import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LocalServingRuntime,
  servingActionDigest,
  type LocalServingApprovalV1,
} from '../src/index.js';

const now = '2026-08-07T00:00:00.000Z';

function approval(
  deploymentId: string,
  action: 'canary' | 'promote' | 'rollback',
  input: Record<string, never> | { trafficPercent: number } = {},
): LocalServingApprovalV1 {
  const digest = servingActionDigest(deploymentId, action, input);
  return {
    approved: true,
    actionDigest: digest,
    commitDigest: digest,
    expiresAt: '2026-08-07T01:00:00.000Z',
    approvalId: `approval-${action}`,
  };
}

describe('LocalServingRuntime Phase 7 lifecycle', () => {
  it('deploys, observes, invokes, updates, detects degradation, and rolls back a revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-phase7-serving-'));
    let healthy = true;
    const runtime = new LocalServingRuntime({
      rootPath: root,
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 10000)'],
      clock: () => now,
      fetcher: async (input) => {
        const url = String(input);
        if (url.endsWith('/health')) {
          return new Response(JSON.stringify({ healthy }), { status: healthy ? 200 : 503 });
        }
        return new Response(JSON.stringify({ modelVersionId: 'model-v1', ok: healthy }), {
          status: healthy ? 200 : 503,
        });
      },
    });

    const first = await runtime.serve({
      deploymentId: 'deployment-phase7-v1',
      endpointId: 'endpoint-phase7',
      endpointName: 'phase7-service',
      modelId: 'registered-model',
      modelVersionId: 'model-v1',
      modelArtifactId: 'artifact-v1',
      servingRuntime: 'node-fixture',
      region: 'local',
      resources: { cpuMillicores: 500, memoryBytes: 1024 * 1024, gpuCount: 0 },
      scaling: { minReplicas: 1, maxReplicas: 2, targetConcurrency: 4 },
      environment: { MODEL_ENV: 'phase7' },
      secretRefs: ['vault://serving/api-key'],
      networkVisibility: 'loopback',
      auth: { mode: 'workspace' },
      healthCheck: { path: '/health', intervalMs: 1000 },
      rolloutPolicy: { strategy: 'canary', canaryPercent: 10, autoRollbackOnDegraded: true },
      port: 8127,
      healthUrl: 'http://127.0.0.1:8127/health',
      invokeUrl: 'http://127.0.0.1:8127',
    });
    expect(first).toMatchObject({
      state: 'deploying',
      modelVersionId: 'model-v1',
      approvalRequired: true,
      revisionId: expect.any(String),
    });

    await expect(runtime.observe(first.deploymentId)).resolves.toMatchObject({
      state: 'healthy',
      healthEvidence: { adapter: process.execPath, statusCode: 200 },
    });
    await expect(
      runtime.invoke(first.deploymentId, { payload: { prompt: 'hello' } }),
    ).resolves.toMatchObject({
      success: true,
      modelVersionId: 'model-v1',
    });
    await expect(runtime.smokeTest(first.deploymentId)).resolves.toMatchObject({ passed: true });

    await expect(
      runtime.canary(
        first.deploymentId,
        10,
        approval(first.deploymentId, 'canary', { trafficPercent: 10 }),
      ),
    ).resolves.toMatchObject({
      trafficPercent: 10,
    });
    await expect(
      runtime.promote(first.deploymentId, approval(first.deploymentId, 'promote')),
    ).resolves.toMatchObject({
      trafficPercent: 100,
    });

    const second = await runtime.update(first.deploymentId, {
      modelVersionId: 'model-v2',
      modelArtifactId: 'artifact-v2',
      rolloutPolicy: { strategy: 'rolling', maxSurgePercent: 25 },
    });
    expect(second).toMatchObject({ state: 'deploying', modelVersionId: 'model-v2' });
    await expect(runtime.observe(second.deploymentId)).resolves.toMatchObject({ state: 'healthy' });
    await expect(
      runtime.promote(second.deploymentId, approval(second.deploymentId, 'promote')),
    ).resolves.toMatchObject({
      trafficPercent: 100,
    });

    healthy = false;
    await expect(runtime.observe(second.deploymentId)).resolves.toMatchObject({
      state: 'degraded',
      error: expect.any(String),
    });
    await expect(
      runtime.rollback(second.deploymentId, approval(second.deploymentId, 'rollback')),
    ).resolves.toMatchObject({
      state: 'stopped',
      trafficPercent: 0,
    });

    const endpoint = await runtime.getEndpoint('endpoint-phase7');
    expect(endpoint).toMatchObject({
      state: 'healthy',
      activeDeploymentId: first.deploymentId,
      trafficPercent: 100,
    });
    expect((await runtime.metrics(first.deploymentId)).requests).toBeGreaterThanOrEqual(2);
    expect((await runtime.logs(first.deploymentId)).length).toBeGreaterThan(0);
    expect(await runtime.revisions('endpoint-phase7')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ modelVersionId: 'model-v1' }),
        expect.objectContaining({ modelVersionId: 'model-v2' }),
      ]),
    );
    expect(await runtime.events()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'serve' }),
        expect.objectContaining({ action: 'invoke' }),
        expect.objectContaining({ action: 'rollback' }),
      ]),
    );

    const recovered = new LocalServingRuntime({
      rootPath: root,
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 10000)'],
      clock: () => now,
    });
    await expect(recovered.list()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ deploymentId: first.deploymentId, state: 'degraded' }),
      ]),
    );
  });

  it('does not claim health without an adapter or health evidence and rejects stale approval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-phase7-serving-gate-'));
    const unavailable = new LocalServingRuntime({ rootPath: root, clock: () => now });
    await expect(
      unavailable.serve({
        modelId: 'model',
        modelVersionId: 'version',
        healthUrl: 'http://127.0.0.1:8128/health',
      }),
    ).rejects.toMatchObject({ code: 'COMPUTE_RESOURCE_UNAVAILABLE' });

    const rootPath = await mkdtemp(join(tmpdir(), 'spyderbyte-phase7-serving-approval-'));
    const runtime = new LocalServingRuntime({
      rootPath,
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 5000)'],
      clock: () => now,
      fetcher: async () => new Response('{}', { status: 200 }),
    });
    const deployment = await runtime.serve({
      deploymentId: 'deployment-approval',
      endpointId: 'endpoint-approval',
      modelId: 'model',
      modelVersionId: 'version',
      port: 8128,
      healthUrl: 'http://127.0.0.1:8128/health',
    });
    await expect(runtime.observe(deployment.deploymentId)).resolves.toMatchObject({
      state: 'healthy',
    });
    await expect(runtime.canary(deployment.deploymentId, 10)).rejects.toMatchObject({
      code: 'APPROVAL_REQUIRED',
    });
    await expect(
      runtime.canary(deployment.deploymentId, 10, {
        ...approval(deployment.deploymentId, 'canary', { trafficPercent: 10 }),
        commitDigest: 'sha256:stale',
      }),
    ).rejects.toMatchObject({ code: 'APPROVAL_INVALIDATED' });
    await runtime.stop(deployment.deploymentId);
    const reloaded = new LocalServingRuntime({
      rootPath,
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 5000)'],
      clock: () => now,
    });
    await expect(reloaded.list()).resolves.toMatchObject([
      { deploymentId: 'deployment-approval', state: 'stopped' },
    ]);
  });
});
