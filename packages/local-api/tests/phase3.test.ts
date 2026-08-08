import { describe, expect, it } from 'vitest';
import { LocalNotebookRuntime, LocalQueryRuntime } from '@agentic-platform/provider-runtime';
import { handleLocalApiRequest, type LocalApiOptions } from '../src/index.js';

describe('Phase 3 notebook API journey', () => {
  it('supports create, open, execute, publish inputs, lineage records, and close/reopen lifecycle', async () => {
    const notebooks = new LocalNotebookRuntime(new LocalQueryRuntime());
    const api = {
      orchestrator: {} as LocalApiOptions['orchestrator'],
      tenant: {
        tenantId: '018f0c4b-4e90-7abc-8def-0123456789ab',
        workspaceId: '018f0c4b-4e91-7abc-8def-0123456789ab',
      },
      providerRuntime: { notebooks },
    } as LocalApiOptions;

    const created = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/notebooks',
        body: { notebookId: 'api-notebook', title: 'API analysis' },
      },
      api,
    );
    expect(created.statusCode).toBe(201);
    const upserted = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/notebooks/api-notebook/cells/table',
        body: {
          type: 'sql',
          source: 'SELECT category, COUNT(*) AS total FROM dataset GROUP BY category',
        },
      },
      api,
    );
    expect(upserted.body).toMatchObject({ revision: 2 });
    const run = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/notebooks/api-notebook/run',
        body: {
          revision: 2,
          sourceData: { columns: ['category'], rows: [['a'], ['a'], ['b']] },
          datasetVersion: 'dataset:v1',
        },
      },
      api,
    );
    expect(run.statusCode).toBe(202);
    expect(run.body).toMatchObject({ run: { state: 'completed', revision: 2 } });

    const versions = await handleLocalApiRequest(
      { method: 'GET', path: '/v1/notebooks/api-notebook/versions', body: undefined },
      api,
    );
    expect(versions.body).toHaveLength(2);
    const executions = await handleLocalApiRequest(
      { method: 'GET', path: '/v1/notebooks/api-notebook/executions', body: undefined },
      api,
    );
    expect(executions.body).toMatchObject([
      { sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/), state: 'completed' },
    ]);
    const usage = await handleLocalApiRequest(
      { method: 'GET', path: '/v1/notebooks/api-notebook/usage', body: undefined },
      api,
    );
    expect(usage.body).toMatchObject({ durationMs: expect.any(Number), costMinor: 0 });

    const archived = await handleLocalApiRequest(
      { method: 'POST', path: '/v1/notebooks/api-notebook/archive', body: {} },
      api,
    );
    expect(archived.body).toMatchObject({ state: 'archived' });
    const restored = await handleLocalApiRequest(
      { method: 'POST', path: '/v1/notebooks/api-notebook/restore', body: {} },
      api,
    );
    expect(restored.body).toMatchObject({ state: 'active' });
    const associated = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/notebooks/api-notebook/experiments',
        body: { experimentId: 'experiment-1' },
      },
      api,
    );
    expect(associated.body).toMatchObject({
      notebookId: 'api-notebook',
      experimentId: 'experiment-1',
    });
  });
});
