# Transactional outbox backlog

1. Measure pending rows by tenant, topic, age, retry count, and correlation ID. Confirm the
   authoritative transaction committed before investigating transport delivery.
2. Check consumer health, transport connectivity, parked messages, and idempotency receipts.
3. Restore consumers or reduce intake under the declared backpressure policy. Process rows in
   bounded batches and mark published only after the transport acknowledgement.
4. Recheck oldest-row age, duplicate delivery, projection lag, and budget/workflow impact before
   closing the incident.

Never delete backlog rows to reduce a metric. Hosted transport tuning requires the selected
provider and capacity target.
