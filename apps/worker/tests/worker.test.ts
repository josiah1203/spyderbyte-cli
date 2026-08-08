import { describe, expect, it } from 'vitest';
import { newSortableId, type Workflow } from '@agentic-platform/runtime-contracts';
import { InMemoryStateStore } from '@agentic-platform/state';
import { DurableWorker } from '../src/index.js';

const tenant = { tenantId: newSortableId(), workspaceId: newSortableId() };
const workflowId = newSortableId();
const now = '2026-08-02T00:00:00.000Z';
const workflow: Workflow = {
  schemaVersion: 1,
  workflowId,
  tenant,
  objective: 'worker fixture',
  state: 'executing',
  planVersion: 1,
  createdAt: now,
  updatedAt: now,
  invocationIds: [],
  completionCriteria: [],
};

describe('DurableWorker', () => {
  it('recovers a pending activity with a replacement worker instance', async () => {
    const state = new InMemoryStateStore();
    await state.transaction((transaction) =>
      transaction.workflows.create(tenant, workflowId, workflow, now),
    );
    const first = new DurableWorker({ state, clock: () => now });
    const handle = await first.startWorkflow({
      tenant,
      workflowId,
      definitionVersion: 'worker.v1',
      now,
    });
    await first.schedule(handle, {
      activityId: 'activity-1',
      name: 'fixture',
      input: { ok: true },
      ownerTier: 2,
      maxAttempts: 1,
      retryableFailureCodes: [],
    });
    first.stop();
    const replacement = new DurableWorker({ state, clock: () => now });
    replacement.registerActivity('fixture', async () => ({ recovered: true }));
    const recovered = await replacement.recover(handle);
    expect(recovered.activity?.result).toEqual({ recovered: true });
  });
});
