# Spyderbyte Phase 8 — managed execution evidence

Date: 2026-08-07

## Local exit-gate evidence

The deterministic Phase 8 fixture creates a free individual account, authenticates a short-lived
cloud session, estimates a local Run switch, requires an action-digest-bound approval, streams
provider progress, submits a compute attempt, returns an immutable content-addressed artifact,
records actual usage, and reconciles a Stripe capture or prepaid balance. Repeating the execution
is idempotent and does not double-capture or double-charge.

Evidence:

- `packages/cloud-runtime/tests/phase8-cloud.test.ts` — four acceptance/security tests covering
  continuity, tenant isolation, prepaid settlement, OpenRouter SSE parsing, Modal gateway scoping,
  and secret-handle forwarding.
- `packages/local-api/tests/cloud-run.test.ts` — API route coverage for estimate, approval,
  execution, and authenticated event replay.
- `packages/cloud-runtime/README.md` — composition boundary and production adapter notes.

## Implemented boundaries

- `packages/runtime-contracts/src/cloud.ts` contains the versioned cloud account, session, estimate,
  approval, event, artifact, usage, billing, and Run-continuity contracts.
- `packages/cloud-runtime` provides account/session auth, hosted PostgreSQL/state composition,
  durable event publishers, hosted worker/workflow aliases, KMS secret-broker composition, direct
  OpenRouter streaming, Modal compute gateway validation, pricing, resource limits, Stripe/prepaid
  billing, usage ledger, artifact return, and the local-to-cloud orchestrator.
- `packages/local-api/src/index.ts` exposes the authenticated `/v1/cloud/runs/estimate`,
  `/v1/cloud/runs/approve`, `/v1/cloud/runs/execute`, and `/v1/cloud/runs/{runId}/events` routes.

## Verification

- Cloud runtime: typecheck, lint, build, and 4/4 tests pass.
- Local API: typecheck, lint, and 27/27 package tests pass.
- Hosted backend suite: 37/37 tests pass.
- Repository typecheck: 33/33 packages pass.
- Repository build: 33/33 packages pass.
- Runtime contract generation, package boundaries, and scoped formatting checks pass.

## Scope note

This is local/contract-level completion of the Phase 8 vertical slice. Real OpenRouter, Modal,
Stripe, KMS, hosted PostgreSQL, deployment, observability, and release credentials are injected
through the adapter ports and still require production-environment evidence before a hosted launch.
