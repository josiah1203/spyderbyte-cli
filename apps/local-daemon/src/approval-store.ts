import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  runtimeError,
  validateContract,
  type ApprovalRequest,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import type { ApprovalRecord, ApprovalStore } from '@agentic-platform/policy';

interface ApprovalFile {
  schemaVersion: 1;
  records: ApprovalRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function approvalKey(tenant: TenantRef, approvalId: string): string {
  return `${tenant.tenantId}:${tenant.workspaceId}:${approvalId}`;
}

function loadApprovalFile(path: string): ApprovalRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  if (!isRecord(parsed) || parsed['schemaVersion'] !== 1 || !Array.isArray(parsed['records'])) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Local approval store is invalid');
  }
  return parsed['records'].map((entry) => {
    if (!isRecord(entry) || !isRecord(entry['request']) || !isRecord(entry['action'])) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Local approval record is invalid');
    }
    const validation = validateContract('ApprovalRequest', entry['request']);
    if (!validation.valid || validation.value === undefined) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Local approval request is invalid');
    }
    return {
      request: validation.value as ApprovalRequest,
      action: structuredClone(entry['action']) as unknown as ApprovalRecord['action'],
    };
  });
}

export class LocalFileApprovalStore implements ApprovalStore {
  private readonly path: string;
  private readonly records = new Map<string, ApprovalRecord>();

  constructor(path: string) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    for (const record of loadApprovalFile(this.path)) {
      const key = approvalKey(record.request.tenant, record.request.approvalId);
      if (this.records.has(key)) {
        throw runtimeError(
          'VALIDATION_SCHEMA_MISMATCH',
          'Local approval store has duplicate records',
        );
      }
      this.records.set(key, record);
    }
    this.persist();
  }

  create(record: ApprovalRecord): void {
    const key = approvalKey(record.request.tenant, record.request.approvalId);
    if (this.records.has(key)) {
      throw runtimeError('CONCURRENCY_STALE_VERSION', 'Approval already exists');
    }
    this.records.set(key, structuredClone(record));
    try {
      this.persist();
    } catch (error) {
      this.records.delete(key);
      throw error;
    }
  }

  get(tenant: TenantRef, approvalId: string): ApprovalRecord | undefined {
    const record = this.records.get(approvalKey(tenant, approvalId));
    return record === undefined ? undefined : structuredClone(record);
  }

  list(tenant: TenantRef): ApprovalRecord[] {
    const prefix = `${tenant.tenantId}:${tenant.workspaceId}:`;
    return structuredClone(
      [...this.records.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, record]) => record),
    );
  }

  update(record: ApprovalRecord): void {
    const key = approvalKey(record.request.tenant, record.request.approvalId);
    const previous = this.records.get(key);
    if (previous === undefined) {
      throw runtimeError('APPROVAL_INVALIDATED', 'Approval no longer exists');
    }
    this.records.set(key, structuredClone(record));
    try {
      this.persist();
    } catch (error) {
      this.records.set(key, previous);
      throw error;
    }
  }

  private persist(): void {
    const temporaryPath = `${this.path}.tmp`;
    const value: ApprovalFile = {
      schemaVersion: 1,
      records: [...this.records.values()],
    };
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, this.path);
    chmodSync(this.path, 0o600);
  }
}
