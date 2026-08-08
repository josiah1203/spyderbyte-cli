import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handleLocalApiRequest } from '@agentic-platform/local-api';
import { createProviderRuntime } from '@agentic-platform/provider-runtime';
import {
  newSortableId,
  type Actor,
  type Id,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import { createSqliteLocalDaemon } from '../src/index.js';

const now = '2026-08-07T00:00:00.000Z';
const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };

async function waitForRun(
  daemon: ReturnType<typeof createSqliteLocalDaemon>,
  runId: Id,
): Promise<Awaited<ReturnType<typeof daemon.conversation.readRun>>> {
  let detail = await daemon.conversation.readRun(tenant, runId);
  const terminal = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);
  for (let attempt = 0; attempt < 1_000 && !terminal.has(detail.run.state); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    detail = await daemon.conversation.readRun(tenant, runId);
  }
  return detail;
}

describe('Phase 5 disconnected local-first acceptance', () => {
  it('opens a clean workspace, streams a local Run, executes SQL/Python/notebook work, publishes an artifact, and resumes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-phase5-offline-'));
    const databasePath = join(root, 'state.sqlite');
    let externalCalls = 0;
    const disconnectedFetcher: typeof fetch = async () => {
      externalCalls += 1;
      throw new Error('network disconnected');
    };
    const providerRuntime = createProviderRuntime({
      rootPath: root,
      tenant,
      useKeychain: false,
      fetcher: disconnectedFetcher,
      clock: () => now,
    });
    const daemon = createSqliteLocalDaemon(databasePath, {
      providerRuntime,
      artifactRoot: join(root, 'objects'),
      clock: () => now,
    });
    const projectId = newSortableId();
    await daemon.state.transaction(async (transaction) => {
      await transaction.projects.create(
        tenant,
        projectId,
        {
          schemaVersion: 1,
          projectId,
          tenant,
          name: 'Offline project',
          objective: 'Prove local-first execution',
          state: 'active',
          createdAt: now,
          updatedAt: now,
        },
        now,
      );
    });
    const actor: Actor = { actorId: newSortableId(), type: 'human', displayName: 'Offline user' };
    const accepted = await daemon.conversation.send({
      tenant,
      projectId,
      actor,
      text: 'Answer locally and stream the result.',
    });
    const completed = await waitForRun(daemon, accepted.runId);
    expect(completed.run.state).toBe('succeeded');
    expect(completed.logs.some((line) => line.level === 'output')).toBe(true);
    expect(completed.attempts[0]).toMatchObject({
      state: 'succeeded',
      providerId: 'deterministic',
    });

    const api = {
      orchestrator: daemon.orchestrator,
      state: daemon.state,
      tenant,
      workspaceContext: { ...tenant, mode: 'personal_local' as const },
      providerRuntime,
      conversation: daemon.conversation,
    };
    await expect(
      handleLocalApiRequest(
        { method: 'GET', path: `/v1/projects/${projectId}/conversation`, body: undefined },
        api,
      ),
    ).resolves.toMatchObject({ statusCode: 200, body: { generating: false } });
    await expect(
      handleLocalApiRequest(
        { method: 'GET', path: `/v1/runs/${accepted.runId}/logs`, body: undefined },
        api,
      ),
    ).resolves.toMatchObject({ statusCode: 200, body: { runId: accepted.runId } });

    const sql = await providerRuntime.queries.execute({
      queryId: 'phase5-offline-sql',
      sql: 'SELECT id, value FROM dataset ORDER BY id',
      source: {
        tableName: 'dataset',
        columns: ['id', 'value'],
        rows: [
          [1, 10],
          [2, 20],
        ],
      },
    });
    expect(sql).toMatchObject({
      status: 'completed',
      rowCount: 2,
      rows: [
        [1, 10],
        [2, 20],
      ],
    });

    const notebookId = newSortableId();
    const notebook = providerRuntime.notebooks.create({ notebookId, title: 'Offline notebook' });
    const sqlCell = providerRuntime.notebooks.upsertCell({
      notebookId,
      cellId: 'sql-cell',
      type: 'sql',
      source: 'SELECT value FROM dataset ORDER BY value',
    });
    const sqlExecution = await providerRuntime.notebooks.runCell({
      notebookId,
      cellId: 'sql-cell',
      type: 'sql',
      source: sqlCell.cells[0]?.source ?? '',
      sourceData: { tableName: 'dataset', columns: ['value'], rows: [[10], [20]] },
    });
    expect(sqlExecution.execution.state).toBe('completed');
    const pythonCell = providerRuntime.notebooks.upsertCell({
      notebookId,
      cellId: 'python-cell',
      type: 'python',
      source: 'print("offline-python")',
    });
    const pythonExecution = await providerRuntime.notebooks.runCell({
      notebookId,
      cellId: 'python-cell',
      type: 'python',
      source: pythonCell.cells.find((cell) => cell.cellId === 'python-cell')?.source ?? '',
    });
    expect(pythonExecution.execution.state).toBe('completed');
    expect(pythonExecution.execution.artifactIds.length).toBeGreaterThan(0);
    expect(notebook.notebookId).toBe(notebookId);

    const staged = await daemon.artifacts.stageUpload(
      tenant,
      '{"offline":true}',
      'application/json',
      now,
    );
    const artifact = await daemon.artifacts.publish({
      tenant,
      artifactId: newSortableId(),
      stagedUploadId: staged.stagedUploadId,
      mediaType: 'application/json',
      createdBy: actor,
      now,
    });
    expect(artifact.record.reference.version).toBe(1);
    expect(artifact.record.reference.mediaType).toBe('application/json');

    daemon.close();
    const reopenedRuntime = createProviderRuntime({
      rootPath: root,
      tenant,
      useKeychain: false,
      fetcher: disconnectedFetcher,
      clock: () => now,
    });
    const reopened = createSqliteLocalDaemon(databasePath, {
      providerRuntime: reopenedRuntime,
      artifactRoot: join(root, 'objects'),
      clock: () => now,
    });
    const resumed = await reopened.conversation.read(tenant, projectId);
    expect(resumed.messages.some((message) => message.role === 'assistant')).toBe(true);
    expect(resumed.generating).toBe(false);
    reopened.close();
    expect(externalCalls).toBe(0);
  });
});
