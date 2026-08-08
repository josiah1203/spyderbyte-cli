# Wave 0 — Freeze and Decide

**Status:** Complete locally; PR publication deferred by owner
**Branch:** `codex/wave-0-freeze`
**GitHub base:** `main` at `cbc15c076d17f70fec9f89c90c0502e68657f505`
**Local platform source:** `2579ce2b195ba394509f7b4ded6cc6dbcddbfebe`

This evidence freezes the two unrelated source histories before composition. No Spyderbyte
platform source is overlaid in this wave.

## Provenance result

- GitHub `josiah1203/spyderbyte-cli` is the Kimi CLI fork and contains 988 tracked files at the
  selected baseline.
- The local Spyderbyte platform contains 755 tracked files at its selected baseline.
- `git merge-base` returns no commit: the histories are unrelated.
- The fetched GitHub branch replaced the stale local `origin/main` reference, proving that the
  prior tracking ref was not evidence of GitHub contents.
- [`source-baselines.json`](../../integration/source-baselines.json) records commit IDs, intended
  source tags, tracked-file counts, license identity, and critical file hashes.
- `scripts/verify_wave_0.py` validates both commits and every recorded hash from Git objects, so
  working-tree changes cannot falsify the baseline.

## Kimi module disposition

[`kimi-module-classification.json`](../../integration/kimi-module-classification.json) is an
ordered, machine-verified classification of every path under `src/kimi_cli`:

- **preserve:** frontend and generic terminal utilities;
- **adapt:** ACP/wire mechanics, commands, approvals, extensions, notifications, tools, context,
  compaction, and background mechanics;
- **replace:** Kimi Soul, agent prompts, sessions, provider configuration, credentials, sharing,
  and composition authority;
- **remove:** Kimi account, telemetry, web, and visualization product surfaces; and
- **defer:** generated dependencies and bundled skills until the capability boundary is stable.

The verifier fails on an unclassified source path and therefore prevents new upstream modules
from entering the integration without a deliberate disposition.

## Runtime candidate decisions

[`runtime-candidate-decisions.json`](../../integration/runtime-candidate-decisions.json) records
candidate-level retain/fork/rewrite/reject treatment and the required conformance gate. The
decisions preserve tested mechanics without preserving Kimi product authority.

## Backend contract readiness audit

The local platform already has typed TypeScript contracts and API/client implementations for
projects, AgentSessions, Agent events, Universal Runs and Attempts, approval, providers/models,
runtimes/compute, artifacts, usage, subscriptions, ACP, datasets/SQL, notebooks/Jupyter,
visualizations, experiments/training/evaluation/models, deployment/serving, pipelines,
automations, connectors, organization/governance, and recovery.

Wave 1 and Wave 2 must close these frontend-facing gaps rather than expose backend package
internals to Python:

| Gap | Required output |
| --- | --- |
| Python has no versioned client package | Generated or validated Python models plus async HTTP/SSE client |
| Session response fields are partly optional in the TypeScript client | Required `FrontendSession` DTO with negotiated schema/capabilities |
| Event stream uses numeric cursors but has no Python replay fixture corpus | Cross-language snapshots, duplicate/out-of-order/gap fixtures, resume tests |
| Prompt acceptance is represented by broad JSON responses | Typed accepted-turn envelope with project, AgentSession, message, and Run IDs |
| Approval projection is backend-shaped | Frontend approval DTO with choices, expiry, grant scope, and committed-result event |
| Native computational APIs expose heterogeneous local response shapes | Stable resource summary/detail/action/handoff DTO families |
| Error handling lacks a Python taxonomy | Version mismatch, auth, policy, approval, budget, transport, cursor-gap, and terminal Run errors |
| Daemon lifecycle is not packaged for Python | Discovery, start/connect, readiness, diagnostics, restart, and version negotiation contract |

## Baseline verification

The commands below are the authoritative baseline commands; failures are frozen rather than
silently corrected in Wave 0.

| Source | Command | Result at freeze |
| --- | --- | --- |
| Kimi CLI | `make check-kimi-cli` | Passes; `ruff`, formatting, and `pyright` are clean. The upstream non-blocking `ty` step reports diagnostics but exits successfully by design. |
| Kimi CLI | `KIMI_SHARE_DIR=/tmp/spyderbyte-kimi-test-state make test-kimi-cli` | Passes: 2,955 unit/in-repo tests passed, 5 skipped, 1 expected failure; 52 external E2E tests passed and 4 real-LLM tests skipped |
| Spyderbyte platform | `pnpm verify` | Fails at `codex:migration:check`: generated `CODEX_MIGRATION_MATRIX.md` is stale at clean commit `2579ce2b` |

The platform failure predates composition and must be repaired in the imported platform tree,
then the complete verification command rerun. A broad root `pytest` invocation is not an upstream
Kimi CI command and was rejected after it mixed workspace test modules and omitted package dev
dependencies.

## Owner decision gate

**Accepted by the repository owner on 2026-08-08.** The following decisions are binding for the
subsequent implementation waves unless superseded by an accepted ADR:

Wave 0 cannot be marked complete until the owner accepts or edits these decisions:

1. **Import method:** history-preserving subtree import of platform commit `2579ce2b` under
   `platform/`; do not squash and do not merge unrelated roots at repository root.
2. **Python namespace:** introduce `spyderbyte_cli` now; retain `kimi_cli` only as a temporary
   internal compatibility/provenance namespace through authority cutover.
3. **Sidecar packaging:** HTTP plus resumable SSE to `platform/apps/local-daemon`; development
   launcher first, packaged managed sidecar after the local golden path.
4. **ACP:** preserve the current `agent-client-protocol==0.8.0` mechanics for the first vertical
   slice while mapping all state to Spyderbyte contracts; expand the compatibility matrix later.
5. **Upstream synchronization:** explicit patch-port PRs only, each with source commit,
   classification review, license check, and UI regression evidence.
6. **First adapter candidates:** `ContextCompactor`, `ContextWindowManager`,
   `OpenAICompatibleTransport`, and `LocalProcessRuntime`; no background execution or Kimi
   agent-loop adoption until Run/cancellation/budget contracts pass.
7. **Wave publication:** every wave receives its own branch, commit set, and validation evidence.
   Draft PR publication is deferred by the owner's 2026-08-08 instruction to skip PRs and
   continue; the branches remain publication-ready.

## Exit evidence required

- both intended source tags resolve to the recorded commits;
- `python scripts/verify_wave_0.py` passes;
- Kimi check/test outcomes replace the pending rows above;
- the accepted owner gate remains recorded in this evidence; and
- the Wave 0 changes are committed as an isolated, publication-ready wave branch.
