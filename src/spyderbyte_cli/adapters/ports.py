from __future__ import annotations

from dataclasses import dataclass, field
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
