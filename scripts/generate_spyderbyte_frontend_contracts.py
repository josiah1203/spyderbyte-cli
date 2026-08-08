#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

from pydantic import TypeAdapter

from spyderbyte_cli.frontend.models import (
    EventPage,
    FrontendAgentEvent,
    FrontendAgentRequest,
    FrontendAgentResponse,
    FrontendAgentSession,
    FrontendAgentSessionSnapshot,
    FrontendApproval,
    FrontendArtifact,
    FrontendAuditRecord,
    FrontendBudget,
    FrontendConversationSnapshot,
    FrontendError,
    FrontendEstimate,
    FrontendEvent,
    FrontendGovernanceDecision,
    FrontendGovernanceOverview,
    FrontendLicenseStatus,
    FrontendMembership,
    FrontendMessage,
    FrontendModelCatalog,
    FrontendOnboardingStatus,
    FrontendOrganization,
    FrontendPermission,
    FrontendPlan,
    FrontendPlanStep,
    FrontendPolicy,
    FrontendProject,
    FrontendProviderCatalog,
    FrontendRecommendation,
    FrontendResourceCapability,
    FrontendResourceRequest,
    FrontendResourceResult,
    FrontendRun,
    FrontendRunAttempt,
    FrontendRunDetail,
    FrontendRunLog,
    FrontendRuntimeCatalog,
    FrontendSession,
    FrontendUsage,
    FrontendWorkspaceSnapshot,
    PromptAcceptance,
)

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "contracts/frontend/v1/frontend-contracts.schema.json"


def render() -> str:
    schema = TypeAdapter(
        FrontendSession
        | PromptAcceptance
        | FrontendEvent
        | EventPage
        | FrontendError
        | FrontendRun
        | FrontendApproval
        | FrontendArtifact
        | FrontendUsage
        | FrontendProviderCatalog
        | FrontendModelCatalog
        | FrontendRuntimeCatalog
        | FrontendResourceCapability
        | FrontendResourceRequest
        | FrontendResourceResult
        | FrontendOrganization
        | FrontendMembership
        | FrontendPolicy
        | FrontendBudget
        | FrontendAuditRecord
        | FrontendGovernanceOverview
        | FrontendGovernanceDecision
        | FrontendLicenseStatus
        | FrontendOnboardingStatus
        | FrontendWorkspaceSnapshot
        | FrontendProject
        | FrontendAgentSession
        | FrontendAgentRequest
        | FrontendAgentEvent
        | FrontendPermission
        | FrontendRecommendation
        | FrontendPlanStep
        | FrontendPlan
        | FrontendEstimate
        | FrontendAgentResponse
        | FrontendAgentSessionSnapshot
        | FrontendMessage
        | FrontendConversationSnapshot
        | FrontendRunAttempt
        | FrontendRunLog
        | FrontendRunDetail,
    ).json_schema(by_alias=True, union_format="any_of")
    return json.dumps(schema, indent=2, sort_keys=True) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    generated = render()
    if args.check:
        if not OUTPUT.is_file() or OUTPUT.read_text(encoding="utf-8") != generated:
            raise SystemExit(f"frontend contract is stale: {OUTPUT}")
        print("Spyderbyte frontend contract is up to date.")
        return
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(generated, encoding="utf-8")
    print(f"wrote {OUTPUT}")


if __name__ == "__main__":
    main()
