import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newSortableId, type TenantRef } from '@agentic-platform/runtime-contracts';
import { LocalServingRuntime, servingActionDigest } from '@agentic-platform/provider-runtime';
import {
  handleLocalApiRequest,
  type LocalApiOptions,
  type LocalApiResponse,
} from '../src/index.js';

function body<T>(response: LocalApiResponse): T {
  return response.body as T;
}

function approval(
  deploymentId: string,
  action: 'canary' | 'promote' | 'rollback',
  input: Record<string, never> | { trafficPercent: number } = {},
): Record<string, unknown> {
  const digest = servingActionDigest(deploymentId, action, input);
  return {
    approved: true,
    actionDigest: digest,
    commitDigest: digest,
    expiresAt: '2026-08-07T01:00:00.000Z',
  };
}

describe('local API Phase 7 serving journey', () => {
  it('exposes endpoint management, telemetry, controlled rollout, invocation, and rollback', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'spyderbyte-phase7-api-'));
    const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
    const runtime = new LocalServingRuntime({
      rootPath,
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 10000)'],
      clock: () => '2026-08-07T00:00:00.000Z',
      fetcher: async (input) =>
        String(input).endsWith('/health')
          ? new Response('{}', { status: 200 })
          : new Response(JSON.stringify({ ok: true }), { status: 200 }),
    });
    const options: LocalApiOptions = {
      orchestrator: {} as LocalApiOptions['orchestrator'],
      tenant,
      providerRuntime: { serving: runtime } as LocalApiOptions['providerRuntime'],
      localSession: {
        tenant,
        actor: { actorId: newSortableId(), type: 'human', displayName: 'Phase 7 tester' },
      },
      clock: () => '2026-08-07T00:00:00.000Z',
    };

    const served = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/deployments/local/serve',
        body: {
          deploymentId: 'api-deployment-v1',
          endpointId: 'api-endpoint',
          endpointName: 'api-service',
          modelId: 'api-model',
          modelArtifactId: 'api-artifact-v1',
          servingRuntime: 'node-fixture',
          region: 'local',
          resources: { cpuMillicores: 250, memoryBytes: 1024 },
          scaling: { minReplicas: 1, maxReplicas: 2 },
          environment: { MODEL_ENV: 'test' },
          secretRefs: ['vault://api/key'],
          networkVisibility: 'loopback',
          auth: { mode: 'workspace' },
          healthCheck: { path: '/health' },
          rolloutPolicy: { strategy: 'canary', canaryPercent: 10 },
          port: 8129,
          healthUrl: 'http://127.0.0.1:8129/health',
          invokeUrl: 'http://127.0.0.1:8129',
        },
      },
      options,
    );
    expect(served.statusCode).toBe(202);
    const deploymentId = body<{ deploymentId: string }>(served).deploymentId;

    await expect(
      handleLocalApiRequest(
        { method: 'POST', path: `/v1/deployments/local/${deploymentId}/observe`, body: {} },
        options,
      ),
    ).resolves.toMatchObject({ statusCode: 200, body: { state: 'healthy' } });

    await expect(
      handleLocalApiRequest(
        {
          method: 'POST',
          path: `/v1/deployments/local/${deploymentId}/canary`,
          body: { trafficPercent: 10 },
        },
        options,
      ),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });

    const canary = await handleLocalApiRequest(
      {
        method: 'POST',
        path: `/v1/deployments/local/${deploymentId}/canary`,
        body: {
          trafficPercent: 10,
          approval: approval(deploymentId, 'canary', { trafficPercent: 10 }),
        },
      },
      options,
    );
    expect(canary).toMatchObject({ statusCode: 200, body: { trafficPercent: 10 } });

    await expect(
      handleLocalApiRequest(
        {
          method: 'POST',
          path: `/v1/deployments/local/${deploymentId}/promote`,
          body: { approval: approval(deploymentId, 'promote') },
        },
        options,
      ),
    ).resolves.toMatchObject({ statusCode: 200, body: { trafficPercent: 100 } });

    await expect(
      handleLocalApiRequest(
        {
          method: 'POST',
          path: `/v1/deployments/local/${deploymentId}/invoke`,
          body: { payload: { prompt: 'hello' } },
        },
        options,
      ),
    ).resolves.toMatchObject({ statusCode: 200, body: { success: true } });

    const updated = await handleLocalApiRequest(
      {
        method: 'POST',
        path: `/v1/deployments/local/${deploymentId}/update`,
        body: { modelArtifactId: 'api-artifact-v2', rolloutPolicy: { strategy: 'rolling' } },
      },
      options,
    );
    expect(updated).toMatchObject({
      statusCode: 202,
      body: { state: 'deploying', modelArtifactId: 'api-artifact-v2' },
    });
    const secondDeploymentId = body<{ deploymentId: string }>(updated).deploymentId;
    await expect(
      handleLocalApiRequest(
        { method: 'POST', path: `/v1/deployments/local/${secondDeploymentId}/observe`, body: {} },
        options,
      ),
    ).resolves.toMatchObject({ body: { state: 'healthy' } });
    await handleLocalApiRequest(
      {
        method: 'POST',
        path: `/v1/deployments/local/${secondDeploymentId}/promote`,
        body: { approval: approval(secondDeploymentId, 'promote') },
      },
      options,
    );

    await expect(
      handleLocalApiRequest(
        {
          method: 'GET',
          path: `/v1/deployments/local/${secondDeploymentId}/metrics`,
          body: undefined,
        },
        options,
      ),
    ).resolves.toMatchObject({ statusCode: 200, body: { requests: 0 } });
    await expect(
      handleLocalApiRequest(
        { method: 'GET', path: '/v1/deployments/local/endpoints', body: undefined },
        options,
      ),
    ).resolves.toMatchObject({ statusCode: 200, body: { endpoints: expect.any(Array) } });

    const rollback = await handleLocalApiRequest(
      {
        method: 'POST',
        path: `/v1/deployments/local/${secondDeploymentId}/rollback`,
        body: { approval: approval(secondDeploymentId, 'rollback') },
      },
      options,
    );
    expect(rollback).toMatchObject({
      statusCode: 200,
      body: { state: 'stopped', trafficPercent: 0 },
    });
  });
});
