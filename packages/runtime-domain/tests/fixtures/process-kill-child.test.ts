import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  newSortableId,
  type TenantRef,
  type Workflow,
} from '../../../runtime-contracts/src/index.js';
import {
  DurableWorkflowEngine,
  type WorkflowHandle as EngineWorkflowHandle,
} from '../../src/index.js';
import { SqliteStateStore, type SqliteDatabase } from '../../../state/src/index.js';

const phase = process.env['RUNTIME_PROCESS_KILL_PHASE'];
const directory = process.env['RUNTIME_PROCESS_KILL_DIRECTORY'];

const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as {
  DatabaseSync: new (
    location: string,
    options?: { enableForeignKeyConstraints?: boolean },
  ) => SqliteDatabase & { close(): void };
};

async function openStore(databasePath: string): Promise<{
  database: SqliteDatabase & { close(): void };
  store: SqliteStateStore;
}> {
  const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
  database.exec(
    readFileSync(
      new URL('../../../state/migrations/0001_authoritative_state.sql', import.meta.url),
      'utf8',
    ),
  );
  database.exec(
    readFileSync(new URL('../../../state/migrations/0002_projects.sql', import.meta.url), 'utf8'),
  );
  database.exec(
    readFileSync(
      new URL('../../../state/migrations/0001_append_only.sqlite.sql', import.meta.url),
      'utf8',
    ),
  );
  return { database, store: new SqliteStateStore(database) };
}

describe.skipIf(phase === undefined)('process-kill recovery child', () => {
  it('prepares a durable activity and stays alive until killed', async () => {
    if (phase !== 'prepare' || directory === undefined) return;
    const databasePath = join(directory, 'workflow.sqlite');
    const startedPath = join(directory, 'started');
    const handlePath = join(directory, 'handle.json');
    const { database, store } = await openStore(databasePath);
    const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
    const workflowId = newSortableId();
    const now = '2026-08-03T00:00:00.000Z';
    const workflow: Workflow = {
      schemaVersion: 1,
      workflowId,
      tenant,
      objective: 'process-kill recovery fixture',
      state: 'executing',
      planVersion: 1,
      createdAt: now,
      updatedAt: now,
      invocationIds: [],
      completionCriteria: ['activity recovers after worker death'],
    };
    await store.transaction((transaction) =>
      transaction.workflows.create(tenant, workflowId, workflow, now),
    );
    const engine = new DurableWorkflowEngine({ state: store, clock: () => now });
    const handle = await engine.start({
      tenant,
      workflowId,
      definitionVersion: 'workflow.v1',
      now,
    });
    await engine.scheduleActivity(handle, {
      activityId: 'process-kill-activity',
      name: 'process-kill-activity',
      input: { fixture: true },
      ownerTier: 2,
      maxAttempts: 2,
      retryableFailureCodes: ['TRANSIENT'],
    });
    engine.registerActivity('process-kill-activity', async () => {
      await writeFile(startedPath, 'started');
      await new Promise<never>(() => undefined);
    });
    await writeFile(handlePath, JSON.stringify(handle));
    await engine.resumeAfterRestart(handle);
    database.close();
  });

  it('resumes the activity in a replacement process', async () => {
    if (phase !== 'recover' || directory === undefined) return;
    const databasePath = join(directory, 'workflow.sqlite');
    const handlePath = join(directory, 'handle.json');
    const resultPath = join(directory, 'result.json');
    const handle = JSON.parse(await readFile(handlePath, 'utf8')) as EngineWorkflowHandle;
    const { database, store } = await openStore(databasePath);
    const engine = new DurableWorkflowEngine({
      state: store,
      clock: () => '2026-08-03T00:00:01.000Z',
    });
    engine.registerActivity('process-kill-activity', async () => ({ recovered: true }));
    const result = await engine.resumeAfterRestart(handle);
    await writeFile(
      resultPath,
      JSON.stringify({
        status: result.status,
        activityStatus: result.activity?.status,
        recovered:
          result.activity?.result !== undefined &&
          typeof result.activity.result === 'object' &&
          result.activity.result !== null &&
          'recovered' in result.activity.result
            ? result.activity.result.recovered
            : undefined,
      }),
    );
    expect(result.activity?.status).toBe('succeeded');
    database.close();
  });
});
