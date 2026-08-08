import {
  HostedDurableEventTransport,
  InMemoryDurableEventTransport,
  type HostedEventClient,
} from '@agentic-platform/backends';
import type { RuntimeEvent, TenantRef } from '@agentic-platform/runtime-contracts';

export interface CloudEventPublisher {
  publish(event: RuntimeEvent, topic: string): Promise<void>;
  replay(tenant: TenantRef, topic: string): Promise<readonly RuntimeEvent[]>;
}

export class InMemoryCloudEventPublisher implements CloudEventPublisher {
  private readonly transport: InMemoryDurableEventTransport;
  private readonly clock: () => string;

  constructor(options: { readonly clock?: () => string } = {}) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.transport = new InMemoryDurableEventTransport();
  }

  async publish(event: RuntimeEvent, topic: string): Promise<void> {
    this.transport.publish(event, topic, this.clock());
  }

  async replay(tenant: TenantRef, topic: string): Promise<readonly RuntimeEvent[]> {
    return this.transport.replay(tenant, topic).map((message) => message.event);
  }
}

export class HostedCloudEventPublisher implements CloudEventPublisher {
  private readonly transport: HostedDurableEventTransport;

  constructor(options: { readonly client: HostedEventClient; readonly clock?: () => string }) {
    this.transport = new HostedDurableEventTransport(options);
  }

  async publish(event: RuntimeEvent, topic: string): Promise<void> {
    await this.transport.publish(event, topic);
  }

  async replay(tenant: TenantRef, topic: string): Promise<readonly RuntimeEvent[]> {
    const messages = await this.transport.replay(tenant, topic);
    return messages.map((message) => message.event);
  }
}
