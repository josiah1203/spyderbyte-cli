import { createHash, randomBytes } from 'node:crypto';
import {
  makeCurrency,
  isId,
  newSortableId,
  runtimeError,
  type Actor,
  type CloudAccountV1,
  type CloudLoginResultV1,
  type CloudResourceLimitsV1,
  type CloudSessionV1,
  type Id,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';

export interface CloudAccountOptions {
  readonly sessionTtlMs?: number;
  readonly clock?: () => string;
  readonly defaultResourceLimits?: CloudResourceLimitsV1;
}

export type CloudAccountLookup<T> = T | Promise<T>;

/** Account/session lookups consumed by managed execution. */
export interface CloudAccountService {
  authenticate(accessToken: string, now?: string): CloudAccountLookup<CloudSessionV1>;
  requireSession(
    accessToken: string,
    tenant: TenantRef,
    now?: string,
  ): CloudAccountLookup<CloudSessionV1>;
  requireAccount(tenant: TenantRef): CloudAccountLookup<CloudAccountV1>;
}

/** Provider-neutral identity port for a hosted account/session implementation. */
export interface HostedCloudAccountClient {
  authenticate(accessToken: string): Promise<CloudSessionV1>;
  requireSession(accessToken: string, tenant: TenantRef): Promise<CloudSessionV1>;
  requireAccount(tenant: TenantRef): Promise<CloudAccountV1>;
}

export class HostedCloudAccountService implements CloudAccountService {
  constructor(private readonly client: HostedCloudAccountClient) {}

  authenticate(accessToken: string): Promise<CloudSessionV1> {
    return this.client.authenticate(accessToken);
  }

  requireSession(accessToken: string, tenant: TenantRef): Promise<CloudSessionV1> {
    return this.client.requireSession(accessToken, tenant);
  }

  requireAccount(tenant: TenantRef): Promise<CloudAccountV1> {
    return this.client.requireAccount(tenant);
  }
}

export interface CreateIndividualAccountInput {
  readonly tenant: TenantRef;
  readonly owner: Actor;
  readonly currency?: string;
  readonly billingMode?: CloudAccountV1['billingMode'];
  readonly stripeCustomerId?: string;
  readonly resourceLimits?: CloudResourceLimitsV1;
  readonly now?: string;
}

interface StoredSession {
  readonly session: CloudSessionV1;
  readonly tokenDigest: string;
}

function tenantKey(tenant: TenantRef): string {
  return `${tenant.tenantId}:${tenant.workspaceId}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertTenant(tenant: TenantRef): void {
  if (!isId(tenant.tenantId) || !isId(tenant.workspaceId)) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Cloud account tenant is required');
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} must be a positive integer`);
  }
}

function digestToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const defaultLimits: CloudResourceLimitsV1 = {
  maxCpuMillicores: 2_000,
  maxMemoryBytes: 4 * 1024 ** 3,
  maxGpuCount: 0,
  maxWallTimeMs: 15 * 60 * 1_000,
  maxOutputBytes: 10 * 1024 * 1024,
  maxProcessCount: 16,
};

/**
 * Personal cloud auth fixture and account boundary.
 *
 * The durable representation retains only a digest of the bearer token. A
 * production composition can replace the identity exchange while preserving
 * this tenant/session contract.
 */
export class InMemoryCloudAccountService implements CloudAccountService {
  private readonly accounts = new Map<string, CloudAccountV1>();
  private readonly sessions = new Map<string, StoredSession>();
  private readonly sessionTtlMs: number;
  private readonly clock: () => string;
  private readonly defaultLimits: CloudResourceLimitsV1;

  constructor(options: CloudAccountOptions = {}) {
    this.sessionTtlMs = options.sessionTtlMs ?? 60 * 60 * 1_000;
    assertPositiveInteger(this.sessionTtlMs, 'Cloud session TTL');
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.defaultLimits = clone(options.defaultResourceLimits ?? defaultLimits);
    this.assertLimits(this.defaultLimits);
  }

  createIndividual(input: CreateIndividualAccountInput): CloudAccountV1 {
    assertTenant(input.tenant);
    const key = tenantKey(input.tenant);
    if (this.accounts.has(key)) {
      throw runtimeError('CONCURRENCY_STALE_VERSION', 'Cloud account already exists for tenant');
    }
    const now = input.now ?? this.clock();
    const limits = clone(input.resourceLimits ?? this.defaultLimits);
    this.assertLimits(limits);
    const account: CloudAccountV1 = {
      schemaVersion: 1,
      accountId: newSortableId(),
      tenant: clone(input.tenant),
      owner: clone(input.owner),
      plan: 'individual_free',
      billingMode: input.billingMode ?? 'stripe',
      currency: makeCurrency(input.currency ?? 'USD'),
      resourceLimits: limits,
      ...(input.stripeCustomerId === undefined ? {} : { stripeCustomerId: input.stripeCustomerId }),
      createdAt: now,
      updatedAt: now,
    };
    this.accounts.set(key, clone(account));
    return clone(account);
  }

  issueSession(accountId: Id, actor: Actor, now = this.clock()): CloudLoginResultV1 {
    const account = [...this.accounts.values()].find(
      (candidate) => candidate.accountId === accountId,
    );
    if (account === undefined)
      throw runtimeError('AUTHORITY_MISSING', 'Cloud account was not found');
    if (actor.actorId !== account.owner.actorId || actor.type !== account.owner.type) {
      throw runtimeError('POLICY_DENIED', 'Actor is not the cloud account owner');
    }
    const issuedAtMs = Date.parse(now);
    if (!Number.isFinite(issuedAtMs)) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Cloud session issue time is invalid');
    }
    const accessToken = randomBytes(32).toString('base64url');
    const session: CloudSessionV1 = {
      schemaVersion: 1,
      sessionId: newSortableId(),
      accountId: account.accountId,
      tenant: clone(account.tenant),
      actor: clone(actor),
      issuedAt: now,
      expiresAt: new Date(issuedAtMs + this.sessionTtlMs).toISOString(),
    };
    this.sessions.set(digestToken(accessToken), {
      session: clone(session),
      tokenDigest: digestToken(accessToken),
    });
    return { session: clone(session), accessToken };
  }

  authenticate(accessToken: string, now = this.clock()): CloudSessionV1 {
    if (accessToken.trim().length === 0) {
      throw runtimeError('AUTHORITY_MISSING', 'Cloud access token is required');
    }
    const stored = this.sessions.get(digestToken(accessToken));
    if (stored === undefined) throw runtimeError('AUTHORITY_MISSING', 'Cloud session is invalid');
    if (Date.parse(stored.session.expiresAt) <= Date.parse(now)) {
      this.sessions.delete(stored.tokenDigest);
      throw runtimeError('AUTHORITY_EXPIRED', 'Cloud session has expired');
    }
    return clone(stored.session);
  }

  requireSession(accessToken: string, tenant: TenantRef, now = this.clock()): CloudSessionV1 {
    const session = this.authenticate(accessToken, now);
    if (tenantKey(session.tenant) !== tenantKey(tenant)) {
      throw runtimeError('AUTHORITY_SCOPE_VIOLATION', 'Cloud session is outside the tenant scope');
    }
    return session;
  }

  requireAccount(tenant: TenantRef): CloudAccountV1 {
    assertTenant(tenant);
    const account = this.accounts.get(tenantKey(tenant));
    if (account === undefined)
      throw runtimeError('AUTHORITY_MISSING', 'Cloud account was not found');
    return clone(account);
  }

  revoke(accessToken: string): void {
    this.sessions.delete(digestToken(accessToken));
  }

  private assertLimits(limits: CloudResourceLimitsV1): void {
    assertPositiveInteger(limits.maxCpuMillicores, 'Cloud CPU limit');
    assertPositiveInteger(limits.maxMemoryBytes, 'Cloud memory limit');
    if (!Number.isSafeInteger(limits.maxGpuCount) || limits.maxGpuCount < 0) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Cloud GPU limit must be non-negative');
    }
    assertPositiveInteger(limits.maxWallTimeMs, 'Cloud wall-time limit');
    assertPositiveInteger(limits.maxOutputBytes, 'Cloud output limit');
    assertPositiveInteger(limits.maxProcessCount, 'Cloud process limit');
  }
}
