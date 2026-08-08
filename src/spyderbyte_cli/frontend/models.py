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


class FrontendError(FrontendModel):
    """Stable error envelope exposed to every frontend transport."""

    schema_version: Literal[1] = FRONTEND_SCHEMA_VERSION
    error: str
    code: str | None = None
    correlation_id: str | None = None
    retryable: bool = False
    details: dict[str, Any] = Field(default_factory=dict)


class EventPage(FrontendModel):
    """A reconnectable, cursor-addressed page from the backend event stream."""

    schema_version: Literal[1] = FRONTEND_SCHEMA_VERSION
    cursor: int = Field(ge=0)
    events: tuple[FrontendEvent, ...] = ()
    gap_detected: bool = False
    refresh_required: bool = False


FrontendRunState = Literal[
    "accepted",
    "queued",
    "running",
    "awaiting_approval",
    "succeeded",
    "failed",
    "cancelled",
    "timed_out",
    "partially_succeeded",
]


class FrontendRun(FrontendModel):
    schema_version: Literal[1] = FRONTEND_SCHEMA_VERSION
    run_id: str
    project_id: str
    state: FrontendRunState
    attempt_count: int = Field(default=0, ge=0)
    requested_action: str | None = None
    error: FrontendError | None = None


class FrontendApproval(FrontendModel):
    schema_version: Literal[1] = FRONTEND_SCHEMA_VERSION
    approval_id: str
    run_id: str
    state: Literal["pending", "approved", "rejected", "revoked"]
    action: dict[str, Any] = Field(default_factory=dict)
    resources: tuple[str, ...] = ()


class FrontendArtifact(FrontendModel):
    schema_version: Literal[1] = FRONTEND_SCHEMA_VERSION
    artifact_id: str
    version: int = Field(ge=1)
    media_type: str
    content_hash: str | None = None
    title: str | None = None


class FrontendUsage(FrontendModel):
    schema_version: Literal[1] = FRONTEND_SCHEMA_VERSION
    run_id: str
    input_tokens: int = Field(default=0, ge=0)
    output_tokens: int = Field(default=0, ge=0)
    estimated_cost: float | None = Field(default=None, ge=0)
    actual_cost: float | None = Field(default=None, ge=0)


FrontendInterface = Literal["tui", "cli", "acp", "api", "mock"]


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


EventPage.model_rebuild()
