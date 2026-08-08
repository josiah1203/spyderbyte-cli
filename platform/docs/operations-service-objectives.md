# Service objectives and capacity evidence

The platform must not silently choose production SLOs or capacity limits. The provider-neutral
release-gate helpers in `packages/observability/src/release-gates.ts` accept those values as
explicit inputs and produce reproducible pass/fail evidence.

Before a hosted release, operations must record at least:

- command acceptance and idempotency conflict targets;
- projection freshness and subscription reconnect targets;
- workflow recovery and approval propagation targets;
- audit completeness and budget-enforcement accuracy targets;
- artifact durability and deployment rollback targets;
- tenant/global concurrency, fan-out, artifact-size, slow-consumer, and connection-exhaustion
  capacity limits.

The local harness intentionally does not fill in those values. A release record should include the
target document or ADR, fixture/scenario version, observation window, tenant scope, correlation
range, raw measurement digest, evaluated result, and operator approval. Failed gates keep the
previous release active and do not justify changing the target after measurement.
