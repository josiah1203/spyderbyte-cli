# ADR-0007: Policy decision point

- Status: Accepted
- Date: 2026-08-02

## Context

Authority, tool grants, approvals, tenancy, budgets, and resource scopes must be evaluated
consistently at command, invocation, tool, and commit boundaries. Local development needs a
deterministic policy implementation without an external service.

## Decision

Expose an internal `PolicyDecisionService` interface with versioned inputs and outputs. Use a
deterministic local evaluator first. Use OPA as the default hosted policy decision point after the
policy input/output contract stabilizes. All durable side effects re-evaluate policy and approval at
commit time and fail closed when the decision cannot be verified.

## Alternatives considered

- Policy embedded in each service: rejected because decisions would drift.
- Cedar: viable alternative, but OPA matches the planned bundle and REST integration path.
- A hosted policy service from day one: rejected because it would slow deterministic contract work.

## Consequences

Policy inputs are explicit, versioned, redacted, and testable. Policy is authoritative for
authorization decisions, but business aggregates still enforce their own state invariants.

## Migration implications

Local policy fixtures become conformance fixtures for the hosted evaluator. Policy version changes
require compatibility tests and an audit trail; old decisions remain evidence, not live authority.

## Security impact

Fail-closed behavior, short-lived grants, commit-time checks, revocation, and tenant scoping are
mandatory. Raw credentials and secret values are excluded from policy/model context.

## Observability impact

Each decision records policy version, input digest, authority/approval references, result, and
latency without logging sensitive values.

## Rollback or revisit trigger

Revisit the hosted PDP if bundle distribution, latency, availability, or policy-language review
fails; retain the internal interface and deterministic evaluator.
