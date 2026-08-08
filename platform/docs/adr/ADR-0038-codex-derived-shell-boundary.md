# ADR-0038: Codex-derived shell boundary

Status: Accepted; migration boundary and live shell bridge implemented for the supplied snapshot

Date: 2026-08-07

## Context

The new Spyderbyte requirements call for a mature conversation-first terminal shell with streaming,
composition, markdown, scrolling, approvals, diffs, progress, and cross-platform terminal behavior.
The available Codex checkout provides those mechanics, but it also contains an OpenAI/Codex agent,
account, model, tool, cloud, telemetry, configuration, persistence, and update architecture that
must not become Spyderbyte authority.

The current repository already contains a TypeScript line-oriented `spyderbyte` CLI, a local daemon,
typed REST/SSE clients, provider/runtime adapters, durable Runs, and a Cline compatibility adapter.
Those domain and execution boundaries must survive the shell migration.

## Decision

1. The Codex checkout is an upstream source reference, not an application dependency. The complete
   file-level inventory and SHA-256 manifest are maintained in `CODEX_MIGRATION_MATRIX.md`.
2. Only product-neutral terminal infrastructure may be retained: terminal lifecycle, input and
   multiline composition, markdown/code rendering, scrolling, resize, progress/output
   presentation, approval presentation primitives, diff rendering, and compatible packaging
   mechanics.
3. Codex agent orchestration, account/authentication, ChatGPT/OpenAI product behavior, model
   routing, tool registry authority, cloud tasks, thread/rollout persistence, telemetry endpoints,
   Codex configuration paths, update endpoints, and billing behavior are replaced or removed.
4. Approved upstream files will live under `vendor/codex-derived/` or an explicitly approved shell
   crate. They may not be imported by `packages/runtime-contracts`, `packages/policy`,
   `packages/state`, `packages/provider-runtime`, `packages/local-api`, or other Spyderbyte domain
   packages.
5. The rich terminal shell will be hosted by a separate Rust crate/application, provisionally
   `apps/spyderbyte-shell`, because the audited Codex TUI is Rust/Ratatui-based. It will own terminal
   rendering and user input only.
6. The canonical packaged command remains `spyderbyte`. The existing TypeScript `apps/tui` command
   surface is transitional and will become the headless Spyderbyte CLI/client implementation or be
   retired after command parity; it will not create a second primary product command.
7. The shell communicates with Spyderbyte through typed `AgentClient`, `ProjectClient`, `RunClient`,
   `ArtifactClient`, `ProviderClient`, `RuntimeClient`, `ApprovalClient`, and `UsageClient` APIs.
   It does not link directly to provider adapters, state stores, policy implementations, or the
   Cline runtime. The Rust presentation host receives those typed results from the TypeScript
   launcher over an authenticated loopback bridge.
8. TUI, CLI, ACP, API, web, Jupyter, and automation attach to the same `AgentSession` and produce
   the same universal Spyderbyte `Run` records. The shell is replaceable without rewriting the
   platform.
9. The build combines the existing pnpm/TypeScript verification graph with Cargo checks for the
   shell and a provenance/license check for the audited upstream snapshot. The exact workspace
   wiring does not require importing the Codex workspace wholesale.

## Alternatives considered

### Rebrand the entire Codex repository

Rejected. It would leave Codex agent semantics, account assumptions, tool authority, cloud behavior,
and persistence underneath a Spyderbyte skin, directly violating the product and architecture PRDs.

### Keep the current readline CLI as the final TUI

Rejected as the final target. It remains valuable as a transitional headless command client, but it
does not provide the required rich shell interaction primitives or adaptive task renderers.

### Implement a new TUI from scratch

Rejected for the initial migration. Terminal lifecycle, composition, streaming, scrollback,
approval dialogs, and resize behavior are not Spyderbyte differentiation and are already mature in
the upstream shell substrate.

### Let the Codex app-server protocol become Spyderbyte ACP

Rejected. ACP is a Spyderbyte interface adapter. It must map into Spyderbyte AgentSession, policy,
permissions, Runs, events, artifacts, usage, and audit rather than importing Codex app-server domain
semantics.

## Consequences

Positive:

- Spyderbyte gets a mature terminal shell without inheriting a second agent or execution model.
- The shell can be replaced independently of the backend and future ACP/API clients.
- Existing local daemon, client SDK, approval, Run, artifact, and provider work remains reusable.
- Legal provenance and upstream synchronization become explicit and reviewable.

Costs and risks:

- A Rust shell boundary must be integrated with the TypeScript monorepo and release packaging.
- Transitional command parity may require both a rich shell host and a headless client implementation.
- Upstream source files, Ratatui dependencies, and cross-platform process behavior require separate
  license, dependency, security, and release review.
- User-facing Codex/OpenAI compatibility references must be classified and either deliberately
  retained behind neutral provider contracts or removed.

## Migration implications

- Phase 0 completed the matrix, provenance file, license/dependency/security/branding audit, and
  this ADR without importing Codex source.
- Phase 1 completed the branded shell boundary and reimplemented the approved terminal mechanics
  without copying upstream files.
- Phase 2 moved shell calls behind typed Spyderbyte clients and SSE cursor/reconnect handling.
- Phase 3 attaches the shell to `AgentSession` through the TypeScript client launcher; the same
  universal Run stream drives CLI and rich-shell output.
- Phase 4 remains the broader cross-interface parity and hosted-runtime proof beyond the local
  migration boundary.
- No Codex source may be added to a domain package as a shortcut.

## Security impact

The shell is untrusted presentation code. It cannot grant permissions, read raw secrets, select
providers or runtimes outside backend responses, bypass workspace boundaries, or claim execution
success without an authoritative Run/result. Reused process or sandbox primitives require separate
security review for analytical workloads, network policy, filesystem scope, and secret forwarding.

## Observability impact

Shell events carry Spyderbyte correlation IDs, project/session/Run IDs, interface identity, and
typed error/usage information. Upstream telemetry and identifiers are not retained. Local-only mode
must remain functional with telemetry disabled.

## Rollback or revisit trigger

Revisit this ADR if the upstream license/provenance cannot be verified, the shell cannot be isolated
from Codex domain dependencies, the Rust boundary cannot meet supported distribution targets, or a
future product decision selects a different shell substrate. Rollback removes the imported shell
crate and returns the transitional CLI as the supported command surface without changing the
Spyderbyte backend contracts.
