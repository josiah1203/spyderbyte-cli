# ADR-0017: Bounded interaction API and projection reads

- Status: Accepted for local implementation
- Date: 2026-08-03

## Context

The interaction plane must read authoritative projections and handle large collections without
allowing an unbounded response or a process-local assumption to become the hosted contract.
Authentication and shared rate-limit infrastructure are deployment decisions, but their local
failure behavior should be deterministic and testable.

## Decision

- Add an injected projection-reader port at `GET /v1/projections/{projectionName}`. The API
  allowlists the provider-neutral built-in projection names and keeps tenant binding at the route
  boundary.
- Preserve the existing array response when collection routes have no pagination parameters. When
  `limit` or `cursor` is supplied, return `{ items, nextCursor?, hasMore }` with safe integer cursors
  and a maximum local page size.
- Add an injectable API rate-limiter port. The local implementation is a deterministic fixed-window
  limiter keyed by tenant/workspace and returns `429` with retry metadata. Hosted composition must
  replace it with a shared, identity-aware limiter.
- The web model can load supported projections through `ProjectionApi`, marks cursor gaps as stale,
  and surfaces optimistic artifact-version conflicts without deciding server policy.

## Consequences

The local shell can exercise the same projection-loading, bounded-read, and throttling behavior as a
hosted composition without selecting an identity provider or shared infrastructure. Existing
unpaged callers remain compatible. Hosted authentication, distributed rate limiting, and browser
end-to-end evidence remain release gates.
