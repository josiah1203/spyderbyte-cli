import { describe, expect, it } from 'vitest';
import { newSortableId, type Actor, type TenantRef } from '@agentic-platform/runtime-contracts';
import { InMemoryCollaborationService } from '../src/index.js';

const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
const otherTenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
const actor: Actor = { actorId: newSortableId(), type: 'human', displayName: 'Ada' };
const now = '2026-08-06T00:00:00.000Z';

describe('browser collaboration conflict boundary', () => {
  it('applies optimistic document writes and returns explicit conflicts', () => {
    const service = new InMemoryCollaborationService(() => now);
    const documentId = newSortableId();
    const document = service.open({
      tenant,
      resourceType: 'workflow-plan',
      resourceId: documentId,
      initialValue: { title: 'Initial' },
      actor,
      now,
    });
    const applied = service.write({
      tenant,
      documentId,
      expectedVersion: document.version,
      value: { title: 'Updated' },
      actor,
      now,
    });
    expect(applied.status).toBe('applied');
    const conflict = service.write({
      tenant,
      documentId,
      expectedVersion: 0,
      value: { title: 'Stale edit' },
      actor,
      now,
    });
    expect(conflict).toMatchObject({ status: 'conflict', conflict: { actualVersion: 1 } });
    expect(service.conflicts(tenant, documentId)).toHaveLength(1);
    expect(() => service.read(otherTenant, documentId)).toThrow('not found');
  });

  it('expires presence and keeps presence/audit records tenant scoped', () => {
    const service = new InMemoryCollaborationService(() => now);
    const documentId = newSortableId();
    service.open({ tenant, resourceType: 'chat', resourceId: documentId, actor, now });
    service.updatePresence({ tenant, documentId, actor, state: 'active', ttlMs: 1000, now });
    expect(service.listPresence(tenant, documentId, now)).toHaveLength(1);
    expect(service.listPresence(otherTenant, documentId, now)).toHaveLength(0);
    expect(service.expirePresence('2026-08-06T00:00:01.001Z')).toBe(1);
    expect(service.listPresence(tenant, documentId, '2026-08-06T00:00:01.001Z')).toHaveLength(0);
  });
});
