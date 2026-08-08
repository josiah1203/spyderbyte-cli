# Spyderbyte Declarative Implementation Plan

**Status:** Authoritative going-forward plan  
**Version:** 1.0  
**Date:** 2026-08-07  
**Repository:** `/Users/josiah/aug`  
**Product:** Spyderbyte  
**Canonical executable:** `spyderbyte`

This document supersedes the execution authority of:

- [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md);
- [`SPYDERBYTE_PRODUCTION_IMPLEMENTATION_PLAN.md`](SPYDERBYTE_PRODUCTION_IMPLEMENTATION_PLAN.md);
- [`AGENTIC_PLATFORM_IMPLEMENTATION_PLAYBOOK.md`](AGENTIC_PLATFORM_IMPLEMENTATION_PLAYBOOK.md).

Those documents remain historical implementation records and evidence sources. New work, status
updates, phase decisions, and completion records must be made here. If an older document conflicts
with this one, this plan wins unless a newer ADR explicitly changes it.

The required Codex source audit is recorded in
[`CODEX_MIGRATION_MATRIX.md`](CODEX_MIGRATION_MATRIX.md). No Codex-derived source has been
imported by this plan.

## 1. Purpose and operating contract

Spyderbyte is a conversation-first computational and operational intelligence platform. It turns
files, datasets, databases, documents, code, models, APIs, organizational systems, and human
instructions into analyses, visualizations, notebooks, reports, models, decisions, workflows,
automations, software changes, and deployable artifacts.

The product experience is:

```text
Ask → Understand → Inspect → Plan → Estimate → Approve → Execute
    → Observe → Explain → Inspect artifacts → Modify → Save → Repeat
```

The implementation agent must follow these rules for every change:

1. Read this plan and select the first incomplete phase whose prerequisites are satisfied.
2. Inspect current files and preserve unrelated user changes.
3. Treat `packages/runtime-contracts` and the authoritative backend services as the domain source
   of truth; clients render and request, but do not decide.
4. Implement the smallest complete vertical increment: contract, implementation, tests, evidence,
   and plan status update together.
5. Do not import or adapt Codex source until Phase 0 migration evidence and the required ADRs are
   complete.
6. Do not mark a phase complete when a path is simulated, projection-only, unverified, or blocked
   by an unresolved security, licensing, product, topology, or commercial decision.
7. Preserve authority, approval, audit, artifact immutability, lineage, secret isolation, budget,
   cancellation, and recovery invariants even when a UI or test is incomplete.
8. Stop at explicit human decision gates involving source licensing, product scope, security
   posture, cloud vendors, billing, commercial policy, or release credentials.

### Status vocabulary

| Status          | Meaning                                                                                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Complete**    | The stated scope has implementation and passing evidence. A local completion is labeled local when hosted, signed-release, or customer-infrastructure proof remains. |
| **In progress** | Some implementation and evidence exist, but the phase exit gate is not satisfied.                                                                                    |
| **Planned**     | Requirements and approach are accepted; implementation has not started.                                                                                              |
| **Deferred**    | Intentionally sequenced later; no partial implementation should be represented as complete.                                                                          |
| **Blocked**     | A required external decision, credential, source artifact, or environment is unavailable.                                                                            |
| **Rejected**    | Explicitly excluded from the product or replaced by another boundary.                                                                                                |

## 2. Source requirements and reconciliation

This plan consolidates:

1. `Spyderbyte Product Requirements Document — CLI/TUI, ACP Agent Interface, Commercial Model,
and Hosted Execution Platform` (pasted source, version 1.0).
2. `Spyderbyte CLI/TUI Replatforming PRD — Codex CLI Shell Adoption and Spyderbyte Runtime
Integration` (pasted source, version 1.0).
3. The current Spyderbyte implementation in `/Users/josiah/aug`.
4. The available Codex checkout at `/Users/josiah/Downloads/codexcli-main`.

The requirements are reconciled as follows:

| Requirement                 | Declarative decision                                                                                                                                                                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex shell adoption        | Codex-derived code supplies terminal interaction primitives only. Spyderbyte owns the agent, clients, domain, policy, Runs, providers, runtimes, artifacts, billing, identity, telemetry, configuration, and updates.                                                                     |
| Existing Cline-derived code | `packages/cline-adapter` remains a compatibility boundary during migration. It is not the final Spyderbyte Agent and cannot own tools, policy, sessions, or Runs.                                                                                                                         |
| Conversation-first product  | The CLI/TUI is the primary daily control surface. Web and desktop are rich artifact, visual inspection, administration, and distribution surfaces, not competing control planes.                                                                                                          |
| Universal execution         | Every material action becomes one Spyderbyte `Run`, with `ExecutionAttempt` records for retries. Codex turns, rollouts, or ACP requests are not alternate execution entities.                                                                                                             |
| Local-first product         | Local-only mode works offline without a Spyderbyte account. BYOK and local models remain first-class. Cloud state is lazy and optional until requested.                                                                                                                                   |
| Cloud                       | Local, customer-owned, and Spyderbyte-managed execution use the same contracts. Initial hosted adapters may target OpenRouter, Modal, Postgres, R2, a durable workflow provider, Stripe, and OpenTelemetry/Sentry, but vendor names never become domain types.                            |
| ACP                         | `spyderbyte acp` is a transport adapter over the same `AgentSession` and Agent events as TUI, CLI, and API. ACP is not the business-logic layer and Codex app-server protocol is not ACP authority.                                                                                       |
| Commercial model            | Individual platform use is free; personal BYOK/local/customer infrastructure is not platform-metered. Spyderbyte-managed resources are usage-priced. Organizations pay annual platform fees for shared operation, governance, administration, identity, policy, audit, and collaboration. |
| Scope discipline            | Do not build a full browser IDE, custom notebook implementation, Tableau-class BI, spreadsheet competitor, proprietary chart language, default Kubernetes platform, or dozens of hosted integrations in the initial release.                                                              |

## 3. Product and architecture invariants

### 3.1 Authority and boundaries

```text
Codex-derived terminal primitives
              ↓
Spyderbyte shell and renderers
              ↓
Spyderbyte typed clients and protocol
              ↓
Spyderbyte AgentSession / AgentTransport
              ↓
Spyderbyte control plane
              ↓
Runs, policy, approvals, budgets, events, artifacts, usage
              ↓
Inference providers and compute providers
              ↓
Local, customer-owned, or Spyderbyte-managed execution
```

The shell must never decide:

- provider or model selection;
- local versus hosted execution;
- notebook or SQL execution semantics;
- approval requirements or policy outcomes;
- budget and cost truth;
- permission or workspace boundaries;
- retry ownership;
- artifact storage or lineage;
- secret resolution;
- durable state transitions.

The shell may request, render, filter, and offer user actions based on typed backend responses.

### 3.2 Durable domain entities

The backend owns these resources and their histories:

```text
Organization
└── Workspace
    ├── members, identity, policies, providers, credentials, runtimes, environments, budgets
    └── Project
        ├── AgentSession / Conversation / messages
        ├── files, repositories, connections, datasets, queries, notebooks
        ├── plans, approvals, Runs, Attempts, events, logs, usage
        ├── artifacts, versions, lineage, visualizations
        ├── experiments, models, deployments, pipelines, automations
        └── audit and recovery records
```

Clients own only drafts, temporary selections, layout, cached rendering, and optimistic
presentation state.

### 3.3 Universal Run model

Every material action creates or attaches to a durable `Run`, including:

- prompt and agent execution;
- shell commands, Python, SQL, notebooks, and notebook cells;
- data transforms, profiles, quality checks, visualizations, and reports;
- training, evaluation, deployment, inference, connector synchronization, and automations;
- repository operations and approved file/configuration changes.

The logical request is:

```ts
interface ExecutionRequest {
  runId: string;
  actor: Actor;
  project: ProjectRef;
  interface: 'cli' | 'tui' | 'acp' | 'api' | 'jupyter' | 'web' | 'automation';
  action: string;
  inputs: ArtifactReference[];
  environment: EnvironmentRevision;
  runtime: RuntimeProfile;
  computeRequirements: ComputeRequirements;
  networkPolicy: NetworkPolicy;
  secrets: SecretReference[];
  limits: ExecutionLimits;
  estimatedCost?: CostEstimate;
}
```

It is planned into an `ExecutionPlan`, attempted through one or more `ExecutionAttempt` records,
and reconciled into a typed result, artifact set, usage events, and audit record.

Required states:

```text
draft → validating → awaiting_configuration → awaiting_approval
     → queued → provisioning → running → finalizing → succeeded

terminal: failed | cancelled | timed_out | partially_succeeded
```

Required event families include `assistant.delta`, `plan.created`, `approval.required`,
`run.started`, `run.progress`, `log.appended`, `artifact.created`, `usage.updated`,
`execution.completed`, and `run.failed`. Clients reconnect by fetching a current snapshot,
resuming from a cursor, deduplicating events, and reconstructing visible state.

### 3.4 Provider and compute separation

`InferenceProvider` supplies model inference. `ComputeProvider` executes computational workloads.
They are separate contracts even when an adapter uses the same vendor.

Required provider-neutral interfaces:

```text
InferenceProvider
ComputeProvider
ObjectStore
WorkflowBackend
SecretStore
IdentityProvider
BillingProvider
EventStore
```

No domain type may be named `ModalJob`, `OpenRouterRequest`, `R2Artifact`, or equivalent vendor
concept. Vendors implement adapters for Spyderbyte concepts such as `ExecutionAttempt`,
`Model`, `Artifact`, `UsageEvent`, and `Workflow`.

### 3.5 Security, approvals, and audit

The agent never bypasses authentication, authorization, workspace boundaries, data classification,
provider restrictions, runtime restrictions, budgets, policies, or approvals.

Approval decisions bind at minimum to principal, organization, workspace, project, resource,
interface, action, data classification, execution environment, estimated risk, estimated cost,
and authentication strength. Material audit records include actor, action, resource, interface,
timestamp, policy decision, approval, runtime, provider, result, artifacts, and usage.

Secrets are metadata/reference-only in durable records. Workers receive short-lived scoped access;
raw values do not enter prompts, logs, artifacts, telemetry, ACP messages, or diagnostics.

## 4. Current implementation baseline

This section is part of the new plan, not a claim that the complete product is finished. “Complete”
means the local or contract scope in the row has evidence; open hosted, clean-machine, commercial,
or source-migration gates remain open.

### 4.1 Verification baseline

On 2026-08-07, the repository passed:

- `pnpm format:check`;
- `pnpm verify` with 49/49 test tasks, 47/47 invariant tasks, and 30/30 build tasks;
- 45/45 browser tests in `apps/web`;
- web typecheck including compatibility output.

The build still emits known non-blocking warnings for large bundles, CJS `import.meta`, and local
macOS SDK discovery. These warnings are not release evidence for signed/universal/notarized output.

### 4.2 Implemented capability ledger

| Area                                 | Status                                                             | Implemented evidence and boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime contracts                    | **Complete**                                                       | Versioned TypeScript contracts, JSON Schema, generated docs, validators, IDs, time/money primitives, error taxonomy, redaction, state machines, fixtures, and property tests in `packages/runtime-contracts`.                                                                                                                                                                                                                                                                                                                                                                                               |
| Authoritative state                  | **Complete locally; hosted open**                                  | PostgreSQL/SQLite/in-memory repository ports, transactions, events, outbox, idempotency, migrations, recovery, tenant/workspace keys, and failure injection in `packages/state` and `packages/runtime-domain`.                                                                                                                                                                                                                                                                                                                                                                                              |
| Artifacts and projections            | **Complete locally; hosted object plane open**                     | Content-addressed artifact registry, immutable versions, lineage, filesystem/in-memory object stores, publication guards, projection rebuild/read paths, retention/deletion safeguards, and interaction projections in `packages/artifact-registry` and `packages/projections`.                                                                                                                                                                                                                                                                                                                             |
| Policy, authority, approvals, budget | **Complete locally**                                               | Integrity-protected authority envelopes, scoped grants, policy decisions, exact action digests, commit-time approval revalidation, budget reservations/reconciliation, audit, break-glass, redaction in `packages/policy` and `packages/budget`.                                                                                                                                                                                                                                                                                                                                                            |
| Harness and invocation enforcement   | **Complete for local contract**                                    | Tier hierarchy, delegation, context manifests, metered model calls, deadlines/cancellation, fallback, hooks, report validation, and runtime adapter in `packages/harness-core`. Cline-compatible behavior is isolated in `packages/cline-adapter`; it is not final Agent authority.                                                                                                                                                                                                                                                                                                                         |
| Local data/SQL loop                  | **Complete for local-first scope**                                 | Sources/connections, credential references, schema discovery, bounded previews, profiles/quality, immutable dataset versions, read-only SQL, history/saved queries, explain/export/cancel, durable query results, lineage, and handoff hydration in `packages/provider-runtime`, `packages/local-api`, `apps/tui`, and `apps/web/src/screens/SQLWorkbench.tsx`.                                                                                                                                                                                                                                             |
| Local durable workflows              | **Complete locally; Temporal/hosted proof open**                   | Workflow state, retry ownership, approval waits, cancellation, restart recovery, event cursor replay, deduplication, lease redelivery, parking, SSE disconnect handling, and process-kill recovery in `packages/runtime-domain`, `apps/worker`, and `packages/local-api`.                                                                                                                                                                                                                                                                                                                                   |
| Training and compute                 | **Complete locally; hosted isolation open**                        | Local resource inventory/offers, subprocess jobs, cost metering, budget reconciliation, candidate selection, checkpoints/lineage, OOM handling, and deterministic coding sandbox gates in `packages/orchestrator`, `packages/specialists`, `packages/tasks`, and `apps/sandbox-runner`.                                                                                                                                                                                                                                                                                                                     |
| Provider/model runtime               | **In progress**                                                    | Provider configuration, vault boundary, OpenAI/Anthropic/OpenAI-compatible/local/deterministic adapters, discovery, health/preflight, usage, routing, and daemon conversation streaming exist in `packages/provider-runtime`, `apps/local-daemon`, and `packages/local-api`. Real production provider/model-backed project execution and full first-run live run remain open.                                                                                                                                                                                                                               |
| Agent/session layer                  | **In progress (local control plane complete; hosted open)**        | `LocalProjectConversationService` persists conversation messages, Runs, attempts, logs, usage, and provider-backed output. Versioned AgentSession contracts and the ACP AgentTransport now cross the terminal/ACP boundary; hosted agent transport, full cross-interface equivalence, and broader artifact/usage/audit closure remain open.                                                                                                                                                                                                                                                                 |
| Existing CLI                         | **Complete locally for the transitional CLI + rich shell host**    | `apps/tui` retains the typed noninteractive command surface and starts the local daemon/client before delegating its no-argument interactive path to the standalone `apps/spyderbyte-shell` host. The Rust host owns presentation only; an authenticated loopback bridge carries context, submissions, Run status, plans, logs, reconnect state, cancellation, and output deltas from the typed Spyderbyte boundary.                                                                                                                                                                                        |
| Client boundary                      | **Complete for Phase 2 and rich-shell bridge**                     | `packages/client-sdk` owns the eight named typed clients, stable page/error schemas, REST/SSE calls, cursor replay, reconnect, cancellation, typed errors, and centralized exit semantics. `apps/tui` consumes the SDK/runtime-contract boundary without provider or domain implementation imports; the rich shell uses the same `sendMessage` and `followRun` path as the transitional CLI.                                                                                                                                                                                                                |
| Desktop/workspace/license            | **Complete locally (2026-08-07; credentialed release gates open)** | Tauri host, local-daemon sidecar, loopback/session transport, workspace SQLite/CAS, archive export/restore, license validation, Keychain adapter contract, mode-0600 state, native dialogs, single-instance behavior, bounded restart, target manifests, signed update verification, update/rollback controls, and deep-link preparation exist in `apps/desktop`, `packages/workspace`, `packages/license`, `apps/local-daemon`, `packages/provider-runtime`, and `scripts/release`. Native signed artifacts, notarization, Gatekeeper, and clean-machine installer evidence remain external release gates. |
| Web/interaction surface              | **In progress**                                                    | Vibe three-pane workspace, capability gates, provider setup, objective/plan/approval checkpoints, artifact inspection/lineage, settings/storage/license flows, projections, SSE reconnect, and SQL handoff browser coverage exist in `apps/web`. It is not the terminal authority and full first-run real execution/accessibility/E2E remain open.                                                                                                                                                                                                                                                          |
| Jupyter integration                  | **Local adapter exists; end-to-end gate open**                     | Discovery, managed sessions, scoped tokens, dataset/query/profile/quality/handoff commands, execution/reconnect APIs, and artifact/lineage contracts exist in `packages/jupyter-extension`; clean golden-path JupyterLab evidence remains open.                                                                                                                                                                                                                                                                                                                                                             |
| Model lifecycle/deployment           | **Complete locally; hosted backend open**                          | Experiment, registry, lineage-complete model publication, immutable evaluation/promotion, canary rollback, and reconciliation report adapters exist in `packages/orchestrator`, `packages/provider-runtime`, and lifecycle contracts. Production tracker/serving/hosted scenario remain open.                                                                                                                                                                                                                                                                                                               |
| Connectors/governance                | **Complete locally; hosted publication open**                      | Governance consultations, deterministic connector build/scan/test/publication, credential-handle boundaries, revocation, audit, rollback, and a reference connector exist in `packages/orchestrator`, `packages/policy`, and provider runtime.                                                                                                                                                                                                                                                                                                                                                              |
| Operations/security                  | **Complete locally (2026-08-07; production gates open)**           | Redaction, hash-chained audit, consent-aware product metrics, runbooks, threat model, backup/restore, capacity probes, rollout gates, dependency/gitleaks/Trivy configuration, and rate/tenant boundaries exist under `docs`, `packages`, and `scripts`. CI execution results, hosted load/SLO/capacity, production container/image findings, DR exercises, and release rollout wiring remain open.                                                                                                                                                                                                         |
| Codex-derived shell                  | **Complete locally**                                               | `apps/spyderbyte-shell` provides the presentation-only terminal lifecycle, alternate screen, keyboard/input, multiline composer, responsive panes, scrolling, markdown/code, progress/status, approval, log, and diff rendering. `apps/tui` owns the typed client/session/run bridge, including live SSE replay/reconnect and cancellation. No Codex source or Codex domain authority is imported; the boundary remains subordinate to Spyderbyte clients and AgentSession.                                                                                                                                 |
| ACP                                  | **Complete locally (ACP v1; 2026-08-07)**                          | `packages/agent-transport` implements the official `@agentclientprotocol/sdk` v1 agent over newline-delimited stdio. `spyderbyte acp` resolves project/session context, streams shared Run output and plans, reports policy permissions/tool status, maps cancellation to Run cancellation, supports session load/replay, and preserves Spyderbyte policy and persistence authority. Protocol fixtures cover Zed, JetBrains, and an internal client shape; a loopback smoke run covers the real local daemon and client SDK. Hosted ACP deployment and live vendor-client certification remain open.        |
| Hosted commercialization             | **Deferred/planned**                                               | Provider-neutral hosted adapters and local fixtures exist. Production control plane, OpenRouter, Modal, object storage, workflow backend, secret manager, Stripe, usage ledger, cloud auth, and managed worker evidence remain open.                                                                                                                                                                                                                                                                                                                                                                        |

## 5. Target contracts and package ownership

The target package shape may preserve the current monorepo, but responsibilities are declarative:

```text
apps/
  spyderbyte-cli/          # canonical binary and noninteractive commands
  spyderbyte-tui/          # Codex-derived shell host and renderers
  local-daemon/            # local control/runtime composition
  api/                     # hosted control plane
  worker/                  # durable workflow/worker entrypoints
  sandbox-runner/          # isolated local/hosted execution entrypoint
  web/                     # rich artifacts, tables, charts, administration
  desktop/                 # distribution, lifecycle, native dialogs, update

packages/
  runtime-contracts/       # language-neutral schemas and generated types
  client-sdk/              # typed domain clients and stream primitives
  agent/                   # AgentSession, planning, context, recommendations
  agent-transport/         # TUI, CLI, ACP, API transport abstraction
  runtime-domain/          # Runs, workflows, events, recovery state machines
  state/                   # repositories, transactions, outbox, idempotency
  policy/                  # authority, policy, approvals, audit
  budget/                  # reservations, usage, reconciliation
  provider-runtime/        # inference/compute/provider-neutral adapters
  artifact-registry/       # artifact bytes, metadata, versions, lineage
  projections/             # authoritative read models and cursor replay
  jupyter-extension/       # advanced notebook renderer/client
  cline-adapter/           # bounded transitional compatibility adapter only

vendor/codex-derived/      # only approved shell infrastructure with provenance
```

Required typed client interfaces are:

```text
AgentClient
ProjectClient
RunClient
ArtifactClient
ProviderClient
RuntimeClient
ApprovalClient
UsageClient
```

Required internal transport types are:

```text
AgentTransport
TuiAgentTransport
CliAgentTransport
AcpAgentTransport
ApiAgentTransport

AgentSession
AgentRequest
AgentEvent
AgentPermissionRequest
AgentResponse
```

All transports map to the same `AgentSession` and backend Run lifecycle. ACP, TUI, CLI, API, web,
Jupyter, and automation are interfaces—not separate agents.

## 6. CLI and TUI product contract

### 6.1 Canonical commands

The command surface is organized around intent and durable resources:

```text
spyderbyte
spyderbyte chat | ask | status | doctor
spyderbyte project create | open | list | inspect | export
spyderbyte run [prompt|script|command] ...
spyderbyte runs list | inspect | logs [--follow] | cancel | retry
spyderbyte query "SELECT ..."
spyderbyte database connect ...
spyderbyte notebook create | open | run | publish
spyderbyte models list | use | inspect
spyderbyte provider add | list | login | test | remove
spyderbyte compute list | use local | use cloud | estimate
spyderbyte artifacts list | inspect | open | export
spyderbyte automation create | list | run | disable
spyderbyte org | users | policies | approvals | budgets | audit
spyderbyte acp
```

Existing commands may remain as compatibility aliases while the final command model is introduced.
All relevant noninteractive commands support `--json` using generated Spyderbyte schemas, not
terminal presentation objects.

Stable exit codes are centralized and documented:

```text
0 success
1 general failure
2 invalid request
3 authentication required
4 configuration required
5 approval denied
6 execution failed
7 budget exceeded
8 policy denied
```

### 6.2 Conversation-first shell

The default shell is a minimal conversation surface with:

- project/workspace header;
- conversation and streamed assistant output;
- plan/recommendation cards;
- contextual Run and approval actions;
- persistent composer unless a blocking approval/modal requires focus;
- Runs, artifacts, files, context, runtime, model, usage, and connection status;
- operator diagnostics available through progressive disclosure.

Interaction priority is conversation → recommendations → actions → plans → approvals → Runs →
results → files/resources → explicit controls → diagnostics.

The shell supports three disclosure depths without separate products:

- **Guided:** intent, recommendations, files, results, charts, approvals.
- **Builder:** notebooks, SQL, runtimes, models, environments, experiments, pipelines, detailed
  Run inspection.
- **Operator:** workers, routing, queues, policy, budgets, secrets, deployments, governance,
  infrastructure health, audit.

The active renderer is task-specific: tables/statistics/charts for analysis, metrics and resource
usage for training, diffs for code/configuration, structured comparisons for documents, and artifact
previews for outputs. Terminal rendering should use summaries, small textual previews, sparklines,
and external open actions rather than implementing a full plotting or IDE system.

### 6.3 Slash commands and editor integration

Initial slash commands are `/help`, `/project`, `/files`, `/runs`, `/artifacts`, `/model`,
`/provider`, `/runtime`, `/notebook`, `/usage`, `/settings`, `/doctor`, `/clear`, and `/resume`.
Organization commands are `/org`, `/approvals`, `/policies`, `/budgets`, and `/audit`.

Explicit shell execution such as `!pytest`, `!python analysis.py`, or `spyderbyte run command` is
allowed when safe, but material work must become a Run. `$VISUAL`, `$EDITOR`, and an explicit
Spyderbyte editor setting control external editor actions. Diff renderers support code, SQL,
configuration, JSON, text, and workflow changes.

### 6.4 Local filesystem and configuration

The final conceptual home is:

```text
~/.spyderbyte/
  config.toml
  credentials/
  sessions/
  cache/
  logs/
  runtimes/

project/.spyderbyte/
  project metadata and intentional local state
```

The canonical environment prefix is `SPYDERBYTE_`. Provider credentials live in secure vaults or
credential references, not ordinary configuration. A migration must not silently adopt Codex
paths, config keys, telemetry identifiers, user-agent strings, or update endpoints.

## 7. ACP contract

`spyderbyte acp` runs without launching the interactive TUI and communicates over the supported ACP
transport. The adapter maps external sessions to:

```text
AgentSession {
  id
  project_id
  workspace_id
  user_id
  organization_id?
  interface = acp
  client
  conversation_id
  mode
  context
  permissions
}
```

Initial ACP capabilities:

- initialize/session lifecycle;
- project context and resource context;
- prompt submission;
- assistant streaming;
- plan and execution progress;
- tool invocation reporting;
- permission requests and responses;
- cancellation;
- filesystem/resource mutation reporting;
- terminal/execution status;
- structured plan display where supported.

ACP permission requests are rendered by the client but decided by Spyderbyte policy at execution
time. ACP requests must produce normal Spyderbyte Runs, events, artifacts, usage, and audit. ACP
protocol evolution is isolated inside `AcpAgentTransport`.

## 8. Commercial and hosted product contract

### 8.1 Individual edition

Free individual use includes CLI, TUI, projects, Agent, local files, analysis, code, SQL,
notebooks, charts, artifacts, lineage, local Run history, local automations, local models, BYOK,
customer-owned infrastructure, and ACP. No artificial capability wall prevents serious local work.

Individuals may optionally consume Spyderbyte-managed inference, CPU/GPU, notebooks, training, batch,
serving, document processing, or storage on a usage basis. Local and BYOK work is not charged as
Spyderbyte consumption.

### 8.2 Organization and enterprise

The annual platform boundary begins with shared projects, members, centralized administration,
shared artifacts/context, team automations, shared provider configuration, usage reporting,
approvals, policies, audit, history, budgets, SSO, SCIM, Slack/Teams, private execution, and
support. Indicative Team/Business pricing from the PRD is product input, not a release constant;
pricing and entitlements require a human commercial decision.

Enterprise and government options add SSO/OIDC/SAML, SCIM, advanced RBAC/ABAC, private networking,
customer infrastructure, private inference, data residency, retention, customer-managed encryption,
regional deployment, procurement controls, predictable commitments, and support tooling.

### 8.3 Hosted architecture

Initial adapter candidates are OpenRouter for managed inference, Modal for compute, Postgres for
control metadata, R2 for object storage, Inngest or an equivalent durable workflow backend, Stripe
for billing, OpenTelemetry/Sentry for observability, transactional mail, and a KMS-backed secret
store. Final vendor selection is a decision gate; the domain contracts do not change if vendors do.

Hosted execution must:

- keep untrusted/agent-generated code outside the control-plane API;
- provide isolated filesystem, scoped inputs, explicit secrets, CPU/memory/GPU/time/disk limits,
  network policy, and an artifact output directory;
- collect outputs, persist artifacts, finalize usage, and destroy the runtime;
- route control-plane state through Runs, Attempts, events, usage ledger, and audit;
- return artifacts to the same project history as local Runs.

### 8.4 Usage ledger and billing

Spyderbyte owns an append-only `UsageEvent` ledger. Stripe is a billing/payment adapter, never the
authoritative usage database. Ledger dimensions include account, organization, project, Run,
provider, resource type, quantity, provider cost, customer cost, currency, and timestamp.

Resource examples include inference input/output tokens, CPU/GPU seconds, memory GB-seconds,
storage byte-seconds, notebook compute, and serving compute. The accounting flow is:

```text
Provider usage → UsageEvent → Spyderbyte ledger → pricing policy
  → balance/prepaid pool/commitment → invoice or Stripe adapter
```

Government billing must support predictable annual commitments, managed pools, approved overage
ceilings, and maximum annual exposure.

## 9. Declarative implementation phases

The phase order preserves the existing platform foundation while adding the Codex shell and new
product requirements. Each phase has a deliverable, exit gate, and evidence requirement.

### Phase 0 — Migration authority and provenance

**Status: Complete for the supplied Codex snapshot (2026-08-07); no Codex source was imported.**

Deliver:

1. Expand [`CODEX_MIGRATION_MATRIX.md`](CODEX_MIGRATION_MATRIX.md) to one row per file under the
   audited Codex source roots and the existing CLI/Cline-derived surface. The deterministic
   inventory now covers 6,046 Codex files and 65 Spyderbyte CLI-boundary files under the supplied
   snapshot, with combined digest
   `sha256:b9b4aec1b69375b0f8c697d4307526bcfbe3e48beb9a5a934d0b4d40770174d3`.
2. Record upstream URL, source commit or archive digest, import date, license notices, modified
   files, excluded files, and deliberate sync policy in [`UPSTREAM_CODEX.md`](UPSTREAM_CODEX.md).
3. Add `ADR-0038-codex-derived-shell-boundary.md` defining KEEP/ADAPT/REPLACE/REMOVE boundaries.
4. Run license, dependency, security, branding, telemetry, filesystem, and binary-name audits. The
   passing evidence is recorded in
   [`migration-audit.md`](audit-artifacts/2026-08-07-codex-phase-0/migration-audit.md).
5. Decide whether the rich shell is hosted as a Rust crate with a typed client boundary or another
   implementation after audit; do not assume a full repository merge. ADR-0038 accepts a separate
   Rust `apps/spyderbyte-shell` boundary, the canonical `spyderbyte` command, and typed Spyderbyte
   clients instead of a wholesale Codex merge.

**Exit gate:** Matrix expansion, provenance, Apache-2.0 compliance, dependency review, audit
evidence, shell boundary ADR, and the selected Phase 1 per-file review are accepted. All 6,111
rows have explicit deterministic decisions with zero unresolved `AUDIT` rows. No Codex-derived
source has been imported; the product shell is a separately implemented boundary.

**Evidence (2026-08-07):** `pnpm codex:migration:generate`, `pnpm codex:migration:check`, and
`pnpm codex:migration:audit` completed successfully. The source checkout has no Git metadata, so
the deterministic file-manifest digest is the recorded source identity. Apache-2.0 and the
Ratatui MIT notice are present; no direct Codex dependency or Codex source import exists in the
audited Spyderbyte CLI boundary. Existing `openai-codex`, `codex-subscription`, and `codex-cli`
compatibility references remain explicitly classified as provider-compatibility findings.

### Phase 1 — Shell extraction and Spyderbyte identity

**Status: Complete locally (2026-08-07); selected upstream shell-mechanics regressions pass, while the full upstream workspace suite has an unrelated product-domain failure.**

Extract only approved Codex terminal mechanics: terminal lifecycle, alternate-screen behavior,
keyboard/input, multiline composer, markdown/code blocks, scrolling, resize, progress, output,
approval presentation primitives, diff rendering, and cross-platform packaging patterns.

Replace or remove Codex/OpenAI-specific branding and behavior across splash, binary, help, prompts,
errors, installers, config, paths, telemetry, user-agent strings, diagnostics, docs, completions,
crash reports, and update systems. The primary binary becomes `spyderbyte`; `codex` is never a
primary command. Preserve required Apache-2.0 attribution separately.

**Exit gate:** `spyderbyte` boots a fully branded shell with no inherited account prompt, cloud
dependency, agent authority, or product-domain behavior; the extracted-boundary shell regression
suite and the selected upstream shell-mechanics regressions pass. The complete supplied upstream
workspace suite remains red only in the unrelated product-domain test
`app::tests::changing_cyber_model_reasoning_preserves_selected_permissions`, which aborts with a
stack overflow after 3423 tests begin.

**Evidence (2026-08-07):**

1. [`audit-artifacts/2026-08-07-codex-phase-1/shell-file-review.md`](audit-artifacts/2026-08-07-codex-phase-1/shell-file-review.md)
   reviews the selected terminal lifecycle, event stream, screen sizing, composer, markdown,
   diff, ANSI, and branding files from the supplied Codex snapshot. Product/domain, account,
   cloud, telemetry, persistence, and update behavior is excluded; no upstream file was copied.
2. `apps/spyderbyte-shell` is an isolated std-only Rust crate with canonical binary `spyderbyte`,
   a non-TTY/plain fallback, Unix alternate-screen/raw-input lifecycle, narrow/wide layouts,
   typed event rendering, multiline input, scrolling, resize-aware rendering, progress/status,
   approval, logs, code blocks, and diffs. `#![forbid(unsafe_code)]` is enabled.
3. `apps/tui` starts the local daemon/client before delegating its no-argument interactive path to
   the Rust host when available. An authenticated loopback bridge submits through
   `SpyderbyteClient.sendMessage`, follows the same cursor/reconnect SSE stream as the CLI, and
   forwards typed context, plan, status, log, output-delta, connection, and cancellation events.
4. Boundary gates pass: `cargo fmt --all -- --check`, `cargo check --all-targets`, and
   `cargo test` (11/11); `pnpm --filter @agentic-platform/tui build`; direct `spyderbyte --help`,
   plain-mode boot, and PTY boot/Ctrl+C restore smoke tests. Branding tests exclude Codex/OpenAI,
   account, cloud, and sign-in copy from the shell help; authority tests exclude provider,
   credential, API-key, and Run state from shell state.
5. Selected upstream mechanics regressions pass from the supplied checkout: `tui::` (45 tests),
   `custom_terminal::` (10), `markdown_render::markdown_render_tests::` (106), and
   `diff_render::` (50), for 211 passing upstream shell tests. The full `codex-rs/tui` library
   suite compiled and began 3,423 tests but hit the unrelated stack overflow named above; that
   failure is retained as upstream baseline evidence and is not imported into Spyderbyte.
6. Repository-wide contract checks, generated-output checks, formatting, and typecheck pass
   (`31/31` packages). Repository-wide lint/test remain independently red in
   `packages/runtime-domain` because of three existing unused-variable lint errors and a child-
   process recovery test timeout; the focused shell/TUI lint, typecheck, test, and build gates are
   green.

### Phase 2 — Spyderbyte client layer

**Status: Complete (2026-08-07).**

Expose `AgentClient`, `ProjectClient`, `RunClient`, `ArtifactClient`, `ProviderClient`,
`RuntimeClient`, `ApprovalClient`, and `UsageClient` over the current versioned local/hosted API.
Add stable JSON schemas, cursor replay, reconnect, cancellation, pagination, typed errors, and
centralized exit-code mapping. The shell consumes clients; it never imports provider or domain
implementation packages directly.

**Exit gate:** A shell test can render mocked Spyderbyte events and domain records with no Codex
business logic and no local decision about provider, runtime, approval, cost, or artifact storage.

**Completion record:** `packages/client-sdk/src/index.ts` now explicitly implements and exports all
eight named clients, exposes a shared client bundle, normalizes legacy collections into versioned
cursor pages, preserves SSE cursor replay/reconnect and AbortSignal cancellation, and maps typed
API/transport errors to the documented exit codes. `apps/tui` renders SDK/runtime-contract records
through `apps/tui/src/rendering.ts` and uses the SDK exit-code mapper; it has no provider or domain
implementation imports. Evidence is in `packages/client-sdk/tests/client-sdk.test.ts`,
`apps/tui/tests/client-layer.test.ts`, the focused SDK/TUI typecheck, test, build, lint, and format
checks, and `scripts/verify/check-boundaries.mjs`.

### Phase 3 — Spyderbyte AgentSession and real agent integration

**Status: Complete (local vertical slice; 2026-08-07).**

Create durable `AgentSession`, `AgentRequest`, `AgentEvent`, `AgentPermissionRequest`, and
`AgentResponse` contracts. Map TUI, CLI, ACP, API, Jupyter, web, and automation into the same
session model with project/workspace/user/organization/interface/context/mode fields.

Generalize the current conversation service from a provider-backed turn into:

```text
request → context inspection → recommendation → plan → estimate
        → policy/approval → Run → events → artifacts → explanation → next action
```

The Cline adapter may supply a bounded model runtime during migration, but the Spyderbyte Agent
owns context, planning, capabilities, tool calls, policy, approval, and Run creation.

**Exit gate:** A natural-language request from the terminal creates a durable AgentSession,
produces a typed recommendation/plan, enforces policy, and continues through the shared Run path;
there is one agent and no Codex/Cline agent authority.

**Completion record (2026-08-07):**

- `packages/runtime-contracts` now owns versioned `AgentSession`, `AgentRequest`, `AgentEvent`,
  `AgentPermissionRequest`, `AgentRecommendation`, `AgentEstimate`, and `AgentResponse` contracts,
  strict JSON schemas, runtime validators, and generated contract outputs. The shared interface
  enum covers TUI, CLI, ACP, API, Jupyter, web, automation, and system entrypoints.
- `apps/local-daemon` reconstructs durable sessions from the authoritative event stream and runs the
  typed pipeline: context inspection, recommendation, plan, estimate, policy evaluation, shared Run,
  event stream, explanation, and next action. Organization policy pauses destructive adapter tool
  calls as durable permission requests; local conversation remains owned by the Spyderbyte Agent.
- `packages/local-api` and `packages/client-sdk` expose project/session reads and preserve the same
  session model across interface-labelled requests. The Cline compatibility adapter remains a
  bounded runtime surface; invocation records identify `spyderbyte-agent.v1` and grant no Cline or
  Codex agent authority.
- The rich shell uses the same AgentSession/Run path: its TypeScript launcher calls
  `sendMessage(..., 'tui')`, follows the durable Run through SDK SSE cursor replay/reconnect, and
  maps output/status/cancellation back to the Rust presentation host over the authenticated
  loopback bridge.
- Evidence: `apps/local-daemon/tests/phase3-agent-session.test.ts` covers ACP completion through the
  shared Run, CLI-labelled policy permission waits, both session API routes, typed events, and
  invocation identity. Targeted results are runtime-contracts 103/103, local-api 18/18,
  local-daemon 11/11, and the Phase 3 acceptance test 2/2.
- Verification: contract/API/frontend generated-output checks, repository typecheck (31/31),
  invariant suite (47/47), and repository build (31/31) pass. The parallel repository test command
  has one pre-existing flaky runtime-domain child-process recovery case; its isolated rerun passes
  8/8. Repository formatting/lint remain gated by unrelated pre-existing shell/audit-artifact files.

This completion is for the local control-plane vertical slice. Hosted ACP transport, external
provider deployment, and cross-interface equivalence evidence remain in the later transport,
universal-Run, and hosted phases.

### Phase 4 — Universal Run integration

**Status: Complete (2026-08-07).**

Map all material pathways—prompt, `!command`, Python, SQL, notebook/cell, data operations,
visualization, training, evaluation, connector sync, automation, deployment, and repository
changes—to `ExecutionRequest` → `ExecutionPlan` → `Run` → `ExecutionAttempt` → events/artifacts/
usage/audit.

Replace invisible process execution, token-stream-only rendering, and any simulated or
projection-only success. Preserve Run state across restart, reconnect, cancellation, retry,
approval waits, and partial failure. One user action may produce inference and compute attempts,
but all remain under one Run history.

**Exit gate:** The universal Run acceptance suite proves no material action bypasses Run history and
that local, CLI, TUI, API, ACP, and Jupyter paths produce equivalent authoritative records.

**Completion record (2026-08-07):** `packages/runtime-contracts` now defines the durable
`ExecutionRequest` envelope, compute/network/secret/limit contracts, and a redacted replay
descriptor. `packages/runtime-domain/src/universal-run.ts` provides the append-only coordinator
for request, plan, Run, attempt, result, progress, operation-link, artifact/usage, cancellation,
approval-wait, partial-failure, idempotency, reconnect, and retry state. The local API mutation
boundary classifies material pathways into that coordinator; Run cancel/retry controls operate on
the target Run rather than creating wrapper Runs. The local conversation service creates the same
request/plan records and preserves the original Run across retry by linking and reconciling the
child agent execution. Client interface identity is explicit for CLI/TUI, web, ACP, and Jupyter.
The passing gate is recorded in
[`audit-artifacts/2026-08-07-spyderbyte-phase-4/universal-run-acceptance.md`](audit-artifacts/2026-08-07-spyderbyte-phase-4/universal-run-acceptance.md), with executable coverage in
[`packages/local-api/tests/universal-run.test.ts`](packages/local-api/tests/universal-run.test.ts).

### Phase 5 — Provider, model, runtime, and local-first integration

**Status: Complete (2026-08-07).**

Complete the provider-neutral selection hierarchy for:

- Spyderbyte Cloud managed inference;
- OpenAI, Anthropic, OpenAI-compatible endpoints;
- Ollama, llama.cpp, MLX, and appropriate Hugging Face local models;
- customer-owned inference and compute;
- Local, Docker, customer runtime, and Spyderbyte Cloud compute profiles.

Provider setup must use secure credential references and preflight/health/usage contracts. Compute
selection uses `RuntimeProfile`, never Modal or cloud-vendor names in the shell. Add first-run
onboarding that lets a user choose local model, provider key, Spyderbyte Cloud, or configure later;
detects local environment/project context; and permits the first question without requiring cloud
authentication.

**Exit gate:** With the network disconnected, a clean install can open a project, use a local model
or BYOK provider, run local Python/SQL/notebook work, stream a Run, produce artifacts, and resume.

**Completion record (2026-08-07):** Provider configuration now covers the explicit
`spyderbyte-cloud` and `customer-owned` provider families in addition to the local and API
transports, with the existing vault-backed `credentialRef` boundary retained. A redacted provider
preflight report is available beside discovery, health, and usage through the shared provider
runtime and local API. Material API replay bodies recursively strip credential fields before they
enter the universal Run ledger. `FileComputeProfileRegistry` persists the shared `RuntimeProfile`
contract for local-host, local-docker, remote-ssh, managed-worker, and customer-cloud profiles and
selects them by requirements, network policy, explicit preference, and local-first precedence.
`/v1/onboarding` and the TUI onboarding commands detect project/runtime context, persist a
non-secret first-run choice for local model, provider key, Spyderbyte Cloud, or configure later,
and guarantee the first question does not require cloud authentication. The provider/runtime and
local API acceptance suites cover the hierarchy, secure BYOK setup, preflight/health/usage,
compute selection, onboarding, and replay redaction. The disconnected acceptance gate is recorded
in [`audit-artifacts/2026-08-07-spyderbyte-phase-5/provider-runtime-local-first-acceptance.md`](audit-artifacts/2026-08-07-spyderbyte-phase-5/provider-runtime-local-first-acceptance.md),
with executable coverage in
[`packages/provider-runtime/tests/phase5-provider-selection.test.ts`](packages/provider-runtime/tests/phase5-provider-selection.test.ts),
[`packages/local-api/tests/phase5-provider-onboarding.test.ts`](packages/local-api/tests/phase5-provider-onboarding.test.ts),
and [`apps/local-daemon/tests/phase5-local-first.test.ts`](apps/local-daemon/tests/phase5-local-first.test.ts).
The web first-run follow-up now consumes the same `/v1/onboarding` response, displays detected
project context, lets a user choose local model/BYOK/Spyderbyte Cloud/configure-later, submits
provider credentials only to the local API boundary, and clears the API-key field after submission.
The browser acceptance coverage is in
[`apps/web/tests/app.test.tsx`](apps/web/tests/app.test.tsx) and the UI implementation is in
[`apps/web/src/screens/Onboarding.tsx`](apps/web/src/screens/Onboarding.tsx); the broader real-run,
artifact-lineage, accessibility, and clean-machine gates remain open.

### Phase 6 — Artifacts, visualization, notebooks, and advanced shell UX

**Status: Complete (local terminal vertical slice; 2026-08-07).**

Add first-class artifact listing/inspection/open/export, immutable lineage and versions, chart/table
previews, external rich visualization actions, JupyterLab launch/context/reconnect, project-aware
conversation resume, file/resource context, Inbox/watch-directory classification, recommendations,
structured diffs, and automation surfaces.

Initial visualization registry includes line/bar/stacked bar/area/KPI/table/pivot, scatter/histogram/
box/heatmap, point map/choropleth, confusion matrix/ROC/precision-recall/feature importance. The
agent chooses automatically and users can override conversationally.

**Exit gate:** A terminal user can inspect, open, modify, save, and reuse artifacts and notebook
outputs without the shell becoming a browser IDE or custom plotting system.

**Completion record (2026-08-07):** The local terminal exit gate is satisfied. `apps/tui/src/index.ts`
now exposes artifact list, inspection, version and lineage history, structured diff, open, preview,
export, save, and reuse commands; visualization choose/validate/render commands with a structured
rich-visualization handoff; repository file/resource context and save operations; workspace
Inbox/watch classification and recommendations; Jupyter context; and project-aware conversation
resume. `packages/client-sdk/src/index.ts` and `packages/local-api/src/index.ts` provide the shared
artifact, visualization, workspace, repository, and Jupyter routes rather than putting domain
semantics in the shell. Immutable artifact publication and structured diffs are implemented in
`packages/artifact-registry/src/diff.ts`, workspace classification and recommendations in
`packages/provider-runtime/src/workspace-intake.ts`, and the complete declared visualization
registry plus automatic/override selection in `packages/provider-runtime/src/visualizations.ts`.
`packages/jupyter-extension/src/index.ts` propagates notebook/project/runtime context through cell,
notebook, publication, launch, and reconnect operations. Acceptance coverage is in
`packages/local-api/tests/phase6-artifacts.test.ts`,
`packages/provider-runtime/tests/phase6-visualization.test.ts`,
`packages/client-sdk/tests/client-sdk.test.ts`, `packages/jupyter-extension/tests/phase6.test.ts`,
and `apps/tui/tests/command-parity.test.ts`; the affected package suites, type builds, formatting,
and generated API/frontend contract checks pass. Hosted execution, ACP, and signed-release proof
remain in their later phases; this completion record is deliberately scoped to the local terminal
exit gate.

**Follow-up evidence (2026-08-07):** The current React project surface now closes the next local
CSV workflow increment without moving authority into the browser. `apps/web/src/screens/ProjectDetail.tsx`
stages CSV content through `/v1/artifacts/uploads`, publishes an immutable source version, submits
a typed `ValidateDataset` plan through `/v1/commands/plan`, renders the governed steps and approval
state, runs the reviewed workflow through `/v1/workflows/{workflowId}/run`, and exposes the returned
governance, quality-report, validated-dataset, and lineage artifact references. The shared web
runtime client/store now expose a typed planning operation alongside command submission. Browser
acceptance coverage is in `apps/web/tests/app.test.tsx` (`47` tests passing); the web typecheck and
the orchestrator/local-api/local-daemon suites also pass (`15`, `29`, and `14` tests respectively).
This closes the local CSV → plan/review → run → artifact handoff; full first-run real-provider
execution, notebook continuation, accessibility/E2E, clean-machine installation, hosted execution,
and signed-release evidence remain open as recorded in the status ledger.

**Follow-up evidence (2026-08-07):** The web artifact surface now consumes the existing local
content and diff authority for version-specific open/preview/export actions and structured
comparisons. `apps/web/src/screens/Assets.tsx` reads immutable content through
`/v1/artifacts/{artifactId}/versions/{version}/content`, renders text previews with a binary
fallback, creates browser downloads, and reads `/v1/artifacts/{artifactId}/diff` for bounded
version comparisons. Current artifact versions link into the notebook route; `Notebooks.tsx`
loads CSV context from the same immutable content endpoint and passes typed `sourceData` to the
local SQL-cell execution boundary. Browser acceptance coverage now passes `49` tests, including
artifact preview/diff and notebook continuation; web typecheck and formatting checks pass. The
remaining first-run real-provider, accessibility/E2E, clean-machine, hosted, and signed-release
gates are unchanged.

**Verification evidence (2026-08-07):** `pnpm verify` passes after the local artifact/notebook
increment: contract and migration audits, Phase 11 and container checks, formatting, lint and
package boundaries, typecheck across `33` workspace packages, tests across `54` workspace tasks,
invariants across `50` tasks, and builds across `33` tasks. The generated migration matrix and
`UPSTREAM_CODEX.md` now agree on the deterministic snapshot digest
`sha256:b9b4aec1b69375b0f8c697d4307526bcfbe3e48beb9a5a934d0b4d40770174d3`. Build output retains
only the documented large-web-bundle, CommonJS `import.meta`, and macOS SDK-discovery warnings;
credentialed signing/notarization and hosted CI evidence remain external gates.

### Phase 7 — ACP adapter

**Status: Complete locally (ACP v1; 2026-08-07).**

Implement `spyderbyte acp` with `AcpAgentTransport`, session initialization, project context,
prompt/streaming, progress, permissions, cancellation, filesystem/resource mutation reporting,
terminal status, and structured plans. Map all ACP execution to normal Spyderbyte Runs and events.
Validate against representative ACP clients such as Zed, JetBrains, and an internal fixture when
available.

**Exit gate:** The same Spyderbyte Agent used by the terminal operates in an ACP client without a
second agent, Run pipeline, permission authority, or persistence model.

**Completion record (2026-08-07):**

- `packages/agent-transport` now owns `AcpAgentTransport` and uses the official
  [`@agentclientprotocol/sdk`](https://agentclientprotocol.com/libraries/typescript) v1 API with
  JSON-RPC/NDJSON over stdio. The adapter negotiates ACP v1, creates/loads durable project-backed
  sessions, accepts text/resource prompts, emits session updates for plans, output, Run/tool-log
  progress, terminal-shaped execution status, and resource metadata, and returns structured stop
  reasons.
- `apps/tui` now exposes `spyderbyte acp [--project <projectId>]` without launching the interactive
  TUI. Prompt submission is labelled `sourceInterface: 'acp'`, uses the existing client SDK and
  `LocalProjectConversationService`, and observes the same durable Run/event stream as the terminal.
  ACP cancellation calls the normal Run cancellation path. Permission requests are rendered through
  the ACP client while the existing Spyderbyte policy/approval authority remains decisive; a client
  response cannot bypass a pending policy decision.
- Evidence: `packages/agent-transport/tests/acp.test.ts` covers initialize, session creation/load,
  prompt updates, structured plans, cancellation, official SDK client shapes labelled `zed`,
  `jetbrains`, and `internal-fixture`, plus an actual NDJSON/stdio stream. A focused loopback smoke
  run against `createLocalDaemonServer` completed with updates
  `user_message_chunk → plan → agent_message_chunk → plan`, proving the real local AgentSession and
  shared Run path are used.
- Verification: agent-transport typecheck/test, TUI typecheck/build, and `git diff --check` pass.
  The broader TUI suite retains one pre-existing artifact-export assertion (`ABC` versus `QUJD`); no
  ACP test depends on that fixture. Live Zed and JetBrains binaries were not available in the local
  environment, so compatibility evidence is protocol-level using the official SDK and representative
  client metadata; hosted/certified-client gates remain future work.

See [`audit-artifacts/2026-08-07-spyderbyte-phase-7/acp-v1-acceptance.md`](audit-artifacts/2026-08-07-spyderbyte-phase-7/acp-v1-acceptance.md).

### Phase 8 — Spyderbyte Cloud and managed execution

**Status: Complete locally (managed-execution vertical slice; 2026-08-07).**

Implement account auth, hosted Postgres, object storage, event transport, durable workflow backend,
OpenRouter inference, Modal compute, KMS-backed secret broker, isolated worker pools, usage ledger,
pricing, Stripe adapter, cost estimates, prepaid balances, resource limits, cloud streaming,
artifact return, and cloud/local Run continuity.

**Exit gate:** A free individual user can switch a Run from local to Spyderbyte Cloud, see an
estimate, approve it, receive live state, obtain artifacts, and be charged/reconciled correctly.

**Completion record (2026-08-07):** The local managed-execution exit gate is satisfied. Versioned
cloud account/session, estimate, approval, event, artifact, usage, billing, and Run-continuity
contracts live in `packages/runtime-contracts/src/cloud.ts`. The new
`packages/cloud-runtime` package composes tenant-scoped account auth, hosted PostgreSQL/state and
object-store/event/workflow/worker ports, KMS secret handles, OpenRouter SSE streaming, Modal
compute gateway validation, resource limits, pricing, Stripe capture, prepaid balances, an
idempotent usage ledger, immutable artifact return, and local-to-cloud Run continuity. The local
API exposes authenticated estimate, approval, execute, and event-replay routes under
`/v1/cloud/runs/*`.

Acceptance evidence is in `packages/cloud-runtime/tests/phase8-cloud.test.ts` and
`packages/local-api/tests/cloud-run.test.ts`; the detailed record is
[`audit-artifacts/2026-08-07-spyderbyte-phase-8/cloud-managed-execution.md`](audit-artifacts/2026-08-07-spyderbyte-phase-8/cloud-managed-execution.md).
Cloud runtime and local API tests/typechecks/lint/build pass, the repository typecheck and build
pass for all 33 packages, and contract/boundary/format checks pass. This completion is explicitly
local/contract-level: real OpenRouter, Modal, Stripe, KMS, hosted PostgreSQL deployment, and
production release evidence remain required before a hosted launch.

**Hosted continuity follow-up (2026-08-07):** The managed-execution coordinator no longer owns
estimate, approval, Run result, or cloud-event state in private process maps. The new
`CloudRuntimeStore` port has local and transactional `StateStoreCloudRuntimeStore` implementations;
the latter persists metadata through the existing state receipts and appends cloud Run events to
the authoritative event stream. `HostedCloudAccountService` provides the async hosted identity
boundary, while `createHostedCloudRuntime` composes durable runtime state, billing state, usage
idempotency, and prepaid reservation/reconciliation state without selecting a vendor or region.
Billing transitions are append-only, and the durable usage/prepaid adapters preserve tenant scope,
idempotency, currency checks, and restart recovery.

The Phase 8 acceptance suite now proves that a new coordinator instance restores estimates,
approvals, results, cloud events, billing state, usage, and prepaid balances from a shared state
store. Focused `@agentic-platform/cloud-runtime` typecheck, lint, test (5 tests), and build pass.
The repository `pnpm verify` rerun also passed contracts, API/frontend snapshots, migration audit,
Phase 11/container checks, format, 33-package lint/boundaries, 33-package typecheck, 54 test tasks,
50 invariant tasks, and 33-package build.
This closes the provider-neutral hosted composition contract; credentialed identity/provider/
compute/object/event transports, hosted Postgres deployment, SLO/load/capacity evidence, and
production release certification remain external deployment gates.

### Phase 9 — Organizational platform

**Status: Complete locally (shared organizational workspace vertical slice; 2026-08-07).**

Add organizations, memberships, shared projects/context/artifacts, centralized provider
configuration, workspace roles, policy presentation, approvals, budgets, usage allocations,
organizational history, audit, admin, Slack/Teams, and annual entitlements. The shell should show
organization, workspace, project, role, budget, policy, allowed providers, and allowed runtimes
without exposing infrastructure detail by default.

**Exit gate:** A team can operate one shared Spyderbyte workspace with governed Runs, shared
artifacts, centralized credentials, policies, budgets, and audit rather than disconnected local
installations.

**Completion record (2026-08-07):** The local shared-workspace exit gate is satisfied. Organizations,
scoped memberships and roles, durable local governance state, shared project/context/artifact/history
access, centralized provider configuration through the vault boundary, allowed provider/runtime
policy, approval-bound evaluation/commit, budgets, attributed usage, forecasts/alerts, and a
hash-chained audit record are implemented across `packages/policy`, `packages/local-api`, and
`apps/local-daemon`. Shared API routes fail closed for non-members and enforce the minimum role;
conversation Runs evaluate before conversation initialization, re-evaluate after provider selection,
and commit usage/audit evidence with actor, workspace, project, provider, runtime, interface, and
approval context. Web Governance and the TUI organization commands expose the shared control-plane
summary without credential values or infrastructure detail. The evidence record is
[`audit-artifacts/2026-08-07-spyderbyte-phase-9/organizational-platform.md`](audit-artifacts/2026-08-07-spyderbyte-phase-9/organizational-platform.md),
and focused acceptance is in `apps/local-daemon/tests/phase9-organizational.test.ts`.

This is local/contract-level completion. The existing Slack connector/provider-action boundary is
protected by the shared membership policy; production Teams integration, hosted vendor/region/data
residency choices, and annual organization pricing/entitlement semantics remain explicit human
decision gates rather than release constants.

### Phase 10 — Enterprise and government

**Status: Local enterprise/government control-plane and adapter-substitution gate complete; hosted deployment and certification evidence remain open.**

Add SSO/OIDC/SAML, SCIM, service accounts, advanced RBAC/ABAC, private runners, customer cloud,
private Kubernetes/on-premise options, regional/data-residency controls, customer-managed keys,
retention/legal hold, extensive export, predictable government commitments, procurement evidence,
support tooling, and customer-owned adapter substitutions.

**Exit gate:** A customer can replace hosted inference, compute, storage, and vault adapters with
approved private or government infrastructure without changing the Spyderbyte product model.

**Completion record (2026-08-07):** The local/contract-level Phase 10 exit gate is satisfied. The
new `packages/backends/src/enterprise-government.ts` module adds versioned enterprise/government
profile, service-account, RBAC/ABAC, runner, adapter, Run, retention/deletion, export, support,
commitment, procurement, and audit contracts. It enforces residency and data-class boundaries,
customer-managed-key references, digest-only credential rotation, legal holds, independent
deletion approval, redacted evidence, and approved private Kubernetes, on-premise, customer-cloud,
hosted Kubernetes, and SLURM runner kinds. The adapter set composes customer-owned inference,
compute, storage, vault, and customer key-management ports through the same
`EnterpriseRunRequestV1` and `EnterpriseRunResultV1` product model.

The local API exposes the control-plane surface under `/v1/enterprise/control-plane/*`. Existing
OIDC/SAML SSO, SCIM, enterprise secret handles, hosted execution, governance, recovery, and local
retention foundations remain intact. Acceptance evidence is in
[`audit-artifacts/2026-08-07-spyderbyte-phase-10/enterprise-government.md`](audit-artifacts/2026-08-07-spyderbyte-phase-10/enterprise-government.md),
[`packages/backends/tests/phase10-enterprise-government.test.ts`](packages/backends/tests/phase10-enterprise-government.test.ts),
and [`packages/local-api/tests/phase10-enterprise.test.ts`](packages/local-api/tests/phase10-enterprise.test.ts).
The affected package suites, repository lint/typecheck/build, contract generation, API contract,
package-boundary checks, invariant tests, and the tracked-artifact guard pass. The original Phase 10
run recorded an unrelated provider-runtime update-manifest assertion and seven formatting files;
those are retained in the audit record as historical evidence. A subsequent clean-baseline
`pnpm verify` rerun passes the repository-wide contracts, formatting, lint/boundary, typecheck,
test, invariant, and build gates. Real hosted identity/KMS/HSM/private-infrastructure deployment,
government authorization, certification, and release evidence remain open.

### Phase 11 — Release, operations, and product guardrails

**Status: Complete locally (2026-08-07); credentialed/native signed release, hosted, and organizational gates remain open.**

Complete cross-platform distribution for macOS arm64/x86_64, Linux x86_64/arm64, and Windows x86_64
where supported; Spyderbyte-owned stable/beta/nightly channels, signature validation, installer,
update, rollback, desktop launcher compatibility, and deep-link preparation.

Complete security, privacy, and operations gates: shell/process audit, sandbox tests, secret
forwarding tests, branding scan, license scan, dependency/image/container scan, configurable
telemetry, SLO/load/capacity decisions, backup/restore, DR, incident runbooks, support bundle
redaction, crash/restart/reconnect, and Gatekeeper/notarization evidence.

Track product metrics: install/download, first successful Run, project creation, weekly active
individuals, Runs/user, artifact reuse, Run success, managed conversion, organizational creation,
shared project adoption, ARR, usage revenue, provider/runtime failure, approval bypass, artifact
loss, unrecoverable Runs, queue latency, and margin compression.

**Exit gate:** A clean supported machine passes the complete local first-run journey and release
evidence; hosted and organizational release gates pass their own environments and no user-facing
Codex/OpenAI product assumptions remain.

**Completion record (2026-08-07):** The local Phase 11 implementation and evidence gate are
complete. The release matrix, stable/beta/nightly channel model, Ed25519 update-manifest
verification, installer target selection, update/rollback API and TUI surfaces, Spyderbyte
desktop identity/deep-link preparation, sandbox/process and secret-forwarding controls, telemetry
consent boundary, SLO/capacity helpers, backup/restore/DR contracts, incident runbook, support
bundle redaction, bounded daemon restart/reconnect, and product-metric vocabulary are implemented
and covered by local checks.

Evidence:

- [`scripts/verify/check-phase11-local.mjs`](scripts/verify/check-phase11-local.mjs) validates the
  Spyderbyte desktop identity, deep-link/updater configuration, target matrix, signed manifest
  fixture, security-scan wiring, operations docs, and product-metrics contract.
- [`scripts/release/release-targets.mjs`](scripts/release/release-targets.mjs),
  [`scripts/release/build-platform-release.mjs`](scripts/release/build-platform-release.mjs),
  [`scripts/release/write-platform-release-manifest.mjs`](scripts/release/write-platform-release-manifest.mjs),
  and [`scripts/release/verify-platform-release-manifest.mjs`](scripts/release/verify-platform-release-manifest.mjs)
  cover macOS arm64/x86_64, Linux arm64/x86_64, and Windows x86_64 target selection and signed
  release metadata. All five target dry-runs passed.
- [`packages/provider-runtime/tests/phase11-release.test.ts`](packages/provider-runtime/tests/phase11-release.test.ts),
  [`packages/local-api/tests/phase11-release.test.ts`](packages/local-api/tests/phase11-release.test.ts),
  [`packages/observability/tests/observability.test.ts`](packages/observability/tests/observability.test.ts),
  and the local-daemon, state-recovery, sandbox, and shell suites cover signature failure,
  rollback, redaction, consent, first-run/reconnect/recovery, process boundaries, and shell
  command parity.
- `pnpm verify` passed on 2026-08-07: contracts, Phase 11 verifier, pinned-container check,
  formatting, lint/boundary checks, typecheck (33 packages), tests, invariants, and the desktop
  bundle build. `pnpm test:integration` passed across 50 workspace tasks; database-backed cases
  were skipped because no `DATABASE_URL` was configured.
- [`docs/operations/phase11-local-targets.md`](docs/operations/phase11-local-targets.md),
  [`docs/operations/phase11-product-metrics.md`](docs/operations/phase11-product-metrics.md),
  and [`docs/runbooks/phase11-release-operations.md`](docs/runbooks/phase11-release-operations.md)
  record local thresholds, metric ownership boundaries, release/recovery procedures, and
  credential requirements.
- [`audit-artifacts/2026-08-07-codex-phase-0/migration-audit.md`](audit-artifacts/2026-08-07-codex-phase-0/migration-audit.md)
  remains the license/provenance evidence: the audited boundary has no direct Codex dependency or
  source import, and the Apache-2.0/NOTICE checks passed.

Open external gates are deliberate: credentialed macOS Developer ID signing, notarization,
stapling, Gatekeeper validation, and native Linux/Windows artifact publication were not run on
this macOS workstation; `pnpm release:macos` remains fail-closed until those credentials and
artifacts exist. The CI dependency audit, gitleaks, and Trivy jobs are configured but their hosted
execution/results remain external. Hosted SLO/load/capacity, backup/restore/DR exercises, remote
telemetry export, and organizational release evidence remain owned by their respective
environments.

## 10. Golden-path acceptance scenarios

### 10.1 Local individual path

```text
install → spyderbyte → local-only onboarding
→ create/open project → configure local model or BYOK
→ add CSV → ask “Analyze this dataset and explain the main trend.”
→ inspect plan → approve → local Python executes
→ Run streams → chart/report artifact created
→ result explained → ask follow-up → modify/rerun
→ quit/relaunch → recover AgentSession, Run, artifacts, and lineage
```

### 10.2 Local-to-cloud path

```text
local Run → insufficient local capacity
→ explain restriction and estimate Spyderbyte Cloud
→ user approves → hosted Run/Attempt executes
→ events stream → artifact returns to same project
→ local and hosted Runs remain comparable in history
```

### 10.3 ACP path

```text
ACP initialize → project/session context → prompt
→ Spyderbyte plan → policy/permission request
→ client approval → universal Run → event stream
→ artifact/usage/audit → reconnect/recover
```

### 10.4 Organization path

```text
invite user → shared workspace/project
→ centralized provider/credential policy
→ governed plan and budget approval
→ shared Run/artifact/history/audit
→ policy explains unavailable provider/runtime
```

### 10.5 Clean product installation

The clean-machine test must cover installation, first launch, local/offline mode, provider/model
setup, project detection/creation, CSV analysis, plan/approval, Run stream, artifact lineage,
Jupyter handoff, relaunch, cloud upgrade when enabled, update/rollback, and uninstall/data
preservation. It must not require manually starting a daemon or editing backend configuration.

## 11. Testing and evidence contract

Every phase adds evidence in the following layers:

1. **Contract tests:** schema, compatibility, serialization, error, and state-machine behavior.
2. **Unit/property tests:** canonicalization, IDs, policy, budgets, redaction, provider/runtime
   selection, and event deduplication.
3. **Adapter tests:** provider, compute, object, workflow, secret, identity, billing, and shell
   boundaries with deterministic fixtures.
4. **Integration tests:** API/client/daemon/worker/Run/artifact/usage/approval behavior.
5. **Shell regression tests:** rendering, composer, multiline input, scroll, resize, dialogs,
   output, keybindings, terminal restoration, JSON output, and exit codes.
6. **Cross-interface tests:** equivalent AgentSession, Run, event, artifact, usage, and audit
   records from TUI, CLI, ACP, API, web, Jupyter, and automation.
7. **Failure injection:** backend restart, local worker crash, terminal resize, network loss, SSH
   disconnect, client restart, lease recovery, cancellation, provider failure, artifact failure,
   budget/policy denial, and cloud runtime destruction.
8. **Security/release tests:** secret non-disclosure, path/project boundaries, network policy,
   approval bypass resistance, license/provenance, branding scan, signed artifacts, Gatekeeper,
   update/rollback, and clean-machine install.

Required evidence commands for the current TypeScript repository remain:

```text
pnpm contracts:check
pnpm api-contracts:check
pnpm frontend-contracts:check
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:invariants
pnpm build
pnpm verify
```

The Codex-derived shell adds its own Rust/Bazel/package checks only after Phase 0 selects the build
boundary. All checks must run without silently skipping required database, hosted, release, or
architecture evidence.

## 12. Branding, licensing, and independence checks

Production scans must categorize every occurrence of `Codex`, `codex`, `OpenAI Codex`, and
`@openai/codex` as legal attribution, internal vendored namespace, migration evidence, or bug. No
unintended user-facing occurrence is allowed.

The final dependency direction is:

```text
Codex-derived UI primitives → Spyderbyte shell
Spyderbyte shell → Spyderbyte clients/contracts
Spyderbyte clients → Spyderbyte Agent + platform
```

It must never be:

```text
Spyderbyte platform → Codex Agent
```

Apache-2.0 notices, copyright, provenance, modified-file tracking, third-party dependencies, and
non-endorsement language must be preserved. The shell must be theoretically replaceable without
rewriting the Spyderbyte platform.

## 13. Human decision gates

The implementation must request a decision before:

1. importing Codex source or adding a new upstream dependency;
2. selecting Rust/TypeScript/bridge architecture for the extracted shell;
3. choosing ACP transport/version and representative compatibility clients;
4. making Cline or any other model runtime the production Agent implementation;
5. selecting hosted vendors, regions, data residency, or customer infrastructure;
6. approving pricing, entitlements, usage rates, prepaid/commitment billing, or government caps;
7. changing credential, sandbox, policy, approval, audit, or artifact authority boundaries;
8. changing release architecture, supported platforms, signing/notarization, update channels, or
   data-preservation behavior.

## 14. Status ledger and next actions

The current overall program status is **In progress**. Phases 0 through 10 and the local Phase 11
scope are complete for their documented local scope; hosted deployment/certification, commercial
decisions, and credentialed/native release gates remain open.

Immediate order:

1. Re-fetch or authenticate the upstream commit/release digest before any future upstream source
   synchronization; the current local snapshot is recorded by deterministic manifest digest.
2. Keep `apps/spyderbyte-shell` isolated and extend its typed event/rendering coverage only through
   Spyderbyte-owned contracts; do not add Codex domain or account behavior.
3. Continue the local-first golden path and close remaining Phase 6 artifact/notebook and release
   evidence gaps without moving authority into the shell or ACP adapter.
4. Implement hosted Spyderbyte Cloud execution while preserving the same AgentSession, Run, event,
   artifact, usage, audit, and policy contracts.
5. Continue through hosted deployment, commercial, and release gates in order.

Each completed action must add a dated evidence record to this plan and update the relevant phase
status. This plan is the declarative record going forward.
