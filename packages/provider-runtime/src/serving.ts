import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runtimeError, type JsonValue } from '@agentic-platform/runtime-contracts';

/**
 * The local adapter keeps the legacy states for compatibility with the first local serving
 * surface. Rich deployments use the phase-seven lifecycle states below.
 */
export type LocalDeploymentState =
  | 'draft'
  | 'validating'
  | 'provisioning'
  | 'deploying'
  | 'healthy'
  | 'degraded'
  | 'failed'
  | 'updating'
  | 'stopped'
  | 'archived'
  | 'starting'
  | 'active'
  | 'unhealthy'
  | 'rolled-back';

export type LocalServingEndpointState =
  | 'draft'
  | 'provisioning'
  | 'deploying'
  | 'healthy'
  | 'degraded'
  | 'failed'
  | 'updating'
  | 'stopped'
  | 'archived';

export interface LocalServingResourcesV1 {
  readonly cpuMillicores?: number;
  readonly memoryBytes?: number;
  readonly gpuType?: string;
  readonly gpuCount?: number;
}

export interface LocalServingScalingV1 {
  readonly minReplicas: number;
  readonly maxReplicas: number;
  readonly targetConcurrency?: number;
  readonly targetCpuPercent?: number;
}

export interface LocalServingAuthV1 {
  readonly mode: 'none' | 'workspace' | 'api_key' | 'bearer';
  /** A reference only; secret material is never persisted in a deployment record. */
  readonly secretRef?: string;
}

export interface LocalServingHealthCheckV1 {
  readonly url?: string;
  readonly path?: string;
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
  readonly successThreshold?: number;
  readonly failureThreshold?: number;
}

export interface LocalServingRolloutPolicyV1 {
  readonly strategy: 'rolling' | 'canary';
  readonly maxUnavailablePercent?: number;
  readonly maxSurgePercent?: number;
  readonly canaryPercent?: number;
  readonly autoRollbackOnDegraded?: boolean;
}

export interface LocalServingApprovalV1 {
  readonly approved: true;
  readonly actionDigest: string;
  readonly commitDigest: string;
  readonly expiresAt: string;
  readonly approvalId?: string;
  readonly actorId?: string;
}

export interface LocalServingRequestV1 {
  readonly deploymentId?: string;
  readonly endpointId?: string;
  readonly endpointName?: string;
  readonly modelId: string;
  readonly modelVersionId?: string;
  readonly modelArtifactId?: string;
  readonly servingRuntime?: string;
  readonly region?: string;
  readonly resources?: LocalServingResourcesV1;
  readonly scaling?: LocalServingScalingV1;
  readonly environment?: Readonly<Record<string, string>>;
  /** References are accepted; secret values are deliberately not accepted. */
  readonly secretRefs?: readonly string[];
  readonly networkVisibility?: 'loopback' | 'private' | 'public';
  readonly auth?: LocalServingAuthV1;
  readonly healthCheck?: LocalServingHealthCheckV1;
  readonly rolloutPolicy?: LocalServingRolloutPolicyV1;
  readonly port?: number;
  readonly healthUrl?: string;
  readonly invokeUrl?: string;
  /** Legacy local requests do not set this and remain backwards compatible. */
  readonly approvalRequired?: boolean;
}

export interface LocalServingHealthEvidenceV1 {
  readonly checkedAt: string;
  readonly url: string;
  readonly statusCode: number;
  readonly responseMs: number;
  readonly adapter: string;
  readonly evidenceDigest: string;
}

export interface LocalServingMetricsV1 {
  readonly healthChecks: number;
  readonly healthFailures: number;
  readonly requests: number;
  readonly successes: number;
  readonly errors: number;
  readonly totalLatencyMs: number;
  readonly averageLatencyMs: number;
  readonly p50LatencyMs?: number;
  readonly p95LatencyMs?: number;
  readonly lastRequestAt?: string;
  readonly lastErrorAt?: string;
}

export interface LocalServingUtilizationV1 {
  readonly observedAt: string;
  readonly cpuMillicores?: number;
  readonly memoryBytes?: number;
  readonly gpuUtilizationPercent?: number;
  readonly replicas: number;
}

export interface LocalServingCostV1 {
  readonly currency: string;
  readonly estimatedMinor: number;
  readonly actualMinor: number;
  readonly observedAt: string;
}

export interface LocalServingLogV1 {
  readonly sequence: number;
  readonly at: string;
  readonly stream: 'stdout' | 'stderr' | 'system';
  readonly message: string;
}

export interface LocalServingRevisionV1 {
  readonly revisionId: string;
  readonly deploymentId: string;
  readonly modelId: string;
  readonly modelVersionId?: string;
  readonly modelArtifactId?: string;
  readonly state: LocalDeploymentState;
  readonly trafficPercent: number;
  readonly createdAt: string;
  readonly healthyAt?: string;
  readonly supersededAt?: string;
  readonly reason?: string;
}

export interface LocalServingInvocationV1 {
  readonly invocationId: string;
  readonly endpointId?: string;
  readonly deploymentId: string;
  readonly modelVersionId?: string;
  readonly invokedAt: string;
  readonly method: string;
  readonly statusCode?: number;
  readonly latencyMs: number;
  readonly success: boolean;
  readonly response?: JsonValue;
  readonly error?: string;
}

export interface LocalServingSmokeTestV1 {
  readonly smokeTestId: string;
  readonly endpointId?: string;
  readonly deploymentId: string;
  readonly modelVersionId?: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly passed: boolean;
  readonly invocationId?: string;
  readonly healthEvidence?: LocalServingHealthEvidenceV1;
  readonly error?: string;
}

export interface LocalServingEventV1 {
  readonly eventId: string;
  readonly deploymentId?: string;
  readonly endpointId?: string;
  readonly action: string;
  readonly occurredAt: string;
  readonly details?: Readonly<Record<string, JsonValue>>;
}

export interface LocalServingEndpointV1 {
  readonly endpointId: string;
  readonly name: string;
  readonly modelId: string;
  readonly modelVersionId?: string;
  readonly state: LocalServingEndpointState;
  readonly activeDeploymentId?: string;
  readonly previousDeploymentId?: string;
  readonly revisionIds: readonly string[];
  readonly trafficPercent: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly healthEvidence?: LocalServingHealthEvidenceV1;
  readonly metrics?: LocalServingMetricsV1;
  readonly error?: string;
}

export interface LocalDeploymentV1 {
  readonly schemaVersion?: number;
  readonly deploymentId: string;
  readonly endpointId?: string;
  readonly revisionId?: string;
  readonly modelId: string;
  readonly modelVersionId?: string;
  readonly modelArtifactId?: string;
  readonly modelDisplayName?: string;
  readonly servingRuntime?: string;
  readonly region?: string;
  readonly resources?: LocalServingResourcesV1;
  readonly scaling?: LocalServingScalingV1;
  readonly environment?: Readonly<Record<string, string>>;
  readonly secretRefs?: readonly string[];
  readonly networkVisibility?: 'loopback' | 'private' | 'public';
  readonly auth?: LocalServingAuthV1;
  readonly healthCheck?: LocalServingHealthCheckV1;
  readonly rolloutPolicy?: LocalServingRolloutPolicyV1;
  readonly state: LocalDeploymentState;
  readonly trafficPercent: number;
  readonly port?: number;
  readonly healthUrl?: string;
  readonly invokeUrl?: string;
  readonly healthCheckedAt?: string;
  readonly healthEvidence?: LocalServingHealthEvidenceV1;
  readonly metrics?: LocalServingMetricsV1;
  readonly utilization?: LocalServingUtilizationV1;
  readonly cost?: LocalServingCostV1;
  readonly logs?: readonly LocalServingLogV1[];
  readonly revisionHistory?: readonly LocalServingRevisionV1[];
  readonly invocations?: readonly LocalServingInvocationV1[];
  readonly smokeTests?: readonly LocalServingSmokeTestV1[];
  readonly approvalRequired?: boolean;
  readonly lastAction?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly error?: string;
}

export type LocalServingAction = 'canary' | 'promote' | 'rollback';

export interface ModelServingRuntime {
  readonly available: boolean;
  list(): Promise<readonly LocalDeploymentV1[]>;
  get(deploymentId: string): Promise<LocalDeploymentV1 | undefined>;
  listEndpoints(): Promise<readonly LocalServingEndpointV1[]>;
  getEndpoint(endpointId: string): Promise<LocalServingEndpointV1 | undefined>;
  serve(input: LocalServingRequestV1): Promise<LocalDeploymentV1>;
  update(
    deploymentId: string,
    input: Partial<LocalServingRequestV1> & { readonly modelId?: string },
  ): Promise<LocalDeploymentV1>;
  rollingUpdate(
    deploymentId: string,
    input: Partial<LocalServingRequestV1> & { readonly modelId?: string },
  ): Promise<LocalDeploymentV1>;
  observe(deploymentId: string): Promise<LocalDeploymentV1>;
  canary(
    deploymentId: string,
    trafficPercent: number,
    approval?: LocalServingApprovalV1,
  ): Promise<LocalDeploymentV1>;
  promote(deploymentId: string, approval?: LocalServingApprovalV1): Promise<LocalDeploymentV1>;
  rollback(deploymentId: string, approval?: LocalServingApprovalV1): Promise<LocalDeploymentV1>;
  stop(deploymentId: string): Promise<LocalDeploymentV1>;
  archive(deploymentId: string): Promise<LocalDeploymentV1>;
  restart(deploymentId: string): Promise<LocalDeploymentV1>;
  scale(deploymentId: string, scaling: LocalServingScalingV1): Promise<LocalDeploymentV1>;
  invoke(
    deploymentId: string,
    input?: { readonly payload?: JsonValue; readonly method?: string; readonly path?: string },
  ): Promise<LocalServingInvocationV1>;
  smokeTest(deploymentId: string): Promise<LocalServingSmokeTestV1>;
  metrics(deploymentId: string): Promise<LocalServingMetricsV1>;
  logs(deploymentId: string): Promise<readonly LocalServingLogV1[]>;
  revisions(deploymentIdOrEndpointId: string): Promise<readonly LocalServingRevisionV1[]>;
  events(deploymentId?: string): Promise<readonly LocalServingEventV1[]>;
}

export interface LocalServingRuntimeOptions {
  readonly rootPath: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly clock?: () => string;
  readonly fetcher?: typeof fetch;
}

interface ServingState {
  readonly schemaVersion: 2;
  readonly deployments: LocalDeploymentV1[];
  readonly endpoints: LocalServingEndpointV1[];
  readonly events: LocalServingEventV1[];
}

interface ProcessSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function omitKeys<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Omit<T, K> {
  const excluded = new Set<PropertyKey>(keys);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !excluded.has(key))) as Omit<
    T,
    K
  >;
}

function safeId(value: string, label: string): string {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(value)) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} is invalid`);
  }
  return value;
}

function bounded(value: string, max = 4000): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function parseArgs(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function validateHealthUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'healthUrl is invalid');
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw runtimeError('POLICY_DENIED', 'Local serving health checks must target loopback');
  }
  return url.toString();
}

function validateInvokeUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'invokeUrl is invalid');
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw runtimeError('POLICY_DENIED', 'Local serving invocations must target loopback');
  }
  return url.toString();
}

function numberField(value: number | undefined, label: string, minimum = 0): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < minimum) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} must be at least ${minimum}`);
  }
  return value;
}

function validateResources(
  value: LocalServingResourcesV1 | undefined,
): LocalServingResourcesV1 | undefined {
  if (value === undefined) return undefined;
  const cpuMillicores = numberField(value.cpuMillicores, 'cpuMillicores', 1);
  const memoryBytes = numberField(value.memoryBytes, 'memoryBytes', 1);
  const gpuCount = numberField(value.gpuCount, 'gpuCount', 0);
  return {
    ...(cpuMillicores === undefined ? {} : { cpuMillicores }),
    ...(memoryBytes === undefined ? {} : { memoryBytes }),
    ...(value.gpuType === undefined ? {} : { gpuType: value.gpuType }),
    ...(gpuCount === undefined ? {} : { gpuCount }),
  };
}

function validateScaling(
  value: LocalServingScalingV1 | undefined,
): LocalServingScalingV1 | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value.minReplicas) || value.minReplicas < 1) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'minReplicas must be a positive integer');
  }
  if (!Number.isSafeInteger(value.maxReplicas) || value.maxReplicas < value.minReplicas) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'maxReplicas must be >= minReplicas');
  }
  if (
    value.targetConcurrency !== undefined &&
    (!Number.isSafeInteger(value.targetConcurrency) || value.targetConcurrency < 1)
  ) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'targetConcurrency must be a positive integer');
  }
  if (
    value.targetCpuPercent !== undefined &&
    (!Number.isFinite(value.targetCpuPercent) ||
      value.targetCpuPercent < 1 ||
      value.targetCpuPercent > 100)
  ) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'targetCpuPercent must be between 1 and 100');
  }
  return { ...value };
}

function validateSecretRefs(value: readonly string[] | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !value.every((item) => typeof item === 'string' && item.trim().length > 0 && item.length <= 200)
  ) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'secretRefs must contain references only');
  }
  return [...new Set(value)];
}

function validateEnvironment(
  value: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || typeof item !== 'string') {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'environment contains an invalid variable');
    }
  }
  return { ...value };
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`;
}

/** Stable digest used by local and hosted callers to bind approval to a traffic action. */
export function servingActionDigest(
  deploymentId: string,
  action: LocalServingAction,
  input: Readonly<Record<string, JsonValue>> = {},
): string {
  return `sha256:${createHash('sha256')
    .update(canonical({ deploymentId, action, input }))
    .digest('hex')}`;
}

function evidenceDigest(input: LocalServingHealthEvidenceV1): string {
  return `sha256:${createHash('sha256').update(canonical(input)).digest('hex')}`;
}

function defaultMetrics(): LocalServingMetricsV1 {
  return {
    healthChecks: 0,
    healthFailures: 0,
    requests: 0,
    successes: 0,
    errors: 0,
    totalLatencyMs: 0,
    averageLatencyMs: 0,
  };
}

function updateMetrics(
  current: LocalServingMetricsV1 | undefined,
  input: { readonly latencyMs: number; readonly success: boolean; readonly at: string },
): LocalServingMetricsV1 {
  const previous = current ?? defaultMetrics();
  const requests = previous.requests + 1;
  const totalLatencyMs = previous.totalLatencyMs + input.latencyMs;
  return {
    ...previous,
    requests,
    successes: previous.successes + (input.success ? 1 : 0),
    errors: previous.errors + (input.success ? 0 : 1),
    totalLatencyMs,
    averageLatencyMs: totalLatencyMs / requests,
    ...(input.success ? { lastRequestAt: input.at } : { lastErrorAt: input.at }),
  };
}

function stateIsTrafficEligible(state: LocalDeploymentState): boolean {
  return ['healthy', 'active'].includes(state);
}

function isRichDeployment(input: LocalServingRequestV1): boolean {
  return (
    input.modelVersionId !== undefined ||
    input.endpointId !== undefined ||
    input.endpointName !== undefined ||
    input.servingRuntime !== undefined ||
    input.region !== undefined ||
    input.resources !== undefined ||
    input.scaling !== undefined ||
    input.environment !== undefined ||
    input.secretRefs !== undefined ||
    input.networkVisibility !== undefined ||
    input.auth !== undefined ||
    input.healthCheck !== undefined ||
    input.rolloutPolicy !== undefined ||
    input.invokeUrl !== undefined ||
    input.approvalRequired === true
  );
}

function normalizeDeployment(value: LocalDeploymentV1): LocalDeploymentV1 {
  return {
    ...value,
    schemaVersion: value.schemaVersion ?? 2,
    trafficPercent: Number.isFinite(value.trafficPercent) ? value.trafficPercent : 0,
    ...(value.metrics === undefined ? {} : { metrics: { ...defaultMetrics(), ...value.metrics } }),
    ...(value.logs === undefined ? {} : { logs: [...value.logs].slice(-500) }),
    ...(value.revisionHistory === undefined ? {} : { revisionHistory: [...value.revisionHistory] }),
    ...(value.invocations === undefined ? {} : { invocations: [...value.invocations].slice(-100) }),
    ...(value.smokeTests === undefined ? {} : { smokeTests: [...value.smokeTests].slice(-100) }),
  };
}

function normalizeState(raw: Partial<ServingState> & { deployments?: unknown }): ServingState {
  const deployments = Array.isArray(raw.deployments)
    ? raw.deployments
        .filter(
          (item): item is LocalDeploymentV1 =>
            item !== null &&
            typeof item === 'object' &&
            typeof (item as LocalDeploymentV1).deploymentId === 'string',
        )
        .map((item) => normalizeDeployment(item))
    : [];
  const endpoints = Array.isArray(raw.endpoints)
    ? raw.endpoints.filter(
        (item): item is LocalServingEndpointV1 =>
          item !== null &&
          typeof item === 'object' &&
          typeof (item as LocalServingEndpointV1).endpointId === 'string',
      )
    : [];
  const events = Array.isArray(raw.events)
    ? raw.events.filter(
        (item): item is LocalServingEventV1 =>
          item !== null &&
          typeof item === 'object' &&
          typeof (item as LocalServingEventV1).eventId === 'string',
      )
    : [];
  return {
    schemaVersion: 2,
    deployments,
    endpoints,
    events: events.slice(-1000),
  };
}

/** A bounded local model-serving adapter. It never runs a shell; only the configured executable is invoked. */
export class LocalServingRuntime implements ModelServingRuntime {
  readonly available: boolean;
  private readonly statePath: string;
  private readonly rootPath: string;
  private readonly command: string | undefined;
  private readonly args: readonly string[];
  private readonly clock: () => string;
  private readonly fetcher: typeof fetch;
  private readonly processes = new Map<string, ChildProcess>();
  private readonly processSpecs = new Map<string, ProcessSpec>();
  private state: ServingState | undefined;
  private loading: Promise<void> | undefined;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(options: LocalServingRuntimeOptions) {
    this.rootPath = options.rootPath;
    this.statePath = join(options.rootPath, '.agentic', 'deployments.json');
    this.command = options.command ?? process.env['SPYDERBYTE_SERVE_COMMAND'];
    this.args = options.args ??
      parseArgs(process.env['SPYDERBYTE_SERVE_ARGS']) ?? [
        '--model',
        '%MODEL_ID%',
        '--port',
        '%PORT%',
      ];
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.fetcher = options.fetcher ?? fetch;
    this.available = this.command !== undefined && this.command.trim().length > 0;
  }

  async list(): Promise<readonly LocalDeploymentV1[]> {
    await this.ensureLoaded();
    return clone(this.state?.deployments ?? []);
  }

  async get(deploymentId: string): Promise<LocalDeploymentV1 | undefined> {
    await this.ensureLoaded();
    const deployment = this.state?.deployments.find((item) => item.deploymentId === deploymentId);
    return deployment === undefined ? undefined : clone(deployment);
  }

  async listEndpoints(): Promise<readonly LocalServingEndpointV1[]> {
    await this.ensureLoaded();
    return clone(this.state?.endpoints ?? []);
  }

  async getEndpoint(endpointId: string): Promise<LocalServingEndpointV1 | undefined> {
    await this.ensureLoaded();
    const endpoint = this.state?.endpoints.find((item) => item.endpointId === endpointId);
    return endpoint === undefined ? undefined : clone(endpoint);
  }

  async serve(input: LocalServingRequestV1): Promise<LocalDeploymentV1> {
    if (!this.available || this.command === undefined) {
      throw runtimeError(
        'COMPUTE_RESOURCE_UNAVAILABLE',
        'Configure SPYDERBYTE_SERVE_COMMAND before starting a model deployment',
      );
    }
    await this.ensureLoaded();
    const rich = isRichDeployment(input);
    const deploymentId = safeId(input.deploymentId ?? `deployment-${randomUUID()}`, 'deploymentId');
    const modelId = input.modelId.trim();
    if (modelId.length === 0) throw runtimeError('VALIDATION_INVALID_INPUT', 'modelId is required');
    if (rich && input.modelVersionId === undefined && input.modelArtifactId === undefined) {
      throw runtimeError(
        'VALIDATION_SCHEMA_MISMATCH',
        'Rich deployment requests require modelVersionId or modelArtifactId',
      );
    }
    if (input.networkVisibility === 'public') {
      throw runtimeError(
        'POLICY_DENIED',
        'The local serving adapter cannot expose a public endpoint',
      );
    }
    if (
      input.auth?.mode !== undefined &&
      !['none', 'workspace', 'api_key', 'bearer'].includes(input.auth.mode)
    ) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Serving auth mode is invalid');
    }
    if (
      input.rolloutPolicy?.canaryPercent !== undefined &&
      (!Number.isSafeInteger(input.rolloutPolicy.canaryPercent) ||
        input.rolloutPolicy.canaryPercent < 1 ||
        input.rolloutPolicy.canaryPercent > 99)
    ) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'rollout canaryPercent must be between 1 and 99',
      );
    }
    const port = input.port;
    if (port !== undefined && (!Number.isSafeInteger(port) || port < 1024 || port > 65535)) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Serving port must be between 1024 and 65535');
    }
    const healthCheck = input.healthCheck;
    const derivedHealthUrl =
      input.healthUrl ??
      healthCheck?.url ??
      (healthCheck?.path !== undefined && port !== undefined
        ? `http://127.0.0.1:${port}${healthCheck.path.startsWith('/') ? healthCheck.path : `/${healthCheck.path}`}`
        : undefined) ??
      process.env['SPYDERBYTE_SERVE_HEALTH_URL'];
    const healthUrl = validateHealthUrl(derivedHealthUrl);
    const invokeUrl = validateInvokeUrl(input.invokeUrl);
    const now = this.clock();
    const endpointId = safeId(input.endpointId ?? `endpoint-${randomUUID()}`, 'endpointId');
    const revisionId = safeId(`revision-${randomUUID()}`, 'revisionId');
    const scaling = validateScaling(input.scaling);
    const resources = validateResources(input.resources);
    const environment = validateEnvironment(input.environment);
    const secretRefs = validateSecretRefs(input.secretRefs);
    const endpoint = this.state?.endpoints.find((item) => item.endpointId === endpointId);
    const metrics = defaultMetrics();
    const deployment: LocalDeploymentV1 = {
      schemaVersion: 2,
      deploymentId,
      endpointId,
      revisionId,
      modelId,
      ...(input.modelVersionId === undefined ? {} : { modelVersionId: input.modelVersionId }),
      ...(input.modelArtifactId === undefined ? {} : { modelArtifactId: input.modelArtifactId }),
      ...(input.endpointName === undefined ? {} : { modelDisplayName: input.endpointName }),
      ...(input.servingRuntime === undefined ? {} : { servingRuntime: input.servingRuntime }),
      ...(input.region === undefined ? {} : { region: input.region }),
      ...(resources === undefined ? {} : { resources }),
      ...(scaling === undefined ? {} : { scaling }),
      ...(environment === undefined ? {} : { environment }),
      ...(secretRefs === undefined ? {} : { secretRefs }),
      ...(input.networkVisibility === undefined
        ? {}
        : { networkVisibility: input.networkVisibility }),
      ...(input.auth === undefined ? {} : { auth: { ...input.auth } }),
      ...(healthCheck === undefined
        ? {}
        : {
            healthCheck: { ...healthCheck, ...(healthUrl === undefined ? {} : { url: healthUrl }) },
          }),
      ...(input.rolloutPolicy === undefined ? {} : { rolloutPolicy: { ...input.rolloutPolicy } }),
      state: rich ? 'provisioning' : 'starting',
      trafficPercent: 0,
      ...(port === undefined ? {} : { port }),
      ...(healthUrl === undefined ? {} : { healthUrl }),
      ...(invokeUrl === undefined ? {} : { invokeUrl }),
      metrics,
      utilization: {
        observedAt: now,
        ...(resources?.cpuMillicores === undefined
          ? {}
          : { cpuMillicores: resources.cpuMillicores }),
        ...(resources?.memoryBytes === undefined ? {} : { memoryBytes: resources.memoryBytes }),
        replicas: scaling?.minReplicas ?? 1,
      },
      cost: {
        currency: 'USD',
        estimatedMinor: 0,
        actualMinor: 0,
        observedAt: now,
      },
      logs: [],
      revisionHistory: [
        {
          revisionId,
          deploymentId,
          modelId,
          ...(input.modelVersionId === undefined ? {} : { modelVersionId: input.modelVersionId }),
          ...(input.modelArtifactId === undefined
            ? {}
            : { modelArtifactId: input.modelArtifactId }),
          state: rich ? 'provisioning' : 'starting',
          trafficPercent: 0,
          createdAt: now,
        },
      ],
      invocations: [],
      smokeTests: [],
      ...(rich ? { approvalRequired: input.approvalRequired ?? true } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.state?.deployments.push(deployment);
    const nextEndpoint: LocalServingEndpointV1 =
      endpoint === undefined
        ? {
            endpointId,
            name: input.endpointName?.trim() || modelId,
            modelId,
            ...(input.modelVersionId === undefined ? {} : { modelVersionId: input.modelVersionId }),
            state: rich ? 'provisioning' : 'deploying',
            revisionIds: [revisionId],
            trafficPercent: 0,
            createdAt: now,
            updatedAt: now,
          }
        : {
            ...endpoint,
            modelId,
            ...(input.modelVersionId === undefined ? {} : { modelVersionId: input.modelVersionId }),
            state: 'updating',
            revisionIds: [...endpoint.revisionIds, revisionId],
            updatedAt: now,
          };
    this.upsertEndpoint(nextEndpoint);
    await this.persist();
    if (rich) {
      await this.recordEvent(deploymentId, endpointId, 'validating', {
        modelId,
        ...(input.modelVersionId === undefined ? {} : { modelVersionId: input.modelVersionId }),
      });
      await this.recordEvent(deploymentId, endpointId, 'provisioning', { revisionId });
    }
    const spec = this.processSpec(deployment);
    this.processSpecs.set(deploymentId, spec);
    const child = this.spawnProcess(deployment, spec);
    this.processes.set(deploymentId, child);
    const launched = {
      ...deployment,
      state: rich ? ('deploying' as const) : ('active' as const),
      updatedAt: this.clock(),
      lastAction: 'serve',
    };
    await this.replace(launched);
    await this.recordEvent(deploymentId, endpointId, 'serve', {
      revisionId,
      modelId,
    });
    if (rich) await this.recordEvent(deploymentId, endpointId, 'deploying', { revisionId });
    return clone(launched);
  }

  async update(
    deploymentId: string,
    input: Partial<LocalServingRequestV1> & { readonly modelId?: string },
  ): Promise<LocalDeploymentV1> {
    const current = await this.required(deploymentId);
    const updating = await this.replace({
      ...current,
      state: 'updating',
      trafficPercent: 0,
      updatedAt: this.clock(),
      lastAction: 'update',
    });
    await this.updateRevisionState(current, 'updating', 'rolling update started');
    try {
      const { modelId: requestedModelId, ...rest } = input;
      return await this.serve({
        ...rest,
        modelId: requestedModelId ?? current.modelId,
        ...(current.endpointId === undefined && rest.endpointId === undefined
          ? {}
          : { endpointId: current.endpointId ?? rest.endpointId }),
        ...(input.modelVersionId === undefined && current.modelVersionId === undefined
          ? {}
          : { modelVersionId: input.modelVersionId ?? current.modelVersionId }),
        ...(input.modelArtifactId === undefined && current.modelArtifactId === undefined
          ? {}
          : { modelArtifactId: input.modelArtifactId ?? current.modelArtifactId }),
        ...(input.port === undefined && current.port === undefined
          ? {}
          : { port: input.port ?? current.port }),
        ...(input.healthUrl === undefined && current.healthUrl === undefined
          ? {}
          : { healthUrl: input.healthUrl ?? current.healthUrl }),
        ...(input.invokeUrl === undefined && current.invokeUrl === undefined
          ? {}
          : { invokeUrl: input.invokeUrl ?? current.invokeUrl }),
        ...(input.servingRuntime === undefined && current.servingRuntime === undefined
          ? {}
          : { servingRuntime: input.servingRuntime ?? current.servingRuntime }),
        ...(input.region === undefined && current.region === undefined
          ? {}
          : { region: input.region ?? current.region }),
        ...(input.resources === undefined && current.resources === undefined
          ? {}
          : { resources: input.resources ?? current.resources }),
        ...(input.scaling === undefined && current.scaling === undefined
          ? {}
          : { scaling: input.scaling ?? current.scaling }),
        ...(input.environment === undefined && current.environment === undefined
          ? {}
          : { environment: input.environment ?? current.environment }),
        ...(input.secretRefs === undefined && current.secretRefs === undefined
          ? {}
          : { secretRefs: input.secretRefs ?? current.secretRefs }),
        ...(input.networkVisibility === undefined && current.networkVisibility === undefined
          ? {}
          : { networkVisibility: input.networkVisibility ?? current.networkVisibility }),
        ...(input.auth === undefined && current.auth === undefined
          ? {}
          : { auth: input.auth ?? current.auth }),
        ...(input.healthCheck === undefined && current.healthCheck === undefined
          ? {}
          : { healthCheck: input.healthCheck ?? current.healthCheck }),
        ...(input.rolloutPolicy === undefined && current.rolloutPolicy === undefined
          ? {}
          : { rolloutPolicy: input.rolloutPolicy ?? current.rolloutPolicy }),
      });
    } catch (error) {
      await this.replace({
        ...updating,
        state: 'failed',
        error: error instanceof Error ? error.message : String(error),
        updatedAt: this.clock(),
      });
      throw error;
    }
  }

  async rollingUpdate(
    deploymentId: string,
    input: Partial<LocalServingRequestV1> & { readonly modelId?: string },
  ): Promise<LocalDeploymentV1> {
    return this.update(deploymentId, input);
  }

  async observe(deploymentId: string): Promise<LocalDeploymentV1> {
    const current = await this.required(deploymentId);
    const checkedAt = this.clock();
    if (current.healthUrl === undefined) {
      if (current.approvalRequired === true) {
        return this.replace({
          ...current,
          state: 'degraded',
          healthCheckedAt: checkedAt,
          updatedAt: checkedAt,
          error: 'No loopback health check is configured',
          metrics: {
            ...(current.metrics ?? defaultMetrics()),
            healthChecks: (current.metrics?.healthChecks ?? 0) + 1,
            healthFailures: (current.metrics?.healthFailures ?? 0) + 1,
          },
        });
      }
      return this.replace({ ...current, updatedAt: checkedAt });
    }
    if (!this.available || !this.processes.has(deploymentId)) {
      return this.replace({
        ...current,
        state: current.approvalRequired === true ? 'degraded' : 'unhealthy',
        healthCheckedAt: checkedAt,
        updatedAt: checkedAt,
        error: 'Serving process is not active; restart the deployment before observing health',
        metrics: {
          ...(current.metrics ?? defaultMetrics()),
          healthChecks: (current.metrics?.healthChecks ?? 0) + 1,
          healthFailures: (current.metrics?.healthFailures ?? 0) + 1,
        },
      });
    }
    const started = Date.now();
    try {
      const response = await this.fetcher(current.healthUrl, {
        headers: { accept: 'application/json' },
      });
      const responseMs = Math.max(0, Date.now() - started);
      const observedAt = this.clock();
      const healthMetrics = {
        ...(current.metrics ?? defaultMetrics()),
        healthChecks: (current.metrics?.healthChecks ?? 0) + 1,
        healthFailures: (current.metrics?.healthFailures ?? 0) + (response.ok ? 0 : 1),
      };
      if (response.ok) {
        const evidenceBase: LocalServingHealthEvidenceV1 = {
          checkedAt: observedAt,
          url: current.healthUrl,
          statusCode: response.status,
          responseMs,
          adapter: this.command ?? 'unconfigured',
          evidenceDigest: '',
        };
        const evidence = { ...evidenceBase, evidenceDigest: evidenceDigest(evidenceBase) };
        const withoutError = omitKeys(current, ['error']);
        const healthy = await this.replace({
          ...withoutError,
          state: 'healthy',
          healthCheckedAt: observedAt,
          healthEvidence: evidence,
          updatedAt: observedAt,
          metrics: healthMetrics,
        });
        await this.updateEndpointFromDeployment(healthy);
        await this.updateRevisionState(healthy, 'healthy');
        return healthy;
      }
      const degraded = await this.replace({
        ...current,
        state: current.approvalRequired === true ? 'degraded' : 'unhealthy',
        healthCheckedAt: observedAt,
        updatedAt: observedAt,
        error: `Health check returned ${response.status}`,
        metrics: healthMetrics,
      });
      await this.updateEndpointFromDeployment(degraded);
      return degraded;
    } catch (error) {
      const observedAt = this.clock();
      const degraded = await this.replace({
        ...current,
        state: current.approvalRequired === true ? 'degraded' : 'unhealthy',
        healthCheckedAt: observedAt,
        updatedAt: observedAt,
        error: bounded(error instanceof Error ? error.message : String(error)),
        metrics: {
          ...(current.metrics ?? defaultMetrics()),
          healthChecks: (current.metrics?.healthChecks ?? 0) + 1,
          healthFailures: (current.metrics?.healthFailures ?? 0) + 1,
        },
      });
      await this.updateEndpointFromDeployment(degraded);
      return degraded;
    }
  }

  async canary(
    deploymentId: string,
    trafficPercent: number,
    approval?: LocalServingApprovalV1,
  ): Promise<LocalDeploymentV1> {
    if (!Number.isSafeInteger(trafficPercent) || trafficPercent < 1 || trafficPercent > 99) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'Canary traffic must be an integer from 1 to 99',
      );
    }
    const current = await this.required(deploymentId);
    if (!stateIsTrafficEligible(current.state)) {
      throw runtimeError(
        'POLICY_DENIED',
        'A serving deployment must be healthy before canary traffic is granted',
      );
    }
    this.requireApproval(current, 'canary', { trafficPercent }, approval);
    const next = await this.replace({
      ...current,
      trafficPercent,
      updatedAt: this.clock(),
      lastAction: 'canary',
    });
    await this.updateEndpointFromDeployment(next);
    await this.recordEvent(deploymentId, current.endpointId, 'canary', { trafficPercent });
    return next;
  }

  async promote(
    deploymentId: string,
    approval?: LocalServingApprovalV1,
  ): Promise<LocalDeploymentV1> {
    const current = await this.required(deploymentId);
    if (!stateIsTrafficEligible(current.state)) {
      throw runtimeError('POLICY_DENIED', 'Only a healthy serving deployment can be promoted');
    }
    this.requireApproval(current, 'promote', {}, approval);
    const next = await this.replace({
      ...current,
      trafficPercent: 100,
      updatedAt: this.clock(),
      lastAction: 'promote',
    });
    await this.activateEndpoint(next);
    await this.recordEvent(deploymentId, current.endpointId, 'promote');
    return next;
  }

  async rollback(
    deploymentId: string,
    approval?: LocalServingApprovalV1,
  ): Promise<LocalDeploymentV1> {
    const current = await this.required(deploymentId);
    this.requireApproval(current, 'rollback', {}, approval);
    this.killProcess(deploymentId);
    const endpoint =
      current.endpointId === undefined ? undefined : await this.getEndpoint(current.endpointId);
    const previousId = endpoint?.previousDeploymentId;
    const previous = previousId === undefined ? undefined : await this.get(previousId);
    const legacy = current.approvalRequired !== true;
    const next = await this.replace({
      ...current,
      state: legacy ? 'rolled-back' : 'stopped',
      trafficPercent: 0,
      updatedAt: this.clock(),
      lastAction: 'rollback',
    });
    if (previous !== undefined) {
      const previousNext = await this.replace({
        ...previous,
        state: previous.healthEvidence === undefined ? previous.state : 'healthy',
        trafficPercent: previous.healthEvidence === undefined ? 0 : 100,
        updatedAt: this.clock(),
        lastAction: 'rollback.restore',
      });
      await this.updateEndpointFromDeployment(previousNext);
    } else if (current.endpointId !== undefined) {
      const withoutActiveDeployment = omitKeys(endpoint as LocalServingEndpointV1, [
        'activeDeploymentId',
      ]);
      await this.updateEndpoint({
        ...withoutActiveDeployment,
        state: 'stopped',
        trafficPercent: 0,
        updatedAt: this.clock(),
      });
    }
    await this.updateRevisionState(next, legacy ? 'rolled-back' : 'stopped', 'rollback');
    await this.recordEvent(deploymentId, current.endpointId, 'rollback', {
      ...(previousId === undefined ? {} : { previousDeploymentId: previousId }),
    });
    return next;
  }

  async stop(deploymentId: string): Promise<LocalDeploymentV1> {
    const current = await this.required(deploymentId);
    this.killProcess(deploymentId);
    const next = await this.replace({
      ...current,
      state: 'stopped',
      trafficPercent: 0,
      updatedAt: this.clock(),
      lastAction: 'stop',
    });
    await this.updateEndpointFromDeployment(next);
    await this.recordEvent(deploymentId, current.endpointId, 'stop');
    return next;
  }

  async archive(deploymentId: string): Promise<LocalDeploymentV1> {
    const current = await this.required(deploymentId);
    this.killProcess(deploymentId);
    const next = await this.replace({
      ...current,
      state: 'archived',
      trafficPercent: 0,
      updatedAt: this.clock(),
      lastAction: 'archive',
    });
    if (current.endpointId !== undefined) {
      const endpoint = await this.getEndpoint(current.endpointId);
      if (endpoint !== undefined) {
        const withoutPointers = omitKeys(endpoint, ['activeDeploymentId', 'previousDeploymentId']);
        await this.updateEndpoint({
          ...withoutPointers,
          state: 'archived',
          trafficPercent: 0,
          updatedAt: this.clock(),
        });
      }
    }
    await this.updateRevisionState(next, 'archived', 'archived by operator');
    await this.recordEvent(deploymentId, current.endpointId, 'archive');
    return next;
  }

  async restart(deploymentId: string): Promise<LocalDeploymentV1> {
    if (!this.available || this.command === undefined) {
      throw runtimeError(
        'COMPUTE_RESOURCE_UNAVAILABLE',
        'Configure SPYDERBYTE_SERVE_COMMAND before restarting a deployment',
      );
    }
    const current = await this.required(deploymentId);
    this.killProcess(deploymentId);
    const withoutRestartEvidence = omitKeys(current, [
      'healthEvidence',
      'healthCheckedAt',
      'error',
    ]);
    const provisioning = await this.replace({
      ...withoutRestartEvidence,
      state: current.approvalRequired === true ? 'provisioning' : 'starting',
      trafficPercent: 0,
      updatedAt: this.clock(),
      lastAction: 'restart',
    });
    const spec = this.processSpec(provisioning);
    this.processSpecs.set(deploymentId, spec);
    this.processes.set(deploymentId, this.spawnProcess(provisioning, spec));
    const deploying = await this.replace({
      ...provisioning,
      state: provisioning.approvalRequired === true ? 'deploying' : 'active',
      updatedAt: this.clock(),
    });
    await this.recordEvent(deploymentId, current.endpointId, 'restart');
    return deploying;
  }

  async scale(deploymentId: string, scaling: LocalServingScalingV1): Promise<LocalDeploymentV1> {
    const current = await this.required(deploymentId);
    const nextScaling = validateScaling(scaling);
    if (nextScaling === undefined)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'scaling is required');
    const next = await this.replace({
      ...current,
      scaling: nextScaling,
      utilization: {
        ...(current.utilization ?? { observedAt: this.clock(), replicas: 1 }),
        observedAt: this.clock(),
        replicas: nextScaling.minReplicas,
      },
      updatedAt: this.clock(),
      lastAction: 'scale',
    });
    await this.recordEvent(
      deploymentId,
      current.endpointId,
      'scale',
      nextScaling as unknown as Record<string, JsonValue>,
    );
    return next;
  }

  async invoke(
    deploymentId: string,
    input: { readonly payload?: JsonValue; readonly method?: string; readonly path?: string } = {},
  ): Promise<LocalServingInvocationV1> {
    const current = await this.required(deploymentId);
    if (current.state !== 'healthy') {
      throw runtimeError(
        'POLICY_DENIED',
        'Only a deployment with current health evidence can receive traffic',
      );
    }
    const baseUrl =
      current.invokeUrl ??
      (current.port === undefined ? undefined : `http://127.0.0.1:${current.port}`);
    if (baseUrl === undefined)
      throw runtimeError(
        'COMPUTE_RESOURCE_UNAVAILABLE',
        'Configure an invokeUrl or serving port before invoking',
      );
    const path = input.path ?? '/predict';
    const url = validateInvokeUrl(new URL(path, baseUrl).toString());
    if (url === undefined)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Invocation URL is invalid');
    const method = (input.method ?? 'POST').toUpperCase();
    const started = Date.now();
    const invokedAt = this.clock();
    let statusCode: number | undefined;
    let responseBody: JsonValue | undefined;
    let error: string | undefined;
    try {
      const response = await this.fetcher(url, {
        method,
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        ...(input.payload === undefined || method === 'GET'
          ? {}
          : { body: JSON.stringify(input.payload) }),
      });
      statusCode = response.status;
      const text = await response.text();
      if (text.length > 0) {
        try {
          responseBody = JSON.parse(text) as JsonValue;
        } catch {
          responseBody = bounded(text) as JsonValue;
        }
      }
      if (!response.ok) error = `Invocation returned ${response.status}`;
    } catch (caught) {
      error = bounded(caught instanceof Error ? caught.message : String(caught));
    }
    const latencyMs = Math.max(0, Date.now() - started);
    const success =
      error === undefined && statusCode !== undefined && statusCode >= 200 && statusCode < 300;
    const invocation: LocalServingInvocationV1 = {
      invocationId: `invocation-${randomUUID()}`,
      ...(current.endpointId === undefined ? {} : { endpointId: current.endpointId }),
      deploymentId,
      ...(current.modelVersionId === undefined ? {} : { modelVersionId: current.modelVersionId }),
      invokedAt,
      method,
      ...(statusCode === undefined ? {} : { statusCode }),
      latencyMs,
      success,
      ...(responseBody === undefined ? {} : { response: responseBody }),
      ...(error === undefined ? {} : { error }),
    };
    const next = await this.replace({
      ...current,
      metrics: updateMetrics(current.metrics, { latencyMs, success, at: invokedAt }),
      invocations: [...(current.invocations ?? []), invocation].slice(-100),
      logs: [
        ...(current.logs ?? []),
        {
          sequence: (current.logs?.at(-1)?.sequence ?? 0) + 1,
          at: invokedAt,
          stream: (success ? 'stdout' : 'stderr') as 'stdout' | 'stderr',
          message: success
            ? `invocation ${invocation.invocationId} returned ${statusCode}`
            : (error ?? 'invocation failed'),
        },
      ].slice(-500),
      updatedAt: this.clock(),
    });
    await this.recordEvent(deploymentId, current.endpointId, 'invoke', {
      invocationId: invocation.invocationId,
      success,
      latencyMs,
    });
    void next;
    return invocation;
  }

  async smokeTest(deploymentId: string): Promise<LocalServingSmokeTestV1> {
    const current = await this.required(deploymentId);
    const startedAt = this.clock();
    let healthEvidence = current.healthEvidence;
    let invocationId: string | undefined;
    let error: string | undefined;
    let passed = false;
    try {
      if (current.healthUrl !== undefined) {
        const observed = await this.observe(deploymentId);
        healthEvidence = observed.healthEvidence;
        passed = observed.state === 'healthy';
        if (!passed) error = observed.error ?? 'Health smoke test failed';
      }
      if (passed && current.invokeUrl !== undefined) {
        const invocation = await this.invoke(deploymentId, { payload: { smokeTest: true } });
        invocationId = invocation.invocationId;
        passed = invocation.success;
        if (!passed) error = invocation.error ?? 'Invocation smoke test failed';
      }
    } catch (caught) {
      error = bounded(caught instanceof Error ? caught.message : String(caught));
    }
    const completedAt = this.clock();
    const smokeTest: LocalServingSmokeTestV1 = {
      smokeTestId: `smoke-${randomUUID()}`,
      ...(current.endpointId === undefined ? {} : { endpointId: current.endpointId }),
      deploymentId,
      ...(current.modelVersionId === undefined ? {} : { modelVersionId: current.modelVersionId }),
      startedAt,
      completedAt,
      passed,
      ...(invocationId === undefined ? {} : { invocationId }),
      ...(healthEvidence === undefined ? {} : { healthEvidence }),
      ...(error === undefined ? {} : { error }),
    };
    const latest = await this.required(deploymentId);
    await this.replace({
      ...latest,
      smokeTests: [...(latest.smokeTests ?? []), smokeTest].slice(-100),
      updatedAt: completedAt,
    });
    await this.recordEvent(deploymentId, current.endpointId, 'smoke-test', {
      passed,
      smokeTestId: smokeTest.smokeTestId,
    });
    return smokeTest;
  }

  async metrics(deploymentId: string): Promise<LocalServingMetricsV1> {
    const current = await this.required(deploymentId);
    return clone(current.metrics ?? defaultMetrics());
  }

  async logs(deploymentId: string): Promise<readonly LocalServingLogV1[]> {
    const current = await this.required(deploymentId);
    return clone(current.logs ?? []);
  }

  async revisions(deploymentIdOrEndpointId: string): Promise<readonly LocalServingRevisionV1[]> {
    const current = await this.get(deploymentIdOrEndpointId);
    const endpointId = current?.endpointId ?? deploymentIdOrEndpointId;
    const endpoint = await this.getEndpoint(endpointId);
    if (endpoint === undefined) return [];
    const deployments = await this.list();
    return clone(
      endpoint.revisionIds.flatMap((revisionId) => {
        const deployment = deployments.find((item) => item.revisionId === revisionId);
        return deployment?.revisionHistory?.filter((item) => item.revisionId === revisionId) ?? [];
      }),
    );
  }

  async events(deploymentId?: string): Promise<readonly LocalServingEventV1[]> {
    await this.ensureLoaded();
    return clone(
      (this.state?.events ?? []).filter(
        (event) => deploymentId === undefined || event.deploymentId === deploymentId,
      ),
    );
  }

  private requireApproval(
    deployment: LocalDeploymentV1,
    action: LocalServingAction,
    input: Readonly<Record<string, JsonValue>> = {},
    approval?: LocalServingApprovalV1,
  ): void {
    if (deployment.approvalRequired !== true) return;
    if (approval === undefined || approval.approved !== true) {
      throw runtimeError(
        'APPROVAL_REQUIRED',
        `Approval is required before ${action} changes traffic`,
      );
    }
    const now = Date.parse(this.clock());
    const expiresAt = Date.parse(approval.expiresAt);
    const expected = servingActionDigest(deployment.deploymentId, action, input);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      throw runtimeError('APPROVAL_INVALIDATED', 'Serving approval has expired');
    }
    if (approval.actionDigest !== expected || approval.commitDigest !== expected) {
      throw runtimeError(
        'APPROVAL_INVALIDATED',
        'Serving approval does not match the requested traffic action',
      );
    }
  }

  private processSpec(deployment: LocalDeploymentV1): ProcessSpec {
    if (this.command === undefined)
      throw runtimeError('COMPUTE_RESOURCE_UNAVAILABLE', 'Serving command is not configured');
    const args = this.args.map((item) =>
      item
        .replaceAll('%MODEL_ID%', deployment.modelId)
        .replaceAll('%MODEL_VERSION_ID%', deployment.modelVersionId ?? '')
        .replaceAll('%MODEL_ARTIFACT_ID%', deployment.modelArtifactId ?? '')
        .replaceAll('%DEPLOYMENT_ID%', deployment.deploymentId)
        .replaceAll('%ENDPOINT_ID%', deployment.endpointId ?? '')
        .replaceAll('%REVISION_ID%', deployment.revisionId ?? '')
        .replaceAll('%REGION%', deployment.region ?? '')
        .replaceAll('%PORT%', String(deployment.port ?? 0)),
    );
    return {
      command: this.command,
      args,
      env: {
        ...process.env,
        ...(deployment.environment ?? {}),
        SPYDERBYTE_DEPLOYMENT_ID: deployment.deploymentId,
        SPYDERBYTE_MODEL_ID: deployment.modelId,
        ...(deployment.endpointId === undefined
          ? {}
          : { SPYDERBYTE_ENDPOINT_ID: deployment.endpointId }),
        ...(deployment.revisionId === undefined
          ? {}
          : { SPYDERBYTE_REVISION_ID: deployment.revisionId }),
        ...(deployment.modelVersionId === undefined
          ? {}
          : { SPYDERBYTE_MODEL_VERSION_ID: deployment.modelVersionId }),
        ...(deployment.modelArtifactId === undefined
          ? {}
          : { SPYDERBYTE_MODEL_ARTIFACT_ID: deployment.modelArtifactId }),
      },
    };
  }

  private spawnProcess(deployment: LocalDeploymentV1, spec: ProcessSpec): ChildProcess {
    const child = spawn(spec.command, spec.args, {
      cwd: this.rootPath,
      env: spec.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk: Buffer | string) => {
      void this.appendLog(deployment.deploymentId, 'stdout', String(chunk));
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      void this.appendLog(deployment.deploymentId, 'stderr', String(chunk));
    });
    child.once('error', (error) => void this.markFailed(deployment.deploymentId, error.message));
    child.once('close', (code) => {
      if (code !== 0)
        void this.markFailed(
          deployment.deploymentId,
          `Serving process exited with code ${String(code)}`,
        );
    });
    return child;
  }

  private killProcess(deploymentId: string): void {
    this.processes.get(deploymentId)?.kill('SIGTERM');
    this.processes.delete(deploymentId);
  }

  private async markFailed(deploymentId: string, error: string): Promise<void> {
    this.processes.delete(deploymentId);
    const current = await this.get(deploymentId);
    if (current === undefined || ['rolled-back', 'stopped', 'archived'].includes(current.state))
      return;
    const next = await this.replace({
      ...current,
      state: 'failed',
      updatedAt: this.clock(),
      error: bounded(error),
      lastAction: 'process-failed',
    });
    await this.updateEndpointFromDeployment(next);
    await this.recordEvent(deploymentId, current.endpointId, 'process-failed', {
      error: bounded(error),
    });
  }

  private async appendLog(
    deploymentId: string,
    stream: 'stdout' | 'stderr',
    message: string,
  ): Promise<void> {
    const current = await this.get(deploymentId);
    if (current === undefined) return;
    const lines = message.split(/\r?\n/).filter((line) => line.length > 0);
    if (lines.length === 0) return;
    await this.replace({
      ...current,
      logs: [
        ...(current.logs ?? []),
        ...lines.map((line, index) => ({
          sequence: (current.logs?.at(-1)?.sequence ?? 0) + index + 1,
          at: this.clock(),
          stream,
          message: bounded(line),
        })),
      ].slice(-500),
      updatedAt: this.clock(),
    });
  }

  private async required(deploymentId: string): Promise<LocalDeploymentV1> {
    const deployment = await this.get(deploymentId);
    if (deployment === undefined)
      throw runtimeError('VALIDATION_INVALID_INPUT', `Deployment ${deploymentId} was not found`);
    return deployment;
  }

  private upsertEndpoint(endpoint: LocalServingEndpointV1): void {
    const index =
      this.state?.endpoints.findIndex((item) => item.endpointId === endpoint.endpointId) ?? -1;
    if (this.state === undefined) return;
    if (index < 0) this.state.endpoints.push(endpoint);
    else this.state.endpoints[index] = endpoint;
  }

  private async updateEndpoint(endpoint: LocalServingEndpointV1): Promise<void> {
    this.upsertEndpoint(endpoint);
    await this.persist();
  }

  private async updateEndpointFromDeployment(deployment: LocalDeploymentV1): Promise<void> {
    if (deployment.endpointId === undefined) return;
    const endpoint = await this.getEndpoint(deployment.endpointId);
    if (endpoint === undefined) return;
    const state: LocalServingEndpointState =
      deployment.state === 'healthy'
        ? 'healthy'
        : ['degraded', 'unhealthy'].includes(deployment.state)
          ? 'degraded'
          : deployment.state === 'failed'
            ? 'failed'
            : deployment.state === 'stopped' || deployment.state === 'rolled-back'
              ? 'stopped'
              : ['updating'].includes(deployment.state)
                ? 'updating'
                : ['provisioning', 'starting'].includes(deployment.state)
                  ? 'provisioning'
                  : 'deploying';
    await this.updateEndpoint({
      ...endpoint,
      state,
      ...(deployment.state === 'healthy' ? { healthEvidence: deployment.healthEvidence } : {}),
      ...(deployment.metrics === undefined ? {} : { metrics: deployment.metrics }),
      trafficPercent: deployment.trafficPercent,
      ...(deployment.state === 'healthy' && deployment.trafficPercent === 100
        ? { activeDeploymentId: deployment.deploymentId }
        : {}),
      updatedAt: this.clock(),
      ...(deployment.error === undefined ? {} : { error: deployment.error }),
    });
  }

  private async activateEndpoint(deployment: LocalDeploymentV1): Promise<void> {
    if (deployment.endpointId === undefined) return;
    const endpoint = await this.getEndpoint(deployment.endpointId);
    if (endpoint === undefined) return;
    const oldActive = endpoint.activeDeploymentId;
    if (oldActive !== undefined && oldActive !== deployment.deploymentId) {
      const previous = await this.get(oldActive);
      if (previous !== undefined) {
        await this.replace({
          ...previous,
          trafficPercent: 0,
          updatedAt: this.clock(),
          lastAction: 'superseded',
        });
        await this.updateRevisionState(previous, previous.state, 'superseded');
      }
    }
    await this.updateEndpoint({
      ...endpoint,
      state: 'healthy',
      activeDeploymentId: deployment.deploymentId,
      ...(oldActive === undefined || oldActive === deployment.deploymentId
        ? {}
        : { previousDeploymentId: oldActive }),
      trafficPercent: 100,
      ...(deployment.healthEvidence === undefined
        ? {}
        : { healthEvidence: deployment.healthEvidence }),
      ...(deployment.metrics === undefined ? {} : { metrics: deployment.metrics }),
      updatedAt: this.clock(),
    });
  }

  private async updateRevisionState(
    deployment: LocalDeploymentV1,
    state: LocalDeploymentState,
    reason?: string,
  ): Promise<void> {
    if (deployment.revisionId === undefined) return;
    const current = await this.get(deployment.deploymentId);
    if (current === undefined) return;
    const history = [...(current.revisionHistory ?? [])];
    const index = history.findIndex((item) => item.revisionId === deployment.revisionId);
    const revision: LocalServingRevisionV1 = {
      revisionId: deployment.revisionId,
      deploymentId: deployment.deploymentId,
      modelId: deployment.modelId,
      ...(deployment.modelVersionId === undefined
        ? {}
        : { modelVersionId: deployment.modelVersionId }),
      ...(deployment.modelArtifactId === undefined
        ? {}
        : { modelArtifactId: deployment.modelArtifactId }),
      state,
      trafficPercent: deployment.trafficPercent,
      createdAt: history[index]?.createdAt ?? deployment.createdAt,
      ...(state === 'healthy' ? { healthyAt: deployment.healthCheckedAt ?? this.clock() } : {}),
      ...(reason === undefined ? {} : { reason }),
    };
    if (index < 0) history.push(revision);
    else history[index] = { ...history[index], ...revision };
    await this.replace({ ...current, revisionHistory: history, updatedAt: this.clock() });
  }

  private async recordEvent(
    deploymentId: string | undefined,
    endpointId: string | undefined,
    action: string,
    details?: Readonly<Record<string, JsonValue>>,
  ): Promise<void> {
    await this.ensureLoaded();
    this.state?.events.push({
      eventId: `event-${randomUUID()}`,
      ...(deploymentId === undefined ? {} : { deploymentId }),
      ...(endpointId === undefined ? {} : { endpointId }),
      action,
      occurredAt: this.clock(),
      ...(details === undefined ? {} : { details }),
    });
    if (this.state !== undefined && this.state.events.length > 1000)
      this.state.events.splice(0, this.state.events.length - 1000);
    await this.persist();
  }

  private async replace(deployment: LocalDeploymentV1): Promise<LocalDeploymentV1> {
    await this.ensureLoaded();
    const index =
      this.state?.deployments.findIndex((item) => item.deploymentId === deployment.deploymentId) ??
      -1;
    if (index < 0) throw runtimeError('VALIDATION_INVALID_INPUT', 'Deployment was not found');
    if (this.state) this.state.deployments[index] = normalizeDeployment(deployment);
    await this.persist();
    return clone(deployment);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.state) return;
    this.loading ??= (async () => {
      try {
        const raw = JSON.parse(await readFile(this.statePath, 'utf8')) as Partial<ServingState> & {
          deployments?: unknown;
        };
        this.state = normalizeState(raw);
      } catch {
        this.state = { schemaVersion: 2, deployments: [], endpoints: [], events: [] };
      }
      const recovered = this.state.deployments.filter((deployment) =>
        ['healthy', 'active', 'deploying', 'provisioning', 'starting'].includes(deployment.state),
      );
      if (recovered.length > 0) {
        const now = this.clock();
        for (const deployment of recovered) {
          const index = this.state.deployments.findIndex(
            (item) => item.deploymentId === deployment.deploymentId,
          );
          if (index >= 0) {
            this.state.deployments[index] = {
              ...deployment,
              state: deployment.approvalRequired === true ? 'degraded' : 'unhealthy',
              updatedAt: now,
              error: 'Runtime restarted; health must be re-established by the serving adapter',
            };
          }
        }
        for (const endpoint of this.state.endpoints) {
          if (recovered.some((deployment) => deployment.endpointId === endpoint.endpointId)) {
            const deployment = this.state.deployments.find(
              (item) => item.endpointId === endpoint.endpointId,
            );
            const withoutActiveDeployment = omitKeys(endpoint, ['activeDeploymentId']);
            this.state.endpoints[this.state.endpoints.indexOf(endpoint)] = {
              ...withoutActiveDeployment,
              state: 'degraded',
              trafficPercent: 0,
              updatedAt: now,
              ...(deployment?.error === undefined ? {} : { error: deployment.error }),
            };
          }
        }
        await this.persist();
      }
    })();
    await this.loading;
  }

  private async persist(): Promise<void> {
    const write = this.persistChain.then(async () => {
      await mkdir(dirname(this.statePath), { recursive: true });
      const temporaryPath = `${this.statePath}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryPath, this.statePath);
    });
    this.persistChain = write.catch(() => undefined);
    await write;
  }
}

export function servingJsonValue(value: LocalDeploymentV1): JsonValue {
  return value as unknown as JsonValue;
}
