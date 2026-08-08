import { describe, expect, it } from 'vitest';
import {
  HostedComputeBackend,
  HostedDurableEventTransport,
  HostedSecretBroker,
  InMemoryDurableEventTransport,
  ReferenceReadOnlyConnector,
  type ApprovedAllocationGrant,
  type CapacitySnapshot,
  type ComputeAllocation,
  type ComputeOffer,
  type EventConsumer,
  type EventMessage,
  type HostedEventClient,
  type HostedSchedulerClient,
  type HostedSecretManagerClient,
  type JobHandle,
  type JobObservation,
  type SecretHandle,
} from '../src/index.js';
import {
  makeMoney,
  newSortableId,
  type AuthorityEnvelope,
  type RuntimeEvent,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';

const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
const now = '2026-08-02T00:00:00.000Z';

const event: RuntimeEvent = {
  schemaVersion: 1,
  eventId: newSortableId(),
  eventName: 'workflow.created.v1',
  tenant,
  aggregateType: 'workflow',
  aggregateId: newSortableId(),
  aggregateVersion: 1,
  occurredAt: now,
  actor: { actorId: newSortableId(), type: 'system' },
  correlationId: newSortableId(),
  payload: { ok: true },
};

class EventClientFixture implements HostedEventClient {
  private readonly transport = new InMemoryDurableEventTransport();

  publish(request: {
    readonly deduplicationKey: string;
    readonly message: EventMessage;
  }): Promise<EventMessage> {
    return Promise.resolve(
      this.transport.publish(
        request.message.event,
        request.message.topic,
        request.message.publishedAt,
      ),
    );
  }

  poll(consumer: EventConsumer, maxMessages: number): Promise<readonly EventMessage[]> {
    return Promise.resolve(this.transport.poll(consumer, maxMessages));
  }

  ack(consumer: EventConsumer, messageId: string): Promise<void> {
    this.transport.ack(consumer, messageId as EventMessage['messageId']);
    return Promise.resolve();
  }

  park(messageId: string): Promise<void> {
    this.transport.park(messageId as EventMessage['messageId']);
    return Promise.resolve();
  }

  replay(tenantRef: TenantRef, topic: string): Promise<readonly EventMessage[]> {
    return Promise.resolve(this.transport.replay(tenantRef, topic));
  }

  lag(consumer: EventConsumer): Promise<number> {
    return Promise.resolve(this.transport.lag(consumer));
  }
}

class SecretClientFixture implements HostedSecretManagerClient {
  issued?: { tenant: TenantRef; secretName: string; operation: string; ttlMs: number };
  revoked?: string;
  readonly handle: SecretHandle = {
    handleId: newSortableId(),
    tenant,
    secretName: 'fixture-secret',
    operation: 'connector.read',
    expiresAt: '2026-08-02T01:00:00.000Z',
    scopeDigest: 'scope',
  };

  issue(input: {
    readonly tenant: TenantRef;
    readonly secretName: string;
    readonly operation: string;
    readonly ttlMs: number;
  }): Promise<SecretHandle> {
    this.issued = input;
    return Promise.resolve(this.handle);
  }

  resolve(): Promise<string> {
    return Promise.resolve('provider-secret');
  }

  revoke(handleId: string): Promise<void> {
    this.revoked = handleId;
    return Promise.resolve();
  }

  redact(value: string): Promise<string> {
    return Promise.resolve(value.replace('provider-secret', '[REDACTED]'));
  }
}

const backendId = 'scheduler-fixture';
const offer: ComputeOffer = {
  offerId: newSortableId(),
  backendId,
  tenant,
  resources: { cpuMillicores: 100, memoryBytes: 1024, gpuCount: 0 },
  estimatedCost: makeMoney(5, 'USD'),
  expiresAt: '2026-08-02T01:00:00.000Z',
  workloadName: 'hosted-fixture',
};

function authority(): AuthorityEnvelope {
  return {
    schemaVersion: 1,
    envelopeId: newSortableId(),
    tenant,
    issuer: { actorId: newSortableId(), type: 'system' },
    subjectAgentId: newSortableId(),
    workflowId: newSortableId(),
    invocationId: newSortableId(),
    tier: 1,
    harnessVersion: 'cluster.v1',
    permittedActions: ['compute.allocate'],
    capabilities: ['compute.hosted'],
    resourceScopes: [{ kind: 'compute', id: backendId }],
    allowedArtifactReads: [],
    allowedArtifactWrites: [],
    allowedChildAgentTypes: [],
    maxChildCount: 0,
    toolOperations: [],
    issuedAt: now,
    expiresAt: '2026-08-02T01:00:00.000Z',
    nonce: 'nonce',
    policyVersion: 'policy.v1',
    revocationEpoch: 0,
    integrityProof: 'a'.repeat(64),
  };
}

function grant(approved = true): ApprovedAllocationGrant {
  return {
    grantId: newSortableId(),
    offerId: offer.offerId,
    tenant,
    specialistType: 'cluster',
    tier: 1,
    authority: authority(),
    approved,
    approvalDigest: 'approval',
    budgetId: newSortableId(),
    estimatedCost: makeMoney(5, 'USD'),
    expiresAt: '2026-08-02T01:00:00.000Z',
  };
}

class SchedulerClientFixture implements HostedSchedulerClient {
  allocated = 0;
  readonly allocation: ComputeAllocation = {
    allocationId: newSortableId(),
    offer,
    grantId: newSortableId(),
    allocatedAt: now,
    state: 'allocated',
  };
  readonly job: JobHandle = {
    jobId: newSortableId(),
    allocationId: this.allocation.allocationId,
    submittedAt: now,
  };

  inspectCapacity(): Promise<CapacitySnapshot> {
    return Promise.resolve({
      backendId,
      observedAt: now,
      total: { cpuMillicores: 1000, memoryBytes: 1024 * 1024, gpuCount: 0 },
      free: { cpuMillicores: 1000, memoryBytes: 1024 * 1024, gpuCount: 0 },
    });
  }

  estimate(): Promise<readonly ComputeOffer[]> {
    return Promise.resolve([offer]);
  }

  allocate(): Promise<ComputeAllocation> {
    this.allocated += 1;
    return Promise.resolve(this.allocation);
  }

  submitJob(): Promise<JobHandle> {
    return Promise.resolve(this.job);
  }

  async *observeJob(): AsyncIterable<JobObservation> {
    yield {
      job: this.job,
      status: 'succeeded',
      observedAt: now,
      attempt: 1,
      stdout: 'ok',
      stderr: '',
    };
  }

  terminate(): Promise<void> {
    return Promise.resolve();
  }
}

describe('hosted adapter contracts', () => {
  it('preserves event deduplication, acknowledgement, and tenant/topic boundaries', async () => {
    const transport = new HostedDurableEventTransport({ client: new EventClientFixture() });
    const first = await transport.publish(event, 'runtime.events', now);
    expect((await transport.publish(event, 'runtime.events', now)).messageId).toBe(first.messageId);
    const consumer = { consumerId: 'projection', tenant, topic: 'runtime.events' };
    expect(await transport.poll(consumer)).toHaveLength(1);
    await transport.ack(consumer, first.messageId);
    await expect(transport.lag(consumer)).resolves.toBe(0);
  });

  it('keeps hosted secret values outside the issue request and audit records', async () => {
    const client = new SecretClientFixture();
    const broker = new HostedSecretBroker({ client, clock: () => now });
    const handle = await broker.issue({
      tenant,
      secretName: 'fixture-secret',
      operation: 'connector.read',
      ttlMs: 1_000,
    });
    expect(client.issued).not.toHaveProperty('value');
    expect(await broker.resolve(handle, tenant, 'connector.read')).toBe('provider-secret');
    expect(await broker.redact('token=provider-secret')).toBe('token=[REDACTED]');
    await broker.revoke(handle.handleId);
    expect(broker.auditRecords().every((record) => !('value' in record))).toBe(true);
    await expect(
      broker.resolve({ ...handle, expiresAt: now }, tenant, 'connector.read'),
    ).rejects.toThrow('Secret handle');
  });

  it('rechecks Cluster authority before delegating hosted allocation', async () => {
    const client = new SchedulerClientFixture();
    const backend = new HostedComputeBackend({
      client,
      backendId,
      clock: () => now,
    });
    await expect(backend.allocate(offer, grant(false))).rejects.toThrow('approved');
    expect(client.allocated).toBe(0);
    const allocation = await backend.allocate(offer, grant());
    expect(client.allocated).toBe(1);
    const job = await backend.submitJob(allocation, { command: 'fixture' });
    const observations: JobObservation[] = [];
    for await (const observation of backend.observeJob(job)) observations.push(observation);
    expect(observations.at(-1)?.status).toBe('succeeded');
  });

  it('handles read-only pagination, retryable rate limits, credential scope, and redaction', async () => {
    let calls = 0;
    const connector = new ReferenceReadOnlyConnector({
      connectorName: 'fixture-read-only',
      maxAttempts: 2,
      maxPageSize: 10,
      client: {
        async list() {
          calls += 1;
          if (calls === 1) throw Object.assign(new Error('rate limited'), { retryable: true });
          return { items: [{ id: 1, token: 'provider-secret' }], nextCursor: 'next' };
        },
      },
      redact: (value) => value.replace('provider-secret', '[REDACTED]'),
      clock: () => now,
    });
    const page = await connector.list(tenant, new SecretClientFixture().handle, { limit: 1 });
    expect(calls).toBe(2);
    expect(page).toEqual({ items: [{ id: 1, token: '[REDACTED]' }], nextCursor: 'next' });
    expect(connector.auditRecords().map((record) => record.outcome)).toEqual([
      'retrying',
      'succeeded',
    ]);
    await expect(
      connector.list(tenant, { ...new SecretClientFixture().handle, operation: 'connector.write' }),
    ).rejects.toThrow('read-only');
    await expect(
      connector.list(tenant, {
        ...new SecretClientFixture().handle,
        expiresAt: now,
      }),
    ).rejects.toThrow('expired');
  });
});
