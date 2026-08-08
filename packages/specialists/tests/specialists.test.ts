import { describe, expect, it } from 'vitest';
import { profileDataset } from '@agentic-platform/tasks';
import { GovernanceSpecialist } from '../src/index.js';

const sourceArtifact = {
  schemaVersion: 1 as const,
  tenant: {
    tenantId: '018f0c4b-4e60-7abc-8def-0123456789ab' as never,
    workspaceId: '018f0c4b-4e61-7abc-8def-0123456789ab' as never,
  },
  artifactId: '018f0c4b-4e62-7abc-8def-0123456789ab' as never,
  version: 1,
  contentHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as never,
  mediaType: 'text/csv',
  sizeBytes: 40,
  createdAt: '2026-08-02T00:00:00.000Z',
};

describe('dataset specialists', () => {
  it('denies PII access unless the requested scope is explicit', () => {
    const specialist = new GovernanceSpecialist();
    const profile = profileDataset('id,email\n1,a@example.com\n');
    const denied = specialist.evaluate({
      sourceArtifact,
      intendedUse: 'quality review',
      requestedAccessScopes: ['dataset.read'],
      retentionDays: 30,
      profile,
      now: '2026-08-02T00:00:00.000Z',
    });
    expect(denied.decision).toBe('denied');
    expect(denied.reasonCodes).toContain('PII_SCOPE_NOT_REQUESTED');

    const approved = specialist.evaluate({
      sourceArtifact,
      intendedUse: 'quality review',
      requestedAccessScopes: ['dataset.read', 'pii.read'],
      retentionDays: 30,
      profile,
      now: '2026-08-02T00:00:00.000Z',
    });
    expect(approved.decision).toBe('approved');
  });
});
