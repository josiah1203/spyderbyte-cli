from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest
from typer.testing import CliRunner

from spyderbyte_cli.adapters.kimi.process import BoundedProcessRuntime
from spyderbyte_cli.adapters.kimi.provider import KosongProviderTransportAdapter
from spyderbyte_cli.adapters.kimi.runtime import AgentRuntimeAdapter
from spyderbyte_cli.adapters.kimi.tools import ToolBrokerAdapter
from spyderbyte_cli.adapters.ports import ProcessRequest, ProviderRequest, ToolCall
from spyderbyte_cli.cli import app
from spyderbyte_cli.daemon import DaemonManager
from spyderbyte_cli.frontend.acp import frontend_event_to_acp
from spyderbyte_cli.frontend.client import HttpFrontendClient
from spyderbyte_cli.frontend.models import (
    EventPage,
    FrontendCapabilities,
    FrontendEvent,
    FrontendSession,
)
from spyderbyte_cli.frontend.projection import FrontendProjector
from spyderbyte_cli.frontend.transport import FrontendTransport, RetryPolicy


def _session() -> FrontendSession:
    return FrontendSession(
        session_id="fs_wave2",
        project_id="project_wave2",
        agent_session_id="agent_wave2",
        workspace_id="workspace_wave2",
        actor_id="actor_wave2",
        mode="local",
        capabilities=FrontendCapabilities(api_version="v1"),
        issued_at=datetime(2026, 8, 8, tzinfo=UTC),
    )


@pytest.mark.asyncio
async def test_http_frontend_client_uses_idempotency_and_maps_sse() -> None:
    calls: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.url.path == "/v1/session":
            return httpx.Response(
                200,
                json={
                    "sessionId": "session_wave2",
                    "tenant": {"workspaceId": "workspace_wave2"},
                    "actor": {"actorId": "actor_wave2"},
                    "projectId": "project_wave2",
                    "agentSessionId": "agent_wave2",
                    "issuedAt": "2026-08-08T00:00:00Z",
                },
                request=request,
            )
        if request.url.path.endswith("/conversation/messages"):
            assert request.headers["idempotency-key"] == "request-wave2"
            return httpx.Response(
                202,
                json={"runId": "run_wave2", "acceptedAt": "2026-08-08T00:00:00Z"},
                request=request,
            )
        if request.url.path == "/v1/subscriptions/events":
            payload = {
                "cursor": 3,
                "events": [
                    {
                        "eventId": "evt_1",
                        "cursor": 1,
                        "eventName": "session.ready",
                        "occurredAt": "2026-08-08T00:00:00Z",
                        "payload": {"projectId": "project_wave2", "agentSessionId": "agent_wave2"},
                    },
                    {
                        "eventId": "evt_2",
                        "cursor": 2,
                        "aggregateType": "run",
                        "aggregateId": "run_wave2",
                        "eventName": "run.status-changed.v1",
                        "occurredAt": "2026-08-08T00:00:01Z",
                        "payload": {"state": "running"},
                    },
                    {
                        "eventId": "evt_3",
                        "cursor": 3,
                        "aggregateType": "run",
                        "aggregateId": "run_wave2",
                        "eventName": "assistant.delta.v1",
                        "occurredAt": "2026-08-08T00:00:02Z",
                        "payload": {"text": "hello"},
                    },
                ],
                "gapDetected": False,
                "refreshRequired": False,
            }
            return httpx.Response(
                200,
                headers={"content-type": "text/event-stream"},
                content=f"data: {json.dumps(payload)}\n\n".encode(),
                request=request,
            )
        return httpx.Response(404, json={"error": "not found"}, request=request)

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="http://test"
    ) as http:
        transport = FrontendTransport(
            "http://test",
            token="secret-token",
            workspace_id="workspace_wave2",
            client=http,
        )
        client = HttpFrontendClient(transport)
        session = await client.open_session()
        acceptance = await client.send_prompt("inspect", request_id="request-wave2")
        events = client.events(after_cursor=0)
        first = await events.__anext__()
        second = await events.__anext__()

    assert session.project_id == "project_wave2"
    assert acceptance.run_id == "run_wave2"
    assert first.kind == "session.ready"
    assert second.kind == "run.status"
    assert calls[0].headers["authorization"] == "Bearer secret-token"


@pytest.mark.asyncio
async def test_transport_retries_idempotent_request_only() -> None:
    attempts = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return httpx.Response(503, json={"error": "busy"}, request=request)
        return httpx.Response(200, json={"ok": True}, request=request)

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="http://test"
    ) as http:
        transport = FrontendTransport(
            "http://test",
            client=http,
            retry_policy=RetryPolicy(max_attempts=2, base_delay=0),
        )
        assert await transport.request("GET", "/v1/health") == {"ok": True}
    assert attempts == 2


def test_projection_is_duplicate_safe_and_cursor_ordered() -> None:
    session = _session()
    projector = FrontendProjector(session)
    ready = FrontendEvent(
        event_id="evt_1",
        cursor=1,
        kind="session.ready",
        occurred_at=session.issued_at,
        project_id=session.project_id,
        agent_session_id=session.agent_session_id,
    )
    turn = ready.model_copy(
        update={
            "event_id": "evt_2",
            "cursor": 2,
            "kind": "turn.accepted",
            "run_id": "run_1",
            "payload": {"state": "accepted"},
        }
    )
    delta = ready.model_copy(
        update={
            "event_id": "evt_3",
            "cursor": 3,
            "kind": "assistant.delta",
            "run_id": "run_1",
            "payload": {"text": "hello"},
        }
    )
    projector.apply(EventPage(cursor=3, events=(delta, turn, ready)))
    projector.apply(delta)
    snapshot = projector.snapshot()
    assert snapshot.cursor == 3
    assert snapshot.assistant_text == "hello"
    assert snapshot.runs[0].run_id == "run_1"
    assert snapshot.gap_detected is False
    gap_projector = FrontendProjector(session)
    gap_projector.apply(delta)
    assert gap_projector.snapshot().refresh_required is True


@pytest.mark.asyncio
async def test_adapters_redact_and_fail_closed(tmp_path: Path) -> None:
    async def exchange(_request: ProviderRequest):
        return {
            "id": "provider-request",
            "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 2, "completion_tokens": 3},
            "api_key": "should-not-leak",
        }

    provider = KosongProviderTransportAdapter(exchange=exchange)
    response = await provider.exchange(
        ProviderRequest("provider", "model", ({"role": "user", "content": "hi"},))
    )
    assert response.text == "ok"
    assert response.raw["api_key"] == "[REDACTED]"

    async def invoke(_call: ToolCall):
        return {"result": "ok", "token": "secret"}

    tools = ToolBrokerAdapter(invoke, allowed_capabilities=frozenset({"files.read"}))
    result = await tools.invoke(ToolCall("files.read", {}, "grant", "run"))
    assert result == {"result": "ok", "token": "[REDACTED]"}

    runtime = BoundedProcessRuntime(
        workspace_root=tmp_path,
        allowed_programs=frozenset({sys.executable}),
    )
    process = await runtime.execute(
        ProcessRequest((sys.executable, "-c", "print('ok')"), str(tmp_path))
    )
    assert process["state"] == "succeeded"
    assert process["output"].strip() == "ok"

    calls = 0

    async def retrying(_attempt):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("retry")
        return "done"

    assert await AgentRuntimeAdapter().execute(retrying) == "done"


def test_acp_mapping_keeps_run_and_cursor_identity() -> None:
    event = FrontendEvent(
        event_id="evt_acp",
        cursor=7,
        kind="assistant.delta",
        occurred_at=datetime(2026, 8, 8, tzinfo=UTC),
        project_id="project_wave2",
        agent_session_id="agent_wave2",
        run_id="run_wave2",
        payload={"text": "hello"},
    )
    update = frontend_event_to_acp(event)
    assert update["method"] == "session/update"
    assert update["params"]["sessionId"] == "agent_wave2"
    assert update["params"]["update"]["cursor"] == 7


def test_mock_print_and_acp_surfaces_use_the_same_frontend_contract() -> None:
    printed = CliRunner().invoke(app, ["--mock", "--prompt", "inspect"])
    assert printed.exit_code == 0, printed.output
    assert "Spyderbyte" in printed.output
    acp = CliRunner().invoke(app, ["acp", "--mock", "--prompt", "inspect"])
    assert acp.exit_code == 0, acp.output
    assert '"method": "session/update"' in acp.output


def test_daemon_manager_owns_lifecycle_and_safe_diagnostics(tmp_path: Path) -> None:
    ready = False

    class Response:
        status = 200

        def __init__(self, payload: str = "") -> None:
            self.payload = payload

        def __enter__(self):
            return self

        def __exit__(self, *args: object) -> bool:
            return False

        def read(self) -> str:
            return self.payload

    class Process:
        returncode: int | None = None

        def poll(self) -> int | None:
            return self.returncode

        def terminate(self) -> None:
            nonlocal ready
            ready = False
            self.returncode = 0

        def wait(self, timeout: float | None = None) -> int:
            del timeout
            return 0

        def kill(self) -> None:
            self.returncode = -9

    process = Process()

    def opener(url: str, **_kwargs: object):
        if url.endswith("/v1/diagnostics"):
            return Response('{"queueDepth": 0}')
        if not ready:
            raise OSError("stopped")
        return Response()

    def popen(*_args: object, **_kwargs: object) -> Process:
        nonlocal ready
        ready = True
        return process

    manager = DaemonManager(
        opener=opener,
        popen=popen,
        repository_root=tmp_path,
    )
    (tmp_path / "platform/apps/local-daemon").mkdir(parents=True)
    (tmp_path / "platform/apps/local-daemon/package.json").write_text("{}")
    assert manager.start(timeout=1)["state"] == "ready"
    assert manager.diagnostics()["daemon"] == {"queueDepth": 0}
    assert manager.stop()["state"] == "stopped"
    assert process.returncode == 0
