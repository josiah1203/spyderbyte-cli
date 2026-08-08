import {
  makeMoney,
  newSortableId,
  runtimeError,
  type CloudComputeRequestV1,
  type Id,
  type Money,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import type { SecretHandle } from '@agentic-platform/backends';
import { estimateInputTokens } from './billing.js';

export interface CloudSecretResolver {
  resolve(handle: SecretHandle, tenant: TenantRef, operation: string): Promise<string>;
}

export interface CloudInferenceInput {
  readonly tenant: TenantRef;
  readonly modelId: string;
  readonly prompt: string;
  readonly maxOutputTokens: number;
}

export type CloudInferenceEvent =
  | { readonly type: 'delta'; readonly text: string }
  | {
      readonly type: 'usage';
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly providerRequestId?: string;
    }
  | { readonly type: 'completed'; readonly providerRequestId?: string };

export interface CloudInferenceProvider {
  stream(
    input: CloudInferenceInput,
  ): AsyncIterable<CloudInferenceEvent> | Promise<AsyncIterable<CloudInferenceEvent>>;
}

export interface OpenRouterInferenceOptions {
  readonly endpoint?: string;
  readonly apiKeyHandle: SecretHandle;
  readonly secretResolver: CloudSecretResolver;
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function assertInferenceInput(input: CloudInferenceInput): void {
  if (input.modelId.trim().length === 0 || input.prompt.length === 0) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Cloud inference model and prompt are required');
  }
  if (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1) {
    throw runtimeError(
      'VALIDATION_INVALID_INPUT',
      'Cloud inference output token limit must be positive',
    );
  }
}

function parseInferencePayload(payload: unknown): CloudInferenceEvent | undefined {
  const root = objectRecord(payload);
  const id = stringValue(root['id']);
  const choices = root['choices'];
  const first = Array.isArray(choices) ? objectRecord(choices[0]) : {};
  const delta = objectRecord(first['delta']);
  const text = stringValue(delta['content']);
  if (text !== undefined && text.length > 0) return { type: 'delta', text };
  const usage = objectRecord(root['usage']);
  const inputTokens = numberValue(usage['prompt_tokens']);
  const outputTokens = numberValue(usage['completion_tokens']);
  if (inputTokens !== undefined || outputTokens !== undefined) {
    return {
      type: 'usage',
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
      ...(id === undefined ? {} : { providerRequestId: id }),
    };
  }
  return undefined;
}

async function* responseEvents(response: Response): AsyncIterable<CloudInferenceEvent> {
  if (response.body === null) {
    const parsed = parseInferencePayload(await response.json().catch(() => ({})));
    if (parsed !== undefined) yield parsed;
    yield { type: 'completed' };
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let providerRequestId: string | undefined;
  let completed = false;
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice('data:'.length).trim();
        if (data === '[DONE]') {
          completed = true;
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'OpenRouter returned invalid SSE JSON');
        }
        const event = parseInferencePayload(parsed);
        if (event !== undefined) {
          if (event.type === 'usage' && event.providerRequestId !== undefined) {
            providerRequestId = event.providerRequestId;
          }
          yield event;
        }
      }
      if (chunk.done) break;
    }
    if (buffer.startsWith('data:')) {
      const data = buffer.slice('data:'.length).trim();
      if (data !== '[DONE]' && data.length > 0) {
        const event = parseInferencePayload(JSON.parse(data));
        if (event !== undefined) yield event;
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (!completed)
    yield { type: 'completed', ...(providerRequestId === undefined ? {} : { providerRequestId }) };
  else
    yield { type: 'completed', ...(providerRequestId === undefined ? {} : { providerRequestId }) };
}

/** OpenRouter's OpenAI-compatible streaming boundary with KMS-resolved credentials. */
export class OpenRouterInferenceAdapter implements CloudInferenceProvider {
  private readonly endpoint: string;
  private readonly apiKeyHandle: SecretHandle;
  private readonly secretResolver: CloudSecretResolver;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OpenRouterInferenceOptions) {
    this.endpoint = (options.endpoint ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
    this.apiKeyHandle = options.apiKeyHandle;
    this.secretResolver = options.secretResolver;
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'OpenRouter timeout must be positive');
    }
  }

  async *stream(input: CloudInferenceInput): AsyncIterable<CloudInferenceEvent> {
    assertInferenceInput(input);
    const apiKey = await this.secretResolver.resolve(
      this.apiKeyHandle,
      input.tenant,
      'cloud.model.invoke',
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(`${this.endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
          accept: 'text/event-stream, application/json',
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
          'http-referer': 'https://spyderbyte.local',
          'x-title': 'Spyderbyte Cloud',
        },
        body: JSON.stringify({
          model: input.modelId,
          messages: [{ role: 'user', content: input.prompt }],
          max_tokens: input.maxOutputTokens,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw runtimeError(
          'EXTERNAL_DEPENDENCY_UNAVAILABLE',
          `OpenRouter returned HTTP ${response.status}`,
        );
      }
      for await (const event of responseEvents(response)) yield event;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw runtimeError('EXTERNAL_DEPENDENCY_UNAVAILABLE', 'OpenRouter request timed out');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export interface CloudComputeSubmission {
  readonly runId: Id;
  readonly tenant: TenantRef;
  readonly compute: CloudComputeRequestV1;
  readonly payload: string;
}

export type CloudComputeState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface CloudComputeHandle {
  readonly executionId: Id;
  readonly externalExecutionId: string;
  readonly tenant: TenantRef;
  readonly state: CloudComputeState;
  readonly submittedAt: string;
}

export interface CloudComputeObservation {
  readonly handle: CloudComputeHandle;
  readonly state: CloudComputeState;
  readonly observedAt: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly computeSeconds: number;
  readonly outputBytes: number;
  readonly providerRequestId?: string;
}

export interface CloudComputeProvider {
  estimate(input: {
    readonly tenant: TenantRef;
    readonly compute: CloudComputeRequestV1;
  }): Promise<{ readonly estimatedCost: Money }>;
  submit(input: CloudComputeSubmission): Promise<CloudComputeHandle>;
  observe(handle: CloudComputeHandle): Promise<CloudComputeObservation>;
  terminate(handle: CloudComputeHandle): Promise<void>;
}

export interface ModalComputeGateway {
  estimate(input: {
    readonly authorizationToken: string;
    readonly tenant: TenantRef;
    readonly compute: CloudComputeRequestV1;
  }): Promise<{ readonly externalOfferId: string; readonly estimatedCost: Money }>;
  submit(input: {
    readonly authorizationToken: string;
    readonly request: CloudComputeSubmission;
  }): Promise<{ readonly externalExecutionId: string; readonly state: CloudComputeState }>;
  observe(input: {
    readonly authorizationToken: string;
    readonly handle: CloudComputeHandle;
  }): Promise<CloudComputeObservation>;
  terminate(input: {
    readonly authorizationToken: string;
    readonly handle: CloudComputeHandle;
  }): Promise<void>;
}

export interface ModalComputeAdapterOptions {
  readonly gateway: ModalComputeGateway;
  readonly authHandle: SecretHandle;
  readonly secretResolver: CloudSecretResolver;
  readonly clock?: () => string;
}

function sameTenant(left: TenantRef, right: TenantRef): boolean {
  return left.tenantId === right.tenantId && left.workspaceId === right.workspaceId;
}

function assertComputeRequest(compute: CloudComputeRequestV1): void {
  const positive = [
    ['cpuMillicores', compute.cpuMillicores],
    ['memoryBytes', compute.memoryBytes],
    ['wallTimeMs', compute.wallTimeMs],
    ['maxOutputBytes', compute.maxOutputBytes],
    ['maxProcessCount', compute.maxProcessCount],
  ] as const;
  for (const [label, value] of positive) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw runtimeError('VALIDATION_INVALID_INPUT', `Modal ${label} must be positive`);
    }
  }
  if (!Number.isSafeInteger(compute.gpuCount) || compute.gpuCount < 0) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Modal gpuCount must be non-negative');
  }
}

/** Modal remains an injected gateway so credentials and API-version details stay out of domain code. */
export class ModalComputeAdapter implements CloudComputeProvider {
  private readonly gateway: ModalComputeGateway;
  private readonly authHandle: SecretHandle;
  private readonly secretResolver: CloudSecretResolver;
  private readonly clock: () => string;

  constructor(options: ModalComputeAdapterOptions) {
    this.gateway = options.gateway;
    this.authHandle = options.authHandle;
    this.secretResolver = options.secretResolver;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async estimate(input: {
    readonly tenant: TenantRef;
    readonly compute: CloudComputeRequestV1;
  }): Promise<{ readonly estimatedCost: Money }> {
    assertComputeRequest(input.compute);
    const token = await this.secretResolver.resolve(
      this.authHandle,
      input.tenant,
      'cloud.compute.submit',
    );
    const result = await this.gateway.estimate({ authorizationToken: token, ...input });
    if (result.externalOfferId.trim().length === 0) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Modal returned no offer ID');
    }
    return { estimatedCost: { ...result.estimatedCost } };
  }

  async submit(input: CloudComputeSubmission): Promise<CloudComputeHandle> {
    assertComputeRequest(input.compute);
    const token = await this.secretResolver.resolve(
      this.authHandle,
      input.tenant,
      'cloud.compute.submit',
    );
    const result = await this.gateway.submit({ authorizationToken: token, request: input });
    if (result.externalExecutionId.trim().length === 0) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Modal returned no execution ID');
    }
    if (!['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(result.state)) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Modal returned an invalid execution state');
    }
    return {
      executionId: newSortableId(),
      externalExecutionId: result.externalExecutionId,
      tenant: { ...input.tenant },
      state: result.state,
      submittedAt: this.clock(),
    };
  }

  async observe(handle: CloudComputeHandle): Promise<CloudComputeObservation> {
    const token = await this.secretResolver.resolve(
      this.authHandle,
      handle.tenant,
      'cloud.compute.observe',
    );
    const result = await this.gateway.observe({ authorizationToken: token, handle: { ...handle } });
    if (
      !sameTenant(result.handle.tenant, handle.tenant) ||
      result.handle.externalExecutionId !== handle.externalExecutionId
    ) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Modal observation crossed execution scope');
    }
    return { ...result, handle: { ...handle, state: result.state } };
  }

  async terminate(handle: CloudComputeHandle): Promise<void> {
    const token = await this.secretResolver.resolve(
      this.authHandle,
      handle.tenant,
      'cloud.compute.terminate',
    );
    await this.gateway.terminate({ authorizationToken: token, handle: { ...handle } });
  }
}

export class DeterministicCloudInferenceProvider implements CloudInferenceProvider {
  async *stream(input: CloudInferenceInput): AsyncIterable<CloudInferenceEvent> {
    assertInferenceInput(input);
    const output = `cloud:${input.modelId}:${input.prompt}`;
    yield { type: 'delta', text: output };
    yield {
      type: 'usage',
      inputTokens: estimateInputTokens(input.prompt),
      outputTokens: Math.max(1, Math.ceil(output.length / 4)),
      providerRequestId: 'deterministic-openrouter-request',
    };
    yield { type: 'completed', providerRequestId: 'deterministic-openrouter-request' };
  }
}

export class DeterministicCloudComputeProvider implements CloudComputeProvider {
  private readonly observations = new Map<Id, CloudComputeObservation>();
  private readonly clock: () => string;

  constructor(options: { readonly clock?: () => string } = {}) {
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async estimate(input: {
    readonly tenant: TenantRef;
    readonly compute: CloudComputeRequestV1;
  }): Promise<{ readonly estimatedCost: Money }> {
    assertComputeRequest(input.compute);
    const seconds = Math.ceil(input.compute.wallTimeMs / 1_000);
    return { estimatedCost: makeMoney(seconds, 'USD') };
  }

  async submit(input: CloudComputeSubmission): Promise<CloudComputeHandle> {
    assertComputeRequest(input.compute);
    const handle: CloudComputeHandle = {
      executionId: newSortableId(),
      externalExecutionId: `deterministic-modal-${newSortableId()}`,
      tenant: { ...input.tenant },
      state: 'running',
      submittedAt: this.clock(),
    };
    this.observations.set(handle.executionId, {
      handle,
      state: 'succeeded',
      observedAt: this.clock(),
      stdout: input.payload,
      stderr: '',
      computeSeconds: Math.max(1, Math.ceil(input.compute.wallTimeMs / 1_000)),
      outputBytes: new TextEncoder().encode(input.payload).byteLength,
      providerRequestId: handle.externalExecutionId,
    });
    return handle;
  }

  async observe(handle: CloudComputeHandle): Promise<CloudComputeObservation> {
    const observation = this.observations.get(handle.executionId);
    if (observation === undefined)
      throw runtimeError('ARTIFACT_NOT_FOUND', 'Cloud compute handle was not found');
    if (!sameTenant(observation.handle.tenant, handle.tenant))
      throw runtimeError('POLICY_DENIED', 'Cloud compute crosses tenant scope');
    return { ...observation, handle: { ...handle, state: observation.state } };
  }

  async terminate(handle: CloudComputeHandle): Promise<void> {
    this.observations.delete(handle.executionId);
  }
}
