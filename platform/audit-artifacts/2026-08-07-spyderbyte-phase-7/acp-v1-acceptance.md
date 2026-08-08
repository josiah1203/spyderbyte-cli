# Spyderbyte Phase 7 — ACP v1 local acceptance

Date: 2026-08-07

## Approved boundary

- ACP v1 stable.
- Official [`@agentclientprotocol/sdk`](https://agentclientprotocol.com/libraries/typescript).
- JSON-RPC/NDJSON over stdio, matching the ACP v1 transport contract.
- Representative protocol fixtures for Zed, JetBrains, and an internal deterministic client.

The ACP specification defines `initialize`, `session/new`, `session/prompt`, `session/update`, and
`session/cancel` as the core lifecycle, and requires newline-delimited JSON for stdio. Spyderbyte
keeps policy, AgentSession persistence, Run creation, event replay, and cancellation in its existing
local control plane.

## Evidence

1. `pnpm --filter @agentic-platform/agent-transport typecheck` — pass.
2. `pnpm --filter @agentic-platform/agent-transport test` — 5/5 pass:
   - Zed-shaped client metadata and ACP initialize/session/prompt flow;
   - JetBrains-shaped client metadata and the same flow;
   - internal fixture;
   - `session/cancel` to the shared Run;
   - actual NDJSON/stdio stream.
3. `pnpm --filter @agentic-platform/tui typecheck` — pass.
4. `pnpm --filter @agentic-platform/tui build` — pass, including the agent-transport package and
   Rust presentation host.
5. Focused loopback smoke against `createLocalDaemonServer` and `SpyderbyteClient` — pass. The
   observed ACP updates were:

   ```text
   user_message_chunk → plan → agent_message_chunk → plan
   ```

   The request was submitted with `sourceInterface: 'acp'` and completed through the existing
   local AgentSession/Run/event path.

6. `git diff --check` — pass.

## Scope note

Live Zed and JetBrains binaries were not installed in this environment. Their compatibility is
represented at the protocol level by the official SDK and client metadata fixtures; certified live
client and hosted-agent deployment evidence remains outside this local Phase 7 completion.

The broader TUI suite still contains one unrelated pre-existing artifact-export assertion that
expects `QUJD` while the fixture writes `ABC`; the focused ACP checks are green.
