import {
  newSortableId,
  runtimeError,
  transitionDeployment,
  type DeploymentAction,
  type DeploymentState,
  type Id,
  type JsonValue,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';

export type ServingEndpointState = 'provisioning' | 'ready' | 'degraded' | 'failed' | 'deleted';
export type ServingHealthState = 'unknown' | 'healthy' | 'unhealthy';

export interface ServingEndpointV1 {
  readonly endpointId: Id;
  readonly tenant: TenantRef;
  readonly name: string;
  readonly modelName: string;
  readonly protocol: 'http' | 'grpc';
  readonly state: ServingEndpointState;
  readonly activeDeploymentId?: Id;
  readonly previousDeploymentId?: Id;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ServingRevisionV1 {
  readonly deploymentId: Id;
  readonly endpointId: Id;
  readonly tenant: TenantRef;
  readonly modelVersionId: Id;
  readonly manifest: JsonValue;
  readonly state: DeploymentState;
  readonly trafficPercent: number;
  readonly health: ServingHealthState;
  readonly consecutiveFailures: number;
  readonly lastHealthCheckAt?: string;
  readonly error?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ServingTrafficApproval {
  readonly approved: boolean;
  readonly actionDigest: string;
  readonly commitDigest: string;
  readonly expiresAt: string;
  readonly now: string;
}

export interface ServingHealthObservation {
  readonly healthy: boolean;
  readonly observedAt?: string;
  readonly error?: string;
}

export interface ServingAuditRecord {
  readonly auditId: Id;
  readonly tenant: TenantRef;
  readonly action: string;
  readonly targetId: Id;
  readonly outcome: 'completed' | 'denied' | 'failed';
  readonly details: JsonValue;
  readonly at: string;
}

export interface ServingEndpointManager {
  createEndpoint(input: {
    readonly tenant: TenantRef;
    readonly name: string;
    readonly modelName: string;
    readonly protocol?: 'http' | 'grpc';
    readonly now?: string;
  }): ServingEndpointV1;
  getEndpoint(tenant: TenantRef, endpointId: Id): ServingEndpointV1 | undefined;
  listEndpoints(tenant: TenantRef): readonly ServingEndpointV1[];
  requestDeployment(input: {
    readonly tenant: TenantRef;
    readonly endpointId: Id;
    readonly modelVersionId: Id;
    readonly manifest: JsonValue;
    readonly now?: string;
  }): ServingRevisionV1;
  advance(
    tenant: TenantRef,
    deploymentId: Id,
    action: DeploymentAction,
    approval?: ServingTrafficApproval,
  ): ServingRevisionV1;
  observeHealth(
    tenant: TenantRef,
    deploymentId: Id,
    observation: ServingHealthObservation,
  ): ServingRevisionV1;
  automaticRollbackIfUnhealthy(
    tenant: TenantRef,
    deploymentId: Id,
    approval: ServingTrafficApproval,
  ): ServingRevisionV1;
  getRevision(tenant: TenantRef, deploymentId: Id): ServingRevisionV1 | undefined;
  listRevisions(tenant: TenantRef, endpointId: Id): readonly ServingRevisionV1[];
  auditRecords(tenant?: TenantRef): readonly ServingAuditRecord[];
}

export interface InMemoryServingEndpointManagerOptions {
  readonly clock?: () => string;
  readonly healthFailureThreshold?: number;
}

function tenantKey(tenant: TenantRef): string {
  return `${tenant.tenantId}:${tenant.workspaceId}`;
}

function sameTenant(left: TenantRef, right: TenantRef): boolean {
  return left.tenantId === right.tenantId && left.workspaceId === right.workspaceId;
}

function endpointKey(tenant: TenantRef, endpointId: Id): string {
  return `${tenantKey(tenant)}:${endpointId}`;
}

function assertText(value: string, label: string): string {
  if (value.trim().length === 0 || value.length > 160) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} must be 1–160 characters`);
  }
  return value.trim();
}

function assertManifest(value: JsonValue): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Serving manifest must be a JSON object');
  }
}

function assertTrafficApproval(approval: ServingTrafficApproval | undefined): void {
  const expiresAt = approval === undefined ? Number.NaN : Date.parse(approval.expiresAt);
  const now = approval === undefined ? Number.NaN : Date.parse(approval.now);
  if (
    approval === undefined ||
    !approval.approved ||
    approval.actionDigest !== approval.commitDigest ||
    !Number.isFinite(expiresAt) ||
    !Number.isFinite(now) ||
    expiresAt <= now
  ) {
    throw runtimeError('APPROVAL_INVALIDATED', 'Serving traffic change lacks fresh approval');
  }
}

function requiresApproval(action: DeploymentAction): boolean {
  return (
    action === 'startCanary' || action === 'ramp' || action === 'activate' || action === 'rollback'
  );
}

function assertDeploymentState(state: DeploymentState, action: DeploymentAction): void {
  if (transitionDeployment(state, action).state === state) {
    throw runtimeError(
      'VALIDATION_INVALID_INPUT',
      `Invalid deployment transition ${state}:${action}`,
    );
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryServingEndpointManager implements ServingEndpointManager {
  private readonly endpoints = new Map<string, ServingEndpointV1>();
  private readonly revisions = new Map<string, ServingRevisionV1>();
  private readonly audits: ServingAuditRecord[] = [];
  private readonly clock: () => string;
  private readonly healthFailureThreshold: number;

  constructor(options: InMemoryServingEndpointManagerOptions = {}) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.healthFailureThreshold = options.healthFailureThreshold ?? 2;
    if (!Number.isSafeInteger(this.healthFailureThreshold) || this.healthFailureThreshold < 1) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Health failure threshold must be positive');
    }
  }

  createEndpoint(input: {
    readonly tenant: TenantRef;
    readonly name: string;
    readonly modelName: string;
    readonly protocol?: 'http' | 'grpc';
    readonly now?: string;
  }): ServingEndpointV1 {
    const name = assertText(input.name, 'Endpoint name');
    const modelName = assertText(input.modelName, 'Model name');
    const existing = [...this.endpoints.values()].find(
      (endpoint) =>
        sameTenant(endpoint.tenant, input.tenant) &&
        endpoint.name === name &&
        endpoint.state !== 'deleted',
    );
    if (existing !== undefined) {
      throw runtimeError('CONCURRENCY_STALE_VERSION', `Endpoint ${name} already exists`);
    }
    const now = input.now ?? this.clock();
    const endpoint: ServingEndpointV1 = {
      endpointId: newSortableId(),
      tenant: clone(input.tenant),
      name,
      modelName,
      protocol: input.protocol ?? 'http',
      state: 'provisioning',
      createdAt: now,
      updatedAt: now,
    };
    this.endpoints.set(endpointKey(input.tenant, endpoint.endpointId), endpoint);
    this.record(endpoint.tenant, 'endpoint.created', endpoint.endpointId, 'completed', {
      name,
      modelName,
    });
    return clone(endpoint);
  }

  getEndpoint(tenant: TenantRef, endpointId: Id): ServingEndpointV1 | undefined {
    const endpoint = this.endpoints.get(endpointKey(tenant, endpointId));
    return endpoint === undefined ? undefined : clone(endpoint);
  }

  listEndpoints(tenant: TenantRef): readonly ServingEndpointV1[] {
    return clone(
      [...this.endpoints.values()].filter((endpoint) => sameTenant(endpoint.tenant, tenant)),
    );
  }

  requestDeployment(input: {
    readonly tenant: TenantRef;
    readonly endpointId: Id;
    readonly modelVersionId: Id;
    readonly manifest: JsonValue;
    readonly now?: string;
  }): ServingRevisionV1 {
    const endpoint = this.requireEndpoint(input.tenant, input.endpointId);
    assertText(input.modelVersionId, 'Model version ID');
    assertManifest(input.manifest);
    const now = input.now ?? this.clock();
    const revision: ServingRevisionV1 = {
      deploymentId: newSortableId(),
      endpointId: endpoint.endpointId,
      tenant: clone(input.tenant),
      modelVersionId: input.modelVersionId,
      manifest: clone(input.manifest),
      state: 'requested',
      trafficPercent: 0,
      health: 'unknown',
      consecutiveFailures: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.revisions.set(endpointKey(input.tenant, revision.deploymentId), revision);
    this.endpoints.set(endpointKey(input.tenant, endpoint.endpointId), {
      ...endpoint,
      state: 'provisioning',
      updatedAt: now,
    });
    this.record(input.tenant, 'deployment.requested', revision.deploymentId, 'completed', {
      endpointId: endpoint.endpointId,
      modelVersionId: input.modelVersionId,
    });
    return clone(revision);
  }

  advance(
    tenant: TenantRef,
    deploymentId: Id,
    action: DeploymentAction,
    approval?: ServingTrafficApproval,
  ): ServingRevisionV1 {
    const current = this.requireRevision(tenant, deploymentId);
    if (requiresApproval(action)) {
      try {
        assertTrafficApproval(approval);
      } catch (error) {
        this.record(tenant, `deployment.${action}`, deploymentId, 'denied', {
          reason: error instanceof Error ? error.message : 'invalid approval',
        });
        throw error;
      }
    }
    assertDeploymentState(current.state, action);
    const nextState = transitionDeployment(current.state, action).state;
    const trafficPercent =
      nextState === 'canary'
        ? 10
        : nextState === 'ramping'
          ? 50
          : nextState === 'active'
            ? 100
            : nextState === 'rolled_back'
              ? 0
              : current.trafficPercent;
    const now = approval?.now ?? this.clock();
    const next: ServingRevisionV1 = {
      ...current,
      state: nextState,
      trafficPercent,
      updatedAt: now,
      ...(nextState === 'rolled_back' ? { health: 'unhealthy' as const } : {}),
    };
    this.revisions.set(endpointKey(tenant, deploymentId), next);
    this.updateEndpointAfterTransition(tenant, next, now);
    this.record(tenant, `deployment.${action}`, deploymentId, 'completed', {
      from: current.state,
      to: next.state,
      trafficPercent,
    });
    return clone(next);
  }

  observeHealth(
    tenant: TenantRef,
    deploymentId: Id,
    observation: ServingHealthObservation,
  ): ServingRevisionV1 {
    const current = this.requireRevision(tenant, deploymentId);
    const now = observation.observedAt ?? this.clock();
    const failures = observation.healthy ? 0 : current.consecutiveFailures + 1;
    const next: ServingRevisionV1 = {
      ...current,
      health: observation.healthy ? 'healthy' : 'unhealthy',
      consecutiveFailures: failures,
      lastHealthCheckAt: now,
      updatedAt: now,
      ...(observation.error === undefined ? {} : { error: observation.error.slice(0, 4000) }),
    };
    this.revisions.set(endpointKey(tenant, deploymentId), next);
    const endpoint = this.requireEndpoint(tenant, current.endpointId);
    this.endpoints.set(endpointKey(tenant, endpoint.endpointId), {
      ...endpoint,
      state: observation.healthy ? 'ready' : 'degraded',
      updatedAt: now,
    });
    this.record(tenant, 'deployment.health.observed', deploymentId, 'completed', {
      health: next.health,
      consecutiveFailures: failures,
    });
    return clone(next);
  }

  automaticRollbackIfUnhealthy(
    tenant: TenantRef,
    deploymentId: Id,
    approval: ServingTrafficApproval,
  ): ServingRevisionV1 {
    const current = this.requireRevision(tenant, deploymentId);
    if (
      current.health !== 'unhealthy' ||
      current.consecutiveFailures < this.healthFailureThreshold ||
      !['canary', 'ramping', 'active'].includes(current.state)
    ) {
      this.record(tenant, 'deployment.rollback.skipped', deploymentId, 'completed', {
        state: current.state,
        health: current.health,
        consecutiveFailures: current.consecutiveFailures,
      });
      return clone(current);
    }
    return this.advance(tenant, deploymentId, 'rollback', approval);
  }

  getRevision(tenant: TenantRef, deploymentId: Id): ServingRevisionV1 | undefined {
    const revision = this.revisions.get(endpointKey(tenant, deploymentId));
    return revision === undefined ? undefined : clone(revision);
  }

  listRevisions(tenant: TenantRef, endpointId: Id): readonly ServingRevisionV1[] {
    const endpoint = this.requireEndpoint(tenant, endpointId);
    return clone(
      [...this.revisions.values()].filter(
        (revision) =>
          sameTenant(revision.tenant, tenant) && revision.endpointId === endpoint.endpointId,
      ),
    );
  }

  auditRecords(tenant?: TenantRef): readonly ServingAuditRecord[] {
    return clone(
      tenant === undefined
        ? this.audits
        : this.audits.filter((record) => sameTenant(record.tenant, tenant)),
    );
  }

  private updateEndpointAfterTransition(
    tenant: TenantRef,
    revision: ServingRevisionV1,
    now: string,
  ): void {
    const endpoint = this.requireEndpoint(tenant, revision.endpointId);
    if (revision.state === 'active') {
      const next = {
        ...endpoint,
        state: 'ready',
        activeDeploymentId: revision.deploymentId,
        updatedAt: now,
        ...(endpoint.activeDeploymentId === undefined
          ? {}
          : { previousDeploymentId: endpoint.activeDeploymentId }),
      } satisfies ServingEndpointV1;
      if (endpoint.activeDeploymentId === undefined) {
        const withoutPrevious = { ...next };
        delete withoutPrevious.previousDeploymentId;
        this.endpoints.set(endpointKey(tenant, endpoint.endpointId), withoutPrevious);
      } else {
        this.endpoints.set(endpointKey(tenant, endpoint.endpointId), next);
      }
    } else if (revision.state === 'rolled_back') {
      const next = {
        ...endpoint,
        state: endpoint.previousDeploymentId === undefined ? 'failed' : 'ready',
        updatedAt: now,
        ...(endpoint.previousDeploymentId === undefined
          ? {}
          : { activeDeploymentId: endpoint.previousDeploymentId }),
      } satisfies ServingEndpointV1;
      const withoutPrevious = { ...next };
      delete withoutPrevious.previousDeploymentId;
      this.endpoints.set(endpointKey(tenant, endpoint.endpointId), withoutPrevious);
    }
  }

  private requireEndpoint(tenant: TenantRef, endpointId: Id): ServingEndpointV1 {
    const endpoint = this.endpoints.get(endpointKey(tenant, endpointId));
    if (endpoint === undefined || !sameTenant(endpoint.tenant, tenant)) {
      throw runtimeError('ARTIFACT_NOT_FOUND', `Serving endpoint ${endpointId} was not found`);
    }
    if (endpoint.state === 'deleted') {
      throw runtimeError('POLICY_DENIED', 'Deleted serving endpoints cannot be changed');
    }
    return endpoint;
  }

  private requireRevision(tenant: TenantRef, deploymentId: Id): ServingRevisionV1 {
    const revision = this.revisions.get(endpointKey(tenant, deploymentId));
    if (revision === undefined || !sameTenant(revision.tenant, tenant)) {
      throw runtimeError('ARTIFACT_NOT_FOUND', `Serving deployment ${deploymentId} was not found`);
    }
    return revision;
  }

  private record(
    tenant: TenantRef,
    action: string,
    targetId: Id,
    outcome: ServingAuditRecord['outcome'],
    details: JsonValue,
  ): void {
    this.audits.push({
      auditId: newSortableId(),
      tenant: clone(tenant),
      action,
      targetId,
      outcome,
      details: clone(details),
      at: this.clock(),
    });
  }
}
