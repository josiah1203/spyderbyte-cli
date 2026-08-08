# State migrations

`0001_authoritative_state.sql` is deliberately limited to the SQL types shared by PostgreSQL and
SQLite. JSON payloads are text at this boundary; adapters parse and validate them through
`@agentic-platform/runtime-contracts` before accepting a write. Apply exactly one dialect guard
after the shared migration: `0001_append_only.postgres.sql` for PostgreSQL or
`0001_append_only.sqlite.sql` for SQLite. Artifact bytes are intentionally outside the database;
`artifact_content_objects` and `artifact_staged_uploads` hold CAS/object-key metadata so
publication and cleanup can be reconciled without storing large payloads in rows. The immutable
`artifact_versions` rows hold publication metadata, while `artifact_version_states` holds mutable
lifecycle status such as `stale` without rewriting a published version.

Apply `0002_projects.sql` after the shared schema. It adds the durable product project aggregate
point-read table; the append-only `project.*` events remain the projection source for UI views.

The transactional outbox includes additive `claimed_by` and `claim_expires_at` lease metadata.
PostgreSQL startup applies those columns idempotently through `applyPostgresMigrations`; SQLite
startup applies them through `ensureSqliteOutboxClaimColumns` so existing local databases can be
opened without a destructive reset.
