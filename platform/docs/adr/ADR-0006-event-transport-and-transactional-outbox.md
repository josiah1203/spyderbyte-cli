# ADR-0006: Event transport and transactional outbox

- Status: Accepted pending hosted transport proof
- Date: 2026-08-02

## Context

Domain state and publishable events must commit atomically, while consumers must tolerate redelivery
and reconnect from a cursor. Exactly-once end-to-end side effects are not available from transport
semantics alone.

## Decision

Persist events and outbox records in the same authoritative transaction. Use an in-process/local
outbox dispatcher first. Use NATS JetStream as the default hosted transport after a proof of
delivery, replay, retention, and operational behavior. Consumers use idempotency keys, aggregate
versions, deduplication records, and side-effect receipts; the platform claims effectively-once
processing, never exactly-once side effects.

## Alternatives considered

- Direct database polling only: useful locally but insufficient as the hosted transport contract.
- Kafka: strong option, but a larger initial operational footprint for this platform slice.
- Fire-and-forget application events: rejected because state and event publication could diverge.

## Consequences

Event envelopes, cursors, retention, redelivery, and consumer acknowledgements are explicit
contracts. Projection rebuilds must work from raw events independent of the transport.

## Migration implications

The local dispatcher and NATS adapter implement the same consumer contract. A transport migration
replays from the outbox/event store and preserves event IDs and schema versions.

## Security impact

Topics/streams are tenant-aware where required, consumers authenticate through broker credentials,
and event payloads are redacted before leaving their trust boundary.

## Observability impact

Publish, delivery, acknowledgement, redelivery, lag, cursor, and deduplication outcomes are
recorded with event and correlation IDs.

## Rollback or revisit trigger

Revisit NATS if retention/replay, tenant isolation, latency, or operational tests fail; retain the
transactional outbox regardless of transport choice.
