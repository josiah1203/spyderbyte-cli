from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

FRONTEND_SCHEMA_VERSION = 1


def _camel(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part.title() for part in tail)


class FrontendModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=_camel,
        extra="forbid",
        frozen=True,
        populate_by_name=True,
    )


class FrontendCapabilities(FrontendModel):
    schema_version: Literal[1] = FRONTEND_SCHEMA_VERSION
    api_version: str
    event_stream: Literal["sse"] = "sse"
    event_resume: bool = True
    native_resources: tuple[str, ...] = ()


class FrontendSession(FrontendModel):
    schema_version: Literal[1] = FRONTEND_SCHEMA_VERSION
    session_id: str
    project_id: str
    agent_session_id: str
    workspace_id: str
    actor_id: str
    mode: Literal["local", "hosted", "mock"]
    capabilities: FrontendCapabilities
    issued_at: datetime


class PromptAcceptance(FrontendModel):
    schema_version: Literal[1] = FRONTEND_SCHEMA_VERSION
    request_id: str
    project_id: str
    agent_session_id: str
    user_message_id: str
    assistant_message_id: str
    run_id: str
    accepted_at: datetime


FrontendEventKind = Literal[
    "session.ready",
    "turn.accepted",
    "assistant.delta",
    "run.status",
    "approval.requested",
    "approval.committed",
    "artifact.available",
    "usage.updated",
    "stream.end",
]


class FrontendEvent(FrontendModel):
    schema_version: Literal[1] = FRONTEND_SCHEMA_VERSION
    event_id: str
    cursor: int = Field(ge=0)
    kind: FrontendEventKind
    occurred_at: datetime
    project_id: str
    agent_session_id: str
    run_id: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
