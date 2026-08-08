import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProviderRuntime } from '@agentic-platform/provider-runtime';
import { newSortableId, type TenantRef } from '@agentic-platform/runtime-contracts';
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

describe('Phase 6 local API journey', () => {
  it('publishes, estimates, dry-runs, executes, inspects, and idempotently replays a pipeline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-phase6-api-'));
    const api = options(root);
    const created = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/pipelines/local',
        body: { pipelineId: 'api-phase6-pipeline', name: 'API Phase 6' },
      },
      api,
    );
    expect(created.statusCode).toBe(201);
    const definition = created.body as Record<string, unknown>;
    const upserted = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/pipelines/local/api-phase6-pipeline',
        body: {
          definition: {
            ...definition,
            stages: [
              {
                stageId: 'query',
                label: 'Query',
                type: 'query',
                dependsOn: [],
                config: { sql: 'SELECT 1 AS value', estimatedCostMinor: 1 },
              },
            ],
          },
        },
      },
      api,
    );
    expect(upserted.statusCode).toBe(200);
    await expect(
      handleLocalApiRequest(
        { method: 'POST', path: '/v1/pipelines/local/api-phase6-pipeline/publish', body: {} },
        api,
      ),
    ).resolves.toMatchObject({
      statusCode: 200,
      body: { digest: expect.stringMatching(/^sha256:/) },
    });
    await expect(
      handleLocalApiRequest(
        {
          method: 'GET',
          path: '/v1/pipelines/local/api-phase6-pipeline/versions',
          body: undefined,
        },
        api,
      ),
    ).resolves.toMatchObject({
      statusCode: 200,
      body: expect.arrayContaining([expect.objectContaining({ version: 2 })]),
    });
    await expect(
      handleLocalApiRequest(
        {
          method: 'GET',
          path: '/v1/pipelines/local/api-phase6-pipeline/estimate',
          body: undefined,
        },
        api,
      ),
    ).resolves.toMatchObject({ statusCode: 200, body: { costMinor: 1 } });
    await expect(
      handleLocalApiRequest(
        { method: 'POST', path: '/v1/pipelines/local/api-phase6-pipeline/dry-run', body: {} },
        api,
      ),
    ).resolves.toMatchObject({ statusCode: 200, body: { dryRun: true, status: 'completed' } });
    const first = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/pipelines/local/api-phase6-pipeline/run',
        body: { idempotencyKey: 'api-phase6-run', inputs: { source: 'fixture' } },
      },
      api,
    );
    const second = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/pipelines/local/api-phase6-pipeline/run',
        body: { idempotencyKey: 'api-phase6-run', inputs: { source: 'fixture' } },
      },
      api,
    );
    expect(first.statusCode).toBe(202);
    expect((second.body as { runId: string }).runId).toBe((first.body as { runId: string }).runId);
    await expect(
      handleLocalApiRequest(
        {
          method: 'GET',
          path: `/v1/pipelines/local/runs/${(first.body as { runId: string }).runId}`,
          body: undefined,
        },
        api,
      ),
    ).resolves.toMatchObject({
      statusCode: 200,
      body: { nodeLogs: expect.any(Array), usage: expect.any(Object) },
    });
  });

  it('exposes scheduler trigger and connector schema-event surfaces', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-phase6-api-triggers-'));
    const api = options(root);
    await handleLocalApiRequest(
      { method: 'POST', path: '/v1/pipelines/local', body: { pipelineId: 'trigger-pipeline' } },
      api,
    );
    const automation = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/automations/local',
        body: {
          automationId: 'data-arrival-automation',
          name: 'Data arrival automation',
          pipelineId: 'trigger-pipeline',
          trigger: { type: 'data-arrival', sourceRef: 'dataset://fixture', eventName: 'ready' },
        },
      },
      api,
    );
    expect(automation.statusCode).toBe(201);
    await expect(
      handleLocalApiRequest(
        {
          method: 'POST',
          path: '/v1/automations/data-arrivals',
          body: { sourceRef: 'dataset://fixture', eventName: 'ready', payload: { version: 1 } },
        },
        api,
      ),
    ).resolves.toMatchObject({
      statusCode: 202,
      body: [expect.objectContaining({ status: 'completed' })],
    });
    await expect(
      handleLocalApiRequest({ method: 'POST', path: '/v1/automations/tick', body: {} }, api),
    ).resolves.toMatchObject({ statusCode: 202, body: { status: 'processed' } });
    await expect(
      handleLocalApiRequest(
        { method: 'GET', path: '/v1/connector-schema-events', body: undefined },
        api,
      ),
    ).resolves.toMatchObject({ statusCode: 200, body: [] });
  });
});
