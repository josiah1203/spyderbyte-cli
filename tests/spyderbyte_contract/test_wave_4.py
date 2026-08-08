from __future__ import annotations

import json
from urllib.parse import urlparse

import httpx
import pytest
from typer.testing import CliRunner

from spyderbyte_cli.cli import app
from spyderbyte_cli.frontend.resources import (
    RESOURCE_OPERATIONS,
    RESOURCE_TYPES,
    FrontendResourceError,
    NativeResourceClient,
)
from spyderbyte_cli.frontend.transport import FrontendTransport


def _resource_response(resource_type: str, path: str) -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "resourceType": resource_type,
        "resourceId": f"{resource_type}-01",
        "runId": "run-resource-01" if path else None,
        "state": "succeeded",
        "items": [{"resourceId": f"{resource_type}-01", "state": "succeeded"}],
        "artifacts": [{"artifactId": "artifact-resource-01"}],
        "lineage": [{"resourceId": "lineage-resource-01"}],
    }


@pytest.mark.asyncio
async def test_discover_matrix_uses_first_class_backend_routes() -> None:
    calls: list[tuple[str, str]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, request.url.path))
        return httpx.Response(
            200,
            json={
                "schemaVersion": 1,
                "resourceType": "fixture",
                "items": [{"resourceId": "fixture-01", "state": "ready"}],
            },
            request=request,
        )

    transport = FrontendTransport(
        "http://test",
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    client = NativeResourceClient(transport)
    expected_paths = {
        "dataset": "/v1/datasets/local",
        "sql": "/v1/data/queries",
        "notebook": "/v1/notebooks",
        "experiment": "/v1/experiments/local",
        "model": "/v1/models/local/registry",
        "visualization": "/v1/visualizations/catalog",
        "pipeline": "/v1/pipelines/local",
        "automation": "/v1/automations/local",
    }

    try:
        results = [await client.discover(resource_type) for resource_type in RESOURCE_TYPES]
    finally:
        await transport._client.aclose()  # type: ignore[union-attr]

    assert calls == [("GET", expected_paths[resource_type]) for resource_type in RESOURCE_TYPES]
    assert all(result.capabilities[0].operations == RESOURCE_OPERATIONS for result in results)
    assert all(result.items[0]["resourceId"] == "fixture-01" for result in results)


@pytest.mark.asyncio
async def test_operations_preserve_typed_envelope_and_route_authority() -> None:
    calls: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(
            202 if request.method == "POST" else 200,
            json=_resource_response("fixture", request.url.path),
            request=request,
        )

    transport = FrontendTransport(
        "http://test",
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    client = NativeResourceClient(transport)
    try:
        sql = await client.invoke("sql", payload={"sql": "select 1"})
        dataset = await client.inspect(
            "dataset",
            resource_id="dataset-01",
            payload={"facet": "lineage", "version": 2},
        )
        resumed_pipeline = await client.resume(
            "pipeline", run_id="pipeline-run-01", payload={"stageId": "stage-a"}
        )
        experiment = await client.compare("experiment", payload={"runIds": ["run-a", "run-b"]})
    finally:
        await transport._client.aclose()  # type: ignore[union-attr]

    assert urlparse(str(calls[0].url)).path == "/v1/data/queries"
    sql_body = json.loads(calls[0].content)
    assert sql_body["sql"] == "select 1"
    assert sql_body["queryId"]
    assert calls[0].headers["idempotency-key"]
    assert str(calls[1].url) == "http://test/v1/datasets/local/dataset-01/lineage?version=2"
    assert str(calls[2].url) == (
        "http://test/v1/pipelines/local/runs/pipeline-run-01/stages/stage-a/retry"
    )
    assert resumed_pipeline.operation == "resume"
    assert str(calls[3].url) == "http://test/v1/experiments/local/compare"
    assert sql.artifact_ids == ("artifact-resource-01",)
    assert sql.lineage == ("lineage-resource-01",)
    assert sql.run_id == "run-resource-01"
    assert dataset.resource_id == "fixture-01"
    assert experiment.operation == "compare"


@pytest.mark.asyncio
async def test_resource_operations_require_ids_and_report_capability_errors() -> None:
    transport = FrontendTransport(
        "http://test",
        client=httpx.AsyncClient(
            transport=httpx.MockTransport(lambda request: httpx.Response(500))
        ),
    )
    client = NativeResourceClient(transport)
    try:
        with pytest.raises(FrontendResourceError, match="resource_id is required"):
            await client.observe("dataset")
        with pytest.raises(FrontendResourceError, match="no export route"):
            await client.export("pipeline", resource_id="pipeline-01")
    finally:
        await transport._client.aclose()  # type: ignore[union-attr]


def test_resource_command_emits_stable_json_without_a_backend() -> None:
    result = CliRunner().invoke(app, ["resource", "dataset", "discover"])

    assert result.exit_code == 0, result.stdout
    payload = json.loads(result.stdout)
    assert payload["schemaVersion"] == 1
    assert payload["resourceType"] == "dataset"
    assert payload["operation"] == "discover"
    assert payload["capabilities"][0]["routeFamily"] == "local-data"
