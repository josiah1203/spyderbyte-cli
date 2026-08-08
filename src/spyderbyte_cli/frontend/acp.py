from __future__ import annotations

from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Any, Literal

from spyderbyte_cli.frontend.client import FrontendClient
from spyderbyte_cli.frontend.models import FrontendEvent, FrontendSession

AcpStopReason = Literal["end_turn", "cancelled", "max_turn_requests", "error"]


def frontend_session_to_acp(session: FrontendSession) -> dict[str, Any]:
    """Map a Spyderbyte AgentSession identity into an ACP session response."""

    return {
        "sessionId": session.agent_session_id,
        "modes": [{"id": "spyderbyte", "name": "Spyderbyte", "description": "Spyderbyte Run"}],
        "models": [
            {
                "id": "backend-selected",
                "name": "Backend selected",
                "description": "Provider and model are resolved by Spyderbyte.",
            }
        ],
        "capabilities": {
            "promptCapabilities": {"embeddedContext": False, "image": True, "audio": False},
            "loadSession": True,
        },
    }


def frontend_event_to_acp(event: FrontendEvent) -> dict[str, Any]:
    """Map one typed frontend event to an ACP ``session/update`` notification."""

    params: dict[str, Any] = {
        "sessionId": event.agent_session_id,
        "update": {
            "eventId": event.event_id,
            "cursor": event.cursor,
            "runId": event.run_id,
        },
    }
    update = params["update"]
    if event.kind == "assistant.delta":
        update.update(
            {
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": _text(event.payload.get("text"))},
            }
        )
    elif event.kind == "run.status":
        update.update(
            {
                "sessionUpdate": "run_status",
                "state": _text(event.payload.get("state")) or "unknown",
            }
        )
    elif event.kind == "approval.requested":
        update.update(
            {
                "sessionUpdate": "request_permission",
                "permission": {
                    "approvalId": event.payload.get("approvalId"),
                    "action": event.payload.get("action", {}),
                    "options": ["approve", "reject"],
                },
            }
        )
    elif event.kind == "approval.committed":
        update.update(
            {
                "sessionUpdate": "permission_result",
                "approvalId": event.payload.get("approvalId"),
                "state": _text(event.payload.get("state")) or "approved",
            }
        )
    elif event.kind == "artifact.available":
        update.update(
            {
                "sessionUpdate": "artifact_available",
                "artifact": {
                    "artifactId": event.payload.get("artifactId"),
                    "version": event.payload.get("version"),
                    "mediaType": event.payload.get("mediaType"),
                    "contentHash": event.payload.get("contentHash"),
                },
            }
        )
    elif event.kind == "usage.updated":
        update.update({"sessionUpdate": "usage_update", "usage": event.payload})
    elif event.kind == "stream.end":
        update.update({"sessionUpdate": "turn_complete", "stopReason": "end_turn"})
    else:
        update.update({"sessionUpdate": event.kind, "payload": event.payload})
    return {"method": "session/update", "params": params}


def acp_content_to_prompt(content: Sequence[Mapping[str, Any]] | str) -> str:
    """Convert ACP text/image content into the backend prompt boundary."""

    if isinstance(content, str):
        if not content.strip():
            raise ValueError("ACP prompt must not be empty")
        return content
    parts: list[str] = []
    for block in content:
        kind = block.get("type")
        if kind == "text" and isinstance(block.get("text"), str):
            parts.append(block["text"])
        elif kind == "image" and isinstance(block.get("data"), str):
            mime = _text(block.get("mimeType")) or "application/octet-stream"
            parts.append(f"[image data:{mime};base64,{block['data']}]")
    prompt = "\n".join(part for part in parts if part.strip())
    if not prompt:
        raise ValueError("ACP prompt contains no supported content")
    return prompt


class AcpSessionBridge:
    """ACP transport adapter over the same AgentSession/Run frontend client."""

    def __init__(self, client: FrontendClient) -> None:
        self.client = client
        self.session: FrontendSession | None = None
        self.cursor = 0
        self.run_id: str | None = None

    async def initialize(self) -> dict[str, Any]:
        self.session = await self.client.open_session()
        return frontend_session_to_acp(self.session)

    async def prompt(
        self, content: Sequence[Mapping[str, Any]] | str
    ) -> AsyncIterator[dict[str, Any]]:
        if self.session is None:
            await self.initialize()
        assert self.session is not None
        acceptance = await self.client.send_prompt(acp_content_to_prompt(content))
        self.run_id = acceptance.run_id
        yield {
            "method": "session/update",
            "params": {
                "sessionId": self.session.agent_session_id,
                "update": {"sessionUpdate": "run_started", "runId": self.run_id},
            },
        }
        async for event in self.client.events(after_cursor=self.cursor):
            self.cursor = max(self.cursor, event.cursor)
            if event.run_id != self.run_id:
                continue
            yield frontend_event_to_acp(event)
            if event.kind == "stream.end":
                return

    async def cancel(self, reason: str = "ACP cancellation") -> Mapping[str, object]:
        if self.run_id is None:
            return {"cancelled": False, "reason": "no active Run"}
        result = await self.client.cancel_run(self.run_id, reason=reason)
        return result

    async def decide_permission(self, approval_id: str, decision: Literal["approve", "reject"]):
        method = getattr(self.client, "decide_approval", None)
        if method is None:
            raise RuntimeError("frontend client does not expose approval decisions")
        return await method(approval_id, decision)


def _text(value: object) -> str | None:
    return value if isinstance(value, str) else None
