# Spyderbyte Phase 10 — enterprise and government acceptance

Date: 2026-08-07

## Scope

Phase 10's local/contract-level exit gate is implemented at the backend boundary. Existing
OIDC/SAML SSO, SCIM, enterprise secret handles, hosted execution, governance, recovery, and local
retention services remain available. The new control plane composes the missing enterprise and
government obligations without moving infrastructure authority into the API or shell.

Implementation:

- `packages/backends/src/enterprise-government.ts` defines versioned `schemaVersion: 1` profile,
  service-account, role/attribute policy, residency/CMK, runner, adapter, Run, deletion/export,
  support, commitment, procurement, and audit contracts.
- `packages/backends/src/enterprise-government.ts` implements digest-only rotating service
  credentials, default-deny RBAC/ABAC with scope and conditions, region/data-class enforcement,
  customer-managed-key references without key material, private Kubernetes/on-premise/customer
  cloud/hosted Kubernetes/SLURM runner kinds, legal holds, approval-bound deletion and tombstones,
  redacted exports/support bundles, government commitments, and procurement evidence.
- The `EnterpriseAdapterSetV1` boundary injects inference, compute, storage, vault, and customer
  key-management adapters into one unchanged `EnterpriseRunRequestV1`/`EnterpriseRunResultV1`
  path. The control plane validates adapter approval, region, runner scope, vault handle scope,
  CMK encryption receipts, content-addressed storage receipts, and secret non-disclosure.
- `packages/local-api/src/enterprise.ts` and `packages/local-api/src/index.ts` expose the
  control-plane profile, service-account, policy, runner, Run, legal-hold, deletion, export,
  support, government-commitment, procurement, and audit routes under
  `/v1/enterprise/control-plane/*`.
- `apps/api/contracts/api.v1.json` and its generated OpenAPI output now enumerate the same
  control-plane routes.

## Exit-gate evidence

`packages/backends/tests/phase10-enterprise-government.test.ts` proves:

1. a government profile requires a private deployment, approved CMK reference, and approved
   government-region adapter set;
2. service-account credentials are opaque, expiring, rotatable, revocable, and never persisted as
   raw tokens;
3. RBAC/ABAC denies an attribute mismatch and allows the matching group, while residency denies a
   cross-region request;
4. private Kubernetes, on-premise, and customer-cloud runners are registered under the same
   tenant/data-residency boundary;
5. the same Run contract invokes customer-owned inference, compute, storage, vault, and CMK
   adapters, returns a content-addressed artifact, and does not return the vault credential;
6. an active legal hold blocks deletion, release returns it to approval, and an independent human
   approval produces a deletion tombstone;
7. extensive export, support diagnostics, commitments, and procurement evidence are available
   with sensitive fields redacted.

`packages/local-api/tests/phase10-enterprise.test.ts` proves the authenticated API composition for
profile, service-account rotation, policy evaluation, legal hold/deletion request, redacted export
and support bundle, government commitments, and procurement evidence.

## Verification

- `pnpm --filter @agentic-platform/backends test`: 13 files, 39 tests passed.
- `pnpm --filter @agentic-platform/local-api test`: 16 files, 29 tests passed.
- `pnpm lint`, `pnpm typecheck`, and `pnpm build` passed for the 33 existing workspace packages.
- `pnpm contracts:check`, `pnpm api-contracts:check`, and the package-boundary check passed.
- `pnpm test:invariants` passed all 50 invariant tasks.
- Targeted Prettier checks passed for all Phase 10 files.
- The repository-wide `pnpm test` reached the unrelated existing
  `packages/provider-runtime/tests/provider-runtime.test.ts` update-manifest assertion (1 failed,
  61 passed in that package); the Phase 10 affected-package suites remained green.
- The repository-wide `pnpm format:check` still reports seven pre-existing files outside this
  change (`apps/local-daemon/src/conversation.ts`, `apps/local-daemon/src/index.ts`,
  `apps/local-daemon/tests/phase9-organizational.test.ts`, `apps/tui/src/index.ts`,
  `apps/web/src/screens/Governance.tsx`, `packages/local-api/src/production-scale.ts`, and
  `packages/policy/src/governance.ts`). Those unrelated formatting changes were not folded into
  this phase.

## Boundary remaining open

This closes the local/contract-level Phase 10 gate. A hosted launch still requires real customer
identity, KMS/HSM, private runner, cloud/on-prem, storage, support, procurement, government
authorization, deployment, and certification evidence. Those environment-specific commitments are
not represented as completed by this record.
