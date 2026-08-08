import { describe, expect, it } from 'vitest';
import {
  newSortableId,
  type ArtifactReference,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import {
  InMemoryConnectorRegistry,
  InMemoryDeploymentController,
  InMemoryExperimentBackend,
  InMemoryLifecycleAuditLog,
  InMemoryModelRegistry,
} from '../src/index.js';

const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
const reference = (id = newSortableId()): ArtifactReference => ({
  schemaVersion: 1,
  tenant,
  artifactId: id,
  version: 1,
  contentHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  mediaType: 'application/json',
  sizeBytes: 1,
  createdAt: '2026-08-02T00:00:00.000Z',
});
const modelLineage = (checkpoint = reference(), validatedDataset = reference()) => ({
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
    environmentSnapshot: reference(),
  },
  validatedDataset,
  originalDataLineage: [reference()],
});

describe('lifecycle backends', () => {
  it('keeps experiment references and requires complete lineage for model publication', async () => {
    const experiment = new InMemoryExperimentBackend();
    const dataset = reference();
    const run = await experiment.createRun({
      tenant,
      workflowId: newSortableId(),
      name: 'fixture',
      sourceRevision: 'git:fixture',
      dataset,
    });
    await experiment.logMetric(run, {
      metricId: newSortableId(),
      name: 'accuracy',
      value: 0.8,
      unit: 'ratio',
      observedAt: '2026-08-02T00:00:00.000Z',
    });
    const checkpoint = reference();
    await experiment.registerCheckpoint(run, checkpoint);
    const registry = new InMemoryModelRegistry();
    const model = registry.publish({
      tenant,
      modelName: 'fixture-model',
      candidateArtifact: checkpoint,
      lineage: modelLineage(checkpoint, dataset),
      evaluation: { recommendation: 'promote', evaluationArtifact: reference() },
      policyApproved: true,
      approvalDigest: 'digest',
      commitApprovalDigest: 'digest',
    });
    expect(model.version).toBe(1);
  });

  it('rejects a lineage record that omits original data provenance', () => {
    const candidate = reference();
    const registry = new InMemoryModelRegistry();
    expect(() =>
      registry.publish({
        tenant,
        modelName: 'incomplete-model',
        candidateArtifact: candidate,
        lineage: { ...modelLineage(candidate), originalDataLineage: [] },
        evaluation: { recommendation: 'promote', evaluationArtifact: reference() },
        policyApproved: true,
        approvalDigest: 'digest',
        commitApprovalDigest: 'digest',
      }),
    ).toThrow('lineage is incomplete');
  });

  it('audits approval-bound canary rollback and connector revocation', () => {
    const audit = new InMemoryLifecycleAuditLog(() => '2026-08-02T00:00:00.000Z');
    const registry = new InMemoryModelRegistry({ audit });
    const candidate = reference();
    const model = registry.publish({
      tenant,
      modelName: 'fixture-model',
      candidateArtifact: candidate,
      lineage: modelLineage(candidate),
      evaluation: { recommendation: 'promote', evaluationArtifact: reference() },
      policyApproved: true,
      approvalDigest: 'digest',
      commitApprovalDigest: 'digest',
    });
    const deployments = new InMemoryDeploymentController({ audit });
    const deployment = deployments.request(tenant, model);
    const grant = {
      approved: true,
      actionDigest: 'traffic',
      commitDigest: 'traffic',
      expiresAt: '2026-08-02T01:00:00.000Z',
      now: '2026-08-02T00:00:00.000Z',
    };
    deployments.advance(tenant, deployment.deploymentId, 'provision');
    deployments.advance(tenant, deployment.deploymentId, 'smokePass');
    expect(() =>
      deployments.advance(tenant, deployment.deploymentId, 'startCanary', {
        ...grant,
        expiresAt: 'not-a-date',
      }),
    ).toThrow('fresh bound approval');
    deployments.advance(tenant, deployment.deploymentId, 'startCanary', grant);
    deployments.observeHealth(tenant, deployment.deploymentId, false);
    expect(
      deployments.automaticRollbackIfUnhealthy(tenant, deployment.deploymentId, grant).state,
    ).toBe('rolled_back');
    const connectors = new InMemoryConnectorRegistry({ audit });
    const connector = connectors.publish({
      tenant,
      name: 'fixture-read-only',
      sourceHash: 'source',
      scopeDigest: 'scope',
      authorAgentId: newSortableId(),
      publisherAgentId: newSortableId(),
      scansPassed: true,
      contractTestsPassed: true,
      governanceApproved: true,
      humanApproved: true,
      approvalDigest: 'connector',
      commitApprovalDigest: 'connector',
    });
    expect(connectors.revoke(tenant, connector.connectorId).state).toBe('revoked');
    expect(audit.list().map((record) => record.action)).toEqual([
      'model.published',
      'deployment.requested',
      'deployment.provision',
      'deployment.smokePass',
      'deployment.startCanary',
      'deployment.startCanary',
      'deployment.health.observed',
      'deployment.rollback',
      'connector.published',
      'connector.revoked',
    ]);
    expect(audit.list().every((record) => !JSON.stringify(record).includes('secret'))).toBe(true);
  });

  it('records denied lifecycle mutations without leaking approval material', () => {
    const audit = new InMemoryLifecycleAuditLog(() => '2026-08-02T00:00:00.000Z');
    const registry = new InMemoryModelRegistry({ audit });
    expect(() =>
      registry.publish({
        tenant,
        modelName: 'blocked-model',
        candidateArtifact: reference(),
        lineage: modelLineage(),
        evaluation: { recommendation: 'reject', evaluationArtifact: reference() },
        policyApproved: true,
        approvalDigest: 'approval-secret-digest',
        commitApprovalDigest: 'approval-secret-digest',
      }),
    ).toThrow('promote recommendation');
    const connectors = new InMemoryConnectorRegistry({ audit });
    expect(() =>
      connectors.publish({
        tenant,
        name: 'blocked-connector',
        sourceHash: 'source-secret-hash',
        scopeDigest: 'scope-secret-digest',
        authorAgentId: newSortableId(),
        publisherAgentId: newSortableId(),
        scansPassed: true,
        contractTestsPassed: true,
        governanceApproved: true,
        humanApproved: true,
        approvalDigest: 'old-digest',
        commitApprovalDigest: 'new-digest',
      }),
    ).toThrow('no longer matches');
    expect(audit.list().map((record) => record.outcome)).toEqual(['denied', 'denied']);
    expect(audit.list().every((record) => !JSON.stringify(record).includes('secret'))).toBe(true);
  });

  it('rejects deployment and connector mutations from another tenant', () => {
    const audit = new InMemoryLifecycleAuditLog(() => '2026-08-02T00:00:00.000Z');
    const registry = new InMemoryModelRegistry({ audit });
    const candidate = reference();
    const model = registry.publish({
      tenant,
      modelName: 'tenant-bound-model',
      candidateArtifact: candidate,
      lineage: modelLineage(candidate),
      evaluation: { recommendation: 'promote', evaluationArtifact: reference() },
      policyApproved: true,
      approvalDigest: 'digest',
      commitApprovalDigest: 'digest',
    });
    const deployments = new InMemoryDeploymentController({ audit });
    const deployment = deployments.request(tenant, model);
    const otherTenant: TenantRef = {
      tenantId: newSortableId(),
      workspaceId: newSortableId(),
    };
    expect(() => deployments.get(otherTenant, deployment.deploymentId)).toThrow('tenant scope');
    const connectors = new InMemoryConnectorRegistry({ audit });
    const connector = connectors.publish({
      tenant,
      name: 'tenant-bound-connector',
      sourceHash: 'source',
      scopeDigest: 'scope',
      authorAgentId: newSortableId(),
      publisherAgentId: newSortableId(),
      scansPassed: true,
      contractTestsPassed: true,
      governanceApproved: true,
      humanApproved: true,
      approvalDigest: 'connector',
      commitApprovalDigest: 'connector',
    });
    expect(() => connectors.revoke(otherTenant, connector.connectorId)).toThrow('tenant boundary');
  });
});
