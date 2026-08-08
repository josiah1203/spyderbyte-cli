import { describe, expect, it } from 'vitest';
import { SpyderbyteJupyterExtension } from '../src/index.js';

describe('Phase 3 JupyterLab integration', () => {
  it('exposes notebook execution, browsers, usage, approvals, and experiment association through the API', async () => {
    const requests: string[] = [];
    const extension = new SpyderbyteJupyterExtension({
      baseUrl: 'http://127.0.0.1:8787',
      notebookId: 'notebook-phase3',
      apiToken: 'ephemeral',
      fetcher: async (input) => {
        requests.push(String(input));
        return new Response('{}', { status: 200 });
      },
    });
    await extension.runNotebook({ revision: 3 });
    await extension.listDatasets();
    await extension.listModels();
    await extension.listApprovals();
    await extension.getNotebookUsage();
    await extension.associateExperiment('experiment-1');
    expect(requests).toEqual([
      'http://127.0.0.1:8787/v1/notebooks/notebook-phase3/run',
      'http://127.0.0.1:8787/v1/datasets/local',
      'http://127.0.0.1:8787/v1/models/catalog',
      'http://127.0.0.1:8787/v1/approvals',
      'http://127.0.0.1:8787/v1/notebooks/notebook-phase3/usage',
      'http://127.0.0.1:8787/v1/notebooks/notebook-phase3/experiments',
    ]);
  });
});
