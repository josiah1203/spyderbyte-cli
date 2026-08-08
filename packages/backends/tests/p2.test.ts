import { describe, expect, it } from 'vitest';
import {
  InMemoryCatalogBackend,
  InMemoryEvaluationBackend,
  InMemoryModelPromotionWorkflow,
  InMemoryModelRegistry,
  InMemoryStructuredExperimentBackend,
  modelPromotionDigest,
} from '../src/index.js';
import {
  newSortableId,
  type ArtifactReference,
  type HashSha256,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';

const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };

function artifact(owner: TenantRef = tenant, version = 1, uri?: string): ArtifactReference {
  return {
    schemaVersion: 1,
    tenant: owner,
    artifactId: newSortableId(),
    version,
    contentHash: 'a'.repeat(64) as HashSha256,
    mediaType: 'application/json',
    sizeBytes: 1,
    createdAt: '2026-08-06T00:00:00.000Z',
    ...(uri === undefined ? {} : { uri }),
  };
}

function experimentInput(experimentId: string) {
  const datasetVersion = artifact();
  return {
    schemaVersion: 1 as const,
    experimentId,
    tenant,
    name: `Experiment ${experimentId}`,
    datasetVersion,
    target: 'label',
    features: ['feature_a', 'feature_b'],
    task: 'classification' as const,
    algorithm: 'fixture-classifier',
    environmentRevision: artifact(),
    computeProfile: 'local-cpu',
    metricNames: ['accuracy'],
    hyperparameters: { learningRate: 0.1 },
    seed: 42,
    outputDestination: 'artifacts://experiments',
  };
}

function modelLineage(checkpoint: ArtifactReference, dataset: ArtifactReference) {
  return {
    checkpoint,
    trainingRun: {
      run: {
        runId: newSortableId(),
        tenant,
        externalRunId: `fixture-run-${newSortableId()}`,
      },
      configuration: {
        configId: 'fixture-config',
        strategy: {
          strategyId: 'fixture-strategy',
          baseModel: 'fixture-model',
          method: 'lora' as const,
          objective: 'classify',
          checkpointEverySteps: 1,
          earlyStopMetric: 'loss',
        },
        hyperparameters: { learningRate: 0.0001, microBatchSize: 1 },
        resources: { cpuMillicores: 100, memoryBytes: 1024, gpuCount: 0 },
        durationSeconds: 1,
      },
      sourceRevision: 'git:fixture',
      environmentSnapshot: artifact(),
    },
    validatedDataset: dataset,
    originalDataLineage: [dataset],
  };
}

describe('P2 backend contracts', () => {
  it('keeps structured experiments reproducible and comparable', async () => {
    const experiments = new InMemoryStructuredExperimentBackend({
      clock: () => '2026-08-06T00:00:00.000Z',
    });
    const first = await experiments.create(experimentInput('018f0c4b-4e50-7abc-8def-012345678901'));
    const second = await experiments.create(
      experimentInput('018f0c4b-4e50-7abc-8def-012345678902'),
    );
    await experiments.validate(tenant, first.experimentId);
    await experiments.validate(tenant, second.experimentId);
    await experiments.start(tenant, first.experimentId);
    await experiments.start(tenant, second.experimentId);
    await experiments.logMetric(tenant, first.experimentId, {
      metricId: newSortableId(),
      name: 'accuracy',
      value: 0.81,
      unit: 'ratio',
      observedAt: '2026-08-06T00:00:00.000Z',
    });
    await experiments.logMetric(tenant, second.experimentId, {
      metricId: newSortableId(),
      name: 'accuracy',
      value: 0.91,
      unit: 'ratio',
      observedAt: '2026-08-06T00:00:00.000Z',
    });
    await experiments.complete(tenant, first.experimentId);
    await experiments.complete(tenant, second.experimentId);
    const comparison = await experiments.compare(tenant, [first.experimentId, second.experimentId]);
    expect(comparison).toMatchObject({
      immutable: true,
      metrics: { accuracy: expect.any(Object) },
    });
    expect(comparison.metrics.accuracy[first.experimentId]).toBe(0.81);
    await expect(experiments.get(tenant, first.experimentId)).resolves.toMatchObject({
      state: 'compared',
      history: expect.arrayContaining([
        expect.objectContaining({ from: 'draft', to: 'validating' }),
        expect.objectContaining({ from: 'validating', to: 'ready' }),
        expect.objectContaining({ from: 'ready', to: 'running' }),
        expect.objectContaining({ from: 'running', to: 'completed' }),
      ]),
    });
  });

  it('evaluates immutable inputs and binds promotion to the evaluated candidate', async () => {
    const candidate = artifact();
    const dataset = artifact();
    const evaluation = new InMemoryEvaluationBackend({
      clock: () => '2026-08-06T00:00:00.000Z',
    });
    const result = await evaluation.evaluate({
      tenant,
      candidateArtifact: candidate,
      baselineArtifact: artifact(),
      datasetVersion: dataset,
      benchmarkId: 'fixture-benchmark',
      benchmarkVersion: 1,
      observations: [
        { expected: 1, candidate: 1, baseline: 0 },
        { expected: 1, candidate: 1, baseline: 1 },
        { expected: 0, candidate: 0, baseline: 1 },
      ],
      metrics: [{ name: 'accuracy', higherIsBetter: true, requiredMinimum: 0.8 }],
    });
    expect(result).toMatchObject({
      recommendation: 'promote',
      immutable: true,
      sampleSize: 3,
      evaluationArtifact: { contentHash: expect.stringMatching(/^sha256:/) },
    });
    const registry = new InMemoryModelRegistry();
    const model = registry.registerCandidate({
      tenant,
      modelName: 'fixture-model',
      candidateArtifact: candidate,
      lineage: modelLineage(candidate, dataset),
      evaluation: {
        recommendation: result.recommendation,
        evaluationArtifact: result.evaluationArtifact,
      },
    });
    const digest = modelPromotionDigest({
      tenant,
      modelVersionId: model.modelVersionId,
      evaluation: result,
      policyApproved: true,
    });
    const promotions = new InMemoryModelPromotionWorkflow(registry, {
      clock: () => '2026-08-06T00:00:00.000Z',
    });
    const decision = promotions.decide({
      tenant,
      modelVersionId: model.modelVersionId,
      evaluation: result,
      policyApproved: true,
      approvalDigest: digest,
      commitApprovalDigest: digest,
    });
    expect(decision).toMatchObject({ to: 'promoted', immutable: true, approvalDigest: digest });
    expect(registry.get(tenant, model.modelVersionId)).toMatchObject({ status: 'promoted' });
  });

  it('keeps catalog versions immutable and records parent lineage', async () => {
    const catalog = new InMemoryCatalogBackend(tenant, {
      clock: () => '2026-08-06T00:00:00.000Z',
    });
    const first = artifact(tenant, 1, 'dataset://fixture');
    catalog.registerDataset({
      reference: 'dataset://fixture',
      name: 'Fixture dataset',
      artifact: first,
      schema: { version: 1, fields: [{ name: 'label', type: 'string', nullable: false }] },
      classification: 'internal',
    });
    const second = artifact(tenant, 2, 'dataset://fixture');
    await catalog.publishDatasetVersion(second);
    await expect(catalog.resolveDatasetVersion('dataset://fixture', 1)).resolves.toMatchObject({
      artifact: first,
      immutable: true,
    });
    await expect(catalog.resolveDataset('dataset://fixture')).resolves.toMatchObject({
      artifact: second,
      lineage: [expect.objectContaining({ relation: 'derived-from', sourceVersion: 1 })],
    });
  });
});
