# Codex-derived shell provenance

**Status:** Migration boundary complete for the supplied snapshot; no Codex source imported  
**Date:** 2026-08-07  
**Product:** Spyderbyte  
**Source checkout:** `/Users/josiah/Downloads/codexcli-main`  
**Upstream repository:** <https://github.com/openai/codex>  
**License:** Apache-2.0  
**Additional notice observed:** Ratatui-derived code under MIT, as stated in the source `NOTICE`

## Source identity

The supplied checkout does not contain `.git` metadata, so an upstream commit cannot be asserted
from the local files. The source identity is therefore provisional until the source is re-fetched or
the provider supplies an authenticated commit/release archive digest.

| Field                  | Value                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Source URL             | `https://github.com/openai/codex`                                                                                           |
| Local checkout         | `/Users/josiah/Downloads/codexcli-main`                                                                                     |
| Git commit             | Unavailable: checkout has no `.git` directory                                                                               |
| Source snapshot        | 6,046 Codex files plus 65 Spyderbyte CLI-boundary files inventoried by `scripts/verify/generate-codex-migration-matrix.mjs` |
| Combined file manifest | `sha256:b9b4aec1b69375b0f8c697d4307526bcfbe3e48beb9a5a934d0b4d40770174d3`                                                   |
| Audit date             | 2026-08-07                                                                                                                  |
| Import date            | Not applicable; no Codex source has been imported                                                                           |

The combined manifest includes each inventoried path, byte count, and SHA-256 file digest. The
authoritative generated matrix is [`CODEX_MIGRATION_MATRIX.md`](CODEX_MIGRATION_MATRIX.md).
Every inventoried row has a resolved deterministic decision; no row remains in the `AUDIT` state.
Regenerate and verify it with:

```text
pnpm codex:migration:generate
pnpm codex:migration:check
```

## Import inventory at the Phase 0 gate

| Category                          | Recorded state                                                                                                                                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Imported upstream files           | None; no Codex source is part of the Spyderbyte build.                                                                                                                                                         |
| Modified imported files           | None; there are no imported upstream files to modify.                                                                                                                                                          |
| Excluded files and behavior       | Codex agent, account/auth, cloud, telemetry, thread/rollout, billing, product-domain, and update behavior is excluded by policy; non-shell files are explicitly `REMOVE` or `REPLACE` in the migration matrix. |
| Generated or ignored source paths | `.git`, `node_modules`, `target`, `dist`, `.turbo`, and local-daemon `.agentic` runtime state are excluded from the deterministic inventory; generated/build outputs are not import candidates.                |
| Sync policy                       | Version-pinned, deliberate re-generation and review; no continuous upstream merge.                                                                                                                             |

The Phase 0 audit report is [`migration-audit.md`](audit-artifacts/2026-08-07-codex-phase-0/migration-audit.md).

The completed shell boundary is `apps/spyderbyte-shell`: `apps/tui` starts the local daemon and
owns the typed `SpyderbyteClient`, while the Rust shell receives context, Run status, plan, log,
reconnect, cancellation, and output-delta frames over an authenticated loopback bridge. The
backend remains the only AgentSession, policy, provider, Run, and persistence authority.

## License and attribution obligations

Before importing any file:

1. Preserve the Apache-2.0 license and required copyright notices.
2. Carry prominent modified-file notices where the license requires them.
3. Preserve the Ratatui MIT notice for any retained Ratatui-derived code.
4. Record imported, modified, and excluded files in the generated matrix and release notices.
5. Do not imply OpenAI endorsement through Spyderbyte branding, binary names, product copy, or
   distribution channels.
6. Audit transitive Rust, Node, Python, and system dependencies independently of the source
   license.

## Import and sync policy

- Do not merge the Codex repository wholesale.
- Import only files classified `KEEP` or explicitly approved `ADAPT` in the matrix.
- Place approved source under `vendor/codex-derived/` or the approved shell crate boundary; do not
  scatter upstream code through Spyderbyte domain packages.
- Every imported file receives provenance metadata and a modified-file notice when changed.
- Upstream synchronization is deliberate and version-pinned; there is no continuous upstream merge.
- A changed upstream snapshot invalidates the migration matrix and requires a review before build or
  release.
- Codex core, authentication, ChatGPT/OpenAI account, cloud, telemetry, tool-registry, thread,
  rollout, billing, and product-domain behavior is excluded from the Spyderbyte shell.

## Current intentional compatibility references

The existing repository contains provider and compatibility identifiers such as `openai-codex`,
`codex-subscription`, and `codex-cli`. They are recorded as existing migration findings, not as
approval to expose Codex branding as the primary product. Phase 5 must decide whether a
Codex-subscription adapter is intentionally retained, renamed behind a neutral provider label, or
removed. User-facing branding scans must distinguish legal/provenance references from product
surface defects.
