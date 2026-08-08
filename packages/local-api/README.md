# Local API transport

Reusable HTTP, session, pagination, rate-limit, and SSE transport for the Spyderbyte runtime.
The hosted API application re-exports this package so local daemon composition does not depend on
another application package.

The Spyderbyte workflow boundary exposes typed `POST /v1/commands/plan` and
`POST /v1/workflows/{workflowId}/run` routes. Planning persists the authoritative workflow in the
`planning` state; execution is a separate licensed operation so the frontend can render a review
step without owning orchestration policy. The local daemon configures the approval routes with a
workflow-scoped decision authority, so `/v1/approvals/{approvalId}/approve` or `reject` updates the
same action-digest-bound plan before `/v1/workflows/{workflowId}/run` can execute it. Workspace
metadata, checksummed archive export, restore preview, and non-overwriting import are exposed
through the `/v1/workspace` routes.
