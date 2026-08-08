# ADR-0018: Provider-neutral release gates

- Status: Accepted for local evidence generation
- Date: 2026-08-03

## Context

Operations need repeatable SLO and capacity evidence before choosing hosted targets. Hard-coding
latency, availability, recovery, or concurrency values in the local implementation would turn an
unapproved product decision into a false release guarantee.

## Decision

`packages/observability` provides a deterministic SLO summarizer/evaluator and a bounded concurrent
capacity probe. Callers must supply target values, and an empty observation set fails closed. The
helpers report raw counts, latency samples, and check results so a hosted runner can attach
correlation, tenant, exporter, and operator evidence without changing the gate semantics.

## Consequences

Local and hosted compositions can use the same gate logic. The repository gains executable evidence
generation without claiming production readiness. Target values, load envelopes, alert thresholds,
and release stages remain explicit operations decisions.
