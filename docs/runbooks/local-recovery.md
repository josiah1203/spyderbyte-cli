# Local recovery runbook

This runbook covers the deterministic local engine and worker replacement path.

1. Stop the worker process. Do not delete the SQLite database or artifact CAS directory.
2. Start a replacement `DurableWorker` against the same `StateStore`/SQLite file.
3. Query the workflow engine handle and inspect the persisted activity attempt and status.
4. Register the activity implementation for the pinned workflow definition version.
5. Call `resumeAfterRestart`; do not replay a completed activity. The activity ID and durable
   side-effect receipt are the deduplication boundary.
6. Verify the workflow projection cursor, terminal point read, and append-only audit chain.

For a cancellation, signal the workflow first, then terminate the sandbox gracefully and force
terminate after its bounded grace period. Reconcile the compute reservation and retain the failure
classification and cleanup evidence.
