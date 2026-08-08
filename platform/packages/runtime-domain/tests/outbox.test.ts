import { describe, expect, it } from 'vitest';
import {
  newSortableId,
  type RuntimeEvent,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import { InMemoryStateStore } from '@agentic-platform/state';
import { TransactionalOutboxDispatcher, type OutboxTransport } from '../src/index.js';

const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
const now = '2026-08-07T00:00:00.000Z';

function event(): RuntimeEvent {
  const aggregateId = newSortableId();
  return {
    schemaVersion: 1,
    eventId: newSortableId(),
    eventName: 'workflow.outbox-fixture.v1',
    tenant,
    aggregateType: 'workflow',
    aggregateId,
    aggregateVersion: 1,
    occurredAt: now,
    actor: { actorId: newSortableId(), type: 'system' },
    correlationId: aggregateId,
    payload: { ok: true },
  };
}

async function enqueueEvent(state: InMemoryStateStore, received: RuntimeEvent): Promise<void> {
  await state.transaction(async (transaction) => {
    const stored = await transaction.events.append(received, 0);
    await transaction.outbox.enqueue(stored.event, 'runtime.events', now);
  });
}

describe('TransactionalOutboxDispatcher', () => {
  it('retries failed publication and acknowledges only after transport success', async () => {
    const state = new InMemoryStateStore();
    const received = event();
    await enqueueEvent(state, received);
    let attempts = 0;
    const published: string[] = [];
    const transport: OutboxTransport = {
      async publish(record) {
        attempts += 1;
        if (attempts === 1) throw new Error('transport unavailable');
        published.push(record.eventId);
      },
    };
    const dispatcher = new TransactionalOutboxDispatcher(state, transport, { clock: () => now });

    await expect(dispatcher.dispatch(tenant)).resolves.toMatchObject({
      inspected: 1,
      published: 0,
      failures: [{ stage: 'publish', attempts: 1, message: 'transport unavailable' }],
    });
    expect(
      await state.transaction((transaction) => transaction.outbox.pending(tenant, now)),
    ).toHaveLength(1);

    await expect(dispatcher.dispatch(tenant)).resolves.toMatchObject({
      inspected: 1,
      published: 1,
      failures: [],
    });
    expect(published).toEqual([received.eventId]);
    expect(
      await state.transaction((transaction) => transaction.outbox.pending(tenant, now)),
    ).toHaveLength(0);
    expect((await state.snapshot()).outbox[0]?.attempts).toBe(2);
  });

  it('bounds a batch, preserves tenant isolation, and avoids duplicate concurrent publication', async () => {
    const state = new InMemoryStateStore();
    const first = event();
    const second = event();
    await enqueueEvent(state, first);
    await enqueueEvent(state, second);
    let resolvePublish!: () => void;
    const publishStarted = new Promise<void>((resolve) => {
      resolvePublish = resolve;
    });
    const transport: OutboxTransport = {
      async publish() {
        resolvePublish();
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    };
    const dispatcher = new TransactionalOutboxDispatcher(state, transport, {
      clock: () => now,
      maxBatch: 1,
    });
    const firstDispatch = dispatcher.dispatch(tenant);
    await publishStarted;
    const concurrent = await dispatcher.dispatch(tenant);
    expect(concurrent).toMatchObject({ inspected: 1, published: 0, failures: [] });
    await firstDispatch;
    const remaining = await state.transaction((transaction) =>
      transaction.outbox.pending(tenant, now),
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.eventId).toBe(second.eventId);
  });

  it('reclaims an expired claim in a replacement dispatcher', async () => {
    const state = new InMemoryStateStore();
    const received = event();
    await enqueueEvent(state, received);
    const failureTransport: OutboxTransport = {
      async publish() {
        throw new Error('worker stopped');
      },
    };
    const firstDispatcher = new TransactionalOutboxDispatcher(state, failureTransport, {
      consumerId: 'worker-a',
      claimDurationMs: 1_000,
      clock: () => now,
    });
    await expect(firstDispatcher.dispatch(tenant)).resolves.toMatchObject({
      inspected: 1,
      published: 0,
      failures: [{ stage: 'publish', attempts: 1, message: 'worker stopped' }],
    });

    const published: string[] = [];
    const replacementDispatcher = new TransactionalOutboxDispatcher(
      state,
      {
        async publish(record) {
          published.push(record.eventId);
        },
      },
      {
        consumerId: 'worker-b',
        claimDurationMs: 1_000,
        clock: () => '2026-08-07T00:00:02.000Z',
      },
    );
    await expect(
      replacementDispatcher.dispatch(tenant, { now: '2026-08-07T00:00:02.000Z' }),
    ).resolves.toMatchObject({ inspected: 1, published: 1, failures: [] });
    expect(published).toEqual([received.eventId]);
    expect((await state.snapshot()).outbox[0]).toMatchObject({ attempts: 2 });
    expect((await state.snapshot()).outbox[0]?.claimedBy).toBeUndefined();
  });
});
