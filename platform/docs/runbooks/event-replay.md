# Event replay and projection rebuild

Raw domain events and transactional outbox rows remain authoritative. A consumer may be redelivered
the same event, so consumers must acknowledge only after the idempotent projection/effect commit.

- Use the tenant-scoped subscription cursor as the `afterCursor` value.
- If the gateway reports `gapDetected`, stop applying live events and refresh the authoritative
  projection before resuming from the returned cursor.
- Park poison messages with their event ID, consumer, error code, and correlation ID. Do not delete
  them; replay only after the handler or data issue is corrected.
- Rebuild projections from raw events with an explicit cursor and verify the rebuilt point read
  against the current aggregate state.
- Compare outbox lag, consumer lag, redelivery count, and parked-message count before closing the
  incident.
