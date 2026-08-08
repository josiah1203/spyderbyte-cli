import {
  isContract,
  newSortableId,
  parseContract,
  runtimeError,
  validateContract,
  type AgentInvocation,
  type AgentRegistration,
  type ApprovalRequest,
  type Artifact,
  type BudgetReservation,
  type JsonValue,
  type Project,
  type RuntimeCommand,
  type RuntimeEvent,
  type TenantRef,
  type Workflow,
} from '@agentic-platform/runtime-contracts';
import type {
  AggregateRepository,
  ArtifactVersionRepository,
  CommandDeduplicationRecord,
  EventStore,
  OutboxRecord,
  OutboxRepository,
  ProjectionCheckpoint,
  ProjectionCheckpointRepository,
  SideEffectReceipt,
  SideEffectReceiptRepository,
  StateStore,
  StateTransaction,
  StoredEvent,
  VersionedAggregate,
  PersistedArtifactVersion,
  InvocationRepository,
} from './ports.js';
import type { Id } from '@agentic-platform/runtime-contracts';

interface StoreData {
  aggregates: Map<string, VersionedAggregate<unknown>>;
  events: StoredEvent[];
  outbox: Map<string, OutboxRecord>;
  commands: Map<string, CommandDeduplicationRecord>;
  checkpoints: Map<string, ProjectionCheckpoint>;
  receipts: Map<string, SideEffectReceipt>;
  artifactVersions: Map<string, PersistedArtifactVersion>;
  nextStreamSequence: number;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function tenantKey(tenant: TenantRef): string {
  return `${tenant.tenantId}:${tenant.workspaceId}`;
}

function assertOutboxClaimInput(
  consumerId: string,
  claimExpiresAt: string,
  now: string,
  limit: number,
): void {
  if (consumerId.trim().length === 0) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Outbox consumer ID is required');
  }
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Outbox claim limit must be a positive integer');
  }
  const nowMs = Date.parse(now);
  const expiresMs = Date.parse(claimExpiresAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(expiresMs) || expiresMs <= nowMs) {
    throw runtimeError(
      'VALIDATION_INVALID_INPUT',
      'Outbox claim expiry must be a valid instant after the current time',
    );
  }
}

function assertOutboxOwnership(record: OutboxRecord, consumerId: string, now?: string): void {
  if (consumerId.trim().length === 0) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Outbox consumer ID is required');
  }
  const expiresAt = record.claimExpiresAt;
  const expired =
    now !== undefined &&
    (expiresAt === undefined ||
      !Number.isFinite(Date.parse(expiresAt)) ||
      Date.parse(expiresAt) <= Date.parse(now));
  if (record.claimedBy !== consumerId || expired) {
    throw runtimeError(
      'CONCURRENCY_STALE_VERSION',
      `Outbox record ${record.outboxId} is no longer actively claimed by ${consumerId}`,
    );
  }
}

function aggregateKey(tenant: TenantRef, aggregateType: string, id: Id): string {
  return `${tenantKey(tenant)}:${aggregateType}:${id}`;
}

function dedupKey(tenant: TenantRef, idempotencyKey: string): string {
  return `${tenantKey(tenant)}:${idempotencyKey}`;
}

function checkpointKey(tenant: TenantRef, projectionName: string): string {
  return `${tenantKey(tenant)}:${projectionName}`;
}

function receiptKey(tenant: TenantRef, effectKey: string): string {
  return `${tenantKey(tenant)}:${effectKey}`;
}

function artifactVersionKey(tenant: TenantRef, artifactId: Id, version: number): string {
  return `${tenantKey(tenant)}:artifact:${artifactId}:${version}`;
}

function emptyData(): StoreData {
  return {
    aggregates: new Map(),
    events: [],
    outbox: new Map(),
    commands: new Map(),
    checkpoints: new Map(),
    receipts: new Map(),
    artifactVersions: new Map(),
    nextStreamSequence: 0,
  };
}

function repository<T>(data: StoreData, aggregateType: string): AggregateRepository<T> {
  return {
    async get(tenant, id) {
      const value = data.aggregates.get(aggregateKey(tenant, aggregateType, id));
      return value ? clone(value as VersionedAggregate<T>) : undefined;
    },
    async create(tenant, id, value, updatedAt) {
      const key = aggregateKey(tenant, aggregateType, id);
      if (data.aggregates.has(key)) {
        throw runtimeError('CONCURRENCY_STALE_VERSION', `${aggregateType} ${id} already exists`);
      }
      const record: VersionedAggregate<T> = { tenant, id, version: 0, value, updatedAt };
      data.aggregates.set(key, clone(record));
      return clone(record);
    },
    async update(tenant, id, expectedVersion, value, updatedAt) {
      const key = aggregateKey(tenant, aggregateType, id);
      const existing = data.aggregates.get(key) as VersionedAggregate<T> | undefined;
      if (!existing || existing.version !== expectedVersion) {
        throw runtimeError(
          'CONCURRENCY_STALE_VERSION',
          `${aggregateType} ${id} expected version ${expectedVersion}, actual ${existing?.version ?? 'missing'}`,
        );
      }
      const record: VersionedAggregate<T> = {
        tenant,
        id,
        version: expectedVersion + 1,
        value,
        updatedAt,
      };
      data.aggregates.set(key, clone(record));
      return clone(record);
    },
  };
}

function eventStore(data: StoreData): EventStore {
  return {
    async append<TPayload extends JsonValue>(
      event: RuntimeEvent<TPayload>,
      expectedAggregateVersion: number,
    ) {
      if (!isContract('RuntimeEvent', event)) {
        const validation = validateContract('RuntimeEvent', event);
        throw runtimeError(
          'VALIDATION_SCHEMA_MISMATCH',
          `Event did not satisfy RuntimeEvent.v1${validation.errors.length > 0 ? `: ${validation.errors.map((error) => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`).join('; ')}` : `: ${JSON.stringify(event)}`}`,
        );
      }
      const aggregateEvents = data.events.filter(
        (stored) =>
          stored.event.tenant.tenantId === event.tenant.tenantId &&
          stored.event.tenant.workspaceId === event.tenant.workspaceId &&
          stored.event.aggregateType === event.aggregateType &&
          stored.event.aggregateId === event.aggregateId,
      );
      const actualVersion = aggregateEvents.at(-1)?.event.aggregateVersion ?? 0;
      if (actualVersion !== expectedAggregateVersion) {
        throw runtimeError(
          'CONCURRENCY_STALE_VERSION',
          `${event.aggregateType} ${event.aggregateId} expected event version ${expectedAggregateVersion}, actual ${actualVersion}`,
        );
      }
      const validated = parseContract('RuntimeEvent', event) as RuntimeEvent<TPayload>;
      const stored: StoredEvent<TPayload> = {
        streamSequence: data.nextStreamSequence + 1,
        event: {
          ...validated,
          aggregateVersion: actualVersion + 1,
        },
      };
      data.nextStreamSequence = stored.streamSequence;
      data.events.push(clone(stored));
      return clone(stored);
    },
    async list(tenant, afterStreamSequence = 0) {
      return clone(
        data.events.filter(
          (stored) =>
            stored.streamSequence > afterStreamSequence &&
            stored.event.tenant.tenantId === tenant.tenantId &&
            stored.event.tenant.workspaceId === tenant.workspaceId,
        ),
      );
    },
    async all() {
      return clone(data.events);
    },
  };
}

function outboxRepository(data: StoreData): OutboxRepository {
  return {
    async enqueue(event, topic, availableAt) {
      const existing = [...data.outbox.values()].find(
        (record) =>
          record.tenant.tenantId === event.tenant.tenantId &&
          record.tenant.workspaceId === event.tenant.workspaceId &&
          record.eventId === event.eventId,
      );
      if (existing) return clone(existing);
      const record: OutboxRecord = {
        outboxId: newSortableId(),
        tenant: event.tenant,
        eventId: event.eventId,
        topic,
        event: clone(event),
        availableAt,
        attempts: 0,
      };
      data.outbox.set(`${tenantKey(event.tenant)}:${record.outboxId}`, record);
      return clone(record);
    },
    async pending(tenant, now) {
      return clone(
        [...data.outbox.values()].filter(
          (record) =>
            record.tenant.tenantId === tenant.tenantId &&
            record.tenant.workspaceId === tenant.workspaceId &&
            !record.publishedAt &&
            record.availableAt <= now,
        ),
      );
    },
    async claimPending(tenant, now, consumerId, claimExpiresAt, limit) {
      assertOutboxClaimInput(consumerId, claimExpiresAt, now, limit);
      const records = [...data.outbox.values()]
        .filter(
          (record) =>
            record.tenant.tenantId === tenant.tenantId &&
            record.tenant.workspaceId === tenant.workspaceId &&
            !record.publishedAt &&
            record.availableAt <= now &&
            (record.claimedBy === undefined ||
              record.claimedBy === consumerId ||
              record.claimExpiresAt === undefined ||
              record.claimExpiresAt <= now),
        )
        .sort((left, right) =>
          `${left.availableAt}:${left.outboxId}`.localeCompare(
            `${right.availableAt}:${right.outboxId}`,
          ),
        )
        .slice(0, limit);
      for (const record of records) {
        record.claimedBy = consumerId;
        record.claimExpiresAt = claimExpiresAt;
      }
      return clone(records);
    },
    async markPublished(tenant, outboxId, publishedAt, consumerId, now) {
      const key = `${tenantKey(tenant)}:${outboxId}`;
      const record = data.outbox.get(key);
      if (!record)
        throw runtimeError('VALIDATION_INVALID_INPUT', `Outbox record ${outboxId} not found`);
      if (record.publishedAt) return;
      if (consumerId !== undefined) assertOutboxOwnership(record, consumerId, now);
      record.publishedAt = publishedAt;
      delete record.claimedBy;
      delete record.claimExpiresAt;
    },
    async incrementAttempt(tenant, outboxId, consumerId, now) {
      const key = `${tenantKey(tenant)}:${outboxId}`;
      const record = data.outbox.get(key);
      if (!record)
        throw runtimeError('VALIDATION_INVALID_INPUT', `Outbox record ${outboxId} not found`);
      if (consumerId !== undefined) assertOutboxOwnership(record, consumerId, now);
      record.attempts += 1;
    },
  };
}

function commandRepository(data: StoreData) {
  return {
    async reserve(command: RuntimeCommand, requestDigest: string, reservedAt: string) {
      const key = dedupKey(command.tenant, command.idempotencyKey);
      const existing = data.commands.get(key);
      if (existing) {
        if (existing.requestDigest !== requestDigest) {
          throw runtimeError(
            'VALIDATION_INVALID_INPUT',
            'Idempotency key was reused with a different request digest',
          );
        }
        return clone(existing);
      }
      const record: CommandDeduplicationRecord = {
        tenant: command.tenant,
        idempotencyKey: command.idempotencyKey,
        requestDigest,
        commandId: command.commandId,
        reservedAt,
      };
      data.commands.set(key, record);
      return clone(record);
    },
    async complete(
      tenant: TenantRef,
      idempotencyKey: string,
      result: JsonValue,
      completedAt: string,
    ) {
      const record = data.commands.get(dedupKey(tenant, idempotencyKey));
      if (!record)
        throw runtimeError('VALIDATION_INVALID_INPUT', 'Cannot complete an unreserved command');
      record.result = clone(result);
      record.completedAt = completedAt;
    },
    async get(tenant: TenantRef, idempotencyKey: string) {
      const record = data.commands.get(dedupKey(tenant, idempotencyKey));
      return record ? clone(record) : undefined;
    },
  };
}

function checkpointRepository(data: StoreData): ProjectionCheckpointRepository {
  return {
    async get(tenant, projectionName) {
      const record = data.checkpoints.get(checkpointKey(tenant, projectionName));
      return record ? clone(record) : undefined;
    },
    async save(checkpoint) {
      data.checkpoints.set(
        checkpointKey(checkpoint.tenant, checkpoint.projectionName),
        clone(checkpoint),
      );
    },
    async clear(tenant, projectionName) {
      data.checkpoints.delete(checkpointKey(tenant, projectionName));
    },
  };
}

function receiptRepository(data: StoreData): SideEffectReceiptRepository {
  return {
    async get(tenant, effectKey) {
      const record = data.receipts.get(receiptKey(tenant, effectKey));
      return record ? clone(record) : undefined;
    },
    async record(receipt) {
      const key = receiptKey(receipt.tenant, receipt.effectKey);
      const existing = data.receipts.get(key);
      if (existing) return clone(existing);
      data.receipts.set(key, clone(receipt));
      return clone(receipt);
    },
  };
}

function artifactVersionRepository(data: StoreData): ArtifactVersionRepository {
  const versionsFor = (tenant: TenantRef, artifactId?: Id): PersistedArtifactVersion[] =>
    [...data.artifactVersions.values()]
      .filter(
        (record) =>
          record.reference.tenant.tenantId === tenant.tenantId &&
          record.reference.tenant.workspaceId === tenant.workspaceId &&
          (artifactId === undefined || record.reference.artifactId === artifactId),
      )
      .sort((left, right) => left.reference.version - right.reference.version)
      .map((record) => clone(record));

  return {
    async get(tenant, artifactId, version) {
      const record = data.artifactVersions.get(artifactVersionKey(tenant, artifactId, version));
      return record ? clone(record) : undefined;
    },
    async current(tenant, artifactId) {
      return versionsFor(tenant, artifactId).at(-1);
    },
    async list(tenant, artifactId) {
      return versionsFor(tenant, artifactId);
    },
    async publish(record, expectedCurrentVersion) {
      const current = versionsFor(record.reference.tenant, record.reference.artifactId).at(-1);
      const actualVersion = current?.reference.version ?? 0;
      if (actualVersion !== expectedCurrentVersion) {
        throw runtimeError(
          'CONCURRENCY_STALE_VERSION',
          `Artifact ${record.reference.artifactId} expected parent ${expectedCurrentVersion}, actual ${actualVersion}`,
        );
      }
      if (record.reference.version !== expectedCurrentVersion + 1) {
        throw runtimeError(
          'CONCURRENCY_STALE_VERSION',
          `Artifact ${record.reference.artifactId} next version must be ${expectedCurrentVersion + 1}`,
        );
      }
      const key = artifactVersionKey(
        record.reference.tenant,
        record.reference.artifactId,
        record.reference.version,
      );
      if (data.artifactVersions.has(key)) {
        throw runtimeError(
          'CONCURRENCY_STALE_VERSION',
          `Artifact ${record.reference.artifactId}@${record.reference.version} already exists`,
        );
      }
      data.artifactVersions.set(key, clone(record));
    },
    async markStale(tenant, artifactId, version, updatedAt) {
      void updatedAt;
      const key = artifactVersionKey(tenant, artifactId, version);
      const record = data.artifactVersions.get(key);
      if (!record) {
        throw runtimeError(
          'ARTIFACT_NOT_FOUND',
          `Artifact ${artifactId}@${version} is unavailable`,
        );
      }
      if (record.state !== 'archived') record.state = 'stale';
    },
  };
}

function transaction(data: StoreData): StateTransaction {
  const baseInvocations = repository<AgentInvocation>(data, 'invocation');
  const invocations: InvocationRepository = {
    ...baseInvocations,
    async getForUpdate(tenant, invocationId) {
      return baseInvocations.get(tenant, invocationId);
    },
    async countChildren(tenant, parentInvocationId) {
      let count = 0;
      for (const aggregate of data.aggregates.values()) {
        if (!isContract('AgentInvocation', aggregate.value)) continue;
        if (
          aggregate.tenant.tenantId === tenant.tenantId &&
          aggregate.tenant.workspaceId === tenant.workspaceId &&
          aggregate.value.parentInvocationId === parentInvocationId
        ) {
          count += 1;
        }
      }
      return count;
    },
  };
  return {
    workflows: repository<Workflow>(data, 'workflow'),
    projects: repository<Project>(data, 'project'),
    invocations,
    artifacts: repository<Artifact>(data, 'artifact'),
    approvals: repository<ApprovalRequest>(data, 'approval'),
    budgets: repository<BudgetReservation>(data, 'budget'),
    agents: repository<AgentRegistration>(data, 'agent'),
    events: eventStore(data),
    outbox: outboxRepository(data),
    commands: commandRepository(data),
    checkpoints: checkpointRepository(data),
    receipts: receiptRepository(data),
    artifactVersions: artifactVersionRepository(data),
  };
}

export class InMemoryStateStore implements StateStore {
  private data = emptyData();
  private queue = Promise.resolve();

  async transaction<T>(work: (transaction: StateTransaction) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const draft = clone(this.data);
      const result = await work(transaction(draft));
      this.data = draft;
      return result;
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async snapshot(): Promise<{
    events: StoredEvent[];
    outbox: OutboxRecord[];
    commands: CommandDeduplicationRecord[];
    checkpoints: ProjectionCheckpoint[];
    receipts: SideEffectReceipt[];
  }> {
    return {
      events: clone(this.data.events),
      outbox: clone([...this.data.outbox.values()]),
      commands: clone([...this.data.commands.values()]),
      checkpoints: clone([...this.data.checkpoints.values()]),
      receipts: clone([...this.data.receipts.values()]),
    };
  }
}
