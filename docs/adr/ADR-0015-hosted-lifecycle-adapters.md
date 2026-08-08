# ADR-0015: Provider-neutral lifecycle adapters

Status: Accepted for the provider-neutral implementation

## Context

Experiment tracking and serving systems are external resources. Their state is
not authoritative, and a provider response must not be allowed to cross a
tenant boundary or silently change the control-plane model and deployment
contract.

## Decision

- Define injected clients for experiment runs, model publication/listing, and
  deployment requests, transitions, health observations, and rollback.
- Keep tenant-scoped control-plane handles and model/deployment records in the
  shared contracts; hosted adapters validate returned tenant, identity, state,
  and traffic fields before returning them to domain code.
- Preserve the local implementations as deterministic contract fixtures. A
  provider-specific tracker and serving backend is selected only after the
  hosted topology and data-handling gate is accepted.

## Consequences

Adapter conformance tests can cover the lifecycle path without paid services or
real production model traffic. Reconciliation, provider retries, serving
capacity, and rollout infrastructure remain deployment-specific work.
