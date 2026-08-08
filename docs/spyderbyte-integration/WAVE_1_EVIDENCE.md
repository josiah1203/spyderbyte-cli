# Wave 1 — Compose Without Coupling

**Status:** Complete locally; PR publication deferred by owner

**Branch:** `codex/wave-1-compose`

**Kimi parent:** `a6845ca6` (`codex/wave-0-freeze`)

**Imported platform source:** `2579ce2b195ba394509f7b4ded6cc6dbcddbfebe`

Wave 1 composes the two source trees while preserving independent authority and build boundaries.
No real backend transport is wired in this wave; the Python shell runs against a deterministic,
typed frontend mock.

## Repository composition

- The platform history was imported under `platform/` with `git subtree add`, producing commit
  `bb866c3b` and retaining the source commit as the subtree parent.
- The Kimi repository remains at the root, preserving its existing UI and PTY implementation.
- Root Make targets and split GitHub Actions jobs verify provenance, Python seams, and the
  imported platform independently.
- `platform verify:composed` excludes only the historical Codex migration audit that requires an
  external workstation checkout. It retains contract generation checks, release controls,
  container and tracked-artifact checks, formatting, lint, boundaries, type checking, unit tests,
  invariant tests, and all builds.

## Frontend boundary and visual preservation

- `spyderbyte_cli.frontend` defines schema-versioned `FrontendSession`, capability,
  prompt-acceptance, and event DTOs plus a `FrontendClient` protocol.
- Versioned JSON Schema and fixtures live under `contracts/frontend/v1` and are checked against
  the Python models.
- `spyderbyte --mock` renders a complete deterministic turn through the Kimi console primitive,
  while all text, IDs, state, and product authority come from Spyderbyte DTOs.
- Ten selected upstream Kimi UI/PTY tests are protected by a SHA-256 manifest. Boundary tests
  prohibit Kimi product-authority imports and permit only Kimi UI imports or the isolated
  transitional adapter package.

## Approved inherited primitives

The `spyderbyte_cli.adapters.kimi` package implements only Spyderbyte-owned ports:

- recency-based context selection with protected-item enforcement;
- bounded extractive compaction with source traceability; and
- atomic, deterministic, disposable JSON checkpoint caching.

Provider transport, tool implementation, local process runtime, background execution, and cache
interfaces exist only as ports. No Kimi Soul, provider authority, sessions, approvals, durable
history, or tool registry is connected.

## Daemon composition

`DaemonManager` discovers the local health endpoint and can start the imported
`@agentic-platform/local-daemon` in a project-local `.spyderbyte/workspace`. Real HTTP/SSE client
wiring remains a Wave 2 contract-and-transport task.

## Verification

| Scope | Command | Result |
| --- | --- | --- |
| Python contracts, lint, format, types, boundaries, adapters, daemon, and retained UI | `UV_CACHE_DIR=/tmp/spyderbyte-uv-cache make verify-wave-1` | Pass: 15 tests; zero Ruff or Pyright findings; frontend schema and Wave 0 provenance current |
| Python distribution | `UV_CACHE_DIR=/tmp/spyderbyte-uv-cache uv build --package kimi-cli --no-sources` | Pass: sdist and wheel include `spyderbyte_cli` and the `spyderbyte` entrypoint |
| Retained Kimi source | `UV_CACHE_DIR=/tmp/spyderbyte-uv-cache make check-kimi-cli` | Pass: Ruff, formatting, and Pyright clean; inherited `ty` diagnostics remain non-blocking by upstream design |
| Mock structured and visual shell | `uv run spyderbyte --mock --prompt 'Verify Wave 1' --json` and the visual equivalent | Pass: session, accepted Run, resumable events, assistant delta, and terminal success rendered |
| Imported platform | `pnpm --dir platform verify:composed` | Pass: contracts, 33-package boundaries/lint, 55 type/build tasks, package tests, invariant tests, 33 builds, local-daemon sidecar, and macOS `Spyderbyte.app` bundle |
| Source hygiene | `git diff --check` | Pass |

The first platform run exposed two clean-checkout defects and Wave 1 corrected them: Turbo now
builds dependency declarations before consumer typechecks, and desktop typechecking disables the
release-only external sidecar requirement. The release build still creates and bundles the real
sidecar.

## Exit decision

Wave 1 satisfies its exit gate: both projects build and test independently in one repository, the
shell runs against a typed mock frontend session, the Kimi visual foundation is retained, and no
untyped bridge or Kimi backend authority has been introduced. At the Wave 1 boundary, Waves 2–7
were still planned; Wave 2 completion is recorded separately in `WAVE_2_EVIDENCE.md`.
