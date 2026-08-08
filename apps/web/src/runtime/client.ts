import type {
  Actor,
  CommandAcknowledgement,
  FrontendCommand,
  JsonValue,
  ProjectionEnvelope,
  RuntimeClient,
  RuntimeEvent,
  SubscriptionOptions,
  SubscriptionPage,
  TenantRef,
} from './contracts';

type FetchFunction = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface RuntimeWindowConfig {
  baseUrl?: string;
  token?: string;
  workspaceId?: string;
}

declare global {
  interface Window {
    __AGENTIC_RUNTIME_CONFIG__?: RuntimeWindowConfig;
    __TAURI_INTERNALS__?: {
      invoke?: (command: string) => Promise<
        RuntimeWindowConfig & {
          apiBase?: string;
          authToken?: string;
        }
      >;
    };
  }
}

export class RuntimeApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly body?: JsonValue;

  constructor(status: number, body: JsonValue | undefined, statusText = '') {
    const record = asRecord(body);
    const message =
      typeof record?.error === 'string'
        ? record.error
        : statusText || `Runtime request failed with status ${status}`;
    super(message);
    this.name = 'RuntimeApiError';
    this.status = status;
    this.body = body;
    this.code = typeof record?.code === 'string' ? record.code : undefined;
  }
}

export class RuntimeProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeProtocolError';
  }
}

interface RuntimeClientOptions {
  baseUrl?: string;
  token?: string;
  workspaceId?: string;
  fetch?: FetchFunction;
  credentials?: RequestCredentials;
  getSession?: () => { tenant?: TenantRef; actor?: Actor };
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : undefined;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== 'object') return false;
  return Object.values(value).every(isJsonValue);
}

async function parseBody(response: Response): Promise<JsonValue | undefined> {
  const text = await response.text();
  if (!text.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isJsonValue(parsed) ? parsed : { error: 'Runtime returned an invalid JSON value' };
  } catch {
    return { error: 'Runtime returned malformed JSON' };
  }
}

let fallbackUuidSequence = 0;

function uuidv7(): string {
  const bytes = new Uint8Array(16);
  const cryptoObject = globalThis.crypto;
  if (cryptoObject?.getRandomValues) cryptoObject.getRandomValues(bytes);
  else {
    const sequence = fallbackUuidSequence++;
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = (Date.now() + sequence * 31 + index * 17) & 0xff;
    }
  }
  let timestamp = Date.now();
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp & 0xff;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function newRuntimeId(): string {
  return uuidv7();
}

function requestUrl(baseUrl: string, path: string): string {
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(path)) return path;
  if (!baseUrl) return path;
  return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

function browserApiBase(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const value = document
    .querySelector<HTMLMetaElement>('meta[name="agentic-api-base"]')
    ?.content.trim();
  return value || undefined;
}

class FetchSse {
  private readonly controller = new AbortController();
  private closed = false;
  private readonly listeners = new Map<string, Set<(data: string) => void>>();

  constructor(
    private readonly url: string,
    private readonly fetcher: FetchFunction,
    private readonly headers: Record<string, string>,
    private readonly credentials: RequestCredentials,
  ) {
    void this.consume();
  }

  on(type: string, listener: (data: string) => void): void {
    const listeners = this.listeners.get(type) ?? new Set<(data: string) => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  close(): void {
    this.closed = true;
    this.controller.abort();
  }

  private emit(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener(data);
  }

  private async consume(): Promise<void> {
    try {
      const response = await this.fetcher(this.url, {
        headers: { accept: 'text/event-stream', ...this.headers },
        credentials: this.credentials,
        signal: this.controller.signal,
      });
      if (!response.ok)
        throw new RuntimeApiError(response.status, await parseBody(response), response.statusText);
      if (!response.body) throw new Error('Runtime event stream has no body');
      this.emit('open', '');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let eventName = 'message';
      let data: string[] = [];
      const dispatch = (): void => {
        if (data.length > 0 && !this.closed) this.emit(eventName, data.join('\n'));
        eventName = 'message';
        data = [];
      };
      const line = (raw: string): void => {
        const value = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if (!value) {
          dispatch();
          return;
        }
        if (value.startsWith(':')) return;
        const separator = value.indexOf(':');
        const field = separator === -1 ? value : value.slice(0, separator);
        const content =
          separator === -1 ? '' : value.slice(separator + (value[separator + 1] === ' ' ? 2 : 1));
        if (field === 'event') eventName = content;
        if (field === 'data') data.push(content);
      };
      while (!this.closed) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const item of lines) line(item);
      }
      buffer += decoder.decode();
      if (buffer) line(buffer);
      dispatch();
      if (!this.closed) this.emit('error', 'Runtime event stream ended');
    } catch (error) {
      if (!this.closed && !(error instanceof DOMException && error.name === 'AbortError')) {
        this.emit('error', error instanceof Error ? error.message : String(error));
      }
    }
  }
}

class ReconnectingSse {
  private source?: FetchSse;
  private cursor: number;
  private stopped = true;
  private retryTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly connectSource: (url: string) => FetchSse,
    private readonly baseUrl: string,
    private readonly options: SubscriptionOptions,
    private readonly onPage: (page: SubscriptionPage) => void,
    private readonly onDisconnect: () => void,
  ) {
    this.cursor = options.afterCursor ?? 0;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.source?.close();
    this.source = undefined;
  }

  private connect(): void {
    if (this.stopped) return;
    const url = new URL(
      requestUrl(this.baseUrl, '/v1/subscriptions/events'),
      globalThis.location?.href ?? 'http://localhost/',
    );
    url.searchParams.set('afterCursor', String(this.cursor));
    if (this.options.maxEvents !== undefined)
      url.searchParams.set('maxEvents', String(this.options.maxEvents));
    for (const topic of this.options.topics ?? []) url.searchParams.append('topic', topic);
    try {
      const source = this.connectSource(url.toString());
      this.source = source;
      source.on('open', () => this.options.onConnectionStateChange?.('connected'));
      source.on('runtime.events', (data) => this.handlePage(data));
      source.on('error', () => this.handleDisconnect());
    } catch {
      this.handleDisconnect();
    }
  }

  private handlePage(data: string): void {
    try {
      const parsed: unknown = JSON.parse(data);
      if (!isSubscriptionPage(parsed)) throw new Error('Runtime sent an invalid subscription page');
      if (parsed.cursor < this.cursor) return;
      this.cursor = parsed.cursor;
      this.options.onConnectionStateChange?.('connected');
      this.onPage(parsed);
    } catch {
      this.handleDisconnect();
    }
  }

  private handleDisconnect(): void {
    this.source?.close();
    this.source = undefined;
    if (this.stopped) return;
    this.options.onConnectionStateChange?.('disconnected');
    this.onDisconnect();
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.connect();
    }, 1000);
  }
}

function isSubscriptionPage(value: unknown): value is SubscriptionPage {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(record.cursor) &&
    Array.isArray(record.events) &&
    record.events.every(isRuntimeEvent) &&
    typeof record.gapDetected === 'boolean' &&
    typeof record.refreshRequired === 'boolean'
  );
}

function isRuntimeEvent(value: unknown): value is RuntimeEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.eventId === 'string' && typeof record.eventName === 'string';
}

function isProjectionEnvelope(value: unknown): value is ProjectionEnvelope<unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.projectionName === 'string' && ('state' in record || 'data' in record);
}

export class HttpRuntimeClient implements RuntimeClient {
  private readonly fetcher: FetchFunction;
  private readonly credentials: RequestCredentials;
  private baseUrl: string;
  private token?: string;
  private workspaceId?: string;
  private readonly getSession?: RuntimeClientOptions['getSession'];
  private session?: { tenant: TenantRef; actor: Actor };

  constructor(options: RuntimeClientOptions = {}) {
    const config = typeof window === 'undefined' ? undefined : window.__AGENTIC_RUNTIME_CONFIG__;
    this.baseUrl =
      options.baseUrl ??
      config?.baseUrl ??
      browserApiBase() ??
      import.meta.env.VITE_AGENTIC_API_BASE ??
      '';
    this.token = options.token ?? config?.token ?? import.meta.env.VITE_AGENTIC_API_TOKEN;
    this.workspaceId = options.workspaceId ?? config?.workspaceId;
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.credentials = options.credentials ?? 'include';
    this.getSession = options.getSession;
  }

  async query<T>(
    projection: string,
    params: Record<string, string | number | boolean> = {},
  ): Promise<ProjectionEnvelope<T>> {
    const url = new URL(
      requestUrl(this.baseUrl, `/v1/projections/${encodeURIComponent(projection)}`),
      globalThis.location?.href ?? 'http://localhost/',
    );
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const response = await this.request<unknown>('GET', url.toString());
    if (!isProjectionEnvelope(response))
      throw new RuntimeProtocolError('Runtime returned an invalid projection envelope');
    return response as ProjectionEnvelope<T>;
  }

  async get<T>(path: string, options: { signal?: AbortSignal } = {}): Promise<T> {
    return this.request<T>('GET', requestUrl(this.baseUrl, path), undefined, options);
  }

  async post<T>(path: string, body: JsonValue, options: { signal?: AbortSignal } = {}): Promise<T> {
    return this.request<T>('POST', requestUrl(this.baseUrl, path), body, options);
  }

  async put<T>(path: string, body: JsonValue, options: { signal?: AbortSignal } = {}): Promise<T> {
    return this.request<T>('PUT', requestUrl(this.baseUrl, path), body, options);
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  setSession(session: { tenant: TenantRef; actor: Actor }): void {
    this.session = session;
  }

  setRuntime(config: { baseUrl: string; token?: string; workspaceId?: string }): void {
    this.baseUrl = config.baseUrl;
    this.token = config.token;
    this.workspaceId = config.workspaceId;
  }

  private wireCommand(command: FrontendCommand): {
    schemaVersion: number;
    commandId: string;
    commandType: string;
    tenant: TenantRef;
    actor: Actor;
    issuedAt: string;
    idempotencyKey: string;
    correlationId: string;
    causationId?: string;
    payload: JsonValue;
  } {
    const session = this.getSession?.() ?? this.session;
    if (!session?.tenant || !session.actor) throw new Error('Runtime session is not ready');
    const now = new Date().toISOString();
    return {
      schemaVersion: 1,
      commandId: command.commandId ?? uuidv7(),
      commandType: command.commandType,
      tenant: session.tenant,
      actor: session.actor,
      issuedAt: now,
      idempotencyKey: command.idempotencyKey ?? `${command.commandType}:${uuidv7()}`,
      correlationId: command.correlationId ?? uuidv7(),
      ...(command.causationId ? { causationId: command.causationId } : {}),
      payload:
        command.expectedRevision === undefined
          ? command.payload
          : {
              ...asRecord(command.payload),
              expectedRevision: command.expectedRevision,
            },
    };
  }

  private acknowledgement(
    wire: ReturnType<HttpRuntimeClient['wireCommand']>,
    result: JsonValue,
  ): CommandAcknowledgement {
    const record = asRecord(result);
    if (!record)
      throw new RuntimeProtocolError('Runtime returned an invalid command acknowledgement');
    return {
      accepted: record.accepted === true,
      ...record,
      result: record.result ?? result,
      correlationId: wire.correlationId,
    };
  }

  async command(command: FrontendCommand): Promise<CommandAcknowledgement> {
    const wire = this.wireCommand(command);
    const result = await this.request<JsonValue>(
      'POST',
      requestUrl(this.baseUrl, '/v1/commands'),
      wire,
    );
    return this.acknowledgement(wire, result);
  }

  async plan(command: FrontendCommand): Promise<CommandAcknowledgement> {
    const wire = this.wireCommand(command);
    const result = await this.request<JsonValue>(
      'POST',
      requestUrl(this.baseUrl, '/v1/commands/plan'),
      wire,
    );
    return this.acknowledgement(wire, result);
  }

  subscribe(options: SubscriptionOptions, listener: (page: SubscriptionPage) => void): () => void {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (this.workspaceId) headers['x-agentic-workspace-id'] = this.workspaceId;
    const source = new ReconnectingSse(
      (url) => new FetchSse(url, this.fetcher, headers, this.credentials),
      this.baseUrl,
      options,
      listener,
      () => undefined,
    );
    source.start();
    return () => source.stop();
  }

  async refresh(projections: string[] = []): Promise<void> {
    await Promise.all(projections.map((projection) => this.query(projection)));
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    body?: unknown,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    headers['x-spyderbyte-interface'] = 'web';
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (this.workspaceId) headers['x-agentic-workspace-id'] = this.workspaceId;
    const response = await this.fetcher(url, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      credentials: this.credentials,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = await parseBody(response);
    if (!response.ok) throw new RuntimeApiError(response.status, parsed, response.statusText);
    return parsed as T;
  }
}
