import {
  runtimeError,
  type Id,
  type JsonValue,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';

export type SettingsScope = 'user' | 'workspace' | 'project';
export type SettingsValues = { [key: string]: JsonValue };

export interface SettingsEnvelope {
  schemaVersion: 1;
  scope: SettingsScope;
  projectId?: Id;
  revision: number;
  values: SettingsValues;
  updatedAt: string;
}

export interface SettingsStorePutRequest {
  tenant: TenantRef;
  scope: SettingsScope;
  projectId?: Id;
  patch: SettingsValues;
  expectedRevision?: number;
  updatedAt: string;
}

export interface SettingsStore {
  get(tenant: TenantRef, scope: SettingsScope, projectId?: Id): SettingsEnvelope | undefined;
  put(request: SettingsStorePutRequest): SettingsEnvelope;
}

function key(tenant: TenantRef, scope: SettingsScope, projectId?: Id): string {
  return `${tenant.tenantId}:${tenant.workspaceId}:${scope}:${projectId ?? ''}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Small durable-store-shaped implementation used by tests and non-filesystem compositions. */
export class InMemorySettingsStore implements SettingsStore {
  private readonly records = new Map<string, SettingsEnvelope>();

  get(tenant: TenantRef, scope: SettingsScope, projectId?: Id): SettingsEnvelope | undefined {
    const value = this.records.get(key(tenant, scope, projectId));
    return value === undefined ? undefined : clone(value);
  }

  put(request: SettingsStorePutRequest): SettingsEnvelope {
    const recordKey = key(request.tenant, request.scope, request.projectId);
    const current = this.records.get(recordKey);
    const currentRevision = current?.revision ?? 0;
    if (
      request.expectedRevision !== undefined &&
      (!Number.isSafeInteger(request.expectedRevision) ||
        request.expectedRevision !== currentRevision)
    ) {
      throw runtimeError(
        'CONCURRENCY_STALE_VERSION',
        `Settings revision ${request.expectedRevision} does not match ${currentRevision}`,
      );
    }
    const values: SettingsValues = {
      ...(current?.values ?? {}),
      ...clone(request.patch),
    };
    const next: SettingsEnvelope = {
      schemaVersion: 1,
      scope: request.scope,
      ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
      revision: currentRevision + 1,
      values,
      updatedAt: request.updatedAt,
    };
    this.records.set(recordKey, clone(next));
    return clone(next);
  }
}
