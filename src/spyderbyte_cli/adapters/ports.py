from __future__ import annotations

from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol


@dataclass(frozen=True, slots=True)
class ContextItem:
    item_id: str
    text: str
    token_count: int
    protected: bool = False


@dataclass(frozen=True, slots=True)
class ContextSelection:
    items: tuple[ContextItem, ...]
    token_count: int
    omitted_item_ids: tuple[str, ...]


class ContextWindowManager(Protocol):
    def select(self, items: tuple[ContextItem, ...], *, token_budget: int) -> ContextSelection: ...


@dataclass(frozen=True, slots=True)
class CompactionResult:
    summary: str
    source_item_ids: tuple[str, ...]
    estimated_tokens: int


class ContextCompactor(Protocol):
    def compact(self, items: tuple[ContextItem, ...], *, token_budget: int) -> CompactionResult: ...


@dataclass(frozen=True, slots=True)
class ProviderExchange:
    provider_id: str
    model_id: str
    messages: tuple[dict[str, Any], ...]
    credential_handle: str | None = None


class ProviderTransport(Protocol):
    async def exchange(self, request: ProviderExchange) -> dict[str, Any]: ...


class AdapterUnavailable(RuntimeError):
    """Raised when a retained primitive has no Spyderbyte-owned implementation."""


@dataclass(frozen=True, slots=True)
class ProviderRequest:
    provider_id: str
    model_id: str
    messages: tuple[dict[str, Any], ...]
    credential_handle: str | None = None
    request_id: str | None = None
    stream: bool = True


@dataclass(frozen=True, slots=True)
class ProviderUsage:
    input_tokens: int = 0
    output_tokens: int = 0
    cached_tokens: int = 0


@dataclass(frozen=True, slots=True)
class ProviderResponse:
    provider_id: str
    model_id: str
    text: str
    finish_reason: str | None = None
    usage: ProviderUsage = ProviderUsage()
    provider_request_id: str | None = None
    raw: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ProviderDelta:
    text: str = ""
    finish_reason: str | None = None
    usage: ProviderUsage | None = None


class ProviderTransportAdapter(Protocol):
    async def exchange(self, request: ProviderRequest) -> ProviderResponse: ...

    def stream(self, request: ProviderRequest) -> AsyncIterator[ProviderDelta]: ...


class ToolBrokerPort(Protocol):
    async def invoke(self, call: ToolCall) -> dict[str, Any]: ...


class ProcessRuntimePort(Protocol):
    async def execute(self, request: ProcessRequest) -> dict[str, Any]: ...


class BackgroundExecutionPort(Protocol):
    async def start(self, *, parent_run_id: str, child_run_id: str) -> None: ...

    async def cancel(self, *, run_id: str) -> None: ...


@dataclass(frozen=True, slots=True)
class CredentialLease:
    handle: str
    expires_at: datetime


def redact_secrets(value: Any) -> Any:
    """Return telemetry-safe data without ever copying credential-shaped values."""

    if isinstance(value, str):
        return value
    if isinstance(value, Mapping):
        return {
            str(key): "[REDACTED]"
            if any(part in str(key).lower() for part in ("token", "secret", "password", "api_key"))
            else redact_secrets(item)
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [redact_secrets(item) for item in value]
    return value


def normalize_provider_response(
    request: ProviderRequest,
    raw: Mapping[str, Any],
) -> ProviderResponse:
    """Normalize OpenAI-compatible/Kosong-shaped responses at the adapter boundary."""

    choices = raw.get("choices")
    first = choices[0] if isinstance(choices, list) and choices else {}
    message = first.get("message") if isinstance(first, Mapping) else {}
    text = ""
    if isinstance(message, Mapping) and isinstance(message.get("content"), str):
        text = message["content"]
    elif isinstance(first, Mapping) and isinstance(first.get("text"), str):
        text = first["text"]
    usage_value = raw.get("usage")
    usage = usage_value if isinstance(usage_value, Mapping) else {}
    return ProviderResponse(
        provider_id=request.provider_id,
        model_id=request.model_id,
        text=text,
        finish_reason=first.get("finish_reason") if isinstance(first, Mapping) else None,
        usage=ProviderUsage(
            input_tokens=_non_negative_int(usage.get("prompt_tokens"), 0),
            output_tokens=_non_negative_int(usage.get("completion_tokens"), 0),
            cached_tokens=_non_negative_int(usage.get("cached_tokens"), 0),
        ),
        provider_request_id=raw.get("id") if isinstance(raw.get("id"), str) else None,
        raw=redact_secrets(raw),
    )


def _non_negative_int(value: Any, fallback: int) -> int:
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    return fallback


@dataclass(frozen=True, slots=True)
class ToolCall:
    capability: str
    arguments: dict[str, Any]
    grant_id: str
    run_id: str


class ToolImplementation(Protocol):
    async def invoke(self, call: ToolCall) -> dict[str, Any]: ...


@dataclass(frozen=True, slots=True)
class ProcessRequest:
    argv: tuple[str, ...]
    cwd: str
    environment: dict[str, str] = field(default_factory=dict)
    timeout_ms: int = 30_000


class LocalProcessRuntime(Protocol):
    async def execute(self, request: ProcessRequest) -> dict[str, Any]: ...


class BackgroundExecution(Protocol):
    async def start(self, *, parent_run_id: str, child_run_id: str) -> None: ...

    async def cancel(self, *, run_id: str) -> None: ...


class CheckpointCache(Protocol):
    def load(self, cache_key: str) -> dict[str, Any] | None: ...

    def store(self, cache_key: str, value: dict[str, Any]) -> None: ...
