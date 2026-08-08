import {
  newSortableId,
  runtimeError,
  validateContract,
  type Actor,
  type ApprovalRequest,
  type AuthorityEnvelope,
  type HashSha256,
  type Id,
  type Money,
  type ResourceSelector,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import { sha256Digest } from './canonical.js';
import type { AuthorityService } from './authority.js';

export interface ApprovalAction {
  actionType: string;
  tenant: TenantRef;
  workflowId: Id;
  invocationId: Id;
  actor: Actor;
  artifactVersions: ResourceSelector[];
  resources: ResourceSelector[];
  credentialScopes: string[];
  deploymentTarget?: string;
  trafficPercentage?: number;
  estimatedCost: Money;
  policyVersion: string;
  configurationDigest?: HashSha256;
  revocationEpoch: number;
}

export interface ApprovalRecord {
  request: ApprovalRequest;
  action: ApprovalAction;
}

export interface ApprovalStore {
  create(record: ApprovalRecord): void;
  get(tenant: TenantRef, approvalId: Id): ApprovalRecord | undefined;
  list(tenant: TenantRef): ApprovalRecord[];
  update(record: ApprovalRecord): void;
}

export class InMemoryApprovalStore implements ApprovalStore {
  private readonly records = new Map<string, ApprovalRecord>();

  private key(tenant: TenantRef, approvalId: Id): string {
    return `${tenant.tenantId}:${tenant.workspaceId}:${approvalId}`;
  }

  create(record: ApprovalRecord): void {
    const key = this.key(record.request.tenant, record.request.approvalId);
    if (this.records.has(key))
      throw runtimeError('CONCURRENCY_STALE_VERSION', 'Approval already exists');
    this.records.set(key, structuredClone(record));
  }

  get(tenant: TenantRef, approvalId: Id): ApprovalRecord | undefined {
    const record = this.records.get(this.key(tenant, approvalId));
    return record ? structuredClone(record) : undefined;
  }

  list(tenant: TenantRef): ApprovalRecord[] {
    const prefix = `${tenant.tenantId}:${tenant.workspaceId}:`;
    return structuredClone(
      [...this.records.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, record]) => record),
    );
  }

  update(record: ApprovalRecord): void {
    const key = this.key(record.request.tenant, record.request.approvalId);
    if (!this.records.has(key))
      throw runtimeError('APPROVAL_INVALIDATED', 'Approval no longer exists');
    this.records.set(key, structuredClone(record));
  }
}

export interface ApprovalServiceOptions {
  authority: Pick<AuthorityService, 'assertAuthorized' | 'verify' | 'currentRevocationEpoch'>;
  policyVersion?: string;
  store?: ApprovalStore;
  clock?: () => string;
}

export interface ApprovalRequestInput {
  action: ApprovalAction;
  authority: AuthorityEnvelope;
  expiresAt: string;
  now?: string;
}

function combinedResources(action: ApprovalAction): ResourceSelector[] {
  const seen = new Set<string>();
  return [...action.resources, ...action.artifactVersions].filter((resource) => {
    const key = `${resource.kind}:${resource.id}:${resource.version ?? '*'}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function validateAction(action: ApprovalAction): void {
  if (
    action.artifactVersions.some(
      (resource) => resource.kind !== 'artifact' || resource.version === undefined,
    )
  ) {
    throw runtimeError(
      'VALIDATION_INVALID_INPUT',
      'Approval artifact references require exact versions',
    );
  }
  if (
    action.trafficPercentage !== undefined &&
    (!Number.isFinite(action.trafficPercentage) ||
      action.trafficPercentage < 0 ||
      action.trafficPercentage > 100)
  ) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Traffic percentage must be between 0 and 100');
  }
  if (
    !Number.isSafeInteger(action.estimatedCost.amountMinor) ||
    action.estimatedCost.amountMinor < 0
  ) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Approval cost must be a non-negative integer');
  }
  if (action.policyVersion.length === 0 || action.actionType.length === 0) {
    throw runtimeError(
      'VALIDATION_INVALID_INPUT',
      'Approval action type and policy version are required',
    );
  }
}

function assertSameTenant(left: TenantRef, right: TenantRef): void {
  if (left.tenantId !== right.tenantId || left.workspaceId !== right.workspaceId) {
    throw runtimeError('POLICY_DENIED', 'Approval tenant/workspace does not match request');
  }
}

export class ApprovalService {
  private readonly authority: ApprovalServiceOptions['authority'];
  private readonly policyVersion: string;
  private readonly store: ApprovalStore;
  private readonly clock: () => string;

  constructor(options: ApprovalServiceOptions) {
    this.authority = options.authority;
    this.policyVersion = options.policyVersion ?? 'policy.v1';
    this.store = options.store ?? new InMemoryApprovalStore();
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  request(input: ApprovalRequestInput): ApprovalRecord {
    const now = input.now ?? this.clock();
    validateAction(input.action);
    assertSameTenant(input.action.tenant, input.authority.tenant);
    if (
      input.action.policyVersion !== this.policyVersion ||
      input.authority.policyVersion !== this.policyVersion
    ) {
      throw runtimeError('POLICY_DENIED', 'Approval action uses an unsupported policy version');
    }
    if (input.action.revocationEpoch !== input.authority.revocationEpoch) {
      throw runtimeError('APPROVAL_INVALIDATED', 'Approval action uses a stale revocation epoch');
    }
    if (Date.parse(input.expiresAt) <= Date.parse(now)) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Approval expiration must be in the future');
    }
    this.authority.assertAuthorized(input.authority, {
      tenant: input.action.tenant,
      workflowId: input.action.workflowId,
      invocationId: input.action.invocationId,
      actorId: input.action.actor.actorId,
      action: 'approval.request',
      resources: combinedResources(input.action),
      now,
    });
    const request: ApprovalRequest = {
      schemaVersion: 1,
      approvalId: newSortableId(),
      tenant: input.action.tenant,
      workflowId: input.action.workflowId,
      invocationId: input.action.invocationId,
      actionDigest: sha256Digest(input.action),
      actionType: input.action.actionType,
      requestedBy: input.action.actor,
      resources: combinedResources(input.action),
      estimatedCost: input.action.estimatedCost,
      policyVersion: input.action.policyVersion,
      revocationEpoch: input.action.revocationEpoch,
      state: 'pending',
      requestedAt: now,
      expiresAt: input.expiresAt,
    };
    const validation = validateContract('ApprovalRequest', request);
    if (!validation.valid) {
      throw runtimeError(
        'VALIDATION_SCHEMA_MISMATCH',
        'Approval request failed contract validation',
      );
    }
    const record = { request, action: structuredClone(input.action) } satisfies ApprovalRecord;
    this.store.create(record);
    return structuredClone(record);
  }

  decide(
    tenant: TenantRef,
    approvalId: Id,
    state: 'approved' | 'rejected',
    approver: Actor,
    authority: AuthorityEnvelope,
    now = this.clock(),
    decisionReason?: string,
  ): ApprovalRecord {
    const existing = this.require(tenant, approvalId);
    if (existing.request.state !== 'pending') {
      throw runtimeError('APPROVAL_INVALIDATED', 'Only pending approvals can be decided');
    }
    if (approver.type !== 'human') {
      throw runtimeError('POLICY_DENIED', 'Only a human actor can decide an approval');
    }
    if (approver.actorId === existing.request.requestedBy.actorId) {
      throw runtimeError('POLICY_DENIED', 'The requesting actor cannot approve its own action');
    }
    this.authority.assertAuthorized(authority, {
      tenant,
      workflowId: existing.action.workflowId,
      invocationId: existing.action.invocationId,
      actorId: approver.actorId,
      action: 'approval.decide',
      resources: existing.request.resources,
      now,
    });
    const request: ApprovalRequest = {
      ...existing.request,
      state,
      decidedBy: approver,
      decidedAt: now,
      ...(decisionReason !== undefined ? { decisionReason } : {}),
    };
    const updated = { request, action: existing.action } satisfies ApprovalRecord;
    this.store.update(updated);
    return structuredClone(updated);
  }

  revoke(
    tenant: TenantRef,
    approvalId: Id,
    authority: AuthorityEnvelope,
    now = this.clock(),
    reason = 'Approval revoked by policy',
  ): ApprovalRecord {
    const existing = this.require(tenant, approvalId);
    this.authority.assertAuthorized(authority, {
      tenant,
      workflowId: existing.action.workflowId,
      invocationId: existing.action.invocationId,
      actorId: authority.subjectAgentId,
      action: 'approval.revoke',
      resources: existing.request.resources,
      now,
    });
    const updated = {
      request: {
        ...existing.request,
        state: 'revoked' as const,
        decidedBy: authority.issuer,
        decidedAt: now,
        decisionReason: reason,
      },
      action: existing.action,
    } satisfies ApprovalRecord;
    this.store.update(updated);
    return structuredClone(updated);
  }

  assertValid(
    tenant: TenantRef,
    approvalId: Id,
    action: ApprovalAction,
    authority: AuthorityEnvelope,
    now = this.clock(),
  ): ApprovalRecord {
    const record = this.require(tenant, approvalId);
    if (record.request.state !== 'approved') {
      throw runtimeError('APPROVAL_INVALIDATED', `Approval is ${record.request.state}`);
    }
    if (Date.parse(now) >= Date.parse(record.request.expiresAt)) {
      throw runtimeError('APPROVAL_INVALIDATED', 'Approval has expired');
    }
    validateAction(action);
    if (sha256Digest(action) !== record.request.actionDigest) {
      throw runtimeError('APPROVAL_INVALIDATED', 'Approval action digest no longer matches');
    }
    if (
      record.request.policyVersion !== this.policyVersion ||
      action.policyVersion !== this.policyVersion
    ) {
      throw runtimeError('APPROVAL_INVALIDATED', 'Approval policy version no longer matches');
    }
    if (record.request.revocationEpoch !== action.revocationEpoch) {
      throw runtimeError('APPROVAL_INVALIDATED', 'Approval revocation epoch no longer matches');
    }
    this.authority.verify(authority, now);
    if (
      authority.revocationEpoch !== record.request.revocationEpoch ||
      this.authority.currentRevocationEpoch(authority.tenant, authority.subjectAgentId) !==
        record.request.revocationEpoch
    ) {
      throw runtimeError('APPROVAL_INVALIDATED', 'Approval was revoked before commit');
    }
    assertSameTenant(authority.tenant, tenant);
    return structuredClone(record);
  }

  get(tenant: TenantRef, approvalId: Id): ApprovalRecord | undefined {
    return this.store.get(tenant, approvalId);
  }

  list(tenant: TenantRef): ApprovalRecord[] {
    return this.store.list(tenant);
  }

  private require(tenant: TenantRef, approvalId: Id): ApprovalRecord {
    const record = this.store.get(tenant, approvalId);
    if (!record) throw runtimeError('APPROVAL_INVALIDATED', `Approval ${approvalId} was not found`);
    return record;
  }
}
