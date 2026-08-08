# Runbooks

Operational runbooks cover the local worker, event, projection, outbox, artifact, budget,
approval, secret, scheduler, model, deployment, tenant-lifecycle, and database recovery paths.
Provider-specific commands, credentials, SLOs, and destructive retention actions remain dependent
on the hosted-resource and governance decision gates.

- [Stuck workflow](stuck-workflow.md)
- [Poison event](poison-event.md)
- [Projection rebuild](projection-rebuild.md)
- [Outbox backlog](outbox-backlog.md)
- [Artifact integrity failure](artifact-integrity-failure.md)
- [Budget reconciliation discrepancy](budget-reconciliation-discrepancy.md)
- [Approval service outage](approval-service-outage.md)
- [Secret broker outage](secret-broker-outage.md)
- [Scheduler outage](scheduler-outage.md)
- [Model provider outage](model-provider-outage.md)
- [Rollback failed](rollback-failed.md)
- [Tenant export/deletion](tenant-export-deletion.md)
- [Database restore](database-restore.md)
- [Event replay](event-replay.md)
- [Local recovery](local-recovery.md)
- [SQLite backup/restore](sqlite-backup-restore.md)
- [Phase 11 release and operations](phase11-release-operations.md)
