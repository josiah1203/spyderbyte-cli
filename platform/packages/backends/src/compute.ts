import { spawn, type ChildProcess } from 'node:child_process';
import { cpus, totalmem } from 'node:os';
import {
  makeMoney,
  newSortableId,
  runtimeError,
  type AuthorityEnvelope,
  type Id,
  type Money,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';

export interface ComputeResources {
  readonly cpuMillicores: number;
  readonly memoryBytes: number;
  readonly gpuCount: number;
}

export interface CapacityRequest {
  readonly tenant: TenantRef;
  readonly minimum?: Partial<ComputeResources>;
}

export interface CapacitySnapshot {
  readonly backendId: string;
  readonly observedAt: string;
  readonly total: ComputeResources;
  readonly free: ComputeResources;
}

export interface WorkloadRequirements {
  readonly tenant: TenantRef;
  readonly name: string;
  readonly resources: ComputeResources;
  readonly durationSeconds: number;
  readonly maxCostMinor: number;
  readonly currency: string;
}

export interface ComputeOffer {
  readonly offerId: Id;
  readonly backendId: string;
  readonly tenant: TenantRef;
  readonly resources: ComputeResources;
  readonly estimatedCost: Money;
  readonly expiresAt: string;
  readonly workloadName: string;
  readonly costBasis?: ComputeCostBasis;
}

export interface ComputeCostBasis {
  readonly cpuMinorPerSecond: number;
  readonly gpuMinorPerSecond: number;
}

export interface ApprovedAllocationGrant {
  readonly grantId: Id;
  readonly offerId: Id;
  readonly tenant: TenantRef;
  readonly specialistType: 'cluster';
  readonly tier: 1;
  readonly authority: AuthorityEnvelope;
  readonly approved: boolean;
  readonly approvalDigest: string;
  readonly budgetId: Id;
  readonly estimatedCost: Money;
  readonly expiresAt: string;
}

export interface ComputeAllocation {
  readonly allocationId: Id;
  readonly offer: ComputeOffer;
  readonly grantId: Id;
  readonly allocatedAt: string;
  readonly state: 'allocated' | 'released';
}

export interface JobSpecification {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly wallTimeMs?: number;
  readonly outputBytes?: number;
}

export type ComputeFailureCode =
  | 'USER_CODE'
  | 'OUT_OF_MEMORY'
  | 'CAPACITY_UNAVAILABLE'
  | 'PREEMPTION'
  | 'NODE_FAILURE'
  | 'NETWORK'
  | 'NCCL'
  | 'SCHEDULER_REJECTION'
  | 'BUDGET_REJECTION'
  | 'POLICY_REJECTION'
  | 'UNKNOWN_INFRASTRUCTURE';

export interface JobHandle {
  readonly jobId: Id;
  readonly allocationId: Id;
  readonly submittedAt: string;
}

export interface JobObservation {
  readonly job: JobHandle;
  readonly status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  readonly observedAt: string;
  readonly attempt: number;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly cpuSeconds?: number;
  readonly gpuSeconds?: number;
  readonly memoryBytes?: number;
  readonly failureCode?: ComputeFailureCode;
}

export interface ComputeBackend {
  inspectCapacity(request: CapacityRequest): Promise<CapacitySnapshot>;
  estimate(workload: WorkloadRequirements): Promise<ComputeOffer[]>;
  allocate(offer: ComputeOffer, grant: ApprovedAllocationGrant): Promise<ComputeAllocation>;
  submitJob(allocation: ComputeAllocation, spec: JobSpecification): Promise<JobHandle>;
  observeJob(job: JobHandle): AsyncIterable<JobObservation>;
  terminate(job: JobHandle): Promise<void>;
}

interface LocalJob {
  readonly handle: JobHandle;
  readonly allocation: ComputeAllocation;
  readonly process: ChildProcess;
  stdout: string;
  stderr: string;
  outputBytes: number;
  startedAt: number;
  finished?: JobObservation;
  timer?: ReturnType<typeof setTimeout>;
  released: boolean;
}

interface LocalComputeOptions {
  readonly backendId?: string;
  readonly capacity?: ComputeResources;
  readonly clock?: () => string;
  readonly costPerCpuSecondMinor?: number;
  readonly costPerGpuSecondMinor?: number;
}

function tenantKey(tenant: TenantRef): string {
  return `${tenant.tenantId}:${tenant.workspaceId}`;
}

function assertAllocationGrant(
  offer: ComputeOffer,
  grant: ApprovedAllocationGrant,
  backendId: string,
  now: string,
): void {
  if (offer.backendId !== backendId) {
    throw runtimeError('COMPUTE_RESOURCE_UNAVAILABLE', 'Compute offer belongs to another backend');
  }
  if (tenantKey(offer.tenant) !== tenantKey(grant.tenant) || grant.offerId !== offer.offerId) {
    throw runtimeError('POLICY_DENIED', 'Allocation grant is not bound to the compute offer');
  }
  if (grant.specialistType !== 'cluster' || grant.tier !== 1 || !grant.approved) {
    throw runtimeError(
      'AUTHORITY_MISSING',
      'Only an approved Tier 1 Cluster grant may allocate compute',
    );
  }
  if (
    grant.authority.tier !== 1 ||
    grant.authority.subjectAgentId === undefined ||
    tenantKey(grant.authority.tenant) !== tenantKey(offer.tenant) ||
    !grant.authority.permittedActions.includes('compute.allocate') ||
    !grant.authority.resourceScopes.some(
      (scope) => scope.kind === 'compute' && scope.id === backendId,
    ) ||
    Date.parse(grant.authority.expiresAt) <= Date.parse(now)
  ) {
    throw runtimeError('AUTHORITY_MISSING', 'Allocation grant authority is invalid');
  }
  if (
    grant.estimatedCost.amountMinor < offer.estimatedCost.amountMinor ||
    grant.estimatedCost.currency !== offer.estimatedCost.currency
  ) {
    throw runtimeError('BUDGET_EXCEEDED', 'Allocation grant does not cover the offered cost');
  }
  if (
    Date.parse(grant.expiresAt) <= Date.parse(now) ||
    Date.parse(offer.expiresAt) <= Date.parse(now)
  ) {
    throw runtimeError('AUTHORITY_EXPIRED', 'Compute offer or grant has expired');
  }
}

function fits(available: ComputeResources, requested: ComputeResources): boolean {
  return (
    available.cpuMillicores >= requested.cpuMillicores &&
    available.memoryBytes >= requested.memoryBytes &&
    available.gpuCount >= requested.gpuCount
  );
}

function subtract(left: ComputeResources, right: ComputeResources): ComputeResources {
  return {
    cpuMillicores: left.cpuMillicores - right.cpuMillicores,
    memoryBytes: left.memoryBytes - right.memoryBytes,
    gpuCount: left.gpuCount - right.gpuCount,
  };
}

function add(left: ComputeResources, right: ComputeResources): ComputeResources {
  return {
    cpuMillicores: left.cpuMillicores + right.cpuMillicores,
    memoryBytes: left.memoryBytes + right.memoryBytes,
    gpuCount: left.gpuCount + right.gpuCount,
  };
}

function assertResources(resources: ComputeResources): void {
  if (
    !Number.isSafeInteger(resources.cpuMillicores) ||
    resources.cpuMillicores < 1 ||
    !Number.isSafeInteger(resources.memoryBytes) ||
    resources.memoryBytes < 1 ||
    !Number.isSafeInteger(resources.gpuCount) ||
    resources.gpuCount < 0
  ) {
    throw runtimeError(
      'VALIDATION_INVALID_INPUT',
      'Compute resources must be non-negative integers',
    );
  }
}

function assertCostBasis(costBasis: ComputeCostBasis): void {
  if (
    !Number.isSafeInteger(costBasis.cpuMinorPerSecond) ||
    costBasis.cpuMinorPerSecond < 0 ||
    !Number.isSafeInteger(costBasis.gpuMinorPerSecond) ||
    costBasis.gpuMinorPerSecond < 0
  ) {
    throw runtimeError(
      'VALIDATION_INVALID_INPUT',
      'Compute cost rates must be non-negative integer minor units per second',
    );
  }
}

function classifyFailure(
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): ComputeFailureCode {
  const lower = stderr.toLowerCase();
  if (lower.includes('out of memory') || lower.includes('oom')) return 'OUT_OF_MEMORY';
  if (lower.includes('network') || lower.includes('econn')) return 'NETWORK';
  if (lower.includes('nccl')) return 'NCCL';
  if (signal === 'SIGTERM' || signal === 'SIGKILL') return 'PREEMPTION';
  if (exitCode !== 0) return 'USER_CODE';
  return 'UNKNOWN_INFRASTRUCTURE';
}

function secretLike(key: string): boolean {
  return /(secret|token|password|api[_-]?key|private[_-]?key)/i.test(key);
}

export class LocalComputeBackend implements ComputeBackend {
  private readonly backendId: string;
  private readonly clock: () => string;
  private readonly costPerCpuSecondMinor: number;
  private readonly costPerGpuSecondMinor: number;
  private readonly total: ComputeResources;
  private free: ComputeResources;
  private readonly offers = new Map<Id, ComputeOffer>();
  private readonly allocations = new Map<Id, ComputeAllocation>();
  private readonly jobs = new Map<Id, LocalJob>();

  constructor(options: LocalComputeOptions = {}) {
    this.backendId = options.backendId ?? 'local';
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.costPerCpuSecondMinor = options.costPerCpuSecondMinor ?? 1;
    this.costPerGpuSecondMinor = options.costPerGpuSecondMinor ?? 10;
    assertCostBasis({
      cpuMinorPerSecond: this.costPerCpuSecondMinor,
      gpuMinorPerSecond: this.costPerGpuSecondMinor,
    });
    this.total = options.capacity ?? {
      cpuMillicores: Math.max(1, cpus().length * 1000),
      memoryBytes: Math.max(1, totalmem()),
      gpuCount: 0,
    };
    assertResources(this.total);
    this.free = { ...this.total };
  }

  async inspectCapacity(request: CapacityRequest): Promise<CapacitySnapshot> {
    if (!request.tenant.tenantId || !request.tenant.workspaceId) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Tenant is required for capacity inspection');
    }
    if (request.minimum !== undefined) {
      const minimum: ComputeResources = {
        cpuMillicores: request.minimum.cpuMillicores ?? 0,
        memoryBytes: request.minimum.memoryBytes ?? 0,
        gpuCount: request.minimum.gpuCount ?? 0,
      };
      if (!fits(this.free, minimum)) {
        throw runtimeError(
          'COMPUTE_RESOURCE_UNAVAILABLE',
          'Local capacity is below the requested minimum',
        );
      }
    }
    return {
      backendId: this.backendId,
      observedAt: this.clock(),
      total: { ...this.total },
      free: { ...this.free },
    };
  }

  async estimate(workload: WorkloadRequirements): Promise<ComputeOffer[]> {
    assertResources(workload.resources);
    if (!Number.isSafeInteger(workload.durationSeconds) || workload.durationSeconds < 1) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'Workload duration must be a positive integer',
      );
    }
    if (!fits(this.free, workload.resources)) return [];
    const amountMinor =
      (workload.resources.cpuMillicores * workload.durationSeconds * this.costPerCpuSecondMinor) /
        1000 +
      workload.resources.gpuCount * workload.durationSeconds * this.costPerGpuSecondMinor;
    const estimatedCost = makeMoney(Math.ceil(amountMinor), workload.currency);
    if (estimatedCost.amountMinor > workload.maxCostMinor) return [];
    const offer: ComputeOffer = {
      offerId: newSortableId(),
      backendId: this.backendId,
      tenant: workload.tenant,
      resources: { ...workload.resources },
      estimatedCost,
      expiresAt: new Date(Date.parse(this.clock()) + workload.durationSeconds * 1000).toISOString(),
      workloadName: workload.name,
      costBasis: {
        cpuMinorPerSecond: this.costPerCpuSecondMinor,
        gpuMinorPerSecond: this.costPerGpuSecondMinor,
      },
    };
    this.offers.set(offer.offerId, offer);
    return [structuredClone(offer)];
  }

  async allocate(offer: ComputeOffer, grant: ApprovedAllocationGrant): Promise<ComputeAllocation> {
    const registered = this.offers.get(offer.offerId);
    if (!registered || registered.backendId !== this.backendId) {
      throw runtimeError(
        'COMPUTE_RESOURCE_UNAVAILABLE',
        'Compute offer is unknown or belongs to another backend',
      );
    }
    assertAllocationGrant(registered, grant, this.backendId, this.clock());
    if (!fits(this.free, registered.resources)) {
      throw runtimeError(
        'COMPUTE_RESOURCE_UNAVAILABLE',
        'Capacity was consumed before allocation commit',
      );
    }
    this.free = subtract(this.free, registered.resources);
    const allocation: ComputeAllocation = {
      allocationId: newSortableId(),
      offer: structuredClone(registered),
      grantId: grant.grantId,
      allocatedAt: this.clock(),
      state: 'allocated',
    };
    this.allocations.set(allocation.allocationId, allocation);
    this.offers.delete(offer.offerId);
    return structuredClone(allocation);
  }

  async submitJob(allocation: ComputeAllocation, spec: JobSpecification): Promise<JobHandle> {
    const stored = this.allocations.get(allocation.allocationId);
    if (!stored || stored.state !== 'allocated') {
      throw runtimeError('COMPUTE_RESOURCE_UNAVAILABLE', 'Compute allocation is not active');
    }
    if (spec.command.length === 0 || (spec.wallTimeMs !== undefined && spec.wallTimeMs < 1)) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Job command and deadline are invalid');
    }
    if (Object.keys(spec.env ?? {}).some(secretLike)) {
      throw runtimeError(
        'SECRET_EXPOSURE_BLOCKED',
        'Secret-like environment keys must be injected by a broker boundary',
      );
    }
    const process = spawn(spec.command, [...(spec.args ?? [])], {
      cwd: spec.cwd,
      env: { ...processEnv(), ...(spec.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const handle: JobHandle = {
      jobId: newSortableId(),
      allocationId: allocation.allocationId,
      submittedAt: this.clock(),
    };
    const job: LocalJob = {
      handle,
      allocation: stored,
      process,
      stdout: '',
      stderr: '',
      outputBytes: 0,
      startedAt: Date.now(),
      released: false,
    };
    const outputLimit = spec.outputBytes ?? 4 * 1024 * 1024;
    const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      job.outputBytes += chunk.byteLength;
      if (job.outputBytes > outputLimit) {
        job.stderr += '\noutput limit exceeded';
        process.kill('SIGKILL');
        return;
      }
      job[target] += chunk.toString('utf8');
    };
    process.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
    process.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (job.finished !== undefined) return;
      const cancelled = signal === 'SIGTERM' || signal === 'SIGKILL';
      job.finished = {
        job: handle,
        status: cancelled ? 'cancelled' : exitCode === 0 ? 'succeeded' : 'failed',
        observedAt: this.clock(),
        attempt: 1,
        ...(exitCode !== null ? { exitCode } : {}),
        ...(signal !== null ? { signal } : {}),
        stdout: job.stdout,
        stderr: job.stderr,
        cpuSeconds:
          (Math.max(0, (Date.now() - job.startedAt) / 1000) *
            stored.offer.resources.cpuMillicores) /
          1000,
        gpuSeconds:
          Math.max(0, (Date.now() - job.startedAt) / 1000) * stored.offer.resources.gpuCount,
        memoryBytes: stored.offer.resources.memoryBytes,
        ...(exitCode !== 0 && !cancelled
          ? { failureCode: classifyFailure(exitCode, signal, job.stderr) }
          : {}),
      };
      if (job.timer !== undefined) clearTimeout(job.timer);
      this.release(job);
    };
    process.once('error', () => finish(1, null));
    process.once('close', (code, signal) => finish(code, signal));
    if (spec.wallTimeMs !== undefined) {
      job.timer = setTimeout(() => {
        if (job.finished === undefined) {
          job.stderr += '\ndeadline exceeded';
          process.kill('SIGTERM');
          setTimeout(() => {
            if (job.finished === undefined) process.kill('SIGKILL');
          }, 50);
        }
      }, spec.wallTimeMs);
    }
    this.jobs.set(handle.jobId, job);
    return handle;
  }

  async *observeJob(jobHandle: JobHandle): AsyncIterable<JobObservation> {
    const job = this.jobs.get(jobHandle.jobId);
    if (!job) throw runtimeError('ARTIFACT_NOT_FOUND', `Job ${jobHandle.jobId} was not found`);
    yield {
      job: job.handle,
      status: job.finished === undefined ? 'running' : job.finished.status,
      observedAt: this.clock(),
      attempt: 1,
      stdout: job.stdout,
      stderr: job.stderr,
    };
    while (job.finished === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    yield structuredClone(job.finished);
  }

  async terminate(jobHandle: JobHandle): Promise<void> {
    const job = this.jobs.get(jobHandle.jobId);
    if (!job) return;
    if (job.finished === undefined) job.process.kill('SIGTERM');
  }

  private release(job: LocalJob): void {
    if (job.released) return;
    job.released = true;
    const allocation = this.allocations.get(job.allocation.allocationId);
    if (allocation !== undefined) {
      this.allocations.set(allocation.allocationId, { ...allocation, state: 'released' });
      this.free = add(this.free, allocation.offer.resources);
    }
  }
}

export interface HostedSchedulerClient {
  inspectCapacity(request: CapacityRequest): Promise<CapacitySnapshot>;
  estimate(workload: WorkloadRequirements): Promise<readonly ComputeOffer[]>;
  allocate(offer: ComputeOffer, grant: ApprovedAllocationGrant): Promise<ComputeAllocation>;
  submitJob(allocation: ComputeAllocation, spec: JobSpecification): Promise<JobHandle>;
  observeJob(job: JobHandle): AsyncIterable<JobObservation>;
  terminate(job: JobHandle): Promise<void>;
}

export class HostedComputeBackend implements ComputeBackend {
  private readonly client: HostedSchedulerClient;
  private readonly backendId: string;
  private readonly clock: () => string;

  constructor(options: { client: HostedSchedulerClient; backendId: string; clock?: () => string }) {
    if (options.backendId.trim().length === 0)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Hosted compute backend ID is required');
    this.client = options.client;
    this.backendId = options.backendId;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async inspectCapacity(request: CapacityRequest): Promise<CapacitySnapshot> {
    const snapshot = await this.client.inspectCapacity(request);
    if (snapshot.backendId !== this.backendId)
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Hosted scheduler returned another backend');
    return structuredClone(snapshot);
  }

  async estimate(workload: WorkloadRequirements): Promise<ComputeOffer[]> {
    const offers = await this.client.estimate(workload);
    for (const offer of offers) {
      if (
        offer.backendId !== this.backendId ||
        tenantKey(offer.tenant) !== tenantKey(workload.tenant)
      ) {
        throw runtimeError(
          'VALIDATION_SCHEMA_MISMATCH',
          'Hosted scheduler returned an offer outside the requested scope',
        );
      }
    }
    return [...structuredClone(offers)];
  }

  async allocate(offer: ComputeOffer, grant: ApprovedAllocationGrant): Promise<ComputeAllocation> {
    assertAllocationGrant(offer, grant, this.backendId, this.clock());
    const allocation = await this.client.allocate(offer, grant);
    if (
      allocation.offer.offerId !== offer.offerId ||
      allocation.offer.backendId !== this.backendId ||
      tenantKey(allocation.offer.tenant) !== tenantKey(offer.tenant)
    ) {
      throw runtimeError(
        'VALIDATION_SCHEMA_MISMATCH',
        'Hosted scheduler returned an invalid allocation',
      );
    }
    return structuredClone(allocation);
  }

  async submitJob(allocation: ComputeAllocation, spec: JobSpecification): Promise<JobHandle> {
    if (allocation.offer.backendId !== this.backendId)
      throw runtimeError('POLICY_DENIED', 'Job allocation belongs to another compute backend');
    if (Object.keys(spec.env ?? {}).some(secretLike)) {
      throw runtimeError(
        'SECRET_EXPOSURE_BLOCKED',
        'Secret-like environment keys must be injected by a broker boundary',
      );
    }
    const job = await this.client.submitJob(allocation, spec);
    if (job.allocationId !== allocation.allocationId)
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Hosted scheduler returned an unbound job');
    return structuredClone(job);
  }

  async *observeJob(job: JobHandle): AsyncIterable<JobObservation> {
    for await (const observation of this.client.observeJob(job)) {
      if (
        observation.job.jobId !== job.jobId ||
        observation.job.allocationId !== job.allocationId
      ) {
        throw runtimeError(
          'VALIDATION_SCHEMA_MISMATCH',
          'Hosted scheduler returned an unbound observation',
        );
      }
      yield structuredClone(observation);
    }
  }

  terminate(job: JobHandle): Promise<void> {
    return this.client.terminate(job);
  }
}

function processEnv(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !secretLike(key)) environment[key] = value;
  }
  return environment;
}

export function computeActualCost(offer: ComputeOffer, observation: JobObservation): Money {
  if (
    offer.costBasis === undefined ||
    observation.cpuSeconds === undefined ||
    !Number.isFinite(observation.cpuSeconds)
  )
    return offer.estimatedCost;
  const gpuSeconds =
    observation.gpuSeconds !== undefined && Number.isFinite(observation.gpuSeconds)
      ? observation.gpuSeconds
      : 0;
  const amountMinor = Math.ceil(
    Math.max(0, observation.cpuSeconds) * offer.costBasis.cpuMinorPerSecond +
      Math.max(0, gpuSeconds) * offer.costBasis.gpuMinorPerSecond,
  );
  return makeMoney(amountMinor, offer.estimatedCost.currency);
}
