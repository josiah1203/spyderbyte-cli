# Spyderbyte Phase 4 — Universal Run acceptance

Date: 2026-08-07  
Authoritative plan: [`SPYDERBYTE_DECLARATIVE_IMPLEMENTATION_PLAN.md`](../../SPYDERBYTE_DECLARATIVE_IMPLEMENTATION_PLAN.md)

## Scope

This record closes the Phase 4 gate for the supplied local foundation. The universal execution
envelope now carries the request, plan, runtime, environment, compute, network, secret-reference,
limit, idempotency, and restart-safe replay metadata for material actions.

The local API mutation boundary classifies material actions—including prompt-adjacent commands,
Python, SQL, notebook/cell execution, data operations, visualization, training, evaluation,
connector sync, automation, deployment, repository changes, ACP, and Jupyter execution—into the
universal coordinator. Conversation submission remains an explicit exception because the durable
conversation service creates the canonical Agent Run directly; conversation retry links its child
runtime back to the original Run and reconciles the new attempt.

The coordinator persists `ExecutionRequest`, `ExecutionPlan`, `Run`, `RunAttempt`, lifecycle and
progress events, result records, operation links, output references, resource usage, and outbox
entries. It supports idempotency replay, restart-safe API retry using the persisted redacted replay
descriptor, cooperative cancellation through `AbortSignal`, approval-wait states, partial success,
reconnect/read projection, and one Run with multiple attempts.

## Evidence

The acceptance suite is [`packages/local-api/tests/universal-run.test.ts`](../../packages/local-api/tests/universal-run.test.ts).
It proves:

- all declared material action families are classified and Run-control paths are excluded;
- API, CLI, TUI, ACP, Jupyter, web, automation, and system interface identities produce equivalent
  authoritative request/plan/run/attempt records;
- the same Run survives state-store reconstruction and retry after coordinator restart;
- failed first attempts and successful retries remain under one Run with two attempts;
- idempotency, cancellation, approval waits, partial failure, listing, and progress/log projection
  are durable;
- the conversation service retains the original Run while linking and reconciling a retry child.

Passing verification commands:

```text
pnpm --filter @agentic-platform/local-api test
pnpm --filter @agentic-platform/local-daemon test
pnpm --filter @agentic-platform/runtime-domain typecheck
pnpm --filter @agentic-platform/runtime-contracts typecheck
pnpm --filter @agentic-platform/client-sdk typecheck
pnpm --filter @agentic-platform/jupyter-extension typecheck
pnpm --filter @agentic-platform/tui typecheck
pnpm --filter @agentic-platform/web typecheck
pnpm contracts:check
pnpm format:check
git diff --check
```

Result: all commands passed on the supplied local snapshot. Phase 4 is complete for the local,
CLI/TUI, API, ACP, Jupyter, and web client boundary; hosted provider/runtime adapters continue
under the later provider and deployment phases.
