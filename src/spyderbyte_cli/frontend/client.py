from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Callable, Mapping
from datetime import UTC, datetime
from typing import Protocol
from urllib.parse import quote

from spyderbyte_cli.frontend.models import (
    EventPage,
    FrontendCapabilities,
    FrontendEvent,
    FrontendEventKind,
    FrontendSession,
    PromptAcceptance,
)
from spyderbyte_cli.frontend.transport import FrontendTransport, FrontendTransportError


class FrontendClient(Protocol):
    async def open_session(self) -> FrontendSession: ...

    async def send_prompt(
        self,
        prompt: str,
        *,
        request_id: str | None = None,
    ) -> PromptAcceptance: ...

    def events(
        self,
        *,
        after_cursor: int = 0,
        max_reconnects: int = 5,
        reconnect_delay: float = 0.25,
        on_connection_state_change: Callable[[str], None] | None = None,
    ) -> AsyncIterator[FrontendEvent]: ...

    async def cancel_run(
        self, run_id: str, *, reason: str | None = None
    ) -> Mapping[str, object]: ...

    async def retry_run(self, run_id: str) -> Mapping[str, object]: ...


def _new_id(prefix: str) -> str:
    import uuid

    return f"{prefix}_{uuid.uuid4().hex}"


class MockFrontendClient:
    """Deterministic fixture client used by contract and reconnect tests."""

    def __init__(self) -> None:
        self._now = datetime(2026, 8, 8, tzinfo=UTC)
        self._session = FrontendSession(
            session_id="fs_mock_01",
            project_id="prj_mock_01",
            agent_session_id="as_mock_01",
            workspace_id="ws_mock_01",
            actor_id="actor_local",
            mode="mock",
            capabilities=FrontendCapabilities(
                api_version="v1",
                native_resources=(
                    "dataset",
                    "sql",
                    "notebook",
                    "experiment",
                    "model",
                    "visualization",
                    "pipeline",
                    "automation",
                ),
            ),
            issued_at=self._now,
        )
        self._events: list[FrontendEvent] = [
            FrontendEvent(
                event_id="evt_mock_01",
                cursor=1,
                kind="session.ready",
                occurred_at=self._now,
                project_id=self._session.project_id,
                agent_session_id=self._session.agent_session_id,
                payload={"mode": "mock"},
            )
        ]

    async def open_session(self) -> FrontendSession:
        return self._session

    async def send_prompt(
        self,
        prompt: str,
        *,
        request_id: str | None = None,
    ) -> PromptAcceptance:
        if not prompt.strip():
            raise ValueError("prompt must not be empty")
        acceptance = PromptAcceptance(
            request_id=request_id or "req_mock_01",
            project_id=self._session.project_id,
            agent_session_id=self._session.agent_session_id,
            user_message_id="msg_user_mock_01",
            assistant_message_id="msg_assistant_mock_01",
            run_id="run_mock_01",
            accepted_at=self._now,
        )
        self._events.extend(
            [
                FrontendEvent(
                    event_id="evt_mock_02",
                    cursor=2,
                    kind="turn.accepted",
                    occurred_at=self._now,
                    project_id=self._session.project_id,
                    agent_session_id=self._session.agent_session_id,
                    run_id=acceptance.run_id,
                    payload={"prompt": prompt},
                ),
                FrontendEvent(
                    event_id="evt_mock_03",
                    cursor=3,
                    kind="assistant.delta",
                    occurred_at=self._now,
                    project_id=self._session.project_id,
                    agent_session_id=self._session.agent_session_id,
                    run_id=acceptance.run_id,
                    payload={"text": "Mock Spyderbyte backend accepted the turn."},
                ),
                FrontendEvent(
                    event_id="evt_mock_04",
                    cursor=4,
                    kind="run.status",
                    occurred_at=self._now,
                    project_id=self._session.project_id,
                    agent_session_id=self._session.agent_session_id,
                    run_id=acceptance.run_id,
                    payload={"state": "succeeded"},
                ),
                FrontendEvent(
                    event_id="evt_mock_05",
                    cursor=5,
                    kind="stream.end",
                    occurred_at=self._now,
                    project_id=self._session.project_id,
                    agent_session_id=self._session.agent_session_id,
                    run_id=acceptance.run_id,
                ),
            ]
        )
        return acceptance

    async def cancel_run(self, run_id: str, *, reason: str | None = None) -> Mapping[str, object]:
        if run_id != "run_mock_01":
            raise ValueError(f"unknown mock run: {run_id}")
        self._events.append(
            FrontendEvent(
                event_id="evt_mock_cancelled",
                cursor=len(self._events) + 1,
                kind="run.status",
                occurred_at=self._now,
                project_id=self._session.project_id,
                agent_session_id=self._session.agent_session_id,
                run_id=run_id,
                payload={"state": "cancelled", "reason": reason},
            )
        )
        return {"runId": run_id, "state": "cancelled"}

    async def retry_run(self, run_id: str) -> Mapping[str, object]:
        if run_id != "run_mock_01":
            raise ValueError(f"unknown mock run: {run_id}")
        return {"runId": run_id, "state": "accepted"}

    async def events(
        self,
        *,
        after_cursor: int = 0,
        max_reconnects: int = 5,
        reconnect_delay: float = 0.25,
        on_connection_state_change: Callable[[str], None] | None = None,
    ) -> AsyncIterator[FrontendEvent]:
        del max_reconnects, reconnect_delay, on_connection_state_change
        for event in self._events:
            if event.cursor > after_cursor:
                yield event


class HttpFrontendClient:
    """Spyderbyte-owned frontend client over the versioned local/hosted API."""

    def __init__(
        self,
        transport: FrontendTransport,
        *,
        project_id: str | None = None,
        agent_session_id: str | None = None,
        capabilities: FrontendCapabilities | None = None,
    ) -> None:
        self.transport = transport
        self.project_id = project_id
        self.agent_session_id = agent_session_id
        self._capabilities = capabilities or FrontendCapabilities(api_version="v1")
        self._session: FrontendSession | None = None

    async def open_session(self) -> FrontendSession:
        raw = _record(await self.transport.request("GET", "/v1/session"))
        nested = _record(raw.get("session")) if isinstance(raw.get("session"), dict) else raw
        tenant = _record(nested.get("tenant"))
        workspace_id = _string(nested.get("workspaceId")) or _string(tenant.get("workspaceId"))
        if workspace_id is None:
            raise FrontendTransportError(
                "Spyderbyte session did not identify a workspace",
                error=_schema_error("session_missing_workspace"),
            )
        project_id = (
            _string(nested.get("projectId"))
            or self.project_id
            or _string(nested.get("defaultProjectId"))
            or workspace_id
        )
        agent_session_id = (
            _string(nested.get("agentSessionId"))
            or self.agent_session_id
            or _string(nested.get("defaultAgentSessionId"))
            or f"agent_session_{project_id}"
        )
        actor = _record(nested.get("actor"))
        actor_id = _string(nested.get("actorId")) or _string(actor.get("actorId"))
        session_id = _string(nested.get("sessionId"))
        if session_id is None or actor_id is None:
            raise FrontendTransportError(
                "Spyderbyte session is missing its identity",
                error=_schema_error("session_missing_identity"),
            )
        mode = "hosted" if _string(nested.get("mode")) == "hosted" else "local"
        capabilities = _capabilities(nested.get("capabilities"), self._capabilities)
        issued_at = _datetime(nested.get("issuedAt"))
        self._session = FrontendSession(
            session_id=session_id,
            project_id=project_id,
            agent_session_id=agent_session_id,
            workspace_id=workspace_id,
            actor_id=actor_id,
            mode=mode,
            capabilities=capabilities,
            issued_at=issued_at,
        )
        return self._session

    async def send_prompt(
        self,
        prompt: str,
        *,
        request_id: str | None = None,
    ) -> PromptAcceptance:
        if not prompt.strip():
            raise ValueError("prompt must not be empty")
        session = self._session or await self.open_session()
        request_id = request_id or _new_id("req")
        raw = _record(
            await self.transport.request(
                "POST",
                f"/v1/projects/{quote(session.project_id, safe='')}/conversation/messages",
                body={
                    "text": prompt,
                    "sourceInterface": self.transport.interface,
                },
                idempotency_key=request_id,
            )
        )
        nested = _record(raw.get("acceptance")) if isinstance(raw.get("acceptance"), dict) else raw
        run_id = _string(nested.get("runId")) or _string(nested.get("run_id"))
        if run_id is None:
            raise FrontendTransportError(
                "Spyderbyte prompt response did not identify a Run",
                error=_schema_error("prompt_missing_run"),
            )
        return PromptAcceptance(
            request_id=_string(nested.get("requestId")) or request_id,
            project_id=_string(nested.get("projectId")) or session.project_id,
            agent_session_id=(_string(nested.get("agentSessionId")) or session.agent_session_id),
            user_message_id=_string(nested.get("userMessageId")) or _new_id("msg_user"),
            assistant_message_id=(
                _string(nested.get("assistantMessageId")) or _new_id("msg_assistant")
            ),
            run_id=run_id,
            accepted_at=_datetime(nested.get("acceptedAt")),
        )

    async def cancel_run(self, run_id: str, *, reason: str | None = None) -> Mapping[str, object]:
        return _record(
            await self.transport.request(
                "POST",
                f"/v1/runs/{quote(run_id, safe='')}/cancel",
                body={} if reason is None else {"reason": reason},
                idempotency_key=_new_id("cancel"),
            )
        )

    async def retry_run(self, run_id: str) -> Mapping[str, object]:
        return _record(
            await self.transport.request(
                "POST",
                f"/v1/runs/{quote(run_id, safe='')}/retry",
                body={},
                idempotency_key=_new_id("retry"),
            )
        )

    async def events(
        self,
        *,
        after_cursor: int = 0,
        max_reconnects: int = 5,
        reconnect_delay: float = 0.25,
        on_connection_state_change: Callable[[str], None] | None = None,
    ) -> AsyncIterator[FrontendEvent]:
        if after_cursor < 0:
            raise ValueError("after_cursor must be non-negative")
        cursor = after_cursor
        reconnects = 0
        while True:
            _notify(on_connection_state_change, "connecting" if reconnects == 0 else "reconnecting")
            saw_page = False
            try:
                lines = self.transport.sse_lines(
                    "/v1/subscriptions/events",
                    params={"afterCursor": cursor},
                )
                _notify(on_connection_state_change, "connected")
                async for payload in _sse_payloads(lines):
                    saw_page = True
                    page = self._event_page(payload, cursor)
                    for event in page.events:
                        cursor = max(cursor, event.cursor)
                        yield event
                    cursor = max(cursor, page.cursor)
                    if page.refresh_required:
                        _notify(on_connection_state_change, "refresh_required")
                if saw_page:
                    raise FrontendTransportError(
                        "Spyderbyte event stream ended before cancellation",
                        retryable=True,
                    )
                raise FrontendTransportError(
                    "Spyderbyte event stream returned no pages",
                    retryable=True,
                )
            except asyncio.CancelledError:
                return
            except FrontendTransportError:
                if reconnects >= max_reconnects:
                    _notify(on_connection_state_change, "disconnected")
                    raise
                reconnects += 1
                _notify(on_connection_state_change, "reconnecting")
                await asyncio.sleep(reconnect_delay)
            else:
                reconnects = 0

    def _event_page(self, payload: object, previous_cursor: int) -> EventPage:
        raw = _record(payload)
        raw_events = raw.get("events")
        if not isinstance(raw_events, list):
            raise FrontendTransportError(
                "Spyderbyte event page did not contain events",
                error=_schema_error("event_page_missing_events"),
            )
        page_cursor = _integer(raw.get("cursor"))
        if page_cursor is None:
            raise FrontendTransportError(
                "Spyderbyte event page did not contain a cursor",
                error=_schema_error("event_page_missing_cursor"),
            )
        events = tuple(
            _runtime_event_to_frontend(
                raw_event,
                cursor=max(previous_cursor, page_cursor - len(raw_events) + index + 1),
                session=self._session,
            )
            for index, raw_event in enumerate(raw_events)
        )
        return EventPage(
            cursor=page_cursor,
            events=events,
            gap_detected=raw.get("gapDetected") is True,
            refresh_required=raw.get("refreshRequired") is True,
        )


async def _sse_payloads(lines: AsyncIterator[str]) -> AsyncIterator[object]:
    data: list[str] = []
    async for line in lines:
        if line.startswith(":"):
            continue
        if line.startswith("data:"):
            data.append(line[5:].lstrip())
            continue
        if line.strip() == "" and data:
            yield _decode_sse_data(data)
            data = []
    if data:
        yield _decode_sse_data(data)


def _decode_sse_data(data: list[str]) -> object:
    try:
        value = json.loads("\n".join(data))
    except json.JSONDecodeError as error:
        raise FrontendTransportError(
            "Spyderbyte event stream contained invalid JSON",
            error=_schema_error("event_invalid_json"),
        ) from error
    if isinstance(value, dict) and isinstance(value.get("error"), str):
        raise FrontendTransportError(value["error"], error=_schema_error(value["error"]))
    return value


def _runtime_event_to_frontend(
    value: object,
    *,
    cursor: int,
    session: FrontendSession | None,
) -> FrontendEvent:
    raw = _record(value)
    if isinstance(raw.get("kind"), str):
        return FrontendEvent.model_validate(
            {**raw, "cursor": _integer(raw.get("cursor")) or cursor}
        )
    payload = _record(raw.get("payload"))
    event_name = _string(raw.get("eventName")) or _string(raw.get("type")) or "run.status"
    aggregate_type = _string(raw.get("aggregateType"))
    run_id = (
        _string(raw.get("runId")) or _string(raw.get("aggregateId"))
        if aggregate_type in {"run", "Run"}
        else _string(raw.get("runId")) or _string(payload.get("runId"))
    )
    return FrontendEvent(
        event_id=_string(raw.get("eventId")) or _new_id("evt"),
        cursor=_integer(raw.get("cursor")) or cursor,
        kind=_event_kind(event_name),
        occurred_at=_datetime(raw.get("occurredAt")),
        project_id=(
            _string(payload.get("projectId"))
            or _string(raw.get("projectId"))
            or (session.project_id if session is not None else "unknown-project")
        ),
        agent_session_id=(
            _string(payload.get("agentSessionId"))
            or _string(raw.get("agentSessionId"))
            or (session.agent_session_id if session is not None else "unknown-agent-session")
        ),
        run_id=run_id,
        payload={**payload, "eventName": event_name},
    )


def _event_kind(event_name: str) -> FrontendEventKind:
    lowered = event_name.lower().replace("_", ".").replace("-", ".")
    if "assistant" in lowered or "message.delta" in lowered or "content.delta" in lowered:
        return "assistant.delta"
    if "approval.request" in lowered:
        return "approval.requested"
    if "approval" in lowered and ("commit" in lowered or "decid" in lowered):
        return "approval.committed"
    if "artifact" in lowered:
        return "artifact.available"
    if "usage" in lowered or "meter" in lowered:
        return "usage.updated"
    if "stream.end" in lowered or lowered.endswith("completed") or lowered.endswith("finished"):
        return "stream.end"
    if "session" in lowered and ("ready" in lowered or "opened" in lowered):
        return "session.ready"
    if "turn" in lowered and ("accept" in lowered or "created" in lowered):
        return "turn.accepted"
    return "run.status"


def _record(value: object) -> dict[str, object]:
    if isinstance(value, dict):
        return value
    raise FrontendTransportError(
        "Spyderbyte response was not an object",
        error=_schema_error("response_not_object"),
    )


def _string(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _integer(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def _datetime(value: object) -> datetime:
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            pass
    return datetime.now(UTC)


def _schema_error(code: str):
    from spyderbyte_cli.frontend.models import FrontendError

    return FrontendError(error=code, code="VALIDATION_SCHEMA_MISMATCH")


def _capabilities(value: object, fallback: FrontendCapabilities) -> FrontendCapabilities:
    if not isinstance(value, dict):
        return fallback
    try:
        return FrontendCapabilities.model_validate(value)
    except Exception:
        return fallback


def _notify(callback: Callable[[str], None] | None, state: str) -> None:
    if callback is not None:
        callback(state)
