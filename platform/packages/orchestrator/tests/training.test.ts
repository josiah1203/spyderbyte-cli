import { describe, expect, it } from 'vitest';
import { LocalComputeBackend, LocalTrainingSmokeWorkflow } from '@agentic-platform/backends';
import {
  newSortableId,
  type ArtifactReference,
  type AuthorityEnvelope,
} from '@agentic-platform/runtime-contracts';
import { LocalModelLifecycleOrchestrator, LocalTrainingSliceOrchestrator } from '../src/index.js';

const tenant = { tenantId: newSortableId(), workspaceId: newSortableId() };
const dataset: ArtifactReference = {
  schemaVersion: 1,
  tenant,
  artifactId: newSortableId(),
  version: 1,
  contentHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  mediaType: 'application/json',
  sizeBytes: 1,
  createdAt: '2026-08-02T00:00:00.000Z',
};
const authority: AuthorityEnvelope = {
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

describe('LocalTrainingSliceOrchestrator', () => {
  it('connects ML Engineer strategy/config output to Cluster-gated compute and checkpoint reporting', async () => {
    const compute = new LocalComputeBackend({
      capacity: { cpuMillicores: 1000, memoryBytes: 1024 * 1024, gpuCount: 0 },
      clock: () => '2026-08-02T00:00:00.000Z',
    });
    const orchestrator = new LocalTrainingSliceOrchestrator({
      training: new LocalTrainingSmokeWorkflow({
        compute,
        clock: () => '2026-08-02T00:00:00.000Z',
      }),
    });
    const result = await orchestrator.run({
      tenant,
      validatedDataset: dataset,
      sourceRevision: 'git:fixture',
      baseModel: 'fixture-model',
      method: 'lora',
      objective: 'classify',
      resources: { cpuMillicores: 100, memoryBytes: 1024, gpuCount: 0 },
      budgetLimitMinor: 100,
      currency: 'USD',
      authority,
      approvalDigest: 'training-approval',
      approved: true,
      now: '2026-08-02T00:00:00.000Z',
    });
    expect(result.configs).toHaveLength(2);
    expect(result.run.summary.status).toBe('succeeded');
    expect(result.run.checkpoint).toBeDefined();
  });

  it('carries training evidence through experiment, independent evaluation, canary, and rollback', async () => {
    const now = '2026-08-02T00:00:00.000Z';
    const compute = new LocalComputeBackend({
      capacity: { cpuMillicores: 1000, memoryBytes: 1024 * 1024, gpuCount: 0 },
      clock: () => now,
    });
    const lifecycle = new LocalModelLifecycleOrchestrator({
      training: new LocalTrainingSliceOrchestrator({
        training: new LocalTrainingSmokeWorkflow({ compute, clock: () => now }),
      }),
    });
    const result = await lifecycle.run({
      workflowId: newSortableId(),
      training: {
        tenant,
        validatedDataset: dataset,
        sourceRevision: 'git:fixture',
        baseModel: 'fixture-model',
        method: 'lora',
        objective: 'classify',
        resources: { cpuMillicores: 100, memoryBytes: 1024, gpuCount: 0 },
        budgetLimitMinor: 100,
        currency: 'USD',
        authority,
        approvalDigest: 'compute-approval',
        approved: true,
        now,
      },
      modelName: 'fixture-model',
      baseline: { ...dataset, artifactId: newSortableId() },
      benchmark: { ...dataset, artifactId: newSortableId() },
      evaluationArtifact: { ...dataset, artifactId: newSortableId() },
      environmentSnapshot: { ...dataset, artifactId: newSortableId() },
      originalDataLineage: [{ ...dataset, artifactId: newSortableId() }],
      candidateMetric: 0.82,
      baselineMetric: 0.75,
      candidateSamples: [0.81, 0.82, 0.83, 0.82],
      baselineSamples: [0.74, 0.75, 0.76, 0.75],
      minimumSampleSize: 3,
      safetyRegression: false,
      modelApprovalDigest: 'model-approval',
      commitModelApprovalDigest: 'model-approval',
      policyApproved: true,
      trafficGrant: {
        approved: true,
        actionDigest: 'traffic-approval',
        commitDigest: 'traffic-approval',
        expiresAt: '2026-08-02T01:00:00.000Z',
        now,
      },
      injectCanaryFailure: true,
    });
    expect(result.status).toBe('rolled_back');
    expect(result.training.run.candidateRuns).toHaveLength(2);
    expect(result.evaluation.recommendation).toBe('promote');
    expect(result.model.version).toBe(1);
    expect(result.deployment.trafficPercent).toBe(10);
    expect(result.rollback).toMatchObject({ state: 'rolled_back', trafficPercent: 0 });
    expect(result.report).toMatchObject({
      schemaVersion: 1,
      metrics: { candidateMetric: 0.82, baselineMetric: 0.75 },
      cost: { currency: 'USD', reconciled: true },
      rollout: {
        status: 'rolled_back',
        state: 'canary',
        trafficPercent: 10,
        rollbackState: 'rolled_back',
      },
    });
    expect(result.report.metrics.delta).toBeCloseTo(0.07);
    expect(result.report.artifacts.originalDataLineage).toHaveLength(1);
  });
});
