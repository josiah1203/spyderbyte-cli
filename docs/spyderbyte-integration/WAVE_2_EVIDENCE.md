# Wave 2 — Contract and Transport Foundation

**Status:** Complete locally; PR publication deferred by owner

**Branch:** `codex/wave-2-contract`

**Parent:** `codex/wave-1-compose`

Wave 2 gives the retained Kimi UI a real, typed Spyderbyte frontend seam without moving product
authority into Kimi. It is still a local/mock transport increment: provider credentials, durable
AgentSession/Run orchestration, and the credentialed provider smoke test remain Wave 3 work.

## Delivered boundaries

- `spyderbyte_cli.frontend.models` owns the v1 session, prompt, error, event-page, Run, approval,
  artifact, and usage DTOs. The JSON Schema is generated from those models and checked in CI.
- `FrontendTransport` owns bearer/workspace/interface headers, idempotency keys, bounded retries,
  safe error envelopes, and cancellation-aware HTTP requests.
- `HttpFrontendClient` maps `/v1/session`, prompt acceptance, Run cancellation/retry, and
  reconnectable `/v1/subscriptions/events` SSE pages into the frontend DTOs.
- `FrontendProjector` applies events by cursor, deduplicates event IDs, buffers out-of-order
  pages, and explicitly reports unresolved gaps requiring snapshot refresh.
- `AcpSessionBridge` maps session identity, content, assistant deltas, Run status, permissions,
  artifacts, usage, and cancellation over the same frontend client.
- Kimi-derived provider, tool, process, retry, and background mechanics are adapter-only and
  fail closed when no Spyderbyte-owned port is configured. Provider responses and tool outputs are
  redacted before leaving the adapter boundary.
- `DaemonManager` now supports discovery, owned-process start/stop/restart, and safe diagnostics.

## Verification

| Scope | Command | Result |
| --- | --- | --- |
| Python contracts and tests | `UV_CACHE_DIR=/tmp/spyderbyte-uv-cache make verify-wave-2` | Pass |
| Python type checks | `UV_CACHE_DIR=/tmp/spyderbyte-uv-cache uv run pyright src/spyderbyte_cli tests/spyderbyte_contract` | Pass |
| Mock CLI | `UV_CACHE_DIR=/tmp/spyderbyte-uv-cache uv run spyderbyte --mock --prompt 'Verify Wave 2' --json` | Pass |
| Schema freshness | `UV_CACHE_DIR=/tmp/spyderbyte-uv-cache uv run python scripts/generate_spyderbyte_frontend_contracts.py --check` | Pass |
| Imported platform regression | `pnpm --dir platform verify:composed` | Pass: contracts, 33-package lint/type/test/build, invariants, and desktop bundle |
| Source hygiene | `git diff --check` | Pass |

Wave 2 does not claim credentialed provider, hosted, or release evidence.
