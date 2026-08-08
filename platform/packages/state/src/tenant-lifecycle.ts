import { createHash } from 'node:crypto';
import {
  newSortableId,
  runtimeError,
  validateContract,
  type Actor,
  type HashSha256,
  type Id,
  type JsonValue,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';

export type TenantDataBucket =
  | 'authoritative'
  | 'artifacts'
  | 'events'
  | 'outbox'
  | 'projections'
  | 'audit'
  | 'connector_handles'
  | 'backups';

export type TenantDeletionState =
  | 'pending_approval'
  | 'blocked_legal_hold'
  | 'approved'
  | 'executing'
  | 'completed';

export interface TenantDataInventory {
  readonly tenant: TenantRef;
  readonly observedAt: string;
  readonly retentionPolicyVersion: string;
  readonly legalHold: boolean;
  readonly counts: Readonly<Record<TenantDataBucket, number>>;
  readonly totalBytes: number;
  readonly digest: HashSha256;
}

export interface TenantDeletionBatch {
  readonly tenant: TenantRef;
  readonly deletionId: Id;
  readonly cursor: string;
  readonly nextCursor?: string;
  readonly deleted: number;
  readonly remaining: number;
}

export interface TenantDataLifecyclePort {
  inventory(tenant: TenantRef, now: string): Promise<TenantDataInventory>;
  deleteBatch(input: {
    readonly tenant: TenantRef;
    readonly deletionId: Id;
    readonly cursor: string;
    readonly limit: number;
    readonly inventoryDigest: HashSha256;
  }): Promise<TenantDeletionBatch>;
}

export interface TenantDeletionPlan {
  readonly deletionId: Id;
  readonly tenant: TenantRef;
  readonly requestedBy: Actor;
  readonly reason: string;
  readonly policyVersion: string;
  readonly inventory: TenantDataInventory;
  readonly batchSize: number;
  readonly cursor: string;
  readonly deletedCount: number;
  readonly state: TenantDeletionState;
  readonly requestedAt: string;
  readonly approvedBy?: Actor;
  readonly approvedAt?: string;
  readonly completedAt?: string;
  readonly tombstoneId?: Id;
}

export interface TenantDeletionTombstone {
  readonly tombstoneId: Id;
  readonly deletionId: Id;
  readonly tenant: TenantRef;
  readonly inventoryDigest: HashSha256;
  readonly policyVersion: string;
  readonly deletedCount: number;
  readonly completedAt: string;
  readonly evidenceDigest: HashSha256;
}

export interface TenantLifecycleStore {
  createPlan(plan: TenantDeletionPlan): void;
  getPlan(tenant: TenantRef, deletionId: Id): TenantDeletionPlan | undefined;
  updatePlan(plan: TenantDeletionPlan): void;
  createTombstone(tombstone: TenantDeletionTombstone): void;
  getTombstone(tenant: TenantRef, tombstoneId: Id): TenantDeletionTombstone | undefined;
}

export interface TenantLifecycleAuditEvent {
  readonly auditId: Id;
  readonly tenant: TenantRef;
  readonly actor: Actor;
  readonly action: 'deletion.request' | 'deletion.approve' | 'deletion.batch' | 'deletion.complete';
  readonly deletionId: Id;
  readonly result: 'approval_required' | 'allowed' | 'executed' | 'completed';
  readonly details: JsonValue;
  readonly occurredAt: string;
}

export interface TenantLifecycleAuditSink {
  record(event: TenantLifecycleAuditEvent): void;
}

export interface TenantDeletionRequest {
  readonly tenant: TenantRef;
  readonly requester: Actor;
  readonly reason: string;
  readonly policyVersion: string;
  readonly batchSize: number;
  readonly now?: string;
}

export interface TenantLifecycleServiceOptions {
  readonly port: TenantDataLifecyclePort;
  readonly store?: TenantLifecycleStore;
  readonly audit?: TenantLifecycleAuditSink;
  readonly clock?: () => string;
}

function tenantKey(tenant: TenantRef): string {
  return `${tenant.tenantId}:${tenant.workspaceId}`;
}

function sameTenant(left: TenantRef, right: TenantRef): boolean {
  return left.tenantId === right.tenantId && left.workspaceId === right.workspaceId;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertHuman(actor: Actor, label: string): void {
  if (!validateContract('Actor', actor).valid || actor.type !== 'human') {
    throw runtimeError('POLICY_DENIED', `${label} must be a human actor`);
  }
}

function assertTenant(tenant: TenantRef): void {
  if (!validateContract('TenantRef', tenant).valid) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Tenant lifecycle tenant is invalid');
  }
}

function assertInventory(inventory: TenantDataInventory, tenant: TenantRef): void {
  assertTenant(inventory.tenant);
  if (!sameTenant(inventory.tenant, tenant)) {
    throw runtimeError('POLICY_DENIED', 'Inventory crosses the tenant boundary');
  }
  if (!validateContract('UtcInstant', inventory.observedAt).valid) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Inventory observedAt must be a UTC instant');
  }
  if (inventory.retentionPolicyVersion.trim().length === 0) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Retention policy version is required');
  }
  if (!validateContract('HashSha256', inventory.digest).valid) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Inventory digest must be SHA-256');
  }
  if (!Number.isSafeInteger(inventory.totalBytes) || inventory.totalBytes < 0) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Inventory totalBytes must be non-negative');
  }
  for (const count of Object.values(inventory.counts)) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Inventory counts must be non-negative');
    }
  }
}

function assertBatch(batch: TenantDeletionBatch, plan: TenantDeletionPlan): void {
  if (!sameTenant(batch.tenant, plan.tenant) || batch.deletionId !== plan.deletionId) {
    throw runtimeError('POLICY_DENIED', 'Deletion batch crosses its tenant or deletion boundary');
  }
  if (batch.cursor !== plan.cursor) {
    throw runtimeError(
      'CONCURRENCY_STALE_VERSION',
      'Deletion batch cursor does not match the plan',
    );
  }
  if (!Number.isSafeInteger(batch.deleted) || batch.deleted < 0) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Deletion batch deleted count is invalid');
  }
  if (!Number.isSafeInteger(batch.remaining) || batch.remaining < 0) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Deletion batch remaining count is invalid');
  }
  if (batch.remaining > 0 && batch.nextCursor === undefined) {
    throw runtimeError(
      'VALIDATION_SCHEMA_MISMATCH',
      'Non-terminal deletion batch needs a next cursor',
    );
  }
}

function digestEvidence(value: JsonValue): HashSha256 {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex') as HashSha256;
}

export class InMemoryTenantLifecycleStore implements TenantLifecycleStore {
  private readonly plans = new Map<string, TenantDeletionPlan>();
  private readonly tombstones = new Map<string, TenantDeletionTombstone>();

  createPlan(plan: TenantDeletionPlan): void {
    const key = `${tenantKey(plan.tenant)}:${plan.deletionId}`;
    if (this.plans.has(key))
      throw runtimeError('CONCURRENCY_STALE_VERSION', 'Deletion plan exists');
    this.plans.set(key, clone(plan));
  }

  getPlan(tenant: TenantRef, deletionId: Id): TenantDeletionPlan | undefined {
    const plan = this.plans.get(`${tenantKey(tenant)}:${deletionId}`);
    return plan === undefined ? undefined : clone(plan);
  }

  updatePlan(plan: TenantDeletionPlan): void {
    const key = `${tenantKey(plan.tenant)}:${plan.deletionId}`;
    if (!this.plans.has(key)) throw runtimeError('POLICY_DENIED', 'Deletion plan does not exist');
    this.plans.set(key, clone(plan));
  }

  createTombstone(tombstone: TenantDeletionTombstone): void {
    const key = `${tenantKey(tombstone.tenant)}:${tombstone.tombstoneId}`;
    if (this.tombstones.has(key))
      throw runtimeError('CONCURRENCY_STALE_VERSION', 'Tombstone exists');
    this.tombstones.set(key, clone(tombstone));
  }

  getTombstone(tenant: TenantRef, tombstoneId: Id): TenantDeletionTombstone | undefined {
    const tombstone = this.tombstones.get(`${tenantKey(tenant)}:${tombstoneId}`);
    return tombstone === undefined ? undefined : clone(tombstone);
  }
}

export class TenantLifecycleService {
  private readonly port: TenantDataLifecyclePort;
  private readonly store: TenantLifecycleStore;
  private readonly audit: TenantLifecycleAuditSink | undefined;
  private readonly clock: () => string;

  constructor(options: TenantLifecycleServiceOptions) {
    this.port = options.port;
    this.store = options.store ?? new InMemoryTenantLifecycleStore();
    this.audit = options.audit;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async request(input: TenantDeletionRequest): Promise<TenantDeletionPlan> {
    const now = input.now ?? this.clock();
    assertTenant(input.tenant);
    assertHuman(input.requester, 'Deletion requester');
    if (input.reason.trim().length === 0) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Deletion reason is required');
    }
    if (input.policyVersion.trim().length === 0) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Retention policy version is required');
    }
    if (!Number.isSafeInteger(input.batchSize) || input.batchSize < 1) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Deletion batchSize must be positive');
    }
    const inventory = await this.port.inventory(input.tenant, now);
    assertInventory(inventory, input.tenant);
    if (inventory.retentionPolicyVersion !== input.policyVersion) {
      throw runtimeError(
        'POLICY_DENIED',
        'Deletion policy version does not match the authoritative inventory',
      );
    }
    const plan: TenantDeletionPlan = {
      deletionId: newSortableId(),
      tenant: input.tenant,
      requestedBy: input.requester,
      reason: input.reason.trim(),
      policyVersion: input.policyVersion,
      inventory,
      batchSize: input.batchSize,
      cursor: '',
      deletedCount: 0,
      state: inventory.legalHold ? 'blocked_legal_hold' : 'pending_approval',
      requestedAt: now,
    };
    this.store.createPlan(plan);
    this.record(plan, input.requester, 'deletion.request', 'approval_required', now);
    return clone(plan);
  }

  approve(
    tenant: TenantRef,
    deletionId: Id,
    approver: Actor,
    now = this.clock(),
  ): TenantDeletionPlan {
    const plan = this.requirePlan(tenant, deletionId);
    assertHuman(approver, 'Deletion approver');
    if (plan.state === 'blocked_legal_hold') {
      throw runtimeError('POLICY_DENIED', 'Deletion is blocked by a legal hold');
    }
    if (plan.state !== 'pending_approval') {
      throw runtimeError('APPROVAL_INVALIDATED', `Deletion plan is ${plan.state}`);
    }
    if (approver.actorId === plan.requestedBy.actorId) {
      throw runtimeError('POLICY_DENIED', 'The requester cannot approve its own deletion');
    }
    const updated: TenantDeletionPlan = {
      ...plan,
      state: 'approved',
      approvedBy: approver,
      approvedAt: now,
    };
    this.store.updatePlan(updated);
    this.record(updated, approver, 'deletion.approve', 'allowed', now);
    return clone(updated);
  }

  async executeBatch(
    tenant: TenantRef,
    deletionId: Id,
    now = this.clock(),
  ): Promise<TenantDeletionPlan> {
    const plan = this.requirePlan(tenant, deletionId);
    if (plan.state !== 'approved' && plan.state !== 'executing') {
      throw runtimeError('APPROVAL_INVALIDATED', `Deletion plan is ${plan.state}`);
    }
    const executing: TenantDeletionPlan =
      plan.state === 'approved' ? { ...plan, state: 'executing' } : plan;
    if (executing !== plan) this.store.updatePlan(executing);
    const batch = await this.port.deleteBatch({
      tenant,
      deletionId,
      cursor: executing.cursor,
      limit: executing.batchSize,
      inventoryDigest: executing.inventory.digest,
    });
    assertBatch(batch, executing);
    const deletedCount = executing.deletedCount + batch.deleted;
    if (batch.remaining === 0) {
      const completedAt = now;
      const tombstoneId = newSortableId();
      const tombstone: TenantDeletionTombstone = {
        tombstoneId,
        deletionId,
        tenant,
        inventoryDigest: executing.inventory.digest,
        policyVersion: executing.policyVersion,
        deletedCount,
        completedAt,
        evidenceDigest: digestEvidence({
          deletionId,
          tenant: { tenantId: tenant.tenantId, workspaceId: tenant.workspaceId },
          inventoryDigest: executing.inventory.digest,
          policyVersion: executing.policyVersion,
          deletedCount,
          completedAt,
        }),
      };
      this.store.createTombstone(tombstone);
      const completed: TenantDeletionPlan = {
        ...executing,
        state: 'completed',
        cursor: batch.nextCursor ?? executing.cursor,
        deletedCount,
        completedAt,
        tombstoneId,
      };
      this.store.updatePlan(completed);
      this.record(
        completed,
        executing.approvedBy ?? executing.requestedBy,
        'deletion.complete',
        'completed',
        now,
      );
      return clone(completed);
    }
    const next: TenantDeletionPlan = {
      ...executing,
      cursor: batch.nextCursor ?? executing.cursor,
      deletedCount,
    };
    this.store.updatePlan(next);
    this.record(
      next,
      executing.approvedBy ?? executing.requestedBy,
      'deletion.batch',
      'executed',
      now,
    );
    return clone(next);
  }

  getPlan(tenant: TenantRef, deletionId: Id): TenantDeletionPlan | undefined {
    return this.store.getPlan(tenant, deletionId);
  }

  getTombstone(tenant: TenantRef, tombstoneId: Id): TenantDeletionTombstone | undefined {
    return this.store.getTombstone(tenant, tombstoneId);
  }

  private requirePlan(tenant: TenantRef, deletionId: Id): TenantDeletionPlan {
    const plan = this.store.getPlan(tenant, deletionId);
    if (plan === undefined) throw runtimeError('POLICY_DENIED', 'Deletion plan was not found');
    if (!sameTenant(plan.tenant, tenant)) {
      throw runtimeError('POLICY_DENIED', 'Deletion plan crosses the tenant boundary');
    }
    return plan;
  }

  private record(
    plan: TenantDeletionPlan,
    actor: Actor,
    action: TenantLifecycleAuditEvent['action'],
    result: TenantLifecycleAuditEvent['result'],
    occurredAt: string,
  ): void {
    this.audit?.record({
      auditId: newSortableId(),
      tenant: plan.tenant,
      actor,
      action,
      deletionId: plan.deletionId,
      result,
      details: {
        policyVersion: plan.policyVersion,
        inventoryDigest: plan.inventory.digest,
        state: plan.state,
        cursor: plan.cursor,
        deletedCount: plan.deletedCount,
        tombstoneId: plan.tombstoneId ?? null,
      },
      occurredAt,
    });
  }
}
