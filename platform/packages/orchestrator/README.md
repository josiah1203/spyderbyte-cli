# Orchestrator

`LocalDatasetWorkflowOrchestrator` implements the first deterministic `ValidateDataset` vertical
slice. Its public `plan` method persists an idempotent `workflow.planned.v1` plan without executing
specialists; `runPlanned` executes that reviewed workflow, while `submit` preserves the combined
compatibility path. When an `ApprovalService` is configured, the plan binds `workflow.execute` to
the exact artifact versions and root authority, transitions to `awaiting_approval`, and refuses
execution until a separate authorized human decision passes commit-time revalidation. It validates
source versions and registrations, creates authority-bound
Governance and Data Engineer invocations, publishes immutable
GovernanceDecision/DataQualityReport/ValidatedDataset artifacts, records workflow/invocation events,
detects source version conflicts, and handles cancellation and terminal aggregation. Specialist and
Tier 2 task code remains isolated in their respective packages. `LocalTrainingSliceOrchestrator`
connects ML Engineer strategy/config decisions to Cluster-gated local training and returns both
candidate runs with reconciled cost and checkpoint evidence. `LocalModelLifecycleOrchestrator`
composes that output through experiment logging, independent evaluation, structured lineage
publication, approval-bound canary traffic, automatic rollback, and a typed reconciliation report.
`LocalConnectorPublicationOrchestrator` composes deterministic connector build and scan output,
independent contract-test evidence, material-bound approval, and registry publication while
preserving author-versus-publisher separation.
