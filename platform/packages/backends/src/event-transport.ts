import {
  newSortableId,
  runtimeError,
  type Id,
  type RuntimeEvent,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';

export interface EventMessage {
  readonly messageId: Id;
  readonly tenant: TenantRef;
  readonly topic: string;
  readonly event: RuntimeEvent;
  readonly publishedAt: string;
  readonly deliveryCount: number;
  readonly state: 'available' | 'in_flight' | 'acked' | 'parked';
}

export interface EventConsumer {
  readonly consumerId: string;
  readonly tenant: TenantRef;
  readonly topic: string;
}

export interface HostedEventClient {
  publish(request: {
    readonly deduplicationKey: string;
    readonly message: EventMessage;
  }): Promise<EventMessage>;
  poll(consumer: EventConsumer, maxMessages: number): Promise<readonly EventMessage[]>;
  ack(consumer: EventConsumer, messageId: Id): Promise<void>;
  park(messageId: Id): Promise<void>;
  replay(tenant: TenantRef, topic: string): Promise<readonly EventMessage[]>;
  lag(consumer: EventConsumer): Promise<number>;
}

function eventKey(event: RuntimeEvent): string {
  return `${event.tenant.tenantId}:${event.tenant.workspaceId}:${event.eventId}`;
}

function assertHostedMessage(message: EventMessage, tenant: TenantRef, topic: string): void {
  if (
    message.tenant.tenantId !== tenant.tenantId ||
    message.tenant.workspaceId !== tenant.workspaceId ||
    message.topic !== topic
  ) {
    throw runtimeError(
      'VALIDATION_SCHEMA_MISMATCH',
      'Hosted event client returned an invalid message',
    );
  }
}

export class InMemoryDurableEventTransport {
  private readonly messages: EventMessage[] = [];
  private readonly clock: () => number;
  private readonly visibilityTimeoutMs: number;
  private readonly acknowledgedByConsumer = new Map<string, Set<Id>>();
  private readonly leasesByConsumer = new Map<string, Map<Id, number>>();

  constructor(options: { clock?: () => number; visibilityTimeoutMs?: number } = {}) {
    this.clock = options.clock ?? (() => Date.now());
    this.visibilityTimeoutMs = options.visibilityTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.visibilityTimeoutMs) || this.visibilityTimeoutMs < 1) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'Event visibility timeout must be a positive integer',
      );
    }
  }

  publish(event: RuntimeEvent, topic: string, publishedAt: string): EventMessage {
    if (topic.trim().length === 0)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Event topic is required');
    const key = `${event.tenant.tenantId}:${event.tenant.workspaceId}:${event.eventId}`;
    const existing = this.messages.find(
      (message) =>
        `${message.tenant.tenantId}:${message.tenant.workspaceId}:${message.event.eventId}` === key,
    );
    if (existing !== undefined) return structuredClone(existing);
    const message: EventMessage = {
      messageId: newSortableId(),
      tenant: event.tenant,
      topic,
      event: structuredClone(event),
      publishedAt,
      deliveryCount: 0,
      state: 'available',
    };
    this.messages.push(message);
    return structuredClone(message);
  }

  poll(consumer: EventConsumer, maxMessages = 10): EventMessage[] {
    if (maxMessages < 1)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Consumer batch size must be positive');
    const consumerKey = this.consumerKey(consumer);
    const acknowledged = this.acknowledgedByConsumer.get(consumerKey) ?? new Set<Id>();
    const leases = this.leasesByConsumer.get(consumerKey) ?? new Map<Id, number>();
    const now = this.clock();
    const selected = this.messages
      .filter((message) => {
        if (
          message.topic !== consumer.topic ||
          !sameTenant(message.tenant, consumer.tenant) ||
          message.state === 'parked' ||
          acknowledged.has(message.messageId)
        )
          return false;
        const leaseUntil = leases.get(message.messageId);
        return leaseUntil === undefined || leaseUntil <= now;
      })
      .slice(0, maxMessages);
    this.acknowledgedByConsumer.set(consumerKey, acknowledged);
    this.leasesByConsumer.set(consumerKey, leases);
    const delivered: EventMessage[] = [];
    for (const message of selected) {
      const index = this.messages.indexOf(message);
      const updated = {
        ...message,
        deliveryCount: message.deliveryCount + 1,
        state: 'in_flight',
      } satisfies EventMessage;
      this.messages[index] = updated;
      leases.set(message.messageId, now + this.visibilityTimeoutMs);
      delivered.push(updated);
    }
    return structuredClone(delivered);
  }

  ack(consumer: EventConsumer, messageId: Id): void {
    const index = this.messages.findIndex((message) => message.messageId === messageId);
    if (index < 0)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Event message ${messageId} was not found`);
    const message = this.messages[index];
    if (message === undefined)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Event message ${messageId} was not found`);
    if (!sameTenant(message.tenant, consumer.tenant) || message.topic !== consumer.topic)
      throw runtimeError('POLICY_DENIED', 'Consumer cannot acknowledge another tenant or topic');
    const consumerKey = this.consumerKey(consumer);
    const acknowledged = this.acknowledgedByConsumer.get(consumerKey) ?? new Set<Id>();
    acknowledged.add(messageId);
    this.acknowledgedByConsumer.set(consumerKey, acknowledged);
    this.leasesByConsumer.get(consumerKey)?.delete(messageId);
    this.messages[index] = { ...message, state: 'acked' };
  }

  park(messageId: Id): void {
    const index = this.messages.findIndex((message) => message.messageId === messageId);
    if (index < 0)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Event message ${messageId} was not found`);
    const message = this.messages[index];
    if (message === undefined)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Event message ${messageId} was not found`);
    this.messages[index] = { ...message, state: 'parked' };
    for (const leases of this.leasesByConsumer.values()) leases.delete(messageId);
  }

  replay(tenant: TenantRef, topic: string): EventMessage[] {
    return structuredClone(
      this.messages.filter(
        (message) => sameTenant(message.tenant, tenant) && message.topic === topic,
      ),
    );
  }

  lag(consumer: EventConsumer): number {
    const consumerKey = this.consumerKey(consumer);
    const acknowledged = this.acknowledgedByConsumer.get(consumerKey) ?? new Set<Id>();
    return this.messages.filter(
      (message) =>
        !acknowledged.has(message.messageId) &&
        sameTenant(message.tenant, consumer.tenant) &&
        message.topic === consumer.topic &&
        message.state !== 'parked',
    ).length;
  }

  private consumerKey(consumer: EventConsumer): string {
    return `${consumer.consumerId}:${consumer.tenant.tenantId}:${consumer.tenant.workspaceId}:${consumer.topic}`;
  }
}

export class HostedDurableEventTransport {
  private readonly client: HostedEventClient;
  private readonly clock: () => string;

  constructor(options: { client: HostedEventClient; clock?: () => string }) {
    this.client = options.client;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async publish(
    event: RuntimeEvent,
    topic: string,
    publishedAt = this.clock(),
  ): Promise<EventMessage> {
    if (topic.trim().length === 0)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Event topic is required');
    const message: EventMessage = {
      messageId: newSortableId(),
      tenant: event.tenant,
      topic,
      event: structuredClone(event),
      publishedAt,
      deliveryCount: 0,
      state: 'available',
    };
    const stored = await this.client.publish({
      deduplicationKey: eventKey(event),
      message,
    });
    assertHostedMessage(stored, event.tenant, topic);
    return structuredClone(stored);
  }

  async poll(consumer: EventConsumer, maxMessages = 10): Promise<EventMessage[]> {
    if (maxMessages < 1)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Consumer batch size must be positive');
    const messages = await this.client.poll(consumer, maxMessages);
    for (const message of messages) assertHostedMessage(message, consumer.tenant, consumer.topic);
    return [...structuredClone(messages)];
  }

  ack(consumer: EventConsumer, messageId: Id): Promise<void> {
    return this.client.ack(consumer, messageId);
  }

  park(messageId: Id): Promise<void> {
    return this.client.park(messageId);
  }

  async replay(tenant: TenantRef, topic: string): Promise<EventMessage[]> {
    const messages = await this.client.replay(tenant, topic);
    for (const message of messages) assertHostedMessage(message, tenant, topic);
    return [...structuredClone(messages)];
  }

  lag(consumer: EventConsumer): Promise<number> {
    return this.client.lag(consumer);
  }
}

function sameTenant(left: TenantRef, right: TenantRef): boolean {
  return left.tenantId === right.tenantId && left.workspaceId === right.workspaceId;
}
