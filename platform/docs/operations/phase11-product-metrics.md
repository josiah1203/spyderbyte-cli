# Phase 11 product metrics

**Status:** Local metric vocabulary and consent boundary complete; production collection and
reporting remain host-owned.

Spyderbyte keeps product metrics behind `ConfigurableTelemetry` in
`packages/observability/src/index.ts`. Telemetry defaults to `disabled`. Product metrics are
accepted only when `includeProductMetrics` is enabled, and the local sink stores the same
correlation context used by Runs, projects, workspaces, and tenants. A remote mode is represented
for the owning host; authenticated export is deliberately outside the package boundary.

The Phase 11 vocabulary is stable and typed:

- Acquisition and activation: `install.download`, `run.first_success`, `project.created`.
- Individual and shared usage: `weekly_active_individual`, `runs.per_user`, `artifact.reused`,
  `run.success`, `organization.created`, `shared_project.adoption`.
- Commercial: `managed.conversion`, `revenue.arr`, `revenue.usage`, `margin.compression`.
- Reliability and governance: `provider_runtime.failure`, `approval.bypass`, `artifact.loss`,
  `run.unrecoverable`, `queue.latency`.

The contract intentionally carries numeric values, timestamps, correlation context, and optional
string labels, while leaving aggregation windows, revenue attribution, retention, and remote
transport to the product, finance, and operations owners in the host environment.
