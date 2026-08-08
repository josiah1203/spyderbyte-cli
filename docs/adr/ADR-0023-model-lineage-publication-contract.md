# ADR-0023: Structured model-lineage publication contract

- Status: Accepted for local and provider-neutral adapter work
- Date: 2026-08-03

## Context

Model publication must prove the full reproducibility chain before a candidate can be promoted.
An untyped artifact array could contain the right number of references while omitting the training
configuration, source revision, execution environment, or original-data provenance.

## Decision

Represent model publication lineage as a structured `ModelLineage` value containing the checkpoint,
experiment run, exact training configuration, source revision, environment snapshot, validated
dataset, and one or more original-data lineage artifacts. The candidate artifact must match the
lineage checkpoint by artifact ID, version, and content hash. Local and hosted registry adapters
validate the complete shape and tenant ownership before publication or delegation.

## Alternatives considered

- Keep a positional artifact array: rejected because completeness and ordering would remain
  implicit and easy to bypass.
- Put lineage only in external tracker metadata: rejected because the external tracker is not
  authoritative and may be unavailable during promotion.
- Require a provider-specific lineage schema: rejected because business logic must remain
  provider-neutral.

## Consequences

Model registry clients must provide structured lineage evidence. Existing callers migrate by
assigning each prior reference to its semantic role and supplying the run/configuration/source,
environment, and original-data references. Hosted responses are rejected if they omit or alter the
required chain.

## Security impact

Promotion cannot silently accept cross-tenant or incomplete provenance. Approval-bound publication
still revalidates policy, evaluation, and the commit digest before delegation.

## Observability impact

Lifecycle audit records continue to store only redacted identifiers and summaries; experiment and
model records retain the correlation-ready run and artifact references for reconciliation.

## Rollback or revisit trigger

Revisit if a selected experiment tracker or model registry requires a richer immutable lineage
graph, or if a compatibility migration needs versioned publication payloads for already persisted
model versions.
