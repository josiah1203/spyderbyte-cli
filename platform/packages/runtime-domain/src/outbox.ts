import {
  newSortableId,
  runtimeError,
  type Id,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import type { OutboxRecord, StateStore } from '@agentic-platform/state';

export interface OutboxTransport {
  publish(record: OutboxRecord): Promise<void>;
}

export type OutboxDispatchFailureStage = 'attempt' | 'publish' | 'acknowledge';

export interface OutboxDispatchFailure {
  readonly outboxId: Id;
  readonly eventId: Id;
  readonly stage: OutboxDispatchFailureStage;
  readonly attempts: number;
  readonly message: string;
}

export interface OutboxDispatchResult {
  readonly inspected: number;
  readonly published: number;
  readonly failures: readonly OutboxDispatchFailure[];
}

export interface OutboxDispatchOptions {
  readonly maxBatch?: number;
  readonly now?: string;
}

const DEFAULT_CLAIM_DURATION_MS = 30_000;

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} must be a positive integer`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tenantKey(tenant: TenantRef): string {
  return `${tenant.tenantId}:${tenant.workspaceId}`;
}

function claimExpiry(now: string, durationMs: number): string {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Outbox dispatch time must be a valid instant');
  }
  return new Date(nowMs + durationMs).toISOString();
}

/**
 * Drains a tenant-scoped transactional outbox with at-least-once publication semantics.
 *
 * The outbox row is attempted before publication and marked published only after the transport
 * resolves. A crash after transport acceptance but before the acknowledgement transaction can
 * redeliver the event; transports and consumers must therefore deduplicate by event ID.
 */
export class TransactionalOutboxDispatcher {
  private readonly inFlight = new Set<string>();
  private readonly clock: () => string;
  private readonly defaultMaxBatch: number;
  private readonly consumerId: string;
  private readonly claimDurationMs: number;

  constructor(
    private readonly state: StateStore,
    private readonly transport: OutboxTransport,
    options: {
      clock?: () => string;
      maxBatch?: number;
      consumerId?: string;
      claimDurationMs?: number;
    } = {},
  ) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.defaultMaxBatch = options.maxBatch ?? 100;
    this.consumerId = options.consumerId ?? `outbox-dispatcher-${newSortableId()}`;
    this.claimDurationMs = options.claimDurationMs ?? DEFAULT_CLAIM_DURATION_MS;
    assertPositiveInteger(this.defaultMaxBatch, 'Outbox dispatch batch size');
    assertPositiveInteger(this.claimDurationMs, 'Outbox claim duration');
    if (this.consumerId.trim().length === 0) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Outbox consumer ID is required');
    }
  }

  async dispatch(
    tenant: TenantRef,
    options: OutboxDispatchOptions = {},
  ): Promise<OutboxDispatchResult> {
    const maxBatch = options.maxBatch ?? this.defaultMaxBatch;
    assertPositiveInteger(maxBatch, 'Outbox dispatch batch size');
    const now = options.now ?? this.clock();
    const selected = await this.state.transaction((transaction) =>
      transaction.outbox.claimPending(
        tenant,
        now,
        this.consumerId,
        claimExpiry(now, this.claimDurationMs),
        maxBatch,
      ),
    );
    const failures: OutboxDispatchFailure[] = [];
    let published = 0;

    for (const record of selected) {
      const key = `${tenantKey(record.tenant)}:${record.outboxId}`;
      if (this.inFlight.has(key)) continue;
      this.inFlight.add(key);
      try {
        try {
          await this.state.transaction((transaction) =>
            transaction.outbox.incrementAttempt(
              record.tenant,
              record.outboxId,
              this.consumerId,
              now,
            ),
          );
        } catch (error) {
          failures.push({
            outboxId: record.outboxId,
            eventId: record.eventId,
            stage: 'attempt',
            attempts: record.attempts,
            message: errorMessage(error),
          });
          continue;
        }

        try {
          await this.transport.publish(structuredClone(record));
        } catch (error) {
          failures.push({
            outboxId: record.outboxId,
            eventId: record.eventId,
            stage: 'publish',
            attempts: record.attempts + 1,
            message: errorMessage(error),
          });
          continue;
        }

        try {
          await this.state.transaction((transaction) =>
            transaction.outbox.markPublished(
              record.tenant,
              record.outboxId,
              now,
              this.consumerId,
              now,
            ),
          );
          published += 1;
        } catch (error) {
          failures.push({
            outboxId: record.outboxId,
            eventId: record.eventId,
            stage: 'acknowledge',
            attempts: record.attempts + 1,
            message: errorMessage(error),
          });
        }
      } finally {
        this.inFlight.delete(key);
      }
    }

    return { inspected: selected.length, published, failures };
  }
}
