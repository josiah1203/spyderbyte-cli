# Artifact registry

`ContentAddressedArtifactRegistry` hashes streamed input, stages content by tenant, writes bytes
through an `ArtifactObjectStore` (the local implementation is filesystem-backed), and publishes
immutable logical versions through the authoritative transaction boundary, persists publication
metadata and lifecycle status through the state port, records lineage, and verifies content
integrity on reads. Human versions automatically preserve the edited parent and propagate
staleness to descendants; agents cannot silently supersede a human version without an explicit
rebase flag.

Staged-object cleanup is retryable. If cleanup fails after the metadata transaction commits,
publication succeeds with `stagedCleanupPending: true` and the staged upload remains available for
reconciliation.

`S3CompatibleArtifactObjectStore` adapts a conditional-write S3-compatible client while preserving
the same immutable `sha256/<hash>` contract as the local stores. A provider client must implement
write-if-absent semantics; collisions are verified byte-for-byte before an existing object is
accepted.
