import {
  newSortableId,
  runtimeError,
  validateContract,
  type Actor,
  type Id,
  type ResourceSelector,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import type { AuditSink } from './audit.js';

export type BreakGlassState = 'pending' | 'active' | 'revoked' | 'expired' | 'consumed';

export interface BreakGlassGrant {
  readonly grantId: Id;
  readonly tenant: TenantRef;
  readonly requestedBy: Actor;
  readonly reason: string;
  readonly actions: readonly string[];
  readonly resources: readonly ResourceSelector[];
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly maxUses: number;
  readonly useCount: number;
  readonly state: BreakGlassState;
  readonly approvedBy?: Actor;
  readonly approvedAt?: string;
  readonly revokedBy?: Actor;
  readonly revokedAt?: string;
  readonly revocationReason?: string;
}

export interface BreakGlassStore {
  create(grant: BreakGlassGrant): void;
  get(tenant: TenantRef, grantId: Id): BreakGlassGrant | undefined;
  list(tenant: TenantRef): BreakGlassGrant[];
  update(grant: BreakGlassGrant): void;
}

export class InMemoryBreakGlassStore implements BreakGlassStore {
  private readonly grants = new Map<string, BreakGlassGrant>();

  private key(tenant: TenantRef, grantId: Id): string {
    return `${tenant.tenantId}:${tenant.workspaceId}:${grantId}`;
  }

  create(grant: BreakGlassGrant): void {
    const key = this.key(grant.tenant, grant.grantId);
    if (this.grants.has(key))
      throw runtimeError('CONCURRENCY_STALE_VERSION', 'Grant already exists');
    this.grants.set(key, structuredClone(grant));
  }

  get(tenant: TenantRef, grantId: Id): BreakGlassGrant | undefined {
    const grant = this.grants.get(this.key(tenant, grantId));
    return grant === undefined ? undefined : structuredClone(grant);
  }

  list(tenant: TenantRef): BreakGlassGrant[] {
    const prefix = `${tenant.tenantId}:${tenant.workspaceId}:`;
    return structuredClone(
      [...this.grants.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, grant]) => grant),
    );
  }

  update(grant: BreakGlassGrant): void {
    const key = this.key(grant.tenant, grant.grantId);
    if (!this.grants.has(key)) throw runtimeError('POLICY_DENIED', 'Break-glass grant not found');
    this.grants.set(key, structuredClone(grant));
  }
}

export interface BreakGlassRequestInput {
  readonly tenant: TenantRef;
  readonly requester: Actor;
  readonly reason: string;
  readonly actions: readonly string[];
  readonly resources: readonly ResourceSelector[];
  readonly expiresAt: string;
  readonly maxUses: number;
  readonly now?: string;
}

export interface BreakGlassServiceOptions {
  readonly store?: BreakGlassStore;
  readonly audit?: AuditSink;
  readonly clock?: () => string;
}

function sameTenant(left: TenantRef, right: TenantRef): boolean {
  return left.tenantId === right.tenantId && left.workspaceId === right.workspaceId;
}

function validateRequest(input: BreakGlassRequestInput, now: string): void {
  if (!validateContract('TenantRef', input.tenant).valid) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Break-glass tenant is invalid');
  }
  if (!validateContract('Actor', input.requester).valid || input.requester.type !== 'human') {
    throw runtimeError('POLICY_DENIED', 'Break-glass access may only be requested by a human');
  }
  if (input.reason.trim().length === 0) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Break-glass reason is required');
  }
  const actions = [...new Set(input.actions)].sort();
  if (
    actions.length === 0 ||
    actions.some((action) => action.trim().length === 0 || action === '*' || action.endsWith('*'))
  ) {
    throw runtimeError(
      'VALIDATION_INVALID_INPUT',
      'Break-glass actions must be non-empty explicit operations',
    );
  }
  if (
    input.resources.length === 0 ||
    input.resources.some((resource) => !validateContract('ResourceSelector', resource).valid)
  ) {
    throw runtimeError(
      'VALIDATION_SCHEMA_MISMATCH',
      'Break-glass resources must contain valid non-empty selectors',
    );
  }
  if (!Number.isSafeInteger(input.maxUses) || input.maxUses < 1) {
    throw runtimeError(
      'VALIDATION_INVALID_INPUT',
      'Break-glass maxUses must be a positive integer',
    );
  }
  if (
    !validateContract('UtcInstant', input.expiresAt).valid ||
    Date.parse(input.expiresAt) <= Date.parse(now)
  ) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Break-glass expiration must be in the future');
  }
}

function assertHuman(actor: Actor, label: string): void {
  if (!validateContract('Actor', actor).valid || actor.type !== 'human') {
    throw runtimeError('POLICY_DENIED', `${label} must be a human actor`);
  }
}

function assertTenant(grant: BreakGlassGrant, tenant: TenantRef): void {
  if (!sameTenant(grant.tenant, tenant)) {
    throw runtimeError('POLICY_DENIED', 'Break-glass grant tenant does not match the request');
  }
}

function actionAllowed(grant: BreakGlassGrant, action: string): boolean {
  return grant.actions.includes(action);
}

function resourceAllowed(grant: BreakGlassGrant, resource: ResourceSelector): boolean {
  return grant.resources.some(
    (scope) =>
      scope.kind === resource.kind &&
      scope.id === resource.id &&
      (scope.version === undefined || scope.version === resource.version),
  );
}

export class BreakGlassService {
  private readonly store: BreakGlassStore;
  private readonly audit: AuditSink | undefined;
  private readonly clock: () => string;

  constructor(options: BreakGlassServiceOptions = {}) {
    this.store = options.store ?? new InMemoryBreakGlassStore();
    this.audit = options.audit;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  request(input: BreakGlassRequestInput): BreakGlassGrant {
    const now = input.now ?? this.clock();
    validateRequest(input, now);
    const grant: BreakGlassGrant = {
      grantId: newSortableId(),
      tenant: input.tenant,
      requestedBy: input.requester,
      reason: input.reason.trim(),
      actions: [...new Set(input.actions)].sort(),
      resources: structuredClone(input.resources),
      requestedAt: now,
      expiresAt: input.expiresAt,
      maxUses: input.maxUses,
      useCount: 0,
      state: 'pending',
    };
    this.store.create(grant);
    this.record(
      input.tenant,
      input.requester,
      'break_glass.request',
      'approval_required',
      grant,
      now,
    );
    return structuredClone(grant);
  }

  approve(tenant: TenantRef, grantId: Id, approver: Actor, now = this.clock()): BreakGlassGrant {
    const existing = this.require(tenant, grantId);
    assertHuman(approver, 'Break-glass approver');
    if (existing.state !== 'pending') {
      throw runtimeError('APPROVAL_INVALIDATED', `Break-glass grant is ${existing.state}`);
    }
    if (existing.requestedBy.actorId === approver.actorId) {
      throw runtimeError('POLICY_DENIED', 'The requesting actor cannot approve break-glass access');
    }
    if (Date.parse(now) >= Date.parse(existing.expiresAt)) {
      const expired = { ...existing, state: 'expired' as const };
      this.store.update(expired);
      throw runtimeError('APPROVAL_INVALIDATED', 'Break-glass grant has expired');
    }
    const updated: BreakGlassGrant = {
      ...existing,
      state: 'active',
      approvedBy: approver,
      approvedAt: now,
    };
    this.store.update(updated);
    this.record(tenant, approver, 'break_glass.approve', 'allowed', updated, now);
    return structuredClone(updated);
  }

  assertValid(
    tenant: TenantRef,
    grantId: Id,
    actor: Actor,
    action: string,
    resources: readonly ResourceSelector[],
    now = this.clock(),
  ): BreakGlassGrant {
    const grant = this.require(tenant, grantId);
    assertHuman(actor, 'Break-glass subject');
    if (grant.requestedBy.actorId !== actor.actorId) {
      throw runtimeError('POLICY_DENIED', 'Break-glass grant is bound to a different human');
    }
    if (Date.parse(now) >= Date.parse(grant.expiresAt)) {
      const expired = { ...grant, state: 'expired' as const };
      this.store.update(expired);
      throw runtimeError('APPROVAL_INVALIDATED', 'Break-glass grant has expired');
    }
    if (grant.state === 'consumed' || grant.useCount >= grant.maxUses) {
      const consumed = { ...grant, state: 'consumed' as const };
      this.store.update(consumed);
      throw runtimeError('APPROVAL_INVALIDATED', 'Break-glass grant has no remaining uses');
    }
    if (grant.state !== 'active') {
      throw runtimeError('APPROVAL_INVALIDATED', `Break-glass grant is ${grant.state}`);
    }
    if (
      !actionAllowed(grant, action) ||
      resources.some((resource) => !resourceAllowed(grant, resource))
    ) {
      throw runtimeError('POLICY_DENIED', 'Break-glass action or resource is outside the grant');
    }
    return structuredClone(grant);
  }

  consume(
    tenant: TenantRef,
    grantId: Id,
    actor: Actor,
    action: string,
    resources: readonly ResourceSelector[],
    now = this.clock(),
  ): BreakGlassGrant {
    const grant = this.assertValid(tenant, grantId, actor, action, resources, now);
    const useCount = grant.useCount + 1;
    const updated: BreakGlassGrant = {
      ...grant,
      useCount,
      state: useCount >= grant.maxUses ? 'consumed' : 'active',
    };
    this.store.update(updated);
    this.record(tenant, actor, 'break_glass.consume', 'executed', updated, now);
    return structuredClone(updated);
  }

  revoke(
    tenant: TenantRef,
    grantId: Id,
    revoker: Actor,
    reason: string,
    now = this.clock(),
  ): BreakGlassGrant {
    const existing = this.require(tenant, grantId);
    assertHuman(revoker, 'Break-glass revoker');
    if (reason.trim().length === 0) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Break-glass revocation reason is required');
    }
    if (existing.state !== 'active' && existing.state !== 'pending') {
      throw runtimeError('APPROVAL_INVALIDATED', `Break-glass grant is ${existing.state}`);
    }
    const updated: BreakGlassGrant = {
      ...existing,
      state: 'revoked',
      revokedBy: revoker,
      revokedAt: now,
      revocationReason: reason.trim(),
    };
    this.store.update(updated);
    this.record(tenant, revoker, 'break_glass.revoke', 'denied', updated, now);
    return structuredClone(updated);
  }

  get(tenant: TenantRef, grantId: Id): BreakGlassGrant | undefined {
    return this.store.get(tenant, grantId);
  }

  list(tenant: TenantRef): BreakGlassGrant[] {
    return this.store.list(tenant);
  }

  private require(tenant: TenantRef, grantId: Id): BreakGlassGrant {
    const grant = this.store.get(tenant, grantId);
    if (grant === undefined) throw runtimeError('POLICY_DENIED', 'Break-glass grant was not found');
    assertTenant(grant, tenant);
    return grant;
  }

  private record(
    tenant: TenantRef,
    actor: Actor,
    action: string,
    result: 'allowed' | 'denied' | 'approval_required' | 'executed',
    grant: BreakGlassGrant,
    occurredAt: string,
  ): void {
    this.audit?.record({
      auditId: newSortableId(),
      tenant,
      actor,
      action,
      target: [{ kind: 'workspace', id: tenant.workspaceId }],
      result,
      evidence: {
        grantId: grant.grantId,
        actions: [...grant.actions],
        resources: grant.resources.map((resource) =>
          resource.version === undefined
            ? { kind: resource.kind, id: resource.id }
            : { kind: resource.kind, id: resource.id, version: resource.version },
        ),
        state: grant.state,
        expiresAt: grant.expiresAt,
        useCount: grant.useCount,
        maxUses: grant.maxUses,
      },
      occurredAt,
    });
  }
}
