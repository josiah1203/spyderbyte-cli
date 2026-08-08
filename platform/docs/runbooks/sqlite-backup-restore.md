# Local SQLite backup and restore

This exercise proves that committed authoritative metadata, events, and outbox rows can be
recovered together. It is a local recovery procedure, not a substitute for hosted PostgreSQL
backups or an object-store durability exercise.

1. Stop command intake and drain the local worker. Do not copy a database while a transaction is
   active.
2. Close the SQLite database and copy the database file to a timestamped backup path. Record the
   source path, backup path, UTC timestamp, and SHA-256 digest.
3. Preserve the content-addressed artifact directory separately. Verify every referenced object
   hash while preparing the restore package.
4. Restore the database copy to a new path and start a replacement local daemon against that path.
5. Query the workflow point read, replay the tenant event stream, and inspect pending outbox rows.
6. Rebuild projections from the restored event cursor and verify the append-only audit chain.
7. Reconcile any pending outbox rows before reopening command intake. Never re-run a completed
   command without its original idempotency key.

The automated fixture is `packages/state/tests/sqlite-recovery.test.ts`; it writes a committed
workflow, event, and outbox row, copies the closed database, and verifies all three after restore.
