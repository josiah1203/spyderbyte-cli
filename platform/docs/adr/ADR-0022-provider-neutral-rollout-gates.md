# ADR-0022: Provider-neutral harness rollout gates

- Status: Accepted for local/provider-neutral implementation
- Date: 2026-08-03

## Context

The harness rollout requires shadow, canary, limited, and general stages. A failed evaluation must
not accidentally promote a candidate or remove the previous working version. The repository can
define this safety state machine without choosing production thresholds or deployment tooling.

## Decision

`evaluateReleaseGate` accepts caller-supplied checks, an explicit operator-approval flag, release
identifiers, stage, and evaluation time. It fails closed when any check or required approval fails,
returns `hold`, marks rollback as required when a previous release exists, and includes a digest of
the evaluated evidence. A passing evaluation returns `advance` and the next rollout stage.

The helper does not select target values, perform traffic changes, or replace a hosted release
controller. Hosted composition must persist evaluations and bind the result to the chosen deployment
and identity systems.

## Consequences

Local evaluation fixtures can prove promotion/hold semantics and rollback intent. Production
operators still own thresholds, approval policy, persistence, and the actual rollout mechanism.
