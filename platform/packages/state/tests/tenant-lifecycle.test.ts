import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  newSortableId,
  type Actor,
  type HashSha256,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import {
  TenantLifecycleService,
  type TenantDataBucket,
  type TenantDataInventory,
  type TenantDataLifecyclePort,
} from '../src/index.js';

const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
const otherTenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
const requester: Actor = { actorId: newSortableId(), type: 'human' };
const approver: Actor = { actorId: newSortableId(), type: 'human' };
const now = '2026-08-03T00:00:00.000Z';
const buckets: TenantDataBucket[] = [
  'authoritative',
  'artifacts',
  'events',
  'outbox',
  'projections',
  'audit',
  'connector_handles',
  'backups',
];

function inventory(forTenant: TenantRef, legalHold = false): TenantDataInventory {
  const counts = Object.fromEntries(
    buckets.map((bucket) => [bucket, bucket === 'artifacts' ? 3 : 0]),
  ) as Record<TenantDataBucket, number>;
  const digest = createHash('sha256')
    .update(JSON.stringify({ tenant: forTenant, policy: 'retention.v1', counts, legalHold }))
    .digest('hex') as HashSha256;
  return {
    tenant: forTenant,
    observedAt: now,
    retentionPolicyVersion: 'retention.v1',
    legalHold,
    counts,
    totalBytes: 120,
    digest,
  };
}

class FixtureLifecyclePort implements TenantDataLifecyclePort {
  readonly calls: string[] = [];
  readonly hold: boolean;

  constructor(hold = false) {
    this.hold = hold;
  }

  async inventory(forTenant: TenantRef): Promise<TenantDataInventory> {
    return inventory(forTenant, this.hold);
  }

  async deleteBatch(input: Parameters<TenantDataLifecyclePort['deleteBatch']>[0]) {
    this.calls.push(`${input.tenant.tenantId}:${input.cursor}`);
    if (input.tenant.tenantId !== tenant.tenantId) {
      return {
        tenant: otherTenant,
        deletionId: input.deletionId,
        cursor: input.cursor,
        deleted: 1,
        remaining: 0,
      };
    }
    if (input.cursor === '') {
      return {
        tenant,
        deletionId: input.deletionId,
        cursor: '',
        nextCursor: 'next',
        deleted: 2,
        remaining: 1,
      };
    }
    return {
      tenant,
      deletionId: input.deletionId,
      cursor: 'next',
      deleted: 1,
      remaining: 0,
    };
  }
}

describe('tenant retention and deletion lifecycle', () => {
  it('requires independent approval and completes bounded resumable batches with a tombstone', async () => {
    const port = new FixtureLifecyclePort();
    const audit: string[] = [];
    const service = new TenantLifecycleService({
      port,
      clock: () => now,
      audit: { record: (event) => audit.push(event.action) },
    });
    const plan = await service.request({
      tenant,
      requester,
      reason: 'Approved tenant deletion request',
      policyVersion: 'retention.v1',
      batchSize: 2,
      now,
    });
    expect(plan.state).toBe('pending_approval');
    expect(() => service.approve(tenant, plan.deletionId, requester, now)).toThrow('own deletion');
    await expect(service.executeBatch(tenant, plan.deletionId, now)).rejects.toThrow(
      'pending_approval',
    );
    expect((await service.approve(tenant, plan.deletionId, approver, now)).state).toBe('approved');
    const running = await service.executeBatch(tenant, plan.deletionId, now);
    expect(running).toMatchObject({ state: 'executing', cursor: 'next', deletedCount: 2 });
    const completed = await service.executeBatch(tenant, plan.deletionId, now);
    expect(completed).toMatchObject({ state: 'completed', deletedCount: 3 });
    const tombstoneId = completed.tombstoneId;
    expect(tombstoneId).toBeDefined();
    if (tombstoneId === undefined) throw new Error('Expected a deletion tombstone');
    expect(service.getTombstone(tenant, tombstoneId)).toMatchObject({
      deletionId: plan.deletionId,
      inventoryDigest: plan.inventory.digest,
      deletedCount: 3,
    });
    expect(port.calls).toHaveLength(2);
    expect(audit).toEqual([
      'deletion.request',
      'deletion.approve',
      'deletion.batch',
      'deletion.complete',
    ]);
  });

  it('blocks legal holds and rejects cross-tenant batches', async () => {
    const held = new TenantLifecycleService({
      port: new FixtureLifecyclePort(true),
      clock: () => now,
    });
    const heldPlan = await held.request({
      tenant,
      requester,
      reason: 'Legal hold must prevent deletion',
      policyVersion: 'retention.v1',
      batchSize: 1,
      now,
    });
    expect(heldPlan.state).toBe('blocked_legal_hold');
    expect(() => held.approve(tenant, heldPlan.deletionId, approver, now)).toThrow('legal hold');

    const service = new TenantLifecycleService({
      port: new FixtureLifecyclePort(),
      clock: () => now,
    });
    const plan = await service.request({
      tenant,
      requester,
      reason: 'Cross-tenant response must fail closed',
      policyVersion: 'retention.v1',
      batchSize: 1,
      now,
    });
    expect(() => service.approve(otherTenant, plan.deletionId, approver, now)).toThrow('not found');
    await expect(
      service.request({
        tenant,
        requester,
        reason: 'Wrong policy cannot authorize deletion',
        policyVersion: 'retention.v2',
        batchSize: 1,
        now,
      }),
    ).rejects.toThrow('does not match');
  });
});
