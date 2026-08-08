from __future__ import annotations

import asyncio
import json
import secrets
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from datetime import UTC, datetime
from typing import Literal, Protocol, cast
from urllib.parse import quote

from spyderbyte_cli.frontend.models import (
    EventPage,
    FrontendAgentEvent,
    FrontendAgentRequest,
    FrontendAgentResponse,
    FrontendAgentSession,
    FrontendAgentSessionSnapshot,
    FrontendApproval,
    FrontendArtifact,
    FrontendCapabilities,
    FrontendConversationSnapshot,
    FrontendError,
    FrontendEstimate,
    FrontendEvent,
    FrontendEventKind,
    FrontendInterface,
    FrontendMessage,
    FrontendModelCatalog,
    FrontendPermission,
    FrontendPlan,
    FrontendPlanStep,
    FrontendProject,
    FrontendProviderCatalog,
    FrontendRecommendation,
    FrontendRun,
    FrontendRunAttempt,
    FrontendRunDetail,
    FrontendRunLog,
    FrontendRunState,
    FrontendRuntimeCatalog,
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
        provider_id: str | None = None,
        model_id: str | None = None,
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
    return f"{prefix}_{uuid.uuid4().hex}"


def _new_sortable_id() -> str:
    """Create the UUIDv7-shaped IDs required by the local runtime command contract."""

    timestamp_ms = int(time.time() * 1000) & ((1 << 48) - 1)
    random_a = secrets.randbits(12)
    random_b = secrets.randbits(62)
    value = (timestamp_ms << 80) | (0x7 << 76) | (random_a << 64) | (0b10 << 62) | random_b
    return str(uuid.UUID(int=value))


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
        provider_id: str | None = None,
        model_id: str | None = None,
    ) -> PromptAcceptance:
        del provider_id, model_id
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
        project_name: str = "Spyderbyte local project",
        project_objective: str | None = None,
    ) -> None:
        self.transport = transport
        self.project_id = project_id
        self.agent_session_id = agent_session_id
        self._capabilities = capabilities or FrontendCapabilities(api_version="v1")
        self.project_name = project_name
        self.project_objective = project_objective
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
        project_id = (
            _string(nested.get("projectId"))
            or self.project_id
            or _string(nested.get("defaultProjectId"))
        )
        agent_session_id = (
            _string(nested.get("agentSessionId"))
            or self.agent_session_id
            or _string(nested.get("defaultAgentSessionId"))
        )
        conversation: dict[str, object] | None = None
        if project_id is None:
            capabilities = await self._load_capabilities()
            project_id = await self._select_or_create_project(tenant, actor)
        if agent_session_id is None:
            conversation = _record(
                await self.transport.request(
                    "GET",
                    f"/v1/projects/{quote(project_id, safe='')}/conversation",
                )
            )
            conversation_session = _record(conversation.get("session"))
            project_id = _string(conversation_session.get("projectId")) or project_id
            agent_session_id = _string(conversation_session.get("sessionId"))
        if agent_session_id is None:
            raise FrontendTransportError(
                "Spyderbyte project did not identify an AgentSession",
                error=_schema_error("session_missing_agent_session"),
            )
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
            tenant_id=_string(tenant.get("tenantId")),
        )
        return self._session

    async def _load_capabilities(self) -> FrontendCapabilities:
        try:
            raw = _record(await self.transport.request("GET", "/v1/capabilities"))
        except FrontendTransportError:
            return self._capabilities
        entries = _record(raw.get("capabilities"))
        capability_to_resource = {
            "dataset": "dataset",
            "sql": "sql",
            "notebook": "notebook",
            "experiment": "experiment",
            "model": "model",
            "visualization": "visualization",
            "pipeline": "pipeline",
            "automation": "automation",
            "catalog-datasets": "dataset",
            "queries": "sql",
            "notebooks": "notebook",
            "experiments": "experiment",
            "model-lifecycle": "model",
            "visualizations": "visualization",
            "pipelines": "pipeline",
            "automations": "automation",
        }
        native_resources = tuple(
            sorted(
                resource
                for capability, resource in capability_to_resource.items()
                if (entry := entries.get(capability))
                and isinstance(entry, dict)
                and entry.get("enabled") is True
            )
        )
        return FrontendCapabilities(
            api_version="v1",
            native_resources=native_resources,
            event_resume=True,
        )

    async def _select_or_create_project(
        self,
        tenant: Mapping[str, object],
        actor: Mapping[str, object],
    ) -> str:
        projects = await self.list_projects()
        active = [project for project in projects if project.status == "active"]
        if active:
            selected = max(
                active,
                key=lambda project: project.updated_at or datetime.min.replace(tzinfo=UTC),
            )
            return selected.project_id
        tenant_id = _string(tenant.get("tenantId"))
        workspace_id = _string(tenant.get("workspaceId"))
        actor_id = _string(actor.get("actorId"))
        actor_type = _string(actor.get("type")) or "human"
        if tenant_id is None or workspace_id is None or actor_id is None:
            raise FrontendTransportError(
                "Spyderbyte session cannot create a project without tenant identity",
                error=_schema_error("session_missing_tenant_identity"),
            )
        now = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        idempotency_key = _new_id("create-project")
        command = {
            "schemaVersion": 1,
            "commandId": _new_sortable_id(),
            "commandType": "CreateProject",
            "tenant": {"tenantId": tenant_id, "workspaceId": workspace_id},
            "actor": {
                "actorId": actor_id,
                "type": actor_type,
                "displayName": _string(actor.get("displayName")) or "Spyderbyte user",
            },
            "issuedAt": now,
            "idempotencyKey": idempotency_key,
            "correlationId": _new_sortable_id(),
            "payload": {
                "name": self.project_name,
                **({} if self.project_objective is None else {"objective": self.project_objective}),
            },
        }
        raw = _record(
            await self.transport.request(
                "POST",
                "/v1/commands",
                body=command,
                idempotency_key=idempotency_key,
            )
        )
        result = _record(raw.get("result"))
        project_id = _string(raw.get("projectId")) or _string(result.get("projectId"))
        if project_id is None:
            raise FrontendTransportError(
                "Spyderbyte project creation did not return a project ID",
                error=_schema_error("project_create_missing_id"),
            )
        return project_id

    async def list_projects(self) -> tuple[FrontendProject, ...]:
        raw = _record(await self.transport.request("GET", "/v1/projections/projects"))
        state = _record(raw.get("state"))
        projects = state.get("projects")
        candidates: list[object]
        if isinstance(projects, dict):
            candidates = list(projects.values())
        elif isinstance(projects, list):
            candidates = projects
        else:
            candidates = []
        parsed: list[FrontendProject] = []
        for candidate in candidates:
            record = _record(candidate)
            project_id = _string(record.get("projectId"))
            name = _string(record.get("name"))
            if project_id is None or name is None:
                continue
            status = _string(record.get("status"))
            parsed.append(
                FrontendProject(
                    project_id=project_id,
                    name=name,
                    status="archived" if status == "archived" else "active",
                    objective=_string(record.get("objective")),
                    version=_integer(record.get("version")) or 0,
                    updated_at=_optional_datetime(record.get("updatedAt")),
                )
            )
        return tuple(parsed)

    async def read_conversation(self) -> FrontendConversationSnapshot:
        session = self._session or await self.open_session()
        raw = _record(
            await self.transport.request(
                "GET",
                f"/v1/projects/{quote(session.project_id, safe='')}/conversation",
            )
        )
        return _conversation_snapshot(raw, session.project_id)

    async def read_agent_session(self) -> FrontendAgentSessionSnapshot:
        session = self._session or await self.open_session()
        raw = _record(
            await self.transport.request(
                "GET",
                f"/v1/projects/{quote(session.project_id, safe='')}/agent-session",
            )
        )
        return _agent_session_snapshot(raw)

    async def read_run(self, run_id: str) -> FrontendRunDetail:
        raw = _record(await self.transport.request("GET", f"/v1/runs/{quote(run_id, safe='')}"))
        return _run_detail(raw)

    async def list_runs(self, project_id: str | None = None) -> tuple[FrontendRun, ...]:
        path = "/v1/runs"
        if project_id is not None:
            path += f"?projectId={quote(project_id, safe='')}"
        raw = _record(await self.transport.request("GET", path))
        runs = raw.get("runs")
        if not isinstance(runs, list):
            return ()
        return tuple(_frontend_run(item) for item in runs if isinstance(item, dict))

    async def read_projection(self, name: str) -> Mapping[str, object]:
        if not name or "/" in name or "?" in name:
            raise ValueError("projection name must be a single path segment")
        return _record(
            await self.transport.request("GET", f"/v1/projections/{quote(name, safe='')}")
        )

    async def list_approvals(self) -> tuple[FrontendApproval, ...]:
        raw = await self.transport.request("GET", "/v1/approvals")
        candidates = raw.get("approvals") if isinstance(raw, dict) else raw
        if not isinstance(candidates, list):
            return ()
        return tuple(_approval(item) for item in candidates if isinstance(item, dict))

    async def decide_approval(
        self,
        approval_id: str,
        decision: Literal["approve", "reject", "revoke"],
        *,
        reason: str | None = None,
    ) -> Mapping[str, object]:
        if not approval_id:
            raise ValueError("approval_id must not be empty")
        body = {} if reason is None else {"reason": reason}
        return _record(
            await self.transport.request(
                "POST",
                f"/v1/approvals/{quote(approval_id, safe='')}/{decision}",
                body=body,
                idempotency_key=_new_id("approval"),
            )
        )

    async def read_artifact(self, artifact_id: str) -> FrontendArtifact:
        raw = _record(
            await self.transport.request("GET", f"/v1/artifacts/{quote(artifact_id, safe='')}")
        )
        parsed = _artifact(raw)
        if parsed is None:
            raise FrontendTransportError(
                "Spyderbyte artifact response did not identify an artifact",
                error=_schema_error("artifact_missing_identity"),
            )
        return FrontendArtifact.model_validate(parsed)

    async def read_artifact_versions(self, artifact_id: str) -> tuple[FrontendArtifact, ...]:
        raw = await self.transport.request(
            "GET", f"/v1/artifacts/{quote(artifact_id, safe='')}/versions"
        )
        candidates = raw.get("versions") if isinstance(raw, dict) else raw
        if not isinstance(candidates, list):
            return ()
        parsed = (_artifact(item) for item in candidates if isinstance(item, dict))
        return tuple(FrontendArtifact.model_validate(item) for item in parsed if item is not None)

    async def read_provider_catalog(self) -> FrontendProviderCatalog:
        raw = _record(await self.transport.request("GET", "/v1/providers"))
        return FrontendProviderCatalog(
            providers=_records(raw.get("providers")),
            credentials=_records(raw.get("credentials")),
            models=_records(raw.get("models")),
        )

    async def read_model_catalog(self) -> FrontendModelCatalog:
        raw = _record(await self.transport.request("GET", "/v1/models/catalog"))
        return FrontendModelCatalog(
            models=_records(raw.get("models")),
            runtimes=_records(raw.get("runtimes")),
            provider_priority=_strings(raw.get("providerPriority")),
            routing_policy=_record_or_empty(raw.get("routingPolicy")),
        )

    async def read_runtime_catalog(self) -> FrontendRuntimeCatalog:
        raw = _record(await self.transport.request("GET", "/v1/runtimes/profiles"))
        return FrontendRuntimeCatalog(
            profiles=_records(raw.get("profiles")),
            revisions=_records(raw.get("revisions")),
        )

    async def send_prompt(
        self,
        prompt: str,
        *,
        request_id: str | None = None,
        provider_id: str | None = None,
        model_id: str | None = None,
    ) -> PromptAcceptance:
        if not prompt.strip():
            raise ValueError("prompt must not be empty")
        session = self._session or await self.open_session()
        request_id = request_id or _new_id("req")
        if (provider_id is None) != (model_id is None):
            raise ValueError("provider_id and model_id must be supplied together")
        body: dict[str, object] = {
            "text": prompt,
            "sourceInterface": self.transport.interface,
        }
        if provider_id is not None and model_id is not None:
            body.update({"providerId": provider_id, "modelId": model_id})
        raw = _record(
            await self.transport.request(
                "POST",
                f"/v1/projects/{quote(session.project_id, safe='')}/conversation/messages",
                body=body,
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
                payloads = _sse_payloads(lines)
                _notify(on_connection_state_change, "connected")
                try:
                    async for payload in payloads:
                        saw_page = True
                        page = self._event_page(payload, cursor)
                        for event in page.events:
                            cursor = max(cursor, event.cursor)
                            yield event
                        cursor = max(cursor, page.cursor)
                        if page.refresh_required:
                            _notify(on_connection_state_change, "refresh_required")
                finally:
                    await _close_async_iterator(payloads)
                    await _close_async_iterator(lines)
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


async def _close_async_iterator(value: object) -> None:
    close = getattr(value, "aclose", None)
    if not callable(close):
        return
    close_async = cast(Callable[[], Awaitable[object]], close)
    try:
        await close_async()
    except RuntimeError as error:
        if "already running" not in str(error):
            raise


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
    payload = dict(_record(raw.get("payload")))
    agent_event = _record_or_empty(payload.get("agentEvent"))
    session_payload = _record_or_empty(payload.get("session"))
    request_payload = _record_or_empty(payload.get("request"))
    if agent_event:
        payload = {**_record(agent_event.get("payload")), **payload}
    delta = _string(payload.get("delta"))
    if delta is not None and _string(payload.get("text")) is None:
        payload["text"] = delta
    event_name = _string(raw.get("eventName")) or _string(raw.get("type")) or "run.status"
    aggregate_type = _string(raw.get("aggregateType"))
    run_id = (
        _string(raw.get("runId")) or _string(raw.get("aggregateId"))
        if aggregate_type in {"run", "Run"}
        else _string(raw.get("runId")) or _string(payload.get("runId"))
    )
    if run_id is None and (
        event_name.startswith("agent.")
        or event_name.startswith("chat.")
        or event_name.startswith("run.")
    ):
        run_id = (
            _string(session_payload.get("currentRunId"))
            or _string(request_payload.get("correlationId"))
            or _string(agent_event.get("correlationId"))
            or _string(payload.get("correlationId"))
            or _string(raw.get("correlationId"))
        )
    return FrontendEvent(
        event_id=_string(raw.get("eventId")) or _new_id("evt"),
        cursor=_integer(raw.get("cursor")) or cursor,
        kind=_event_kind(event_name),
        occurred_at=_datetime(raw.get("occurredAt")),
        project_id=(
            _string(payload.get("projectId"))
            or _string(_record_or_empty(payload.get("message")).get("projectId"))
            or _string(raw.get("projectId"))
            or (session.project_id if session is not None else "unknown-project")
        ),
        agent_session_id=(
            _string(payload.get("agentSessionId"))
            or _string(payload.get("conversationId"))
            or _string(session_payload.get("sessionId"))
            or _string(raw.get("agentSessionId"))
            or (session.agent_session_id if session is not None else "unknown-agent-session")
        ),
        run_id=run_id,
        payload={**payload, "eventName": event_name},
    )


def _event_kind(event_name: str) -> FrontendEventKind:
    lowered = event_name.lower().replace("_", ".").replace("-", ".")
    if "run.started" in lowered or "run.created" in lowered:
        return "turn.accepted"
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
    if any(
        marker in lowered
        for marker in (
            "chat.run.completed",
            "chat.run.failed",
            "chat.run.cancelled",
            "run.completed",
            "run.failed",
            "run.cancelled",
        )
    ):
        return "stream.end"
    return "run.status"


def _record(value: object) -> dict[str, object]:
    if isinstance(value, dict):
        return value
    raise FrontendTransportError(
        "Spyderbyte response was not an object",
        error=_schema_error("response_not_object"),
    )


def _record_or_empty(value: object) -> dict[str, object]:
    return value if isinstance(value, dict) else {}


def _records(value: object) -> tuple[dict[str, object], ...]:
    if not isinstance(value, list):
        return ()
    return tuple(item for item in value if isinstance(item, dict))


def _approval(value: object) -> FrontendApproval:
    raw = _record(value)
    request = _record_or_empty(raw.get("request"))
    action = _record_or_empty(raw.get("action"))
    state = _string(raw.get("state")) or _string(request.get("state"))
    approval_state = cast(
        Literal["pending", "approved", "rejected", "revoked"],
        state if state in {"pending", "approved", "rejected", "revoked"} else "pending",
    )
    return FrontendApproval(
        approval_id=(
            _string(raw.get("approvalId"))
            or _string(request.get("approvalId"))
            or "unknown-approval"
        ),
        run_id=(
            _string(raw.get("runId"))
            or _string(request.get("workflowId"))
            or _string(action.get("workflowId"))
            or _string(action.get("runId"))
            or "unknown-run"
        ),
        state=approval_state,
        action=action,
        resources=(
            _strings(raw.get("resources"))
            or _strings(request.get("resources"))
            or _strings(action.get("resources"))
        ),
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


def _optional_datetime(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _strings(value: object) -> tuple[str, ...]:
    if not isinstance(value, (list, tuple)):
        return ()
    return tuple(item for item in value if isinstance(item, str))


def _interface(value: object) -> FrontendInterface:
    valid = {
        "tui",
        "cli",
        "acp",
        "api",
        "jupyter",
        "web",
        "automation",
        "system",
        "mock",
    }
    return cast(FrontendInterface, value if isinstance(value, str) and value in valid else "api")


def _agent_mode(
    value: object,
) -> Literal["conversation", "planning", "approval", "execution", "review"]:
    valid = {"conversation", "planning", "approval", "execution", "review"}
    fallback = value if isinstance(value, str) and value in valid else "conversation"
    return cast(Literal["conversation", "planning", "approval", "execution", "review"], fallback)


def _agent_state(
    value: object,
) -> Literal["active", "awaiting_approval", "running", "completed", "failed", "cancelled"]:
    valid = {"active", "awaiting_approval", "running", "completed", "failed", "cancelled"}
    fallback = value if isinstance(value, str) and value in valid else "active"
    return cast(
        Literal["active", "awaiting_approval", "running", "completed", "failed", "cancelled"],
        fallback,
    )


def _response_state(
    value: object,
) -> Literal["accepted", "awaiting_permission", "completed", "failed", "cancelled"]:
    valid = {"accepted", "awaiting_permission", "completed", "failed", "cancelled"}
    fallback = value if isinstance(value, str) and value in valid else "accepted"
    return cast(
        Literal["accepted", "awaiting_permission", "completed", "failed", "cancelled"],
        fallback,
    )


def _run_state_value(value: object) -> FrontendRunState:
    valid = {
        "draft",
        "validating",
        "awaiting_configuration",
        "accepted",
        "queued",
        "provisioning",
        "running",
        "awaiting_approval",
        "finalizing",
        "succeeded",
        "failed",
        "cancelled",
        "timed_out",
        "partially_succeeded",
    }
    return cast(FrontendRunState, value if isinstance(value, str) and value in valid else "queued")


def _artifact(value: object) -> dict[str, object] | None:
    raw = _record(value)
    artifact_id = _string(raw.get("artifactId"))
    if artifact_id is None:
        return None
    return {
        "artifactId": artifact_id,
        "version": _integer(raw.get("version")) or 1,
        "mediaType": _string(raw.get("mediaType")) or "application/octet-stream",
        "contentHash": _string(raw.get("contentHash")),
        "title": _string(raw.get("title")),
    }


def _agent_session(value: object) -> FrontendAgentSession:
    raw = _record(value)
    session_id = _string(raw.get("sessionId"))
    workspace_id = _string(raw.get("workspaceId"))
    if session_id is None or workspace_id is None:
        raise FrontendTransportError(
            "Spyderbyte AgentSession is missing its identity",
            error=_schema_error("agent_session_missing_identity"),
        )
    return FrontendAgentSession(
        session_id=session_id,
        workspace_id=workspace_id,
        project_id=_string(raw.get("projectId")),
        source_interface=_interface(raw.get("sourceInterface")),
        mode=_agent_mode(raw.get("mode")),
        state=_agent_state(raw.get("state")),
        request_ids=_strings(raw.get("requestIds")),
        current_run_id=_string(raw.get("currentRunId")),
        created_at=_datetime(raw.get("createdAt")),
        updated_at=_datetime(raw.get("updatedAt")),
    )


def _agent_response(value: object) -> FrontendAgentResponse:
    raw = _record(value)
    recommendation = _record(raw.get("recommendation"))
    plan_raw = _record(raw.get("plan"))
    estimate = _record(raw.get("estimate"))
    steps = []
    raw_steps = plan_raw.get("steps")
    if isinstance(raw_steps, list):
        for raw_step in raw_steps:
            step = _record(raw_step)
            step_id = _string(step.get("stepId"))
            if step_id is None:
                continue
            steps.append(
                FrontendPlanStep(
                    step_id=step_id,
                    tier=_integer(step.get("tier")) or 0,
                    agent_type=_string(step.get("agentType")) or "spyderbyte-agent",
                    title=_string(step.get("title")) or "Agent step",
                    description=_string(step.get("description")) or "Execute the agent step.",
                    depends_on=_strings(step.get("dependsOn")),
                    input_artifact_ids=_strings(step.get("inputArtifactIds")),
                    required_capabilities=_strings(step.get("requiredCapabilities")),
                    approval_required=step.get("approvalRequired") is True,
                    expected_outputs=_strings(step.get("expectedOutputs")),
                    acceptance_criteria=_strings(step.get("acceptanceCriteria")),
                )
            )
    artifacts = []
    raw_artifacts = raw.get("artifacts")
    if isinstance(raw_artifacts, list):
        artifacts = [
            FrontendArtifact.model_validate(candidate)
            for candidate in (_artifact(item) for item in raw_artifacts)
            if candidate is not None
        ]
    confidence_value = recommendation.get("confidence")
    confidence = (
        float(confidence_value)
        if isinstance(confidence_value, (int, float)) and 0 <= confidence_value <= 1
        else 0.0
    )
    estimated_cost = estimate.get("estimatedCost")
    if not isinstance(estimated_cost, dict):
        estimated_cost = {}
    return FrontendAgentResponse(
        response_id=_string(raw.get("responseId")) or "unknown-response",
        session_id=_string(raw.get("sessionId")) or "unknown-session",
        request_id=_string(raw.get("requestId")) or "unknown-request",
        state=_response_state(raw.get("state")),
        recommendation=FrontendRecommendation(
            summary=_string(recommendation.get("summary")) or "Agent recommendation",
            actions=_strings(recommendation.get("actions")),
            rationale=_strings(recommendation.get("rationale")),
            confidence=confidence,
        ),
        plan=FrontendPlan(
            plan_id=_string(plan_raw.get("planId")) or "unknown-plan",
            workflow_id=_string(plan_raw.get("workflowId")) or "unknown-workflow",
            execution_request_id=_string(plan_raw.get("executionRequestId")),
            version=_integer(plan_raw.get("version")) or 1,
            steps=tuple(steps),
            created_at=_optional_datetime(plan_raw.get("createdAt")),
            created_by_invocation_id=_string(plan_raw.get("createdByInvocationId")),
            digest=_string(plan_raw.get("digest")),
        ),
        estimate=FrontendEstimate(
            estimated_cost=estimated_cost,
            estimated_duration_ms=_integer(estimate.get("estimatedDurationMs")) or 0,
            resource_class=_string(estimate.get("resourceClass")) or "local-agent",
        ),
        run_id=_string(raw.get("runId")),
        permission_request_id=_string(raw.get("permissionRequestId")),
        artifacts=tuple(artifacts),
        explanation=_string(raw.get("explanation")),
        next_action=_string(raw.get("nextAction")),
        created_at=_datetime(raw.get("createdAt")),
        completed_at=_optional_datetime(raw.get("completedAt")),
    )


def _agent_session_snapshot(value: object) -> FrontendAgentSessionSnapshot:
    raw = _record(value)
    requests = []
    raw_requests = raw.get("requests")
    for candidate in raw_requests if isinstance(raw_requests, list) else []:
        item = _record(candidate)
        requests.append(
            FrontendAgentRequest(
                request_id=_string(item.get("requestId")) or "unknown-request",
                session_id=_string(item.get("sessionId")) or "unknown-session",
                source_interface=_interface(item.get("sourceInterface")),
                mode=_agent_mode(item.get("mode")),
                text=_string(item.get("text")) or "",
                created_at=_datetime(item.get("createdAt")),
                correlation_id=_string(item.get("correlationId")) or "unknown-correlation",
            )
        )
    events = []
    raw_events = raw.get("events")
    for candidate in raw_events if isinstance(raw_events, list) else []:
        item = _record(candidate)
        events.append(
            FrontendAgentEvent(
                event_id=_string(item.get("eventId")) or "unknown-event",
                session_id=_string(item.get("sessionId")) or "unknown-session",
                request_id=_string(item.get("requestId")) or "unknown-request",
                sequence=_integer(item.get("sequence")) or 0,
                kind=_string(item.get("kind")) or "unknown",
                payload=_record_or_empty(item.get("payload")),
                occurred_at=_datetime(item.get("occurredAt")),
                correlation_id=_string(item.get("correlationId")) or "unknown-correlation",
            )
        )
    permissions = []
    raw_permissions = raw.get("permissions")
    for candidate in raw_permissions if isinstance(raw_permissions, list) else []:
        item = _record(candidate)
        state = _string(item.get("state"))
        raw_kind = _string(item.get("kind"))
        permission_kind = cast(
            Literal["policy", "approval", "confirmation", "capability"],
            raw_kind
            if raw_kind in {"policy", "approval", "confirmation", "capability"}
            else "policy",
        )
        permission_state = cast(
            Literal["pending", "approved", "rejected", "expired", "revoked"],
            state
            if state in {"pending", "approved", "rejected", "expired", "revoked"}
            else "pending",
        )
        permissions.append(
            FrontendPermission(
                permission_request_id=_string(item.get("permissionRequestId"))
                or "unknown-permission",
                session_id=_string(item.get("sessionId")) or "unknown-session",
                request_id=_string(item.get("requestId")) or "unknown-request",
                kind=permission_kind,
                action=_string(item.get("action")) or "unknown",
                reason=_string(item.get("reason")) or "",
                resources=_strings(item.get("resources")),
                state=permission_state,
                requested_at=_datetime(item.get("requestedAt")),
                expires_at=_optional_datetime(item.get("expiresAt")),
                decided_at=_optional_datetime(item.get("decidedAt")),
            )
        )
    raw_responses = raw.get("responses")
    responses = (
        [_agent_response(candidate) for candidate in raw_responses]
        if isinstance(raw_responses, list)
        else []
    )
    return FrontendAgentSessionSnapshot(
        session=_agent_session(raw.get("session")),
        requests=tuple(requests),
        events=tuple(events),
        permissions=tuple(permissions),
        responses=tuple(responses),
    )


def _conversation_snapshot(value: object, project_id: str) -> FrontendConversationSnapshot:
    raw = _record(value)
    messages = []
    raw_messages = raw.get("messages")
    for candidate in raw_messages if isinstance(raw_messages, list) else []:
        item = _record(candidate)
        raw_role = _string(item.get("role"))
        raw_message_state = _string(item.get("state"))
        role = cast(
            Literal["user", "assistant", "system", "tool"],
            raw_role if raw_role in {"user", "assistant", "system", "tool"} else "assistant",
        )
        message_state = cast(
            Literal["streaming", "completed", "failed", "cancelled"],
            raw_message_state
            if raw_message_state in {"streaming", "completed", "failed", "cancelled"}
            else "completed",
        )
        messages.append(
            FrontendMessage(
                message_id=_string(item.get("messageId")) or "unknown-message",
                conversation_id=_string(item.get("conversationId")) or "unknown-conversation",
                project_id=_string(item.get("projectId")) or project_id,
                role=role,
                state=message_state,
                text=_string(item.get("text")) or "",
                created_at=_datetime(item.get("createdAt")),
                updated_at=_datetime(item.get("updatedAt")),
                correlation_id=_string(item.get("correlationId")),
                provider_id=_string(item.get("providerId")),
                model_id=_string(item.get("modelId")),
                tool_name=_string(item.get("toolName")),
                tool_operation=_string(item.get("toolOperation")),
            )
        )
    session_raw = raw.get("session")
    latest_raw = raw.get("latestResponse")
    return FrontendConversationSnapshot(
        conversation_id=_string(raw.get("conversationId")) or "unknown-conversation",
        project_id=_string(raw.get("projectId")) or project_id,
        session=None if session_raw is None else _agent_session(session_raw),
        latest_response=None if latest_raw is None else _agent_response(latest_raw),
        run_id=_string(raw.get("runId")),
        workflow_id=_string(raw.get("workflowId")),
        messages=tuple(messages),
        generating=raw.get("generating") is True,
        updated_at=_datetime(raw.get("updatedAt")),
    )


def _frontend_run(value: object) -> FrontendRun:
    raw = _record(value)
    error_raw = raw.get("error")
    error = None
    if error_raw is not None:
        failure = _record(error_raw)
        error = FrontendError(
            error=_string(failure.get("message")) or "Run failed",
            code=_string(failure.get("code")),
            retryable=failure.get("retryable") is True,
            details={"failureId": _string(failure.get("failureId"))},
        )
    attempts = raw.get("attemptIds")
    return FrontendRun(
        run_id=_string(raw.get("runId")) or "unknown-run",
        project_id=_string(raw.get("projectId")) or "unknown-project",
        state=_run_state_value(raw.get("state")),
        attempt_count=len(attempts) if isinstance(attempts, list) else 0,
        requested_action=_string(raw.get("requestedAction")),
        provider_id=_string(raw.get("providerId")),
        model_id=_string(raw.get("modelId")),
        error=error,
    )


def _run_detail(value: object) -> FrontendRunDetail:
    raw = _record(value)
    attempts = []
    raw_attempts = raw.get("attempts")
    if isinstance(raw_attempts, list):
        for candidate in raw_attempts:
            item = _record(candidate)
            attempts.append(
                FrontendRunAttempt(
                    attempt_id=_string(item.get("attemptId")) or "unknown-attempt",
                    run_id=_string(item.get("runId")) or "unknown-run",
                    attempt_number=_integer(item.get("attemptNumber")) or 1,
                    state=_run_state_value(item.get("state")),
                    error=_record(item.get("error")) if item.get("error") is not None else None,
                )
            )
    logs = []
    raw_logs = raw.get("logs")
    if isinstance(raw_logs, list):
        for candidate in raw_logs:
            item = _record(candidate)
            level = _string(item.get("level"))
            log_level = cast(
                Literal["info", "error", "output"],
                level if level in {"info", "error", "output"} else "info",
            )
            logs.append(
                FrontendRunLog(
                    event_id=_string(item.get("eventId")) or "unknown-event",
                    run_id=_string(item.get("runId")) or "unknown-run",
                    event_name=_string(item.get("eventName")) or "run.log",
                    occurred_at=_datetime(item.get("occurredAt")),
                    message=_string(item.get("message")) or "",
                    level=log_level,
                )
            )
    return FrontendRunDetail(
        run=_frontend_run(raw.get("run")),
        attempts=tuple(attempts),
        logs=tuple(logs),
    )


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
