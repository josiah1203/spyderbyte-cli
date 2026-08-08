import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  isId,
  newSortableId,
  runtimeError,
  type Actor,
  type Id,
  type TenantRef,
  type WorkspaceContext,
  type WorkspaceMode,
} from '@agentic-platform/runtime-contracts';

export type ApiRequestHeaders = Readonly<Record<string, string | undefined>>;
export const LOCAL_SESSION_COOKIE_NAME = 'agentic_local_session' as const;

export interface ApiSession {
  readonly schemaVersion: 1;
  readonly sessionId: Id;
  readonly actor: Actor;
  readonly tenant: TenantRef;
  readonly workspaces: readonly TenantRef[];
  /** Trusted context for the selected tenant/workspace, when supplied by composition. */
  readonly workspaceContext?: WorkspaceContext;
  readonly workspaceContexts?: readonly WorkspaceContext[];
  readonly scopes: readonly string[];
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface SessionAuthenticator {
  authenticate(headers: ApiRequestHeaders, now: string): ApiSession;
}

/**
 * Session verifier for the desktop's ephemeral loopback bearer. Only a digest is retained; the
 * raw token is held by the desktop webview and the daemon parent process for the session lifetime.
 */
export class StaticBearerSessionAuthenticator implements SessionAuthenticator {
  private readonly tokenDigest: string;
  private readonly session: ApiSession;
  private readonly cookieName: string;

  constructor(token: string, session: ApiSession, options: { readonly cookieName?: string } = {}) {
    if (!/^\w[A-Za-z0-9._~-]{19,}$/.test(token)) {
      throw new TypeError('Local API bearer token must contain at least 20 safe characters');
    }
    this.tokenDigest = digestToken(token);
    this.session = structuredClone(session);
    this.cookieName = options.cookieName ?? LOCAL_SESSION_COOKIE_NAME;
    assertSessionShape(this.session, this.session.issuedAt);
  }

  authenticate(headers: ApiRequestHeaders, now: string): ApiSession {
    const token = readBearerToken(headers, this.cookieName);
    if (token === undefined || !sameToken(token, this.tokenDigest)) {
      throw runtimeError('AUTHORITY_MISSING', 'Authenticated API session is required');
    }
    return selectSessionWorkspace(this.session, headers, now);
  }
}

export interface SessionIssueRequest {
  readonly actor: Actor;
  readonly tenant: TenantRef;
  readonly workspaces?: readonly TenantRef[];
  readonly workspaceContext?: WorkspaceContext;
  readonly workspaceContexts?: readonly WorkspaceContext[];
  readonly scopes?: readonly string[];
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface IssuedApiSession {
  readonly token: string;
  readonly session: ApiSession;
}

/**
 * Local/test session authority. It stores only a SHA-256 token digest, so fixture infrastructure
 * cannot accidentally persist or expose bearer material. Hosted composition should replace this
 * port with an OIDC/JWT or session-store adapter after the identity decision gate.
 */
export class InMemorySessionAuthenticator implements SessionAuthenticator {
  private readonly sessions = new Map<string, ApiSession>();
  private readonly tokenBySession = new Map<Id, string>();

  issue(request: SessionIssueRequest): IssuedApiSession {
    const session: ApiSession = {
      schemaVersion: 1,
      sessionId: this.newSessionId(),
      actor: request.actor,
      tenant: request.tenant,
      workspaces: [...(request.workspaces ?? [request.tenant])],
      ...(request.workspaceContext === undefined
        ? {}
        : { workspaceContext: request.workspaceContext }),
      ...(request.workspaceContexts === undefined
        ? {}
        : { workspaceContexts: [...request.workspaceContexts] }),
      scopes: [...(request.scopes ?? [])].sort(),
      issuedAt: request.issuedAt,
      expiresAt: request.expiresAt,
    };
    assertSessionShape(session, request.issuedAt);
    if (!session.workspaces.some((workspace) => sameTenant(workspace, session.tenant))) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Session tenant is not in its workspace set');
    }
    const token = randomBytes(32).toString('base64url');
    const tokenDigest = digestToken(token);
    this.sessions.set(tokenDigest, structuredClone(session));
    this.tokenBySession.set(session.sessionId, tokenDigest);
    return { token, session: structuredClone(session) };
  }

  authenticate(headers: ApiRequestHeaders, now: string): ApiSession {
    const token = readBearerToken(headers);
    if (token === undefined) {
      throw runtimeError('AUTHORITY_MISSING', 'Authenticated API session is required');
    }
    const session = this.sessions.get(digestToken(token));
    if (session === undefined) {
      throw runtimeError('AUTHORITY_MISSING', 'Bearer session token is invalid');
    }
    return selectSessionWorkspace(session, headers, now);
  }

  revoke(sessionId: Id): boolean {
    const tokenDigest = this.tokenBySession.get(sessionId);
    if (tokenDigest === undefined) return false;
    this.tokenBySession.delete(sessionId);
    return this.sessions.delete(tokenDigest);
  }

  private newSessionId(): Id {
    let sessionId = newSortableId();
    while (this.tokenBySession.has(sessionId)) {
      sessionId = newSortableId();
    }
    return sessionId;
  }
}

function readHeader(headers: ApiRequestHeaders, name: string): string | undefined {
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return match?.[1];
}

function readBearerToken(
  headers: ApiRequestHeaders,
  cookieName: string = LOCAL_SESSION_COOKIE_NAME,
): string | undefined {
  const authorization = readHeader(headers, 'authorization');
  if (authorization !== undefined) {
    const match = /^Bearer ([A-Za-z0-9._~-]{20,})$/.exec(authorization.trim());
    return match?.[1];
  }
  const cookieHeader = readHeader(headers, 'cookie');
  if (cookieHeader === undefined) return undefined;
  const cookie = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => {
      return part.startsWith(`${cookieName}=`);
    });
  const value = cookie?.slice(cookieName.length + 1);
  return value === undefined || !/^[A-Za-z0-9._~-]{20,}$/.test(value) ? undefined : value;
}

function sameToken(candidate: string, expectedDigest: string): boolean {
  const candidateDigest = Buffer.from(digestToken(candidate), 'hex');
  const expected = Buffer.from(expectedDigest, 'hex');
  return candidateDigest.length === expected.length && timingSafeEqual(candidateDigest, expected);
}

function digestToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function selectSessionWorkspace(
  session: ApiSession,
  headers: ApiRequestHeaders,
  now: string,
): ApiSession {
  assertSessionShape(session, now);
  if (Date.parse(session.expiresAt) <= Date.parse(now)) {
    throw runtimeError('AUTHORITY_EXPIRED', 'Authenticated API session has expired');
  }
  const requestedWorkspaceId = readHeader(headers, 'x-agentic-workspace-id')?.trim();
  if (requestedWorkspaceId === undefined || requestedWorkspaceId.length === 0) {
    return structuredClone(session);
  }
  const selectedWorkspace = session.workspaces.find(
    (workspace) => workspace.workspaceId === requestedWorkspaceId,
  );
  if (selectedWorkspace === undefined) {
    throw runtimeError(
      'AUTHORITY_SCOPE_VIOLATION',
      'Requested workspace is not assigned to the session',
    );
  }
  const selectedContext = session.workspaceContexts?.find((context) =>
    sameTenant(context, selectedWorkspace),
  );
  if (session.workspaceContexts !== undefined && selectedContext === undefined) {
    throw runtimeError(
      'AUTHORITY_SCOPE_VIOLATION',
      'Requested workspace has no matching trusted context',
    );
  }
  if (
    session.workspaceContext !== undefined &&
    session.workspaceContexts === undefined &&
    !sameTenant(session.workspaceContext, selectedWorkspace)
  ) {
    throw runtimeError(
      'AUTHORITY_SCOPE_VIOLATION',
      'Requested workspace has no matching trusted context',
    );
  }
  return structuredClone({
    ...session,
    tenant: selectedWorkspace,
    ...(selectedContext === undefined ? {} : { workspaceContext: selectedContext }),
  });
}

function assertSessionShape(session: ApiSession, now: string): void {
  const actor = session?.actor;
  const tenant = session?.tenant;
  const workspaces = session?.workspaces;
  const workspaceContext = session?.workspaceContext;
  const workspaceContexts = session?.workspaceContexts;
  if (
    session.schemaVersion !== 1 ||
    !isId(session.sessionId) ||
    actor === undefined ||
    actor === null ||
    !isId(actor.actorId) ||
    tenant === undefined ||
    tenant === null ||
    !isId(tenant.tenantId) ||
    !isId(tenant.workspaceId) ||
    !Array.isArray(workspaces) ||
    workspaces.length === 0 ||
    workspaces.some(
      (workspace) =>
        workspace === undefined ||
        workspace === null ||
        !isId(workspace.tenantId) ||
        !isId(workspace.workspaceId),
    ) ||
    (workspaceContext !== undefined &&
      (!isId(workspaceContext.tenantId) ||
        !isId(workspaceContext.workspaceId) ||
        !isWorkspaceMode(workspaceContext.mode) ||
        !isValidOrganizationContext(workspaceContext) ||
        !sameTenant(workspaceContext, tenant))) ||
    (workspaceContexts !== undefined &&
      (!Array.isArray(workspaceContexts) ||
        workspaceContexts.length === 0 ||
        workspaceContexts.some(
          (context) =>
            context === undefined ||
            context === null ||
            !isId(context.tenantId) ||
            !isId(context.workspaceId) ||
            !isWorkspaceMode(context.mode) ||
            !isValidOrganizationContext(context) ||
            !workspaces.some((workspace) => sameTenant(workspace, context)),
        )))
  ) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Authenticated API session is malformed');
  }
  const issuedAt = Date.parse(session.issuedAt);
  const expiresAt = Date.parse(session.expiresAt);
  const observedAt = Date.parse(now);
  if (
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    !Number.isFinite(observedAt) ||
    expiresAt <= issuedAt
  ) {
    throw runtimeError(
      'VALIDATION_SCHEMA_MISMATCH',
      'Authenticated API session timestamps invalid',
    );
  }
  if (issuedAt > observedAt) {
    throw runtimeError('AUTHORITY_MISSING', 'Authenticated API session is not active yet');
  }
}

function isWorkspaceMode(value: unknown): value is WorkspaceMode {
  return (
    value === 'personal_local' || value === 'organization_local' || value === 'organization_hosted'
  );
}

function isValidOrganizationContext(context: WorkspaceContext): boolean {
  if (context.mode === 'personal_local') return context.organizationId === undefined;
  return context.organizationId !== undefined && isId(context.organizationId);
}

function sameTenant(left: TenantRef, right: TenantRef): boolean {
  return left.tenantId === right.tenantId && left.workspaceId === right.workspaceId;
}
