# Wave 5 — Organizational and hosted interface parity

**Status:** Complete locally; full SSO/SCIM, signed cloud login UX, and commercial entitlements remain external

**Branch:** `codex/wave-5-org-hosted`

**Parent:** `codex/wave-4-computational-parity`

Wave 5 exposes organization governance, workspace facets, approvals, license/onboarding, and ACP
cancel through the same Python frontend client used by the local golden path. Personal-local
workspaces continue to fail closed on organization surfaces through backend capability checks.

## Delivered boundary

- `NativeGovernanceClient` wraps `/v1/governance/*`, `/v1/workspace/*`, `/v1/license/status`,
  `/v1/onboarding`, and `/v1/cloud/runs/estimate` without inventing local policy authority.
- Headless CLI commands mirror the TypeScript TUI oracle: `org`, `users`, `policies`, `budgets`,
  `approvals`, `audit`, `workspace`, `onboarding`, and `license`.
- ACP cancel is exercised through the Spyderbyte frontend client rather than Kimi Soul.
- Command parity matrix records implemented, partial, and deferred surfaces.

## Verification

| Scope | Command | Result |
| --- | --- | --- |
| Authoritative Wave 5 gate | `UV_CACHE_DIR=/tmp/spyderbyte-uv-cache make verify-wave-5` | Pass: schema freshness, Ruff, Pyright, 31 Python tests, Wave 0 provenance, organization daemon E2E |
| Governance unit matrix | `UV_CACHE_DIR=/tmp/spyderbyte-uv-cache uv run pytest tests/spyderbyte_contract/test_wave_5.py -q` | Pass: route authority, JSON commands, ACP cancel |
| Organization daemon E2E | `UV_CACHE_DIR=/tmp/spyderbyte-uv-cache uv run python scripts/verify_wave_5.py` | Pass: org bootstrap, evaluate/commit, audit verify |
| Parity matrix | [`COMMAND_PARITY_MATRIX.md`](COMMAND_PARITY_MATRIX.md) | Seeded against TUI help |

## External gates

SSO/SCIM, customer-managed keys, pricing/entitlements, and signed hosted login remain Wave 7 /
Section 13 decisions. Rich interactive editing stays with web/desktop clients over shared IDs.
