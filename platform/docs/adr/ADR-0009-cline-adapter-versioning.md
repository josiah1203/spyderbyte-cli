# ADR-0009: Cline adapter and versioning

- Status: Accepted
- Date: 2026-08-02

## Context

The platform plans to use Cline for agent runtime behavior, but direct SDK use would spread provider
coupling and make authority, budgeting, redaction, and report validation inconsistent.

## Decision

Only `@agentic-platform/cline-adapter` may import Cline SDK APIs. Business code depends on the
internal `AgentRuntimeAdapter`. The adapter receives a brokered model client/credential handle,
materialized harness definition, context, tool set, and abort signal. SDK versions are pinned in
the lockfile and compatibility tests cover creation, structured output, tool calls, streaming,
cancellation, errors, and usage reporting. CI uses a fake runtime and never sends production data.

## Alternatives considered

- Direct SDK calls from specialists: rejected because it bypasses shared enforcement.
- A provider-neutral agent runtime with no Cline adapter: deferred until multiple runtimes are
  required.
- Unpinned SDK upgrades: rejected because runtime semantics affect audit and report acceptance.

## Consequences

The adapter owns SDK translation and compatibility risk. Harness core owns lifecycle, policy,
budget, context, and report enforcement; Cline does not become the source of truth.

## Migration implications

SDK upgrades require adapter compatibility fixtures and a versioned adapter contract. Replacing
Cline changes only the adapter and runtime registration when the internal interface remains stable.

## Security impact

Provider credentials are brokered, short-lived, redacted, and never placed in model context or
worker dumps. Tool capability remains narrower than the agent's possible textual instructions.

## Observability impact

Adapter events normalize provider request IDs, model/version, usage, latency, cancellation, and
error categories into platform telemetry without recording secrets or full sensitive prompts.

## Rollback or revisit trigger

Revisit if the pinned SDK cannot satisfy structured output, cancellation, usage, or isolation tests,
or if a different runtime provides a safer supported adapter.
