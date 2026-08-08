# Spyderbyte Phase 9 — organizational platform evidence

Date: 2026-08-07

## Local exit-gate evidence

The deterministic Phase 9 fixture creates one organization workspace with an owner, a scoped
operator, and an outsider. The operator creates a shared project and publishes a shared artifact;
the owner reads the project projection, artifact catalog, and conversation history. The operator's
conversation request becomes a governed Run, is checked against the organization policy's allowed
interface/provider/runtime set, records attributed usage, and appends redacted immutable audit
evidence. The outsider cannot list the organization, read artifacts, read shared projections, or
submit a conversation Run.

The same control state is reopened through a SQLite daemon restart. Memberships, policies, budgets,
usage, and the audit chain remain available and audit verification succeeds.

## Implemented boundaries

- `packages/policy/src/governance.ts` defines the organization, membership, scoped role, policy,
  provider/runtime allowlist, budget, usage, approval, audit, and durable-state contracts. The
  in-memory implementation accepts a `GovernanceStateStore` so local files and hosted transactional
  adapters share one authority boundary.
- `apps/local-daemon/src/governance-store.ts` persists redacted governance metadata atomically;
  provider credential values remain in the provider vault and are not written to governance state.
- `packages/local-api/src/production-scale.ts` exposes membership-scoped organization overview,
  provider/runtime metadata, member/policy/budget/usage/forecast/alert/audit routes, and governed
  evaluate/commit routes.
- `packages/local-api/src/index.ts` fails shared project, Run, artifact, projection, collaboration,
  provider, connector, cloud-run, workspace, and approval access closed without active organization
  membership and the required role. Project-scoped membership grants are honored.
- `apps/local-daemon/src/conversation.ts` evaluates organization policy before creating a
  conversation seed event, re-evaluates after provider selection, and commits Run state, usage, and
  audit evidence with actor, project, provider, runtime, interface, and approval context.
- `apps/web/src/screens/Governance.tsx` and `apps/tui/src/index.ts` expose organization, workspace,
  role, policy, budget, usage, allowed providers/runtimes, approvals, and audit verification without
  exposing credential values or infrastructure internals.
- API/OpenAPI and frontend contract snapshots include the governed policy allowlists and overview /
  provider metadata routes.

## Verification

- `pnpm --filter @agentic-platform/policy test` — 3 files, 11 tests passed.
- `pnpm --filter @agentic-platform/local-api test` — 16 files, 29 tests passed.
- `pnpm --filter @agentic-platform/local-daemon test` — 4 files, 14 tests passed.
- `apps/local-daemon/tests/phase9-organizational.test.ts` — 2/2 shared-workspace and restart tests
  passed, including provider/runtime denial and provider-admin boundary checks.
- Policy, local API, local daemon, client SDK, TUI, and web typechecks/builds passed.
- `pnpm test` — 54 workspace tasks passed across the 33-package repository.
- `pnpm typecheck`, `pnpm lint`, and `pnpm build` — all 33 workspace packages passed; package
  boundary validation passed.
- `pnpm api-contracts:check`, `pnpm frontend-contracts:check`, and targeted Prettier checks passed.

## Scope note

This is local/contract-level completion of the Phase 9 shared-workspace exit gate. The existing Slack
connector/provider-action boundary is membership/policy protected; a production Teams adapter,
hosted vendor/region/data-residency choices, and annual organization pricing/entitlement semantics
remain explicit human decision gates from the declarative plan and are not hardcoded here.
