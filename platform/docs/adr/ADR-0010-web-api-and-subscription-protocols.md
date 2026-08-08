# ADR-0010: Web API and subscription protocols

- Status: Accepted
- Date: 2026-08-02

## Context

Clients need commands, queries, approvals, artifact edits, and reconnectable event updates. The
frontend must remain a projection of authoritative state rather than a second workflow engine.

## Decision

Use versioned REST endpoints under `/v1` for commands and queries, with JSON Schema/OpenAPI
validation, idempotency keys for commands, optimistic versions for edits, correlation IDs, stable
error envelopes, tenant authorization, and pagination. Use Server-Sent Events for reconnectable
event subscriptions with cursors; defer WebSockets until bidirectional chat/control requires them.

## Alternatives considered

- GraphQL first: rejected because command side effects, audit, and schema compatibility are clearer
  with explicit endpoints in the first release.
- WebSockets first: rejected because one-way event replay is simpler and sufficient initially.
- Frontend-local state machines: rejected by the authoritative-event invariant.

## Consequences

API handlers translate validated requests into commands/queries and never implement business policy
locally. SSE requires durable cursors, idempotent projection reads, and explicit reconnect behavior.

## Migration implications

Breaking API changes use a new version. A WebSocket session can later wrap the same event and
command contracts without changing domain state.

## Security impact

Every request is tenant-scoped and authenticated; responses exclude internal stack traces and
secrets. Approval actions bind to exact action digests and are rechecked on commit.

## Observability impact

Requests, commands, subscriptions, cursors, and errors carry correlation/causation IDs, tenant,
actor, schema version, latency, and rate-limit outcomes.

## Rollback or revisit trigger

Revisit the transport if SSE cannot meet reconnect, fan-out, or latency targets, or if a client
requirement proves bidirectional sessions necessary before the planned interaction phase.
