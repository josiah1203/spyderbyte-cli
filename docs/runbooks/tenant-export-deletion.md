# Tenant export and deletion

1. Verify tenant and workspace identity, retention/residency policy, legal hold, requester
   authority, and required human approval. Start with a dry-run inventory.
2. Enumerate authoritative aggregates, artifact versions and objects, events/outbox rows,
   projections, audit records, connector handles, and backups by tenant scope.
3. Export only through redacted, access-controlled paths. For deletion, use
   `TenantLifecycleService` with an approved policy-versioned inventory, bounded tenant-scoped
   batches, checkpoints, and a tombstone/evidence record; never issue broad filesystem or SQL
   deletion commands.
4. Verify no cross-tenant records were touched, reconcile asynchronous cleanup, and retain the
   minimum deletion evidence required by policy.

Retention, residency, encryption, legal hold, and deletion windows remain governance decisions;
this runbook does not choose them or authorize destructive execution without the required identity,
approval, and hosted adapter bindings.
