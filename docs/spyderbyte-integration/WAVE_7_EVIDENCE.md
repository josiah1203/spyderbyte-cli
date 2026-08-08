# Wave 7 — Remaining hosted, commercial, and release gates

**Status:** In progress locally for scaffolding; **Blocked** on Section 13 decisions and credentials for hosted/commercial/signed release

**Branch:** `codex/wave-7-release-gates`

**Parent:** `codex/wave-6-authority-cutover`

Wave 7 cannot be marked complete without hosted environments, vendor/product decisions,
credentials, and signing infrastructure. This branch records the gate matrix, verifies the
local-only release scaffolding that is already available, and fails closed on blocked gates.

## Local scaffolding delivered

- Release-gate checklist enumerating H3–H6 and P5–P6/Q8 requirements with current status.
- `scripts/verify_wave_7.py` confirms local Spyderbyte entry/help, frontend contract freshness
  prerequisite via make, and prints an explicit blocked-gate report instead of inventing hosted
  evidence.
- Plan status distinguishes local scaffolding from hosted/credentialed completion.

## Verification

| Scope | Command | Result |
| --- | --- | --- |
| Authoritative Wave 7 gate | `UV_CACHE_DIR=/tmp/spyderbyte-uv-cache make verify-wave-7` | Pass local scaffolding; reports blocked hosted/signing gates |
| Gate checklist | [`RELEASE_GATES.md`](RELEASE_GATES.md) | Source of truth for remaining Section 13 work |

## Blocked gates (require human decisions / credentials)

See Section 13 of `SPYDERBYTE_IMPLEMENTATION_PLAN.md` and [`RELEASE_GATES.md`](RELEASE_GATES.md):

1. Hosted identity/gateway/Postgres/object/secret/workflow adapters (H3)
2. Managed inference/compute reconciliation and customer-owned alternatives (H4)
3. Pricing, entitlements, licensing, usage billing (H5 / Section 13 #8)
4. Production SSO/SCIM, private runners, residency, CMK, government evidence (H6 / Section 13 #7)
5. Signed/notarized publication for supported platforms (P5 / Section 13 #9)
6. Stable/beta/nightly updates, rollback, DR evidence (P6 / Section 13 #9)
7. Final package namespace rename and sidecar packaging targets (Section 13 #2/#3)
