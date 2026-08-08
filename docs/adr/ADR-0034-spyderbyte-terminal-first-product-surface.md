# ADR-0034: Spyderbyte terminal-first product surface

Status: Accepted

Date: 2026-08-06

## Context

Spyderbyte has durable workflow, artifact, policy, event, projection, and local-daemon foundations, but the first user-visible loop must be explicit: configure a provider, discover a usable model, submit a model request, reconnect to its progress, and inspect the durable result. A projection-only UI or a provider catalog that exists only in memory cannot be the authority for that loop.

The product surface therefore needs one shared application boundary for the terminal, CLI, web, desktop, and future hosted clients. It must preserve tenant/workspace scope, keep secrets out of durable metadata and logs, and make provider and run failures diagnosable.

## Decision

1. The local daemon API is the first application boundary. Clients use the same typed client SDK; they do not import provider adapters or mutate state directly.
2. Provider configuration metadata is durable and tenant-scoped. Secrets are stored through the credential vault and represented elsewhere only by credential metadata and a reference.
3. Provider models are derived from persisted configuration plus provider discovery. A model is selectable only when its provider metadata is ready and the routing policy permits it.
4. Every accepted model-assisted conversation turn creates a durable `Run` and `RunAttempt`. Run status, output, failure, and log events are appended to the event store and published through the existing outbox/SSE path.
5. The terminal client exposes provider setup, model refresh, project creation/opening, run submission, run detail, logs, cancellation, retry, and health diagnostics. The interactive shell and one-shot CLI commands call the same SDK methods.
6. Existing workflow projections remain compatible. New model runs use `aggregateType: run` and existing `runs`, `run-timeline`, and `run-logs` projections; the conversation service also provides schema-shaped run detail for clients that need a complete record.
7. SQL/query preview controls remain explicitly non-authoritative until a real execution contract exists. A preview must never be presented as a completed external or durable run.

## Consequences

Positive:

- The terminal, web, and desktop surfaces can converge on one contract and reconnect strategy.
- Restart/reconnect does not lose the run identity, attempt state, or output log.
- Provider setup can be audited without exposing API keys.
- A model failure has a durable location for endpoint, authentication, discovery, inference, streaming, and retry diagnostics.

Tradeoffs:

- Provider setup and model invocation now depend on generated runtime/API contracts and event naming discipline.
- Direct provider adapters initially cover common OpenAI-compatible and Anthropic HTTP paths; specialized CLI gateways and multimodal/tool contracts remain explicit extension points.
- A terminal-first loop adds a client SDK and CLI package that must be versioned with the local API.

## Verification obligations

- Provider configuration persistence tests must prove that secrets are absent from the metadata store.
- Transport tests must cover model discovery, completion, and streaming for OpenAI-compatible and Anthropic paths.
- Local-daemon tests must prove that a conversation turn yields a durable run, attempt, logs, and terminal state.
- Client tests must prove authenticated JSON requests and SSE cursor handling.
- Generated runtime, API, and frontend contract snapshots must be current before release.
