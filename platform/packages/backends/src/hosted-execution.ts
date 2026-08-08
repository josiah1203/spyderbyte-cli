import {
  newSortableId,
  runtimeError,
  type Id,
  type JsonValue,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';

export type HostedExecutionTargetKind = 'kubernetes' | 'slurm' | 'customer_cloud';
export type HostedExecutionState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface HostedExecutionTargetV1 {
  readonly targetId: Id;
  readonly tenant: TenantRef;
  readonly kind: HostedExecutionTargetKind;
  readonly region: string;
  readonly capabilities: readonly string[];
  readonly enabled: boolean;
}

export interface HostedSandboxPolicyV1 {
  readonly networkAllowlist: readonly string[];
  readonly readOnlyArtifactMounts: boolean;
  readonly ephemeralFilesystem: boolean;
  readonly maxOutputBytes: number;
  readonly maxWallTimeMs: number;
  readonly maxProcessCount: number;
}

export interface HostedExecutionRequestV1 {
  readonly executionId: Id;
  readonly tenant: TenantRef;
  readonly targetId: Id;
  readonly command: string;
  readonly args: readonly string[];
  readonly resources: Readonly<Record<string, number>>;
  readonly sandbox: HostedSandboxPolicyV1;
  readonly payload?: JsonValue;
}

export interface HostedExecutionHandleV1 {
  readonly executionId: Id;
  readonly externalExecutionId: string;
  readonly tenant: TenantRef;
  readonly targetId: Id;
  readonly state: HostedExecutionState;
  readonly submittedAt: string;
}

export interface HostedExecutionObservationV1 {
  readonly handle: HostedExecutionHandleV1;
  readonly state: HostedExecutionState;
  readonly observedAt: string;
  readonly attempt: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly usage?: Readonly<Record<string, number>>;
  readonly failureCode?: string;
}

export interface HostedExecutionClient {
  submit(
    request: HostedExecutionRequestV1,
  ): Promise<{ readonly externalExecutionId: string; readonly state: HostedExecutionState }>;
  observe(handle: HostedExecutionHandleV1): Promise<HostedExecutionObservationV1>;
  terminate(handle: HostedExecutionHandleV1): Promise<void>;
}

export interface HostedExecutionAdapterOptions {
  readonly clock?: () => string;
  readonly maxConcurrentPerTenant?: number;
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

function assertPositive(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} must be positive`);
}

function assertSandbox(policy: HostedSandboxPolicyV1): void {
  if (policy.networkAllowlist.length === 0)
    throw runtimeError('POLICY_DENIED', 'Hosted execution requires a non-empty network allowlist');
  assertPositive(policy.maxOutputBytes, 'Hosted maxOutputBytes');
  assertPositive(policy.maxWallTimeMs, 'Hosted maxWallTimeMs');
  assertPositive(policy.maxProcessCount, 'Hosted maxProcessCount');
  for (const host of policy.networkAllowlist) {
    if (host.trim().length === 0 || host.includes('://') || host.includes('*'))
      throw runtimeError('POLICY_DENIED', 'Hosted network allowlist contains an invalid host');
  }
}

function assertState(value: string): asserts value is HostedExecutionState {
  if (!['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(value))
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Hosted execution returned an invalid state');
}

export class HostedExecutionAdapter {
  private readonly client: HostedExecutionClient;
  private readonly targets = new Map<string, HostedExecutionTargetV1>();
  private readonly handles = new Map<Id, HostedExecutionHandleV1>();
  private readonly activeByTenant = new Map<string, number>();
  private readonly clock: () => string;
  private readonly maxConcurrentPerTenant: number;

  constructor(client: HostedExecutionClient, options: HostedExecutionAdapterOptions = {}) {
    this.client = client;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.maxConcurrentPerTenant = options.maxConcurrentPerTenant ?? 8;
    assertPositive(this.maxConcurrentPerTenant, 'Hosted tenant concurrency');
  }

  registerTarget(target: HostedExecutionTargetV1): HostedExecutionTargetV1 {
    if (target.region.trim().length === 0 || target.capabilities.length === 0)
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'Hosted target region and capabilities are required',
      );
    const key = `${tenantKey(target.tenant)}:${target.targetId}`;
    if (this.targets.has(key))
      throw runtimeError(
        'CONCURRENCY_STALE_VERSION',
        `Hosted target ${target.targetId} already exists`,
      );
    this.targets.set(key, clone(target));
    return clone(target);
  }

  async submit(
    request: Omit<HostedExecutionRequestV1, 'executionId'> & { readonly executionId?: Id },
  ): Promise<HostedExecutionHandleV1> {
    assertSandbox(request.sandbox);
    if (request.command.trim().length === 0 || request.command.includes(' '))
      throw runtimeError(
        'POLICY_DENIED',
        'Hosted execution command must be an executable without shell syntax',
      );
    const target = this.targets.get(`${tenantKey(request.tenant)}:${request.targetId}`);
    if (target === undefined || !target.enabled)
      throw runtimeError('COMPUTE_RESOURCE_UNAVAILABLE', 'Hosted execution target is unavailable');
    const active = this.activeByTenant.get(tenantKey(request.tenant)) ?? 0;
    if (active >= this.maxConcurrentPerTenant)
      throw runtimeError(
        'COMPUTE_RESOURCE_UNAVAILABLE',
        'Hosted tenant execution quota is exhausted',
      );
    const executionId = request.executionId ?? newSortableId();
    const submitted = await this.client.submit({ ...clone(request), executionId });
    assertState(submitted.state);
    if (submitted.externalExecutionId.trim().length === 0)
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Hosted execution returned no external ID');
    const handle: HostedExecutionHandleV1 = {
      executionId,
      externalExecutionId: submitted.externalExecutionId,
      tenant: clone(request.tenant),
      targetId: request.targetId,
      state: submitted.state,
      submittedAt: this.clock(),
    };
    this.handles.set(executionId, handle);
    if (!['succeeded', 'failed', 'cancelled'].includes(handle.state))
      this.activeByTenant.set(tenantKey(request.tenant), active + 1);
    return clone(handle);
  }

  async observe(tenant: TenantRef, executionId: Id): Promise<HostedExecutionObservationV1> {
    const handle = this.requireHandle(tenant, executionId);
    const observation = await this.client.observe(clone(handle));
    assertState(observation.state);
    if (
      !sameTenant(observation.handle.tenant, tenant) ||
      observation.handle.executionId !== executionId ||
      observation.handle.externalExecutionId !== handle.externalExecutionId
    )
      throw runtimeError(
        'VALIDATION_SCHEMA_MISMATCH',
        'Hosted execution crossed tenant or execution scope',
      );
    const normalized = { ...observation, handle: { ...handle, state: observation.state } };
    this.handles.set(executionId, normalized.handle);
    if (
      !['succeeded', 'failed', 'cancelled'].includes(handle.state) &&
      ['succeeded', 'failed', 'cancelled'].includes(observation.state)
    )
      this.activeByTenant.set(
        tenantKey(tenant),
        Math.max(0, (this.activeByTenant.get(tenantKey(tenant)) ?? 1) - 1),
      );
    return clone(normalized);
  }

  async terminate(tenant: TenantRef, executionId: Id): Promise<void> {
    const handle = this.requireHandle(tenant, executionId);
    if (['succeeded', 'failed', 'cancelled'].includes(handle.state)) return;
    await this.client.terminate(clone(handle));
    this.handles.set(executionId, { ...handle, state: 'cancelled' });
    this.activeByTenant.set(
      tenantKey(tenant),
      Math.max(0, (this.activeByTenant.get(tenantKey(tenant)) ?? 1) - 1),
    );
  }

  get(tenant: TenantRef, executionId: Id): HostedExecutionHandleV1 | undefined {
    const handle = this.handles.get(executionId);
    return handle === undefined || !sameTenant(handle.tenant, tenant) ? undefined : clone(handle);
  }

  listTargets(tenant: TenantRef): readonly HostedExecutionTargetV1[] {
    return clone([...this.targets.values()].filter((target) => sameTenant(target.tenant, tenant)));
  }

  list(tenant: TenantRef): readonly HostedExecutionHandleV1[] {
    return clone([...this.handles.values()].filter((handle) => sameTenant(handle.tenant, tenant)));
  }

  private requireHandle(tenant: TenantRef, executionId: Id): HostedExecutionHandleV1 {
    const handle = this.handles.get(executionId);
    if (handle === undefined)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Hosted execution ${executionId} was not found`);
    if (!sameTenant(handle.tenant, tenant))
      throw runtimeError('POLICY_DENIED', 'Hosted execution crosses tenant boundary');
    return handle;
  }
}
