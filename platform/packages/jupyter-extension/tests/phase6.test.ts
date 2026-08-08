import { describe, expect, it } from 'vitest';
import { SpyderbyteJupyterExtension } from '../src/index.js';

describe('Phase 6 JupyterLab context and reconnect integration', () => {
  it('propagates notebook/project context and exposes launch/reconnect operations', async () => {
    const requests: Array<{ readonly path: string; readonly body: unknown }> = [];
    const extension = new SpyderbyteJupyterExtension({
      baseUrl: 'http://127.0.0.1:8787',
      notebookId: 'notebook-phase6',
      projectId: 'project-phase6',
      projectPath: '/workspace/project',
      runtimeProfileId: 'runtime-local',
      apiToken: 'ephemeral',
      fetcher: async (input, init) => {
        const url = new URL(String(input));
        requests.push({
          path: url.pathname,
          body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        });
        return new Response('{}', { status: 200 });
      },
    });
    extension.setContext({ modelId: 'local-model' });
    await extension.launchSession({ mode: 'local' });
    await extension.runNotebook({ revision: 2 });
    await extension.reconnectSession('session-phase6');
    await extension.getSession('session-phase6');

    expect(requests.map((request) => request.path)).toEqual([
      '/v1/jupyter/sessions',
      '/v1/notebooks/notebook-phase6/run',
      '/v1/jupyter/sessions/session-phase6/reconnect',
      '/v1/jupyter/sessions/session-phase6',
    ]);
    expect(requests[0]?.body).toMatchObject({
      notebookId: 'notebook-phase6',
      projectId: 'project-phase6',
      context: { notebookId: 'notebook-phase6', modelId: 'local-model' },
    });
    expect(requests[1]?.body).toMatchObject({
      revision: 2,
      context: { projectPath: '/workspace/project', runtimeProfileId: 'runtime-local' },
    });
    expect(requests[2]?.body).toMatchObject({ context: { projectId: 'project-phase6' } });
  });
});
