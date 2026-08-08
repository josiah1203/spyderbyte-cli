# ADR-0005: Durable workflow engine

- Status: Accepted pending Phase 6 proof-of-concept
- Date: 2026-08-02

## Context

Workflows must survive worker loss, support cancellation and approval waits, and replay
deterministically. The local contract should not depend on a vendor-specific API.

## Decision

Define and implement the internal `WorkflowEngine` interface first. Use a deterministic in-process
engine for unit tests and the earliest local slice. Use Temporal as the default durable hosted
implementation in Phase 6, subject to a proof-of-concept covering replay, cancellation, signals,
workflow upgrades, and TypeScript worker operations.

## Alternatives considered

- Queue plus custom state machine: more operational surface and weaker replay semantics.
- Temporal from the first local slice: couples foundational tests to an external service.
- Another durable engine: remains viable if the Phase 6 proof does not meet requirements.

## Consequences

Workflow code must be deterministic and keep side effects behind activities/adapters. The adapter
must expose cancellation and signal semantics without leaking Temporal types into domain packages.

## Migration implications

The in-process engine and Temporal adapter share conformance tests. Existing workflow state is
recovered from authoritative aggregates and event history, not from vendor-specific snapshots alone.

## Security impact

Workflow signals and activity execution are authorized by the control plane; the engine is not an
authority grant. Secrets remain in brokered adapters.

## Observability impact

Workflow IDs, run IDs, activity IDs, retries, and replay decisions map to platform correlation and
audit records.

## Rollback or revisit trigger

Revisit if the proof-of-concept fails replay, cancellation, upgrade, or operational SLO gates, or
if a compatible engine offers materially lower recovery risk.
