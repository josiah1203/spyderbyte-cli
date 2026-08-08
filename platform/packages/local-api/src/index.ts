import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isAbsolute } from 'node:path';
import {
  createStructuredArtifactDiff,
  type ContentAddressedArtifactRegistry,
} from '@agentic-platform/artifact-registry';
import type { EnterpriseControlPlane } from '@agentic-platform/backends';
import { DEFAULT_LOCAL_WORKFLOW_FEATURE, type LicenseGate } from '@agentic-platform/license';
import {
  getErrorDefinition,
  isId,
  isJsonValue,
  newSortableId,
  redactSecretText,
  runtimeError,
  validateContract,
  type Actor,
  type ArtifactReference,
  type AuthorityEnvelope,
  type CloudRunRequestV1,
  type ExecutionReplay,
  type HashSha256,
  type Id,
  type JsonPrimitive,
  type JsonValue,
  type RuntimeCommand,
  type RuntimeErrorCode,
  type RuntimeProfile,
  type TenantRef,
  type WorkspaceContext,
} from '@agentic-platform/runtime-contracts';
import type { LocalDatasetOrchestrator } from '@agentic-platform/orchestrator';
import type { CloudRunContinuityService } from '@agentic-platform/cloud-runtime';
import type {
  ApprovalRecord,
  ApprovalService,
  GovernanceApprovalContextV1,
  GovernanceRole,
  LocalConfirmationService,
} from '@agentic-platform/policy';
import { governanceMembershipForActor, governanceRoleAllows } from '@agentic-platform/policy';
import {
  EventSubscriptionGateway,
  UniversalRunCoordinator,
  type UniversalRunOperationResult,
  type SubscriptionPage,
  type SubscriptionRequest,
} from '@agentic-platform/runtime-domain';
import type { StateStore } from '@agentic-platform/state';
import type {
  AutomationNotificationConfigV1,
  AutomationRetryPolicyV1,
  HarnessModelPolicy,
  ModelRoutingPolicy,
  DataConnectionInputV1,
  DataExportFormat,
  DataHandoffTarget,
  DataQualityRequestV1,
  DataSavedQueryInputV1,
  DatasetVersionInputV1,
  PipelineDefinitionV1,
  ProviderRuntimeServices,
  TrainingRunRequestV1,
  ExperimentComputeSpecV1,
  ExperimentEvaluationObservationV1,
  ExperimentEvaluationRequestV1,
  ExperimentMetricSpecV1,
  ExperimentRunStartInputV1,
  LocalExperimentDefinitionInputV1,
  ModelCandidateInputV1,
  ModelCardV1,
  ModelPromotionInputV1,
  ModelValidationInputV1,
  LocalServingApprovalV1,
  LocalServingRequestV1,
  LocalServingScalingV1,
  VisualizationType,
} from '@agentic-platform/provider-runtime';
import {
  LOCAL_SESSION_COOKIE_NAME,
  type ApiRequestHeaders,
  type ApiSession,
  type SessionAuthenticator,
} from './auth.js';
import { paginate, parsePagination } from './pagination.js';
import type { ApiRateLimiter, RateLimitDecision } from './rate-limit.js';
import type { ConversationService } from './conversation.js';
import {
  handleProductionScaleRequest,
  type ProductionScaleOperations,
} from './production-scale.js';
import {
  InMemorySettingsStore,
  type SettingsEnvelope,
  type SettingsScope,
  type SettingsStore,
  type SettingsValues,
} from './settings.js';
import {
  detectOnboardingContext,
  type OnboardingChoice,
  type OnboardingState,
} from './onboarding.js';
import { handleEnterpriseRequest } from './enterprise.js';

export * from './conversation.js';
export * from './production-scale.js';
export * from './enterprise.js';
export { createExecutionRequest } from '@agentic-platform/runtime-domain';

export * from './auth.js';
export * from './settings.js';
export * from './onboarding.js';

const MAX_LOCAL_ARTIFACT_UPLOAD_BYTES = 25 * 1024 * 1024;
const defaultSettingsStore = new InMemorySettingsStore();

function settingsStore(options: LocalApiOptions): SettingsStore {
  return options.settings ?? defaultSettingsStore;
}

function settingsScope(value: unknown): SettingsScope {
  if (value !== 'user' && value !== 'workspace' && value !== 'project') {
    throw runtimeError(
      'VALIDATION_SCHEMA_MISMATCH',
      'settings scope must be user, workspace, or project',
    );
  }
  return value;
}

function settingsProjectId(value: unknown, scope: SettingsScope): Id | undefined {
  if (value === undefined || value === '') {
    if (scope === 'project') {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'project settings require projectId');
    }
    return undefined;
  }
  if (typeof value !== 'string' || !isId(value)) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'projectId must be a UUIDv7 id');
  }
  if (scope !== 'project') {
    throw runtimeError(
      'VALIDATION_SCHEMA_MISMATCH',
      'projectId is only valid for project settings',
    );
  }
  return value;
}

function settingsEnvelope(
  options: LocalApiOptions,
  scope: SettingsScope,
  projectId: Id | undefined,
): SettingsEnvelope {
  return (
    settingsStore(options).get(options.tenant, scope, projectId) ?? {
      schemaVersion: 1,
      scope,
      ...(projectId === undefined ? {} : { projectId }),
      revision: 0,
      values: {},
      updatedAt: options.clock?.() ?? new Date(0).toISOString(),
    }
  );
}

function profileRecord(options: LocalApiOptions, session: ApiSession | undefined): SettingsValues {
  const values = settingsEnvelope(options, 'user', undefined).values;
  const profile = values['profile'];
  if (profile !== null && typeof profile === 'object' && !Array.isArray(profile)) {
    return profile as SettingsValues;
  }
  return {
    displayName: session?.actor.displayName ?? '',
    onboardingComplete: false,
  };
}

const SENSITIVE_DIAGNOSTIC_KEYS =
  /(?:secret|token|password|api[-_]?key|authorization|private[-_]?key)/i;

export function sanitizeDiagnosticValue(value: unknown, key?: string): JsonValue {
  if (key !== undefined && SENSITIVE_DIAGNOSTIC_KEYS.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactSecretText(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeDiagnosticValue(entry));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeDiagnosticValue(entryValue, entryKey),
      ]),
    ) as JsonValue;
  }
  return value as JsonValue;
}

function providerRuntimeDiagnostics(options: LocalApiOptions): JsonValue {
  const runtime = options.providerRuntime;
  if (runtime === undefined) {
    return {
      schemaVersion: 1,
      generatedAt: options.clock?.() ?? new Date().toISOString(),
      providerRuntime: 'not_configured',
    };
  }
  return sanitizeDiagnosticValue({
    schemaVersion: 1,
    generatedAt: options.clock?.() ?? new Date().toISOString(),
    providers: runtime.providers.list().map((provider) => ({
      providerConfigurationId: provider.providerConfigurationId,
      providerId: provider.providerId,
      providerType: provider.providerType,
      state: provider.state,
      authenticationState: provider.authenticationState,
      local: provider.local,
      endpoint: provider.endpoint,
      usagePolicy: provider.usagePolicy,
      lastTestedAt: provider.lastTestedAt,
      lastSuccessfulUseAt: provider.lastSuccessfulUseAt,
      lastFailureAt: provider.lastFailureAt,
    })),
    models: runtime.catalog.list().map((model) => ({
      providerId: model.providerId,
      modelId: model.modelId,
      state: model.state,
      local: model.local,
      capabilities: model.capabilities,
      usageStatus: model.usageStatus,
    })),
    runtimes: runtime.runtimes.list(),
    providerPriority: runtime.providerPriority,
    routingPolicy: runtime.routingPolicy,
  }) as JsonValue;
}

export interface LocalWorkspaceOperations {
  readonly rootPath: string;
  readonly manifest: JsonValue;
  exportArchive(archivePath: string): Promise<JsonValue>;
  /** Optional semantic alias for durable snapshots; export remains the fallback. */
  backupArchive?(archivePath: string): Promise<JsonValue>;
  previewRestore(archivePath: string, destinationRoot: string): Promise<JsonValue>;
  importArchive(archivePath: string, destinationRoot: string): Promise<JsonValue>;
}

export interface LocalApiOptions {
  orchestrator: LocalDatasetOrchestrator;
  tenant: TenantRef;
  state?: StateStore;
  workspace?: LocalWorkspaceOperations;
  subscriptions?: EventSubscriptionGateway;
  artifacts?: ContentAddressedArtifactRegistry;
  approvals?: {
    readonly service: ApprovalService;
    readonly actor: Actor;
    readonly authority?: AuthorityEnvelope;
    readonly authorityFor?: (input: {
      readonly approval: ApprovalRecord;
      readonly actor: Actor;
      readonly action: 'decide' | 'revoke';
      readonly now: string;
    }) => AuthorityEnvelope;
    readonly clock?: () => string;
  };
  budget?: {
    snapshot(tenant: TenantRef, budgetId: Id): unknown;
  };
  audit?: {
    list(tenant: TenantRef): readonly unknown[];
  };
  projections?: {
    read(tenant: TenantRef, projectionName: string): unknown | Promise<unknown>;
  };
  productCommands?: {
    supports(commandType: string): boolean;
    execute(command: RuntimeCommand): Promise<JsonValue>;
  };
  /** Optional shared model, OAuth, local-model, and speech services. */
  providerRuntime?: ProviderRuntimeServices;
  /** Optional Cline-backed project conversation service. */
  conversation?: ConversationService;
  /** Shared durable coordinator for material actions; defaults to the supplied StateStore. */
  universalRuns?: UniversalRunCoordinator;
  /** Optional hosted/control-plane services for the P3 production-scale API surface. */
  productionScale?: ProductionScaleOperations;
  /** Optional Phase 10 enterprise/government control plane and adapter registry. */
  enterprise?: EnterpriseControlPlane;
  /** Optional managed-execution boundary for local-to-Spyderbyte Cloud Run continuity. */
  cloud?: {
    readonly service: CloudRunContinuityService;
  };
  capabilities?: JsonValue;
  /** The local limiter is an injectable port; hosted composition should use a shared implementation. */
  rateLimiter?: ApiRateLimiter;
  /** Optional identity boundary; production composition must provide a hosted authenticator. */
  sessionAuthenticator?: SessionAuthenticator;
  /** Trusted workspace context supplied by the daemon/host composition. */
  workspaceContext?: WorkspaceContext;
  /** Durable user/workspace/project settings store. */
  settings?: SettingsStore;
  /** Separate device-local confirmation challenges for personal-local safety prompts. */
  confirmations?: LocalConfirmationService;
  /** Refreshes the session actor from durable profile state without exposing credentials. */
  sessionTransform?: (session: ApiSession) => ApiSession;
  /** Spyderbyte license boundary; production composition must provide a signed gate. */
  license?: LicenseGate;
  /** Single-workspace local composition can expose a stable session without hosted identity. */
  localSession?: ApiSession;
  /** Optional local-only license import sink; the caller owns validation and durable storage. */
  licenseImport?: (entitlement: unknown) => void | Promise<void>;
  /** Ephemeral desktop session cookie used by browser EventSource, which cannot set headers. */
  sessionCookie?: {
    readonly name?: string;
    readonly value: string;
  };
  /** Explicit loopback origins allowed to call the local API from the desktop webview. */
  corsOrigins?: readonly string[];
  clock?: () => string;
}

export interface LocalApiRequest {
  method: string;
  path: string;
  body: unknown;
  headers?: ApiRequestHeaders;
}

export interface LocalApiResponse {
  statusCode: number;
  body: unknown;
  headers?: Readonly<Record<string, string>>;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Request body must be valid JSON');
  }
}

function jsonResponse(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  if (statusCode === 204 || body === undefined) {
    response.statusCode = statusCode;
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
    response.end();
    return;
  }
  const encoded = JSON.stringify(body);
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.end(encoded);
}

function errorStatus(error: unknown): number {
  const code = error instanceof Error && 'code' in error ? String(error.code) : undefined;
  if (
    code === 'CONCURRENCY_STALE_VERSION' ||
    code === 'APPROVAL_REQUIRED' ||
    code === 'APPROVAL_INVALIDATED' ||
    code === 'BUDGET_EXCEEDED' ||
    code === 'RETRY_EXHAUSTED'
  )
    return 409;
  if (code === 'AUTHORITY_MISSING' || code === 'AUTHORITY_EXPIRED') return 401;
  if (code === 'AUTHORITY_SCOPE_VIOLATION') return 403;
  if (code === 'LOCAL_CONFIRMATION_REQUIRED') return 409;
  if (code === 'CAPABILITY_UNAVAILABLE') return 503;
  if (code === 'POLICY_DENIED') return 403;
  if (code === 'COMPUTE_RESOURCE_UNAVAILABLE' || code === 'EXTERNAL_DEPENDENCY_UNAVAILABLE')
    return 503;
  if (
    code === 'VALIDATION_INVALID_INPUT' ||
    code === 'VALIDATION_SCHEMA_MISMATCH' ||
    code === 'WORKSPACE_ARCHIVE_INVALID' ||
    code === 'WORKSPACE_ARCHIVE_INTEGRITY'
  ) {
    return 400;
  }
  if (code === 'WORKSPACE_DESTINATION_EXISTS' || code === 'WORKSPACE_EXISTS') return 409;
  if (code === 'ARTIFACT_NOT_FOUND' || code === 'WORKSPACE_NOT_FOUND') return 404;
  return 500;
}

export function errorBody(
  error: unknown,
  correlationId?: string,
): { error: string; code?: string; correlationId?: string } {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : undefined;
  const explicitUserMessage =
    error !== null &&
    typeof error === 'object' &&
    typeof (error as { userMessage?: unknown }).userMessage === 'string'
      ? (error as { userMessage: string }).userMessage
      : undefined;
  let userMessage = explicitUserMessage;
  if (userMessage === undefined && code !== undefined) {
    try {
      userMessage = getErrorDefinition(code as RuntimeErrorCode)?.userMessage;
    } catch {
      userMessage = undefined;
    }
  }
  return {
    error: userMessage ?? (error instanceof Error ? error.message : String(error)),
    ...(code === undefined ? {} : { code }),
    ...(correlationId === undefined ? {} : { correlationId }),
  };
}

function commandAcknowledgement(command: RuntimeCommand, result: unknown): JsonValue {
  const metadata = {
    accepted: true,
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    correlationId: command.correlationId,
  } satisfies Record<string, JsonValue>;
  if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
    return { ...(result as Record<string, JsonValue>), ...metadata, result: result as JsonValue };
  }
  return { ...metadata, result: result as JsonValue };
}

export function formatSubscriptionFrame(page: SubscriptionPage): string {
  return `id: ${page.cursor}\nevent: runtime.events\ndata: ${JSON.stringify(page)}\n\n`;
}

function rateLimitResponse(options: LocalApiOptions): LocalApiResponse | undefined {
  const limiter = options.rateLimiter;
  if (limiter === undefined) return undefined;
  const decision = limiter.consume(`${options.tenant.tenantId}:${options.tenant.workspaceId}`);
  if (decision.allowed) return undefined;
  return {
    statusCode: 429,
    body: {
      error: 'rate_limit_exceeded',
      retryAfterSeconds: retryAfterSeconds(decision),
    },
    headers: rateLimitHeaders(decision),
  };
}

function rateLimitHeaders(decision: RateLimitDecision): Readonly<Record<string, string>> {
  return {
    'retry-after': String(retryAfterSeconds(decision)),
    'x-ratelimit-limit': String(decision.limit),
    'x-ratelimit-remaining': String(decision.remaining),
    'x-ratelimit-reset': String(Math.ceil(decision.resetAt / 1000)),
  };
}

function retryAfterSeconds(decision: RateLimitDecision): number {
  return Math.max(
    1,
    Math.ceil((decision.retryAfterMs ?? Math.max(0, decision.resetAt - Date.now())) / 1000),
  );
}

function authenticateRequest(
  request: LocalApiRequest,
  options: LocalApiOptions,
): ApiSession | undefined {
  const authenticator = options.sessionAuthenticator;
  const session =
    authenticator === undefined
      ? options.localSession
      : authenticator.authenticate(
          request.headers ?? {},
          options.clock?.() ?? new Date().toISOString(),
        );
  return session === undefined ? undefined : (options.sessionTransform?.(session) ?? session);
}

function optionsForSession(
  options: LocalApiOptions,
  session: ApiSession | undefined,
): LocalApiOptions {
  return session === undefined
    ? options
    : {
        ...options,
        tenant: session.tenant,
        ...(session.workspaceContext === undefined
          ? {}
          : { workspaceContext: session.workspaceContext }),
        localSession: session,
      };
}

function headerValue(request: LocalApiRequest, name: string): string | undefined {
  const direct = request.headers?.[name];
  if (direct !== undefined) return direct;
  return Object.entries(request.headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
}

function sourceInterfaceForRequest(
  request: LocalApiRequest,
  path: string,
): (typeof CONVERSATION_SOURCE_INTERFACES)[number] {
  const body =
    request.body !== null && typeof request.body === 'object' && !Array.isArray(request.body)
      ? (request.body as Record<string, unknown>)
      : undefined;
  const candidate = headerValue(request, 'x-spyderbyte-interface') ?? body?.['sourceInterface'];
  if (
    CONVERSATION_SOURCE_INTERFACES.includes(
      candidate as (typeof CONVERSATION_SOURCE_INTERFACES)[number],
    )
  ) {
    return candidate as (typeof CONVERSATION_SOURCE_INTERFACES)[number];
  }
  if (path.startsWith('/v1/jupyter/')) return 'jupyter';
  if (path.startsWith('/v1/acp/')) return 'acp';
  if (path.startsWith('/v1/automations/')) return 'automation';
  return 'api';
}

function projectIdForRequest(request: LocalApiRequest, path: string): Id | undefined {
  const body =
    request.body !== null && typeof request.body === 'object' && !Array.isArray(request.body)
      ? (request.body as Record<string, unknown>)
      : undefined;
  if (isId(body?.['projectId'])) return body['projectId'];
  const payload =
    body?.['payload'] !== null &&
    typeof body?.['payload'] === 'object' &&
    !Array.isArray(body?.['payload'])
      ? (body['payload'] as Record<string, unknown>)
      : undefined;
  if (isId(payload?.['projectId'])) return payload['projectId'];
  const projectMatch = /^\/v1\/projects\/([^/]+)/.exec(path);
  const projectId = projectMatch?.[1];
  return projectId !== undefined && isId(projectId) ? projectId : undefined;
}

interface SharedAccessRequirement {
  readonly minimumRole: GovernanceRole;
  readonly projectId?: Id;
}

function sharedAccessRequirement(
  request: LocalApiRequest,
  path: string,
): SharedAccessRequirement | undefined {
  const method = request.method.toUpperCase();
  const projectId = projectIdForRequest(request, path);
  if (/^\/v1\/projects\/[^/]+\/conversation(?:\/messages)?$/.test(path)) {
    return {
      minimumRole: method === 'GET' ? 'viewer' : 'operator',
      ...(projectId === undefined ? {} : { projectId }),
    };
  }
  if (/^\/v1\/projects\/[^/]+\/(?:conversation|agent-session)/.test(path)) {
    return { minimumRole: 'viewer', ...(projectId === undefined ? {} : { projectId }) };
  }
  if (/^\/v1\/(?:runs|agent-sessions|artifacts|collaboration|projections)\b/.test(path)) {
    return {
      minimumRole: MUTATING_METHODS.has(method) ? 'editor' : 'viewer',
      ...(projectId === undefined ? {} : { projectId }),
    };
  }
  if (path === '/v1/commands' || path === '/v1/commands/plan') {
    const body = bodyRecord(request.body, 'runtime command');
    const commandType = typeof body['commandType'] === 'string' ? body['commandType'] : '';
    const readOnly = path.endsWith('/plan');
    return {
      minimumRole:
        readOnly || commandType === 'CancelRun' || commandType === 'CancelProject'
          ? 'operator'
          : 'editor',
      ...(projectId === undefined ? {} : { projectId }),
    };
  }
  if (path.startsWith('/v1/providers')) {
    return { minimumRole: MUTATING_METHODS.has(method) ? 'admin' : 'viewer' };
  }
  if (path.startsWith('/v1/provider-actions')) {
    return { minimumRole: MUTATING_METHODS.has(method) ? 'operator' : 'viewer' };
  }
  if (
    path.startsWith('/v1/connectors') ||
    path.startsWith('/v1/connector-') ||
    path.startsWith('/v1/connections')
  ) {
    return { minimumRole: MUTATING_METHODS.has(method) ? 'operator' : 'viewer' };
  }
  if (path.startsWith('/v1/oauth')) {
    return { minimumRole: MUTATING_METHODS.has(method) ? 'admin' : 'viewer' };
  }
  if (path.startsWith('/v1/cloud/runs/')) {
    return { minimumRole: MUTATING_METHODS.has(method) ? 'operator' : 'viewer' };
  }
  if (path === '/v1/approvals' || path.startsWith('/v1/approvals/')) {
    return { minimumRole: method === 'GET' ? 'viewer' : 'operator' };
  }
  if (path === '/v1/workspace' || path.startsWith('/v1/workspace/')) {
    return { minimumRole: method === 'GET' ? 'viewer' : 'editor' };
  }
  return undefined;
}

function assertSharedWorkspaceAccess(
  request: LocalApiRequest,
  path: string,
  options: LocalApiOptions,
  actor: Actor | undefined,
): void {
  const context = options.workspaceContext;
  if (context?.mode === undefined || context.mode === 'personal_local') return;
  const requirement = sharedAccessRequirement(request, path);
  if (requirement === undefined) return;
  const organizationId = context.organizationId;
  const governance = options.productionScale?.governance;
  if (organizationId === undefined || governance === undefined) {
    throw runtimeError(
      'CAPABILITY_UNAVAILABLE',
      'Organization workspace governance is not configured for this shared operation',
    );
  }
  if (actor === undefined)
    throw runtimeError('AUTHORITY_MISSING', 'An authenticated actor is required for shared access');
  const membership = governanceMembershipForActor(
    governance.listMemberships(options.tenant, organizationId),
    actor.actorId,
    options.tenant.workspaceId,
    requirement.projectId,
  );
  if (membership === undefined) {
    throw runtimeError(
      'AUTHORITY_SCOPE_VIOLATION',
      'Actor is not an active member of this workspace',
    );
  }
  if (!governanceRoleAllows(membership.role, requirement.minimumRole)) {
    throw runtimeError(
      'POLICY_DENIED',
      `The ${requirement.minimumRole} role is required for this shared operation`,
    );
  }
}

function replayForRequest(
  request: LocalApiRequest,
  sourceInterface: (typeof CONVERSATION_SOURCE_INTERFACES)[number],
): ExecutionReplay {
  const replayBody =
    request.body === undefined || !isJsonValue(request.body)
      ? undefined
      : replaySafeJson(request.body);
  return {
    type: 'http',
    method: request.method.toUpperCase(),
    path: request.path,
    ...(replayBody === undefined ? {} : { body: replayBody }),
    headers: { 'x-spyderbyte-interface': sourceInterface },
  };
}

const REPLAY_SENSITIVE_KEY =
  /^(?:api[-_]?key|secret|token|password|authorization|private[-_]?key)$/i;

function replaySafeJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((entry) => replaySafeJson(entry));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !REPLAY_SENSITIVE_KEY.test(key))
        .map(([key, entry]) => [key, replaySafeJson(entry)]),
    ) as JsonValue;
  }
  return value;
}

const coordinatorsByState = new WeakMap<object, UniversalRunCoordinator>();

function universalRunCoordinator(options: LocalApiOptions): UniversalRunCoordinator | undefined {
  if (options.universalRuns !== undefined) return options.universalRuns;
  if (options.state === undefined) return undefined;
  const existing = coordinatorsByState.get(options.state);
  if (existing !== undefined) return existing;
  const coordinator = new UniversalRunCoordinator(options.state, options.clock);
  coordinatorsByState.set(options.state, coordinator);
  return coordinator;
}

function assertLicensed(options: LocalApiOptions): void {
  options.license?.assertFeature(DEFAULT_LOCAL_WORKFLOW_FEATURE);
}

/**
 * Personal-local effectful operations use a short-lived, action-bound challenge when the host
 * composes the API with LocalConfirmationService. Organization policy/approval remains the
 * responsibility of the hosted control plane and is not inferred from a browser payload.
 */
function requireLocalConfirmation(
  options: LocalApiOptions,
  action: JsonValue,
  confirmationId: unknown,
): void {
  if (options.workspaceContext?.mode !== 'personal_local' || options.confirmations === undefined) {
    return;
  }
  if (confirmationId !== undefined && typeof confirmationId !== 'string') {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'confirmationId must be a string');
  }
  const now = options.clock?.() ?? new Date().toISOString();
  if (typeof confirmationId !== 'string' || confirmationId.length === 0) {
    const challenge = options.confirmations.issue(action, now);
    throw runtimeError(
      'LOCAL_CONFIRMATION_REQUIRED',
      'Confirm this effectful local action before retrying it',
      [challenge.challengeId],
    );
  }
  options.confirmations.consume(pathId(confirmationId, 'confirmationId'), action, now);
}

function applyCorsHeaders(
  request: IncomingMessage,
  response: ServerResponse,
  options: LocalApiOptions,
): void {
  const origin = request.headers.origin;
  if (origin !== undefined && options.corsOrigins?.includes(origin)) {
    response.setHeader('access-control-allow-origin', origin);
    response.setHeader('access-control-allow-credentials', 'true');
    response.setHeader('vary', 'Origin');
  }
  response.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  response.setHeader(
    'access-control-allow-headers',
    'accept,content-type,authorization,x-agentic-workspace-id',
  );
}

function sessionCookieHeader(options: LocalApiOptions): string | undefined {
  const cookie = options.sessionCookie;
  if (cookie === undefined) return undefined;
  return `${cookie.name ?? LOCAL_SESSION_COOKIE_NAME}=${cookie.value}; Path=/; HttpOnly; SameSite=Strict`;
}

function setSessionCookie(response: ServerResponse, options: LocalApiOptions): void {
  const value = sessionCookieHeader(options);
  if (value !== undefined) response.setHeader('set-cookie', value);
}

export function subscriptionRequestFromPath(
  rawPath: string,
  tenant: TenantRef,
): SubscriptionRequest {
  const query = new URL(rawPath, 'http://local').searchParams;
  const parsedCursor = Number(query.get('afterCursor') ?? '0');
  const parsedMaxEvents = Number(query.get('maxEvents') ?? '0');
  const topics = [
    ...query.getAll('topic'),
    ...query
      .getAll('topics')
      .flatMap((value) => value.split(',').map((topic) => topic.trim()))
      .filter((topic) => topic.length > 0),
  ];
  return {
    tenant,
    afterCursor: Number.isSafeInteger(parsedCursor) && parsedCursor >= 0 ? parsedCursor : 0,
    ...(Number.isSafeInteger(parsedMaxEvents) && parsedMaxEvents > 0
      ? { maxEvents: parsedMaxEvents }
      : {}),
    ...(topics.length > 0 ? { topics } : {}),
  };
}

function subscriptionGateway(options: LocalApiOptions): EventSubscriptionGateway | undefined {
  if (options.subscriptions !== undefined) return options.subscriptions;
  if (options.state !== undefined) return new EventSubscriptionGateway({ state: options.state });
  return undefined;
}

function pathId(value: string, name: string): Id {
  if (!isId(value)) throw runtimeError('VALIDATION_INVALID_INPUT', `${name} must be a UUIDv7 id`);
  return value;
}

function bodyRecord(body: unknown, label: string): Record<string, unknown> {
  if (body === undefined) return {};
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${label} must be an object`);
  }
  return body as Record<string, unknown>;
}

function cloudAccessToken(request: LocalApiRequest): string {
  const authorization =
    headerValue(request, 'x-spyderbyte-cloud-token') ?? headerValue(request, 'authorization');
  if (authorization === undefined) {
    throw runtimeError('AUTHORITY_MISSING', 'Cloud bearer authorization is required');
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (match?.[1] === undefined || match[1].trim().length === 0) {
    throw runtimeError('AUTHORITY_MISSING', 'Cloud bearer authorization is invalid');
  }
  return match[1].trim();
}

async function handleCloudRunRequest(
  request: LocalApiRequest,
  options: LocalApiOptions,
): Promise<LocalApiResponse | undefined> {
  const cloud = options.cloud;
  if (cloud === undefined) return undefined;
  const path = request.path.split('?')[0] ?? '/';
  const isCloudPath =
    (request.method === 'POST' &&
      ['/v1/cloud/runs/estimate', '/v1/cloud/runs/approve', '/v1/cloud/runs/execute'].includes(
        path,
      )) ||
    (request.method === 'GET' && /^\/v1\/cloud\/runs\/[^/]+\/events$/.test(path));
  if (!isCloudPath) return undefined;
  const accessToken = cloudAccessToken(request);
  if (request.method === 'POST' && path === '/v1/cloud/runs/estimate') {
    const body = bodyRecord(request.body, 'cloud run estimate');
    return {
      statusCode: 200,
      body: await cloud.service.estimate(body as unknown as CloudRunRequestV1, accessToken),
    };
  }
  if (request.method === 'POST' && path === '/v1/cloud/runs/approve') {
    const body = bodyRecord(request.body, 'cloud run approval');
    return {
      statusCode: 200,
      body: await cloud.service.approve({
        accessToken,
        estimateId: pathId(requiredString(body, 'estimateId'), 'estimateId'),
        actionDigest: requiredString(body, 'actionDigest'),
      }),
    };
  }
  if (request.method === 'POST' && path === '/v1/cloud/runs/execute') {
    const body = bodyRecord(request.body, 'cloud run execution');
    return {
      statusCode: 200,
      body: await cloud.service.execute({
        accessToken,
        estimateId: pathId(requiredString(body, 'estimateId'), 'estimateId'),
        approvalId: pathId(requiredString(body, 'approvalId'), 'approvalId'),
      }),
    };
  }
  const eventsMatch = /^\/v1\/cloud\/runs\/([^/]+)\/events$/.exec(path);
  if (request.method === 'GET' && eventsMatch?.[1] !== undefined) {
    return {
      statusCode: 200,
      body: {
        events: await cloud.service.eventsForSession(
          accessToken,
          pathId(decodeURIComponent(eventsMatch[1]), 'runId'),
        ),
      },
    };
  }
  return undefined;
}

const MODEL_DATA_CLASSES = ['public', 'internal', 'confidential', 'restricted'] as const;

const PROVIDER_TYPES = [
  'openai',
  'anthropic',
  'openai-compatible',
  'spyderbyte-cloud',
  'customer-owned',
  'ollama',
  'llama.cpp',
  'mlx',
  'huggingface-local',
  'codex-cli',
  'claude-code-cli',
  'deterministic',
] as const;

const CONVERSATION_SOURCE_INTERFACES = [
  'tui',
  'cli',
  'acp',
  'jupyter',
  'web',
  'api',
  'automation',
  'system',
] as const;

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Material mutations are classified at the API boundary so new execution routes cannot silently
 * bypass the universal Run ledger. Conversation submission is excluded because
 * LocalProjectConversationService already creates the canonical Agent Run itself.
 */
export function isMaterialExecutionPath(method: string, path: string): boolean {
  if (!MUTATING_METHODS.has(method.toUpperCase())) return false;
  if (/^\/v1\/projects\/[^/]+\/conversation(?:\/messages)?$/.test(path)) return false;
  if (/^\/v1\/runs\/[^/]+\/(?:cancel|retry)$/.test(path)) return false;
  if (/^\/v1\/subscriptions(?:\/|$)/.test(path)) return false;
  if (/^\/v1\/(?:confirmations|oauth|license|updates)(?:\/|$)/.test(path)) return false;
  return true;
}

function providerType(value: unknown): (typeof PROVIDER_TYPES)[number] {
  if (!PROVIDER_TYPES.includes(value as (typeof PROVIDER_TYPES)[number])) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'providerType is invalid');
  }
  return value as (typeof PROVIDER_TYPES)[number];
}

function conversationSourceInterface(
  value: unknown,
): (typeof CONVERSATION_SOURCE_INTERFACES)[number] {
  if (
    !CONVERSATION_SOURCE_INTERFACES.includes(
      value as (typeof CONVERSATION_SOURCE_INTERFACES)[number],
    )
  ) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'sourceInterface is invalid');
  }
  return value as (typeof CONVERSATION_SOURCE_INTERFACES)[number];
}

function modelDataClass(value: unknown, label: string): (typeof MODEL_DATA_CLASSES)[number] {
  if (!MODEL_DATA_CLASSES.includes(value as (typeof MODEL_DATA_CLASSES)[number])) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${label} is invalid`);
  }
  return value as (typeof MODEL_DATA_CLASSES)[number];
}

function stringArray(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string' || entry.trim() === '')
  ) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${label} must be an array of strings`);
  }
  return value.map((entry) => String(entry).trim());
}

function routingPolicyFromRequest(value: unknown, current: ModelRoutingPolicy): ModelRoutingPolicy {
  if (value === undefined) return current;
  const record = bodyRecord(value, 'routing policy');
  const booleanField = (key: string, fallback: boolean): boolean => {
    const entry = record[key];
    if (entry === undefined) return fallback;
    if (typeof entry !== 'boolean') {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `routing policy.${key} must be a boolean`);
    }
    return entry;
  };
  const allowedDataClasses =
    record['allowedDataClasses'] === undefined
      ? [...current.allowedDataClasses]
      : stringArray(record['allowedDataClasses'], 'routing policy.allowedDataClasses').map(
          (entry) => modelDataClass(entry, 'routing policy.allowedDataClasses'),
        );
  const harnessValue = record['harnessPolicies'];
  let harnessPolicies = current.harnessPolicies;
  if (harnessValue !== undefined) {
    const harnessRecord = bodyRecord(harnessValue, 'routing policy.harnessPolicies');
    harnessPolicies = Object.fromEntries(
      Object.entries(harnessRecord).map(([harnessId, rawPolicy]) => {
        const policyRecord = bodyRecord(rawPolicy, `routing policy for ${harnessId}`);
        const previous = current.harnessPolicies[harnessId];
        const allowedProviders =
          policyRecord['allowedProviders'] === undefined
            ? previous?.allowedProviders
            : stringArray(policyRecord['allowedProviders'], `${harnessId}.allowedProviders`);
        const requiredCapabilities =
          policyRecord['requiredCapabilities'] === undefined
            ? previous?.requiredCapabilities
            : stringArray(
                policyRecord['requiredCapabilities'],
                `${harnessId}.requiredCapabilities`,
              );
        const dataClass =
          policyRecord['dataClass'] === undefined
            ? previous?.dataClass
            : modelDataClass(policyRecord['dataClass'], `${harnessId}.dataClass`);
        const policy: HarnessModelPolicy = {
          ...(allowedProviders === undefined ? {} : { allowedProviders }),
          ...(requiredCapabilities === undefined ? {} : { requiredCapabilities }),
          ...(dataClass === undefined ? {} : { dataClass }),
          allowExternalModels: booleanFieldFrom(
            policyRecord,
            'allowExternalModels',
            previous?.allowExternalModels ?? current.allowExternalModels,
            harnessId,
          ),
          allowProviderFallback: booleanFieldFrom(
            policyRecord,
            'allowProviderFallback',
            previous?.allowProviderFallback ?? current.allowProviderFallback,
            harnessId,
          ),
        };
        return [harnessId, policy];
      }),
    );
  }
  return {
    allowExternalModels: booleanField('allowExternalModels', current.allowExternalModels),
    allowProviderFallback: booleanField('allowProviderFallback', current.allowProviderFallback),
    allowedDataClasses,
    harnessPolicies,
  };
}

function booleanFieldFrom(
  record: Record<string, unknown>,
  key: string,
  fallback: boolean,
  label: string,
): boolean {
  const value = record[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw runtimeError(
      'VALIDATION_SCHEMA_MISMATCH',
      `routing policy.${label}.${key} must be a boolean`,
    );
  }
  return value;
}

function optionalReason(body: unknown, label: string): string | undefined {
  const record = bodyRecord(body, label);
  const unknownKeys = Object.keys(record).filter((key) => key !== 'reason');
  if (unknownKeys.length > 0) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${label} contains an unknown field`);
  }
  const reason = record['reason'];
  if (reason === undefined) return undefined;
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${label}.reason must be a non-empty string`);
  }
  return reason;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${key} is required`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${key} must be a non-empty string`);
  }
  return value;
}

function optionalJsonRecord(value: unknown, label: string): Record<string, JsonValue> | undefined {
  if (value === undefined) return undefined;
  if (!isJsonValue(value) || value === null || Array.isArray(value) || typeof value !== 'object') {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${label} must be a JSON object`);
  }
  return value as Record<string, JsonValue>;
}

function localServingRequest(
  record: Record<string, unknown>,
  requireModel = true,
): LocalServingRequestV1 {
  const modelId = requireModel
    ? requiredString(record, 'modelId')
    : optionalString(record, 'modelId');
  const port = record['port'];
  if (
    port !== undefined &&
    (!Number.isSafeInteger(port) || (port as number) < 1024 || (port as number) > 65535)
  ) {
    throw runtimeError(
      'VALIDATION_SCHEMA_MISMATCH',
      'port must be an integer between 1024 and 65535',
    );
  }
  const resources = optionalJsonRecord(record['resources'], 'resources');
  const scaling = optionalJsonRecord(record['scaling'], 'scaling');
  const healthCheck = optionalJsonRecord(record['healthCheck'], 'healthCheck');
  const rolloutPolicy = optionalJsonRecord(record['rolloutPolicy'], 'rolloutPolicy');
  const auth = optionalJsonRecord(record['auth'], 'auth');
  const environment = optionalJsonRecord(record['environment'], 'environment');
  const secretRefs = record['secretRefs'];
  if (
    secretRefs !== undefined &&
    (!Array.isArray(secretRefs) || !secretRefs.every((item) => typeof item === 'string'))
  ) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'secretRefs must be an array of references');
  }
  const input: LocalServingRequestV1 = {
    ...(modelId === undefined ? {} : { modelId }),
    ...(optionalString(record, 'deploymentId') === undefined
      ? {}
      : { deploymentId: optionalString(record, 'deploymentId') }),
    ...(optionalString(record, 'endpointId') === undefined
      ? {}
      : { endpointId: optionalString(record, 'endpointId') }),
    ...(optionalString(record, 'endpointName') === undefined
      ? {}
      : { endpointName: optionalString(record, 'endpointName') }),
    ...(optionalString(record, 'modelVersionId') === undefined
      ? {}
      : { modelVersionId: optionalString(record, 'modelVersionId') }),
    ...(optionalString(record, 'modelArtifactId') === undefined
      ? {}
      : { modelArtifactId: optionalString(record, 'modelArtifactId') }),
    ...(optionalString(record, 'servingRuntime') === undefined
      ? {}
      : { servingRuntime: optionalString(record, 'servingRuntime') }),
    ...(optionalString(record, 'region') === undefined
      ? {}
      : { region: optionalString(record, 'region') }),
    ...(resources === undefined
      ? {}
      : { resources: resources as unknown as LocalServingRequestV1['resources'] }),
    ...(scaling === undefined ? {} : { scaling: scaling as unknown as LocalServingScalingV1 }),
    ...(environment === undefined
      ? {}
      : {
          environment: Object.fromEntries(
            Object.entries(environment).map(([key, value]) => [key, String(value)]),
          ),
        }),
    ...(secretRefs === undefined ? {} : { secretRefs: secretRefs as string[] }),
    ...(record['networkVisibility'] === undefined
      ? {}
      : {
          networkVisibility: record[
            'networkVisibility'
          ] as LocalServingRequestV1['networkVisibility'],
        }),
    ...(auth === undefined ? {} : { auth: auth as unknown as LocalServingRequestV1['auth'] }),
    ...(healthCheck === undefined
      ? {}
      : { healthCheck: healthCheck as unknown as LocalServingRequestV1['healthCheck'] }),
    ...(rolloutPolicy === undefined
      ? {}
      : { rolloutPolicy: rolloutPolicy as unknown as LocalServingRequestV1['rolloutPolicy'] }),
    ...(port === undefined ? {} : { port: port as number }),
    ...(optionalString(record, 'healthUrl') === undefined
      ? {}
      : { healthUrl: optionalString(record, 'healthUrl') }),
    ...(optionalString(record, 'invokeUrl') === undefined
      ? {}
      : { invokeUrl: optionalString(record, 'invokeUrl') }),
    ...(record['approvalRequired'] === undefined
      ? {}
      : { approvalRequired: record['approvalRequired'] === true }),
  } as LocalServingRequestV1;
  return input;
}

function servingApproval(value: unknown): LocalServingApprovalV1 | undefined {
  if (value === undefined) return undefined;
  if (!isJsonValue(value) || value === null || Array.isArray(value) || typeof value !== 'object') {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'approval must be an object');
  }
  return value as unknown as LocalServingApprovalV1;
}

function optionalQuerySource(
  record: Record<string, unknown>,
  key: string,
):
  | {
      tableName?: string;
      columns?: string[];
      rows: Array<readonly JsonValue[]> | Array<Record<string, JsonValue>>;
    }
  | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  const sourceRecord = bodyRecord(value, key);
  const rowsValue = sourceRecord['rows'];
  if (!Array.isArray(rowsValue)) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${key}.rows must be an array`);
  }
  const rows = rowsValue as Array<readonly JsonValue[]> | Array<Record<string, JsonValue>>;
  if (rows.some((row) => !Array.isArray(row) && (row === null || typeof row !== 'object'))) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${key}.rows must contain arrays or objects`);
  }
  const columnsValue = sourceRecord['columns'];
  if (
    columnsValue !== undefined &&
    (!Array.isArray(columnsValue) || columnsValue.some((value) => typeof value !== 'string'))
  ) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${key}.columns must be an array of strings`);
  }
  return {
    rows,
    ...(typeof sourceRecord['tableName'] === 'string'
      ? { tableName: sourceRecord['tableName'] }
      : {}),
    ...(columnsValue === undefined ? {} : { columns: columnsValue as string[] }),
  };
}

function optionalQueryParameters(
  value: unknown,
  label: string,
): Record<string, JsonPrimitive> | undefined {
  if (value === undefined) return undefined;
  const record = bodyRecord(value, label);
  const parameters: Record<string, JsonPrimitive> = {};
  for (const [key, parameter] of Object.entries(record)) {
    if (
      parameter !== null &&
      typeof parameter !== 'string' &&
      typeof parameter !== 'number' &&
      typeof parameter !== 'boolean'
    ) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${label}.${key} must be primitive`);
    }
    parameters[key] = parameter as JsonPrimitive;
  }
  return parameters;
}

function requiredBase64(record: Record<string, unknown>, key: string): Uint8Array {
  const value = requiredString(record, key);
  try {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
      throw new Error('invalid base64');
    }
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length === 0) throw new Error('empty');
    return new Uint8Array(bytes);
  } catch {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${key} must be base64 audio data`);
  }
}

function requiredAbsolutePath(record: Record<string, unknown>, key: string): string {
  const value = requiredString(record, key);
  if (!isAbsolute(value)) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${key} must be an absolute path`);
  }
  return value;
}

function validatedRuntimeCommand(body: unknown): RuntimeCommand {
  const validation = validateContract('RuntimeCommand', body);
  if (!validation.valid || validation.value === undefined) {
    const details = validation.errors
      .map((error) => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`)
      .join('; ');
    throw runtimeError(
      'VALIDATION_SCHEMA_MISMATCH',
      `Command body failed RuntimeCommand validation${details ? `: ${details}` : ''}`,
    );
  }
  return validation.value;
}

function optionalNonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${key} must be a non-negative integer`);
  }
  return value as number;
}

function optionalId(record: Record<string, unknown>, key: string): Id | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${key} must be a UUIDv7 id`);
  }
  return pathId(value, key);
}

function optionalArtifactReferences(
  record: Record<string, unknown>,
  key: string,
): ArtifactReference[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${key} must be an array`);
  }
  const references: ArtifactReference[] = [];
  for (const entry of value) {
    const validation = validateContract('ArtifactReference', entry);
    if (!validation.valid || validation.value === undefined) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${key} contains an invalid artifact`);
    }
    references.push(validation.value);
  }
  return references;
}

function optionalHash(record: Record<string, unknown>, key: string): HashSha256 | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  const validation = validateContract('HashSha256', value);
  if (!validation.valid || validation.value === undefined) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${key} must be a SHA-256 hash`);
  }
  return validation.value;
}

function requiredArtifactReference(
  record: Record<string, unknown>,
  key: string,
): ArtifactReference {
  const validation = validateContract('ArtifactReference', record[key]);
  if (!validation.valid || validation.value === undefined) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${key} must be an ArtifactReference`);
  }
  return validation.value;
}

function requiredJsonObject(
  record: Record<string, unknown>,
  key: string,
): Record<string, JsonValue> {
  const value = record[key];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${key} must be a JSON object`);
  }
  if (Object.values(value).some((entry) => !isJsonValue(entry))) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${key} must contain JSON values`);
  }
  return value as Record<string, JsonValue>;
}

function optionalJsonObject(
  record: Record<string, unknown>,
  key: string,
): Record<string, JsonValue> | undefined {
  if (record[key] === undefined) return undefined;
  return requiredJsonObject(record, key);
}

function requiredPrimitive(value: unknown, label: string): JsonPrimitive {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value as JsonPrimitive;
  }
  throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${label} must be a JSON primitive`);
}

function requiredIntegerValue(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${label} must be an integer >= ${minimum}`);
  }
  return value as number;
}

function experimentMetricSpecs(record: Record<string, unknown>): ExperimentMetricSpecV1[] {
  const value = record['metrics'];
  if (!Array.isArray(value) || value.length === 0) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'metrics must be a non-empty array');
  }
  return value.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'metrics entries must be objects');
    }
    const item = entry as Record<string, unknown>;
    const name = requiredString(item, 'name');
    if (typeof item['higherIsBetter'] !== 'boolean') {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${name}.higherIsBetter must be boolean`);
    }
    return {
      name,
      higherIsBetter: item['higherIsBetter'],
      ...(typeof item['requiredMinimum'] === 'number'
        ? { requiredMinimum: item['requiredMinimum'] }
        : {}),
      ...(typeof item['maximumRegression'] === 'number'
        ? { maximumRegression: item['maximumRegression'] }
        : {}),
    };
  });
}

async function streamSubscriptions(
  request: IncomingMessage,
  response: ServerResponse,
  options: LocalApiOptions,
): Promise<void> {
  const session = authenticateRequest(
    {
      method: 'GET',
      path: request.url ?? '/v1/subscriptions/events',
      body: undefined,
      headers: requestHeaders(request),
    },
    options,
  );
  options = optionsForSession(options, session);
  const gateway = subscriptionGateway(options);
  if (gateway === undefined) {
    jsonResponse(response, 501, { error: 'subscription_backend_not_configured' });
    return;
  }
  const subscription = subscriptionRequestFromPath(request.url ?? '/', options.tenant);
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  request.once('close', abort);
  response.statusCode = 200;
  response.setHeader('content-type', 'text/event-stream; charset=utf-8');
  response.setHeader('cache-control', 'no-cache, no-transform');
  response.setHeader('connection', 'keep-alive');
  response.flushHeaders?.();
  response.write(': connected\n\n');
  try {
    for await (const page of gateway.subscribe(subscription, controller.signal)) {
      if (response.writableEnded) break;
      const frame = formatSubscriptionFrame(page);
      if (response.write(frame)) continue;
      await new Promise<void>((resolve) => response.once('drain', resolve));
    }
  } catch (error) {
    if (!controller.signal.aborted && !response.writableEnded) {
      response.write(`event: error\ndata: ${JSON.stringify(errorBody(error))}\n\n`);
    }
  } finally {
    request.off('close', abort);
    if (!response.writableEnded) response.end();
  }
}

export async function handleLocalApiRequest(
  request: LocalApiRequest,
  options: LocalApiOptions,
): Promise<LocalApiResponse> {
  const path = request.path.split('?')[0] ?? '/';
  const coordinator = universalRunCoordinator(options);
  if (coordinator === undefined || !isMaterialExecutionPath(request.method, path)) {
    return handleLocalApiRequestCore(request, options);
  }
  const session = authenticateRequest(request, options);
  const scopedOptions = optionsForSession(options, session);
  const actor =
    session?.actor ??
    scopedOptions.localSession?.actor ??
    ({ actorId: scopedOptions.tenant.tenantId, type: 'system', displayName: 'Local API' } as const);
  const sourceInterface = sourceInterfaceForRequest(request, path);
  const action = `${request.method.toUpperCase()} ${path}`.slice(0, 200);
  const idempotencyKey = headerValue(request, 'idempotency-key');
  const requestedProjectId = projectIdForRequest(request, path);
  const result = await coordinator.execute(
    {
      tenant: scopedOptions.tenant,
      actor,
      sourceInterface,
      action,
      replay: replayForRequest(request, sourceInterface),
      ...(requestedProjectId === undefined ? {} : { projectId: requestedProjectId }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      ...(scopedOptions.clock === undefined ? {} : { clock: scopedOptions.clock }),
    },
    async (): Promise<UniversalRunOperationResult> => handleLocalApiRequestCore(request, options),
  );
  return {
    statusCode: result.statusCode,
    body: result.body,
    ...(result.headers === undefined ? {} : { headers: result.headers }),
  };
}

async function handleLocalApiRequestCore(
  request: LocalApiRequest,
  options: LocalApiOptions,
): Promise<LocalApiResponse> {
  const method = request.method;
  const rawPath = request.path;
  const path = rawPath.split('?')[0] ?? '/';
  if (method === 'GET' && (path === '/health' || path === '/v1/health')) {
    return {
      statusCode: 200,
      body: {
        status: 'ok',
        service: 'agentic-local-daemon',
        tenant: options.tenant,
        license: options.license?.status().status ?? 'unconfigured',
      },
    };
  }
  if (method === 'GET' && path === '/v1/license/status') {
    return options.license === undefined
      ? { statusCode: 501, body: { error: 'license_checker_not_configured' } }
      : { statusCode: 200, body: options.license.status() };
  }
  if (method === 'GET' && path === '/v1/capabilities') {
    return {
      statusCode: 200,
      body: options.capabilities ?? defaultCapabilities(options),
    };
  }
  const session = authenticateRequest(request, options);
  options = optionsForSession(options, session);
  const limited = rateLimitResponse(options);
  if (limited !== undefined) return limited;
  const actor = session?.actor ?? options.localSession?.actor;
  const productionScaleResponse = await handleProductionScaleRequest(
    {
      method,
      path,
      body: request.body,
      tenant: options.tenant,
      ...(actor === undefined ? {} : { actor }),
      ...(options.workspaceContext?.mode === undefined
        ? {}
        : { workspaceMode: options.workspaceContext.mode }),
      now: options.clock?.() ?? new Date().toISOString(),
    },
    options.productionScale,
  );
  if (productionScaleResponse !== undefined) return productionScaleResponse;
  assertSharedWorkspaceAccess(request, path, options, actor);
  const enterpriseResponse = await handleEnterpriseRequest(
    {
      method,
      path,
      body: request.body,
      tenant: options.tenant,
      ...(actor === undefined ? {} : { actor }),
      now: options.clock?.() ?? new Date().toISOString(),
    },
    options.enterprise,
  );
  if (enterpriseResponse !== undefined) return enterpriseResponse;
  const cloudResponse = await handleCloudRunRequest(request, options);
  if (cloudResponse !== undefined) return cloudResponse;
  if (method === 'GET' && path === '/v1/session') {
    return session === undefined && options.localSession === undefined
      ? { statusCode: 501, body: { error: 'session_authenticator_not_configured' } }
      : { statusCode: 200, body: session ?? options.localSession };
  }
  if (method === 'GET' && path === '/v1/settings') {
    const query = new URL(rawPath, 'http://local').searchParams;
    const scope = settingsScope(query.get('scope'));
    const projectId = settingsProjectId(query.get('projectId') ?? undefined, scope);
    return {
      statusCode: 200,
      body: settingsEnvelope(options, scope, projectId),
    };
  }
  if (method === 'PUT' && path === '/v1/settings') {
    const record = bodyRecord(request.body, 'settings update');
    const scope = settingsScope(record['scope']);
    const projectId = settingsProjectId(record['projectId'], scope);
    const patch = bodyRecord(record['patch'], 'settings patch');
    if (Object.values(patch).some((value) => !isJsonValue(value))) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'settings patch must contain JSON values');
    }
    const expectedRevision = record['expectedRevision'];
    if (
      expectedRevision !== undefined &&
      (typeof expectedRevision !== 'number' ||
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 0)
    ) {
      throw runtimeError(
        'VALIDATION_SCHEMA_MISMATCH',
        'expectedRevision must be a non-negative integer',
      );
    }
    const updatedAt = record['updatedAt'];
    if (updatedAt !== undefined && typeof updatedAt !== 'string') {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'updatedAt must be an ISO timestamp');
    }
    const envelope = settingsStore(options).put({
      tenant: options.tenant,
      scope,
      ...(projectId === undefined ? {} : { projectId }),
      patch: patch as SettingsValues,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
      updatedAt: updatedAt ?? options.clock?.() ?? new Date().toISOString(),
    });
    return { statusCode: 200, body: envelope };
  }
  if (method === 'GET' && path === '/v1/profile') {
    const envelope = settingsEnvelope(options, 'user', undefined);
    return {
      statusCode: 200,
      body: {
        profile: profileRecord(options, session ?? options.localSession),
        revision: envelope.revision,
        updatedAt: envelope.updatedAt,
      },
    };
  }
  if (method === 'PUT' && path === '/v1/profile') {
    const record = bodyRecord(request.body, 'profile update');
    const current = profileRecord(options, session ?? options.localSession);
    const displayName = record['displayName'] ?? current['displayName'];
    if (
      typeof displayName !== 'string' ||
      displayName.trim().length === 0 ||
      displayName.length > 80
    ) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'displayName must contain 1–80 characters');
    }
    const avatarColor = record['avatarColor'] ?? current['avatarColor'];
    const initials = record['initials'] ?? current['initials'];
    const onboardingComplete =
      record['onboardingComplete'] ?? current['onboardingComplete'] ?? false;
    if (avatarColor !== undefined && typeof avatarColor !== 'string') {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'avatarColor must be a string');
    }
    if (initials !== undefined && (typeof initials !== 'string' || initials.length > 4)) {
      throw runtimeError(
        'VALIDATION_SCHEMA_MISMATCH',
        'initials must contain at most 4 characters',
      );
    }
    if (typeof onboardingComplete !== 'boolean') {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'onboardingComplete must be a boolean');
    }
    const profile: SettingsValues = {
      displayName: displayName.trim(),
      ...(avatarColor === undefined ? {} : { avatarColor }),
      ...(initials === undefined ? {} : { initials: initials.trim().toUpperCase() }),
      onboardingComplete,
    };
    const expectedRevision = record['expectedRevision'];
    if (
      expectedRevision !== undefined &&
      (typeof expectedRevision !== 'number' ||
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 0)
    ) {
      throw runtimeError(
        'VALIDATION_SCHEMA_MISMATCH',
        'expectedRevision must be a non-negative integer',
      );
    }
    const envelope = settingsStore(options).put({
      tenant: options.tenant,
      scope: 'user',
      patch: { profile },
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
      updatedAt: options.clock?.() ?? new Date().toISOString(),
    });
    return {
      statusCode: 200,
      body: { profile, revision: envelope.revision, updatedAt: envelope.updatedAt },
    };
  }
  if (method === 'POST' && path === '/v1/confirmations/challenge') {
    if (
      options.workspaceContext?.mode !== 'personal_local' ||
      options.confirmations === undefined
    ) {
      return { statusCode: 404, body: { error: 'local_confirmations_not_available' } };
    }
    const record = bodyRecord(request.body, 'local confirmation challenge');
    const action = record['action'];
    if (!isJsonValue(action)) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'confirmation action must be JSON');
    }
    return {
      statusCode: 201,
      body: options.confirmations.issue(action, options.clock?.() ?? new Date().toISOString()),
    };
  }
  const confirmationMatch = /^\/v1\/confirmations\/([^/]+)\/confirm$/.exec(path);
  if (method === 'POST' && confirmationMatch?.[1]) {
    if (
      options.workspaceContext?.mode !== 'personal_local' ||
      options.confirmations === undefined
    ) {
      return { statusCode: 404, body: { error: 'local_confirmations_not_available' } };
    }
    const record = bodyRecord(request.body, 'local confirmation');
    const action = record['action'];
    if (!isJsonValue(action)) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'confirmation action must be JSON');
    }
    return {
      statusCode: 200,
      body: options.confirmations.confirm(
        pathId(confirmationMatch[1], 'challengeId'),
        action,
        options.clock?.() ?? new Date().toISOString(),
      ),
    };
  }
  if (method === 'GET' && path === '/v1/diagnostics') {
    return { statusCode: 200, body: providerRuntimeDiagnostics(options) };
  }
  if (method === 'POST' && path === '/v1/diagnostics/support-bundle') {
    const governance = options.productionScale?.governance;
    const identity = options.productionScale?.identity;
    const secrets = options.productionScale?.secrets;
    const hostedExecution = options.productionScale?.hostedExecution;
    const recovery = options.productionScale?.recovery;
    return {
      statusCode: 200,
      body: sanitizeDiagnosticValue({
        schemaVersion: 1,
        bundleType: 'spyderbyte-support',
        generatedAt: options.clock?.() ?? new Date().toISOString(),
        tenant: options.tenant,
        workspaceContext: options.workspaceContext,
        diagnostics: providerRuntimeDiagnostics(options),
        governanceAudit: governance?.auditRecords(options.tenant),
        enterpriseIdentityAudit: identity?.auditRecords(options.tenant),
        enterpriseSecretAudit:
          secrets !== undefined &&
          'auditRecords' in secrets &&
          typeof secrets.auditRecords === 'function'
            ? secrets.auditRecords(options.tenant)
            : undefined,
        hostedExecutions: hostedExecution?.list(options.tenant),
        recoveryAudit:
          recovery?.auditRecords === undefined ? undefined : recovery.auditRecords(options.tenant),
      }),
    };
  }
  if (method === 'GET' && path === '/v1/onboarding') {
    const environment = await detectOnboardingContext(
      options.workspace?.rootPath,
      options.clock?.() ?? new Date().toISOString(),
    );
    const stored = settingsEnvelope(options, 'user', undefined).values['onboarding'];
    const onboarding =
      stored !== null && typeof stored === 'object' && !Array.isArray(stored)
        ? (stored as unknown as OnboardingState)
        : ({ schemaVersion: 1, status: 'not_started', environment } satisfies OnboardingState);
    const firstQuestionReady =
      options.providerRuntime?.catalog
        .list()
        .some((model) => model.local && model.state === 'ready') ?? false;
    return {
      statusCode: 200,
      body: {
        onboarding: { ...onboarding, environment },
        firstQuestionReady,
        authenticationRequiredForFirstQuestion: false,
        choices: [
          { id: 'local-model', label: 'Use a local model', requiresAuthentication: false },
          { id: 'provider-key', label: 'Use a provider key', requiresAuthentication: true },
          { id: 'spyderbyte-cloud', label: 'Use Spyderbyte Cloud', requiresAuthentication: true },
          { id: 'configure-later', label: 'Configure later', requiresAuthentication: false },
        ],
      },
    };
  }
  if (method === 'POST' && path === '/v1/onboarding') {
    const record = bodyRecord(request.body, 'onboarding');
    const choice = record['choice'];
    if (
      !['local-model', 'provider-key', 'spyderbyte-cloud', 'configure-later'].includes(
        String(choice),
      )
    ) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'choice is invalid');
    }
    const selectedChoice = choice as OnboardingChoice;
    const environment = await detectOnboardingContext(
      options.workspace?.rootPath,
      options.clock?.() ?? new Date().toISOString(),
    );
    let modelId = typeof record['modelId'] === 'string' ? record['modelId'] : undefined;
    let providerConfigurationId: Id | undefined;
    if (selectedChoice === 'local-model' && options.providerRuntime !== undefined) {
      if (modelId !== undefined) {
        const model = options.providerRuntime.providers
          .listModels()
          .find((candidate) => candidate.modelId === modelId);
        if (model === undefined || !model.local) {
          throw runtimeError(
            'VALIDATION_INVALID_INPUT',
            'modelId must identify an installed local model',
          );
        }
        options.providerRuntime.setProviderPriority([
          model.providerId,
          ...options.providerRuntime.providerPriority.filter(
            (providerId) => providerId !== model.providerId,
          ),
        ]);
      } else {
        modelId = options.providerRuntime.providers
          .listModels()
          .find((model) => model.local)?.modelId;
        options.providerRuntime.setProviderPriority(['huggingface-local', 'deterministic']);
      }
    }
    if (selectedChoice === 'provider-key') {
      if (options.providerRuntime === undefined) {
        return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
      }
      const providerValue = record['provider'];
      if (providerValue !== undefined) {
        const provider = bodyRecord(providerValue, 'onboarding provider');
        const providerConfiguration = await options.providerRuntime.providers.add({
          providerType: providerType(provider['providerType']),
          displayName: requiredString(provider, 'displayName'),
          ...(typeof provider['providerId'] === 'string'
            ? { providerId: provider['providerId'] }
            : {}),
          ...(typeof provider['endpoint'] === 'string' ? { endpoint: provider['endpoint'] } : {}),
          ...(typeof provider['defaultModelId'] === 'string'
            ? { defaultModelId: provider['defaultModelId'] }
            : {}),
          ...(Array.isArray(provider['modelIds'])
            ? { modelIds: provider['modelIds'] as string[] }
            : {}),
          ...(typeof provider['apiKey'] === 'string' ? { apiKey: provider['apiKey'] } : {}),
        });
        providerConfigurationId = providerConfiguration.providerConfigurationId;
        modelId ??= providerConfiguration.defaultModelId;
        options.providerRuntime.setProviderPriority([
          providerConfiguration.providerId,
          ...options.providerRuntime.providerPriority.filter(
            (providerId) => providerId !== providerConfiguration.providerId,
          ),
        ]);
      }
    }
    if (selectedChoice === 'spyderbyte-cloud' && options.providerRuntime !== undefined) {
      const existing = options.providerRuntime.providers.getByProviderId('spyderbyte-cloud');
      if (existing === undefined) {
        const cloud = await options.providerRuntime.providers.add({
          providerId: 'spyderbyte-cloud',
          providerType: 'spyderbyte-cloud',
          displayName: 'Spyderbyte Cloud',
          defaultModelId: modelId ?? 'managed-default',
          modelIds: [modelId ?? 'managed-default'],
        });
        providerConfigurationId = cloud.providerConfigurationId;
        modelId ??= cloud.defaultModelId;
      } else {
        providerConfigurationId = existing.providerConfigurationId;
        modelId ??= existing.defaultModelId;
      }
      options.providerRuntime.setProviderPriority([
        'spyderbyte-cloud',
        ...options.providerRuntime.providerPriority.filter(
          (providerId) => providerId !== 'spyderbyte-cloud',
        ),
      ]);
    }
    const onboarding: OnboardingState = {
      schemaVersion: 1,
      status: 'configured',
      choice: selectedChoice,
      ...(modelId === undefined ? {} : { modelId }),
      ...(providerConfigurationId === undefined ? {} : { providerConfigurationId }),
      environment,
      completedAt: options.clock?.() ?? new Date().toISOString(),
    };
    const current = settingsEnvelope(options, 'user', undefined);
    const profile = profileRecord(options, session ?? options.localSession);
    const envelope = settingsStore(options).put({
      tenant: options.tenant,
      scope: 'user',
      expectedRevision: current.revision,
      patch: {
        onboarding: onboarding as unknown as JsonValue,
        profile: { ...profile, onboardingComplete: true },
      },
      updatedAt: options.clock?.() ?? new Date().toISOString(),
    });
    const firstQuestionReady =
      options.providerRuntime?.catalog
        .list()
        .some((model) => model.local && model.state === 'ready') ?? false;
    return {
      statusCode: 200,
      body: {
        onboarding,
        firstQuestionReady,
        authenticationRequiredForFirstQuestion: false,
        revision: envelope.revision,
      },
    };
  }
  if (method === 'GET' && path === '/v1/providers') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    return {
      statusCode: 200,
      body: {
        providers: options.providerRuntime.providers.list(),
        credentials: options.providerRuntime.providers.listCredentials(),
        models: options.providerRuntime.providers.listModels(),
      },
    };
  }
  if (method === 'POST' && path === '/v1/providers') {
    assertLicensed(options);
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const record = bodyRecord(request.body, 'provider configuration');
    const modelIds = record['modelIds'];
    if (
      modelIds !== undefined &&
      (!Array.isArray(modelIds) || modelIds.some((value) => typeof value !== 'string'))
    ) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'modelIds must be an array of strings');
    }
    const providerId = typeof record['providerId'] === 'string' ? record['providerId'] : undefined;
    const endpoint = typeof record['endpoint'] === 'string' ? record['endpoint'] : undefined;
    const apiVersion = typeof record['apiVersion'] === 'string' ? record['apiVersion'] : undefined;
    const defaultModelId =
      typeof record['defaultModelId'] === 'string' ? record['defaultModelId'] : undefined;
    const apiKey =
      typeof record['apiKey'] === 'string'
        ? record['apiKey']
        : typeof record['secret'] === 'string'
          ? record['secret']
          : undefined;
    const timeoutMs = typeof record['timeoutMs'] === 'number' ? record['timeoutMs'] : undefined;
    const retryMaxAttempts =
      typeof record['retryMaxAttempts'] === 'number' ? record['retryMaxAttempts'] : undefined;
    const configuration = await options.providerRuntime.providers.add({
      ...(providerId === undefined ? {} : { providerId }),
      providerType: providerType(record['providerType']),
      displayName: requiredString(record, 'displayName'),
      ...(endpoint === undefined ? {} : { endpoint }),
      ...(apiVersion === undefined ? {} : { apiVersion }),
      ...(defaultModelId === undefined ? {} : { defaultModelId }),
      ...(modelIds === undefined ? {} : { modelIds: modelIds as string[] }),
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(retryMaxAttempts === undefined ? {} : { retryMaxAttempts }),
    });
    return { statusCode: 201, body: configuration };
  }
  const providerMatch = /^\/v1\/providers\/([^/]+)$/.exec(path);
  if (
    providerMatch?.[1] !== undefined &&
    (method === 'GET' || method === 'PATCH' || method === 'DELETE')
  ) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const providerConfigurationId = pathId(providerMatch[1], 'providerConfigurationId');
    if (method === 'GET') {
      const configuration = options.providerRuntime.providers.get(providerConfigurationId);
      if (configuration === undefined)
        return { statusCode: 404, body: { error: 'provider_not_found' } };
      return { statusCode: 200, body: configuration };
    }
    assertLicensed(options);
    if (method === 'DELETE') {
      await options.providerRuntime.providers.remove(providerConfigurationId);
      return { statusCode: 204, body: undefined };
    }
    const record = bodyRecord(request.body, 'provider configuration update');
    const modelIds = record['modelIds'];
    if (
      modelIds !== undefined &&
      (!Array.isArray(modelIds) || modelIds.some((value) => typeof value !== 'string'))
    ) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'modelIds must be an array of strings');
    }
    const displayName =
      typeof record['displayName'] === 'string' ? record['displayName'] : undefined;
    const endpoint = typeof record['endpoint'] === 'string' ? record['endpoint'] : undefined;
    const apiVersion = typeof record['apiVersion'] === 'string' ? record['apiVersion'] : undefined;
    const defaultModelId =
      typeof record['defaultModelId'] === 'string' ? record['defaultModelId'] : undefined;
    const enabled = typeof record['enabled'] === 'boolean' ? record['enabled'] : undefined;
    const timeoutMs = typeof record['timeoutMs'] === 'number' ? record['timeoutMs'] : undefined;
    const retryMaxAttempts =
      typeof record['retryMaxAttempts'] === 'number' ? record['retryMaxAttempts'] : undefined;
    return {
      statusCode: 200,
      body: await options.providerRuntime.providers.update(providerConfigurationId, {
        ...(displayName === undefined ? {} : { displayName }),
        ...(endpoint === undefined ? {} : { endpoint }),
        ...(apiVersion === undefined ? {} : { apiVersion }),
        ...(defaultModelId === undefined ? {} : { defaultModelId }),
        ...(enabled === undefined ? {} : { enabled }),
        ...(modelIds === undefined ? {} : { modelIds: modelIds as string[] }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(retryMaxAttempts === undefined ? {} : { retryMaxAttempts }),
      }),
    };
  }
  const providerActionMatch =
    /^\/v1\/providers\/([^/]+)\/(credentials|preflight|test|discover-models|health|usage)$/.exec(
      path,
    );
  if (providerActionMatch?.[1] !== undefined && providerActionMatch[2] !== undefined) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const providerConfigurationId = pathId(providerActionMatch[1], 'providerConfigurationId');
    const action = providerActionMatch[2];
    if (action === 'health' && method === 'GET') {
      return {
        statusCode: 200,
        body: options.providerRuntime.providers.health(providerConfigurationId),
      };
    }
    if (action === 'usage' && method === 'GET') {
      return {
        statusCode: 200,
        body: options.providerRuntime.providers.usage(providerConfigurationId),
      };
    }
    assertLicensed(options);
    if (action === 'credentials' && method === 'POST') {
      const record = bodyRecord(request.body, 'provider credential');
      const secret =
        typeof record['apiKey'] === 'string'
          ? record['apiKey']
          : typeof record['secret'] === 'string'
            ? record['secret']
            : undefined;
      if (secret === undefined)
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'apiKey is required');
      return {
        statusCode: 201,
        body: await options.providerRuntime.providers.setCredential(
          providerConfigurationId,
          secret,
        ),
      };
    }
    if (action === 'credentials' && method === 'DELETE') {
      await options.providerRuntime.providers.revokeCredential(providerConfigurationId);
      return { statusCode: 204, body: undefined };
    }
    if (action === 'test' && method === 'POST') {
      const record = bodyRecord(request.body, 'provider test');
      return {
        statusCode: 200,
        body: await options.providerRuntime.providers.test(
          providerConfigurationId,
          typeof record['modelId'] === 'string' ? record['modelId'] : undefined,
        ),
      };
    }
    if (action === 'preflight' && method === 'POST') {
      const record = bodyRecord(request.body, 'provider preflight');
      return {
        statusCode: 200,
        body: await options.providerRuntime.providers.preflight(
          providerConfigurationId,
          typeof record['modelId'] === 'string' ? record['modelId'] : undefined,
        ),
      };
    }
    if (action === 'discover-models' && method === 'POST') {
      return {
        statusCode: 200,
        body: {
          models: await options.providerRuntime.providers.discoverModels(providerConfigurationId),
        },
      };
    }
  }
  if (method === 'GET' && path === '/v1/models') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    await options.providerRuntime.providers.refresh();
    return { statusCode: 200, body: { models: options.providerRuntime.providers.listModels() } };
  }
  if (method === 'GET' && path === '/v1/models/catalog') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    await options.providerRuntime.providers.refresh();
    await options.providerRuntime.refreshLocalModels();
    await options.providerRuntime.catalog.refreshStatus();
    return {
      statusCode: 200,
      body: {
        models: options.providerRuntime.catalog.list(),
        runtimes: options.providerRuntime.runtimes.list(),
        installed: await options.providerRuntime.downloads.listInstalled(),
        downloads: options.providerRuntime.downloads.listJobs(),
        providerPriority: options.providerRuntime.providerPriority,
        routingPolicy: options.providerRuntime.routingPolicy,
      },
    };
  }
  const modelDetailMatch = /^\/v1\/models\/([^/]+)$/.exec(path);
  if (method === 'GET' && modelDetailMatch?.[1] !== undefined) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const modelId = decodeURIComponent(modelDetailMatch[1]);
    const model = options.providerRuntime.providers
      .listModels()
      .find((candidate) => candidate.modelId === modelId || candidate.providerModelId === modelId);
    return model === undefined
      ? { statusCode: 404, body: { error: 'model_not_found' } }
      : { statusCode: 200, body: model };
  }
  if (method === 'POST' && path === '/v1/models/refresh') {
    assertLicensed(options);
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    await options.providerRuntime.providers.refresh();
    await options.providerRuntime.refreshLocalModels();
    return { statusCode: 200, body: { models: options.providerRuntime.providers.listModels() } };
  }
  if (method === 'GET' && path === '/v1/model-routing') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    return {
      statusCode: 200,
      body: {
        providerPriority: options.providerRuntime.providerPriority,
        routingPolicy: options.providerRuntime.routingPolicy,
      },
    };
  }
  if (method === 'POST' && path === '/v1/model-routing') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const record = bodyRecord(request.body, 'model routing');
    const priority = record['providerPriority'];
    if (!Array.isArray(priority) || priority.some((value) => typeof value !== 'string')) {
      throw runtimeError(
        'VALIDATION_SCHEMA_MISMATCH',
        'providerPriority must be an array of provider ids',
      );
    }
    options.providerRuntime.setProviderPriority(priority as string[]);
    options.providerRuntime.setRoutingPolicy(
      routingPolicyFromRequest(record['routingPolicy'], options.providerRuntime.routingPolicy),
    );
    return {
      statusCode: 200,
      body: {
        providerPriority: options.providerRuntime.providerPriority,
        routingPolicy: options.providerRuntime.routingPolicy,
      },
    };
  }
  if (method === 'POST' && path === '/v1/model-selection') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const record = bodyRecord(request.body, 'model selection');
    const tier = record['tier'];
    const taskShape = record['taskShape'];
    const allowedModels = record['allowedModels'];
    if (!Number.isSafeInteger(tier) || ![0, 1, 2].includes(tier as number)) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'tier must be 0, 1, or 2');
    }
    if (typeof taskShape !== 'string' || taskShape.trim().length === 0) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'taskShape is required');
    }
    if (!Array.isArray(allowedModels) || allowedModels.some((value) => typeof value !== 'string')) {
      throw runtimeError(
        'VALIDATION_SCHEMA_MISMATCH',
        'allowedModels must be an array of model ids',
      );
    }
    const arrayField = (key: string): string[] | undefined => {
      const value = record[key];
      if (value === undefined) return undefined;
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${key} must be an array of strings`);
      }
      return value as string[];
    };
    const allowedProviders = arrayField('allowedProviders');
    const requiredCapabilities = arrayField('requiredCapabilities');
    const overrideValue = record['override'];
    let override: { providerId: string; modelId: string } | undefined;
    if (overrideValue !== undefined) {
      const overrideRecord = bodyRecord(overrideValue, 'model selection override');
      override = {
        providerId: requiredString(overrideRecord, 'providerId'),
        modelId: requiredString(overrideRecord, 'modelId'),
      };
    }
    const dataClass = record['dataClass'];
    if (
      dataClass !== undefined &&
      !['public', 'internal', 'confidential', 'restricted'].includes(String(dataClass))
    ) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'dataClass is invalid');
    }
    if (
      dataClass !== undefined &&
      !options.providerRuntime.routingPolicy.allowedDataClasses.includes(
        dataClass as (typeof MODEL_DATA_CLASSES)[number],
      )
    ) {
      const personalLocal = options.workspaceContext?.mode === 'personal_local';
      throw runtimeError(
        personalLocal ? 'CAPABILITY_UNAVAILABLE' : 'POLICY_DENIED',
        personalLocal
          ? `Local routing settings have disabled data class ${String(dataClass)}`
          : `The organization workspace policy does not allow data class ${String(dataClass)}`,
      );
    }
    await options.providerRuntime.refreshLocalModels();
    await options.providerRuntime.catalog.refreshStatus();
    const resolved = options.providerRuntime.router.resolveSelection({
      tier: tier as 0 | 1 | 2,
      taskShape,
      allowedModels: allowedModels as string[],
      providerPriority: arrayField('providerPriority') ?? options.providerRuntime.providerPriority,
      ...(allowedProviders === undefined ? {} : { allowedProviders }),
      ...(requiredCapabilities === undefined ? {} : { requiredCapabilities }),
      allowExternalModels:
        typeof record['allowExternalModels'] === 'boolean'
          ? record['allowExternalModels']
          : options.providerRuntime.routingPolicy.allowExternalModels,
      ...(dataClass === undefined
        ? {}
        : { dataClass: dataClass as 'public' | 'internal' | 'confidential' | 'restricted' }),
      ...(override === undefined ? {} : { override }),
      allowProviderFallback:
        typeof record['allowProviderFallback'] === 'boolean'
          ? record['allowProviderFallback']
          : options.providerRuntime.routingPolicy.allowProviderFallback,
    }).resolved;
    return {
      statusCode: 200,
      body: { selected: resolved.selected, fallback: resolved.fallback, reason: resolved.reason },
    };
  }
  if (method === 'GET' && path === '/v1/models/downloads') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    return { statusCode: 200, body: options.providerRuntime.downloads.listJobs() };
  }
  if (method === 'POST' && path === '/v1/models/downloads') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const record = bodyRecord(request.body, 'model download');
    return {
      statusCode: 202,
      body: await options.providerRuntime.downloads.start(
        requiredString(record, 'repoId'),
        typeof record['revision'] === 'string' && record['revision'].trim() !== ''
          ? record['revision']
          : 'main',
      ),
    };
  }
  if (method === 'POST' && path === '/v1/models/installed/remove') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const record = bodyRecord(request.body, 'model removal');
    const modelId = requiredString(record, 'modelId');
    const removed = await options.providerRuntime.downloads.removeById(modelId);
    if (!removed) return { statusCode: 404, body: { error: 'model_not_found' } };
    await options.providerRuntime.refreshLocalModels();
    return { statusCode: 200, body: { removed: true, modelId } };
  }
  const modelDownloadMatch = /^\/v1\/models\/downloads\/([^/]+)\/cancel$/.exec(path);
  if (method === 'POST' && modelDownloadMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const job = options.providerRuntime.downloads.cancel(modelDownloadMatch[1]);
    return job === undefined
      ? { statusCode: 404, body: { error: 'download_not_found' } }
      : { statusCode: 200, body: job };
  }
  if (method === 'POST' && path === '/v1/models/huggingface/search') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const record = bodyRecord(request.body, 'Hugging Face search');
    const limit = record['limit'];
    if (
      limit !== undefined &&
      (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100)
    ) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'limit must be an integer from 1 to 100');
    }
    return {
      statusCode: 200,
      body: await options.providerRuntime.hub.search(
        typeof record['query'] === 'string' ? record['query'] : '',
        limit as number | undefined,
      ),
    };
  }
  if (method === 'GET' && path === '/v1/models/huggingface/details') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const query = new URL(rawPath, 'http://local').searchParams;
    const repoId = query.get('repoId')?.trim();
    if (repoId === undefined || repoId.length === 0) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'repoId is required');
    }
    return {
      statusCode: 200,
      body: await options.providerRuntime.hub.details(repoId, query.get('revision') ?? 'main'),
    };
  }
  if (method === 'POST' && path === '/v1/models/huggingface/token') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const record = bodyRecord(request.body, 'Hugging Face token');
    const token = record['token'];
    if (typeof token !== 'string') {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'token must be a string');
    }
    await options.providerRuntime.setHuggingFaceToken(token);
    return { statusCode: 200, body: { configured: token.trim().length > 0 } };
  }
  if (method === 'GET' && path === '/v1/runtimes/discovery') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    return { statusCode: 200, body: await options.providerRuntime.runtimeProfiles.discover() };
  }
  if (method === 'GET' && path === '/v1/runtimes/compute-profiles') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    return {
      statusCode: 200,
      body: { profiles: options.providerRuntime.computeProfiles.list() },
    };
  }
  if (method === 'POST' && path === '/v1/runtimes/compute-profiles') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const record = bodyRecord(request.body, 'compute profile');
    const numeric = (key: string): number | undefined => {
      const value = record[key];
      if (value === undefined) return undefined;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${key} must be a non-negative number`);
      }
      return value;
    };
    const allowedTypes = [
      'local-host',
      'local-docker',
      'remote-ssh',
      'managed-worker',
      'customer-cloud',
    ];
    const runtimeType = requiredString(record, 'runtimeType');
    if (!allowedTypes.includes(runtimeType)) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'runtimeType is invalid');
    }
    const state = record['state'];
    if (
      state !== undefined &&
      !['configured', 'ready', 'degraded', 'unavailable', 'disabled'].includes(String(state))
    ) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'state is invalid');
    }
    const networkPolicy = record['networkPolicy'];
    if (
      networkPolicy !== undefined &&
      !['offline', 'allowlist', 'unrestricted'].includes(String(networkPolicy))
    ) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'networkPolicy is invalid');
    }
    const cpuMillicores = numeric('cpuMillicores');
    const memoryBytes = numeric('memoryBytes');
    const gpuCount = numeric('gpuCount');
    return {
      statusCode: 201,
      body: await options.providerRuntime.computeProfiles.create({
        ...(typeof record['runtimeProfileId'] === 'string'
          ? { runtimeProfileId: record['runtimeProfileId'] as Id }
          : {}),
        runtimeType: runtimeType as RuntimeProfile['runtimeType'],
        displayName: requiredString(record, 'displayName'),
        ...(state === undefined ? {} : { state: state as RuntimeProfile['state'] }),
        ...(typeof record['endpoint'] === 'string' ? { endpoint: record['endpoint'] } : {}),
        ...(cpuMillicores === undefined ? {} : { cpuMillicores }),
        ...(memoryBytes === undefined ? {} : { memoryBytes }),
        ...(typeof record['gpuType'] === 'string' ? { gpuType: record['gpuType'] } : {}),
        ...(gpuCount === undefined ? {} : { gpuCount }),
        ...(networkPolicy === undefined
          ? {}
          : { networkPolicy: networkPolicy as 'offline' | 'allowlist' | 'unrestricted' }),
      }),
    };
  }
  if (method === 'POST' && path === '/v1/runtimes/compute-selection') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const record = bodyRecord(request.body, 'compute selection');
    const arrayOfStrings = (key: string): string[] | undefined => {
      const value = record[key];
      if (value === undefined) return undefined;
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${key} must be an array of strings`);
      }
      return value as string[];
    };
    const requirementsValue = record['requirements'];
    let requirements:
      | {
          cpuMillicores?: number;
          memoryBytes?: number;
          gpuCount?: number;
          gpuType?: string;
          wallTimeMs?: number;
          storageBytes?: number;
        }
      | undefined;
    if (requirementsValue !== undefined) {
      const requirementsRecord = bodyRecord(requirementsValue, 'compute requirements');
      requirements = {
        ...(typeof requirementsRecord['cpuMillicores'] === 'number'
          ? { cpuMillicores: requirementsRecord['cpuMillicores'] }
          : {}),
        ...(typeof requirementsRecord['memoryBytes'] === 'number'
          ? { memoryBytes: requirementsRecord['memoryBytes'] }
          : {}),
        ...(typeof requirementsRecord['gpuCount'] === 'number'
          ? { gpuCount: requirementsRecord['gpuCount'] }
          : {}),
        ...(typeof requirementsRecord['gpuType'] === 'string'
          ? { gpuType: requirementsRecord['gpuType'] }
          : {}),
        ...(typeof requirementsRecord['wallTimeMs'] === 'number'
          ? { wallTimeMs: requirementsRecord['wallTimeMs'] }
          : {}),
        ...(typeof requirementsRecord['storageBytes'] === 'number'
          ? { storageBytes: requirementsRecord['storageBytes'] }
          : {}),
      };
    }
    const networkPolicy = record['networkPolicy'];
    if (
      networkPolicy !== undefined &&
      !['offline', 'allowlist', 'unrestricted'].includes(String(networkPolicy))
    ) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'networkPolicy is invalid');
    }
    return {
      statusCode: 200,
      body: options.providerRuntime.selectComputeProfile({
        ...(typeof record['explicitProfileId'] === 'string'
          ? { explicitProfileId: record['explicitProfileId'] as never }
          : {}),
        ...(arrayOfStrings('preferredProfileIds') === undefined
          ? {}
          : { preferredProfileIds: arrayOfStrings('preferredProfileIds') as Id[] }),
        ...(arrayOfStrings('allowedRuntimeTypes') === undefined
          ? {}
          : {
              allowedRuntimeTypes: arrayOfStrings(
                'allowedRuntimeTypes',
              ) as RuntimeProfile['runtimeType'][],
            }),
        ...(requirements === undefined ? {} : { requirements }),
        ...(networkPolicy === undefined
          ? {}
          : { networkPolicy: networkPolicy as 'offline' | 'allowlist' | 'unrestricted' }),
      }),
    };
  }
  if (method === 'GET' && path === '/v1/runtimes/profiles') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    return {
      statusCode: 200,
      body: {
        profiles: await options.providerRuntime.runtimeProfiles.listProfiles(),
        revisions: await options.providerRuntime.runtimeProfiles.listRevisions(),
      },
    };
  }
  if (method === 'POST' && path === '/v1/runtimes/profiles') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const record = bodyRecord(request.body, 'runtime profile');
    const environmentVariableNames = record['environmentVariableNames'];
    if (
      environmentVariableNames !== undefined &&
      (!Array.isArray(environmentVariableNames) ||
        environmentVariableNames.some((value) => typeof value !== 'string'))
    ) {
      throw runtimeError(
        'VALIDATION_SCHEMA_MISMATCH',
        'environmentVariableNames must be an array of strings',
      );
    }
    return {
      statusCode: 201,
      body: await options.providerRuntime.runtimeProfiles.createProfile({
        ...(typeof record['profileId'] === 'string' ? { profileId: record['profileId'] } : {}),
        name: requiredString(record, 'name'),
        kind: requiredString(record, 'kind') as 'python' | 'jupyter' | 'node' | 'shell',
        executable: requiredString(record, 'executable'),
        ...(typeof record['workingDirectory'] === 'string'
          ? { workingDirectory: record['workingDirectory'] }
          : {}),
        ...(environmentVariableNames === undefined ? {} : { environmentVariableNames }),
      }),
    };
  }
  const runtimeRevisionMatch = /^\/v1\/runtimes\/profiles\/([^/]+)\/revisions$/.exec(path);
  if (runtimeRevisionMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const profileId = decodeURIComponent(runtimeRevisionMatch[1]);
    if (method === 'GET') {
      return {
        statusCode: 200,
        body: await options.providerRuntime.runtimeProfiles.listRevisions(profileId),
      };
    }
    if (method === 'POST') {
      assertLicensed(options);
      const record = bodyRecord(request.body, 'environment revision');
      const packages = record['packages'];
      if (
        packages !== undefined &&
        (!Array.isArray(packages) || packages.some((value) => typeof value !== 'string'))
      ) {
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'packages must be an array of strings');
      }
      return {
        statusCode: 201,
        body: await options.providerRuntime.runtimeProfiles.createRevision({
          profileId,
          ...(typeof record['lockfile'] === 'string' ? { lockfile: record['lockfile'] } : {}),
          ...(packages === undefined ? {} : { packages }),
        }),
      };
    }
  }
  if (method === 'GET' && path === '/v1/jupyter/discovery') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    return { statusCode: 200, body: await options.providerRuntime.jupyter.discover() };
  }
  if (method === 'GET' && path === '/v1/jupyter/sessions') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const sessions = await options.providerRuntime.jupyter.list();
    return {
      statusCode: 200,
      body: sessions.filter((session) => sameTenant(session.tenant, options.tenant)),
    };
  }
  if (method === 'POST' && path === '/v1/jupyter/sessions') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const record = bodyRecord(request.body, 'Jupyter session');
    const port = record['port'];
    if (
      port !== undefined &&
      (!Number.isSafeInteger(port) || (port as number) < 0 || (port as number) > 65_535)
    ) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'port must be an integer from 0 to 65535');
    }
    const notebookId = typeof record['notebookId'] === 'string' ? record['notebookId'] : undefined;
    const profileId = typeof record['profileId'] === 'string' ? record['profileId'] : undefined;
    const runtimeProfileId =
      typeof record['runtimeProfileId'] === 'string' ? record['runtimeProfileId'] : undefined;
    const projectId = typeof record['projectId'] === 'string' ? record['projectId'] : undefined;
    const environmentRevisionId =
      typeof record['environmentRevisionId'] === 'string'
        ? record['environmentRevisionId']
        : undefined;
    const computeProfile =
      typeof record['computeProfile'] === 'string' ? record['computeProfile'] : undefined;
    const runtime = typeof record['runtime'] === 'string' ? record['runtime'] : undefined;
    const idleTimeoutMs = record['idleTimeoutMs'];
    if (
      idleTimeoutMs !== undefined &&
      (!Number.isSafeInteger(idleTimeoutMs) || (idleTimeoutMs as number) <= 0)
    ) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'idleTimeoutMs must be a positive integer');
    }
    const mode = record['mode'];
    if (mode !== undefined && mode !== 'local' && mode !== 'managed') {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'mode must be local or managed');
    }
    const associatedRunId =
      typeof record['associatedRunId'] === 'string' ? record['associatedRunId'] : undefined;
    const projectPath =
      typeof record['projectPath'] === 'string' ? record['projectPath'] : undefined;
    requireLocalConfirmation(
      options,
      {
        kind: 'jupyter.launch',
        ...(notebookId === undefined ? {} : { notebookId }),
        ...(profileId === undefined ? {} : { profileId }),
        ...(runtimeProfileId === undefined ? {} : { runtimeProfileId }),
        ...(projectId === undefined ? {} : { projectId }),
        ...(projectPath === undefined ? {} : { projectPath }),
        ...(port === undefined ? {} : { port: port as number }),
      },
      record['confirmationId'],
    );
    return {
      statusCode: 201,
      body: await options.providerRuntime.jupyter.launch({
        ...(notebookId === undefined ? {} : { notebookId }),
        tenant: options.tenant,
        ...(projectId === undefined ? {} : { projectId }),
        ...(options.localSession?.actor === undefined ? {} : { user: options.localSession.actor }),
        ...(profileId === undefined ? {} : { profileId }),
        ...(runtimeProfileId === undefined ? {} : { runtimeProfileId }),
        ...(environmentRevisionId === undefined ? {} : { environmentRevisionId }),
        ...(runtime === undefined ? {} : { runtime }),
        ...(computeProfile === undefined ? {} : { computeProfile }),
        ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs: idleTimeoutMs as number }),
        ...(mode === undefined ? {} : { mode }),
        ...(associatedRunId === undefined ? {} : { associatedRunId }),
        ...(projectPath === undefined ? {} : { projectPath }),
        ...(port === undefined ? {} : { port: port as number }),
      }),
    };
  }
  const jupyterSessionMatch = /^\/v1\/jupyter\/sessions\/([^/]+)$/.exec(path);
  if (method === 'GET' && jupyterSessionMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const session = await options.providerRuntime.jupyter.get(
      decodeURIComponent(jupyterSessionMatch[1]),
    );
    const scopedSession = sameTenant(session?.tenant, options.tenant) ? session : undefined;
    return {
      statusCode: scopedSession === undefined ? 404 : 200,
      body: scopedSession ?? { error: 'jupyter_session_not_found' },
    };
  }
  const jupyterSessionStopMatch = /^\/v1\/jupyter\/sessions\/([^/]+)\/stop$/.exec(path);
  if (method === 'POST' && jupyterSessionStopMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const sessionId = decodeURIComponent(jupyterSessionStopMatch[1]);
    const session = await options.providerRuntime.jupyter.get(sessionId);
    if (!sameTenant(session?.tenant, options.tenant))
      return { statusCode: 404, body: { error: 'jupyter_session_not_found' } };
    const record = bodyRecord(request.body ?? {}, 'Jupyter session stop');
    requireLocalConfirmation(
      options,
      { kind: 'jupyter.stop', sessionId },
      record['confirmationId'],
    );
    return {
      statusCode: 200,
      body: await options.providerRuntime.jupyter.stop(sessionId),
    };
  }
  const jupyterSessionActionMatch =
    /^\/v1\/jupyter\/sessions\/([^/]+)\/(interrupt|restart|reconnect)$/.exec(path);
  if (method === 'POST' && jupyterSessionActionMatch?.[1] && jupyterSessionActionMatch[2]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const sessionId = decodeURIComponent(jupyterSessionActionMatch[1]);
    const session = await options.providerRuntime.jupyter.get(sessionId);
    if (!sameTenant(session?.tenant, options.tenant))
      return { statusCode: 404, body: { error: 'jupyter_session_not_found' } };
    const action = jupyterSessionActionMatch[2];
    const record = bodyRecord(request.body ?? {}, 'Jupyter session action');
    requireLocalConfirmation(
      options,
      { kind: `jupyter.${action}`, sessionId },
      record['confirmationId'],
    );
    if (action === 'interrupt') {
      return { statusCode: 202, body: await options.providerRuntime.jupyter.interrupt(sessionId) };
    }
    if (action === 'restart') {
      return { statusCode: 200, body: await options.providerRuntime.jupyter.restart(sessionId) };
    }
    return { statusCode: 200, body: await options.providerRuntime.jupyter.reconnect(sessionId) };
  }
  if (method === 'GET' && path === '/v1/updates/status') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    return { statusCode: 200, body: options.providerRuntime.updates.status() };
  }
  if (method === 'POST' && path === '/v1/updates/check') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    return { statusCode: 200, body: await options.providerRuntime.updates.check() };
  }
  if (method === 'POST' && path === '/v1/updates/download') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    return { statusCode: 200, body: await options.providerRuntime.updates.download() };
  }
  if (method === 'POST' && path === '/v1/updates/install') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    return { statusCode: 202, body: await options.providerRuntime.updates.install() };
  }
  if (method === 'POST' && path === '/v1/updates/rollback') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    return { statusCode: 202, body: await options.providerRuntime.updates.rollback() };
  }
  if (method === 'GET' && path === '/v1/connections') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    for (const connection of options.providerRuntime.oauth
      .listConnections()
      .filter((item) => item.status === 'connected')) {
      options.providerRuntime.catalog.connect(connection.connectorId, connection.connectionId);
    }
    return {
      statusCode: 200,
      body: {
        connectors: options.providerRuntime.oauth.listConnectors(),
        connections: options.providerRuntime.oauth.listConnections(),
      },
    };
  }
  if (method === 'GET' && path === '/v1/provider-actions/catalog') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    return { statusCode: 200, body: options.providerRuntime.providerActions.list() };
  }
  if (method === 'POST' && path === '/v1/provider-actions/execute') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const record = bodyRecord(request.body, 'provider action');
    const input = record['input'];
    if (
      input !== undefined &&
      (input === null || typeof input !== 'object' || Array.isArray(input))
    ) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'provider action input must be an object');
    }
    const providerId = requiredString(record, 'providerId');
    if (!['github', 'google-drive', 'slack', 'youtube', 'frame-io'].includes(providerId)) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'providerId is invalid');
    }
    return {
      statusCode: 202,
      body: await options.providerRuntime.providerActions.execute({
        providerId: providerId as 'github' | 'google-drive' | 'slack' | 'youtube' | 'frame-io',
        connectionId: requiredString(record, 'connectionId'),
        operation: requiredString(record, 'operation'),
        ...(input === undefined ? {} : { input: input as Record<string, JsonValue> }),
      }),
    };
  }
  if (method === 'GET' && path === '/v1/local-bridges/catalog') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    return { statusCode: 200, body: options.providerRuntime.bridges.list() };
  }
  const localBridgeMatch = /^\/v1\/local-bridges\/([^/]+)\/execute$/.exec(path);
  if (method === 'POST' && localBridgeMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const record = bodyRecord(request.body, 'local bridge action');
    const input = record['input'];
    if (
      input !== undefined &&
      (input === null || typeof input !== 'object' || Array.isArray(input))
    ) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'local bridge input must be an object');
    }
    return {
      statusCode: 202,
      body: await options.providerRuntime.bridges.execute({
        bridgeId: decodeURIComponent(localBridgeMatch[1]) as
          | 'adobe-premiere'
          | 'blackmagic-resolve'
          | 'apple-final-cut'
          | 'local-media-bridge',
        operation: requiredString(record, 'operation'),
        ...(input === undefined ? {} : { input: input as Record<string, JsonValue> }),
      }),
    };
  }
  if (method === 'GET' && path === '/v1/notebooks') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    return { statusCode: 200, body: options.providerRuntime.notebooks.list() };
  }
  if (method === 'POST' && path === '/v1/notebooks') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const record = bodyRecord(request.body ?? {}, 'notebook');
    const notebookId =
      typeof record['notebookId'] === 'string' ? record['notebookId'] : newSortableId();
    const title = typeof record['title'] === 'string' ? record['title'] : undefined;
    const projectId = typeof record['projectId'] === 'string' ? record['projectId'] : undefined;
    const runtimeProfileId =
      typeof record['runtimeProfileId'] === 'string' ? record['runtimeProfileId'] : undefined;
    const environmentRevisionId =
      typeof record['environmentRevisionId'] === 'string'
        ? record['environmentRevisionId']
        : undefined;
    return {
      statusCode: 201,
      body: options.providerRuntime.notebooks.create({
        notebookId,
        ...(title === undefined ? {} : { title }),
        ...(projectId === undefined ? {} : { projectId }),
        ...(runtimeProfileId === undefined ? {} : { runtimeProfileId }),
        ...(environmentRevisionId === undefined ? {} : { environmentRevisionId }),
      }),
    };
  }
  if (method === 'GET' && path === '/v1/repositories/local') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    return {
      statusCode: 200,
      body: {
        repositories: await options.providerRuntime.repositories.list(),
        worktrees: await options.providerRuntime.repositories.listWorktrees(),
      },
    };
  }
  if (method === 'POST' && path === '/v1/repositories/local/register') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const record = bodyRecord(request.body, 'local repository registration');
    return {
      statusCode: 201,
      body: await options.providerRuntime.repositories.register({
        path: requiredString(record, 'path'),
        ...(typeof record['name'] === 'string' ? { name: record['name'] } : {}),
        ...(typeof record['remoteUrl'] === 'string' ? { remoteUrl: record['remoteUrl'] } : {}),
        ...(record['kind'] === 'git' || record['kind'] === 'directory'
          ? { kind: record['kind'] }
          : {}),
      }),
    };
  }
  if (method === 'GET' && path === '/v1/editors/resolve') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    return { statusCode: 200, body: await options.providerRuntime.repositories.resolveEditor() };
  }
  if (method === 'PUT' && path === '/v1/editors/settings') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const record = bodyRecord(request.body, 'editor settings');
    const value = record['value'];
    if (value !== undefined && typeof value !== 'string') {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'editor setting value must be a string');
    }
    return {
      statusCode: 200,
      body: await options.providerRuntime.repositories.setEditorSetting(
        value as string | undefined,
      ),
    };
  }
  const localChangeSetCreateMatch = /^\/v1\/repositories\/local\/([^/]+)\/change-sets$/.exec(path);
  if (method === 'POST' && localChangeSetCreateMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    return {
      statusCode: 201,
      body: await options.providerRuntime.repositories.createChangeSet(
        decodeURIComponent(localChangeSetCreateMatch[1]),
      ),
    };
  }
  const changeSetMatch = /^\/v1\/change-sets\/([^/]+)$/.exec(path);
  if (method === 'GET' && changeSetMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const changeSet = await options.providerRuntime.repositories.getChangeSet(
      decodeURIComponent(changeSetMatch[1]),
    );
    return {
      statusCode: changeSet === undefined ? 404 : 200,
      body: changeSet ?? { error: 'change_set_not_found' },
    };
  }
  const changeSetRefreshMatch = /^\/v1\/change-sets\/([^/]+)\/refresh$/.exec(path);
  if (method === 'POST' && changeSetRefreshMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    return {
      statusCode: 200,
      body: await options.providerRuntime.repositories.refreshChangeSet(
        decodeURIComponent(changeSetRefreshMatch[1]),
      ),
    };
  }
  const changeSetApplyMatch = /^\/v1\/change-sets\/([^/]+)\/hunks$/.exec(path);
  if (method === 'POST' && changeSetApplyMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const record = bodyRecord(request.body, 'change set hunk operation');
    const hunkIds = record['hunkIds'];
    if (!Array.isArray(hunkIds) || hunkIds.some((value) => typeof value !== 'string')) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'hunkIds must be an array of strings');
    }
    const action = record['action'];
    if (action !== 'accept' && action !== 'revert') {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'action must be accept or revert');
    }
    const changeSetId = decodeURIComponent(changeSetApplyMatch[1]);
    requireLocalConfirmation(
      options,
      { kind: `change-set.${action}`, changeSetId, hunkIds: [...hunkIds].sort() },
      record['confirmationId'],
    );
    return {
      statusCode: 200,
      body: await options.providerRuntime.repositories.applyChangeSetHunks({
        changeSetId,
        hunkIds,
        action,
      }),
    };
  }
  if (method === 'GET' && path === '/v1/pipelines/local') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    return {
      statusCode: 200,
      body: {
        pipelines: await options.providerRuntime.pipelines.list(),
        runs: await options.providerRuntime.pipelines.listRuns(),
      },
    };
  }
  const localPipelineMatch = /^\/v1\/pipelines\/local\/([^/]+)$/.exec(path);
  if (localPipelineMatch?.[1] && localPipelineMatch[1] !== 'source') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const pipelineId = decodeURIComponent(localPipelineMatch[1]);
    if (method === 'GET') {
      const definition = await options.providerRuntime.pipelines.get(pipelineId);
      return {
        statusCode: definition === undefined ? 404 : 200,
        body: definition ?? { error: 'pipeline_not_found' },
      };
    }
    if (method === 'POST') {
      assertLicensed(options);
      const record = bodyRecord(request.body, 'pipeline definition');
      const definition = record['definition'];
      if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'pipeline definition must be an object');
      }
      return {
        statusCode: 200,
        body: await options.providerRuntime.pipelines.upsert(definition as PipelineDefinitionV1),
      };
    }
  }
  if (method === 'POST' && path === '/v1/pipelines/local') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const record = bodyRecord(request.body, 'pipeline');
    return {
      statusCode: 201,
      body: await options.providerRuntime.pipelines.create(
        requiredString(record, 'pipelineId'),
        typeof record['name'] === 'string' ? record['name'] : undefined,
      ),
    };
  }
  if (method === 'POST' && path === '/v1/pipelines/local/source') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const record = bodyRecord(request.body, 'pipeline source');
    return {
      statusCode: 201,
      body: await options.providerRuntime.pipelines.loadFile(requiredString(record, 'path')),
    };
  }
  const localPipelineActionMatch =
    /^\/v1\/pipelines\/local\/([^/]+)\/(validate|plan|estimate|save|run|dry-run|publish|versions|runs)$/.exec(
      path,
    );
  if (localPipelineActionMatch?.[1] && localPipelineActionMatch[2]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const pipelineId = decodeURIComponent(localPipelineActionMatch[1]);
    const action = localPipelineActionMatch[2];
    if (action === 'validate' && method === 'POST') {
      const definition = await options.providerRuntime.pipelines.get(pipelineId);
      if (definition === undefined)
        return { statusCode: 404, body: { error: 'pipeline_not_found' } };
      return { statusCode: 200, body: options.providerRuntime.pipelines.validate(definition) };
    }
    if (action === 'plan' && method === 'GET') {
      return { statusCode: 200, body: await options.providerRuntime.pipelines.plan(pipelineId) };
    }
    if (action === 'estimate' && method === 'GET') {
      return {
        statusCode: 200,
        body: await options.providerRuntime.pipelines.estimate(pipelineId),
      };
    }
    if (action === 'versions' && method === 'GET') {
      return {
        statusCode: 200,
        body: await options.providerRuntime.pipelines.listVersions(pipelineId),
      };
    }
    if (action === 'publish' && method === 'POST') {
      assertLicensed(options);
      const record = request.body === undefined ? {} : bodyRecord(request.body, 'pipeline publish');
      const version = Number.isSafeInteger(record['version'])
        ? (record['version'] as number)
        : undefined;
      return {
        statusCode: 200,
        body: await options.providerRuntime.pipelines.publish(pipelineId, version),
      };
    }
    if (action === 'save' && method === 'POST') {
      assertLicensed(options);
      const record = bodyRecord(request.body, 'pipeline source');
      return {
        statusCode: 200,
        body: await options.providerRuntime.pipelines.saveFile(
          pipelineId,
          typeof record['path'] === 'string' ? record['path'] : undefined,
        ),
      };
    }
    if (action === 'run' && method === 'POST') {
      assertLicensed(options);
      const record = request.body === undefined ? {} : bodyRecord(request.body, 'pipeline run');
      const inputs = record['inputs'];
      if (
        inputs !== undefined &&
        (inputs === null || typeof inputs !== 'object' || Array.isArray(inputs))
      ) {
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'pipeline inputs must be an object');
      }
      return {
        statusCode: 202,
        body: await options.providerRuntime.pipelines.run(pipelineId, {
          ...(inputs === undefined ? {} : { inputs: inputs as Record<string, JsonValue> }),
          ...(typeof record['idempotencyKey'] === 'string'
            ? { idempotencyKey: record['idempotencyKey'] }
            : {}),
          ...(Number.isSafeInteger(record['version'])
            ? { version: record['version'] as number }
            : {}),
        }),
      };
    }
    if (action === 'dry-run' && method === 'POST') {
      assertLicensed(options);
      const record = request.body === undefined ? {} : bodyRecord(request.body, 'pipeline dry-run');
      return {
        statusCode: 200,
        body: await options.providerRuntime.pipelines.dryRun(pipelineId, {
          ...(typeof record['idempotencyKey'] === 'string'
            ? { idempotencyKey: record['idempotencyKey'] }
            : {}),
          ...(Number.isSafeInteger(record['version'])
            ? { version: record['version'] as number }
            : {}),
        }),
      };
    }
    if (action === 'runs' && method === 'GET') {
      return {
        statusCode: 200,
        body: await options.providerRuntime.pipelines.listRuns(pipelineId),
      };
    }
  }
  const localPipelineCancelMatch = /^\/v1\/pipelines\/local\/runs\/([^/]+)\/cancel$/.exec(path);
  if (method === 'POST' && localPipelineCancelMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    return {
      statusCode: 202,
      body: {
        runId: decodeURIComponent(localPipelineCancelMatch[1]),
        cancelled: options.providerRuntime.pipelines.cancel(
          decodeURIComponent(localPipelineCancelMatch[1]),
        ),
      },
    };
  }
  const localPipelineRunMatch = /^\/v1\/pipelines\/local\/runs\/([^/]+)$/.exec(path);
  if (method === 'GET' && localPipelineRunMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const run = await options.providerRuntime.pipelines.getRun(
      decodeURIComponent(localPipelineRunMatch[1]),
    );
    return {
      statusCode: run === undefined ? 404 : 200,
      body: run ?? { error: 'pipeline_run_not_found' },
    };
  }
  const localPipelineRetryMatch =
    /^\/v1\/pipelines\/local\/runs\/([^/]+)\/stages\/([^/]+)\/retry$/.exec(path);
  if (method === 'POST' && localPipelineRetryMatch?.[1] && localPipelineRetryMatch[2]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    return {
      statusCode: 202,
      body: await options.providerRuntime.pipelines.retryStage(
        decodeURIComponent(localPipelineRetryMatch[1]),
        decodeURIComponent(localPipelineRetryMatch[2]),
      ),
    };
  }
  if (method === 'GET' && path === '/v1/automations/local') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    return {
      statusCode: 200,
      body: {
        automations: await options.providerRuntime.automations.list(),
        runs: await options.providerRuntime.automations.listRuns(),
        notifications: await options.providerRuntime.automations.listNotifications(),
      },
    };
  }
  if (method === 'POST' && path === '/v1/automations/local') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const record = bodyRecord(request.body, 'automation');
    const trigger = bodyRecord(record['trigger'], 'automation trigger');
    const triggerType = trigger['type'];
    if (
      triggerType !== 'manual' &&
      triggerType !== 'interval' &&
      triggerType !== 'cron' &&
      triggerType !== 'webhook' &&
      triggerType !== 'event' &&
      triggerType !== 'data-arrival' &&
      triggerType !== 'repository'
    ) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'automation.trigger.type is invalid');
    }
    const intervalMs = trigger['intervalMs'];
    if (
      triggerType === 'interval' &&
      (!Number.isSafeInteger(intervalMs) || (intervalMs as number) < 1)
    ) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'automation.trigger.intervalMs is invalid');
    }
    if (
      triggerType === 'cron' &&
      (typeof trigger['expression'] !== 'string' || typeof trigger['timezone'] !== 'string')
    ) {
      throw runtimeError(
        'VALIDATION_SCHEMA_MISMATCH',
        'automation cron requires expression and timezone',
      );
    }
    const retryValue = record['retryPolicy'];
    let retryPolicy: AutomationRetryPolicyV1 | undefined;
    if (retryValue !== undefined) {
      const retry = bodyRecord(retryValue, 'automation retry policy');
      const maxAttempts = retry['maxAttempts'];
      const backoffMs = retry['backoffMs'];
      const maxBackoffMs = retry['maxBackoffMs'];
      if (
        !Number.isSafeInteger(maxAttempts) ||
        !Number.isSafeInteger(backoffMs) ||
        !Number.isSafeInteger(maxBackoffMs)
      ) {
        throw runtimeError(
          'VALIDATION_SCHEMA_MISMATCH',
          'automation retryPolicy fields must be integers',
        );
      }
      retryPolicy = {
        maxAttempts: maxAttempts as number,
        backoffMs: backoffMs as number,
        maxBackoffMs: maxBackoffMs as number,
      };
    }
    const notificationsValue = record['notifications'];
    let notifications: AutomationNotificationConfigV1[] | undefined;
    if (notificationsValue !== undefined) {
      if (!Array.isArray(notificationsValue)) {
        throw runtimeError(
          'VALIDATION_SCHEMA_MISMATCH',
          'automation notifications must be an array',
        );
      }
      notifications = notificationsValue.map((item) => {
        const notification = bodyRecord(item, 'automation notification');
        const event = notification['event'];
        if (event !== 'retrying' && event !== 'succeeded' && event !== 'failed') {
          throw runtimeError(
            'VALIDATION_SCHEMA_MISMATCH',
            'automation notification event is invalid',
          );
        }
        return {
          notificationId: requiredString(notification, 'notificationId'),
          event,
          targetRef: requiredString(notification, 'targetRef'),
        };
      });
    }
    return {
      statusCode: 201,
      body: await options.providerRuntime.automations.create({
        automationId: requiredString(record, 'automationId'),
        name: requiredString(record, 'name'),
        pipelineId: requiredString(record, 'pipelineId'),
        trigger:
          triggerType === 'manual'
            ? { type: 'manual' }
            : triggerType === 'interval'
              ? { type: 'interval', intervalMs: intervalMs as number }
              : triggerType === 'cron'
                ? {
                    type: 'cron',
                    expression: trigger['expression'] as string,
                    timezone: trigger['timezone'] as string,
                  }
                : triggerType === 'webhook'
                  ? { type: 'webhook', secretId: requiredString(trigger, 'secretId') }
                  : triggerType === 'event'
                    ? {
                        type: 'event',
                        topic: requiredString(trigger, 'topic'),
                        ...(typeof trigger['eventName'] === 'string'
                          ? { eventName: trigger['eventName'] }
                          : {}),
                      }
                    : triggerType === 'data-arrival'
                      ? {
                          type: 'data-arrival',
                          sourceRef: requiredString(trigger, 'sourceRef'),
                          ...(typeof trigger['eventName'] === 'string'
                            ? { eventName: trigger['eventName'] }
                            : {}),
                        }
                      : {
                          type: 'repository',
                          repositoryId: requiredString(trigger, 'repositoryId'),
                          ...(typeof trigger['eventName'] === 'string'
                            ? { eventName: trigger['eventName'] }
                            : {}),
                          ...(typeof trigger['branch'] === 'string'
                            ? { branch: trigger['branch'] }
                            : {}),
                        },
        ...(typeof record['timezone'] === 'string' ? { timezone: record['timezone'] } : {}),
        ...(Number.isSafeInteger(record['concurrencyLimit'])
          ? { concurrencyLimit: record['concurrencyLimit'] as number }
          : {}),
        ...(record['concurrencyPolicy'] === 'queue' || record['concurrencyPolicy'] === 'reject'
          ? { concurrencyPolicy: record['concurrencyPolicy'] }
          : {}),
        ...(Number.isSafeInteger(record['maxBackfillRuns'])
          ? { maxBackfillRuns: record['maxBackfillRuns'] as number }
          : {}),
        ...(retryPolicy === undefined ? {} : { retryPolicy }),
        ...(notifications === undefined ? {} : { notifications }),
      }),
    };
  }
  if (method === 'POST' && path === '/v1/automations/events') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const record = bodyRecord(request.body, 'automation event');
    return {
      statusCode: 202,
      body: await options.providerRuntime.automations.receiveEvent({
        topic: requiredString(record, 'topic'),
        ...(typeof record['eventName'] === 'string' ? { eventName: record['eventName'] } : {}),
        ...(record['payload'] !== undefined &&
        record['payload'] !== null &&
        typeof record['payload'] === 'object' &&
        !Array.isArray(record['payload'])
          ? { payload: record['payload'] as Record<string, JsonValue> }
          : {}),
      }),
    };
  }
  if (method === 'POST' && path === '/v1/automations/tick') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    await options.providerRuntime.automations.tick();
    return { statusCode: 202, body: { status: 'processed' } };
  }
  if (method === 'POST' && path === '/v1/automations/data-arrivals') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const record = bodyRecord(request.body, 'automation data arrival');
    const payload = record['payload'];
    return {
      statusCode: 202,
      body: await options.providerRuntime.automations.receiveDataArrival({
        sourceRef: requiredString(record, 'sourceRef'),
        ...(typeof record['eventName'] === 'string' ? { eventName: record['eventName'] } : {}),
        ...(payload !== undefined &&
        payload !== null &&
        typeof payload === 'object' &&
        !Array.isArray(payload)
          ? { payload: payload as Record<string, JsonValue> }
          : {}),
      }),
    };
  }
  if (method === 'POST' && path === '/v1/automations/repositories/events') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const record = bodyRecord(request.body, 'automation repository event');
    const payload = record['payload'];
    return {
      statusCode: 202,
      body: await options.providerRuntime.automations.receiveRepositoryEvent({
        repositoryId: requiredString(record, 'repositoryId'),
        ...(typeof record['eventName'] === 'string' ? { eventName: record['eventName'] } : {}),
        ...(typeof record['branch'] === 'string' ? { branch: record['branch'] } : {}),
        ...(payload !== undefined &&
        payload !== null &&
        typeof payload === 'object' &&
        !Array.isArray(payload)
          ? { payload: payload as Record<string, JsonValue> }
          : {}),
      }),
    };
  }
  const localAutomationMatch =
    /^\/v1\/automations\/local\/([^/]+)\/(pause|resume|trigger|runs|notifications|webhook|backfill)$/.exec(
      path,
    );
  if (localAutomationMatch?.[1] && localAutomationMatch[2]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const automationId = decodeURIComponent(localAutomationMatch[1]);
    const action = localAutomationMatch[2];
    if (action === 'runs' && method === 'GET') {
      return {
        statusCode: 200,
        body: await options.providerRuntime.automations.listRuns(automationId),
      };
    }
    if (action === 'notifications' && method === 'GET') {
      return {
        statusCode: 200,
        body: await options.providerRuntime.automations.listNotifications(automationId),
      };
    }
    if (method === 'POST' && (action === 'pause' || action === 'resume')) {
      assertLicensed(options);
      return {
        statusCode: 200,
        body:
          action === 'pause'
            ? await options.providerRuntime.automations.pause(automationId)
            : await options.providerRuntime.automations.resume(automationId),
      };
    }
    if (method === 'POST' && action === 'trigger') {
      assertLicensed(options);
      const record =
        request.body === undefined ? {} : bodyRecord(request.body, 'automation trigger');
      return {
        statusCode: 202,
        body: await options.providerRuntime.automations.trigger(automationId, {
          ...(typeof record['idempotencyKey'] === 'string'
            ? { idempotencyKey: record['idempotencyKey'] }
            : {}),
          ...(record['inputs'] !== undefined &&
          record['inputs'] !== null &&
          typeof record['inputs'] === 'object' &&
          !Array.isArray(record['inputs'])
            ? { inputs: record['inputs'] as Record<string, JsonValue> }
            : {}),
        }),
      };
    }
    if (method === 'POST' && action === 'webhook') {
      assertLicensed(options);
      const record = bodyRecord(request.body, 'automation webhook');
      const payload = record['payload'];
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'webhook payload must be an object');
      }
      return {
        statusCode: 202,
        body: await options.providerRuntime.automations.receiveWebhook(automationId, {
          payload: payload as Record<string, unknown>,
          ...(typeof record['signature'] === 'string' ? { signature: record['signature'] } : {}),
        }),
      };
    }
    if (method === 'POST' && action === 'backfill') {
      assertLicensed(options);
      const record = bodyRecord(request.body, 'automation backfill');
      const count = record['count'];
      if (!Number.isSafeInteger(count)) {
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'backfill count must be an integer');
      }
      return {
        statusCode: 202,
        body: await options.providerRuntime.automations.backfill(automationId, {
          count: count as number,
        }),
      };
    }
  }
  const localAutomationDetailMatch = /^\/v1\/automations\/local\/([^/]+)$/.exec(path);
  if (method === 'GET' && localAutomationDetailMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const automation = await options.providerRuntime.automations.get(
      decodeURIComponent(localAutomationDetailMatch[1]),
    );
    return {
      statusCode: automation === undefined ? 404 : 200,
      body: automation ?? { error: 'automation_not_found' },
    };
  }
  if (method === 'GET' && path === '/v1/experiments/local') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    return {
      statusCode: 200,
      body: {
        available: options.providerRuntime.experiments.available,
        experiments: await options.providerRuntime.experiments.list(options.tenant),
      },
    };
  }
  if (method === 'POST' && path === '/v1/experiments/local') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const record = bodyRecord(request.body, 'experiment');
    const computeRecord = bodyRecord(record['compute'], 'experiment compute');
    const features = record['features'];
    if (
      !Array.isArray(features) ||
      features.length === 0 ||
      features.some((item) => typeof item !== 'string')
    ) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'features must be a non-empty string array');
    }
    const task = requiredString(record, 'task');
    if (!['classification', 'regression', 'generation', 'custom'].includes(task)) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'task is invalid');
    }
    const input: LocalExperimentDefinitionInputV1 = {
      tenant: options.tenant,
      ...(typeof record['experimentId'] === 'string'
        ? { experimentId: pathId(record['experimentId'], 'experimentId') }
        : {}),
      name: requiredString(record, 'name'),
      datasetVersion: requiredArtifactReference(record, 'datasetVersion'),
      target: requiredString(record, 'target'),
      features: features as string[],
      task: task as LocalExperimentDefinitionInputV1['task'],
      algorithm: requiredString(record, 'algorithm'),
      ...(typeof record['baseModel'] === 'string' ? { baseModel: record['baseModel'] } : {}),
      environmentRevision: requiredArtifactReference(record, 'environmentRevision'),
      compute: {
        ...(typeof computeRecord['runtimeProfileId'] === 'string'
          ? { runtimeProfileId: pathId(computeRecord['runtimeProfileId'], 'runtimeProfileId') }
          : {}),
        cpuMillicores: requiredIntegerValue(
          computeRecord['cpuMillicores'],
          'compute.cpuMillicores',
          1,
        ),
        memoryBytes: requiredIntegerValue(computeRecord['memoryBytes'], 'compute.memoryBytes', 1),
        gpuCount: requiredIntegerValue(computeRecord['gpuCount'] ?? 0, 'compute.gpuCount'),
        maxDurationMs: requiredIntegerValue(
          computeRecord['maxDurationMs'],
          'compute.maxDurationMs',
          1,
        ),
        ...(typeof computeRecord['gpuType'] === 'string'
          ? { gpuType: computeRecord['gpuType'] }
          : {}),
        ...(typeof computeRecord['estimatedCostMinor'] === 'number'
          ? {
              estimatedCostMinor: requiredIntegerValue(
                computeRecord['estimatedCostMinor'],
                'compute.estimatedCostMinor',
              ),
            }
          : {}),
        currency: requiredString(computeRecord, 'currency'),
      } satisfies ExperimentComputeSpecV1,
      metrics: experimentMetricSpecs(record),
      hyperparameters: optionalJsonObject(record, 'hyperparameters') ?? {},
      seed: requiredIntegerValue(record['seed'], 'seed'),
      outputDestination: requiredString(record, 'outputDestination'),
      ...(typeof record['environmentLockfile'] === 'string'
        ? { environmentLockfile: record['environmentLockfile'] }
        : {}),
    };
    return { statusCode: 201, body: await options.providerRuntime.experiments.create(input) };
  }
  const experimentValidateMatch = /^\/v1\/experiments\/local\/([^/]+)\/validate$/.exec(path);
  if (method === 'POST' && experimentValidateMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    return {
      statusCode: 200,
      body: await options.providerRuntime.experiments.validate(
        options.tenant,
        pathId(decodeURIComponent(experimentValidateMatch[1]), 'experimentId'),
      ),
    };
  }
  const experimentArchiveMatch = /^\/v1\/experiments\/local\/([^/]+)\/archive$/.exec(path);
  if (method === 'POST' && experimentArchiveMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    return {
      statusCode: 200,
      body: await options.providerRuntime.experiments.archive(
        options.tenant,
        pathId(decodeURIComponent(experimentArchiveMatch[1]), 'experimentId'),
      ),
    };
  }
  const experimentComparePath = '/v1/experiments/local/compare';
  if (method === 'POST' && path === experimentComparePath) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const record = bodyRecord(request.body, 'experiment comparison');
    const runIds = record['runIds'];
    if (
      !Array.isArray(runIds) ||
      runIds.length < 2 ||
      runIds.some((item) => typeof item !== 'string')
    ) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'runIds must contain at least two IDs');
    }
    return {
      statusCode: 201,
      body: await options.providerRuntime.experiments.compare(options.tenant, {
        runIds: runIds.map((item) => pathId(item as string, 'runId')),
      }),
    };
  }
  if (method === 'GET' && path === '/v1/experiment-comparisons/local') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    return {
      statusCode: 200,
      body: await options.providerRuntime.experiments.listComparisons(options.tenant),
    };
  }
  const experimentComparisonMatch = /^\/v1\/experiment-comparisons\/local\/([^/]+)$/.exec(path);
  if (method === 'GET' && experimentComparisonMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const comparison = await options.providerRuntime.experiments.getComparison(
      options.tenant,
      pathId(decodeURIComponent(experimentComparisonMatch[1]), 'comparisonId'),
    );
    return {
      statusCode: comparison === undefined ? 404 : 200,
      body: comparison ?? { error: 'comparison_not_found' },
    };
  }
  const experimentRunListPath = '/v1/experiment-runs/local';
  if (method === 'GET' && path === experimentRunListPath) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const experimentId = new URL(rawPath, 'http://local').searchParams.get('experimentId');
    return {
      statusCode: 200,
      body: await options.providerRuntime.experiments.listRuns(
        options.tenant,
        experimentId === null ? undefined : pathId(experimentId, 'experimentId'),
      ),
    };
  }
  const experimentRunStartMatch = /^\/v1\/experiments\/local\/([^/]+)\/runs$/.exec(path);
  if (method === 'POST' && experimentRunStartMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const experimentId = pathId(decodeURIComponent(experimentRunStartMatch[1]), 'experimentId');
    const record = bodyRecord(request.body, 'experiment run');
    const variantId = requiredString(record, 'variantId');
    requireLocalConfirmation(
      options,
      { kind: 'experiment.start', experimentId, variantId },
      record['confirmationId'],
    );
    const hyperparameters = optionalJsonObject(record, 'hyperparameters');
    const configuration = optionalJsonObject(record, 'configuration');
    const input: ExperimentRunStartInputV1 & { readonly tenant: TenantRef } = {
      tenant: options.tenant,
      experimentId,
      variantId,
      ...(typeof record['variantLabel'] === 'string'
        ? { variantLabel: record['variantLabel'] }
        : {}),
      ...(hyperparameters === undefined ? {} : { hyperparameters }),
      ...(configuration === undefined ? {} : { configuration }),
    };
    return { statusCode: 202, body: await options.providerRuntime.experiments.start(input) };
  }
  const experimentDetailMatch = /^\/v1\/experiments\/local\/([^/]+)$/.exec(path);
  if (method === 'GET' && experimentDetailMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const experiment = await options.providerRuntime.experiments.get(
      options.tenant,
      pathId(decodeURIComponent(experimentDetailMatch[1]), 'experimentId'),
    );
    return {
      statusCode: experiment === undefined ? 404 : 200,
      body: experiment ?? { error: 'experiment_not_found' },
    };
  }
  const experimentRunEventsMatch = /^\/v1\/experiment-runs\/local\/([^/]+)\/events$/.exec(path);
  if (method === 'GET' && experimentRunEventsMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const query = new URL(rawPath, 'http://local').searchParams;
    const afterSequence = query.get('afterSequence');
    return {
      statusCode: 200,
      body: await options.providerRuntime.experiments.listEvents(
        options.tenant,
        pathId(decodeURIComponent(experimentRunEventsMatch[1]), 'runId'),
        afterSequence === null ? 0 : requiredIntegerValue(Number(afterSequence), 'afterSequence'),
      ),
    };
  }
  const experimentRunCancelMatch = /^\/v1\/experiment-runs\/local\/([^/]+)\/cancel$/.exec(path);
  if (method === 'POST' && experimentRunCancelMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const runId = pathId(decodeURIComponent(experimentRunCancelMatch[1]), 'runId');
    const record = bodyRecord(request.body ?? {}, 'experiment cancellation');
    requireLocalConfirmation(
      options,
      { kind: 'experiment.cancel', runId },
      record['confirmationId'],
    );
    return {
      statusCode: 202,
      body: await options.providerRuntime.experiments.cancel(options.tenant, runId),
    };
  }
  const experimentRunRetryMatch = /^\/v1\/experiment-runs\/local\/([^/]+)\/retry$/.exec(path);
  if (method === 'POST' && experimentRunRetryMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const runId = pathId(decodeURIComponent(experimentRunRetryMatch[1]), 'runId');
    const record = bodyRecord(request.body ?? {}, 'experiment retry');
    requireLocalConfirmation(
      options,
      { kind: 'experiment.retry', runId },
      record['confirmationId'],
    );
    return {
      statusCode: 202,
      body: await options.providerRuntime.experiments.retry(options.tenant, runId),
    };
  }
  const experimentRunDetailMatch = /^\/v1\/experiment-runs\/local\/([^/]+)$/.exec(path);
  if (method === 'GET' && experimentRunDetailMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const run = await options.providerRuntime.experiments.getRun(
      options.tenant,
      pathId(decodeURIComponent(experimentRunDetailMatch[1]), 'runId'),
    );
    return {
      statusCode: run === undefined ? 404 : 200,
      body: run ?? { error: 'experiment_run_not_found' },
    };
  }
  if (method === 'POST' && path === '/v1/experiment-evaluations/local') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const record = bodyRecord(request.body, 'experiment evaluation');
    const observationsValue = record['observations'];
    if (!Array.isArray(observationsValue) || observationsValue.length === 0) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'observations must be a non-empty array');
    }
    const observations: ExperimentEvaluationObservationV1[] = observationsValue.map((entry) => {
      const item = bodyRecord(entry, 'evaluation observation');
      return {
        expected: requiredPrimitive(item['expected'], 'observation.expected'),
        candidate: requiredPrimitive(item['candidate'], 'observation.candidate'),
        ...(item['baseline'] === undefined
          ? {}
          : { baseline: requiredPrimitive(item['baseline'], 'observation.baseline') }),
      };
    });
    const input: ExperimentEvaluationRequestV1 = {
      runId: pathId(requiredString(record, 'runId'), 'runId'),
      benchmarkId: requiredString(record, 'benchmarkId'),
      benchmarkVersion: requiredIntegerValue(record['benchmarkVersion'], 'benchmarkVersion', 1),
      observations,
      ...(record['metrics'] === undefined ? {} : { metrics: experimentMetricSpecs(record) }),
      ...(typeof record['baselineRunId'] === 'string'
        ? { baselineRunId: pathId(record['baselineRunId'], 'baselineRunId') }
        : {}),
      ...(record['minimumSampleSize'] === undefined
        ? {}
        : {
            minimumSampleSize: requiredIntegerValue(
              record['minimumSampleSize'],
              'minimumSampleSize',
              1,
            ),
          }),
      ...(Array.isArray(record['limitations'])
        ? {
            limitations: record['limitations'].filter(
              (item): item is string => typeof item === 'string',
            ),
          }
        : {}),
    };
    return {
      statusCode: 201,
      body: await options.providerRuntime.experiments.evaluate(options.tenant, input),
    };
  }
  if (method === 'GET' && path === '/v1/experiment-evaluations/local') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    return {
      statusCode: 200,
      body: await options.providerRuntime.experiments.listEvaluations(options.tenant),
    };
  }
  const experimentEvaluationDetailMatch = /^\/v1\/experiment-evaluations\/local\/([^/]+)$/.exec(
    path,
  );
  if (method === 'GET' && experimentEvaluationDetailMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const evaluation = await options.providerRuntime.experiments.getEvaluation(
      options.tenant,
      pathId(decodeURIComponent(experimentEvaluationDetailMatch[1]), 'evaluationId'),
    );
    return {
      statusCode: evaluation === undefined ? 404 : 200,
      body: evaluation ?? { error: 'evaluation_not_found' },
    };
  }
  if (method === 'POST' && path === '/v1/models/local/candidates') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const record = bodyRecord(request.body, 'model candidate');
    const card = bodyRecord(record['modelCard'], 'model card');
    const modelCard: ModelCardV1 = {
      summary: requiredString(card, 'summary'),
      intendedUse: requiredString(card, 'intendedUse'),
      limitations: Array.isArray(card['limitations'])
        ? card['limitations'].filter((item): item is string => typeof item === 'string')
        : [],
      risks: Array.isArray(card['risks'])
        ? card['risks'].filter((item): item is string => typeof item === 'string')
        : [],
      ...(typeof card['owner'] === 'string' ? { owner: card['owner'] } : {}),
    };
    const input: ModelCandidateInputV1 = {
      runId: pathId(requiredString(record, 'runId'), 'runId'),
      modelName: requiredString(record, 'modelName'),
      modelCard,
    };
    requireLocalConfirmation(
      options,
      { kind: 'model.candidate.register', runId: input.runId, modelName: input.modelName },
      record['confirmationId'],
    );
    return {
      statusCode: 201,
      body: await options.providerRuntime.experiments.registerCandidate(options.tenant, input),
    };
  }
  if (method === 'GET' && path === '/v1/models/local/registry') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const modelName = new URL(rawPath, 'http://local').searchParams.get('modelName') ?? undefined;
    return {
      statusCode: 200,
      body: await options.providerRuntime.experiments.listModels(options.tenant, modelName),
    };
  }
  const modelValidateMatch = /^\/v1\/models\/local\/([^/]+)\/validate$/.exec(path);
  if (method === 'POST' && modelValidateMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const record = bodyRecord(request.body, 'model validation');
    const input: ModelValidationInputV1 = {
      modelVersionId: pathId(decodeURIComponent(modelValidateMatch[1]), 'modelVersionId'),
      evaluationId: pathId(requiredString(record, 'evaluationId'), 'evaluationId'),
    };
    return {
      statusCode: 200,
      body: await options.providerRuntime.experiments.validateModel(options.tenant, input),
    };
  }
  const modelPromoteMatch = /^\/v1\/models\/local\/([^/]+)\/promote$/.exec(path);
  if (method === 'POST' && modelPromoteMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const record = bodyRecord(request.body, 'model promotion');
    const modelVersionId = pathId(decodeURIComponent(modelPromoteMatch[1]), 'modelVersionId');
    const input: ModelPromotionInputV1 = {
      modelVersionId,
      policyApproved: record['policyApproved'] === true,
      approvalDigest: requiredString(record, 'approvalDigest'),
      commitApprovalDigest: requiredString(record, 'commitApprovalDigest'),
      ...(typeof record['reason'] === 'string' ? { reason: record['reason'] } : {}),
    };
    requireLocalConfirmation(
      options,
      { kind: 'model.promote', modelVersionId, approvalDigest: input.approvalDigest },
      record['confirmationId'],
    );
    return {
      statusCode: 200,
      body: await options.providerRuntime.experiments.promoteModel(options.tenant, input),
    };
  }
  const localRegistryModelDetailMatch = /^\/v1\/models\/local\/([^/]+)$/.exec(path);
  if (method === 'GET' && localRegistryModelDetailMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const model = await options.providerRuntime.experiments.getModel(
      options.tenant,
      pathId(decodeURIComponent(localRegistryModelDetailMatch[1]), 'modelVersionId'),
    );
    return {
      statusCode: model === undefined ? 404 : 200,
      body: model ?? { error: 'model_not_found' },
    };
  }
  if (method === 'GET' && path === '/v1/model-promotions/local') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    return {
      statusCode: 200,
      body: await options.providerRuntime.experiments.listPromotionDecisions(options.tenant),
    };
  }
  const experimentArtifactMatch = /^\/v1\/experiment-artifacts\/local\/([^/]+)$/.exec(path);
  if (method === 'GET' && experimentArtifactMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const artifact = await options.providerRuntime.experiments.getArtifact(
      options.tenant,
      pathId(decodeURIComponent(experimentArtifactMatch[1]), 'artifactId'),
    );
    return {
      statusCode: artifact === undefined ? 404 : 200,
      body: artifact ?? { error: 'experiment_artifact_not_found' },
    };
  }
  if (method === 'GET' && path === '/v1/training/runs') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    return {
      statusCode: 200,
      body: {
        available: options.providerRuntime.training.available,
        runs: await options.providerRuntime.training.list(),
      },
    };
  }
  if (method === 'POST' && path === '/v1/training/runs') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const record = bodyRecord(request.body, 'training run');
    const configuration = bodyRecord(record['configuration'], 'training configuration');
    const requestValue: TrainingRunRequestV1 = {
      configuration: configuration as unknown as Record<string, JsonValue>,
      ...(typeof record['runId'] === 'string' ? { runId: record['runId'] } : {}),
      ...(typeof record['datasetArtifactId'] === 'string'
        ? { datasetArtifactId: record['datasetArtifactId'] }
        : {}),
      ...(typeof record['modelId'] === 'string' ? { modelId: record['modelId'] } : {}),
      ...(Number.isSafeInteger(record['timeoutMs'])
        ? { timeoutMs: record['timeoutMs'] as number }
        : {}),
    };
    return { statusCode: 202, body: await options.providerRuntime.training.train(requestValue) };
  }
  const trainingRunMatch = /^\/v1\/training\/runs\/([^/]+)$/.exec(path);
  if (method === 'GET' && trainingRunMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const run = await options.providerRuntime.training.get(decodeURIComponent(trainingRunMatch[1]));
    return {
      statusCode: run === undefined ? 404 : 200,
      body: run ?? { error: 'training_run_not_found' },
    };
  }
  const trainingCancelMatch = /^\/v1\/training\/runs\/([^/]+)\/cancel$/.exec(path);
  if (method === 'POST' && trainingCancelMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const runId = decodeURIComponent(trainingCancelMatch[1]);
    return {
      statusCode: 202,
      body: { runId, cancelled: options.providerRuntime.training.cancel(runId) },
    };
  }
  if (method === 'GET' && path === '/v1/deployments/local') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    return {
      statusCode: 200,
      body: {
        available: options.providerRuntime.serving.available,
        deployments: await options.providerRuntime.serving.list(),
        endpoints: await options.providerRuntime.serving.listEndpoints(),
      },
    };
  }
  if (method === 'GET' && path === '/v1/deployments/local/endpoints') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    return {
      statusCode: 200,
      body: {
        available: options.providerRuntime.serving.available,
        endpoints: await options.providerRuntime.serving.listEndpoints(),
      },
    };
  }
  const localEndpointDetailMatch = /^\/v1\/deployments\/local\/endpoints\/([^/]+)$/.exec(path);
  if (method === 'GET' && localEndpointDetailMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const endpoint = await options.providerRuntime.serving.getEndpoint(
      decodeURIComponent(localEndpointDetailMatch[1]),
    );
    return {
      statusCode: endpoint === undefined ? 404 : 200,
      body: endpoint ?? { error: 'endpoint_not_found' },
    };
  }
  const localDeploymentTelemetryMatch =
    /^\/v1\/deployments\/local\/([^/]+)\/(metrics|logs|revisions|events)$/.exec(path);
  if (method === 'GET' && localDeploymentTelemetryMatch?.[1] && localDeploymentTelemetryMatch[2]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const deploymentId = decodeURIComponent(localDeploymentTelemetryMatch[1]);
    if ((await options.providerRuntime.serving.get(deploymentId)) === undefined) {
      return { statusCode: 404, body: { error: 'deployment_not_found' } };
    }
    const telemetry = localDeploymentTelemetryMatch[2];
    if (telemetry === 'metrics') {
      return { statusCode: 200, body: await options.providerRuntime.serving.metrics(deploymentId) };
    }
    if (telemetry === 'logs') {
      return {
        statusCode: 200,
        body: { logs: await options.providerRuntime.serving.logs(deploymentId) },
      };
    }
    if (telemetry === 'revisions') {
      return {
        statusCode: 200,
        body: { revisions: await options.providerRuntime.serving.revisions(deploymentId) },
      };
    }
    return {
      statusCode: 200,
      body: { events: await options.providerRuntime.serving.events(deploymentId) },
    };
  }
  const localDeploymentDetailMatch = /^\/v1\/deployments\/local\/([^/]+)$/.exec(path);
  if (method === 'GET' && localDeploymentDetailMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const deployment = await options.providerRuntime.serving.get(
      decodeURIComponent(localDeploymentDetailMatch[1]),
    );
    return {
      statusCode: deployment === undefined ? 404 : 200,
      body: deployment ?? { error: 'deployment_not_found' },
    };
  }
  if (method === 'POST' && path === '/v1/deployments/local/serve') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const record = bodyRecord(request.body, 'model deployment');
    const servingRequest = localServingRequest(record);
    if (servingRequest.modelVersionId !== undefined) {
      const modelVersionId = pathId(servingRequest.modelVersionId, 'modelVersionId');
      const model = await options.providerRuntime.experiments.getModel(
        options.tenant,
        modelVersionId,
      );
      if (model === undefined || model.stage !== 'production') {
        throw runtimeError(
          'POLICY_DENIED',
          'Only a promoted production model version can be served',
        );
      }
    }
    requireLocalConfirmation(
      options,
      { kind: 'deployment.local.serve', request: servingRequest as unknown as JsonValue },
      record['confirmationId'],
    );
    return {
      statusCode: 202,
      body: await options.providerRuntime.serving.serve(servingRequest),
    };
  }
  const localDeploymentActionMatch =
    /^\/v1\/deployments\/local\/([^/]+)\/(observe|canary|promote|rollback|update|stop|restart|scale|invoke|smoke-test|archive)$/.exec(
      path,
    );
  if (method === 'POST' && localDeploymentActionMatch?.[1] && localDeploymentActionMatch[2]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const deploymentId = decodeURIComponent(localDeploymentActionMatch[1]);
    const action = localDeploymentActionMatch[2];
    if (action === 'observe') {
      return { statusCode: 200, body: await options.providerRuntime.serving.observe(deploymentId) };
    }
    const record = bodyRecord(request.body, `deployment ${action}`);
    if (action === 'update') {
      const updateRequest = localServingRequest(record, false);
      requireLocalConfirmation(
        options,
        {
          kind: 'deployment.local.update',
          deploymentId,
          request: updateRequest as unknown as JsonValue,
        },
        record['confirmationId'],
      );
      return {
        statusCode: 202,
        body: await options.providerRuntime.serving.update(deploymentId, updateRequest),
      };
    }
    if (action === 'stop' || action === 'restart' || action === 'scale' || action === 'archive') {
      requireLocalConfirmation(
        options,
        { kind: `deployment.local.${action}`, deploymentId, request: record as JsonValue },
        record['confirmationId'],
      );
    }
    if (action === 'stop') {
      return { statusCode: 200, body: await options.providerRuntime.serving.stop(deploymentId) };
    }
    if (action === 'restart') {
      return { statusCode: 202, body: await options.providerRuntime.serving.restart(deploymentId) };
    }
    if (action === 'archive') {
      return { statusCode: 200, body: await options.providerRuntime.serving.archive(deploymentId) };
    }
    if (action === 'scale') {
      const scaling = optionalJsonRecord(record['scaling'], 'scaling');
      if (scaling === undefined)
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'scaling is required');
      return {
        statusCode: 200,
        body: await options.providerRuntime.serving.scale(
          deploymentId,
          scaling as unknown as LocalServingScalingV1,
        ),
      };
    }
    if (action === 'invoke') {
      const payload = record['payload'];
      if (payload !== undefined && !isJsonValue(payload)) {
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'payload must be JSON');
      }
      const methodValue = record['method'];
      const pathValue = record['path'];
      if (methodValue !== undefined && typeof methodValue !== 'string') {
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'method must be a string');
      }
      if (pathValue !== undefined && typeof pathValue !== 'string') {
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'path must be a string');
      }
      return {
        statusCode: 200,
        body: await options.providerRuntime.serving.invoke(deploymentId, {
          ...(payload === undefined ? {} : { payload }),
          ...(methodValue === undefined ? {} : { method: methodValue }),
          ...(pathValue === undefined ? {} : { path: pathValue }),
        }),
      };
    }
    if (action === 'smoke-test') {
      return {
        statusCode: 200,
        body: await options.providerRuntime.serving.smokeTest(deploymentId),
      };
    }
    const approval = servingApproval(record['approval']);
    requireLocalConfirmation(
      options,
      {
        kind: `deployment.local.${action}`,
        deploymentId,
        ...(action === 'canary' ? { trafficPercent: record['trafficPercent'] as JsonValue } : {}),
        ...(approval === undefined ? {} : { approval: approval as unknown as JsonValue }),
      },
      record['confirmationId'],
    );
    if (action === 'promote') {
      return {
        statusCode: 200,
        body: await options.providerRuntime.serving.promote(deploymentId, approval),
      };
    }
    if (action === 'rollback') {
      return {
        statusCode: 200,
        body: await options.providerRuntime.serving.rollback(deploymentId, approval),
      };
    }
    const trafficPercent = record['trafficPercent'];
    if (!Number.isSafeInteger(trafficPercent)) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'trafficPercent must be an integer');
    }
    return {
      statusCode: 200,
      body: await options.providerRuntime.serving.canary(
        deploymentId,
        trafficPercent as number,
        approval,
      ),
    };
  }
  const localRepositoryFileMoveMatch = /^\/v1\/repositories\/local\/([^/]+)\/files\/move$/.exec(
    path,
  );
  if (method === 'POST' && localRepositoryFileMoveMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const record = bodyRecord(request.body, 'file move');
    const repositoryId = decodeURIComponent(localRepositoryFileMoveMatch[1]);
    const from = requiredString(record, 'from');
    const to = requiredString(record, 'to');
    requireLocalConfirmation(
      options,
      { kind: 'repository.file.move', repositoryId, from, to },
      record['confirmationId'],
    );
    return {
      statusCode: 200,
      body: await options.providerRuntime.repositories.moveFile({ repositoryId, from, to }),
    };
  }
  const localRepositoryFileDeleteMatch = /^\/v1\/repositories\/local\/([^/]+)\/files\/delete$/.exec(
    path,
  );
  if (method === 'POST' && localRepositoryFileDeleteMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const record = bodyRecord(request.body, 'file delete');
    const repositoryId = decodeURIComponent(localRepositoryFileDeleteMatch[1]);
    const filePath = requiredString(record, 'path');
    requireLocalConfirmation(
      options,
      { kind: 'repository.file.delete', repositoryId, path: filePath },
      record['confirmationId'],
    );
    return {
      statusCode: 200,
      body: await options.providerRuntime.repositories.deleteFile({ repositoryId, path: filePath }),
    };
  }
  const localRepositoryRunMatch = /^\/v1\/repository-runs\/([^/]+)$/.exec(path);
  if (method === 'GET' && localRepositoryRunMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const run = await options.providerRuntime.repositories.getRun(
      decodeURIComponent(localRepositoryRunMatch[1]),
    );
    return {
      statusCode: run === undefined ? 404 : 200,
      body: run ?? { error: 'repository_run_not_found' },
    };
  }
  const localRepositoryRunCancelMatch = /^\/v1\/repository-runs\/([^/]+)\/cancel$/.exec(path);
  if (method === 'POST' && localRepositoryRunCancelMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    return {
      statusCode: 200,
      body: await options.providerRuntime.repositories.cancelRun(
        decodeURIComponent(localRepositoryRunCancelMatch[1]),
      ),
    };
  }
  const localRepositoryStatusMatch =
    /^\/v1\/repositories\/local\/([^/]+)\/(status|diff|files|file|search|history|runs|python|dependencies|tests|checks|worktrees|commit|push|pull-requests|merge)$/.exec(
      path,
    );
  if (localRepositoryStatusMatch?.[1] && localRepositoryStatusMatch[2]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const repositoryId = decodeURIComponent(localRepositoryStatusMatch[1]);
    const operation = localRepositoryStatusMatch[2];
    if (operation === 'status' && method === 'GET') {
      return {
        statusCode: 200,
        body: await options.providerRuntime.repositories.status(repositoryId),
      };
    }
    if (operation === 'diff' && method === 'GET') {
      return {
        statusCode: 200,
        body: await options.providerRuntime.repositories.diff(repositoryId),
      };
    }
    if (operation === 'files' && method === 'GET') {
      const prefix = new URL(rawPath, 'http://local').searchParams.get('prefix') ?? undefined;
      return {
        statusCode: 200,
        body: await options.providerRuntime.repositories.listFiles(repositoryId, prefix),
      };
    }
    if (operation === 'file' && method === 'GET') {
      const filePath = new URL(rawPath, 'http://local').searchParams.get('path');
      if (filePath === null || filePath.trim().length === 0) {
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'path is required');
      }
      return {
        statusCode: 200,
        body: await options.providerRuntime.repositories.readFile(repositoryId, filePath),
      };
    }
    if (operation === 'file' && method === 'POST') {
      assertLicensed(options);
      const record = bodyRecord(request.body, 'file write');
      const filePath = requiredString(record, 'path');
      const content = record['content'];
      if (typeof content !== 'string') {
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'content must be a string');
      }
      const origin = record['origin'];
      if (
        origin !== 'manual' &&
        origin !== 'generated' &&
        origin !== 'upload' &&
        origin !== 'artifact-derived'
      ) {
        throw runtimeError(
          'VALIDATION_SCHEMA_MISMATCH',
          'origin must be manual, generated, upload, or artifact-derived',
        );
      }
      const artifactId = record['artifactId'];
      if (artifactId !== undefined && typeof artifactId !== 'string') {
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'artifactId must be a string');
      }
      const contentHash = `sha256:${createHash('sha256').update(content).digest('hex')}`;
      requireLocalConfirmation(
        options,
        {
          kind: 'repository.file.write',
          repositoryId,
          path: filePath,
          contentHash,
          origin,
          sizeBytes: Buffer.byteLength(content, 'utf8'),
        },
        record['confirmationId'],
      );
      return {
        statusCode: 200,
        body: await options.providerRuntime.repositories.writeFile({
          repositoryId,
          path: filePath,
          content,
          origin,
          ...(artifactId === undefined ? {} : { artifactId }),
        }),
      };
    }
    if (operation === 'search' && method === 'GET') {
      const query = new URL(rawPath, 'http://local').searchParams.get('query');
      if (query === null || query.trim().length === 0) {
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'query is required');
      }
      const prefix = new URL(rawPath, 'http://local').searchParams.get('prefix') ?? undefined;
      return {
        statusCode: 200,
        body: await options.providerRuntime.repositories.search(repositoryId, query, prefix),
      };
    }
    if (operation === 'history' && method === 'GET') {
      const filePath = new URL(rawPath, 'http://local').searchParams.get('path') ?? undefined;
      return {
        statusCode: 200,
        body: await options.providerRuntime.repositories.history(repositoryId, filePath),
      };
    }
    if (operation === 'runs' && method === 'GET') {
      return {
        statusCode: 200,
        body: await options.providerRuntime.repositories.listRuns(repositoryId),
      };
    }
    if (operation === 'python' && method === 'POST') {
      assertLicensed(options);
      const record = bodyRecord(request.body, 'Python execution');
      const source = record['source'];
      if (typeof source !== 'string' || source.length === 0) {
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'source is required');
      }
      const args = record['args'];
      if (
        args !== undefined &&
        (!Array.isArray(args) || args.some((value) => typeof value !== 'string'))
      ) {
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Python args must be an array of strings');
      }
      const runtimeProfileId = record['runtimeProfileId'];
      if (runtimeProfileId !== undefined && typeof runtimeProfileId !== 'string') {
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'runtimeProfileId must be a string');
      }
      const environmentRevisionId = record['environmentRevisionId'];
      if (environmentRevisionId !== undefined && typeof environmentRevisionId !== 'string') {
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'environmentRevisionId must be a string');
      }
      const timeoutMs = record['timeoutMs'];
      if (
        timeoutMs !== undefined &&
        (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1000)
      ) {
        throw runtimeError(
          'VALIDATION_SCHEMA_MISMATCH',
          'timeoutMs must be an integer of at least 1000',
        );
      }
      const normalizedTimeoutMs = timeoutMs === undefined ? undefined : (timeoutMs as number);
      requireLocalConfirmation(
        options,
        {
          kind: 'repository.python',
          repositoryId,
          sourceHash: `sha256:${createHash('sha256').update(source).digest('hex')}`,
          ...(runtimeProfileId === undefined ? {} : { runtimeProfileId }),
          ...(environmentRevisionId === undefined ? {} : { environmentRevisionId }),
          ...(normalizedTimeoutMs === undefined ? {} : { timeoutMs: normalizedTimeoutMs }),
        },
        record['confirmationId'],
      );
      return {
        statusCode: 200,
        body: await options.providerRuntime.repositories.runPython({
          repositoryId,
          source,
          ...(args === undefined ? {} : { args }),
          ...(runtimeProfileId === undefined ? {} : { runtimeProfileId }),
          ...(environmentRevisionId === undefined ? {} : { environmentRevisionId }),
          ...(normalizedTimeoutMs === undefined ? {} : { timeoutMs: normalizedTimeoutMs }),
        }),
      };
    }
    if (operation === 'dependencies' && method === 'POST') {
      assertLicensed(options);
      const record = bodyRecord(request.body, 'dependency installation');
      const command = requiredString(record, 'command');
      const args = record['args'];
      if (
        args !== undefined &&
        (!Array.isArray(args) || args.some((value) => typeof value !== 'string'))
      ) {
        throw runtimeError(
          'VALIDATION_SCHEMA_MISMATCH',
          'Dependency args must be an array of strings',
        );
      }
      const timeoutMs = record['timeoutMs'];
      if (
        timeoutMs !== undefined &&
        (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1000)
      ) {
        throw runtimeError(
          'VALIDATION_SCHEMA_MISMATCH',
          'timeoutMs must be an integer of at least 1000',
        );
      }
      const normalizedTimeoutMs = timeoutMs === undefined ? undefined : (timeoutMs as number);
      requireLocalConfirmation(
        options,
        {
          kind: 'repository.dependencies.install',
          repositoryId,
          command,
          ...(args === undefined ? {} : { args }),
        },
        record['confirmationId'],
      );
      return {
        statusCode: 200,
        body: await options.providerRuntime.repositories.installDependencies({
          repositoryId,
          command,
          ...(args === undefined ? {} : { args }),
          ...(normalizedTimeoutMs === undefined ? {} : { timeoutMs: normalizedTimeoutMs }),
        }),
      };
    }
    if (operation === 'tests' && method === 'POST') {
      assertLicensed(options);
      const record = bodyRecord(request.body, 'repository test');
      const args = record['args'];
      if (
        args !== undefined &&
        (!Array.isArray(args) || args.some((value) => typeof value !== 'string'))
      ) {
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'test args must be an array of strings');
      }
      const timeoutMs = record['timeoutMs'];
      if (
        timeoutMs !== undefined &&
        (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1000)
      ) {
        throw runtimeError(
          'VALIDATION_SCHEMA_MISMATCH',
          'timeoutMs must be an integer of at least 1000',
        );
      }
      const command = requiredString(record, 'command');
      const environmentRevisionId = record['environmentRevisionId'];
      if (environmentRevisionId !== undefined && typeof environmentRevisionId !== 'string') {
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'environmentRevisionId must be a string');
      }
      requireLocalConfirmation(
        options,
        {
          kind: 'repository.test',
          repositoryId,
          command,
          ...(args === undefined ? {} : { args }),
          ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }),
          ...(environmentRevisionId === undefined ? {} : { environmentRevisionId }),
        },
        record['confirmationId'],
      );
      return {
        statusCode: 200,
        body: await options.providerRuntime.repositories.runTest({
          repositoryId,
          command,
          ...(args === undefined ? {} : { args }),
          ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }),
          ...(environmentRevisionId === undefined ? {} : { environmentRevisionId }),
        }),
      };
    }
    if (operation === 'checks' && method === 'POST') {
      assertLicensed(options);
      return {
        statusCode: 200,
        body: await options.providerRuntime.repositories.check(repositoryId),
      };
    }
    if (operation === 'worktrees' && method === 'GET') {
      return {
        statusCode: 200,
        body: await options.providerRuntime.repositories.listWorktrees(repositoryId),
      };
    }
    if (operation === 'worktrees' && method === 'POST') {
      assertLicensed(options);
      const record = bodyRecord(request.body, 'local worktree');
      return {
        statusCode: 201,
        body: await options.providerRuntime.repositories.createWorktree({
          repositoryId,
          branch: requiredString(record, 'branch'),
          ...(typeof record['base'] === 'string' ? { base: record['base'] } : {}),
        }),
      };
    }
    if (operation === 'commit' && method === 'POST') {
      assertLicensed(options);
      const record = bodyRecord(request.body, 'repository commit');
      const message = requiredString(record, 'message');
      requireLocalConfirmation(
        options,
        { kind: 'repository.commit', repositoryId, message },
        record['confirmationId'],
      );
      return {
        statusCode: 201,
        body: await options.providerRuntime.repositories.commit(repositoryId, message),
      };
    }
    if (operation === 'push' && method === 'POST') {
      assertLicensed(options);
      const record = bodyRecord(request.body, 'repository push');
      const remote = typeof record['remote'] === 'string' ? record['remote'] : undefined;
      const branch = typeof record['branch'] === 'string' ? record['branch'] : undefined;
      requireLocalConfirmation(
        options,
        {
          kind: 'repository.push',
          repositoryId,
          ...(remote === undefined ? {} : { remote }),
          ...(branch === undefined ? {} : { branch }),
        },
        record['confirmationId'],
      );
      return {
        statusCode: 202,
        body: await options.providerRuntime.repositories.push(repositoryId, {
          ...(remote === undefined ? {} : { remote }),
          ...(branch === undefined ? {} : { branch }),
        }),
      };
    }
    if (operation === 'pull-requests' && method === 'POST') {
      assertLicensed(options);
      const record = bodyRecord(request.body, 'repository pull request');
      if (record['provider'] !== 'github') {
        throw runtimeError(
          'VALIDATION_SCHEMA_MISMATCH',
          'Only the GitHub pull request provider is supported',
        );
      }
      const connectionId = requiredString(record, 'connectionId');
      const owner = requiredString(record, 'owner');
      const repo = requiredString(record, 'repo');
      const head = requiredString(record, 'head');
      const base = requiredString(record, 'base');
      const title = requiredString(record, 'title');
      requireLocalConfirmation(
        options,
        {
          kind: 'repository.pull-request.create',
          repositoryId,
          connectionId,
          owner,
          repo,
          head,
          base,
          title,
        },
        record['confirmationId'],
      );
      return {
        statusCode: 202,
        body: await options.providerRuntime.repositories.createPullRequest({
          provider: 'github',
          connectionId,
          owner,
          repo,
          head,
          base,
          title,
          ...(typeof record['body'] === 'string' ? { body: record['body'] } : {}),
          ...(typeof record['draft'] === 'boolean' ? { draft: record['draft'] } : {}),
        }),
      };
    }
    if (operation === 'merge' && method === 'POST') {
      assertLicensed(options);
      const record = bodyRecord(request.body, 'repository merge');
      if (record['provider'] !== 'github') {
        throw runtimeError(
          'VALIDATION_SCHEMA_MISMATCH',
          'Only the GitHub merge provider is supported',
        );
      }
      const number = record['number'];
      if (!Number.isSafeInteger(number) || (number as number) < 1) {
        throw runtimeError(
          'VALIDATION_SCHEMA_MISMATCH',
          'Pull request number must be a positive integer',
        );
      }
      const mergeMethod = record['mergeMethod'];
      if (
        mergeMethod !== undefined &&
        !['merge', 'squash', 'rebase'].includes(String(mergeMethod))
      ) {
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'mergeMethod is invalid');
      }
      const connectionId = requiredString(record, 'connectionId');
      const owner = requiredString(record, 'owner');
      const repo = requiredString(record, 'repo');
      const normalizedMergeMethod =
        mergeMethod === undefined ? undefined : (mergeMethod as 'merge' | 'squash' | 'rebase');
      requireLocalConfirmation(
        options,
        {
          kind: 'repository.pull-request.merge',
          repositoryId,
          connectionId,
          owner,
          repo,
          number: number as number,
          ...(normalizedMergeMethod === undefined ? {} : { mergeMethod: normalizedMergeMethod }),
        },
        record['confirmationId'],
      );
      return {
        statusCode: 202,
        body: await options.providerRuntime.repositories.mergePullRequest({
          provider: 'github',
          connectionId,
          owner,
          repo,
          number: number as number,
          ...(normalizedMergeMethod === undefined ? {} : { mergeMethod: normalizedMergeMethod }),
          ...(typeof record['commitTitle'] === 'string'
            ? { commitTitle: record['commitTitle'] }
            : {}),
          ...(typeof record['commitMessage'] === 'string'
            ? { commitMessage: record['commitMessage'] }
            : {}),
        }),
      };
    }
  }
  const workspaceIntakePath =
    path === '/v1/workspace/intake' ||
    path === '/v1/workspace/inbox' ||
    path === '/v1/workspace/watch' ||
    path === '/v1/workspace/recommendations' ||
    path === '/v1/workspace/context';
  if (method === 'GET' && workspaceIntakePath) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const snapshot = await options.providerRuntime.workspaceIntake.snapshot();
    if (path === '/v1/workspace/inbox') return { statusCode: 200, body: snapshot.inbox };
    if (path === '/v1/workspace/watch') return { statusCode: 200, body: snapshot.watch };
    if (path === '/v1/workspace/recommendations') {
      return { statusCode: 200, body: snapshot.recommendations };
    }
    if (path === '/v1/workspace/context') {
      return {
        statusCode: 200,
        body: {
          schemaVersion: 1,
          tenant: options.tenant,
          repositories: await options.providerRuntime.repositories.list(),
          intake: snapshot,
        },
      };
    }
    return { statusCode: 200, body: snapshot };
  }
  if (method === 'GET' && path === '/v1/visualizations/catalog') {
    return {
      statusCode: 200,
      body: {
        schemaVersion: 1,
        resourceType: 'visualization',
        available: options.providerRuntime !== undefined,
        types: [
          'table',
          'metric',
          'kpi',
          'line',
          'bar',
          'stacked-bar',
          'area',
          'pivot',
          'scatter',
          'histogram',
          'box',
          'heatmap',
          'point-map',
          'choropleth',
          'time-series',
          'confusion-matrix',
          'roc',
          'precision-recall',
          'feature-importance',
        ],
        operations: ['discover', 'invoke', 'observe', 'inspect'],
      },
    };
  }
  const visualizationChoosePath = path === '/v1/visualizations/choose';
  const visualizationValidatePath = path === '/v1/visualizations/validate';
  const visualizationRenderPath = path === '/v1/visualizations/render';
  if (
    method === 'POST' &&
    (visualizationChoosePath || visualizationValidatePath || visualizationRenderPath)
  ) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    if (visualizationRenderPath) assertLicensed(options);
    const record = bodyRecord(request.body, 'visualization');
    const columnsValue = record['columns'];
    if (!Array.isArray(columnsValue) || columnsValue.some((value) => typeof value !== 'string')) {
      throw runtimeError(
        'VALIDATION_SCHEMA_MISMATCH',
        'visualization.columns must be an array of strings',
      );
    }
    const rowsValue = record['rows'];
    if (!Array.isArray(rowsValue) || rowsValue.some((row) => !Array.isArray(row))) {
      throw runtimeError(
        'VALIDATION_SCHEMA_MISMATCH',
        'visualization.rows must be an array of arrays',
      );
    }
    const input = {
      columns: columnsValue as string[],
      rows: rowsValue as Array<readonly JsonValue[]>,
      ...(typeof record['sourceArtifactId'] === 'string'
        ? { sourceArtifactId: record['sourceArtifactId'] }
        : {}),
    };
    const visualizationTypes: readonly VisualizationType[] = [
      'table',
      'metric',
      'kpi',
      'line',
      'bar',
      'stacked-bar',
      'area',
      'pivot',
      'scatter',
      'histogram',
      'box',
      'heatmap',
      'point-map',
      'choropleth',
      'time-series',
      'confusion-matrix',
      'roc',
      'precision-recall',
      'feature-importance',
    ];
    if (visualizationChoosePath) {
      const override = record['type'];
      if (override !== undefined && !visualizationTypes.includes(override as VisualizationType)) {
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'visualization.type is invalid');
      }
      return {
        statusCode: 200,
        body: options.providerRuntime.visualizations.choose(
          input,
          override === undefined ? undefined : (override as VisualizationType),
        ),
      };
    }
    const specRecord = bodyRecord(record['spec'], 'visualization.spec');
    const type = specRecord['type'];
    if (!visualizationTypes.includes(type as VisualizationType)) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'visualization.spec.type is invalid');
    }
    const spec = {
      type: type as VisualizationType,
      ...(typeof specRecord['title'] === 'string' ? { title: specRecord['title'] } : {}),
      ...(typeof specRecord['xColumn'] === 'string' ? { xColumn: specRecord['xColumn'] } : {}),
      ...(typeof specRecord['yColumn'] === 'string' ? { yColumn: specRecord['yColumn'] } : {}),
      ...(typeof specRecord['seriesColumn'] === 'string'
        ? { seriesColumn: specRecord['seriesColumn'] }
        : {}),
      ...(Number.isSafeInteger(specRecord['bucketCount'])
        ? { bucketCount: specRecord['bucketCount'] as number }
        : {}),
    };
    const validation = options.providerRuntime.visualizations.validate(spec, input);
    return {
      statusCode: 200,
      body:
        visualizationRenderPath && validation.valid
          ? options.providerRuntime.visualizations.render(spec, input)
          : validation,
    };
  }
  const notebookVersionDetailMatch = /^\/v1\/notebooks\/([^/]+)\/versions\/(\d+)$/.exec(path);
  if (method === 'GET' && notebookVersionDetailMatch?.[1] && notebookVersionDetailMatch[2]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const notebook = options.providerRuntime.notebooks.get(
      decodeURIComponent(notebookVersionDetailMatch[1]),
      Number(notebookVersionDetailMatch[2]),
    );
    return {
      statusCode: notebook === undefined ? 404 : 200,
      body: notebook ?? { error: 'notebook_version_not_found' },
    };
  }
  const notebookVersionsMatch = /^\/v1\/notebooks\/([^/]+)\/versions$/.exec(path);
  if (method === 'GET' && notebookVersionsMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    return {
      statusCode: 200,
      body: options.providerRuntime.notebooks.versions(
        decodeURIComponent(notebookVersionsMatch[1]),
      ),
    };
  }
  const notebookActionMatch =
    /^\/v1\/notebooks\/([^/]+)\/(open|duplicate|archive|restore|run)$/.exec(path);
  if (notebookActionMatch?.[1] && notebookActionMatch[2]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const notebookId = decodeURIComponent(notebookActionMatch[1]);
    const action = notebookActionMatch[2];
    if (action === 'open' && method === 'POST') {
      const record = bodyRecord(request.body ?? {}, 'notebook open');
      const revision = record['revision'];
      if (
        revision !== undefined &&
        (!Number.isSafeInteger(revision) || (revision as number) <= 0)
      ) {
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'revision must be a positive integer');
      }
      return {
        statusCode: 200,
        body: options.providerRuntime.notebooks.open(
          notebookId,
          revision === undefined ? undefined : (revision as number),
        ),
      };
    }
    if (action === 'duplicate' && method === 'POST') {
      assertLicensed(options);
      const record = bodyRecord(request.body ?? {}, 'notebook duplicate');
      return {
        statusCode: 201,
        body: options.providerRuntime.notebooks.duplicate({
          notebookId,
          ...(typeof record['newNotebookId'] === 'string'
            ? { newNotebookId: record['newNotebookId'] }
            : {}),
          ...(typeof record['title'] === 'string' ? { title: record['title'] } : {}),
        }),
      };
    }
    if ((action === 'archive' || action === 'restore') && method === 'POST') {
      assertLicensed(options);
      const record = bodyRecord(request.body ?? {}, `notebook ${action}`);
      requireLocalConfirmation(
        options,
        { kind: `notebook.${action}`, notebookId },
        record['confirmationId'],
      );
      return {
        statusCode: 200,
        body:
          action === 'archive'
            ? options.providerRuntime.notebooks.archive(notebookId)
            : options.providerRuntime.notebooks.restore(notebookId),
      };
    }
    if (action === 'run' && method === 'POST') {
      assertLicensed(options);
      const record = bodyRecord(request.body ?? {}, 'notebook run');
      const revision = record['revision'];
      if (
        revision !== undefined &&
        (!Number.isSafeInteger(revision) || (revision as number) <= 0)
      ) {
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'revision must be a positive integer');
      }
      const parameters = record['parameters'];
      if (
        parameters !== undefined &&
        (parameters === null ||
          typeof parameters !== 'object' ||
          Array.isArray(parameters) ||
          !isJsonValue(parameters))
      ) {
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'parameters must be a JSON object');
      }
      const sourceData = optionalQuerySource(record, 'sourceData');
      const confirmationAction = {
        kind: 'notebook.run',
        notebookId,
        ...(revision === undefined ? {} : { revision: revision as number }),
      } satisfies JsonValue;
      requireLocalConfirmation(options, confirmationAction, record['confirmationId']);
      return {
        statusCode: 202,
        body: await options.providerRuntime.notebooks.runNotebook({
          notebookId,
          ...(revision === undefined ? {} : { revision: revision as number }),
          ...(sourceData === undefined ? {} : { sourceData }),
          ...(typeof record['runtimeProfileId'] === 'string'
            ? { runtimeProfileId: record['runtimeProfileId'] }
            : {}),
          ...(typeof record['environmentRevisionId'] === 'string'
            ? { environmentRevisionId: record['environmentRevisionId'] }
            : {}),
          ...(typeof record['datasetVersion'] === 'string'
            ? { datasetVersion: record['datasetVersion'] }
            : {}),
          ...(typeof record['computeProfile'] === 'string'
            ? { computeProfile: record['computeProfile'] }
            : {}),
          ...(parameters === undefined
            ? {}
            : { parameters: parameters as Record<string, JsonValue> }),
        }),
      };
    }
  }
  const notebookExecutionListMatch = /^\/v1\/notebooks\/([^/]+)\/executions$/.exec(path);
  if (method === 'GET' && notebookExecutionListMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    return {
      statusCode: 200,
      body: options.providerRuntime.notebooks.listExecutions(
        decodeURIComponent(notebookExecutionListMatch[1]),
      ),
    };
  }
  const notebookUsageMatch = /^\/v1\/notebooks\/([^/]+)\/usage$/.exec(path);
  if (method === 'GET' && notebookUsageMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    return {
      statusCode: 200,
      body: options.providerRuntime.notebooks.usage(decodeURIComponent(notebookUsageMatch[1])),
    };
  }
  const notebookExperimentsMatch = /^\/v1\/notebooks\/([^/]+)\/experiments$/.exec(path);
  if (method === 'GET' && notebookExperimentsMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    return {
      statusCode: 200,
      body: options.providerRuntime.notebooks.experiments(
        decodeURIComponent(notebookExperimentsMatch[1]),
      ),
    };
  }
  if (method === 'POST' && notebookExperimentsMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const notebookId = decodeURIComponent(notebookExperimentsMatch[1]);
    const record = bodyRecord(request.body ?? {}, 'notebook experiment association');
    const experimentId = requiredString(record, 'experimentId');
    return {
      statusCode: 201,
      body: options.providerRuntime.notebooks.associateExperiment(notebookId, experimentId),
    };
  }
  const notebookRunsMatch = /^\/v1\/notebooks\/([^/]+)\/runs$/.exec(path);
  if (method === 'GET' && notebookRunsMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    return {
      statusCode: 200,
      body: options.providerRuntime.notebooks.listRuns(decodeURIComponent(notebookRunsMatch[1])),
    };
  }
  const notebookRunDetailMatch = /^\/v1\/notebooks\/([^/]+)\/runs\/([^/]+)$/.exec(path);
  if (method === 'GET' && notebookRunDetailMatch?.[1] && notebookRunDetailMatch[2]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const run = options.providerRuntime.notebooks.getRun(
      decodeURIComponent(notebookRunDetailMatch[2]),
    );
    return {
      statusCode: run === undefined ? 404 : 200,
      body: run ?? { error: 'notebook_run_not_found' },
    };
  }
  const notebookCellRunMatch = /^\/v1\/notebooks\/([^/]+)\/cells\/([^/]+)\/run$/.exec(path);
  if (method === 'POST' && notebookCellRunMatch?.[1] && notebookCellRunMatch[2]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const record = bodyRecord(request.body, 'notebook cell run');
    const type = record['type'];
    if (type !== 'markdown' && type !== 'python' && type !== 'sql') {
      throw runtimeError(
        'VALIDATION_SCHEMA_MISMATCH',
        'Notebook cell type must be markdown, python, or sql',
      );
    }
    const sourceData = optionalQuerySource(record, 'sourceData');
    const revision = record['revision'];
    if (revision !== undefined && (!Number.isSafeInteger(revision) || (revision as number) <= 0)) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'revision must be a positive integer');
    }
    const outputType = record['outputType'];
    if (
      outputType !== undefined &&
      outputType !== 'text' &&
      outputType !== 'table' &&
      outputType !== 'chart' &&
      outputType !== 'image' &&
      outputType !== 'html' &&
      outputType !== 'report' &&
      outputType !== 'notebook'
    ) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Notebook outputType is invalid');
    }
    const notebookId = decodeURIComponent(notebookCellRunMatch[1]);
    const cellId = decodeURIComponent(notebookCellRunMatch[2]);
    const source = requiredString(record, 'source');
    const confirmationAction = {
      kind: 'notebook.cell.run',
      notebookId,
      cellId,
      type,
      source,
      ...(sourceData === undefined ? {} : { sourceData: sourceData as unknown as JsonValue }),
    } satisfies JsonValue;
    requireLocalConfirmation(options, confirmationAction, record['confirmationId']);
    return {
      statusCode: 200,
      body: await options.providerRuntime.notebooks.runCell({
        notebookId,
        cellId,
        type,
        source,
        ...(sourceData === undefined ? {} : { sourceData }),
        ...(revision === undefined ? {} : { revision: revision as number }),
        ...(typeof record['runtimeProfileId'] === 'string'
          ? { runtimeProfileId: record['runtimeProfileId'] }
          : {}),
        ...(typeof record['environmentRevisionId'] === 'string'
          ? { environmentRevisionId: record['environmentRevisionId'] }
          : {}),
        ...(typeof record['runId'] === 'string' ? { runId: record['runId'] } : {}),
        ...(outputType === undefined ? {} : { outputType }),
        ...(typeof record['mediaType'] === 'string' ? { mediaType: record['mediaType'] } : {}),
      }),
    };
  }
  const notebookCellCancelMatch = /^\/v1\/notebooks\/([^/]+)\/cells\/([^/]+)\/cancel$/.exec(path);
  if (method === 'POST' && notebookCellCancelMatch?.[1] && notebookCellCancelMatch[2]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const notebookId = decodeURIComponent(notebookCellCancelMatch[1]);
    const cellId = decodeURIComponent(notebookCellCancelMatch[2]);
    return {
      statusCode: 202,
      body: {
        notebookId,
        cellId,
        cancelled: options.providerRuntime.notebooks.cancel(notebookId, cellId),
      },
    };
  }
  const notebookRestartMatch = /^\/v1\/notebooks\/([^/]+)\/restart$/.exec(path);
  if (method === 'POST' && notebookRestartMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const notebookId = decodeURIComponent(notebookRestartMatch[1]);
    const record = bodyRecord(request.body ?? {}, 'notebook restart');
    requireLocalConfirmation(
      options,
      { kind: 'notebook.restart', notebookId },
      record['confirmationId'],
    );
    return {
      statusCode: 200,
      body: options.providerRuntime.notebooks.restart(notebookId),
    };
  }
  const notebookExportMatch = /^\/v1\/notebooks\/([^/]+)\/export$/.exec(path);
  if (method === 'GET' && notebookExportMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    return {
      statusCode: 200,
      body: options.providerRuntime.notebooks.exportIpynb(
        decodeURIComponent(notebookExportMatch[1]),
      ),
    };
  }
  const notebookImportMatch = /^\/v1\/notebooks\/([^/]+)\/import$/.exec(path);
  if (method === 'POST' && notebookImportMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const record = bodyRecord(request.body, 'notebook import');
    return {
      statusCode: 200,
      body: options.providerRuntime.notebooks.importIpynb(
        decodeURIComponent(notebookImportMatch[1]),
        record['document'],
      ),
    };
  }
  const notebookArtifactPublishMatch = /^\/v1\/notebooks\/([^/]+)\/cells\/([^/]+)\/publish$/.exec(
    path,
  );
  if (method === 'POST' && notebookArtifactPublishMatch?.[1] && notebookArtifactPublishMatch[2]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    if (options.artifacts === undefined) {
      return { statusCode: 501, body: { error: 'artifact_backend_not_configured' } };
    }
    const record = bodyRecord(request.body, 'notebook artifact publication');
    const notebookId = decodeURIComponent(notebookArtifactPublishMatch[1]);
    const cellId = decodeURIComponent(notebookArtifactPublishMatch[2]);
    const localArtifactId = requiredString(record, 'artifactId');
    const artifact = await options.providerRuntime.notebooks.getArtifact(localArtifactId);
    if (artifact === undefined) {
      return { statusCode: 404, body: { error: 'notebook_artifact_not_found' } };
    }
    const createdByValue = record['createdBy'] ?? options.localSession?.actor;
    const createdByValidation = validateContract('Actor', createdByValue);
    if (!createdByValidation.valid || createdByValidation.value === undefined) {
      throw runtimeError(
        'VALIDATION_SCHEMA_MISMATCH',
        'createdBy must be supplied when no authenticated session is available',
      );
    }
    const artifactIdValue = record['publishedArtifactId'];
    const artifactId =
      typeof artifactIdValue === 'string' && isId(artifactIdValue)
        ? artifactIdValue
        : newSortableId();
    const mediaType =
      typeof record['mediaType'] === 'string' ? record['mediaType'] : artifact.mediaType;
    const derivedFrom = optionalArtifactReferences(record, 'derivedFrom');
    const nowValue = record['now'];
    const now =
      nowValue === undefined
        ? (options.clock?.() ?? new Date().toISOString())
        : typeof nowValue === 'string' && validateContract('UtcInstant', nowValue).valid
          ? nowValue
          : (() => {
              throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'now must be a UTC instant');
            })();
    requireLocalConfirmation(
      options,
      { kind: 'notebook.artifact.publish', notebookId, cellId, localArtifactId, mediaType },
      record['confirmationId'],
    );
    const staged = await options.artifacts.stageUpload(
      options.tenant,
      artifact.content,
      mediaType,
      now,
      artifact.contentHash as HashSha256,
    );
    return {
      statusCode: 201,
      body: {
        localArtifactId,
        publishedArtifactId: artifactId,
        publication: await options.artifacts.publish({
          tenant: options.tenant,
          artifactId,
          stagedUploadId: staged.stagedUploadId,
          mediaType,
          createdBy: createdByValidation.value,
          ...(derivedFrom === undefined ? {} : { derivedFrom }),
          now,
          expectedContentHash: artifact.contentHash as HashSha256,
        }),
      },
    };
  }
  const notebookCellUpsertMatch = /^\/v1\/notebooks\/([^/]+)\/cells\/([^/]+)$/.exec(path);
  if (method === 'POST' && notebookCellUpsertMatch?.[1] && notebookCellUpsertMatch[2]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const record = bodyRecord(request.body, 'notebook cell');
    const type = record['type'];
    if (type !== 'markdown' && type !== 'python' && type !== 'sql') {
      throw runtimeError(
        'VALIDATION_SCHEMA_MISMATCH',
        'Notebook cell type must be markdown, python, or sql',
      );
    }
    return {
      statusCode: 200,
      body: options.providerRuntime.notebooks.upsertCell({
        notebookId: decodeURIComponent(notebookCellUpsertMatch[1]),
        cellId: decodeURIComponent(notebookCellUpsertMatch[2]),
        type,
        source: requiredString(record, 'source'),
      }),
    };
  }
  const notebookDetailMatch = /^\/v1\/notebooks\/([^/]+)$/.exec(path);
  if (method === 'GET' && notebookDetailMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const notebook = options.providerRuntime.notebooks.get(
      decodeURIComponent(notebookDetailMatch[1]),
    );
    return {
      statusCode: notebook === undefined ? 404 : 200,
      body: notebook ?? { error: 'notebook_not_found' },
    };
  }
  if (method === 'POST' && notebookDetailMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const record = bodyRecord(request.body, 'notebook');
    return {
      statusCode: 201,
      body: options.providerRuntime.notebooks.create(
        decodeURIComponent(notebookDetailMatch[1]),
        typeof record['title'] === 'string' ? record['title'] : undefined,
      ),
    };
  }
  if (method === 'PATCH' && notebookDetailMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const notebookId = decodeURIComponent(notebookDetailMatch[1]);
    const record = bodyRecord(request.body ?? {}, 'notebook update');
    if (typeof record['title'] !== 'string') {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Notebook update requires title');
    }
    return {
      statusCode: 200,
      body: options.providerRuntime.notebooks.rename(notebookId, record['title']),
    };
  }
  if (method === 'DELETE' && notebookDetailMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const notebookId = decodeURIComponent(notebookDetailMatch[1]);
    const record = bodyRecord(request.body ?? {}, 'notebook delete');
    requireLocalConfirmation(
      options,
      { kind: 'notebook.delete', notebookId },
      record['confirmationId'],
    );
    const removed = options.providerRuntime.notebooks.delete(notebookId);
    return {
      statusCode: removed ? 200 : 404,
      body: removed ? { notebookId, deleted: true } : { error: 'notebook_not_found' },
    };
  }
  if (method === 'GET' && path === '/v1/data/connections') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    return { statusCode: 200, body: await options.providerRuntime.data.listConnections() };
  }
  if (method === 'GET' && path === '/v1/data/sources') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    return { statusCode: 200, body: await options.providerRuntime.data.listSources() };
  }
  const dataSourceMatch = /^\/v1\/data\/sources\/([^/]+)$/.exec(path);
  if (method === 'GET' && dataSourceMatch?.[1] !== undefined) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const source = await options.providerRuntime.data.getSource(
      decodeURIComponent(dataSourceMatch[1]),
    );
    return {
      statusCode: source === undefined ? 404 : 200,
      body: source ?? { error: 'data_source_not_found' },
    };
  }
  if (method === 'POST' && path === '/v1/data/connections') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const record = bodyRecord(request.body, 'data connection');
    const kind = record['kind'];
    if (kind !== 'memory' && kind !== 'file' && kind !== 'sql' && kind !== 'connector') {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'data connection kind is invalid');
    }
    const source = optionalQuerySource(record, 'source');
    const schema = record['schema'];
    const connection: DataConnectionInputV1 = {
      connectionId: requiredString(record, 'connectionId'),
      name: requiredString(record, 'name'),
      kind,
      ...(typeof record['connectorId'] === 'string' ? { connectorId: record['connectorId'] } : {}),
      ...(typeof record['credentialRef'] === 'string'
        ? { credentialRef: record['credentialRef'] }
        : {}),
      ...(typeof record['path'] === 'string' ? { path: record['path'] } : {}),
      ...(typeof record['tableName'] === 'string' ? { tableName: record['tableName'] } : {}),
      ...(typeof record['sourceId'] === 'string' ? { sourceId: record['sourceId'] } : {}),
      ...(typeof record['sourceReference'] === 'string'
        ? { sourceReference: record['sourceReference'] }
        : {}),
      ...(schema === undefined
        ? {}
        : { schema: schema as NonNullable<DataConnectionInputV1['schema']> }),
      ...(source === undefined ? {} : { source }),
    };
    return {
      statusCode: 201,
      body: await options.providerRuntime.data.registerConnection(connection),
    };
  }
  const dataConnectionMatch =
    /^\/v1\/data\/connections\/([^/]+)(?:\/(test|schema|bind-credential|revoke-credential|reauthorize))?$/.exec(
      path,
    );
  if (dataConnectionMatch?.[1] !== undefined) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const connectionId = decodeURIComponent(dataConnectionMatch[1]);
    const action = dataConnectionMatch[2];
    if (method === 'GET' && action === undefined) {
      const connection = await options.providerRuntime.data.getConnection(connectionId);
      return {
        statusCode: connection === undefined ? 404 : 200,
        body: connection ?? { error: 'data_connection_not_found' },
      };
    }
    if (method === 'DELETE' && action === undefined) {
      assertLicensed(options);
      const removed = await options.providerRuntime.data.removeConnection(connectionId);
      return {
        statusCode: removed ? 200 : 404,
        body: removed ? { connectionId, removed: true } : { error: 'data_connection_not_found' },
      };
    }
    if (method === 'POST' && action === 'test') {
      assertLicensed(options);
      return {
        statusCode: 200,
        body: await options.providerRuntime.data.testConnection(connectionId),
      };
    }
    if (method === 'POST' && action === 'bind-credential') {
      assertLicensed(options);
      const record = bodyRecord(request.body, 'data credential binding');
      return {
        statusCode: 200,
        body: await options.providerRuntime.data.bindCredential(
          connectionId,
          requiredString(record, 'credentialRef'),
        ),
      };
    }
    if (method === 'POST' && action === 'revoke-credential') {
      assertLicensed(options);
      return {
        statusCode: 200,
        body: await options.providerRuntime.data.revokeCredential(connectionId),
      };
    }
    if (method === 'POST' && action === 'reauthorize') {
      assertLicensed(options);
      const record = bodyRecord(request.body ?? {}, 'data credential reauthorization');
      return {
        statusCode: 200,
        body: await options.providerRuntime.data.reauthorizeCredential(
          connectionId,
          typeof record['credentialRef'] === 'string' ? record['credentialRef'] : undefined,
        ),
      };
    }
    if (method === 'GET' && action === 'schema') {
      return {
        statusCode: 200,
        body: await options.providerRuntime.data.browseSchema(connectionId),
      };
    }
  }
  if (method === 'GET' && path === '/v1/datasets/local') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const datasetId = new URL(rawPath, 'http://local').searchParams.get('datasetId') ?? undefined;
    return {
      statusCode: 200,
      body: await options.providerRuntime.data.listDatasetVersions(datasetId),
    };
  }
  if (method === 'POST' && path === '/v1/datasets/local/versions') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const record = bodyRecord(request.body, 'dataset version');
    const source = optionalQuerySource(record, 'source');
    const lineage = record['lineage'];
    if (
      lineage !== undefined &&
      (!Array.isArray(lineage) || lineage.some((item) => !isJsonValue(item)))
    ) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'lineage must be an array of JSON values');
    }
    const lineageInput =
      lineage === undefined
        ? undefined
        : (lineage as NonNullable<DatasetVersionInputV1['lineage']>);
    const input: DatasetVersionInputV1 = {
      datasetId: requiredString(record, 'datasetId'),
      name: requiredString(record, 'name'),
      connectionId: requiredString(record, 'connectionId'),
      sourceReference: requiredString(record, 'sourceReference'),
      ...(typeof record['mediaType'] === 'string' ? { mediaType: record['mediaType'] } : {}),
      ...(source === undefined ? {} : { source }),
      ...(lineageInput === undefined ? {} : { lineage: lineageInput }),
    };
    return {
      statusCode: 201,
      body: await options.providerRuntime.data.publishDatasetVersion(input),
    };
  }
  const datasetAnalysisMatch = /^\/v1\/datasets\/local\/([^/]+)\/(profile|quality)$/.exec(path);
  if ((method === 'GET' || method === 'POST') && datasetAnalysisMatch?.[1] !== undefined) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const datasetId = decodeURIComponent(datasetAnalysisMatch[1]);
    const action = datasetAnalysisMatch[2];
    if (method === 'POST') assertLicensed(options);
    const record = method === 'POST' ? bodyRecord(request.body ?? {}, 'dataset analysis') : {};
    const queryVersion = new URL(rawPath, 'http://local').searchParams.get('version');
    const versionValue =
      record['version'] ?? (queryVersion === null ? undefined : Number.parseInt(queryVersion, 10));
    if (
      versionValue !== undefined &&
      (!Number.isSafeInteger(versionValue) || (versionValue as number) < 1)
    ) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'version must be a positive integer');
    }
    if (method === 'GET') {
      const result =
        action === 'profile'
          ? await options.providerRuntime.data.getDatasetProfile(
              datasetId,
              versionValue === undefined ? undefined : (versionValue as number),
            )
          : await options.providerRuntime.data.getDatasetQuality(
              datasetId,
              versionValue === undefined ? undefined : (versionValue as number),
            );
      return {
        statusCode: result === undefined ? 404 : 200,
        body: result ?? { error: `dataset_${action}_not_found` },
      };
    }
    if (action === 'profile') {
      return {
        statusCode: 200,
        body: await options.providerRuntime.data.profileDataset(
          datasetId,
          versionValue === undefined ? undefined : (versionValue as number),
        ),
      };
    }
    const requiredFieldsValue = record['requiredFields'];
    if (
      requiredFieldsValue !== undefined &&
      (!Array.isArray(requiredFieldsValue) ||
        requiredFieldsValue.some((field) => typeof field !== 'string'))
    ) {
      throw runtimeError(
        'VALIDATION_SCHEMA_MISMATCH',
        'requiredFields must be an array of strings',
      );
    }
    const maxNullFraction = record['maxNullFraction'];
    if (
      maxNullFraction !== undefined &&
      (typeof maxNullFraction !== 'number' ||
        !Number.isFinite(maxNullFraction) ||
        maxNullFraction < 0 ||
        maxNullFraction > 1)
    ) {
      throw runtimeError(
        'VALIDATION_SCHEMA_MISMATCH',
        'maxNullFraction must be a number between 0 and 1',
      );
    }
    const qualityRequest: DataQualityRequestV1 = {
      datasetId,
      ...(versionValue === undefined ? {} : { datasetVersion: versionValue as number }),
      ...(requiredFieldsValue === undefined
        ? {}
        : { requiredFields: requiredFieldsValue as string[] }),
      ...(maxNullFraction === undefined ? {} : { maxNullFraction: maxNullFraction as number }),
    };
    return {
      statusCode: 200,
      body: await options.providerRuntime.data.qualityDataset(qualityRequest),
    };
  }
  const datasetLocalMatch = /^\/v1\/datasets\/local\/([^/]+)(?:\/(lineage))?$/.exec(path);
  if (
    method === 'GET' &&
    datasetLocalMatch?.[1] !== undefined &&
    datasetLocalMatch[1] !== 'queries'
  ) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const datasetId = decodeURIComponent(datasetLocalMatch[1]);
    const versionValue = new URL(rawPath, 'http://local').searchParams.get('version');
    const version = versionValue === null ? undefined : Number.parseInt(versionValue, 10);
    if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) {
      throw runtimeError(
        'VALIDATION_SCHEMA_MISMATCH',
        'dataset version must be a positive integer',
      );
    }
    if (datasetLocalMatch[2] === 'lineage') {
      return {
        statusCode: 200,
        body: await options.providerRuntime.data.lineage(datasetId, version),
      };
    }
    const dataset = await options.providerRuntime.data.getDatasetVersion(datasetId, version);
    return {
      statusCode: dataset === undefined ? 404 : 200,
      body: dataset ?? { error: 'dataset_version_not_found' },
    };
  }
  if (method === 'POST' && path === '/v1/datasets/local/query') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const record = bodyRecord(request.body, 'dataset query');
    const parametersValue = record['parameters'];
    let parameters: Record<string, JsonPrimitive> | undefined;
    if (parametersValue !== undefined) {
      const parameterRecord = bodyRecord(parametersValue, 'dataset query parameters');
      parameters = {};
      for (const [key, value] of Object.entries(parameterRecord)) {
        if (
          value !== null &&
          typeof value !== 'string' &&
          typeof value !== 'number' &&
          typeof value !== 'boolean'
        ) {
          throw runtimeError(
            'VALIDATION_SCHEMA_MISMATCH',
            `Query parameter ${key} must be primitive`,
          );
        }
        parameters[key] = value as JsonPrimitive;
      }
    }
    const source = optionalQuerySource(record, 'source');
    const versionValue = record['datasetVersion'];
    if (
      versionValue !== undefined &&
      (!Number.isSafeInteger(versionValue) || (versionValue as number) < 1)
    ) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'datasetVersion must be a positive integer');
    }
    return {
      statusCode: 200,
      body: await options.providerRuntime.data.executeQuery({
        queryId: requiredString(record, 'queryId'),
        sql: requiredString(record, 'sql'),
        ...(typeof record['connectionId'] === 'string'
          ? { connectionId: record['connectionId'] }
          : {}),
        ...(typeof record['datasetId'] === 'string' ? { datasetId: record['datasetId'] } : {}),
        ...(versionValue === undefined ? {} : { datasetVersion: versionValue as number }),
        ...(parameters === undefined ? {} : { parameters }),
        ...(source === undefined ? {} : { source }),
        ...(Number.isSafeInteger(record['maxRows'])
          ? { maxRows: record['maxRows'] as number }
          : {}),
        ...(Number.isSafeInteger(record['timeoutMs'])
          ? { timeoutMs: record['timeoutMs'] as number }
          : {}),
        ...(Number.isSafeInteger(record['costLimit'])
          ? { costLimit: record['costLimit'] as number }
          : {}),
        ...(typeof record['savedQueryId'] === 'string'
          ? { savedQueryId: record['savedQueryId'] }
          : {}),
      }),
    };
  }
  if (method === 'GET' && path === '/v1/datasets/local/queries') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    return { statusCode: 200, body: await options.providerRuntime.data.listQueries() };
  }
  const datasetQueryMatch = /^\/v1\/datasets\/local\/queries\/([^/]+)$/.exec(path);
  if (method === 'GET' && datasetQueryMatch?.[1] !== undefined) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const query = await options.providerRuntime.data.getQueryResult(
      decodeURIComponent(datasetQueryMatch[1]),
    );
    return {
      statusCode: query === undefined ? 404 : 200,
      body: query ?? { error: 'dataset_query_not_found' },
    };
  }
  if (path === '/v1/data/queries' && method === 'GET') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    return { statusCode: 200, body: await options.providerRuntime.data.listQueries() };
  }
  if (path === '/v1/data/queries' && method === 'POST') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const record = bodyRecord(request.body, 'data query');
    const parameters = optionalQueryParameters(record['parameters'], 'data query parameters');
    const source = optionalQuerySource(record, 'source');
    const maxRows = record['maxRows'];
    const timeoutMs = record['timeoutMs'];
    const costLimit = record['costLimit'];
    if (maxRows !== undefined && (!Number.isSafeInteger(maxRows) || (maxRows as number) < 1)) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'maxRows must be a positive integer');
    }
    if (
      timeoutMs !== undefined &&
      (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 100)
    ) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'timeoutMs must be at least 100ms');
    }
    if (
      costLimit !== undefined &&
      (!Number.isSafeInteger(costLimit) || (costLimit as number) < 1)
    ) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'costLimit must be a positive integer');
    }
    return {
      statusCode: 200,
      body: await options.providerRuntime.data.executeQuery({
        queryId: requiredString(record, 'queryId'),
        sql: requiredString(record, 'sql'),
        ...(typeof record['connectionId'] === 'string'
          ? { connectionId: record['connectionId'] }
          : {}),
        ...(typeof record['datasetId'] === 'string' ? { datasetId: record['datasetId'] } : {}),
        ...(Number.isSafeInteger(record['datasetVersion'])
          ? { datasetVersion: record['datasetVersion'] as number }
          : {}),
        ...(typeof record['savedQueryId'] === 'string'
          ? { savedQueryId: record['savedQueryId'] }
          : {}),
        ...(parameters === undefined ? {} : { parameters }),
        ...(source === undefined ? {} : { source }),
        ...(maxRows === undefined ? {} : { maxRows: maxRows as number }),
        ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }),
        ...(costLimit === undefined ? {} : { costLimit: costLimit as number }),
      }),
    };
  }
  const dataQueryValidateMatch = /^\/v1\/data\/queries\/([^/]+)\/validate$/.exec(path);
  if (dataQueryValidateMatch?.[1] !== undefined && method === 'POST') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const record = bodyRecord(request.body, 'data query validation');
    return {
      statusCode: 200,
      body: options.providerRuntime.queries.validate(requiredString(record, 'sql')),
    };
  }
  const dataQueryActionMatch =
    /^\/v1\/data\/queries\/([^/]+)\/(cancel|explain|export|handoff)$/.exec(path);
  if (dataQueryActionMatch?.[1] !== undefined && method === 'POST') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const queryId = decodeURIComponent(dataQueryActionMatch[1]);
    const action = dataQueryActionMatch[2];
    if (action === 'cancel') {
      return {
        statusCode: 202,
        body: { queryId, cancelled: await options.providerRuntime.data.cancelQuery(queryId) },
      };
    }
    if (action === 'explain') {
      const record = bodyRecord(request.body, 'data query explain');
      const parameters = optionalQueryParameters(record['parameters'], 'data query parameters');
      const source = optionalQuerySource(record, 'source');
      return {
        statusCode: 200,
        body: await options.providerRuntime.data.explainQuery({
          queryId,
          sql: requiredString(record, 'sql'),
          ...(typeof record['connectionId'] === 'string'
            ? { connectionId: record['connectionId'] }
            : {}),
          ...(typeof record['datasetId'] === 'string' ? { datasetId: record['datasetId'] } : {}),
          ...(Number.isSafeInteger(record['datasetVersion'])
            ? { datasetVersion: record['datasetVersion'] as number }
            : {}),
          ...(parameters === undefined ? {} : { parameters }),
          ...(source === undefined ? {} : { source }),
        }),
      };
    }
    if (action === 'export') {
      const record = bodyRecord(request.body ?? {}, 'data query export');
      const format = record['format'] ?? 'json';
      if (format !== 'json' && format !== 'csv') {
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'format must be json or csv');
      }
      const destinationPath =
        record['destinationPath'] === undefined
          ? undefined
          : requiredString(record, 'destinationPath');
      return {
        statusCode: 201,
        body: await options.providerRuntime.data.exportQueryResult(
          queryId,
          format as DataExportFormat,
          destinationPath,
        ),
      };
    }
    const record = bodyRecord(request.body ?? {}, 'data query handoff');
    const target = record['target'] ?? 'browser';
    if (target !== 'browser' && target !== 'jupyter') {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'target must be browser or jupyter');
    }
    return {
      statusCode: 201,
      body: await options.providerRuntime.data.createQueryHandoff(
        queryId,
        target as DataHandoffTarget,
      ),
    };
  }
  const dataQueryDetailMatch = /^\/v1\/data\/queries\/([^/]+)$/.exec(path);
  if (dataQueryDetailMatch?.[1] !== undefined && method === 'GET') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const query = await options.providerRuntime.data.getQueryResult(
      decodeURIComponent(dataQueryDetailMatch[1]),
    );
    return {
      statusCode: query === undefined ? 404 : 200,
      body: query ?? { error: 'data_query_not_found' },
    };
  }
  if (path === '/v1/data/saved-queries' && method === 'GET') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    return { statusCode: 200, body: await options.providerRuntime.data.listSavedQueries() };
  }
  if (path === '/v1/data/saved-queries' && method === 'POST') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const record = bodyRecord(request.body, 'saved data query');
    const parameters = optionalQueryParameters(record['parameters'], 'saved query parameters');
    const input: DataSavedQueryInputV1 = {
      savedQueryId: requiredString(record, 'savedQueryId'),
      name: requiredString(record, 'name'),
      sql: requiredString(record, 'sql'),
      ...(typeof record['connectionId'] === 'string'
        ? { connectionId: record['connectionId'] }
        : {}),
      ...(typeof record['datasetId'] === 'string' ? { datasetId: record['datasetId'] } : {}),
      ...(Number.isSafeInteger(record['datasetVersion'])
        ? { datasetVersion: record['datasetVersion'] as number }
        : {}),
      ...(parameters === undefined ? {} : { parameters }),
      ...(Number.isSafeInteger(record['maxRows']) ? { maxRows: record['maxRows'] as number } : {}),
      ...(Number.isSafeInteger(record['timeoutMs'])
        ? { timeoutMs: record['timeoutMs'] as number }
        : {}),
      ...(Number.isSafeInteger(record['costLimit'])
        ? { costLimit: record['costLimit'] as number }
        : {}),
    };
    return { statusCode: 201, body: await options.providerRuntime.data.saveQuery(input) };
  }
  const savedQueryDetailMatch = /^\/v1\/data\/saved-queries\/([^/]+)$/.exec(path);
  if (savedQueryDetailMatch?.[1] !== undefined && method === 'GET') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const saved = await options.providerRuntime.data.getSavedQuery(
      decodeURIComponent(savedQueryDetailMatch[1]),
    );
    return {
      statusCode: saved === undefined ? 404 : 200,
      body: saved ?? { error: 'saved_data_query_not_found' },
    };
  }
  const queryValidateMatch = /^\/v1\/queries\/([^/]+)\/validate$/.exec(path);
  if (method === 'POST' && queryValidateMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const record = bodyRecord(request.body, 'query validation');
    return {
      statusCode: 200,
      body: options.providerRuntime.queries.validate(requiredString(record, 'sql')),
    };
  }
  const queryExecuteMatch = /^\/v1\/queries\/([^/]+)\/execute$/.exec(path);
  if (method === 'POST' && queryExecuteMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const record = bodyRecord(request.body, 'query execution');
    const parameterValue = record['parameters'];
    const parameters: Record<string, string | number | boolean | null> = {};
    if (parameterValue !== undefined) {
      const parameterRecord = bodyRecord(parameterValue, 'query parameters');
      for (const [key, value] of Object.entries(parameterRecord)) {
        if (
          value !== null &&
          typeof value !== 'string' &&
          typeof value !== 'number' &&
          typeof value !== 'boolean'
        ) {
          throw runtimeError(
            'VALIDATION_SCHEMA_MISMATCH',
            `Query parameter ${key} must be a primitive value`,
          );
        }
        parameters[key] = value as string | number | boolean | null;
      }
    }
    const sourceValue = record['source'];
    let source:
      | {
          tableName?: string;
          columns?: string[];
          rows: Array<readonly JsonValue[]> | Array<Record<string, JsonValue>>;
        }
      | undefined;
    if (sourceValue !== undefined) {
      const sourceRecord = bodyRecord(sourceValue, 'query source');
      const rowsValue = sourceRecord['rows'];
      if (!Array.isArray(rowsValue))
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Query source rows must be an array');
      const rows = rowsValue as Array<readonly JsonValue[]> | Array<Record<string, JsonValue>>;
      if (rows.some((row) => !Array.isArray(row) && (row === null || typeof row !== 'object'))) {
        throw runtimeError(
          'VALIDATION_SCHEMA_MISMATCH',
          'Query source rows must be arrays or objects',
        );
      }
      const columnsValue = sourceRecord['columns'];
      if (
        columnsValue !== undefined &&
        (!Array.isArray(columnsValue) || columnsValue.some((value) => typeof value !== 'string'))
      ) {
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Query source columns must be strings');
      }
      source = {
        rows,
        ...(typeof sourceRecord['tableName'] === 'string'
          ? { tableName: sourceRecord['tableName'] }
          : {}),
        ...(columnsValue === undefined ? {} : { columns: columnsValue as string[] }),
      };
    }
    const maxRows = record['maxRows'];
    const timeoutMs = record['timeoutMs'];
    const costLimit = record['costLimit'];
    if (maxRows !== undefined && (!Number.isSafeInteger(maxRows) || (maxRows as number) < 1)) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'maxRows must be a positive integer');
    }
    if (
      timeoutMs !== undefined &&
      (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 100)
    ) {
      throw runtimeError(
        'VALIDATION_SCHEMA_MISMATCH',
        'timeoutMs must be an integer of at least 100',
      );
    }
    if (
      costLimit !== undefined &&
      (!Number.isSafeInteger(costLimit) || (costLimit as number) < 1)
    ) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'costLimit must be a positive integer');
    }
    return {
      statusCode: 200,
      body: await options.providerRuntime.queries.execute({
        queryId: decodeURIComponent(queryExecuteMatch[1]),
        sql: requiredString(record, 'sql'),
        parameters,
        ...(source === undefined ? {} : { source }),
        ...(maxRows === undefined ? {} : { maxRows: maxRows as number }),
        ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }),
        ...(costLimit === undefined ? {} : { costLimit: costLimit as number }),
      }),
    };
  }
  const queryCancelMatch = /^\/v1\/queries\/([^/]+)\/cancel$/.exec(path);
  if (method === 'POST' && queryCancelMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    return {
      statusCode: 202,
      body: {
        queryId: decodeURIComponent(queryCancelMatch[1]),
        cancelled: options.providerRuntime.queries.cancel(decodeURIComponent(queryCancelMatch[1])),
      },
    };
  }
  const queryResultMatch = /^\/v1\/queries\/([^/]+)\/results$/.exec(path);
  if (method === 'GET' && queryResultMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const queryId = decodeURIComponent(queryResultMatch[1]);
    const result = options.providerRuntime.queries.result(queryId);
    return {
      statusCode: result === undefined ? 404 : 200,
      body: result ?? { error: 'query_result_not_found' },
    };
  }
  if (
    method === 'GET' &&
    (path === '/v1/connections/catalog' || path === '/v1/connectors/catalog')
  ) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const query = new URL(rawPath, 'http://local').searchParams;
    const limitValue = query.get('limit');
    const limit = limitValue === null ? undefined : Number.parseInt(limitValue, 10);
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'limit must be an integer from 1 to 100');
    }
    return {
      statusCode: 200,
      body: options.providerRuntime.connections.list({
        ...(query.get('query') === null ? {} : { query: query.get('query') ?? '' }),
        ...(query.get('category') === null ? {} : { category: query.get('category') ?? '' }),
        ...(query.get('cursor') === null ? {} : { cursor: query.get('cursor') ?? '' }),
        ...(limit === undefined ? {} : { limit }),
      }),
    };
  }
  const connectorDiscoveryMatch = /^\/v1\/connectors\/([^/]+)\/discover$/.exec(path);
  if ((method === 'GET' || method === 'POST') && connectorDiscoveryMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const connectorId = decodeURIComponent(connectorDiscoveryMatch[1]);
    const manifest = options.providerRuntime.connections.registry.require(connectorId);
    const requestRecord = method === 'POST' ? bodyRecord(request.body, 'connector discovery') : {};
    const queryConnectionId = new URL(rawPath, 'http://local').searchParams.get('connectionId');
    const connectionId =
      typeof requestRecord['connectionId'] === 'string'
        ? requestRecord['connectionId']
        : (queryConnectionId ?? undefined);
    if (manifest.runtimeAdapter === 'meltano' && connectionId !== undefined) {
      const resources = manifest.resources.map((resource) => resource.resourceId);
      return {
        statusCode: 200,
        body: await options.providerRuntime.connectors.discover({
          manifest,
          binding: {
            bindingId: `binding-${connectorId}-${connectionId}`,
            connectorId,
            connectionId,
            resources,
            createdAt: options.clock?.() ?? new Date().toISOString(),
            updatedAt: options.clock?.() ?? new Date().toISOString(),
          },
        }),
      };
    }
    return {
      statusCode: 200,
      body: options.providerRuntime.connections.discover(connectorId, connectionId),
    };
  }
  const connectorAuthMatch = /^\/v1\/connectors\/([^/]+)\/auth\/start$/.exec(path);
  if (method === 'POST' && connectorAuthMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const record = bodyRecord(request.body, 'connector authorization');
    const sessionId = session?.sessionId ?? options.localSession?.sessionId ?? 'local-session';
    return {
      statusCode: 200,
      body: await options.providerRuntime.oauth.start({
        connectorId: decodeURIComponent(connectorAuthMatch[1]),
        sessionId,
        redirectUri: requiredString(record, 'redirectUri'),
        returnTo: typeof record['returnTo'] === 'string' ? record['returnTo'] : '/connections',
      }),
    };
  }
  const connectorDetailMatch = /^\/v1\/connectors\/([^/]+)$/.exec(path);
  if (method === 'GET' && connectorDetailMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const connectorId = decodeURIComponent(connectorDetailMatch[1]);
    const entry = options.providerRuntime.connections.registry.get(connectorId);
    if (entry === undefined) return { statusCode: 404, body: { error: 'connector_not_found' } };
    const configured = options.providerRuntime.oauth
      .listConnections()
      .some(
        (connection) => connection.connectorId === connectorId && connection.status === 'connected',
      );
    return { statusCode: 200, body: { ...entry, configured } };
  }
  if (method === 'GET' && path === '/v1/connector-runs') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    return { statusCode: 200, body: options.providerRuntime.connectors.listRuns() };
  }
  if (method === 'GET' && path === '/v1/connector-checkpoints') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    return { statusCode: 200, body: options.providerRuntime.connectors.listCheckpoints() };
  }
  if (method === 'GET' && path === '/v1/connector-schema-events') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    return { statusCode: 200, body: options.providerRuntime.connectors.listSchemaChangeEvents() };
  }
  const connectorCheckpointMatch = /^\/v1\/connector-checkpoints\/([^/]+)$/.exec(path);
  if (method === 'GET' && connectorCheckpointMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const checkpoint = options.providerRuntime.connectors.getCheckpoint(
      decodeURIComponent(connectorCheckpointMatch[1]),
    );
    return {
      statusCode: checkpoint === undefined ? 404 : 200,
      body: checkpoint ?? { error: 'connector_checkpoint_not_found' },
    };
  }
  if (method === 'POST' && path === '/v1/connector-runs') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const record = bodyRecord(request.body, 'connector run');
    const connectorId = requiredString(record, 'connectorId');
    const connectionId = requiredString(record, 'connectionId');
    const operation = requiredString(record, 'operation');
    const manifest = options.providerRuntime.connections.registry.require(connectorId);
    const checkpointId =
      typeof record['checkpointId'] === 'string' ? record['checkpointId'] : undefined;
    const checkpoint =
      checkpointId === undefined
        ? undefined
        : options.providerRuntime.connectors.getCheckpoint(checkpointId);
    if (checkpointId !== undefined && checkpoint === undefined) {
      throw runtimeError(
        'ARTIFACT_NOT_FOUND',
        `Connector checkpoint ${checkpointId} was not found`,
      );
    }
    const resourceValue = record['resources'];
    const resources =
      resourceValue === undefined
        ? manifest.resources.map((resource) => resource.resourceId)
        : stringArray(resourceValue, 'resources');
    const schemaSelection = record['schemaSelection'];
    const selectedSchemas =
      schemaSelection === undefined ? undefined : stringArray(schemaSelection, 'schemaSelection');
    const syncMode = record['syncMode'];
    if (syncMode !== undefined && syncMode !== 'full' && syncMode !== 'incremental') {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'syncMode must be full or incremental');
    }
    const destination =
      typeof record['destination'] === 'string' ? record['destination'] : undefined;
    return {
      statusCode: 202,
      body: await options.providerRuntime.connectors.execute({
        manifest,
        binding: {
          bindingId: `binding-${connectorId}-${connectionId}`,
          connectorId,
          connectionId,
          resources,
          ...(selectedSchemas === undefined ? {} : { schemaSelection: selectedSchemas }),
          ...(syncMode === 'full' || syncMode === 'incremental' ? { syncMode } : {}),
          ...(destination === undefined ? {} : { destination }),
          createdAt: options.clock?.() ?? new Date().toISOString(),
          updatedAt: options.clock?.() ?? new Date().toISOString(),
        },
        operation,
        ...(typeof record['idempotencyKey'] === 'string'
          ? { idempotencyKey: record['idempotencyKey'] }
          : {}),
        ...(checkpoint === undefined ? {} : { checkpoint }),
      }),
    };
  }
  const connectorRunCancelMatch = /^\/v1\/connector-runs\/([^/]+)\/cancel$/.exec(path);
  if (method === 'POST' && connectorRunCancelMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    assertLicensed(options);
    const runId = decodeURIComponent(connectorRunCancelMatch[1]);
    await options.providerRuntime.connectors.cancel(runId);
    return { statusCode: 202, body: { runId, cancelled: true } };
  }
  const connectorRunDetailMatch = /^\/v1\/connector-runs\/([^/]+)$/.exec(path);
  if (method === 'GET' && connectorRunDetailMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const runId = decodeURIComponent(connectorRunDetailMatch[1]);
    const run = options.providerRuntime.connectors.getRun(runId);
    return {
      statusCode: run === undefined ? 404 : 200,
      body: run ?? { error: 'connector_run_not_found' },
    };
  }
  if (method === 'POST' && path === '/v1/connections/setup') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const record = bodyRecord(request.body, 'connection setup');
    const configRecord = bodyRecord(record['config'], 'connection configuration');
    const config: Record<string, string> = {};
    for (const [key, value] of Object.entries(configRecord)) {
      if (typeof value !== 'string') {
        throw runtimeError(
          'VALIDATION_SCHEMA_MISMATCH',
          `Connection field ${key} must be a string`,
        );
      }
      config[key] = value;
    }
    return {
      statusCode: 201,
      body: await options.providerRuntime.connections.setup({
        connectorId: requiredString(record, 'connectorId'),
        config,
        ...(typeof record['accountLabel'] === 'string'
          ? { accountLabel: record['accountLabel'] }
          : {}),
      }),
    };
  }
  const connectionTestMatch = /^\/v1\/connections\/([^/]+)\/test$/.exec(path);
  if (method === 'POST' && connectionTestMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    return {
      statusCode: 200,
      body: await options.providerRuntime.connections.test(connectionTestMatch[1]),
    };
  }
  if (method === 'POST' && path === '/v1/oauth/start') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const record = bodyRecord(request.body, 'OAuth start');
    const sessionId = session?.sessionId ?? options.localSession?.sessionId ?? 'local-session';
    return {
      statusCode: 200,
      body: await options.providerRuntime.oauth.start({
        connectorId: requiredString(record, 'connectorId'),
        sessionId,
        redirectUri: requiredString(record, 'redirectUri'),
        returnTo: typeof record['returnTo'] === 'string' ? record['returnTo'] : '/connections',
      }),
    };
  }
  if (method === 'GET' && path === '/v1/oauth/callback') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const query = new URL(rawPath, 'http://local').searchParams;
    const callback: { state: string; code?: string; error?: string; errorDescription?: string } = {
      state: query.get('state') ?? '',
    };
    const code = query.get('code');
    const error = query.get('error');
    const errorDescription = query.get('error_description');
    if (code !== null) callback.code = code;
    if (error !== null) callback.error = error;
    if (errorDescription !== null) callback.errorDescription = errorDescription;
    const result = await options.providerRuntime.oauth.complete(callback);
    options.providerRuntime.catalog.connect(
      result.connection.connectorId,
      result.connection.connectionId,
    );
    const callbackBody = { connected: true, connectionId: result.connection.connectionId };
    const acceptsJson = request.headers?.['accept']?.includes('application/json') === true;
    return acceptsJson
      ? { statusCode: 200, body: callbackBody }
      : { statusCode: 302, headers: { location: result.returnTo }, body: callbackBody };
  }
  const connectionMatch = /^\/v1\/connections\/([^/]+)\/revoke$/.exec(path);
  if (method === 'POST' && connectionMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    await options.providerRuntime.oauth.revoke(connectionMatch[1]);
    const connection = options.providerRuntime.oauth
      .listConnections()
      .find((candidate) => candidate.connectionId === connectionMatch[1]);
    if (connection !== undefined) {
      options.providerRuntime.catalog.disconnect(connection.connectorId, connection.connectionId);
    }
    return { statusCode: 200, body: { revoked: true, connectionId: connectionMatch[1] } };
  }
  const connectionRefreshMatch = /^\/v1\/connections\/([^/]+)\/refresh$/.exec(path);
  if (method === 'POST' && connectionRefreshMatch?.[1]) {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const connection = await options.providerRuntime.oauth.refresh(connectionRefreshMatch[1]);
    options.providerRuntime.catalog.connect(connection.connectorId, connection.connectionId);
    return { statusCode: 200, body: connection };
  }
  if (method === 'POST' && path === '/v1/speech/transcriptions') {
    if (options.providerRuntime === undefined) {
      return { statusCode: 501, body: { error: 'provider_runtime_not_configured' } };
    }
    const record = bodyRecord(request.body, 'speech transcription');
    return {
      statusCode: 200,
      body: await options.providerRuntime.speech.transcribe({
        audio: requiredBase64(record, 'audioBase64'),
        mimeType: requiredString(record, 'mimeType'),
        ...(typeof record['language'] === 'string' ? { language: record['language'] } : {}),
      }),
    };
  }
  if (method === 'GET' && path === '/v1/runs') {
    const coordinator = universalRunCoordinator(options);
    if (coordinator !== undefined) {
      const query = new URL(rawPath, 'http://local').searchParams;
      const projectId = query.get('projectId');
      const runs = await coordinator.list(options.tenant);
      return {
        statusCode: 200,
        body: {
          runs:
            projectId === null
              ? runs
              : runs.filter((run) => run.projectId === pathId(projectId, 'projectId')),
        },
      };
    }
    if (options.conversation === undefined) {
      return { statusCode: 501, body: { error: 'agent_conversation_not_configured' } };
    }
    const query = new URL(rawPath, 'http://local').searchParams;
    const projectId = query.get('projectId');
    return {
      statusCode: 200,
      body: {
        runs: await options.conversation.listRuns(
          options.tenant,
          projectId === null ? undefined : pathId(projectId, 'projectId'),
        ),
      },
    };
  }
  const runLogsMatch = /^\/v1\/runs\/([^/]+)\/logs$/.exec(path);
  if (method === 'GET' && runLogsMatch?.[1] !== undefined) {
    const coordinator = universalRunCoordinator(options);
    if (coordinator !== undefined) {
      const detail = await coordinator.read(options.tenant, pathId(runLogsMatch[1], 'runId'));
      return { statusCode: 200, body: { runId: detail.run.runId, logs: detail.logs } };
    }
    if (options.conversation === undefined) {
      return { statusCode: 501, body: { error: 'agent_conversation_not_configured' } };
    }
    const detail = await options.conversation.readRun(
      options.tenant,
      pathId(runLogsMatch[1], 'runId'),
    );
    return { statusCode: 200, body: { runId: detail.run.runId, logs: detail.logs } };
  }
  const runActionMatch = /^\/v1\/runs\/([^/]+)\/(cancel|retry)$/.exec(path);
  if (method === 'POST' && runActionMatch?.[1] !== undefined && runActionMatch[2] !== undefined) {
    const coordinator = universalRunCoordinator(options);
    if (coordinator !== undefined) {
      const runId = pathId(runActionMatch[1], 'runId');
      const detail = await coordinator.read(options.tenant, runId);
      const actor =
        session?.actor ??
        options.localSession?.actor ??
        ({ actorId: options.tenant.tenantId, type: 'system', displayName: 'Local API' } as const);
      if (runActionMatch[2] === 'cancel') {
        const reason = optionalReason(request.body, 'run cancellation');
        if (
          detail.run.requestedAction === 'conversation.respond' &&
          options.conversation !== undefined
        ) {
          return {
            statusCode: 202,
            body: await options.conversation.cancel(
              options.tenant,
              detail.run.projectId ?? runId,
              reason,
            ),
          };
        }
        return {
          statusCode: 202,
          body: await coordinator.cancel(options.tenant, runId, actor, reason),
        };
      }
      if (
        detail.run.requestedAction === 'conversation.respond' &&
        options.conversation !== undefined
      ) {
        return {
          statusCode: 202,
          body: await options.conversation.retryRun(options.tenant, runId, actor),
        };
      }
      const retried = await coordinator.retry(options.tenant, runId, actor, async ({ request }) => {
        const replay = request.replay;
        if (replay === undefined) {
          throw runtimeError('RETRY_EXHAUSTED', 'The original API request is unavailable');
        }
        return handleLocalApiRequestCore(
          {
            method: replay.method,
            path: replay.path,
            body: replay.body,
            ...(replay.headers === undefined ? {} : { headers: replay.headers }),
          },
          options,
        );
      });
      return {
        statusCode: retried.statusCode,
        body: retried.body,
        ...(retried.headers === undefined ? {} : { headers: retried.headers }),
      };
    }
    if (options.conversation === undefined) {
      return { statusCode: 501, body: { error: 'agent_conversation_not_configured' } };
    }
    const runId = pathId(runActionMatch[1], 'runId');
    const detail = await options.conversation.readRun(options.tenant, runId);
    if (runActionMatch[2] === 'cancel') {
      const reason = optionalReason(request.body, 'run cancellation');
      return {
        statusCode: 202,
        body: await options.conversation.cancel(
          options.tenant,
          detail.run.projectId ?? runId,
          reason,
        ),
      };
    }
    const actor = session?.actor ?? options.localSession?.actor;
    if (actor === undefined) {
      throw runtimeError(
        'AUTHORITY_MISSING',
        'Run retry requires an authenticated platform session',
      );
    }
    return {
      statusCode: 202,
      body: await options.conversation.retryRun(options.tenant, runId, actor),
    };
  }
  const runMatch = /^\/v1\/runs\/([^/]+)$/.exec(path);
  if (method === 'GET' && runMatch?.[1] !== undefined) {
    const coordinator = universalRunCoordinator(options);
    if (coordinator !== undefined) {
      return {
        statusCode: 200,
        body: await coordinator.read(options.tenant, pathId(runMatch[1], 'runId')),
      };
    }
    if (options.conversation === undefined) {
      return { statusCode: 501, body: { error: 'agent_conversation_not_configured' } };
    }
    return {
      statusCode: 200,
      body: await options.conversation.readRun(options.tenant, pathId(runMatch[1], 'runId')),
    };
  }
  const agentSessionMatch = /^\/v1\/agent-sessions\/([^/]+)$/.exec(path);
  if (method === 'GET' && agentSessionMatch?.[1] !== undefined) {
    if (options.conversation === undefined) {
      return { statusCode: 501, body: { error: 'agent_conversation_not_configured' } };
    }
    return {
      statusCode: 200,
      body: await options.conversation.readSession(
        options.tenant,
        pathId(agentSessionMatch[1], 'sessionId'),
      ),
    };
  }
  const projectAgentSessionMatch = /^\/v1\/projects\/([^/]+)\/agent-session$/.exec(path);
  if (method === 'GET' && projectAgentSessionMatch?.[1] !== undefined) {
    if (options.conversation === undefined) {
      return { statusCode: 501, body: { error: 'agent_conversation_not_configured' } };
    }
    return {
      statusCode: 200,
      body: await options.conversation.readProjectSession(
        options.tenant,
        pathId(projectAgentSessionMatch[1], 'projectId'),
      ),
    };
  }
  const conversationMatch = /^\/v1\/projects\/([^/]+)\/conversation(?:\/messages)?$/.exec(path);
  if (method === 'GET' && conversationMatch?.[1]) {
    if (options.conversation === undefined) {
      return { statusCode: 501, body: { error: 'agent_conversation_not_configured' } };
    }
    return {
      statusCode: 200,
      body: await options.conversation.read(
        options.tenant,
        pathId(conversationMatch[1], 'projectId'),
      ),
    };
  }
  if (method === 'POST' && conversationMatch?.[1]) {
    if (options.conversation === undefined) {
      return { statusCode: 501, body: { error: 'agent_conversation_not_configured' } };
    }
    const record = bodyRecord(request.body, 'conversation message');
    const text = record['text'];
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'conversation message text is required');
    }
    if (text.length > 100_000) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'conversation message is too long');
    }
    const actor = session?.actor ?? options.localSession?.actor;
    if (actor === undefined) {
      throw runtimeError(
        'AUTHORITY_MISSING',
        'Conversation requires an authenticated platform session',
      );
    }
    const clientMessageId = record['clientMessageId'];
    if (
      clientMessageId !== undefined &&
      (typeof clientMessageId !== 'string' || !isId(clientMessageId))
    ) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'clientMessageId must be a UUIDv7 id');
    }
    const requestedSourceInterface =
      record['sourceInterface'] ?? headerValue(request, 'x-spyderbyte-interface');
    const sourceInterface =
      requestedSourceInterface === undefined
        ? undefined
        : conversationSourceInterface(requestedSourceInterface);
    const clientVersion =
      typeof record['clientVersion'] === 'string' ? record['clientVersion'] : undefined;
    const modelRecord = bodyRecord(record['model'], 'model selection');
    const rawProviderId = record['providerId'] ?? modelRecord['providerId'];
    const rawModelId = record['modelId'] ?? modelRecord['modelId'];
    if (
      (rawProviderId !== undefined && typeof rawProviderId !== 'string') ||
      (rawModelId !== undefined && typeof rawModelId !== 'string') ||
      (rawProviderId === undefined) !== (rawModelId === undefined)
    ) {
      throw runtimeError(
        'VALIDATION_SCHEMA_MISMATCH',
        'providerId and modelId must be supplied together for an explicit model selection',
      );
    }
    const providerId = typeof rawProviderId === 'string' ? rawProviderId : undefined;
    const modelId = typeof rawModelId === 'string' ? rawModelId : undefined;
    const approvalContext = record['approvalContext'];
    if (
      approvalContext !== undefined &&
      (approvalContext === null ||
        typeof approvalContext !== 'object' ||
        Array.isArray(approvalContext))
    ) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'approvalContext must be an object');
    }
    return {
      statusCode: 202,
      body: await options.conversation.send({
        tenant: options.tenant,
        projectId: pathId(conversationMatch[1], 'projectId'),
        actor,
        text: text.trim(),
        ...(typeof clientMessageId === 'string' ? { clientMessageId } : {}),
        ...(sourceInterface === undefined ? {} : { sourceInterface }),
        ...(clientVersion === undefined ? {} : { clientVersion }),
        ...(providerId === undefined || modelId === undefined
          ? {}
          : { modelOverride: { providerId, modelId } }),
        ...(approvalContext === undefined
          ? {}
          : {
              governanceApprovalContext: approvalContext as GovernanceApprovalContextV1,
            }),
      }),
    };
  }
  const conversationCancelMatch = /^\/v1\/conversations\/([^/]+)\/cancel$/.exec(path);
  if (method === 'POST' && conversationCancelMatch?.[1]) {
    if (options.conversation === undefined) {
      return { statusCode: 501, body: { error: 'agent_conversation_not_configured' } };
    }
    const reason = optionalReason(request.body, 'conversation cancellation');
    return {
      statusCode: 202,
      body: await options.conversation.cancel(
        options.tenant,
        pathId(conversationCancelMatch[1], 'conversationId'),
        reason,
      ),
    };
  }
  if (method === 'GET' && path === '/v1/workspace') {
    if (options.workspace === undefined) {
      return { statusCode: 501, body: { error: 'workspace_backend_not_configured' } };
    }
    return {
      statusCode: 200,
      body: {
        rootPath: options.workspace.rootPath,
        manifest: options.workspace.manifest,
        ...(options.workspaceContext === undefined
          ? {}
          : { workspaceContext: options.workspaceContext }),
        archiveFormat: 'agentic.workspace.archive.v1',
      },
    };
  }
  if (method === 'POST' && (path === '/v1/workspace/export' || path === '/v1/workspace/backup')) {
    if (options.workspace === undefined) {
      return { statusCode: 501, body: { error: 'workspace_backend_not_configured' } };
    }
    const record = bodyRecord(request.body, 'workspace export');
    const createArchive =
      path === '/v1/workspace/backup'
        ? (options.workspace.backupArchive ?? options.workspace.exportArchive)
        : options.workspace.exportArchive;
    return {
      statusCode: 201,
      body: await createArchive(requiredAbsolutePath(record, 'destinationPath')),
    };
  }
  if (method === 'POST' && path === '/v1/workspace/restore-preview') {
    if (options.workspace === undefined) {
      return { statusCode: 501, body: { error: 'workspace_backend_not_configured' } };
    }
    const record = bodyRecord(request.body, 'workspace restore preview');
    return {
      statusCode: 200,
      body: await options.workspace.previewRestore(
        requiredAbsolutePath(record, 'archivePath'),
        requiredAbsolutePath(record, 'destinationRoot'),
      ),
    };
  }
  if (method === 'POST' && path === '/v1/workspace/import') {
    if (options.workspace === undefined) {
      return { statusCode: 501, body: { error: 'workspace_backend_not_configured' } };
    }
    const record = bodyRecord(request.body, 'workspace import');
    return {
      statusCode: 201,
      body: await options.workspace.importArchive(
        requiredAbsolutePath(record, 'archivePath'),
        requiredAbsolutePath(record, 'destinationRoot'),
      ),
    };
  }
  if (method === 'POST' && path === '/v1/license/import') {
    if (options.licenseImport === undefined)
      return { statusCode: 501, body: { error: 'license_import_not_configured' } };
    if (request.body === undefined) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'License entitlement body is required');
    }
    await options.licenseImport(request.body);
    return {
      statusCode: 200,
      body:
        options.license === undefined
          ? { status: 'imported' }
          : { status: 'imported', license: options.license.status() },
    };
  }
  if (method === 'POST' && path === '/v1/artifacts/uploads') {
    assertLicensed(options);
    if (options.artifacts === undefined)
      return { statusCode: 501, body: { error: 'artifact_backend_not_configured' } };
    const record = bodyRecord(request.body, 'artifact upload');
    const content = record['content'];
    if (typeof content !== 'string') {
      throw runtimeError(
        'VALIDATION_SCHEMA_MISMATCH',
        'artifact upload.content must be a UTF-8 string',
      );
    }
    const mediaType = requiredString(record, 'mediaType');
    const sizeBytes = new TextEncoder().encode(content).byteLength;
    if (sizeBytes > MAX_LOCAL_ARTIFACT_UPLOAD_BYTES) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        `Artifact upload exceeds the ${MAX_LOCAL_ARTIFACT_UPLOAD_BYTES}-byte local limit`,
      );
    }
    const expectedContentHash = optionalHash(record, 'expectedContentHash');
    const nowValue = record['now'];
    const now =
      nowValue === undefined
        ? (options.clock?.() ?? new Date().toISOString())
        : typeof nowValue === 'string' && validateContract('UtcInstant', nowValue).valid
          ? nowValue
          : (() => {
              throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'now must be a UTC instant');
            })();
    const staged = await options.artifacts.stageUpload(
      options.tenant,
      content,
      mediaType,
      now,
      expectedContentHash,
    );
    return { statusCode: 201, body: staged };
  }
  if (method === 'POST' && (path === '/v1/commands' || path === '/v1/commands/plan')) {
    const command = validatedRuntimeCommand(request.body);
    if (!sameTenant(command.tenant, options.tenant))
      throw runtimeError(
        'AUTHORITY_SCOPE_VIOLATION',
        'API command tenant does not match the session tenant',
      );
    const projectCommand =
      command.commandType === 'CreateProject' ||
      command.commandType === 'UpdateProject' ||
      command.commandType === 'ArchiveProject' ||
      command.commandType === 'RestoreProject';
    if (!projectCommand) assertLicensed(options);
    if (path === '/v1/commands' && command.commandType === 'CancelRun') {
      const payload = bodyRecord(command.payload, 'CancelRun payload');
      const workflowId = payload['workflowId'];
      if (typeof workflowId !== 'string' || !isId(workflowId)) {
        throw runtimeError(
          'VALIDATION_INVALID_INPUT',
          'CancelRun payload.workflowId must be a UUIDv7 id',
        );
      }
      const reason =
        typeof payload['reason'] === 'string' ? payload['reason'] : 'cancelled by frontend';
      return {
        statusCode: 202,
        body: commandAcknowledgement(
          command,
          await options.orchestrator.cancel(options.tenant, workflowId, reason),
        ),
      };
    }
    if (path === '/v1/commands' && command.commandType === 'CancelProject') {
      const payload = bodyRecord(command.payload, 'CancelProject payload');
      const projectId = payload['projectId'];
      if (typeof projectId !== 'string' || !isId(projectId)) {
        throw runtimeError(
          'VALIDATION_INVALID_INPUT',
          'CancelProject payload.projectId must be a UUIDv7 id',
        );
      }
      const reason = typeof payload['reason'] === 'string' ? payload['reason'] : undefined;
      const workflows = await options.orchestrator.listWorkflowsByProject(
        options.tenant,
        projectId,
      );
      const active = workflows.filter(
        (workflow) => !['completed', 'failed', 'blocked', 'cancelled'].includes(workflow.state),
      );
      const cancelled = await Promise.all(
        active.map((workflow) =>
          options.orchestrator.cancel(options.tenant, workflow.workflowId, reason),
        ),
      );
      return {
        statusCode: 202,
        body: commandAcknowledgement(command, {
          projectId,
          workflowIds: active.map((workflow) => workflow.workflowId),
          cancelled: cancelled.length,
          status: active.length === 0 ? 'already_terminal' : 'cancel_requested',
        }),
      };
    }
    if (path === '/v1/commands' && options.productCommands?.supports(command.commandType)) {
      return {
        statusCode: 202,
        body: commandAcknowledgement(command, await options.productCommands.execute(command)),
      };
    }
    const result =
      path === '/v1/commands/plan'
        ? await options.orchestrator.plan(command)
        : await options.orchestrator.submit(command);
    return {
      statusCode: path === '/v1/commands/plan' ? 200 : 202,
      body: commandAcknowledgement(command, result),
    };
  }
  const approvalActionMatch = /^\/v1\/approvals\/([^/]+)\/(approve|reject|revoke)$/.exec(path);
  if (method === 'POST' && approvalActionMatch?.[1] && approvalActionMatch[2]) {
    if (options.workspaceContext?.mode === 'personal_local') {
      return { statusCode: 404, body: { error: 'organization_surface_not_available' } };
    }
    assertLicensed(options);
    const session = options.approvals;
    if (session === undefined)
      return { statusCode: 501, body: { error: 'approvals_not_configured' } };
    const approvalId = pathId(approvalActionMatch[1], 'approvalId');
    const reason = optionalReason(request.body, 'approval request');
    const now = session.clock?.() ?? options.clock?.() ?? new Date().toISOString();
    const action = approvalActionMatch[2];
    const approval = session.service.get(options.tenant, approvalId);
    if (approval === undefined) {
      throw runtimeError('APPROVAL_INVALIDATED', `Approval ${approvalId} was not found`);
    }
    const authority =
      session.authorityFor?.({
        approval,
        actor: session.actor,
        action: action === 'revoke' ? 'revoke' : 'decide',
        now,
      }) ?? session.authority;
    if (authority === undefined) {
      throw runtimeError('AUTHORITY_MISSING', 'Approval decision authority is not configured');
    }
    if (action === 'revoke') {
      return {
        statusCode: 202,
        body: session.service.revoke(options.tenant, approvalId, authority, now, reason),
      };
    }
    return {
      statusCode: 202,
      body: session.service.decide(
        options.tenant,
        approvalId,
        action === 'approve' ? 'approved' : 'rejected',
        session.actor,
        authority,
        now,
        reason,
      ),
    };
  }
  if (method === 'GET' && path === '/v1/approvals') {
    if (options.workspaceContext?.mode === 'personal_local') {
      return { statusCode: 404, body: { error: 'organization_surface_not_available' } };
    }
    if (options.approvals === undefined)
      return { statusCode: 501, body: { error: 'approvals_not_configured' } };
    const approvals = options.approvals.service.list(options.tenant);
    const pagination = parsePagination(rawPath);
    return {
      statusCode: 200,
      body: pagination === undefined ? approvals : paginate(approvals, pagination),
    };
  }
  const projectionMatch = /^\/v1\/projections\/([^/]+)$/.exec(path);
  if (method === 'GET' && projectionMatch?.[1]) {
    if (options.projections === undefined)
      return { statusCode: 501, body: { error: 'projection_backend_not_configured' } };
    const projectionName = projectionMatch[1];
    if (!projectionNames.has(projectionName)) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Unknown projection name');
    }
    if (!projectionEnabled(options, projectionName)) {
      return {
        statusCode: 501,
        body: {
          error: `Projection ${projectionName} is not enabled in this runtime`,
          code: 'PROJECTION_NOT_ENABLED',
        },
      };
    }
    return {
      statusCode: 200,
      body: await options.projections.read(options.tenant, projectionName),
    };
  }
  const workflowPlanMatch = /^\/v1\/workflows\/([^/]+)\/plan$/.exec(path);
  if (method === 'GET' && workflowPlanMatch?.[1]) {
    const workflowId = pathId(workflowPlanMatch[1], 'workflowId');
    const plan = await options.orchestrator.getWorkflowPlan(options.tenant, workflowId);
    return {
      statusCode: plan === undefined ? 404 : 200,
      body: plan ?? { error: 'workflow_not_found' },
    };
  }
  const workflowRunMatch = /^\/v1\/workflows\/([^/]+)\/run$/.exec(path);
  if (method === 'POST' && workflowRunMatch?.[1]) {
    assertLicensed(options);
    bodyRecord(request.body, 'workflow run');
    return {
      statusCode: 202,
      body: await options.orchestrator.runPlanned(
        options.tenant,
        pathId(workflowRunMatch[1], 'workflowId'),
      ),
    };
  }
  const workflowInvocationsMatch = /^\/v1\/workflows\/([^/]+)\/invocations$/.exec(path);
  if (method === 'GET' && workflowInvocationsMatch?.[1]) {
    const workflowId = pathId(workflowInvocationsMatch[1], 'workflowId');
    const invocations = await options.orchestrator.listWorkflowInvocations(
      options.tenant,
      workflowId,
    );
    const pagination = parsePagination(rawPath);
    return {
      statusCode: invocations === undefined ? 404 : 200,
      body:
        invocations === undefined
          ? { error: 'workflow_not_found' }
          : pagination === undefined
            ? invocations
            : paginate(invocations, pagination),
    };
  }
  const cancelMatch = /^\/v1\/workflows\/([^/]+)\/cancel$/.exec(path);
  if (method === 'POST' && cancelMatch?.[1]) {
    assertLicensed(options);
    const body =
      request.body !== null && typeof request.body === 'object'
        ? (request.body as Record<string, unknown>)
        : {};
    const reason = typeof body['reason'] === 'string' ? body['reason'] : undefined;
    return {
      statusCode: 202,
      body: await options.orchestrator.cancel(
        options.tenant,
        pathId(cancelMatch[1], 'workflowId'),
        reason,
      ),
    };
  }
  const workflowMatch = /^\/v1\/workflows\/([^/]+)$/.exec(path);
  if (method === 'GET' && workflowMatch?.[1]) {
    const workflow = await options.orchestrator.getWorkflow(
      options.tenant,
      pathId(workflowMatch[1], 'workflowId'),
    );
    return { statusCode: workflow ? 200 : 404, body: workflow ?? { error: 'workflow_not_found' } };
  }
  const eventsMatch = /^\/v1\/workflows\/([^/]+)\/events$/.exec(path);
  if (method === 'GET' && eventsMatch?.[1]) {
    const events = await options.orchestrator.listEvents(
      options.tenant,
      pathId(eventsMatch[1], 'workflowId'),
    );
    const pagination = parsePagination(rawPath);
    return {
      statusCode: 200,
      body: pagination === undefined ? events : paginate(events, pagination),
    };
  }
  const invocationMatch = /^\/v1\/invocations\/([^/]+)$/.exec(path);
  if (method === 'GET' && invocationMatch?.[1]) {
    const invocation = await options.orchestrator.getInvocation(
      options.tenant,
      pathId(invocationMatch[1], 'invocationId'),
    );
    return {
      statusCode: invocation === undefined ? 404 : 200,
      body: invocation ?? { error: 'invocation_not_found' },
    };
  }
  const artifactLineageMatch = /^\/v1\/artifacts\/([^/]+)\/lineage$/.exec(path);
  const artifactDiffMatch = /^\/v1\/artifacts\/([^/]+)\/diff$/.exec(path);
  if (method === 'GET' && artifactDiffMatch?.[1]) {
    const artifactId = pathId(artifactDiffMatch[1], 'artifactId');
    const current = await options.orchestrator.getCurrentArtifact(options.tenant, artifactId);
    if (current === undefined) return { statusCode: 404, body: { error: 'artifact_not_found' } };
    const query = new URL(rawPath, 'http://local').searchParams;
    const parseVersion = (key: string): number | undefined => {
      const value = query.get(key);
      if (value === null) return undefined;
      const version = Number(value);
      if (!Number.isSafeInteger(version) || version < 1) {
        throw runtimeError('VALIDATION_INVALID_INPUT', `${key} must be a positive integer`);
      }
      return version;
    };
    const toVersion = parseVersion('toVersion') ?? current.reference.version;
    const fromVersion = parseVersion('fromVersion') ?? (toVersion > 1 ? toVersion - 1 : undefined);
    if (fromVersion !== undefined && fromVersion >= toVersion) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'fromVersion must be older than toVersion');
    }
    const target = await options.orchestrator.getArtifact(options.tenant, artifactId, toVersion);
    const after = await options.orchestrator.readArtifactContent(
      options.tenant,
      artifactId,
      toVersion,
    );
    const before =
      fromVersion === undefined
        ? undefined
        : await options.orchestrator.readArtifactContent(options.tenant, artifactId, fromVersion);
    return {
      statusCode: 200,
      body: createStructuredArtifactDiff({
        artifactId,
        ...(fromVersion === undefined ? {} : { fromVersion }),
        toVersion,
        mediaType: target.reference.mediaType,
        ...(before === undefined ? {} : { before }),
        after,
      }),
    };
  }
  if (method === 'GET' && path === '/v1/artifacts') {
    return {
      statusCode: 200,
      body: { artifacts: await options.orchestrator.listCurrentArtifacts(options.tenant) },
    };
  }
  const artifactContentMatch = /^\/v1\/artifacts\/([^/]+)\/versions\/(\d+)\/content$/.exec(path);
  if (method === 'GET' && artifactContentMatch?.[1] && artifactContentMatch[2]) {
    const artifactId = pathId(artifactContentMatch[1], 'artifactId');
    const version = Number(artifactContentMatch[2]);
    if (!Number.isSafeInteger(version) || version < 1) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'artifact version must be a positive integer');
    }
    const artifact = await options.orchestrator.getArtifact(options.tenant, artifactId, version);
    const content = await options.orchestrator.readArtifactContent(
      options.tenant,
      artifactId,
      version,
    );
    if (content.byteLength > 10 * 1024 * 1024) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'Artifact content exceeds the 10 MiB local API read limit',
      );
    }
    return {
      statusCode: 200,
      body: {
        artifactId,
        version,
        mediaType: artifact.reference.mediaType,
        contentHash: artifact.reference.contentHash,
        contentBase64: Buffer.from(content).toString('base64'),
      },
    };
  }
  if (method === 'GET' && artifactLineageMatch?.[1]) {
    const artifactId = pathId(artifactLineageMatch[1], 'artifactId');
    const artifact = await options.orchestrator.getCurrentArtifact(options.tenant, artifactId);
    return {
      statusCode: artifact === undefined ? 404 : 200,
      body:
        artifact === undefined
          ? { error: 'artifact_not_found' }
          : (() => {
              const pagination = parsePagination(rawPath);
              return pagination === undefined
                ? artifact.lineage
                : paginate(artifact.lineage, pagination);
            })(),
    };
  }
  const artifactPublishMatch = /^\/v1\/artifacts\/([^/]+)\/versions$/.exec(path);
  if (method === 'POST' && artifactPublishMatch?.[1]) {
    assertLicensed(options);
    if (options.artifacts === undefined)
      return { statusCode: 501, body: { error: 'artifact_backend_not_configured' } };
    const record = bodyRecord(request.body, 'artifact publication');
    const artifactId = pathId(artifactPublishMatch[1], 'artifactId');
    const stagedUploadId = pathId(requiredString(record, 'stagedUploadId'), 'stagedUploadId');
    const mediaType = requiredString(record, 'mediaType');
    const createdByValue = record['createdBy'];
    const createdByValidation = validateContract('Actor', createdByValue);
    if (!createdByValidation.valid || createdByValidation.value === undefined) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'createdBy must be a valid actor');
    }
    const invocationId = optionalId(record, 'invocationId');
    const derivedFrom = optionalArtifactReferences(record, 'derivedFrom');
    const expectedParentVersion = optionalNonNegativeInteger(record, 'expectedParentVersion');
    const expectedContentHash = optionalHash(record, 'expectedContentHash');
    const schemaName = record['schemaName'];
    if (schemaName !== undefined && (typeof schemaName !== 'string' || schemaName.trim() === '')) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'schemaName must be a non-empty string');
    }
    const retentionUntil = record['retentionUntil'];
    if (retentionUntil !== undefined && !validateContract('UtcInstant', retentionUntil).valid) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'retentionUntil must be a UTC instant');
    }
    const allowAgentRebase = record['allowAgentRebase'];
    if (allowAgentRebase !== undefined && typeof allowAgentRebase !== 'boolean') {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'allowAgentRebase must be a boolean');
    }
    const nowValue = record['now'];
    const now =
      nowValue === undefined
        ? (options.clock?.() ?? new Date().toISOString())
        : typeof nowValue === 'string' && validateContract('UtcInstant', nowValue).valid
          ? nowValue
          : (() => {
              throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'now must be a UTC instant');
            })();
    return {
      statusCode: 201,
      body: await options.artifacts.publish({
        tenant: options.tenant,
        artifactId,
        stagedUploadId,
        mediaType,
        createdBy: createdByValidation.value,
        ...(invocationId !== undefined ? { invocationId } : {}),
        ...(derivedFrom !== undefined ? { derivedFrom } : {}),
        ...(expectedParentVersion !== undefined ? { expectedParentVersion } : {}),
        ...(schemaName !== undefined ? { schemaName: schemaName as string } : {}),
        ...(retentionUntil !== undefined ? { retentionUntil: retentionUntil as string } : {}),
        now,
        ...(expectedContentHash !== undefined ? { expectedContentHash } : {}),
        ...(allowAgentRebase !== undefined ? { allowAgentRebase } : {}),
      }),
    };
  }
  const artifactVersionsMatch = /^\/v1\/artifacts\/([^/]+)\/versions$/.exec(path);
  if (method === 'GET' && artifactVersionsMatch?.[1]) {
    const artifactId = pathId(artifactVersionsMatch[1], 'artifactId');
    const current = await options.orchestrator.getCurrentArtifact(options.tenant, artifactId);
    if (current === undefined) return { statusCode: 404, body: { error: 'artifact_not_found' } };
    const versions = await options.orchestrator.listArtifactVersions(options.tenant, artifactId);
    const pagination = parsePagination(rawPath);
    return {
      statusCode: 200,
      body: pagination === undefined ? versions : paginate(versions, pagination),
    };
  }
  const artifactCurrentMatch = /^\/v1\/artifacts\/([^/]+)$/.exec(path);
  if (method === 'GET' && artifactCurrentMatch?.[1]) {
    const artifact = await options.orchestrator.getCurrentArtifact(
      options.tenant,
      pathId(artifactCurrentMatch[1], 'artifactId'),
    );
    return {
      statusCode: artifact === undefined ? 404 : 200,
      body: artifact ?? { error: 'artifact_not_found' },
    };
  }
  const artifactMatch = /^\/v1\/artifacts\/([^/]+)\/versions\/(\d+)$/.exec(path);
  if (method === 'GET' && artifactMatch?.[1] && artifactMatch[2]) {
    const version = Number(artifactMatch[2]);
    if (!Number.isSafeInteger(version) || version < 1)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'artifact version must be a positive integer');
    const artifact = await options.orchestrator.getArtifact(
      options.tenant,
      pathId(artifactMatch[1], 'artifactId'),
      version,
    );
    return { statusCode: 200, body: artifact };
  }
  if (method === 'GET' && path === '/v1/agents') {
    const agents = options.orchestrator.listAgents();
    const pagination = parsePagination(rawPath);
    return {
      statusCode: 200,
      body: pagination === undefined ? agents : paginate(agents, pagination),
    };
  }
  const budgetMatch = /^\/v1\/budgets\/([^/]+)$/.exec(path);
  if (method === 'GET' && budgetMatch?.[1]) {
    if (options.budget === undefined)
      return { statusCode: 501, body: { error: 'budget_backend_not_configured' } };
    return {
      statusCode: 200,
      body: options.budget.snapshot(options.tenant, pathId(budgetMatch[1], 'budgetId')),
    };
  }
  if (method === 'GET' && path === '/v1/audit') {
    if (options.audit === undefined)
      return { statusCode: 501, body: { error: 'audit_backend_not_configured' } };
    const records = options.audit.list(options.tenant);
    const pagination = parsePagination(rawPath);
    return {
      statusCode: 200,
      body: pagination === undefined ? records : paginate(records, pagination),
    };
  }
  if (method === 'GET' && path === '/v1/subscriptions/events') {
    const gateway = subscriptionGateway(options);
    if (gateway === undefined)
      return { statusCode: 501, body: { error: 'subscription_backend_not_configured' } };
    return {
      statusCode: 200,
      body: await gateway.replay(subscriptionRequestFromPath(rawPath, options.tenant)),
    };
  }
  return { statusCode: 404, body: { error: 'route_not_found' } };
}

const projectionNames = new Set([
  'workflow-summary',
  'invocation-jobs',
  'artifact-catalog-lineage',
  'approval-queue',
  'budget-cost',
  'audit-timeline',
  'catalog-datasets',
  'model-lifecycle',
  'deployment-traffic',
  'connector-governance',
  'chat-sessions',
  'projects',
  'runs',
  'run-timeline',
  'run-metrics',
  'run-logs',
  'machine-state',
  'assets',
  'datasets',
  'queries',
  'visualizations',
  'automations',
  'connections',
  'environments',
  'settings',
  'profiles',
  'notifications',
  'governance',
  'usage',
  'repositories',
  'worktrees',
  'notebooks',
  'experiments',
  'incidents',
  'pipelines',
  'resources',
]);

function defaultCapabilities(options: LocalApiOptions): JsonValue {
  const projections = [...projectionNames].sort();
  const personalLocal = options.workspaceContext?.mode === 'personal_local';
  const commands = [
    'ValidateDataset',
    'CreateRun',
    'PlanRun',
    'CancelRun',
    'CancelProject',
    'CreateProject',
    'UpdateProject',
    'ArchiveProject',
    'RestoreProject',
    'CreateDataset',
    'UpdateDataset',
    'ArchiveDataset',
    'CreateQuery',
    'UpdateQuery',
    'ArchiveQuery',
    'RunQuery',
    'CancelQuery',
    'CreateVisualization',
    'UpdateVisualization',
    'ArchiveVisualization',
    'RefreshVisualization',
    'CreateAutomation',
    'UpdateAutomation',
    'PauseAutomation',
    'ResumeAutomation',
    'CreateNotebook',
    'UpdateNotebook',
    'ArchiveNotebook',
    'RunNotebook',
    'CreateRepository',
    'UpdateRepository',
    'ArchiveRepository',
    'SyncRepository',
    'CreateWorktree',
    'UpdateWorktree',
    'DeleteWorktree',
    'CreateExperiment',
    'UpdateExperiment',
    'ArchiveExperiment',
    'CreateDeployment',
    'UpdateDeployment',
    'PromoteDeployment',
    'RollbackDeployment',
    'ObserveDeployment',
    'InvokeDeployment',
    'SmokeTestDeployment',
    'StopDeployment',
    'RestartDeployment',
    'ScaleDeployment',
    'ReadDeploymentTelemetry',
    'CreatePipeline',
    'UpdatePipeline',
    'RunPipeline',
    'CancelPipeline',
    'CreateEnvironment',
    'UpdateEnvironment',
    'DeleteEnvironment',
    'CreateResource',
    'UpdateResource',
    'ReleaseResource',
    'CreateIncident',
    'UpdateIncident',
    'AcknowledgeIncident',
    'ResolveIncident',
    'CreateGovernancePolicy',
    'UpdateGovernancePolicy',
    'ArchiveGovernancePolicy',
  ];
  const enabled = new Set([
    'workflow-summary',
    'invocation-jobs',
    'artifact-catalog-lineage',
    'projects',
    'runs',
    'run-timeline',
    'run-metrics',
    'run-logs',
    'machine-state',
    'audit-timeline',
    'catalog-datasets',
    'model-lifecycle',
    'deployment-traffic',
    'usage',
  ]);
  if (!personalLocal) enabled.add('approval-queue');
  const localResourceBackend =
    options.projections !== undefined && options.productCommands !== undefined;
  if (localResourceBackend) {
    for (const projection of [
      'assets',
      'datasets',
      'queries',
      'visualizations',
      'automations',
      'connections',
      'environments',
      'settings',
      'profiles',
      'notifications',
      'governance',
      'usage',
      'repositories',
      'worktrees',
      'notebooks',
      'experiments',
      'incidents',
      'pipelines',
      'resources',
    ])
      enabled.add(projection);
  }
  if (personalLocal) {
    enabled.delete('governance');
    enabled.delete('usage');
  }
  const commandsByProjection: Record<string, string[]> = {
    projects: [
      'CreateProject',
      'UpdateProject',
      'ArchiveProject',
      'RestoreProject',
      'CancelProject',
    ],
    'catalog-datasets': ['ValidateDataset', 'CreateDataset', 'UpdateDataset', 'ArchiveDataset'],
    queries: ['CreateQuery', 'UpdateQuery', 'ArchiveQuery', 'RunQuery', 'CancelQuery'],
    visualizations: [
      'CreateVisualization',
      'UpdateVisualization',
      'ArchiveVisualization',
      'RefreshVisualization',
    ],
    automations: [
      'CreateAutomation',
      'UpdateAutomation',
      'PauseAutomation',
      'ResumeAutomation',
      'DispatchAutomationEvent',
      'BackfillAutomation',
    ],
    notebooks: ['CreateNotebook', 'UpdateNotebook', 'ArchiveNotebook', 'RunNotebook'],
    repositories: [
      'CreateRepository',
      'UpdateRepository',
      'ArchiveRepository',
      'SyncRepository',
      'CommitRepository',
      'PushRepository',
      'CreatePullRequest',
      'MergePullRequest',
    ],
    worktrees: ['CreateWorktree', 'UpdateWorktree', 'DeleteWorktree'],
    experiments: ['CreateExperiment', 'UpdateExperiment', 'ArchiveExperiment'],
    'deployment-traffic': [
      'CreateDeployment',
      'UpdateDeployment',
      'PromoteDeployment',
      'RollbackDeployment',
    ],
    pipelines: ['CreatePipeline', 'UpdatePipeline', 'RunPipeline', 'CancelPipeline'],
    environments: ['CreateEnvironment', 'UpdateEnvironment', 'DeleteEnvironment'],
    resources: ['CreateResource', 'UpdateResource', 'ReleaseResource'],
    incidents: ['CreateIncident', 'UpdateIncident', 'AcknowledgeIncident', 'ResolveIncident'],
    governance: ['CreateGovernancePolicy', 'UpdateGovernancePolicy', 'ArchiveGovernancePolicy'],
  };
  const capabilities: Record<string, JsonValue> = Object.fromEntries(
    projections.map((projection) => [
      projection,
      enabled.has(projection)
        ? {
            enabled: true,
            status: 'metadata-only',
            executor: 'authoritative-projection',
            projections: [projection],
            ...(commandsByProjection[projection] === undefined
              ? {}
              : { commands: commandsByProjection[projection] }),
          }
        : {
            enabled: false,
            status: 'unavailable',
            reason:
              personalLocal &&
              (projection === 'approval-queue' ||
                projection === 'governance' ||
                projection === 'usage')
                ? 'This organization surface is available when an organization workspace is connected.'
                : 'Platform setup is required for this workflow.',
            projections: [projection],
          },
    ]),
  );
  if (options.providerRuntime !== undefined) {
    capabilities['model-runtime'] = {
      enabled: true,
      commands: ['model.download', 'model.remove', 'model.route', 'huggingface.token'],
    };
    capabilities['oauth-connections'] = {
      enabled: true,
      commands: ['oauth.start', 'oauth.refresh', 'connection.revoke'],
    };
    capabilities['speech-transcription'] = options.providerRuntime.speech.available
      ? {
          enabled: true,
          status: 'ready',
          executor: 'local-whisper',
          commands: ['speech.transcribe'],
        }
      : {
          enabled: false,
          status: 'unavailable',
          executor: 'local-whisper',
          reason: 'Configure a bundled or local Whisper executable before transcribing media.',
          commands: ['speech.transcribe'],
        };
    capabilities['model-lifecycle'] = { enabled: true, projections: ['model-lifecycle'] };
    capabilities['connections'] = { enabled: true, projections: ['connections'] };
  }
  const executionCapabilities: Record<string, JsonValue> = {
    'connectors.catalog':
      options.providerRuntime === undefined
        ? { enabled: false, status: 'unavailable', reason: 'The connector registry is not loaded.' }
        : { enabled: true, status: 'ready', executor: 'curated-connector-registry' },
    'connectors.auth':
      options.providerRuntime === undefined
        ? {
            enabled: false,
            status: 'unavailable',
            reason: 'The connector authorization broker is not loaded.',
          }
        : { enabled: true, status: 'ready', executor: 'oauth-pkce-broker' },
    'connectors.discover':
      options.providerRuntime?.connectors.available === true
        ? { enabled: true, status: 'ready', executor: 'sandboxed-meltano-discovery' }
        : {
            enabled: false,
            status: 'unavailable',
            reason: 'Configure the signed Meltano runtime before stream discovery is available.',
          },
    'connectors.execute': {
      enabled: options.providerRuntime?.connectors.available === true,
      status: options.providerRuntime?.connectors.available === true ? 'ready' : 'unavailable',
      executor: 'sandboxed-meltano',
      ...(options.providerRuntime?.connectors.available === true
        ? {}
        : { reason: 'Configure the signed Meltano runtime before connector runs can execute.' }),
    },
    'queries.execute':
      options.providerRuntime === undefined
        ? { enabled: false, status: 'unavailable', reason: 'The local SQL executor is not loaded.' }
        : { enabled: true, status: 'ready', executor: 'local-sql-runtime' },
    'notebooks.execute':
      options.providerRuntime === undefined
        ? {
            enabled: false,
            status: 'unavailable',
            reason: 'The local Python kernel is not loaded.',
          }
        : { enabled: true, status: 'ready', executor: 'sandboxed-local-python' },
    'visualizations.render':
      options.providerRuntime === undefined
        ? {
            enabled: false,
            status: 'unavailable',
            reason: 'The local visualization renderer is not loaded.',
          }
        : { enabled: true, status: 'ready', executor: 'local-visualization-runtime' },
    'pipelines.execute': {
      enabled: options.providerRuntime !== undefined,
      status: options.providerRuntime === undefined ? 'unavailable' : 'ready',
      ...(options.providerRuntime === undefined
        ? { reason: 'The local typed pipeline runtime is not loaded.' }
        : { executor: 'local-pipeline-runtime' }),
    },
    'automations.schedule': {
      enabled: options.providerRuntime !== undefined,
      status: options.providerRuntime === undefined ? 'unavailable' : 'ready',
      ...(options.providerRuntime === undefined
        ? { reason: 'The local durable scheduler is not loaded.' }
        : { executor: 'local-durable-scheduler' }),
    },
    'repositories.sync': {
      enabled: options.providerRuntime !== undefined,
      status: options.providerRuntime === undefined ? 'unavailable' : 'ready',
      ...(options.providerRuntime === undefined
        ? { reason: 'The local Git runtime is not loaded.' }
        : { executor: 'local-git-sandbox' }),
    },
    'repositories.write': {
      enabled: options.providerRuntime !== undefined,
      status: options.providerRuntime === undefined ? 'unavailable' : 'ready',
      ...(options.providerRuntime === undefined
        ? { reason: 'The local Git runtime is not loaded.' }
        : { executor: 'local-git-write-boundary' }),
    },
    'repositories.files': {
      enabled: options.providerRuntime !== undefined,
      status: options.providerRuntime === undefined ? 'unavailable' : 'ready',
      ...(options.providerRuntime === undefined
        ? { reason: 'The local project filesystem runtime is not loaded.' }
        : { executor: 'local-project-filesystem' }),
    },
    'repositories.execute': {
      enabled: options.providerRuntime !== undefined,
      status: options.providerRuntime === undefined ? 'unavailable' : 'ready',
      ...(options.providerRuntime === undefined
        ? { reason: 'The local project execution runtime is not loaded.' }
        : { executor: 'durable-local-run-record' }),
    },
    'repositories.dependencies': {
      enabled: options.providerRuntime !== undefined,
      status: options.providerRuntime === undefined ? 'unavailable' : 'ready',
      ...(options.providerRuntime === undefined
        ? { reason: 'The dependency execution boundary is not loaded.' }
        : { executor: 'confirmed-allowlisted-dependency-command' }),
    },
    'automations.webhooks': {
      enabled: options.providerRuntime !== undefined,
      status: options.providerRuntime === undefined ? 'unavailable' : 'ready',
      ...(options.providerRuntime === undefined
        ? { reason: 'The local automation runtime is not loaded.' }
        : { executor: 'signed-webhook-and-event-router' }),
    },
    'provider-actions.execute': {
      enabled: options.providerRuntime?.providerActions.available === true,
      status: options.providerRuntime?.providerActions.available === true ? 'ready' : 'unavailable',
      executor: 'scoped-oauth-provider-actions',
      ...(options.providerRuntime?.providerActions.available === true
        ? {}
        : { reason: 'The provider action runtime is not loaded.' }),
    },
    'media.bridges.execute': {
      enabled: options.providerRuntime?.bridges.list().some((bridge) => bridge.available) === true,
      status:
        options.providerRuntime?.bridges.list().some((bridge) => bridge.available) === true
          ? 'ready'
          : 'unavailable',
      executor: 'signed-local-media-bridge',
      ...(options.providerRuntime?.bridges.list().some((bridge) => bridge.available) === true
        ? {}
        : { reason: 'Configure a signed Premiere, Resolve, Final Cut, or media bridge binary.' }),
    },
    'models.train': {
      enabled: options.providerRuntime?.training.available === true,
      status: options.providerRuntime?.training.available === true ? 'ready' : 'unavailable',
      ...(options.providerRuntime?.training.available === true
        ? { executor: 'configured-local-training' }
        : { reason: 'Configure SPYDERBYTE_TRAIN_COMMAND before training models.' }),
    },
    'experiments.lifecycle': {
      enabled: options.providerRuntime !== undefined,
      status: options.providerRuntime === undefined ? 'unavailable' : 'ready',
      executor: 'durable-local-experiment-runtime',
      ...(options.providerRuntime === undefined
        ? { reason: 'The local experiment runtime is not loaded.' }
        : {}),
    },
    'models.registry': {
      enabled: options.providerRuntime !== undefined,
      status: options.providerRuntime === undefined ? 'unavailable' : 'ready',
      executor: 'lineage-bound-local-model-registry',
      ...(options.providerRuntime === undefined
        ? { reason: 'The local model registry is not loaded.' }
        : {}),
    },
    'deployments.serve': {
      enabled: options.providerRuntime?.serving.available === true,
      status: options.providerRuntime?.serving.available === true ? 'ready' : 'unavailable',
      executor: 'configured-local-serving-runtime',
      ...(options.providerRuntime?.serving.available === true
        ? {}
        : { reason: 'Configure SPYDERBYTE_SERVE_COMMAND before serving models.' }),
    },
    'deployments.canary': {
      enabled: options.providerRuntime?.serving.available === true,
      status: options.providerRuntime?.serving.available === true ? 'ready' : 'unavailable',
      executor: 'local-canary-controller',
      ...(options.providerRuntime?.serving.available === true
        ? {}
        : { reason: 'A configured serving runtime is required for canary traffic.' }),
    },
    'deployments.observe': {
      enabled: options.providerRuntime?.serving.available === true,
      status: options.providerRuntime?.serving.available === true ? 'ready' : 'unavailable',
      executor: 'local-serving-health-observer',
      ...(options.providerRuntime?.serving.available === true
        ? {}
        : { reason: 'A configured serving runtime is required for health evidence.' }),
    },
    'deployments.invoke': {
      enabled: options.providerRuntime?.serving.available === true,
      status: options.providerRuntime?.serving.available === true ? 'ready' : 'unavailable',
      executor: 'local-serving-invocation-adapter',
      ...(options.providerRuntime?.serving.available === true
        ? {}
        : { reason: 'A configured serving runtime is required for invocation.' }),
    },
    'deployments.approval': {
      enabled: options.providerRuntime?.serving.available === true,
      status: options.providerRuntime?.serving.available === true ? 'ready' : 'unavailable',
      executor: 'approval-bound-serving-rollout-controller',
      ...(options.providerRuntime?.serving.available === true
        ? {}
        : { reason: 'A configured serving runtime is required for rollout approval.' }),
    },
  };
  Object.assign(capabilities, executionCapabilities);
  return {
    schemaVersion: 1,
    runtimeMode: 'managed-local-daemon',
    workspaceMode: options.workspaceContext?.mode ?? 'organization_local',
    policyEnforcement: personalLocal ? 'local' : 'organization',
    projectionVersion: 1,
    generatedAt: options.clock?.() ?? new Date().toISOString(),
    projections,
    commands,
    capabilities,
  } as JsonValue;
}

function projectionEnabled(options: LocalApiOptions, projectionName: string): boolean {
  const capabilities = options.capabilities ?? defaultCapabilities(options);
  if (capabilities === null || typeof capabilities !== 'object' || Array.isArray(capabilities))
    return true;
  const entries = capabilities['capabilities'];
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) return true;
  const descriptor = entries[projectionName];
  if (
    descriptor === undefined ||
    descriptor === null ||
    typeof descriptor !== 'object' ||
    Array.isArray(descriptor)
  )
    return true;
  const enabled = descriptor['enabled'];
  return enabled !== false;
}

function sameTenant(left: TenantRef | undefined, right: TenantRef): boolean {
  return left?.tenantId === right.tenantId && left?.workspaceId === right.workspaceId;
}

function requestHeaders(request: IncomingMessage): ApiRequestHeaders {
  const authorization = request.headers['authorization'];
  const cookie = request.headers['cookie'];
  const workspaceId = new URL(request.url ?? '/', 'http://local').searchParams.get('workspaceId');
  return {
    authorization: Array.isArray(authorization) ? authorization[0] : authorization,
    cookie: Array.isArray(cookie) ? cookie.join('; ') : cookie,
    ...(workspaceId === null ? {} : { 'x-agentic-workspace-id': workspaceId }),
  };
}

export function createLocalApiServer(options: LocalApiOptions): Server {
  return createServer((request, response) => {
    const method = request.method ?? 'GET';
    const path = request.url ?? '/';
    applyCorsHeaders(request, response, options);
    if (method === 'OPTIONS') {
      response.statusCode = 204;
      response.end();
      return;
    }
    if (method === 'GET' && path.split('?')[0] === '/v1/subscriptions/events') {
      try {
        const session = authenticateRequest(
          { method, path, body: undefined, headers: requestHeaders(request) },
          options,
        );
        const scopedOptions = optionsForSession(options, session);
        setSessionCookie(response, scopedOptions);
        const limited = rateLimitResponse(scopedOptions);
        if (limited !== undefined) {
          jsonResponse(response, limited.statusCode, limited.body, limited.headers);
          return;
        }
        void streamSubscriptions(request, response, scopedOptions).catch((error: unknown) => {
          if (!response.writableEnded) {
            jsonResponse(response, errorStatus(error), errorBody(error));
          }
        });
      } catch (error) {
        jsonResponse(response, errorStatus(error), errorBody(error));
        return;
      }
      return;
    }
    let parsedBody: unknown;
    const bodyPromise =
      method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
        ? readJson(request)
        : Promise.resolve(undefined);
    void bodyPromise
      .then((body) => {
        parsedBody = body;
        return handleLocalApiRequest(
          { method, path, body, headers: requestHeaders(request) },
          options,
        );
      })
      .then(({ statusCode, body, headers }) => {
        setSessionCookie(response, options);
        jsonResponse(response, statusCode, body, headers);
      })
      .catch((error: unknown) => {
        setSessionCookie(response, options);
        const correlationId =
          parsedBody !== null &&
          typeof parsedBody === 'object' &&
          !Array.isArray(parsedBody) &&
          typeof (parsedBody as Record<string, unknown>)['correlationId'] === 'string'
            ? ((parsedBody as Record<string, unknown>)['correlationId'] as string)
            : undefined;
        jsonResponse(response, errorStatus(error), errorBody(error, correlationId));
      });
  });
}
