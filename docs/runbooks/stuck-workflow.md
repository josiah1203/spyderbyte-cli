# Stuck workflow

Trigger this runbook when a workflow has no progress beyond its deadline, lease, or declared
heartbeat interval.

1. Read the tenant-scoped workflow point read and last authoritative event. Record workflow,
   invocation, attempt, correlation, and budget identifiers.
2. Check pending outbox rows, consumer lag, approval state, activity lease, and the latest
   failure classification. Do not infer state from logs alone.
3. If the activity is recoverable, requeue only through the workflow engine with its declared
   retry policy. If it is not recoverable, cancel or fail it through the control plane.
4. Reconcile compute and budget reservations, then verify the projection and terminal point read.

Evidence to retain: the before/after state, decision actor, event IDs, retry or cancellation
reason, cleanup result, and any parked messages. Hosted worker and scheduler restart commands are
provider-specific and require the hosted topology gate.
