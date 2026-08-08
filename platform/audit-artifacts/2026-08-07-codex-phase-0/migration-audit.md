# Phase 0 Codex migration audit

**Date:** 2026-08-07  
**Decision:** Accepted with 6111 resolved matrix decisions; no Codex source import is part of the build  
**Codex root:** `/Users/josiah/Downloads/codexcli-main`  
**Codex files observed:** 6046  
**Spyderbyte CLI boundary files observed:** 65

This report records the evidence gathered for the Phase 0 exit gate. Static findings in the Codex tree are deliberately retained as import-review inputs; no upstream file is part of the Spyderbyte build.

### Exit-gate checks

| Check | Result |
|---|---|
| Matrix generated and linked | PASS |
| Matrix digest matches UPSTREAM_CODEX.md | PASS |
| Codex Apache-2.0 license present | PASS |
| Codex notice preserves OpenAI and Ratatui attribution | PASS |
| No direct @openai/codex dependency in audited Spyderbyte CLI boundary | PASS |
| No Codex source import into the audited Spyderbyte CLI boundary | PASS |
| Every matrix row has a resolved decision | PASS |
| Source commit or deterministic snapshot is recorded | PASS |

### Provenance and license audit

- Upstream repository: <https://github.com/openai/codex>.
- Local checkout has no git metadata; the deterministic snapshot is the current source identity.
- Matrix digest: `sha256:b9b4aec1b69375b0f8c697d4307526bcfbe3e48beb9a5a934d0b4d40770174d3`; provenance record: `sha256:b9b4aec1b69375b0f8c697d4307526bcfbe3e48beb9a5a934d0b4d40770174d3`.
- Apache-2.0 license: present.
- NOTICE attribution: OpenAI Codex and Ratatui notices present.
- Matrix rows with unresolved AUDIT decisions: 0.
- No source import occurred. Modified-file notices and release attribution are therefore not applicable to the current build.

### Dependency audit

- Codex Rust workspace members/manifest entries observed: 162.
- Codex workspace dependency entries observed: 303.
- Direct `@openai/codex`/`codex` dependency in the audited Spyderbyte CLI boundary: 0.
- Files with Codex-derived source import markers in the audited boundary: 0.
- Dependency provenance for any future imported Ratatui or Rust utility crate must be recorded separately before Phase 1 build integration.
- Vulnerability scanning of the upstream dependency graph is a Phase 1 import gate; no upstream dependency is currently in the Spyderbyte lockfile.

### Security audit

- Codex files containing process execution mechanisms: 235.
- Codex files containing unsafe code: 150.
- Codex files containing authentication/credential terms: 1663.
- Codex files containing network URLs: 1699.
- These findings are not approved for import. Spyderbyte process execution, sandboxing, secret handling, cancellation, and policy remain authoritative.
- The shell boundary ADR forbids Codex core, auth, cloud, telemetry, tool-registry, and persistence behavior from becoming Spyderbyte authority.

### Branding and telemetry audit

- Audited Spyderbyte CLI boundary files containing Codex/OpenAI-Codex identifiers: 6.
- Findings: `apps/spyderbyte-shell/src/lib.rs`, `packages/cline-adapter/src/index.ts`, `packages/cline-adapter/tests/compatibility.test.ts`, `packages/runtime-contracts/generated/runtime-contracts.v1.json`, `packages/runtime-contracts/schemas/runtime-contracts.v1.json`, `packages/runtime-contracts/src/contracts.ts`.
- Findings are categorized as migration/provider compatibility references in the current implementation; user-facing names must be neutralized or explicitly approved before release.
- Audited CLI boundary files containing telemetry/analytics terms: 2.
- No Codex telemetry endpoint or inherited OpenAI account telemetry is authorized. Local-only mode must support telemetry disabled or redirected.

### Filesystem and binary audit

- Audited CLI boundary files containing Codex-specific home/path markers: 0.
- No Codex home/path findings.
- Audited CLI boundary files containing binary/configuration markers: 25.
- Current package exposes the `spyderbyte` binary; a Codex primary binary is not authorized.
- Final paths/configuration are `~/.spyderbyte`, project `.spyderbyte`, and `SPYDERBYTE_` environment variables.

### Migration follow-up

- Re-fetch or otherwise authenticate the upstream commit/release digest before any future synchronization.
- Keep the approved shell behavior reimplemented behind the Spyderbyte client boundary; do not import Codex domain authority.
- Repeat branding, filesystem, telemetry, binary, dependency, and security checks whenever the source snapshot or shell boundary changes.

