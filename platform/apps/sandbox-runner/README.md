# Sandbox runner

The local Tier 2 execution entrypoint provides invocation-specific workspaces, read-only artifact
mounts, bounded subprocess execution, cancellation/deadlines, output limits, secret-filtered
environment inheritance, and fail-closed network policy handling.

`runCodingTask` adds the deterministic coding-task gate: it copies a repository into a mutable
invocation workspace, captures before/after content digests, enforces an exact changed-path
allowlist, runs required checks, and rejects secret-like or unsafe dependency changes. Successful
coding tasks must publish an immutable `text/x-diff` patch through an injected artifact publisher;
the returned reference is checked for tenant, hash, media type, and invocation provenance.
