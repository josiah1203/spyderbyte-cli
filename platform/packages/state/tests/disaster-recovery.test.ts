import { describe, expect, it } from 'vitest';
import { newSortableId, type TenantRef } from '@agentic-platform/runtime-contracts';
import { InMemoryDisasterRecoveryService, type RetentionPolicyV1 } from '../src/index.js';

const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
const now = '2026-08-06T00:00:00.000Z';

describe('disaster recovery and retention evidence', () => {
  it('verifies a backup, previews a non-overwriting restore, and records an exercise', () => {
    const service = new InMemoryDisasterRecoveryService({ clock: () => now });
    const backup = service.createBackup({
      tenant,
      snapshot: {
        schemaVersion: 1,
        workflows: [{ id: newSortableId(), state: 'completed' }],
        eventCursor: 10,
      },
      schemaVersion: 'state.v1',
      eventCursor: 10,
      artifactDigests: ['a'.repeat(64) as `${string}`],
      encryptionKeyId: 'kms-key-1',
      retentionUntil: '2026-09-06T00:00:00.000Z',
      now,
    });
    expect(service.verify(tenant, backup.manifest.backupId, now).state).toBe('verified');
    const targetTenant = { tenantId: tenant.tenantId, workspaceId: newSortableId() };
    const preview = service.previewRestore({
      tenant,
      backupId: backup.manifest.backupId,
      targetTenant,
      now,
    });
    expect(preview).toMatchObject({ safe: true, targetTenant });
    const evidence = service.restore({
      tenant,
      backupId: backup.manifest.backupId,
      targetTenant,
      approvalDigest: backup.manifest.contentDigest,
      now,
    });
    expect(evidence).toMatchObject({ restored: true, idempotent: false, targetTenant });
    const exercise = service.runExercise({ tenant, backupId: backup.manifest.backupId, now });
    expect(exercise.verified).toBe(true);
    expect(exercise.evidence.evidenceDigest).toHaveLength(64);
  });

  it('blocks secret-shaped backup content and honors legal hold retention', () => {
    const service = new InMemoryDisasterRecoveryService({ clock: () => now });
    expect(() =>
      service.createBackup({
        tenant,
        snapshot: { apiKey: 'must-not-be-backed-up' },
        schemaVersion: 'state.v1',
        eventCursor: 1,
        encryptionKeyId: 'kms-key-1',
        retentionUntil: '2026-09-06T00:00:00.000Z',
        now,
      }),
    ).toThrow('secret-shaped');
    const backup = service.createBackup({
      tenant,
      snapshot: { safe: true },
      schemaVersion: 'state.v1',
      eventCursor: 1,
      encryptionKeyId: 'kms-key-1',
      retentionUntil: '2026-08-01T00:00:00.000Z',
      now,
    });
    const policy: RetentionPolicyV1 = {
      policyId: newSortableId(),
      tenant,
      version: 'retention.v1',
      retentionDays: 30,
      legalHold: true,
      createdAt: now,
    };
    expect(service.evaluateRetention(policy, backup, now)).toBe('blocked_legal_hold');
  });
});
