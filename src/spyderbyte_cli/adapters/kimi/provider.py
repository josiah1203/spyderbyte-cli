from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from typing import Any

from spyderbyte_cli.adapters.ports import (
    AdapterUnavailable,
    ProviderDelta,
    ProviderRequest,
    ProviderResponse,
    ProviderTransportAdapter,
    ProviderUsage,
    normalize_provider_response,
    redact_secrets,
)

ProviderExchange = Callable[[ProviderRequest], Awaitable[Mapping[str, Any]]]
ProviderStream = Callable[[ProviderRequest], AsyncIterator[Mapping[str, Any] | ProviderDelta]]


class KosongProviderTransportAdapter(ProviderTransportAdapter):
    """Conform a selected Kosong transport to a Spyderbyte-owned provider port.

    The adapter accepts callables rather than importing Kosong's provider authority. Credential
    resolution therefore stays in the backend and only an opaque lease handle crosses this seam.
    """

    def __init__(
        self,
        exchange: ProviderExchange | None = None,
        stream: ProviderStream | None = None,
    ) -> None:
        self._exchange = exchange
        self._stream_fn = stream

    async def exchange(self, request: ProviderRequest) -> ProviderResponse:
        if self._exchange is None:
            raise AdapterUnavailable("provider transport is not configured")
        try:
            raw = await self._exchange(request)
        except Exception as error:
            raise AdapterUnavailable("provider transport exchange failed") from error
        return normalize_provider_response(request, redact_secrets(raw))

    async def _stream(self, request: ProviderRequest) -> AsyncIterator[ProviderDelta]:
        if self._stream_fn is None:
            raise AdapterUnavailable("provider streaming transport is not configured")
        try:
            async for raw in self._stream_fn(request):
                if isinstance(raw, ProviderDelta):
                    yield raw
                    continue
                yield _normalize_delta(raw)
        except AdapterUnavailable:
            raise
        except Exception as error:
            raise AdapterUnavailable("provider streaming transport failed") from error

    def stream(self, request: ProviderRequest) -> AsyncIterator[ProviderDelta]:
        return self._stream(request)


def _normalize_delta(raw: Mapping[str, Any]) -> ProviderDelta:
    choices = raw.get("choices")
    first = choices[0] if isinstance(choices, list) and choices else {}
    delta = first.get("delta") if isinstance(first, Mapping) else {}
    text = ""
    if isinstance(delta, Mapping) and isinstance(delta.get("content"), str):
        text = delta["content"]
    elif isinstance(first, Mapping) and isinstance(first.get("text"), str):
        text = first["text"]
    usage_value = raw.get("usage")
    usage = usage_value if isinstance(usage_value, Mapping) else None
    return ProviderDelta(
        text=text,
        finish_reason=first.get("finish_reason") if isinstance(first, Mapping) else None,
        usage=(
            None
            if usage is None
            else ProviderUsage(
                input_tokens=_integer(usage.get("prompt_tokens")),
                output_tokens=_integer(usage.get("completion_tokens")),
                cached_tokens=_integer(usage.get("cached_tokens")),
            )
        ),
    )


def _integer(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0
