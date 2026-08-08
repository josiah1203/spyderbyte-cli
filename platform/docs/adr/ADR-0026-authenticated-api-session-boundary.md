# ADR-0026: Provider-neutral authenticated API session boundary

- Status: Accepted for local and provider-neutral adapter work
- Date: 2026-08-03

## Context

The local API enforced a configured tenant, but it had no authenticated-session boundary. A hosted
identity system must not be selected implicitly, and the local fixtures must not encourage storing
raw bearer material or trusting a client-supplied tenant header.

## Decision

Add an injectable `SessionAuthenticator` port. The local implementation issues short-lived fixture
sessions, stores only a SHA-256 token digest, checks bearer syntax, session timestamps, revocation,
and workspace membership, and returns a tenant-bound actor/session record. An optional
`x-agentic-workspace-id` request value can select only a workspace already present in the
authenticated session. When configured, the API authenticates every request, including SSE, before
rate limiting or route handling.

Production composition must replace the local implementation with the selected OIDC/JWT or session
store adapter. The API does not infer identity from arbitrary tenant headers and existing local
compositions remain intentionally usable without an authenticator for offline fixtures.

## Alternatives considered

- Trust a request tenant or workspace header: rejected because it is client-controlled authority.
- Store raw fixture tokens: rejected because local test infrastructure should model the same secret
  handling discipline expected from hosted identity systems.
- Select an OIDC provider now: rejected because identity provider and production credential choices
  are explicit human gates in the implementation plan.

## Consequences

The internal request contract gains optional headers and the API can fail closed with 401 for missing
or expired sessions and 403 for an unassigned workspace. The session snapshot exposes available
workspaces, and the web shell resets projections before switching to an assigned workspace. Existing
fixed-tenant local API fixtures remain backward compatible when the port is omitted.

## Security and observability impact

Raw bearer tokens are not retained by the local session authority. Authentication failures carry
structured authority errors without echoing token material; rate limiting remains keyed by the
workspace selected from the authenticated session rather than an untrusted tenant value.

## Rollback or revisit trigger

Revisit when the first hosted identity architecture is selected. Preserve the port and its
tenant-bound session semantics while replacing token issuance, verification, rotation, and
revocation with the production adapter.
