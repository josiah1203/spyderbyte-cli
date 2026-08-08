# Rich shell bridge smoke evidence

**Date:** 2026-08-07  
**Boundary:** `apps/tui` TypeScript launcher ↔ `apps/spyderbyte-shell` Rust presentation host

The rich shell now connects to an authenticated loopback bridge owned by the TypeScript launcher.
The launcher owns `SpyderbyteClient`, `AgentSession`, `Run`, SSE cursor replay/reconnect, and
cancellation. The Rust process owns terminal input/rendering and does not link to provider, policy,
state, or Codex runtime code.

## Evidence

- `pnpm --filter @agentic-platform/spyderbyte-shell test`: 11/11 passed.
- `pnpm --filter @agentic-platform/tui test`: 7 tests passed, including hex-framed multiline
  bridge round-trip coverage.
- `pnpm --filter @agentic-platform/tui build`: passed.
- A real temporary loopback smoke authenticated the Rust child with `HELLO`, delivered `CONTEXT`,
  `CONNECTION`, `PLAN`, `STATUS`, and Unicode `DELTA` frames, received `SUBMIT=hello`, and exited
  with code 0. Assertions for `connection: connected` and `bridge output ✓` passed.
- The bridge path uses the same SDK `sendMessage(..., 'tui')` and `followRun` subscription/replay
  path as the transitional CLI; output logs map to assistant deltas and terminal Run states map to
  shell status events.

No Codex source or Codex domain authority is imported by the bridge.
