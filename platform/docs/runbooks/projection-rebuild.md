# Projection rebuild

1. Mark the projection stale and pause live application for the affected tenant or projection
   shard. Keep raw events and the current checkpoint intact.
2. Rebuild into a new projection namespace from cursor zero or the approved restore cursor.
3. Apply events in stream order, deduplicating by event ID and enforcing tenant boundaries.
4. Compare rebuilt point reads with authoritative aggregates, event counts, audit-chain hashes,
   and outbox/consumer cursors.
5. Atomically promote the rebuilt projection, resume from the recorded cursor, and monitor lag.

Do not repair a projection by editing its rows directly. Hosted database and stream commands are
provider-specific.
