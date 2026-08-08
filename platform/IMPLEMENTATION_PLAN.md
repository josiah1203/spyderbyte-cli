# Agentic ML/Data Platform Implementation Plan

> **Superseded:** This is a historical platform-foundation implementation record. The authoritative
> plan going forward is [`SPYDERBYTE_IMPLEMENTATION_PLAN.md`](SPYDERBYTE_IMPLEMENTATION_PLAN.md).
> Keep this file as evidence; do not use it for new status updates or phase decisions.

> Historical foundation execution record
>
> Status: Historical; superseded by the declarative Spyderbyte plan
> Source architecture: `Agentic ML/Data Platform — End-to-End Runtime and Harness Architecture`
> Last updated: 2026-08-04

> Spyderbyte frontend/product readiness: approximately 25–35% remaining. The supplied
> `/Users/josiah/Documents/frontend design/platform-focus-wireframe` repository is the visual
> acceptance target; the earlier `apps/web` card shell is not the acceptance target.

## 1. Purpose and operating contract

This file is the implementation authority for building the platform in this repository. Codex must use it as an execution plan, not as background reading. The platform must be built incrementally, with every phase producing a runnable, tested increment and every consequential design decision recorded before it becomes expensive to reverse.

The target is an agentic ML/data platform with four planes:

1. **Interaction plane:** chat, workspace panels, approvals, jobs, compute, catalog, models, connectors, governance, repositories, and cost views.
2. **Control plane:** commands, workflows, planning, policy, approvals, budgets, eventing, state transitions, artifact management, and audit.
3. **Execution plane:** Tier 0 orchestration, Tier 1 specialist harnesses, Tier 2 coding/plugin/deterministic task harnesses, and isolated execution environments.
4. **Resource plane:** local compute, Kubernetes or SLURM, object storage, source repositories, experiment tracking, catalogs, model registries, secrets, serving systems, and external connectors.

The central implementation rule is:

> The frontend, control plane, orchestrator, specialists, and workers must operate on the same versioned artifact and event model. No component may maintain an independent interpretation of durable state.

The product release priority is now explicit:

> Spyderbyte v1 is the first shippable product: a signed, notarized macOS application distributed as a DMG, with a local daemon, local workspace/artifact state, OS-native secret storage, offline-capable license validation, and the same versioned contracts used by the future hosted plane. Hosted infrastructure must not block the Spyderbyte release.

### 1.3 Spyderbyte frontend acceptance correction

The frontend-folder prototype is the product reference for Spyderbyte. It is not a second
production application: its component anatomy and visual tokens are to be carried into the
monorepo `/apps/web`, while its local API actions remain the authority for durable behavior.

The supplied prototype is a focused analysis-workspace screen, not a complete set of wireframes
for every local-product flow. Therefore the implementation uses the supplied screen as the
faithful workspace surface and derives the surrounding screens from the same three-pane anatomy:

| Product flow | Supplied prototype surface or derived extension | Authoritative local action |
|---|---|---|
| First-run and license | License chip, import gate, settings License & edition | signed entitlement import, status, Keychain receipt |
| Workspace | Tree sidebar, workspace selector, storage drawer | workspace open/switch/export/backup/import |
| Provider setup | Provider/model flow view and Keychain status | provider adapter and secret-handle boundary |
| Objective | New/objective flow with dataset staging | typed `RuntimeCommand` plan request |
| Plan review | Plan-review card and approval state | action-digest-bound plan/approval routes |
| Live run | Results surface and run-details drawer | workflow run, projection reads, reconnectable SSE |
| Artifacts | Artifact/lineage flow view and conflict alert | immutable versions, lineage, export |
| Storage | Portable workspace controls in the drawer/settings | checksummed archive, backup, restore preview/import |
| Settings | Vibe settings modal with grouped sections | license, connections, storage, diagnostics settings |

The SQL/result content in the supplied prototype remains explicitly marked as a design preview
until query persistence, provider/model execution, and artifact-version behavior are connected.
The production path must not use simulated run timers or toast-only navigation.

### 1.1 Instructions Codex must follow

For every implementation turn:

1. Read this file and identify the first incomplete Spyderbyte release-track work package whose prerequisites are satisfied. Hosted work is not the next action while a Spyderbyte release gate is incomplete.
2. Inspect the repository and existing changes before editing. Preserve unrelated user changes.
3. Confirm that the proposed work does not violate any invariant in Section 4.
4. Implement the smallest complete vertical increment, including production code, tests, documentation, and migration changes where applicable.
5. Use contract-first development: schemas and failure behavior precede adapters, UI, and agent prompts.
6. Run the validation commands required by the work package.
7. Do not mark work complete if tests are skipped, acceptance criteria are unmet, or a required decision remains unresolved.
8. Update the progress ledger and decision log in this file only after the implementation and validation succeed.
9. Stop and request user direction at an explicit human decision gate or when a decision materially changes product scope, security posture, deployment topology, or cost.
10. Never weaken authority, approval, audit, artifact-versioning, or secret-handling rules to make a test pass.

### 1.2 Definition of implementation-complete

The platform is implementation-complete when:

- A user can submit a typed command that creates or resumes a durable workflow.
- Tier 0 creates a validated plan and can invoke only registered Tier 1 specialists.
- Tier 1 specialists can invoke only registered Tier 2 tasks and can commit domain decisions through control-plane services.
- Tier 2 cannot create agents or broaden its authority.
- Every invocation is bounded by authority, budget, resource, time, retry, and tool envelopes.
- Every accepted report passes schema, artifact, metric, cost, and acceptance-policy validation.
- Every published artifact is immutable, versioned, content-addressed, and traceable to its creator and inputs.
- Human-created artifact versions take precedence and downstream staleness is propagated correctly.
- Approvals bind to exact action digests and are invalidated by material changes.
- Production secrets never enter model context or logs.
- A local end-to-end ML workflow and a hosted end-to-end ML workflow implement the same contracts.
- Frontend views are projections of authoritative events rather than independent state machines.
- Workflow recovery, retries, cancellation, reconnectable event streaming, audit, and rollback pass failure-injection tests.
- Operational dashboards, alerts, runbooks, backup/restore, and disaster-recovery exercises exist and pass their release gates.

Spyderbyte v1 is release-complete when:

- A clean supported Mac installs the signed and notarized DMG and launches without a developer override.
- The desktop host starts, health-checks, and recovers the local daemon and preserves workspace data across restart and upgrade.
- A user can create/open/import/export a workspace, connect a provider through the OS keychain, run the local dataset workflow, inspect projections, and export artifacts without a vendor control plane.
- The license is verified from a signed entitlement at startup and at effectful command boundaries, with explicit invalid/expired/offline behavior.
- The production frontend completes the first-run, objective-to-plan, approval, run, artifact, settings, license, and backup journeys against the real local API.
- Release CI produces checksummed macOS artifacts and records install, Gatekeeper, restart recovery, offline, update, and rollback evidence.

## 2. Scope

### 2.1 In scope

- Runtime contracts for commands, workflows, plans, invocations, reports, artifacts, events, approvals, budgets, authority, policies, resources, metrics, costs, failures, and agents.
- Durable command handling, workflow coordination, event publication, projections, optimistic concurrency, idempotency, retries, cancellation, and recovery.
- Tier 0, Tier 1, and Tier 2 harness construction and mechanical nesting enforcement.
- Cline SDK integration behind an internal runtime adapter.
- Context assembly, tool brokerage, model routing, usage metering, policy enforcement, lifecycle hooks, and report validation.
- Initial specialists: Governance, Data Engineer, ML Engineer, Cluster, MLOps, Eval, Deployment, FinOps, Data Quality, and Connector Engineering.
- Tier 2 coding, plugin-backed, and deterministic worker shapes.
- Local development mode and hosted deployment mode.
- Local compute first, followed by one cloud scheduler backend.
- Artifact and event backed frontend views.
- Evaluation, security, observability, audit, operations, and release engineering.
- Local productization: desktop host, daemon lifecycle, workspace portability, macOS keychain integration, license validation, production frontend, DMG distribution, signing, notarization, update, and rollback.

### 2.2 Deferred until the relevant phase

- Supporting both Kubernetes and SLURM in the first cloud release. Implement one, retain the shared adapter, add the second only after the first passes production readiness.
- Multiple experiment trackers in the initial release. Implement one adapter and contract-test the interface.
- Arbitrary third-party connector publication. Begin with one reference connector and a sandbox-only registry.
- Fully autonomous production rollout. Production deployment remains approval-gated.
- Fine-grained multi-region active/active operation. Begin with single-region high availability and tested recovery.
- Hosted database, event transport, scheduler, production identity, and hosted secret manager are deferred from Spyderbyte v1; provider-neutral contracts and local adapters remain in scope.
- Cloud billing is deferred from Spyderbyte v1. The local product exposes entitlement, edition, feature access, local usage, and diagnostics instead.

### 2.3 Explicitly out of scope

- An agent bypassing the control plane to mutate durable state.
- Raw production credentials in prompts, artifacts, traces, or worker environment dumps.
- Tier 0 shell, filesystem-write, compute-allocation, model-promotion, connector-publication, or secret-read tools.
- Tier 1 directly creating another Tier 1.
- Tier 2 creating any agent.
- Frontend business logic that independently decides approval, promotion, governance, budget, or retry policy.
- Treating vector search, caches, chat history, or model memory as the source of truth.
- Requiring an online control plane for the Spyderbyte to launch, validate an offline license, open a workspace, or export user data.
- Shipping an unsigned or unnotarized macOS installer as a production release.

## 3. Baseline technical decisions

The repository is currently greenfield. The following are implementation defaults, not hidden assumptions. Record any change as an ADR before adopting it.

### 3.1 Language and repository

- TypeScript for control-plane, harness, adapter, and frontend code.
- A pnpm workspace monorepo.
- Node.js current LTS, pinned in repository tooling.
- Strict TypeScript settings with no unchecked implicit `any`.
- JSON Schema as the language-neutral wire contract, with TypeScript validators generated or derived from a single schema authority.
- PostgreSQL for hosted authoritative metadata.
- SQLite for the local metadata implementation, provided it passes the same repository contract tests.
- S3-compatible object storage for hosted artifacts; a content-addressed filesystem implementation for local mode.
- SHA-256 content hashes and immutable object keys.
- OpenTelemetry for traces, metrics, and log correlation.

### 3.2 Application layout

```text
/apps
  /api                 # Hosted command/query/subscription API
  /local-api           # Reusable HTTP transport and API session boundary
  /web                 # Interaction plane
  /desktop             # Tauri macOS host, lifecycle, IPC, deep links, and packaging
  /local-daemon        # Local API and runtime composition
  /worker              # Durable workflow and task workers
  /sandbox-runner      # Tier 2 isolated execution entrypoint

/packages
  /runtime-contracts   # Schemas, IDs, enums, versioning, codecs
  /runtime-domain      # Pure domain state machines and decisions
  /state               # Repositories, transactions, event/outbox stores
  /projections         # Workflow, job, artifact, cost, approval, audit views
  /harness-core        # Harness factory and shared interception pipeline
  /cline-adapter       # The only package allowed to import Cline SDK APIs
  /orchestrator        # Tier 0 planner, validator, scheduler, aggregator
  /specialists         # Tier 1 specialist packages
  /tasks               # Tier 2 coding, plugin, and deterministic tasks
  /policy              # Authority, policy, approval, action digest
  /budget              # Reservation, metering, reconciliation
  /artifact-registry   # Artifact publication and lineage
  /agent-registry      # Harness registration and compatibility
  /license              # Signed entitlement validation and edition/feature policy
  /workspace            # Local workspace layout, migration, export, import, and backup
  /backends            # Compute, catalog, experiment, registry adapters
  /tool-broker         # Capability grants and execution boundary
  /observability       # Telemetry, audit, redaction, usage
  /testkit             # Contract fixtures, fakes, harness test utilities

/deploy
  /local
  /kubernetes          # Or selected hosted scheduler
  /observability

/docs
  /adr
  /contracts
  /runbooks
  /threat-models
  /evaluations

/scripts
  /ci
  /dev
  /release
```

### 3.3 Durable execution and messaging

- Introduce a `WorkflowEngine` internal interface before selecting a durable engine implementation.
- Use the embedded durable coordinator and SQLite-backed workflow state as the default Spyderbyte runtime; it must support restart recovery, cancellation, approval waits, idempotency, and replay without a hosted service.
- Use a deterministic in-process engine only for unit tests and the earliest local slice.
- Use Temporal as the default durable execution implementation in Phase 6, subject to an ADR and a proof-of-concept that verifies workflow replay, cancellation, signals, upgrades, and TypeScript worker operations.
- Treat PostgreSQL as the authority for domain aggregates and artifact metadata.
- Use a transactional outbox so database state and publishable events commit atomically.
- Use NATS JetStream as the default hosted event transport after the outbox, subject to an ADR. Consumers must be idempotent because transport-level redelivery is expected.
- Never claim exactly-once end-to-end side effects. Implement effectively-once processing with idempotency keys, aggregate versions, deduplication records, and side-effect receipts.

### 3.4 Policy and authorization

- Enforce identity and tenancy at the API and repository layers.
- Represent invocation permissions with signed or server-verifiable `AuthorityEnvelope` objects.
- Use an internal policy interface with a local deterministic implementation first.
- Use OPA as the default hosted policy decision point after policy inputs and outputs stabilize.
- Re-evaluate authorization and approval at commit time for durable effects; a tool grant or approval that was valid when work began may have expired or been invalidated before commit.

### 3.5 Cline integration

- Only `/packages/cline-adapter` may import Cline SDK packages.
- Business code depends on the internal `AgentRuntimeAdapter` interface.
- Pin the SDK in the lockfile.
- Add compatibility tests for agent creation, structured output, tool calls, streaming events, cancellation, error mapping, and usage reporting.
- Do not expose provider credentials directly to an agent. The adapter must receive a model client or credential handle from the brokered runtime.

### 3.6 Initial product slice

The first vertical slice is:

```text
ValidateDataset command
  -> workflow
  -> Tier 0 plan
  -> Data Engineer Tier 1
  -> deterministic schema/profile/leakage Tier 2 tasks
  -> ValidatedDataset artifact
  -> normalized report
  -> workflow/artifact/audit projections
  -> live API response and event stream
```

The second vertical slice extends this to:

```text
ValidatedDataset
  -> ML Engineer Tier 1
  -> training configuration
  -> Cluster compute offer
  -> optional approval
  -> local smoke training task
  -> checkpoint and report
```

The first Spyderbyte release slice wraps both vertical slices in:

```text
DMG install
  -> desktop host starts local daemon
  -> license status is verified
  -> workspace is created or opened
  -> provider credential is stored in macOS Keychain
  -> objective/chat creates a typed plan
  -> approval and budget checks run locally
  -> workflow executes through API/SSE projections
  -> artifacts are versioned and exported
```

## 4. Non-negotiable invariants

These invariants must be enforced in code and tested. Prompt instructions are insufficient.

1. Tier 0 can invoke only Tier 1.
2. Tier 1 can invoke only Tier 2.
3. Tier 2 cannot invoke agents.
4. Only the Cluster specialist may allocate compute.
5. Only Governance may issue policy decisions.
6. Only FinOps may reserve or reconcile budget.
7. Only Deployment may alter serving traffic.
8. Only deterministic registry services may publish approved connectors or models.
9. Production credentials are never placed in agent context.
10. Every consequential action emits an audit event.
11. Published artifacts are immutable and versioned.
12. Human-created versions take precedence over agent-created versions.
13. Every invocation has explicit authority, cost, time, resource, retry, and tool limits.
14. Every agent output is schema-validated before acceptance.
15. Tier 2 success means mechanical acceptance criteria passed; it does not validate the parent strategy.
16. An approval binds to exact artifact versions, resource scopes, targets, action parameters, and estimated cost.
17. Frontend panels contain no independent orchestration, ML, governance, approval, budget, or deployment policy.
18. Local and hosted deployments implement the same public contracts.
19. Tier 2 must not use an LLM when a deterministic implementation is sufficient.
20. Cline-specific APIs remain isolated behind the Cline adapter.
21. Authority and approval are checked again immediately before a durable side effect commits.
22. Event consumers and external side effects are idempotent.
23. Tenant identifiers are part of every authoritative lookup and uniqueness boundary.
24. No artifact content is mutable after publication; edits create a new version.
25. A cache, projection, search index, model context, or event transport is never the sole source of authoritative state.

Required invariant tests belong in `packages/testkit/src/invariants/` and run in every CI build.

## 5. Canonical runtime model

### 5.1 Runtime sequence

```text
RuntimeCommand
  -> command validation and idempotency
  -> aggregate transaction
  -> Workflow creation/resumption
  -> Tier 0 AgentInvocation
  -> validated ExecutionPlan
  -> Tier 1 AgentInvocation(s)
  -> Tier 2 task invocation(s)
  -> AgentReport validation
  -> domain decision commit
  -> Artifact publication + RuntimeEvent append
  -> projection updates
  -> client subscription updates
```

### 5.2 Aggregate boundaries

- **Workflow aggregate:** objective, plan versions, workflow state, invocation references, completion criteria, constraints, and high-level budget reference.
- **Invocation aggregate:** lifecycle, parent relationship, harness version, envelopes, attempt history, report reference, and terminal status.
- **Artifact aggregate:** logical identity, immutable versions, ownership, lineage, lifecycle state, content location, and hash.
- **Approval aggregate:** action digest, risk, approver policy, decision, validity, expiration, revocation, and exact bound resources.
- **Budget aggregate:** limit, reservations, actual usage, adjustments, reconciliation, and alerts.
- **Agent registration aggregate:** harness identity, version, tier, supported contracts, required capabilities, status, and rollout policy.

Do not combine all runtime state into a single workflow document. Transactions should protect one aggregate plus the outbox; cross-aggregate processes use idempotent coordinators.

### 5.3 Identifier and time rules

- Use opaque sortable IDs such as UUIDv7 or ULID. Select one in ADR-0002 and use it consistently.
- IDs are never reused across tenants.
- Store timestamps as UTC instants and serialize as RFC 3339.
- Store money as integer minor units plus ISO currency code. Do not use binary floating point for ledger amounts.
- Store token, byte, duration, and compute quantities as integers with explicit units.
- Include `schemaVersion` in every durable command, event, report, and artifact-content envelope.

### 5.4 Event naming and compatibility

Use versioned event names, for example:

```text
workflow.created.v1
workflow.planned.v1
invocation.started.v1
invocation.report-accepted.v1
artifact.published.v1
artifact.descendants-marked-stale.v1
approval.requested.v1
approval.granted.v1
budget.reserved.v1
compute.allocation-created.v1
deployment.traffic-shifted.v1
```

Compatibility rules:

- Never change the meaning of an existing event version.
- Add optional fields only when old consumers remain correct.
- Introduce a new event version for semantic or required-field changes.
- Preserve raw events indefinitely according to retention policy.
- Upcasters are deterministic, pure, versioned, and covered by fixtures.
- Projections must be rebuildable from an explicit cursor or snapshot plus subsequent events.

## 6. Progress ledger

Codex must update this table after a phase gate passes. Do not mark partial work complete.

| Phase | Name | Status | Evidence |
|---|---|---:|---|
| 0 | Repository bootstrap and ADRs | Complete | Monorepo config, 22-package skeleton, strict verification, CI workflow, PostgreSQL integration smoke test, and ADR-0001 through ADR-0010 added. `pnpm install --frozen-lockfile`, `pnpm verify`, `pnpm test:integration`, and a temporary-Git `git diff --check` over implementation files pass. |
| 1 | Runtime contracts | Complete | `packages/runtime-contracts` contains versioned TypeScript contracts, primitive/core Ajv validators, canonical JSON Schema, generated docs/drift checking, pure state machines, error taxonomy, fixtures, and property tests. Final package suite: 78 tests passed; testkit hierarchy invariants: 2 tests passed. |
| 2 | Authoritative state and artifacts | In progress | Authoritative SQL schema and tenant+workspace keys, PostgreSQL, SQLite, and in-memory repository/transaction ports, a shared state contract suite, transactional events/outbox/idempotency, command dispatcher, filesystem/in-memory CAS object stores, streamed artifact publication, rebuildable tenant-bound projections with a reusable built-in reader, append-only artifact-version guards, tenant-scoped retention/deletion planning with legal-hold, approval, bounded-batch, cursor, and tombstone safeguards, and failure-injection tests are implemented. Artifact publication metadata, lineage, CAS metadata, and lifecycle status now commit through the state transaction. PostgreSQL migration application is serialized with a transaction-scoped advisory lock, and Turbo now forwards `DATABASE_URL` so integration workers cannot silently skip the database contract suite. `pnpm verify`, the SQLite state/migration tests, and the forced local PostgreSQL integration graph pass; hosted production execution remains the phase-gate follow-up. |
| 3 | Policy, authority, approvals, and budget | Complete | Integrity-protected, invocation-bound authority envelopes with scoped resources and revocation epochs, typed/versioned/reproducible policy decisions, approval services with exact action digests and commit-time revalidation, concurrency-safe integer-minor-unit budget reservations/reconciliation, audited short-lived tool grants, and secret-redacted tool execution are implemented. Focused security tests cover revoked approvals, undeclared operations, concurrent hard-limit enforcement, resource-scope escape, and redaction; the final `pnpm verify` suite is green. |
| 4 | Harness core and invocation enforcement | Complete | Harness factory validation, mechanical tier hierarchy, parent-pinned authority/budget/resource delegation, trust-separated context manifests, policy-routed metered model calls, cancellation/deadlines, bounded provider fallback, a provider-neutral `AgentRuntimeAdapter` over Cline-compatible streamed-event/usage/error interfaces, ordered hooks, authoritative report verification, and an internal SDK-shape compatibility fixture are implemented. Focused harness tests and the full 22-package `pnpm verify` suite pass; the Cline SDK remains isolated behind the adapter. |
| 5 | Local dataset vertical slice | Complete | Deterministic CSV/JSON profiling, schema/type checks, PII governance, duplicate and split-leakage detection, Governance/Data Engineer scheduling, authority-bound invocations, immutable output artifacts, workflow/invocation event history, idempotent command replay, source-version conflict detection, cancellation handling, SQLite plus filesystem-CAS reopening, a local CLI, tenant-scoped workflow/plan/invocation/event and artifact/lineage query routes, local capacity inspection, invocation sandboxes, and the full fixture matrix are implemented. Focused Phase 5 tests and the full 22-package `pnpm verify` suite pass. |
| 6 | Durable execution and live recovery | In progress | The internal durable workflow engine persists engine state in authoritative workflow records, supports start/signals/activity scheduling/approval waits/cancellation/restart recovery, records retry ownership, propagates abort signals to active handlers, ignores late terminal completions, and is wrapped by a replacement-safe worker. An external durable-engine adapter now preserves the same workflow contract. Explicit compatible workflow-definition upgrades now update the authoritative version, emit an audit event, and invalidate stale handles. Cursor replay, retention-gap detection with advancing recovery cursors, tenant authorization, event deduplication, per-consumer acknowledgment, visibility-lease redelivery, parking, replay, real `text/event-stream` delivery with disconnect cancellation, duplicate-command fan-in, and an actual SQLite-backed worker process-kill/replacement test are implemented. Temporal proof-of-concept remains open. |
| 7 | Training and compute vertical slice | In progress | Local CPU/RAM/GPU inventory, offers, Cluster-only allocation grants, subprocess jobs, observation/termination, deterministic rate-based estimated/actual cost metering, failure classification, ML Engineer candidate configs, sequential execution of both candidates, cumulative reconciled budget enforcement, deterministic best-candidate selection, checkpoint/lineage summaries, OOM handling, and a deterministic coding sandbox with path, secret, dependency, diff, required-check, and injected immutable patch-artifact publication gates are implemented and tested. Hosted compute and container/worktree isolation remain open. |
| 8A | Spyderbyte productization and macOS distribution | In progress | The first local release slice is implemented: `packages/license` validates fail-closed Ed25519 entitlements and gates daemon/API effects; `packages/workspace` creates, opens, imports, and exports portable SQLite/CAS workspaces and provides checksummed `agentic.workspace.archive.v1` export, integrity/path validation, restore preview, and non-overwriting restore; `packages/local-api` owns reusable HTTP/session/SSE transport and exposes workspace metadata, archive export, restore preview/import, typed command-plan, and reviewed-workflow-run routes; `/apps/web` now carries the supplied frontend-folder Vibe three-pane workspace anatomy, local license state, signed-license import, workspace-switch actions, storage export/import controls, derived provider/objective/plan/run/artifact/storage/settings checkpoints, and a workflow composer that stages CSV content, publishes an immutable source artifact, creates a typed `ValidateDataset` plan, and shows a Vibe review card with approval/rejection controls that keeps execution disabled until the action-digest-bound request is approved; `/apps/desktop` is a Tauri 2 host supervising a self-contained Node local-daemon sidecar on an OS-assigned loopback port with bearer continuity, HttpOnly SSE cookie transport, Keychain receipt persistence, mode-0600 daemon cache, bounded restart, single-instance/window focus, native workspace/archive dialogs, and persisted active-workspace selection. Secure signed-license loopback smoke completed with session/auth, license revalidation, and entitlement mode-0600 evidence. Real authenticated loopback plan/approval smoke completed with plan `200`, two governed steps, pending run `awaiting_approval`, approved decision, and reviewed run `202`/`completed`; workspace smoke completed with metadata `200`, archive export `201`, restore preview `200`, import `201`, and preserved workspace ID. The full workspace build (`pnpm build`) passed on 2026-08-04 after routing the desktop task through the repository-owned headless packager; the platform-aware desktop build compiles the Tauri host without a macOS installer on non-macOS CI, while macOS builds the app and DMG. The packager creates and read-only mounts the DMG with `hdiutil` without Finder/AppleScript automation, and the user-facing `bundle:dmg` command completes end to end. The latest developer x86_64 DMG contains the app bundle and Applications drop link, with bundle ID `com.agentic.platform.local`, minimum macOS `13.0`, and SHA-256 `1383e3a4be1e28cb1a416a95adca5822e7449c45fc51f6452722f6ac16184437`; a matching `.sha256` sidecar and manifest are generated and verified. The sidecar builder emits Tauri target-triple names and the release verifier fails closed for missing architecture slices; universal output still requires an Apple Silicon runner because `pkg` cannot execute its arm64 bootstrap on this Intel host. The mounted-DMG release sidecar smoke returned license `valid`, plan version `1`, pending `awaiting_approval`, approved `approved`, and completed `completed`, with three-entry lineage plus export/backup/restore evidence. Approval regression evidence: orchestrator approval-wait and commit validation (13 tests), local daemon API approval plus SQLite reopen persistence (4 tests), and Vibe approval gating (7 tests) pass. Remaining gates: production license key embedding/signing inputs, real provider/model execution replacing preview results, first-run artifact lineage journey, clean-machine Keychain receipt/permission and archive/daemon crash-restart evidence, provider-secret Keychain adapters, universal architecture, Developer ID signing, notarization, Gatekeeper, update/rollback, and clean-machine evidence. |
| 8 | Hosted resource plane | Deferred | Provider-neutral adapters and local fixtures exist, but production PostgreSQL/S3-compatible storage, NATS JetStream, one selected cloud scheduler, production secret manager, hosted worker pools, and hosted backup/restore are deferred until after Spyderbyte v1 and an explicit provider/topology decision gate. |
| 9 | Model lifecycle, evaluation, and deployment | In progress | Local experiment persistence, provider-neutral hosted experiment/registry/deployment adapters, structured lineage-complete model registration (checkpoint, run/configuration, source revision, environment snapshot, validated dataset, and original-data lineage), immutable evaluation/promotion decisions, approval-digest binding, tenant-scoped deployment transitions, canary rollback, shared lifecycle audit records, a typed final reconciliation report for artifacts/metrics/cost/rollout, a reusable local lifecycle composition, and a local candidate-to-evaluation-to-canary-failure rollback scenario are implemented. A production experiment tracker, serving backend, and hosted end-to-end scenario remain open. |
| 10 | Governance and connector publication | In progress | Governance consultations, deterministic connector schema/source/test/package build, static and dependency scans, reproducible sandbox contract tests, material-bound approval digests, author-versus-publisher separation, human approval binding, deterministic publication, tenant-scoped revocation, registry audit records, rollback behavior, and a read-only reference connector with pagination, retry, redaction, credential-handle scope/expiry, and audit coverage are implemented locally. Production credential-handle integration and hosted registry workflow remain open. |
| 11 | Interaction plane | In progress | Projection-driven workflow/artifact/approval interaction state, tenant-scoped catalog/model/deployment/connector/chat projections for every planned panel, cursor replay/gap refresh, optimistic artifact edit commands, explicit two-user conflict handling, cancellation, tenant-scoped workflow/plan/invocation/event and artifact/lineage queries, injected artifact-publication and approval command routes, a browser `HttpProjectionApi`, reconnectable SSE client with last-cursor replay, an injected authoritative projection-read route, bounded collection reads, an injectable local rate limiter, an optional provider-neutral authenticated-session boundary with hashed local bearer fixtures, authenticated JSON/SSE enforcement, a session/workspace snapshot route, tenant-bound workspace selection with projection reset, cookie-capable JSON/SSE transport, the supplied Vibe three-pane workspace anatomy with derived Spyderbyte flow checkpoints, connection/reconnect state, API session-tenant enforcement, shared `RuntimeCommand` request validation, generated OpenAPI drift checks, projection-loading/conflict tests, browser interaction tests, and local visual smoke evidence are implemented. Real provider/model execution, first-run persistence, production identity integration, shared hosted rate limiting, full browser accessibility/E2E coverage, and hosted multi-user validation remain open. |
| 12 | Security, scale, operations, and release | In progress | Correlation-safe redaction, append-only hash-chained audit, lifecycle audit coverage, metrics, threat model, a complete provider-neutral incident runbook set, an expiring scoped break-glass grant with independent human approval and bounded audited use, local SQLite backup/restore exercise, duplicate-command fan-in, consumer redelivery, bounded capacity probes with target-supplied SLO/capacity evaluation, provider-neutral shadow/canary/limited/general rollout gate evaluation with hold-and-rollback evidence, capacity recheck/release, bounded API collection reads, deterministic local rate-limit tests, API tenant-boundary tests, harness evaluation fixtures, a clean `gitleaks` scan, and a clean dependency audit are implemented. Container/image scans, production load/capacity targets, SLO decisions, hosted backup/restore, DR evidence, and hosted release rollout wiring remain open. |

**Phase 8A local gate update — 2026-08-07:** The provider-secret Keychain adapter contract is now
locally verified by direct `/usr/bin/security` command mapping and non-macOS refusal tests in
`packages/provider-runtime/tests/phase1.test.ts`. This closes the adapter-contract slice; signed
clean-machine persistence, Keychain permissions, and the remaining macOS distribution gates remain
open.

For avoidance of doubt, the Phase 8A summary's earlier “provider-secret Keychain adapters” wording
now refers to the signed clean-machine persistence/permission gate; the local adapter contract itself
is complete.

The local artifact inspection slice is also connected to the authoritative API: the Assets screen
loads the current immutable record, version history, content hash/media type, creator, and upstream
lineage on demand, with browser coverage in `apps/web/tests/app.test.tsx`. The broader first-run
artifact-lineage journey and clean-machine release evidence remain open.

The first-run provider setup slice is also connected to the authoritative API: `apps/web` can add a
provider, send an API key only to `/v1/providers`, clear it after submission, show only provider and
credential metadata, and run `/v1/providers/{id}/test`. Browser coverage verifies the add → clear →
preflight journey, while `packages/local-api/tests/phase2.test.ts` verifies the vault boundary and
metadata-only response. Signed clean-machine credential persistence remains open.

The canonical routed React SQL Workbench now hydrates `/sql?queryId=...` from the authoritative
`GET /v1/data/queries/:id` record, restoring the saved SQL, connection/dataset lineage fields,
result rows, and immutable result-artifact metadata after navigation or reload. Browser coverage in
`apps/web/tests/app.test.tsx` verifies the persisted handoff. The legacy compatibility renderer's
supplied preview Results/SQL surface remains non-authoritative; provider/model-backed project
execution, live-run projections, and the complete first-run objective → plan → approval → run
journey remain open. This slice passed `pnpm format:check`, 45/45 web tests, and the full
`pnpm verify` graph on 2026-08-07: 49/49 test tasks, 47/47 invariant tasks, and 30/30 build tasks.

Allowed status values: `Not started`, `In progress`, `Blocked`, `Complete`.

## 7. Phase 0 — Repository bootstrap and architectural decisions

### Goal

Create a reproducible, strict, testable monorepo and make the minimum high-impact decisions needed to begin contract work.

### Work package 0.1 — Initialize the monorepo

Create:

```text
package.json
pnpm-workspace.yaml
tsconfig.base.json
eslint.config.*
prettier.config.*
.editorconfig
.gitignore
.npmrc
.node-version or equivalent
turbo.json or an equivalent task runner configuration
```

Requirements:

- Root scripts: `build`, `typecheck`, `lint`, `test`, `test:integration`, `test:invariants`, `format:check`, and `verify`.
- `verify` must run formatting checks, lint, typecheck, unit tests, invariant tests, and build.
- Package boundaries must be enforced with lint rules or dependency-cruiser style checks.
- CI must use frozen lockfile installation.
- Test output and coverage must be deterministic in CI.

### Work package 0.2 — Create repository skeleton

Create all top-level directories from Section 3.2 with package manifests and placeholder READMEs. Do not generate empty implementation files that imply completed functionality.

### Work package 0.3 — Create ADRs

Create and resolve:

- `ADR-0001-language-monorepo-and-package-boundaries.md`
- `ADR-0002-identifiers-time-money-and-units.md`
- `ADR-0003-schema-authority-and-code-generation.md`
- `ADR-0004-database-and-local-store.md`
- `ADR-0005-durable-workflow-engine.md`
- `ADR-0006-event-transport-and-transactional-outbox.md`
- `ADR-0007-policy-decision-point.md`
- `ADR-0008-object-storage-and-content-addressing.md`
- `ADR-0009-cline-adapter-versioning.md`
- `ADR-0010-web-api-and-subscription-protocols.md`

Every ADR must contain context, decision, alternatives, consequences, migration implications, security impact, observability impact, and rollback/revisit trigger.

### Work package 0.4 — Establish CI

CI must:

- install from the committed lockfile;
- cache dependencies without caching build correctness;
- run `pnpm verify`;
- run database-backed integration tests in an isolated service;
- publish test and coverage results;
- scan dependencies and repository secrets;
- reject generated contract drift;
- reject a dirty working tree after code generation.

### Phase 0 validation

```bash
pnpm install --frozen-lockfile
pnpm verify
git diff --check
```

### Phase 0 exit criteria

- A clean checkout can install and verify without manual steps.
- Package dependency rules are enforced.
- ADRs required for Phase 1 are accepted.
- CI runs the same verification command as local development.
- No application behavior is claimed yet.

## 8. Phase 1 — Runtime contracts

### Goal

Define stable, versioned wire contracts before building services or harness prompts.

### Work package 1.1 — Contract conventions

In `/packages/runtime-contracts`, implement:

- schema versioning convention;
- opaque identifier types;
- actor and tenant identity;
- UTC time codec;
- money and unit types;
- resource selectors;
- artifact references;
- standard error envelope;
- pagination cursor;
- idempotency key;
- correlation and causation identifiers.

All exported schemas require:

- TypeScript type;
- runtime validator;
- JSON Schema output;
- valid fixture;
- invalid fixture matrix;
- round-trip serialization test.

### Work package 1.2 — Core contracts

Implement schemas for:

- `RuntimeCommand<TPayload>`
- `Workflow`
- `ExecutionPlan` and `PlanStep`
- `AgentInvocation<TInput>`
- `AgentReport`
- `Artifact<TContent>` and `ArtifactReference`
- `RuntimeEvent<TPayload>`
- `ApprovalRequest`
- `BudgetEnvelope`, reservations, and usage observations
- `AuthorityEnvelope`
- `ResourceEnvelope`
- `RetryPolicy`
- `FailureRecord`
- `AgentRegistration`
- `ToolGrant`
- `DecisionRecord`, `Escalation`, `StateAssertion`, `MetricObservation`, and `CostObservation`

### Work package 1.3 — State machines

Implement pure transition functions and tests for:

- workflow: `planning -> awaiting_approval | executing | blocked | completed | failed | cancelled`;
- invocation: `created -> preparing -> running -> awaiting_approval | validating_report -> succeeded | partially_succeeded | blocked | failed | cancelled`;
- artifact: `draft -> valid | blocked -> stale | superseded | archived` with valid domain-specific transitions;
- approval: `pending -> approved | rejected | expired | revoked`;
- deployment: `requested -> provisioning -> smoke_testing -> canary -> ramping -> active`, plus rollback and failure paths;
- budget reservation: `requested -> reserved -> partially_consumed -> reconciled | released | rejected`.

Transition functions return domain events; they do not write databases directly.

### Work package 1.4 — Error taxonomy

Define stable error codes grouped by:

- validation;
- concurrency;
- authority;
- policy;
- approval;
- budget;
- artifact;
- invocation hierarchy;
- harness output;
- external dependency;
- compute resource;
- secret handling;
- retry exhaustion.

Errors must specify whether they are retryable, the owning tier, safe user-facing text, internal diagnostics, and evidence references.

### Work package 1.5 — Contract compatibility tooling

Add tooling that:

- emits JSON Schemas into a committed generated directory;
- detects breaking schema changes;
- validates stored fixtures across all supported schema versions;
- verifies upcasters;
- produces human-readable contract documentation.

### Phase 1 tests

- Property tests for IDs, time, money, hashes, versions, and state transitions.
- Negative tests for missing tenant, invalid tier, invalid parent-child tier, negative budgets, unsupported currency, malformed resource scopes, and illegal transitions.
- Compatibility tests proving old fixtures decode after non-breaking changes.
- Snapshot tests for generated JSON Schema.

### Phase 1 exit criteria

- All core types exist as runtime-validated, versioned schemas.
- Illegal state transitions are mechanically rejected.
- The Tier hierarchy can be validated without model logic.
- Generated contract documentation is committed and drift-checked.
- No API or adapter duplicates the contract types.

## 9. Phase 2 — Authoritative state, events, and artifacts

### Goal

Implement durable authoritative state, optimistic concurrency, immutable artifacts, event publication, and rebuildable projections.

### Work package 2.1 — Database schema

Create migrations for at least:

```text
tenants
workspaces
commands
command_deduplication
workflows
workflow_plans
invocations
invocation_attempts
agent_reports
artifacts
artifact_versions
artifact_lineage_edges
approvals
budgets
budget_reservations
usage_records
agent_registrations
domain_events
transactional_outbox
projection_checkpoints
side_effect_receipts
audit_records
```

Database rules:

- Every tenant-owned table includes `tenant_id`.
- Uniqueness constraints include tenant boundary where appropriate.
- Aggregate writes include an expected version.
- Event sequence is monotonically increasing within an aggregate.
- Outbox insert occurs in the same transaction as the aggregate mutation.
- Artifact version rows are append-only after publication.
- Large artifact content lives in object storage; metadata and hashes live in the database.

### Work package 2.2 — Repository interfaces

Define ports before adapters:

- `WorkflowRepository`
- `InvocationRepository`
- `ArtifactRepository`
- `ApprovalRepository`
- `BudgetRepository`
- `AgentRegistryRepository`
- `EventStore`
- `OutboxRepository`
- `ProjectionCheckpointRepository`
- `SideEffectReceiptRepository`

Provide PostgreSQL and local implementations and run the same contract suite against each.

### Work package 2.3 — Command transaction boundary

Implement a command dispatcher with this sequence:

1. authenticate actor;
2. validate tenant/workspace membership;
3. validate command schema;
4. reserve the idempotency key;
5. load aggregate and compare expected version;
6. authorize the command;
7. execute pure domain decision logic;
8. persist aggregate changes and events;
9. append outbox records in the same transaction;
10. commit;
11. return the stored result for duplicate idempotency keys.

Duplicate commands with the same key and different request digests must fail.

### Work package 2.4 — Artifact registry

Implement:

- streaming hash computation;
- content-addressed object keys;
- staged upload followed by atomic publication;
- logical artifact identity and immutable versions;
- creator identity and invocation reference;
- `derivedFrom` lineage;
- ownership and human precedence;
- lifecycle status;
- schema association;
- content size and media type;
- integrity verification on read;
- retention and archival metadata.

Artifact publication must reject:

- mismatched hashes;
- missing staged content;
- invalid schema;
- an attempt to mutate a published version;
- unauthorized lineage references;
- cross-tenant references;
- a commit based on a stale parent version unless an explicit rebase policy permits it.

### Work package 2.5 — Projections

Implement projectors for:

- workflow summary;
- invocation/job status;
- artifact list and lineage summary;
- approval queue;
- budget/cost summary;
- audit timeline.

Each projector must:

- be idempotent;
- persist its cursor;
- detect gaps;
- rebuild from zero or a declared snapshot;
- expose staleness/lag metrics;
- never mutate authoritative aggregates.

### Work package 2.6 — Human edits and staleness propagation

Implement human edits as new artifact versions. On publication:

- compare expected version;
- validate schema and policy;
- mark the actor authority as human;
- preserve lineage to the edited version;
- determine affected descendants;
- mark invalid descendants stale through events;
- prevent agents from overwriting or silently superseding the human version;
- require rebase or approval for agent-proposed replacements.

### Phase 2 failure-injection tests

- Process crashes after aggregate write but before outbox publication attempt.
- Outbox message is delivered multiple times.
- Projector crashes between applying and checkpointing.
- Artifact upload succeeds but database commit fails.
- Database commit succeeds but staged-object cleanup fails.
- Two writers update the same artifact version concurrently.
- Tenant A attempts to reference Tenant B artifact.
- Human edit lands while an invocation is running.

### Phase 2 exit criteria

- State and outbox records commit atomically.
- Projection rebuild produces equivalent views.
- Artifact content and lineage integrity are verified.
- Optimistic concurrency and idempotency behavior are deterministic.
- Human-edit precedence and staleness propagation pass integration tests.

## 10. Phase 3 — Policy, authority, approvals, and budget

### Goal

Make authority, policy, approval, and cost boundaries enforceable independently of agents and prompts.

### Work package 3.1 — Authority envelopes

Define an envelope containing:

- tenant, workspace, workflow, invocation, and actor identity;
- tier and registered harness version;
- permitted actions;
- resource selectors;
- allowed artifact reads and writes;
- allowed child agent types;
- maximum child count;
- tool operations;
- issued-at, expires-at, and policy version;
- revocation/epoch reference;
- envelope integrity proof.

Every service method that can create a durable effect accepts an authorization context and verifies it server-side.

### Work package 3.2 — Tool grants

Implement short-lived, invocation-bound tool grants. A grant must specify tool name, exact operations, resource scope, expiration, invocation, and maximum usage where applicable.

Tool broker flow:

```text
validate request schema
  -> validate invocation is active
  -> validate authority envelope
  -> evaluate policy
  -> check approval if required
  -> check budget/resource limits
  -> issue ephemeral handle
  -> execute operation
  -> redact response
  -> meter usage
  -> emit audit event
```

### Work package 3.3 — Policy decision service

Define typed inputs and outputs for:

- data access;
- PII handling;
- compute allocation;
- secret capability issuance;
- connector scopes;
- model promotion;
- deployment target/traffic shift;
- artifact retention;
- external network access.

Every decision records policy version, input digest, result, obligations, reason codes, and decision ID.

### Work package 3.4 — Approval service

The action digest must include:

- action type;
- tenant/workspace;
- actor and requesting invocation;
- exact artifact IDs and versions;
- resource selectors;
- credential scopes;
- deployment target and traffic percentage;
- estimated cost and currency;
- policy version;
- relevant configuration digest.

Before executing an approved action, recompute the digest and verify approval state, expiration, approver policy, and revocation epoch.

### Work package 3.5 — FinOps ledger

Implement integer-minor-unit accounting for:

- workflow hard and soft limits;
- category limits for LLM, compute, storage, and external APIs;
- reservations;
- actual usage;
- partial consumption;
- release and reconciliation;
- retry budget consumption;
- alerts and anomalies.

The budget check must occur before each metered model call or external resource action. Actual usage must reconcile against its reservation.

### Phase 3 security tests

- Expired authority envelope.
- Valid envelope used by the wrong invocation.
- Resource selector escape through path traversal or prefix confusion.
- Approval replay against a modified artifact version.
- Cost increase after approval.
- Revoked approval at commit time.
- Concurrent reservations that would exceed the hard limit.
- Model attempts to request an undeclared tool operation.
- Tool response contains secret-shaped content and must be redacted.

### Phase 3 exit criteria

- Consequential service operations fail closed without valid authority.
- Approval digest invalidation is proven by tests.
- Budget cannot be oversubscribed under concurrent requests.
- Tool access is capability-scoped and audited.
- Policy decisions are versioned and reproducible from recorded inputs.

## 11. Phase 4 — Harness core and invocation enforcement

### Goal

Implement the shared harness abstraction, model/tool interception pipeline, normalized reporting, and mechanical tier enforcement.

### Work package 4.1 — Harness definition and factory

Implement:

```ts
interface HarnessDefinition<TInput, TOutput> {
  identity: HarnessIdentity;
  tier: 0 | 1 | 2;
  inputSchema: RuntimeSchema<TInput>;
  outputSchema: RuntimeSchema<TOutput>;
  promptPolicy: PromptPolicy;
  contextPolicy: ContextPolicy;
  toolPolicy: ToolPolicy;
  modelPolicy: ModelPolicy;
  authorityPolicy: AuthorityPolicy;
  budgetPolicy: BudgetPolicy;
  retryPolicy: RetryPolicy;
  approvalPolicy: ApprovalPolicy;
  plugins: PluginReference[];
  hooks: HarnessHooks;
  acceptancePolicy: AcceptancePolicy<TOutput>;
}
```

The factory must fail before runtime creation if the definition is internally inconsistent or requests capabilities unavailable to its tier.

### Work package 4.2 — Invocation service

Implement `mayInvoke` as a domain rule and enforce it in the persistence transaction:

```text
Tier 0 -> Tier 1: allow
Tier 0 -> Tier 2: deny
Tier 1 -> Tier 1: deny
Tier 1 -> Tier 2: allow
Tier 2 -> any: deny
```

Validate the child registration, input type, output expectations, authority delegation, budget delegation, maximum depth, maximum children, and parent lifecycle before creation.

### Work package 4.3 — Context assembler

Build context in trust-separated sections:

1. system policy;
2. trusted workspace policy;
3. invocation objective;
4. relevant artifact summaries or exact mounted files;
5. explicit constraints;
6. authority, budget, resource, retry, and tool envelopes;
7. prior child reports;
8. untrusted external content.

Tier-specific rules:

- Tier 0 receives organization/workflow summaries, not raw operational files.
- Tier 1 receives domain state and only necessary artifact content.
- Tier 2 receives exact task input and mounted working files, not organization history.

Context assembly must produce a manifest listing every included item, trust class, source, version, size, and reason for inclusion.

### Work package 4.4 — Model router and metered model client

Implement policy-based routing by tier and task shape. The wrapper must:

- reserve budget;
- enforce token limits;
- record provider/model and policy version;
- emit start/completion/failure telemetry;
- capture provider usage;
- reconcile budget;
- support cancellation and deadlines;
- apply bounded fallback rules;
- never log credentials or raw sensitive context.

### Work package 4.5 — Cline adapter

Implement internal interfaces for:

- runtime creation;
- structured agent execution;
- tool registration;
- streamed events;
- cancellation;
- usage observations;
- normalized error mapping;
- SDK lifecycle disposal.

Add a fake adapter for tests. Business packages must not import the Cline SDK.

### Work package 4.6 — Lifecycle hooks and interceptor order

Use an explicit order:

```text
beforeInvocation
  -> context assembly
  -> afterContextAssembly
  -> beforeModelCall
  -> model call
  -> afterModelCall
  -> beforeToolCall for each tool call
  -> policy/authority/budget enforcement
  -> tool execution
  -> afterToolCall
  -> onArtifactProduced / onEscalation / onFailure
  -> report validation
  -> afterInvocation
```

Hook failures require declared behavior: fail closed for authority, policy, approval, redaction, audit, or budget hooks; best-effort only for explicitly noncritical telemetry exporters.

### Work package 4.7 — Report validator

Validation pipeline:

1. parse structured output;
2. validate report schema;
3. match invocation, agent type, tier, and harness version;
4. verify status fields and required failure detail;
5. verify produced artifacts exist and were created by the invocation;
6. verify lineage and hashes;
7. reconcile metrics and cost with observed records;
8. validate child invocation references;
9. validate state assertions against authoritative reads;
10. run tier-specific acceptance policy;
11. accept, request bounded repair, or fail.

Agent prose is never directly committed as durable domain state.

### Phase 4 tests

- Definition requests a prohibited Tier capability.
- Tier 0 attempts Tier 2 invocation.
- Tier 1 tries to delegate more authority or budget than it owns.
- Tier 2 attempts child creation.
- Context contains untrusted prompt instructions.
- Model emits malformed JSON, nonexistent artifacts, false cost data, or mismatched invocation ID.
- Required audit hook fails.
- Adapter cancellation races with report completion.
- SDK upgrade compatibility fixture.

### Phase 4 exit criteria

- All tier rules are enforced without relying on prompts.
- A fake agent can complete an invocation through the full interceptor and validation pipeline.
- Invalid reports cannot commit decisions.
- Cline SDK usage is isolated and compatibility-tested.
- Usage, audit, and correlation data exists for every model/tool operation.

### Phase 4 completion record

The Phase 4 contracts are implemented in `packages/harness-core`, `packages/agent-registry`,
`packages/cline-adapter`, `packages/state`, and `packages/tool-broker`. The focused evidence covers
prohibited capabilities, tier/delegation enforcement, trust-separated context, model/tool
interception, disabled/compatible harness registration, Tier 2 shells, invalid-report rejection,
critical-hook failure, adapter cancellation, SDK compatibility, correlation propagation, and stale
parent lifecycle rejection. See
`docs/contracts/spyderbyte-p4-capability-matrix.md` for the file-to-requirement map.

The repository gate passes through contracts, formatting, lint, boundaries, typechecks, tests,
invariants, and all non-desktop builds. The local macOS desktop packaging substep remains
environment-dependent: the installed `pkg` runtime cannot produce the signed sidecar in this
workspace and must be rerun on a configured release runner.

## 12. Phase 5 — Local dataset vertical slice

### Goal

Deliver the first runnable end-to-end workflow using local resources and deterministic Tier 2 tasks wherever possible.

### Work package 5.1 — Tier 0 minimum orchestrator

Implement a constrained planner for `ValidateDataset`:

- load command and workspace summary;
- locate requested source artifact;
- verify Governance and Data Engineer registrations;
- create a plan with Governance then Data Engineer;
- validate dependencies, authority, budget, expected outputs, and completion criteria;
- commit `workflow.planned.v1`;
- schedule ready steps;
- aggregate reports;
- complete or block the workflow.

Use deterministic planning for this single command shape first. Introduce model-generated planning only after the plan validator and evaluation fixtures exist.

### Work package 5.2 — Governance specialist

Initial inputs:

- dataset reference;
- intended use;
- actor and workspace;
- requested access scopes;
- retention requirement.

Initial Tier 2 tasks:

- schema-based policy evaluation;
- local PII scanner fixture;
- retention-rule checker.

Output: immutable `GovernanceDecision` artifact with decision, constraints, reason codes, evidence, policy version, and expiration/review conditions.

### Work package 5.3 — Data Engineer specialist

Initial Tier 2 tasks:

- source profiler;
- schema validator;
- deterministic hash worker;
- duplicate detector;
- split generator;
- leakage detector.

Output: `ValidatedDataset` plus `DataQualityReport`, canonical schema, split references, lineage, counts, hashes, and limitations.

### Work package 5.4 — Local resource adapters

Implement:

- local filesystem artifact store;
- SQLite metadata repository if selected by ADR;
- in-process event publisher after outbox;
- local CPU/memory/GPU capacity inspection;
- invocation-specific sandbox directory;
- read-only artifact mounts where supported;
- subprocess execution with deadline and output limits.

### Work package 5.5 — API and CLI smoke path

Expose:

- `POST /v1/commands` with idempotency key;
- `GET /v1/workflows/:id`;
- `GET /v1/workflows/:id/events`;
- `GET /v1/artifacts/:id/versions/:version` metadata;
- local CLI command that submits a fixture dataset validation and waits for terminal status.

### Phase 5 end-to-end test

Fixture cases:

1. Valid dataset succeeds and publishes immutable artifacts.
2. Schema-invalid dataset fails mechanically at Tier 2 and is rejected by Data Engineer.
3. Governance denial prevents Data Engineer invocation.
4. Leakage above threshold produces a blocked or failed domain decision, not a false success.
5. Duplicate command returns the original workflow.
6. Human edits the schema while validation runs; publication detects the version conflict.
7. Cancellation stops pending tasks and records terminal state.

### Phase 5 exit criteria

- A clean local checkout can run the workflow with one documented command.
- The event and artifact history explain every state transition.
- No LLM is used for deterministic validation tasks.
- Restart is not yet required to recover execution, but state is durably stored for Phase 6.
- API, CLI, and tests read the same projections.

## 13. Phase 6 — Durable execution and real-time recovery

### Goal

Make workflows survive process failure, support retries/cancellation/approvals, and provide reconnectable live event delivery.

### Work package 6.1 — Workflow engine adapter

Implement `WorkflowEngine` with:

- start or signal workflow;
- schedule activity;
- wait for event or approval;
- cancel;
- query status;
- resume after worker restart;
- version workflow definitions safely;
- map engine identifiers to platform workflow/invocation IDs.

Implement the Temporal adapter after the proof-of-concept passes. Keep domain state in platform repositories; do not make Temporal history the only source of business truth.

### Work package 6.2 — Retry ownership

Implement policies by tier:

- Tier 2 retries only declared transient mechanical failures without changing task intent.
- Tier 1 may change tactics while preserving its domain objective and authority.
- Tier 0 replans when budget, deadline, prerequisite validity, cross-domain compatibility, or user objective changes.

Every retry records attempt number, failure code, cost, context freshness, chosen policy, and result.

### Work package 6.3 — Cancellation and deadlines

Support:

- workflow cancellation;
- invocation cancellation;
- activity heartbeat and cancellation propagation;
- graceful sandbox termination followed by forced termination after a bounded interval;
- deadline expiration;
- cleanup tasks;
- terminal audit and cost reconciliation.

### Work package 6.4 — Approval waits

Workflow execution must durably wait for approvals without holding a process or consuming model tokens. Approval, rejection, expiration, and revocation resume the workflow through typed signals/events.

### Work package 6.5 — Subscription gateway

Implement:

- REST/RPC for commands and point reads;
- WebSocket for chat/session control if needed;
- SSE for projection/event subscriptions;
- monotonic per-subscription cursor;
- replay from `afterCursor`;
- gap detection and projection refresh instruction;
- bounded per-client buffers and slow-consumer behavior;
- tenant/topic authorization.

### Phase 6 chaos tests

- Kill workflow worker during planning, Tier 1 execution, and report validation.
- Kill API after command commit but before response.
- Deliver an event repeatedly and out of order where transport permits.
- Expire approval while workflow is offline.
- Cancel during a long-running sandbox task.
- Deploy a compatible workflow-code update with in-flight workflows.
- Disconnect and reconnect a client from an old cursor.

### Phase 6 exit criteria

- In-flight workflows resume after worker restart without duplicate durable effects.
- Retries respect owner tier and cumulative cost limits.
- Cancellation and deadlines reach all descendants.
- Approval waits survive restarts.
- Live clients replay missed events and converge on authoritative projections.

## 14. Phase 7 — Training and compute vertical slice

### Goal

Extend the platform from validated data to a local training smoke run with compute offers, budget reservation, checkpoint publication, and normalized reporting.

### Work package 7.1 — ML Engineer specialist

Owned decisions:

- base model choice among approved candidates;
- fine-tuning method;
- hyperparameters;
- training objective;
- checkpoint and early-stop strategy;
- technical viability for independent evaluation.

Tier 2 tasks:

- EDA summary;
- training configuration generator;
- training code task;
- config/unit tests;
- local smoke-run launcher;
- metric observer;
- checkpoint inspector.

The ML Engineer must not approve evaluation, allocate compute outside a Cluster offer, promote a model, or modify the evaluation set.

### Work package 7.2 — Cluster specialist and compute contract

Implement `ComputeBackend` contract methods:

- `inspectCapacity`;
- `estimate`;
- `allocate`;
- `submitJob`;
- `observeJob`;
- `terminate`.

The Cluster specialist is the only Tier 1 allowed to issue a `ComputeAllocation`. Allocation requires a valid offer, authority, policy, budget reservation, and approval when thresholds require it.

### Work package 7.3 — Local compute backend

Implement:

- CPU/RAM/GPU inventory;
- capability and free-capacity snapshot;
- workload-fit calculation;
- deterministic cost policy for local resources;
- subprocess or container job submission;
- stdout/stderr capture to artifact storage;
- heartbeats and resource observations;
- termination;
- failure classification.

Classify at least: `USER_CODE`, `OUT_OF_MEMORY`, `CAPACITY_UNAVAILABLE`, `PREEMPTION`, `NODE_FAILURE`, `NETWORK`, `NCCL`, `SCHEDULER_REJECTION`, `BUDGET_REJECTION`, `POLICY_REJECTION`, and `UNKNOWN_INFRASTRUCTURE`.

### Work package 7.4 — Tier 2 coding harness

Provide:

- isolated repository worktree or container;
- exact allowed paths;
- read-only reference artifacts;
- restricted terminal;
- network policy;
- required tests;
- diff capture;
- dependency and secret scan;
- patch or commit artifact publication.

Success requires files, scope, tests, diff, provenance, and security checks. Prose alone is never a successful coding-task result.

### Work package 7.5 — Metering

Capture:

- model input/output tokens;
- tool calls;
- wall-clock task time;
- CPU/GPU seconds;
- peak memory;
- storage bytes;
- external API quantities;
- estimated and actual cost.

### Phase 7 end-to-end test

Run:

```text
validated dataset
  -> training strategy
  -> two candidate training configurations
  -> local compute offer
  -> reservation/approval if required
  -> smoke training run
  -> checkpoint artifact
  -> training summary
```

Include OOM handling: Tier 2 detects it, ML Engineer may adjust micro-batch strategy, Cluster alone may offer larger resources, and Tier 0 resolves material cost/deadline changes.

### Phase 7 exit criteria

- Compute cannot be allocated outside Cluster authority.
- Training tasks cannot exceed approved offer or budget.
- Coding changes are mechanically verified and published as artifacts.
- Metrics, logs, checkpoint, config, source revision, and dataset form a traceable lineage chain.
- Failure ownership and retry behavior pass scenario tests.

## Spyderbyte v1 release track — Phase 8A

### Goal

Turn the existing local runtime foundation into a downloadable, signed macOS product. Spyderbyte v1 must be useful without a vendor control plane while preserving the same runtime contracts and projection model used by the future hosted plane.

The recommended desktop default is Tauri 2 with the React/Vite frontend and the local daemon packaged as a managed sidecar or child process. Record the final choice in an ADR before implementation; the choice must cover IPC, daemon lifecycle, deep links, Keychain access, filesystem permissions, crash recovery, updates, and packaging.

### Work package 8A.0 — Product and release ADRs

Record decisions for:

- Spyderbyte v1 scope and hosted/deferred boundary.
- Tauri 2 versus Electron, with the recommendation and rejected alternatives.
- Supported macOS versions and whether the first release is arm64-only or universal arm64/x86_64.
- Workspace, artifact, cache, log, temporary, and backup paths.
- Daemon supervision, loopback binding, session authentication, single-instance behavior, and shutdown semantics.
- macOS Keychain service names, access groups, OAuth callback/deep-link behavior, and secret rotation.
- Signed license payload, activation/refresh policy, offline validity, grace behavior, and feature entitlements.
- Developer ID signing, Hardened Runtime entitlements, notarization, update channel, rollback, and release ownership.

### Work package 8A.1 — Desktop host and daemon lifecycle

Create `/apps/desktop` and implement:

- Tauri shell that starts the local daemon and waits for a health check before rendering the authenticated app.
- Managed daemon process or signed sidecar with randomized loopback port and per-session bearer token.
- Single-instance lock and window-focus behavior.
- Clean shutdown, daemon restart, crash detection, bounded restart backoff, and recovery messaging.
- Native file/folder dialogs for workspace open/import/export and artifact save operations.
- Deep-link or loopback callback handling for OAuth without exposing credentials to the webview.
- App, daemon, workspace, and log version reporting for diagnostics.
- macOS application support paths that do not place mutable user workspaces inside the app bundle.

### Work package 8A.2 — Workspace lifecycle and OS secrets

Implement the local workspace contract:

- Create/open/rename/close workspace.
- Versioned workspace manifest with schema version, product version, workspace ID, tenant boundary, and migration history.
- Default workspace layout for SQLite metadata, CAS artifacts, event/outbox data, connectors, notebooks, exports, logs, and temporary execution state.
- Import/export as a versioned archive with checksums, manifest validation, path traversal protection, and optional exclusion of caches.
- Backup snapshot and restore preview before replacing or merging an existing workspace.
- macOS Keychain adapter for provider keys, OAuth refresh tokens, license receipts, and device/session secrets.
- Secret handles only in runtime context; raw secret values must not enter model context, logs, artifacts, or exported workspace metadata.

### Work package 8A.3 — Basic signed license check

Add `/packages/license` and a license contract with:

```text
SignedEntitlementV1
  payload: schemaVersion, licenseId, product, edition,
           issuedAt, notBefore, expiresAt, features
  signature: Ed25519 signature over canonical payload
```

Requirements:

- The application contains the verification public key only; the signing private key stays outside the repository and release artifact.
- Validate signature, schema, product, edition, not-before, expiration, feature scope, and key ID.
- Store the signed license file or activation receipt in macOS Keychain, with a recoverable imported copy only when the user explicitly exports it.
- Validate at desktop startup, workspace open/import, and the daemon’s effectful command boundary.
- Expose `GET /v1/license/status` with status, edition, feature flags, expiration, validation reason, and last checked time; never return the private or raw credential material.
- Allow initial offline license-file import. Add online activation/refresh only as an optional follow-on.
- Missing, invalid, or expired licenses may allow license import, diagnostics, read-only artifact access, and workspace export, but must block new compute, external effects, and other licensed operations. Never delete or permanently lock user data.
- Make clock behavior explicit. Offline licenses cannot support immediate revocation; revocation requires expiration, refresh, or an explicitly approved online check.

License tests:

- Valid entitlement.
- Tampered payload or signature.
- Wrong product or edition.
- Future `notBefore`.
- Expired entitlement.
- Malformed payload and unsupported schema.
- Unknown key ID and key rotation.
- Offline startup and offline expiry behavior.
- Clock rollback/clock jump handling.
- Daemon command bypass attempt.

### Work package 8A.4 — Supplied Vibe prototype to production frontend

Merge the supplied frontend direction into `/apps/web`; do not maintain a second production UI
outside the monorepo. The reference repository is
`/Users/josiah/Documents/frontend design/platform-focus-wireframe`, and the visual source is the
monday.com Vibe UI Kit and its added workspace wireframe:

- [Vibe UI Kit by monday.com](https://www.figma.com/design/ecqBuAHeBjTp9M8X5t0jIC/Vibe-UI-Kit-by-monday.com--Community-?m=auto&is-community-duplicate=1&fuid=1249231832359008557)
- Vibe foundations: Poppins for headings, Figtree for UI text, semantic primary/positive/warning/negative colors, 2–80px spacing scale, and 4/8/16px corner radii.
- Vibe components to map first: Button, Icon Button, Tabs, Search, Text Field, Badge, Toast,
  Modal, Table, Linear Progress, and Toggle.

The supplied implementation’s acceptance state is: desktop light theme, expanded workspace tree,
Customer Churn → Analyze → Churn investigation, Results selected, and the run-details drawer
expanded. Its component anatomy is compact navigation, analysis/editor canvas, results surface,
contextual run drawer, and grouped settings modal. `apps/web/src/workspace-prototype.css` and the
prototype renderer in `apps/web/src/index.ts` now carry that anatomy into the desktop frontend;
the existing projection model, HTTP client, typed commands, license import, workspace archive
actions, and approval callbacks remain in place.

Build the screens in this order:

1. License/first-run gate and workspace create/open/import.
2. Provider and Keychain setup.
3. Connector gallery, OAuth, account binding, and stream selection.
4. Objective/chat entry and template selection.
5. Typed plan review with budget, authority, policy findings, and approval actions.
6. Live run view with SSE projections, run drawer, logs, cost, and reconnect state.
7. Artifact preview/editing, lineage, version conflicts, export, and backup.
8. Model/evaluation/deployment views and local diagnostics.
9. Settings with License & edition, Connections, Storage, Export/backup, Updates, and Diagnostics.

Current implementation boundary:

- The faithful supplied analysis workspace, Results/Chart tabs, filtering, run drawer, settings
  modal, sidebar/drawer collapse, flow map, license gate, and derived Provider/Objectives screens
  are implemented.
- The canonical routed React SQL Workbench now executes and persists the local data-query slice and
  restores an authoritative result/artifact record from `/sql?queryId=...`; its handoff behavior is
  covered in `apps/web/tests/app.test.tsx`. The legacy compatibility renderer's supplied Results/SQL
  preview remains non-authoritative and must not be used as frontend completion evidence.
  Provider/model-backed project execution, authoritative live-run projections, and the complete
  first-run journey are still required before the frontend gate can be marked complete.
- The remaining frontend work is the real first-run journey, provider/Keychain setup, objective to
  plan to approval to live-run transitions, artifact lineage/editing, storage settings, and full
  browser accessibility/E2E coverage.

The frontend must use the existing projection/API clients and typed commands. Remove simulated
timers and toast-only navigation from the production path. Add a true SQL/editor surface only when
its persistence, validation, and artifact-version behavior are defined.

### Work package 8A.5 — DMG packaging and release engineering

Implement a macOS release pipeline that:

- Builds the React frontend and local daemon for the supported architectures.
- Packages the Tauri app bundle and DMG with a stable bundle identifier and version source.
- Uses a repository-owned headless `hdiutil` packager rather than Finder automation, and verifies
  the mounted app, Applications drop link, and requested architecture slices.
- Signs the app, nested executables, sidecars, and update artifacts with Developer ID.
- Enables Hardened Runtime with the minimum entitlements required by the daemon, Keychain, OAuth, and local execution model.
- Submits the app/DMG to Apple notarization, staples the returned ticket, and verifies with Gatekeeper tooling on a clean Mac.
- Publishes checksums, SBOM, release notes, supported macOS versions, and a reproducible build manifest.
- Implemented release evidence (2026-08-04): the repo-owned packager now emits a SHA-256 sidecar and machine-readable `.manifest.json` containing the artifact digest, bundle metadata, architecture inspection, supported macOS baseline, lockfile/config digests, and toolchain versions. The current developer x86_64 DMG digest is `1383e3a4be1e28cb1a416a95adca5822e7449c45fc51f6452722f6ac16184437`. The packaged sidecar smoke covers license status, typed plan approval, workflow and artifact projections, three-entry artifact lineage, workspace export, the explicit `/v1/workspace/backup` snapshot route, restore preview, and workspace-identity-preserving restore. Universal output still requires an Apple Silicon runner; signing, notarization, Gatekeeper, SBOM, update/rollback, and clean-machine evidence remain open.
- Defines stable, beta, and developer channels with signed update metadata and rollback to the previous known-good release.
- Tests app upgrade without losing workspaces, app removal without silently deleting workspaces, and recovery after an interrupted update.

### Work package 8A.6 — Spyderbyte end-to-end release gate

Automate the scenario:

```text
download DMG
  -> install and launch
  -> license import/status
  -> create workspace
  -> store provider credential in Keychain
  -> connect reference data source
  -> submit objective
  -> review plan and approve
  -> run local workflow
  -> inspect live projections and artifact lineage
  -> export workspace/artifact
  -> quit, relaunch, and recover state
```

The gate must pass on a clean supported Mac in online and offline modes. It must also cover invalid/expired license behavior, duplicate commands, daemon restart, interrupted execution, reconnectable SSE, backup/restore, and safe workspace export.

### Phase 8A tests

- Tauri/WebView smoke tests for first launch, deep link, Keychain, filesystem dialog, single instance, and daemon crash recovery.
- License contract and property tests for canonicalization, signatures, expiry, product/edition, key rotation, and command-boundary enforcement.
- Workspace migration, import/export, checksum, backup/restore, and path-hardening tests.
- Frontend contract tests against generated API schemas and projection fixtures.
- Browser end-to-end tests for license, objective-to-plan, approval, run, artifact, export, settings, and reconnect flows.
- Accessibility tests for keyboard navigation, modal focus management, live regions, contrast, text zoom, and reduced-motion behavior.
- Clean-machine DMG install, Gatekeeper, update, rollback, and uninstall-preservation tests.

### Phase 8A exit criteria

- A signed/notarized DMG installs and launches on every supported architecture.
- The desktop host supervises the local daemon and preserves workspaces across restart and upgrade.
- License checks are cryptographically verifiable, offline-capable within the documented validity window, and enforced at effectful command boundaries.
- Provider secrets are stored through the OS Keychain and are absent from context, traces, logs, artifacts, and exports.
- The core frontend journey uses authoritative local projections and typed commands with no simulated execution path.
- Workspace import/export, artifact portability, backup/restore, and crash recovery are demonstrated.
- Release evidence is attached to the versioned plan before the Spyderbyte status changes to Complete.

## 15. Phase 8 — Hosted resource plane

### Goal

Run the same contracts with hosted storage, database, workers, secrets, and one cloud scheduler after Spyderbyte v1. This phase is not a Spyderbyte release blocker.

### Work package 8.1 — Hosted database and object storage

- Production PostgreSQL configuration, migrations, connection pooling, TLS, backup, and restore.
- S3-compatible artifact store with encryption, staged uploads, retention, integrity verification, and tenant isolation.
- Migration parity tests with local repositories.

### Work package 8.2 — Event transport

- Outbox publisher to NATS JetStream.
- Durable consumers with explicit acknowledgment.
- Deduplication/idempotency on publish and consume.
- Dead-letter or parking stream with operator tooling.
- Replay procedure and retention policy.
- Lag, redelivery, and poison-message alerts.

### Work package 8.3 — Cloud compute adapter

Choose Kubernetes or SLURM via ADR. Implement the full `ComputeBackend` contract, including capacity, offers, allocations, submission, observation, termination, and backend-specific failure mapping.

### Work package 8.4 — Secret broker

Integrate a production secret manager so agents receive only short-lived capability handles. Requirements:

- no plaintext secret returned to model or control plane caller;
- scope and operation binding;
- expiration and revocation;
- audit record without secret value;
- response redaction;
- rotation support;
- sandbox injection only at tool execution boundary.

### Work package 8.5 — Worker pools and sandboxing

Separate queues/pools by risk and workload:

- Tier 0 control workers;
- Tier 1 domain workers;
- Tier 2 deterministic workers;
- Tier 2 coding sandboxes;
- compute observation workers;
- projection workers.

Apply quotas, pod/container security, network policies, resource limits, ephemeral filesystems, read-only mounts, and output limits.

### Phase 8 exit criteria

- Local and hosted contract suites pass unchanged.
- Hosted workflow survives node/worker replacement.
- Secret values do not appear in context, logs, traces, reports, or artifacts.
- Cloud compute operations are authority, approval, and budget gated.
- Backup/restore and event replay are tested.

## 16. Phase 9 — Model lifecycle, evaluation, and deployment

### Goal

Complete the model path from checkpoint registration through independent evaluation to approval-gated canary and rollback.

### Work package 9.1 — MLOps specialist

Implement lineage and reproducibility decisions. Required chain:

```text
registered model version
  <- checkpoint
  <- training run
  <- training configuration
  <- source revision
  <- container/environment snapshot
  <- validated dataset version
  <- original data lineage
```

No model may be registered for promotion with an incomplete lineage graph.

### Work package 9.2 — Experiment backend

Implement one adapter for:

- run creation;
- metrics;
- artifact logging;
- checkpoint registration;
- environment metadata;
- external run identifier mapping.

External tracker state is not authoritative; store references and reconciliation status in the control plane.

### Work package 9.3 — Eval specialist

Implement immutable evaluation inputs and:

- benchmark selection;
- sample-size checks;
- metric calculation;
- statistical comparison;
- regression classification;
- qualitative sample selection;
- limitations;
- recommendation: `promote`, `reject`, or `investigate`.

The Eval harness cannot modify weights, training configuration, evaluation artifacts, benchmark definitions, or thresholds after seeing results.

### Work package 9.4 — Model registry publication

Model publication is a deterministic service operation after required decisions and approvals. It must verify lineage, evaluation, policy, approval digest, artifact hashes, and target registry state.

### Work package 9.5 — Deployment specialist

Implement the deployment state machine and Tier 2 tasks for:

- endpoint provision;
- manifest generation;
- smoke tests;
- canary shift;
- health observation;
- ramping;
- automatic rollback;
- rollback verification.

Traffic changes require fresh authorization and approval at commit time.

### Phase 9 end-to-end scenario

Fine-tune from an approved dataset under a hard budget, register the candidate, compare against an immutable baseline, and deploy 10% internal traffic only if target metrics pass without unacceptable safety regression. Inject a canary health failure and verify automatic rollback.

### Phase 9 exit criteria

- Evaluation independence is mechanically protected.
- Promotion cannot occur without complete lineage, passing policy, and bound approval.
- Serving traffic changes only through Deployment.
- Canary rollback completes and is audited under failure injection.
- The final workflow report reconciles artifacts, metrics, cost, and rollout state.

## 17. Phase 10 — Governance and connector publication

### Goal

Implement cross-cutting governance consultations and a secure connector development/publication path.

### Work package 10.1 — Governance consultations

Other specialists submit typed consultation requests to the control plane. They do not spawn Governance directly. Record the requester, action, resources, scopes, justification, policy version, response, obligations, and evidence.

### Work package 10.2 — Connector specialist

Implement Tier 2 tasks for:

- specification resolution;
- tool schema generation;
- connector code generation;
- test generation;
- sandbox contract tests;
- package build;
- dependency and static scans.

Connector development may use public documentation, mocks, approved test accounts, and sandbox credentials. It must never receive raw production credentials.

### Work package 10.3 — Publication workflow

Required sequence:

```text
source artifact
  -> static/dependency/security scans
  -> sandbox contract tests
  -> Governance scope decision
  -> mandatory human approval
  -> deterministic registry publication
```

Any source, dependency, requested scope, target, or test-result change invalidates the publication approval.

### Work package 10.4 — Reference connector

Build one low-risk reference connector with read-only sandbox scope. Use it to test schema compatibility, pagination, rate limits, retries, redaction, audit, credential handles, and registry rollback.

### Phase 10 exit criteria

- Cross-specialist policy checks preserve the Tier hierarchy.
- Connector publication cannot be performed by the agent that authored it.
- Approval is invalidated by any material package or scope change.
- Sandbox tests and security scans are required and reproducible.
- Connector revocation and registry rollback are tested.

## 18. Phase 11 — Interaction plane

### Goal

Build the Spyderbyte desktop interaction plane as projections over the proven local control plane, using the monday.com Vibe UI Kit visual language and keeping hosted-compatible contracts.

### Work package 11.1 — Application shell and supplied prototype anatomy

Implement license/edition gate, first-run workspace selection, navigation, global workflow status,
reconnect behavior, errors, Keychain/provider status, native file dialogs, and accessibility
baseline. Use the supplied three-pane analysis workspace as the shell acceptance target; a generic
Vibe-inspired card shell is insufficient.

### Work package 11.2 — Views

Build in this order:

1. license/first-run and workspace create/open/import;
2. provider connections, connector gallery, and data/catalog;
3. chat/objective and plan collaboration;
4. approvals queue and approval detail;
5. workflow/run detail, live projections, and audit timeline;
6. artifacts, lineage, human editing, and export;
7. jobs, compute allocations, cost, and budget;
8. models/evaluations/deployments;
9. local diagnostics, backup/restore, updates, and license settings;

Every panel reads a projection API and sends typed commands. It must not mutate shared state locally beyond optimistic UI that reconciles with the authoritative response.

### Work package 11.3 — Human artifact editing

The editor must:

- display exact artifact version and ownership;
- send expected version;
- validate client-side for usability and server-side for authority;
- create a new human-authored version;
- show downstream stale effects;
- resolve optimistic concurrency conflicts explicitly;
- never silently overwrite agent or human versions.

### Work package 11.4 — Approvals UX

Show exact action digest inputs in human-readable form: artifacts and versions, cost, scopes, target, traffic, policy findings, expiration, and consequences. Rejection and revocation require recorded reasons.

### Work package 11.5 — Live synchronization

- Subscribe using a stored cursor.
- Replay missed events after reconnect.
- Detect invalid/gapped projection and refetch.
- Show stale/disconnected state.
- Bound log streaming and virtualize large output.
- Confirm terminal state with a point read.

### Phase 11 tests

- Component and accessibility tests.
- Contract tests against generated API schemas.
- End-to-end reconnect and replay tests.
- Optimistic concurrency conflict UX.
- Approval invalidation while screen is open.
- Multi-tab and two-user artifact edit races.
- Tenant isolation in routes and subscriptions.

### Phase 11 exit criteria

- All panels converge on control-plane projections.
- No frontend policy duplicates server rules.
- Approval and human-edit flows expose exact versions and conflicts.
- Core paths meet accessibility standards and keyboard navigation requirements.
- Reconnect behavior is reliable and observable.

## 19. Phase 12 — Security, scale, operations, and release

### Goal

Prove the system is secure, observable, recoverable, scalable within declared limits, and releasable as a signed Spyderbyte DMG before hosted release work is considered complete.

### Work package 12.1 — Threat modeling

Create threat models for:

- tenant isolation;
- prompt injection and untrusted content;
- tool grant escalation;
- secret exfiltration;
- malicious artifacts and archives;
- supply chain and generated code;
- approval replay and time-of-check/time-of-use;
- event forgery or replay;
- sandbox escape;
- model output spoofing;
- connector scope escalation;
- deployment traffic manipulation.

Track mitigations, verification methods, residual risk, owner, and review date.

### Work package 12.2 — Security testing

- Static analysis and dependency scanning.
- Secret scanning.
- Container/image scanning.
- Artifact malware/archive-bomb checks.
- Tenant-isolation integration tests.
- Authorization fuzzing.
- Prompt-injection red-team evaluation.
- Sandbox escape tests.
- Approval/digest/revocation race tests.
- Audit immutability and completeness checks.

### Work package 12.3 — Observability

Every command, workflow, invocation, model call, tool call, artifact publication, policy decision, approval, budget operation, and backend action must carry tenant-safe correlation identifiers.

Dashboards:

- command success/latency/idempotency conflicts;
- workflow state, duration, blockage, recovery, and cancellation;
- invocation success by tier/agent/version;
- report validation/repair/failure;
- event outbox lag and projection lag;
- model usage and cost;
- compute offers, allocations, utilization, failures, and cost;
- approval wait time and invalidation;
- artifact publication/integrity/staleness;
- deployment health and rollback;
- security denials and suspicious tool requests.

### Work package 12.4 — Service objectives

Define and validate SLOs for:

- command acceptance;
- projection freshness;
- event subscription reconnect;
- workflow recovery;
- approval propagation;
- audit completeness;
- artifact durability;
- deployment rollback time;
- budget enforcement accuracy.

Do not invent target values without product and operations agreement. Record chosen targets in an ADR or service-level document.

### Work package 12.5 — Capacity and scale tests

Test:

- concurrent workflows per tenant and globally;
- fan-out of Tier 1 and Tier 2 tasks;
- high-frequency metrics and log events;
- large artifacts and multipart uploads;
- slow consumers;
- projection rebuild duration;
- database connection exhaustion;
- scheduler capacity shortage;
- backpressure at every queue boundary;
- budget/policy service latency or outage.

### Work package 12.6 — Operations and recovery

Create runbooks for:

- stuck workflow;
- poison event;
- projection rebuild;
- outbox backlog;
- artifact integrity failure;
- budget reconciliation discrepancy;
- approval service outage;
- secret-broker outage;
- scheduler outage;
- model provider outage;
- rollback failed;
- tenant data export/deletion;
- database restore and event replay.

Perform documented recovery exercises and attach evidence.

### Work package 12.7 — Harness evaluation and rollout

Tier 0 evaluation:

- plan completeness;
- correct specialist routing;
- dependency correctness;
- budget compliance;
- escalation quality;
- unnecessary invocation rate.

Tier 1 evaluation:

- domain decision quality;
- policy compliance;
- child-task decomposition;
- rejection of invalid Tier 2 output;
- cost/performance tradeoff quality.

Tier 2 evaluation:

- task success;
- schema/test validity;
- deterministic repeatability;
- unauthorized-operation rate;
- token/tool-call efficiency.

System evaluation:

- end-to-end objective success;
- total cost and duration;
- human intervention rate;
- rollback rate;
- audit completeness;
- stale-artifact propagation;
- recovery after injected failure.

Roll out harness versions through shadow, canary, limited availability, and general availability stages. Record exact harness version on every invocation and maintain a rollback path.

### Work package 12.8 — Local macOS release evidence

For every Spyderbyte release candidate, retain:

- build provenance, dependency lock, SBOM, checksums, and release manifest;
- Developer ID signing verification for the app, nested binaries, sidecars, and update metadata;
- notarization result and stapled-ticket verification;
- clean-machine install and Gatekeeper launch evidence;
- first-run license/workspace/provider/workflow/artifact scenario evidence;
- offline license, invalid-license, Keychain, daemon restart, workspace migration, export/import, and backup/restore evidence;
- upgrade, rollback, uninstall-preservation, and interrupted-update evidence;
- supported-architecture and supported-macOS matrix;
- release owner, known limitations, rollback version, and customer recovery instructions.

### Phase 12 exit criteria

- Critical threat mitigations are implemented and verified.
- SLOs, alerts, dashboards, and on-call runbooks exist.
- Backup/restore and disaster-recovery exercises pass.
- Load tests demonstrate declared capacity and backpressure.
- Harness evaluations meet approved release thresholds.
- Release, migration, rollback, and incident procedures are documented and exercised.
- A signed/notarized Spyderbyte DMG passes the clean-machine release gate and the complete first-run-to-artifact scenario.

## 20. Required service interfaces

These interfaces are ports. Adapters may vary, but business logic must not bypass them.

### 20.1 Workflow engine

```ts
interface WorkflowEngine {
  start(request: StartWorkflowRequest): Promise<WorkflowHandle>;
  signal(handle: WorkflowHandle, signal: WorkflowSignal): Promise<void>;
  query(handle: WorkflowHandle): Promise<WorkflowEngineState>;
  cancel(handle: WorkflowHandle, reason: CancellationReason): Promise<void>;
}
```

### 20.2 Compute backend

```ts
interface ComputeBackend {
  inspectCapacity(request: CapacityRequest): Promise<CapacitySnapshot>;
  estimate(workload: WorkloadRequirements): Promise<ComputeOffer[]>;
  allocate(
    offer: ComputeOffer,
    grant: ApprovedAllocationGrant,
  ): Promise<ComputeAllocation>;
  submitJob(
    allocation: ComputeAllocation,
    spec: JobSpecification,
  ): Promise<JobHandle>;
  observeJob(job: JobHandle): AsyncIterable<JobObservation>;
  terminate(job: JobHandle): Promise<void>;
}
```

### 20.3 Experiment backend

```ts
interface ExperimentBackend {
  createRun(metadata: RunMetadata): Promise<RunHandle>;
  logMetric(run: RunHandle, metric: MetricObservation): Promise<void>;
  logArtifact(run: RunHandle, artifact: ArtifactReference): Promise<void>;
  registerCheckpoint(
    run: RunHandle,
    checkpoint: ArtifactReference,
  ): Promise<RegisteredCheckpoint>;
}
```

### 20.4 Catalog backend

```ts
interface CatalogBackend {
  resolveDataset(reference: string): Promise<DatasetDescriptor>;
  readSchema(reference: string): Promise<SchemaDescriptor>;
  publishDatasetVersion(
    artifact: ArtifactReference,
  ): Promise<CatalogReference>;
}
```

### 20.5 Agent runtime adapter

```ts
interface AgentRuntimeAdapter {
  run<TInput, TOutput>(
    definition: MaterializedHarnessDefinition<TInput, TOutput>,
    context: AgentContext,
    tools: BrokeredToolSet,
    signal: AbortSignal,
  ): AsyncIterable<AgentRuntimeEvent<TOutput>>;
}
```

### 20.6 Tool broker

```ts
interface ToolBroker {
  describeTools(request: ToolDescriptionRequest): Promise<ToolDescriptor[]>;
  execute<TInput, TOutput>(
    grant: ToolGrant,
    operation: ToolOperation<TInput>,
  ): Promise<ToolExecutionResult<TOutput>>;
}
```

### 20.7 Policy service

```ts
interface PolicyDecisionService {
  evaluate<TInput extends PolicyInput>(
    request: PolicyEvaluationRequest<TInput>,
  ): Promise<PolicyDecision>;
}
```

## 21. Minimum API surface

Commands:

- `POST /v1/commands`
- `POST /v1/workflows/{workflowId}/cancel`
- `POST /v1/approvals/{approvalId}/approve`
- `POST /v1/approvals/{approvalId}/reject`
- `POST /v1/approvals/{approvalId}/revoke`
- `POST /v1/artifacts/{artifactId}/versions`

Queries:

- `GET /v1/session`
- `GET /v1/workflows/{workflowId}`
- `GET /v1/workflows/{workflowId}/plan`
- `GET /v1/workflows/{workflowId}/invocations`
- `GET /v1/invocations/{invocationId}`
- `GET /v1/artifacts/{artifactId}`
- `GET /v1/artifacts/{artifactId}/versions/{version}`
- `GET /v1/artifacts/{artifactId}/lineage`
- `GET /v1/approvals`
- `GET /v1/budgets/{budgetId}`
- `GET /v1/audit`
- `GET /v1/agents`

Subscriptions:

- `GET /v1/subscriptions/events?workspaceId=...&topics=...&afterCursor=...`
- Optional WebSocket session endpoint for chat and bidirectional control.

API requirements:

- tenant authorization;
- authenticated session and assigned-workspace selection when identity is configured;
- request/response schema validation;
- idempotency for commands;
- optimistic version field for edits;
- correlation ID;
- stable error envelope;
- pagination and rate limits;
- generated OpenAPI document checked for drift;
- no internal stack traces or secrets in responses.

## 22. Testing strategy

### 22.1 Test layers

1. **Unit tests:** pure state transitions, validators, hashes, action digests, budget math, policy inputs, and plan checks.
2. **Property tests:** versioning, idempotency, money, selectors, lineage DAGs, transition sequences, and retry limits.
3. **Repository contract tests:** identical suites for PostgreSQL/local implementations and object-store adapters.
4. **Adapter contract tests:** compute, experiment, catalog, model runtime, policy, secrets, and event transport.
5. **Integration tests:** real database, object store emulator, event transport, workflow engine, and fake model runtime.
6. **Invariant tests:** all rules in Section 4, executed in every CI run.
7. **End-to-end tests:** local and hosted vertical slices.
8. **Evaluation suites:** quality and behavior of Tier 0/1/2 harnesses.
9. **Security tests:** tenant isolation, capability escalation, injection, redaction, approval replay, and sandboxing.
10. **Chaos/recovery tests:** worker death, duplicate events, network partitions, backend outage, and restore/replay.

### 22.2 Required fixture categories

- valid happy paths;
- malformed inputs;
- stale versions;
- duplicate commands and events;
- cross-tenant references;
- expired/revoked grants and approvals;
- budget exhaustion;
- transient versus permanent failures;
- malicious/untrusted content;
- missing or corrupt artifacts;
- incomplete lineage;
- conflicting specialist reports;
- human edits during execution;
- cancellation races;
- SDK and schema version upgrades.

### 22.3 Test determinism

- Inject clocks, IDs, random sources, model clients, and external adapters.
- Do not call real paid model or cloud services in standard CI.
- Store golden model outputs only as versioned fixtures with explicit purpose.
- Ensure replay tests do not depend on wall-clock timing.
- Use bounded timeouts and surface leaked workers/handles.

## 23. Observability and audit contract

Every record or signal should carry when applicable:

- tenant ID;
- workspace ID;
- workflow ID;
- invocation ID;
- parent invocation ID;
- command ID;
- correlation ID;
- causation ID;
- actor ID/type;
- agent type/version/tier;
- artifact ID/version;
- approval ID;
- budget/reservation ID;
- backend and external request ID;
- event schema version.

Audit records must capture who/what/when/where, action, target, decision, policy/authority/approval references, before/after versions where applicable, result, and evidence. Audit output must be append-only and protected from ordinary application mutation.

Redaction rules apply before logs, traces, reports, and error messages leave their trust boundary. Test redaction against API keys, bearer tokens, passwords, connection strings, private keys, cookies, and known secret-manager values.

## 24. Security implementation checklist

The checked items below describe enforced local/provider-neutral controls. Hosted enforcement,
container isolation, production identity, and retention operations remain explicit phase gates.

- [x] Tenant scoped queries and constraints in local repositories, API routes, catalogs, artifacts, and worker pools; hosted database execution remains a Phase 2 gate.
- [x] Short-lived tool grants with invocation, authority, expiry, resource, and use-count binding.
- [x] Commit-time authority and approval validation for durable artifact, model, deployment, budget, and tool effects.
- [x] No raw production secret in model context; secret handles, redaction, and secret-shaped environment rejection are enforced locally.
- [x] Network allowlist is part of the sandbox/task contract and the local sandbox fails closed when it cannot enforce a non-empty allowlist.
- [x] Invocation-specific local workspaces are created and cleaned up; hosted worktree/container isolation remains a Phase 7/12 gate.
- [x] Read-only artifact mounts are copied into invocation workspaces with read-only permissions where supported.
- [x] Wall-time, output, process, and contract-level resource limits are enforced locally; CPU, memory, storage cgroups, and hosted quota enforcement remain open.
- [x] Dependency and secret scanning for changed/generated code is enforced by the coding sandbox contract.
- [x] Untrusted external content is explicitly labeled and kept separate from policy/trusted context sections.
- [x] Local object-store, sandbox, and workspace-archive path traversal protections are enforced; archive restore rejects symlinks, non-regular files, duplicate/traversal paths, malformed base64, and digest mismatches. Archive confidentiality/encryption remains an explicit v1 policy decision.
- [x] Artifact content hashes are verified on read/publication and media types are required to be non-empty; a hosted content-type policy remains open.
- [x] Authority envelopes have verifiable integrity, and grants carry verifiable authority binding; signed event provenance across external trust boundaries remains open.
- [x] Approval action digests are bound and revalidated at commit time.
- [x] Budget reservations and reconciliation use serialized concurrency controls and integer minor units.
- [x] Append-only, redacted, hash-chained audit records and lifecycle audit coverage are implemented locally; hosted audit retention/completeness monitoring remains open.
- [x] Break-glass process with independent human approval, explicit scope, bounded use count, additional audit, and expiration in `packages/policy/src/break-glass.ts`; hosted identity/durable-store integration remains open.
- [x] Revocation propagation for authority envelopes, approvals, tool grants, and hosted adapter boundaries.
- [x] Optional local API bearer-session verification stores only token digests, checks expiry/revocation, and binds JSON/SSE requests to an authenticated session workspace; hosted identity integration remains open.
- [x] Data retention and deletion workflow uses explicit policy versions, legal-hold blocking, independent approval, bounded tenant-scoped batches, resumable cursors, audit events, and completion tombstones in `packages/state/src/tenant-lifecycle.ts`; hosted retention/backup/object-store execution remains open.
- [ ] Spyderbyte license signatures, Keychain receipt storage, startup validation, and effectful-command enforcement pass the Phase 8A test matrix.
- [ ] macOS app, nested binaries, sidecars, update artifacts, and DMG are Developer ID signed, Hardened Runtime enabled, notarized, stapled, and Gatekeeper-verified.
- [ ] Workspace import/export, backup/restore, uninstall preservation, and interrupted-update recovery pass on a clean supported Mac.

Open production controls are container/image scanning, production identity/authentication, hosted
resource enforcement, signed cross-service provenance where required, break-glass operations,
retention/deletion execution, backup/DR validation, macOS release evidence, and SLO/load evidence.

## 25. Pull request and change discipline

Each implementation change must include:

- the work package addressed;
- rationale and linked ADR if architectural;
- contracts added or changed;
- migrations and backward-compatibility impact;
- authority/policy/budget/security impact;
- tests run and results;
- observability changes;
- rollout and rollback notes;
- progress-ledger update only when the phase gate passes.

Changes that modify a durable schema, event, approval digest, policy input, artifact format, or adapter contract require explicit compatibility review.

Do not combine unrelated phases in one change. Prefer a complete contract-through-test slice over broad scaffolding.

## 26. Human decision gates

Codex must stop and request approval before:

- changing a non-negotiable invariant;
- selecting a cloud provider or committing to Kubernetes versus SLURM;
- selecting a model provider or sending real data to a hosted model;
- enabling production credentials or external systems;
- setting production cost or approval thresholds;
- enabling production model promotion or serving traffic changes;
- publishing a connector;
- adopting a breaking data/event migration without a compatibility path;
- changing tenant isolation or retention guarantees;
- accepting a critical residual security risk;
- deleting or irreversibly migrating user data.

Codex may proceed without a gate for reversible local scaffolding, pure contracts, fakes, fixtures, local-only adapters, and tests that do not access production data or systems.

## 27. Decision log

Record decisions here only as a summary; ADR files remain authoritative.

| Date | ADR | Decision | Status |
|---|---|---|---|
| 2026-08-02 | ADR-0001 | Greenfield TypeScript monorepo baseline accepted | Accepted |
| 2026-08-02 | ADR-0002 | UUIDv7 identifiers, UTC instants, minor-unit money, and explicit quantities accepted | Accepted |
| 2026-08-02 | ADR-0003 | JSON Schema authority with deterministic generated TypeScript/docs accepted | Accepted |
| 2026-08-02 | ADR-0004 | PostgreSQL hosted metadata and contract-compatible SQLite local store accepted | Accepted |
| 2026-08-02 | ADR-0005 | Internal workflow engine with Temporal as the Phase 6 default accepted pending proof-of-concept | Accepted pending proof |
| 2026-08-02 | ADR-0006 | Transactional outbox with NATS JetStream hosted transport accepted pending proof | Accepted pending proof |
| 2026-08-02 | ADR-0007 | Deterministic local policy evaluator with OPA hosted default accepted | Accepted |
| 2026-08-02 | ADR-0008 | SHA-256 content-addressed filesystem/S3-compatible artifact storage accepted | Accepted |
| 2026-08-02 | ADR-0009 | Cline isolated behind a pinned internal adapter accepted | Accepted |
| 2026-08-02 | ADR-0010 | Versioned REST commands/queries plus SSE subscriptions accepted | Accepted |
| 2026-08-02 | ADR-0011 | Local coding tasks use a deterministic mutable workspace and fail-closed network policy | Accepted for local Phase 7 |
| 2026-08-02 | ADR-0012 | Hosted resources use provider-neutral injected clients until the provider/topology gate is accepted | Accepted for adapter work |
| 2026-08-03 | ADR-0013 | Explicit workflow-definition upgrades and generated API contract accepted for provider-neutral local implementation | Accepted for local implementation |
| 2026-08-03 | ADR-0014 | Provider-neutral worker-pool lease contract accepted for local implementation | Accepted for local implementation |
| 2026-08-03 | ADR-0015 | Provider-neutral lifecycle adapters validate hosted experiment, registry, and deployment responses | Accepted for adapter work |
| 2026-08-03 | ADR-0016 | Dataset catalog resolution and publication use a tenant-scoped provider-neutral adapter contract | Accepted for local implementation |
| 2026-08-03 | ADR-0017 | Interaction reads use injected projections, bounded cursors, and replaceable rate limiting | Accepted for local implementation |
| 2026-08-03 | ADR-0018 | SLO and capacity evidence use target-supplied provider-neutral release gates | Accepted for local evidence generation |
| 2026-08-03 | ADR-0019 | Break-glass access uses expiring, explicitly scoped, independently approved, bounded grants with audit evidence | Accepted for local implementation |
| 2026-08-03 | ADR-0020 | Tenant retention/deletion uses policy-versioned inventory, legal-hold blocking, approved bounded batches, and tombstones | Accepted for local implementation |
| 2026-08-03 | ADR-0021 | Browser transport uses the versioned JSON API and reconnectable SSE with explicit conflict UX | Accepted for local implementation |
| 2026-08-03 | ADR-0022 | Harness rollout uses provider-neutral hold/advance gates with previous-release rollback evidence | Accepted for local implementation |
| 2026-08-03 | ADR-0023 | Model publication uses structured, tenant-bound lineage evidence for checkpoint, run/configuration, source, environment, dataset, and original-data provenance | Accepted for local implementation |
| 2026-08-03 | ADR-0024 | Connector builds are deterministic and publication approvals bind to source, package, scope, scan, and contract-test material | Accepted for local implementation |
| 2026-08-03 | ADR-0025 | Model lifecycle results include a typed reconciliation report for artifacts, metrics, cost, and rollout state | Accepted for local implementation |
| 2026-08-03 | ADR-0026 | API identity is an injectable tenant-bound session port with hashed local bearer fixtures and hosted-provider substitution | Accepted for local implementation |
| 2026-08-03 | ADR-0027 | Spyderbyte v1 is the primary shippable product; hosted resource-plane work is deferred from its release path | Accepted for the current release track |
| 2026-08-03 | ADR-0028 | Tauri 2 is the macOS desktop host with the existing React/Vite UI and local daemon as a managed process/sidecar | Accepted for the first implementation slice; native file lifecycle, crash evidence, signing, and update recovery remain open |
| 2026-08-04 | ADR-0029 | Local licensing uses an Ed25519-signed offline entitlement with public-key verification, atomic import/revalidation, and native macOS Keychain receipt persistence with a mode-0600 active cache | Accepted for the technical contract; clean-machine Keychain evidence, activation, and product/legal policy remain open |
| 2026-08-04 | ADR-0030 | Frontend visual direction follows the monday.com Vibe UI Kit and `/Users/josiah/Documents/frontend design/platform-focus-wireframe`; the supplied three-pane analysis workspace is the fidelity target, while first-run/provider/objective/plan/run/artifact/storage/settings views are derived extensions until additional wireframes exist | Accepted for the production UI slice; preview content and live provider execution remain open |
| 2026-08-04 | ADR-0031 | The desktop runtime uses a self-contained Node sidecar on an OS-assigned loopback port, a per-launch bearer session delivered through the Tauri command bridge, an HttpOnly cookie for browser SSE, workspace-backed SQLite/CAS, bounded restart with token continuity, Tauri single-instance/window focus, native folder selection with supervised workspace switching, and explicit Tauri webview CORS origins | Accepted for Spyderbyte hardening; clean-machine recovery evidence and update supervision remain open |
| 2026-08-03 | ADR-0033 | Local typed plans bind exact action-digest approvals, wait before execution, and persist approval records beside SQLite in the portable workspace | Accepted for Spyderbyte v1 |
| 2026-08-04 | ADR-0032 | Local workspace portability uses a versioned JSON archive with sorted regular-file entries, per-file SHA-256 digests, an archive digest, traversal/symlink rejection, restore preview, and non-overwriting restore; archives are integrity protected but not encrypted in v1 | Accepted for Spyderbyte implementation; export confidentiality/encryption policy remains open |

## 28. Open questions backlog

Resolve each through an ADR, product decision, or implementation spike before its dependent phase.

1. Which identifier standard: UUIDv7 or ULID?
2. Which schema library/generation path is authoritative?
3. SQLite or embedded PostgreSQL for local mode?
4. Temporal self-hosted, managed, or an alternative durable engine?
5. NATS JetStream or another event transport?
6. OPA, Cedar, or internal policy evaluator for hosted policy?
7. Kubernetes or SLURM first?
8. Which experiment tracker first?
9. Which object store and secret manager in the first hosted environment?
10. Which model providers and data-handling constraints are allowed?
11. What approval thresholds apply to spend, access, promotion, deployment, and connector publication?
12. What are the required retention, residency, encryption, and deletion policies?
13. Which benchmark suites and safety metrics gate promotion?
14. What are initial SLO and capacity targets?
15. What connector is the low-risk reference implementation?
16. Which macOS versions and CPU architectures are supported for Spyderbyte v1?
17. Is Tauri 2 accepted as the desktop host after the lifecycle/Keychain/deep-link spike?
18. What is the Spyderbyte workspace path, export format, cache policy, and uninstall-preservation policy?
19. Which Apple Developer account, signing identities, notarization credentials, and release owners are used?
20. What are the license editions, feature entitlements, validity windows, refresh policy, grace behavior, and customer recovery policy?
21. Is device binding required for v1, or is license-file import plus signed entitlement sufficient?
22. What is the first provider/connector and OAuth callback mode supported in the DMG release?
23. Which Vibe component variants are mapped to the final React component API and token names?

## 29. Immediate next actions

The original Phase 0 bootstrap sequence below is complete. The next implementation decision is now
the Spyderbyte v1 productization gate. Hosted topology remains a later compatibility track and
must not displace the desktop, workspace, license, frontend, and DMG work.

Current next actions:

1. Finish the remaining frontend vertical journey on top of the supplied prototype anatomy:
   first-run/license, workspace open/import, objective, typed plan review, approval, live run, artifact
   lineage, storage, and settings. Provider setup is now wired through the local API and vault boundary.
2. Replace the preview SQL/result surface with the first provider/model-backed execution path and
   authoritative projection/result/artifact bindings; preserve the existing API and typed-command
   boundaries.
3. Validate UI license import plus provider-secret Keychain persistence in a signed build without
   exposing credentials to the webview or model context; the adapter command contract is already
   covered by local tests.
4. Run the Tauri clean-machine smoke pass for first launch, native dialogs, Keychain receipt
   persistence, restart recovery, single-instance behavior, and archive restore.
5. Run the universal app/sidecar build on an Apple Silicon release runner, then configure Developer
   ID, Hardened Runtime, notarization, Gatekeeper, update, rollback, and release-owner evidence.
6. Produce the signed/notarized DMG candidate and run the complete clean-machine Spyderbyte
   release gate before returning to hosted topology work.

The original bootstrap sequence was:

1. Initialize the repository and package manager configuration.
2. Add the directory/package skeleton.
3. Add strict compiler, lint, formatting, unit-test, and boundary rules.
4. Create CI using the single `pnpm verify` entrypoint.
5. Write ADR-0001 through ADR-0004 and resolve them.
6. Create the `runtime-contracts` package.
7. Implement shared ID, time, money, tenant, actor, error, and schema-version primitives.
8. Add contract fixtures and JSON Schema drift checks.
9. Run the Phase 0 gate.
10. Update the progress ledger only after the gate passes.

Do not begin with a disconnected mock web UI, broad specialist prompts, cloud deployment, or a
direct Cline integration. The runtime contracts and enforcement boundaries must exist first, and
the production frontend must be wired to the local daemon and Spyderbyte release gates.

## 30. Reference sources for implementation choices

The architecture supplied by the user is the primary product source. The following official sources should be rechecked at implementation time because APIs and operational guidance can change:

- Temporal durable execution documentation: <https://docs.temporal.io/>
- NATS JetStream concepts and delivery semantics: <https://docs.nats.io/nats-concepts/jetstream>
- Open Policy Agent bundles and policy distribution: <https://www.openpolicyagent.org/docs/management-bundles>
- Open Policy Agent REST decision API: <https://www.openpolicyagent.org/docs/rest-api>
- Cline Agent/AgentRuntime SDK reference: <https://docs.cline.bot/sdk/reference/agent>
- Cline source repository: <https://github.com/cline/cline>
- monday.com Vibe documentation: <https://vibe.monday.com/?path=/docs/welcome--docs>
- monday.com Vibe UI Kit source file: <https://www.figma.com/design/ecqBuAHeBjTp9M8X5t0jIC/Vibe-UI-Kit-by-monday.com--Community-?m=auto&is-community-duplicate=1&fuid=1249231832359008557>
- Tauri distribution and DMG documentation: <https://v2.tauri.app/distribute/> and <https://v2.tauri.app/distribute/dmg/>
- Apple macOS notarization documentation: <https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution>
- Apple Developer ID guidance: <https://developer.apple.com/support/developer-id/>

When implementation begins, pin dependencies through the lockfile and record verified APIs in adapter compatibility tests. Do not treat this plan's references as permission to bypass a current documentation check.
