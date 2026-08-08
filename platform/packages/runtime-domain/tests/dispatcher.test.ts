import { describe, expect, it } from 'vitest';
import {
  newSortableId,
  runtimeError,
  type Id,
  type RuntimeCommand,
  type RuntimeEvent,
  type TenantRef,
  type Workflow,
} from '@agentic-platform/runtime-contracts';
import { InMemoryStateStore } from '@agentic-platform/state';
import { CommandDispatcher, type CommandHandler } from '../src/index.js';

const tenant: TenantRef = {
  tenantId: '018f0c4b-4e30-7abc-8def-0123456789ab' as Id,
  workspaceId: '018f0c4b-4e31-7abc-8def-0123456789ab' as Id,
};
const otherTenant: TenantRef = {
  tenantId: '018f0c4b-4e32-7abc-8def-0123456789ab' as Id,
  workspaceId: '018f0c4b-4e33-7abc-8def-0123456789ab' as Id,
};
const workflowId = '018f0c4b-4e34-7abc-8def-0123456789ab' as Id;
const actor = {
  actorId: '018f0c4b-4e35-7abc-8def-0123456789ab' as Id,
  type: 'human' as const,
  displayName: 'Dispatcher tester',
};
const now = '2026-08-02T00:00:00.000Z';

function command(
  payload: RuntimeCommand['payload'] = { objective: 'Ship the dataset' },
): RuntimeCommand {
  return {
    schemaVersion: 1,
    commandId: newSortableId(),
    commandType: 'WorkflowStart',
    tenant,
    actor,
    issuedAt: now,
    idempotencyKey: 'workflow-start-1',
    correlationId: workflowId,
    payload,
  };
}

function event(
  eventName: string,
  eventTenant: TenantRef,
  version: number,
  payload: RuntimeEvent['payload'],
): RuntimeEvent {
  return {
    schemaVersion: 1,
    eventId: newSortableId(),
    eventName,
    tenant: eventTenant,
    aggregateType: 'workflow',
    aggregateId: workflowId,
    aggregateVersion: version,
    occurredAt: now,
    actor,
    correlationId: workflowId,
    payload,
  };
}

function workflowValue(): Workflow {
  return {
    schemaVersion: 1,
    workflowId,
    tenant,
    objective: 'Ship the dataset',
    state: 'planning',
    planVersion: 0,
    createdAt: now,
    updatedAt: now,
    invocationIds: [],
    completionCriteria: ['A report is accepted'],
  };
}

function handlerWith(events: readonly RuntimeEvent[], onHandle?: () => void): CommandHandler {
  return {
    commandType: 'WorkflowStart',
    async handle() {
      onHandle?.();
      return { result: { workflowId }, events };
    },
  };
}

describe('CommandDispatcher', () => {
  it('authorizes, commits aggregate changes with ordered events and outbox rows, and replays idempotently', async () => {
    const store = new InMemoryStateStore();
    const first = event('workflow.created.v1', tenant, 1, {
      objective: 'Ship the dataset',
      state: 'planning',
    });
    const second = event('workflow.state-changed.v1', tenant, 2, { state: 'executing' });
    let handled = 0;
    const dispatcher = new CommandDispatcher(store, (received) => {
      expect(received.tenant).toEqual(tenant);
    });
    dispatcher.register(
      handlerWith([first, second], () => {
        handled += 1;
      }),
    );

    const received = command();
    const firstResult = await dispatcher.dispatch(received);
    expect(firstResult.replayed).toBe(false);
    expect(firstResult.events).toHaveLength(2);
    expect(firstResult.events.map(({ event: stored }) => stored.aggregateVersion)).toEqual([1, 2]);
    expect(handled).toBe(1);

    const snapshot = await store.snapshot();
    expect(snapshot.events).toHaveLength(2);
    expect(snapshot.outbox).toHaveLength(2);
    expect(snapshot.commands[0]?.result).toEqual({ workflowId });

    const replay = await dispatcher.dispatch(received);
    expect(replay.replayed).toBe(true);
    expect(replay.result).toEqual({ workflowId });
    expect(replay.events).toEqual([]);
    expect(handled).toBe(1);
  });

  it('rejects a changed request digest for an existing idempotency key', async () => {
    const store = new InMemoryStateStore();
    const dispatcher = new CommandDispatcher(store);
    dispatcher.register(handlerWith([]));
    await dispatcher.dispatch(command());

    await expect(dispatcher.dispatch(command({ objective: 'Different request' }))).rejects.toThrow(
      'different request digest',
    );
    expect((await store.snapshot()).commands).toHaveLength(1);
  });

  it('rolls back reservations and aggregate writes when a handler violates tenant scope', async () => {
    const store = new InMemoryStateStore();
    const dispatcher = new CommandDispatcher(store);
    const crossTenantEvent = event('workflow.created.v1', otherTenant, 1, { state: 'planning' });
    dispatcher.register({
      commandType: 'WorkflowStart',
      async handle({ transaction }) {
        await transaction.workflows.create(tenant, workflowId, workflowValue(), now);
        return { result: { ok: true }, events: [crossTenantEvent] };
      },
    });

    await expect(dispatcher.dispatch(command())).rejects.toThrow('cross-tenant events');
    const snapshot = await store.snapshot();
    expect(snapshot.events).toHaveLength(0);
    expect(snapshot.outbox).toHaveLength(0);
    expect(snapshot.commands).toHaveLength(0);
    expect(
      await store.transaction((transaction) => transaction.workflows.get(tenant, workflowId)),
    ).toBeUndefined();
  });

  it('runs authorization before reserving a command', async () => {
    const store = new InMemoryStateStore();
    const dispatcher = new CommandDispatcher(store, () => {
      throw runtimeError('AUTHORITY_MISSING', 'test policy denied the command');
    });
    dispatcher.register(handlerWith([]));

    await expect(dispatcher.dispatch(command())).rejects.toThrow('test policy denied');
    const snapshot = await store.snapshot();
    expect(snapshot.commands).toHaveLength(0);
    expect(snapshot.events).toHaveLength(0);
  });

  it('serializes a burst of duplicate submissions to one durable handler execution', async () => {
    const store = new InMemoryStateStore();
    let handled = 0;
    const dispatcher = new CommandDispatcher(store);
    dispatcher.register(
      handlerWith([], () => {
        handled += 1;
      }),
    );
    const received = command();
    const results = await Promise.all(
      Array.from({ length: 32 }, () => dispatcher.dispatch(received)),
    );
    expect(handled).toBe(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(31);
    expect((await store.snapshot()).commands).toHaveLength(1);
  });
});
