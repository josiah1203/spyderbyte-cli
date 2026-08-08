import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  newSortableId,
  runtimeError,
  type Id,
  type JsonValue,
  type ProviderConfiguration,
  type ProviderCredential,
  type ProviderModel,
  type ProviderUsagePolicy,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import type { ModelProviderMetadata, ModelRouter } from '@agentic-platform/harness-core';
import type { CredentialVault } from './oauth.js';
import {
  type DiscoveredProviderModel,
  type ProviderCatalog,
  type ProviderCatalogEntry,
  type ProviderTransport,
  type ProviderAdapterFactory,
  DefaultProviderAdapterFactory,
  type ProviderRateLimitMetadata,
  type ProviderTransportError,
} from './providers.js';

export interface ProviderConfigurationFile {
  readonly schemaVersion: 1;
  readonly configurations: readonly ProviderConfiguration[];
  readonly credentials: readonly ProviderCredential[];
  readonly models: readonly ProviderModel[];
}

export interface ProviderConfigurationStore {
  load(): ProviderConfigurationFile;
  save(value: ProviderConfigurationFile): void;
}

const EMPTY_FILE: ProviderConfigurationFile = {
  schemaVersion: 1,
  configurations: [],
  credentials: [],
  models: [],
};

export function defaultProviderUsagePolicy(): ProviderUsagePolicy {
  return { maxTokensPerRequest: 4096 };
}

function validUsagePolicy(value: unknown): value is ProviderUsagePolicy {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['maxTokensPerRequest'] === 'number' &&
    Number.isSafeInteger(candidate['maxTokensPerRequest']) &&
    candidate['maxTokensPerRequest'] >= 1 &&
    (candidate['maxRequestsPerMinute'] === undefined ||
      (typeof candidate['maxRequestsPerMinute'] === 'number' &&
        Number.isSafeInteger(candidate['maxRequestsPerMinute']) &&
        candidate['maxRequestsPerMinute'] >= 1)) &&
    (candidate['maxCostMinorPerRequest'] === undefined ||
      (typeof candidate['maxCostMinorPerRequest'] === 'number' &&
        Number.isSafeInteger(candidate['maxCostMinorPerRequest']) &&
        candidate['maxCostMinorPerRequest'] >= 0))
  );
}

function validConfiguration(value: unknown): value is ProviderConfiguration {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['providerConfigurationId'] === 'string' &&
    typeof candidate['tenant'] === 'object' &&
    typeof candidate['providerId'] === 'string' &&
    typeof candidate['providerType'] === 'string' &&
    typeof candidate['displayName'] === 'string' &&
    typeof candidate['endpoint'] === 'string' &&
    Array.isArray(candidate['capabilities']) &&
    Array.isArray(candidate['supportedModalities']) &&
    typeof candidate['modelDiscoveryMode'] === 'string' &&
    typeof candidate['state'] === 'string' &&
    typeof candidate['authenticationState'] === 'string' &&
    typeof candidate['local'] === 'boolean' &&
    typeof candidate['timeoutMs'] === 'number' &&
    typeof candidate['retryMaxAttempts'] === 'number' &&
    (candidate['usagePolicy'] === undefined || validUsagePolicy(candidate['usagePolicy'])) &&
    typeof candidate['createdAt'] === 'string' &&
    typeof candidate['updatedAt'] === 'string'
  );
}

function migrateConfiguration(configuration: ProviderConfiguration): ProviderConfiguration {
  return configuration.usagePolicy === undefined
    ? { ...configuration, usagePolicy: defaultProviderUsagePolicy() }
    : configuration;
}

function validCredential(value: unknown): value is ProviderCredential {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['credentialId'] === 'string' &&
    typeof candidate['providerConfigurationId'] === 'string' &&
    typeof candidate['tenant'] === 'object' &&
    typeof candidate['authMethod'] === 'string' &&
    typeof candidate['status'] === 'string' &&
    typeof candidate['createdAt'] === 'string' &&
    typeof candidate['updatedAt'] === 'string'
  );
}

function validModel(value: unknown): value is ProviderModel {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['providerModelId'] === 'string' &&
    typeof candidate['providerConfigurationId'] === 'string' &&
    typeof candidate['tenant'] === 'object' &&
    typeof candidate['providerId'] === 'string' &&
    typeof candidate['modelId'] === 'string' &&
    typeof candidate['displayName'] === 'string' &&
    Array.isArray(candidate['inputModalities']) &&
    Array.isArray(candidate['outputModalities']) &&
    Array.isArray(candidate['capabilities']) &&
    Array.isArray(candidate['dataClasses']) &&
    typeof candidate['billingMode'] === 'string' &&
    typeof candidate['local'] === 'boolean' &&
    typeof candidate['state'] === 'string' &&
    typeof candidate['createdAt'] === 'string' &&
    typeof candidate['updatedAt'] === 'string'
  );
}

function normalizeFile(value: unknown): ProviderConfigurationFile {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return EMPTY_FILE;
  const record = value as Record<string, unknown>;
  return {
    schemaVersion: 1,
    configurations: Array.isArray(record['configurations'])
      ? record['configurations'].filter(validConfiguration).map(migrateConfiguration)
      : [],
    credentials: Array.isArray(record['credentials'])
      ? record['credentials'].filter(validCredential)
      : [],
    models: Array.isArray(record['models']) ? record['models'].filter(validModel) : [],
  };
}

export class FileProviderConfigurationStore implements ProviderConfigurationStore {
  constructor(private readonly path: string) {}

  load(): ProviderConfigurationFile {
    try {
      return normalizeFile(JSON.parse(readFileSync(this.path, 'utf8')) as unknown);
    } catch {
      return EMPTY_FILE;
    }
  }

  save(value: ProviderConfigurationFile): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp-${process.pid}`;
    writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}

export class MemoryProviderConfigurationStore implements ProviderConfigurationStore {
  private value: ProviderConfigurationFile = EMPTY_FILE;

  load(): ProviderConfigurationFile {
    return structuredClone(this.value);
  }

  save(value: ProviderConfigurationFile): void {
    this.value = structuredClone(value);
  }
}

export interface ProviderTestCheck {
  readonly name:
    | 'endpoint'
    | 'authentication'
    | 'reachability'
    | 'model_discovery'
    | 'inference'
    | 'streaming'
    | 'capability_report';
  readonly status: 'passed' | 'failed' | 'skipped';
  readonly message: string;
  readonly durationMs?: number;
}

export interface ProviderTestReport {
  readonly providerConfigurationId: Id;
  readonly state: ProviderConfiguration['state'];
  readonly checkedAt: string;
  readonly checks: readonly ProviderTestCheck[];
  readonly models: readonly ProviderModel[];
  readonly capabilities: readonly string[];
  readonly latencyMs: Readonly<Record<string, number>>;
  readonly rateLimit?: ProviderRateLimitMetadata;
  readonly actionableErrors: readonly string[];
}

/**
 * A safe, provider-neutral readiness report. It deliberately contains only
 * credential state and redacted checks; the credential value is resolved by
 * the vault at transport time and is never part of this contract.
 */
export interface ProviderPreflightReport {
  readonly schemaVersion: 1;
  readonly providerConfigurationId: Id;
  readonly providerId: string;
  readonly state: ProviderConfiguration['state'];
  readonly authenticationState: ProviderConfiguration['authenticationState'];
  readonly checkedAt: string;
  readonly checks: readonly ProviderTestCheck[];
  readonly models: readonly ProviderModel[];
  readonly credentialState: 'available' | 'missing' | 'not_required';
  readonly actionableErrors: readonly string[];
}

export interface ProviderHealthReport {
  readonly providerConfigurationId: Id;
  readonly providerId: string;
  readonly state: ProviderConfiguration['state'];
  readonly authenticationState: ProviderConfiguration['authenticationState'];
  readonly checkedAt?: string;
  readonly lastSuccessfulUseAt?: string;
  readonly lastFailureAt?: string;
  readonly message?: string;
}

export interface ProviderConfigurationServiceOptions {
  readonly tenant: TenantRef;
  readonly store: ProviderConfigurationStore;
  readonly vault: CredentialVault;
  readonly catalog: ProviderCatalog;
  readonly router: ModelRouter;
  readonly deterministicTransport?: ProviderTransport;
  readonly adapterFactory?: ProviderAdapterFactory;
  /** Seed the local fixture provider so the daemon always has a durable model path. */
  readonly seedDeterministicProvider?: boolean;
  readonly clock?: () => string;
  readonly fetcher?: typeof fetch;
}

export interface AddProviderInput {
  readonly providerId?: string;
  readonly providerType: ProviderConfiguration['providerType'];
  readonly displayName: string;
  readonly endpoint?: string;
  readonly apiVersion?: string;
  readonly defaultModelId?: string;
  readonly modelIds?: readonly string[];
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly retryMaxAttempts?: number;
}

export interface UpdateProviderInput {
  readonly displayName?: string;
  readonly endpoint?: string;
  readonly apiVersion?: string;
  readonly defaultModelId?: string;
  readonly enabled?: boolean;
  readonly modelIds?: readonly string[];
  readonly timeoutMs?: number;
  readonly retryMaxAttempts?: number;
}

function nowIso(clock: () => string): string {
  return clock();
}

function slug(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (normalized.length === 0)
    throw runtimeError('VALIDATION_INVALID_INPUT', 'providerId is invalid');
  return normalized.slice(0, 80);
}

function defaultEndpoint(providerType: ProviderConfiguration['providerType']): string {
  switch (providerType) {
    case 'openai':
      return 'https://api.openai.com/v1';
    case 'anthropic':
      return 'https://api.anthropic.com/v1';
    case 'spyderbyte-cloud':
      return 'https://api.spyderbyte.com/v1';
    case 'deterministic':
      return 'local://deterministic';
    case 'ollama':
      return 'http://127.0.0.1:11434/v1';
    case 'llama.cpp':
    case 'mlx':
    case 'huggingface-local':
      return 'http://127.0.0.1:8080/v1';
    default:
      return '';
  }
}

function defaultDiscoveryMode(
  providerType: ProviderConfiguration['providerType'],
): ProviderConfiguration['modelDiscoveryMode'] {
  if (providerType === 'deterministic') return 'configured';
  if (
    providerType === 'huggingface-local' ||
    providerType === 'llama.cpp' ||
    providerType === 'mlx'
  )
    return 'local';
  return 'api';
}

function isLocal(providerType: ProviderConfiguration['providerType']): boolean {
  return ['ollama', 'llama.cpp', 'mlx', 'huggingface-local', 'deterministic'].includes(
    providerType,
  );
}

function providerSource(
  providerType: ProviderConfiguration['providerType'],
): ProviderCatalogEntry['source'] {
  if (providerType === 'openai-compatible') return 'openai-compatible';
  if (providerType === 'spyderbyte-cloud') return 'spyderbyte-cloud';
  if (providerType === 'customer-owned') return 'customer-owned';
  return 'api-key';
}

function modelState(configuration: ProviderConfiguration): ProviderModel['state'] {
  if (configuration.state === 'disabled' || configuration.state === 'misconfigured')
    return 'unavailable';
  if (configuration.state === 'degraded' || configuration.state === 'rate_limited')
    return 'degraded';
  return configuration.authenticationState === 'required' ? 'unconfigured' : 'ready';
}

export class ProviderConfigurationService {
  private readonly clock: () => string;
  private readonly fetcher: typeof fetch;
  private readonly adapterFactory: ProviderAdapterFactory;
  private file: ProviderConfigurationFile;

  constructor(private readonly options: ProviderConfigurationServiceOptions) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.fetcher = options.fetcher ?? fetch;
    this.adapterFactory = options.adapterFactory ?? new DefaultProviderAdapterFactory();
    this.file = options.store.load();
    if (options.seedDeterministicProvider === true) this.seedDeterministicProvider();
    this.rehydration = this.rehydrate();
  }

  list(): ProviderConfiguration[] {
    return this.file.configurations
      .filter((configuration) => sameTenant(configuration.tenant, this.options.tenant))
      .map((configuration) => structuredClone(configuration));
  }

  listCredentials(): ProviderCredential[] {
    return this.file.credentials
      .filter((credential) => sameTenant(credential.tenant, this.options.tenant))
      .map((credential) => structuredClone(credential));
  }

  listModels(): ProviderModel[] {
    return this.file.models
      .filter((model) => sameTenant(model.tenant, this.options.tenant))
      .map((model) => structuredClone(model));
  }

  get(providerConfigurationId: Id): ProviderConfiguration | undefined {
    const configuration = this.file.configurations.find(
      (candidate) =>
        candidate.providerConfigurationId === providerConfigurationId &&
        sameTenant(candidate.tenant, this.options.tenant),
    );
    return configuration === undefined ? undefined : structuredClone(configuration);
  }

  getByProviderId(providerId: string): ProviderConfiguration | undefined {
    const configuration = this.file.configurations.find(
      (candidate) =>
        candidate.providerId === providerId && sameTenant(candidate.tenant, this.options.tenant),
    );
    return configuration === undefined ? undefined : structuredClone(configuration);
  }

  async add(input: AddProviderInput): Promise<ProviderConfiguration> {
    const providerType = input.providerType;
    const providerId = slug(input.providerId ?? providerType);
    if (this.getByProviderId(providerId) !== undefined) {
      throw runtimeError('VALIDATION_INVALID_INPUT', `Provider ${providerId} already exists`);
    }
    const endpoint = input.endpoint?.trim() || defaultEndpoint(providerType);
    if (endpoint.length === 0)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Provider endpoint is required');
    const now = nowIso(this.clock);
    const configuration: ProviderConfiguration = {
      schemaVersion: 1,
      providerConfigurationId: newSortableId(),
      tenant: this.options.tenant,
      providerId,
      providerType,
      displayName: input.displayName.trim(),
      endpoint,
      ...(input.apiVersion === undefined ? {} : { apiVersion: input.apiVersion }),
      ...(input.defaultModelId === undefined ? {} : { defaultModelId: input.defaultModelId }),
      capabilities: ['streaming', 'structured-output'],
      supportedModalities: ['text'],
      modelDiscoveryMode: defaultDiscoveryMode(providerType),
      state:
        input.apiKey !== undefined || isLocal(providerType) || providerType === 'deterministic'
          ? 'authenticated'
          : 'configured',
      authenticationState:
        input.apiKey !== undefined || isLocal(providerType) || providerType === 'deterministic'
          ? 'authenticated'
          : 'required',
      local: isLocal(providerType),
      timeoutMs: input.timeoutMs ?? 120_000,
      retryMaxAttempts: input.retryMaxAttempts ?? 2,
      usagePolicy: defaultProviderUsagePolicy(),
      createdAt: now,
      updatedAt: now,
    };
    this.file = {
      ...this.file,
      configurations: [...this.file.configurations, configuration],
    };
    this.persist();
    if (input.apiKey !== undefined)
      await this.setCredential(configuration.providerConfigurationId, input.apiKey);
    await this.upsertConfiguredModels(
      configuration,
      input.modelIds ?? (input.defaultModelId === undefined ? [] : [input.defaultModelId]),
    );
    return this.get(configuration.providerConfigurationId) as ProviderConfiguration;
  }

  async update(
    providerConfigurationId: Id,
    input: UpdateProviderInput,
  ): Promise<ProviderConfiguration> {
    const current = this.require(providerConfigurationId);
    const next: ProviderConfiguration = {
      ...current,
      ...(input.displayName === undefined ? {} : { displayName: input.displayName.trim() }),
      ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint.trim() }),
      ...(input.apiVersion === undefined ? {} : { apiVersion: input.apiVersion }),
      ...(input.defaultModelId === undefined ? {} : { defaultModelId: input.defaultModelId }),
      state:
        input.enabled === false
          ? 'disabled'
          : input.enabled === true && current.state === 'disabled'
            ? 'configured'
            : current.state,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.retryMaxAttempts === undefined ? {} : { retryMaxAttempts: input.retryMaxAttempts }),
      updatedAt: nowIso(this.clock),
    };
    this.replaceConfiguration(next);
    if (input.modelIds !== undefined) await this.upsertConfiguredModels(next, input.modelIds);
    await this.registerConfiguration(next);
    this.persist();
    return structuredClone(next);
  }

  async setCredential(providerConfigurationId: Id, secret: string): Promise<ProviderCredential> {
    this.require(providerConfigurationId);
    if (secret.trim().length === 0)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Credential cannot be empty');
    const current = this.file.credentials.find(
      (candidate) =>
        candidate.providerConfigurationId === providerConfigurationId &&
        sameTenant(candidate.tenant, this.options.tenant),
    );
    const now = nowIso(this.clock);
    const credential: ProviderCredential = {
      schemaVersion: 1,
      credentialId: current?.credentialId ?? newSortableId(),
      tenant: this.options.tenant,
      providerConfigurationId,
      authMethod: 'api_key',
      status: 'active',
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    await this.options.vault.put(`provider:${credential.credentialId}`, secret);
    this.file = {
      ...this.file,
      credentials: [
        ...this.file.credentials.filter(
          (candidate) => candidate.credentialId !== credential.credentialId,
        ),
        credential,
      ],
      configurations: this.file.configurations.map((candidate) =>
        candidate.providerConfigurationId === providerConfigurationId
          ? {
              ...candidate,
              credentialRef: credential.credentialId,
              authenticationState: 'authenticated',
              state: 'authenticated',
              updatedAt: now,
            }
          : candidate,
      ),
    };
    this.persist();
    await this.registerConfiguration(this.require(providerConfigurationId));
    return structuredClone(credential);
  }

  async revokeCredential(providerConfigurationId: Id): Promise<void> {
    const configuration = this.require(providerConfigurationId);
    const credential = this.file.credentials.find(
      (candidate) => candidate.credentialId === configuration.credentialRef,
    );
    if (credential !== undefined)
      await this.options.vault.delete(`provider:${credential.credentialId}`);
    const now = nowIso(this.clock);
    this.file = {
      ...this.file,
      credentials: this.file.credentials.map((candidate) =>
        candidate.credentialId === credential?.credentialId
          ? { ...candidate, status: 'revoked', updatedAt: now }
          : candidate,
      ),
      configurations: this.file.configurations.map((candidate) =>
        candidate.providerConfigurationId === providerConfigurationId
          ? {
              ...candidate,
              authenticationState: candidate.local ? 'not_applicable' : 'required',
              state: candidate.local ? 'configured' : 'configured',
              updatedAt: now,
            }
          : candidate,
      ),
    };
    this.persist();
    await this.registerConfiguration(this.require(providerConfigurationId));
  }

  async remove(providerConfigurationId: Id): Promise<void> {
    const configuration = this.require(providerConfigurationId);
    await this.revokeCredential(providerConfigurationId).catch(() => undefined);
    this.file = {
      ...this.file,
      configurations: this.file.configurations.filter(
        (candidate) => candidate.providerConfigurationId !== configuration.providerConfigurationId,
      ),
      credentials: this.file.credentials.filter(
        (candidate) => candidate.providerConfigurationId !== configuration.providerConfigurationId,
      ),
      models: this.file.models.filter(
        (candidate) => candidate.providerConfigurationId !== configuration.providerConfigurationId,
      ),
    };
    this.options.catalog.removeProvider(configuration.providerId);
    this.persist();
  }

  async discoverModels(providerConfigurationId: Id): Promise<readonly ProviderModel[]> {
    const configuration = this.require(providerConfigurationId);
    const transport = await this.transportFor(configuration);
    const discovered =
      transport.discoverModels === undefined ? [] : await transport.discoverModels();
    const models: readonly DiscoveredProviderModel[] =
      discovered.length > 0
        ? discovered
        : this.file.models
            .filter((model) => model.providerConfigurationId === providerConfigurationId)
            .map((model) => ({
              modelId: model.modelId,
              displayName: model.displayName,
              ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
              capabilities: model.capabilities,
            }));
    this.upsertModels(configuration, models);
    const next: ProviderConfiguration = {
      ...configuration,
      state: models.length > 0 ? 'reachable' : configuration.state,
      lastTestedAt: nowIso(this.clock),
      updatedAt: nowIso(this.clock),
    };
    this.replaceConfiguration(next);
    this.persist();
    await this.registerConfiguration(next);
    return this.listModels().filter(
      (model) => model.providerConfigurationId === providerConfigurationId,
    );
  }

  async test(providerConfigurationId: Id, requestedModelId?: string): Promise<ProviderTestReport> {
    const configuration = this.require(providerConfigurationId);
    const checks: ProviderTestCheck[] = [];
    const latency: Record<string, number> = {};
    const actionableErrors: string[] = [];
    let rateLimit: ProviderRateLimitMetadata | undefined;
    let models: readonly ProviderModel[] = [];
    const credential =
      configuration.credentialRef === undefined
        ? undefined
        : await this.options.vault.get(`provider:${configuration.credentialRef}`);
    const hasCredential = configuration.local || configuration.providerType === 'deterministic';
    if (hasCredential || credential !== undefined) {
      checks.push({
        name: 'authentication',
        status: 'passed',
        message: configuration.local
          ? 'Local provider does not require authentication.'
          : 'Credential is available.',
      });
    } else {
      const message = 'No active credential is available; add or select a provider credential.';
      checks.push({ name: 'authentication', status: 'failed', message });
      actionableErrors.push(message);
      return this.finishTest(configuration, checks, models, {
        capabilities: configuration.capabilities,
        latency,
        actionableErrors,
      });
    }

    let adapter: ReturnType<ProviderAdapterFactory['create']>;
    try {
      const endpointStarted = Date.now();
      adapter = await this.adapterFor(configuration);
      checks.push({
        name: 'endpoint',
        status: 'passed',
        message: 'Provider adapter constructed.',
        durationMs: Date.now() - endpointStarted,
      });
    } catch (error) {
      const message = safeError(error);
      checks.push({
        name: 'endpoint',
        status: 'failed',
        message,
      });
      actionableErrors.push(message);
      return this.finishTest(configuration, checks, models, {
        capabilities: configuration.capabilities,
        latency,
        actionableErrors,
      });
    }

    checks.push({
      name: 'capability_report',
      status: adapter.capabilities.some((capability) => capability.enabled) ? 'passed' : 'failed',
      message:
        adapter.capabilities.length > 0
          ? `Adapter reports ${adapter.capabilities.filter((capability) => capability.enabled).length} capability(ies).`
          : 'Provider adapter reports no capabilities.',
    });
    const transport = adapter.transport;
    const discoveryStarted = Date.now();
    try {
      models = await this.discoverModels(providerConfigurationId);
      latency['model_discovery'] = Date.now() - discoveryStarted;
      checks.push({
        name: 'reachability',
        status: 'passed',
        message: 'Provider endpoint responded to model discovery.',
        durationMs: latency['model_discovery'],
      });
      checks.push({
        name: 'model_discovery',
        status: models.length > 0 ? 'passed' : 'failed',
        message:
          models.length > 0
            ? `Discovered ${models.length} model(s).`
            : 'No models were discovered.',
        durationMs: latency['model_discovery'],
      });
    } catch (error) {
      latency['model_discovery'] = Date.now() - discoveryStarted;
      const message = safeError(error);
      const details = providerErrorDetails(error);
      rateLimit = details.rateLimit;
      actionableErrors.push(actionableProviderError(error, 'Model discovery failed.'));
      checks.push({
        name: 'reachability',
        status: 'failed',
        message,
        durationMs: latency['model_discovery'],
      });
      checks.push({
        name: 'model_discovery',
        status: 'failed',
        message,
        durationMs: latency['model_discovery'],
      });
    }
    const modelId = requestedModelId ?? models[0]?.modelId ?? configuration.defaultModelId;
    if (modelId === undefined) {
      checks.push({ name: 'inference', status: 'skipped', message: 'No model is configured.' });
      checks.push({ name: 'streaming', status: 'skipped', message: 'No model is configured.' });
      return this.finishTest(configuration, checks, models, {
        capabilities: adapter.capabilities
          .filter((capability) => capability.enabled)
          .map((capability) => capability.capability),
        latency,
        ...(rateLimit === undefined ? {} : { rateLimit }),
        actionableErrors,
      });
    }
    const request = {
      requestId: newSortableId(),
      model: modelId,
      input: { instruction: 'Reply with the single word OK.' } as JsonValue,
      maxTokens: 8,
    };
    const inferenceStarted = Date.now();
    try {
      await transport.complete(this.metadataFor(configuration, modelId), request);
      latency['inference'] = Date.now() - inferenceStarted;
      checks.push({
        name: 'inference',
        status: 'passed',
        message: 'Minimal inference request succeeded.',
        durationMs: latency['inference'],
      });
    } catch (error) {
      latency['inference'] = Date.now() - inferenceStarted;
      const message = safeError(error);
      const details = providerErrorDetails(error);
      rateLimit ??= details.rateLimit;
      actionableErrors.push(actionableProviderError(error, 'Minimal inference request failed.'));
      checks.push({
        name: 'inference',
        status: 'failed',
        message,
        durationMs: latency['inference'],
      });
    }
    if (transport.stream === undefined) {
      checks.push({
        name: 'streaming',
        status: 'skipped',
        message: 'Provider transport does not expose streaming.',
      });
    } else {
      const streamingStarted = Date.now();
      try {
        let emitted = false;
        for await (const event of await transport.stream(
          this.metadataFor(configuration, modelId),
          request,
        )) {
          if (event.type === 'delta' || event.type === 'completed') emitted = true;
        }
        latency['streaming'] = Date.now() - streamingStarted;
        checks.push({
          name: 'streaming',
          status: emitted ? 'passed' : 'failed',
          message: emitted ? 'Streaming request succeeded.' : 'Streaming returned no output.',
          durationMs: latency['streaming'],
        });
      } catch (error) {
        latency['streaming'] = Date.now() - streamingStarted;
        const message = safeError(error);
        const details = providerErrorDetails(error);
        rateLimit ??= details.rateLimit;
        actionableErrors.push(actionableProviderError(error, 'Streaming request failed.'));
        checks.push({
          name: 'streaming',
          status: 'failed',
          message,
          durationMs: latency['streaming'],
        });
      }
    }
    return this.finishTest(configuration, checks, models, {
      capabilities: adapter.capabilities
        .filter((capability) => capability.enabled)
        .map((capability) => capability.capability),
      latency,
      ...(rateLimit === undefined ? {} : { rateLimit }),
      actionableErrors,
    });
  }

  async preflight(
    providerConfigurationId: Id,
    requestedModelId?: string,
  ): Promise<ProviderPreflightReport> {
    const configuration = this.require(providerConfigurationId);
    const report = await this.test(providerConfigurationId, requestedModelId);
    const credentialState = configuration.local
      ? 'not_required'
      : configuration.credentialRef === undefined
        ? 'missing'
        : 'available';
    return {
      schemaVersion: 1,
      providerConfigurationId,
      providerId: configuration.providerId,
      state: report.state,
      authenticationState:
        report.state === 'callable' ? 'authenticated' : configuration.authenticationState,
      checkedAt: report.checkedAt,
      checks: report.checks,
      models: report.models,
      credentialState,
      actionableErrors: report.actionableErrors,
    };
  }

  health(providerConfigurationId: Id): ProviderHealthReport {
    const configuration = this.require(providerConfigurationId);
    return {
      providerConfigurationId,
      providerId: configuration.providerId,
      state: configuration.state,
      authenticationState: configuration.authenticationState,
      ...(configuration.lastTestedAt === undefined
        ? {}
        : { checkedAt: configuration.lastTestedAt }),
      ...(configuration.lastSuccessfulUseAt === undefined
        ? {}
        : { lastSuccessfulUseAt: configuration.lastSuccessfulUseAt }),
      ...(configuration.lastFailureAt === undefined
        ? {}
        : { lastFailureAt: configuration.lastFailureAt }),
    };
  }

  usage(providerConfigurationId: Id): JsonValue {
    const configuration = this.require(providerConfigurationId);
    return {
      providerConfigurationId,
      providerId: configuration.providerId,
      state: configuration.state,
      quotaState: 'unknown',
      lastSuccessfulUseAt: configuration.lastSuccessfulUseAt ?? null,
      lastFailureAt: configuration.lastFailureAt ?? null,
    };
  }

  async refresh(): Promise<void> {
    await this.rehydration;
    for (const configuration of this.list()) {
      this.registerConfiguration(configuration);
      if (
        configuration.modelDiscoveryMode === 'api' &&
        configuration.authenticationState === 'authenticated'
      ) {
        await this.discoverModels(configuration.providerConfigurationId).catch(() => undefined);
      }
    }
  }

  private finishTest(
    configuration: ProviderConfiguration,
    checks: ProviderTestCheck[],
    models: readonly ProviderModel[],
    evidence: {
      readonly capabilities: readonly string[];
      readonly latency: Readonly<Record<string, number>>;
      readonly rateLimit?: ProviderRateLimitMetadata;
      readonly actionableErrors: readonly string[];
    },
  ): ProviderTestReport {
    const failed = checks.some((check) => check.status === 'failed');
    const authFailed = checks.some(
      (check) => check.name === 'authentication' && check.status === 'failed',
    );
    const endpointFailed = checks.some(
      (check) => check.name === 'endpoint' && check.status === 'failed',
    );
    const rateLimited = evidence.rateLimit?.statusCode === 429;
    const now = nowIso(this.clock);
    const next: ProviderConfiguration = {
      ...configuration,
      state:
        configuration.state === 'disabled'
          ? 'disabled'
          : rateLimited
            ? 'rate_limited'
            : endpointFailed
              ? 'misconfigured'
              : failed
                ? 'degraded'
                : 'callable',
      authenticationState:
        authFailed && configuration.credentialRef !== undefined
          ? 'expired'
          : configuration.authenticationState,
      lastTestedAt: now,
      ...(failed ? { lastFailureAt: now } : { lastSuccessfulUseAt: now }),
      updatedAt: now,
    };
    this.replaceConfiguration(next);
    this.persist();
    this.registerConfiguration(next);
    return {
      providerConfigurationId: configuration.providerConfigurationId,
      state: next.state,
      checkedAt: now,
      checks,
      models,
      capabilities: [...evidence.capabilities],
      latencyMs: { ...evidence.latency },
      ...(evidence.rateLimit === undefined ? {} : { rateLimit: evidence.rateLimit }),
      actionableErrors: [...new Set(evidence.actionableErrors)],
    };
  }

  private require(providerConfigurationId: Id): ProviderConfiguration {
    const configuration = this.get(providerConfigurationId);
    if (configuration === undefined)
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        `Provider configuration ${providerConfigurationId} was not found`,
      );
    return configuration;
  }

  private persist(): void {
    this.options.store.save(this.file);
  }

  private readonly rehydration: Promise<void>;

  private async rehydrate(): Promise<void> {
    await Promise.all(
      this.list().map((configuration) => this.registerConfiguration(configuration)),
    );
  }

  private seedDeterministicProvider(): void {
    if (this.getByProviderId('deterministic') !== undefined) return;
    const now = nowIso(this.clock);
    const providerConfigurationId = newSortableId();
    const configuration: ProviderConfiguration = {
      schemaVersion: 1,
      providerConfigurationId,
      tenant: this.options.tenant,
      providerId: 'deterministic',
      providerType: 'deterministic',
      displayName: 'Deterministic local provider',
      endpoint: 'local://deterministic',
      defaultModelId: 'fixture-model',
      capabilities: ['streaming', 'structured-output'],
      supportedModalities: ['text'],
      modelDiscoveryMode: 'configured',
      state: 'authenticated',
      authenticationState: 'not_applicable',
      local: true,
      timeoutMs: 120_000,
      retryMaxAttempts: 2,
      usagePolicy: defaultProviderUsagePolicy(),
      createdAt: now,
      updatedAt: now,
    };
    const model: ProviderModel = {
      schemaVersion: 1,
      providerModelId: newSortableId(),
      tenant: this.options.tenant,
      providerConfigurationId,
      providerId: 'deterministic',
      modelId: 'fixture-model',
      displayName: 'Deterministic provider',
      inputModalities: ['text'],
      outputModalities: ['text'],
      capabilities: ['streaming', 'structured-output'],
      dataClasses: ['public', 'internal', 'confidential', 'restricted'],
      billingMode: 'local',
      local: true,
      state: 'ready',
      createdAt: now,
      updatedAt: now,
    };
    this.file = {
      ...this.file,
      configurations: [...this.file.configurations, configuration],
      models: [...this.file.models, model],
    };
    this.persist();
  }

  private async transportFor(configuration: ProviderConfiguration): Promise<ProviderTransport> {
    const adapter = await this.adapterFor(configuration);
    return adapter.transport;
  }

  private async adapterFor(
    configuration: ProviderConfiguration,
  ): Promise<ReturnType<ProviderAdapterFactory['create']>> {
    const credential =
      configuration.credentialRef === undefined
        ? undefined
        : await this.options.vault.get(`provider:${configuration.credentialRef}`);
    if (
      !configuration.local &&
      configuration.providerType !== 'deterministic' &&
      credential === undefined
    ) {
      throw runtimeError('POLICY_DENIED', `${configuration.displayName} has no active credential`);
    }
    return this.adapterFactory.create(configuration, {
      ...(credential === undefined ? {} : { apiKey: credential }),
      ...(configuration.apiVersion === undefined ? {} : { apiVersion: configuration.apiVersion }),
      fetcher: this.fetcher,
      timeoutMs: configuration.timeoutMs,
      ...(this.options.deterministicTransport === undefined
        ? {}
        : { deterministicTransport: this.options.deterministicTransport }),
    });
  }

  private async registerConfiguration(configuration: ProviderConfiguration): Promise<void> {
    const models = this.listModels().filter(
      (model) => model.providerConfigurationId === configuration.providerConfigurationId,
    );
    const transport = await this.transportFor(configuration).catch(() => undefined);
    for (const model of models) {
      const entry = this.catalogEntry(configuration, model);
      this.options.catalog.upsert(entry, transport);
      const providerKey = `${entry.providerId}:${entry.modelId}`;
      try {
        const provider = this.options.catalog.get({
          providerId: entry.providerId,
          modelId: entry.modelId,
        });
        if (provider === undefined) continue;
        this.options.router.registerProvider(provider);
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? String(error.code) : undefined;
        if (code !== 'VALIDATION_INVALID_INPUT') throw error;
      }
      this.options.router.addProviderToRoutes(providerKey);
    }
  }

  private metadataFor(
    configuration: ProviderConfiguration,
    modelId: string,
  ): ModelProviderMetadata {
    const model = this.file.models.find(
      (candidate) =>
        candidate.providerConfigurationId === configuration.providerConfigurationId &&
        candidate.modelId === modelId,
    );
    return model === undefined
      ? this.catalogEntry(configuration, {
          schemaVersion: 1,
          providerModelId: newSortableId(),
          tenant: this.options.tenant,
          providerConfigurationId: configuration.providerConfigurationId,
          providerId: configuration.providerId,
          modelId,
          displayName: modelId,
          inputModalities: ['text'],
          outputModalities: ['text'],
          capabilities: configuration.capabilities,
          dataClasses: ['public', 'internal', 'confidential'],
          billingMode: configuration.local ? 'local' : 'metered',
          local: configuration.local,
          state: modelState(configuration),
          createdAt: configuration.createdAt,
          updatedAt: configuration.updatedAt,
        })
      : this.catalogEntry(configuration, model);
  }

  private catalogEntry(
    configuration: ProviderConfiguration,
    model: ProviderModel,
  ): ProviderCatalogEntry {
    return {
      providerId: configuration.providerId,
      modelId: model.modelId,
      providerKey: `${configuration.providerId}:${model.modelId}`,
      modelRef: { providerId: configuration.providerId, modelId: model.modelId },
      source: providerSource(configuration.providerType),
      displayName: model.displayName,
      capabilities: model.capabilities,
      dataClasses: ['public', 'internal', 'confidential'],
      billingMode: configuration.local ? 'local' : 'metered',
      state: model.state,
      authenticationState: configuration.authenticationState,
      local: configuration.local,
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    };
  }

  private async upsertConfiguredModels(
    configuration: ProviderConfiguration,
    modelIds: readonly string[],
  ): Promise<void> {
    this.upsertModels(
      configuration,
      modelIds.map((modelId) => ({ modelId })),
    );
    await this.registerConfiguration(configuration);
  }

  private upsertModels(
    configuration: ProviderConfiguration,
    models: readonly DiscoveredProviderModel[],
  ): void {
    const now = nowIso(this.clock);
    const current = this.file.models.filter(
      (model) => model.providerConfigurationId !== configuration.providerConfigurationId,
    );
    const nextModels: ProviderModel[] = models.map((model) => {
      const existing = this.file.models.find(
        (candidate) =>
          candidate.providerConfigurationId === configuration.providerConfigurationId &&
          candidate.modelId === model.modelId,
      );
      return {
        schemaVersion: 1,
        providerModelId: existing?.providerModelId ?? newSortableId(),
        tenant: this.options.tenant,
        providerConfigurationId: configuration.providerConfigurationId,
        providerId: configuration.providerId,
        modelId: model.modelId,
        displayName: model.displayName ?? model.modelId,
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
        inputModalities: ['text'],
        outputModalities: ['text'],
        capabilities: [...(model.capabilities ?? configuration.capabilities)],
        dataClasses: ['public', 'internal', 'confidential'],
        billingMode: configuration.local ? 'local' : 'metered',
        local: configuration.local,
        state: modelState(configuration),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
    });
    this.file = { ...this.file, models: [...current, ...nextModels] };
    this.persist();
  }

  private replaceConfiguration(configuration: ProviderConfiguration): void {
    this.file = {
      ...this.file,
      configurations: this.file.configurations.map((candidate) =>
        candidate.providerConfigurationId === configuration.providerConfigurationId
          ? configuration
          : candidate,
      ),
    };
  }
}

function sameTenant(left: TenantRef, right: TenantRef): boolean {
  return left.tenantId === right.tenantId && left.workspaceId === right.workspaceId;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function providerErrorDetails(error: unknown): {
  readonly statusCode?: number;
  readonly rateLimit?: ProviderRateLimitMetadata;
} {
  if (error === null || typeof error !== 'object') return {};
  const candidate = error as Partial<ProviderTransportError>;
  return {
    ...(typeof candidate.statusCode === 'number' ? { statusCode: candidate.statusCode } : {}),
    ...(candidate.rateLimit === undefined ? {} : { rateLimit: candidate.rateLimit }),
  };
}

function actionableProviderError(error: unknown, fallback: string): string {
  const details = providerErrorDetails(error);
  if (details.statusCode === 401 || details.statusCode === 403) {
    return 'Credential was rejected or expired; select a current credential and test again.';
  }
  if (details.statusCode === 429) {
    return 'Provider rate limit reached; wait for the retry window before trying again.';
  }
  if (details.statusCode !== undefined && details.statusCode >= 500) {
    return 'Provider is temporarily unavailable; verify endpoint health and retry.';
  }
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}
