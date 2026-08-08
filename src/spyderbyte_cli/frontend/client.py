from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Protocol

from spyderbyte_cli.frontend.models import (
    FrontendCapabilities,
    FrontendEvent,
    FrontendSession,
    PromptAcceptance,
)


class FrontendClient(Protocol):
    async def open_session(self) -> FrontendSession: ...

    async def send_prompt(self, prompt: str) -> PromptAcceptance: ...

    def events(self, *, after_cursor: int = 0) -> AsyncIterator[FrontendEvent]: ...


class MockFrontendClient:
    """Deterministic fixture client used before the HTTP transport lands in Wave 2."""

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

    async def send_prompt(self, prompt: str) -> PromptAcceptance:
        if not prompt.strip():
            raise ValueError("prompt must not be empty")
        acceptance = PromptAcceptance(
            request_id="req_mock_01",
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

    async def events(self, *, after_cursor: int = 0) -> AsyncIterator[FrontendEvent]:
        for event in self._events:
            if event.cursor > after_cursor:
                yield event
