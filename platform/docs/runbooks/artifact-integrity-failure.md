# Artifact integrity failure

1. Quarantine the affected artifact reference and stop downstream publication or deployment.
2. Recompute the content digest from the object store and compare it with the immutable reference,
   CAS metadata, media type, and size.
3. Inspect lineage and audit events. Do not mutate an immutable artifact-version row.
4. Restore the object from a verified backup or republish a new version through the registry with
   a recorded reason. Mark dependent projections stale where required.
5. Re-run integrity, lineage, and policy checks before allowing downstream use.

If no verified copy exists, preserve the evidence and escalate to the hosted backup/restore gate.
