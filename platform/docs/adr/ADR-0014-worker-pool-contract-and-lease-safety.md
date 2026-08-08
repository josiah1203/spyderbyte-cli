# ADR-0014: Worker-pool contract and lease safety

Status: Accepted for the provider-neutral local implementation

## Context

Hosted execution needs separate worker pools for control, domain specialists,
deterministic tasks, coding sandboxes, compute observation, and projections.
Workers must not claim work outside their tenant or pool, and a lost worker must
not hold a task forever.

## Decision

- Define one `WorkerPool` contract with tenant-scoped enqueue, claim, heartbeat,
  acknowledgement, failure, parking, point reads, and lag.
- The local implementation enforces configurable queue and concurrency quotas,
  expiring leases, bounded attempts, redelivery, and terminal parking.
- The hosted implementation delegates to an injected client and validates every
  returned lease and task record before exposing it to domain code.
- Pool names are explicit: Tier 0 control, Tier 1 domain, Tier 2 deterministic,
  Tier 2 coding, compute observation, and projection.

This is a provider-neutral contract. Container security, network policy,
ephemeral storage, and hosted scheduler bindings remain Phase 8 decision gates.

## Consequences

Local tests can exercise worker replacement and backpressure without cloud
systems. Hosted clients must preserve tenant, pool, lease, and attempt semantics;
provider-specific redelivery and dead-letter tooling remains an adapter concern.
