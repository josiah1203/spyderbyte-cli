import { describe, expect, it } from 'vitest';
import { SpyderbyteJupyterExtension, createJupyterLabPlugin } from '../src/index.js';

describe('Spyderbyte Jupyter extension bridge', () => {
  it('routes cell execution and artifact publication through scoped API auth', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const extension = new SpyderbyteJupyterExtension({
      baseUrl: 'http://127.0.0.1:8787',
      notebookId: 'notebook-main',
      projectId: 'project-1',
      runtimeProfileId: 'python-local',
      apiToken: async () => 'short-lived-token',
      fetcher: async (input, init) => {
        requests.push({ url: String(input), init });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    await extension.runCell({ cellId: 'cell/1', type: 'python', source: 'print(1)' });
    await extension.publishArtifact('cell/1', 'sha256:artifact');
    expect(requests.map((request) => request.url)).toEqual([
      'http://127.0.0.1:8787/v1/notebooks/notebook-main/cells/cell%2F1/run',
      'http://127.0.0.1:8787/v1/notebooks/notebook-main/cells/cell%2F1/publish',
    ]);
    expect((requests[0]?.init?.headers as Record<string, string>).authorization).toBe(
      'Bearer short-lived-token',
    );
    expect(extension.getContext()).toMatchObject({
      schemaVersion: 1,
      notebookId: 'notebook-main',
      projectId: 'project-1',
      runtimeProfileId: 'python-local',
    });
  });

  it('registers context, runtime, run, and publish commands with the host', async () => {
    const commands = new Map<string, { execute: (args?: Record<string, never>) => unknown }>();
    const extension = new SpyderbyteJupyterExtension({
      baseUrl: 'http://127.0.0.1:8787',
      notebookId: 'notebook-main',
      apiToken: 'token',
      fetcher: async () => new Response('{}', { status: 200 }),
    });
    const plugin = createJupyterLabPlugin(extension);
    plugin.activate({
      commands: {
        addCommand(id, command) {
          commands.set(id, command as { execute: (args?: Record<string, never>) => unknown });
        },
      },
    });
    expect([...commands.keys()]).toEqual([
      'spyderbyte:show-context',
      'spyderbyte:launch-session',
      'spyderbyte:reconnect-session',
      'spyderbyte:load-runtime-profiles',
      'spyderbyte:run-cell',
      'spyderbyte:run-notebook',
      'spyderbyte:publish-artifact',
      'spyderbyte:browse-datasets',
      'spyderbyte:browse-data-connections',
      'spyderbyte:browse-data-schema',
      'spyderbyte:run-data-query',
      'spyderbyte:profile-dataset',
      'spyderbyte:quality-dataset',
      'spyderbyte:handoff-data-query',
      'spyderbyte:browse-models',
      'spyderbyte:list-approvals',
      'spyderbyte:show-usage',
      'spyderbyte:associate-experiment',
      'spyderbyte:list-experiment-runs',
      'spyderbyte:compare-experiments',
      'spyderbyte:list-deployments',
      'spyderbyte:inspect-deployment',
      'spyderbyte:invoke-deployment',
      'spyderbyte:smoke-test-deployment',
      'spyderbyte:deployment-metrics',
      'spyderbyte:deployment-revisions',
    ]);
    expect(await commands.get('spyderbyte:show-context')?.execute()).toMatchObject({
      notebookId: 'notebook-main',
    });
  });

  it('routes data discovery, bounded query, quality, and handoff calls through the API', async () => {
    const urls: string[] = [];
    const extension = new SpyderbyteJupyterExtension({
      baseUrl: 'http://127.0.0.1:8787',
      notebookId: 'notebook-main',
      apiToken: 'token',
      fetcher: async (input) => {
        urls.push(String(input));
        return new Response('{}', { status: 200 });
      },
    });
    await extension.listDataConnections();
    await extension.browseDataSchema('sales/connection');
    await extension.runDataQuery({ queryId: 'sales-query', sql: 'SELECT 1' });
    await extension.profileDataset('sales-dataset', 2);
    await extension.qualityDataset('sales-dataset', { requiredFields: ['id'] });
    await extension.handoffDataQuery('sales-query');
    expect(urls).toEqual([
      'http://127.0.0.1:8787/v1/data/connections',
      'http://127.0.0.1:8787/v1/data/connections/sales%2Fconnection/schema',
      'http://127.0.0.1:8787/v1/data/queries',
      'http://127.0.0.1:8787/v1/datasets/local/sales-dataset/profile',
      'http://127.0.0.1:8787/v1/datasets/local/sales-dataset/quality',
      'http://127.0.0.1:8787/v1/data/queries/sales-query/handoff',
    ]);
  });
});
