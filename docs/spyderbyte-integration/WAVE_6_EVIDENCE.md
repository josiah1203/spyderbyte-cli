# Wave 6 — Kimi authority removal and product cutover

**Status:** Complete locally for authority cutover; package rename, signed packaging, and
notarized release remain Section 13 gated

**Branch:** `codex/wave-6-authority-cutover`

**Parent:** `codex/wave-5-org-hosted`

Wave 6 removes live Kimi product-authority composition from the Spyderbyte CLI path. Approved
Kimi-derived mechanics may remain only behind `spyderbyte_cli.adapters.kimi` or non-authority UI
presentation modules. The Spyderbyte shell renderer no longer imports Kimi console/update/usage
surfaces.

## Delivered boundary

- `spyderbyte_cli.__main__` and `cli.py` compose only the Spyderbyte Typer app and frontend client.
- `shell.py` renders through Rich directly; no `kimi_cli` import remains on the Spyderbyte UX path.
- Forbidden-import and forbidden-token scans reject Soul/OAuth/update/usage/telemetry product
  authority modules and composition tokens such as `KimiCLI`.
- Transitional `kimi` / `kimi-cli` entrypoints and the `kimi-cli` package name remain until the
  Section 13 namespace decision.

## Verification

| Scope | Command | Result |
| --- | --- | --- |
| Authoritative Wave 6 gate | `UV_CACHE_DIR=/tmp/spyderbyte-uv-cache make verify-wave-6` | Pass: schema freshness, Ruff, Pyright, 35 Python tests, Wave 0 provenance, authority scan |
| Authority unit tests | `UV_CACHE_DIR=/tmp/spyderbyte-uv-cache uv run pytest tests/spyderbyte_contract/test_wave_6_authority.py tests/spyderbyte_contract/test_boundaries.py -q` | Pass |
| Authority scan | `UV_CACHE_DIR=/tmp/spyderbyte-uv-cache uv run python scripts/verify_wave_6.py` | Pass: Spyderbyte-branded help; no product-authority imports/tokens |

## Deferred Section 13 items

- U6 final Python package/namespace rename and dual-entrypoint removal
- P4 composed Spyderbyte-plus-sidecar product packaging targets
- P5/P6 signed/notarized publication, update channels, rollback, and data-preservation behavior
- Expanding ACP beyond the current `agent-client-protocol==0.8.0` baseline
