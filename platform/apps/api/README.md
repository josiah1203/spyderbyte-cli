# API application

The framework-free local HTTP adapter exposes the provider-neutral command/query surface: `POST
/v1/commands`, workflow plan/invocation/event queries, invocation lookup, current and versioned
artifact queries, artifact lineage, and agent registration lookup. It also serves cursor-based JSON replays and
reconnectable `text/event-stream` subscriptions at `/v1/subscriptions/events`, plus injected
authoritative projection reads at `/v1/projections/{projectionName}`. Commands are
validated against the shared runtime JSON Schema, and the checked OpenAPI artifact is generated
from `contracts/api.v1.json` into `generated/openapi.v1.json`.

Artifact publication and approval decisions use explicitly injected, tenant-bound local services.
Budget and audit readers remain explicit ports and return `501` until their backing service is wired.
Collection routes preserve their unpaged response for compatibility and support bounded `limit` plus
opaque numeric `cursor` query parameters. An injectable in-process fixed-window limiter provides
deterministic local `429` behavior; hosted deployments must replace it with a shared limiter.

The API optionally accepts an injected `SessionAuthenticator`. The included
`InMemorySessionAuthenticator` stores only token digests, checks expiry/revocation and workspace
membership, exposes the authenticated snapshot at `GET /v1/session`, and enforces the selected
tenant on JSON and SSE requests. Hosted deployments must replace it with the selected
identity/session adapter; no client-supplied tenant header is trusted. The HTTP adapter forwards
authorization and cookie headers to that port, while the browser may select an assigned workspace
with `x-agentic-workspace-id` (JSON) or the equivalent SSE query parameter.

Run `pnpm api-contracts:check` from the repository root to detect API contract drift. Hosted identity
integration and hosted transport remain later-phase work; the adapter receives a tenant-scoped orchestrator
explicitly. Projection readers are injected so the local daemon, a hosted projector, or a test
fixture can provide the same snapshot contract.

Spyderbyte composition can also inject a signed `LicenseGate`. `GET /v1/license/status` returns
safe entitlement metadata without exposing the signature, and effectful command, approval, cancel,
and artifact-publication routes fail closed when the gate reports a missing, invalid, or expired
license. Tests and hosted adapters may omit the gate to preserve their existing explicit fixture
composition; the desktop/local release must always provide one.
