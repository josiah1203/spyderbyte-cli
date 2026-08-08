import { newSortableId } from '@agentic-platform/runtime-contracts';
import type {
  Actor,
  AgentInterface,
  ApprovalRequest,
  Id,
  JsonValue,
  ProviderConfiguration,
  ProviderCredential,
  ProviderModel,
  Run,
  RunAttempt,
  RuntimeEvent,
  RuntimeCommand,
  TenantRef,
} from '@agentic-platform/runtime-contracts';
import type {
  ServingEndpointV1,
  ServingRevisionV1,
  ServingTrafficApproval,
} from '@agentic-platform/backends';
import type { AgentDefinitionV1, AgentRouteDecision } from '@agentic-platform/agent-registry';
import type { ScopedBudgetSnapshot, ScopedReservationRecord } from '@agentic-platform/budget';
import type { BackupRecordV1, RestoreEvidenceV1, RestorePreviewV1 } from '@agentic-platform/state';
import type {
  CollaborationConflictV1,
  CollaborationDocumentV1,
  CollaborationPresenceV1,
  CollaborationWriteResult,
} from '@agentic-platform/runtime-domain';

export type ClientConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export const SPYDERBYTE_SCHEMA_VERSION = 1 as const;

export interface ClientPage<T> {
  readonly schemaVersion: typeof SPYDERBYTE_SCHEMA_VERSION;
  readonly items: readonly T[];
  readonly nextCursor?: string;
  readonly hasMore: boolean;
}

export interface ClientErrorEnvelope {
  readonly error: string;
  readonly code?: string;
  readonly correlationId?: Id;
}

export const SPYDERBYTE_EXIT_CODES = {
  success: 0,
  generalFailure: 1,
  invalidRequest: 2,
  authenticationRequired: 3,
  configurationRequired: 4,
  approvalDenied: 5,
  executionFailed: 6,
  budgetExceeded: 7,
  policyDenied: 8,
} as const;

export type SpyderbyteExitCode = (typeof SPYDERBYTE_EXIT_CODES)[keyof typeof SPYDERBYTE_EXIT_CODES];

export interface ClientSession {
  readonly schemaVersion?: number;
  readonly sessionId?: Id;
  readonly tenant: TenantRef;
  readonly actor: Actor;
  readonly workspaces?: readonly TenantRef[];
  readonly scopes?: readonly string[];
  readonly issuedAt?: string;
  readonly expiresAt?: string;
}

export interface ProviderListResponse {
  readonly providers: readonly ProviderConfiguration[];
  readonly credentials: readonly ProviderCredential[];
  readonly models: readonly ProviderModel[];
}

export interface ProviderModelsResponse {
  readonly models: readonly ProviderModel[];
}

export interface ProviderTestReport {
  readonly providerConfigurationId: Id;
  readonly state: ProviderConfiguration['state'];
  readonly checkedAt: string;
  readonly checks: readonly {
    readonly name: string;
    readonly status: 'passed' | 'failed' | 'skipped';
    readonly message: string;
  }[];
  readonly models: readonly ProviderModel[];
  readonly capabilities?: readonly string[];
  readonly latencyMs?: Readonly<Record<string, number>>;
  readonly rateLimit?: {
    readonly statusCode?: number;
    readonly retryAfterMs?: number;
    readonly limit?: number;
    readonly remaining?: number;
    readonly resetAt?: string;
  };
  readonly actionableErrors?: readonly string[];
}

export interface ProviderPreflightReport {
  readonly schemaVersion: 1;
  readonly providerConfigurationId: Id;
  readonly providerId: string;
  readonly state: ProviderConfiguration['state'];
  readonly authenticationState: ProviderConfiguration['authenticationState'];
  readonly checkedAt: string;
  readonly checks: readonly {
    readonly name: string;
    readonly status: 'passed' | 'failed' | 'skipped';
    readonly message: string;
  }[];
  readonly models: readonly ProviderModel[];
  readonly credentialState: 'available' | 'missing' | 'not_required';
  readonly actionableErrors: readonly string[];
}

export interface RunLog {
  readonly eventId: Id;
  readonly runId: Id;
  readonly eventName: string;
  readonly occurredAt: string;
  readonly message: string;
  readonly level: 'info' | 'error' | 'output';
}

export interface RunDetail {
  readonly run: Run;
  readonly attempts: readonly RunAttempt[];
  readonly logs: readonly RunLog[];
}

export interface ClientApprovalRecord {
  readonly request: ApprovalRequest;
  readonly action: JsonValue;
}

export interface ServingEndpointListResponse {
  readonly endpoints: readonly ServingEndpointV1[];
}

export interface ServingDeploymentListResponse {
  readonly deployments: readonly ServingRevisionV1[];
}

export interface ScopedBudgetListResponse {
  readonly budgets: readonly ScopedBudgetSnapshot[];
}

export interface ScopedReservationListResponse {
  readonly reservations: readonly ScopedReservationRecord[];
}

export interface AgentDefinitionListResponse {
  readonly definitions: readonly AgentDefinitionV1[];
}

export interface RecoveryBackupListResponse {
  readonly backups: readonly BackupRecordV1[];
}

export interface CollaborationPresenceListResponse {
  readonly presence: readonly CollaborationPresenceV1[];
}

export interface CollaborationConflictListResponse {
  readonly conflicts: readonly CollaborationConflictV1[];
}

export interface SubscriptionPage {
  readonly cursor: number;
  readonly events: readonly RuntimeEvent[];
  readonly gapDetected: boolean;
  readonly refreshRequired: boolean;
}

export interface NotebookDocumentResponse {
  readonly schemaVersion: number;
  readonly notebookId: string;
  readonly title: string;
  readonly revision: number;
  readonly state: 'draft' | 'active' | 'archived';
  readonly kernel: string;
  readonly environment: string;
  readonly cells: readonly Record<string, unknown>[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly [key: string]: unknown;
}

export interface NotebookVersionResponse {
  readonly schemaVersion: number;
  readonly notebookId: string;
  readonly revision: number;
  readonly document: NotebookDocumentResponse;
  readonly createdAt: string;
  readonly reason: string;
}

export interface DataConnectionSummary {
  readonly schemaVersion: 1;
  readonly connectionId: string;
  readonly name: string;
  readonly kind: 'memory' | 'file' | 'sql' | 'connector';
  readonly credentialStatus: 'unbound' | 'bound' | 'revoked';
  readonly sourceId: string;
  readonly sourceReference: string;
  readonly status: 'configured' | 'ready' | 'degraded' | 'failed';
  readonly [key: string]: unknown;
}

export interface DataSourceSummary {
  readonly schemaVersion: 1;
  readonly sourceId: string;
  readonly connectionId: string;
  readonly name: string;
  readonly kind: 'memory' | 'file' | 'sql' | 'connector';
  readonly sourceReference: string;
  readonly status: 'configured' | 'ready' | 'degraded' | 'failed';
  readonly [key: string]: unknown;
}

export interface DataConnectionsResponse {
  readonly connections: readonly DataConnectionSummary[];
}

export interface DataSourcesResponse {
  readonly sources: readonly DataSourceSummary[];
}

export interface JupyterSessionResponse {
  readonly schemaVersion: number;
  readonly sessionId: string;
  readonly sessionRequestId: string;
  readonly state: string;
  readonly projectPath: string;
  readonly serverMode: 'local' | 'managed';
  readonly idleTimeoutMs: number;
  readonly lastActivityAt: string;
  readonly associatedRunIds: readonly string[];
  readonly [key: string]: unknown;
}

export interface JupyterLaunchResponse {
  readonly session: JupyterSessionResponse;
  readonly token: string;
  readonly accessUrl: string;
}

export interface ClientRequestOptions {
  readonly signal?: AbortSignal;
}

export interface PaginationOptions extends ClientRequestOptions {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface EventStreamOptions extends ClientRequestOptions {
  readonly afterCursor?: number;
  readonly maxEvents?: number;
  readonly topics?: readonly string[];
  readonly maxReconnects?: number;
  readonly reconnectDelayMs?: number;
  readonly onConnectionStateChange?: (state: ClientConnectionState) => void;
}

export interface SpyderbyteClientOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly workspaceId?: Id;
  readonly interface?: AgentInterface;
  readonly fetcher?: typeof fetch;
}

export interface AgentClient {
  session(options?: ClientRequestOptions): Promise<ClientSession>;
  command<T>(input: ClientCommandInput): Promise<T>;
  sendMessage(
    projectId: Id,
    text: string,
    options?: ClientRequestOptions,
    sourceInterface?: AgentInterface,
    modelOverride?: { readonly providerId: string; readonly modelId: string },
  ): Promise<JsonValue>;
  agentSession(sessionId: Id, options?: ClientRequestOptions): Promise<JsonValue>;
  projectAgentSession(projectId: Id, options?: ClientRequestOptions): Promise<JsonValue>;
  projectConversation(projectId: Id, options?: ClientRequestOptions): Promise<JsonValue>;
  events(options?: EventStreamOptions): AsyncIterable<SubscriptionPage>;
  followRun(runId: Id, options?: EventStreamOptions): AsyncIterable<RunDetail>;
}

export interface ProjectClient {
  projects(options?: ClientRequestOptions): Promise<JsonValue>;
  createProject(name: string, objective?: string): Promise<JsonValue>;
  projectConversation(projectId: Id, options?: ClientRequestOptions): Promise<JsonValue>;
  workspace(options?: ClientRequestOptions): Promise<JsonValue>;
  sendMessage(
    projectId: Id,
    text: string,
    options?: ClientRequestOptions,
    sourceInterface?: AgentInterface,
    modelOverride?: { readonly providerId: string; readonly modelId: string },
  ): Promise<JsonValue>;
  projectAgentSession(projectId: Id, options?: ClientRequestOptions): Promise<JsonValue>;
}

export interface RunClient {
  runs(projectId?: Id, options?: ClientRequestOptions): Promise<{ readonly runs: readonly Run[] }>;
  listRuns(projectId?: Id, options?: PaginationOptions): Promise<ClientPage<Run>>;
  run(runId: Id, options?: ClientRequestOptions): Promise<RunDetail>;
  runLogs(
    runId: Id,
    options?: ClientRequestOptions,
  ): Promise<{ readonly runId: Id; readonly logs: readonly RunLog[] }>;
  cancelRun(runId: Id, reason?: string, options?: ClientRequestOptions): Promise<JsonValue>;
  retryRun(runId: Id, options?: ClientRequestOptions): Promise<JsonValue>;
  events(options?: EventStreamOptions): AsyncIterable<SubscriptionPage>;
  followRun(runId: Id, options?: EventStreamOptions): AsyncIterable<RunDetail>;
}

export interface ArtifactClient {
  artifacts(options?: ClientRequestOptions): Promise<JsonValue>;
  listArtifacts(options?: PaginationOptions): Promise<ClientPage<JsonValue>>;
  artifact(artifactId: string, options?: ClientRequestOptions): Promise<JsonValue>;
  artifactVersions(artifactId: string, options?: ClientRequestOptions): Promise<JsonValue>;
  artifactLineage(artifactId: string, options?: ClientRequestOptions): Promise<JsonValue>;
  artifactContent(
    artifactId: string,
    version: number,
    options?: ClientRequestOptions,
  ): Promise<JsonValue>;
  stageArtifactUpload(
    content: string,
    mediaType: string,
    expectedContentHash?: string,
    options?: ClientRequestOptions,
  ): Promise<JsonValue>;
  publishArtifactVersion(
    artifactId: string,
    input: JsonValue,
    options?: ClientRequestOptions,
  ): Promise<JsonValue>;
  artifactDiff(
    artifactId: string,
    fromVersion?: number,
    toVersion?: number,
    options?: ClientRequestOptions,
  ): Promise<JsonValue>;
}

export type ClientVisualizationType =
  | 'table'
  | 'metric'
  | 'kpi'
  | 'line'
  | 'bar'
  | 'stacked-bar'
  | 'area'
  | 'pivot'
  | 'scatter'
  | 'histogram'
  | 'box'
  | 'heatmap'
  | 'point-map'
  | 'choropleth'
  | 'time-series'
  | 'confusion-matrix'
  | 'roc'
  | 'precision-recall'
  | 'feature-importance';

export interface VisualizationClient {
  chooseVisualization(
    input: JsonValue,
    override?: ClientVisualizationType,
    options?: ClientRequestOptions,
  ): Promise<JsonValue>;
  validateVisualization(input: JsonValue, options?: ClientRequestOptions): Promise<JsonValue>;
  renderVisualization(input: JsonValue, options?: ClientRequestOptions): Promise<JsonValue>;
}

export interface WorkspaceClient {
  workspaceIntake(options?: ClientRequestOptions): Promise<JsonValue>;
  workspaceInbox(options?: ClientRequestOptions): Promise<JsonValue>;
  workspaceWatch(options?: ClientRequestOptions): Promise<JsonValue>;
  workspaceRecommendations(options?: ClientRequestOptions): Promise<JsonValue>;
  workspaceContext(options?: ClientRequestOptions): Promise<JsonValue>;
}

export interface ProviderClient {
  providers(options?: ClientRequestOptions): Promise<ProviderListResponse>;
  addProvider(input: JsonValue, options?: ClientRequestOptions): Promise<ProviderConfiguration>;
  updateProvider(
    providerConfigurationId: Id,
    input: JsonValue,
    options?: ClientRequestOptions,
  ): Promise<ProviderConfiguration>;
  removeProvider(providerConfigurationId: Id, options?: ClientRequestOptions): Promise<JsonValue>;
  setProviderCredential(
    providerConfigurationId: Id,
    secret: string,
    options?: ClientRequestOptions,
  ): Promise<ProviderCredential>;
  revokeProviderCredential(
    providerConfigurationId: Id,
    options?: ClientRequestOptions,
  ): Promise<JsonValue>;
  testProvider(
    providerConfigurationId: Id,
    modelId?: string,
    options?: ClientRequestOptions,
  ): Promise<ProviderTestReport>;
  preflightProvider(
    providerConfigurationId: Id,
    modelId?: string,
    options?: ClientRequestOptions,
  ): Promise<ProviderPreflightReport>;
  discoverProviderModels(
    providerConfigurationId: Id,
    options?: ClientRequestOptions,
  ): Promise<ProviderModelsResponse>;
  providerHealth(providerConfigurationId: Id, options?: ClientRequestOptions): Promise<JsonValue>;
  providerUsage(providerConfigurationId: Id, options?: ClientRequestOptions): Promise<JsonValue>;
  models(options?: ClientRequestOptions): Promise<ProviderModelsResponse>;
  refreshModels(options?: ClientRequestOptions): Promise<ProviderModelsResponse>;
}

export interface RuntimeClient {
  health(options?: ClientRequestOptions): Promise<JsonValue>;
  diagnostics(options?: ClientRequestOptions): Promise<JsonValue>;
  supportBundle(options?: ClientRequestOptions): Promise<JsonValue>;
  updateStatus(options?: ClientRequestOptions): Promise<JsonValue>;
  checkForUpdates(options?: ClientRequestOptions): Promise<JsonValue>;
  downloadUpdate(options?: ClientRequestOptions): Promise<JsonValue>;
  installUpdate(options?: ClientRequestOptions): Promise<JsonValue>;
  rollbackUpdate(options?: ClientRequestOptions): Promise<JsonValue>;
  runtimeProfiles(options?: ClientRequestOptions): Promise<JsonValue>;
  computeProfiles(options?: ClientRequestOptions): Promise<JsonValue>;
  createComputeProfile(input: JsonValue, options?: ClientRequestOptions): Promise<JsonValue>;
  selectComputeProfile(input?: JsonValue, options?: ClientRequestOptions): Promise<JsonValue>;
  models(options?: ClientRequestOptions): Promise<ProviderModelsResponse>;
  refreshModels(options?: ClientRequestOptions): Promise<ProviderModelsResponse>;
  jupyterDiscovery(options?: ClientRequestOptions): Promise<JsonValue>;
  jupyterSessions(options?: ClientRequestOptions): Promise<readonly JupyterSessionResponse[]>;
  launchJupyterSession(
    input?: JsonValue,
    options?: ClientRequestOptions,
  ): Promise<JupyterLaunchResponse>;
  stopJupyterSession(sessionId: string, options?: ClientRequestOptions): Promise<JsonValue>;
  jupyterSessionAction(
    sessionId: string,
    action: 'interrupt' | 'restart' | 'reconnect',
    options?: ClientRequestOptions,
  ): Promise<JsonValue>;
}

export interface OnboardingClient {
  onboarding(options?: ClientRequestOptions): Promise<JsonValue>;
  completeOnboarding(input: JsonValue, options?: ClientRequestOptions): Promise<JsonValue>;
}

export interface ApprovalClient {
  approvals(
    options?: PaginationOptions,
  ): Promise<readonly ClientApprovalRecord[] | ClientPage<ClientApprovalRecord>>;
  listApprovals(options?: PaginationOptions): Promise<ClientPage<ClientApprovalRecord>>;
  approveApproval(
    approvalId: Id,
    reason?: string,
    options?: ClientRequestOptions,
  ): Promise<ClientApprovalRecord>;
  rejectApproval(
    approvalId: Id,
    reason?: string,
    options?: ClientRequestOptions,
  ): Promise<ClientApprovalRecord>;
  revokeApproval(
    approvalId: Id,
    reason?: string,
    options?: ClientRequestOptions,
  ): Promise<ClientApprovalRecord>;
}

export interface UsageClient {
  providerUsage(providerConfigurationId: Id, options?: ClientRequestOptions): Promise<JsonValue>;
  notebookUsage(notebookId: string, options?: ClientRequestOptions): Promise<JsonValue>;
  governanceUsage(organizationId: Id, options?: ClientRequestOptions): Promise<JsonValue>;
}

export interface SpyderbyteClientBundle {
  readonly agent: AgentClient;
  readonly project: ProjectClient;
  readonly run: RunClient;
  readonly artifact: ArtifactClient;
  readonly provider: ProviderClient;
  readonly runtime: RuntimeClient;
  readonly approval: ApprovalClient;
  readonly usage: UsageClient;
  readonly visualization: VisualizationClient;
  readonly workspaceIntake: WorkspaceClient;
}

export interface ClientCommandInput {
  readonly commandType: string;
  readonly payload: JsonValue;
  readonly idempotencyKey?: string;
}

export class SpyderbyteClientError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly code: string | undefined;
  readonly correlationId: Id | undefined;
  readonly retryable: boolean;
  readonly exitCode: SpyderbyteExitCode;
  override readonly cause: unknown;

  constructor(status: number, body: unknown, cause?: unknown) {
    const envelope = errorEnvelope(body);
    const message =
      envelope !== undefined ? envelope.error : `Spyderbyte API request failed (${status})`;
    super(message);
    this.name = 'SpyderbyteClientError';
    this.status = status;
    this.body = body;
    this.code = envelope?.code;
    this.correlationId = envelope?.correlationId;
    this.retryable = isRetryableClientError(status, this.code);
    this.exitCode = exitCodeForClientError(status, this.code);
    this.cause = cause;
  }

  static fromTransport(cause: unknown): SpyderbyteClientError {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return new SpyderbyteClientError(
      0,
      {
        error: 'The Spyderbyte API could not be reached.',
        code: 'EXTERNAL_DEPENDENCY_UNAVAILABLE',
      },
      cause ?? new Error(detail),
    );
  }
}

function errorEnvelope(value: unknown): ClientErrorEnvelope | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record['error'] !== 'string') return undefined;
  return {
    error: record['error'],
    ...(typeof record['code'] === 'string' ? { code: record['code'] } : {}),
    ...(typeof record['correlationId'] === 'string'
      ? { correlationId: record['correlationId'] as Id }
      : {}),
  };
}

function isRetryableClientError(status: number, code?: string): boolean {
  if (status === 408 || status === 425 || status === 429 || status >= 500) return true;
  return new Set([
    'CONCURRENCY_STALE_VERSION',
    'CAPABILITY_UNAVAILABLE',
    'EXTERNAL_DEPENDENCY_UNAVAILABLE',
    'COMPUTE_RESOURCE_UNAVAILABLE',
  ]).has(code ?? '');
}

function exitCodeForClientError(status: number, code?: string): SpyderbyteExitCode {
  const normalized = code?.toUpperCase() ?? '';
  if (normalized.includes('AUTHORITY') || normalized.includes('AUTHENTICATION') || status === 401)
    return SPYDERBYTE_EXIT_CODES.authenticationRequired;
  if (normalized.includes('APPROVAL')) return SPYDERBYTE_EXIT_CODES.approvalDenied;
  if (normalized.includes('BUDGET')) return SPYDERBYTE_EXIT_CODES.budgetExceeded;
  if (normalized.includes('POLICY') || status === 403) return SPYDERBYTE_EXIT_CODES.policyDenied;
  if (normalized.includes('VALIDATION') || status === 400)
    return SPYDERBYTE_EXIT_CODES.invalidRequest;
  if (normalized.includes('CAPABILITY') || normalized.includes('CONFIG') || status === 501)
    return SPYDERBYTE_EXIT_CODES.configurationRequired;
  if (status >= 500 || status === 0) return SPYDERBYTE_EXIT_CODES.executionFailed;
  return SPYDERBYTE_EXIT_CODES.generalFailure;
}

export function exitCodeForError(error: unknown): SpyderbyteExitCode {
  return error instanceof SpyderbyteClientError
    ? error.exitCode
    : SPYDERBYTE_EXIT_CODES.generalFailure;
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('Aborted'));
      },
      { once: true },
    );
  });
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function withPagination(path: string, options?: PaginationOptions): string {
  if (options?.cursor === undefined && options?.limit === undefined) return path;
  const query = new URLSearchParams();
  if (options.cursor !== undefined) {
    if (options.cursor.trim().length === 0) {
      throw new SpyderbyteClientError(0, {
        error: 'cursor must not be empty',
        code: 'VALIDATION_INVALID_INPUT',
      });
    }
    query.set('cursor', options.cursor);
  }
  if (options.limit !== undefined) {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) {
      throw new SpyderbyteClientError(0, {
        error: 'limit must be an integer between 1 and 100',
        code: 'VALIDATION_INVALID_INPUT',
      });
    }
    query.set('limit', String(options.limit));
  }
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}${query.toString()}`;
}

function normalizePage<T>(value: unknown, collectionKey = 'items'): ClientPage<T> {
  const record = jsonRecord(value);
  const rawItems = Array.isArray(value)
    ? value
    : Array.isArray(record['items'])
      ? record['items']
      : Array.isArray(record[collectionKey])
        ? record[collectionKey]
        : undefined;
  if (rawItems === undefined) {
    throw new SpyderbyteClientError(0, {
      error: `Spyderbyte response did not contain a ${collectionKey} collection`,
      code: 'VALIDATION_SCHEMA_MISMATCH',
    });
  }
  const nextCursor = record['nextCursor'];
  if (nextCursor !== undefined && nextCursor !== null && typeof nextCursor !== 'string') {
    throw new SpyderbyteClientError(0, {
      error: 'Spyderbyte response contained an invalid pagination cursor',
      code: 'VALIDATION_SCHEMA_MISMATCH',
    });
  }
  const hasMore =
    typeof record['hasMore'] === 'boolean'
      ? record['hasMore']
      : typeof nextCursor === 'string' && nextCursor.length > 0;
  return {
    schemaVersion: SPYDERBYTE_SCHEMA_VERSION,
    items: rawItems as T[],
    ...(typeof nextCursor === 'string' ? { nextCursor } : {}),
    hasMore,
  };
}

async function* ssePages(response: Response): AsyncIterable<SubscriptionPage> {
  if (response.body === null) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];
  const emit = (): SubscriptionPage | undefined => {
    if (dataLines.length === 0) return undefined;
    const data = dataLines.join('\n');
    dataLines = [];
    try {
      const value: unknown = JSON.parse(data);
      const record = jsonRecord(value);
      if (!Number.isSafeInteger(record['cursor']) || !Array.isArray(record['events']))
        return undefined;
      return {
        cursor: record['cursor'] as number,
        events: record['events'] as RuntimeEvent[],
        gapDetected: record['gapDetected'] === true,
        refreshRequired: record['refreshRequired'] === true,
      };
    } catch {
      return undefined;
    }
  };
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        if (line.trim() === '') {
          const page = emit();
          if (page !== undefined) yield page;
        }
      }
      if (chunk.done) break;
    }
    const page = emit();
    if (page !== undefined) yield page;
  } finally {
    reader.releaseLock();
  }
}

export class SpyderbyteClient
  implements
    AgentClient,
    ProjectClient,
    RunClient,
    ArtifactClient,
    ProviderClient,
    RuntimeClient,
    OnboardingClient,
    ApprovalClient,
    UsageClient,
    VisualizationClient,
    WorkspaceClient
{
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: SpyderbyteClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.fetcher = options.fetcher ?? fetch;
  }

  get clients(): SpyderbyteClientBundle {
    return createSpyderbyteClients(this);
  }

  get agent(): AgentClient {
    return this;
  }

  get project(): ProjectClient {
    return this;
  }

  get runClient(): RunClient {
    return this;
  }

  get artifactClient(): ArtifactClient {
    return this;
  }

  get provider(): ProviderClient {
    return this;
  }

  get runtime(): RuntimeClient {
    return this;
  }

  get approval(): ApprovalClient {
    return this;
  }

  get usage(): UsageClient {
    return this;
  }

  get visualization(): VisualizationClient {
    return this;
  }

  async request<T>(
    method: string,
    path: string,
    body?: JsonValue,
    options: ClientRequestOptions = {},
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.options.token !== undefined) headers['authorization'] = `Bearer ${this.options.token}`;
    if (this.options.workspaceId !== undefined)
      headers['x-agentic-workspace-id'] = this.options.workspaceId;
    if (this.options.interface !== undefined)
      headers['x-spyderbyte-interface'] = this.options.interface;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw SpyderbyteClientError.fromTransport(error);
    }
    const value = await responseBody(response);
    if (!response.ok) throw new SpyderbyteClientError(response.status, value);
    return value as T;
  }

  get<T>(path: string, options?: ClientRequestOptions): Promise<T> {
    return this.request<T>('GET', path, undefined, options);
  }

  post<T>(path: string, body?: JsonValue, options?: ClientRequestOptions): Promise<T> {
    return this.request<T>('POST', path, body, options);
  }

  patch<T>(path: string, body: JsonValue, options?: ClientRequestOptions): Promise<T> {
    return this.request<T>('PATCH', path, body, options);
  }

  delete<T>(path: string, options?: ClientRequestOptions): Promise<T> {
    return this.request<T>('DELETE', path, undefined, options);
  }

  paginate<T>(
    path: string,
    options: PaginationOptions = {},
    collectionKey = 'items',
  ): Promise<ClientPage<T>> {
    return this.get<unknown>(withPagination(path, options), options).then((value) =>
      normalizePage<T>(value, collectionKey),
    );
  }

  page<T>(
    path: string,
    options: PaginationOptions = {},
    collectionKey = 'items',
  ): Promise<ClientPage<T>> {
    return this.paginate<T>(path, options, collectionKey);
  }

  async collectPages<T>(
    path: string,
    options: PaginationOptions = {},
    collectionKey = 'items',
  ): Promise<readonly T[]> {
    const items: T[] = [];
    let cursor = options.cursor;
    const seenCursors = new Set<string>();
    while (true) {
      const page = await this.paginate<T>(
        path,
        { ...options, ...(cursor === undefined ? {} : { cursor }) },
        collectionKey,
      );
      items.push(...page.items);
      if (!page.hasMore) return items;
      if (page.nextCursor === undefined || seenCursors.has(page.nextCursor)) {
        throw new SpyderbyteClientError(0, {
          error: 'Spyderbyte response could not advance pagination',
          code: 'VALIDATION_SCHEMA_MISMATCH',
        });
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }

  listAll<T>(
    path: string,
    options: PaginationOptions = {},
    collectionKey = 'items',
  ): Promise<readonly T[]> {
    return this.collectPages<T>(path, options, collectionKey);
  }

  health(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get('/v1/health', options);
  }

  diagnostics(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get('/v1/diagnostics', options);
  }

  supportBundle(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post('/v1/diagnostics/support-bundle', {}, options);
  }

  updateStatus(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get('/v1/updates/status', options);
  }

  checkForUpdates(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post('/v1/updates/check', {}, options);
  }

  downloadUpdate(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post('/v1/updates/download', {}, options);
  }

  installUpdate(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post('/v1/updates/install', {}, options);
  }

  rollbackUpdate(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post('/v1/updates/rollback', {}, options);
  }

  session(options?: ClientRequestOptions): Promise<ClientSession> {
    return this.get('/v1/session', options);
  }

  providers(options?: ClientRequestOptions): Promise<ProviderListResponse> {
    return this.get('/v1/providers', options);
  }

  addProvider(input: JsonValue, options?: ClientRequestOptions): Promise<ProviderConfiguration> {
    return this.post('/v1/providers', input, options);
  }

  updateProvider(
    providerConfigurationId: Id,
    input: JsonValue,
    options?: ClientRequestOptions,
  ): Promise<ProviderConfiguration> {
    return this.patch(`/v1/providers/${encode(providerConfigurationId)}`, input, options);
  }

  removeProvider(providerConfigurationId: Id, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.delete(`/v1/providers/${encode(providerConfigurationId)}`, options);
  }

  setProviderCredential(
    providerConfigurationId: Id,
    secret: string,
    options?: ClientRequestOptions,
  ): Promise<ProviderCredential> {
    return this.post(
      `/v1/providers/${encode(providerConfigurationId)}/credentials`,
      { apiKey: secret },
      options,
    );
  }

  revokeProviderCredential(
    providerConfigurationId: Id,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.delete(`/v1/providers/${encode(providerConfigurationId)}/credentials`, options);
  }

  testProvider(
    providerConfigurationId: Id,
    modelId?: string,
    options?: ClientRequestOptions,
  ): Promise<ProviderTestReport> {
    return this.post(
      `/v1/providers/${encode(providerConfigurationId)}/test`,
      modelId === undefined ? {} : { modelId },
      options,
    );
  }

  preflightProvider(
    providerConfigurationId: Id,
    modelId?: string,
    options?: ClientRequestOptions,
  ): Promise<ProviderPreflightReport> {
    return this.post(
      `/v1/providers/${encode(providerConfigurationId)}/preflight`,
      modelId === undefined ? {} : { modelId },
      options,
    );
  }

  discoverProviderModels(
    providerConfigurationId: Id,
    options?: ClientRequestOptions,
  ): Promise<ProviderModelsResponse> {
    return this.post(
      `/v1/providers/${encode(providerConfigurationId)}/discover-models`,
      {},
      options,
    );
  }

  providerHealth(providerConfigurationId: Id, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/providers/${encode(providerConfigurationId)}/health`, options);
  }

  providerUsage(providerConfigurationId: Id, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/providers/${encode(providerConfigurationId)}/usage`, options);
  }

  models(options?: ClientRequestOptions): Promise<ProviderModelsResponse> {
    return this.get('/v1/models', options);
  }

  refreshModels(options?: ClientRequestOptions): Promise<ProviderModelsResponse> {
    return this.post('/v1/models/refresh', {}, options);
  }

  dataSources(options?: ClientRequestOptions): Promise<readonly DataSourceSummary[]> {
    return this.get('/v1/data/sources', options);
  }

  dataSource(sourceId: string, options?: ClientRequestOptions): Promise<DataSourceSummary> {
    return this.get(`/v1/data/sources/${encode(sourceId)}`, options);
  }

  dataConnections(options?: ClientRequestOptions): Promise<readonly DataConnectionSummary[]> {
    return this.get('/v1/data/connections', options);
  }

  dataConnection(
    connectionId: string,
    options?: ClientRequestOptions,
  ): Promise<DataConnectionSummary> {
    return this.get(`/v1/data/connections/${encode(connectionId)}`, options);
  }

  createDataConnection(
    input: JsonValue,
    options?: ClientRequestOptions,
  ): Promise<DataConnectionSummary> {
    return this.post('/v1/data/connections', input, options);
  }

  testDataConnection(connectionId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post(`/v1/data/connections/${encode(connectionId)}/test`, {}, options);
  }

  dataSchema(connectionId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/data/connections/${encode(connectionId)}/schema`, options);
  }

  bindDataCredential(
    connectionId: string,
    credentialRef: string,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.post(
      `/v1/data/connections/${encode(connectionId)}/bind-credential`,
      { credentialRef },
      options,
    );
  }

  revokeDataCredential(connectionId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post(`/v1/data/connections/${encode(connectionId)}/revoke-credential`, {}, options);
  }

  reauthorizeDataCredential(
    connectionId: string,
    credentialRef?: string,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.post(
      `/v1/data/connections/${encode(connectionId)}/reauthorize`,
      credentialRef === undefined ? {} : { credentialRef },
      options,
    );
  }

  localDatasets(datasetId?: string, options?: ClientRequestOptions): Promise<JsonValue> {
    const query = datasetId === undefined ? '' : `?datasetId=${encode(datasetId)}`;
    return this.get(`/v1/datasets/local${query}`, options);
  }

  publishLocalDatasetVersion(input: JsonValue, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post('/v1/datasets/local/versions', input, options);
  }

  localDataset(
    datasetId: string,
    version?: number,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    const query = version === undefined ? '' : `?version=${version}`;
    return this.get(`/v1/datasets/local/${encode(datasetId)}${query}`, options);
  }

  localDatasetLineage(
    datasetId: string,
    version?: number,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    const query = version === undefined ? '' : `?version=${version}`;
    return this.get(`/v1/datasets/local/${encode(datasetId)}/lineage${query}`, options);
  }

  profileLocalDataset(
    datasetId: string,
    version?: number,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.post(
      `/v1/datasets/local/${encode(datasetId)}/profile`,
      version === undefined ? {} : { version },
      options,
    );
  }

  getLocalDatasetProfile(
    datasetId: string,
    version?: number,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    const query = version === undefined ? '' : `?version=${version}`;
    return this.get(`/v1/datasets/local/${encode(datasetId)}/profile${query}`, options);
  }

  qualityLocalDataset(
    datasetId: string,
    input: JsonValue = {},
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.post(`/v1/datasets/local/${encode(datasetId)}/quality`, input, options);
  }

  getLocalDatasetQuality(
    datasetId: string,
    version?: number,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    const query = version === undefined ? '' : `?version=${version}`;
    return this.get(`/v1/datasets/local/${encode(datasetId)}/quality${query}`, options);
  }

  runDataQuery(input: JsonValue, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post('/v1/data/queries', input, options);
  }

  dataQueries(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get('/v1/data/queries', options);
  }

  dataQuery(queryId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/data/queries/${encode(queryId)}`, options);
  }

  validateDataQuery(
    queryId: string,
    sql: string,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.post(`/v1/data/queries/${encode(queryId)}/validate`, { sql }, options);
  }

  explainDataQuery(
    queryId: string,
    input: JsonValue,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.post(`/v1/data/queries/${encode(queryId)}/explain`, input, options);
  }

  cancelDataQuery(queryId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post(`/v1/data/queries/${encode(queryId)}/cancel`, {}, options);
  }

  exportDataQuery(
    queryId: string,
    input: JsonValue = {},
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.post(`/v1/data/queries/${encode(queryId)}/export`, input, options);
  }

  handoffDataQuery(
    queryId: string,
    target: 'browser' | 'jupyter' = 'browser',
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.post(`/v1/data/queries/${encode(queryId)}/handoff`, { target }, options);
  }

  savedDataQueries(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get('/v1/data/saved-queries', options);
  }

  saveDataQuery(input: JsonValue, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post('/v1/data/saved-queries', input, options);
  }

  savedDataQuery(savedQueryId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/data/saved-queries/${encode(savedQueryId)}`, options);
  }

  localExperiments(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get('/v1/experiments/local', options);
  }

  createLocalExperiment(input: JsonValue, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post('/v1/experiments/local', input, options);
  }

  localExperiment(experimentId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/experiments/local/${encode(experimentId)}`, options);
  }

  validateLocalExperiment(
    experimentId: string,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.post(`/v1/experiments/local/${encode(experimentId)}/validate`, {}, options);
  }

  localExperimentRuns(experimentId?: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(
      experimentId === undefined
        ? '/v1/experiment-runs/local'
        : `/v1/experiment-runs/local?experimentId=${encode(experimentId)}`,
      options,
    );
  }

  localExperimentRun(runId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/experiment-runs/local/${encode(runId)}`, options);
  }

  localExperimentRunEvents(runId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/experiment-runs/local/${encode(runId)}/events`, options);
  }

  compareLocalExperiments(
    runIds: readonly string[],
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.post('/v1/experiments/local/compare', { runIds: [...runIds] }, options);
  }

  localExperimentComparisons(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get('/v1/experiment-comparisons/local', options);
  }

  localExperimentComparison(
    comparisonId: string,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.get(`/v1/experiment-comparisons/local/${encode(comparisonId)}`, options);
  }

  localModelRegistry(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get('/v1/models/local/registry', options);
  }

  localDeployments(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get('/v1/deployments/local', options);
  }

  localServingEndpoints(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get('/v1/deployments/local/endpoints', options);
  }

  localServingEndpoint(endpointId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/deployments/local/endpoints/${encode(endpointId)}`, options);
  }

  serveLocalDeployment(input: JsonValue, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post('/v1/deployments/local/serve', input, options);
  }

  localDeployment(deploymentId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/deployments/local/${encode(deploymentId)}`, options);
  }

  operateLocalDeployment(
    deploymentId: string,
    action: string,
    input: JsonValue = {},
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.post(
      `/v1/deployments/local/${encode(deploymentId)}/${encode(action)}`,
      input,
      options,
    );
  }

  updateLocalDeployment(
    deploymentId: string,
    input: JsonValue,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.operateLocalDeployment(deploymentId, 'update', input, options);
  }

  observeLocalDeployment(deploymentId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.operateLocalDeployment(deploymentId, 'observe', {}, options);
  }

  canaryLocalDeployment(
    deploymentId: string,
    trafficPercent: number,
    approval?: JsonValue,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.operateLocalDeployment(
      deploymentId,
      'canary',
      { trafficPercent, ...(approval === undefined ? {} : { approval }) },
      options,
    );
  }

  promoteLocalDeployment(
    deploymentId: string,
    approval?: JsonValue,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.operateLocalDeployment(
      deploymentId,
      'promote',
      approval === undefined ? {} : { approval },
      options,
    );
  }

  rollbackLocalDeployment(
    deploymentId: string,
    approval?: JsonValue,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.operateLocalDeployment(
      deploymentId,
      'rollback',
      approval === undefined ? {} : { approval },
      options,
    );
  }

  stopLocalDeployment(deploymentId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.operateLocalDeployment(deploymentId, 'stop', {}, options);
  }

  archiveLocalDeployment(deploymentId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.operateLocalDeployment(deploymentId, 'archive', {}, options);
  }

  restartLocalDeployment(deploymentId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.operateLocalDeployment(deploymentId, 'restart', {}, options);
  }

  scaleLocalDeployment(
    deploymentId: string,
    scaling: JsonValue,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.operateLocalDeployment(deploymentId, 'scale', { scaling }, options);
  }

  invokeLocalDeployment(
    deploymentId: string,
    input: JsonValue = {},
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.operateLocalDeployment(deploymentId, 'invoke', input, options);
  }

  smokeTestLocalDeployment(
    deploymentId: string,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.operateLocalDeployment(deploymentId, 'smoke-test', {}, options);
  }

  localDeploymentTelemetry(
    deploymentId: string,
    telemetry: 'metrics' | 'logs' | 'revisions' | 'events',
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.get(`/v1/deployments/local/${encode(deploymentId)}/${telemetry}`, options);
  }

  localDeploymentMetrics(deploymentId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.localDeploymentTelemetry(deploymentId, 'metrics', options);
  }

  localDeploymentLogs(deploymentId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.localDeploymentTelemetry(deploymentId, 'logs', options);
  }

  localDeploymentRevisions(
    deploymentId: string,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.localDeploymentTelemetry(deploymentId, 'revisions', options);
  }

  servingEndpoints(options?: ClientRequestOptions): Promise<ServingEndpointListResponse> {
    return this.get('/v1/serving/endpoints', options);
  }

  createServingEndpoint(
    input: JsonValue,
    options?: ClientRequestOptions,
  ): Promise<ServingEndpointV1> {
    return this.post('/v1/serving/endpoints', input, options);
  }

  servingEndpoint(endpointId: Id, options?: ClientRequestOptions): Promise<ServingEndpointV1> {
    return this.get(`/v1/serving/endpoints/${encode(endpointId)}`, options);
  }

  servingDeployments(
    endpointId: Id,
    options?: ClientRequestOptions,
  ): Promise<ServingDeploymentListResponse> {
    return this.get(`/v1/serving/endpoints/${encode(endpointId)}/deployments`, options);
  }

  requestServingDeployment(
    endpointId: Id,
    input: JsonValue,
    options?: ClientRequestOptions,
  ): Promise<ServingRevisionV1> {
    return this.post(`/v1/serving/endpoints/${encode(endpointId)}/deployments`, input, options);
  }

  servingDeployment(deploymentId: Id, options?: ClientRequestOptions): Promise<ServingRevisionV1> {
    return this.get(`/v1/serving/deployments/${encode(deploymentId)}`, options);
  }

  advanceServingDeployment(
    deploymentId: Id,
    action: string,
    approval?: ServingTrafficApproval,
    options?: ClientRequestOptions,
  ): Promise<ServingRevisionV1> {
    const body = {
      action,
      ...(approval === undefined ? {} : { approval }),
    } as unknown as JsonValue;
    return this.post(`/v1/serving/deployments/${encode(deploymentId)}/actions`, body, options);
  }

  observeServingDeployment(
    deploymentId: Id,
    healthy: boolean,
    error?: string,
    options?: ClientRequestOptions,
  ): Promise<ServingRevisionV1> {
    const body = {
      healthy,
      ...(error === undefined ? {} : { error }),
    } as JsonValue;
    return this.post(`/v1/serving/deployments/${encode(deploymentId)}/health`, body, options);
  }

  rollbackServingDeployment(
    deploymentId: Id,
    approval: ServingTrafficApproval,
    options?: ClientRequestOptions,
  ): Promise<ServingRevisionV1> {
    return this.post(
      `/v1/serving/deployments/${encode(deploymentId)}/rollback-if-unhealthy`,
      { approval } as unknown as JsonValue,
      options,
    );
  }

  scopedBudgets(options?: ClientRequestOptions): Promise<ScopedBudgetListResponse> {
    return this.get('/v1/scoped-budgets', options);
  }

  createScopedBudget(
    input: JsonValue,
    options?: ClientRequestOptions,
  ): Promise<ScopedBudgetSnapshot> {
    return this.post('/v1/scoped-budgets', input, options);
  }

  scopedBudget(budgetId: Id, options?: ClientRequestOptions): Promise<ScopedBudgetSnapshot> {
    return this.get(`/v1/scoped-budgets/${encode(budgetId)}`, options);
  }

  reserveScopedBudget(
    budgetId: Id,
    input: JsonValue,
    options?: ClientRequestOptions,
  ): Promise<ScopedReservationRecord> {
    return this.post(`/v1/scoped-budgets/${encode(budgetId)}/reservations`, input, options);
  }

  consumeScopedReservation(
    reservationId: Id,
    amount: JsonValue,
    options?: ClientRequestOptions,
  ): Promise<ScopedReservationRecord> {
    return this.post(
      `/v1/scoped-reservations/${encode(reservationId)}/consume`,
      { amount } as JsonValue,
      options,
    );
  }

  reconcileScopedReservation(
    reservationId: Id,
    actual: JsonValue,
    options?: ClientRequestOptions,
  ): Promise<ScopedReservationRecord> {
    return this.post(
      `/v1/scoped-reservations/${encode(reservationId)}/reconcile`,
      { actual } as JsonValue,
      options,
    );
  }

  releaseScopedReservation(
    reservationId: Id,
    options?: ClientRequestOptions,
  ): Promise<ScopedReservationRecord> {
    return this.post(`/v1/scoped-reservations/${encode(reservationId)}/release`, {}, options);
  }

  estimateCost(input: JsonValue, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post('/v1/cost/estimate', input, options);
  }

  checkCostPolicy(input: JsonValue, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post('/v1/cost/policy-check', input, options);
  }

  agentDefinitions(options?: ClientRequestOptions): Promise<AgentDefinitionListResponse> {
    return this.get('/v1/agent-definitions', options);
  }

  resolveAgent(input: JsonValue, options?: ClientRequestOptions): Promise<AgentRouteDecision> {
    return this.post('/v1/agent-definitions/resolve', input, options);
  }

  updateAgentRollout(
    agentType: string,
    version: string,
    input: JsonValue,
    options?: ClientRequestOptions,
  ): Promise<AgentDefinitionV1> {
    return this.post(
      `/v1/agent-definitions/${encode(agentType)}/${encode(version)}/rollout`,
      input,
      options,
    );
  }

  rollbackAgent(
    agentType: string,
    version: string,
    options?: ClientRequestOptions,
  ): Promise<AgentDefinitionV1> {
    return this.post(
      `/v1/agent-definitions/${encode(agentType)}/${encode(version)}/rollback`,
      {},
      options,
    );
  }

  beginAgentInvocation(input: JsonValue, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post('/v1/agent-invocations', input, options);
  }

  finishAgentInvocation(leaseId: Id, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post(`/v1/agent-invocations/${encode(leaseId)}/finish`, {}, options);
  }

  recoveryBackups(options?: ClientRequestOptions): Promise<RecoveryBackupListResponse> {
    return this.get('/v1/recovery/backups', options);
  }

  createRecoveryBackup(input: JsonValue, options?: ClientRequestOptions): Promise<BackupRecordV1> {
    return this.post('/v1/recovery/backups', input, options);
  }

  recoveryBackup(backupId: Id, options?: ClientRequestOptions): Promise<BackupRecordV1> {
    return this.get(`/v1/recovery/backups/${encode(backupId)}`, options);
  }

  verifyRecoveryBackup(backupId: Id, options?: ClientRequestOptions): Promise<BackupRecordV1> {
    return this.post(`/v1/recovery/backups/${encode(backupId)}/verify`, {}, options);
  }

  previewRecoveryRestore(backupId: Id, options?: ClientRequestOptions): Promise<RestorePreviewV1> {
    return this.post(`/v1/recovery/backups/${encode(backupId)}/preview`, {}, options);
  }

  restoreRecoveryBackup(
    backupId: Id,
    approvalDigest: string,
    options?: ClientRequestOptions,
  ): Promise<RestoreEvidenceV1> {
    return this.post(
      `/v1/recovery/backups/${encode(backupId)}/restore`,
      { approvalDigest } as JsonValue,
      options,
    );
  }

  runRecoveryExercise(backupId: Id, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post(`/v1/recovery/backups/${encode(backupId)}/exercise`, {}, options);
  }

  openCollaborationDocument(
    input: JsonValue,
    options?: ClientRequestOptions,
  ): Promise<CollaborationDocumentV1> {
    return this.post('/v1/collaboration/documents', input, options);
  }

  collaborationDocument(
    documentId: Id,
    options?: ClientRequestOptions,
  ): Promise<CollaborationDocumentV1> {
    return this.get(`/v1/collaboration/documents/${encode(documentId)}`, options);
  }

  writeCollaborationDocument(
    documentId: Id,
    input: JsonValue,
    options?: ClientRequestOptions,
  ): Promise<CollaborationWriteResult> {
    return this.request('PUT', `/v1/collaboration/documents/${encode(documentId)}`, input, options);
  }

  collaborationPresence(
    documentId: Id,
    options?: ClientRequestOptions,
  ): Promise<CollaborationPresenceListResponse> {
    return this.get(`/v1/collaboration/documents/${encode(documentId)}/presence`, options);
  }

  updateCollaborationPresence(
    documentId: Id,
    input: JsonValue,
    options?: ClientRequestOptions,
  ): Promise<CollaborationPresenceV1> {
    return this.post(`/v1/collaboration/documents/${encode(documentId)}/presence`, input, options);
  }

  collaborationConflicts(
    documentId: Id,
    options?: ClientRequestOptions,
  ): Promise<CollaborationConflictListResponse> {
    return this.get(`/v1/collaboration/documents/${encode(documentId)}/conflicts`, options);
  }

  governanceOrganizations(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get('/v1/governance/organizations', options);
  }

  createGovernanceOrganization(
    input: JsonValue,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.post('/v1/governance/organizations', input, options);
  }

  governanceMembers(organizationId: Id, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/governance/organizations/${encode(organizationId)}/members`, options);
  }

  governanceOverview(organizationId: Id, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/governance/organizations/${encode(organizationId)}/overview`, options);
  }

  governanceProviders(organizationId: Id, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/governance/organizations/${encode(organizationId)}/providers`, options);
  }

  upsertGovernanceMember(
    organizationId: Id,
    input: JsonValue,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.post(
      `/v1/governance/organizations/${encode(organizationId)}/members`,
      input,
      options,
    );
  }

  governancePolicies(organizationId: Id, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/governance/organizations/${encode(organizationId)}/policies`, options);
  }

  putGovernancePolicy(
    organizationId: Id,
    input: JsonValue,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.post(
      `/v1/governance/organizations/${encode(organizationId)}/policies`,
      input,
      options,
    );
  }

  governanceBudgets(organizationId: Id, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/governance/organizations/${encode(organizationId)}/budgets`, options);
  }

  setGovernanceBudget(
    organizationId: Id,
    input: JsonValue,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.post(
      `/v1/governance/organizations/${encode(organizationId)}/budgets`,
      input,
      options,
    );
  }

  governanceUsage(organizationId: Id, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/governance/organizations/${encode(organizationId)}/usage`, options);
  }

  governanceForecast(organizationId: Id, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/governance/organizations/${encode(organizationId)}/forecast`, options);
  }

  governanceAudit(organizationId: Id, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/governance/organizations/${encode(organizationId)}/audit`, options);
  }

  verifyGovernanceAudit(organizationId: Id, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/governance/organizations/${encode(organizationId)}/audit/verify`, options);
  }

  evaluateGovernance(input: JsonValue, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post('/v1/governance/evaluate', input, options);
  }

  commitGovernedExecution(input: JsonValue, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post('/v1/governance/commit', input, options);
  }

  enterpriseSsoProviders(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get('/v1/enterprise/sso/providers', options);
  }

  registerEnterpriseSsoProvider(
    input: JsonValue,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.post('/v1/enterprise/sso/providers', input, options);
  }

  startEnterpriseSsoLogin(input: JsonValue, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post('/v1/enterprise/sso/login/start', input, options);
  }

  completeEnterpriseSsoLogin(input: JsonValue, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post('/v1/enterprise/sso/login/complete', input, options);
  }

  enterpriseScimUsers(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get('/v1/enterprise/scim/users', options);
  }

  upsertEnterpriseScimUser(input: JsonValue, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post('/v1/enterprise/scim/users', input, options);
  }

  issueEnterpriseSecretHandle(
    input: JsonValue,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.post('/v1/enterprise/secrets/handles', input, options);
  }

  rotateEnterpriseSecretHandle(
    handleId: Id,
    input: JsonValue,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.post(`/v1/enterprise/secrets/handles/${encode(handleId)}/rotate`, input, options);
  }

  registerEnterpriseRunner(input: JsonValue, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post('/v1/enterprise/runners', input, options);
  }

  enterpriseExecutions(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get('/v1/enterprise/executions', options);
  }

  submitEnterpriseExecution(input: JsonValue, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post('/v1/enterprise/executions', input, options);
  }

  enterpriseExecution(executionId: Id, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/enterprise/executions/${encode(executionId)}`, options);
  }

  observeEnterpriseExecution(executionId: Id, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/enterprise/executions/${encode(executionId)}/observe`, options);
  }

  terminateEnterpriseExecution(
    executionId: Id,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.post(`/v1/enterprise/executions/${encode(executionId)}/terminate`, {}, options);
  }

  pipelines(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get('/v1/pipelines/local', options);
  }

  createPipeline(input: JsonValue = {}, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post('/v1/pipelines/local', input, options);
  }

  pipeline(pipelineId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/pipelines/local/${encode(pipelineId)}`, options);
  }

  updatePipeline(
    pipelineId: string,
    definition: JsonValue,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.post(`/v1/pipelines/local/${encode(pipelineId)}`, { definition }, options);
  }

  validatePipeline(pipelineId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post(`/v1/pipelines/local/${encode(pipelineId)}/validate`, {}, options);
  }

  planPipeline(pipelineId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/pipelines/local/${encode(pipelineId)}/plan`, options);
  }

  estimatePipeline(pipelineId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/pipelines/local/${encode(pipelineId)}/estimate`, options);
  }

  pipelineVersions(pipelineId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/pipelines/local/${encode(pipelineId)}/versions`, options);
  }

  publishPipeline(
    pipelineId: string,
    version?: number,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.post(
      `/v1/pipelines/local/${encode(pipelineId)}/publish`,
      version === undefined ? {} : { version },
      options,
    );
  }

  runPipeline(
    pipelineId: string,
    input: JsonValue = {},
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.post(`/v1/pipelines/local/${encode(pipelineId)}/run`, input, options);
  }

  dryRunPipeline(
    pipelineId: string,
    input: JsonValue = {},
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.post(`/v1/pipelines/local/${encode(pipelineId)}/dry-run`, input, options);
  }

  pipelineRuns(pipelineId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/pipelines/local/${encode(pipelineId)}/runs`, options);
  }

  pipelineRun(runId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/pipelines/local/runs/${encode(runId)}`, options);
  }

  cancelPipelineRun(runId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post(`/v1/pipelines/local/runs/${encode(runId)}/cancel`, {}, options);
  }

  retryPipelineStage(
    runId: string,
    stageId: string,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.post(
      `/v1/pipelines/local/runs/${encode(runId)}/stages/${encode(stageId)}/retry`,
      {},
      options,
    );
  }

  automations(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get('/v1/automations/local', options);
  }

  createAutomation(input: JsonValue, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post('/v1/automations/local', input, options);
  }

  automation(automationId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/automations/local/${encode(automationId)}`, options);
  }

  pauseAutomation(automationId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post(`/v1/automations/local/${encode(automationId)}/pause`, {}, options);
  }

  resumeAutomation(automationId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post(`/v1/automations/local/${encode(automationId)}/resume`, {}, options);
  }

  triggerAutomation(
    automationId: string,
    input: JsonValue = {},
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.post(`/v1/automations/local/${encode(automationId)}/trigger`, input, options);
  }

  automationRuns(automationId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/automations/local/${encode(automationId)}/runs`, options);
  }

  automationNotifications(
    automationId: string,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.get(`/v1/automations/local/${encode(automationId)}/notifications`, options);
  }

  automationWebhook(
    automationId: string,
    input: JsonValue,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.post(`/v1/automations/local/${encode(automationId)}/webhook`, input, options);
  }

  automationEvent(input: JsonValue, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post('/v1/automations/events', input, options);
  }

  automationDataArrival(input: JsonValue, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post('/v1/automations/data-arrivals', input, options);
  }

  automationRepositoryEvent(input: JsonValue, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post('/v1/automations/repositories/events', input, options);
  }

  tickAutomations(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post('/v1/automations/tick', {}, options);
  }

  connectorCatalog(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get('/v1/connectors/catalog', options);
  }

  connector(connectorId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/connectors/${encode(connectorId)}`, options);
  }

  discoverConnector(
    connectorId: string,
    input: JsonValue = {},
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.post(`/v1/connectors/${encode(connectorId)}/discover`, input, options);
  }

  connectorRuns(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get('/v1/connector-runs', options);
  }

  connectorCheckpoints(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get('/v1/connector-checkpoints', options);
  }

  connectorSchemaEvents(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get('/v1/connector-schema-events', options);
  }

  runConnector(input: JsonValue, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post('/v1/connector-runs', input, options);
  }

  connectorRun(runId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/connector-runs/${encode(runId)}`, options);
  }

  cancelConnectorRun(runId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post(`/v1/connector-runs/${encode(runId)}/cancel`, {}, options);
  }

  listNotebooks(options?: ClientRequestOptions): Promise<readonly NotebookDocumentResponse[]> {
    return this.get('/v1/notebooks', options);
  }

  notebooks(options?: ClientRequestOptions): Promise<readonly NotebookDocumentResponse[]> {
    return this.listNotebooks(options);
  }

  createNotebook(
    input: JsonValue = {},
    options?: ClientRequestOptions,
  ): Promise<NotebookDocumentResponse> {
    return this.post('/v1/notebooks', input, options);
  }

  notebook(notebookId: string, options?: ClientRequestOptions): Promise<NotebookDocumentResponse> {
    return this.get(`/v1/notebooks/${encode(notebookId)}`, options);
  }

  openNotebook(
    notebookId: string,
    revision?: number,
    options?: ClientRequestOptions,
  ): Promise<NotebookDocumentResponse> {
    return this.post(
      `/v1/notebooks/${encode(notebookId)}/open`,
      revision === undefined ? {} : ({ revision } as JsonValue),
      options,
    );
  }

  duplicateNotebook(
    notebookId: string,
    input: JsonValue = {},
    options?: ClientRequestOptions,
  ): Promise<NotebookDocumentResponse> {
    return this.post(`/v1/notebooks/${encode(notebookId)}/duplicate`, input, options);
  }

  renameNotebook(
    notebookId: string,
    title: string,
    options?: ClientRequestOptions,
  ): Promise<NotebookDocumentResponse> {
    return this.patch(`/v1/notebooks/${encode(notebookId)}`, { title }, options);
  }

  archiveNotebook(
    notebookId: string,
    options?: ClientRequestOptions,
  ): Promise<NotebookDocumentResponse> {
    return this.post(`/v1/notebooks/${encode(notebookId)}/archive`, {}, options);
  }

  restoreNotebook(
    notebookId: string,
    options?: ClientRequestOptions,
  ): Promise<NotebookDocumentResponse> {
    return this.post(`/v1/notebooks/${encode(notebookId)}/restore`, {}, options);
  }

  deleteNotebook(notebookId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.delete(`/v1/notebooks/${encode(notebookId)}`, options);
  }

  notebookVersions(
    notebookId: string,
    options?: ClientRequestOptions,
  ): Promise<readonly NotebookVersionResponse[]> {
    return this.get(`/v1/notebooks/${encode(notebookId)}/versions`, options);
  }

  notebookVersion(
    notebookId: string,
    revision: number,
    options?: ClientRequestOptions,
  ): Promise<NotebookDocumentResponse> {
    return this.get(`/v1/notebooks/${encode(notebookId)}/versions/${revision}`, options);
  }

  upsertNotebookCell(
    notebookId: string,
    cellId: string,
    input: JsonValue,
    options?: ClientRequestOptions,
  ): Promise<NotebookDocumentResponse> {
    return this.post(`/v1/notebooks/${encode(notebookId)}/cells/${encode(cellId)}`, input, options);
  }

  runNotebookCell(
    notebookId: string,
    cellId: string,
    input: JsonValue,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.post(
      `/v1/notebooks/${encode(notebookId)}/cells/${encode(cellId)}/run`,
      input,
      options,
    );
  }

  cancelNotebookCell(
    notebookId: string,
    cellId: string,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.post(
      `/v1/notebooks/${encode(notebookId)}/cells/${encode(cellId)}/cancel`,
      {},
      options,
    );
  }

  restartNotebook(
    notebookId: string,
    options?: ClientRequestOptions,
  ): Promise<NotebookDocumentResponse> {
    return this.post(`/v1/notebooks/${encode(notebookId)}/restart`, {}, options);
  }

  exportNotebook(notebookId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/notebooks/${encode(notebookId)}/export`, options);
  }

  importNotebook(
    notebookId: string,
    document: JsonValue,
    options?: ClientRequestOptions,
  ): Promise<NotebookDocumentResponse> {
    return this.post(`/v1/notebooks/${encode(notebookId)}/import`, { document }, options);
  }

  runNotebook(
    notebookId: string,
    input: JsonValue = {},
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.post(`/v1/notebooks/${encode(notebookId)}/run`, input, options);
  }

  notebookExecutions(
    notebookId: string,
    options?: ClientRequestOptions,
  ): Promise<readonly Record<string, unknown>[]> {
    return this.get(`/v1/notebooks/${encode(notebookId)}/executions`, options);
  }

  notebookUsage(notebookId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/notebooks/${encode(notebookId)}/usage`, options);
  }

  notebookRuns(
    notebookId: string,
    options?: ClientRequestOptions,
  ): Promise<readonly Record<string, unknown>[]> {
    return this.get(`/v1/notebooks/${encode(notebookId)}/runs`, options);
  }

  notebookRun(
    notebookId: string,
    runId: string,
    options?: ClientRequestOptions,
  ): Promise<Record<string, unknown>> {
    return this.get(`/v1/notebooks/${encode(notebookId)}/runs/${encode(runId)}`, options);
  }

  jupyterDiscovery(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get('/v1/jupyter/discovery', options);
  }

  jupyterSessions(options?: ClientRequestOptions): Promise<readonly JupyterSessionResponse[]> {
    return this.get('/v1/jupyter/sessions', options);
  }

  launchJupyterSession(
    input: JsonValue = {},
    options?: ClientRequestOptions,
  ): Promise<JupyterLaunchResponse> {
    return this.post('/v1/jupyter/sessions', input, options);
  }

  jupyterSession(
    sessionId: string,
    options?: ClientRequestOptions,
  ): Promise<JupyterSessionResponse> {
    return this.get(`/v1/jupyter/sessions/${encode(sessionId)}`, options);
  }

  stopJupyterSession(sessionId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post(`/v1/jupyter/sessions/${encode(sessionId)}/stop`, {}, options);
  }

  jupyterSessionAction(
    sessionId: string,
    action: 'interrupt' | 'restart' | 'reconnect',
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.post(`/v1/jupyter/sessions/${encode(sessionId)}/${action}`, {}, options);
  }

  projects(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get('/v1/projections/projects', options);
  }

  runtimeProfiles(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get('/v1/runtimes/profiles', options);
  }

  onboarding(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get('/v1/onboarding', options);
  }

  completeOnboarding(input: JsonValue, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post('/v1/onboarding', input, options);
  }

  computeProfiles(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get('/v1/runtimes/compute-profiles', options);
  }

  createComputeProfile(input: JsonValue, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post('/v1/runtimes/compute-profiles', input, options);
  }

  selectComputeProfile(input: JsonValue = {}, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post('/v1/runtimes/compute-selection', input, options);
  }

  localRepositories(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get('/v1/repositories/local', options);
  }

  repositoryStatus(repositoryId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/repositories/local/${encode(repositoryId)}/status`, options);
  }

  repositoryDiff(repositoryId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/repositories/local/${encode(repositoryId)}/diff`, options);
  }

  repositoryFiles(
    repositoryId: string,
    prefix?: string,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    const suffix = prefix === undefined ? '' : `?prefix=${encode(prefix)}`;
    return this.get(`/v1/repositories/local/${encode(repositoryId)}/files${suffix}`, options);
  }

  repositoryFile(
    repositoryId: string,
    path: string,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.get(
      `/v1/repositories/local/${encode(repositoryId)}/file?path=${encode(path)}`,
      options,
    );
  }

  writeRepositoryFile(
    repositoryId: string,
    input: JsonValue,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.post(`/v1/repositories/local/${encode(repositoryId)}/file`, input, options);
  }

  runRepositoryTest(
    repositoryId: string,
    input: JsonValue,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.post(`/v1/repositories/local/${encode(repositoryId)}/tests`, input, options);
  }

  artifacts(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get('/v1/artifacts', options);
  }

  listArtifacts(options: PaginationOptions = {}): Promise<ClientPage<JsonValue>> {
    return this.paginate<JsonValue>('/v1/artifacts', options, 'artifacts');
  }

  artifact(artifactId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/artifacts/${encode(artifactId)}`, options);
  }

  artifactVersions(artifactId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/artifacts/${encode(artifactId)}/versions`, options);
  }

  artifactLineage(artifactId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/artifacts/${encode(artifactId)}/lineage`, options);
  }

  artifactContent(
    artifactId: string,
    version: number,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.get(`/v1/artifacts/${encode(artifactId)}/versions/${version}/content`, options);
  }

  stageArtifactUpload(
    content: string,
    mediaType: string,
    expectedContentHash?: string,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.post(
      '/v1/artifacts/uploads',
      {
        content,
        mediaType,
        ...(expectedContentHash === undefined ? {} : { expectedContentHash }),
      },
      options,
    );
  }

  publishArtifactVersion(
    artifactId: string,
    input: JsonValue,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.post(`/v1/artifacts/${encode(artifactId)}/versions`, input, options);
  }

  artifactDiff(
    artifactId: string,
    fromVersion?: number,
    toVersion?: number,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    const query = new URLSearchParams();
    if (fromVersion !== undefined) query.set('fromVersion', String(fromVersion));
    if (toVersion !== undefined) query.set('toVersion', String(toVersion));
    const suffix = query.toString();
    return this.get(
      `/v1/artifacts/${encode(artifactId)}/diff${suffix.length === 0 ? '' : `?${suffix}`}`,
      options,
    );
  }

  chooseVisualization(
    input: JsonValue,
    override?: ClientVisualizationType,
    options?: ClientRequestOptions,
  ): Promise<JsonValue> {
    return this.post(
      '/v1/visualizations/choose',
      {
        ...jsonRecord(input),
        ...(override === undefined ? {} : { type: override }),
      } as unknown as JsonValue,
      options,
    );
  }

  validateVisualization(input: JsonValue, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post('/v1/visualizations/validate', input, options);
  }

  renderVisualization(input: JsonValue, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post('/v1/visualizations/render', input, options);
  }

  workspaceIntake(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get('/v1/workspace/intake', options);
  }

  workspaceInbox(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get('/v1/workspace/inbox', options);
  }

  workspaceWatch(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get('/v1/workspace/watch', options);
  }

  workspaceRecommendations(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get('/v1/workspace/recommendations', options);
  }

  workspaceContext(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get('/v1/workspace/context', options);
  }

  trainingRuns(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get('/v1/training/runs', options);
  }

  startTraining(input: JsonValue, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post('/v1/training/runs', input, options);
  }

  trainingRun(runId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/training/runs/${encode(runId)}`, options);
  }

  cancelTraining(runId: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post(`/v1/training/runs/${encode(runId)}/cancel`, {}, options);
  }

  approvals(
    options: PaginationOptions = {},
  ): Promise<readonly ClientApprovalRecord[] | ClientPage<ClientApprovalRecord>> {
    return this.get(withPagination('/v1/approvals', options), options);
  }

  listApprovals(options: PaginationOptions = {}): Promise<ClientPage<ClientApprovalRecord>> {
    return this.paginate<ClientApprovalRecord>('/v1/approvals', options);
  }

  approveApproval(
    approvalId: Id,
    reason?: string,
    options?: ClientRequestOptions,
  ): Promise<ClientApprovalRecord> {
    return this.post(
      `/v1/approvals/${encode(approvalId)}/approve`,
      reason === undefined ? {} : { reason },
      options,
    );
  }

  rejectApproval(
    approvalId: Id,
    reason?: string,
    options?: ClientRequestOptions,
  ): Promise<ClientApprovalRecord> {
    return this.post(
      `/v1/approvals/${encode(approvalId)}/reject`,
      reason === undefined ? {} : { reason },
      options,
    );
  }

  revokeApproval(
    approvalId: Id,
    reason?: string,
    options?: ClientRequestOptions,
  ): Promise<ClientApprovalRecord> {
    return this.post(
      `/v1/approvals/${encode(approvalId)}/revoke`,
      reason === undefined ? {} : { reason },
      options,
    );
  }

  async command<T>(input: {
    readonly commandType: string;
    readonly payload: JsonValue;
    readonly idempotencyKey?: string;
  }): Promise<T> {
    const session = await this.session();
    const now = new Date().toISOString();
    const command: RuntimeCommand = {
      schemaVersion: 1,
      commandId: cryptoId(),
      commandType: input.commandType,
      tenant: session.tenant,
      actor: session.actor,
      issuedAt: now,
      idempotencyKey: input.idempotencyKey ?? `${input.commandType}:${cryptoId()}`,
      correlationId: cryptoId(),
      payload: input.payload,
    };
    return this.post<T>('/v1/commands', command as unknown as JsonValue);
  }

  createProject(name: string, objective?: string): Promise<JsonValue> {
    return this.command({
      commandType: 'CreateProject',
      payload: {
        name,
        ...(objective === undefined ? {} : { objective }),
      } as JsonValue,
    });
  }

  projectConversation(projectId: Id, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/projects/${encode(projectId)}/conversation`, options);
  }

  projectAgentSession(projectId: Id, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/projects/${encode(projectId)}/agent-session`, options);
  }

  agentSession(sessionId: Id, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get(`/v1/agent-sessions/${encode(sessionId)}`, options);
  }

  workspace(options?: ClientRequestOptions): Promise<JsonValue> {
    return this.get('/v1/workspace', options);
  }

  sendMessage(
    projectId: Id,
    text: string,
    options?: ClientRequestOptions,
    sourceInterface:
      | 'tui'
      | 'cli'
      | 'acp'
      | 'jupyter'
      | 'web'
      | 'api'
      | 'automation'
      | 'system' = 'cli',
    modelOverride?: { readonly providerId: string; readonly modelId: string },
  ): Promise<JsonValue> {
    return this.post(
      `/v1/projects/${encode(projectId)}/conversation/messages`,
      {
        text,
        sourceInterface,
        ...(modelOverride === undefined ? {} : { model: modelOverride }),
      },
      options,
    );
  }

  runs(projectId?: Id, options?: ClientRequestOptions): Promise<{ readonly runs: readonly Run[] }> {
    const query = projectId === undefined ? '' : `?projectId=${encode(projectId)}`;
    return this.get(`/v1/runs${query}`, options);
  }

  listRuns(projectId?: Id, options: PaginationOptions = {}): Promise<ClientPage<Run>> {
    const query = projectId === undefined ? '' : `?projectId=${encode(projectId)}`;
    return this.paginate<Run>(`/v1/runs${query}`, options, 'runs');
  }

  run(runId: Id, options?: ClientRequestOptions): Promise<RunDetail> {
    return this.get(`/v1/runs/${encode(runId)}`, options);
  }

  runLogs(
    runId: Id,
    options?: ClientRequestOptions,
  ): Promise<{ readonly runId: Id; readonly logs: readonly RunLog[] }> {
    return this.get(`/v1/runs/${encode(runId)}/logs`, options);
  }

  cancelRun(runId: Id, reason?: string, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post(
      `/v1/runs/${encode(runId)}/cancel`,
      reason === undefined ? {} : { reason },
      options,
    );
  }

  retryRun(runId: Id, options?: ClientRequestOptions): Promise<JsonValue> {
    return this.post(`/v1/runs/${encode(runId)}/retry`, {}, options);
  }

  async *events(options: EventStreamOptions = {}): AsyncIterable<SubscriptionPage> {
    let cursor = options.afterCursor ?? 0;
    let reconnects = 0;
    const maxReconnects = options.maxReconnects ?? 5;
    while (!options.signal?.aborted) {
      const query = new URLSearchParams({ afterCursor: String(cursor) });
      if (options.maxEvents !== undefined) query.set('maxEvents', String(options.maxEvents));
      for (const topic of options.topics ?? []) query.append('topic', topic);
      const headers: Record<string, string> = { accept: 'text/event-stream' };
      if (this.options.token !== undefined)
        headers['authorization'] = `Bearer ${this.options.token}`;
      if (this.options.workspaceId !== undefined)
        headers['x-agentic-workspace-id'] = this.options.workspaceId;
      try {
        options.onConnectionStateChange?.(reconnects === 0 ? 'connecting' : 'reconnecting');
        let response: Response;
        try {
          response = await this.fetcher(
            `${this.baseUrl}/v1/subscriptions/events?${query.toString()}`,
            {
              method: 'GET',
              headers,
              ...(options.signal === undefined ? {} : { signal: options.signal }),
            },
          );
        } catch (error) {
          if (options.signal?.aborted) throw error;
          throw SpyderbyteClientError.fromTransport(error);
        }
        if (!response.ok)
          throw new SpyderbyteClientError(response.status, await responseBody(response));
        reconnects = 0;
        options.onConnectionStateChange?.('connected');
        for await (const page of ssePages(response)) {
          cursor = Math.max(cursor, page.cursor);
          yield page;
        }
        if (options.signal?.aborted) return;
        throw new SpyderbyteClientError(0, {
          error: 'The Spyderbyte event stream ended before cancellation.',
          code: 'EXTERNAL_DEPENDENCY_UNAVAILABLE',
        });
      } catch (error) {
        if (options.signal?.aborted) return;
        if (reconnects >= maxReconnects) {
          options.onConnectionStateChange?.('disconnected');
          throw error;
        }
        options.onConnectionStateChange?.('reconnecting');
        reconnects += 1;
        await sleep(options.reconnectDelayMs ?? 250, options.signal);
      }
    }
  }

  async *followRun(runId: Id, options: EventStreamOptions = {}): AsyncIterable<RunDetail> {
    for await (const page of this.events(options)) {
      if (page.refreshRequired || page.events.some((event) => event.aggregateId === runId)) {
        const detail = await this.run(runId, options);
        yield detail;
        if (
          ['succeeded', 'failed', 'cancelled', 'timed_out', 'partially_succeeded'].includes(
            detail.run.state,
          )
        )
          return;
      }
    }
  }
}

export function createSpyderbyteClients(client: SpyderbyteClient): SpyderbyteClientBundle {
  return {
    agent: client,
    project: client,
    run: client,
    artifact: client,
    provider: client,
    runtime: client,
    approval: client,
    usage: client,
    visualization: client,
    workspaceIntake: client,
  };
}

function cryptoId(): Id {
  return newSortableId();
}
