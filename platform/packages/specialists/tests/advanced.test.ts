import { describe, expect, it } from 'vitest';
import {
  newSortableId,
  type ArtifactReference,
  type AuthorityEnvelope,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import {
  InMemoryDeploymentController,
  InMemoryExperimentBackend,
  InMemoryModelRegistry,
  LocalComputeBackend,
  LocalTrainingSmokeWorkflow,
} from '@agentic-platform/backends';
import {
  ClusterSpecialist,
  ConnectorSpecialist,
  DeploymentSpecialist,
  EvalSpecialist,
  MlEngineerSpecialist,
} from '../src/index.js';

const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
const artifact: ArtifactReference = {
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

describe('advanced specialist boundaries', () => {
  it('keeps training strategy/config decisions in ML Engineer and allocation in Cluster', () => {
    const ml = new MlEngineerSpecialist();
    const strategy = ml.proposeStrategy({
      baseModel: 'fixture',
      method: 'lora',
      objective: 'classify',
      dataset: artifact,
      resources: { cpuMillicores: 100, memoryBytes: 1024, gpuCount: 0 },
    });
    const configs = ml.generateCandidateConfigs(strategy, {
      cpuMillicores: 100,
      memoryBytes: 1024,
      gpuCount: 0,
    });
    expect(configs).toHaveLength(2);
    const grant = new ClusterSpecialist().createAllocationGrant({
      offer: {
        offerId: newSortableId(),
        backendId: 'local',
        tenant,
        resources: configs[0].resources,
        estimatedCost: { amountMinor: 1, currency: 'USD' },
        expiresAt: '2026-08-02T01:00:00.000Z',
        workloadName: 'train',
      },
      tenant,
      authority,
      approvalDigest: 'approval',
      budgetId: newSortableId(),
      approved: true,
      now: '2026-08-02T00:00:00.000Z',
    });
    expect(grant.specialistType).toBe('cluster');
    expect(grant.tier).toBe(1);
  });

  it('keeps evaluation independent and enforces deployment and connector gates', () => {
    const evaluation = new EvalSpecialist().evaluate({
      candidate: artifact,
      baseline: { ...artifact, artifactId: newSortableId() },
      benchmark: { ...artifact, artifactId: newSortableId() },
      candidateMetric: 0.8,
      baselineMetric: 0.7,
      safetyRegression: true,
    });
    expect(evaluation.recommendation).toBe('reject');
    const deployment = new DeploymentSpecialist();
    expect(deployment.transition('requested', 'provision')).toBe('provisioning');
    expect(deployment.transition('canary', 'rollback')).toBe('rolled_back');
    const scan = new ConnectorSpecialist().scan({
      specification: { tools: ['read'] },
      requestedScopes: ['sandbox.read'],
      source: 'fixture',
    });
    expect(scan.valid).toBe(true);
  });

  it('requires sufficient independent samples before a statistical promotion', () => {
    const evaluator = new EvalSpecialist();
    const investigate = evaluator.evaluate({
      candidate: artifact,
      baseline: { ...artifact, artifactId: newSortableId() },
      benchmark: { ...artifact, artifactId: newSortableId() },
      candidateMetric: 0.8,
      baselineMetric: 0.7,
      candidateSamples: [0.8],
      baselineSamples: [0.7],
      minimumSampleSize: 3,
      safetyRegression: false,
    });
    expect(investigate.recommendation).toBe('investigate');
    expect(investigate.comparison.sufficientSampleSize).toBe(false);
  });

  it('runs the local model lifecycle through evaluation, canary, and audited rollback', async () => {
    const now = '2026-08-02T00:00:00.000Z';
    const compute = new LocalComputeBackend({
      capacity: { cpuMillicores: 1000, memoryBytes: 1024 * 1024, gpuCount: 0 },
      clock: () => now,
    });
    const strategy = new MlEngineerSpecialist().proposeStrategy({
      baseModel: 'fixture-model',
      method: 'lora',
      objective: 'classify',
      dataset: artifact,
      resources: { cpuMillicores: 100, memoryBytes: 1024, gpuCount: 0 },
    });
    const configs = new MlEngineerSpecialist().generateCandidateConfigs(strategy, {
      cpuMillicores: 100,
      memoryBytes: 1024,
      gpuCount: 0,
    });
    const training = await new LocalTrainingSmokeWorkflow({
      compute,
      clock: () => now,
    }).run({
      tenant,
      validatedDataset: artifact,
      sourceRevision: 'git:fixture',
      configs: configs.map((config) => ({ ...config, durationSeconds: 1 })) as [
        (typeof configs)[number],
        (typeof configs)[number],
      ],
      budgetLimitMinor: 100,
      currency: 'USD',
      clusterGrantFor: (offer) =>
        new ClusterSpecialist().createAllocationGrant({
          offer,
          tenant,
          authority,
          approvalDigest: 'compute-approval',
          budgetId: newSortableId(),
          approved: true,
          now,
        }),
    });
    expect(training.summary.status).toBe('succeeded');
    expect(training.candidateRuns).toHaveLength(2);
    const checkpoint = training.checkpoint;
    if (checkpoint === undefined) throw new Error('training checkpoint was not produced');

    const experiment = new InMemoryExperimentBackend();
    const experimentRun = await experiment.createRun({
      tenant,
      workflowId: newSortableId(),
      name: 'local-lifecycle-fixture',
      sourceRevision: 'git:fixture',
      dataset: artifact,
    });
    await experiment.logMetric(experimentRun, {
      metricId: newSortableId(),
      name: 'validation_accuracy',
      value: 0.82,
      unit: 'ratio',
      observedAt: now,
    });
    await experiment.logArtifact(experimentRun, checkpoint);
    const registered = await experiment.registerCheckpoint(experimentRun, checkpoint);

    const evaluation = new EvalSpecialist().evaluate({
      candidate: registered.artifact,
      baseline: { ...artifact, artifactId: newSortableId() },
      benchmark: { ...artifact, artifactId: newSortableId() },
      candidateMetric: 0.82,
      baselineMetric: 0.75,
      candidateSamples: [0.81, 0.82, 0.83, 0.82],
      baselineSamples: [0.74, 0.75, 0.76, 0.75],
      minimumSampleSize: 3,
      safetyRegression: false,
    });
    expect(evaluation.recommendation).toBe('promote');

    const registry = new InMemoryModelRegistry();
    const model = registry.publish({
      tenant,
      modelName: 'fixture-model',
      candidateArtifact: registered.artifact,
      lineage: {
        checkpoint: registered.artifact,
        trainingRun: {
          run: experimentRun,
          configuration: configs[0],
          sourceRevision: 'git:fixture',
          environmentSnapshot: { ...artifact, artifactId: newSortableId() },
        },
        validatedDataset: artifact,
        originalDataLineage: [{ ...artifact, artifactId: newSortableId() }],
      },
      evaluation: { recommendation: evaluation.recommendation, evaluationArtifact: artifact },
      policyApproved: true,
      approvalDigest: 'model-approval',
      commitApprovalDigest: 'model-approval',
    });
    const deployments = new InMemoryDeploymentController();
    const deployment = deployments.request(tenant, model);
    await deployments.advance(tenant, deployment.deploymentId, 'provision');
    await deployments.advance(tenant, deployment.deploymentId, 'smokePass');
    const trafficGrant = {
      approved: true,
      actionDigest: 'traffic-approval',
      commitDigest: 'traffic-approval',
      expiresAt: '2026-08-02T01:00:00.000Z',
      now,
    } as const;
    const canary = deployments.advance(
      tenant,
      deployment.deploymentId,
      'startCanary',
      trafficGrant,
    );
    expect(canary.trafficPercent).toBe(10);
    deployments.observeHealth(tenant, deployment.deploymentId, false);
    const rolledBack = deployments.automaticRollbackIfUnhealthy(
      tenant,
      deployment.deploymentId,
      trafficGrant,
    );
    expect(rolledBack.state).toBe('rolled_back');
    expect(rolledBack.trafficPercent).toBe(0);
    expect(registry.auditRecords().some((record) => record.action === 'model.published')).toBe(
      true,
    );
    expect(
      deployments.auditRecords().some((record) => record.action === 'deployment.rollback'),
    ).toBe(true);
  });
});
