# Spyderbyte Unified Implementation Plan

**Status:** Sole authoritative implementation and progress plan
**Version:** 2.1
**Date:** 2026-08-07
**Integration repository:** `github.com/josiah1203/spyderbyte-cli`
**Local platform source:** `/Users/josiah/aug`
**Canonical executable:** `spyderbyte`

This is the only active execution authority for Spyderbyte. It consolidates the product/backend
invariants, the implemented local-platform baseline, the Kimi CLI integration, the inherited-code
audit, the parallel delivery program, and the remaining hosted, commercial, enterprise, security,
and release work.

The following documents are historical evidence, not active plans:

- [`SPYDERBYTE_DECLARATIVE_IMPLEMENTATION_PLAN.md`](SPYDERBYTE_DECLARATIVE_IMPLEMENTATION_PLAN.md);
- [`SPYDERBYTE_PRODUCTION_IMPLEMENTATION_PLAN.md`](SPYDERBYTE_PRODUCTION_IMPLEMENTATION_PLAN.md);
- [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md); and
- [`AGENTIC_PLATFORM_IMPLEMENTATION_PLAYBOOK.md`](AGENTIC_PLATFORM_IMPLEMENTATION_PLAYBOOK.md).

If a historical document conflicts with this file, this file wins unless a newer accepted ADR
explicitly changes the decision. New phases, status changes, completion evidence, sequencing, and
next actions must be recorded here only.

The integration uses a subsumption policy, not a renderer-only rewrite. Mature Kimi implementation
primitives may remain when they operate under Spyderbyte interfaces and pass explicit conformance,
security, replacement, licensing, and operations gates. Product authority moves to Spyderbyte.

## 0. Plan authority and execution rules

Every implementation change must follow these rules:

1. Read this plan and select the first incomplete work package whose prerequisites are satisfied.
2. Inspect the current source and preserve unrelated user changes.
3. Treat Spyderbyte runtime contracts and authoritative backend services as domain truth; clients
   and inherited adapters may request, project, and implement bounded mechanics but may not decide
   policy or durable state.
4. Deliver the smallest complete vertical increment: contract, implementation, migration,
   tests, operational evidence, and plan status update together.
5. Do not compose the source histories until Wave 0 provenance, licensing, repository-layout, and
   import-method gates are approved.
6. Do not mark work complete when it is simulated, projection-only, unverified, or blocked by an
   unresolved security, licensing, product, topology, commercial, credential, or release gate.
7. Preserve authority, approval, audit, artifact immutability, lineage, secret isolation, budget,
   cancellation, idempotency, recovery, and tenant/workspace boundaries.
8. Stop at the explicit human decision gates in Section 13.
9. Prepare every completed wave as its own reviewable branch and commit set with exit evidence.
   Open a draft pull request unless the owner explicitly defers publication. On 2026-08-08 the
   owner deferred PR publication and authorized local continuation; wave boundaries and evidence
   remain mandatory so the branches can be published later without reconstructed scope.

Status vocabulary:

| Status          | Meaning                                                                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Complete**    | The stated scope has implementation and passing evidence. Local-only completion is labeled when hosted, signed-release, or customer-infrastructure proof remains. |
| **In progress** | Some implementation/evidence exists, but the exit gate is not satisfied.                                                                                          |
| **Planned**     | Requirements and approach are recorded; implementation has not started.                                                                                           |
| **Deferred**    | Intentionally sequenced later and not represented as partial completion.                                                                                          |
| **Blocked**     | A required decision, credential, source artifact, or environment is unavailable.                                                                                  |
| **Rejected**    | Explicitly excluded or replaced by another boundary.                                                                                                              |

## 1. Outcome

Deliver one Spyderbyte product in which:

- the Spyderbyte terminal shell, derived in part from Kimi CLI, supplies polished input,
  rendering, keyboard interaction, terminal layout, print mode, and ACP transport mechanics;
- selected Kimi-derived context, compaction, retry, streaming, provider-transport, tool,
  process, checkpoint, and background-task primitives may be retained behind Spyderbyte-owned
  adapters when they pass conformance, security, licensing, and operational gates;
- the existing Spyderbyte backend owns projects, conversations, AgentSessions, Runs, retries,
  providers, runtimes, tools, policy, approvals, budgets, artifacts, lineage, usage, audit, and
  durable state;
- interactive TUI, noninteractive CLI, ACP, web, desktop, and future clients use the same
  Spyderbyte contracts and execution path;
- local-only individual use remains account-optional and works with local models or BYOK;
- Spyderbyte Cloud and organizational features extend the same contracts rather than creating a
  second agent or execution model; and
- Apache-2.0 attribution, Kimi/Moonshot notices, source provenance, and modified-file notices are
  preserved while user-facing Kimi branding and Kimi-specific product assumptions are removed.

The governing rule is:

```text
SPYDERBYTE TERMINAL SHELL
(derived in part from Kimi CLI)
          |
          v
Spyderbyte Frontend DTOs
          |
          v
Spyderbyte Client API
          |
          v
SPYDERBYTE DOMAIN
AgentSession | Universal Runs | Policy | Approvals | Resources
          |
          v
Spyderbyte Adapter Boundary
     /                 |                    \
ContextCompactor  LocalProcessRuntime  ProviderTransport
(Kimi-derived)    (Kimi/KAOS-derived)  (Kosong-derived)
```

The UI and frontend DTOs remain above the client/domain trust boundary. Inherited runtime
primitives remain below the authoritative domain, behind replaceable Spyderbyte adapters. They
may implement mechanics but may not become a second orchestration or product layer.

It must never become:

```text
Kimi Soul executes work -> Spyderbyte mirrors the result
```

or:

```text
TUI executes tools directly -> backend records a synthetic Run afterward
```

## 2. Reconciled source baseline

### 2.1 Local Spyderbyte platform

The local platform is a separate TypeScript/Rust monorepo. It is not present in the connected
GitHub repository.

- Current local commit: `2579ce2b195ba394509f7b4ded6cc6dbcddbfebe`.
- Prior snapshot commit: `8d8c296`.
- The working tree was clean at review time.
- The repository contains approximately 753 tracked files and the complete local platform,
  including contracts, state, policy, agent transport, local API, daemon, worker, sandbox,
  current TUI/shell references, web, desktop, tests, release scripts, and audit evidence.
- `origin` was repointed to `josiah1203/spyderbyte-cli`, but the local
  `refs/remotes/origin/main` still names the old local commit. That remote-tracking ref is stale
  and must not be used as evidence of the GitHub repository state.

The local platform already implements, for its documented local scope:

- versioned runtime/domain contracts and Universal Runs;
- SQLite/Postgres/in-memory state, events, outbox, recovery, and projections;
- AgentSession, conversation, event, permission, and response records;
- local API, resumable event streaming, typed TypeScript client, and daemon lifecycle;
- provider/model and compute/runtime separation;
- policy, approvals, authority, budget, usage, audit, and break-glass controls;
- artifacts, versions, lineage, notebooks, data/SQL, visualization, experiments, serving,
  pipelines, automations, connectors, and workspace intake;
- ACP v1 transport, organization/governance contracts, enterprise/government adapter contracts;
  and
- local release/update/recovery guardrails.

These are implementation assets, not proof that the integrated Kimi-based product or hosted
release is complete.

### 2.2 Connected Kimi fork

The connected repository is a separate Kimi CLI history and contains none of the local platform.

- Repository: `josiah1203/spyderbyte-cli`.
- Reviewed GitHub `main`: `cbc15c076d17f70fec9f89c90c0502e68657f505`.
- Upstream identity at review time: Kimi CLI `1.49.0`, Python `>=3.12`, Apache-2.0.
- Primary entrypoints: `src/kimi_cli/cli`, `src/kimi_cli/app.py`, and the `kimi`/`kimi-cli`
  console scripts.
- Reusable frontend assets: `src/kimi_cli/ui/shell`, `src/kimi_cli/ui/print`, terminal utilities,
  prompt handling, keyboard handling, display blocks, and selected wire/ACP transport mechanics.
- Kimi-owned product authorities that must not remain authoritative: `app.py` composition,
  Kimi session/provider/account configuration, local approval and auto-approval policy, local
  execution state, Kimi usage/cost truth, Kimi telemetry policy, and Kimi update/account behavior.
- Candidate implementation primitives requiring adapter-level audit: context packing and
  compaction, retry/streaming helpers, Kosong provider transports, selected tool implementations,
  KAOS process/filesystem mechanics, checkpoint serialization, approval presentation queues, and
  background worker mechanics.

### 2.3 Repository conclusion

The histories must not be joined by pushing `/Users/josiah/aug/main` to the Kimi fork or by a
blind unrelated-history merge. The Kimi fork is the integration repository. The local platform
must be imported deliberately, under an isolated prefix, with a provenance manifest and an
independent build boundary.

### 2.4 Current program status

**Overall status: In progress — local integration waves 0–6 complete; Wave 7 blocked on Section 13.**

- The local platform is imported under `platform/` with its source history preserved and a
  hermetic composed verification command.
- Waves 0 through 6 are complete locally for their executable scopes: provenance, composition,
  frontend contracts, transport, golden path, native resources, organizational interfaces, and
  Kimi product-authority removal on the Spyderbyte path.
- Wave 7 local release scaffolding and the blocked-gate checklist are recorded; hosted deployment,
  commercial decisions, credentialed environments, package rename, and signed publication remain
  Blocked on Section 13.
- No further terminal-integration wave is executable without owner decisions or credentials.

| Wave | Status | Evidence or next gate |
| ---- | ------ | --------------------- |
| 0 — Freeze and decide | Complete | Source tags, hashes, exhaustive classification, candidate decisions, baseline evidence, and owner gate recorded; PR deferred by owner |
| 1 — Compose without coupling | Complete | Platform subtree, typed frontend v1 seam, mock shell, adapter boundary, daemon launcher, retained visual tests, and independent verification recorded; PR deferred by owner |
| 2 — Contract and transport | Complete | Versioned DTOs, authenticated/retrying HTTP+SSE transport, deterministic projection, ACP mapping, adapter ports, daemon lifecycle, and mock reconnect evidence recorded; PR deferred by owner |
| 3 — Local golden path | Complete locally | Real daemon golden path, durable AgentSession/Run snapshots, provider/model/runtime facets, local ACP, and reproducible E2E evidence recorded in [`WAVE_3_EVIDENCE.md`](docs/spyderbyte-integration/WAVE_3_EVIDENCE.md); credentialed-provider and publication gates remain external |
| 4 — Computational parity | Complete locally | Typed native-resource matrix, headless `resource` command, visualization catalog, and daemon discover evidence recorded in [`WAVE_4_EVIDENCE.md`](docs/spyderbyte-integration/WAVE_4_EVIDENCE.md); rich-client handoff UX and hosted publication remain external |
| 5 — Organizational/hosted interfaces | Complete locally | Governance client/CLI, workspace facets, onboarding/license, ACP cancel, and command-parity matrix recorded in [`WAVE_5_EVIDENCE.md`](docs/spyderbyte-integration/WAVE_5_EVIDENCE.md); SSO/SCIM and signed cloud login remain external |
| 6 — Authority cutover | Complete locally | Spyderbyte path no longer composes KimiCLI/OAuth/update/usage authority; forbidden-import evidence in [`WAVE_6_EVIDENCE.md`](docs/spyderbyte-integration/WAVE_6_EVIDENCE.md); package rename and signed packaging remain Section 13 gated |
| 7 — Hosted/commercial/release | Blocked | Local scaffolding and gate checklist in [`WAVE_7_EVIDENCE.md`](docs/spyderbyte-integration/WAVE_7_EVIDENCE.md) / [`RELEASE_GATES.md`](docs/spyderbyte-integration/RELEASE_GATES.md); hosted/signing/commercial completion requires Section 13 decisions and credentials |

No historical “phase complete” statement may be interpreted as completion of the integrated Kimi
product or a hosted/credentialed release.

## 3. Non-negotiable architecture

### 3.1 Backend authority

The Spyderbyte backend is authoritative for:

- identity, organization, workspace, project, and role;
- session and conversation history;
- Agent requests, events, permission requests, and responses;
- Run/Attempt state, retry ownership, cancellation, logs, and terminal status;
- model provider, selected model, compute provider, runtime profile, and environment;
- tool availability, execution, sandbox, network, filesystem, and secret scopes;
- plans, estimates, policy decisions, approvals, and budget reservations;
- artifacts, versions, lineage, usage, billing facts, and audit; and
- local/hosted routing, reconnect cursors, recovery, and updates.

The frontend may own draft input, focus, layout, temporary selections, rendering caches, and
optimistic presentation only.

### 3.2 One session, one Run model, one approval model

- A TUI turn maps to one backend Agent request and one or more linked Universal Runs.
- Kimi `TurnBegin`, `StepBegin`, and tool display concepts are view events, not durable domain
  state.
- Kimi sessions must be replaced by backend project/AgentSession references plus a disposable
  local resume cache.
- Kimi approval futures must be fed by backend approval records; they cannot approve work locally.
- `--yes`, `--auto-approve`, AFK, or print mode must never bypass backend policy. Such flags may
  request a backend-approved policy mode, but the server remains authoritative.
- Shell commands, file mutations, tools, MCP calls, and background jobs must execute through the
  Spyderbyte tool/run boundary rather than Kimi's local KAOS/tool lifecycle.

Kimi interaction concepts may survive with Spyderbyte semantics:

- “allow once” records one bounded backend approval decision;
- “allow for session/project” requests a server-issued `ApprovalGrant` bound to principal,
  workspace/project, capability, resource/path/network constraints, expiration, authentication
  strength, use count, and revocation;
- AFK/auto-approve becomes an `AutonomyProfile` such as `supervised`, `trusted`, or `unattended`,
  constrained by cost, tools, paths, domains, runtimes, data classification, time, and expiration;
  and
- background/subagent work creates linked child AgentSessions, Runs, Attempts, usage, artifacts,
  lineage, and audit records rather than opaque local tasks.

### 3.3 Sidecar boundary

Use an HTTP plus resumable event-stream sidecar boundary between Python and the existing
TypeScript platform.

```text
Python terminal process
  - input, keyboard, rendering, print mode, ACP transport
  - typed Python Spyderbyte client
  - backend-event -> frontend-event projection
                 |
                 | loopback HTTP + SSE in local mode
                 | authenticated HTTPS + SSE in hosted mode
                 v
Spyderbyte local daemon or cloud gateway
  - client session and capabilities
  - projects and AgentSessions
  - conversations and Universal Runs
  - approvals, providers, runtimes, tools, artifacts, usage, audit
                 |
                 v
workers / inference / compute / object store / workflow backend
```

Do not import TypeScript into Python, Python UI code into the TypeScript domain packages, or
backend package internals into UI components.

### 3.4 Authority is not implementation

The integration must distinguish ownership of a product decision from the code used to implement
that decision.

```text
Spyderbyte owns the request, policy, state transition, IDs, and durable result.
An approved Kimi-derived adapter may perform bounded mechanics inside that request.
```

Examples:

- Spyderbyte selects authorized project resources; a Kimi-derived compactor may fit that approved
  context into a model window.
- Spyderbyte resolves provider configuration and a credential reference; a Kimi/Kosong-derived
  transport may perform the provider HTTP exchange.
- Spyderbyte ToolBroker authorizes and records `shell.execute`; a reviewed KAOS-derived adapter
  may implement the bounded local process operation.
- Spyderbyte creates a parent and child Run; reviewed Kimi background-worker mechanics may execute
  the child while Run state, cancellation, budget, and audit remain authoritative.
- Spyderbyte creates and validates an approval grant; the Kimi approval panel and queue mechanics
  may collect and render the user's response.

No inherited primitive may independently resolve or persist raw credentials, select policy,
allocate authority, create a parallel durable session, calculate authoritative cost, or commit an
execution result except through its Spyderbyte adapter contract. When transport mechanics must
consume credential material, the Spyderbyte broker injects a short-lived scoped value at the final
execution boundary, and redaction/logging rules remain enforced outside the inherited code.

### 3.5 Kimi implementation audit

The reviewed Kimi fork contains meaningful reusable mechanics; deleting everything outside the UI
would discard tested engineering. The audit does not automatically approve these components for
production. It classifies them for extraction and conformance work.

| Candidate                  | Audit finding                                                                                                                                                                 | Planned treatment                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context/checkpoints        | Append-only JSONL, tolerant restore, token accounting, checkpoint/revert, and file rotation are tested, but coupled to Kimi/Kosong messages and local session files.          | Extract algorithms and cache/checkpoint mechanics behind a Spyderbyte `ContextWindowManager`; backend project history remains truth.                                   |
| Compaction                 | Has explicit threshold logic, preserved-message behavior, summary generation, token estimates, and focused tests.                                                             | Strong adoption candidate behind a Spyderbyte compaction interface, using only policy-filtered context and metered provider calls.                                     |
| Agent-loop retry/streaming | Mature step/retry/steer/turn balancing and streaming tests exist, but current loop owns Kimi context, tools, and provider calls.                                              | Extract bounded loop utilities or implement a Kimi-derived `AgentRuntimeAdapter`; Spyderbyte AgentSession and Run orchestration own lifecycle.                         |
| Kosong provider transports | Provider-neutral message/tool abstractions and OpenAI/Anthropic/Google transport tests and snapshots exist.                                                                   | Retain selectively behind `ProviderAdapter`; Spyderbyte registry, credentials, model policy, usage, and routing remain authoritative.                                  |
| Shell/file/MCP/web tools   | Useful, tested implementations exist. Current tool objects can execute directly and use Kimi approval/context.                                                                | Port selected implementations behind ToolBroker capabilities; reject any adapter that cannot satisfy sandbox, grant, path, network, cancellation, and audit contracts. |
| KAOS process/filesystem    | Tested local and SSH mechanics may reduce process/remote execution work. It is not by itself the Spyderbyte sandbox or policy boundary.                                       | Evaluate as a `LocalRuntime`/remote runtime implementation beneath Spyderbyte execution limits and sandbox enforcement.                                                |
| Approval runtime           | Queueing, request projection, feedback, and UI behavior are reusable; local `yolo`, AFK, and session-cache decisions are not enterprise authority.                            | Keep presentation/request mechanics; translate “allow once/session/project” into server-issued, constrained Spyderbyte decisions or grants.                            |
| Session serialization      | Atomic state files, metadata migration, wire logs, and crash-tolerant restore are useful. The entity model is too narrow for Organization/Workspace/Project/AgentSession/Run. | Reuse only for disposable UI cache, offline envelope, import tooling, or crash checkpoint; reconcile against backend snapshots.                                        |
| Background agents/tasks    | Manager, worker, timeout, persistence, and resume tests are useful, but local background state is currently its own authority.                                                | Adopt only after mapping parent/child AgentSessions and Runs, budget, cancellation, lineage, and audit.                                                                |
| Cost/usage signals         | Token/provider usage emitted by Kimi/Kosong can improve measurement.                                                                                                          | Treat as metering input; the Spyderbyte usage ledger validates and reconciles authoritative usage/cost.                                                                |

Inherited code is grouped into three classes:

1. **UI primitives — adopt aggressively:** rendering, prompt composer, streaming visuals,
   progress/approval/diff cards, keyboard behavior, and terminal utilities.
2. **Runtime primitives — wrap and adopt selectively:** context/compaction, retry, streaming,
   provider transports, tools, process handling, MCP, checkpoints, and background workers.
3. **Product authority — replace:** durable sessions, provider configuration, credentials, policy,
   approval authority, model/runtime selection policy, cost ledger, execution state, organization
   state, telemetry consent, account identity, and updates.

### 3.6 Computational and ML capability preservation

Spyderbyte is a computational and ML platform with an agent interface, not a coding-agent shell
with data features bolted on. The integration must preserve first-class domain behavior for:

- datasets, profiling, SQL, transforms, joins, and materialized data products;
- notebooks, kernels, cells, execution state, publication, and Jupyter handoff;
- visualizations and their editable specifications, data bindings, and exported artifacts;
- experiments, training Runs, evaluations, comparisons, metrics, and model registration;
- model versions, registry state, deployment/serving resources, and operational status;
- pipelines, schedules, automations, connectors, and workspace intake;
- local, remote, and managed compute/runtime selection; and
- immutable artifacts, versions, lineage, provenance, usage, and audit.

These capabilities must not be reduced to a generic shell/file/web/MCP tool vocabulary. A native
Spyderbyte resource or Run type is mandatory whenever the domain has a first-class representation.
Generic tools are an explicit escape hatch only when no native capability exists or when a user
deliberately selects the lower-level route. Any fallback must record its provenance, limitations,
policy decision, Run, outputs, and lineage; it must never manufacture native state by scraping
opaque terminal output.

The terminal is a compact client, not the only renderer. It must show resource identity, status,
summary, metrics, lineage, and available actions, then offer a rich-client handoff to the
Spyderbyte web app, desktop app, Jupyter, or another approved client over the same backend resource
ID. A handoff must not create a parallel notebook, visualization, Run, or artifact history.

### 3.7 Native-resource preference and capability vocabulary

The Agent is a consumer of Spyderbyte capabilities. It may use low-level system primitives, but
those primitives are not the complete capability vocabulary and cannot shadow a richer domain
operation.

| User intent      | Required native route               | Generic fallback that must not be the default |
| ---------------- | ----------------------------------- | --------------------------------------------- |
| Query Postgres   | SQL Run                             | shell `psql`                                  |
| Run a notebook   | Notebook Run                        | shell `jupyter`                               |
| Train a model    | Training or Experiment Run          | generic Python process                        |
| Create a chart   | `VisualizationResource`             | Python-generated image                        |
| Execute pipeline | Pipeline Run                        | shell script                                  |
| Deploy a model   | `DeploymentResource` or Serving Run | shell deployment command                      |
| Sync Shopify     | Connector Run                       | custom script                                 |
| Schedule work    | Automation                          | operating-system cron                         |

The minimum first-class capability vocabulary is:

- **Data:** profile, query, transform, join, materialize, and inspect;
- **Notebook:** create, execute, resume, inspect, and publish;
- **Experiment:** create, train, evaluate, compare, and register;
- **Visualization:** create, modify, inspect, publish, and export;
- **Pipeline:** run, resume, schedule, inspect, and cancel;
- **Artifact:** inspect, compare, trace lineage, reuse, and export; and
- **System:** shell, file, web, MCP, process, and other bounded implementation primitives.

During migration, `spyderbyte_cli.adapters.kimi` and “Kimi-derived” are acceptable provenance
labels. They are transitional implementation names, not the final product model. Once boundaries
stabilize, approved adapters should use capability names such as `OpenAICompatibleTransport`,
`LocalProcessRuntime`, `ContextCompactor`, and `CheckpointCache`. Source headers, NOTICE files,
and provenance manifests must continue to preserve Kimi, Moonshot, Kosong, and KAOS attribution.

## 4. Canonical integration-repository layout

The first composition PR should establish this shape without reorganizing either source tree more
than necessary:

```text
spyderbyte-cli/
├── pyproject.toml                 # Python shell package and spyderbyte entrypoint
├── src/
│   ├── kimi_cli/                  # temporary upstream-compatible namespace during migration
│   └── spyderbyte_cli/            # Spyderbyte composition, client, events, commands
├── platform/                      # imported local TypeScript/Rust monorepo
│   ├── package.json
│   ├── pnpm-workspace.yaml
│   ├── apps/
│   ├── packages/
│   ├── scripts/
│   └── docs/
├── tests/
│   ├── upstream_ui/               # retained Kimi shell regression tests
│   ├── spyderbyte_contract/
│   └── spyderbyte_e2e/
├── docs/
│   ├── architecture/
│   ├── integration/
│   └── provenance/
├── third_party/
│   └── README.md                  # attribution/provenance index, not vendored duplicates
├── Makefile                       # orchestration across uv and pnpm
└── .github/workflows/             # split Python, platform, contract, and packaged E2E jobs
```

Import policy:

1. Create an immutable local source tag or bundle for `2579ce2` before composition.
2. Record the Kimi source commit, local platform commit, licenses, NOTICE digests, import date,
   and import method in `docs/provenance/source-manifest.json` and a human-readable audit.
3. Import the local tree under `platform/` using a reviewed subtree/snapshot commit. Do not
   overlay its root `apps`, `packages`, lockfiles, or GitHub workflows onto Kimi's root.
4. Preserve the two source baselines in separate tags or bundles. Decide explicitly whether the
   GitHub history keeps the local two-commit history or a signed snapshot plus source bundle.
5. Add `upstream-kimi` as a read-only source remote in integration checkouts. Future upstream
   changes are patch-ported through an inventory, not blindly merged across renamed product code.
6. Keep Python and platform lockfiles independent. Root orchestration may call both ecosystems but
   must not synthesize a single dependency graph.

## 5. Kimi source migration matrix

| Kimi area                                                        | Initial action                                                                    | End state                                                                                                                                               |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/kimi_cli/ui/shell/**`                                       | Preserve and wrap                                                                 | Spyderbyte-branded terminal interaction and renderers consuming Spyderbyte frontend events.                                                             |
| `src/kimi_cli/ui/print/**`                                       | Preserve and adapt                                                                | Noninteractive Spyderbyte output, stable JSON mode, correct exit codes.                                                                                 |
| `src/kimi_cli/ui/theme.py`, terminal/rich utilities              | Preserve with attribution                                                         | Shared Spyderbyte terminal presentation primitives.                                                                                                     |
| `src/kimi_cli/wire/**`                                           | Use as a temporary compatibility seam                                             | Replace Kosong/tool imports with Spyderbyte-owned frontend event DTOs and transport-neutral envelopes.                                                  |
| `src/kimi_cli/acp/**`                                            | Preserve protocol/transport mechanics only                                        | `spyderbyte acp` maps ACP sessions and permissions to the same Spyderbyte client and AgentSession path as TUI.                                          |
| `src/kimi_cli/cli/**`                                            | Rewrite composition and commands incrementally                                    | `spyderbyte` command tree, Spyderbyte config, local daemon discovery, headless parity.                                                                  |
| `src/kimi_cli/app.py`                                            | Replace as composition root                                                       | `SpyderbyteCLI` bootstraps a Spyderbyte frontend session; no provider or Soul construction.                                                             |
| `src/kimi_cli/session.py`, `session_state.py`, `session_fork.py` | Replace durable semantics; retain reviewed serialization/checkpoint helpers       | Backend project/AgentSession is durable; local files are disposable caches, offline envelopes, or import/checkpoint mechanics.                          |
| `src/kimi_cli/soul/context.py`, `compaction.py`                  | Extract and conform approved context-window mechanics                             | Spyderbyte selects authorized context and owns history; Kimi-derived utilities may budget, compact, summarize, and checkpoint it.                       |
| `src/kimi_cli/soul/kimisoul.py` and retry/streaming helpers      | Decompose behind an `AgentRuntimeAdapter`; do not retain the monolithic authority | Approved planning/retry/streaming mechanics run inside Spyderbyte AgentSession and Universal Run orchestration.                                         |
| `src/kimi_cli/llm.py`, `packages/kosong/**`                      | Audit transports separately from Kimi configuration and model policy              | Approved provider transports may remain behind Spyderbyte `ProviderAdapter`; registry, credentials, routing, metering, and policy are Spyderbyte-owned. |
| `src/kimi_cli/tools/**`, `packages/kaos/**`                      | Remove direct production execution; port selected implementations behind adapters | ToolBroker, policy, sandbox, approval, and Run contracts authorize every operation; reviewed Kimi/KAOS mechanics may implement bounded operations.      |
| `src/kimi_cli/approval_runtime/**`                               | Retain presentation/queue mechanics; replace local decision semantics             | Backend approval IDs/state and constrained grants are authoritative; frontend submits decisions and observes committed results.                         |
| `src/kimi_cli/auth/**`                                           | Remove Kimi account/OAuth assumptions                                             | Optional Spyderbyte Cloud identity plus account-free local mode and backend-managed provider credentials.                                               |
| `src/kimi_cli/background/**`                                     | Audit worker/timeout/resume mechanics and convert state to Run projections        | Approved mechanics execute parent/child Runs; no local Kimi background store owns durable state, budget, cancellation, or audit.                        |
| `src/kimi_cli/telemetry/**`                                      | Replace                                                                           | Spyderbyte consent, redaction, product metrics, audit, and OpenTelemetry boundary.                                                                      |
| `src/kimi_cli/web/**`, `vis/**`, `web/**`                        | Defer/remove unless a renderer is explicitly reused                               | Existing Spyderbyte web/desktop remains the rich artifact/admin surface. Avoid a second web product.                                                    |
| `src/kimi_cli/plugin/**`, skills, hooks, MCP                     | Retain useful discovery/protocol mechanics through backend capability/tool policy | Client discovery and display may remain; invocation, credentials, execution, grants, and authorization are backend-owned.                               |
| root installers, PyInstaller spec, release workflows             | Adapt after vertical slice                                                        | Spyderbyte package/binary, sidecar bundle, notices, signatures, channels, update/rollback.                                                              |
| Kimi docs, branding, endpoints, migration nudges                 | Replace user-facing content; retain legal attribution                             | Spyderbyte docs and no Kimi/Moonshot endorsement implication.                                                                                           |

## 6. Local platform import matrix

| Local area                                                              | Integration role                                                                                           |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `packages/runtime-contracts`                                            | Domain/schema authority; produce language-neutral client artifacts.                                        |
| `packages/client-sdk`                                                   | Reference implementation and contract oracle for the Python client.                                        |
| `packages/agent-transport`                                              | AgentSession/ACP semantic oracle; do not package a competing ACP path after cutover.                       |
| `packages/state`, `runtime-domain`, `projections`                       | Durable local/hosted state, events, Run lifecycle, replay, and recovery.                                   |
| `packages/policy`, `budget`, `tool-broker`                              | Only authority for permission, approval, spend, and effectful tools.                                       |
| `packages/provider-runtime`, `backends`, `harness-core`, `orchestrator` | Provider-neutral inference/compute and product execution.                                                  |
| `packages/artifact-registry`, `workspace`, `tasks`, `specialists`       | Artifacts, workspace context, tasks, and specialist behavior.                                              |
| `packages/local-api`                                                    | Stabilize as the Python client's local/hosted-compatible API surface.                                      |
| `apps/local-daemon`                                                     | Local sidecar lifecycle and composition root.                                                              |
| `apps/worker`, `apps/sandbox-runner`                                    | Local/hosted execution workers; never invoked directly by the shell.                                       |
| `apps/tui`                                                              | Contract/command-parity oracle during migration; retire from product distribution after Kimi shell parity. |
| `apps/spyderbyte-shell`                                                 | Prior shell experiment and test evidence; not the final frontend.                                          |
| `apps/web`, `apps/desktop`                                              | Preserve as rich artifact, administration, onboarding, and desktop distribution surfaces.                  |
| `scripts/release`, `scripts/verify`, operations/audit docs              | Adapt to the composed repo and new Python-plus-sidecar artifact.                                           |

## 7. Required client and event contracts

### 7.1 Python client boundary

Create a typed asynchronous Python package under `src/spyderbyte_cli/client/` with these facets:

- `session`: health, capabilities, local/cloud authentication, workspace and actor;
- `projects`: list/create/open/inspect/export;
- `agent`: read AgentSession, read conversation snapshot, send prompt, cancel, steer, resume;
- `runs`: list/inspect/logs/follow/cancel/retry;
- `events`: cursor-based subscription, reconnect, deduplication, gap detection, snapshot refresh;
- `approvals`: list/approve/reject/revoke with reason and committed-state confirmation;
- `providers`: configurations, credential metadata, model discovery, health, selected model;
- `runtimes`: compute/runtime profiles, availability, selected profile;
- `artifacts`: list/inspect/versions/content/lineage/diff/export/save/reuse;
- `usage`: Run/provider/workspace/org usage and server-calculated cost;
- `organization`: memberships, roles, policies, budgets, audit, shared resources;
- `updates`: channel, check, download, verify, install, rollback; and
- stable error envelopes, retryability, correlation IDs, and CLI exit-code mapping.

The Python models must be generated from or validated against versioned language-neutral schemas.
Do not hand-maintain independent TypeScript and Python meanings. Add a contract fixture corpus and
a mock server that can drive the shell without a real backend.

### 7.2 Backend readiness work

Before the UI vertical slice, stabilize these API details:

1. version/capabilities handshake and minimum-compatible client version;
2. project-to-AgentSession lookup and snapshot schema;
3. prompt acceptance response containing project, conversation, session, request, Run,
   correlation, and assistant-message IDs;
4. event cursor contract, heartbeat, reconnect delay, gap signal, and snapshot refresh rule;
5. authoritative approval records and decision endpoints;
6. constrained `ApprovalGrant` and `AutonomyProfile` contracts for allow-once/session/project and
   supervised/trusted/unattended behavior, including expiry, revocation, use count, budgets,
   tools, paths, networks, runtimes, and data classification;
7. parent/child AgentSession, Run, Attempt, cancellation, budget, usage, artifact, and lineage
   links for background/subagent execution;
8. Run/log/artifact/usage links carried in events rather than inferred by the UI;
9. idempotency keys for prompt, approval, retry, cancel, upload, and effectful commands;
10. local/cloud parity for paths and semantic errors; and
11. generated contract artifacts checked into the integration repository and verified in CI.

### 7.3 Backend event to frontend event projection

Create a pure projection layer. It may maintain transient render state, but it may not execute
domain actions.

| Spyderbyte event or snapshot                   | Frontend projection                                                    |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| prompt accepted / request created              | begin turn; bind backend IDs to the visible turn                       |
| `assistant.delta`                              | streaming text/thought content block                                   |
| `plan.created` / plan updated                  | plan display and status summary                                        |
| tool proposed / Run planned                    | tool/action display block with Run ID and estimate                     |
| `approval.required`                            | approval panel keyed by backend approval ID                            |
| `run.started` / attempt started                | step/Run status with provider/runtime metadata                         |
| `run.progress`                                 | live status/progress block                                             |
| `log.appended`                                 | bounded log block and follow link                                      |
| `artifact.created` / version published         | typed artifact card with open/export/save actions                      |
| `usage.updated`                                | backend-calculated token, compute, and cost display                    |
| retry scheduled / attempt failed               | retry display using backend attempt counters                           |
| question/input required                        | structured question panel mapped to a backend interaction request      |
| `execution.completed` / Run terminal           | finalize visible blocks, refresh snapshot, end turn                    |
| `run.failed` / policy denied / budget exceeded | typed error, recovery actions, stable exit code                        |
| reconnect/gap                                  | connection status, snapshot refresh, cursor reset, deduplicated replay |

Replace Kimi `WireMessage` dependencies on Kosong and Kimi tool classes with Spyderbyte-owned view
DTOs before isolating or removing inherited dependencies. Approved runtime adapters may retain
their implementation dependencies, but frontend DTOs must not depend on them.

### 7.4 Inherited runtime adapter contracts

Approved Kimi-derived runtime code must sit behind explicit Spyderbyte ports. At minimum define:

- `AgentRuntimeAdapter`: consumes a Spyderbyte request/context/limits envelope and emits typed
  proposed actions and stream events; it cannot commit Runs or approvals;
- `ContextWindowManager`: consumes policy-filtered resources and a token budget; returns a
  reproducible context manifest, summaries, and source references;
- `CompactionAdapter`: compacts an approved message/resource set and reports metered provider usage
  plus the digest of every input and output;
- `ProviderTransportAdapter`: receives resolved endpoint/model/options and broker-injected,
  short-lived credential material or an opaque signer; returns normalized stream, tool-call,
  error, rate-limit, and usage signals without persisting or logging the credential;
- `ToolImplementationAdapter`: executes only an already-authorized invocation with explicit
  workspace, path, network, environment, time, output, process, and cancellation limits;
- `ProcessRuntimeAdapter`: performs bounded local/remote process mechanics beneath the sandbox and
  ExecutionAttempt lifecycle;
- `BackgroundExecutionAdapter`: executes a declared child AgentSession/Run and reports heartbeat,
  cancellation, retry, and terminal evidence; and
- `CheckpointCache`: stores disposable render/context checkpoints that always reconcile against
  an authoritative backend snapshot and event cursor.

An inherited primitive may enter production only when it has:

1. a Spyderbyte-owned interface and no caller outside the approved adapter boundary;
2. conformance tests against an independent implementation or fixture corpus;
3. threat-model review for credentials, prompts, paths, network, subprocesses, serialization,
   cancellation, and untrusted content;
4. deterministic timeout, retry, cancellation, idempotency, and error semantics;
5. usage and audit signals that can be reconciled by the backend;
6. license/NOTICE and modified-file evidence;
7. a replacement test proving the implementation can be swapped without changing product state;
   and
8. an explicit retain, fork, rewrite, or reject decision in the migration matrix.

“Kimi-derived” is provenance, not a runtime authority or product-facing type name.

## 8. Parallel delivery program

### 8.1 Workstreams

| Lane                              | Scope                                                                          | Can begin after                              | Primary outputs                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------- | ---------------------------------------------------------------------------------- |
| **R — Repository and provenance** | Compose histories, licenses, build roots, CI, upstream tracking                | none                                         | import PR, source manifest, build orchestration                                    |
| **B — Backend contracts**         | Freeze client/event schemas and close API gaps                                 | local baseline                               | versioned schema, fixtures, mock server, API conformance                           |
| **C — Python client/transport**   | Async client, SSE, errors, generated models                                    | B schema draft                               | Python SDK, reconnect tests, local/cloud transport                                 |
| **U — Spyderbyte shell**          | Frontend protocol, Kimi-derived renderers, commands, branding                  | R layout                                     | shell boundary, UI regression harness, no backend imports                          |
| **K — Inherited primitives**      | Audit, extract, wrap, and conform Kimi context/provider/tool/process mechanics | R layout + Spyderbyte adapter drafts         | approved adapter catalog, conformance/security evidence, rejected-component ledger |
| **E — Event/render projection**   | Map AgentSession/Run events to terminal view state                             | B schema + U DTO seam                        | deterministic projector, replay tests, artifact/status blocks                      |
| **A — ACP**                       | Reuse ACP transport over Spyderbyte client                                     | B schema + C client                          | `spyderbyte acp`, permission/session mapping, compatibility tests                  |
| **P — Packaging/release**         | Daemon sidecar, installers, updates, signing, notices                          | R layout; vertical slice for final packaging | dev launcher, packaged sidecar, release matrix                                     |
| **H — Hosted/commercial**         | Cloud gateway, org, billing, SSO, regions, managed resources                   | B contracts; platform adapters               | hosted acceptance, commercial and enterprise gates                                 |
| **Q — Quality/security**          | contract, UI, E2E, chaos, security, performance, accessibility                 | starts in Wave 0                             | CI gates, fixtures, evidence, release reports                                      |

### 8.2 Waves and dependency gates

#### Wave 0 — Freeze and decide

Run R, B, U, K, and Q audits in parallel.

- R0: create source tags/bundles and provenance manifest for both baselines.
- R1: decide history-preserving subtree versus signed snapshot import.
- B0: export the current client/API/runtime schema and identify endpoint gaps.
- U0: classify every Kimi module as preserve, adapt, replace, remove, or defer.
- K0: split Kimi product authority from reusable mechanics and record a candidate-level
  retain/fork/rewrite/reject decision with coupling, test, license, and security evidence.
- Q0: capture passing baseline commands for both codebases and record known failures.
- Decision gate: approve repository composition, final Python namespace timing, sidecar packaging
  direction, upstream synchronization policy, and the first runtime primitives allowed to enter
  adapter conformance work.

**Exit:** both sources are reproducible; no code has been overlaid; the integration branch can be
rebuilt from recorded commits.

#### Wave 1 — Compose without coupling

Run R, B, U, K, P, and Q in parallel.

- R2: import the local platform under `platform/`; retain Kimi tree at root.
- R3: add root build orchestration and split CI for Python, platform, contracts, licenses.
- B1: publish versioned frontend-facing schemas and fixture corpus.
- U1: add `FrontendSession`, frontend event DTOs, and dependency-boundary tests.
- U2: expose `spyderbyte` entrypoint and initial branding while keeping temporary internal
  compatibility aliases.
- K1: create an isolated `spyderbyte_cli.adapters.kimi` boundary and forbidden-import rules; add
  empty Spyderbyte-owned ports for context, compaction, provider transport, tool implementation,
  process runtime, background execution, and checkpoint cache.
- K2: port or wrap context budgeting/compaction/checkpoint algorithms against fixture-only
  Spyderbyte contracts; do not connect them to durable project state yet.
- P1: add a development launcher that starts or connects to `platform/apps/local-daemon`.
- Q1: preserve selected Kimi UI/PTY tests unchanged as an ergonomics regression suite.

**Exit:** both projects build and test independently in one repo; the shell can run against a mock
frontend session; no Kimi backend behavior has been replaced by an untyped bridge.

#### Wave 2 — Contract and transport foundation

Run B, C, U, K, E, A, P, and Q in parallel.

- B2: close version, session, prompt-acceptance, cursor, approval, Run-link, and error gaps.
- C1: implement session/project/agent/Run/event client facets and generated models.
- C2: implement authentication, retry, cancellation, idempotency, SSE resume, gap recovery.
- U3: replace Kimi composition root with `SpyderbyteCLI` behind a feature flag.
- K3: conform selected Kosong transports to `ProviderTransportAdapter` using backend-resolved
  configuration, broker-injected short-lived credentials or opaque signers, normalized errors,
  streaming, redaction, and usage signals.
- K4: conform selected tool/KAOS implementations to ToolBroker and ProcessRuntime contracts with
  path/network/process/output/cancellation limits; reject any adapter that cannot fail closed.
- K5: prototype retry/streaming/background mechanics as AgentRuntime/BackgroundExecution adapters
  with parent/child Runs and no local durable authority.
- E1: implement deterministic snapshot/event projection using mock fixtures.
- A1: define ACP-to-Spyderbyte session, content, permission, cancellation, and artifact mapping.
- P2: make daemon discovery/start/stop/restart and support diagnostics cross-platform in dev.
- Q2: add mock-driven shell, print, and ACP tests; inject duplicate/out-of-order/gap events.

**Exit:** the Kimi-derived UI renders a complete mocked Spyderbyte turn and reconnects without
Kimi product authority. Any retained runtime primitive is reachable only through a Spyderbyte
adapter and passes its initial conformance/security gate.

**Wave 2 completion record — 2026-08-08:** The versioned frontend contract now covers session,
prompt acceptance, errors, event pages, Runs, approvals, artifacts, and usage. The Python client
uses an authenticated, idempotency-aware transport with bounded retries and SSE cursor resume;
duplicate/out-of-order/gap behavior is deterministic through `FrontendProjector`. ACP mapping,
provider/tool/process/background adapter seams, and cross-platform daemon start/stop/restart/
diagnostics are covered by focused tests. `make verify-wave-2` is the local exit command.

#### Wave 3 — Local golden-path wiring

Run C/E vertical slices in parallel by resource family while U, K, and Q integrate continuously.

- E2: project selection, conversation snapshot, prompt submission, assistant streaming.
- E3: Universal Run status, attempts, logs, cancel, retry, and terminal states.
- E4: backend approval panel and committed decision flow.
- E5: provider/model/runtime status and selection; no provider SDK in Python UI.
- E6: backend-routed shell command, file edit, tool call, and background Run presentation.
- E7: artifact cards, versions, lineage, preview, open/export/save/reuse/diff.
- E8: usage, estimated/actual cost, policy, budget, and actionable errors.
- K6: connect approved context/compaction and provider-transport adapters to the golden path;
  preserve Spyderbyte context selection, provider routing, metering, and audit authority.
- K7: connect approved tool/process/background adapters only through ToolBroker, sandbox,
  approval, ExecutionAttempt, parent/child Run, cancellation, and budget boundaries.
- U4: conversation-first slash commands and headless command parity over the Python client.
- A2: run ACP against the same local AgentSession and Run path.
- P3: package the local daemon and required workers as a development sidecar artifact.
- Q3: run a real local E2E with model adapter stub, then one credentialed provider smoke test.

**Exit:** a local user starts `spyderbyte`, opens/creates a project, sends a prompt, observes a
durable Run, handles an approval, receives artifacts and usage, reconnects, and inspects/retries or
cancels the Run. The same project and history are visible through CLI, ACP, and API.

**Wave 3 completion record — 2026-08-08:** The Python frontend now opens or creates the active
backend project, reads the durable conversation and AgentSession snapshots, submits a prompt with
optional backend model selection, consumes cursor-resumable SSE events, and reads typed Run,
attempt, log, provider, model, runtime, approval, artifact, and projection facets. The local CLI
and ACP command both use that client and the same local daemon path. `make verify-wave-3` passes
the schema, lint, type, retained UI, provenance, and clean-workspace real-daemon checks. The
deterministic `deterministic`/`fixture-model` provider is the available local smoke adapter;
credentialed-provider smoke, organization approval/usage exercise, and GitHub publication remain
environment or owner gates and are not represented as local proof.

#### Wave 4 — Computational platform parity

Run native resource families in parallel after the golden path is stable. Each family must use
the same AgentSession, Universal Run, policy, approval, artifact, lineage, usage, and audit
contracts established in Wave 3.

- U5: canonical noninteractive command tree and stable JSON/stream output.
- E9a: Dataset resources, profiling, transforms, joins, materialization, and lineage.
- E9b: SQL resources and Runs, connection selection, query status, results, and saved outputs.
- E9c: Notebook resources and Runs, cell/kernel status, resume, publish, and Jupyter handoff.
- E9d: Experiment, Training, Evaluation, Model, registry, comparison, deployment, and serving
  resources and Runs.
- E9e: Visualization resources, editable specifications, data bindings, previews, and rich-client
  handoff.
- E9f: Pipeline, Automation, schedule, Connector, and workspace-intake resources and Runs.
- C3: expose typed discover, invoke, observe, resume, cancel, inspect, compare, publish, export,
  and handoff operations for every supported resource family.
- Q4: add native-resource routing tests proving the Agent selects a first-class capability when
  available and uses a generic system fallback only when explicitly allowed.
- Q5: run the computational parity matrix below through TUI, headless CLI, ACP where applicable,
  and the shared API.

| Resource      | Discover | Invoke   | Observe  | Resume   | Inspect  | Native output                                       |
| ------------- | -------- | -------- | -------- | -------- | -------- | --------------------------------------------------- |
| Dataset       | Required | Required | Required | Required | Required | versions, profile, schema, lineage                  |
| SQL           | Required | Required | Required | Required | Required | SQL Run, result dataset/artifact, query metadata    |
| Notebook      | Required | Required | Required | Required | Required | Notebook Run, cells, outputs, publication           |
| Experiment    | Required | Required | Required | Required | Required | Training/Evaluation Runs, metrics, comparisons      |
| Model         | Required | Required | Required | Required | Required | versions, registry state, deployment/serving status |
| Visualization | Required | Required | Required | Required | Required | editable specification, preview, export             |
| Pipeline      | Required | Required | Required | Required | Required | Pipeline Run, stages, logs, outputs, lineage        |
| Automation    | Required | Required | Required | Required | Required | schedule, trigger history, linked Runs, policy      |

**Exit:** every v1 first-class computational resource can be discovered, invoked, observed,
resumed, and inspected in the terminal without being flattened into an opaque shell command.
Where the terminal cannot provide the full editing or exploratory experience, it opens a richer
client over the same resource and Run IDs.

#### Wave 5 — Organizational and hosted interface parity

Run organization, ACP, and hosted client surfaces in parallel after their contracts stabilize.

- E10: organization/workspace switching, role/policy/budget/approval/audit views.
- A3: representative ACP client compatibility and reconnect/cancellation tests.
- H1: optional Spyderbyte Cloud login, managed model/compute selection, hosted reconnect.
- H2: shared project/context/artifact and centralized organization administration paths.
- Q6: command-parity matrix against the existing TypeScript TUI and API contract.

**Exit:** all v1 product capabilities have either a terminal workflow, a deliberate rich-client
handoff, or an explicit deferred status. Organization controls cannot be bypassed by terminal or
ACP clients.

#### Wave 6 — Kimi authority removal and product cutover

- U6: rename final Python namespace/package as approved and remove Kimi user-facing identity.
- U7: remove direct production authority and calls to Kimi Soul composition, Kimi provider/session
  configuration, local tool execution, local approval/AFK policy, Kimi auth, Kimi cost truth,
  Kimi telemetry policy, and Kimi update/account endpoints.
- K8: retain only approved Kimi-derived UI/runtime implementations inside Spyderbyte-owned adapter
  boundaries; remove rejected, superseded, and bypassable paths and dependencies.
- U8: retain required terminal/ACP mechanics and approved adapters with modified-file and NOTICE
  compliance.
- P4: package `spyderbyte` plus platform sidecar for supported targets; verify clean install,
  upgrade, rollback, workspace preservation, uninstall behavior, and offline startup.
- Q7: enforce forbidden-import, forbidden-endpoint, branding, license, secret, sandbox, and
  authority scans.

**Exit:** replacing the Spyderbyte backend with a contract-compatible mock leaves the TUI
functional, while removing the TUI leaves backend/API/ACP semantics intact. No production path can
invoke Kimi product authority. Approved Kimi-derived implementations are replaceable adapters and
cannot bypass Spyderbyte AgentSession, Run, provider, tool, policy, approval, usage, or audit
contracts.

#### Wave 7 — Remaining hosted, commercial, and release gates

Run H, P, and Q by environment in parallel.

- H3: deploy hosted identity, gateway, Postgres/event/object/secret/workflow/worker adapters.
- H4: managed inference and compute with reconciliation, quotas, budgets, margin telemetry, and
  customer-owned alternatives.
- H5: organization entitlements, annual licensing, usage billing, invoice/reconciliation, support.
- H6: production SSO/SCIM, private runners, residency, customer-managed keys, retention/legal
  hold, export/deletion, and government evidence.
- P5: signed/notarized/stapled macOS artifacts and verified Linux/Windows publication.
- P6: stable/beta/nightly updates, rollback, crash recovery, backup/restore/DR exercises.
- Q8: hosted SLO/load/capacity, security, dependency/image/secret scans, audit completeness,
  incident and disaster-recovery evidence.

**Exit:** hosted and organizational release environments satisfy the same contracts and golden
paths as local mode; pricing and entitlements are approved product decisions; supported artifacts
pass native signing and clean-machine evidence.

## 9. Critical path

The shortest valid path to an integrated product is:

```text
source freeze
 -> isolated platform import
 -> versioned client/event contract
 -> Python client + frontend DTO seam
 -> inherited-primitive adapter decisions and conformance
 -> backend event projector
 -> local conversation/Run vertical slice
 -> backend approval and tool execution
 -> computational resource parity and native-resource routing
 -> Kimi product-authority removal and adapter isolation
 -> composed packaging and clean-install release
```

ACP, provider/runtime views, artifact renderers, command families, hosted adapters, organization
surfaces, and release automation can proceed in parallel once their contract prerequisites are
stable. No lane may bypass the critical path by directly calling a provider, worker, filesystem,
shell, or approval implementation from the Python frontend.

## 10. Pull-request and branch strategy

Use small integration branches from the Kimi fork, with one owning lane per branch. Suggested
sequence:

1. `codex/repo-composition` — provenance, `platform/` import, build roots, no behavior change.
2. `codex/frontend-contract-v1` — schemas, fixtures, mock server, conformance.
3. `codex/python-client` — generated models, transport, SSE, errors.
4. `codex/shell-boundary` — frontend protocol/DTOs, Spyderbyte entrypoint, mock UI.
5. `codex/kimi-runtime-adapters` — candidate extraction, conformance, threat models, retain/reject ledger.
6. `codex/event-projector` — conversation/Run/approval/artifact/usage projection.
7. `codex/local-golden-path` — daemon bootstrap and real local vertical slice.
8. `codex/acp-adapter` — ACP over the same Python client.
9. `codex/computational-parity` — native data, notebook, ML, visualization, and workflow resources.
10. `codex/command-parity` — headless commands and structured output.
11. `codex/kimi-authority-removal` — remove bypass paths; isolate approved primitives and dependencies.
12. `codex/composed-release` — sidecar packaging, installers, updates, release evidence.

Rules:

- Contract changes land before consumers and include backward-compatibility fixtures.
- UI and backend changes should be separate PRs unless a vertical slice cannot be tested
  independently.
- Generated files and lockfiles belong to their owning ecosystem and are reviewed separately.
- Every PR identifies authority changes, schema changes, migration/recovery behavior, test
  evidence, and source-license impact.
- Upstream Kimi patch ports use a dedicated PR containing the upstream commit, touched-file
  classification, product-boundary review, and regression results.

## 11. Verification and release gates

### 11.1 Required automated layers

- Kimi shell unit and PTY regression tests for input, paste, keyboard, layout, streaming,
  cancellation, approvals, narrow terminals, Unicode, and non-TTY output.
- Python client unit tests for every endpoint, error family, retry, cancellation, timeout,
  idempotency, cursor, duplicate, gap, and authentication state.
- Cross-language schema fixture tests in TypeScript and Python.
- Event-projector golden tests from recorded backend snapshots and event streams.
- Native-resource routing tests for Data, Notebook, Experiment, Visualization, Pipeline, Artifact,
  and System capabilities, including explicit fallback and unavailable-capability cases.
- Adapter conformance and substitution tests for every retained context, compaction, provider,
  tool, process, checkpoint, or background primitive.
- Threat-model and failure-injection tests for inherited adapters, including malicious paths,
  environment/secret leakage, network denial, process trees, cancellation, duplicate requests,
  malformed serialization, provider rate limits, and partial streams.
- Backend package tests and existing `pnpm verify`/invariant gates.
- Mock-driven TUI, print, and ACP tests.
- Real sidecar E2E with stub inference and sandboxed tool execution.
- Credentialed provider, hosted, organization, and release-environment smoke tests.
- Packaging tests for missing/corrupt sidecar, daemon crash/restart, upgrade/rollback, offline
  startup, workspace preservation, and clean uninstall/reinstall.

### 11.2 Forbidden conditions

CI must fail if:

- UI modules import provider SDKs, Kimi Soul, Kimi tools, Kimi approval authority, local workers,
  approved runtime adapters, or platform package internals;
- production code imports inherited provider/tool/process/background implementations outside the
  declared `spyderbyte_cli.adapters.kimi` boundary;
- an inherited adapter reads product configuration or resolves/persists raw credentials directly,
  creates durable session/Run/approval state, selects policy, calculates authoritative cost, or
  commits effects outside its Spyderbyte port;
- a terminal or ACP action creates execution state outside the Universal Run path;
- a first-class data, SQL, notebook, experiment, model, visualization, pipeline, automation,
  connector, deployment, or serving operation is implemented through a generic shell route when
  its native Spyderbyte resource or Run contract is available;
- client code computes authoritative cost, policy, permission, or approval outcomes;
- reconnect replay duplicates visible state or loses a terminal event;
- raw secrets enter logs, events, artifacts, diagnostics, telemetry, or snapshots;
- Kimi account, endpoint, provider, billing, telemetry, update, or user-facing brand assumptions
  remain in a production path;
- Apache-2.0 LICENSE/NOTICE and modified-file obligations are missing; or
- local mode requires a Spyderbyte Cloud account for the individual/BYOK/local-model path.

### 11.3 Golden acceptance journeys

1. **Local individual:** clean install, no account, project, local/BYOK provider, prompt, plan,
   approval, Run, artifact, usage, restart, resume.
2. **Headless:** the same operation through stable CLI JSON with correct IDs and exit code.
3. **ACP:** the same project and AgentSession from a representative ACP client, including
   permission request, cancellation, artifact, and reconnect.
4. **Local to cloud:** move an eligible Run to managed compute without changing project/session
   semantics; preserve policy, artifacts, lineage, usage, and audit.
5. **Organization:** shared project with role/provider/runtime/budget policy, centralized approval,
   attributed usage, and audit; denied actions fail identically through TUI, CLI, ACP, and API.
6. **Failure recovery:** provider failure, daemon restart, network loss, event gap, worker crash,
   and update rollback recover without duplicate effects or lost durable history.
7. **Computational/ML native journey:**

   1. open a project containing a registered dataset;
   2. ask Spyderbyte to predict a named target;
   3. receive a native dataset profile with schema, quality, and lineage;
   4. create an `Experiment` resource;
   5. receive a proposed target, features, method, runtime, and evaluation plan;
   6. approve the bounded training action through backend policy;
   7. select or confirm the authorized compute/runtime resource;
   8. create a linked Training Run rather than a generic Python or shell Run;
   9. observe streaming stage, log, progress, retry, cancellation, and budget state in the TUI;
   10. inspect native metrics and evaluation summaries;
   11. receive versioned visualization and report artifacts;
   12. register the selected model version;
   13. inspect dataset, code/configuration, Run, artifact, and model lineage;
   14. compare the registered model with another experiment or model version;
   15. create and inspect a linked Evaluation Run;
   16. open the same visualization, notebook, or experiment in Spyderbyte web or Jupyter for a
       richer view; and
   17. verify TUI, headless CLI, ACP where applicable, API, web, and desktop observe the same Runs,
       resources, metrics, artifacts, and lineage.

   **Exit:** no stage is represented as an opaque shell command whose output must be scraped to
   reconstruct an Experiment, Training Run, Evaluation Run, model, metric, visualization,
   artifact, or lineage record.

## 12. Remaining Spyderbyte work outside terminal wiring

The local implementation is broad, but these product gates remain open and must not be hidden by
frontend progress:

- real hosted control-plane deployment and operations evidence;
- production identity, secret broker, object store, durable workflow/event transport, and worker
  pool adapters;
- managed inference/compute reconciliation, quotas, capacity, regional routing, and margin data;
- final pricing, organization entitlements, annual licensing, usage rates, commitments, and
  government caps;
- production SSO/SAML/OIDC, SCIM, KMS/HSM/CMK, private runner/customer-cloud/on-prem deployment;
- data residency, retention/legal hold, export/deletion, procurement, certification, and
  government authorization evidence;
- native signed publication for supported platforms, including Developer ID, notarization,
  stapling, Gatekeeper, and equivalent Linux/Windows evidence;
- hosted CI security/dependency/image/secret scan results;
- hosted SLO, load, capacity, backup/restore, disaster recovery, incident, audit-completeness, and
  telemetry export evidence; and
- final clean-machine onboarding, update/rollback, data preservation, support, and release-channel
  evidence for the composed Python-plus-sidecar artifact.

## 13. Human decision gates

Obtain an explicit decision before:

1. choosing full-history subtree versus signed snapshot import for the local platform;
2. finalizing the Python package namespace rename and upstream Kimi synchronization policy;
3. choosing the packaged sidecar technology and supported release targets;
4. choosing ACP protocol version and representative compatibility clients beyond the current
   `agent-client-protocol==0.8.0` baseline;
5. changing any credential, sandbox, policy, approval, budget, audit, artifact, or Run authority;
6. retaining any Kimi product authority, promoting a Kimi-derived primitive without the adapter
   adoption gates, or changing the approved adapter boundary;
7. selecting hosted vendors, regions, residency, customer infrastructure, or government posture;
8. approving pricing, entitlements, rates, commitments, prepaid balances, or government caps; and
9. changing signing, notarization, update, rollback, or user-data-preservation behavior.

## 14. Definition of complete

The Spyderbyte terminal integration is complete only when:

- the source/provenance manifest can reproduce both imported baselines;
- the Spyderbyte terminal shell, derived in part from Kimi CLI, uses only the typed Spyderbyte
  frontend/client contract for product behavior;
- TUI, CLI, ACP, API, web, and desktop observe the same AgentSession, Runs, approvals, artifacts,
  usage, and audit;
- every v1 native computational resource is discoverable, invocable, observable, resumable, and
  inspectable through the terminal; richer clients open the same resource IDs, and all clients
  observe the same Runs, metrics, artifacts, versions, and lineage;
- the Agent prefers native Data, Notebook, Experiment, Visualization, Pipeline, Artifact, and
  related domain capabilities over generic System tools whenever a first-class route exists;
- direct Kimi product-authority paths for agent/session/provider configuration, credentials,
  tools, approvals, usage, auth, telemetry policy, and updates are absent from production;
- every retained Kimi-derived implementation is isolated behind a Spyderbyte-owned adapter,
  passes conformance/security/substitution/license gates, and can be replaced without changing
  durable product state;
- local account-free use, BYOK, local models, local compute, reconnect, and recovery pass;
- the composed artifact installs and updates cleanly on supported targets;
- attribution, security, policy, budget, artifact, and audit gates pass; and
- open hosted/commercial/certification work remains explicitly labeled rather than represented as
  complete.
