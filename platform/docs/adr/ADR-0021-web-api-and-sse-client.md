# ADR-0021: Browser transport uses the versioned API and reconnectable SSE ports

- Status: Accepted for local/provider-neutral implementation
- Date: 2026-08-03

## Context

The interaction model already consumed projections and subscription pages in tests, but the browser
entrypoint did not have a transport implementation. Without one, the shell could not load the
authoritative projection or recover from an event-stream disconnect.

## Decision

The web package provides `HttpProjectionApi` for typed JSON queries/commands and
`ReconnectableSubscriptionClient` for named `runtime.events` SSE frames. The client stores the last
accepted cursor, ignores older pages, reconnects from that cursor, validates the page envelope, and
surfaces structured HTTP errors. A 409 command failure carrying an artifact/version payload is
rendered as an explicit optimistic-concurrency conflict and is never silently retried.

The browser only enables transport when the `agentic-api-base` meta tag is non-empty. Hosted
authentication, shared rate limiting, and full browser automation remain deployment gates.

## Consequences

The local shell can exercise the same API and subscription contracts as hosted composition, and
two-user artifact races have a defined UX path. Deployments must configure the API base and identity
boundary; the transport does not invent authentication or retry a potentially consequential command.
