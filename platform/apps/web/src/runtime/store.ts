import { useCallback, useSyncExternalStore } from 'react';
import type {
  CapabilitiesProjection,
  CommandAcknowledgement,
  FrontendCommand,
  HealthProjection,
  LicenseProjection,
  ProjectionEnvelope,
  RuntimeClient,
  RuntimeConnectionState,
  RuntimeEvent,
  SessionProjection,
  SubscriptionPage,
} from './contracts';
import { HttpRuntimeClient, RuntimeApiError } from './client';
import { PAGE_REGISTRY, pageAvailability, pageDefinition } from './page-registry';

export interface ProjectView {
  projectId: string;
  name: string;
  objective?: string;
  description?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  runCount?: number;
  assetCount?: number;
  [key: string]: unknown;
}

export interface RunView {
  runId: string;
  workflowId?: string;
  projectId?: string;
  name?: string;
  objective?: string;
  status: string;
  startedAt?: string;
  updatedAt?: string;
  progress?: number;
  providerId?: string;
  modelId?: string;
  routingReason?: string;
  fallbackCandidates?: Array<{ providerId: string; modelId: string }>;
  usageStatus?: {
    quotaState?: string;
    usedUnits?: number;
    limitUnits?: number;
    resetAt?: string;
  };
  [key: string]: unknown;
}

export type NotificationTone = 'info' | 'success' | 'warning' | 'danger';

export interface NotificationView {
  notificationId: string;
  title: string;
  message: string;
  occurredAt: string;
  tone: NotificationTone;
  read: boolean;
  eventName: string;
  aggregateType?: string;
  aggregateId?: string;
  page?: import('../data/profiles').Page;
}

export interface RuntimeSnapshot {
  connection: RuntimeConnectionState;
  health?: HealthProjection;
  session?: SessionProjection;
  license?: LicenseProjection;
  capabilities?: CapabilitiesProjection;
  projections: Record<string, ProjectionEnvelope<unknown>>;
  notifications: NotificationView[];
  cursor: number;
  seenEventIds: string[];
  lastError?: string;
}

type Listener = () => void;

const NOTIFICATION_STORAGE_KEY = 'spyderbyte.notifications.v1';

function loadNotifications(): NotificationView[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(NOTIFICATION_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is NotificationView => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return false;
      const value = item as Record<string, unknown>;
      return (
        typeof value.notificationId === 'string' &&
        typeof value.title === 'string' &&
        typeof value.message === 'string' &&
        typeof value.occurredAt === 'string' &&
        typeof value.eventName === 'string' &&
        typeof value.read === 'boolean'
      );
    });
  } catch {
    return [];
  }
}

function notificationTone(eventName: string): NotificationTone {
  const name = eventName.toLowerCase();
  if (name.includes('failed') || name.includes('denied') || name.includes('error')) return 'danger';
  if (name.includes('approval') || name.includes('awaiting') || name.includes('pending'))
    return 'warning';
  if (name.includes('completed') || name.includes('published') || name.includes('connected'))
    return 'success';
  return 'info';
}

function notificationPage(
  aggregateType: string | undefined,
  eventName: string,
): import('../data/profiles').Page | undefined {
  const normalized = `${aggregateType ?? ''} ${eventName}`.toLowerCase();
  if (normalized.includes('approval')) return 'approvals';
  if (normalized.includes('deployment')) return 'deployments';
  if (normalized.includes('connector') || normalized.includes('connection')) return 'connections';
  if (normalized.includes('dataset') || normalized.includes('query')) return 'data';
  if (normalized.includes('notebook')) return 'notebooks';
  if (normalized.includes('automation')) return 'automations';
  if (normalized.includes('pipeline')) return 'pipelines';
  if (normalized.includes('model') || normalized.includes('experiment')) return 'models';
  if (normalized.includes('repository') || normalized.includes('worktree')) return 'repositories';
  if (normalized.includes('run') || normalized.includes('workflow')) return 'runs';
  return undefined;
}

function notificationFromEvent(event: RuntimeEvent): NotificationView | undefined {
  const eventName = event.eventName.toLowerCase();
  const relevant =
    eventName.includes('approval') ||
    eventName.includes('run.') ||
    eventName.includes('workflow.') ||
    eventName.includes('deployment') ||
    eventName.includes('connector') ||
    eventName.includes('automation') ||
    eventName.includes('pipeline') ||
    eventName.includes('model.') ||
    eventName.includes('artifact.published') ||
    eventName.includes('notification.');
  if (!relevant) return undefined;
  const payload = record(event.payload);
  const title =
    typeof payload?.title === 'string'
      ? payload.title
      : event.eventName
          .split(/[.:]/)
          .filter(Boolean)
          .slice(0, 2)
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(' ');
  const message =
    typeof payload?.message === 'string'
      ? payload.message
      : typeof payload?.error === 'string'
        ? payload.error
        : `${event.aggregateType ?? 'Platform'} ${event.aggregateId ?? ''}`.trim();
  return {
    notificationId: event.eventId,
    title: title || 'Platform update',
    message: message || 'A platform event requires your attention.',
    occurredAt: event.occurredAt,
    tone: notificationTone(event.eventName),
    read: false,
    eventName: event.eventName,
    ...(event.aggregateType === undefined ? {} : { aggregateType: event.aggregateType }),
    ...(event.aggregateId === undefined ? {} : { aggregateId: event.aggregateId }),
    ...(notificationPage(event.aggregateType, event.eventName) === undefined
      ? {}
      : { page: notificationPage(event.aggregateType, event.eventName) }),
  };
}

function projectionState<T>(envelope: ProjectionEnvelope<unknown> | undefined): T | undefined {
  return (envelope?.data ?? envelope?.state) as T | undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function entries<T>(value: unknown, key: string): T[] {
  const object = record(value);
  const collection = record(object?.[key]);
  return collection
    ? Object.values(collection).filter(
        (item): item is T => item !== null && typeof item === 'object',
      )
    : [];
}

export class RuntimeStore {
  readonly client: RuntimeClient;
  private snapshot: RuntimeSnapshot = {
    connection: 'booting',
    projections: {},
    notifications: loadNotifications(),
    cursor: 0,
    seenEventIds: [],
  };
  private listeners = new Set<Listener>();
  private unsubscribe?: () => void;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private bootPromise?: Promise<void>;

  constructor(client: RuntimeClient = new HttpRuntimeClient()) {
    this.client = client;
  }

  getSnapshot = (): RuntimeSnapshot => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(): Promise<void> {
    if (this.bootPromise) return this.bootPromise;
    this.bootPromise = this.bootstrap();
    return this.bootPromise;
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.bootPromise = undefined;
  }

  retry(): Promise<void> {
    this.stop();
    this.setSnapshot({ connection: 'booting', lastError: undefined });
    return this.start();
  }

  markUnavailable(error: unknown): void {
    this.setSnapshot({
      connection: 'unavailable',
      lastError: errorMessage(error),
    });
  }

  markNotificationRead(notificationId: string): void {
    this.setSnapshot({
      notifications: this.snapshot.notifications.map((notification) =>
        notification.notificationId === notificationId
          ? { ...notification, read: true }
          : notification,
      ),
    });
  }

  markAllNotificationsRead(): void {
    this.setSnapshot({
      notifications: this.snapshot.notifications.map((notification) => ({
        ...notification,
        read: true,
      })),
    });
  }

  dismissNotification(notificationId: string): void {
    this.setSnapshot({
      notifications: this.snapshot.notifications.filter(
        (notification) => notification.notificationId !== notificationId,
      ),
    });
  }

  setRuntime(config: { baseUrl: string; token?: string; workspaceId?: string }): void {
    this.client.setRuntime?.(config);
  }

  async refresh(projections?: string[]): Promise<void> {
    const requested = projections ?? this.enabledProjectionNames();
    const results = await Promise.allSettled(
      requested.map(async (name) => [name, await this.client.query<unknown>(name)] as const),
    );
    const next = { ...this.snapshot.projections };
    let failed = false;
    let stale = false;
    let firstError: string | undefined;
    for (const result of results) {
      if (result.status === 'fulfilled') {
        next[result.value[0]] = result.value[1];
        stale ||= result.value[1].stale === true || result.value[1].freshness === 'stale';
      } else {
        failed = true;
        firstError ??= errorMessage(result.reason);
      }
    }
    this.setSnapshot({
      projections: next,
      connection: failed
        ? this.snapshot.connection === 'booting' || this.snapshot.connection === 'unavailable'
          ? 'unavailable'
          : 'stale'
        : stale
          ? 'stale'
          : this.snapshot.connection,
      lastError: firstError,
    });
  }

  async refreshStatus(): Promise<void> {
    const results = await Promise.allSettled([
      this.read<HealthProjection>('/v1/health'),
      this.read<LicenseProjection>('/v1/license/status'),
      this.read<CapabilitiesProjection>('/v1/capabilities'),
    ]);
    const patch: Partial<RuntimeSnapshot> = {};
    const health = results[0];
    const license = results[1];
    const capabilities = results[2];
    if (health.status === 'fulfilled') patch.health = health.value;
    if (license.status === 'fulfilled') patch.license = license.value;
    if (capabilities.status === 'fulfilled') patch.capabilities = capabilities.value;
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') patch.lastError = errorMessage(failure.reason);
    this.setSnapshot(patch);
  }

  async command(command: FrontendCommand): Promise<CommandAcknowledgement> {
    try {
      const acknowledgement = await this.client.command(command);
      this.scheduleRefresh();
      return acknowledgement;
    } catch (error) {
      this.setSnapshot({
        lastError: errorMessage(error),
        connection: this.snapshot.connection === 'connected' ? 'error' : this.snapshot.connection,
      });
      throw error;
    }
  }

  async plan(command: FrontendCommand): Promise<CommandAcknowledgement> {
    try {
      const acknowledgement = await this.client.plan(command);
      this.scheduleRefresh();
      return acknowledgement;
    } catch (error) {
      this.setSnapshot({
        lastError: errorMessage(error),
        connection: this.snapshot.connection === 'connected' ? 'error' : this.snapshot.connection,
      });
      throw error;
    }
  }

  private async bootstrap(): Promise<void> {
    try {
      const [health, session, license, capabilities] = await Promise.all([
        this.read<HealthProjection>('/v1/health'),
        this.read<SessionProjection>('/v1/session'),
        this.read<LicenseProjection>('/v1/license/status'),
        this.read<CapabilitiesProjection>('/v1/capabilities'),
      ]);
      this.client.setSession?.(session);
      this.setSnapshot({
        health,
        session,
        license,
        capabilities,
        connection: 'connected',
        lastError: undefined,
      });
      await this.refresh(this.enabledProjectionNames());
      this.unsubscribe = this.client.subscribe(
        {
          topics: [
            'workflow',
            'invocation',
            'run',
            'project',
            'artifact',
            'machine',
            'approval',
            'catalog',
            'connector',
            'model',
            'deployment',
            'dataset',
            'query',
            'visualization',
            'automation',
            'notebook',
            'repository',
            'worktree',
            'experiment',
            'pipeline',
            'incident',
            'resource',
            'environment',
            'governance',
            'settings',
            'chat',
          ],
          afterCursor: this.snapshot.cursor,
          onConnectionStateChange: (connection) => {
            if (connection === 'disconnected') {
              this.setSnapshot({ connection: 'disconnected' });
            } else if (connection === 'connected' && this.snapshot.connection === 'disconnected') {
              this.setSnapshot({ connection: 'stale' });
              this.scheduleRefresh();
            }
          },
        },
        (page) => this.acceptPage(page),
      );
    } catch (error) {
      const status =
        error instanceof RuntimeApiError && (error.status === 401 || error.status === 403)
          ? 'unauthorized'
          : error instanceof RuntimeApiError && error.status === 404
            ? 'unavailable'
            : 'error';
      this.setSnapshot({ connection: status, lastError: errorMessage(error) });
    }
  }

  private enabledProjectionNames(): string[] {
    const descriptors = this.snapshot.capabilities?.capabilities ?? {};
    const declared = [
      ...(this.snapshot.capabilities?.projections ?? []),
      ...Object.values(descriptors)
        .filter((descriptor) => descriptor.enabled !== false)
        .flatMap((descriptor) => descriptor.projections ?? [])
        .filter(Boolean),
      ...Object.values(PAGE_REGISTRY).flatMap((page) => page.projections ?? []),
    ].filter((projection) => descriptors[projection]?.enabled !== false);
    return [...new Set(declared)];
  }

  private async read<T>(path: string): Promise<T> {
    if (this.client.get) return this.client.get<T>(path);
    const url = new URL(path, globalThis.location?.href ?? 'http://localhost/');
    const response = await fetch(url.toString(), {
      headers: { accept: 'application/json' },
      credentials: 'include',
    });
    const body = (await response.json()) as T;
    if (!response.ok)
      throw new RuntimeApiError(response.status, body as never, response.statusText);
    return body;
  }

  private acceptPage(page: SubscriptionPage): void {
    const known = new Set(this.snapshot.seenEventIds);
    const fresh = page.events.filter((event) => !known.has(event.eventId));
    for (const event of fresh) known.add(event.eventId);
    const incomingNotifications = fresh
      .map(notificationFromEvent)
      .filter((notification): notification is NotificationView => notification !== undefined);
    const notificationById = new Map(
      [...incomingNotifications, ...this.snapshot.notifications].map((notification) => [
        notification.notificationId,
        notification,
      ]),
    );
    this.setSnapshot({
      cursor: Math.max(this.snapshot.cursor, page.cursor),
      seenEventIds: [...known].slice(-1000),
      notifications: [...notificationById.values()]
        .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
        .slice(0, 100),
      connection: page.gapDetected || page.refreshRequired ? 'stale' : 'connected',
    });
    if (page.gapDetected || page.refreshRequired || fresh.length > 0) this.scheduleRefresh();
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh().then(() => {
        if (this.snapshot.connection === 'stale' && this.snapshot.lastError === undefined) {
          this.setSnapshot({ connection: 'connected' });
        }
      });
    }, 75);
  }

  private setSnapshot(patch: Partial<RuntimeSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    if (patch.notifications !== undefined && typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(
          NOTIFICATION_STORAGE_KEY,
          JSON.stringify(this.snapshot.notifications.slice(0, 100)),
        );
      } catch {
        // Local notification history is an enhancement; runtime state remains authoritative.
      }
    }
    for (const listener of this.listeners) listener();
  }
}

export function useRuntimeStore(store: RuntimeStore): RuntimeSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function useProjects(store: RuntimeStore): {
  data: ProjectView[];
  state: RuntimeSnapshot['connection'];
  refresh: () => Promise<void>;
} {
  const snapshot = useRuntimeStore(store);
  const state = projectionState<Record<string, unknown>>(snapshot.projections.projects);
  return {
    data: entries<ProjectView>(state, 'projects'),
    state: snapshot.connection,
    refresh: () => store.refresh(['projects']),
  };
}

export function useProjection<T>(
  store: RuntimeStore,
  projection: string,
): {
  data?: T;
  envelope?: ProjectionEnvelope<T>;
  state: RuntimeSnapshot['connection'];
  refresh: () => Promise<void>;
} {
  const snapshot = useRuntimeStore(store);
  const envelope = snapshot.projections[projection] as ProjectionEnvelope<T> | undefined;
  const refresh = useCallback(() => store.refresh([projection]), [projection, store]);
  return {
    data: projectionState<T>(envelope),
    envelope,
    state: snapshot.connection,
    refresh,
  };
}

export function useNotifications(store: RuntimeStore): {
  data: NotificationView[];
  unreadCount: number;
  markRead: (notificationId: string) => void;
  markAllRead: () => void;
  dismiss: (notificationId: string) => void;
} {
  const snapshot = useRuntimeStore(store);
  return {
    data: snapshot.notifications,
    unreadCount: snapshot.notifications.filter((notification) => !notification.read).length,
    markRead: (notificationId) => store.markNotificationRead(notificationId),
    markAllRead: () => store.markAllNotificationsRead(),
    dismiss: (notificationId) => store.dismissNotification(notificationId),
  };
}

export function usePageCapability(
  store: RuntimeStore,
  page: import('../data/profiles').Page,
): ReturnType<typeof pageDefinition> & { state: ReturnType<typeof pageAvailability> } {
  const snapshot = useRuntimeStore(store);
  const definition = pageDefinition(page);
  return {
    ...definition,
    state: pageAvailability(page, snapshot.connection, snapshot.capabilities),
  };
}

export function useProject(
  store: RuntimeStore,
  projectId: string | undefined,
): { data?: ProjectView; state: RuntimeSnapshot['connection'] } {
  const { data, state } = useProjects(store);
  return {
    data: data.find((project) => project.projectId === projectId),
    state,
  };
}

export function useRuns(
  store: RuntimeStore,
  filters: { projectId?: string } = {},
): {
  data: RunView[];
  state: RuntimeSnapshot['connection'];
  refresh: () => Promise<void>;
} {
  const snapshot = useRuntimeStore(store);
  const state = projectionState<Record<string, unknown>>(snapshot.projections.runs);
  const data = entries<RunView>(state, 'runs').filter(
    (run) => filters.projectId === undefined || run.projectId === filters.projectId,
  );
  return {
    data,
    state: snapshot.connection,
    refresh: () => store.refresh(['runs']),
  };
}

export function useRun(
  store: RuntimeStore,
  runId: string | undefined,
): { data?: RunView; state: RuntimeSnapshot['connection'] } {
  const { data, state } = useRuns(store);
  return {
    data: data.find((run) => run.runId === runId || run.workflowId === runId),
    state,
  };
}

export function useRunTimeline(
  store: RuntimeStore,
  runId: string | undefined,
): { data: RuntimeEvent[]; state: RuntimeSnapshot['connection'] } {
  const snapshot = useRuntimeStore(store);
  const value = projectionState<Record<string, unknown>>(snapshot.projections['run-timeline']);
  const collection = record(value?.events);
  const data = Object.values(collection ?? {}).filter((event): event is RuntimeEvent => {
    const item = record(event);
    return item?.aggregateId === runId || item?.correlationId === runId;
  }) as RuntimeEvent[];
  return { data, state: snapshot.connection };
}

export function useMachine(store: RuntimeStore): {
  data?: Record<string, unknown>;
  state: RuntimeSnapshot['connection'];
} {
  const snapshot = useRuntimeStore(store);
  return {
    data: projectionState<Record<string, unknown>>(snapshot.projections['machine-state']),
    state: snapshot.connection,
  };
}

export function useSettings(
  store: RuntimeStore,
  scope = 'workspace',
): { data?: Record<string, unknown>; state: RuntimeSnapshot['connection'] } {
  const snapshot = useRuntimeStore(store);
  const projection = (
    snapshot.projections as Record<string, ProjectionEnvelope<unknown> | undefined>
  ).settings;
  const data = projectionState<Record<string, unknown>>(projection);
  return {
    data: data ? (record(data[scope]) ?? data) : undefined,
    state: snapshot.connection,
  };
}

function errorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  if (value.toLowerCase().includes('resource envelope')) {
    return 'The platform could not satisfy the requested compute capacity. Review Compute and retry.';
  }
  if (value.toLowerCase().includes('github') && value.toLowerCase().includes('not configured')) {
    return 'GitHub is not configured for this platform. An administrator must add the OAuth application settings.';
  }
  if (value.includes('conversation commands are not enabled')) {
    return 'Agent assistance is not enabled for this platform configuration.';
  }
  return value;
}
