from __future__ import annotations

import json

import httpx
import pytest
from typer.testing import CliRunner

from spyderbyte_cli.cli import app
from spyderbyte_cli.frontend.acp import AcpSessionBridge
from spyderbyte_cli.frontend.client import MockFrontendClient
from spyderbyte_cli.frontend.governance import NativeGovernanceClient
from spyderbyte_cli.frontend.transport import FrontendTransport


@pytest.mark.asyncio
async def test_governance_routes_use_first_class_backend_paths() -> None:
    calls: list[tuple[str, str]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, request.url.path))
        path = request.url.path
        if path.endswith("/organizations") and request.method == "GET":
            body = {
                "organizations": [
                    {"organizationId": "org-01", "name": "Acme"},
                ]
            }
        elif path.endswith("/overview"):
            body = {
                "organization": {"organizationId": "org-01", "name": "Acme"},
                "membership": {"actorId": "actor-01", "role": "owner"},
                "policies": [],
                "budgets": [],
                "providers": [],
            }
        elif path.endswith("/audit/verify"):
            body = {"valid": True}
        elif path.endswith("/audit"):
            body = {"records": [{"decision": "executed"}]}
        elif path.endswith("/members"):
            body = {"members": [{"actorId": "actor-01", "role": "owner"}]}
        elif path.endswith("/policies"):
            body = {"policies": [{"version": "governance.v2"}]}
        elif path.endswith("/budgets"):
            body = {"budgets": [{"currency": "USD", "hardLimitMinor": 100}]}
        elif path.endswith("/usage"):
            body = {"consumedMinor": 10}
        elif path == "/v1/governance/evaluate":
            body = {"outcome": "approval_required", "inputDigest": "digest-01"}
        elif path == "/v1/governance/commit":
            body = {"audit": {"decision": "executed"}}
        else:
            body = {}
        return httpx.Response(200, json=body, request=request)

    transport = FrontendTransport(
        "http://test",
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    client = NativeGovernanceClient(transport)
    try:
        organizations = await client.list_organizations()
        overview = await client.overview("org-01")
        members = await client.list_members("org-01")
        policies = await client.list_policies("org-01")
        budgets = await client.list_budgets("org-01")
        usage = await client.usage("org-01")
        evaluation = await client.evaluate(
            "org-01",
            {
                "action": "deployment.execute",
                "target": [{"kind": "deployment", "id": "deployment-1"}],
                "dataClassification": "internal",
                "interfaceName": "cli",
                "estimatedCost": {"amountMinor": 10, "currency": "USD"},
            },
        )
        committed = await client.commit(
            "org-01",
            {
                "action": "deployment.execute",
                "approvalContext": {"approved": True, "actionDigest": "digest-01"},
            },
        )
        records = await client.audit("org-01")
        verified = await client.verify_audit("org-01")
    finally:
        await transport._client.aclose()  # type: ignore[union-attr]

    assert organizations[0].organization_id == "org-01"
    assert overview.membership["role"] == "owner"
    assert members[0].role == "owner"
    assert policies[0].version == "governance.v2"
    assert budgets[0].hard_limit_minor == 100
    assert usage["consumedMinor"] == 10
    assert evaluation.outcome == "approval_required"
    assert committed.outcome == "executed"
    assert records[0].decision == "executed"
    assert verified["valid"] is True
    assert ("GET", "/v1/governance/organizations") in calls
    assert ("GET", "/v1/governance/organizations/org-01/overview") in calls
    assert ("POST", "/v1/governance/evaluate") in calls
    assert ("POST", "/v1/governance/commit") in calls


def test_org_and_audit_commands_emit_stable_json_without_a_backend() -> None:
    runner = CliRunner()
    org = runner.invoke(app, ["org", "list"])
    assert org.exit_code == 0, org.stdout
    payload = json.loads(org.stdout)
    assert payload["organizations"][0]["organizationId"] == "org_mock_01"

    audit = runner.invoke(app, ["audit", "org_mock_01"])
    assert audit.exit_code == 0, audit.stdout
    audit_payload = json.loads(audit.stdout)
    assert audit_payload["verified"]["valid"] is True

    onboarding = runner.invoke(app, ["onboarding", "status"])
    assert onboarding.exit_code == 0, onboarding.stdout
    assert "local-model" in json.loads(onboarding.stdout)["choices"]


@pytest.mark.asyncio
async def test_acp_bridge_cancel_uses_frontend_client_path() -> None:
    client = MockFrontendClient()
    bridge = AcpSessionBridge(client)
    updates = [update async for update in bridge.prompt("cancel me")]
    assert updates
    cancelled = await client.cancel_run("run_mock_01", reason="acp-cancel")
    assert cancelled["state"] == "cancelled"
    assert any(
        event.kind == "run.status" and event.payload.get("state") == "cancelled"
        for event in client._events
    )
