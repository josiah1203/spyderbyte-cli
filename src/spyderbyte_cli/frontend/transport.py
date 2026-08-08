from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from typing import Any

import httpx

from spyderbyte_cli.frontend.models import FrontendError


class FrontendTransportError(RuntimeError):
    """A safe, structured failure from the Spyderbyte HTTP boundary."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int = 0,
        error: FrontendError | None = None,
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.error = error
        self.retryable = retryable


@dataclass(frozen=True, slots=True)
class RetryPolicy:
    max_attempts: int = 3
    base_delay: float = 0.1
    max_delay: float = 2.0
    retry_statuses: frozenset[int] = frozenset({408, 409, 425, 429, 500, 502, 503, 504})

    def __post_init__(self) -> None:
        if self.max_attempts < 1:
            raise ValueError("max_attempts must be positive")
        if self.base_delay < 0 or self.max_delay < self.base_delay:
            raise ValueError("retry delays must be non-negative and ordered")

    def delay(self, attempt: int, retry_after: str | None = None) -> float:
        if retry_after is not None:
            try:
                return max(0.0, min(self.max_delay, float(retry_after)))
            except ValueError:
                try:
                    retry_at = parsedate_to_datetime(retry_after).timestamp()
                except (TypeError, ValueError, OverflowError):
                    retry_at = 0.0
                if retry_at > 0:
                    return max(0.0, min(self.max_delay, retry_at - time.time()))
        return min(self.max_delay, self.base_delay * (2 ** max(0, attempt - 1)))


class FrontendTransport:
    """Small authenticated transport shared by JSON and SSE frontend clients."""

    def __init__(
        self,
        base_url: str,
        *,
        token: str | None = None,
        workspace_id: str | None = None,
        interface: str = "cli",
        client: httpx.AsyncClient | None = None,
        timeout: float = 30.0,
        retry_policy: RetryPolicy | None = None,
        sleeper: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        if not self.base_url:
            raise ValueError("base_url must not be empty")
        self.token = token
        self.workspace_id = workspace_id
        self.interface = interface
        self._client = client
        self._owned_client = client is None
        self._timeout = timeout
        self.retry_policy = retry_policy or RetryPolicy()
        self._sleeper = sleeper

    def _client_or_create(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(base_url=self.base_url, timeout=self._timeout)
        return self._client

    def _headers(
        self,
        *,
        accept: str = "application/json",
        idempotency_key: str | None = None,
        extra: Mapping[str, str] | None = None,
    ) -> dict[str, str]:
        headers = {"accept": accept, "x-spyderbyte-interface": self.interface}
        if self.token is not None:
            headers["authorization"] = f"Bearer {self.token}"
        if self.workspace_id is not None:
            headers["x-agentic-workspace-id"] = self.workspace_id
        if idempotency_key is not None:
            headers["idempotency-key"] = idempotency_key
        if extra is not None:
            headers.update(extra)
        return headers

    async def request(
        self,
        method: str,
        path: str,
        *,
        body: Any = None,
        idempotency_key: str | None = None,
        headers: Mapping[str, str] | None = None,
        signal: asyncio.Event | None = None,
    ) -> Any:
        method = method.upper()
        can_retry = method in {"GET", "HEAD", "OPTIONS"} or idempotency_key is not None
        last_error: FrontendTransportError | None = None
        for attempt in range(1, self.retry_policy.max_attempts + 1):
            if signal is not None and signal.is_set():
                raise asyncio.CancelledError
            try:
                response = await self._client_or_create().request(
                    method,
                    self._url(path),
                    json=body,
                    headers=self._headers(idempotency_key=idempotency_key, extra=headers),
                )
            except httpx.RequestError as error:
                if not can_retry or attempt >= self.retry_policy.max_attempts:
                    raise FrontendTransportError(
                        "Spyderbyte transport is unavailable",
                        retryable=can_retry,
                    ) from error
                await self._sleeper(self.retry_policy.delay(attempt))
                continue

            if response.is_success:
                return await self._json_body(response)

            last_error = self._response_error(response)
            if (
                not can_retry
                or response.status_code not in self.retry_policy.retry_statuses
                or attempt >= self.retry_policy.max_attempts
            ):
                raise last_error
            await self._sleeper(
                self.retry_policy.delay(attempt, response.headers.get("retry-after")),
            )
        assert last_error is not None
        raise last_error

    async def sse_lines(
        self,
        path: str,
        *,
        params: Mapping[str, str | int] | None = None,
        signal: asyncio.Event | None = None,
    ) -> AsyncIterator[str]:
        if signal is not None and signal.is_set():
            raise asyncio.CancelledError
        client = self._client_or_create()
        try:
            async with client.stream(
                "GET",
                self._url(path),
                params=params,
                headers=self._headers(accept="text/event-stream"),
            ) as response:
                if not response.is_success:
                    await response.aread()
                    raise self._response_error(response)
                async for line in response.aiter_lines():
                    if signal is not None and signal.is_set():
                        raise asyncio.CancelledError
                    yield line
        except httpx.RequestError as error:
            raise FrontendTransportError(
                "Spyderbyte event stream is unavailable",
                retryable=True,
            ) from error

    async def close(self) -> None:
        if self._client is not None and self._owned_client:
            await self._client.aclose()
            self._client = None

    def _url(self, path: str) -> str:
        if not path.startswith("/"):
            raise ValueError("frontend transport paths must be absolute")
        return f"{self.base_url}{path}"

    async def _json_body(self, response: httpx.Response) -> Any:
        if response.status_code == 204:
            return None
        try:
            return response.json()
        except (json.JSONDecodeError, ValueError) as error:
            raise FrontendTransportError(
                "Spyderbyte returned an invalid JSON response",
                status_code=response.status_code,
                error=FrontendError(
                    error="invalid_json_response",
                    code="VALIDATION_SCHEMA_MISMATCH",
                ),
            ) from error

    def _response_error(self, response: httpx.Response) -> FrontendTransportError:
        try:
            raw: Any = response.json()
        except (json.JSONDecodeError, ValueError):
            raw = {"error": response.reason_phrase or "Spyderbyte request failed"}
        if not isinstance(raw, dict):
            raw = {"error": "Spyderbyte request failed", "details": {"response": raw}}
        try:
            error = FrontendError.model_validate(raw)
        except Exception:
            error = FrontendError(
                error=str(raw.get("error", "Spyderbyte request failed")),
                code=raw.get("code") if isinstance(raw.get("code"), str) else None,
                correlation_id=(
                    raw.get("correlationId") if isinstance(raw.get("correlationId"), str) else None
                ),
            )
        return FrontendTransportError(
            error.error,
            status_code=response.status_code,
            error=error,
            retryable=response.status_code in self.retry_policy.retry_statuses,
        )
