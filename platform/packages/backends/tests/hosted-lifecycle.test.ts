import { describe, expect, it } from 'vitest';
import {
  newSortableId,
  type ArtifactReference,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import {
  HostedDeploymentController,
  HostedExperimentBackend,
  HostedModelRegistry,
  InMemoryDeploymentController,
  InMemoryExperimentBackend,
  InMemoryModelRegistry,
  type ModelPublicationRequest,
} from '../src/index.js';

const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
const otherTenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };

function artifact(owner: TenantRef = tenant): ArtifactReference {
  return {
    schemaVersion: 1,
    tenant: owner,
    artifactId: newSortableId(),
    version: 1,
    contentHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    mediaType: 'application/json',
    sizeBytes: 1,
    createdAt: '2026-08-03T00:00:00.000Z',
  };
}

function modelLineage(checkpoint: ArtifactReference): ModelPublicationRequest['lineage'] {
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
          method: 'lora',
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
    validatedDataset: artifact(),
    originalDataLineage: [artifact()],
  };
}

function publication(checkpoint = artifact()): ModelPublicationRequest {
  return {
    tenant,
    modelName: 'hosted-fixture-model',
    candidateArtifact: checkpoint,
    lineage: modelLineage(checkpoint),
    evaluation: { recommendation: 'promote', evaluationArtifact: artifact() },
    policyApproved: true,
    approvalDigest: 'approval',
    commitApprovalDigest: 'approval',
  };
}

describe('hosted lifecycle adapters', () => {
  it('keeps experiment, registry, and deployment flows behind injected clients', async () => {
    const localExperiment = new InMemoryExperimentBackend();
    const experiment = new HostedExperimentBackend({
      createRun: (metadata) => localExperiment.createRun(metadata),
      logMetric: ({ run, metric }) => localExperiment.logMetric(run, metric),
      logArtifact: ({ run, artifact: value }) => localExperiment.logArtifact(run, value),
      registerCheckpoint: ({ run, checkpoint }) =>
        localExperiment.registerCheckpoint(run, checkpoint),
    });
    const run = await experiment.createRun({
      tenant,
      workflowId: newSortableId(),
      name: 'hosted-fixture',
      sourceRevision: 'git:fixture',
      dataset: artifact(),
    });
    await experiment.logMetric(run, {
      metricId: newSortableId(),
      name: 'accuracy',
      value: 0.9,
      unit: 'ratio',
      observedAt: '2026-08-03T00:00:00.000Z',
    });
    const checkpoint = await experiment.registerCheckpoint(run, artifact());

    const localRegistry = new InMemoryModelRegistry();
    const registry = new HostedModelRegistry({
      publish: (request) => Promise.resolve(localRegistry.publish(request)),
      list: ({ tenant: owner, modelName }) => Promise.resolve(localRegistry.list(owner, modelName)),
    });
    const model = await registry.publish({
      ...publication(checkpoint.artifact),
    });

    const localDeployments = new InMemoryDeploymentController();
    const deployments = new HostedDeploymentController({
      request: ({ tenant: owner, model: value }) =>
        Promise.resolve(localDeployments.request(owner, value)),
      advance: ({ tenant: owner, deploymentId, action, grant }) =>
        Promise.resolve(localDeployments.advance(owner, deploymentId, action, grant)),
      observeHealth: ({ tenant: owner, deploymentId, healthy }) =>
        Promise.resolve(localDeployments.observeHealth(owner, deploymentId, healthy)),
      automaticRollbackIfUnhealthy: ({ tenant: owner, deploymentId, grant }) =>
        Promise.resolve(localDeployments.automaticRollbackIfUnhealthy(owner, deploymentId, grant)),
      get: ({ tenant: owner, deploymentId }) =>
        Promise.resolve(localDeployments.get(owner, deploymentId)),
    });
    const deployment = await deployments.request(tenant, model);
    const grant = {
      approved: true,
      actionDigest: 'traffic',
      commitDigest: 'traffic',
      expiresAt: '2026-08-03T01:00:00.000Z',
      now: '2026-08-03T00:00:00.000Z',
    };
    await expect(
      deployments.advance(tenant, deployment.deploymentId, 'startCanary', {
        ...grant,
        expiresAt: 'not-a-date',
      }),
    ).rejects.toThrow('fresh bound approval');
    await deployments.advance(tenant, deployment.deploymentId, 'provision');
    await deployments.advance(tenant, deployment.deploymentId, 'smokePass');
    const canary = await deployments.advance(tenant, deployment.deploymentId, 'startCanary', grant);
    expect(canary.trafficPercent).toBe(10);
    expect(
      (await registry.list(tenant, model.modelName)).map((item) => item.modelVersionId),
    ).toEqual([model.modelVersionId]);
  });

  it('rejects a hosted registry response that crosses tenant scope', async () => {
    const local = new InMemoryModelRegistry();
    const model = local.publish(publication());
    const registry = new HostedModelRegistry({
      publish: async () => ({ ...model, tenant: otherTenant }),
      list: async () => [],
    });
    await expect(registry.publish(publication())).rejects.toThrow('invalid model');
  });

  it('rejects a hosted registry response with incomplete lineage', async () => {
    const local = new InMemoryModelRegistry();
    const model = local.publish(publication());
    const registry = new HostedModelRegistry({
      publish: async () => ({
        ...model,
        lineage: { ...model.lineage, originalDataLineage: [] },
      }),
      list: async () => [],
    });
    await expect(registry.publish(publication())).rejects.toThrow('invalid model');
  });

  it('rechecks publication approval before calling the hosted registry', async () => {
    let calls = 0;
    const registry = new HostedModelRegistry({
      publish: async (request) => {
        calls += 1;
        return new InMemoryModelRegistry().publish(request);
      },
      list: async () => [],
    });
    await expect(registry.publish({ ...publication(), policyApproved: false })).rejects.toThrow(
      'policy approval',
    );
    expect(calls).toBe(0);
  });
});
