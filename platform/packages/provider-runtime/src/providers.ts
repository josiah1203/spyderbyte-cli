import { createHash } from 'node:crypto';
import {
  isJsonValue,
  makeMoney,
  runtimeError,
  type JsonValue,
} from '@agentic-platform/runtime-contracts';
import type {
  ModelProvider,
  ModelProviderMetadata,
  ModelProviderRequest,
  ModelProviderResponse,
  ModelStreamEvent,
  ModelProviderUsageStatus,
} from '@agentic-platform/harness-core';
import type { ModelDataClass, ModelRef, ModelUsage } from '@agentic-platform/harness-core';
import type { ProviderConfiguration } from '@agentic-platform/runtime-contracts';

export interface ProviderTransport {
  complete(
    metadata: ModelProviderMetadata,
    request: ModelProviderRequest,
  ): Promise<ModelProviderResponse>;
  stream?(
    metadata: ModelProviderMetadata,
    request: ModelProviderRequest,
  ): AsyncIterable<ModelStreamEvent> | Promise<AsyncIterable<ModelStreamEvent>>;
  status?(): Promise<ModelProviderUsageStatus>;
  discoverModels?(): Promise<readonly DiscoveredProviderModel[]>;
}

/**
 * Provider-neutral capability evidence exposed by an adapter. Keeping this
 * separate from the transport makes provider-specific protocol differences
 * visible to preflight and routing without leaking HTTP details upward.
 */
export interface CapabilityAdapter {
  readonly capability: string;
  readonly enabled: boolean;
}

export interface ProviderAdapter {
  readonly transport: ProviderTransport;
  readonly capabilities: readonly CapabilityAdapter[];
}

export interface ProviderAdapterFactoryOptions {
  readonly apiKey?: string;
  readonly apiVersion?: string;
  readonly fetcher?: typeof fetch;
  readonly deterministicTransport?: ProviderTransport;
  readonly timeoutMs?: number;
}

export interface ProviderAdapterFactory {
  create(
    configuration: ProviderConfiguration,
    options: ProviderAdapterFactoryOptions,
  ): ProviderAdapter;
}

export interface DiscoveredProviderModel {
  readonly modelId: string;
  readonly displayName?: string;
  readonly contextWindow?: number;
  readonly capabilities?: readonly string[];
}

/**
 * Structural boundary for Cline's documented gateway. The concrete Cline
 * import stays in the cline adapter/application composition; this package
 * only knows how to turn the gateway's selected model into a provider.
 */
export interface GatewayModelFactory {
  createAgentModel(selection: { providerId: string; modelId: string }): GatewayModel;
}

export interface GatewayModel {
  complete?(request: ModelProviderRequest): Promise<ModelProviderResponse>;
  stream?(
    request: ModelProviderRequest,
  ): AsyncIterable<ModelStreamEvent> | Promise<AsyncIterable<ModelStreamEvent>>;
}

export function createGatewayTransport(gateway: GatewayModelFactory): ProviderTransport {
  return {
    async complete(metadata, request) {
      const model = gateway.createAgentModel({
        providerId: metadata.providerId,
        modelId: metadata.modelId,
      });
      if (model.complete === undefined) {
        throw runtimeError(
          'COMPUTE_RESOURCE_UNAVAILABLE',
          `${metadata.providerId}:${metadata.modelId} does not expose complete()`,
        );
      }
      return model.complete(request);
    },
    async *stream(metadata, request) {
      const model = gateway.createAgentModel({
        providerId: metadata.providerId,
        modelId: metadata.modelId,
      });
      if (model.stream !== undefined) {
        for await (const event of await model.stream(request)) yield event;
        return;
      }
      if (model.complete === undefined) {
        throw runtimeError(
          'COMPUTE_RESOURCE_UNAVAILABLE',
          `${metadata.providerId}:${metadata.modelId} does not expose stream() or complete()`,
        );
      }
      const response = await model.complete(request);
      yield { type: 'delta', value: response.output };
      yield { type: 'usage', usage: response.usage };
      yield { type: 'completed', output: response.output };
    },
  };
}

export interface ProviderCatalogEntry extends ModelProviderMetadata {
  readonly providerKey: string;
  readonly source:
    | 'codex-subscription'
    | 'claude-code'
    | 'huggingface-local'
    | 'deterministic'
    | 'api-key'
    | 'openai-compatible'
    | 'spyderbyte-cloud'
    | 'customer-owned';
  readonly modelRef: ModelRef;
}

function providerKey(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

function unavailableError(metadata: ModelProviderMetadata): Error {
  return runtimeError(
    'COMPUTE_RESOURCE_UNAVAILABLE',
    `${metadata.providerId}:${metadata.modelId} is not configured or its runtime is unavailable`,
  );
}

function fallbackUsage(): ModelUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cost: makeMoney(0, 'USD'),
  };
}

function objectRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

function promptText(input: JsonValue): string {
  const record = objectRecord(input);
  const instruction = record['instruction'];
  const messages = record['messages'];
  const messageText = Array.isArray(messages)
    ? messages
        .map((message) => {
          const item = objectRecord(message);
          const role = typeof item['role'] === 'string' ? item['role'] : 'user';
          const text = item['text'] ?? item['content'] ?? '';
          return `${role}: ${typeof text === 'string' ? text : JSON.stringify(text)}`;
        })
        .join('\n')
    : '';
  if (typeof instruction === 'string' && messageText.length > 0) {
    return `${messageText}\nuser: ${instruction}`;
  }
  if (typeof instruction === 'string') return instruction;
  if (messageText.length > 0) return messageText;
  return typeof input === 'string' ? input : JSON.stringify(input);
}

function redactProviderMessage(message: string, secret: string | undefined): string {
  const withKnownSecret =
    secret === undefined || secret.length === 0
      ? message
      : message.split(secret).join('[REDACTED]');
  return withKnownSecret.replace(
    /(bearer|x-api-key|api[_-]?key|token|secret)(\s*[:=]\s*)([^\s,;"']+)/gi,
    '$1$2[REDACTED]',
  );
}

export interface ProviderTransportError extends Error {
  readonly statusCode?: number;
  readonly retryAfterMs?: number;
  readonly rateLimit?: ProviderRateLimitMetadata;
}

export interface ProviderRateLimitMetadata {
  readonly statusCode?: number;
  readonly retryAfterMs?: number;
  readonly limit?: number;
  readonly remaining?: number;
  readonly resetAt?: string;
}

function rateLimitMetadata(response: Response): ProviderRateLimitMetadata | undefined {
  const retryAfter = response.headers.get('retry-after');
  const limit = response.headers.get('x-ratelimit-limit');
  const remaining = response.headers.get('x-ratelimit-remaining');
  const reset = response.headers.get('x-ratelimit-reset');
  const retryAfterMs =
    retryAfter === null
      ? undefined
      : /^\d+(?:\.\d+)?$/.test(retryAfter)
        ? Math.max(0, Number(retryAfter) * 1000)
        : Number.isFinite(Date.parse(retryAfter))
          ? Math.max(0, Date.parse(retryAfter) - Date.now())
          : undefined;
  const limitValue = limit === null ? undefined : Number(limit);
  const remainingValue = remaining === null ? undefined : Number(remaining);
  const resetValue = reset === null ? undefined : Number(reset);
  const hasMetadata =
    retryAfterMs !== undefined ||
    (limitValue !== undefined && Number.isFinite(limitValue)) ||
    (remainingValue !== undefined && Number.isFinite(remainingValue)) ||
    (resetValue !== undefined && Number.isFinite(resetValue));
  if (!hasMetadata && response.status !== 429) return undefined;
  return {
    statusCode: response.status,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(limitValue === undefined || !Number.isFinite(limitValue) ? {} : { limit: limitValue }),
    ...(remainingValue === undefined || !Number.isFinite(remainingValue)
      ? {}
      : { remaining: remainingValue }),
    ...(resetValue === undefined || !Number.isFinite(resetValue)
      ? {}
      : { resetAt: new Date(resetValue * 1000).toISOString() }),
  };
}

function providerHttpError(
  providerId: string,
  response: Response,
  payload?: JsonValue,
  secret?: string,
): ProviderTransportError {
  const body = objectRecord(payload);
  const rawMessage = body['error'];
  const message =
    typeof rawMessage === 'string'
      ? rawMessage
      : rawMessage !== undefined
        ? JSON.stringify(rawMessage)
        : response.statusText;
  const code =
    response.status === 401 || response.status === 403
      ? 'POLICY_DENIED'
      : 'EXTERNAL_DEPENDENCY_UNAVAILABLE';
  const error = runtimeError(
    code,
    `${providerId} request failed (${response.status}): ${redactProviderMessage(message, secret).slice(0, 500)}`,
  );
  const metadata = rateLimitMetadata(response);
  Object.assign(error, {
    statusCode: response.status,
    ...(metadata === undefined ? {} : { rateLimit: metadata, retryAfterMs: metadata.retryAfterMs }),
  });
  return error as ProviderTransportError;
}

function requestSignal(
  input: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(input?.reason);
  input?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error('provider request timed out')),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      input?.removeEventListener('abort', onAbort);
    },
  };
}

async function responseJson(response: Response): Promise<JsonValue | undefined> {
  const payload: unknown = await response.json().catch(() => undefined);
  return isJsonValue(payload) ? payload : undefined;
}

async function* responseSse(response: Response): AsyncIterable<JsonValue> {
  if (response.body === null) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];
  const emit = (): JsonValue | undefined => {
    if (dataLines.length === 0) return undefined;
    const data = dataLines.join('\n');
    dataLines = [];
    if (data === '[DONE]') return undefined;
    try {
      const parsed: unknown = JSON.parse(data);
      return isJsonValue(parsed) ? parsed : undefined;
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
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        } else if (line.trim() === '') {
          const parsed = emit();
          if (parsed !== undefined) yield parsed;
        }
      }
      if (chunk.done) break;
    }
    const parsed = emit();
    if (parsed !== undefined) yield parsed;
  } finally {
    reader.releaseLock();
  }
}

function responseUsage(payload: Record<string, JsonValue>): ModelUsage {
  const usage = objectRecord(payload['usage']);
  const inputTokens =
    typeof usage['prompt_tokens'] === 'number'
      ? usage['prompt_tokens']
      : typeof usage['input_tokens'] === 'number'
        ? usage['input_tokens']
        : 0;
  const outputTokens =
    typeof usage['completion_tokens'] === 'number'
      ? usage['completion_tokens']
      : typeof usage['output_tokens'] === 'number'
        ? usage['output_tokens']
        : 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens:
      typeof usage['total_tokens'] === 'number'
        ? usage['total_tokens']
        : inputTokens + outputTokens,
    cost: makeMoney(0, 'USD'),
    ...(typeof payload['id'] === 'string' ? { providerRequestId: payload['id'] } : {}),
  };
}

function contentText(value: JsonValue | undefined): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return value === undefined ? '' : JSON.stringify(value);
  return value
    .map((item) => {
      const record = objectRecord(item);
      return typeof record['text'] === 'string' ? record['text'] : '';
    })
    .join('');
}

function modelEntries(payload: JsonValue | undefined): DiscoveredProviderModel[] {
  const record = objectRecord(payload);
  const data = record['data'];
  if (!Array.isArray(data)) return [];
  return data.flatMap((item) => {
    const model = objectRecord(item);
    const modelId = model['id'];
    return typeof modelId === 'string'
      ? [
          {
            modelId,
            displayName:
              typeof model['display_name'] === 'string' ? model['display_name'] : modelId,
          },
        ]
      : [];
  });
}

export interface HttpProviderTransportOptions {
  readonly providerId: string;
  readonly endpoint: string;
  readonly apiKey?: string;
  readonly apiVersion?: string;
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * OpenAI Chat Completions-compatible transport. The same transport is used for
 * OpenAI and compatible local/hosted gateways; only the endpoint and headers
 * differ. The request body is intentionally limited to the common text path
 * until provider-specific multimodal/tool contracts are promoted.
 */
export function createOpenAiHttpTransport(
  options: HttpProviderTransportOptions,
): ProviderTransport {
  const fetcher = options.fetcher ?? fetch;
  const base = options.endpoint.replace(/\/$/, '');
  const headers = (): Record<string, string> => ({
    accept: 'application/json',
    'content-type': 'application/json',
    ...(options.apiKey === undefined ? {} : { authorization: `Bearer ${options.apiKey}` }),
  });
  const requestBody = (request: ModelProviderRequest, stream: boolean): string =>
    JSON.stringify({
      model: request.model,
      messages: [{ role: 'user', content: promptText(request.input) }],
      max_tokens: request.maxTokens,
      stream,
    });
  const call = async (
    request: ModelProviderRequest,
    stream: boolean,
  ): Promise<{ response: Response; dispose: () => void }> => {
    const signal = requestSignal(request.signal, options.timeoutMs ?? 120_000);
    try {
      const response = await fetcher(`${base}/chat/completions`, {
        method: 'POST',
        headers: headers(),
        body: requestBody(request, stream),
        signal: signal.signal,
      });
      return { response, dispose: signal.dispose };
    } catch (error) {
      signal.dispose();
      throw error;
    }
  };
  return {
    async complete(_metadata, request) {
      const callResult = await call(request, false);
      try {
        const { response } = callResult;
        const payload = await responseJson(response);
        if (!response.ok || payload === undefined)
          throw providerHttpError(options.providerId, response, payload, options.apiKey);
        const root = objectRecord(payload);
        const choices = root['choices'];
        const first = Array.isArray(choices) ? objectRecord(choices[0]) : {};
        const message = objectRecord(first['message']);
        return {
          output: (message['content'] ?? root['output'] ?? '') as JsonValue,
          usage: responseUsage(root),
        };
      } finally {
        callResult.dispose();
      }
    },
    async *stream(_metadata, request) {
      const callResult = await call(request, true);
      try {
        const { response } = callResult;
        if (!response.ok)
          throw providerHttpError(
            options.providerId,
            response,
            await responseJson(response),
            options.apiKey,
          );
        let output = '';
        let usage = fallbackUsage();
        for await (const event of responseSse(response)) {
          const root = objectRecord(event);
          const choices = root['choices'];
          const first = Array.isArray(choices) ? objectRecord(choices[0]) : {};
          const delta = objectRecord(first['delta']);
          const text = typeof delta['content'] === 'string' ? delta['content'] : '';
          if (text.length > 0) {
            output += text;
            yield { type: 'delta', value: text };
          }
          if (root['usage'] !== undefined) usage = responseUsage(root);
        }
        yield { type: 'usage', usage };
        yield { type: 'completed', output };
      } finally {
        callResult.dispose();
      }
    },
    async discoverModels() {
      const signal = requestSignal(undefined, options.timeoutMs ?? 30_000);
      try {
        const response = await fetcher(`${base}/models`, {
          method: 'GET',
          headers: headers(),
          signal: signal.signal,
        });
        const payload = await responseJson(response);
        if (!response.ok)
          throw providerHttpError(options.providerId, response, payload, options.apiKey);
        return modelEntries(payload);
      } finally {
        signal.dispose();
      }
    },
  };
}

/** Anthropic Messages API transport, including the stable version header. */
export function createAnthropicHttpTransport(
  options: HttpProviderTransportOptions,
): ProviderTransport {
  const fetcher = options.fetcher ?? fetch;
  const base = options.endpoint.replace(/\/$/, '');
  const headers = (): Record<string, string> => ({
    accept: 'application/json',
    'content-type': 'application/json',
    'anthropic-version': options.apiVersion ?? '2023-06-01',
    ...(options.apiKey === undefined ? {} : { 'x-api-key': options.apiKey }),
  });
  const requestBody = (request: ModelProviderRequest, stream: boolean): string =>
    JSON.stringify({
      model: request.model,
      max_tokens: request.maxTokens,
      messages: [{ role: 'user', content: promptText(request.input) }],
      stream,
    });
  const call = async (
    request: ModelProviderRequest,
    stream: boolean,
  ): Promise<{ response: Response; dispose: () => void }> => {
    const signal = requestSignal(request.signal, options.timeoutMs ?? 120_000);
    try {
      const response = await fetcher(`${base}/messages`, {
        method: 'POST',
        headers: headers(),
        body: requestBody(request, stream),
        signal: signal.signal,
      });
      return { response, dispose: signal.dispose };
    } catch (error) {
      signal.dispose();
      throw error;
    }
  };
  return {
    async complete(_metadata, request) {
      const callResult = await call(request, false);
      try {
        const { response } = callResult;
        const payload = await responseJson(response);
        if (!response.ok || payload === undefined)
          throw providerHttpError(options.providerId, response, payload, options.apiKey);
        const root = objectRecord(payload);
        return { output: contentText(root['content']), usage: responseUsage(root) };
      } finally {
        callResult.dispose();
      }
    },
    async *stream(_metadata, request) {
      const callResult = await call(request, true);
      try {
        const { response } = callResult;
        if (!response.ok)
          throw providerHttpError(
            options.providerId,
            response,
            await responseJson(response),
            options.apiKey,
          );
        let output = '';
        let usage = fallbackUsage();
        for await (const event of responseSse(response)) {
          const root = objectRecord(event);
          if (root['type'] === 'content_block_delta') {
            const delta = objectRecord(root['delta']);
            const text = typeof delta['text'] === 'string' ? delta['text'] : '';
            if (text.length > 0) {
              output += text;
              yield { type: 'delta', value: text };
            }
          }
          if (root['type'] === 'message_delta') usage = responseUsage(root);
          if (root['type'] === 'message_start')
            usage = responseUsage(objectRecord(root['message']));
        }
        yield { type: 'usage', usage };
        yield { type: 'completed', output };
      } finally {
        callResult.dispose();
      }
    },
    async discoverModels() {
      const signal = requestSignal(undefined, options.timeoutMs ?? 30_000);
      try {
        const response = await fetcher(`${base}/models`, {
          method: 'GET',
          headers: headers(),
          signal: signal.signal,
        });
        const payload = await responseJson(response);
        if (!response.ok)
          throw providerHttpError(options.providerId, response, payload, options.apiKey);
        return modelEntries(payload);
      } finally {
        signal.dispose();
      }
    },
  };
}

function normalizedLocalEndpoint(endpoint: string): string {
  const base = endpoint.replace(/\/$/, '');
  return base.endsWith('/v1') ? base : `${base}/v1`;
}

function capabilityAdapters(capabilities: readonly string[]): readonly CapabilityAdapter[] {
  return capabilities.map((capability) => ({ capability, enabled: true }));
}

function deterministicTransport(configuration: ProviderConfiguration): ProviderTransport {
  return {
    async complete(_metadata, request) {
      return {
        output: { ok: true, provider: 'deterministic', input: request.input } as JsonValue,
        usage: { inputTokens: 0, outputTokens: 1, totalTokens: 1, cost: makeMoney(0, 'USD') },
      };
    },
    async *stream() {
      yield { type: 'delta', value: 'OK' };
      yield {
        type: 'usage',
        usage: { inputTokens: 0, outputTokens: 1, totalTokens: 1, cost: makeMoney(0, 'USD') },
      };
      yield { type: 'completed', output: 'OK' };
    },
    async discoverModels() {
      return [
        {
          modelId: configuration.defaultModelId ?? 'fixture-model',
          displayName: 'Deterministic provider',
        },
      ];
    },
  };
}

/** Default adapter boundary for remote, compatible, local, and fixture providers. */
export class DefaultProviderAdapterFactory implements ProviderAdapterFactory {
  create(
    configuration: ProviderConfiguration,
    options: ProviderAdapterFactoryOptions,
  ): ProviderAdapter {
    if (configuration.providerType !== 'deterministic') {
      let endpoint: URL;
      try {
        endpoint = new URL(configuration.endpoint);
      } catch {
        throw runtimeError(
          'VALIDATION_INVALID_INPUT',
          `${configuration.providerId} has an invalid provider endpoint`,
        );
      }
      if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
        throw runtimeError(
          'VALIDATION_INVALID_INPUT',
          `${configuration.providerId} endpoint must use http or https`,
        );
      }
    }
    let transport: ProviderTransport;
    if (configuration.providerType === 'deterministic') {
      transport = options.deterministicTransport ?? deterministicTransport(configuration);
    } else if (configuration.providerType === 'anthropic') {
      transport = createAnthropicHttpTransport({
        providerId: configuration.providerId,
        endpoint: configuration.endpoint,
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        ...(options.apiVersion === undefined ? {} : { apiVersion: options.apiVersion }),
        ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
    } else {
      const endpoint =
        configuration.local || configuration.providerType === 'ollama'
          ? normalizedLocalEndpoint(configuration.endpoint)
          : configuration.endpoint;
      transport = createOpenAiHttpTransport({
        providerId: configuration.providerId,
        endpoint,
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        ...(options.apiVersion === undefined ? {} : { apiVersion: options.apiVersion }),
        ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
    }
    return {
      transport,
      capabilities: capabilityAdapters(configuration.capabilities),
    };
  }
}

export class CatalogModelProvider implements ModelProvider {
  readonly providerId: string;
  readonly model: string;
  metadata: ModelProviderMetadata;

  constructor(
    readonly entry: ProviderCatalogEntry,
    private transport?: ProviderTransport,
  ) {
    this.providerId = entry.providerId;
    this.model = entry.modelId;
    this.metadata = entry;
  }

  async complete(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    if (this.transport === undefined) throw unavailableError(this.metadata);
    return this.transport.complete(this.metadata, request);
  }

  async *stream(request: ModelProviderRequest): AsyncIterable<ModelStreamEvent> {
    if (this.transport?.stream !== undefined) {
      for await (const event of await this.transport.stream(this.metadata, request)) yield event;
      return;
    }
    const response = await this.complete(request);
    yield { type: 'delta', value: response.output };
    yield { type: 'usage', usage: response.usage };
    yield { type: 'completed', output: response.output };
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }

  setConnection(connectionId: string | undefined): void {
    if (connectionId === undefined) {
      const metadata = { ...this.metadata };
      delete metadata.connectionId;
      metadata.state = 'unconfigured';
      metadata.authenticationState = 'required';
      this.metadata = metadata;
      return;
    }
    this.metadata = {
      ...this.metadata,
      connectionId,
      state: this.transport === undefined ? 'degraded' : 'ready',
      authenticationState: 'authenticated',
    };
  }

  setTransport(transport: ProviderTransport | undefined): void {
    this.transport = transport;
    const nextState: ModelProviderMetadata['state'] =
      transport === undefined ? (this.metadata.local ? 'unconfigured' : 'degraded') : 'ready';
    const next = {
      ...this.metadata,
      state: nextState,
    };
    if (transport === undefined && !this.metadata.local) {
      this.metadata = { ...next, authenticationState: 'required' };
    } else if (next.authenticationState === undefined) {
      const withoutAuthenticationState = { ...next };
      delete withoutAuthenticationState.authenticationState;
      this.metadata = withoutAuthenticationState;
    } else {
      this.metadata = next;
    }
  }

  setMetadata(metadata: ModelProviderMetadata): void {
    this.metadata = metadata;
  }

  async refreshStatus(): Promise<void> {
    if (this.transport?.status === undefined) return;
    try {
      const usageStatus = await this.transport.status();
      this.metadata = {
        ...this.metadata,
        state:
          this.metadata.local || this.metadata.authenticationState === 'authenticated'
            ? 'ready'
            : this.metadata.state,
        usageStatus,
      };
    } catch {
      this.metadata = {
        ...this.metadata,
        state: 'degraded',
        usageStatus: { quotaState: 'unknown' },
      };
    }
  }
}

export interface ProviderCatalogOptions {
  readonly codexModelIds?: readonly string[];
  readonly claudeModelIds?: readonly string[];
  readonly codexTransport?: ProviderTransport;
  readonly claudeTransport?: ProviderTransport;
  readonly localProviders?: readonly {
    readonly modelId: string;
    readonly displayName?: string;
    readonly capabilities?: readonly string[];
    readonly contextWindow?: number;
    readonly transport?: ProviderTransport;
    readonly state?: ModelProviderMetadata['state'];
  }[];
}

export class ProviderCatalog {
  private readonly entries = new Map<string, ProviderCatalogEntry>();
  private readonly providers = new Map<string, CatalogModelProvider>();

  register(entry: ProviderCatalogEntry, transport?: ProviderTransport): CatalogModelProvider {
    if (this.entries.has(entry.providerKey)) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        `Provider already registered: ${entry.providerKey}`,
      );
    }
    const provider = new CatalogModelProvider(entry, transport);
    this.entries.set(entry.providerKey, entry);
    this.providers.set(entry.providerKey, provider);
    return provider;
  }

  upsert(entry: ProviderCatalogEntry, transport?: ProviderTransport): CatalogModelProvider {
    const existing = this.providers.get(entry.providerKey);
    if (existing === undefined) return this.register(entry, transport);
    this.entries.set(entry.providerKey, entry);
    existing.setMetadata(entry);
    existing.setTransport(transport);
    return existing;
  }

  list(): ProviderCatalogEntry[] {
    return structuredClone(
      [...this.providers.values()].map((provider) => ({
        ...provider.entry,
        ...provider.metadata,
      })),
    );
  }

  get(ref: ModelRef): CatalogModelProvider | undefined {
    return this.providers.get(providerKey(ref.providerId, ref.modelId));
  }

  connect(providerId: string, connectionId: string): void {
    for (const provider of this.providers.values()) {
      if (provider.providerId === providerId) provider.setConnection(connectionId);
    }
  }

  disconnect(providerId: string, connectionId?: string): void {
    for (const provider of this.providers.values()) {
      if (
        provider.providerId === providerId &&
        (connectionId === undefined || provider.metadata.connectionId === connectionId)
      ) {
        provider.setConnection(undefined);
      }
    }
  }

  registerLocalModel(input: {
    modelId: string;
    displayName?: string;
    format: 'gguf' | 'mlx' | 'unknown';
    contextWindow?: number;
    runtimeId?: string;
    ready?: boolean;
    transport?: ProviderTransport;
  }): CatalogModelProvider {
    const modelKey = providerKey('huggingface-local', input.modelId);
    const existing = this.providers.get(modelKey);
    if (existing !== undefined) return existing;
    const model = entry('huggingface-local', 'huggingface-local', input.modelId, {
      displayName: input.displayName ?? input.modelId,
      capabilities: ['streaming', 'structured-output', 'tool-calling'],
      dataClasses: ['public', 'internal', 'confidential', 'restricted'],
      billingMode: 'local',
      state: input.ready === true && input.transport !== undefined ? 'ready' : 'unconfigured',
      authenticationState: 'not_applicable',
      local: true,
      runtimeRequirements: [input.runtimeId ?? input.format],
      ...(input.contextWindow === undefined ? {} : { contextWindow: input.contextWindow }),
    });
    return this.register(model, input.transport);
  }

  removeLocalModel(modelId: string): boolean {
    const modelKey = providerKey('huggingface-local', modelId);
    const removed = this.providers.delete(modelKey);
    this.entries.delete(modelKey);
    return removed;
  }

  removeProvider(providerId: string): void {
    for (const [key, provider] of this.providers.entries()) {
      if (provider.providerId !== providerId) continue;
      this.providers.delete(key);
      this.entries.delete(key);
    }
  }

  readyProviders(): CatalogModelProvider[] {
    return [...this.providers.values()].filter((provider) => provider.metadata.state === 'ready');
  }

  async refreshStatus(): Promise<void> {
    await Promise.all([...this.providers.values()].map((provider) => provider.refreshStatus()));
  }

  registerWith(router: { registerProvider(provider: ModelProvider): void }): void {
    // Register the complete catalog once. The router reads live metadata so a
    // provider can move from unconfigured to ready after OAuth or runtime
    // health changes without rebuilding every harness route.
    for (const provider of this.providers.values()) router.registerProvider(provider);
  }
}

function entry(
  source: ProviderCatalogEntry['source'],
  providerId: string,
  modelId: string,
  options: Omit<
    ProviderCatalogEntry,
    'source' | 'providerId' | 'modelId' | 'providerKey' | 'modelRef'
  >,
): ProviderCatalogEntry {
  return {
    source,
    providerId,
    modelId,
    providerKey: providerKey(providerId, modelId),
    modelRef: { providerId, modelId },
    ...options,
  };
}

function subscriptionEntry(
  source: 'codex-subscription' | 'claude-code',
  providerId: string,
  modelId: string,
  displayName: string,
  transport: ProviderTransport | undefined,
  connectionId: string | undefined,
): { entry: ProviderCatalogEntry; transport?: ProviderTransport } {
  const metadata = {
    displayName,
    capabilities: ['streaming', 'tool-calling', 'structured-output'],
    dataClasses: ['public', 'internal', 'confidential'] as ModelDataClass[],
    billingMode: 'subscription' as const,
    state:
      transport === undefined || connectionId === undefined
        ? ('unconfigured' as const)
        : ('ready' as const),
    authenticationState:
      connectionId === undefined ? ('required' as const) : ('authenticated' as const),
    local: false,
    ...(connectionId === undefined ? {} : { connectionId }),
  };
  return {
    entry: entry(source, providerId, modelId, metadata),
    ...(transport === undefined ? {} : { transport }),
  };
}

export interface DefaultProviderCatalogOptions extends ProviderCatalogOptions {
  readonly codexConnectionId?: string;
  readonly claudeConnectionId?: string;
  readonly deterministicTransport?: ProviderTransport;
}

export function createDefaultProviderCatalog(
  options: DefaultProviderCatalogOptions = {},
): ProviderCatalog {
  const catalog = new ProviderCatalog();
  const codexModels = options.codexModelIds ?? ['gpt-5.3-codex'];
  for (const modelId of codexModels) {
    const model = subscriptionEntry(
      'codex-subscription',
      'openai-codex',
      modelId,
      'ChatGPT Subscription / Codex',
      options.codexTransport,
      options.codexConnectionId,
    );
    catalog.register(model.entry, model.transport);
  }
  const claudeModels = options.claudeModelIds ?? ['claude-sonnet-4-6'];
  for (const modelId of claudeModels) {
    const model = subscriptionEntry(
      'claude-code',
      'claude-code',
      modelId,
      'Claude Code subscription',
      options.claudeTransport,
      options.claudeConnectionId,
    );
    catalog.register(model.entry, model.transport);
  }
  for (const local of options.localProviders ?? []) {
    const localEntry = entry('huggingface-local', 'huggingface-local', local.modelId, {
      displayName: local.displayName ?? local.modelId,
      capabilities: local.capabilities ?? ['streaming', 'structured-output'],
      dataClasses: ['public', 'internal', 'confidential', 'restricted'],
      billingMode: 'local',
      state: local.state ?? (local.transport === undefined ? 'unconfigured' : 'ready'),
      authenticationState: 'not_applicable',
      local: true,
      ...(local.contextWindow === undefined ? {} : { contextWindow: local.contextWindow }),
    });
    catalog.register(localEntry, local.transport);
  }
  const deterministicEntry = entry('deterministic', 'deterministic', 'fixture-model', {
    displayName: 'Deterministic provider',
    capabilities: ['structured-output'],
    dataClasses: ['public', 'internal', 'confidential', 'restricted'],
    billingMode: 'local',
    state: 'ready',
    authenticationState: 'not_applicable',
    local: true,
  });
  catalog.register(
    deterministicEntry,
    options.deterministicTransport ?? {
      async complete(_metadata, request) {
        const digest = createHash('sha256')
          .update(JSON.stringify(request.input))
          .digest('hex')
          .slice(0, 16);
        return {
          output: { provider: 'deterministic', model: request.model, inputDigest: digest },
          usage: fallbackUsage(),
        };
      },
    },
  );
  return catalog;
}

export interface LocalRuntimeDescriptor {
  readonly runtimeId: 'llama.cpp' | 'mlx';
  readonly format: 'gguf' | 'mlx';
  readonly version: string;
  readonly state: ModelProviderMetadata['state'];
  readonly binaryPath?: string;
  readonly endpoint?: string;
}

export interface LocalRuntimeRegistryOptions {
  readonly llamaCppEndpoint?: string;
  readonly mlxEndpoint?: string;
  readonly llamaCppBinaryPath?: string;
  readonly mlxBinaryPath?: string;
}

export class LocalRuntimeRegistry {
  private readonly runtimes: LocalRuntimeDescriptor[];

  constructor(options: LocalRuntimeRegistryOptions = {}) {
    this.runtimes = [
      {
        runtimeId: 'llama.cpp',
        format: 'gguf',
        version: 'managed-1',
        state: options.llamaCppEndpoint || options.llamaCppBinaryPath ? 'ready' : 'unconfigured',
        ...(options.llamaCppBinaryPath === undefined
          ? {}
          : { binaryPath: options.llamaCppBinaryPath }),
        ...(options.llamaCppEndpoint === undefined ? {} : { endpoint: options.llamaCppEndpoint }),
      },
      {
        runtimeId: 'mlx',
        format: 'mlx',
        version: 'managed-1',
        state: options.mlxEndpoint || options.mlxBinaryPath ? 'ready' : 'unconfigured',
        ...(options.mlxBinaryPath === undefined ? {} : { binaryPath: options.mlxBinaryPath }),
        ...(options.mlxEndpoint === undefined ? {} : { endpoint: options.mlxEndpoint }),
      },
    ];
  }

  list(): LocalRuntimeDescriptor[] {
    return structuredClone(this.runtimes);
  }

  get(format: LocalRuntimeDescriptor['format']): LocalRuntimeDescriptor | undefined {
    return this.runtimes.find((runtime) => runtime.format === format);
  }
}

export function createOpenAiCompatibleLocalTransport(
  endpoint: string,
  fetcher: typeof fetch = fetch,
): ProviderTransport {
  return createOpenAiHttpTransport({
    providerId: 'local-runtime',
    endpoint: normalizedLocalEndpoint(endpoint),
    fetcher,
  });
}

export function defaultProviderPriority(): string[] {
  return ['openai-codex', 'claude-code', 'huggingface-local', 'deterministic'];
}

export function providerKeyFor(ref: ModelRef): string {
  return providerKey(ref.providerId, ref.modelId);
}

export type ProviderJson = JsonValue;
