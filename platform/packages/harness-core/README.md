# Harness core

The Phase 4 foundation is implemented:

- factory validation for tier, tool, model, authority, budget, retry, and approval policies;
- mechanical parent/child invocation enforcement with registration, delegation, depth, and budget checks;
- trust-separated context assembly with a source/version/size/reason manifest;
- model routing with budget reservation/reconciliation, cancellation/deadlines, bounded provider fallback,
  token enforcement, and non-sensitive telemetry;
- Cline-compatible internal interfaces with streamed events, usage observations, normalized errors,
  lifecycle disposal, and a fake adapter;
- ordered lifecycle hooks and report validation that requires authoritative artifact, cost, metric,
  child-invocation, and state-assertion verification before durable acceptance;
- invocation delegation pinned to the parent authority envelope, including resource and artifact-scope
  subset checks and budget isolation.

Phase 4 also includes an active/disabled harness registry with exact contract/runtime compatibility,
permitted-child checks, and deterministic, plugin-backed, and coding Tier 2 harness shells. The
focused completion coverage is in `tests/p4-completion.test.ts` and the registry package tests.
