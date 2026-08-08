import {
  newSortableId,
  runtimeError,
  type Id,
  type JsonValue,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';

export const workerPoolNames = [
  'tier0-control',
  'tier1-domain',
  'tier2-deterministic',
  'tier2-coding',
  'compute-observation',
  'projection',
] as const;

export type WorkerPoolName = (typeof workerPoolNames)[number];

export interface WorkerTaskRequest {
  readonly taskId: Id;
  readonly tenant: TenantRef;
  readonly pool: WorkerPoolName;
  readonly payload: JsonValue;
  readonly maxAttempts: number;
  readonly enqueuedAt: string;
}

export interface WorkerFailure {
  readonly attempt: number;
  readonly code: string;
  readonly at: string;
}

export interface WorkerLease {
  readonly leaseId: Id;
  readonly taskId: Id;
  readonly tenant: TenantRef;
  readonly pool: WorkerPoolName;
  readonly workerId: string;
  readonly payload: JsonValue;
  readonly attempt: number;
  readonly leasedAt: string;
  readonly expiresAt: string;
}

export interface WorkerTaskRecord extends WorkerTaskRequest {
  readonly state: 'queued' | 'leased' | 'acked' | 'parked';
  readonly attempt: number;
  readonly failures: readonly WorkerFailure[];
  readonly lease?: WorkerLease;
}

export interface WorkerPool {
  enqueue(request: WorkerTaskRequest): Promise<WorkerTaskRecord>;
  claim(
    tenant: TenantRef,
    pool: WorkerPoolName,
    workerId: string,
    now?: string,
  ): Promise<WorkerLease | undefined>;
  heartbeat(tenant: TenantRef, leaseId: Id, workerId: string, now?: string): Promise<WorkerLease>;
  ack(tenant: TenantRef, leaseId: Id, workerId: string, now?: string): Promise<WorkerTaskRecord>;
  fail(
    tenant: TenantRef,
    leaseId: Id,
    workerId: string,
    code: string,
    now?: string,
  ): Promise<WorkerTaskRecord>;
  park(
    tenant: TenantRef,
    leaseId: Id,
    workerId: string,
    code: string,
    now?: string,
  ): Promise<WorkerTaskRecord>;
  get(tenant: TenantRef, taskId: Id): Promise<WorkerTaskRecord | undefined>;
  lag(tenant: TenantRef, pool: WorkerPoolName): Promise<number>;
}

export interface InMemoryWorkerPoolOptions {
  readonly clock?: () => string;
  readonly leaseDurationMs?: number;
  readonly maxQueuedPerTenantAndPool?: number;
  readonly maxInFlightPerTenant?: number;
  readonly maxInFlightByPool?: Partial<Record<WorkerPoolName, number>>;
}

interface StoredTask {
  readonly request: WorkerTaskRequest;
  state: WorkerTaskRecord['state'];
  attempt: number;
  failures: WorkerFailure[];
  lease?: WorkerLease;
}

function tenantKey(tenant: TenantRef): string {
  return `${tenant.tenantId}:${tenant.workspaceId}`;
}

function taskKey(tenant: TenantRef, taskId: Id): string {
  return `${tenantKey(tenant)}:${taskId}`;
}

function sameTenant(left: TenantRef, right: TenantRef): boolean {
  return left.tenantId === right.tenantId && left.workspaceId === right.workspaceId;
}

function isWorkerPoolName(value: string): value is WorkerPoolName {
  return (workerPoolNames as readonly string[]).includes(value);
}

function assertPool(pool: string): asserts pool is WorkerPoolName {
  if (!isWorkerPoolName(pool))
    throw runtimeError('VALIDATION_INVALID_INPUT', `Unknown worker pool ${pool}`);
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    throw runtimeError('VALIDATION_INVALID_INPUT', `Invalid worker-pool timestamp ${value}`);
  return parsed;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw runtimeError('VALIDATION_INVALID_INPUT', `${name} must be a positive integer`);
}

function recordFor(task: StoredTask): WorkerTaskRecord {
  return {
    ...structuredClone(task.request),
    state: task.state,
    attempt: task.attempt,
    failures: structuredClone(task.failures),
    ...(task.lease !== undefined ? { lease: structuredClone(task.lease) } : {}),
  };
}

function assertWorkerId(workerId: string): void {
  if (workerId.trim().length === 0)
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Worker ID is required');
}

export class InMemoryWorkerPool implements WorkerPool {
  private readonly tasks = new Map<string, StoredTask>();
  private readonly clock: () => string;
  private readonly leaseDurationMs: number;
  private readonly maxQueuedPerTenantAndPool: number;
  private readonly maxInFlightPerTenant: number;
  private readonly maxInFlightByPool: Partial<Record<WorkerPoolName, number>>;

  constructor(options: InMemoryWorkerPoolOptions = {}) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.maxQueuedPerTenantAndPool = options.maxQueuedPerTenantAndPool ?? 1_000;
    this.maxInFlightPerTenant = options.maxInFlightPerTenant ?? 4;
    this.maxInFlightByPool = options.maxInFlightByPool ?? {};
    assertPositiveInteger(this.leaseDurationMs, 'Worker lease duration');
    assertPositiveInteger(this.maxQueuedPerTenantAndPool, 'Worker queue limit');
    assertPositiveInteger(this.maxInFlightPerTenant, 'Worker tenant concurrency');
    for (const limit of Object.values(this.maxInFlightByPool)) {
      if (limit !== undefined) assertPositiveInteger(limit, 'Worker pool concurrency');
    }
  }

  async enqueue(request: WorkerTaskRequest): Promise<WorkerTaskRecord> {
    assertPool(request.pool);
    assertPositiveInteger(request.maxAttempts, 'Worker task maxAttempts');
    timestampMs(request.enqueuedAt);
    const key = taskKey(request.tenant, request.taskId);
    const existing = this.tasks.get(key);
    if (existing !== undefined) {
      if (JSON.stringify(existing.request) !== JSON.stringify(request)) {
        throw runtimeError(
          'CONCURRENCY_STALE_VERSION',
          `Worker task ${request.taskId} was already enqueued with another payload`,
        );
      }
      return recordFor(existing);
    }
    const queued = [...this.tasks.values()].filter(
      (task) =>
        task.state === 'queued' &&
        sameTenant(task.request.tenant, request.tenant) &&
        task.request.pool === request.pool,
    ).length;
    if (queued >= this.maxQueuedPerTenantAndPool) {
      throw runtimeError(
        'COMPUTE_RESOURCE_UNAVAILABLE',
        `Worker queue is full for ${request.pool}`,
      );
    }
    const task: StoredTask = {
      request: structuredClone(request),
      state: 'queued',
      attempt: 0,
      failures: [],
    };
    this.tasks.set(key, task);
    return recordFor(task);
  }

  async claim(
    tenant: TenantRef,
    pool: WorkerPoolName,
    workerId: string,
    now = this.clock(),
  ): Promise<WorkerLease | undefined> {
    assertPool(pool);
    assertWorkerId(workerId);
    const nowMs = timestampMs(now);
    this.requeueExpired(now, nowMs);
    const tenantInFlight = [...this.tasks.values()].filter(
      (task) => task.state === 'leased' && sameTenant(task.request.tenant, tenant),
    ).length;
    const poolInFlight = [...this.tasks.values()].filter(
      (task) => task.state === 'leased' && task.request.pool === pool,
    ).length;
    const poolLimit = this.maxInFlightByPool[pool] ?? Number.MAX_SAFE_INTEGER;
    if (tenantInFlight >= this.maxInFlightPerTenant || poolInFlight >= poolLimit) return undefined;
    const task = [...this.tasks.values()].find(
      (candidate) =>
        candidate.state === 'queued' &&
        sameTenant(candidate.request.tenant, tenant) &&
        candidate.request.pool === pool,
    );
    if (task === undefined) return undefined;
    if (task.attempt >= task.request.maxAttempts) {
      task.state = 'parked';
      return undefined;
    }
    task.attempt += 1;
    const lease: WorkerLease = {
      leaseId: newSortableId(),
      taskId: task.request.taskId,
      tenant: task.request.tenant,
      pool,
      workerId,
      payload: structuredClone(task.request.payload),
      attempt: task.attempt,
      leasedAt: now,
      expiresAt: new Date(nowMs + this.leaseDurationMs).toISOString(),
    };
    task.state = 'leased';
    task.lease = lease;
    return structuredClone(lease);
  }

  async heartbeat(
    tenant: TenantRef,
    leaseId: Id,
    workerId: string,
    now = this.clock(),
  ): Promise<WorkerLease> {
    const task = this.requireLease(tenant, leaseId, workerId, now);
    const nowMs = timestampMs(now);
    const lease = task.lease;
    if (lease === undefined)
      throw runtimeError('ARTIFACT_NOT_FOUND', 'Worker lease is unavailable');
    task.lease = {
      ...lease,
      expiresAt: new Date(nowMs + this.leaseDurationMs).toISOString(),
    };
    return structuredClone(task.lease);
  }

  async ack(
    tenant: TenantRef,
    leaseId: Id,
    workerId: string,
    now = this.clock(),
  ): Promise<WorkerTaskRecord> {
    const task = this.requireLease(tenant, leaseId, workerId, now);
    task.state = 'acked';
    delete task.lease;
    return recordFor(task);
  }

  async fail(
    tenant: TenantRef,
    leaseId: Id,
    workerId: string,
    code: string,
    now = this.clock(),
  ): Promise<WorkerTaskRecord> {
    if (code.trim().length === 0)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Worker failure code is required');
    const task = this.requireLease(tenant, leaseId, workerId, now);
    task.failures.push({ attempt: task.attempt, code, at: now });
    delete task.lease;
    if (task.attempt >= task.request.maxAttempts) {
      task.state = 'parked';
    } else {
      task.state = 'queued';
    }
    return recordFor(task);
  }

  async park(
    tenant: TenantRef,
    leaseId: Id,
    workerId: string,
    code: string,
    now = this.clock(),
  ): Promise<WorkerTaskRecord> {
    if (code.trim().length === 0)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Worker parking code is required');
    const task = this.requireLease(tenant, leaseId, workerId, now);
    task.failures.push({ attempt: task.attempt, code, at: now });
    task.state = 'parked';
    delete task.lease;
    return recordFor(task);
  }

  async get(tenant: TenantRef, taskId: Id): Promise<WorkerTaskRecord | undefined> {
    const task = this.tasks.get(taskKey(tenant, taskId));
    return task === undefined ? undefined : recordFor(task);
  }

  async lag(tenant: TenantRef, pool: WorkerPoolName): Promise<number> {
    assertPool(pool);
    return [...this.tasks.values()].filter(
      (task) =>
        sameTenant(task.request.tenant, tenant) &&
        task.request.pool === pool &&
        (task.state === 'queued' || task.state === 'leased'),
    ).length;
  }

  reapExpired(now = this.clock()): number {
    const nowMs = timestampMs(now);
    return this.requeueExpired(now, nowMs);
  }

  private requeueExpired(now: string, nowMs: number): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.state !== 'leased' || task.lease === undefined) continue;
      if (timestampMs(task.lease.expiresAt) > nowMs) continue;
      task.failures.push({ attempt: task.attempt, code: 'LEASE_EXPIRED', at: now });
      delete task.lease;
      task.state = task.attempt >= task.request.maxAttempts ? 'parked' : 'queued';
      count += 1;
    }
    return count;
  }

  private requireLease(tenant: TenantRef, leaseId: Id, workerId: string, now: string): StoredTask {
    assertWorkerId(workerId);
    const task = [...this.tasks.values()].find((candidate) => candidate.lease?.leaseId === leaseId);
    if (task === undefined)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Worker lease ${leaseId} was not found`);
    if (!sameTenant(task.request.tenant, tenant))
      throw runtimeError('POLICY_DENIED', 'Worker cannot mutate another tenant task');
    if (task.lease?.workerId !== workerId)
      throw runtimeError('POLICY_DENIED', 'Worker does not own the lease');
    if (timestampMs(task.lease.expiresAt) <= timestampMs(now))
      throw runtimeError('CONCURRENCY_STALE_VERSION', 'Worker lease has expired');
    return task;
  }
}

export interface HostedWorkerPoolClient {
  enqueue(request: WorkerTaskRequest): Promise<WorkerTaskRecord>;
  claim(request: {
    readonly tenant: TenantRef;
    readonly pool: WorkerPoolName;
    readonly workerId: string;
    readonly now?: string;
  }): Promise<WorkerLease | undefined>;
  heartbeat(request: {
    readonly tenant: TenantRef;
    readonly leaseId: Id;
    readonly workerId: string;
    readonly now?: string;
  }): Promise<WorkerLease>;
  ack(request: {
    readonly tenant: TenantRef;
    readonly leaseId: Id;
    readonly workerId: string;
    readonly now?: string;
  }): Promise<WorkerTaskRecord>;
  fail(request: {
    readonly tenant: TenantRef;
    readonly leaseId: Id;
    readonly workerId: string;
    readonly code: string;
    readonly now?: string;
  }): Promise<WorkerTaskRecord>;
  park(request: {
    readonly tenant: TenantRef;
    readonly leaseId: Id;
    readonly workerId: string;
    readonly code: string;
    readonly now?: string;
  }): Promise<WorkerTaskRecord>;
  get(tenant: TenantRef, taskId: Id): Promise<WorkerTaskRecord | undefined>;
  lag(tenant: TenantRef, pool: WorkerPoolName): Promise<number>;
}

function assertHostedLease(
  lease: WorkerLease,
  tenant: TenantRef,
  pool: WorkerPoolName,
): WorkerLease {
  if (!isWorkerPoolName(lease.pool) || !sameTenant(lease.tenant, tenant) || lease.pool !== pool) {
    throw runtimeError(
      'VALIDATION_SCHEMA_MISMATCH',
      'Hosted worker pool returned an invalid lease',
    );
  }
  return structuredClone(lease);
}

function assertHostedRecord(record: WorkerTaskRecord, tenant: TenantRef): WorkerTaskRecord {
  if (!isWorkerPoolName(record.pool) || !sameTenant(record.tenant, tenant)) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Hosted worker pool returned another tenant');
  }
  return structuredClone(record);
}

export class HostedWorkerPool implements WorkerPool {
  constructor(private readonly client: HostedWorkerPoolClient) {}

  async enqueue(request: WorkerTaskRequest): Promise<WorkerTaskRecord> {
    assertPool(request.pool);
    return assertHostedRecord(await this.client.enqueue(structuredClone(request)), request.tenant);
  }

  async claim(
    tenant: TenantRef,
    pool: WorkerPoolName,
    workerId: string,
    now?: string,
  ): Promise<WorkerLease | undefined> {
    assertPool(pool);
    const lease = await this.client.claim({ tenant, pool, workerId, ...(now ? { now } : {}) });
    return lease === undefined ? undefined : assertHostedLease(lease, tenant, pool);
  }

  heartbeat(tenant: TenantRef, leaseId: Id, workerId: string, now?: string): Promise<WorkerLease> {
    return this.client
      .heartbeat({ tenant, leaseId, workerId, ...(now ? { now } : {}) })
      .then((lease) => assertHostedLease(lease, tenant, lease.pool));
  }

  async ack(
    tenant: TenantRef,
    leaseId: Id,
    workerId: string,
    now?: string,
  ): Promise<WorkerTaskRecord> {
    return assertHostedRecord(
      await this.client.ack({ tenant, leaseId, workerId, ...(now ? { now } : {}) }),
      tenant,
    );
  }

  async fail(
    tenant: TenantRef,
    leaseId: Id,
    workerId: string,
    code: string,
    now?: string,
  ): Promise<WorkerTaskRecord> {
    return assertHostedRecord(
      await this.client.fail({ tenant, leaseId, workerId, code, ...(now ? { now } : {}) }),
      tenant,
    );
  }

  async park(
    tenant: TenantRef,
    leaseId: Id,
    workerId: string,
    code: string,
    now?: string,
  ): Promise<WorkerTaskRecord> {
    return assertHostedRecord(
      await this.client.park({ tenant, leaseId, workerId, code, ...(now ? { now } : {}) }),
      tenant,
    );
  }

  get(tenant: TenantRef, taskId: Id): Promise<WorkerTaskRecord | undefined> {
    return this.client
      .get(tenant, taskId)
      .then((record) => (record === undefined ? undefined : assertHostedRecord(record, tenant)));
  }

  lag(tenant: TenantRef, pool: WorkerPoolName): Promise<number> {
    assertPool(pool);
    return this.client.lag(tenant, pool);
  }
}
