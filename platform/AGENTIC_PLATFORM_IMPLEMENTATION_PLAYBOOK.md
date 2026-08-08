# Agentic ML/Data Platform Implementation Playbook

> **Superseded:** This is a historical foundation playbook. The authoritative plan going forward
> is [`SPYDERBYTE_IMPLEMENTATION_PLAN.md`](SPYDERBYTE_IMPLEMENTATION_PLAN.md).
> Keep this file as evidence; do not use it for new status updates or phase decisions.

**Document status:** Historical foundation playbook; superseded  
**Version:** 1.0  
**Prepared:** 2026-08-02  
**Audience:** Codex implementation agents, platform engineers, security reviewers, ML platform engineers, and product engineers  
**Source architecture:** *Agentic ML/Data Platform — End-to-End Runtime and Harness Architecture*  
**Repository state at baseline:** Greenfield; no source repository or package structure exists yet.

> **Operating instruction for Codex:** Treat this document as the execution playbook for the platform. Follow the phase gates in order, preserve every non-negotiable invariant, implement only against versioned contracts, and update the status ledger and decision records as work is completed. When repository reality conflicts with this document, stop, record the conflict as an ADR or change proposal, and obtain approval before changing a security boundary, hierarchy rule, durability guarantee, authority rule, or artifact semantic.

---

## 1. Purpose and How to Use This Document

This playbook converts the target architecture into a build sequence that an implementation agent can execute. It is not a summary of the architecture. It specifies what to build, where to build it, what dependencies must exist first, how to test each component, and what evidence is required before advancing.

The platform must provide a durable control plane for agentic ML and data work. Users interact through chat and workspace panels, but the control plane—not the user interface or any agent—owns workflow state, authorization, approvals, cost enforcement, audit, recovery, and artifact lineage.

### 1.1 Codex execution protocol

For every implementation task, Codex shall:

1. Read the active phase, prerequisite gates, relevant contracts, and applicable ADRs.
2. Inspect the repository and preserve unrelated user changes.
3. State the exact work package being implemented and its acceptance criteria.
4. Add or update tests before claiming completion.
5. Run the smallest relevant test suite, then the phase verification suite.
6. Run formatting, linting, type checking, schema compatibility checks, and `git diff --check`.
7. Produce evidence: changed files, commands executed, test results, migrations, and known limitations.
8. Update the progress ledger only after evidence passes.
9. Stop at any human approval gate. Never infer approval from silence.
10. Create an ADR before introducing a new infrastructure dependency, changing a public contract, or weakening a stated invariant.

### 1.2 Work-package completion record

Every completed work package must record:

- work-package ID and title;
- implementation summary;
- files and migrations changed;
- contract or schema versions affected;
- tests and verification commands run;
- security and data-handling impact;
- operational impact and rollback path;
- unresolved risks or follow-up work;
- commit or pull-request reference when available.

### 1.3 Progress ledger

| Phase | Outcome | Status | Exit evidence |
|---|---|---:|---|
| 0 | Repository bootstrap and architectural decisions | Not started | Toolchain, CI, ADRs, local dependencies |
| 1 | Runtime contracts and compatibility tooling | Not started | Published schemas, contract tests, generated types |
| 2 | Authoritative state, artifact registry, event log, projections | Not started | Transactional tests, migrations, replay tests |
| 3 | Authority, policy, approvals, budgets, audit | Not started | Deny-by-default tests and approval invalidation tests |
| 4 | Harness core and invocation enforcement | Not started | Tier tests, report validation, adapter contract tests |
| 5 | Local data-to-training vertical slice | Not started | End-to-end local smoke workflow |
| 6 | Durable execution, recovery, retries, cancellation, streaming | Not started | Crash/restart and reconnect tests |
| 7 | Hosted resource plane and distributed workers | Not started | Cloud adapter and workload isolation tests |
| 8 | MLOps, evaluation, registry, deployment, rollback | Not started | Candidate-to-canary end-to-end test |
| 9 | Governance and connector publication | Not started | Scope, secret, sandbox, and approval tests |
| 10 | Product shell and real-time projections | Not started | UI workflow tests and reconnect behavior |
| 11 | Production hardening and launch readiness | Not started | SLO, security, DR, load, and operations sign-off |

Statuses are limited to `Not started`, `In progress`, `Blocked`, `In review`, and `Complete`.

---

## 2. Fixed Architecture Invariants

These invariants are acceptance criteria for every phase and must be enforced in code, not only in prompts or documentation.

1. Tier 0 may invoke only Tier 1.
2. Tier 1 may invoke only Tier 2.
3. Tier 2 may not invoke agents.
4. Only the Cluster specialist may allocate compute.
5. Only Governance may issue policy decisions.
6. Only FinOps may reserve or reconcile budget.
7. Only Deployment may alter serving traffic.
8. Only deterministic registry services publish approved connectors or models.
9. Production credentials never enter agent context, logs, artifacts, reports, or model messages.
10. Every consequential action emits an immutable audit event.
11. Published artifacts are versioned and immutable; changes create new versions.
12. Human-authored artifact versions take precedence over agent-authored versions.
13. Every invocation has explicit authority, cost, time, resource, context, and retry limits.
14. Every agent output is parsed and validated before acceptance.
15. Tier 2 success means mechanical acceptance criteria passed; it does not validate parent strategy.
16. Approval binds to an exact action digest covering artifact versions, scopes, targets, and cost.
17. Frontend panels contain no independent orchestration, ML, security, or cost policy.
18. Local and hosted deployments implement the same public contracts.
19. Tier 2 uses no LLM when deterministic execution is sufficient.
20. Cline-specific APIs remain behind the Cline runtime adapter.

### 2.1 Automated invariant suite

Create `packages/testkit/src/invariants/` during Phase 1. Every invariant receives at least one positive test and one negative test. The suite must run in CI against local implementations and hosted adapters. A change that causes an invariant test to fail is release-blocking.

---

## 3. Baseline Technology Decisions

The repository is greenfield. Use the following defaults to make the plan executable. Exact dependency versions are selected and pinned in Phase 0 after compatibility spikes; do not hard-code versions in this document.

| Concern | Default | Boundary and rationale |
|---|---|---|
| Primary language | TypeScript on the current supported Node.js LTS | Shared contracts across API, workers, harnesses, and web client |
| Monorepo | pnpm workspaces with Turborepo | Deterministic dependency graph and task orchestration |
| API | Fastify with OpenAPI generation | Schema-first REST, low overhead, plugin isolation |
| Web | React, TypeScript, Vite, TanStack Query | Projection-driven SPA with explicit server state |
| Runtime validation | Zod as authoring schema; JSON Schema as interchange | One source for validation and generated API contracts |
| Authoritative hosted store | PostgreSQL | Transactions, optimistic concurrency, relational integrity |
| Local metadata store | SQLite behind the same repository interfaces | Lightweight local daemon; no contract divergence |
| Durable workflow engine | Temporal behind `WorkflowBackend` | Crash recovery, timers, retries, signals, and long-running execution |
| Event transport | Transactional outbox plus NATS JetStream | Database is truth; JetStream distributes and replays integration events |
| Object storage | S3-compatible API; MinIO for local development | Content-addressed large artifacts and portable deployments |
| Policy | OPA behind `PolicyDecisionService` | Independently enforced, versioned policy decisions |
| Observability | OpenTelemetry traces, metrics, and logs | Vendor-neutral correlation across command, workflow, invocation, and tool call |
| Agent runtime | Cline SDK behind `ClineRuntimeAdapter` | Prevent SDK lifecycle or package changes from leaking into business logic |
| Containers | OCI images and Docker Compose locally | Reproducible workers and local dependency stack |
| Cloud scheduler first target | Kubernetes | Implement SLURM only after the compute adapter contract is proven |

Temporal is the hosted durability default, but domain code must depend only on `WorkflowBackend`. NATS is distribution infrastructure, not the authoritative event log. PostgreSQL transactions and the outbox pattern determine committed state. OPA is advisory only through an enforcement wrapper: the tool broker and commit path must independently apply its decisions.

### 3.1 Required Phase 0 ADRs

- ADR-0001: Monorepo, language, and build toolchain.
- ADR-0002: Identifier, time, money, and hashing conventions.
- ADR-0003: PostgreSQL event log plus outbox and JetStream delivery semantics.
- ADR-0004: Temporal workflow boundary and determinism rules.
- ADR-0005: Local SQLite compatibility strategy.
- ADR-0006: OPA policy bundle ownership and release flow.
- ADR-0007: Cline SDK adapter surface and pinned compatibility version.
- ADR-0008: Artifact object layout and encryption policy.
- ADR-0009: Authentication provider interface and development identity mode.
- ADR-0010: Deployment environments and promotion model.

No phase may silently substitute a different technology. A replacement is allowed when an ADR documents contract compatibility, migration, operational burden, security impact, and rollback.

---

## 4. Target Repository Layout

Create the following structure incrementally. Do not generate empty packages that have no owner or phase deliverable.

```text
/.github/workflows
/apps
  /api                 # hosted command, query, approval, and subscription API
  /web                 # projection-driven user interface
  /local-daemon        # local API, coordinator, stores, and adapters
  /worker              # Temporal activities and distributed worker entrypoints
/packages
  /runtime-contracts   # schemas, IDs, commands, events, reports, artifacts
  /state               # repositories, event log, outbox, projections
  /artifact-registry   # immutable metadata and object-store operations
  /workflow            # coordinator, plan execution, recovery contracts
  /harness-core        # factory, context, tools, models, hooks, validators
  /cline-adapter       # sole package importing Cline SDK runtime APIs
  /orchestrator        # Tier 0 planning and aggregation
  /specialists         # Tier 1 domain packages
  /tasks               # Tier 2 coding, plugin-backed, deterministic tasks
  /policy              # authority, policy, approvals, action digests
  /finops              # reservations, metering, reconciliation
  /backends            # compute, experiments, catalog, secret, serving adapters
  /observability       # tracing, audit, redaction, usage
  /testkit             # fixtures, fakes, contract and invariant suites
  /config              # typed configuration and environment validation
/db
  /migrations/postgres
  /migrations/sqlite
  /seeds
/deploy
  /compose
  /kubernetes
  /opa
  /temporal
/docs
  /adr
  /contracts
  /runbooks
  /threat-models
  /examples
/scripts
```

### 4.1 Dependency rules

- `runtime-contracts` imports no internal package.
- Domain packages depend on ports/interfaces, never concrete hosted adapters.
- `cline-adapter` may import Cline SDK packages; no other package may do so.
- `apps/web` consumes generated API types and projection DTOs only.
- `tasks` may not import `orchestrator` or any specialist package.
- Specialists may invoke Tier 2 through `InvocationService`; they may not instantiate task harnesses directly.
- Database, event bus, secret manager, model provider, experiment tracker, scheduler, and serving clients live only under adapter packages.
- Circular package dependencies are prohibited and checked in CI.

---

## 5. Canonical Domain Conventions

### 5.1 Identifiers and time

- Use opaque, sortable ULIDs with type prefixes: `cmd_`, `wf_`, `inv_`, `art_`, `evt_`, `apr_`, `bud_`, `pol_`, `run_`.
- Persist timestamps as UTC and serialize as RFC 3339 strings.
- Never derive authorization from an ID prefix.
- Accept caller idempotency keys separately from server-generated IDs.

### 5.2 Money and quantities

- Store money as integer minor units plus ISO 4217 currency.
- Store measured usage separately from estimated cost.
- A hard limit is enforced before reservation and again before commit.
- Floating-point numbers may represent metrics, not currency.

### 5.3 Schema and event versioning

- Every external schema includes `schemaVersion`.
- Event names are versioned, for example `workflow.planned.v1`.
- Additive backward-compatible fields are optional at first release.
- Breaking changes require a new schema/event version plus upcaster or dual-read migration.
- Persist raw event payloads exactly as accepted; projections may use normalized tables.
- Generated OpenAPI and JSON Schemas are committed and checked for drift.

### 5.4 Artifact identity

An artifact has a stable logical identity and immutable versions. Use `(tenant_id, artifact_id, version)` as the version key. Each published version includes:

- canonical content hash using SHA-256;
- object URI or inline content reference;
- media type and byte size;
- creator actor and optional invocation;
- ordered lineage edges;
- ownership authority and lock mode;
- lifecycle status;
- schema type and schema version;
- retention and classification metadata.

Object keys follow `tenants/{tenantId}/artifacts/{artifactId}/versions/{version}/{contentHash}`. Never use a user-provided filename as the authoritative identity.

### 5.5 Command commit protocol

Every mutating command follows this transaction:

1. Authenticate actor and resolve tenant/workspace membership.
2. Validate command envelope and typed payload.
3. Check idempotency key; return the prior result when already committed.
4. Load aggregate version and compare `expectedStateVersion` when supplied.
5. Evaluate authority and policy.
6. Validate approval digest for consequential actions.
7. Reserve budget or compute authority when required.
8. Apply domain transition.
9. Append aggregate event and audit record in the same database transaction.
10. Insert outbox record in the same transaction.
11. Commit, then asynchronously publish the outbox record.
12. Return command result with aggregate version and projection cursor.

No tool or agent may bypass this path for durable effects.

---

## 6. Core Runtime Contracts

Phase 1 must implement these contracts before business workflows.

### 6.1 Required schema modules

`packages/runtime-contracts/src/` contains:

```text
actor.ts                  ActorIdentity and tenant/workspace scope
ids.ts                    typed ID constructors and validators
time.ts                   RFC 3339 helpers
money.ts                  minor-unit money and usage quantities
commands/base.ts          RuntimeCommand envelope
commands/catalog.ts       command type registry
workflows.ts              Workflow and workflow state machine
plans.ts                  ExecutionPlan, PlanStep, dependencies
invocations.ts            AgentInvocation, envelopes, state machine
reports.ts                AgentReport, decisions, failures, assertions
artifacts.ts              artifact metadata, versions, lineage, ownership
events/base.ts            RuntimeEvent envelope
events/catalog.ts         event type registry and payload schemas
approvals.ts              ApprovalRequest and action digest inputs
budgets.ts                BudgetEnvelope, reservation, reconciliation
authority.ts              AuthorityEnvelope and capability grants
resources.ts              ResourceEnvelope and selectors
agents.ts                 AgentRegistration and harness compatibility
projections.ts            frontend query DTOs and subscription cursors
errors.ts                 stable machine-readable error catalog
```

### 6.2 State machines

Encode transitions as pure functions with exhaustive tests.

**Workflow:** `planning → awaiting_approval | executing | blocked | cancelled`; `awaiting_approval → executing | blocked | cancelled`; `executing → awaiting_approval | blocked | completed | failed | cancelled`; terminal states are immutable.

**Invocation:** `created → context_ready → running → awaiting_approval | verifying | blocked | failed | cancelled`; `verifying → succeeded | partially_succeeded | failed`; terminal states are immutable.

**Artifact:** `DRAFT → VALID | BLOCKED | ARCHIVED`; `VALID → STALE | SUPERSEDED | ARCHIVED`; `STALE → VALID | SUPERSEDED | ARCHIVED`; publication creates a version and never mutates content.

**Approval:** `pending → approved | rejected | expired | revoked`; approved requests may later become `revoked` or be treated as invalid when the action digest no longer matches.

**Deployment:** `REQUESTED → PROVISIONING → SMOKE_TESTING → CANARY → RAMPING → ACTIVE`; any nonterminal stage may transition to `ROLLING_BACK → ROLLED_BACK` or `FAILED`.

### 6.3 Error catalog

All services return a stable error shape containing `code`, `category`, `message`, `retryable`, `correlationId`, and optional validation details. Minimum codes:

- `VALIDATION_FAILED`
- `UNAUTHENTICATED`
- `AUTHORITY_DENIED`
- `POLICY_DENIED`
- `APPROVAL_REQUIRED`
- `APPROVAL_INVALID`
- `VERSION_CONFLICT`
- `BUDGET_EXCEEDED`
- `RESOURCE_UNAVAILABLE`
- `ARTIFACT_NOT_FOUND`
- `ARTIFACT_HASH_MISMATCH`
- `HARNESS_DISABLED`
- `TIER_VIOLATION`
- `REPORT_REJECTED`
- `RETRY_EXHAUSTED`
- `DEPENDENCY_FAILED`
- `INTERNAL_ERROR`

### 6.4 Contract acceptance criteria

- All schemas produce JSON Schema.
- Valid and invalid fixtures exist for every top-level contract.
- State transition tests cover every allowed and denied edge.
- Type generation is deterministic.
- Schema compatibility CI detects breaking changes.
- Unknown enum values fail closed at command and effect boundaries.
- Contract package has no runtime dependency on API, databases, SDKs, or UI.

---

## 7. Authoritative State and Event Architecture

### 7.1 Hosted relational model

Create PostgreSQL migrations for:

- `tenants`, `workspaces`, `workspace_members`;
- `commands` and `command_results` with unique idempotency key scope;
- `workflows`, `workflow_plan_versions`, `workflow_dependencies`;
- `invocations`, `invocation_attempts`, `invocation_relationships`;
- `artifacts`, `artifact_versions`, `artifact_lineage`;
- `approvals` and `approval_history`;
- `budget_accounts`, `budget_reservations`, `usage_observations`, `cost_ledger`;
- `policies`, `policy_decisions`;
- `agent_registrations`, `harness_evaluations`;
- `runtime_events`, `audit_events`, `outbox`;
- projection tables for workflows, jobs, compute, artifacts, costs, approvals, and audits.

Every tenant-owned table includes `tenant_id`. Queries must require tenant scope at the repository boundary. Add row-level security only as defense in depth; application scoping remains mandatory.

### 7.2 Event log rules

- `(aggregate_type, aggregate_id, aggregate_version)` is unique.
- `event_id` is globally unique.
- `correlation_id` follows the originating command or workflow.
- `causation_id` points to the direct causing command, event, or invocation.
- Event append and aggregate write occur in one transaction.
- Consumers are idempotent using `(consumer_name, event_id)` or projection cursor.
- Outbox publication is at-least-once; duplicate delivery is expected.
- Projection rebuild reads the authoritative database event log, not NATS retention.

### 7.3 Artifact publication protocol

1. Create upload intent with maximum size, media type, classification, and expiry.
2. Upload to invocation-scoped staging storage.
3. Stream-compute content hash and malware/security scan where applicable.
4. Validate content against artifact schema and acceptance policy.
5. Verify lineage references and tenant ownership.
6. In one transaction, assign the next version, write metadata, lineage, audit, and outbox events.
7. Copy or promote the staged object to its content-addressed final key.
8. If object promotion fails, mark publication pending and reconcile; never expose a valid metadata record pointing to missing content.
9. Emit `artifact.published.v1` only when content is readable and hash-verified.

### 7.4 Human edit precedence

Human edits create a new version with `authority=human`. Agent commits use optimistic concurrency. If the latest version changed while an invocation ran, the agent commit fails with `VERSION_CONFLICT`. The specialist may rebase only by loading the new human version, treating protected fields as constraints, and producing a candidate version. Downstream artifacts become `STALE` through lineage traversal when their inputs are superseded or invalidated.

### 7.5 Projection rules

- Projections are disposable and rebuildable.
- Each workspace projection has a monotonic cursor.
- A projection update is idempotent and transactional.
- The API returns `projectionVersion` and `cursor` for debugging.
- Chat, panels, notifications, and exports read the same projection DTOs.
- No projection writes authoritative state.

### 7.6 State phase acceptance criteria

- Migrations apply from zero and roll forward on PostgreSQL and SQLite.
- Concurrent artifact writes produce one winner and one version conflict.
- Duplicate commands return the original result without duplicate events.
- Outbox retry does not duplicate projection effects.
- Full projection rebuild produces byte-equivalent normalized results.
- Missing or hash-mismatched artifact content is rejected.
- Cross-tenant reads and lineage links fail.

---

## 8. Authority, Policy, Approval, Budget, and Audit

### 8.1 Authority envelope

An `AuthorityEnvelope` is minted by the control plane and contains:

- subject actor or invocation;
- tenant and workspace;
- allowed capabilities and operations;
- resource selectors;
- issue and expiry timestamps;
- maximum delegation tier;
- approval references;
- policy version;
- nonce and signature or server-side handle;
- revocation epoch.

Authority is checked at tool-call time and again at commit time. A valid envelope is necessary but not sufficient; current policy, approval, budget, resource version, and revocation status must still pass.

### 8.2 Tool broker

Implement `ToolBroker.requestGrant`, `ToolBroker.invoke`, and `ToolBroker.revoke`. Tool definitions declare operation schemas, risk class, side-effect class, required approvals, resource selector grammar, maximum output size, redaction policy, and audit fields.

The broker pipeline is:

1. validate request schema;
2. resolve invocation and current state;
3. check tier and registered harness capability;
4. evaluate authority;
5. request OPA decision with trusted structured input;
6. validate exact approval digest when required;
7. reserve budget when the operation incurs cost;
8. obtain a short-lived credential handle from the secret broker;
9. invoke adapter with timeout and output limits;
10. redact output before model exposure;
11. reconcile cost and emit audit/usage events;
12. release credential and reservation handles.

### 8.3 Approval action digest

Compute a canonical SHA-256 digest over:

- action type;
- tenant/workspace;
- actor and requesting invocation;
- sorted resource scopes;
- exact artifact IDs and versions;
- credential scopes;
- deployment target and traffic percentage;
- compute shape and offer ID;
- estimated maximum cost and currency;
- policy version;
- expiry.

Any material field change produces a different digest and requires a new approval.

### 8.4 Budget ledger

Use double-entry-style ledger semantics for reservations and actual usage. At minimum support `reserve`, `increase`, `release`, `consume`, `reconcile`, and `expire`. Enforce:

`consumed + reserved + requestedReservation <= hardLimit`

Operations must be idempotent. LLM and compute calls reserve before execution, record provider observations, then reconcile. Unknown actual cost may not exceed the reservation without a fresh check or approval.

### 8.5 Audit requirements

Audit records include actor, tenant, workspace, action, decision, resource, correlation, causation, policy version, approval, before/after version references, source IP or worker identity, timestamp, and redacted evidence. Audit records are append-only. Sensitive values are represented by classifications and hashes, never plaintext secrets.

### 8.6 Security acceptance criteria

- All tools deny by default.
- Expired, revoked, cross-tenant, wrong-tier, or scope-mismatched grants fail.
- Commit-time reauthorization catches approval, policy, or artifact changes during execution.
- Production secret plaintext never appears in test-captured prompts, logs, traces, reports, or artifacts.
- Budget races cannot over-reserve a hard limit.
- Approval digest mutation tests invalidate approvals.
- Audit completeness checks cover every consequential command and tool.

---

## 9. Harness Core

### 9.1 Core interfaces

Implement under `packages/harness-core/src/`:

- `HarnessDefinition<I,O>`
- `HarnessFactory`
- `RunningHarness`
- `ContextAssembler`
- `PromptPolicy`
- `ToolPolicy`
- `ModelPolicy` and `ModelRouter`
- `AuthorityPolicy`
- `BudgetPolicy`
- `ApprovalPolicy`
- `RetryPolicy`
- `AcceptancePolicy<O>`
- `HarnessHooks`
- `ReportValidator`
- `InvocationService`

The factory receives only runtime ports. It must not reach into global singletons or environment variables.

### 9.2 Context assembly

Context is a typed collection of blocks with trust labels:

- `system_policy`;
- `trusted_workspace_policy`;
- `user_instruction`;
- `artifact_summary` or `artifact_content`;
- `prior_report`;
- `agent_generated`;
- `untrusted_external`.

Each block records source, version, classification, token estimate, and redaction status. Assemblers include the minimum required content. Tier 0 receives organization/workflow summaries; Tier 1 receives relevant domain data; Tier 2 receives exact task input and mounted files.

### 9.3 Model router

Route by task class, tier, data classification, context size, required structured output, latency budget, and cost envelope. Provider credentials are referenced through the model gateway, not passed to the harness. Record route decision, provider/model identifier, prompt policy version, token usage, latency, and fallback reason.

### 9.4 Lifecycle and checkpoints

Implement ordered hooks for invocation start, context assembly, model/tool calls, artifact production, escalation, failure, and completion. Hook failures are classified as enforcement, observability, or optional. Enforcement hook failures fail closed. Checkpoint only serializable control state and artifact references; never checkpoint raw secrets or live SDK objects.

### 9.5 Report validation

The report pipeline performs:

1. structured-output parse;
2. schema validation;
3. invocation, agent type, tier, and time consistency;
4. artifact existence, tenant, hash, and lineage checks;
5. child invocation relationship checks;
6. decision authority checks;
7. metric and cost reconciliation;
8. state assertion verification;
9. acceptance-policy evaluation;
10. output repair only when repair does not alter domain meaning;
11. failure when any mandatory check cannot be proven.

An agent's prose is never a committed report.

### 9.6 Cline adapter

Only `packages/cline-adapter` imports the Cline SDK. Provide an internal interface with `start`, `send`, `streamEvents`, `cancel`, and `dispose`. Translate SDK events into internal model, tool, message, and lifecycle events. Pin the SDK version and add contract fixtures for event translation, cancellation, structured output, tool registration, token usage, and error mapping.

The adapter must not grant tools directly. Cline tool callbacks call the platform tool broker. SDK API changes are handled by adapter compatibility tests and do not change domain packages.

### 9.7 Invocation hierarchy enforcement

The invocation service validates registry tier, parent tier, permitted child type, authority, budget, and plan membership before creation. Database constraints or triggers prevent invalid relationships. Tests must explicitly deny Tier 0→Tier 2, Tier 1→Tier 1, Tier 2→any, and unregistered agent types.

---

## 10. Tier 0 Orchestrator

### 10.1 Responsibility

Tier 0 owns intent interpretation, plan construction, specialist routing, dependency management, budget/deadline coordination, approvals, conflict resolution, aggregation, and user status. It receives no shell, filesystem write, compute allocation, credential, connector publication, or model promotion tools.

### 10.2 Implementation modules

```text
packages/orchestrator/src/
  harness.ts
  prompt-policy.ts
  context-policy.ts
  planner.ts
  plan-schema.ts
  plan-validator.ts
  dependency-evaluator.ts
  cost-estimator.ts
  approval-planner.ts
  scheduler.ts
  aggregator.ts
  conflict-resolver.ts
  completion-evaluator.ts
  user-status.ts
```

### 10.3 Plan validator

Reject plans when:

- a specialist is missing, disabled, deprecated without opt-in, or incompatible;
- a step asks a specialist for an unowned decision;
- dependencies contain a cycle or unsatisfiable condition;
- expected artifact types are not producible;
- authority or budget exceeds the workflow envelope;
- Tier 0 attempts to target Tier 2;
- required Governance, FinOps, Cluster, Eval, or Deployment boundary is bypassed;
- completion criteria are unmeasurable;
- an approval requirement lacks an exact action template.

### 10.4 Aggregation rules

Tier 0 verifies expected artifacts, report validity, dependency satisfaction, approval freshness, budget, and conflicting state assertions. It may schedule, replan, block, request approval, cancel, or complete. It must not reinterpret a Tier 1 decision as an implementation detail or silently merge conflicting artifacts.

### 10.5 Orchestrator evaluation fixtures

Include at least:

- simple sequential data validation;
- parallel independent specialist work;
- fine-tuning under a hard budget;
- missing specialist;
- cyclic plan;
- stale human-edited artifact;
- rejected approval;
- incompatible Data and Governance decisions;
- cost increase requiring new approval;
- cancellation during child execution;
- malicious external content requesting tools;
- deterministic task incorrectly routed to an LLM.

---

## 11. Tier 1 Specialist Packages

Every specialist package implements the shared shell and provides identity, input/decision schemas, context assembly, task planning, task-report evaluation, commit behavior, consultations, acceptance criteria, and failure taxonomy.

### 11.1 Data Engineer

Owns ingestion strategy, cleaning, canonical schema, split method, deduplication, leakage decision, and readiness. Tier 2 children include profiling, ingestion code, schema validation, deduplication, split generation, leakage detection, and transformation code. Completion requires immutable split hashes, provenance, governance constraints, quality threshold results, and a `ValidatedDataset` artifact.

### 11.2 Data Quality and Observability

Owns monitor definitions, thresholds, drift severity, incident creation, and suspension recommendation. Implement scheduled and event-triggered entry points. Results are observations and incident artifacts, not direct changes to dependent systems.

### 11.3 ML Engineer

Owns base model choice, tuning method, hyperparameters, objective, checkpoint and early-stop strategy, and technical viability for evaluation. It may launch training only with a current Cluster allocation and budget reservation. It cannot alter the immutable evaluation set, approve evaluation, or promote a model.

### 11.4 Cluster and Infrastructure

The sole compute allocator. Implement offer generation separately from allocation. Offers expire and include backend, resource shape, duration, cost, locality, constraints, and evidence. Automatic retries are limited to infrastructure classifications; user code, policy, and budget failures return to the responsible tier.

### 11.5 MLOps and Experiment Management

Owns reproducibility, lineage completeness, checkpoint registration, registry-stage transitions, retention, and rollback target selection. A registered checkpoint must link to run, configuration, source revision, environment/container digest, validated dataset version, and original lineage.

### 11.6 Eval

Owns benchmark selection, sample sufficiency, statistical comparison, regression classification, validity, and promotion recommendation. Inputs are immutable. Benchmark definitions and thresholds cannot change after results are seen. Threshold changes create approved policy artifacts.

### 11.7 Deployment and Serving

Owns endpoint topology, rollout, autoscaling bounds, health criteria, traffic changes, and rollback. Only this specialist may request serving traffic effects. Every rollout has an approved model, evaluation, serving policy, target, rollback target, health windows, and automatic rollback thresholds.

### 11.8 Connector and Platform Engineering

Owns connector architecture, auth interpretation, tool schema, sandbox readiness, scopes, and publication recommendation. It receives only public docs, mock credentials, or approved sandbox handles. A deterministic registry service publishes after scans, contract tests, Governance review, and mandatory human approval.

### 11.9 Governance and Security

Owns data access, PII classification, connector scope, secret-use policy, retention, and compliance results. Cross-specialist checks use typed consultations through the control plane; specialists do not spawn Governance directly.

### 11.10 FinOps and Cost

Owns attribution, reservations, alerts, anomalies, reconciliation, and spend permission. The package contains deterministic ledger operations plus a specialist for domain judgment. Only deterministic ledger services change balances.

### 11.11 Specialist definition checklist

No specialist is registered until all fields are complete:

- owned and prohibited decisions;
- input/output schemas and artifact types;
- permitted Tier 2 task types;
- read/write authority and resource selectors;
- consequential action boundary;
- required consultations;
- approval conditions;
- acceptance policy;
- failure classifications and retry behavior;
- evaluation dataset and release threshold;
- owner team, risk class, version, rollout, and rollback.

---

## 12. Tier 2 Harnesses and Sandboxes

### 12.1 Coding harness

Create invocation-specific worktrees or containers. Inputs specify repository, base revision, allowed paths, mounted artifact references, required tests, prohibited operations, network policy, deadline, and output limit. Completion publishes a patch or commit artifact with diff, test results, dependency changes, and source revision.

Mandatory checks:

- all writes remain within allowed paths;
- repository base revision matches input;
- no secrets or forbidden files are added;
- dependency additions satisfy policy;
- required tests pass;
- produced diff is nonempty when change is required;
- sandbox cleanup occurs after artifact publication.

### 12.2 Plugin-backed harness

Use for bounded tool operations requiring limited interpretation. Define an allowlist of one or two plugins, structured output, maximum tool calls, maximum model turns, and deny-by-default policy. It may not create children or change scope.

### 12.3 Deterministic worker

Use for validation, hashing, statistics, copying, aggregation, and notifications. The task has input/output schemas, pure or bounded execution, and a separate verifier. It emits the normalized report envelope without using a model.

### 12.4 Sandbox baseline

- isolated filesystem and process namespace;
- non-root user;
- CPU, memory, GPU, process, time, and output quotas;
- network deny by default with destination allowlist;
- read-only input mounts where possible;
- ephemeral capability handles;
- no host socket or cloud metadata access;
- structured stdout/stderr capture with truncation and secret redaction;
- immutable base image digest;
- software bill of materials and vulnerability policy;
- teardown and orphan reconciliation.

---

## 13. Backend Adapter Contracts

Define ports first, contract tests second, implementations third.

### 13.1 Compute backend

Operations: inspect capacity, estimate offers, allocate from approved grant, submit job, observe job, terminate job, and release allocation. All mutating calls take an idempotency key. Observations include monotonic sequence, backend native ID, normalized state, resources, timestamps, metrics, and raw evidence reference.

Implement in order:

1. fake adapter for tests;
2. local CPU/GPU adapter;
3. Kubernetes adapter;
4. SLURM adapter only after explicit approval.

### 13.2 Experiment backend

Operations: create run, log metric, log artifact, register checkpoint, finalize run, and resolve run. Implement local filesystem/SQLite first, then MLflow; add W&B only through a separate adapter.

### 13.3 Catalog backend

Operations: resolve dataset, read schema, create version intent, publish approved version, read lineage, and mark lifecycle state. Provide local catalog first.

### 13.4 Secret broker

Operations: request handle, execute capability, rotate/revoke handle, and audit usage. The broker never returns secret plaintext to callers. Local development may use OS keychain or environment-backed handles, but test logs must prove redaction.

### 13.5 Serving backend

Operations: provision revision, smoke test, set weighted traffic, observe health, rollback, and deprovision. Mutations require Deployment authority and an approval digest.

### 13.6 Adapter contract suite

Every adapter implementation must pass the same tests for idempotency, timeout, cancellation, error mapping, observation ordering, tenant isolation, authorization, metrics, and cleanup. Provider-specific behavior remains behind normalized errors and evidence artifacts.

---

## 14. API and Subscription Surface

### 14.1 Command endpoints

```text
POST /v1/commands
POST /v1/workflows/{workflowId}/cancel
POST /v1/workflows/{workflowId}/pause
POST /v1/workflows/{workflowId}/resume
POST /v1/approvals/{approvalId}/decisions
POST /v1/artifacts/{artifactId}/versions
```

All mutating calls require authentication, tenant/workspace scope, `Idempotency-Key`, and expected version when updating an aggregate.

### 14.2 Query endpoints

```text
GET /v1/workflows/{workflowId}
GET /v1/workflows/{workflowId}/plan
GET /v1/invocations/{invocationId}
GET /v1/artifacts/{artifactId}/versions/{version}
GET /v1/projections/jobs
GET /v1/projections/compute
GET /v1/projections/cost
GET /v1/projections/approvals
GET /v1/audit
```

Use cursor pagination. Large logs and objects are streamed from bounded endpoints or pre-signed read handles after authorization.

### 14.3 Live updates

- WebSocket for chat/session control and bidirectional interaction.
- SSE for panel subscriptions and read-only event feeds.
- Every event includes a workspace cursor.
- Reconnect supplies `afterCursor`; the server replays missed projection events.
- If the cursor is outside retention or projection version changed, return a reset signal and fetch a fresh snapshot.
- Polling is only a degradation fallback.

### 14.4 API acceptance criteria

- OpenAPI is generated from contract schemas.
- Authentication and tenant scope are tested on every route.
- Idempotency and version conflict behavior are consistent.
- Subscription reconnect produces no gaps; duplicates are harmless.
- Backpressure and slow consumers do not block the control plane.
- Error responses never expose stack traces or secrets.

---

## 15. Implementation Phases and Work Packages

## Phase 0 — Bootstrap and Architectural Decisions

**Goal:** Establish a reproducible repository and resolve choices that affect every subsequent phase.

### WP0.1 Repository bootstrap

- Initialize Git, `.editorconfig`, `.gitattributes`, ignore rules, license choice placeholder, ownership, and contribution guide.
- Create pnpm workspace and task runner configuration.
- Configure TypeScript strict mode, ESLint, formatter, unit test runner, package boundary checks, and commit-independent build commands.
- Add `docs/adr/README.md` and ADR template.
- Add environment schema validation; no package may read environment variables directly outside `packages/config`.

### WP0.2 Local dependencies

- Add Docker Compose for PostgreSQL, NATS JetStream, MinIO, OPA, and Temporal development services.
- Pin images by version or digest.
- Provide health checks and non-default development credentials through an uncommitted environment file.
- Add `scripts/dev-up`, `dev-down`, `dev-reset`, and `dev-health` as safe package scripts; destructive reset must require explicit confirmation.

### WP0.3 CI baseline

- Install with frozen lockfile.
- Run format check, lint, typecheck, unit tests, dependency-boundary audit, secret scan, schema drift, and build.
- Cache dependencies without caching generated secrets or test databases.
- Upload test reports and coverage.

### WP0.4 Compatibility spikes

- Prove Cline SDK startup, tool callback, structured output, event stream, cancellation, and teardown behind a temporary adapter test.
- Prove Temporal TypeScript workflow/activity separation and replay constraints.
- Prove PostgreSQL outbox publisher to JetStream with duplicate delivery.
- Prove OPA decision input/output and signed or versioned bundle loading.

**Exit gate:** ADR-0001 through ADR-0010 approved; one-command local health check passes; CI is green; dependency and container versions are pinned; no product workflow code exists yet.

## Phase 1 — Runtime Contracts

### WP1.1 Foundational primitives

Implement typed IDs, actors, tenant/workspace scope, timestamps, money, hashes, resource selectors, stable errors, and schema versioning.

### WP1.2 Aggregate contracts

Implement command, workflow, plan, invocation, report, artifact, event, approval, budget, authority, agent registration, and projection schemas.

### WP1.3 State machines and compatibility

Implement pure transition functions, valid/invalid fixtures, JSON Schema generation, OpenAPI components, compatibility checker, and schema catalog documentation.

### WP1.4 Invariant testkit

Create reusable invariant assertions, fake clock, deterministic IDs, actor/tenant fixtures, fake adapters, and report/artifact builders.

**Exit gate:** contracts build without infrastructure; all state edges tested; generated schemas are deterministic; no breaking contract drift; the 20 invariant tests exist even if later phases initially skip infrastructure-dependent cases.

## Phase 2 — State, Events, Artifacts, and Projections

### WP2.1 Database and repositories

Create migrations and typed repositories. All aggregate updates use optimistic concurrency and transactions. Add PostgreSQL and SQLite contract suites.

### WP2.2 Command service and event log

Implement command idempotency, aggregate version checks, event append, audit append, and outbox write in one transaction.

### WP2.3 Artifact registry

Implement upload intent, staging, hash verification, schema validation, lineage, immutable publication, version conflicts, human precedence, and lifecycle invalidation.

### WP2.4 Outbox and event distribution

Implement leasing, retry, dead-letter state, JetStream publishing, consumer deduplication, and monitoring. Do not delete authoritative events after publication.

### WP2.5 Projections

Implement workflow, job, compute, artifact, cost, approval, and audit projections plus rebuild and cursor APIs.

**Exit gate:** duplicate and concurrent command tests pass; artifact hash and lineage checks pass; forced outbox duplicate is harmless; full projection replay matches live projection; PostgreSQL and SQLite expose compatible behavior.

## Phase 3 — Policy, Authority, Approval, Budget, and Audit

### WP3.1 Identity and authority

Implement development identity, authentication port, tenant membership, signed/server-side authority envelopes, resource selectors, expiry, and revocation.

### WP3.2 Policy engine

Implement OPA adapter, policy input schemas, bundle versioning, decision caching rules, and fail-closed behavior. Provide policies for tier invocation, tool operations, data classification, connector scope, spend, model promotion, and deployment.

### WP3.3 Approval service

Implement action digest, approver policy, expiry, decision history, invalidation, revocation, and APIs.

### WP3.4 FinOps ledger

Implement budget accounts, reservation transaction, usage observation, reconciliation, expiry, cost categories, and threshold events.

### WP3.5 Tool broker and audit

Implement broker pipeline, credential-handle port, output redaction, consequential action classification, and audit completeness checker.

**Exit gate:** deny-by-default integration suite passes; budget cannot overrun under concurrency; approval mutation invalidates; commit-time reauthorization works; secret canary values are absent from all captured outputs.

## Phase 4 — Harness Core and Invocation Enforcement

### WP4.1 Harness factory and lifecycle

Implement definitions, factory, runtime services, hooks, context blocks, model router port, retry/acceptance policies, cancellation, and checkpoints.

### WP4.2 Cline runtime adapter

Replace the Phase 0 spike with production adapter, event translation, error mapping, cancellation, tool-broker callback, and contract tests.

### WP4.3 Report validator

Implement structured parse, schema, artifact, child, decision, state, cost, and acceptance checks.

### WP4.4 Invocation service and agent registry

Implement registry versions, status, compatibility, permitted children, tier enforcement, rollout, disable, and exact harness-version recording.

### WP4.5 Tier 2 base harnesses

Implement deterministic, plugin-backed, and coding harness shells with sandbox and acceptance contracts.

**Exit gate:** all valid hierarchy paths succeed and invalid paths fail; malformed or fabricated reports are rejected; disabled harnesses cannot start; Cline SDK is imported only by the adapter package; deterministic tasks execute without an LLM.

### Phase 4 completion record

The repository now provides exact registry compatibility/version checks, mechanical invocation
enforcement in the persistence transaction, three Tier 2 base harness shells, validated model/tool
interception, fail-closed critical hooks, authoritative report verification, and Cline adapter
compatibility/cancellation coverage. Focused evidence is mapped in
`docs/contracts/spyderbyte-p4-capability-matrix.md`.

## Phase 5 — Local Vertical Slice

**Target:** `Dataset → Governance check → validation → training strategy/config → local smoke run → normalized report`.

### WP5.1 Tier 0 minimum orchestrator

Implement plan schema, deterministic plan validator, specialist routing, dependency scheduling, aggregation, and user status. Use constrained fixtures before enabling model-generated planning.

### WP5.2 Governance minimum specialist

Implement local policy decision, PII scan task interface, and retention constraints sufficient for the sample workflow.

### WP5.3 Data Engineer specialist

Implement local source resolution, profiling, schema validation, deduplication, leakage detection, split generation, and `ValidatedDataset` publication.

### WP5.4 ML Engineer specialist

Implement training strategy and configuration artifacts, coding task for a minimal trainer, config validation, and a bounded smoke run.

### WP5.5 Local Cluster specialist

Inspect CPU/GPU, estimate a zero or configured local cost, issue an expiring offer, allocate a process/container quota, and observe the job.

### WP5.6 End-to-end scenario

Seed a synthetic non-sensitive dataset and deterministic model stub. Submit `CreateModelCandidate`, observe events/projections, complete the smoke run, and verify artifacts, reports, lineage, cost, and audit.

**Exit gate:** a clean checkout can start dependencies and complete the scenario with one documented command; replay produces the same final projection; no cloud account or production secret is required; injected failures produce owned, typed failures.

## Phase 6 — Durable Execution and Real-Time Recovery

### WP6.1 Workflow backend

Implement Temporal workflows for command-to-plan, step scheduling, approvals, signals, cancellation, timeouts, and completion. Keep model and tool calls in activities. Workflow code must remain deterministic.

### WP6.2 Recovery and retry

Implement retry budgets, fresh-context rules, heartbeats, attempt records, dead-letter workflows, and manual recovery commands.

### WP6.3 Cancellation and compensation

Propagate cancellation from workflow to invocation, sandbox, job, reservation, and upload. Add compensation for allocation release, staged artifact cleanup, and traffic rollback when applicable.

### WP6.4 Streaming and reconnect

Implement WebSocket session events, SSE projections, cursor replay, reset behavior, bounded buffers, and slow-consumer handling.

### WP6.5 Chaos verification

Kill API, worker, database connection, NATS connection, and sandbox process at controlled points. Verify resume, no duplicate durable effect, cost reconciliation, and complete audit.

**Exit gate:** workflows survive worker/API restart; approvals may wait across restarts; cancellation is bounded; reconnect has no logical gaps; chaos suite passes with documented recovery times.

## Phase 7 — Hosted Resource Plane

### WP7.1 Hosted infrastructure baseline

Provision PostgreSQL, object storage, NATS, Temporal, OPA, identity integration, secret broker, and worker namespaces through infrastructure as code.

### WP7.2 Kubernetes compute adapter

Implement capacity, offers, approved allocation, job submission, observation, termination, cleanup, data locality, quotas, and normalized failures.

### WP7.3 Distributed workers and sandboxes

Separate worker pools by tier, task risk, and resource class. Apply service accounts, network policy, pod security, quotas, image allowlists, and ephemeral storage limits.

### WP7.4 Hosted artifact and event scale

Add multipart upload, lifecycle policies, encryption keys, replication choice, projection scaling, outbox lag monitoring, and backpressure.

### WP7.5 FinOps hosted reconciliation

Reconcile scheduler observations and provider billing exports; alert on drift between estimates, reservations, and actuals.

**Exit gate:** hosted execution passes adapter contracts, tenant isolation tests, secret canary tests, workload escape tests, failover tests, and cost reconciliation within defined tolerance.

## Phase 8 — Model Lifecycle

### WP8.1 Experiment and MLOps

Implement run creation, metrics, environment snapshots, checkpoint validation, lineage graph, model version registration, retention, and rollback target selection.

### WP8.2 Independent Eval

Implement immutable evaluation inputs, benchmark runner, metrics, significance, qualitative samples, regression classification, limitations, and promotion recommendation.

### WP8.3 Model registry publication

Implement deterministic publication service that validates lineage, evaluation, approval, policy, artifact hashes, and exact model version.

### WP8.4 Deployment and Serving

Implement endpoint provision, smoke test, traffic weights, observation windows, ramp, automated rollback, and deployment state machine.

### WP8.5 Full candidate workflow

Execute the reference fine-tuning scenario with hard budget, approval threshold, OOM recovery, evaluation, 10% internal canary, and rollback injection.

**Exit gate:** a model cannot publish without complete lineage and independent evaluation; only Deployment changes traffic; approval is invalidated by target/version/cost change; rollback completes within the agreed SLO.

## Phase 9 — Governance and Connectors

### WP9.1 Governance consultations

Implement typed consultation requests, policy artifacts, evidence, expiry, re-evaluation, and blocked-state propagation.

### WP9.2 Connector development sandbox

Implement documentation ingestion as untrusted content, schema generation, restricted coding harness, mock/sandbox credentials, contract tests, dependency scan, and package build.

### WP9.3 Connector scope and publication

Governance reviews scopes; human approval is mandatory; deterministic registry service verifies digest and publishes. Add revocation, deprecation, and rollback.

### WP9.4 Prompt-injection and exfiltration tests

Seed malicious docs, API responses, source files, and datasets. Verify they cannot expand scope, obtain credentials, redirect network access, change policies, or suppress audit.

**Exit gate:** no connector reaches registry without scans, tests, Governance decision, and exact human approval; production secret values never reach model context; revocation blocks new calls promptly.

## Phase 10 — Product Shell

### WP10.1 Application frame and authentication

Build workspace routing, identity, tenant selection, session recovery, accessibility baseline, and global error handling.

### WP10.2 Projection panels

Build chat, workflows, jobs, compute, catalog, models, connectors, governance, approvals, costs, repositories, and audit panels strictly from projection APIs.

### WP10.3 Commands and human edits

Implement schema-driven forms, expected-version edits, conflict UI, human ownership indicators, stale descendant warnings, approval review, and cancellation.

### WP10.4 Live run experience

Show plan, dependencies, invocation tree, current states, streaming logs, costs, artifacts, decisions, failures, and approval gates. Do not imply completion until report and artifact validation finish.

### WP10.5 UI test suite

Test reconnect, duplicate events, stale cursor reset, optimistic conflicts, rejected approvals, cancellation, inaccessible actions, keyboard navigation, screen readers, and large log virtualization.

**Exit gate:** panels display the same state as APIs; no business policy exists in UI code; reconnect and conflict flows pass; consequential actions communicate exact scope, version, target, and cost.

## Phase 11 — Production Hardening and Launch

### WP11.1 Threat model and security review

Cover tenant isolation, confused deputy, prompt injection, credential exfiltration, artifact poisoning, supply chain, sandbox escape, approval replay, budget race, event forgery, and audit tampering.

### WP11.2 Reliability and disaster recovery

Define backups, point-in-time recovery, object recovery, event replay, key rotation, restore drills, region failure posture, and recovery objectives.

### WP11.3 Performance and capacity

Load test command intake, projection updates, event fan-out, workflow scheduling, artifact upload, concurrent sandboxes, and log streaming. Publish capacity model and scaling thresholds.

### WP11.4 Operations

Create runbooks for stuck workflow, outbox lag, projection rebuild, policy outage, Temporal backlog, NATS outage, cost anomaly, leaked credential suspicion, sandbox orphan, failed rollout, and tenant export/deletion.

### WP11.5 Release governance

Require schema compatibility, migration rehearsal, harness evaluation thresholds, policy review for new capabilities, canary release, rollback, and post-release observation.

**Exit gate:** security sign-off, operational ownership, tested restore, SLO dashboards, paging, capacity headroom, release/rollback rehearsal, and launch checklist approval.

---

## 16. Testing and Verification Strategy

### 16.1 Test layers

| Layer | Purpose | Required examples |
|---|---|---|
| Unit | Pure schemas, state machines, digests, selectors, cost math | All transition edges and canonicalization |
| Contract | Every port against every adapter | PostgreSQL/SQLite, local/Kubernetes, local/MLflow |
| Integration | Multiple real services | command transaction, outbox, policy, approval, artifact publish |
| End-to-end | User objective through projection | local vertical slice, candidate-to-canary |
| Invariant | Security and hierarchy | all 20 fixed invariants |
| Evaluation | Agent judgment and task behavior | tier-specific curated fixtures |
| Chaos | Recovery and duplication | worker crash, network loss, redelivery, timeout |
| Security | Abuse and isolation | prompt injection, scope bypass, secret canaries, sandbox escape |
| Performance | SLO and capacity | intake, events, projections, logs, workers |

### 16.2 Required CI commands

Define stable root commands by Phase 1:

```text
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:contracts
pnpm test:invariants
pnpm schema:generate
pnpm schema:check
pnpm deps:check
pnpm build
```

Integration, end-to-end, evaluation, security, and chaos suites may run in separate CI jobs but are mandatory before their phase gate.

### 16.3 Test data

- Use synthetic or explicitly approved data.
- Label every fixture with classification and allowed purpose.
- Never copy production secrets, customer conversations, model outputs, or datasets into tests.
- Freeze critical evaluation fixtures and hash them.
- Keep adversarial prompt-injection fixtures isolated and clearly marked as untrusted.

### 16.4 Definition of done for any implementation change

- Acceptance criteria are demonstrably met.
- Tests cover success, denial, failure, idempotency, and retry where applicable.
- Public schema and migration impact are documented.
- Observability exists for the new behavior.
- Threat model and data classification are updated when behavior changes.
- No invariant is weakened.
- Rollback or disable path exists.
- Documentation and progress ledger are current.

---

## 17. Observability, SLOs, and Operations

### 17.1 Correlation model

Every trace, structured log, metric, event, and report carries available `tenantId`, `workspaceId`, `workflowId`, `invocationId`, `commandId`, `correlationId`, `causationId`, `agentType`, `harnessVersion`, and `attempt`. High-cardinality identifiers belong in traces/logs, not unbounded metric labels.

### 17.2 Minimum metrics

- command rate, latency, failure, idempotent replay, and version conflict;
- active workflows by state and age;
- plan/replan count and approval wait time;
- invocation queue, duration, attempts, failure owner, and cancellation latency;
- model calls, tokens, cost, latency, fallback, structured-output repair;
- tool calls by decision, duration, denial, and approval;
- budget consumed/reserved and reconciliation drift;
- outbox lag, publication retries, consumer redelivery, and projection lag;
- artifact publication latency, bytes, scan failure, and hash failure;
- sandbox startup, resource use, timeout, orphan, and cleanup;
- compute offer accuracy, allocation latency, job state, and normalized failure;
- deployment health, traffic, rollback trigger, and rollback duration.

### 17.3 Initial SLO targets

Treat these as launch hypotheses to validate under load:

- 99.9% monthly availability for command/query API excluding planned maintenance.
- 99% of accepted commands durably recorded within 1 second.
- 99% of projection updates visible within 3 seconds of committed event.
- 99% of cancellation requests acknowledged within 2 seconds; resource termination has backend-specific SLO.
- Zero accepted cross-tenant access, unapproved production effect, or hard-budget overrun.
- 100% of consequential actions represented in audit completeness checks.
- 100% of published artifacts hash-verifiable and lineage-addressable.

Security invariants are correctness requirements, not percentage SLOs.

---

## 18. Security and Privacy Checklist

Before merging any capability that reads data or causes an effect, answer:

- What actor and tenant owns the action?
- What exact resource selectors are needed?
- What data classification enters model context?
- Can a deterministic worker replace the model?
- What untrusted content is present and how is it labeled?
- Which policy version decides?
- Is human approval required, and what exact digest is approved?
- How is credential use brokered without returning plaintext?
- What cost is reserved before execution?
- What audit evidence is emitted?
- What is the idempotency and retry behavior?
- What is the rollback or compensation path?
- How are outputs scanned, validated, redacted, and size-limited?
- How does tenant isolation hold at repository, storage, network, and worker layers?

Any unanswered item blocks production enablement.

---

## 19. Release and Migration Rules

### 19.1 Database changes

Use expand/migrate/contract. Deploy additive schema first, dual-read/write when necessary, backfill with resumable jobs, switch reads after verification, then remove old fields in a later release. Migrations must be forward-only in production; rollback uses application compatibility or a corrective migration.

### 19.2 Contract changes

- Additive compatible changes update the minor schema version.
- Breaking changes create a new endpoint/event/schema version.
- Readers tolerate only explicitly documented optional fields; they fail closed on security-critical unknowns.
- Keep upcasters deterministic and covered by golden fixtures.

### 19.3 Harness releases

Every harness release requires schema compatibility, evaluation suite, capability diff, policy review for expanded authority, canary registration, exact version capture, and rollback to the prior registration. In-flight invocations remain pinned to their recorded harness version unless a critical revocation cancels them.

### 19.4 Policy releases

OPA bundles are versioned, reviewed, signed or integrity-verified, tested against allow/deny fixtures, deployed to a canary, and observed. Decisions record the exact bundle version. Policy service failure defaults to deny for consequential actions.

---

## 20. Reference End-to-End Acceptance Scenario

The release-level scenario is:

> Fine-tune an approved base model using an approved customer-support-style synthetic dataset, stay below a $250 hard limit, and deploy to 10% of internal test traffic only if the candidate beats the baseline without increasing unsafe-response rate.

Expected flow:

1. API accepts an idempotent `CreateModelCandidate` command.
2. Tier 0 plans Governance, Data Engineer, ML Engineer, Cluster, MLOps, Eval, and Deployment steps.
3. Governance approves data with masking and retention constraints.
4. Data Engineer publishes immutable train/validation/test splits with hashes and leakage report.
5. ML Engineer selects LoRA candidates and publishes configurations plus source revision.
6. Cluster supplies expiring offers; FinOps reserves approved cost.
7. A deliberate OOM is classified; ML Engineer adjusts micro-batch while effective batch is preserved; Cluster confirms no larger allocation is needed.
8. MLOps registers checkpoint, run, environment, and complete lineage.
9. Eval independently runs fixed benchmarks and recommends promote only when thresholds pass.
10. Approval binds to exact model version, target, 10% traffic, and cost.
11. Deployment provisions, smoke-tests, shifts 10%, observes, and can automatically roll back.
12. Tier 0 reports artifacts, decisions, rollout, failures/retries, and reconciled cost from projections.

### 20.1 Failure injections

The same scenario must test:

- duplicate initial command;
- human training-config edit during execution;
- expired compute offer;
- budget increase over approval digest;
- worker crash after external effect but before acknowledgment;
- NATS duplicate delivery;
- invalid model report claiming a nonexistent artifact;
- malicious dataset text asking for credentials;
- evaluation regression;
- canary health failure and rollback;
- user cancellation during training.

No failure may create duplicate durable effects, untracked cost, invalid approval reuse, secret exposure, or inconsistent final projections.

---

## 21. Decision and Change Control

### 21.1 ADR template

Each ADR includes status, date, owners, context, decision, alternatives, consequences, security impact, operational impact, migration, rollback, and affected invariants/contracts.

### 21.2 Changes requiring explicit human approval

- weakening or changing any fixed invariant;
- enabling production data or credentials;
- adding a new consequential tool capability;
- changing tenant isolation or encryption design;
- altering approval scope or bypass behavior;
- increasing default budget or compute authority;
- enabling model or connector publication;
- enabling serving traffic changes;
- selecting a new hosted provider with data residency impact;
- destructive migration or irreversible data retention change.

### 21.3 Open decisions to resolve before their phase

- authentication/identity provider and enterprise federation requirements;
- supported cloud and Kubernetes distribution;
- object-storage region, retention, and customer-managed key requirements;
- model providers and data-processing restrictions;
- experiment tracker priority after local backend;
- production model-serving platform;
- catalog integration target;
- SLURM priority and environment;
- compliance frameworks and audit retention;
- single-region versus multi-region launch posture.

---

## 22. Official Implementation References

Use primary documentation during implementation and pin the exact behavior proven by tests:

- Temporal durable execution and TypeScript SDK: https://docs.temporal.io/
- NATS JetStream persistence, consumers, deduplication, and replay: https://docs.nats.io/nats-concepts/jetstream
- Open Policy Agent REST API and versioned bundles: https://www.openpolicyagent.org/docs/rest-api and https://www.openpolicyagent.org/docs/management-bundles
- Cline Agent/AgentRuntime API and SDK repository: https://docs.cline.bot/sdk/reference/agent and https://github.com/cline/cline

These references inform adapters; they do not override this platform's internal contracts or security boundaries.

---

## Appendix A — First Implementation Backlog

Create issues in this dependency order after Phase 0 approval:

1. `BOOT-001` Initialize monorepo and strict toolchain.
2. `BOOT-002` Add local dependency stack and health checks.
3. `BOOT-003` Add CI baseline and security scanning.
4. `SPIKE-001` Cline adapter compatibility proof.
5. `SPIKE-002` Temporal replay and signal proof.
6. `SPIKE-003` PostgreSQL outbox to JetStream proof.
7. `SPIKE-004` OPA bundle and decision proof.
8. `CONTRACT-001` IDs, actors, time, money, hashes.
9. `CONTRACT-002` command/workflow/plan schemas.
10. `CONTRACT-003` invocation/report schemas.
11. `CONTRACT-004` artifact/event schemas.
12. `CONTRACT-005` approval/budget/authority/resource schemas.
13. `CONTRACT-006` state machines and error catalog.
14. `CONTRACT-007` JSON Schema generation and compatibility check.
15. `TESTKIT-001` invariant fixtures and fake runtime services.
16. `STATE-001` database migrations and repository base.
17. `STATE-002` command idempotency and optimistic concurrency.
18. `STATE-003` event log, audit, and outbox transaction.
19. `ARTIFACT-001` local staging and content-addressed storage.
20. `ARTIFACT-002` immutable publication and lineage.
21. `EVENT-001` outbox publisher and consumer deduplication.
22. `PROJ-001` workflow and invocation projections.
23. `PROJ-002` artifacts, cost, approvals, audit projections.
24. `SEC-001` authority envelope and selector engine.
25. `SEC-002` OPA policy adapter and deny-by-default policies.
26. `APPROVAL-001` action digest and approval lifecycle.
27. `FINOPS-001` reservation and reconciliation ledger.
28. `TOOLS-001` tool broker and audit interceptor.
29. `HARNESS-001` definitions, factory, hooks, and context blocks.
30. `HARNESS-002` report validator.
31. `CLINE-001` production runtime adapter.
32. `AGENTREG-001` registry and tier enforcement.
33. `TASK-001` deterministic worker shell.
34. `TASK-002` coding sandbox shell.
35. `ORCH-001` plan validator and dependency evaluator.
36. `ORCH-002` scheduler, aggregator, and user status.
37. `GOV-001` minimum Governance specialist.
38. `DATA-001` minimum Data Engineer specialist.
39. `CLUSTER-001` local capacity and allocation specialist.
40. `ML-001` minimum ML Engineer specialist.
41. `E2E-001` local data-to-smoke-run scenario.

## Appendix B — Pull Request Checklist

- [ ] Work-package ID and acceptance criteria are linked.
- [ ] Package boundary and tier rules are preserved.
- [ ] Schemas and migrations are documented.
- [ ] Success, denial, failure, idempotency, and retry tests are included.
- [ ] Tenant scope is explicit.
- [ ] Authority, policy, approval, and budget checks occur at effect time.
- [ ] No secret plaintext can enter model context or telemetry.
- [ ] Consequential actions emit audit events.
- [ ] Observability and correlation are present.
- [ ] Rollback/disable path is documented.
- [ ] Relevant phase verification suite passes.
- [ ] `git diff --check` passes.
- [ ] Progress ledger and ADRs are updated when applicable.

## Appendix C — Stop Conditions for Codex

Codex must stop and ask for direction when:

- a required approval is absent or no approver policy exists;
- implementation would weaken a fixed invariant;
- credentials, production data, or external effects are newly required;
- repository state conflicts materially with the selected phase or ADR;
- a destructive migration or irreversible operation is required;
- security, privacy, residency, or compliance requirements are ambiguous;
- a dependency cannot satisfy the required contract without architectural change;
- tests reveal inconsistent authoritative state, duplicate effects, budget overrun, cross-tenant access, approval reuse, or secret exposure.

Ordinary implementation uncertainty is resolved through repository inspection, tests, a reversible default, and an ADR proposal—not by bypassing controls.
