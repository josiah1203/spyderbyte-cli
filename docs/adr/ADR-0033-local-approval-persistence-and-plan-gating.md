# ADR-0033: Local approval persistence and plan gating

- Status: Accepted for Spyderbyte v1
- Date: 2026-08-03

## Context

The Spyderbyte frontend must let a user inspect a typed workflow plan before any specialist
execution begins. The existing approval service already binds decisions to an exact action digest,
authority envelope, artifact versions, expiration, and revocation epoch, but the dataset
orchestrator did not yet connect that service to its plan/run boundary. An in-memory approval store
would also lose a pending review when the daemon restarts.

## Decision

When the local dataset orchestrator is composed with `ApprovalService`, each `ValidateDataset` plan
creates one `workflow.execute` approval request bound to the root invocation authority and exact
source/output artifact selectors. The plan marks its steps as approval-required. A run request
transitions the workflow and root invocation to `awaiting_approval`; execution is allowed only
after a separate human decision and commit-time `ApprovalService.assertValid` check. The local API
creates a short-lived workflow/invocation-scoped decision authority for approve, reject, and revoke
routes; the browser only renders these commands and never evaluates policy itself.

SQLite workspace compositions persist approval records in a mode-0600 JSON store beside
`.agentic/state.sqlite`. The file is included in the existing integrity-protected workspace
archive, so a restored workspace retains its pending and decided approvals. The v1 archive remains
checksummed but not encrypted; encryption is a separate release/security decision.

## Alternatives considered

- Execute immediately after planning: rejected because it defeats the Spyderbyte plan-review
  boundary.
- Keep approvals only in memory: rejected because daemon restart would invalidate the user’s
  review state without an explicit policy decision.
- Add approval fields directly to the workflow SQL schema: deferred because the existing policy
  service has a synchronous store port and the portable workspace archive already provides a
  durable local boundary for v1.

## Consequences

The combined `submit` compatibility path returns `awaiting_approval` when approvals are configured;
the Spyderbyte CLI and Vibe UI must approve before running. Approval records are local workspace
state and are included in backup/export. A future hosted composition should replace the file store
with a transactional durable adapter while preserving the action-digest and commit-time checks.

## Rollback or revisit trigger

Revisit if approval persistence must participate in the same database transaction as workflow state,
if archive encryption becomes mandatory, or when the hosted approval store and identity model are
selected.
