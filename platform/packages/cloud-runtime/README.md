# Cloud runtime

This package is the Phase 8 managed-execution composition. It keeps the Run ID
and local attempt identity intact while adding a tenant-scoped cloud attempt,
an estimate/approval boundary, live durable events, content-addressed artifact
return, usage reconciliation, and either Stripe or prepaid settlement.

Vendor credentials are represented by secret handles. `OpenRouterInferenceAdapter`
and `ModalComputeAdapter` accept injected gateways/fetchers so production
deployments can provide the account-specific transport without persisting raw
credentials in Run state. `HostedPostgresStateStore`, hosted event publishing,
worker pools, and workflow backends reuse the existing transaction and lease
contracts.

The deterministic adapters and `tests/phase8-cloud.test.ts` are the local exit-gate
fixture: a free individual account estimates, approves, streams, returns an
artifact, and is charged/reconciled idempotently. Real vendor credentials,
hosted infrastructure, and release evidence remain deployment concerns.
