# ADR-0024: Deterministic connector build and material-bound publication

- Status: Accepted for local and provider-neutral adapter work
- Date: 2026-08-03

## Context

Connector publication previously exposed scan and approval booleans directly to the registry, but
there was no deterministic package build or single digest covering the source artifact, generated
package, requested scopes, and verification evidence. That leaves a time-of-check/time-of-use gap:
an approval could be carried from one package material to another.

## Decision

`ConnectorSpecialist.build` resolves the approved specification into sorted tool schemas,
generated source, generated contract tests, and a dependency-free package manifest. A separate
contract-test runner produces verification evidence. `ConnectorPublicationWorkflow` accepts a
tenant-bound `ConnectorPublicationMaterial` and requires both approval digests to equal the
canonical digest of the complete source-artifact identity, author/publisher identities, generated
source/package, scope digest, scan result, and contract-test evidence before delegating to the
deterministic registry.

The local orchestrator composes these ports in the order source → scan/build → contract tests →
Governance and human approval → registry publication. The workflow never accepts raw production
credentials or provider-specific publication behavior.

## Alternatives considered

- Keep independent booleans on the registry request: rejected because the fields do not bind the
  approval to the material that was reviewed.
- Hash only the source text: rejected because generated schemas, dependencies, scopes, and test
  results can change the published package without changing the source text.
- Let the specialist publish directly: rejected because author/publisher separation and the
  deterministic registry boundary belong to the control plane.

## Consequences

Connector callers first prepare material to obtain the approval digest, then submit that digest at
commit time. Any source, specification, scope, package, scan, or contract-test change requires a
new preparation and approval. Hosted connector registries can replace the injected registry port
without changing the local ordering or digest contract.

## Security impact

Approval replay, actor substitution, and source/specification TOCTOU are reduced by material-bound
commit validation.
Secret-like source values and unsafe dependency references fail closed before package publication;
the existing tenant and author-versus-publisher checks remain mandatory.

## Observability impact

The registry audit records continue to store identifiers and outcomes rather than source or secret
contents. The returned preparation result exposes source, package, scope, and verification digests
for correlation and reconciliation.

## Rollback or revisit trigger

Revisit if a selected hosted build service needs a richer reproducible-build attestation, a signed
package manifest, or a dependency policy that cannot be represented by the provider-neutral
material contract. Revocation remains the local rollback action for an already published package.
