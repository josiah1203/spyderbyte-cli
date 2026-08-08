# Spyderbyte release gates

Status vocabulary matches `SPYDERBYTE_IMPLEMENTATION_PLAN.md`. Local scaffolding may be
**Complete**; hosted/credentialed/signed work remains **Blocked** until Section 13 decisions land.

| Gate | Plan item | Status | Evidence / blocker |
| --- | --- | --- | --- |
| Local Spyderbyte entry | P4 partial | Complete locally | `uv run spyderbyte --help`; Wave 6 authority scan |
| Local daemon sidecar discover/start | P4 partial | Complete locally | Waves 3–5 verify scripts |
| Frontend contract schema freshness | Q | Complete locally | `make frontend-contracts-check` |
| Composed platform verify | Q | Complete locally | `make verify-platform` (independent) |
| Hosted control plane deploy (H3) | H3 | Blocked | Needs hosted environment + vendor decisions |
| Managed inference/compute (H4) | H4 | Blocked | Needs credentials, capacity, margin telemetry |
| Entitlements / billing (H5) | H5 | Blocked | Section 13 #8 pricing/entitlements decision |
| SSO/SCIM/CMK/residency (H6) | H6 | Blocked | Section 13 #7 customer/government posture |
| Signed macOS/Linux/Windows artifacts (P5) | P5 | Blocked | Section 13 #9 signing/notarization |
| Update channels / rollback / DR (P6) | P6 | Blocked | Section 13 #9 update/data-preservation |
| Hosted SLO/security scans (Q8) | Q8 | Blocked | Needs hosted CI and production telemetry |
| Package namespace rename (U6) | U6 | Blocked | Section 13 #2 |
| Final sidecar packaging targets | P4 full | Blocked | Section 13 #3 |

Owner actions required before Wave 7 can move from Blocked to Complete:

1. Decide Python package rename / upstream sync policy.
2. Decide packaged sidecar technology and supported targets.
3. Select hosted vendors/regions/residency/customer infrastructure posture.
4. Approve pricing, entitlements, rates, and government caps.
5. Provide signing/notarization credentials and release environments.
