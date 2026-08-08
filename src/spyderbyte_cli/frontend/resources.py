from __future__ import annotations

import secrets
import time
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal, NoReturn, Protocol, cast
from urllib.parse import quote

from spyderbyte_cli.frontend.models import (
    FrontendError,
    FrontendResourceCapability,
    FrontendResourceOperation,
    FrontendResourceRequest,
    FrontendResourceResult,
    FrontendResourceType,
)
from spyderbyte_cli.frontend.transport import FrontendTransport

RESOURCE_TYPES: tuple[FrontendResourceType, ...] = (
    "dataset",
    "sql",
    "notebook",
    "experiment",
    "model",
    "visualization",
    "pipeline",
    "automation",
)

RESOURCE_OPERATIONS: tuple[FrontendResourceOperation, ...] = (
    "discover",
    "invoke",
    "observe",
    "resume",
    "cancel",
    "inspect",
    "compare",
    "publish",
    "export",
    "handoff",
)

_METHOD = Literal["GET", "POST"]


@dataclass(frozen=True, slots=True)
class _ResourceRoute:
    method: _METHOD
    path: str
    body: dict[str, Any] | None = None


class FrontendResourceError(ValueError):
    """A typed resource-operation failure before a backend request is made."""

    def __init__(
        self, message: str, *, code: str, details: Mapping[str, Any] | None = None
    ) -> None:
        self.error = FrontendError(error=message, code=code, details=dict(details or {}))
        super().__init__(message)


class FrontendResourceClient(Protocol):
    async def execute(
        self,
        resource_type: FrontendResourceType,
        operation: FrontendResourceOperation,
        *,
        resource_id: str | None = None,
        run_id: str | None = None,
        payload: Mapping[str, Any] | None = None,
    ) -> FrontendResourceResult: ...


_ROUTE_FAMILIES: tuple[tuple[FrontendResourceType, str], ...] = (
    ("dataset", "local-data"),
    ("sql", "local-query"),
    ("notebook", "local-notebook"),
    ("experiment", "local-experiment"),
    ("model", "local-model-serving"),
    ("visualization", "local-visualization"),
    ("pipeline", "local-pipeline"),
    ("automation", "local-automation"),
)

_CAPABILITIES: dict[FrontendResourceType, FrontendResourceCapability] = {
    resource_type: FrontendResourceCapability(
        resource_type=resource_type,
        operations=RESOURCE_OPERATIONS,
        route_family=route_family,
    )
    for resource_type, route_family in _ROUTE_FAMILIES
}

_ITEM_KEYS = (
    "items",
    "datasets",
    "versions",
    "queries",
    "notebooks",
    "experiments",
    "runs",
    "models",
    "deployments",
    "endpoints",
    "pipelines",
    "automations",
    "notifications",
    "connections",
    "sources",
    "comparisons",
    "evaluations",
    "profiles",
    "revisions",
    "events",
    "types",
)

_RESOURCE_ID_KEYS: dict[FrontendResourceType, tuple[str, ...]] = {
    "dataset": ("datasetId", "versionId", "resourceId", "id"),
    "sql": ("queryId", "savedQueryId", "resourceId", "id"),
    "notebook": ("notebookId", "resourceId", "id"),
    "experiment": ("experimentId", "comparisonId", "evaluationId", "resourceId", "id"),
    "model": ("modelVersionId", "deploymentId", "endpointId", "resourceId", "id"),
    "visualization": ("visualizationId", "resourceId", "id"),
    "pipeline": ("pipelineId", "resourceId", "id"),
    "automation": ("automationId", "resourceId", "id"),
}


def _new_sortable_id() -> str:
    timestamp_ms = int(time.time() * 1000) & ((1 << 48) - 1)
    random_a = secrets.randbits(12)
    random_b = secrets.randbits(62)
    value = (timestamp_ms << 80) | (0x7 << 76) | (random_a << 64) | (0b10 << 62) | random_b
    return str(uuid.UUID(int=value))


def _record(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _path_id(value: str) -> str:
    return quote(value, safe="")


def _body(request: FrontendResourceRequest, **updates: Any) -> dict[str, Any]:
    body = dict(request.payload)
    for key, value in updates.items():
        if key not in body and value is not None:
            body[key] = value
    return body


def _query(path: str, key: str, value: Any) -> str:
    if value is None:
        return path
    separator = "&" if "?" in path else "?"
    return f"{path}{separator}{quote(key, safe='')}={quote(str(value), safe='')}"


def resource_capabilities() -> tuple[FrontendResourceCapability, ...]:
    return tuple(_CAPABILITIES[resource_type] for resource_type in RESOURCE_TYPES)


class NativeResourceClient:
    """Typed computational-resource operations over the shared Spyderbyte API.

    The route table is deliberately explicit.  Resource operations never accept an arbitrary
    path, so terminal callers cannot bypass the API's tenant, policy, approval, run, or audit
    boundaries with a shell-style escape hatch.
    """

    def __init__(self, transport: FrontendTransport) -> None:
        self.transport = transport

    async def execute(
        self,
        resource_type: FrontendResourceType,
        operation: FrontendResourceOperation,
        *,
        resource_id: str | None = None,
        run_id: str | None = None,
        payload: Mapping[str, Any] | None = None,
    ) -> FrontendResourceResult:
        request = FrontendResourceRequest(
            resource_type=resource_type,
            operation=operation,
            resource_id=resource_id,
            run_id=run_id,
            payload=dict(payload or {}),
        )
        route = self._route(request)
        body = route.body
        idempotency_key: str | None = None
        if route.method == "POST":
            idempotency_key = _string(request.payload.get("idempotencyKey")) or _new_sortable_id()
            body = body or {}
        raw = await self.transport.request(
            route.method,
            route.path,
            body=body,
            idempotency_key=idempotency_key,
        )
        return _normalise_result(request, raw)

    async def discover(
        self,
        resource_type: FrontendResourceType,
        *,
        payload: Mapping[str, Any] | None = None,
    ) -> FrontendResourceResult:
        return await self.execute(resource_type, "discover", payload=payload)

    async def invoke(
        self,
        resource_type: FrontendResourceType,
        *,
        resource_id: str | None = None,
        payload: Mapping[str, Any] | None = None,
    ) -> FrontendResourceResult:
        return await self.execute(resource_type, "invoke", resource_id=resource_id, payload=payload)

    async def observe(
        self,
        resource_type: FrontendResourceType,
        *,
        resource_id: str | None = None,
        run_id: str | None = None,
        payload: Mapping[str, Any] | None = None,
    ) -> FrontendResourceResult:
        return await self.execute(
            resource_type,
            "observe",
            resource_id=resource_id,
            run_id=run_id,
            payload=payload,
        )

    async def resume(
        self,
        resource_type: FrontendResourceType,
        *,
        resource_id: str | None = None,
        run_id: str | None = None,
        payload: Mapping[str, Any] | None = None,
    ) -> FrontendResourceResult:
        return await self.execute(
            resource_type,
            "resume",
            resource_id=resource_id,
            run_id=run_id,
            payload=payload,
        )

    async def cancel(
        self,
        resource_type: FrontendResourceType,
        *,
        resource_id: str | None = None,
        run_id: str | None = None,
        payload: Mapping[str, Any] | None = None,
    ) -> FrontendResourceResult:
        return await self.execute(
            resource_type,
            "cancel",
            resource_id=resource_id,
            run_id=run_id,
            payload=payload,
        )

    async def inspect(
        self,
        resource_type: FrontendResourceType,
        *,
        resource_id: str | None = None,
        run_id: str | None = None,
        payload: Mapping[str, Any] | None = None,
    ) -> FrontendResourceResult:
        return await self.execute(
            resource_type,
            "inspect",
            resource_id=resource_id,
            run_id=run_id,
            payload=payload,
        )

    async def compare(
        self,
        resource_type: FrontendResourceType,
        *,
        payload: Mapping[str, Any] | None = None,
    ) -> FrontendResourceResult:
        return await self.execute(resource_type, "compare", payload=payload)

    async def publish(
        self,
        resource_type: FrontendResourceType,
        *,
        resource_id: str | None = None,
        payload: Mapping[str, Any] | None = None,
    ) -> FrontendResourceResult:
        return await self.execute(
            resource_type, "publish", resource_id=resource_id, payload=payload
        )

    async def export(
        self,
        resource_type: FrontendResourceType,
        *,
        resource_id: str | None = None,
        payload: Mapping[str, Any] | None = None,
    ) -> FrontendResourceResult:
        return await self.execute(resource_type, "export", resource_id=resource_id, payload=payload)

    async def handoff(
        self,
        resource_type: FrontendResourceType,
        *,
        resource_id: str | None = None,
        payload: Mapping[str, Any] | None = None,
    ) -> FrontendResourceResult:
        return await self.execute(
            resource_type, "handoff", resource_id=resource_id, payload=payload
        )

    def _route(self, request: FrontendResourceRequest) -> _ResourceRoute:
        resource_type = request.resource_type
        operation = request.operation
        resource_id = request.resource_id
        run_id = request.run_id
        payload = request.payload

        if operation == "discover":
            paths = {
                "dataset": "/v1/datasets/local",
                "sql": "/v1/data/queries",
                "notebook": "/v1/notebooks",
                "experiment": "/v1/experiments/local",
                "model": "/v1/models/local/registry",
                "visualization": "/v1/visualizations/catalog",
                "pipeline": "/v1/pipelines/local",
                "automation": "/v1/automations/local",
            }
            path = paths[resource_type]
            if resource_type == "model" and _string(payload.get("modelName")) is not None:
                path = _query(path, "modelName", payload["modelName"])
            return _ResourceRoute("GET", path)

        if operation == "invoke":
            if resource_type == "dataset":
                return _ResourceRoute("POST", "/v1/datasets/local/versions", _body(request))
            if resource_type == "sql":
                return _ResourceRoute(
                    "POST",
                    "/v1/data/queries",
                    _body(request, queryId=resource_id or _new_sortable_id()),
                )
            if resource_type == "notebook":
                self._require(resource_id, resource_type, operation)
                return _ResourceRoute(
                    "POST", f"/v1/notebooks/{_path_id(cast(str, resource_id))}/run", _body(request)
                )
            if resource_type == "experiment":
                if resource_id is None:
                    return _ResourceRoute("POST", "/v1/experiments/local", _body(request))
                return _ResourceRoute(
                    "POST",
                    f"/v1/experiments/local/{_path_id(resource_id)}/runs",
                    _body(request),
                )
            if resource_type == "model":
                self._require(resource_id, resource_type, operation)
                return _ResourceRoute(
                    "POST",
                    f"/v1/deployments/local/{_path_id(cast(str, resource_id))}/invoke",
                    _body(request),
                )
            if resource_type == "visualization":
                return _ResourceRoute("POST", "/v1/visualizations/render", _body(request))
            if resource_type == "pipeline":
                self._require(resource_id, resource_type, operation)
                return _ResourceRoute(
                    "POST",
                    f"/v1/pipelines/local/{_path_id(cast(str, resource_id))}/run",
                    _body(request),
                )
            self._require(resource_id, resource_type, operation)
            return _ResourceRoute(
                "POST",
                f"/v1/automations/local/{_path_id(cast(str, resource_id))}/trigger",
                _body(request),
            )

        if operation == "observe":
            if resource_type == "dataset":
                self._require(resource_id, resource_type, operation)
                return self._detail_route(
                    request,
                    f"/v1/datasets/local/{_path_id(cast(str, resource_id))}",
                    required=False,
                )
            if resource_type == "sql":
                self._require(resource_id, resource_type, operation)
                return self._detail_route(
                    request,
                    f"/v1/data/queries/{_path_id(cast(str, resource_id))}",
                    required=False,
                )
            if resource_type == "notebook":
                self._require(resource_id, resource_type, operation)
                path = f"/v1/notebooks/{_path_id(cast(str, resource_id))}"
                if run_id is not None:
                    path += f"/runs/{_path_id(run_id)}"
                return _ResourceRoute("GET", path)
            if resource_type == "experiment":
                if run_id is not None:
                    return _ResourceRoute("GET", f"/v1/experiment-runs/local/{_path_id(run_id)}")
                if resource_id is not None:
                    return _ResourceRoute("GET", f"/v1/experiments/local/{_path_id(resource_id)}")
                return _ResourceRoute("GET", "/v1/experiments/local")
            if resource_type == "model":
                if resource_id is None:
                    return _ResourceRoute("GET", "/v1/models/local/registry")
                return _ResourceRoute(
                    "POST",
                    f"/v1/deployments/local/{_path_id(resource_id)}/observe",
                    {},
                )
            if resource_type == "visualization":
                return _ResourceRoute("POST", "/v1/visualizations/validate", _body(request))
            if resource_type == "pipeline":
                if run_id is not None:
                    return _ResourceRoute("GET", f"/v1/pipelines/local/runs/{_path_id(run_id)}")
                if resource_id is None:
                    return _ResourceRoute("GET", "/v1/pipelines/local")
                return _ResourceRoute("GET", f"/v1/pipelines/local/{_path_id(resource_id)}")
            if resource_id is None:
                return _ResourceRoute("GET", "/v1/automations/local")
            return _ResourceRoute("GET", f"/v1/automations/local/{_path_id(resource_id)}")

        if operation in {"resume", "cancel"}:
            action = "retry" if operation == "resume" else "cancel"
            if resource_type == "automation" and resource_id is not None and run_id is None:
                return _ResourceRoute(
                    "POST",
                    f"/v1/automations/local/{_path_id(resource_id)}/{
                        'resume' if operation == 'resume' else 'pause'
                    }",
                    _body(request),
                )
            if resource_type == "experiment" and run_id is not None:
                return _ResourceRoute(
                    "POST",
                    f"/v1/experiment-runs/local/{_path_id(run_id)}/{action}",
                    _body(request),
                )
            if resource_type == "pipeline" and run_id is not None:
                stage_id = _string(payload.get("stageId"))
                if operation == "resume" and stage_id is not None:
                    return _ResourceRoute(
                        "POST",
                        f"/v1/pipelines/local/runs/{_path_id(run_id)}/stages/{_path_id(stage_id)}/retry",
                        _body(request),
                    )
                return _ResourceRoute(
                    "POST", f"/v1/runs/{_path_id(run_id)}/{action}", _body(request)
                )
            if resource_type == "sql" and operation == "cancel" and resource_id is not None:
                return _ResourceRoute(
                    "POST", f"/v1/data/queries/{_path_id(resource_id)}/cancel", _body(request)
                )
            if resource_type == "model" and resource_id is not None:
                model_action = "restart" if operation == "resume" else "stop"
                return _ResourceRoute(
                    "POST",
                    f"/v1/deployments/local/{_path_id(resource_id)}/{model_action}",
                    _body(request),
                )
            if resource_type == "notebook" and operation == "cancel":
                cell_id = _string(payload.get("cellId"))
                if resource_id is not None and cell_id is not None:
                    return _ResourceRoute(
                        "POST",
                        f"/v1/notebooks/{_path_id(resource_id)}/cells/{_path_id(cell_id)}/cancel",
                        _body(request),
                    )
            if run_id is not None:
                return _ResourceRoute(
                    "POST", f"/v1/runs/{_path_id(run_id)}/{action}", _body(request)
                )
            self._require(run_id, resource_type, operation, name="run_id")

        if operation == "inspect":
            facet = _string(payload.get("facet")) or "detail"
            if resource_type == "dataset":
                self._require(resource_id, resource_type, operation)
                base = f"/v1/datasets/local/{_path_id(cast(str, resource_id))}"
                if facet in {"profile", "quality", "lineage"}:
                    return _ResourceRoute(
                        "GET", _query(f"{base}/{facet}", "version", payload.get("version"))
                    )
                return _ResourceRoute("GET", _query(base, "version", payload.get("version")))
            if resource_type == "sql":
                if facet == "saved":
                    return _ResourceRoute("GET", "/v1/data/saved-queries")
                if facet == "connections":
                    return _ResourceRoute("GET", "/v1/data/connections")
                connection_id = _string(payload.get("connectionId"))
                if facet == "schema" and connection_id is not None:
                    return _ResourceRoute(
                        "GET", f"/v1/data/connections/{_path_id(connection_id)}/schema"
                    )
                self._require(resource_id, resource_type, operation)
                return _ResourceRoute("GET", f"/v1/data/queries/{_path_id(cast(str, resource_id))}")
            if resource_type == "notebook":
                self._require(resource_id, resource_type, operation)
                base = f"/v1/notebooks/{_path_id(cast(str, resource_id))}"
                paths = {
                    "versions": f"{base}/versions",
                    "executions": f"{base}/executions",
                    "usage": f"{base}/usage",
                    "export": f"{base}/export",
                }
                return _ResourceRoute("GET", paths.get(facet, base))
            if resource_type == "experiment":
                if facet == "runs":
                    path = "/v1/experiment-runs/local"
                    return _ResourceRoute("GET", _query(path, "experimentId", resource_id))
                if facet == "comparisons":
                    return _ResourceRoute("GET", "/v1/experiment-comparisons/local")
                if facet == "evaluations":
                    return _ResourceRoute("GET", "/v1/experiment-evaluations/local")
                if facet == "events":
                    self._require(run_id, resource_type, operation, name="run_id")
                    return _ResourceRoute(
                        "GET", f"/v1/experiment-runs/local/{_path_id(cast(str, run_id))}/events"
                    )
                if resource_id is None:
                    return _ResourceRoute("GET", "/v1/experiments/local")
                return _ResourceRoute("GET", f"/v1/experiments/local/{_path_id(resource_id)}")
            if resource_type == "model":
                if facet == "deployments":
                    return _ResourceRoute("GET", "/v1/deployments/local")
                if facet == "endpoints":
                    return _ResourceRoute("GET", "/v1/deployments/local/endpoints")
                self._require(resource_id, resource_type, operation)
                base = f"/v1/deployments/local/{_path_id(cast(str, resource_id))}"
                if facet in {"metrics", "logs", "revisions", "events"}:
                    return _ResourceRoute("GET", f"{base}/{facet}")
                return _ResourceRoute("GET", f"/v1/models/local/{_path_id(cast(str, resource_id))}")
            if resource_type == "visualization":
                if facet == "validate":
                    return _ResourceRoute("POST", "/v1/visualizations/validate", _body(request))
                return _ResourceRoute("GET", "/v1/visualizations/catalog")
            if resource_type == "pipeline":
                if facet in {"plan", "estimate", "versions", "runs"}:
                    self._require(resource_id, resource_type, operation)
                    return _ResourceRoute(
                        "GET", f"/v1/pipelines/local/{_path_id(cast(str, resource_id))}/{facet}"
                    )
                if run_id is not None:
                    return _ResourceRoute("GET", f"/v1/pipelines/local/runs/{_path_id(run_id)}")
                if resource_id is None:
                    return _ResourceRoute("GET", "/v1/pipelines/local")
                return _ResourceRoute("GET", f"/v1/pipelines/local/{_path_id(resource_id)}")
            if facet == "runs" and resource_id is not None:
                return _ResourceRoute("GET", f"/v1/automations/local/{_path_id(resource_id)}/runs")
            if facet == "notifications" and resource_id is not None:
                return _ResourceRoute(
                    "GET", f"/v1/automations/local/{_path_id(resource_id)}/notifications"
                )
            if resource_id is None:
                return _ResourceRoute("GET", "/v1/automations/local")
            return _ResourceRoute("GET", f"/v1/automations/local/{_path_id(resource_id)}")

        if operation == "compare":
            if resource_type != "experiment":
                return self._unsupported(
                    resource_type, operation, "comparison is only backed by experiments"
                )
            return _ResourceRoute("POST", "/v1/experiments/local/compare", _body(request))

        if operation == "publish":
            if resource_type == "dataset":
                return _ResourceRoute("POST", "/v1/datasets/local/versions", _body(request))
            if resource_type == "notebook":
                self._require(resource_id, resource_type, operation)
                cell_id = _string(payload.get("cellId"))
                self._require(cell_id, resource_type, operation, name="cellId")
                return _ResourceRoute(
                    "POST",
                    (
                        f"/v1/notebooks/{_path_id(cast(str, resource_id))}/cells/"
                        f"{_path_id(cast(str, cell_id))}/publish"
                    ),
                    _body(request),
                )
            if resource_type == "pipeline":
                self._require(resource_id, resource_type, operation)
                return _ResourceRoute(
                    "POST",
                    f"/v1/pipelines/local/{_path_id(cast(str, resource_id))}/publish",
                    _body(request),
                )
            if resource_type == "model":
                self._require(resource_id, resource_type, operation)
                return _ResourceRoute(
                    "POST",
                    f"/v1/models/local/{_path_id(cast(str, resource_id))}/promote",
                    _body(request),
                )
            if resource_type == "experiment" and _string(payload.get("modelName")) is not None:
                return _ResourceRoute("POST", "/v1/models/local/candidates", _body(request))
            return self._unsupported(
                resource_type, operation, "the backend has no publish route for this resource"
            )

        if operation == "export":
            if resource_type == "sql":
                self._require(resource_id, resource_type, operation)
                return _ResourceRoute(
                    "POST",
                    f"/v1/data/queries/{_path_id(cast(str, resource_id))}/export",
                    _body(request),
                )
            if resource_type == "notebook":
                self._require(resource_id, resource_type, operation)
                return _ResourceRoute(
                    "GET", f"/v1/notebooks/{_path_id(cast(str, resource_id))}/export"
                )
            return self._unsupported(
                resource_type, operation, "the backend has no export route for this resource"
            )

        if operation == "handoff":
            target = _string(payload.get("target")) or "browser"
            if resource_type == "sql":
                self._require(resource_id, resource_type, operation)
                return _ResourceRoute(
                    "POST",
                    f"/v1/data/queries/{_path_id(cast(str, resource_id))}/handoff",
                    _body(request, target=target),
                )
            if resource_type == "notebook":
                self._require(resource_id, resource_type, operation)
                return _ResourceRoute(
                    "POST",
                    "/v1/jupyter/sessions",
                    _body(request, notebookId=resource_id, target=target),
                )
            return self._unsupported(
                resource_type, operation, "the backend has no handoff route for this resource"
            )

        raise AssertionError(f"unhandled resource operation: {operation}")

    def _detail_route(
        self,
        request: FrontendResourceRequest,
        path: str,
        *,
        required: bool,
    ) -> _ResourceRoute:
        if required:
            self._require(request.resource_id, request.resource_type, request.operation)
        return _ResourceRoute("GET", _query(path, "version", request.payload.get("version")))

    def _require(
        self,
        value: str | None,
        resource_type: FrontendResourceType,
        operation: FrontendResourceOperation,
        *,
        name: str = "resource_id",
    ) -> None:
        if value is None:
            raise FrontendResourceError(
                f"{name} is required for {resource_type} {operation}",
                code="VALIDATION_SCHEMA_MISMATCH",
                details={"resourceType": resource_type, "operation": operation, "field": name},
            )

    def _unsupported(
        self,
        resource_type: FrontendResourceType,
        operation: FrontendResourceOperation,
        message: str,
    ) -> NoReturn:
        raise FrontendResourceError(
            message,
            code="CAPABILITY_UNAVAILABLE",
            details={"resourceType": resource_type, "operation": operation},
        )


class MockNativeResourceClient:
    """Stable resource fixtures for command and routing tests without a backend process."""

    async def execute(
        self,
        resource_type: FrontendResourceType,
        operation: FrontendResourceOperation,
        *,
        resource_id: str | None = None,
        run_id: str | None = None,
        payload: Mapping[str, Any] | None = None,
    ) -> FrontendResourceResult:
        del payload
        effective_id = resource_id or f"mock_{resource_type}_01"
        effective_run_id = run_id
        state = "ready" if operation == "discover" else "succeeded"
        if operation in {"invoke", "resume"}:
            effective_run_id = effective_run_id or "run_mock_resource_01"
        item = {"resourceType": resource_type, "resourceId": effective_id, "state": state}
        return FrontendResourceResult(
            resource_type=resource_type,
            operation=operation,
            resource_id=effective_id,
            run_id=effective_run_id,
            state=state,
            capabilities=(_CAPABILITIES[resource_type],),
            items=(item,) if operation == "discover" else (),
            data={"items": [item], "source": "mock"},
        )

    async def discover(
        self, resource_type: FrontendResourceType, *, payload: Mapping[str, Any] | None = None
    ) -> FrontendResourceResult:
        return await self.execute(resource_type, "discover", payload=payload)


def _normalise_result(
    request: FrontendResourceRequest,
    raw: Any,
) -> FrontendResourceResult:
    record = _record(raw)
    items = _items(raw, record)
    resource_id = _find_resource_id(request.resource_type, record)
    run_id = _string(record.get("runId")) or _string(record.get("executionId"))
    state = _state(record, default="ready" if request.operation == "discover" else "unknown")
    artifact_ids = _references(record, ("artifactIds", "artifacts"))
    lineage = _references(record, ("lineageIds", "lineage", "derivedFrom"))
    handoff_value = record.get("handoff")
    handoff = dict(handoff_value) if isinstance(handoff_value, Mapping) else None
    data = record if isinstance(raw, Mapping) else {"items": raw}
    return FrontendResourceResult(
        resource_type=request.resource_type,
        operation=request.operation,
        resource_id=resource_id or request.resource_id,
        run_id=run_id or request.run_id,
        state=state,
        capabilities=(_CAPABILITIES[request.resource_type],),
        items=items,
        data=data,
        artifact_ids=artifact_ids,
        lineage=lineage,
        handoff=handoff,
    )


def _items(raw: Any, record: dict[str, Any]) -> tuple[dict[str, Any], ...]:
    if isinstance(raw, list):
        return tuple(dict(item) for item in raw if isinstance(item, Mapping))
    for key in _ITEM_KEYS:
        value = record.get(key)
        if isinstance(value, list):
            return tuple(dict(item) for item in value if isinstance(item, Mapping))
    return ()


def _find_resource_id(resource_type: FrontendResourceType, record: dict[str, Any]) -> str | None:
    for key in _RESOURCE_ID_KEYS[resource_type]:
        value = _string(record.get(key))
        if value is not None:
            return value
    for key in (
        "resource",
        "dataset",
        "query",
        "notebook",
        "experiment",
        "model",
        "pipeline",
        "automation",
    ):
        nested = record.get(key)
        if isinstance(nested, Mapping):
            for id_key in _RESOURCE_ID_KEYS[resource_type]:
                value = _string(nested.get(id_key))
                if value is not None:
                    return value
    return None


def _state(record: dict[str, Any], *, default: str) -> str:
    for key in ("state", "status", "lifecycleState", "phase"):
        value = _string(record.get(key))
        if value is not None:
            return value
    for key in ("run", "result", "resource", "deployment", "publication"):
        nested = record.get(key)
        if isinstance(nested, Mapping):
            value = _state(dict(nested), default="")
            if value:
                return value
    return default


def _references(record: dict[str, Any], keys: tuple[str, ...]) -> tuple[str, ...]:
    values: list[str] = []
    for key in keys:
        value = record.get(key)
        if not isinstance(value, list):
            continue
        for item in value:
            if isinstance(item, str):
                values.append(item)
            elif isinstance(item, Mapping):
                for id_key in ("artifactId", "lineageId", "resourceId", "id"):
                    candidate = _string(item.get(id_key))
                    if candidate is not None:
                        values.append(candidate)
                        break
    return tuple(dict.fromkeys(values))
