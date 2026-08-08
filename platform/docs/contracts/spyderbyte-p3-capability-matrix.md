# Spyderbyte P3 capability matrix

This matrix records the implementation evidence for the production-scale and enterprise backlog.
Provider-specific cloud accounts and identity tenants are deployment gates; the repository proves
the shared contracts and reference semantics used by those adapters.

| P3 workstream                                                   | Contract and implementation evidence                                                                                            | Surface                                                                      | Focused evidence                                                                                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Serving runtime, endpoints, health, canary, rollback            | `packages/backends/src/serving-control.ts` plus the existing local serving runtime and deployment state machine                 | `/v1/serving/*`, `SpyderbyteClient.serving*`                                 | `packages/backends/tests/p3-production.test.ts`; `packages/local-api/tests/production-scale.test.ts`                               |
| Organization/workspace budgets and cost policy                  | `packages/budget/src/scoped-policy.ts` with parent-chain atomic reservation, reconciliation, alerts, and policy checks          | `/v1/scoped-budgets/*`, `/v1/cost/*`, SDK budget methods                     | `packages/budget/tests/scoped-policy.test.ts`; API production-scale test                                                           |
| Agent definitions and advanced routing                          | `packages/agent-registry/src/routing.ts` with cohort rollout, filters, shadow candidates, leases, and rollback                  | `/v1/agent-definitions/*`, `/v1/agent-invocations/*`, SDK routing methods    | `packages/agent-registry/tests/routing.test.ts`; API production-scale test                                                         |
| Customer-cloud execution and hosted worker pools                | `packages/backends/src/hosted-execution.ts`, `worker-pool.ts`, `compute.ts`, and `event-transport.ts`                           | Hosted adapter interfaces; composition injects scheduler/cloud clients       | `packages/backends/tests/p3-production.test.ts`; existing worker-pool tests                                                        |
| SSO/SCIM and enterprise secret managers                         | `enterprise-identity.ts`, `enterprise-secrets.ts`, `secret-broker.ts`; HTTPS-only identity metadata and opaque handle lifecycle | Hosted composition boundary; secret resolution is never a local API response | `packages/backends/tests/p3-production.test.ts`                                                                                    |
| Governance, retention, disaster recovery, browser collaboration | `packages/state/src/tenant-lifecycle.ts`, `disaster-recovery.ts`, `packages/runtime-domain/src/collaboration.ts`                | `/v1/recovery/*`, `/v1/collaboration/*`, SDK recovery/collaboration methods  | `packages/state/tests/disaster-recovery.test.ts`; `packages/runtime-domain/tests/collaboration.test.ts`; API production-scale test |

Contract and surface checks:

- `pnpm api-contracts:check` verifies `apps/api/generated/openapi.v1.json` from the manifest.
- The local API accepts a `productionScale` service bundle so hosted composition can inject durable
  implementations without changing the route contract.
- `packages/client-sdk` has typed methods for every non-secret P3 route and tests method/path parity.
