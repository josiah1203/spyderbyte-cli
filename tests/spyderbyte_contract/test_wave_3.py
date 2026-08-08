from __future__ import annotations

import json
import uuid

import httpx
import pytest

from spyderbyte_cli.frontend.client import HttpFrontendClient
from spyderbyte_cli.frontend.transport import FrontendTransport

TENANT_ID = "018f0c4b-4ea0-7abc-8def-0123456789ab"
WORKSPACE_ID = "018f0c4b-4ea1-7abc-8def-0123456789ab"
ACTOR_ID = "018f0c4b-4ea2-7abc-8def-0123456789ab"
PROJECT_ID = "018f0c4b-4ea3-7abc-8def-0123456789ab"
RUN_ID = "018f0c4b-4ea4-7abc-8def-0123456789ab"
SESSION_ID = PROJECT_ID
NOW = "2026-08-08T00:00:00Z"


def _agent_session() -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "sessionId": SESSION_ID,
        "tenant": {"tenantId": TENANT_ID, "workspaceId": WORKSPACE_ID},
        "workspaceId": WORKSPACE_ID,
        "projectId": PROJECT_ID,
        "user": {"actorId": ACTOR_ID, "type": "human", "displayName": "Local user"},
        "sourceInterface": "cli",
        "context": {
            "workspaceId": WORKSPACE_ID,
            "projectId": PROJECT_ID,
            "sourceInterface": "cli",
            "mode": "conversation",
            "resources": [],
        },
        "mode": "conversation",
        "state": "active",
        "requestIds": [],
        "createdAt": NOW,
        "updatedAt": NOW,
    }


def _response() -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "responseId": "018f0c4b-4ea5-7abc-8def-0123456789ab",
        "sessionId": SESSION_ID,
        "requestId": "018f0c4b-4ea6-7abc-8def-0123456789ab",
        "tenant": {"tenantId": TENANT_ID, "workspaceId": WORKSPACE_ID},
        "state": "completed",
        "recommendation": {
            "summary": "Inspect the project context",
            "actions": ["inspect context"],
            "rationale": ["The request is bounded."],
            "confidence": 0.5,
        },
        "plan": {
            "schemaVersion": 1,
            "planId": "018f0c4b-4ea7-7abc-8def-0123456789ab",
            "workflowId": PROJECT_ID,
            "version": 1,
            "steps": [
                {
                    "stepId": "018f0c4b-4ea8-7abc-8def-0123456789ab",
                    "tier": 0,
                    "agentType": "spyderbyte-agent",
                    "title": "Inspect",
                    "description": "Inspect the context.",
                    "dependsOn": [],
                    "inputArtifactIds": [],
                    "requiredCapabilities": ["context.read"],
                    "approvalRequired": False,
                    "expectedOutputs": ["typed response"],
                    "acceptanceCriteria": ["Persist the response."],
                }
            ],
            "createdAt": NOW,
            "digest": "sha256:test",
        },
        "estimate": {
            "estimatedCost": {"amountMinor": 0, "currency": "USD"},
            "estimatedDurationMs": 120000,
            "resourceClass": "local-agent",
        },
        "runId": RUN_ID,
        "artifacts": [],
        "nextAction": "Inspect the completed Run.",
        "createdAt": NOW,
        "completedAt": NOW,
    }


@pytest.mark.asyncio
async def test_local_golden_path_selects_project_and_reads_durable_state() -> None:
    calls: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        path = request.url.path
        if path == "/v1/session":
            return httpx.Response(
                200,
                json={
                    "schemaVersion": 1,
                    "sessionId": "018f0c4b-4eaf-7abc-8def-0123456789ab",
                    "tenant": {"tenantId": TENANT_ID, "workspaceId": WORKSPACE_ID},
                    "actor": {"actorId": ACTOR_ID, "type": "human", "displayName": "Local user"},
                    "issuedAt": NOW,
                },
                request=request,
            )
        if path == "/v1/capabilities":
            return httpx.Response(
                200,
                json={
                    "capabilities": {
                        "dataset": {"enabled": True},
                        "sql": {"enabled": True},
                        "model-lifecycle": {"enabled": True},
                    }
                },
                request=request,
            )
        if path == "/v1/projections/projects":
            return httpx.Response(200, json={"state": {"projects": {}}}, request=request)
        if path == "/v1/commands":
            body = json.loads(request.content)
            assert body["commandType"] == "CreateProject"
            assert uuid.UUID(body["commandId"]).version == 7
            return httpx.Response(
                202,
                json={"projectId": PROJECT_ID, "result": {"projectId": PROJECT_ID}},
                request=request,
            )
        if path == f"/v1/projects/{PROJECT_ID}/conversation":
            return httpx.Response(
                200,
                json={
                    "conversationId": SESSION_ID,
                    "projectId": PROJECT_ID,
                    "session": _agent_session(),
                    "messages": [],
                    "generating": False,
                    "updatedAt": NOW,
                },
                request=request,
            )
        if path.endswith("/conversation/messages"):
            return httpx.Response(
                202,
                json={
                    "projectId": PROJECT_ID,
                    "sessionId": SESSION_ID,
                    "requestId": "018f0c4b-4ea6-7abc-8def-0123456789ab",
                    "runId": RUN_ID,
                    "userMessageId": "018f0c4b-4ea9-7abc-8def-0123456789ab",
                    "assistantMessageId": "018f0c4b-4eaa-7abc-8def-0123456789ab",
                    "acceptedAt": NOW,
                },
                request=request,
            )
        if path == f"/v1/projects/{PROJECT_ID}/agent-session":
            return httpx.Response(
                200,
                json={
                    "session": _agent_session(),
                    "requests": [],
                    "events": [],
                    "permissions": [],
                    "responses": [_response()],
                },
                request=request,
            )
        if path == f"/v1/runs/{RUN_ID}":
            return httpx.Response(
                200,
                json={
                    "run": {
                        "schemaVersion": 1,
                        "runId": RUN_ID,
                        "projectId": PROJECT_ID,
                        "requestedAction": "conversation.respond",
                        "state": "succeeded",
                        "attemptIds": [],
                        "inputReferences": [],
                        "createdAt": NOW,
                        "updatedAt": NOW,
                    },
                    "attempts": [],
                    "logs": [],
                },
                request=request,
            )
        if path == "/v1/subscriptions/events":
            page = {
                "cursor": 4,
                "events": [
                    {
                        "eventId": "018f0c4b-4eab-7abc-8def-0123456789ab",
                        "eventName": "run.status-changed.v1",
                        "aggregateType": "run",
                        "aggregateId": RUN_ID,
                        "occurredAt": NOW,
                        "payload": {"projectId": PROJECT_ID, "state": "running"},
                    },
                    {
                        "eventId": "018f0c4b-4eac-7abc-8def-0123456789ab",
                        "eventName": "chat.message-delta.v1",
                        "occurredAt": NOW,
                        "payload": {
                            "projectId": PROJECT_ID,
                            "conversationId": SESSION_ID,
                            "runId": RUN_ID,
                            "delta": "local response",
                        },
                    },
                    {
                        "eventId": "018f0c4b-4ead-7abc-8def-0123456789ab",
                        "eventName": "run.status-changed.v1",
                        "aggregateType": "run",
                        "aggregateId": RUN_ID,
                        "occurredAt": NOW,
                        "payload": {"projectId": PROJECT_ID, "state": "succeeded"},
                    },
                    {
                        "eventId": "018f0c4b-4eae-7abc-8def-0123456789ab",
                        "eventName": "run.completed.v1",
                        "aggregateType": "run",
                        "aggregateId": RUN_ID,
                        "occurredAt": NOW,
                        "payload": {"projectId": PROJECT_ID, "runId": RUN_ID, "state": "succeeded"},
                    },
                ],
                "gapDetected": False,
                "refreshRequired": False,
            }
            return httpx.Response(
                200,
                headers={"content-type": "text/event-stream"},
                content=f"data: {json.dumps(page)}\n\n".encode(),
                request=request,
            )
        return httpx.Response(404, json={"error": "not found"}, request=request)

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="http://test"
    ) as http:
        client = HttpFrontendClient(FrontendTransport("http://test", client=http))
        session = await client.open_session()
        acceptance = await client.send_prompt("inspect the local project")
        events = []
        async for event in client.events(after_cursor=0):
            events.append(event)
            if event.kind == "stream.end":
                break
        conversation = await client.read_conversation()
        agent_session = await client.read_agent_session()
        run = await client.read_run(acceptance.run_id)

    assert session.project_id == PROJECT_ID
    assert session.agent_session_id == SESSION_ID
    assert session.capabilities.native_resources == ("dataset", "model", "sql")
    assert acceptance.run_id == RUN_ID
    assert [event.kind for event in events] == [
        "run.status",
        "assistant.delta",
        "run.status",
        "stream.end",
    ]
    assert events[1].payload["text"] == "local response"
    assert conversation.session is not None
    assert conversation.session.session_id == SESSION_ID
    assert agent_session.responses[0].plan.steps[0].agent_type == "spyderbyte-agent"
    assert run.run.state == "succeeded"
    assert any(request.url.path == "/v1/commands" for request in calls)


@pytest.mark.asyncio
async def test_frontend_resource_facets_keep_run_model_and_artifact_authority_backend_owned() -> (
    None
):
    async def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/v1/session":
            return httpx.Response(
                200,
                json={
                    "schemaVersion": 1,
                    "sessionId": "018f0c4b-4eb0-7abc-8def-0123456789ab",
                    "tenant": {"tenantId": TENANT_ID, "workspaceId": WORKSPACE_ID},
                    "actor": {"actorId": ACTOR_ID, "type": "human"},
                    "projectId": PROJECT_ID,
                    "agentSessionId": SESSION_ID,
                    "issuedAt": NOW,
                },
                request=request,
            )
        if path.endswith("/conversation/messages"):
            body = json.loads(request.content)
            assert body["providerId"] == "deterministic"
            assert body["modelId"] == "fixture-model"
            return httpx.Response(
                202,
                json={"projectId": PROJECT_ID, "runId": RUN_ID, "acceptedAt": NOW},
                request=request,
            )
        if path == "/v1/runs":
            return httpx.Response(
                200,
                json={
                    "runs": [
                        {
                            "runId": RUN_ID,
                            "projectId": PROJECT_ID,
                            "state": "succeeded",
                            "attemptIds": [],
                        }
                    ]
                },
                request=request,
            )
        if path == "/v1/approvals":
            return httpx.Response(
                200,
                json=[
                    {
                        "request": {
                            "approvalId": "018f0c4b-4eb1-7abc-8def-0123456789ab",
                            "state": "pending",
                            "workflowId": RUN_ID,
                            "resources": ["workspace"],
                        },
                        "action": {"workflowId": RUN_ID},
                    }
                ],
                request=request,
            )
        if path.endswith("/approve"):
            return httpx.Response(
                202,
                json={"request": {"approvalId": "018f0c4b-4eb1-7abc-8def-0123456789ab"}},
                request=request,
            )
        if path == f"/v1/artifacts/{PROJECT_ID}":
            return httpx.Response(
                200,
                json={
                    "artifactId": PROJECT_ID,
                    "version": 1,
                    "mediaType": "text/plain",
                    "contentHash": "sha256:test",
                },
                request=request,
            )
        if path == f"/v1/artifacts/{PROJECT_ID}/versions":
            return httpx.Response(
                200,
                json=[
                    {
                        "artifactId": PROJECT_ID,
                        "version": 1,
                        "mediaType": "text/plain",
                    }
                ],
                request=request,
            )
        if path == "/v1/providers":
            return httpx.Response(
                200,
                json={
                    "providers": [{"providerId": "deterministic"}],
                    "credentials": [],
                    "models": [],
                },
                request=request,
            )
        if path == "/v1/models/catalog":
            return httpx.Response(
                200,
                json={
                    "models": [{"modelId": "fixture-model"}],
                    "runtimes": [],
                    "providerPriority": ["deterministic"],
                    "routingPolicy": {"mode": "local"},
                },
                request=request,
            )
        if path == "/v1/runtimes/profiles":
            return httpx.Response(200, json={"profiles": [], "revisions": []}, request=request)
        if path == "/v1/projections/usage":
            return httpx.Response(200, json={"state": {"runs": {}}}, request=request)
        return httpx.Response(404, json={"error": "not found"}, request=request)

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="http://test"
    ) as http:
        client = HttpFrontendClient(FrontendTransport("http://test", client=http))
        await client.open_session()
        acceptance = await client.send_prompt(
            "use the deterministic model",
            provider_id="deterministic",
            model_id="fixture-model",
        )
        runs = await client.list_runs(PROJECT_ID)
        approvals = await client.list_approvals()
        decision = await client.decide_approval(
            approvals[0].approval_id,
            "approve",
            reason="Wave 3 contract test",
        )
        artifact = await client.read_artifact(PROJECT_ID)
        versions = await client.read_artifact_versions(PROJECT_ID)
        providers = await client.read_provider_catalog()
        models = await client.read_model_catalog()
        runtimes = await client.read_runtime_catalog()

    assert acceptance.run_id == RUN_ID
    assert runs[0].run_id == RUN_ID
    assert approvals[0].run_id == RUN_ID
    decision_request = decision.get("request")
    assert isinstance(decision_request, dict)
    assert decision_request.get("approvalId") == approvals[0].approval_id
    assert artifact.media_type == "text/plain"
    assert versions[0].version == 1
    assert providers.providers[0]["providerId"] == "deterministic"
    assert models.models[0]["modelId"] == "fixture-model"
    assert runtimes.profiles == ()
