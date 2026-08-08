# ADR-0035: Phase 0 capability and command authority

- Status: Accepted
- Date: 2026-08-06

## Context

The repository contains a broad web surface, a local API, a TUI, provider adapters, runtimes, and
projection-backed previews. Existence of a screen or route is not proof that the underlying work is
callable or durable. Phase 0 needs one auditable classification and one command map before new
surfaces can claim completion.

## Decision

`docs/contracts/spyderbyte-capability-inventory.md` is the visible capability inventory and
classifies every capability group as real, projection-only, mocked, local-only, experimental, or
incomplete. `docs/contracts/spyderbyte-command-map.md` is the first-release terminal command
authority map. `/v1/capabilities` is the runtime gate for callable features; the local API and web
surface must report or render unavailable capabilities explicitly.

The runtime contract JSON Schema and its fixtures remain the wire authority. Client surfaces may
add presentation metadata, but they may not invent a second execution state or declare success from
an optimistic mutation.

## Alternatives considered

- Treating the web page registry as the capability authority: rejected because it is a presentation
  registry and cannot observe runtime adapter readiness.
- Treating every route as callable: rejected because several routes are intentionally local-only,
  projection-only, or dependency-gated.
- Maintaining only prose: rejected because contract fixtures and capability descriptors must be
  executable and testable.

## Consequences

Visible features need a classification, route/service mapping, and capability descriptor or explicit
preview label. The terminal, web, desktop, and Jupyter surfaces can share the same evidence and
failure semantics.

## Migration implications

New capabilities must add inventory/map entries and fixtures before being promoted from
experimental or incomplete. Removing a capability requires a compatibility note and a clear
unavailable reason.

## Security impact

Capability state is not authorization by itself. The API still enforces tenant, license, policy,
approval, and local-confirmation boundaries before effectful work.

## Observability impact

Capability descriptors, command acknowledgements, events, and errors carry stable names, versions,
correlation IDs, and executor/reason metadata so support can distinguish unavailable setup from
runtime failure.

## Rollback or revisit trigger

Revisit when hosted execution or a new client surface becomes authoritative, or when the local API
capability descriptor must be versioned for an incompatible client contract.
