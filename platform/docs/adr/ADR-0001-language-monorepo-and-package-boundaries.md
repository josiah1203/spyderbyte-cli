# ADR-0001: Language, monorepo, and package boundaries

- Status: Accepted
- Date: 2026-08-02

## Context

The platform has control-plane, execution-plane, resource-plane, and interaction-plane code that
must share contracts without sharing authority accidentally. A single repository is the lowest
friction way to test those boundaries together while the implementation is greenfield.

## Decision

Use TypeScript on Node.js 22.14.0, with pnpm 9.15.9 workspaces and Turbo as the task runner. Apps
live under `apps/`; reusable code lives under `packages/`; package boundaries are enforced by
workspace dependency rules and the repository boundary verifier. Runtime contracts are imported
from `@agentic-platform/runtime-contracts`; application packages may not be dependencies of
library packages or sibling applications. A host application may declare a narrowly scoped,
documented `x-boundary-exceptions` entry when it must supervise another application process; the
exception does not permit library packages or business commands to bypass the typed API boundary.

## Alternatives considered

- A polyglot repository: rejected because it duplicates contract and verification paths too early.
- npm workspaces without a task runner: rejected because the planned package/test graph needs
  explicit task dependencies.
- A single application package: rejected because it would make authority and adapter boundaries
  implicit.

## Consequences

The repository has one install and verification path, but packages must keep APIs explicit and
avoid reaching across layers through deep imports. Build graph configuration is shared and package
manifests remain independently inspectable. The local TUI declares the only current host exception
because it can auto-start the local daemon server, while its commands still use the client SDK.

## Migration implications

If a package needs a different runtime or language, it must retain the same wire contracts and
adapter boundary; the package can then move behind a protocol without changing callers.

## Security impact

Coarse package rules prevent applications and lower-level packages from acquiring authority by
depending on higher-level application code. They are a defense-in-depth measure, not a substitute
for runtime authorization.

## Observability impact

Every package will use shared correlation, audit, and telemetry types from the contract and
observability packages rather than inventing local identifiers.

## Rollback or revisit trigger

Revisit if the task graph becomes too slow for CI, if a required runtime cannot be supported by
Node.js, or if a separate service repository is needed for an independently operated boundary.
