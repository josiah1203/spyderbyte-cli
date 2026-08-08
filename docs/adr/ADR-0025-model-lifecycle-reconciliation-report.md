# ADR-0025: Typed model-lifecycle reconciliation report

- Status: Accepted for local and provider-neutral adapter work
- Date: 2026-08-03

## Context

The model lifecycle produces training, experiment, evaluation, registry, and deployment records.
Returning those records separately makes it possible for a caller to miss a cost mismatch or to
report a rollout state that does not match the actual canary/rollback result.

## Decision

`LocalModelLifecycleResult` includes a typed `LocalModelLifecycleReport` that carries the complete
artifact chain, selected and evaluation metrics, estimated and actual cost with a reconciliation
flag, and the final rollout/rollback state. The report is built only after canary success or
automatic rollback, and its cost flag compares the aggregate candidate observations with the
training summary's reconciled actual cost.

## Alternatives considered

- Leave reconciliation to UI callers: rejected because every caller could apply different
  completeness and cost rules.
- Store only free-form log text: rejected because reports are consumed by projections, audits, and
  later hosted adapters.
- Require the external experiment tracker to assemble the report: rejected because the tracker is
  not authoritative for deployment or policy state.

## Consequences

The result contract is additive and callers can continue using the detailed records. New hosted
orchestration adapters should preserve the report fields or provide an equivalent versioned
reconciliation record.

## Security and observability impact

The report contains tenant-bound artifact and run references, not secret contents. Its explicit
reconciliation fields make cost and rollout discrepancies visible to audit, release gates, and
operator tooling.

## Rollback or revisit trigger

Revisit if the production serving system introduces additional rollout states or billing
dimensions that require a versioned report schema upgrade.
