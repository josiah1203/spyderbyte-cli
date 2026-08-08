import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProviderRuntime } from '@agentic-platform/provider-runtime';
import {
  newSortableId,
  type ArtifactReference,
  type HashSha256,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import { handleLocalApiRequest, type LocalApiOptions } from '../src/index.js';

function options(rootPath: string): LocalApiOptions {
  const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
  return {
    orchestrator: {} as LocalApiOptions['orchestrator'],
    tenant,
    workspaceContext: { ...tenant, mode: 'personal_local' },
    providerRuntime: createProviderRuntime({ rootPath, useKeychain: false }),
  };
}

function artifact(tenant: TenantRef, artifactId = newSortableId()): ArtifactReference {
  return {
    schemaVersion: 1,
    tenant,
    artifactId,
    version: 1,
    contentHash: 'a'.repeat(64) as HashSha256,
    mediaType: 'application/json',
    sizeBytes: 1,
    createdAt: '2026-08-06T00:00:00.000Z',
  };
}

function experimentInput(tenant: TenantRef): Record<string, unknown> {
  return {
    name: 'API Phase 5 experiment',
    datasetVersion: artifact(tenant),
    target: 'label',
    features: ['feature_a', 'feature_b'],
    task: 'classification',
    algorithm: 'api-fixture-adapter',
    environmentRevision: artifact(tenant),
    compute: {
      cpuMillicores: 100,
      memoryBytes: 1024,
      gpuCount: 0,
      maxDurationMs: 1000,
      currency: 'USD',
    },
    metrics: [{ name: 'accuracy', higherIsBetter: true, requiredMinimum: 0.8 }],
    hyperparameters: { epochs: 1 },
    seed: 42,
    outputDestination: 'artifacts://api-phase5',
  };
}

describe('Phase 5 local API lifecycle surfaces', () => {
  it('creates, validates, lists, inspects, and archives reproducible experiments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-phase5-api-'));
    const api = options(root);
    const created = await handleLocalApiRequest(
      { method: 'POST', path: '/v1/experiments/local', body: experimentInput(api.tenant) },
      api,
    );
    expect(created.statusCode).toBe(201);
    const experimentId = (created.body as { experimentId: string }).experimentId;
    expect(created.body).toMatchObject({ state: 'draft', runIds: [], comparisonIds: [] });

    await expect(
      handleLocalApiRequest({ method: 'GET', path: '/v1/experiments/local' }, api),
    ).resolves.toMatchObject({
      statusCode: 200,
      body: { available: false, experiments: [expect.objectContaining({ experimentId })] },
    });
    await expect(
      handleLocalApiRequest(
        { method: 'POST', path: `/v1/experiments/local/${experimentId}/validate`, body: {} },
        api,
      ),
    ).resolves.toMatchObject({ statusCode: 200, body: { state: 'ready' } });
    await expect(
      handleLocalApiRequest({ method: 'GET', path: `/v1/experiments/local/${experimentId}` }, api),
    ).resolves.toMatchObject({ statusCode: 200, body: { state: 'ready' } });
    await expect(
      handleLocalApiRequest(
        { method: 'GET', path: `/v1/experiment-runs/local?experimentId=${experimentId}` },
        api,
      ),
    ).resolves.toMatchObject({ statusCode: 200, body: [] });
    await expect(
      handleLocalApiRequest(
        { method: 'POST', path: `/v1/experiments/local/${experimentId}/archive`, body: {} },
        api,
      ),
    ).resolves.toMatchObject({ statusCode: 200, body: { state: 'archived' } });
  });
});
