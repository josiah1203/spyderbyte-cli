# Phase 11 release and operations runbook

## Release preparation

1. Build the platform target on its native release runner.
2. Select `stable`, `beta`, or `nightly`; never publish a developer artifact to a public channel.
3. Create a platform manifest with `pnpm release:manifest <artifact> <manifest>` and the release
   signing key. The manifest binds version, channel, platform, architecture, target triple,
   installer, size, SHA-256, and artifact URL.
4. Verify the exact artifact with `pnpm release:manifest:verify <artifact> <manifest>` using the
   public key. A digest, target, channel, or signature mismatch is a hard failure.
5. Run the local contract, security, recovery, and capacity gates. Promote only with an approved
   release-gate record; failed checks keep the previous release active.

## Update and rollback

- The update service requires HTTPS, a matching platform/architecture/channel, a newer version,
  a SHA-256 artifact digest, and a valid Ed25519 metadata signature.
- Downloaded update bytes are written below `.agentic/updates` with mode `0600`; workspace data is
  never used as the update payload or replaced by an update.
- Installation is delegated to the signed desktop updater, which owns process restart and bundle
  replacement. Rollback is an explicit operation and must retain the previous workspace and
  release evidence.

## Incident and recovery

1. Preserve the correlation ID, release manifest digest, update channel, and workspace scope.
2. Generate `/v1/diagnostics/support-bundle`; inspect that secret-like values are redacted before
   sharing it.
3. Stop writes, verify the latest backup, preview the restore destination, and require the
   approval-bound restore action. Never overwrite the original workspace during first recovery.
4. Use the relevant runbook in this directory for provider, scheduler, projection, outbox, secret,
   artifact, or database failures.
5. Record recovery time, restored artifact digests, audit-chain verification, and operator approval.

## Clean-machine checklist

Installation, first launch, offline/local mode, provider choice, project creation, first successful
Run, artifact inspection, Jupyter handoff, quit/relaunch recovery, update/rollback, and uninstall
data preservation must be exercised on each supported release target. macOS additionally requires
Developer ID signing, hardened runtime, notarization, stapling, Gatekeeper assessment, and a
mounted-DMG smoke. The repository cannot claim those gates from a developer build or absent release
credentials.
