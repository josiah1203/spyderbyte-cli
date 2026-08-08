import { createHash } from 'node:crypto';
import {
  newSortableId,
  runtimeError,
  type Actor,
  type Id,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';

export type EnterpriseSsoProtocol = 'oidc' | 'saml';

export interface EnterpriseSsoProvider {
  readonly providerId: Id;
  readonly tenant: TenantRef;
  readonly displayName: string;
  readonly protocol: EnterpriseSsoProtocol;
  readonly issuerUrl: string;
  readonly clientId: string;
  readonly redirectUris: readonly string[];
  readonly scopes: readonly string[];
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SsoLoginStart {
  readonly providerId: Id;
  readonly state: string;
  readonly authorizationUrl: string;
  readonly expiresAt: string;
}

export interface TrustedIdentityClaims {
  readonly subject: string;
  readonly email: string;
  readonly displayName?: string;
  readonly groups?: readonly string[];
  readonly issuer: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface EnterpriseSession {
  readonly sessionId: Id;
  readonly tenant: TenantRef;
  readonly actor: Actor;
  readonly providerId: Id;
  readonly subject: string;
  readonly groups: readonly string[];
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revokedAt?: string;
}

export interface ScimUser {
  readonly userId: Id;
  readonly tenant: TenantRef;
  readonly externalId: string;
  readonly userName: string;
  readonly email: string;
  readonly displayName: string;
  readonly active: boolean;
  readonly groups: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EnterpriseIdentityAuditRecord {
  readonly auditId: Id;
  readonly tenant: TenantRef;
  readonly action:
    | 'sso.provider.registered'
    | 'sso.login.started'
    | 'sso.login.completed'
    | 'session.revoked'
    | 'scim.user.upserted'
    | 'scim.user.deprovisioned';
  readonly targetId: Id;
  readonly outcome: 'completed' | 'denied';
  readonly at: string;
  readonly details: Readonly<Record<string, string | number | boolean>>;
}

export interface EnterpriseIdentityServiceOptions {
  readonly clock?: () => string;
  readonly loginTtlMs?: number;
  readonly sessionTtlMs?: number;
}

function tenantKey(tenant: TenantRef): string {
  return `${tenant.tenantId}:${tenant.workspaceId}`;
}

function sameTenant(left: TenantRef, right: TenantRef): boolean {
  return left.tenantId === right.tenantId && left.workspaceId === right.workspaceId;
}

function providerKey(tenant: TenantRef, providerId: Id): string {
  return `${tenantKey(tenant)}:${providerId}`;
}

function userKey(tenant: TenantRef, userId: Id): string {
  return `${tenantKey(tenant)}:${userId}`;
}

function assertText(value: string, label: string): string {
  if (value.trim().length === 0 || value.length > 320) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} is required`);
  }
  return value.trim();
}

function assertHttpsUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} must be a URL`);
  }
  if (url.protocol !== 'https:') {
    throw runtimeError('POLICY_DENIED', `${label} must use HTTPS`);
  }
  return url.toString();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryEnterpriseIdentityService {
  private readonly providers = new Map<string, EnterpriseSsoProvider>();
  private readonly loginStates = new Map<
    string,
    { tenant: TenantRef; providerId: Id; expiresAt: string }
  >();
  private readonly sessions = new Map<Id, EnterpriseSession>();
  private readonly users = new Map<string, ScimUser>();
  private readonly audits: EnterpriseIdentityAuditRecord[] = [];
  private readonly clock: () => string;
  private readonly loginTtlMs: number;
  private readonly sessionTtlMs: number;

  constructor(options: EnterpriseIdentityServiceOptions = {}) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.loginTtlMs = options.loginTtlMs ?? 10 * 60_000;
    this.sessionTtlMs = options.sessionTtlMs ?? 8 * 60 * 60_000;
    if (!Number.isSafeInteger(this.loginTtlMs) || this.loginTtlMs < 1) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'SSO login TTL must be positive');
    }
    if (!Number.isSafeInteger(this.sessionTtlMs) || this.sessionTtlMs < 1) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Enterprise session TTL must be positive');
    }
  }

  registerProvider(input: {
    readonly tenant: TenantRef;
    readonly displayName: string;
    readonly protocol: EnterpriseSsoProtocol;
    readonly issuerUrl: string;
    readonly clientId: string;
    readonly redirectUris: readonly string[];
    readonly scopes?: readonly string[];
    readonly now?: string;
  }): EnterpriseSsoProvider {
    if (input.redirectUris.length === 0) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'At least one SSO redirect URI is required');
    }
    const now = input.now ?? this.clock();
    const provider: EnterpriseSsoProvider = {
      providerId: newSortableId(),
      tenant: clone(input.tenant),
      displayName: assertText(input.displayName, 'SSO display name'),
      protocol: input.protocol,
      issuerUrl: assertHttpsUrl(input.issuerUrl, 'SSO issuer URL'),
      clientId: assertText(input.clientId, 'SSO client ID'),
      redirectUris: input.redirectUris.map((uri) => assertHttpsUrl(uri, 'SSO redirect URI')),
      scopes: [...(input.scopes ?? ['openid', 'profile', 'email'])],
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    this.providers.set(providerKey(input.tenant, provider.providerId), provider);
    this.record(input.tenant, 'sso.provider.registered', provider.providerId, 'completed', {
      protocol: provider.protocol,
      displayName: provider.displayName,
    });
    return clone(provider);
  }

  beginLogin(input: {
    readonly tenant: TenantRef;
    readonly providerId: Id;
    readonly redirectUri: string;
    readonly now?: string;
  }): SsoLoginStart {
    const provider = this.requireProvider(input.tenant, input.providerId);
    if (!provider.enabled) throw runtimeError('POLICY_DENIED', 'SSO provider is disabled');
    const redirectUri = assertHttpsUrl(input.redirectUri, 'SSO redirect URI');
    if (!provider.redirectUris.includes(redirectUri)) {
      throw runtimeError('POLICY_DENIED', 'Redirect URI is not registered for the SSO provider');
    }
    const now = input.now ?? this.clock();
    const expiresAt = new Date(Date.parse(now) + this.loginTtlMs).toISOString();
    const state = createHash('sha256')
      .update(`${newSortableId()}:${provider.providerId}`)
      .digest('hex');
    this.loginStates.set(state, {
      tenant: clone(input.tenant),
      providerId: provider.providerId,
      expiresAt,
    });
    const authorizationUrl = new URL(`${provider.issuerUrl.replace(/\/$/, '')}/authorize`);
    authorizationUrl.searchParams.set('client_id', provider.clientId);
    authorizationUrl.searchParams.set('redirect_uri', redirectUri);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('scope', provider.scopes.join(' '));
    authorizationUrl.searchParams.set('state', state);
    this.record(input.tenant, 'sso.login.started', provider.providerId, 'completed', {
      protocol: provider.protocol,
    });
    return {
      providerId: provider.providerId,
      state,
      authorizationUrl: authorizationUrl.toString(),
      expiresAt,
    };
  }

  completeLogin(input: {
    readonly tenant: TenantRef;
    readonly providerId: Id;
    readonly state: string;
    readonly claims: TrustedIdentityClaims;
    readonly now?: string;
  }): EnterpriseSession {
    const pending = this.loginStates.get(input.state);
    const provider = this.requireProvider(input.tenant, input.providerId);
    const now = input.now ?? this.clock();
    if (
      pending === undefined ||
      !sameTenant(pending.tenant, input.tenant) ||
      pending.providerId !== provider.providerId
    ) {
      throw runtimeError('AUTHORITY_MISSING', 'SSO login state is invalid');
    }
    this.loginStates.delete(input.state);
    if (
      Date.parse(pending.expiresAt) <= Date.parse(now) ||
      Date.parse(input.claims.expiresAt) <= Date.parse(now)
    ) {
      throw runtimeError('AUTHORITY_EXPIRED', 'SSO login state or identity claims expired');
    }
    if (input.claims.issuer !== provider.issuerUrl || input.claims.subject.trim().length === 0) {
      throw runtimeError(
        'AUTHORITY_SCOPE_VIOLATION',
        'SSO identity issuer or subject does not match',
      );
    }
    const user = [...this.users.values()].find(
      (candidate) =>
        sameTenant(candidate.tenant, input.tenant) &&
        candidate.email.toLowerCase() === input.claims.email.toLowerCase(),
    );
    if (user !== undefined && !user.active)
      throw runtimeError('POLICY_DENIED', 'SCIM user is deprovisioned');
    const session: EnterpriseSession = {
      sessionId: newSortableId(),
      tenant: clone(input.tenant),
      actor: {
        actorId: user?.userId ?? newSortableId(),
        type: 'human',
        displayName: input.claims.displayName ?? input.claims.email,
      },
      providerId: provider.providerId,
      subject: input.claims.subject,
      groups: [...(input.claims.groups ?? user?.groups ?? [])],
      issuedAt: now,
      expiresAt: new Date(Date.parse(now) + this.sessionTtlMs).toISOString(),
    };
    this.sessions.set(session.sessionId, session);
    this.record(input.tenant, 'sso.login.completed', session.sessionId, 'completed', {
      providerId: provider.providerId,
    });
    return clone(session);
  }

  authenticate(tenant: TenantRef, sessionId: Id, now = this.clock()): EnterpriseSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined || !sameTenant(session.tenant, tenant)) {
      throw runtimeError('AUTHORITY_MISSING', 'Enterprise session was not found');
    }
    if (session.revokedAt !== undefined || Date.parse(session.expiresAt) <= Date.parse(now)) {
      throw runtimeError('AUTHORITY_EXPIRED', 'Enterprise session is expired or revoked');
    }
    return clone(session);
  }

  revokeSession(tenant: TenantRef, sessionId: Id, now = this.clock()): void {
    const session = this.authenticate(tenant, sessionId, now);
    const revoked = { ...session, revokedAt: now };
    this.sessions.set(sessionId, revoked);
    this.record(tenant, 'session.revoked', sessionId, 'completed', {});
  }

  upsertScimUser(input: {
    readonly tenant: TenantRef;
    readonly externalId: string;
    readonly userName: string;
    readonly email: string;
    readonly displayName?: string;
    readonly active?: boolean;
    readonly groups?: readonly string[];
    readonly now?: string;
  }): ScimUser {
    const now = input.now ?? this.clock();
    const existing = [...this.users.values()].find(
      (user) =>
        sameTenant(user.tenant, input.tenant) &&
        user.externalId === assertText(input.externalId, 'SCIM externalId'),
    );
    const user: ScimUser = {
      userId: existing?.userId ?? newSortableId(),
      tenant: clone(input.tenant),
      externalId: input.externalId,
      userName: assertText(input.userName, 'SCIM userName'),
      email: assertText(input.email, 'SCIM email'),
      displayName:
        input.displayName === undefined
          ? input.email
          : assertText(input.displayName, 'SCIM displayName'),
      active: input.active ?? true,
      groups: [...(input.groups ?? [])],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.users.set(userKey(input.tenant, user.userId), user);
    this.record(input.tenant, 'scim.user.upserted', user.userId, 'completed', {
      active: user.active,
    });
    return clone(user);
  }

  deprovisionScimUser(tenant: TenantRef, userId: Id, now = this.clock()): ScimUser {
    const existing = this.users.get(userKey(tenant, userId));
    if (existing === undefined)
      throw runtimeError('ARTIFACT_NOT_FOUND', `SCIM user ${userId} was not found`);
    const user = { ...existing, active: false, updatedAt: now };
    this.users.set(userKey(tenant, userId), user);
    for (const [sessionId, session] of this.sessions.entries()) {
      if (
        session.tenant.tenantId === tenant.tenantId &&
        session.tenant.workspaceId === tenant.workspaceId &&
        session.actor.actorId === userId &&
        session.revokedAt === undefined
      ) {
        this.sessions.set(sessionId, { ...session, revokedAt: now });
      }
    }
    this.record(tenant, 'scim.user.deprovisioned', userId, 'completed', {});
    return clone(user);
  }

  listScimUsers(tenant: TenantRef): readonly ScimUser[] {
    return clone([...this.users.values()].filter((user) => sameTenant(user.tenant, tenant)));
  }

  providersFor(tenant: TenantRef): readonly EnterpriseSsoProvider[] {
    return clone(
      [...this.providers.values()].filter((provider) => sameTenant(provider.tenant, tenant)),
    );
  }

  auditRecords(tenant?: TenantRef): readonly EnterpriseIdentityAuditRecord[] {
    return clone(
      tenant === undefined
        ? this.audits
        : this.audits.filter((record) => sameTenant(record.tenant, tenant)),
    );
  }

  private requireProvider(tenant: TenantRef, providerId: Id): EnterpriseSsoProvider {
    const provider = this.providers.get(providerKey(tenant, providerId));
    if (provider === undefined)
      throw runtimeError('ARTIFACT_NOT_FOUND', `SSO provider ${providerId} was not found`);
    return provider;
  }

  private record(
    tenant: TenantRef,
    action: EnterpriseIdentityAuditRecord['action'],
    targetId: Id,
    outcome: EnterpriseIdentityAuditRecord['outcome'],
    details: Readonly<Record<string, string | number | boolean>>,
  ): void {
    this.audits.push({
      auditId: newSortableId(),
      tenant: clone(tenant),
      action,
      targetId,
      outcome,
      at: this.clock(),
      details: { ...details },
    });
  }
}
