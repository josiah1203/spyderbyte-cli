# ADR-0016: Provider-neutral dataset catalog contract

- Status: Accepted for local implementation
- Date: 2026-08-03

## Context

Dataset workflows need one boundary for resolving a dataset reference, reading its schema, and
publishing a newer immutable artifact version. The local vertical slice must not encode a hosted
catalog or metadata provider, and a hosted response must not be trusted merely because it came from
an injected client.

## Decision

`packages/backends` exposes `CatalogBackend` with tenant-independent method shapes:

- `resolveDataset(reference)` returns tenant-bound dataset metadata;
- `readSchema(reference)` returns a validated schema descriptor;
- `publishDatasetVersion(artifact)` returns a tenant-bound publication reference.

`InMemoryCatalogBackend` is the deterministic local implementation. It enforces tenant scope,
unique schema fields, and monotonic artifact versions. `HostedCatalogBackend` delegates provider
selection to an injected client and validates tenant identity, reference identity, and publication
identity at the boundary.

## Consequences

Business logic can use the same catalog port locally and in a hosted deployment. Hosted catalog
selection and credentials remain an explicit provider decision. Catalog response validation is
duplicated at the boundary intentionally so a compromised or misconfigured provider cannot widen
tenant scope or silently publish a different artifact than the one requested.
