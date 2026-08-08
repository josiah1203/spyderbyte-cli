# Poison event

1. Stop the failing consumer from acknowledging the event and capture event ID, stream cursor,
   consumer, tenant, correlation ID, error code, and a redacted payload digest.
2. Park the original event durably. Never delete it, rewrite it, or acknowledge it as a recovery
   shortcut.
3. Correct the handler or authoritative data under review, then replay the event through the
   idempotent consumer with a bounded attempt count.
4. Verify the projection point read, side-effect receipt, outbox state, and parked-message count.

If the event is malformed or forged, keep it parked and escalate to the security runbook. Hosted
transport parking and replay commands remain adapter-specific.
