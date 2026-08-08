import { runtimeError, type TenantRef } from '@agentic-platform/runtime-contracts';
import type { ProjectionCheckpoint, StateStore, StoredEvent } from '@agentic-platform/state';

export interface ProjectionDefinition<TState> {
  readonly name: string;
  initialState(): TState;
  apply(state: TState, event: StoredEvent['event']): TState;
}

export interface ProjectionRunOptions {
  readonly events?: readonly StoredEvent[];
  readonly now?: string;
}

export interface ProjectionSnapshot<TState> {
  readonly projectionName: string;
  readonly tenant: TenantRef;
  readonly state: TState;
  readonly checkpoint: ProjectionCheckpoint | undefined;
  readonly cursor: number;
  readonly streamHead: number;
  readonly lag: number;
  readonly stale: boolean;
  readonly processedEventCount: number;
  readonly consumedEventCount: number;
  readonly lastAppliedAt: string | undefined;
  readonly generatedAt: string;
  readonly freshness: 'fresh' | 'stale';
  readonly permissions: readonly string[];
}

function projectionKey(tenant: TenantRef, projectionName: string): string {
  return `${tenant.tenantId}:${tenant.workspaceId}:${projectionName}`;
}

function belongsToTenant(event: StoredEvent['event'], tenant: TenantRef): boolean {
  return (
    event.tenant.tenantId === tenant.tenantId && event.tenant.workspaceId === tenant.workspaceId
  );
}

function orderedEvents(events: readonly StoredEvent[]): StoredEvent[] {
  return [...events].sort((left, right) => left.streamSequence - right.streamSequence);
}

export class ProjectionEngine {
  private readonly states = new Map<string, unknown>();
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly store: StateStore) {}

  async project<TState>(
    tenant: TenantRef,
    projection: ProjectionDefinition<TState>,
    options: ProjectionRunOptions = {},
  ): Promise<ProjectionSnapshot<TState>> {
    const key = projectionKey(tenant, projection.name);
    return this.withLock(key, async () => {
      const events = options.events ?? (await this.readAllEvents());
      return this.run(tenant, projection, events, options);
    });
  }

  async rebuild<TState>(
    tenant: TenantRef,
    projection: ProjectionDefinition<TState>,
    options: ProjectionRunOptions = {},
  ): Promise<ProjectionSnapshot<TState>> {
    const key = projectionKey(tenant, projection.name);
    return this.withLock(key, async () => {
      await this.store.transaction((transaction) =>
        transaction.checkpoints.clear(tenant, projection.name),
      );
      this.states.delete(key);
      const events = options.events ?? (await this.readAllEvents());
      return this.run(tenant, projection, events, options);
    });
  }

  private async readAllEvents(): Promise<StoredEvent[]> {
    return this.store.transaction((transaction) => transaction.events.all());
  }

  private async run<TState>(
    tenant: TenantRef,
    projection: ProjectionDefinition<TState>,
    sourceEvents: readonly StoredEvent[],
    options: ProjectionRunOptions,
  ): Promise<ProjectionSnapshot<TState>> {
    const key = projectionKey(tenant, projection.name);
    let checkpoint = await this.store.transaction((transaction) =>
      transaction.checkpoints.get(tenant, projection.name),
    );
    const savedState = this.states.get(key) as TState | undefined;

    // A checkpoint without local state means this engine restarted. Rebuild from the
    // authoritative stream before applying only the tail; this keeps a durable cursor
    // from producing a partial in-memory view.
    if (checkpoint && savedState === undefined && checkpoint.streamSequence > 0) {
      await this.store.transaction((transaction) =>
        transaction.checkpoints.clear(tenant, projection.name),
      );
      checkpoint = undefined;
    }

    let state: TState = savedState ?? projection.initialState();
    let cursor = checkpoint?.streamSequence ?? 0;
    const sorted = orderedEvents(sourceEvents);
    const streamHead = Math.max(cursor, sorted.at(-1)?.streamSequence ?? 0);
    let expectedSequence = cursor + 1;
    let processedEventCount = 0;
    let consumedEventCount = 0;
    let lastAppliedAt: string | undefined;
    let lastCheckpointAt: string | undefined;

    for (const stored of sorted) {
      if (stored.streamSequence <= cursor) continue;
      if (stored.streamSequence !== expectedSequence) {
        throw runtimeError(
          'VALIDATION_INVALID_INPUT',
          `Projection ${projection.name} expected stream sequence ${expectedSequence}, received ${stored.streamSequence}`,
        );
      }

      const matchesTenant = belongsToTenant(stored.event, tenant);
      const nextState = matchesTenant ? projection.apply(state, stored.event) : state;
      const updatedAt = options.now ?? stored.event.occurredAt;
      await this.store.transaction(async (transaction) => {
        await transaction.checkpoints.save({
          tenant,
          projectionName: projection.name,
          streamSequence: stored.streamSequence,
          updatedAt,
        });
      });

      state = nextState;
      this.states.set(key, state);
      cursor = stored.streamSequence;
      expectedSequence = cursor + 1;
      consumedEventCount += 1;
      lastCheckpointAt = updatedAt;
      if (matchesTenant) {
        processedEventCount += 1;
        lastAppliedAt = stored.event.occurredAt;
      }
    }

    checkpoint =
      cursor > 0
        ? {
            tenant,
            projectionName: projection.name,
            streamSequence: cursor,
            updatedAt:
              options.now ?? lastAppliedAt ?? lastCheckpointAt ?? '1970-01-01T00:00:00.000Z',
          }
        : undefined;
    const lag = Math.max(0, streamHead - cursor);
    return {
      projectionName: projection.name,
      tenant,
      state,
      checkpoint,
      cursor,
      streamHead,
      lag,
      stale: lag > 0,
      processedEventCount,
      consumedEventCount,
      lastAppliedAt,
      generatedAt: options.now ?? lastAppliedAt ?? lastCheckpointAt ?? new Date().toISOString(),
      freshness: lag > 0 ? 'stale' : 'fresh',
      permissions: ['read'],
    };
  }

  private async withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(key, current);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }
}
