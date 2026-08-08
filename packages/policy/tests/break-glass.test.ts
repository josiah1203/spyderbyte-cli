import { describe, expect, it } from 'vitest';
import {
  newSortableId,
  type Actor,
  type ResourceSelector,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import { BreakGlassService, InMemoryAuditSink } from '../src/index.js';

const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
const otherTenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
const requester: Actor = { actorId: newSortableId(), type: 'human', displayName: 'On-call' };
const approver: Actor = { actorId: newSortableId(), type: 'human', displayName: 'Incident lead' };
const scope: ResourceSelector = { kind: 'secret', id: 'database/readonly' };
const now = '2026-08-03T00:00:00.000Z';

function request(service: BreakGlassService, maxUses = 2) {
  return service.request({
    tenant,
    requester,
    reason: 'Recover a blocked production incident',
    actions: ['secret.read'],
    resources: [scope],
    expiresAt: '2026-08-03T01:00:00.000Z',
    maxUses,
    now,
  });
}

describe('break-glass access', () => {
  it('requires independent human approval, binds the subject and scope, and audits use', () => {
    const audit = new InMemoryAuditSink();
    const service = new BreakGlassService({ audit, clock: () => now });
    const pending = request(service);
    expect(pending.state).toBe('pending');
    expect(() => service.approve(tenant, pending.grantId, requester, now)).toThrow(
      'cannot approve',
    );

    const active = service.approve(tenant, pending.grantId, approver, now);
    expect(active.state).toBe('active');
    expect(() =>
      service.assertValid(tenant, pending.grantId, approver, 'secret.read', [scope], now),
    ).toThrow('different human');
    expect(() =>
      service.assertValid(tenant, pending.grantId, requester, 'secret.write', [scope], now),
    ).toThrow('outside the grant');
    expect(() =>
      service.assertValid(
        tenant,
        pending.grantId,
        requester,
        'secret.read',
        [{ kind: 'secret', id: 'database/admin' }],
        now,
      ),
    ).toThrow('outside the grant');

    expect(
      service.consume(tenant, pending.grantId, requester, 'secret.read', [scope], now).useCount,
    ).toBe(1);
    expect(
      service.consume(tenant, pending.grantId, requester, 'secret.read', [scope], now).state,
    ).toBe('consumed');
    expect(() =>
      service.consume(tenant, pending.grantId, requester, 'secret.read', [scope], now),
    ).toThrow('no remaining uses');
    expect(audit.list().map((entry) => entry.action)).toEqual([
      'break_glass.request',
      'break_glass.approve',
      'break_glass.consume',
      'break_glass.consume',
    ]);
  });

  it('fails closed on expiry, revocation, and tenant crossing', () => {
    const service = new BreakGlassService({ clock: () => now });
    const pending = request(service, 1);
    expect(service.get(otherTenant, pending.grantId)).toBeUndefined();
    expect(() => service.approve(otherTenant, pending.grantId, approver, now)).toThrow('not found');
    service.approve(tenant, pending.grantId, approver, now);
    expect(() =>
      service.consume(
        tenant,
        pending.grantId,
        requester,
        'secret.read',
        [scope],
        '2026-08-03T01:00:00.000Z',
      ),
    ).toThrow('expired');
    const second = request(service, 1);
    service.approve(tenant, second.grantId, approver, now);
    expect(service.revoke(tenant, second.grantId, approver, 'Incident closed', now).state).toBe(
      'revoked',
    );
    expect(() =>
      service.consume(tenant, second.grantId, requester, 'secret.read', [scope], now),
    ).toThrow('revoked');
  });

  it('rejects wildcard operations and malformed emergency requests', () => {
    const service = new BreakGlassService({ clock: () => now });
    expect(() =>
      service.request({
        tenant,
        requester,
        reason: 'incident',
        actions: ['secret.*'],
        resources: [scope],
        expiresAt: '2026-08-03T01:00:00.000Z',
        maxUses: 1,
        now,
      }),
    ).toThrow('explicit operations');
    expect(() =>
      service.request({
        tenant,
        requester,
        reason: 'incident',
        actions: ['secret.read'],
        resources: [],
        expiresAt: '2026-08-03T01:00:00.000Z',
        maxUses: 1,
        now,
      }),
    ).toThrow('non-empty selectors');
  });
});
