import { randomBytes } from 'node:crypto';
import {
  isUtcInstant,
  newSortableId,
  runtimeError,
  validateContract,
  type Actor,
  type AgentTier,
  type AuthorityEnvelope,
  type Id,
  type ResourceSelector,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import { sha256Digest } from './canonical.js';

export interface AuthorityIssueRequest {
  tenant: TenantRef;
  workflowId: Id;
  invocationId: Id;
  issuer: Actor;
  subjectAgentId: Id;
  tier: AgentTier;
  harnessVersion: string;
  permittedActions: string[];
  capabilities: string[];
  resourceScopes: ResourceSelector[];
  allowedArtifactReads: ResourceSelector[];
  allowedArtifactWrites: ResourceSelector[];
  allowedChildAgentTypes: string[];
  maxChildCount: number;
  toolOperations: string[];
  issuedAt?: string;
  expiresAt?: string;
  policyVersion?: string;
}

export interface AuthorityCheck {
  tenant: TenantRef;
  workflowId?: Id;
  invocationId?: Id;
  actorId?: Id;
  action?: string;
  toolOperation?: string;
  resources?: ResourceSelector[];
  artifactAccess?: 'read' | 'write';
  childAgentType?: string;
  childCount?: number;
  now?: string;
}

export interface AuthorityServiceOptions {
  policyVersion?: string;
  defaultTtlMs?: number;
  clock?: () => string;
}

function tenantKey(tenant: TenantRef, subjectAgentId: Id): string {
  return `${tenant.tenantId}:${tenant.workspaceId}:${subjectAgentId}`;
}

function actionMatches(granted: string, requested: string): boolean {
  if (granted === requested) return true;
  if (granted.endsWith('*')) return requested.startsWith(granted.slice(0, -1));
  return false;
}

export function selectorAllows(scope: ResourceSelector, requested: ResourceSelector): boolean {
  return (
    scope.kind === requested.kind &&
    scope.id === requested.id &&
    (scope.version === undefined || scope.version === requested.version)
  );
}

function resourcesAllowed(
  scopes: readonly ResourceSelector[],
  resources: readonly ResourceSelector[],
) {
  return resources.every((resource) => scopes.some((scope) => selectorAllows(scope, resource)));
}

function unsignedEnvelope(
  envelope: AuthorityEnvelope,
): Omit<AuthorityEnvelope, 'integrityProof' | 'signature'> {
  const unsigned = { ...envelope } as Record<string, unknown>;
  delete unsigned['integrityProof'];
  delete unsigned['signature'];
  return unsigned as Omit<AuthorityEnvelope, 'integrityProof' | 'signature'>;
}

function assertTimeRange(issuedAt: string, expiresAt: string): void {
  if (
    !isUtcInstant(issuedAt) ||
    !isUtcInstant(expiresAt) ||
    Date.parse(expiresAt) <= Date.parse(issuedAt)
  ) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Authority envelope has an invalid time range');
  }
}

export class AuthorityService {
  private readonly policyVersion: string;
  private readonly defaultTtlMs: number;
  private readonly clock: () => string;
  private readonly revocationEpochs = new Map<string, number>();

  constructor(options: AuthorityServiceOptions = {}) {
    this.policyVersion = options.policyVersion ?? 'policy.v1';
    this.defaultTtlMs = options.defaultTtlMs ?? 15 * 60 * 1000;
    this.clock = options.clock ?? (() => new Date().toISOString());
    if (!Number.isSafeInteger(this.defaultTtlMs) || this.defaultTtlMs <= 0) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'Authority TTL must be a positive safe integer',
      );
    }
  }

  issue(request: AuthorityIssueRequest): AuthorityEnvelope {
    const issuedAt = request.issuedAt ?? this.clock();
    const expiresAt =
      request.expiresAt ?? new Date(Date.parse(issuedAt) + this.defaultTtlMs).toISOString();
    assertTimeRange(issuedAt, expiresAt);
    if (request.maxChildCount < 0 || !Number.isSafeInteger(request.maxChildCount)) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'maxChildCount must be a non-negative safe integer',
      );
    }
    const key = tenantKey(request.tenant, request.subjectAgentId);
    const revocationEpoch = this.revocationEpochs.get(key) ?? 0;
    const unsigned = {
      schemaVersion: 1,
      envelopeId: newSortableId(),
      tenant: request.tenant,
      issuer: request.issuer,
      subjectAgentId: request.subjectAgentId,
      workflowId: request.workflowId,
      invocationId: request.invocationId,
      tier: request.tier,
      harnessVersion: request.harnessVersion,
      permittedActions: [...new Set(request.permittedActions)].sort(),
      capabilities: [...new Set(request.capabilities)].sort(),
      resourceScopes: request.resourceScopes,
      allowedArtifactReads: request.allowedArtifactReads,
      allowedArtifactWrites: request.allowedArtifactWrites,
      allowedChildAgentTypes: [...new Set(request.allowedChildAgentTypes)].sort(),
      maxChildCount: request.maxChildCount,
      toolOperations: [...new Set(request.toolOperations)].sort(),
      issuedAt,
      expiresAt,
      nonce: randomBytes(18).toString('hex'),
      policyVersion: request.policyVersion ?? this.policyVersion,
      revocationEpoch,
    } satisfies Omit<AuthorityEnvelope, 'integrityProof' | 'signature'>;
    const envelope: AuthorityEnvelope = {
      ...unsigned,
      integrityProof: sha256Digest(unsigned),
    };
    const validation = validateContract('AuthorityEnvelope', envelope);
    if (!validation.valid) {
      throw runtimeError(
        'VALIDATION_SCHEMA_MISMATCH',
        'Issued authority envelope failed validation',
      );
    }
    return envelope;
  }

  verify(envelope: AuthorityEnvelope, now = this.clock()): AuthorityEnvelope {
    const validation = validateContract('AuthorityEnvelope', envelope);
    if (!validation.valid) {
      throw runtimeError('AUTHORITY_MISSING', 'Authority envelope failed contract validation');
    }
    assertTimeRange(envelope.issuedAt, envelope.expiresAt);
    if (!isUtcInstant(now)) {
      throw runtimeError('VALIDATION_INVALID_INPUT', `Invalid authorization time: ${now}`);
    }
    if (Date.parse(now) < Date.parse(envelope.issuedAt)) {
      throw runtimeError('AUTHORITY_MISSING', 'Authority envelope is not active yet');
    }
    if (Date.parse(now) >= Date.parse(envelope.expiresAt)) {
      throw runtimeError('AUTHORITY_EXPIRED', 'Authority envelope has expired');
    }
    if (sha256Digest(unsignedEnvelope(envelope)) !== envelope.integrityProof) {
      throw runtimeError('AUTHORITY_MISSING', 'Authority envelope integrity proof does not match');
    }
    const currentEpoch =
      this.revocationEpochs.get(tenantKey(envelope.tenant, envelope.subjectAgentId)) ?? 0;
    if (envelope.revocationEpoch !== currentEpoch) {
      throw runtimeError('AUTHORITY_MISSING', 'Authority envelope was revoked');
    }
    return envelope;
  }

  revoke(tenant: TenantRef, subjectAgentId: Id): number {
    const key = tenantKey(tenant, subjectAgentId);
    const next = (this.revocationEpochs.get(key) ?? 0) + 1;
    this.revocationEpochs.set(key, next);
    return next;
  }

  currentRevocationEpoch(tenant: TenantRef, subjectAgentId: Id): number {
    return this.revocationEpochs.get(tenantKey(tenant, subjectAgentId)) ?? 0;
  }

  assertAuthorized(envelope: AuthorityEnvelope, check: AuthorityCheck): void {
    this.verify(envelope, check.now);
    if (
      envelope.tenant.tenantId !== check.tenant.tenantId ||
      envelope.tenant.workspaceId !== check.tenant.workspaceId
    ) {
      throw runtimeError(
        'POLICY_DENIED',
        'Authority envelope tenant/workspace does not match request',
      );
    }
    if (check.workflowId !== undefined && envelope.workflowId !== check.workflowId) {
      throw runtimeError('POLICY_DENIED', 'Authority envelope is bound to a different workflow');
    }
    if (check.invocationId !== undefined && envelope.invocationId !== check.invocationId) {
      throw runtimeError('POLICY_DENIED', 'Authority envelope is bound to a different invocation');
    }
    if (check.actorId !== undefined && envelope.subjectAgentId !== check.actorId) {
      throw runtimeError('POLICY_DENIED', 'Authority envelope is bound to a different actor');
    }
    const action = check.action;
    if (
      action !== undefined &&
      !envelope.permittedActions.some((granted) => actionMatches(granted, action))
    ) {
      throw runtimeError('POLICY_DENIED', `Action is not permitted: ${action}`);
    }
    const toolOperation = check.toolOperation;
    if (
      toolOperation !== undefined &&
      !envelope.toolOperations.some((granted) => actionMatches(granted, toolOperation))
    ) {
      throw runtimeError('POLICY_DENIED', `Tool operation is not permitted: ${toolOperation}`);
    }
    if (
      check.resources !== undefined &&
      !resourcesAllowed(envelope.resourceScopes, check.resources)
    ) {
      throw runtimeError('POLICY_DENIED', 'Requested resource is outside the authority scope');
    }
    if (check.artifactAccess !== undefined && check.resources !== undefined) {
      const artifactScopes =
        check.artifactAccess === 'read'
          ? envelope.allowedArtifactReads
          : envelope.allowedArtifactWrites;
      if (!resourcesAllowed(artifactScopes, check.resources)) {
        throw runtimeError(
          'POLICY_DENIED',
          `Artifact ${check.artifactAccess} is outside the authority scope`,
        );
      }
    }
    const childAgentType = check.childAgentType;
    if (
      childAgentType !== undefined &&
      !envelope.allowedChildAgentTypes.some((granted) => actionMatches(granted, childAgentType))
    ) {
      throw runtimeError('POLICY_DENIED', `Child agent type is not permitted: ${childAgentType}`);
    }
    if (check.childCount !== undefined && check.childCount > envelope.maxChildCount) {
      throw runtimeError('POLICY_DENIED', 'Child agent count exceeds the authority envelope');
    }
  }

  assertResourceScopes(
    envelope: AuthorityEnvelope,
    requested: readonly ResourceSelector[],
    now?: string,
  ): void {
    this.verify(envelope, now);
    if (!resourcesAllowed(envelope.resourceScopes, requested)) {
      throw runtimeError('POLICY_DENIED', 'Requested resource is outside the authority scope');
    }
  }
}

export type AuthorityVerifier = Pick<AuthorityService, 'assertAuthorized' | 'verify'>;
