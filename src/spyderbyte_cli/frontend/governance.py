from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Protocol
from urllib.parse import quote

from spyderbyte_cli.frontend.models import (
    FrontendAuditRecord,
    FrontendBudget,
    FrontendGovernanceDecision,
    FrontendGovernanceOverview,
    FrontendLicenseStatus,
    FrontendMembership,
    FrontendOnboardingStatus,
    FrontendOrganization,
    FrontendPolicy,
    FrontendWorkspaceSnapshot,
)
from spyderbyte_cli.frontend.transport import FrontendTransport


class FrontendGovernanceClient(Protocol):
    async def list_organizations(self) -> tuple[FrontendOrganization, ...]: ...

    async def create_organization(
        self, *, name: str, organization_id: str | None = None
    ) -> FrontendOrganization: ...

    async def overview(self, organization_id: str) -> FrontendGovernanceOverview: ...

    async def list_members(self, organization_id: str) -> tuple[FrontendMembership, ...]: ...

    async def upsert_member(
        self,
        organization_id: str,
        *,
        actor_id: str,
        role: str,
        payload: Mapping[str, Any] | None = None,
    ) -> FrontendMembership: ...

    async def list_policies(self, organization_id: str) -> tuple[FrontendPolicy, ...]: ...

    async def put_policy(
        self, organization_id: str, payload: Mapping[str, Any]
    ) -> FrontendPolicy: ...

    async def list_budgets(self, organization_id: str) -> tuple[FrontendBudget, ...]: ...

    async def put_budget(
        self, organization_id: str, payload: Mapping[str, Any]
    ) -> FrontendBudget: ...

    async def usage(self, organization_id: str) -> dict[str, Any]: ...

    async def forecast(self, organization_id: str) -> dict[str, Any]: ...

    async def audit(self, organization_id: str) -> tuple[FrontendAuditRecord, ...]: ...

    async def verify_audit(self, organization_id: str) -> dict[str, Any]: ...

    async def evaluate(
        self, organization_id: str, payload: Mapping[str, Any]
    ) -> FrontendGovernanceDecision: ...

    async def commit(
        self, organization_id: str, payload: Mapping[str, Any]
    ) -> FrontendGovernanceDecision: ...

    async def read_workspace(self) -> FrontendWorkspaceSnapshot: ...

    async def read_workspace_facet(self, facet: str) -> dict[str, Any]: ...

    async def license_status(self) -> FrontendLicenseStatus: ...

    async def read_onboarding(self) -> FrontendOnboardingStatus: ...

    async def choose_onboarding(self, choice: str) -> FrontendOnboardingStatus: ...

    async def cloud_run_estimate(self, payload: Mapping[str, Any]) -> dict[str, Any]: ...


def _record(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _records(value: Any) -> tuple[dict[str, Any], ...]:
    if not isinstance(value, list):
        return ()
    return tuple(dict(item) for item in value if isinstance(item, Mapping))


def _organization(value: Any) -> FrontendOrganization:
    record = _record(value)
    organization_id = _string(record.get("organizationId")) or "unknown"
    return FrontendOrganization(
        organization_id=organization_id,
        name=_string(record.get("name")) or organization_id,
        data=record,
    )


def _membership(organization_id: str, value: Any) -> FrontendMembership:
    record = _record(value)
    return FrontendMembership(
        organization_id=organization_id,
        actor_id=_string(record.get("actorId")) or "unknown",
        role=_string(record.get("role")) or "member",
        status=_string(record.get("status")) or "active",
        scopes=_records(record.get("scopes")),
        data=record,
    )


def _policy(organization_id: str, value: Any) -> FrontendPolicy:
    record = _record(value)
    return FrontendPolicy(
        organization_id=organization_id,
        version=_string(record.get("version")) or "unknown",
        data=record,
    )


def _budget(organization_id: str, value: Any) -> FrontendBudget:
    record = _record(value)
    hard = record.get("hardLimitMinor")
    soft = record.get("softLimitMinor")
    return FrontendBudget(
        organization_id=organization_id,
        currency=_string(record.get("currency")) or "USD",
        hard_limit_minor=hard if isinstance(hard, int) else None,
        soft_limit_minor=soft if isinstance(soft, int) else None,
        data=record,
    )


def _audit(organization_id: str, value: Any) -> FrontendAuditRecord:
    record = _record(value)
    return FrontendAuditRecord(
        organization_id=organization_id,
        decision=_string(record.get("decision")) or "unknown",
        data=record,
    )


def _decision(organization_id: str, value: Any) -> FrontendGovernanceDecision:
    record = _record(value)
    return FrontendGovernanceDecision(
        organization_id=organization_id,
        outcome=_string(record.get("outcome"))
        or _string(record.get("decision"))
        or _string(_record(record.get("audit")).get("decision"))
        or "unknown",
        input_digest=_string(record.get("inputDigest")),
        data=record,
    )


class NativeGovernanceClient:
    """Organization, workspace, license, and hosted-interface facets over the shared API."""

    def __init__(self, transport: FrontendTransport) -> None:
        self.transport = transport

    async def list_organizations(self) -> tuple[FrontendOrganization, ...]:
        raw = await self.transport.request("GET", "/v1/governance/organizations")
        candidates = raw.get("organizations") if isinstance(raw, dict) else raw
        if not isinstance(candidates, list):
            return ()
        return tuple(_organization(item) for item in candidates if isinstance(item, Mapping))

    async def create_organization(
        self, *, name: str, organization_id: str | None = None
    ) -> FrontendOrganization:
        body: dict[str, Any] = {"name": name}
        if organization_id is not None:
            body["organizationId"] = organization_id
        raw = await self.transport.request(
            "POST", "/v1/governance/organizations", body=body, idempotency_key=organization_id
        )
        return _organization(raw)

    async def overview(self, organization_id: str) -> FrontendGovernanceOverview:
        raw = _record(
            await self.transport.request(
                "GET", f"/v1/governance/organizations/{quote(organization_id, safe='')}/overview"
            )
        )
        return FrontendGovernanceOverview(
            organization_id=organization_id,
            organization=_record(raw.get("organization")),
            membership=_record(raw.get("membership")),
            policies=_records(raw.get("policies")),
            budgets=_records(raw.get("budgets")),
            providers=_records(raw.get("providers")),
            data=raw,
        )

    async def list_members(self, organization_id: str) -> tuple[FrontendMembership, ...]:
        raw = await self.transport.request(
            "GET", f"/v1/governance/organizations/{quote(organization_id, safe='')}/members"
        )
        candidates = raw.get("members") if isinstance(raw, dict) else raw
        if not isinstance(candidates, list):
            return ()
        return tuple(
            _membership(organization_id, item) for item in candidates if isinstance(item, Mapping)
        )

    async def upsert_member(
        self,
        organization_id: str,
        *,
        actor_id: str,
        role: str,
        payload: Mapping[str, Any] | None = None,
    ) -> FrontendMembership:
        body = dict(payload or {})
        body["actorId"] = actor_id
        body["role"] = role
        raw = await self.transport.request(
            "POST",
            f"/v1/governance/organizations/{quote(organization_id, safe='')}/members",
            body=body,
            idempotency_key=f"{organization_id}:{actor_id}:{role}",
        )
        return _membership(organization_id, raw)

    async def list_policies(self, organization_id: str) -> tuple[FrontendPolicy, ...]:
        raw = await self.transport.request(
            "GET", f"/v1/governance/organizations/{quote(organization_id, safe='')}/policies"
        )
        candidates = raw.get("policies") if isinstance(raw, dict) else raw
        if not isinstance(candidates, list):
            return ()
        return tuple(
            _policy(organization_id, item) for item in candidates if isinstance(item, Mapping)
        )

    async def put_policy(self, organization_id: str, payload: Mapping[str, Any]) -> FrontendPolicy:
        raw = await self.transport.request(
            "POST",
            f"/v1/governance/organizations/{quote(organization_id, safe='')}/policies",
            body=dict(payload),
        )
        return _policy(organization_id, raw)

    async def list_budgets(self, organization_id: str) -> tuple[FrontendBudget, ...]:
        raw = await self.transport.request(
            "GET", f"/v1/governance/organizations/{quote(organization_id, safe='')}/budgets"
        )
        candidates = raw.get("budgets") if isinstance(raw, dict) else raw
        if not isinstance(candidates, list):
            return ()
        return tuple(
            _budget(organization_id, item) for item in candidates if isinstance(item, Mapping)
        )

    async def put_budget(self, organization_id: str, payload: Mapping[str, Any]) -> FrontendBudget:
        raw = await self.transport.request(
            "POST",
            f"/v1/governance/organizations/{quote(organization_id, safe='')}/budgets",
            body=dict(payload),
        )
        return _budget(organization_id, raw)

    async def usage(self, organization_id: str) -> dict[str, Any]:
        return _record(
            await self.transport.request(
                "GET", f"/v1/governance/organizations/{quote(organization_id, safe='')}/usage"
            )
        )

    async def forecast(self, organization_id: str) -> dict[str, Any]:
        return _record(
            await self.transport.request(
                "GET", f"/v1/governance/organizations/{quote(organization_id, safe='')}/forecast"
            )
        )

    async def audit(self, organization_id: str) -> tuple[FrontendAuditRecord, ...]:
        raw = await self.transport.request(
            "GET", f"/v1/governance/organizations/{quote(organization_id, safe='')}/audit"
        )
        candidates = raw.get("records") if isinstance(raw, dict) else raw
        if not isinstance(candidates, list):
            return ()
        return tuple(
            _audit(organization_id, item) for item in candidates if isinstance(item, Mapping)
        )

    async def verify_audit(self, organization_id: str) -> dict[str, Any]:
        return _record(
            await self.transport.request(
                "GET",
                f"/v1/governance/organizations/{quote(organization_id, safe='')}/audit/verify",
            )
        )

    async def evaluate(
        self, organization_id: str, payload: Mapping[str, Any]
    ) -> FrontendGovernanceDecision:
        body = dict(payload)
        body["organizationId"] = organization_id
        raw = await self.transport.request("POST", "/v1/governance/evaluate", body=body)
        return _decision(organization_id, raw)

    async def commit(
        self, organization_id: str, payload: Mapping[str, Any]
    ) -> FrontendGovernanceDecision:
        body = dict(payload)
        body["organizationId"] = organization_id
        raw = await self.transport.request("POST", "/v1/governance/commit", body=body)
        return _decision(organization_id, raw)

    async def read_workspace(self) -> FrontendWorkspaceSnapshot:
        raw = _record(await self.transport.request("GET", "/v1/workspace"))
        manifest = _record(raw.get("manifest"))
        workspace_id = (
            _string(raw.get("workspaceId")) or _string(manifest.get("workspaceId")) or "unknown"
        )
        return FrontendWorkspaceSnapshot(
            workspace_id=workspace_id,
            mode=_string(raw.get("mode")) or _string(manifest.get("mode")) or "personal_local",
            organization_id=_string(raw.get("organizationId"))
            or _string(manifest.get("organizationId")),
            data=raw,
        )

    async def read_workspace_facet(self, facet: str) -> dict[str, Any]:
        allowed = {
            "context",
            "intake",
            "inbox",
            "watch",
            "recommendations",
        }
        if facet not in allowed:
            raise ValueError(f"unsupported workspace facet: {facet}")
        return _record(await self.transport.request("GET", f"/v1/workspace/{facet}"))

    async def license_status(self) -> FrontendLicenseStatus:
        raw = _record(await self.transport.request("GET", "/v1/license/status"))
        return FrontendLicenseStatus(
            status=_string(raw.get("status")) or _string(raw.get("state")) or "unknown",
            data=raw,
        )

    async def read_onboarding(self) -> FrontendOnboardingStatus:
        raw = _record(await self.transport.request("GET", "/v1/onboarding"))
        choices = raw.get("choices")
        return FrontendOnboardingStatus(
            choices=tuple(item for item in choices if isinstance(item, str))
            if isinstance(choices, list)
            else (),
            selected=_string(raw.get("selected")) or _string(raw.get("choice")),
            data=raw,
        )

    async def choose_onboarding(self, choice: str) -> FrontendOnboardingStatus:
        raw = _record(
            await self.transport.request("POST", "/v1/onboarding", body={"choice": choice})
        )
        choices = raw.get("choices")
        return FrontendOnboardingStatus(
            choices=tuple(item for item in choices if isinstance(item, str))
            if isinstance(choices, list)
            else (),
            selected=_string(raw.get("selected")) or _string(raw.get("choice")) or choice,
            data=raw,
        )

    async def cloud_run_estimate(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        return _record(
            await self.transport.request("POST", "/v1/cloud/runs/estimate", body=dict(payload))
        )


class MockGovernanceClient:
    """Deterministic governance/hosted fixtures for contract tests."""

    def __init__(self) -> None:
        self._organization = FrontendOrganization(
            organization_id="org_mock_01",
            name="Mock Organization",
            data={"organizationId": "org_mock_01", "name": "Mock Organization"},
        )

    async def list_organizations(self) -> tuple[FrontendOrganization, ...]:
        return (self._organization,)

    async def create_organization(
        self, *, name: str, organization_id: str | None = None
    ) -> FrontendOrganization:
        organization_id = organization_id or "org_mock_created"
        self._organization = FrontendOrganization(
            organization_id=organization_id,
            name=name,
            data={"organizationId": organization_id, "name": name},
        )
        return self._organization

    async def overview(self, organization_id: str) -> FrontendGovernanceOverview:
        return FrontendGovernanceOverview(
            organization_id=organization_id,
            organization=self._organization.data,
            membership={"actorId": "actor_local", "role": "owner"},
            policies=({"version": "governance.v2"},),
            budgets=({"currency": "USD", "hardLimitMinor": 100},),
            providers=(),
        )

    async def list_members(self, organization_id: str) -> tuple[FrontendMembership, ...]:
        return (
            FrontendMembership(
                organization_id=organization_id,
                actor_id="actor_local",
                role="owner",
            ),
        )

    async def upsert_member(
        self,
        organization_id: str,
        *,
        actor_id: str,
        role: str,
        payload: Mapping[str, Any] | None = None,
    ) -> FrontendMembership:
        return FrontendMembership(
            organization_id=organization_id,
            actor_id=actor_id,
            role=role,
            data=dict(payload or {}),
        )

    async def list_policies(self, organization_id: str) -> tuple[FrontendPolicy, ...]:
        return (FrontendPolicy(organization_id=organization_id, version="governance.v2"),)

    async def put_policy(self, organization_id: str, payload: Mapping[str, Any]) -> FrontendPolicy:
        return FrontendPolicy(
            organization_id=organization_id,
            version=str(payload.get("version", "governance.v2")),
            data=dict(payload),
        )

    async def list_budgets(self, organization_id: str) -> tuple[FrontendBudget, ...]:
        return (
            FrontendBudget(
                organization_id=organization_id,
                currency="USD",
                hard_limit_minor=100,
                soft_limit_minor=50,
            ),
        )

    async def put_budget(self, organization_id: str, payload: Mapping[str, Any]) -> FrontendBudget:
        return FrontendBudget(
            organization_id=organization_id,
            currency=str(payload.get("currency", "USD")),
            hard_limit_minor=payload.get("hardLimitMinor")
            if isinstance(payload.get("hardLimitMinor"), int)
            else None,
            soft_limit_minor=payload.get("softLimitMinor")
            if isinstance(payload.get("softLimitMinor"), int)
            else None,
            data=dict(payload),
        )

    async def usage(self, organization_id: str) -> dict[str, Any]:
        return {"organizationId": organization_id, "consumedMinor": 0}

    async def forecast(self, organization_id: str) -> dict[str, Any]:
        return {"organizationId": organization_id, "forecastMinor": 0}

    async def audit(self, organization_id: str) -> tuple[FrontendAuditRecord, ...]:
        return (
            FrontendAuditRecord(
                organization_id=organization_id,
                decision="executed",
            ),
        )

    async def verify_audit(self, organization_id: str) -> dict[str, Any]:
        return {"organizationId": organization_id, "valid": True}

    async def evaluate(
        self, organization_id: str, payload: Mapping[str, Any]
    ) -> FrontendGovernanceDecision:
        return FrontendGovernanceDecision(
            organization_id=organization_id,
            outcome="approval_required",
            input_digest="digest_mock_01",
            data=dict(payload),
        )

    async def commit(
        self, organization_id: str, payload: Mapping[str, Any]
    ) -> FrontendGovernanceDecision:
        return FrontendGovernanceDecision(
            organization_id=organization_id,
            outcome="executed",
            data={"audit": {"decision": "executed"}, **dict(payload)},
        )

    async def read_workspace(self) -> FrontendWorkspaceSnapshot:
        return FrontendWorkspaceSnapshot(
            workspace_id="ws_mock_01",
            mode="organization_local",
            organization_id=self._organization.organization_id,
        )

    async def read_workspace_facet(self, facet: str) -> dict[str, Any]:
        return {"facet": facet, "items": []}

    async def license_status(self) -> FrontendLicenseStatus:
        return FrontendLicenseStatus(status="unlicensed", data={"status": "unlicensed"})

    async def read_onboarding(self) -> FrontendOnboardingStatus:
        return FrontendOnboardingStatus(
            choices=(
                "local-model",
                "provider-key",
                "spyderbyte-cloud",
                "configure-later",
            ),
            selected=None,
        )

    async def choose_onboarding(self, choice: str) -> FrontendOnboardingStatus:
        return FrontendOnboardingStatus(
            choices=(
                "local-model",
                "provider-key",
                "spyderbyte-cloud",
                "configure-later",
            ),
            selected=choice,
        )

    async def cloud_run_estimate(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        return {"estimatedCost": {"amountMinor": 0, "currency": "USD"}, **dict(payload)}
