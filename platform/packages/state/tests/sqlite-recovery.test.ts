import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  newSortableId,
  type RuntimeEvent,
  type TenantRef,
  type Workflow,
} from '@agentic-platform/runtime-contracts';
import { SqliteStateStore, type SqliteDatabase } from '../src/index.js';

const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as {
  DatabaseSync: new (
    location: string,
    options?: { enableForeignKeyConstraints?: boolean },
  ) => SqliteDatabase & { close(): void };
};

const now = '2026-08-02T00:00:00.000Z';
const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };

async function migrate(database: SqliteDatabase): Promise<void> {
  const schema = await readFile(
    new URL('../migrations/0001_authoritative_state.sql', import.meta.url),
    'utf8',
  );
  const projectsMigration = await readFile(
    new URL('../migrations/0002_projects.sql', import.meta.url),
    'utf8',
  );
  const appendOnlyGuard = await readFile(
    new URL('../migrations/0001_append_only.sqlite.sql', import.meta.url),
    'utf8',
  );
  database.exec(schema);
  database.exec(projectsMigration);
  database.exec(appendOnlyGuard);
}

function workflow(workflowId: Workflow['workflowId']): Workflow {
  return {
    schemaVersion: 1,
    workflowId,
    tenant,
    objective: 'backup recovery fixture',
    state: 'executing',
    planVersion: 1,
    createdAt: now,
    updatedAt: now,
    invocationIds: [],
    completionCriteria: ['state survives restore'],
  };
}

function event(workflowId: Workflow['workflowId']): RuntimeEvent {
  return {
    schemaVersion: 1,
    eventId: newSortableId(),
    eventName: 'workflow.recovery-fixture.v1',
    tenant,
    aggregateType: 'workflow',
    aggregateId: workflowId,
    aggregateVersion: 1,
    occurredAt: now,
    actor: { actorId: newSortableId(), type: 'system' },
    correlationId: workflowId,
    payload: { restored: true },
  };
}

describe('SQLite recovery exercise', () => {
  it('restores committed workflow, event, and outbox state from a file snapshot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentic-state-recovery-'));
    const livePath = join(directory, 'live.sqlite');
    const backupPath = join(directory, 'backup.sqlite');
    let live: (SqliteDatabase & { close(): void }) | undefined;
    let restored: (SqliteDatabase & { close(): void }) | undefined;
    try {
      live = new DatabaseSync(livePath, { enableForeignKeyConstraints: true });
      await migrate(live);
      const store = new SqliteStateStore(live);
      const workflowId = newSortableId();
      await store.transaction(async (transaction) => {
        await transaction.workflows.create(tenant, workflowId, workflow(workflowId), now);
        const stored = await transaction.events.append(event(workflowId), 0);
        await transaction.outbox.enqueue(stored.event, 'runtime.events', now);
      });
      live.close();
      live = undefined;

      await copyFile(livePath, backupPath);
      restored = new DatabaseSync(backupPath, { enableForeignKeyConstraints: true });
      const restoredStore = new SqliteStateStore(restored);
      const snapshot = await restoredStore.transaction(async (transaction) => ({
        workflow: await transaction.workflows.get(tenant, workflowId),
        events: await transaction.events.list(tenant),
        outbox: await transaction.outbox.pending(tenant, now),
      }));
      expect(snapshot.workflow?.value.objective).toBe('backup recovery fixture');
      expect(snapshot.events).toHaveLength(1);
      expect(snapshot.events[0]?.event.eventName).toBe('workflow.recovery-fixture.v1');
      expect(snapshot.outbox).toHaveLength(1);
    } finally {
      restored?.close();
      live?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
