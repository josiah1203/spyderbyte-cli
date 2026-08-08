import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runtimeError, type Id, type TenantRef } from '@agentic-platform/runtime-contracts';
import type {
  SettingsEnvelope,
  SettingsScope,
  SettingsStore,
  SettingsStorePutRequest,
} from '@agentic-platform/local-api';

function recordKey(tenant: TenantRef, scope: SettingsScope, projectId?: Id): string {
  return `${tenant.tenantId}:${tenant.workspaceId}:${scope}:${projectId ?? ''}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

interface SettingsFile {
  schemaVersion: 1;
  records: Record<string, SettingsEnvelope>;
}

/** JSON-backed workspace settings. The workspace archive already captures `.agentic` state. */
export class FileSettingsStore implements SettingsStore {
  private readonly records = new Map<string, SettingsEnvelope>();

  constructor(private readonly filePath: string) {
    this.load();
  }

  get(tenant: TenantRef, scope: SettingsScope, projectId?: Id): SettingsEnvelope | undefined {
    const value = this.records.get(recordKey(tenant, scope, projectId));
    return value === undefined ? undefined : clone(value);
  }

  put(request: SettingsStorePutRequest): SettingsEnvelope {
    const key = recordKey(request.tenant, request.scope, request.projectId);
    const current = this.records.get(key);
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
    const next: SettingsEnvelope = {
      schemaVersion: 1,
      scope: request.scope,
      ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
      revision: currentRevision + 1,
      values: { ...(current?.values ?? {}), ...clone(request.patch) },
      updatedAt: request.updatedAt,
    };
    this.records.set(key, clone(next));
    this.flush();
    return clone(next);
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Workspace settings file is not valid JSON');
    }
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      (parsed as Record<string, unknown>)['schemaVersion'] !== 1 ||
      typeof (parsed as Record<string, unknown>)['records'] !== 'object' ||
      (parsed as Record<string, unknown>)['records'] === null
    ) {
      throw runtimeError(
        'VALIDATION_SCHEMA_MISMATCH',
        'Workspace settings file has an invalid shape',
      );
    }
    const records = (parsed as { records: Record<string, unknown> }).records;
    for (const [key, value] of Object.entries(records)) {
      if (
        value === null ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        (value as Record<string, unknown>)['schemaVersion'] !== 1 ||
        !Number.isSafeInteger((value as Record<string, unknown>)['revision']) ||
        typeof (value as Record<string, unknown>)['values'] !== 'object' ||
        (value as Record<string, unknown>)['values'] === null
      ) {
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `Settings record ${key} is invalid`);
      }
      this.records.set(key, clone(value as SettingsEnvelope));
    }
  }

  private flush(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const content: SettingsFile = {
      schemaVersion: 1,
      records: Object.fromEntries(
        [...this.records.entries()].map(([key, value]) => [key, clone(value)]),
      ),
    };
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, this.filePath);
  }
}
