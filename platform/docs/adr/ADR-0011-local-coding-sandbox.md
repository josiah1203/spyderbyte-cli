# ADR-0011: Deterministic local coding sandbox

- Status: Accepted for local Phase 7 work
- Date: 2026-08-02

## Context

The training slice needs a Tier 2 coding boundary that can prove file scope, required checks,
provenance, and secret/dependency hygiene without requiring a cloud scheduler or container runtime.
The host environment cannot safely claim to enforce an arbitrary network allowlist or production
kernel isolation.

## Decision

`@agentic-platform/sandbox-runner` copies a source repository into an invocation-specific mutable
workspace. It runs the requested command and required checks with deadline and output limits,
captures before/after SHA-256 manifests as a deterministic diff and provenance digest, and rejects
changed paths outside the declared allowlist. Changed files are scanned for secret-like values and
unsafe dependency sources. Non-empty local network allowlists fail closed until a hosted sandbox
adapter can enforce them mechanically.

Reference artifacts remain mounted read-only. The local adapter is a contract implementation and
does not claim container, cgroup, or kernel-level isolation; those controls remain Phase 8 hosted
work.

## Consequences

- Coding-task success is based on files, checks, scope, and provenance rather than agent prose.
- The same result shape can be contract-tested against a future container or worktree adapter.
- Local coding tasks cannot use network access, even when a caller requests an allowlist.
- A production deployment must add OS/container isolation and resource enforcement before treating
  the adapter as a hosted security boundary.
