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


class FrontendProviderCatalog(FrontendModel):
    schema_version: Literal[1] = FRONTEND_SCHEMA_VERSION
    providers: tuple[dict[str, Any], ...] = ()
    credentials: tuple[dict[str, Any], ...] = ()
    models: tuple[dict[str, Any], ...] = ()


class FrontendModelCatalog(FrontendModel):
    schema_version: Literal[1] = FRONTEND_SCHEMA_VERSION
    models: tuple[dict[str, Any], ...] = ()
    runtimes: tuple[dict[str, Any], ...] = ()
    provider_priority: tuple[str, ...] = ()
    routing_policy: dict[str, Any] = Field(default_factory=dict)


class FrontendRuntimeCatalog(FrontendModel):
    schema_version: Literal[1] = FRONTEND_SCHEMA_VERSION
    profiles: tuple[dict[str, Any], ...] = ()
    revisions: tuple[dict[str, Any], ...] = ()


FrontendInterface = Literal[
    "tui",
    "cli",
    "acp",
    "api",
    "jupyter",
    "web",
    "automation",
    "system",
    "mock",
]


class FrontendProject(FrontendModel):
    schema_version: Literal[1] = FRONTEND_SCHEMA_VERSION
    project_id: str
    name: str
    status: Literal["active", "archived"] = "active"
    objective: str | None = None
    version: int = Field(default=0, ge=0)
    updated_at: datetime | None = None


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
    tenant_id: str | None = None


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
]


class FrontendRun(FrontendModel):
    schema_version: Literal[1] = FRONTEND_SCHEMA_VERSION
    run_id: str
    project_id: str
    state: FrontendRunState
    attempt_count: int = Field(default=0, ge=0)
    requested_action: str | None = None
    provider_id: str | None = None
    model_id: str | None = None
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


class FrontendAgentSession(FrontendModel):
    schema_version: Literal[1] = FRONTEND_SCHEMA_VERSION
    session_id: str
    workspace_id: str
    project_id: str | None = None
    source_interface: FrontendInterface
    mode: Literal["conversation", "planning", "approval", "execution", "review"]
    state: Literal["active", "awaiting_approval", "running", "completed", "failed", "cancelled"]
    request_ids: tuple[str, ...] = ()
    current_run_id: str | None = None
    created_at: datetime
    updated_at: datetime


class FrontendAgentRequest(FrontendModel):
    schema_version: Literal[1] = FRONTEND_SCHEMA_VERSION
    request_id: str
    session_id: str
    source_interface: FrontendInterface
    mode: Literal["conversation", "planning", "approval", "execution", "review"]
    text: str
    created_at: datetime
    correlation_id: str


class FrontendAgentEvent(FrontendModel):
    schema_version: Literal[1] = FRONTEND_SCHEMA_VERSION
    event_id: str
    session_id: str
    request_id: str
    sequence: int = Field(ge=0)
    kind: str
    payload: dict[str, Any] = Field(default_factory=dict)
    occurred_at: datetime
    correlation_id: str


class FrontendPermission(FrontendModel):
    schema_version: Literal[1] = FRONTEND_SCHEMA_VERSION
    permission_request_id: str
    session_id: str
    request_id: str
    kind: Literal["policy", "approval", "confirmation", "capability"]
    action: str
    reason: str
    resources: tuple[str, ...] = ()
    state: Literal["pending", "approved", "rejected", "expired", "revoked"]
    requested_at: datetime
    expires_at: datetime | None = None
    decided_at: datetime | None = None


class FrontendRecommendation(FrontendModel):
    schema_version: Literal[1] = FRONTEND_SCHEMA_VERSION
    summary: str
    actions: tuple[str, ...] = ()
    rationale: tuple[str, ...] = ()
    confidence: float = Field(ge=0, le=1)


class FrontendPlanStep(FrontendModel):
    schema_version: Literal[1] = FRONTEND_SCHEMA_VERSION
    step_id: str
    tier: int = Field(ge=0)
    agent_type: str
    title: str
    description: str
    depends_on: tuple[str, ...] = ()
    input_artifact_ids: tuple[str, ...] = ()
    required_capabilities: tuple[str, ...] = ()
    approval_required: bool = False
    expected_outputs: tuple[str, ...] = ()
    acceptance_criteria: tuple[str, ...] = ()


class FrontendPlan(FrontendModel):
    schema_version: Literal[1] = FRONTEND_SCHEMA_VERSION
    plan_id: str
    workflow_id: str
    execution_request_id: str | None = None
    version: int = Field(ge=1)
    steps: tuple[FrontendPlanStep, ...] = ()
    created_at: datetime | None = None
    created_by_invocation_id: str | None = None
    digest: str | None = None


class FrontendEstimate(FrontendModel):
    schema_version: Literal[1] = FRONTEND_SCHEMA_VERSION
    estimated_cost: dict[str, Any] = Field(default_factory=dict)
    estimated_duration_ms: int = Field(ge=0)
    resource_class: str


class FrontendAgentResponse(FrontendModel):
    schema_version: Literal[1] = FRONTEND_SCHEMA_VERSION
    response_id: str
    session_id: str
    request_id: str
    state: Literal["accepted", "awaiting_permission", "completed", "failed", "cancelled"]
    recommendation: FrontendRecommendation
    plan: FrontendPlan
    estimate: FrontendEstimate
    run_id: str | None = None
    permission_request_id: str | None = None
    artifacts: tuple[FrontendArtifact, ...] = ()
    explanation: str | None = None
    next_action: str | None = None
    created_at: datetime
    completed_at: datetime | None = None


class FrontendAgentSessionSnapshot(FrontendModel):
    schema_version: Literal[1] = FRONTEND_SCHEMA_VERSION
    session: FrontendAgentSession
    requests: tuple[FrontendAgentRequest, ...] = ()
    events: tuple[FrontendAgentEvent, ...] = ()
    permissions: tuple[FrontendPermission, ...] = ()
    responses: tuple[FrontendAgentResponse, ...] = ()


class FrontendMessage(FrontendModel):
    schema_version: Literal[1] = FRONTEND_SCHEMA_VERSION
    message_id: str
    conversation_id: str
    project_id: str
    role: Literal["user", "assistant", "system", "tool"]
    state: Literal["streaming", "completed", "failed", "cancelled"]
    text: str
    created_at: datetime
    updated_at: datetime
    correlation_id: str | None = None
    provider_id: str | None = None
    model_id: str | None = None
    tool_name: str | None = None
    tool_operation: str | None = None


class FrontendConversationSnapshot(FrontendModel):
    schema_version: Literal[1] = FRONTEND_SCHEMA_VERSION
    conversation_id: str
    project_id: str
    session: FrontendAgentSession | None = None
    latest_response: FrontendAgentResponse | None = None
    run_id: str | None = None
    workflow_id: str | None = None
    messages: tuple[FrontendMessage, ...] = ()
    generating: bool = False
    updated_at: datetime


class FrontendRunAttempt(FrontendModel):
    schema_version: Literal[1] = FRONTEND_SCHEMA_VERSION
    attempt_id: str
    run_id: str
    attempt_number: int = Field(ge=1)
    state: str
    error: dict[str, Any] | None = None


class FrontendRunLog(FrontendModel):
    schema_version: Literal[1] = FRONTEND_SCHEMA_VERSION
    event_id: str
    run_id: str
    event_name: str
    occurred_at: datetime
    message: str
    level: Literal["info", "error", "output"]


class FrontendRunDetail(FrontendModel):
    schema_version: Literal[1] = FRONTEND_SCHEMA_VERSION
    run: FrontendRun
    attempts: tuple[FrontendRunAttempt, ...] = ()
    logs: tuple[FrontendRunLog, ...] = ()


EventPage.model_rebuild()
