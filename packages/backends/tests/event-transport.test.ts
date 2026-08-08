import { describe, expect, it } from 'vitest';
import { newSortableId, type RuntimeEvent } from '@agentic-platform/runtime-contracts';
import { InMemoryDurableEventTransport } from '../src/index.js';

const tenant = { tenantId: newSortableId(), workspaceId: newSortableId() };
const event: RuntimeEvent = {
  schemaVersion: 1,
  eventId: newSortableId(),
  eventName: 'workflow.created.v1',
  tenant,
  aggregateType: 'workflow',
  aggregateId: newSortableId(),
  aggregateVersion: 1,
  occurredAt: '2026-08-02T00:00:00.000Z',
  actor: { actorId: newSortableId(), type: 'system' },
  correlationId: newSortableId(),
  payload: { ok: true },
};

describe('InMemoryDurableEventTransport', () => {
  it('deduplicates publish, requires acknowledgement, and supports parking/replay', () => {
    const transport = new InMemoryDurableEventTransport();
    const first = transport.publish(event, 'runtime.events', event.occurredAt);
    expect(transport.publish(event, 'runtime.events', event.occurredAt).messageId).toBe(
      first.messageId,
    );
    const consumer = { consumerId: 'projection-1', tenant, topic: 'runtime.events' };
    expect(transport.poll(consumer)).toHaveLength(1);
    expect(transport.lag(consumer)).toBe(1);
    transport.ack(consumer, first.messageId);
    expect(transport.lag(consumer)).toBe(0);
    const second = transport.publish(
      { ...event, eventId: newSortableId(), aggregateVersion: 2 },
      'runtime.events',
      event.occurredAt,
    );
    transport.poll(consumer);
    transport.park(second.messageId);
    expect(
      transport
        .replay(tenant, 'runtime.events')
        .find((message) => message.messageId === second.messageId)?.state,
    ).toBe('parked');
  });

  it('redelivers expired leases without skipping out-of-order acknowledgements', () => {
    let now = 0;
    const transport = new InMemoryDurableEventTransport({
      clock: () => now,
      visibilityTimeoutMs: 10,
    });
    const first = transport.publish(event, 'runtime.events', event.occurredAt);
    const second = transport.publish(
      { ...event, eventId: newSortableId(), aggregateVersion: 2 },
      'runtime.events',
      event.occurredAt,
    );
    const consumer = { consumerId: 'recovery-worker', tenant, topic: 'runtime.events' };
    expect(transport.poll(consumer, 2).map((message) => message.messageId)).toEqual([
      first.messageId,
      second.messageId,
    ]);
    transport.ack(consumer, second.messageId);
    expect(transport.lag(consumer)).toBe(1);
    now = 11;
    expect(transport.poll(consumer)).toMatchObject([
      { messageId: first.messageId, deliveryCount: 2, state: 'in_flight' },
    ]);
    transport.ack(consumer, first.messageId);
    expect(transport.lag(consumer)).toBe(0);

    const replacementConsumer = {
      consumerId: 'replacement-worker',
      tenant,
      topic: 'runtime.events',
    };
    expect(transport.poll(replacementConsumer, 2)).toHaveLength(2);
  });
});
