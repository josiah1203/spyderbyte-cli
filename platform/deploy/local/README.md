# Local deployment

The local-first application path uses the in-memory daemon, SQLite daemon, filesystem CAS, local
workflow worker, and framework-free API packages. A pinned optional dependency composition is also
checked in for compatibility and integration work:

- PostgreSQL 16 for relational-store compatibility;
- NATS JetStream for event-delivery compatibility;
- MinIO for S3-compatible artifact compatibility;
- OPA for policy bundle compatibility;
- Temporal auto-setup for workflow-boundary compatibility.

Start it with `pnpm dev:up`, inspect it with `pnpm dev:health`, and stop it with `pnpm dev:down`.
`pnpm dev:reset` removes volumes only after `SPYDERBYTE_CONFIRM_DEV_RESET=YES` is supplied.
The checked-in defaults are disposable development credentials from `.env.example`, not release
secrets.
