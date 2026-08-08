# ADR-0020: Bounded tenant retention and deletion protocol

- Status: Accepted for local/provider-neutral implementation
- Date: 2026-08-03

## Context

Tenant export and deletion must cover authoritative metadata, artifacts, events, projections, audit,
connector handles, and backups without relying on a broad SQL or filesystem command. Retention and
legal-hold policy values are product and operations decisions, while the execution safety protocol
can be implemented independently.

## Decision

`TenantLifecycleService` requires an inventory produced by a tenant-scoped data port and an explicit
retention policy version. It creates a dry, auditable plan, blocks legal holds, requires a different
human to approve the request, and executes only bounded batches carrying the tenant, deletion ID,
cursor, batch limit, and inventory digest. Every batch must echo the same tenant and cursor. A
terminal batch creates an immutable tombstone containing the inventory digest, policy version,
deleted count, completion time, and evidence digest.

The local implementation does not choose retention windows or delete hosted data. Hosted adapters
must bind the port to durable repositories, object storage, backups, legal holds, and identity.

## Consequences

Deletion is resumable and reviewable, and stale or cross-tenant batches fail closed. Operators must
retain the tombstone and audit evidence required by the selected policy and must implement the
provider-specific data/object/backup deletion semantics before enabling production execution.
