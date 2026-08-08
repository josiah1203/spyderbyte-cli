from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from spyderbyte_cli.adapters.ports import AdapterUnavailable, BackgroundExecutionPort


@dataclass(frozen=True, slots=True)
class RuntimeAttempt:
    attempt: int
    error: str | None = None


class AgentRuntimeAdapter:
    """Retry/coordination mechanics with no durable session or Run authority."""

    async def execute(
        self,
        operation: Callable[[RuntimeAttempt], Awaitable[Any]],
        *,
        max_attempts: int = 2,
        retryable: Callable[[Exception], bool] | None = None,
    ) -> Any:
        if max_attempts < 1:
            raise ValueError("max_attempts must be positive")
        retryable = retryable or (lambda _error: True)
        for attempt in range(1, max_attempts + 1):
            try:
                return await operation(RuntimeAttempt(attempt=attempt))
            except Exception as error:
                if attempt >= max_attempts or not retryable(error):
                    raise
                await asyncio.sleep(0)
        raise AssertionError("unreachable")


@dataclass(slots=True)
class InMemoryBackgroundExecution(BackgroundExecutionPort):
    """Parent/child bookkeeping only; the backend remains the durable authority."""

    children: dict[str, set[str]] = field(default_factory=dict)
    cancelled: set[str] = field(default_factory=set)

    async def start(self, *, parent_run_id: str, child_run_id: str) -> None:
        if not parent_run_id or not child_run_id or parent_run_id == child_run_id:
            raise AdapterUnavailable("background Runs require distinct parent and child IDs")
        children = self.children.setdefault(parent_run_id, set())
        if child_run_id in children:
            raise AdapterUnavailable("background child Run is already registered")
        children.add(child_run_id)

    async def cancel(self, *, run_id: str) -> None:
        if not run_id:
            raise AdapterUnavailable("background cancellation requires a Run ID")
        self.cancelled.add(run_id)
