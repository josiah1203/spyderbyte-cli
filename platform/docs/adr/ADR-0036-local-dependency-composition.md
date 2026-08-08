# ADR-0036: Local dependency composition is optional infrastructure

- Status: Accepted
- Date: 2026-08-06

## Context

The local-first daemon and SQLite/CAS path are the default development and test authority, while
PostgreSQL, NATS JetStream, S3-compatible object storage, OPA, and Temporal are compatibility
boundaries required by the broader platform plan. Developers need a reproducible composition without
making every local test depend on containers.

## Decision

Keep the in-memory/SQLite local path as the default. Check in a pinned-version Docker Compose file
under `deploy/local/` for optional dependency and integration work. The root `dev:up`, `dev:down`,
`dev:health`, and explicitly confirmed `dev:reset` scripts are the only supported lifecycle entry
points.

## Alternatives considered

- Requiring containers for every unit test: rejected because it makes local-first contract tests
  fragile and slow.
- Leaving infrastructure undocumented: rejected because hosted compatibility cannot be exercised
  reproducibly.
- Using floating `latest` images: rejected because dependency drift would invalidate verification.

## Consequences

The repository has one documented optional topology and one disposable credential set for local
development. Integration tests can opt into services through `DATABASE_URL` and service-specific
configuration without changing unit-test authority.

## Migration implications

When a hosted topology is selected, update this composition and its health checks together with the
relevant ADR and adapter contract. Do not silently replace the local SQLite/CAS authority.

## Security impact

Credentials are development-only defaults and must not be reused in production. Volume reset is
destructive and requires an explicit confirmation variable.

## Observability impact

Health checks cover each local dependency’s readiness endpoint and are suitable for CI diagnostics.

## Rollback or revisit trigger

Revisit when the hosted database, event, object, policy, and workflow topology is selected and the
local composition can be reduced to the adapters actually supported by the release.
