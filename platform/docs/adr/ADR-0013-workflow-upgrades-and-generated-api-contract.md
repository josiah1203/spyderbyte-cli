# ADR-0013: Explicit workflow upgrades and generated API contract

Status: Accepted for the provider-neutral local implementation

## Context

In-flight workflows must survive a compatible workflow-code deployment without
silently changing their definition or allowing an old handle to mutate state.
The HTTP boundary also needs a checked contract so request validation and API
documentation do not drift independently from the runtime schema authority.

## Decision

- `DurableWorkflowEngine` accepts only exact `(fromVersion, toVersion,
migrationId)` pairs registered at construction time.
- An upgrade updates the authoritative workflow record and emits
  `workflow-engine.definition-upgraded.v1` in the same state transaction.
- Handles from the previous definition version become invalid for query and
  mutation operations. Terminal workflows cannot be upgraded.
- The API manifest at `apps/api/contracts/api.v1.json` is the source for the
  generated OpenAPI document at `apps/api/generated/openapi.v1.json`.
- The generator embeds the shared runtime JSON Schema definitions and the API
  validates `POST /v1/commands` with the shared `RuntimeCommand` validator.
- The local recovery suite includes a SQLite-backed child-worker fixture that
  is killed during an activity and resumed by a replacement process.

This decision is provider-neutral. It does not claim that a hosted workflow
engine has passed its replay or worker-upgrade proof; that remains the Phase 6
Temporal/hosted gate.

## Consequences

Deployments must register and review migrations before moving in-flight work.
The explicit mapping is fail-closed and makes compatibility auditable, while
the generated API artifact can be checked in CI with `pnpm api-contracts:check`.
