# ADR-0037: P3 production-scale services use provider-neutral, tenant-scoped boundaries

- Status: Accepted
- Date: 2026-08-06

## Context

The P3 backlog extends the local-first runtime into serving, organization budgets, advanced agent
routing, hosted execution, enterprise identity/secrets, recovery, governance, and browser
collaboration. These capabilities have materially different deployment providers and trust
boundaries. A local test double must prove lifecycle and policy behavior without pretending that a
local process is Kubernetes, that a caller-supplied identity claim is an SSO assertion, or that a
secret value belongs in application state.

## Decision

Implement P3 around provider-neutral contracts and deterministic reference services:

- Serving uses an endpoint/revision manager backed by the existing deployment state machine. Canary,
  ramp, activation, and rollback require a fresh approval whose action digest matches the commit
  digest. Health observations are counted consecutively and can trigger an approved rollback.
- Budgets are keyed by tenant and form an explicit parent chain. Reservation, consumption,
  reconciliation, and release are serialized per tenant so child reservations cannot oversubscribe
  an organization or workspace parent. Cost policies are separate records and may reject providers,
  models, invocation cost, or retry count.
- Agent routing filters task shape, capability, data class, model provider, tier, and preferred type,
  then applies deterministic cohort rollout and optional shadow selection. Invocation leases enforce
  per-definition concurrency and expiry.
- Hosted execution accepts only an executable plus argument vector, requires an explicit network
  allowlist and sandbox limits, enforces tenant quotas, and delegates scheduler-specific work to a
  client adapter. Worker pools and customer-cloud compute remain injection points.
- Enterprise identity accepts only HTTPS OIDC/SAML provider metadata, binds login state to a tenant
  and provider, validates trusted claims, and revokes sessions when SCIM users are deprovisioned.
  Enterprise secret managers issue opaque, TTL-bound, operation-scoped handles; application logs and
  audit records never contain secret values. Secret resolution and SSO callback handling stay on the
  hosted side of the trust boundary.
- Recovery stores a content digest and encryption-key reference, rejects secret-shaped snapshot
  fields, verifies before restore, binds approval to the digest, supports idempotent restore, and
  evaluates legal holds. Collaboration uses tenant-scoped optimistic versions, explicit conflict
  records, presence TTLs, and audit records.

The optional `productionScale` bundle in the local API exposes the non-secret control-plane
operations through tenant-scoped routes. The client SDK mirrors those routes. Vendor clients are
implemented by adapters at hosted composition time and are not inferred from local request bodies.

## Alternatives considered

- Bind P3 directly to one cloud scheduler, identity provider, and secret manager: rejected because it
  would make the contract non-portable and would turn provider outages or account configuration into
  unit-test assumptions.
- Put SSO claims or resolved secret values in the local API: rejected because it widens the trust
  boundary and makes accidental persistence/logging likely.
- Use uncoordinated child budget counters: rejected because concurrent workspace/project reservations
  could oversubscribe the organization limit.
- Treat health status as a UI-only annotation: rejected because rollback safety depends on durable,
  thresholded observations and approval-bound transitions.

## Consequences

The repository has deterministic unit-testable behavior for all six P3 workstreams, a generated API
contract, and a typed SDK surface. Production composition must supply scheduler, identity, secret,
object-store, and database clients and must preserve the same tenant, approval, and audit contracts.
The in-memory services are reference implementations, not claims that external infrastructure is
already provisioned.

## Migration implications

Hosted adapters should implement the exported interfaces in `packages/backends` and preserve opaque
secret handles, tenant checks, and state/approval semantics. API clients should use the P3 routes in
`apps/api/generated/openapi.v1.json`; new provider-specific fields belong behind adapter contracts,
not in the shared control-plane request shapes.

## Security impact

The decision prevents cross-tenant reads, stale traffic approvals, shell-string execution, open
network egress, plaintext secret persistence, restore of tampered snapshots, and session reuse after
SCIM deprovisioning. Production deployments still need provider-native IAM, encryption, audit
retention, and network controls.

## Observability impact

Serving, budget, identity, recovery, and collaboration reference services emit tenant-scoped audit
records. Budget alerts identify soft-limit and hard-limit events. Recovery evidence includes the
content digest and restore evidence digest. Hosted adapters must map scheduler/provider identifiers
and failures into the same audit and observation fields.

## Rollback or revisit trigger

Revisit when the first hosted provider is selected, when SSO/SCIM claim mapping requires a richer
directory contract, or when the budget ledger moves from in-memory serialization to a durable
transactional store. Any replacement must retain the exported tenant and approval invariants.
