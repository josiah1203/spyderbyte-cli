import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LocalJupyterSessionRuntime,
  LocalNotebookRuntime,
  LocalQueryRuntime,
  LocalRuntimeProfileRuntime,
  type ManagedJupyterServerAdapter,
} from '../src/index.js';

describe('Phase 3 notebook resources', () => {
  it('supports lifecycle operations, immutable revisions, durable executions, and reproducible runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-phase3-notebook-'));
    const storePath = join(root, 'notebooks.json');
    const runtime = new LocalNotebookRuntime(
      new LocalQueryRuntime(),
      () => '2026-08-06T00:00:00.000Z',
      storePath,
    );
    const created = runtime.create({ notebookId: 'phase3-notebook', title: 'Analysis' });
    expect(created).toMatchObject({ revision: 1, state: 'draft' });
    const withCell = runtime.upsertCell({
      notebookId: created.notebookId,
      cellId: 'table',
      type: 'sql',
      source: 'SELECT category, COUNT(*) AS total FROM dataset GROUP BY category',
    });
    expect(withCell.revision).toBe(2);
    expect(runtime.versions(created.notebookId)).toHaveLength(2);

    const run = await runtime.runNotebook({
      notebookId: created.notebookId,
      revision: withCell.revision,
      sourceData: { columns: ['category'], rows: [['a'], ['a'], ['b']] },
      datasetVersion: 'dataset:v1',
      environmentRevisionId: 'environment:1',
      computeProfile: 'local-small',
      parameters: { limit: 10 },
    });
    expect(run.run).toMatchObject({
      state: 'completed',
      revision: 2,
      datasetVersion: 'dataset:v1',
      environmentRevisionId: 'environment:1',
    });
    expect(run.executions[0]).toMatchObject({
      state: 'completed',
      revision: 2,
      sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      outputReferences: [expect.objectContaining({ mediaType: 'application/json' })],
      resourceUsage: { costMinor: 0 },
    });
    expect(runtime.usage(created.notebookId).durationMs).toBeGreaterThanOrEqual(0);

    const renamed = runtime.rename(created.notebookId, 'Analysis v2');
    expect(renamed.title).toBe('Analysis v2');
    expect(runtime.archive(created.notebookId).state).toBe('archived');
    expect(() =>
      runtime.upsertCell({
        notebookId: created.notebookId,
        cellId: 'blocked',
        type: 'markdown',
        source: 'nope',
      }),
    ).toThrow('restored');
    expect(runtime.restore(created.notebookId).state).toBe('active');
    const copy = runtime.duplicate({
      notebookId: created.notebookId,
      newNotebookId: 'phase3-copy',
    });
    expect(copy.notebookId).toBe('phase3-copy');
    expect(runtime.associateExperiment(created.notebookId, 'experiment-1')).toMatchObject({
      experimentId: 'experiment-1',
    });

    const reloaded = new LocalNotebookRuntime(
      new LocalQueryRuntime(),
      () => '2026-08-06T00:00:00.000Z',
      storePath,
    );
    expect(reloaded.open(created.notebookId).title).toBe('Analysis v2');
    expect(reloaded.get(created.notebookId, 2)?.cells[0]?.source).toContain('SELECT');
    expect(reloaded.listExecutions(created.notebookId)).toHaveLength(1);
    expect(reloaded.getRun(run.run.runId)?.state).toBe('completed');
    expect(reloaded.experiments(created.notebookId)).toHaveLength(1);
  });
});

describe('Phase 3 Jupyter session lifecycle', () => {
  it('provisions managed sessions with scoped ephemeral credentials and recovers them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-phase3-managed-jupyter-'));
    const calls: string[] = [];
    const adapter: ManagedJupyterServerAdapter = {
      async launch(input) {
        calls.push(`launch:${input.sessionId}`);
        return { endpoint: 'https://managed.example/jupyter', kernelId: 'kernel-1' };
      },
      async stop() {
        calls.push('stop');
      },
      async interrupt() {
        calls.push('interrupt');
      },
      async restart() {
        calls.push('restart');
        return { endpoint: 'https://managed.example/jupyter', kernelId: 'kernel-2' };
      },
      async reconnect() {
        calls.push('reconnect');
        return { endpoint: 'https://managed.example/jupyter', kernelId: 'kernel-3' };
      },
    };
    const profiles = new LocalRuntimeProfileRuntime(root);
    const runtime = new LocalJupyterSessionRuntime({
      rootPath: root,
      profiles,
      managedServer: adapter,
    });
    const launched = await runtime.launch({
      mode: 'managed',
      projectPath: root,
      notebookId: 'phase3-notebook',
      projectId: 'project-1',
      environmentRevisionId: 'environment-1',
      computeProfile: 'standard',
    });
    expect(launched.session).toMatchObject({
      state: 'ready',
      serverMode: 'managed',
      projectId: 'project-1',
      kernelId: 'kernel-1',
      associatedRunIds: [],
    });
    expect(launched.accessUrl).toContain('token=');
    const stateFile = await readFile(join(root, '.agentic', 'jupyter-sessions.json'), 'utf8');
    expect(stateFile).not.toContain(launched.token);
    await runtime.interrupt(launched.session.sessionId);
    await runtime.restart(launched.session.sessionId);
    await runtime.reconnect(launched.session.sessionId);
    expect(calls).toEqual(expect.arrayContaining(['interrupt', 'restart', 'reconnect']));
    await runtime.stop(launched.session.sessionId);
    expect(calls).toContain('stop');
  });

  it('discovers local Jupyter, records a loopback-only endpoint, and idles out sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-phase3-local-jupyter-'));
    const executable = join(root, 'fake-jupyter');
    await writeFile(
      executable,
      '#!/usr/bin/env node\nif (process.argv.includes("--version")) { console.log("fake-jupyter 2.0"); process.exit(0); }\nsetTimeout(() => console.log("http://127.0.0.1:43129/lab"), 5);\nsetInterval(() => {}, 1000);\n',
      { mode: 0o755 },
    );
    await chmod(executable, 0o755);
    const profiles = new LocalRuntimeProfileRuntime(root);
    let current = '2026-08-06T00:00:00.000Z';
    const runtime = new LocalJupyterSessionRuntime({
      rootPath: root,
      profiles,
      executable,
      idleTimeoutMs: 1_000,
      clock: () => current,
    });
    await expect(runtime.discover()).resolves.toMatchObject({
      available: true,
      version: 'fake-jupyter 2.0',
    });
    const launched = await runtime.launch({ projectPath: root, idleTimeoutMs: 1_000 });
    expect(launched.session).toMatchObject({
      state: 'ready',
      serverMode: 'local',
      endpoint: 'http://127.0.0.1:43129',
    });
    current = '2026-08-06T00:00:02.000Z';
    await expect(runtime.sweepIdle()).resolves.toEqual([
      expect.objectContaining({ state: 'stopped' }),
    ]);
  });
});
