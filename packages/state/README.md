# State

The package defines tenant-scoped repository ports, an authoritative SQL schema, and atomic
in-memory, SQLite, and PostgreSQL implementations. The shared state contract suite covers the
local adapters and is wired for PostgreSQL integration execution.
Transactions clone their draft state or use a database transaction, so aggregate writes, domain
events, outbox rows, command deduplication, checkpoints, artifact metadata, and side-effect
receipts commit together.

The hosted PostgreSQL adapter must implement the same ports against
`migrations/0001_authoritative_state.sql` and `migrations/0002_projects.sql`. PostgreSQL callers should apply the
shared schema and dialect guard through `applyPostgresMigrations`, which uses a
transaction-scoped advisory lock so concurrent workers or deploy processes do
not race during catalog creation.

`SqliteStateStore` accepts a Node 22.14+ `DatabaseSync` connection after the shared migration and
SQLite append-only guard have been applied. This keeps local metadata on the same SQL schema and
contract surface as hosted mode.

`TenantLifecycleService` adds a provider-neutral retention/deletion protocol: it inventories a
tenant under an explicit policy version, blocks legal holds, requires independent human approval,
executes bounded tenant-scoped batches, resumes from cursors, and records a completion tombstone.
The deletion port is injected so local fixtures and hosted repositories share the same safety
checks without silently choosing retention or residency policy values.
