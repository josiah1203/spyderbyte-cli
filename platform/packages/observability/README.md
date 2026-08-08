# Observability

This package provides correlation contexts, structured secret redaction, tamper-evident append-only
audit chains, in-memory structured logs and trace spans, and telemetry summaries for local control-
and execution-plane tests. Logs and spans use the same redaction boundary as audit details, so local
diagnostics can preserve correlation, provider-request, latency, retry, cost, and failure fields
without persisting secret values.
Exported primitives are provider-neutral; production exporters and retention policy remain an
operations-phase integration. `runCapacityProbe`, `evaluateCapacity`, `summarizeSlo`, and
`evaluateSlo` provide deterministic release evidence while leaving target values to the approved
service-level and operations decision. `evaluateReleaseGate` adds the provider-neutral rollout
state machine: failed or incomplete checks hold the candidate, preserve the previous release for
rollback, and record an evidence digest; successful checks advance shadow, canary, limited, and
general stages. Hosted rollout and identity wiring remain operations work.
