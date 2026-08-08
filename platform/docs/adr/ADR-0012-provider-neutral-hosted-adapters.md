# ADR-0012: Provider-neutral hosted adapters

- Status: Accepted for contract and adapter work; provider binding pending the hosted decision gate
- Date: 2026-08-02

## Context

The platform must preserve identical control-plane contracts across local and hosted deployments,
but the implementation plan requires a deliberate choice of cloud, scheduler, event transport,
object store, and secret manager before production credentials or external systems are enabled.

## Decision

Implement hosted adapters against narrow injected client interfaces:

- `S3CompatibleArtifactObjectStore` requires conditional write-if-absent and byte verification.
- `HostedDurableEventTransport` requires publish deduplication, acknowledgement, parking, replay,
  and lag operations.
- `HostedSecretBroker` delegates issuance, resolution, revocation, and redaction without accepting
  plaintext values in its issue request.
- `HostedComputeBackend` rechecks Cluster authority, tenant scope, resource scope, approval, cost,
  and expiration before delegating to a scheduler client.
- `ExternalWorkflowEngine` keeps an external durable-engine implementation behind the internal
  workflow contract.

The adapters contain platform invariants and return platform types. Provider SDKs, credentials,
network clients, and deployment-specific configuration belong only in client implementations after
the human decision gate is accepted.

## Consequences

- Local fake clients can run conformance tests without cloud access or production secrets.
- Provider selection remains reversible at the resource boundary.
- These adapters do not constitute production readiness until a real provider client passes the
  same tests plus hosted durability, security, backup/restore, and operational gates.
