import { describe, expect, it } from 'vitest';
import { newSortableId, type TenantRef } from '@agentic-platform/runtime-contracts';
import { HostedWorkerPool, InMemoryWorkerPool, type HostedWorkerPoolClient } from '../src/index.js';

const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
const otherTenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
const firstNow = '2026-08-03T01:00:00.000Z';

function request(tenantRef: TenantRef, taskId = newSortableId()) {
  return {
    taskId,
    tenant: tenantRef,
    pool: 'tier2-deterministic' as const,
    payload: { action: 'profile' },
    maxAttempts: 2,
    enqueuedAt: firstNow,
  };
}

describe('worker pools', () => {
  it('enforces tenant and pool quotas, redelivers failed work, and acknowledges once', async () => {
    const pool = new InMemoryWorkerPool({
      leaseDurationMs: 1_000,
      maxInFlightPerTenant: 1,
      maxInFlightByPool: { 'tier2-deterministic': 2 },
    });
    const first = await pool.enqueue(request(tenant));
    const second = await pool.enqueue(request(tenant));
    const other = await pool.enqueue(request(otherTenant));
    expect(first.state).toBe('queued');

    const lease = await pool.claim(tenant, 'tier2-deterministic', 'worker-a', firstNow);
    expect(lease?.taskId).toBe(first.taskId);
    expect(await pool.claim(tenant, 'tier2-deterministic', 'worker-b', firstNow)).toBeUndefined();
    const otherLease = await pool.claim(otherTenant, 'tier2-deterministic', 'worker-c', firstNow);
    expect(otherLease?.taskId).toBe(other.taskId);
    if (lease === undefined) throw new Error('expected a tenant lease');
    await expect(pool.ack(otherTenant, lease.leaseId, 'worker-a')).rejects.toThrow(
      'another tenant',
    );

    const waiting = await pool.fail(tenant, lease.leaseId, 'worker-a', 'TRANSIENT', firstNow);
    expect(waiting.state).toBe('queued');
    expect(waiting.failures).toMatchObject([{ attempt: 1, code: 'TRANSIENT' }]);
    const retry = await pool.claim(tenant, 'tier2-deterministic', 'worker-b', firstNow);
    expect(retry?.attempt).toBe(2);
    if (retry === undefined) throw new Error('expected a retry lease');
    const completed = await pool.ack(tenant, retry.leaseId, 'worker-b', firstNow);
    expect(completed.state).toBe('acked');
    expect(await pool.lag(tenant, 'tier2-deterministic')).toBe(1);
    expect((await pool.get(tenant, second.taskId))?.state).toBe('queued');
  });

  it('heartbeats active work and parks expired work after the final attempt', async () => {
    let now = firstNow;
    const pool = new InMemoryWorkerPool({
      clock: () => now,
      leaseDurationMs: 1_000,
      maxInFlightPerTenant: 2,
    });
    const task = await pool.enqueue({ ...request(tenant), maxAttempts: 1 });
    const lease = await pool.claim(tenant, task.pool, 'worker-a');
    if (lease === undefined) throw new Error('expected lease');
    now = '2026-08-03T01:00:00.500Z';
    const extended = await pool.heartbeat(tenant, lease.leaseId, 'worker-a');
    expect(extended.expiresAt).toBe('2026-08-03T01:00:01.500Z');
    now = '2026-08-03T01:00:02.000Z';
    expect(pool.reapExpired()).toBe(1);
    expect((await pool.get(tenant, task.taskId))?.state).toBe('parked');
    expect(await pool.claim(tenant, task.pool, 'worker-b')).toBeUndefined();
  });

  it('rejects duplicate task IDs with a different payload and expired lease mutations', async () => {
    const pool = new InMemoryWorkerPool({ leaseDurationMs: 1_000 });
    const task = await pool.enqueue(request(tenant));
    await expect(
      pool.enqueue({ ...request(tenant, task.taskId), payload: { action: 'other' } }),
    ).rejects.toThrow('another payload');
    const lease = await pool.claim(tenant, task.pool, 'worker-a', firstNow);
    if (lease === undefined) throw new Error('expected lease');
    const expired = '2026-08-03T01:00:01.001Z';
    await expect(pool.ack(tenant, lease.leaseId, 'worker-a', expired)).rejects.toThrow('expired');
    await expect(pool.fail(tenant, lease.leaseId, 'worker-a', 'TOO_LATE', expired)).rejects.toThrow(
      'expired',
    );
  });

  it('keeps the hosted adapter behind the same lease contract and validates returned scope', async () => {
    const local = new InMemoryWorkerPool();
    const client: HostedWorkerPoolClient = {
      enqueue: (input) => local.enqueue(input),
      claim: ({ tenant: tenantRef, pool, workerId, now }) =>
        local.claim(tenantRef, pool, workerId, now),
      heartbeat: ({ tenant: tenantRef, leaseId, workerId, now }) =>
        local.heartbeat(tenantRef, leaseId, workerId, now),
      ack: ({ tenant: tenantRef, leaseId, workerId, now }) =>
        local.ack(tenantRef, leaseId, workerId, now),
      fail: ({ tenant: tenantRef, leaseId, workerId, code, now }) =>
        local.fail(tenantRef, leaseId, workerId, code, now),
      park: ({ tenant: tenantRef, leaseId, workerId, code, now }) =>
        local.park(tenantRef, leaseId, workerId, code, now),
      get: (tenantRef, taskId) => local.get(tenantRef, taskId),
      lag: (tenantRef, pool) => local.lag(tenantRef, pool),
    };
    const hosted = new HostedWorkerPool(client);
    const queued = await hosted.enqueue(request(tenant));
    const lease = await hosted.claim(tenant, queued.pool, 'hosted-worker', firstNow);
    expect(lease?.taskId).toBe(queued.taskId);
    if (lease === undefined) throw new Error('expected hosted lease');
    const completed = await hosted.ack(tenant, lease.leaseId, 'hosted-worker', firstNow);
    expect(completed.state).toBe('acked');
  });
});
