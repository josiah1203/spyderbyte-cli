# Database restore and event replay

1. Declare the incident, stop writes, record the restore point, tenant scope, and backup digest.
2. Restore into an isolated database or new instance. Validate schema version, append-only guards,
   tenant constraints, aggregate versions, event stream continuity, outbox rows, and audit-chain
   hashes.
3. Rebuild projections from the restored event cursor and reconcile artifact CAS metadata and
   pending outbox delivery without duplicating committed commands.
4. Run point-read, tenant-isolation, workflow-recovery, and subscription replay checks. Obtain the
   approved cutover decision before directing traffic to the restore.
5. Keep the original database and evidence read-only until the incident is closed.

The local executable exercise is documented in [SQLite backup/restore](sqlite-backup-restore.md).
Hosted backup tooling, RPO/RTO, and cutover authority remain provider and operations gates.
