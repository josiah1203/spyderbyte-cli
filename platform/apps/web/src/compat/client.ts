import type { Id, JsonValue, RuntimeCommand } from '@agentic-platform/runtime-contracts';
import type { SubscriptionPage } from '@agentic-platform/runtime-domain';
import type { ProjectionApi } from './index.js';

export type FetchFunction = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class WebApiError extends Error {
  readonly status: number;
  readonly body: JsonValue | undefined;
  readonly code: string | undefined;

  constructor(status: number, body: JsonValue | undefined, statusText = '') {
    const record = asRecord(body);
    const message =
      typeof record?.['error'] === 'string'
        ? record['error']
        : statusText.length > 0
          ? statusText
          : `API request failed with status ${status}`;
    super(message);
    this.name = 'WebApiError';
    this.status = status;
    this.body = body;
    this.code = typeof record?.['code'] === 'string' ? record['code'] : undefined;
  }
}

export interface HttpProjectionApiOptions {
  readonly baseUrl?: string;
  readonly fetch?: FetchFunction;
  readonly headers?: Readonly<Record<string, string>>;
  readonly credentials?: RequestCredentials;
}

type JsonRecord = { [key: string]: JsonValue };

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== 'object') return false;
  return Object.values(value).every(isJsonValue);
}

function asRecord(value: JsonValue | undefined): JsonRecord | undefined {
  return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : undefined;
}

function requestUrl(baseUrl: string, path: string): string {
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(path)) return path;
  if (baseUrl.length === 0) return path;
  return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

async function responseBody(response: Response): Promise<JsonValue | undefined> {
  const text = await response.text();
  if (text.trim().length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isJsonValue(parsed) ? parsed : undefined;
  } catch {
    return { error: 'API returned invalid JSON' };
  }
}

export class HttpProjectionApi implements ProjectionApi {
  private baseUrl: string;
  private readonly fetcher: FetchFunction;
  private baseHeaders: Readonly<Record<string, string>>;
  private headers: Readonly<Record<string, string>>;
  private readonly credentials: RequestCredentials;
  private workspaceId: Id | undefined;

  constructor(options: HttpProjectionApiOptions = {}) {
    this.baseUrl = options.baseUrl ?? '';
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.baseHeaders = options.headers ?? {};
    this.headers = this.baseHeaders;
    this.credentials = options.credentials ?? 'same-origin';
  }

  setRuntime(baseUrl: string, headers: Readonly<Record<string, string>> = {}): void {
    this.baseUrl = baseUrl;
    this.baseHeaders = headers;
    this.headers = {
      ...this.baseHeaders,
      ...(this.workspaceId === undefined ? {} : { 'x-agentic-workspace-id': this.workspaceId }),
    };
  }

  setWorkspace(workspaceId: Id | undefined): void {
    this.workspaceId = workspaceId;
    this.headers = {
      ...this.baseHeaders,
      ...(workspaceId === undefined ? {} : { 'x-agentic-workspace-id': workspaceId }),
    };
  }

  async query<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  async command(command: RuntimeCommand): Promise<JsonValue> {
    return this.request<JsonValue>('POST', '/v1/commands', command);
  }

  async planCommand(command: RuntimeCommand): Promise<JsonValue> {
    return this.request<JsonValue>('POST', '/v1/commands/plan', command);
  }

  async runPlannedWorkflow(workflowId: Id): Promise<JsonValue> {
    return this.request<JsonValue>('POST', `/v1/workflows/${workflowId}/run`);
  }

  async approveWorkflowPlan(approvalId: Id): Promise<JsonValue> {
    return this.request<JsonValue>('POST', `/v1/approvals/${approvalId}/approve`, {
      reason: 'Approved in Spyderbyte plan review',
    });
  }

  async rejectWorkflowPlan(approvalId: Id): Promise<JsonValue> {
    return this.request<JsonValue>('POST', `/v1/approvals/${approvalId}/reject`, {
      reason: 'Rejected in Spyderbyte plan review',
    });
  }

  async importLicense(entitlement: JsonValue): Promise<JsonValue> {
    return this.request<JsonValue>('POST', '/v1/license/import', entitlement);
  }

  async workspaceSummary(): Promise<JsonValue> {
    return this.request<JsonValue>('GET', '/v1/workspace');
  }

  async exportWorkspace(archivePath: string): Promise<JsonValue> {
    return this.request<JsonValue>('POST', '/v1/workspace/export', {
      destinationPath: archivePath,
    });
  }

  async backupWorkspace(archivePath: string): Promise<JsonValue> {
    return this.request<JsonValue>('POST', '/v1/workspace/backup', {
      destinationPath: archivePath,
    });
  }

  async previewWorkspaceRestore(archivePath: string, destinationRoot: string): Promise<JsonValue> {
    return this.request<JsonValue>('POST', '/v1/workspace/restore-preview', {
      archivePath,
      destinationRoot,
    });
  }

  async importWorkspace(archivePath: string, destinationRoot: string): Promise<JsonValue> {
    return this.request<JsonValue>('POST', '/v1/workspace/import', {
      archivePath,
      destinationRoot,
    });
  }

  async stageArtifactUpload(content: string, mediaType: string): Promise<JsonValue> {
    return this.request<JsonValue>('POST', '/v1/artifacts/uploads', { content, mediaType });
  }

  async publishArtifactVersion(artifactId: Id, request: JsonValue): Promise<JsonValue> {
    return this.request<JsonValue>('POST', `/v1/artifacts/${artifactId}/versions`, request);
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const response = await this.fetcher(requestUrl(this.baseUrl, path), {
      method,
      headers: {
        accept: 'application/json',
        ...this.headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      credentials: this.credentials,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = await responseBody(response);
    if (!response.ok) throw new WebApiError(response.status, parsed, response.statusText);
    return parsed as T;
  }
}

export function isWebConflict(error: unknown): boolean {
  if (error instanceof WebApiError) {
    return error.status === 409 || error.code === 'CONCURRENCY_STALE_VERSION';
  }
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { status?: unknown; code?: unknown };
  return candidate.status === 409 || candidate.code === 'CONCURRENCY_STALE_VERSION';
}

export interface EventSourceLike {
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}

export interface FetchEventSourceOptions {
  readonly fetch?: FetchFunction;
  readonly headers?: Readonly<Record<string, string>>;
  readonly credentials?: RequestCredentials;
}

/**
 * EventSource-compatible transport for authenticated desktop streams. Native EventSource cannot
 * set an Authorization header, and a loopback cookie is not dependable from a custom Tauri origin.
 */
export class FetchEventSource implements EventSourceLike {
  private readonly listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();
  private readonly controller = new AbortController();
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly options: FetchEventSourceOptions = {},
  ) {
    void this.consume();
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  close(): void {
    this.closed = true;
    this.controller.abort();
  }

  private async consume(): Promise<void> {
    try {
      const fetcher = this.options.fetch ?? globalThis.fetch.bind(globalThis);
      const response = await fetcher(this.url, {
        method: 'GET',
        headers: {
          accept: 'text/event-stream',
          ...this.options.headers,
        },
        credentials: this.options.credentials ?? 'same-origin',
        signal: this.controller.signal,
      });
      if (!response.ok) {
        throw new WebApiError(response.status, await responseBody(response), response.statusText);
      }
      if (response.body === null) throw new Error('Event stream body is unavailable');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let eventName = 'message';
      let dataLines: string[] = [];
      const dispatch = (): void => {
        if (dataLines.length === 0 || this.closed) {
          eventName = 'message';
          dataLines = [];
          return;
        }
        const event = { data: dataLines.join('\n') } as MessageEvent<string>;
        for (const listener of this.listeners.get(eventName) ?? []) listener(event);
        eventName = 'message';
        dataLines = [];
      };
      const consumeLine = (line: string): void => {
        const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
        if (normalized.length === 0) {
          dispatch();
          return;
        }
        if (normalized.startsWith(':')) return;
        const separator = normalized.indexOf(':');
        const field = separator === -1 ? normalized : normalized.slice(0, separator);
        const value =
          separator === -1
            ? ''
            : normalized.slice(separator + (normalized[separator + 1] === ' ' ? 2 : 1));
        if (field === 'event') eventName = value;
        if (field === 'data') dataLines.push(value);
      };

      while (!this.closed) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) consumeLine(line);
      }
      buffer += decoder.decode();
      if (buffer.length > 0) consumeLine(buffer);
      dispatch();
      if (!this.closed) this.emitError(new Error('Event stream ended'));
    } catch (error) {
      if (!this.closed && !(error instanceof DOMException && error.name === 'AbortError')) {
        this.emitError(error);
      }
    }
  }

  private emitError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    for (const listener of this.listeners.get('error') ?? []) {
      listener({ data: message } as MessageEvent<string>);
    }
  }
}

export interface ReconnectableSubscriptionOptions {
  readonly baseUrl?: string;
  readonly topics?: readonly string[];
  readonly maxEvents?: number;
  readonly eventSource?: (url: string) => EventSourceLike;
  readonly retryDelayMs?: number;
  readonly withCredentials?: boolean;
  readonly workspaceId?: Id;
  readonly onPage: (page: SubscriptionPage) => void;
  readonly onError?: (error: unknown) => void;
  readonly onDisconnect?: () => void;
}

export class ReconnectableSubscriptionClient {
  private readonly options: ReconnectableSubscriptionOptions;
  private baseUrl: string;
  private readonly retryDelayMs: number;
  private workspaceId: Id | undefined;
  private source: EventSourceLike | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private cursor = 0;
  private stopped = true;

  constructor(options: ReconnectableSubscriptionOptions) {
    this.options = options;
    this.baseUrl = options.baseUrl ?? '';
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
    this.workspaceId = options.workspaceId;
    if (!Number.isSafeInteger(this.retryDelayMs) || this.retryDelayMs < 0) {
      throw new TypeError('retryDelayMs must be a non-negative integer');
    }
  }

  start(afterCursor = 0): void {
    if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) {
      throw new TypeError('afterCursor must be a non-negative integer');
    }
    this.stopSource();
    this.cursor = afterCursor;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.stopSource();
  }

  currentCursor(): number {
    return this.cursor;
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl;
    if (this.stopped) return;
    this.stopSource();
    this.connect();
  }

  setWorkspace(workspaceId: Id): void {
    this.workspaceId = workspaceId;
    if (this.stopped) return;
    this.stopSource();
    this.cursor = 0;
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;
    const url = new URL(
      requestUrl(this.baseUrl, '/v1/subscriptions/events'),
      typeof globalThis.location === 'object' ? globalThis.location.href : 'http://localhost/',
    );
    url.searchParams.set('afterCursor', String(this.cursor));
    if (this.workspaceId !== undefined) {
      url.searchParams.set('workspaceId', this.workspaceId);
    }
    if (this.options.maxEvents !== undefined) {
      url.searchParams.set('maxEvents', String(this.options.maxEvents));
    }
    for (const topic of this.options.topics ?? []) url.searchParams.append('topic', topic);
    const factory =
      this.options.eventSource ??
      ((sourceUrl: string): EventSourceLike =>
        new EventSource(sourceUrl, { withCredentials: this.options.withCredentials ?? false }));
    try {
      const source = factory(url.toString());
      this.source = source;
      source.addEventListener('runtime.events', (event) => this.handlePage(event));
      source.addEventListener('error', () => this.handleDisconnect());
    } catch (error) {
      this.options.onError?.(error);
      this.scheduleReconnect();
    }
  }

  private handlePage(event: MessageEvent<string>): void {
    try {
      const parsed: unknown = JSON.parse(event.data);
      if (!isSubscriptionPage(parsed)) throw new TypeError('Invalid subscription page');
      if (parsed.cursor < this.cursor) return;
      this.cursor = parsed.cursor;
      this.options.onPage(parsed);
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private handleDisconnect(): void {
    this.stopSource();
    if (this.stopped) return;
    this.options.onDisconnect?.();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer !== undefined) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.connect();
    }, this.retryDelayMs);
  }

  private stopSource(): void {
    this.source?.close();
    this.source = undefined;
  }
}

function isSubscriptionPage(value: unknown): value is SubscriptionPage {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(record['cursor']) &&
    Array.isArray(record['events']) &&
    typeof record['gapDetected'] === 'boolean' &&
    typeof record['refreshRequired'] === 'boolean'
  );
}
