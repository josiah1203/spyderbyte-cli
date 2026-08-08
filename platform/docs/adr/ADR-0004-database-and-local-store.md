# ADR-0004: Hosted database and local store

- Status: Accepted
- Date: 2026-08-02

## Context

Authoritative aggregates, idempotency records, outbox entries, projections, budgets, approvals,
and artifact metadata need transactions and optimistic concurrency. Local development needs to be
portable and must exercise the same repository contracts.

## Decision

Use PostgreSQL for hosted authoritative metadata and SQLite for local mode, both behind repository
interfaces and the same contract-test suite. Use transactional outbox records in the authoritative
store. Keep tenant IDs in primary/unique lookup boundaries and require aggregate versions for
concurrent writes. The local implementation uses a file-backed SQLite database and a
content-addressed filesystem for artifact bytes.

## Alternatives considered

- Embedded PostgreSQL locally: closer SQL parity but heavier setup and slower iteration.
- A document database: weaker fit for aggregate concurrency, approvals, and ledger invariants.
- Projection-only persistence: rejected because projections cannot be the source of truth.

## Consequences

The repository layer must define the supported SQL subset and explicitly test behavior where SQLite
and PostgreSQL differ. Hosted migrations and local migrations remain versioned.

## Migration implications

Schema migrations are additive first, with compatibility windows for event and projection readers.
Switching local storage requires preserving repository interfaces and replaying authoritative events
or importing a documented snapshot format.

## Security impact

Tenant-scoped queries and uniqueness constraints are enforced in repositories, with commit-time
authorization checks. Database credentials never enter model context or worker logs.

## Observability impact

Transactions record correlation and causation IDs, aggregate versions, outbox sequence, and
backend request timing for audit and replay diagnostics.

## Rollback or revisit trigger

Revisit SQLite if contract tests reveal an unsafe semantic gap or if local workload requires a
different embedded engine; revisit PostgreSQL only through a migration and recovery proof.
