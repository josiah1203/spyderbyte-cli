# Spyderbyte Phase 5 — Provider/runtime/local-first acceptance

Date: 2026-08-07  
Authoritative plan: [`SPYDERBYTE_DECLARATIVE_IMPLEMENTATION_PLAN.md`](../../SPYDERBYTE_DECLARATIVE_IMPLEMENTATION_PLAN.md)

## Scope

Phase 5 closes the provider-neutral local execution foundation. The implementation now exposes
one selection model for Spyderbyte Cloud, OpenAI, Anthropic, OpenAI-compatible endpoints, Ollama,
llama.cpp, MLX, Hugging Face local models, and customer-owned endpoints. Cloud and customer-owned
families are explicit configuration/selection types; hosted execution remains the Phase 8
implementation boundary.

Provider credentials are stored as vault values referenced by `credentialRef`. Provider metadata,
catalog entries, health, usage, preflight, Run replay records, diagnostics, and onboarding state
contain no credential values. Material API replay bodies recursively remove credential fields before
they enter the universal Run ledger.

## Implemented evidence

- [`packages/provider-runtime/src/provider-configurations.ts`](../../packages/provider-runtime/src/provider-configurations.ts)
  adds the redacted `preflight` report alongside discovery, health, usage, and test contracts.
- [`packages/provider-runtime/src/compute-profiles.ts`](../../packages/provider-runtime/src/compute-profiles.ts)
  persists provider-neutral `RuntimeProfile` records, seeds an offline local-host profile, and
  selects local, Docker, remote, managed, or customer-cloud profiles by requirements and precedence.
- [`packages/local-api/src/onboarding.ts`](../../packages/local-api/src/onboarding.ts) and
  `/v1/onboarding` detect project markers and local environment context, persist the selected
  first-run path, and report that the first question does not require cloud authentication.
- [`packages/local-api/tests/phase5-provider-onboarding.test.ts`](../../packages/local-api/tests/phase5-provider-onboarding.test.ts)
  proves local onboarding, BYOK vault storage, replay redaction, preflight, health, usage, and
  offline compute selection.
- [`packages/provider-runtime/tests/phase5-provider-selection.test.ts`](../../packages/provider-runtime/tests/phase5-provider-selection.test.ts)
  proves local-first runtime precedence and explicit cloud/customer provider families.
- [`apps/local-daemon/tests/phase5-local-first.test.ts`](../../apps/local-daemon/tests/phase5-local-first.test.ts)
  is the disconnected exit-gate test: a clean SQLite workspace opens a project, streams a local
  Run, executes SQL and Python notebook work, publishes an artifact, restarts, resumes the project,
  and records zero external network calls.

## Verification

Passing results on the supplied local snapshot:

```text
provider-runtime tests: 11 files / 59 tests
local-api tests:        13 files / 26 tests
local-daemon tests:      3 files / 12 tests
runtime-contracts, provider-runtime, local-api, client-sdk, TUI, and local-daemon typechecks/builds
provider-runtime, local-api, client-sdk, TUI, and local-daemon lint
contracts:check
api-contracts:check
frontend-contracts:check
package boundary check
git diff --check
focused Prettier check for all Phase 5 files
```

Repository-wide `pnpm format:check` still reports three pre-existing untracked files outside the
Phase 5 change set (`packages/agent-transport/src/index.ts`,
`packages/agent-transport/tests/acp.test.ts`, and
`packages/provider-runtime/tests/phase6-visualization.test.ts`). The Phase 5 files themselves pass
the formatter check.

## Gate result

The Phase 5 disconnected/local-first exit gate passes. Phase 5 is complete for the local/provider-
neutral foundation; hosted account, worker, billing, and cloud execution remain intentionally
deferred to Phase 8.
