# Spyderbyte Production Implementation Plan

> **Superseded:** This is a historical product-delivery overlay. The authoritative plan going
> forward is [`SPYDERBYTE_IMPLEMENTATION_PLAN.md`](SPYDERBYTE_IMPLEMENTATION_PLAN.md).
> Keep this file as evidence; do not use it for new status updates or phase decisions.

**Status:** Historical product-delivery overlay; superseded  
**Source:** `Spyderbyte Production Plan — From Platform Foundation to a Terminal-First ML Development Environment`  
**Repository baseline:** `/Users/josiah/aug`  
**Date:** 2026-08-06

This document converts the supplied product plan into a dependency-ordered implementation plan.
The existing [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) remains the low-level control-plane,
harness, local-product, and release authority. This document is the product-delivery overlay for
the terminal-first Spyderbyte experience.

## 1. Outcome

Ship one complete, durable, observable execution loop:

```text
install
  → onboard
  → configure provider
  → validate model
  → select runtime
  → create/open project
  → ask the agent or invoke a command
  → review plan and risk
  → execute
  → stream status, logs, metrics, and events
  → inspect artifacts and lineage
  → open JupyterLab for rich work
  → modify and rerun
  → schedule or deploy
  → return later and recover the full history
```

The product surfaces have distinct responsibilities:

| Surface                     | Primary responsibility                                                                                  | Must not become                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| TUI and noninteractive CLI  | Daily control, project navigation, setup, plans, execution, logs, approvals, artifacts, diagnostics     | A second backend or source of truth                             |
| JupyterLab                  | Notebook editing, cell execution, rich tables, visualizations, exploration                              | The owner of credentials, permissions, durable runs, or lineage |
| Lightweight web application | Artifact viewing, large tables, charts, lineage, comparisons, administration, governance, billing/usage | A full IDE that duplicates the TUI                              |
| Local daemon / hosted API   | Authoritative commands, state, policies, execution, events, artifacts, and recovery                     | A UI-specific implementation                                    |

### Production definition of done

Spyderbyte is production-ready for the first release when a clean supported machine can complete
the first-release journey without editing backend configuration or manually starting services:

1. Install and launch Spyderbyte.
2. Sign in or continue in local-only mode.
3. Create/open a workspace and project.
4. Configure and validate a provider or local model.
5. Discover/select a runtime and environment.
6. Connect a repository or supported data source.
7. Ask the agent to perform work or invoke a command.
8. Review the plan, cost, policy findings, and approval requirements.
9. Inspect and modify generated files.
10. Execute a real model, Python, query, or notebook action.
11. Reconnect and observe durable run state, logs, events, metrics, and artifacts.
12. Open JupyterLab, execute cells, and publish a rich output.
13. Reopen the project and recover the run, artifacts, and lineage.

Training, scheduled workflows, and deployment may be beta features in the first production release,
but they must use the same execution contracts and must not be represented as complete until their
adapters are real.

## 2. Planning assumptions and product decisions

These assumptions make the plan executable without inventing external infrastructure:

- Spyderbyte v1 is local-first and may be distributed as the existing signed macOS product. The
  TUI/CLI is the primary operational surface; the desktop/web application remains the richer
  artifact, administration, and visual-inspection surface.
- Local and hosted execution share the same request, plan, run, event, artifact, and lineage
  contracts. Transport and storage implementations may differ.
- The backend owns durable truth. Client state is limited to drafts, selections, layout, cached
  rendering, and temporary optimistic state.
- A capability is production-ready only when a real adapter, durable state transition, error path,
  cancellation path, and verification test exist.
- Unsupported capabilities are hidden, explicitly labeled experimental, or fail closed. No
  projection-only control may claim execution success.
- The first provider set is OpenAI, Anthropic, one OpenAI-compatible endpoint, one local provider,
  and a deterministic test provider. Additional providers follow the adapter contract.
- JupyterLab is integrated as a managed execution client, not embedded as a replacement control
  plane.
- Hosted topology, SSO/SCIM, external secret managers, advanced deployment, and full browser
  collaboration are follow-on work unless a release decision explicitly promotes them.

### Decision gate 0: reconcile the product surfaces

Before implementation begins, record an ADR that confirms:

- TUI/CLI is the primary daily control surface.
- The current desktop host is a distribution and local-runtime shell, not a substitute for the TUI.
- The web application is initially limited to rich artifact/admin workflows.
- The TUI, CLI, Jupyter extension, and web app share the same typed client/application services.
- The first-release boundary is local-first, with hosted-compatible contracts.

This gate prevents the team from expanding the existing browser shell while leaving the terminal
execution loop incomplete.

## 3. Architecture baseline

### 3.1 Durable resource hierarchy

```text
Organization
└── Workspace
    ├── members, policies, providers, credentials, runtimes, environments, budgets
    └── Project
        ├── repository/files
        ├── agent sessions and change sets
        ├── notebooks and Jupyter sessions
        ├── connections, datasets, queries
        ├── experiments, models, deployments
        ├── pipelines and automations
        ├── runs, attempts, events, logs
        └── artifacts and lineage
```

### 3.2 Universal execution model

Every material action creates or attaches to a durable `Run`. The same model applies to prompt
invocation, Python, SQL, notebook/cell execution, training, evaluation, pipelines, connector sync,
visualization, deployment, and automation.

Required contracts in `packages/runtime-contracts`:

- `ExecutionRequest`
- `ExecutionContext`
- `ExecutionPlan`
- `ExecutionAttempt`
- `ExecutionEvent`
- `ExecutionResult`
- `ArtifactReference`
- `ResourceUsage`
- `LineageEdge`
- `ApprovalRequest`
- `RuntimeProfile`
- `EnvironmentRevision`
- `JupyterSession`

Required run state machine:

```text
draft → validating → awaiting_configuration → awaiting_approval
     → queued → provisioning → running → finalizing → succeeded

terminal: failed | cancelled | timed_out | partially_succeeded
session:  starting | ready | idle | stopping | stopped
```

Every retry is a new attempt under the same run. Attempts retain their runtime, provider,
resources, logs, outputs, error, and duration.

### 3.3 Execution adapter contract

All real execution paths implement the same shape:

```ts
interface ExecutionAdapter<TRequest, TResult> {
  validate(request: TRequest, context: ExecutionContext): Promise<ValidationResult>;
  plan(request: TRequest, context: ExecutionContext): Promise<ExecutionPlan>;
  estimate(plan: ExecutionPlan): Promise<ResourceEstimate>;
  execute(plan: ExecutionPlan, signal: AbortSignal): AsyncIterable<ExecutionEvent>;
  cancel(executionId: string): Promise<void>;
  recover(executionId: string): Promise<RecoveryResult>;
}
```

Adapters are responsible for execution mechanics. The control plane remains responsible for
authorization, approvals, budgets, idempotency, state transitions, event publication, and audit.

### 3.4 Event and client model

Use the existing local API/SSE and projection work as the first transport. Add:

- a typed client SDK shared by TUI, CLI, Jupyter extension, and web app;
- event cursors and replay from event ID;
- reconnect and deduplication;
- stale-state detection and fallback polling;
- terminal-state reconciliation through a point read;
- bounded log streaming and virtualized long output;
- a transactional outbox for durable state plus publishable events.

### 3.5 Proposed repository mapping

| Capability                | Primary repository locations                                                                                   | Main result                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Contracts and state       | `packages/runtime-contracts`, `packages/runtime-domain`, `packages/state`                                      | Versioned schemas, migrations, state machines, repositories  |
| Provider/model runtime    | `packages/provider-runtime`, `packages/backends`                                                               | Persisted provider adapters, discovery, health, routing      |
| Orchestration and policy  | `packages/orchestrator`, `packages/harness-core`, `packages/tool-broker`, `packages/policy`, `packages/budget` | Plan, approval, authority, budget, execution coordination    |
| Runs and artifacts        | `packages/projections`, `packages/artifact-registry`, `packages/observability`                                 | Durable run views, event stream, lineage, usage, audit       |
| Workspace and secrets     | `packages/workspace`, `packages/license`, `apps/local-daemon`                                                  | Local workspace, Keychain boundary, portability, diagnostics |
| Client transport          | `packages/local-api`, proposed typed SDK package                                                               | Shared commands, queries, subscriptions, errors              |
| TUI/CLI                   | proposed `apps/tui` or `apps/cli`                                                                              | Interactive and noninteractive terminal clients              |
| Jupyter                   | proposed notebook/session adapter and JupyterLab extension package                                             | Managed sessions, cell events, artifact publishing           |
| Local execution           | `apps/worker`, `apps/sandbox-runner`, `packages/tasks`                                                         | Python, notebook, pipeline, and safe code execution          |
| Rich visual/admin surface | `apps/web`, `apps/desktop`                                                                                     | Artifacts, tables, charts, lineage, settings, packaging      |

## 4. Delivery sequence

The phases are gates, not merely feature batches. A phase is complete only when the acceptance
journey, failure paths, and evidence are present. Work within a phase can be parallelized after its
contract boundary is fixed.

### Phase 0 — Product truth and contract audit

**Objective:** Make every visible capability honest and define the contracts that all clients use.

**Deliverables**

1. Inventory every existing API, CLI, frontend action, provider action, runtime, connector,
   notebook, experiment, pipeline, automation, and deployment capability.
2. Classify each as `real`, `projection-only`, `mocked`, `local-only`, `experimental`, or
   `incomplete`.
3. Map each production command to its API route, service, adapter, durable state transition,
   event stream, error behavior, retry behavior, and cancellation behavior.
4. Define canonical resource names, IDs, versions, timestamps, error envelopes, pagination,
   state transitions, and event envelopes.
5. Add feature flags and capability reporting so unsupported features cannot appear callable.
6. Record the TUI/desktop/web/Jupyter product-surface decision.
7. Build contract fixtures for providers, runtimes, runs, artifacts, notebooks, and approvals.

**Repository targets:** `IMPLEMENTATION_PLAN.md`, `docs/contracts`, `docs/adr`,
`packages/runtime-contracts`, `packages/runtime-domain`, `packages/projections`, `apps/api`,
`apps/local-daemon`.

**Exit gate**

- Every first-release command has documented backend behavior.
- No UI claims success from a local timer, toast, optimistic mutation, or metadata-only record.
- Unsupported features are hidden or explicitly labeled.
- Contract fixtures can drive TUI, CLI, web, and Jupyter client tests.

### Phase 1 — Provider-to-prompt TUI vertical slice

**Objective:** A user can configure a provider and complete a real model request from the terminal.

**Backend work**

1. Add/migrate durable entities for provider configuration, credentials, endpoints, models,
   capabilities, health checks, usage policy, runtime profile, environment, run, and attempt.
2. Implement local OS-keychain credential storage and hosted encrypted-secret abstraction. Return
   secret handles/status only; never return secrets after creation.
3. Implement provider adapter factory:
   `ProviderConfiguration → ProviderAdapterFactory → ProviderTransport → CapabilityAdapter`.
4. Implement OpenAI, Anthropic, OpenAI-compatible, local provider, and deterministic test adapters.
5. Implement structured preflight: reachability, auth, model discovery, minimal request, streaming,
   capability report, latency, rate-limit metadata, and actionable errors.
6. Replace any fixed model catalog with provider-derived catalog and selection hierarchy:
   explicit run → resource → project → workspace → routing policy → fallback.
7. Create durable model-invocation runs with idempotency keys, attempts, usage, cost estimate,
   status transitions, logs, events, cancellation, retry, and return-later retrieval.
8. Add provider/runtime diagnostics and sanitized support bundle generation.

**Client work**

1. Create the reusable client/application service layer.
2. Build `spyderbyte` interactive shell with project/workspace header, command pane, inspector,
   logs/events bottom pane, narrow-terminal fallback, reconnect state, and keyboard navigation.
3. Add provider setup, credential selection, connection test, model discovery, and model selection.
4. Add noninteractive commands:
   `provider add`, `provider test`, `models list`, `project create/open`, `run`, `runs inspect`,
   `runs logs --follow`, and `doctor`.
5. Persist client-only preferences: active workspace/project, selected model/runtime, pane layout,
   recent commands, and draft input.

**Acceptance journey**

```text
install → spyderbyte → local/sign-in mode → provider add/test
→ models list/select → project create/open → prompt
→ plan/approval if required → stream response → inspect run
→ quit/relaunch → retrieve run and logs
```

**Exit gate**

- The journey passes with the deterministic provider and at least one real remote or local
  provider in the supported test environment.
- Provider state distinguishes configured, authenticated, reachable, callable, degraded,
  rate-limited, misconfigured, and disabled.
- The TUI and CLI use the same services and produce the same run semantics.
- Provider failures, expired credentials, cancellation, network interruption, and reconnect are
  tested.

### Phase 1 completion record — 2026-08-06

**Status: Complete.** The provider-to-prompt terminal vertical slice is implemented across the
shared runtime, local API, daemon, client SDK, and `spyderbyte` shell.

| Phase 1 requirement                                                                                                     | Evidence                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Durable provider, credential, model, capability, health, usage-policy, runtime, environment, run, and attempt contracts | `packages/runtime-contracts`, `ProviderConfigurationService`, runtime-profile/environment stores, and durable conversation run events. `ProviderUsagePolicy` is part of the v1 provider contract with migration defaults.                                                                             |
| Local and hosted secret boundaries                                                                                      | `MacOsKeychainVault`, injectable `HostedEncryptedSecretVault`, metadata-only provider credentials, and redaction tests.                                                                                                                                                                               |
| Adapter factory and provider transports                                                                                 | `DefaultProviderAdapterFactory` routes OpenAI, Anthropic, OpenAI-compatible/Ollama/local, and deterministic adapters through capability-aware transports.                                                                                                                                             |
| Structured preflight                                                                                                    | `ProviderConfigurationService.test()` reports authentication, endpoint, reachability, discovery, minimal inference, streaming, capability, latency, rate-limit metadata, and actionable errors; state transitions cover callable, degraded, rate-limited, misconfigured, expired, and disabled paths. |
| Provider-derived catalog and selection hierarchy                                                                        | Discovered models populate the catalog; `ModelRouter.resolveSelection` implements explicit run → resource → project → workspace → routing policy → fallback with tests for precedence and unavailable explicit selections.                                                                            |
| Durable invocation loop                                                                                                 | Local daemon persists idempotent conversation turns, runs, attempts, usage/cost, logs, events, cancellation, retry, point reads, and replayable SSE follow.                                                                                                                                           |
| Shared client and terminal shell                                                                                        | `packages/client-sdk` owns REST/SSE/reconnect behavior; `apps/tui` provides provider setup/test, discovery/selection, project/run commands, diagnostics, preferences, wide/narrow layouts, pane navigation, history, drafts, and reconnect state.                                                     |
| Diagnostics and support bundle                                                                                          | `/v1/diagnostics` and `/v1/diagnostics/support-bundle` return sanitized provider/runtime data; API and frontend contract snapshots are generated and checked.                                                                                                                                         |

Acceptance evidence includes the deterministic provider suite and a live Ollama-backed provider
preflight on `127.0.0.1:11434/v1` using `gpt-oss:120b-cloud`: 3 models discovered, state `callable`,
and authentication, endpoint, capability, reachability, discovery, inference, and streaming checks
all passed (discovery 77 ms, inference 392 ms, streaming 409 ms). TUI and CLI both call the same
client/application services, and focused tests cover expired credentials, rate limits, cancellation,
network/reconnect behavior, idempotency, run recovery, and sanitized diagnostics.

Verification completed: `pnpm contracts:check`, `pnpm api-contracts:check`,
`pnpm frontend-contracts:check`, `pnpm lint`, `pnpm typecheck` (30/30 packages), `pnpm test`
(49/49 tasks), `pnpm test:invariants` (47/47 tasks), affected-package builds, and the formatted
Phase 1 source/test/contract files.

### Phase 2 — Project execution and editor integration

**Objective:** Complete the coding loop: agent change set → human review → edit → execute → artifact.

**Deliverables**

1. Implement a project filesystem abstraction for local directories, Git repositories, managed
   storage, generated files, uploads, and artifact-derived files.
2. Add file tree, search, preview, history, diff, rename/move/delete, and safe file operations.
3. Resolve editors in this order: explicit Spyderbyte setting → `$VISUAL` → `$EDITOR` → detected
   editor → safe fallback.
4. Model agent edits as a change set containing created, modified, deleted, and dependency changes.
5. Support diff inspection, selected-hunk acceptance, rejection, manual edit before acceptance,
   revert, test execution, and run.
6. Add local Python execution and one managed runtime adapter using the shared runtime contract.
7. Capture code revision, environment revision, runtime, inputs, logs, metrics, outputs, and
   artifacts in the run.
8. Add safety confirmations for external writes, dependency installation, destructive file/data
   operations, and expensive execution.

**Acceptance journey**

```text
open project → ask agent to modify code → inspect diff → edit/accept
→ run tests or Python → stream logs → inspect output artifact
→ restart/reconnect → recover project and run state
```

**Exit gate:** no generated change is applied without an inspectable version/change set; Python
execution uses a real adapter; failed and cancelled runs retain evidence.

### Phase 2 completion record — 2026-08-06

**Status: Complete.** The project coding loop is implemented across the provider runtime, local API,
API contracts, capability authority, and web Repositories workbench. Generated, uploaded, and
artifact-derived writes create an inspectable change set reference; manual edits can be refreshed
into the same review record before acceptance.

| Phase 2 requirement                                                          | Evidence                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Project filesystem abstraction                                               | `LocalRepositoryRuntime` registers both Git repositories and local directories; workspace-managed state persists file operations, and writes carry `manual`, `generated`, `upload`, or `artifact-derived` origin plus optional artifact references.                                                          |
| Tree, search, preview, history, diff, move, delete, and safe file operations | Bounded recursive tree traversal, literal text search, UTF-8 previews, Git/file-operation history, atomic writes, regular-file-only move/delete, symlink/path-boundary checks, and bounded diffs are implemented in `packages/provider-runtime/src/repositories.ts` and exposed by the local API.            |
| Editor resolution order                                                      | Explicit persisted Spyderbyte setting, `$VISUAL`, `$EDITOR`, detected `code`/`cursor`/`zed`/`subl`/`vim`/`nano`, and platform fallback are implemented and returned by `/v1/editors/resolve`.                                                                                                                |
| Classified change sets and review loop                                       | Change sets persist created, modified, deleted, and dependency/lockfile classifications; diff hunks support selected accept/revert, stale-head checks, manual edit, and `/v1/change-sets/{id}/refresh`.                                                                                                      |
| Local Python and managed runtime adapters                                    | Local Python runs use the bounded no-shell executor; managed Python runs resolve the selected runtime profile executable and validate its environment revision through the shared runtime-profile contract.                                                                                                  |
| Durable run evidence                                                         | Every repository execution persists code revision, environment revision, runtime, inputs, bounded logs, duration/exit metrics, outputs, artifact references, terminal status, and restart recovery state in `.agentic/repositories.json`. Failed, timed-out, cancelled, and recovered runs remain queryable. |
| Safety confirmations                                                         | Local API confirmation challenges cover file writes, move/delete, dependency installation, Python/test execution, commits, pushes, pull requests, merges, and other external or expensive effects. Capability descriptors gate filesystem, execution, and dependency surfaces.                               |

The acceptance journey is covered by the Repositories workbench and focused fixtures: register/open
directory or Git project → inspect tree/search/diff → create or refresh review → edit and accept or
revert selected hunks → run a bounded test or Python profile → inspect durable logs/metrics/output
and artifact fields → restart the runtime → recover the project, change set, and run record.

Focused evidence: `packages/provider-runtime/tests/phase2-repositories.test.ts` (directory and Git
filesystem, classifications, review refresh, execution evidence/restart recovery) and
`packages/local-api/tests/phase2.test.ts` (API routes and local confirmation boundary). Workspace
verification completed with `pnpm verify`: contract checks, formatting, lint and package-boundary
checks, typecheck (30/30 packages), tests (49/49 tasks), invariants (47/47 tasks), and builds
(30/30 tasks). `git diff --check` also passes.

### Phase 3 — JupyterLab and notebook vertical slice

**Objective:** Provide rich notebook authoring and visualization without recreating JupyterLab.

**Deliverables**

1. Add first-class notebook resources: create, import, duplicate, rename, archive, delete, restore,
   version, export, execute, open.
2. Add `JupyterSessionRequest` and durable session records containing project, notebook, user,
   environment revision, runtime, compute, endpoint, kernel IDs, status, activity, idle timeout,
   and associated runs.
3. Implement local Jupyter discovery/launch and managed-server provisioning behind a session
   service.
4. Bind sessions to short-lived scoped tokens; local mode binds to loopback by default.
5. Build the Spyderbyte JupyterLab extension for project identity, environment/runtime/model
   context, run-through-Spyderbyte, dataset/model browser, artifact publishing, lineage, cost,
   approvals, and experiment association.
6. Record interactive cell execution: notebook revision, cell ID, source hash, environment,
   runtime, inputs, outputs, errors, artifacts, and resource usage.
7. Implement reproducible notebook execution through a pinned notebook revision, dataset version,
   environment lockfile, runtime, compute profile, and parameter set.
8. Publish supported outputs (charts, tables, images, HTML, reports, executed notebooks) as
   immutable artifacts with lineage.
9. Implement session idle termination, restart, interrupt, reconnect, and crash recovery.

**Acceptance journey**

```text
TUI notebook create → notebook open → JupyterLab launch
→ execute cells with chart/table → publish artifact
→ close/reopen → notebook run from CLI → inspect run and lineage
```

**Exit gate:** a browser is required only for the rich Jupyter surface; credentials, authorization,
run state, artifacts, cost, and lineage remain Spyderbyte-owned.

**Phase 3 completion record (2026-08-06):** The notebook/Jupyter vertical slice is implemented
through the durable provider runtime and local control plane. Notebook resources now support
creation/import, duplication, rename, archive/restore/delete, immutable revisions, export/open,
cell execution, full pinned notebook runs, experiment associations, execution records, resource
usage, content-addressed artifact capture, and SQL lineage. Jupyter sessions now persist request
identity and project/notebook/user/runtime/environment/compute/kernel/activity metadata, support
loopback discovery and launch, an injectable managed-server adapter, short-lived scoped tokens
that are never persisted, idle termination, interrupt, restart, reconnect, and crash recovery.
The JupyterLab bridge owns the Spyderbyte context and routes execution, datasets, models,
approvals, usage/cost, lineage, artifact publication, and experiment association through the API.
The SDK and TUI expose the same lifecycle and acceptance journey, while rich rendering remains in
JupyterLab rather than being recreated in the product shell.

Evidence is covered by `packages/provider-runtime/tests/phase3.test.ts`,
`packages/local-api/tests/phase3.test.ts`, and
`packages/jupyter-extension/tests/phase3.test.ts`, alongside the existing artifact publication,
lineage, local confirmation, and Jupyter tests. `apps/api/contracts/api.v1.json` and
`apps/api/generated/openapi.v1.json` include the Phase 3 lifecycle/session/run routes. The final
workspace gates pass: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`,
`pnpm test:invariants`, `pnpm build`, and `pnpm api-contracts:check`.

### Phase 4 — Data and SQL loop

**Objective:** Connect, inspect, query, version, and analyze data with traceable lineage.

**Deliverables**

1. Add durable data source, connection, schema, table/file, dataset, dataset version, profile, and
   quality-result entities.
2. Add connection creation, secret-handle binding, health check, schema discovery, and revoke/
   reauthorize flows.
3. Build TUI data browsing: sources, schemas, fields, types, statistics, nulls, anomalies, and
   bounded row preview.
4. Implement SQL execution with connection selection, parameters, query history, saved queries,
   result preview, row/cost limits, cancellation, explain plan, export, and browser/Jupyter handoff.
5. Create immutable dataset versions; runs and experiments must reference versions, not mutable
   tables or files.
6. Connect Jupyter dataset access to the same connection and lineage services.

**Acceptance journey**

```text
connect source → discover schema → run bounded SQL → save/query result
→ publish immutable dataset version → analyze in JupyterLab
→ trace output back to source, query, and dataset version
```

**Exit gate:** destructive SQL is approval-gated; secrets are scoped and redacted; query results
are durable or explicitly ephemeral; lineage is inspectable.

### Phase 4 completion record — 2026-08-07

**Status: Complete for the local-first scope.** This is the product-plan Data and SQL loop; it is
distinct from the completed Harness Core and Invocation Enforcement Phase 4 documented in
`IMPLEMENTATION_PLAN.md`, `AGENTIC_PLATFORM_IMPLEMENTATION_PLAYBOOK.md`, and
`docs/contracts/spyderbyte-p4-capability-matrix.md`.

The local data catalog now owns the complete acceptance journey: durable source and connection
records, reference-only credential binding/revocation/reauthorization, health checks, schema and
table discovery with bounded previews and field statistics, immutable dataset versions, persisted
profiles and quality results, bounded read-only SQL, query history, saved-query revisions, result
exports, explain plans, cancellation, and expiring browser/Jupyter handoffs. Query records retain
connection, dataset-version, and result-artifact lineage; dataset versions retain source and prior-
version lineage. The persisted catalog is workspace-bound and written with restrictive file modes.

Implementation evidence:

| Requirement                                                                                 | Evidence                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Durable source/connection/schema/table/file entities and credential lifecycle               | `packages/provider-runtime/src/datasets.ts`; `/v1/data/sources`; `/v1/data/connections`; schema discovery persists table metadata; only credential references are stored or returned.                                             |
| Bounded SQL, row/cost limits, parameters, history, saved queries, cancellation, and explain | `packages/provider-runtime/src/query.ts`; `/v1/data/queries`; `/v1/data/saved-queries`; `packages/client-sdk/src/index.ts`; `apps/tui/src/index.ts`.                                                                              |
| Profiles, null/statistics/anomaly signals, quality results, immutable versions, and lineage | `DataProfileV1`, `DataQualityResultV1`, `DatasetVersionV1`, and lineage records in `packages/provider-runtime/src/datasets.ts`; persisted read-back routes for profile and quality results.                                       |
| Web, TUI, and Jupyter surfaces                                                              | `apps/web/src/screens/SQLWorkbench.tsx`; data/dataset/query commands in `apps/tui/src/index.ts`; data discovery/query/profile/quality/handoff commands in `packages/jupyter-extension/src/index.ts`.                              |
| Safety boundary                                                                             | Destructive SQL validation returns `approvalRequired: true` and execution remains disabled in the local runtime; source rows and secrets are not returned by connection metadata; exports are workspace-bound JSON/CSV artifacts. |

Focused acceptance evidence passed:

- `packages/provider-runtime/tests/phase4-data.test.ts` — connect → discover → health check →
  profile/quality → query immutable version → save revision → explain → export → handoff → restart
  and read back durable records; destructive SQL and over-cost queries fail closed.
- `packages/local-api/tests/phase4.test.ts` — API journey for the same flow, including destructive
  validation, credential lifecycle, profile/quality read-back, query result, export, and handoff.
- Client SDK and Jupyter extension tests cover the new route/method/command surfaces.
- `apps/web/src/screens/SQLWorkbench.tsx` restores the authoritative query/result/artifact record
  when opened through `/sql?queryId=...`; `apps/web/tests/app.test.tsx` covers the persisted handoff
  and verifies the SQL, row, and immutable artifact metadata after hydration.
- `pnpm api-contracts:check` and `pnpm frontend-contracts:check` pass after regenerating the
  contract outputs; focused provider-runtime, local-api, client-sdk, Jupyter, and TUI type checks
  pass (the SDK is built before consumers are typechecked so workspace declaration outputs are current).

The Phase 4 gates are therefore complete. The full workspace checks run for this record are green:
`pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm contracts:check`,
`pnpm api-contracts:check`, `pnpm frontend-contracts:check`, and `pnpm build`.

### Phase 5 — Experiments and model lifecycle

**Objective:** Make training, evaluation, comparison, and promotion reproducible.

**Deliverables**

1. Define experiment configuration for dataset/version, target, features, task, algorithm/base
   model, environment, compute, metrics, hyperparameters, seed, and output destination.
2. Implement experiment state: draft, validating, ready, running, completed, compared, promoted,
   archived.
3. Implement training and evaluation adapters using the unified run/attempt model.
4. Stream queue, provisioning, epoch/step, logs, loss, metrics, GPU/memory, checkpoints, cost,
   cancellation, retry, and failure events.
5. Publish checkpoints, metrics, evaluation results, plots, reports, and environment lockfiles as
   artifacts.
6. Add TUI summary comparison and browser/Jupyter rich comparison for curves, distributions,
   confusion matrices, explainability, and multi-metric views.
7. Add model registry records containing version, stage, source experiment, metrics, dataset
   lineage, validation/approval state, model card, and deployment history.
8. Make promotion a policy- and approval-aware effectful action.

**Acceptance journey:** train two variants from immutable inputs, compare metrics and artifacts,
promote one model, and recover the complete lineage later.

**Exit gate:** no model is promotable without reproducibility metadata, validation evidence, and an
auditable approval/policy decision.

**Phase 5 completion record (2026-08-06):** Phase 5 is complete through the durable local
`FileExperimentRuntime`, local API, client SDK/TUI, web Experiments screen, and JupyterLab bridge.
Experiment definitions pin tenant-scoped dataset and environment artifacts, compute, metrics,
hyperparameters, seed, and output destination; lifecycle transitions and unified run/attempt records
persist queue/provisioning/telemetry, logs, resources, cost, checkpoints, cancellation, retry,
failure, and restart-recovery evidence. Terminal checkpoints, metrics, evaluations, plots, reports,
environment lockfiles, comparison artifacts, and model artifacts are content-addressed and integrity
checked. Immutable comparisons expose multi-metric curves, distributions, confusion matrices, and
explainability; registry records preserve source experiment/run, dataset/environment lineage,
validation evidence, model cards, approval digests, deployment history, and immutable promotion
decisions. The API and personal-local effect boundary require validation evidence, policy approval,
and a current approval/commit digest before promotion.

Focused evidence: `packages/provider-runtime/tests/phase5-experiments.test.ts` covers two-variant
training, rich comparison, evaluation, registry promotion, cancellation, retry, failure, artifact
integrity, and restart recovery; `packages/local-api/tests/phase5.test.ts` covers the API lifecycle
routes. TUI `experiments compare`, browser comparison data, Jupyter comparison commands, and the
`experiments.lifecycle`/`models.registry` capability descriptors expose the same durable authority.
Workspace verification completed with `pnpm verify`; contract snapshots, formatting, lint/boundary
checks, typecheck, tests, invariants, and builds pass.

### Phase 6 — Pipelines, automations, and connectors

**Objective:** Turn successful interactive work into repeatable workflows.

**Deliverables**

1. Implement pipeline-as-code using versioned YAML or typed configuration.
2. Support connector, SQL, Python, notebook, inference, training, evaluation, visualization,
   artifact transformation, approval, condition, notification, and deployment nodes.
3. Add pipeline validation, versioning, publishing, dry-run/estimate, execution, node logs,
   retries, cache hits, dependency failures, inputs, outputs, artifacts, cost, and duration.
4. Implement connector registry, configuration, authentication, discovery, resource/schema
   selection, sync mode, destination, checkpoints, schema change events, and signed/versioned
   plugin validation.
5. Implement automations for cron, event, manual, webhook, data arrival, and repository triggers;
   include timezone, pause/resume, concurrency, retry, notification, and history.
6. Add idempotency and bounded backfill for scheduled execution.

**Acceptance journey:** take an interactive notebook/data workflow, publish it as a versioned
pipeline, execute manually, schedule it, observe each node, retry a failed node, and inspect every
run and artifact.

**Exit gate:** scheduling cannot create duplicate effectful work under retries; connector syncs
produce durable checkpoints and lineage; every node uses a registered adapter.

**Phase 6 completion record (2026-08-06):** Phase 6 is complete through the durable typed
`LocalPipelineRuntime`, `LocalAutomationRuntime`, connector registry, Meltano connector runtime,
local API, client SDK, TUI, and browser surfaces. Pipelines now persist typed definitions and
version history, validate DAGs against registered adapters for every required node type, publish
versions, estimate and dry-run, execute with inputs, outputs, artifacts, cost/duration/resource
usage, node logs, retries, cache hits, dependency-failure propagation, durable run inspection,
stage retry, and stable idempotency keys. Connector bindings now carry schema selection, auth
references, sync mode, destinations, and signed/version-pinned plugin metadata; discovery and
execution persist schema fingerprints, schema-change events, checkpoints, lineage, and duplicate
run suppression. Automations cover manual, interval/cron with timezone, webhook, event, data
arrival, and repository triggers with pause/resume, concurrency limits, retry/notifications,
history, idempotent dispatch, and bounded backfill.

Focused evidence: `packages/provider-runtime/tests/phase6.test.ts` covers versioned pipelines,
dry-run/estimate, adapter retries, dependency failures, scheduler idempotency, bounded backfill,
connector schema events, checkpoints, lineage, and duplicate suppression;
`packages/local-api/tests/phase6.test.ts` covers publish/estimate/dry-run/run inspection and
automation/connector routes. `apps/api/contracts/api.v1.json` and
`apps/api/generated/openapi.v1.json` expose the new pipeline, automation, and connector contracts;
the SDK, TUI, and web screens expose the same lifecycle. The final workspace gates pass:
`pnpm verify` (including contract snapshots, formatting, lint/boundary checks, typecheck, tests,
invariants, and build).

### Phase 7 — Deployment and serving

**Objective:** Move a registered model or artifact into an observable, approval-gated service.

**Deliverables**

1. Define deployment request with model/artifact version, serving runtime, region, CPU/GPU,
   scaling, environment, secrets, network visibility, auth, health checks, and rollout policy.
2. Implement deployment lifecycle: draft, validating, provisioning, deploying, healthy, degraded,
   failed, updating, stopped, archived.
3. Add endpoint management, health checks, request/latency/error metrics, utilization, cost,
   logs, revision history, and model version display.
4. Support rolling update, canary, promote, rollback, stop, restart, scale, and approval.
5. Add invocation and smoke-test runs that link endpoint traffic to the deployed model version.

**Acceptance journey:** deploy a promoted model, invoke it, observe health and logs, perform a
controlled update, detect degradation, and roll back to the previous revision.

**Exit gate:** no endpoint is reported healthy without a real serving adapter and health evidence;
traffic-changing operations are policy/approval gated.

**Phase 7 completion record (2026-08-07):** Phase 7 is complete through the durable local serving
runtime, local API, generated contracts, client SDK, TUI, Jupyter bridge, and Deployments web
surface. Deployment requests now carry model/artifact identity, runtime, region, resources,
scaling, environment and secret references, network/auth controls, health checks, and rollout
policy. The runtime persists lifecycle state, revisions, endpoint pointers, health evidence,
metrics, utilization, cost, logs, invocation/smoke-test records, and lifecycle events; it starts a
real configured serving adapter and downgrades stale processes instead of reporting them healthy.
Rolling updates, canary/promote, rollback, stop, restart, scale, and archive are exposed with
approval-bound traffic changes and endpoint-scoped telemetry.

Focused evidence: `packages/provider-runtime/tests/phase7-serving.test.ts` covers real adapter
startup, health evidence, invocation, smoke testing, controlled update, degradation detection,
approval-gated promotion, rollback, endpoint pointers, telemetry, and restart recovery;
`packages/local-api/tests/phase7.test.ts` covers the same journey through the API contract. The
SDK, TUI, Jupyter bridge, web Deployments screen, and API/OpenAPI snapshots expose the same
operations. Final workspace verification completed with `pnpm test` (30 packages, 49 tasks),
`pnpm test:invariants`, and the remaining contract, formatting, lint, typecheck, and build gates.

### Phase 8 — Collaboration, governance, and enterprise readiness

**Objective:** Make the platform governable for teams and regulated workloads.

**Deliverables**

- Organization/workspace/project roles and policy scopes.
- Data classifications and execution-time policy evaluation.
- Approval policies, budgets, forecast, thresholds, blocked actions, and cost attribution.
- Immutable audit records with actor, action, target, policy decision, before/after, run, interface,
  and approval context.
- SSO/SCIM, external secret managers, customer-cloud runners, retention, backup/restore, disaster
  recovery, support bundles, and shared Jupyter isolation.
- Browser views for administration, governance, usage, audit, and experiment/deployment detail.

**Exit gate:** administrators can govern provider access, runtime execution, data access, spend,
notebooks, pipelines, and deployment without bypassing the shared execution plane.

### Phase 8 completion record — 2026-08-07

Phase 8 is complete. The shared governance control plane in `packages/policy` now owns
organization/workspace/project membership and policy scopes, data-classification checks,
approval-bound commits, budgets, thresholds, forecasts, usage attribution, tenant-scoped
immutable audit chains, and audit verification. `packages/local-api` exposes the shared
governance, enterprise identity, secret-handle, hosted-runner, recovery, and retention routes;
personal-local mode fails closed for organization-only surfaces. Enterprise backends provide
SSO/SCIM session and deprovisioning boundaries, brokered/rotatable secret handles, and
tenant/quota/sandbox-checked customer-cloud execution targets. Recovery support includes the
existing backup/restore and legal-hold services plus retention/audit API exposure and sanitized
support-bundle evidence. Shared Jupyter session reads and lifecycle mutations enforce tenant
isolation.

The typed client SDK and API/OpenAPI snapshots expose the same contract. The browser now has
dedicated Governance, Usage, and Audit views with organization selection, member/policy
administration, budget/forecast/alert summaries, audit-chain verification, and evidence tables;
existing experiment and deployment detail views remain on the shared route surface. Focused
acceptance coverage is in `packages/policy/tests/governance.test.ts`,
`packages/backends/tests/phase8-enterprise.test.ts`, and `packages/local-api/tests/phase8.test.ts`.

Final evidence: `pnpm verify` passed with current generated contracts and formatting, 30/30
lint tasks plus package-boundary checks, 30/30 typecheck tasks, 49/49 test tasks, 47/47 invariant
tasks, and 30/30 build tasks including the desktop bundle.

## 5. Cross-cutting implementation workstreams

These workstreams run across all phases and must not be deferred until the end.

### A. Contracts, migrations, and compatibility

- Keep JSON Schema/OpenAPI and generated client types in sync.
- Version every wire contract and event envelope.
- Add forward/backward compatibility tests for clients and persisted records.
- Use additive migrations first; provide rollback or compatibility paths for breaking changes.
- Treat `pnpm verify` plus contract fixtures as the minimum merge gate.

**Workstream A local compatibility record — 2026-08-07:** **Complete for the local-first contract and
persisted-state scope.** Generated JSON Schema/OpenAPI outputs and the client-facing contract snapshot
are checked in lockstep. The data-catalog loader now migrates legacy connection/source records to
canonical v1 state, fills additive defaults, persists the upgraded record atomically, and preserves
source data across restart. Evidence: `packages/provider-runtime/src/datasets.ts`,
`packages/provider-runtime/tests/phase4-data.test.ts`, the generated API/client contract checks, and
the full `pnpm verify` gate. Hosted database migration/rollback fixtures remain an open hosted-plane
requirement and are not implied by this local record.

### B. Security and secret handling

- Store local secrets in OS keychain; hosted secrets behind encrypted storage or external manager.
- Pass secret references or brokered clients to adapters, never raw secrets to model context.
- Redact headers, query parameters, environment dumps, traces, logs, artifacts, and support bundles.
- Re-evaluate authorization, policy, budget, and approval at effectful commit time.
- Use short-lived scoped Jupyter/session tokens and loopback binding for local mode.
- Require confirmation challenges for deletion, external writes, destructive SQL, deployment,
  publishing, secret access, expensive training, repository push/merge, and public endpoints.
- Add dependency, image, runtime-package, and signed-plugin verification before release.

**Workstream B local security record — 2026-08-07:** **Complete for the local-first secret and
redaction scope.** Secret handles and audit records remain metadata-only, while the shared redaction
utility now covers sensitive fields, common assignments, environment-style keys, URL query
parameters, bearer credentials, database DSNs, private-key markers, and known secret values.
Observability and local diagnostic/support-bundle paths use the same text/JSON redaction boundary.
Evidence: `packages/runtime-contracts/src/redaction.ts`,
`packages/observability/src/index.ts`, `packages/local-api/src/index.ts`,
`packages/observability/tests/observability.test.ts`, and
`packages/local-api/tests/redaction.test.ts`. Hosted KMS/secret-manager integration and release-time
dependency/image/plugin verification remain hosted/release gates.

The provider-secret Keychain adapter contract is now also covered locally: `MacOsKeychainVault`
defaults to direct `/usr/bin/security` calls, exposes only a deterministic command-runner seam for
tests, verifies put/get/delete argument mapping, and refuses access on non-macOS hosts. Evidence:
`packages/provider-runtime/src/oauth.ts` and
`packages/provider-runtime/tests/phase1.test.ts`. Clean-machine Keychain permission/receipt
behavior inside the signed desktop build remains a release gate.

The first-run provider setup surface is now connected to the same boundary: the Models screen can
create a provider configuration, submit a credential only to the local API, clear the secret after
submission, display metadata-only credential state, and run the existing provider preflight route.
Evidence: `apps/web/src/screens/Models.tsx`, `apps/web/tests/app.test.tsx`, and
`packages/local-api/tests/phase2.test.ts`. Signed clean-machine persistence and Keychain permission
evidence remain open.

### C. Reliability and recovery

- Idempotency keys on every effectful command.
- Lease-based worker recovery and explicit retry ownership.
- Durable outbox and event replay.
- Cancellation propagation through API, orchestrator, worker, runtime, notebook kernel, and serving
  process.
- No orphaned runs, sessions, workers, or artifacts after crash/restart scenarios.
- Backup, restore preview, migration recovery, and workspace portability tests.

**Workstream C local reliability record — 2026-08-07:** **Complete for the current local-first
state, worker, and event boundary.** Effectful command dispatch reserves tenant-scoped idempotency
keys and commits events plus outbox rows atomically; the new transactional outbox dispatcher retries
publication, bounds batches, preserves tenant isolation, and acknowledges rows only after transport
success. Worker leases already cover heartbeat, expiry, redelivery, explicit retry ownership, and
replacement-worker recovery. Durable workflow tests cover cancellation propagation, late completion
suppression, retry attempts, process-kill recovery, event cursor replay, and retention gaps; SQLite
recovery tests cover committed workflow/event/outbox restoration. Evidence: `packages/runtime-domain/src/outbox.ts`,
`packages/runtime-domain/tests/outbox.test.ts`, `packages/runtime-domain/tests/dispatcher.test.ts`,
`packages/runtime-domain/tests/workflow-engine.test.ts`, `packages/backends/src/worker-pool.ts`,
`packages/backends/tests/worker-pool.test.ts`, and `packages/state/tests/sqlite-recovery.test.ts`.
Durable multi-process outbox claiming is now covered at the shared state boundary: SQLite uses an
atomic claim transaction with legacy-column migration, PostgreSQL uses row locks with
`SKIP LOCKED`, and the in-memory adapter shares the same ownership/reclaim contract. Evidence:
`packages/state/src/ports.ts`, `packages/state/src/sqlite-store.ts`,
`packages/state/src/postgres-store.ts`, `packages/state/tests/state-contract-suite.ts`, and the
replacement-dispatcher recovery test in `packages/runtime-domain/tests/outbox.test.ts`.
Hosted transport/poison-message operations, full cross-product failure-injection, and hosted
disaster-recovery exercises remain hosted/release gates.

### D. Observability

Every execution path emits structured logs, traces, metrics, correlation IDs, run IDs, provider
request IDs, queue depth, latency, retries, cost, runtime utilization, and failure classification.

Minimum projections:

- run status and attempts;
- logs/events/progress/metrics;
- artifacts and lineage;
- approval and policy decisions;
- usage/cost;
- provider/runtime health;
- Jupyter session/kernel state;
- pipeline node state;
- deployment health and revision history.

**Workstream D local observability record — 2026-08-07:** **Complete for the local diagnostics and
release-evidence boundary.** Correlation contexts, append-only tamper-evident audit records,
redacted structured logs, redacted trace-span lifecycle, in-memory telemetry summaries, capacity
probes, SLO evaluation, and rollout-gate evidence are now covered by provider-neutral primitives and
tests. Logs and spans preserve correlation and provider-request fields while sharing the runtime
redaction utility with audit/support paths. Evidence: `packages/observability/src/index.ts`,
`packages/observability/src/release-gates.ts`, `packages/observability/tests/observability.test.ts`,
`packages/observability/tests/release-gates.test.ts`, and the full `pnpm verify` gate. Production
exporters, retention, hosted tracing/metrics backends, and operations SLO approval remain
operations/hosted gates.

### E. TUI/CLI parity

The TUI and CLI call the same application services. Required command families:

```text
spyderbyte
spyderbyte project create|open
spyderbyte provider add|test|list
spyderbyte models list|refresh
spyderbyte run script <file>
spyderbyte query <file>
spyderbyte notebook create|open|run|export
spyderbyte train <config>
spyderbyte pipeline validate|run
spyderbyte automation list|pause|resume
spyderbyte deploy <model-or-artifact>
spyderbyte runs inspect|logs --follow|cancel|retry
spyderbyte artifacts list|inspect|open|export
spyderbyte doctor
```

The interactive shell adds slash commands such as `/project`, `/files`, `/notebooks`, `/data`,
`/sql`, `/runs`, `/artifacts`, `/provider`, `/runtime`, `/environment`, `/usage`, and
`/diagnostics`.

**Workstream E completion record — 2026-08-07:** **Complete for the local-first terminal scope.**
The TUI and CLI now route the required command families through the shared client SDK: provider and
model setup, project and run operations, file-backed scripts and SQL, notebook export, training
configs, pipeline and automation operations, deployment shorthand, artifact list/inspect/open/export,
Jupyter lifecycle, data/dataset/experiment/connector operations, and diagnostics. Interactive slash
commands normalize to the same service-backed command paths. Script execution remains bounded by the
repository test allowlist and local confirmation boundary; SQL remains bounded and read-only; artifact
export uses the immutable content route and writes only the explicitly requested local output.

Evidence: `apps/tui/src/index.ts`, `apps/tui/tests/command-parity.test.ts`,
`packages/client-sdk/src/index.ts`, `packages/client-sdk/tests/client-sdk.test.ts`, the repository
test route in `packages/local-api/src/index.ts`, and the artifact catalog/content routes in the same
API. Focused TUI, SDK, local-API, provider-runtime, typecheck, and API-contract checks pass.

## 6. Initial release scope

### Required for v1

- CLI/TUI shell and noninteractive command routing.
- Local-only mode and existing local workspace/daemon lifecycle.
- Workspace/project create, open, import, export, and recovery.
- Provider configuration and secure credentials.
- OpenAI, Anthropic, OpenAI-compatible, one local provider, deterministic test provider.
- Provider test, model discovery, catalog, selection, and capability reporting.
- Agent sessions, plan review, approvals, file navigation, external editor, diff review.
- Local Python execution and one hosted-compatible runtime interface.
- Durable runs, attempts, events, logs, metrics, cancellation, retry, and diagnostics.
- Notebooks, local JupyterLab, session lifecycle, cell metadata, reproducible notebook execution.
- Artifact publication and basic lineage.
- Supported data upload/connection, bounded SQL, immutable dataset versions.
- Basic automations only if their scheduler and retry semantics are real.
- Signed macOS distribution, license validation, Keychain integration, backup/restore, and clean-
  machine release evidence where the desktop product is part of the release.

### Beta after the core loop is stable

- Training, evaluation, checkpoints, model registry, promotion.
- Hosted JupyterLab and hosted runtime.
- Advanced connectors and shared Jupyter sessions.
- Browser experiment comparison.
- Deployment and serving.
- Workspace budgets and richer governance.

### Defer

- Custom graphical code editor.
- Custom notebook editor.
- Visual pipeline canvas.
- Full browser ML IDE.
- Collaborative text editing.
- Advanced deployment dashboards.
- Broad provider/connector catalog before adapter reliability is proven.

## 7. Prioritized backlog

### P0 — must unlock the first durable loop

1. Record the product-surface ADR and Phase 0 capability matrix.
2. Finalize provider, credential, model, runtime, environment, run, attempt, event, artifact, and
   approval schemas.
3. Implement encrypted/Keychain credential storage and redaction tests.
4. Implement provider configuration APIs, adapter factory, tests, discovery, health, and usage.
5. Replace fixed model catalog with provider-derived models and selection hierarchy.
6. Add shared typed client/application services.
7. Build the TUI shell and CLI routing.
8. Implement project create/open and provider/model setup in the TUI.
9. Implement durable model invocation runs and reconnectable event streaming.
10. Add run detail, logs, diagnostics, cancellation, retry, and failure reporting.
11. Remove or disable projection-only execution controls.

### P0 delivery status — 2026-08-06

The first durable terminal loop is implemented in the repository. The following ledger is the
acceptance evidence for this P0 slice:

| Item                                                             | Status   | Evidence                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product-surface decision and capability boundary                 | Complete | `docs/adr/ADR-0034-spyderbyte-terminal-first-product-surface.md` and `docs/contracts/spyderbyte-capability-matrix.md` define the terminal-first authority and the non-authoritative SQL preview boundary.                                                                                                                                                      |
| Provider, credential, model, run, attempt, and runtime contracts | Complete | `packages/runtime-contracts` source, generated JSON/Markdown artifacts, and contract generation checks. Existing event, artifact, approval, and environment contracts remain the shared authority.                                                                                                                                                             |
| Credential storage and redaction                                 | Complete | Provider credentials persist as metadata-only records; secret values use the platform vault (`MacOsKeychainVault` on macOS and an injectable memory vault for tests/non-macOS); provider tests assert secrets do not enter the durable configuration file, and the Keychain adapter suite verifies direct `security` command mapping plus non-macOS refusal.   |
| Provider configuration and adapter lifecycle                     | Complete | `ProviderConfigurationService`, OpenAI-compatible and Anthropic HTTP transports, discovery, health/test, usage, refresh, safe API routes, and mocked transport coverage.                                                                                                                                                                                       |
| Provider-derived catalog and selection                           | Complete | Configured models populate the catalog and router; the deterministic local fixture is seeded as durable metadata, and uncustomized routing places configured providers ahead of the fixture.                                                                                                                                                                   |
| Shared client/application boundary                               | Complete | `packages/client-sdk` owns typed REST calls, safe errors, SSE cursor replay/reconnect, and terminal run following.                                                                                                                                                                                                                                             |
| TUI and CLI routing                                              | Complete | `apps/tui` exposes doctor, provider/model setup, project list/create/open, run prompt/list/show/logs/cancel/retry, and an interactive shell over the same SDK.                                                                                                                                                                                                 |
| Durable model invocation loop                                    | Complete | Conversation submission persists `Run`, `RunAttempt`, invocation, chat events, run logs, outbox events, and terminal state; the local API exposes point reads and SSE replay.                                                                                                                                                                                  |
| Run operations and diagnostics                                   | Complete | Run detail/log routes, health/provider/model diagnostics, cancellation, failed-run retry, failure records, terminal reconciliation, and focused daemon/API tests are present.                                                                                                                                                                                  |
| Projection-only execution controls                               | Complete | The legacy browser compatibility SQL/results wireframe remains labeled preview content; the canonical routed React SQL Workbench now executes the local bounded-query slice, persists query/result/artifact records, and hydrates `/sql?queryId=...` from the authoritative API. Provider/model-backed project execution and live-run projections remain open. |

Verification completed for this ledger: `pnpm verify` passes the contract, API, frontend snapshot,
format, lint/boundary, typecheck, test, invariant, and build gates across all 30 workspace tasks.
The separate `pnpm test:integration` suite also passes all 47 tasks. `git diff --check`, the local
dependency script syntax checks, and the local Docker Compose config check pass. The default
desktop build verifies the application bundle; DMG packaging is an explicit release operation via
`pnpm --filter @agentic-platform/desktop bundle:dmg` and is not part of the portable default gate.

### Phase 0 completion record — 2026-08-06

Phase 0 is complete. The repository now has an authoritative inventory and first-release command
map covering provider configuration, credentials, model discovery and selection, projects, runs,
capabilities, artifacts, SQL, notebooks, runtimes, connectors, data, pipelines, automations,
experiments, deployments, visualizations, governance, and licensing. Each visible command is
classified as real, projection-only, mocked, local-only, experimental, or incomplete, with its
route/service/adapter, durable state, event, retry/cancel behavior, and error contract recorded.

The capability authority is documented in `docs/adr/ADR-0035-phase-zero-capability-authority.md`
and the local dependency composition in `docs/adr/ADR-0036-local-dependency-composition.md`.
Canonical runtime contracts, generated JSON, and shared fixtures cover providers, credentials,
models, runtime profiles and environment revisions, runs and attempts, events, artifacts,
approvals, notebooks/cells, and Jupyter sessions. The runtime capability projection is exposed
through `/v1/capabilities`; the web page registry and `CapabilityGate` hide or label unsupported
surfaces, and the TUI/CLI route commands through the typed SDK boundary with only the documented
local-daemon bootstrap exception.

The local dependency path is reproducible through the pinned Compose stack and `dev-up`,
`dev-down`, `dev-reset`, and `dev-health` scripts. CI runs the frozen install, full verification,
whitespace check, integration suite, dependency audit, and secret scan. The Phase 0 exit gate is
therefore evidenced by `pnpm verify` (30/30 tasks successful, 49 tests, 47 invariants),
`pnpm test:integration` (47/47 tasks successful), `git diff --check`, shell syntax validation,
and `docker compose -f deploy/local/docker-compose.yml config --quiet`.

### P1 — coding and notebook loop

1. Project filesystem abstraction and external editor resolution.
2. Agent change sets, diff review, selected-hunk acceptance, revert, and test execution.
3. Runtime profiles, environment revisions, local Python execution, and artifact capture.
4. Notebook and Jupyter session schemas.
5. Local Jupyter discovery/launch and session service.
6. JupyterLab extension with scoped auth and project/runtime context.
7. Notebook execution adapter, cell records, artifact publishing, and lineage.
8. Safety confirmations and effectful action review.

**P1 completion record (2026-08-06):** The local-first coding and notebook loop is implemented
across the provider runtime, local API, web workbench, and version-neutral JupyterLab bridge. The
delivery includes project file previews and editor resolution, durable change sets with selected
hunk accept/revert, bounded local test execution, runtime profiles and immutable environment
revisions, managed loopback Jupyter sessions with short-lived scoped tokens, Python/SQL notebook
execution, content-addressed notebook artifacts with query lineage, and action-bound local safety
confirmations. Contract outputs are generated and checked. P1-focused verification passes in the
provider-runtime (32 tests), local-api (4 tests), policy (8 tests), jupyter-extension (2 tests),
runtime-contracts (78 tests), and web (41 tests) suites, plus the workspace typecheck. The full
workspace test sweep still has one unrelated local-daemon smoke-test failure when no model is
discovered, and the boundary checker still reports the pre-existing TUI-to-local-daemon app
dependency.

### P2 — data, ML, and repeatability

1. Data connections, schema browser, SQL execution, result viewer.
2. Immutable dataset versioning and lineage.
3. Structured experiments, training adapter, metrics, checkpoints, evaluation.
4. Model registry and promotion workflow.
5. Pipeline-as-code and validation.
6. Connector sync history and checkpointing.
7. Automation scheduling, retries, notifications, and concurrency policy.

**P2 completion record (2026-08-06):** The local-first P2 backlog is implemented. Durable data
connections, schema browsing, bounded read-only SQL, query history, immutable dataset versions,
and lineage are available through the provider runtime and local API. Structured experiment state,
training-process recovery, metrics/checkpoints, deterministic evaluation, tenant-bound model
candidate registration, approval-bound promotion, pipeline source files/plans/validation,
connector sync history/checkpoints, and automation retry/notification/idempotency/concurrency
semantics are implemented with restart-safe state. Focused verification covers the full P2 path in
`packages/provider-runtime/tests/p2-runtime.test.ts` and `packages/backends/tests/p2.test.ts`.

### P3 — production scale and enterprise

1. Serving runtime, endpoint management, health, canary, rollback.
2. Organization/workspace budgets and cost policy.
3. Agent definitions and advanced routing.
4. Customer-cloud execution and hosted worker pools.
5. SSO/SCIM and enterprise secret managers.
6. Advanced governance, retention, disaster recovery automation, and browser collaboration.

**P3 completion record (2026-08-06):** The production-scale and enterprise backlog is implemented
as provider-neutral contracts, deterministic reference services, hosted adapter boundaries, and a
tenant-scoped API/SDK surface. Serving endpoints now enforce deployment state transitions, fresh
approval for traffic changes, health thresholds, canary progression, and rollback. Scoped budgets
serialize organization/workspace reservations, reconcile unused capacity, emit limit alerts, and
apply model provider/cost/retry policy. Agent definitions support capability/data-class filtering,
cohort rollout, shadow candidates, bounded leases, and rollback. Hosted execution supports
Kubernetes/Slurm/customer-cloud targets with network allowlists, sandbox limits, quotas, and
tenant-scope checks; the existing worker-pool and secret-broker contracts remain the injection
points for real schedulers and secret managers. Enterprise identity includes HTTPS-only OIDC/SAML
provider registration, state-bound login, session revocation, and SCIM deprovisioning; enterprise
secret handles are versioned, TTL-bound, operation-scoped, rotatable, revocable, and never expose
values in audit records. Recovery services enforce digest verification, secret-shaped field
rejection, legal-hold retention, approval-bound idempotent restore, and restore exercises.
Collaboration supports tenant-scoped optimistic writes, conflict records, presence TTLs, and audit.

The new control-plane routes are declared in `apps/api/contracts/api.v1.json`, implemented by the
optional `productionScale` bundle in `packages/local-api`, and exposed through
`packages/client-sdk`. SSO callbacks and secret resolution intentionally remain hosted-only
operations; the local API can consume the resulting authenticated/handle-based boundaries without
accepting untrusted identity claims or returning secret material. Vendor account provisioning,
Kubernetes/Slurm bindings, and customer-cloud credentials are deployment-time adapter work rather
than hidden local test assumptions. Evidence is tracked in
`docs/contracts/spyderbyte-p3-capability-matrix.md` and `docs/adr/ADR-0037-p3-production-scale-and-enterprise-boundaries.md`.

## 8. Verification strategy

### Contract tests

- OpenAPI/request/response/error/pagination compatibility.
- Event ordering, cursor replay, deduplication, and terminal reconciliation.
- CLI-to-API parity and Jupyter extension compatibility.
- Migration upgrade/downgrade or compatibility behavior.

### Provider tests

For every provider adapter: credentials, discovery, minimal request, streaming, tool support where
available, timeout, rate limit, revocation, invalid endpoint, fallback policy, usage, and error
classification. Use deterministic fixtures for CI and live smoke tests only in a controlled opt-in
environment.

### Runtime tests

For every runtime: preflight, provisioning, environment creation, Python/notebook execution, logs,
artifacts, cancellation, timeout, unavailable runtime, insufficient resources, crash recovery, and
lease recovery.

### Jupyter tests

- Local discovery and managed provisioning.
- Scoped token authentication and secret isolation.
- Extension load, project identity, kernel startup, cell execution, interrupt, restart, save,
  artifact publishing, full notebook run, idle timeout, disconnected recovery, and server crash.

### TUI/CLI tests

- Narrow/wide terminals, resize, keyboard navigation, color-disabled output, SSH, tmux, reconnect,
  shell completion, noninteractive fallback, accessibility-oriented output, and bounded logs.

### End-to-end journeys

1. Configure OpenAI and run a prompt.
2. Configure a local model and run a prompt.
3. Import a repository, modify code, review the diff, and execute.
4. Create a notebook, open JupyterLab, execute a cell, and publish a chart.
5. Run a notebook reproducibly from the CLI.
6. Connect data, run SQL, create a dataset version, and inspect lineage.
7. Train and compare two experiments.
8. Create and execute a pipeline.
9. Schedule an automation and inspect its history.
10. Deploy a model, invoke it, and roll back.
11. Cancel and retry a failed run.
12. Approve a high-risk action and verify the action digest.
13. Enforce a workspace/provider/agent budget.
14. Quit/relaunch/reconnect and recover all durable state.

### Failure injection

Inject provider outage, expired credential, worker crash, database restart, network interruption,
corrupt environment, storage failure, duplicate queue delivery, event reconnect, partial artifact
upload, Jupyter server crash, kernel crash, browser closure, and deployment failure. The expected
result is an explicit recoverable state, not a false success or orphaned record.

## 9. Release gates

### Functional gate

The first-release journey passes end to end with real adapters for provider setup, model invocation,
project creation, agent code modification, Python execution, notebook creation, Jupyter launch,
notebook execution, artifact publication, run inspection, and dataset/query support.

### Reliability gate

- Effectful commands are idempotent.
- Worker leases recover.
- Retries do not duplicate external side effects.
- Logs/events/artifacts are durable and replayable.
- Cancellation reaches the execution boundary.
- No orphaned runs, sessions, or artifacts after injected failures.
- Backup/restore and migration recovery are demonstrated.

### Security gate

- Credentials are encrypted or Keychain-backed.
- Secrets are absent from model context, logs, traces, artifacts, and support bundles.
- Tenant/workspace/project isolation is enforced at command and repository boundaries.
- Destructive and expensive actions require explicit approval.
- Jupyter uses scoped short-lived tokens and isolated sessions.
- Dependencies, runtime packages, and connector plugins are verified.

### Observability gate

Every execution exposes structured logs, traces, metrics, correlation/run IDs, provider request IDs,
queue state, latency, retry/failure state, cost/usage, runtime utilization, and session/kernel
health where applicable.

### UX gate

No primary workflow requires opaque IDs, arbitrary JSON, hidden environment variables, backend
configuration edits, manual Jupyter startup, or interpretation of a generic failure. Advanced users
may use YAML/JSON and direct runtime settings.

## 10. Risks and mitigations

| Risk                                                         | Impact                                     | Mitigation                                                                                      |
| ------------------------------------------------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Existing browser work expands faster than terminal execution | Core product loop remains incomplete       | Keep TUI/CLI vertical slice as the release-critical path; gate UI work on authoritative APIs    |
| Provider APIs differ in capabilities and failure semantics   | Misleading model catalog or brittle runs   | Capability adapters, structured preflight, explicit routing decisions, provider contract tests  |
| Jupyter becomes an independent control plane                 | Credential, policy, and lineage drift      | Short-lived scoped sessions; Spyderbyte-owned run/artifact/session records; extension bridge    |
| Retries duplicate external writes                            | Data corruption or duplicate cost          | Idempotency keys, effect receipts, commit-time policy checks, explicit retry ownership          |
| Notebook exploration cannot be reproduced                    | Invalid experiments and weak lineage       | Pin notebook revision, cell/source hashes, environment lockfile, dataset version, runtime, seed |
| Local and hosted behavior diverges                           | Migration and support failures             | Shared JSON Schema, client SDK, adapter contract tests, local/hosted conformance suite          |
| Secrets leak through logs or agent context                   | Security and compliance incident           | Secret handles, brokered clients, redaction at boundaries, support-bundle scanning              |
| Scope becomes a complete IDE/platform rewrite                | Delayed release and fragile surface        | Defer custom editors, visual pipeline canvas, broad dashboards, and provider expansion          |
| Desktop product and terminal product compete                 | Confused architecture and duplicated state | Desktop hosts local runtime; TUI/CLI/Jupyter/web all consume shared services                    |

## 11. First implementation tranche

The next tranche should produce the first real terminal loop before adding new horizontal resources.

1. Add the product-surface ADR and capability matrix.
2. Read the existing contract/projection implementation and identify the smallest missing run path.
3. Finalize provider/configuration/model/runtime/run schemas and migrations.
4. Implement provider credential lifecycle through the existing Keychain/license boundaries.
5. Implement provider preflight and deterministic provider fixtures.
6. Implement one real provider adapter and one local-provider adapter behind the factory.
7. Add typed provider/model/run clients and event subscription/replay.
8. Scaffold `apps/tui` or `apps/cli` using the shared client services.
9. Implement workspace/project selection and provider/model setup in the TUI.
10. Submit a prompt as a durable run, stream events, show logs, and persist the result.
11. Add cancellation, retry, reconnect, and return-later run inspection.
12. Run the Phase 1 gate with deterministic CI fixtures and a controlled live-provider smoke test.

Do not start notebook, experiment, pipeline, or deployment UI work until this tranche passes. Those
resources should consume the same run/event/artifact machinery rather than introduce parallel
execution semantics.

## 12. Final handoff checklist

Before calling the product production-ready, attach evidence for:

- supported install and launch paths;
- local/sign-in onboarding;
- provider setup, validation, discovery, and secure credential storage;
- runtime/environment preflight;
- TUI and CLI parity;
- project/file/editor/change-set workflow;
- real model/Python/query/notebook execution;
- durable runs, attempts, events, logs, metrics, cost, cancellation, retry, and reconnect;
- Jupyter session lifecycle and scoped authentication;
- artifact immutability, checksums, lineage, export, and restore;
- data and dataset-version lineage;
- experiment comparison and promotion if enabled;
- pipeline/automation history if enabled;
- deployment health/rollback if enabled;
- audit, policy, budget, and approval behavior;
- failure-injection results;
- security scans and secret-redaction evidence;
- backup/restore, migration, and clean-machine release evidence.

The dividing line is simple: a platform record or polished card is not a production capability. A
capability is complete only when a user can invoke it, observe it, recover it, inspect its outputs,
and reproduce it through the same authoritative execution plane.
