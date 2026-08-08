import type {
  Actor,
  JsonValue,
  RuntimeEvent,
  TenantRef,
  WorkspaceContext,
} from '@agentic-platform/runtime-contracts';
import type { SubscriptionPage } from '@agentic-platform/runtime-domain';

export type {
  Actor,
  CapabilitiesProjection,
  CapabilityDescriptor,
  Id,
  JsonPrimitive,
  JsonValue,
  RuntimeEvent,
  TenantRef,
  WorkspaceContext,
} from '@agentic-platform/runtime-contracts';
export type { SubscriptionPage } from '@agentic-platform/runtime-domain';

export interface SessionProjection {
  schemaVersion?: number;
  sessionId?: string;
  actor: Actor;
  tenant: TenantRef;
  workspaces?: TenantRef[];
  workspaceContext?: WorkspaceContext;
  workspaceContexts?: WorkspaceContext[];
  scopes?: string[];
  issuedAt?: string;
  expiresAt?: string;
}

export interface HealthProjection {
  status: string;
  service?: string;
  tenant?: TenantRef;
  license?: string;
}

export interface LicenseProjection {
  status: string;
  reason?: string;
  licenseId?: string;
  expiresAt?: string;
}

export interface ProjectionEnvelope<T> {
  projectionName: string;
  projectionVersion?: number;
  tenant?: TenantRef;
  state: T;
  data?: T;
  cursor?: number;
  streamHead?: number;
  lag?: number;
  stale?: boolean;
  generatedAt?: string;
  permissions?: string[];
  freshness?: 'fresh' | 'stale' | 'unavailable';
  [key: string]: unknown;
}

export interface FrontendCommand {
  commandType: string;
  payload: JsonValue;
  commandId?: string;
  idempotencyKey?: string;
  correlationId?: string;
  causationId?: string;
  expectedRevision?: number;
}

export interface CommandAcknowledgement {
  accepted: boolean;
  replayed?: boolean;
  commandId?: string;
  idempotencyKey?: string;
  correlationId?: string;
  result?: JsonValue;
  [key: string]: unknown;
}

export interface SubscriptionOptions {
  topics?: string[];
  maxEvents?: number;
  afterCursor?: number;
  onConnectionStateChange?: (state: 'connected' | 'disconnected') => void;
}

export type RuntimeEventListener = (event: RuntimeEvent) => void;

export interface RuntimeClient {
  query<T>(
    projection: string,
    params?: Record<string, string | number | boolean>,
  ): Promise<ProjectionEnvelope<T>>;
  command(command: FrontendCommand): Promise<CommandAcknowledgement>;
  plan(command: FrontendCommand): Promise<CommandAcknowledgement>;
  subscribe(options: SubscriptionOptions, listener: (page: SubscriptionPage) => void): () => void;
  refresh(projections?: string[]): Promise<void>;
  get?<T>(path: string, options?: { signal?: AbortSignal }): Promise<T>;
  post?<T>(path: string, body: JsonValue, options?: { signal?: AbortSignal }): Promise<T>;
  put?<T>(path: string, body: JsonValue, options?: { signal?: AbortSignal }): Promise<T>;
  getBaseUrl?(): string;
  setSession?(session: SessionProjection): void;
  setRuntime?(config: { baseUrl: string; token?: string; workspaceId?: string }): void;
}

export type RuntimeConnectionState =
  | 'booting'
  | 'connected'
  | 'disconnected'
  | 'stale'
  | 'unauthorized'
  | 'unavailable'
  | 'error';
