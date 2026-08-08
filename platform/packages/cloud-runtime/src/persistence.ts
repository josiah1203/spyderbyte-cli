import {
  newSortableId,
  makeMoney,
  runtimeError,
  type CloudApprovalV1,
  type CloudBillingRecordV1,
  type CloudEstimateV1,
  type CloudRunContinuityV1,
  type CloudRunEventV1,
  type CloudRunRequestV1,
  type CloudUsageRecordV1,
  type Id,
  type JsonValue,
  type Money,
  type RuntimeEvent,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import type { StateStore } from '@agentic-platform/state';
import type {
  CloudBillingStateStore,
  CloudPrepaidBalanceLedger,
  CloudUsageLedger,
} from './billing.js';

export interface StoredCloudEstimate {
  readonly request: CloudRunRequestV1;
  readonly estimate: CloudEstimateV1;
}

export interface StoredCloudEvent {
  readonly cloudEvent: CloudRunEventV1;
  readonly runtimeEvent: RuntimeEvent;
}

export interface CloudEventAppendInput {
  readonly cloudEvent: Omit<CloudRunEventV1, 'sequence'>;
  readonly runtimeEvent: RuntimeEvent;
}

/**
 * Persistence required by the managed execution coordinator.
 *
 * The coordinator deliberately depends on this small port instead of maps so
 * a hosted process can restart or scale horizontally without changing the
 * estimate/approval/Run contracts.
 */
export interface CloudRuntimeStore {
  getEstimate(tenant: TenantRef, estimateId: string): Promise<StoredCloudEstimate | undefined>;
  getEstimateByIdempotency(
    tenant: TenantRef,
    idempotencyKey: string,
  ): Promise<StoredCloudEstimate | undefined>;
  saveEstimate(record: StoredCloudEstimate): Promise<void>;
  getApproval(tenant: TenantRef, estimateId: string): Promise<CloudApprovalV1 | undefined>;
  saveApproval(approval: CloudApprovalV1): Promise<void>;
  getResult(tenant: TenantRef, runId: string): Promise<CloudRunContinuityV1 | undefined>;
  saveResult(result: CloudRunContinuityV1): Promise<void>;
  appendEvent(input: CloudEventAppendInput): Promise<StoredCloudEvent>;
  eventsFor(tenant: TenantRef, runId: string): Promise<readonly CloudRunEventV1[]>;
}

function tenantKey(tenant: TenantRef): string {
  return `${tenant.tenantId}:${tenant.workspaceId}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function estimateKey(tenant: TenantRef, estimateId: string): string {
  return `${tenantKey(tenant)}:${estimateId}`;
}

function approvalKey(tenant: TenantRef, estimateId: string): string {
  return `${tenantKey(tenant)}:${estimateId}`;
}

function resultKey(tenant: TenantRef, runId: string): string {
  return `${tenantKey(tenant)}:${runId}`;
}

function eventKey(tenant: TenantRef, runId: string): string {
  return `${tenantKey(tenant)}:${runId}`;
}

function cloudEventFromPayload(value: unknown): CloudRunEventV1 | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record['schemaVersion'] !== 1 ||
    typeof record['eventId'] !== 'string' ||
    typeof record['runId'] !== 'string' ||
    typeof record['cloudAttemptId'] !== 'string' ||
    typeof record['tenant'] !== 'object' ||
    record['tenant'] === null ||
    typeof record['sequence'] !== 'number' ||
    !Number.isSafeInteger(record['sequence']) ||
    typeof record['eventName'] !== 'string' ||
    typeof record['occurredAt'] !== 'string'
  ) {
    return undefined;
  }
  return clone(record as unknown as CloudRunEventV1);
}

function cloudEventWithSequence(
  input: Omit<CloudRunEventV1, 'sequence'>,
  sequence: number,
): CloudRunEventV1 {
  return { ...clone(input), sequence };
}

/** In-process persistence used by local fixtures and deterministic tests. */
export class InMemoryCloudRuntimeStore implements CloudRuntimeStore {
  private readonly estimates = new Map<string, StoredCloudEstimate>();
  private readonly estimatesByIdempotency = new Map<string, StoredCloudEstimate>();
  private readonly approvals = new Map<string, CloudApprovalV1>();
  private readonly results = new Map<string, CloudRunContinuityV1>();
  private readonly events = new Map<string, StoredCloudEvent[]>();

  getEstimate(tenant: TenantRef, estimateId: string): Promise<StoredCloudEstimate | undefined> {
    return Promise.resolve(clone(this.estimates.get(estimateKey(tenant, estimateId))));
  }

  getEstimateByIdempotency(
    tenant: TenantRef,
    idempotencyKey: string,
  ): Promise<StoredCloudEstimate | undefined> {
    return Promise.resolve(
      clone(this.estimatesByIdempotency.get(`${tenantKey(tenant)}:${idempotencyKey}`)),
    );
  }

  saveEstimate(record: StoredCloudEstimate): Promise<void> {
    const stored = clone(record);
    this.estimates.set(estimateKey(record.estimate.tenant, record.estimate.estimateId), stored);
    this.estimatesByIdempotency.set(
      `${tenantKey(record.request.tenant)}:${record.request.idempotencyKey}`,
      stored,
    );
    return Promise.resolve();
  }

  getApproval(tenant: TenantRef, estimateId: string): Promise<CloudApprovalV1 | undefined> {
    return Promise.resolve(clone(this.approvals.get(approvalKey(tenant, estimateId))));
  }

  saveApproval(approval: CloudApprovalV1): Promise<void> {
    this.approvals.set(approvalKey(approval.tenant, approval.estimateId), clone(approval));
    return Promise.resolve();
  }

  getResult(tenant: TenantRef, runId: string): Promise<CloudRunContinuityV1 | undefined> {
    return Promise.resolve(clone(this.results.get(resultKey(tenant, runId))));
  }

  saveResult(result: CloudRunContinuityV1): Promise<void> {
    this.results.set(resultKey(result.tenant, result.runId), clone(result));
    return Promise.resolve();
  }

  appendEvent(input: CloudEventAppendInput): Promise<StoredCloudEvent> {
    const key = eventKey(input.cloudEvent.tenant, input.cloudEvent.runId);
    const events = this.events.get(key) ?? [];
    const existing = events.find((event) => event.cloudEvent.eventId === input.cloudEvent.eventId);
    if (existing !== undefined) return Promise.resolve(clone(existing));
    const cloudEvent = cloudEventWithSequence(input.cloudEvent, events.length + 1);
    const stored: StoredCloudEvent = {
      cloudEvent,
      runtimeEvent: clone({
        ...input.runtimeEvent,
        aggregateVersion: events.length + 1,
        payload: cloudEvent as unknown as JsonValue,
      }),
    };
    events.push(stored);
    this.events.set(key, events);
    return Promise.resolve(clone(stored));
  }

  eventsFor(tenant: TenantRef, runId: string): Promise<readonly CloudRunEventV1[]> {
    return Promise.resolve(
      clone((this.events.get(eventKey(tenant, runId)) ?? []).map((event) => event.cloudEvent)),
    );
  }
}

/**
 * Durable cloud-runtime persistence over the existing transactional state
 * port. Metadata is stored as immutable receipts and Run events use the
 * authoritative append-only event stream, so hosted Postgres compositions do
 * not need a second domain database or vendor-specific types.
 */
export class StateStoreCloudRuntimeStore implements CloudRuntimeStore {
  constructor(private readonly state: StateStore) {}

  async getEstimate(
    tenant: TenantRef,
    estimateId: string,
  ): Promise<StoredCloudEstimate | undefined> {
    return this.readRecord<StoredCloudEstimate>(tenant, `cloud.estimate:${estimateId}`);
  }

  async getEstimateByIdempotency(
    tenant: TenantRef,
    idempotencyKey: string,
  ): Promise<StoredCloudEstimate | undefined> {
    return this.readRecord<StoredCloudEstimate>(
      tenant,
      `cloud.estimate-idempotency:${idempotencyKey}`,
    );
  }

  async saveEstimate(record: StoredCloudEstimate): Promise<void> {
    await this.state.transaction(async (transaction) => {
      const value = clone(record) as unknown as JsonValue;
      await transaction.receipts.record({
        tenant: record.estimate.tenant,
        receiptId: newSortableId(),
        effectKey: `cloud.estimate:${record.estimate.estimateId}`,
        result: value,
        recordedAt: record.estimate.createdAt,
      });
      await transaction.receipts.record({
        tenant: record.request.tenant,
        receiptId: newSortableId(),
        effectKey: `cloud.estimate-idempotency:${record.request.idempotencyKey}`,
        result: value,
        recordedAt: record.estimate.createdAt,
      });
    });
  }

  getApproval(tenant: TenantRef, estimateId: string): Promise<CloudApprovalV1 | undefined> {
    return this.readRecord<CloudApprovalV1>(tenant, `cloud.approval:${estimateId}`);
  }

  async saveApproval(approval: CloudApprovalV1): Promise<void> {
    await this.writeRecord(
      approval.tenant,
      `cloud.approval:${approval.estimateId}`,
      approval,
      approval.approvedAt,
    );
  }

  getResult(tenant: TenantRef, runId: string): Promise<CloudRunContinuityV1 | undefined> {
    return this.readRecord<CloudRunContinuityV1>(tenant, `cloud.result:${runId}`);
  }

  async saveResult(result: CloudRunContinuityV1): Promise<void> {
    await this.writeRecord(
      result.tenant,
      `cloud.result:${result.runId}`,
      result,
      result.completedAt,
    );
  }

  async appendEvent(input: CloudEventAppendInput): Promise<StoredCloudEvent> {
    return this.state.transaction(async (transaction) => {
      const existingEvents = await transaction.events.list(input.cloudEvent.tenant);
      const aggregateEvents = existingEvents
        .filter(
          ({ event }) =>
            event.aggregateType === 'Run' &&
            event.aggregateId === input.cloudEvent.runId &&
            cloudEventFromPayload(event.payload) !== undefined,
        )
        .sort((left, right) => left.event.aggregateVersion - right.event.aggregateVersion);
      const allAggregateEvents = existingEvents.filter(
        ({ event }) =>
          event.aggregateType === 'Run' && event.aggregateId === input.cloudEvent.runId,
      );
      const expectedAggregateVersion = allAggregateEvents.reduce(
        (version, stored) => Math.max(version, stored.event.aggregateVersion),
        0,
      );
      const cloudEvent = cloudEventWithSequence(input.cloudEvent, aggregateEvents.length + 1);
      const runtimeEvent = await transaction.events.append(
        {
          ...clone(input.runtimeEvent),
          eventName: `cloud-run.${input.cloudEvent.eventName.replaceAll('.', '-')}.v1`,
          aggregateType: 'Run',
          aggregateId: input.cloudEvent.runId,
          aggregateVersion: Math.max(1, expectedAggregateVersion + 1),
          payload: cloudEvent as unknown as JsonValue,
        },
        expectedAggregateVersion,
      );
      return {
        cloudEvent,
        runtimeEvent: clone(runtimeEvent.event),
      };
    });
  }

  async eventsFor(tenant: TenantRef, runId: string): Promise<readonly CloudRunEventV1[]> {
    return this.state.transaction(async (transaction) => {
      const stored = await transaction.events.list(tenant);
      return stored
        .filter(
          ({ event }) =>
            event.aggregateType === 'Run' &&
            event.aggregateId === runId &&
            cloudEventFromPayload(event.payload) !== undefined,
        )
        .map(({ event }) => cloudEventFromPayload(event.payload))
        .filter((event): event is CloudRunEventV1 => event !== undefined)
        .sort((left, right) => left.sequence - right.sequence)
        .map((event) => clone(event));
    });
  }

  private async readRecord<T>(tenant: TenantRef, effectKey: string): Promise<T | undefined> {
    return this.state.transaction(async (transaction) => {
      const record = await transaction.receipts.get(tenant, effectKey);
      return record === undefined ? undefined : clone(record.result as unknown as T);
    });
  }

  private async writeRecord<T>(
    tenant: TenantRef,
    effectKey: string,
    value: T,
    recordedAt: string | undefined,
  ): Promise<void> {
    await this.state.transaction(async (transaction) => {
      await transaction.receipts.record({
        tenant,
        receiptId: newSortableId(),
        effectKey,
        result: clone(value) as unknown as JsonValue,
        recordedAt: recordedAt ?? new Date().toISOString(),
      });
    });
  }
}

/** Durable billing authorization/reconciliation state on the same state port. */
export class StateStoreCloudBillingStateStore implements CloudBillingStateStore {
  constructor(private readonly state: StateStore) {}

  get(tenant: TenantRef, estimateId: string): Promise<CloudBillingRecordV1 | undefined> {
    return this.state.transaction(async (transaction) => {
      const events = await transaction.events.list(tenant);
      const latest = events
        .filter(
          ({ event }) =>
            event.aggregateType === 'CloudBilling' &&
            event.aggregateId === estimateId &&
            event.eventName === 'cloud-billing.state.v1',
        )
        .at(-1);
      return latest === undefined
        ? undefined
        : clone(latest.event.payload as unknown as CloudBillingRecordV1);
    });
  }

  async save(record: CloudBillingRecordV1): Promise<void> {
    const estimateId = record.idempotencyKey.replace(/^cloud-billing:/, '');
    await this.state.transaction(async (transaction) => {
      const events = await transaction.events.list(record.tenant);
      const aggregateVersion = events
        .filter(
          ({ event }) => event.aggregateType === 'CloudBilling' && event.aggregateId === estimateId,
        )
        .reduce((version, stored) => Math.max(version, stored.event.aggregateVersion), 0);
      await transaction.events.append(
        {
          schemaVersion: 1,
          eventId: newSortableId(),
          eventName: 'cloud-billing.state.v1',
          tenant: clone(record.tenant),
          aggregateType: 'CloudBilling',
          aggregateId: estimateId as Id,
          aggregateVersion: Math.max(1, aggregateVersion + 1),
          occurredAt: record.reconciledAt ?? record.authorizedAt,
          actor: { actorId: newSortableId(), type: 'system', displayName: 'cloud-billing' },
          correlationId: record.runId,
          payload: clone(record) as unknown as JsonValue,
        },
        aggregateVersion,
      );
    });
  }

  getAuthorizationId(tenant: TenantRef, estimateId: string): Promise<string | undefined> {
    return this.readRecord<string>(tenant, `cloud.billing-authorization:${estimateId}`);
  }

  async saveAuthorizationId(
    tenant: TenantRef,
    estimateId: string,
    authorizationId: string,
  ): Promise<void> {
    await this.writeRecord(
      tenant,
      `cloud.billing-authorization:${estimateId}`,
      authorizationId,
      new Date().toISOString(),
    );
  }

  private async readRecord<T>(tenant: TenantRef, effectKey: string): Promise<T | undefined> {
    return this.state.transaction(async (transaction) => {
      const record = await transaction.receipts.get(tenant, effectKey);
      return record === undefined ? undefined : clone(record.result as unknown as T);
    });
  }

  private async writeRecord<T>(
    tenant: TenantRef,
    effectKey: string,
    value: T,
    recordedAt: string,
  ): Promise<void> {
    await this.state.transaction(async (transaction) => {
      await transaction.receipts.record({
        tenant,
        receiptId: newSortableId(),
        effectKey,
        result: clone(value) as unknown as JsonValue,
        recordedAt,
      });
    });
  }
}

/** Durable usage idempotency and history on the shared state/event ports. */
export class StateStoreCloudUsageLedger implements CloudUsageLedger {
  constructor(private readonly state: StateStore) {}

  async record(record: CloudUsageRecordV1): Promise<CloudUsageRecordV1> {
    return this.state.transaction(async (transaction) => {
      const effectKey = `cloud.usage:${record.idempotencyKey}`;
      const existing = await transaction.receipts.get(record.tenant, effectKey);
      if (existing !== undefined) {
        if (JSON.stringify(existing.result) !== JSON.stringify(record)) {
          throw runtimeError(
            'VALIDATION_INVALID_INPUT',
            'Usage idempotency key was reused differently',
          );
        }
        return clone(existing.result as unknown as CloudUsageRecordV1);
      }
      await transaction.receipts.record({
        tenant: record.tenant,
        receiptId: newSortableId(),
        effectKey,
        result: clone(record) as unknown as JsonValue,
        recordedAt: record.recordedAt,
      });
      const events = await transaction.events.list(record.tenant);
      const aggregateVersion = events
        .filter(
          ({ event }) =>
            event.aggregateType === 'CloudUsage' && event.aggregateId === record.usageId,
        )
        .reduce((version, stored) => Math.max(version, stored.event.aggregateVersion), 0);
      await transaction.events.append(
        {
          schemaVersion: 1,
          eventId: newSortableId(),
          eventName: 'cloud-usage.record.v1',
          tenant: clone(record.tenant),
          aggregateType: 'CloudUsage',
          aggregateId: record.usageId,
          aggregateVersion: Math.max(1, aggregateVersion + 1),
          occurredAt: record.recordedAt,
          actor: { actorId: newSortableId(), type: 'system', displayName: 'cloud-usage' },
          correlationId: record.runId,
          payload: clone(record) as unknown as JsonValue,
        },
        aggregateVersion,
      );
      return clone(record);
    });
  }

  async get(tenant: TenantRef, idempotencyKey: string): Promise<CloudUsageRecordV1 | undefined> {
    return this.state.transaction(async (transaction) => {
      const record = await transaction.receipts.get(tenant, `cloud.usage:${idempotencyKey}`);
      return record === undefined
        ? undefined
        : clone(record.result as unknown as CloudUsageRecordV1);
    });
  }

  async list(tenant: TenantRef): Promise<CloudUsageRecordV1[]> {
    return this.state.transaction(async (transaction) => {
      const events = await transaction.events.list(tenant);
      return events
        .filter(
          ({ event }) =>
            event.aggregateType === 'CloudUsage' && event.eventName === 'cloud-usage.record.v1',
        )
        .map(({ event }) => clone(event.payload as unknown as CloudUsageRecordV1));
    });
  }
}

interface PersistedPrepaidReservation {
  readonly originalMinor: number;
  readonly remainingMinor: number;
  readonly reconciledMinor?: number;
}

interface PersistedPrepaidState {
  readonly availableMinor: number;
  readonly reservedMinor: number;
  readonly currency?: string;
  readonly reservations: Record<string, PersistedPrepaidReservation>;
}

function emptyPrepaidState(): PersistedPrepaidState {
  return { availableMinor: 0, reservedMinor: 0, reservations: {} };
}

function prepaidAggregateId(tenant: TenantRef): Id {
  return tenant.workspaceId;
}

/** Durable prepaid reservation/reconciliation state using append-only events. */
export class StateStoreCloudPrepaidBalanceLedger implements CloudPrepaidBalanceLedger {
  constructor(private readonly state: StateStore) {}

  async credit(tenant: TenantRef, amount: Money): Promise<Money> {
    this.assertAmount(amount);
    return this.mutate(tenant, (current) => {
      this.assertCurrency(current, amount);
      return {
        ...current,
        currency: current.currency ?? amount.currency,
        availableMinor: current.availableMinor + amount.amountMinor,
      };
    }).then((next) => makeMoney(next.availableMinor, amount.currency));
  }

  async reserve(tenant: TenantRef, reservationId: string, amount: Money): Promise<void> {
    this.assertAmount(amount);
    await this.mutate(tenant, (current) => {
      this.assertCurrency(current, amount);
      const existing = current.reservations[reservationId];
      if (existing !== undefined) {
        if (existing.originalMinor !== amount.amountMinor) {
          throw runtimeError(
            'VALIDATION_INVALID_INPUT',
            'Prepaid reservation was reused differently',
          );
        }
        return current;
      }
      if (current.availableMinor < amount.amountMinor) {
        throw runtimeError('BUDGET_EXCEEDED', 'Prepaid balance is insufficient for cloud estimate');
      }
      return {
        ...current,
        currency: current.currency ?? amount.currency,
        availableMinor: current.availableMinor - amount.amountMinor,
        reservedMinor: current.reservedMinor + amount.amountMinor,
        reservations: {
          ...current.reservations,
          [reservationId]: {
            originalMinor: amount.amountMinor,
            remainingMinor: amount.amountMinor,
          },
        },
      };
    });
  }

  async reconcile(tenant: TenantRef, reservationId: string, actual: Money): Promise<void> {
    this.assertAmount(actual);
    await this.mutate(tenant, (current) => {
      this.assertCurrency(current, actual);
      const reservation = current.reservations[reservationId];
      if (reservation === undefined) {
        throw runtimeError('ARTIFACT_NOT_FOUND', 'Prepaid reservation was not found');
      }
      if (reservation.reconciledMinor !== undefined) {
        if (reservation.reconciledMinor !== actual.amountMinor) {
          throw runtimeError(
            'VALIDATION_INVALID_INPUT',
            'Prepaid reconciliation was reused differently',
          );
        }
        return current;
      }
      const extra = Math.max(0, actual.amountMinor - reservation.remainingMinor);
      if (extra > current.availableMinor) {
        throw runtimeError('BUDGET_EXCEEDED', 'Actual cloud usage exceeds prepaid balance');
      }
      return {
        ...current,
        currency: current.currency ?? actual.currency,
        availableMinor:
          current.availableMinor -
          extra +
          Math.max(0, reservation.remainingMinor - actual.amountMinor),
        reservedMinor: current.reservedMinor - reservation.remainingMinor,
        reservations: {
          ...current.reservations,
          [reservationId]: {
            ...reservation,
            remainingMinor: 0,
            reconciledMinor: actual.amountMinor,
          },
        },
      };
    });
  }

  async release(tenant: TenantRef, reservationId: string): Promise<void> {
    await this.mutate(tenant, (current) => {
      const reservation = current.reservations[reservationId];
      if (reservation === undefined || reservation.reconciledMinor !== undefined) return current;
      return {
        ...current,
        availableMinor: current.availableMinor + reservation.remainingMinor,
        reservedMinor: current.reservedMinor - reservation.remainingMinor,
        reservations: {
          ...current.reservations,
          [reservationId]: { ...reservation, remainingMinor: 0, reconciledMinor: 0 },
        },
      };
    });
  }

  async snapshot(
    tenant: TenantRef,
  ): Promise<{ readonly availableMinor: number; readonly reservedMinor: number }> {
    const current = await this.read(tenant);
    return { availableMinor: current.availableMinor, reservedMinor: current.reservedMinor };
  }

  private async read(tenant: TenantRef): Promise<PersistedPrepaidState> {
    return this.state.transaction(async (transaction) => {
      const events = await transaction.events.list(tenant);
      return this.stateFromEvents(events);
    });
  }

  private async mutate(
    tenant: TenantRef,
    change: (current: PersistedPrepaidState) => PersistedPrepaidState,
  ): Promise<PersistedPrepaidState> {
    return this.state.transaction(async (transaction) => {
      const events = await transaction.events.list(tenant);
      const current = this.stateFromEvents(events);
      const next = change(current);
      const aggregateVersion = events
        .filter(
          ({ event }) =>
            event.aggregateType === 'CloudPrepaidBalance' &&
            event.aggregateId === prepaidAggregateId(tenant),
        )
        .reduce((version, stored) => Math.max(version, stored.event.aggregateVersion), 0);
      await transaction.events.append(
        {
          schemaVersion: 1,
          eventId: newSortableId(),
          eventName: 'cloud-prepaid.state.v1',
          tenant: clone(tenant),
          aggregateType: 'CloudPrepaidBalance',
          aggregateId: prepaidAggregateId(tenant),
          aggregateVersion: Math.max(1, aggregateVersion + 1),
          occurredAt: new Date().toISOString(),
          actor: { actorId: newSortableId(), type: 'system', displayName: 'cloud-prepaid' },
          correlationId: newSortableId(),
          payload: clone(next) as unknown as JsonValue,
        },
        aggregateVersion,
      );
      return clone(next);
    });
  }

  private stateFromEvents(events: readonly { event: RuntimeEvent }[]): PersistedPrepaidState {
    const latest = events
      .filter(
        ({ event }) =>
          event.aggregateType === 'CloudPrepaidBalance' &&
          event.eventName === 'cloud-prepaid.state.v1',
      )
      .at(-1);
    return latest === undefined
      ? emptyPrepaidState()
      : clone(latest.event.payload as unknown as PersistedPrepaidState);
  }

  private assertAmount(amount: Money): void {
    if (!Number.isSafeInteger(amount.amountMinor) || amount.amountMinor < 0) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Prepaid amount must be non-negative');
    }
  }

  private assertCurrency(current: PersistedPrepaidState, amount: Money): void {
    if (current.currency !== undefined && current.currency !== amount.currency) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'Prepaid balance currency does not match cloud charge',
      );
    }
  }
}
