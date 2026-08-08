# ADR-0008: Object storage and content addressing

- Status: Accepted
- Date: 2026-08-02

## Context

Artifacts are immutable, versioned, content-addressed, and traceable to creator and inputs. Metadata
and bytes have different access patterns and must not be conflated with mutable projections.

## Decision

Store artifact metadata and lineage in the authoritative database. Store bytes under SHA-256
content-addressed keys in a local filesystem adapter and an S3-compatible hosted adapter. Publication
is write-once: a hash collision or existing key with different bytes is an integrity failure, and an
edit creates a new artifact version. Artifact references include tenant, artifact, version, hash,
media type, size, and provenance.

## Alternatives considered

- Mutable named files: rejected because lineage and rollback would be ambiguous.
- Database BLOBs: rejected for scale and independent artifact lifecycle.
- Provider-specific object APIs: rejected because local and hosted contracts would diverge.

## Consequences

Readers need integrity verification and explicit authorization. Garbage collection must be
reference-aware and cannot delete live or audit-referenced bytes.

## Migration implications

Legacy mutable artifacts are imported as immutable versions with an import provenance record.
Changing storage providers copies by content hash and verifies bytes before metadata cutover.

## Security impact

Use least-privilege object credentials, private buckets/filesystems, content-type validation,
path-safe keys, and no secret-bearing artifact names or logs.

## Observability impact

Publish, read, verify, stale, supersede, and garbage-collection records carry hash, size, latency,
tenant, actor, and lineage references.

## Rollback or revisit trigger

Revisit the hosted adapter if durability, integrity verification, retention, or tenancy requirements
cannot be met by an S3-compatible implementation.
