# ADR-0003: Schema authority and code generation

- Status: Accepted
- Date: 2026-08-02

## Context

The platform has TypeScript implementations, JSON APIs, persisted events, fixtures, and future
non-TypeScript consumers. A type-only contract would not validate runtime input or document the
wire format.

## Decision

JSON Schema is the language-neutral authority for public runtime contracts. Schemas are versioned
and committed under `packages/runtime-contracts/schemas/`. Runtime validation uses a pinned JSON
Schema validator; generated TypeScript types and human-readable documentation are checked into
their generated directories. Generation is deterministic and CI fails when generated output is
out of date. Fixtures cover valid, invalid, and historical versions, with pure upcasters for
non-breaking compatibility.

## Alternatives considered

- TypeScript-first schemas: rejected because non-TypeScript consumers and wire-level review would
  be second-class.
- OpenAPI-first: insufficient for events, internal commands, and artifact content contracts.
- Runtime decorators: rejected because they couple the wire contract to one framework.

## Consequences

Contract changes require schema review, fixture updates, compatibility checks, and regeneration.
The repository carries generated artifacts, but they are derived and never edited by hand.

## Migration implications

Required or semantic changes create a new schema version. Optional additive fields are allowed only
when old consumers remain correct. Historical raw events remain decodable through upcasters.

## Security impact

Validation occurs before authorization-sensitive operations and before reports or artifacts are
accepted. Schemas must reject unknown authority-bearing fields unless the contract explicitly
allows them.

## Observability impact

Every accepted command, event, report, and artifact reference carries an explicit schema version,
so dashboards and replay tools can distinguish contract evolution from runtime behavior.

## Rollback or revisit trigger

Revisit if another language-neutral schema system provides materially stronger compatibility tooling
without weakening JSON Schema interoperability.
