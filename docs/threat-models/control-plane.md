# Control-plane threat model (local and hosted contracts)

| Threat                                 | Mitigation                                                                                            | Verification                                        |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Cross-tenant reference or subscription | Tenant/workspace keys on state, artifact, event, and subscription reads                               | Repository and subscription contract tests          |
| Tool or compute escalation             | Invocation-bound authority, Cluster-only allocation, commit-time approval/digest checks               | Policy, broker, backend, and lifecycle tests        |
| Secret exfiltration                    | Short-lived handles, operation binding, redaction before audit/log output, no handle value in reports | Secret broker and observability tests               |
| Approval replay/TOCTOU                 | Canonical action digest, expiration/revocation, commit-time revalidation                              | Approval race tests and lifecycle publication tests |
| Malicious generated code               | Invocation sandbox, path checks, output/deadline/process limits, required scans                       | Sandbox and connector fixture tests                 |
| Event forgery/replay                   | Contract validation, aggregate versions, outbox deduplication, audit hash chain                       | Dispatcher, transport, and audit tests              |
| Worker loss or duplicate activity      | Durable engine state, activity IDs, attempt records, replacement-worker recovery                      | Worker and engine restart tests                     |
| Artifact mutation                      | Content-addressed immutable objects and versioned publication with expected parent version            | Artifact registry and edit-conflict tests           |

Residual risks requiring a hosted review include kernel/container isolation strength, production
secret-manager configuration, scheduler credentials, and backup/restore procedures.
