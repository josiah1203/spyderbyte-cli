# Approval service outage

1. Fail closed for new approval-gated effects. Keep already waiting workflows durably waiting and
   do not treat timeout, missing data, or operator silence as approval.
2. Record outage start, affected approval IDs, action digests, expiry times, and tenant scope.
3. Restore the approval dependency, revalidate authority, action digest, revocation epoch, and
   expiry at commit time, then deliver typed signals.
4. Verify approved, rejected, expired, and revoked paths in the workflow projection and audit log.

Manual break-glass approval is not a local shortcut; it requires the separately approved process,
additional audit, and expiry.
