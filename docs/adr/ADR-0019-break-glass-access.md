# ADR-0019: Expiring, scoped break-glass access

- Status: Accepted for local/provider-neutral implementation
- Date: 2026-08-03

## Context

Emergency operations need a controlled recovery path without weakening normal authority, approval,
tenant, secret, or audit invariants. A permanent admin bypass would be difficult to review and easy
to reuse outside the incident that justified it.

## Decision

Break-glass grants are a separate policy primitive. A request must identify one human subject, a
non-empty reason, explicit actions and resource selectors, an expiration, and a positive maximum
use count. A different human must approve it. The grant is checked again at the side-effect
boundary, expires automatically, becomes consumed at its use limit, and can be revoked with a
reason. Every lifecycle transition and use is emitted through the audit sink.

Wildcard operations, cross-tenant use, subject substitution, and raw secret values are rejected.
The local implementation is storage-provider neutral; identity, durable persistence, and on-call
integration remain hosted deployment work.

## Consequences

The emergency path is explicit and testable, but it adds a second human control and requires
operators to preserve audit evidence. Hosted deployments still need durable storage, identity
binding, alerting, and a reviewed operational policy before enabling it.
