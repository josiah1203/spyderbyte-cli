from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from spyderbyte_cli.adapters.ports import (
    AdapterUnavailable,
    ToolBrokerPort,
    ToolCall,
    redact_secrets,
)

ToolInvoker = Callable[[ToolCall], Awaitable[Mapping[str, Any]]]


class ToolBrokerAdapter(ToolBrokerPort):
    """Fail-closed bridge for selected Kimi tool implementations."""

    def __init__(
        self,
        invoke: ToolInvoker | None = None,
        *,
        allowed_capabilities: frozenset[str] = frozenset(),
    ) -> None:
        self._invoke = invoke
        self._allowed_capabilities = allowed_capabilities

    async def invoke(self, call: ToolCall) -> dict[str, Any]:
        if self._invoke is None:
            raise AdapterUnavailable("tool broker is not configured")
        if not call.grant_id or not call.run_id:
            raise AdapterUnavailable("tool calls require a run-bound grant")
        if call.capability not in self._allowed_capabilities:
            raise AdapterUnavailable(f"tool capability is not approved: {call.capability}")
        try:
            result = await self._invoke(call)
        except Exception as error:
            raise AdapterUnavailable("tool invocation failed") from error
        return redact_secrets(dict(result))
