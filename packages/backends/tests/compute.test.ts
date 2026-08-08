import { describe, expect, it } from 'vitest';
import {
  makeMoney,
  newSortableId,
  type AuthorityEnvelope,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import { LocalComputeBackend } from '../src/index.js';

const tenant: TenantRef = {
  tenantId: newSortableId(),
  workspaceId: newSortableId(),
};

function authority(): AuthorityEnvelope {
  const now = '2026-08-02T00:00:00.000Z';
  return {
    schemaVersion: 1,
    envelopeId: newSortableId(),
    tenant,
    issuer: { actorId: newSortableId(), type: 'system' },
    subjectAgentId: newSortableId(),
    workflowId: newSortableId(),
    invocationId: newSortableId(),
    tier: 1,
    harnessVersion: 'cluster.v1',
    permittedActions: ['compute.allocate'],
    capabilities: ['compute.local'],
    resourceScopes: [{ kind: 'compute', id: 'local' }],
    allowedArtifactReads: [],
    allowedArtifactWrites: [],
    allowedChildAgentTypes: [],
    maxChildCount: 0,
    toolOperations: [],
    issuedAt: now,
    expiresAt: '2026-08-02T01:00:00.000Z',
    nonce: 'nonce',
    policyVersion: 'policy.v1',
    revocationEpoch: 0,
    integrityProof: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  };
}

describe('LocalComputeBackend', () => {
  it('offers and allocates only through an approved Cluster grant, then releases capacity', async () => {
    const backend = new LocalComputeBackend({
      capacity: { cpuMillicores: 1000, memoryBytes: 1024 * 1024, gpuCount: 0 },
      clock: () => '2026-08-02T00:00:00.000Z',
    });
    const offer = (
      await backend.estimate({
        tenant,
        name: 'smoke',
        resources: { cpuMillicores: 500, memoryBytes: 1024, gpuCount: 0 },
        durationSeconds: 10,
        maxCostMinor: 100,
        currency: 'USD',
      })
    )[0];
    if (offer === undefined) throw new Error('expected a compute offer');
    const grant = {
      grantId: newSortableId(),
      offerId: offer.offerId,
      tenant,
      specialistType: 'cluster' as const,
      tier: 1 as const,
      authority: authority(),
      approved: true,
      approvalDigest: 'digest',
      budgetId: newSortableId(),
      estimatedCost: makeMoney(100, 'USD'),
      expiresAt: '2026-08-02T01:00:00.000Z',
    };
    const allocation = await backend.allocate(offer, grant);
    const capacity = await backend.inspectCapacity({ tenant });
    expect(capacity.free.cpuMillicores).toBe(500);
    const job = await backend.submitJob(allocation, {
      command: process.execPath,
      args: ['-e', 'process.stdout.write("checkpoint-ready")'],
      wallTimeMs: 1_000,
      outputBytes: 1_000,
    });
    const observations = [];
    for await (const observation of backend.observeJob(job)) observations.push(observation);
    expect(observations.at(-1)?.status).toBe('succeeded');
    expect(observations.at(-1)?.stdout).toContain('checkpoint-ready');
    expect((await backend.inspectCapacity({ tenant })).free.cpuMillicores).toBe(1000);
  });

  it('classifies non-zero subprocess exits as user-code failures and rejects non-cluster grants', async () => {
    const backend = new LocalComputeBackend({
      capacity: { cpuMillicores: 1000, memoryBytes: 1024 * 1024, gpuCount: 0 },
      clock: () => '2026-08-02T00:00:00.000Z',
    });
    const offer = (
      await backend.estimate({
        tenant,
        name: 'bad',
        resources: { cpuMillicores: 100, memoryBytes: 1024, gpuCount: 0 },
        durationSeconds: 1,
        maxCostMinor: 100,
        currency: 'USD',
      })
    )[0];
    if (offer === undefined) throw new Error('expected a compute offer');
    await expect(
      backend.allocate(offer, {
        grantId: newSortableId(),
        offerId: offer.offerId,
        tenant,
        specialistType: 'cluster',
        tier: 1,
        authority: authority(),
        approved: false,
        approvalDigest: 'digest',
        budgetId: newSortableId(),
        estimatedCost: makeMoney(100, 'USD'),
        expiresAt: '2026-08-02T01:00:00.000Z',
      }),
    ).rejects.toThrow('approved');
    const allocation = await backend.allocate(offer, {
      grantId: newSortableId(),
      offerId: offer.offerId,
      tenant,
      specialistType: 'cluster',
      tier: 1,
      authority: authority(),
      approved: true,
      approvalDigest: 'digest',
      budgetId: newSortableId(),
      estimatedCost: makeMoney(100, 'USD'),
      expiresAt: '2026-08-02T01:00:00.000Z',
    });
    await expect(
      backend.submitJob(allocation, {
        command: process.execPath,
        env: { API_KEY: 'must-not-enter-the-worker' },
      }),
    ).rejects.toThrow('Secret-like');
    const job = await backend.submitJob(allocation, {
      command: process.execPath,
      args: ['-e', 'process.stderr.write("bad input"); process.exit(3)'],
      wallTimeMs: 1_000,
    });
    let final;
    for await (const observation of backend.observeJob(job)) final = observation;
    expect(final?.status).toBe('failed');
    expect(final?.failureCode).toBe('USER_CODE');
  });

  it('rechecks capacity at commit, releases on termination, and permits a later allocation', async () => {
    const backend = new LocalComputeBackend({
      capacity: { cpuMillicores: 1000, memoryBytes: 1024 * 1024, gpuCount: 0 },
      clock: () => '2026-08-02T00:00:00.000Z',
    });
    const workload = {
      tenant,
      name: 'capacity-fixture',
      resources: { cpuMillicores: 600, memoryBytes: 1024, gpuCount: 0 },
      durationSeconds: 1,
      maxCostMinor: 100,
      currency: 'USD',
    } as const;
    const firstOffer = (await backend.estimate(workload))[0];
    const secondOffer = (await backend.estimate(workload))[0];
    if (firstOffer === undefined || secondOffer === undefined)
      throw new Error('expected capacity offers');
    const makeGrant = (offerId: typeof firstOffer.offerId) => ({
      grantId: newSortableId(),
      offerId,
      tenant,
      specialistType: 'cluster' as const,
      tier: 1 as const,
      authority: authority(),
      approved: true,
      approvalDigest: 'digest',
      budgetId: newSortableId(),
      estimatedCost: makeMoney(100, 'USD'),
      expiresAt: '2026-08-02T01:00:00.000Z',
    });

    const allocation = await backend.allocate(firstOffer, makeGrant(firstOffer.offerId));
    await expect(backend.allocate(secondOffer, makeGrant(secondOffer.offerId))).rejects.toThrow(
      'Capacity was consumed',
    );
    expect((await backend.inspectCapacity({ tenant })).free.cpuMillicores).toBe(400);

    const job = await backend.submitJob(allocation, {
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 5000)'],
    });
    await backend.terminate(job);
    let final;
    for await (const observation of backend.observeJob(job)) final = observation;
    expect(final?.status).toBe('cancelled');
    expect((await backend.inspectCapacity({ tenant })).free.cpuMillicores).toBe(1000);

    await backend.allocate(secondOffer, makeGrant(secondOffer.offerId));
    expect((await backend.inspectCapacity({ tenant })).free.cpuMillicores).toBe(400);
  });
});
