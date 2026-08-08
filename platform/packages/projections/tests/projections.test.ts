import { describe, expect, it } from 'vitest';
import {
  newSortableId,
  type Id,
  type JsonValue,
  type RuntimeEvent,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import { InMemoryStateStore, type StoredEvent } from '@agentic-platform/state';
import {
  artifactProjection,
  approvalProjection,
  auditProjection,
  budgetCostProjection,
  catalogProjection,
  chatProjection,
  connectorProjection,
  deploymentProjection,
  invocationProjection,
  modelProjection,
  ProjectionEngine,
  resourceProjection,
  type ProjectionDefinition,
  workflowProjection,
} from '../src/index.js';

const tenant: TenantRef = {
  tenantId: '018f0c4b-4e20-7abc-8def-0123456789ab' as Id,
  workspaceId: '018f0c4b-4e21-7abc-8def-0123456789ab' as Id,
};
const otherTenant: TenantRef = {
  tenantId: '018f0c4b-4e22-7abc-8def-0123456789ab' as Id,
  workspaceId: '018f0c4b-4e23-7abc-8def-0123456789ab' as Id,
};
const workflowId = '018f0c4b-4e24-7abc-8def-0123456789ab' as Id;
const otherWorkflowId = '018f0c4b-4e25-7abc-8def-0123456789ab' as Id;
const artifactId = '018f0c4b-4e26-7abc-8def-0123456789ab' as Id;
const approvalId = '018f0c4b-4e27-7abc-8def-0123456789ab' as Id;
const actor = {
  actorId: '018f0c4b-4e28-7abc-8def-0123456789ab' as Id,
  type: 'human' as const,
  displayName: 'Projection tester',
};
const time = '2026-08-02T00:00:00.000Z';
const later = '2026-08-02T00:01:00.000Z';

function eventFor(
  eventName: string,
  eventTenant: TenantRef,
  aggregateId: Id,
  aggregateType: string,
  aggregateVersion: number,
  payload: JsonValue,
  occurredAt = time,
): RuntimeEvent {
  return {
    schemaVersion: 1,
    eventId: newSortableId(),
    eventName,
    tenant: eventTenant,
    aggregateType,
    aggregateId,
    aggregateVersion,
    occurredAt,
    actor,
    correlationId: aggregateId,
    payload,
  };
}

async function appendEvents(
  store: InMemoryStateStore,
  events: Array<{ event: RuntimeEvent; expectedVersion: number }>,
): Promise<void> {
  await store.transaction(async (transaction) => {
    for (const item of events) {
      await transaction.events.append(item.event, item.expectedVersion);
    }
  });
}

describe('ProjectionEngine', () => {
  it('builds tenant-scoped workflow, job, artifact, approval, cost, and audit views', async () => {
    const store = new InMemoryStateStore();
    await appendEvents(store, [
      {
        event: eventFor('workflow.created.v1', tenant, workflowId, 'workflow', 1, {
          objective: 'Ship the dataset',
          state: 'planning',
        }),
        expectedVersion: 0,
      },
      {
        event: eventFor('workflow.created.v1', otherTenant, otherWorkflowId, 'workflow', 1, {
          objective: 'Other tenant',
          state: 'planning',
        }),
        expectedVersion: 0,
      },
      {
        event: eventFor(
          'workflow.state-changed.v1',
          tenant,
          workflowId,
          'workflow',
          2,
          { state: 'executing' },
          later,
        ),
        expectedVersion: 1,
      },
      {
        event: eventFor('artifact.published.v1', tenant, artifactId, 'artifact', 1, {
          version: 1,
          contentHash: 'a'.repeat(64),
          lineage: [],
        }),
        expectedVersion: 0,
      },
      {
        event: eventFor('approval.requested.v1', tenant, approvalId, 'approval', 1, {
          approvalId,
          state: 'pending',
          requestedBy: actor,
        }),
        expectedVersion: 0,
      },
      {
        event: eventFor('usage.recorded.v1', tenant, workflowId, 'usage', 1, {
          amountMinor: 7,
          currency: 'USD',
          source: 'model',
        }),
        expectedVersion: 0,
      },
    ]);

    const engine = new ProjectionEngine(store);
    const workflow = await engine.project(tenant, workflowProjection);
    expect(workflow.state.workflows[workflowId]).toMatchObject({
      state: 'executing',
      version: 2,
      objective: 'Ship the dataset',
    });
    expect(workflow.state.workflows[otherWorkflowId]).toBeUndefined();
    expect(workflow.cursor).toBe(6);
    expect(workflow.processedEventCount).toBe(5);
    expect(workflow.consumedEventCount).toBe(6);
    expect(workflow.lag).toBe(0);
    expect(workflow.stale).toBe(false);

    const invocation = await engine.project(tenant, invocationProjection);
    expect(invocation.state.jobs).toEqual({});
    const artifacts = await engine.project(tenant, artifactProjection);
    expect(artifacts.state.artifacts[artifactId]).toMatchObject({
      currentVersion: 1,
      state: 'valid',
      versions: { '1': { state: 'valid', contentHash: 'a'.repeat(64) } },
    });
    const approvals = await engine.project(tenant, approvalProjection);
    expect(approvals.state.queue[approvalId]).toMatchObject({
      state: 'pending',
      requestedBy: actor.actorId,
    });
    const costs = await engine.project(tenant, budgetCostProjection);
    expect(costs.state.totalsByCurrency).toEqual({ USD: 7 });
    expect(costs.state.observations).toHaveLength(1);
    const audit = await engine.project(tenant, auditProjection);
    expect(audit.state.entries).toHaveLength(5);
    expect(audit.state.entries.map((entry) => entry.eventName)).toEqual([
      'workflow.created.v1',
      'workflow.state-changed.v1',
      'artifact.published.v1',
      'approval.requested.v1',
      'usage.recorded.v1',
    ]);
  });

  it('is idempotent by checkpoint, reports lag, and rebuilds from the event stream', async () => {
    const store = new InMemoryStateStore();
    const firstEvent = eventFor('workflow.created.v1', tenant, workflowId, 'workflow', 1, {
      state: 'planning',
    });
    await appendEvents(store, [{ event: firstEvent, expectedVersion: 0 }]);
    const engine = new ProjectionEngine(store);

    const first = await engine.project(tenant, workflowProjection);
    expect(first.processedEventCount).toBe(1);
    const duplicateRun = await engine.project(tenant, workflowProjection);
    expect(duplicateRun.processedEventCount).toBe(0);
    expect(duplicateRun.consumedEventCount).toBe(0);
    expect(duplicateRun.state).toEqual(first.state);

    const secondEvent = eventFor(
      'workflow.state-changed.v1',
      tenant,
      workflowId,
      'workflow',
      2,
      { state: 'completed' },
      later,
    );
    await appendEvents(store, [{ event: secondEvent, expectedVersion: 1 }]);
    const caughtUp = await engine.project(tenant, workflowProjection);
    expect(caughtUp.processedEventCount).toBe(1);
    expect(caughtUp.lag).toBe(0);
    expect(caughtUp.state.workflows[workflowId]?.state).toBe('completed');

    const rebuilt = await engine.rebuild(tenant, workflowProjection);
    expect(rebuilt.state).toEqual(caughtUp.state);
    expect(rebuilt.processedEventCount).toBe(2);
    expect(rebuilt.cursor).toBe(caughtUp.cursor);
  });

  it('detects a missing stream sequence without advancing past the gap', async () => {
    const store = new InMemoryStateStore();
    const first = eventFor('workflow.created.v1', tenant, workflowId, 'workflow', 1, {
      state: 'planning',
    });
    const missing = eventFor('workflow.state-changed.v1', tenant, workflowId, 'workflow', 2, {
      state: 'executing',
    });
    const last = eventFor('workflow.completed.v1', tenant, workflowId, 'workflow', 3, {
      state: 'completed',
    });
    const sparse: StoredEvent[] = [
      { streamSequence: 1, event: first },
      { streamSequence: 3, event: last },
    ];
    const engine = new ProjectionEngine(store);

    await expect(engine.project(tenant, workflowProjection, { events: sparse })).rejects.toThrow(
      'expected stream sequence 2, received 3',
    );
    expect((await store.snapshot()).checkpoints[0]?.streamSequence).toBe(1);

    const recovered = await engine.project(tenant, workflowProjection, {
      events: [
        { streamSequence: 1, event: first },
        { streamSequence: 2, event: missing },
        { streamSequence: 3, event: last },
      ],
    });
    expect(recovered.state.workflows[workflowId]?.state).toBe('completed');
    expect(recovered.cursor).toBe(3);
  });

  it('resumes safely after a projector crash and rebuilds after a restart', async () => {
    const store = new InMemoryStateStore();
    const first = eventFor('workflow.created.v1', tenant, workflowId, 'workflow', 1, {
      state: 'planning',
    });
    const second = eventFor('workflow.state-changed.v1', tenant, workflowId, 'workflow', 2, {
      state: 'executing',
    });
    await appendEvents(store, [
      { event: first, expectedVersion: 0 },
      { event: second, expectedVersion: 1 },
    ]);

    const crashingProjection: ProjectionDefinition<{ labels: string[] }> = {
      name: 'crash-recovery',
      initialState: () => ({ labels: [] }),
      apply: (state, event) => {
        if (event.aggregateVersion === 2) throw new Error('projector crashed');
        return { labels: [...state.labels, event.eventName] };
      },
    };
    const engine = new ProjectionEngine(store);
    await expect(engine.project(tenant, crashingProjection)).rejects.toThrow('projector crashed');
    expect((await store.snapshot()).checkpoints[0]).toMatchObject({ streamSequence: 1 });

    const restarted = new ProjectionEngine(store);
    const recovered = await restarted.project(tenant, {
      ...crashingProjection,
      apply: (state, event) => ({ labels: [...state.labels, event.eventName] }),
    });
    expect(recovered.state.labels).toEqual(['workflow.created.v1', 'workflow.state-changed.v1']);
    expect(recovered.cursor).toBe(2);
  });

  it('builds tenant-scoped projections for catalog, model, deployment, connector, and chat panels', async () => {
    const store = new InMemoryStateStore();
    const datasetId = newSortableId();
    const modelId = newSortableId();
    const deploymentId = newSortableId();
    const connectorId = newSortableId();
    const sessionId = newSortableId();
    const foreignModelId = newSortableId();
    await appendEvents(store, [
      {
        event: eventFor('catalog.dataset-published.v1', tenant, datasetId, 'catalog', 1, {
          state: 'published',
          name: 'fixture-dataset',
        }),
        expectedVersion: 0,
      },
      {
        event: eventFor('model.published.v1', tenant, modelId, 'model', 1, {
          state: 'published',
          modelName: 'fixture-model',
        }),
        expectedVersion: 0,
      },
      {
        event: eventFor('deployment.start-canary.v1', tenant, deploymentId, 'deployment', 1, {
          state: 'canary',
          trafficPercent: 10,
        }),
        expectedVersion: 0,
      },
      {
        event: eventFor('connector.published.v1', tenant, connectorId, 'connector', 1, {
          state: 'published',
          name: 'fixture-connector',
        }),
        expectedVersion: 0,
      },
      {
        event: eventFor('chat.message-created.v1', tenant, sessionId, 'chat', 1, {
          state: 'active',
          message: 'hello',
        }),
        expectedVersion: 0,
      },
      {
        event: eventFor('model.published.v1', otherTenant, foreignModelId, 'model', 1, {
          state: 'published',
        }),
        expectedVersion: 0,
      },
    ]);

    const engine = new ProjectionEngine(store);
    expect(
      (await engine.project(tenant, catalogProjection)).state.datasets[datasetId],
    ).toMatchObject({
      state: 'published',
      name: 'fixture-dataset',
    });
    expect((await engine.project(tenant, modelProjection)).state.models[modelId]).toMatchObject({
      state: 'published',
      modelName: 'fixture-model',
    });
    expect(
      (await engine.project(tenant, deploymentProjection)).state.deployments[deploymentId],
    ).toMatchObject({ state: 'canary', trafficPercent: 10 });
    expect(
      (await engine.project(tenant, connectorProjection)).state.connectors[connectorId],
    ).toMatchObject({ state: 'published', name: 'fixture-connector' });
    expect((await engine.project(tenant, chatProjection)).state.sessions[sessionId]).toMatchObject({
      state: 'active',
      message: 'hello',
    });
    expect(
      (await engine.project(tenant, modelProjection)).state.models[foreignModelId],
    ).toBeUndefined();
  });

  it('projects generic parity resources from lifecycle events', async () => {
    const store = new InMemoryStateStore();
    const queryId = newSortableId();
    await appendEvents(store, [
      {
        event: eventFor('query.created.v1', tenant, queryId, 'resource', 1, {
          queryId,
          name: 'Revenue query',
          state: 'active',
        }),
        expectedVersion: 0,
      },
      {
        event: eventFor('query.updated.v1', tenant, queryId, 'resource', 2, {
          queryId,
          name: 'Updated revenue query',
        }),
        expectedVersion: 1,
      },
    ]);
    const snapshot = await new ProjectionEngine(store).project(
      tenant,
      resourceProjection('queries', 'query'),
    );
    expect(snapshot.state.items[queryId]).toMatchObject({
      queryId,
      name: 'Updated revenue query',
      state: 'active',
      version: 2,
    });
  });
});
