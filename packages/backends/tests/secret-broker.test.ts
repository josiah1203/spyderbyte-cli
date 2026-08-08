import { describe, expect, it } from 'vitest';
import { newSortableId, type TenantRef } from '@agentic-platform/runtime-contracts';
import { InMemorySecretBroker } from '../src/index.js';

const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };

describe('InMemorySecretBroker', () => {
  it('returns handles rather than values and enforces operation, tenant, expiry, revocation, and redaction', () => {
    let now = '2026-08-02T00:00:00.000Z';
    const broker = new InMemorySecretBroker(() => now);
    const handle = broker.issue({
      tenant,
      secretName: 'fixture-api-key',
      value: 'super-secret',
      operation: 'connector.read',
      ttlMs: 1_000,
    });
    expect(handle).not.toHaveProperty('value');
    expect(broker.resolve(handle, tenant, 'connector.read')).toBe('super-secret');
    expect(broker.redact('token=super-secret')).toBe('token=[REDACTED]');
    broker.revoke(handle.handleId);
    expect(() => broker.resolve(handle, tenant, 'connector.read')).toThrow('Secret handle');
    now = '2026-08-02T00:00:02.000Z';
    expect(() => broker.resolve(handle, tenant, 'connector.read')).toThrow('Secret handle');
    expect(broker.auditRecords().every((record) => !('value' in record))).toBe(true);
  });
});
