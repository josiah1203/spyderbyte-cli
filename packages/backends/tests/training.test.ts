import { describe, expect, it } from 'vitest';
import {
  makeMoney,
  newSortableId,
  type ArtifactReference,
  type AuthorityEnvelope,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import { LocalComputeBackend, LocalTrainingSmokeWorkflow } from '../src/index.js';

const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
const dataset: ArtifactReference = {
  schemaVersion: 1,
  tenant,
  artifactId: newSortableId(),
  version: 1,
  contentHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  mediaType: 'application/json',
  sizeBytes: 10,
  createdAt: '2026-08-02T00:00:00.000Z',
};

function authority(): AuthorityEnvelope {
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
    issuedAt: '2026-08-02T00:00:00.000Z',
    expiresAt: '2026-08-02T01:00:00.000Z',
    nonce: 'nonce',
    policyVersion: 'policy.v1',
    revocationEpoch: 0,
    integrityProof: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  };
}

const config = (configId: string) => ({
  configId,
  strategy: {
    strategyId: `${configId}-strategy`,
    baseModel: 'fixture-model',
    method: 'lora' as const,
    objective: 'classify',
    checkpointEverySteps: 1,
    earlyStopMetric: 'loss',
  },
  hyperparameters: { learningRate: 0.001, microBatchSize: 1 },
  resources: { cpuMillicores: 100, memoryBytes: 1024, gpuCount: 0 },
  durationSeconds: 1,
});

describe('LocalTrainingSmokeWorkflow', () => {
  it('runs two candidate configs through a Cluster-gated local offer and publishes a checkpoint reference', async () => {
    const compute = new LocalComputeBackend({
      capacity: { cpuMillicores: 1000, memoryBytes: 1024 * 1024, gpuCount: 0 },
      clock: () => '2026-08-02T00:00:00.000Z',
    });
    const workflow = new LocalTrainingSmokeWorkflow({
      compute,
      clock: () => '2026-08-02T00:00:00.000Z',
    });
    const result = await workflow.run({
      tenant,
      validatedDataset: dataset,
      sourceRevision: 'git:fixture',
      configs: [config('candidate-a'), config('candidate-b')],
      budgetLimitMinor: 100,
      currency: 'USD',
      clusterGrantFor: (offer) => ({
        grantId: newSortableId(),
        offerId: offer.offerId,
        tenant,
        specialistType: 'cluster',
        tier: 1,
        authority: authority(),
        approved: true,
        approvalDigest: 'approval',
        budgetId: newSortableId(),
        estimatedCost: makeMoney(100, 'USD'),
        expiresAt: '2026-08-02T01:00:00.000Z',
      }),
    });
    expect(result.summary.status).toBe('succeeded');
    expect(result.candidateRuns).toHaveLength(2);
    expect(
      result.candidateRuns.every((candidate) => candidate.summary.status === 'succeeded'),
    ).toBe(true);
    expect(result.checkpoint?.contentHash).toHaveLength(64);
    expect(result.summary.metrics.smoke_metric).toBe(0.75);
    expect(result.summary.costMinor).toBe(result.summary.actualCostMinor);
    expect(result.summary.estimatedCostMinor).toBeGreaterThanOrEqual(
      result.summary.actualCostMinor,
    );
  });

  it('normalizes OOM as a compute failure rather than a successful training report', async () => {
    const compute = new LocalComputeBackend({
      capacity: { cpuMillicores: 1000, memoryBytes: 1024 * 1024, gpuCount: 0 },
      clock: () => '2026-08-02T00:00:00.000Z',
    });
    const workflow = new LocalTrainingSmokeWorkflow({
      compute,
      clock: () => '2026-08-02T00:00:00.000Z',
    });
    const result = await workflow.run({
      tenant,
      validatedDataset: dataset,
      sourceRevision: 'git:fixture',
      configs: [config('candidate-a'), config('candidate-b')],
      budgetLimitMinor: 100,
      currency: 'USD',
      command: process.execPath,
      args: ['-e', 'process.stderr.write("out of memory"); process.exit(137)'],
      clusterGrantFor: (offer) => ({
        grantId: newSortableId(),
        offerId: offer.offerId,
        tenant,
        specialistType: 'cluster',
        tier: 1,
        authority: authority(),
        approved: true,
        approvalDigest: 'approval',
        budgetId: newSortableId(),
        estimatedCost: makeMoney(100, 'USD'),
        expiresAt: '2026-08-02T01:00:00.000Z',
      }),
    });
    expect(result.summary.status).toBe('failed');
    expect(result.summary.failureCode).toBe('OUT_OF_MEMORY');
    expect(result.summary.costMinor).toBe(result.summary.actualCostMinor);
    expect(result.checkpoint).toBeUndefined();
    expect(result.candidateRuns).toHaveLength(2);
    expect(
      result.candidateRuns.every((candidate) => candidate.summary.failureCode === 'OUT_OF_MEMORY'),
    ).toBe(true);
  });

  it('blocks the unrun candidate when reconciled usage exhausts the approved budget', async () => {
    const compute = new LocalComputeBackend({
      capacity: { cpuMillicores: 1000, memoryBytes: 1024 * 1024, gpuCount: 0 },
      clock: () => '2026-08-02T00:00:00.000Z',
    });
    const workflow = new LocalTrainingSmokeWorkflow({
      compute,
      clock: () => '2026-08-02T00:00:00.000Z',
    });
    const result = await workflow.run({
      tenant,
      validatedDataset: dataset,
      sourceRevision: 'git:fixture',
      configs: [config('candidate-a'), config('candidate-b')],
      budgetLimitMinor: 1,
      currency: 'USD',
      clusterGrantFor: (offer) => ({
        grantId: newSortableId(),
        offerId: offer.offerId,
        tenant,
        specialistType: 'cluster',
        tier: 1,
        authority: authority(),
        approved: true,
        approvalDigest: 'approval',
        budgetId: newSortableId(),
        estimatedCost: makeMoney(1, 'USD'),
        expiresAt: '2026-08-02T01:00:00.000Z',
      }),
    });
    expect(result.summary.status).toBe('blocked');
    expect(result.summary.failureCode).toBe('BUDGET_REJECTION');
    expect(result.candidateRuns[0]?.summary.status).toBe('succeeded');
    expect(result.candidateRuns[1]?.summary.failureCode).toBe('BUDGET_REJECTION');
    expect(result.checkpoint).toBeUndefined();
  });
});
