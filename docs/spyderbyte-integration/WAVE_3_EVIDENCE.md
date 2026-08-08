# Wave 3 — Local golden-path wiring

**Status:** Complete locally; credentialed-provider smoke and PR publication deferred by owner

**Branch:** `codex/wave-3-golden-path`

**Parent:** `codex/wave-2-contract`

Wave 3 connects the typed Python frontend to the authoritative local Spyderbyte daemon. The
daemon remains responsible for project state, AgentSessions, Runs, provider/model selection,
policy, approvals, artifacts, usage, and event history.

## Delivered boundary

- `HttpFrontendClient.open_session()` negotiates the API session, discovers native capabilities,
  selects the newest active project, or creates one through the versioned `CreateProject` command
  contract with UUIDv7 command/correlation IDs and idempotency.
- Conversation, AgentSession, request, response, recommendation, plan, estimate, message, Run,
  attempt, and log snapshots are mapped into strict v1 Python DTOs.
- Prompt submission supports backend-resolved provider/model overrides. Run list/detail/log,
  cancellation, retry, approval decision, artifact/version, projection, provider catalog, model
  catalog, and runtime catalog facets stay behind the frontend client; no provider SDK or local
  execution authority was added to the Python UI.
- SSE event mapping normalizes backend delta payloads, preserves nested Agent events, recovers Run
  identity from authoritative correlation/session fields, filters unrelated history in CLI/ACP,
  resumes from numeric cursors, and closes nested async streams without the prior generator-close
  warning.
- `spyderbyte acp --backend local` now uses the same AgentSession/Run client path as the CLI.
  The local daemon development command rebuilds its dependency closure so API source changes are
  reflected in sidecar smoke runs.
- The local API model-catalog route was ordered before its dynamic model-detail route; a platform
  regression test protects `/v1/models/catalog`.

## Verification

| Scope | Command | Result |
| --- | --- | --- |
| Authoritative Wave 3 gate | `UV_CACHE_DIR=/tmp/spyderbyte-uv-cache make verify-wave-3` | Pass: schema freshness, Ruff, Pyright, 24 Python tests, Wave 0 provenance, and clean-workspace daemon E2E |
| Real daemon golden path | `UV_CACHE_DIR=/tmp/spyderbyte-uv-cache uv run python scripts/verify_wave_3.py` | Pass: clean temporary workspace, project creation, native capability discovery, deterministic provider/model/runtime catalogs, prompt acceptance, SSE stream/resume, AgentSession snapshot, Run attempts/logs, conversation snapshot, and terminal `succeeded` state |
| Local ACP path | `UV_CACHE_DIR=/tmp/spyderbyte-uv-cache uv run spyderbyte acp --backend local --prompt 'Verify ACP uses the local AgentSession and Run path' --json` | Pass: ACP initialization, shared Run updates, assistant chunk, and turn completion |
| Platform route regression | `pnpm --dir platform --filter @agentic-platform/local-api test -- phase5-provider-onboarding.test.ts` | Pass: 2 tests, including model-catalog route ordering |
| Source hygiene | `git diff --check` | Required before commit; no generated or secret material is included |

## External gates

The local daemon intentionally runs the deterministic `deterministic`/`fixture-model` adapter. No
credential was available for the separate credentialed-provider smoke. Personal-local workspaces
also correctly do not expose organization-only approval and usage surfaces; those typed client
facets fail through the backend's explicit capability/error envelope rather than inventing local
state. GitHub connector authentication remained unavailable, so this branch is locally reviewable
but unpublished.
