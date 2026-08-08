# Wave 4 — Computational platform parity

**Status:** Complete locally; rich-client handoff and credentialed hosted publication remain external

**Branch:** `codex/wave-4-computational-parity`

**Parent:** `codex/wave-3-golden-path`

Wave 4 exposes every v1 first-class computational resource through the shared AgentSession, Run,
policy, approval, artifact, lineage, usage, and audit contracts established in Wave 3. Terminal
callers discover, invoke, observe, resume, cancel, inspect, compare, publish, export, and hand off
resources through typed routes rather than opaque shell commands.

## Delivered boundary

- `FrontendResourceType` / `FrontendResourceOperation` DTOs and generated frontend-contract schema
  entries cover dataset, SQL, notebook, experiment, model, visualization, pipeline, and automation.
- `NativeResourceClient` maps each typed operation to an explicit backend route table. Arbitrary
  paths are rejected so CLI callers cannot bypass tenant, policy, approval, Run, or audit
  boundaries.
- `HttpFrontendClient.resources` and `MockFrontendClient.resources` share the same resource
  protocol. Session capability discovery advertises the native-resource matrix.
- `spyderbyte resource <type> <operation>` emits stable JSON envelopes for headless and streamed
  Run observation.
- Local API adds `/v1/visualizations/catalog` so visualization discover/inspect use a first-class
  catalog rather than a synthetic shell fallback. Client SDK exposes `visualizationCatalog()`.
- Wave 4 verify script boots a clean temporary workspace daemon and exercises discover across all
  eight resource families plus visualization inspect.

## Verification

| Scope | Command | Result |
| --- | --- | --- |
| Authoritative Wave 4 gate | `UV_CACHE_DIR=/tmp/spyderbyte-uv-cache make verify-wave-4` | Pass: schema freshness, Ruff, Pyright, 28 Python tests, Wave 0 provenance, and clean-workspace native-resource E2E |
| Native-resource unit matrix | `UV_CACHE_DIR=/tmp/spyderbyte-uv-cache uv run pytest tests/spyderbyte_contract/test_wave_4.py -q` | Pass: route authority, typed envelopes, capability errors, and headless JSON command |
| Real daemon discover matrix | `UV_CACHE_DIR=/tmp/spyderbyte-uv-cache uv run python scripts/verify_wave_4.py` | Pass: project creation, eight-family discover, visualization catalog inspect |
| Platform visualization catalog | `pnpm --dir platform --filter @agentic-platform/local-api test -- phase6-artifacts.test.ts` | Pass: 2 tests, including `/v1/visualizations/catalog` |
| Source hygiene | `git diff --check` | Required before commit; no generated or secret material beyond the versioned contract schema is included |

## External gates

Personal-local workspaces correctly keep organization-only governance surfaces behind backend
capability checks. Rich-client handoff destinations (web, Jupyter, desktop) open over shared
resource and Run IDs when the backend provides a handoff payload; interactive editing UX remains
with those clients. Credentialed hosted publication and signing remain Wave 7 gates.
