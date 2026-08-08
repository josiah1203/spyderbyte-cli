import { createHash } from 'node:crypto';
import {
  newSortableId,
  runtimeError,
  type Id,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';

export interface SecretHandle {
  readonly handleId: Id;
  readonly tenant: TenantRef;
  readonly secretName: string;
  readonly operation: string;
  readonly expiresAt: string;
  readonly scopeDigest: string;
}

export interface SecretAuditRecord {
  readonly handleId: Id;
  readonly tenant: TenantRef;
  readonly operation: string;
  readonly at: string;
  readonly outcome: 'issued' | 'resolved' | 'revoked' | 'expired' | 'redacted' | 'denied';
}

export interface HostedSecretManagerClient {
  issue(input: {
    readonly tenant: TenantRef;
    readonly secretName: string;
    readonly operation: string;
    readonly ttlMs: number;
  }): Promise<SecretHandle>;
  resolve(input: {
    readonly handleId: Id;
    readonly tenant: TenantRef;
    readonly operation: string;
  }): Promise<string>;
  revoke(handleId: Id): Promise<void>;
  redact(value: string): Promise<string>;
}

interface StoredSecret extends SecretHandle {
  readonly value: string;
  revoked: boolean;
}

export class InMemorySecretBroker {
  private readonly secrets = new Map<Id, StoredSecret>();
  private readonly audit: SecretAuditRecord[] = [];
  private readonly clock: () => string;

  constructor(clock: () => string = () => new Date().toISOString()) {
    this.clock = clock;
  }

  issue(input: {
    tenant: TenantRef;
    secretName: string;
    value: string;
    operation: string;
    ttlMs: number;
  }): SecretHandle {
    if (input.value.length === 0 || input.ttlMs < 1) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Secret values and TTL are required');
    }
    const now = Date.parse(this.clock());
    const handle: SecretHandle = {
      handleId: newSortableId(),
      tenant: input.tenant,
      secretName: input.secretName,
      operation: input.operation,
      expiresAt: new Date(now + input.ttlMs).toISOString(),
      scopeDigest: createHash('sha256')
        .update(`${input.secretName}:${input.operation}`)
        .digest('hex'),
    };
    this.secrets.set(handle.handleId, { ...handle, value: input.value, revoked: false });
    this.audit.push({ ...handle, at: this.clock(), outcome: 'issued' });
    return handle;
  }

  resolve(handle: SecretHandle, tenant: TenantRef, operation: string): string {
    const record = this.secrets.get(handle.handleId);
    if (
      record === undefined ||
      record.revoked ||
      record.tenant.tenantId !== tenant.tenantId ||
      record.tenant.workspaceId !== tenant.workspaceId ||
      record.operation !== operation ||
      Date.parse(record.expiresAt) <= Date.parse(this.clock())
    ) {
      this.audit.push({
        ...handle,
        at: this.clock(),
        outcome: record?.revoked ? 'revoked' : 'expired',
      });
      throw runtimeError(
        'SECRET_EXPOSURE_BLOCKED',
        'Secret handle is invalid, expired, or out of scope',
      );
    }
    this.audit.push({ ...handle, at: this.clock(), outcome: 'resolved' });
    return record.value;
  }

  revoke(handleId: Id): void {
    const record = this.secrets.get(handleId);
    if (record === undefined) return;
    record.revoked = true;
    this.audit.push({ ...publicHandle(record), at: this.clock(), outcome: 'revoked' });
  }

  redact(value: string): string {
    let output = value;
    for (const record of this.secrets.values())
      output = output.split(record.value).join('[REDACTED]');
    return output;
  }

  auditRecords(): SecretAuditRecord[] {
    return structuredClone(this.audit);
  }
}

export class HostedSecretBroker {
  private readonly client: HostedSecretManagerClient;
  private readonly audit: SecretAuditRecord[] = [];
  private readonly clock: () => string;

  constructor(options: { client: HostedSecretManagerClient; clock?: () => string }) {
    this.client = options.client;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async issue(input: {
    tenant: TenantRef;
    secretName: string;
    operation: string;
    ttlMs: number;
  }): Promise<SecretHandle> {
    if (input.secretName.trim().length === 0 || input.operation.trim().length === 0) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Secret name and operation are required');
    }
    if (input.ttlMs < 1)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Secret TTL must be positive');
    const handle = await this.client.issue(input);
    const expiresAt = Date.parse(handle.expiresAt);
    const now = Date.parse(this.clock());
    if (
      handle.tenant.tenantId !== input.tenant.tenantId ||
      handle.tenant.workspaceId !== input.tenant.workspaceId ||
      handle.secretName !== input.secretName ||
      handle.operation !== input.operation ||
      handle.handleId.length === 0 ||
      handle.scopeDigest.length === 0 ||
      !Number.isFinite(expiresAt) ||
      !Number.isFinite(now) ||
      expiresAt <= now
    ) {
      throw runtimeError(
        'VALIDATION_SCHEMA_MISMATCH',
        'Secret manager returned an out-of-scope handle',
      );
    }
    this.audit.push({ ...handle, at: this.clock(), outcome: 'issued' });
    return structuredClone(handle);
  }

  async resolve(handle: SecretHandle, tenant: TenantRef, operation: string): Promise<string> {
    try {
      assertSecretHandleScope(handle, tenant, operation, this.clock());
      const value = await this.client.resolve({
        handleId: handle.handleId,
        tenant,
        operation,
      });
      this.audit.push({ ...handle, at: this.clock(), outcome: 'resolved' });
      return value;
    } catch (error) {
      this.audit.push({ ...handle, at: this.clock(), outcome: 'denied' });
      throw error;
    }
  }

  async revoke(handleId: Id): Promise<void> {
    await this.client.revoke(handleId);
    const existing = this.audit.find((record) => record.handleId === handleId);
    if (existing !== undefined)
      this.audit.push({ ...existing, at: this.clock(), outcome: 'revoked' });
  }

  async redact(value: string): Promise<string> {
    const redacted = await this.client.redact(value);
    return redacted;
  }

  auditRecords(): SecretAuditRecord[] {
    return structuredClone(this.audit);
  }
}

function publicHandle(record: SecretHandle): SecretHandle {
  return {
    handleId: record.handleId,
    tenant: record.tenant,
    secretName: record.secretName,
    operation: record.operation,
    expiresAt: record.expiresAt,
    scopeDigest: record.scopeDigest,
  };
}

function assertSecretHandleScope(
  handle: SecretHandle,
  tenant: TenantRef,
  operation: string,
  nowIso: string,
): void {
  const expiresAt = Date.parse(handle.expiresAt);
  const now = Date.parse(nowIso);
  if (
    handle.tenant.tenantId !== tenant.tenantId ||
    handle.tenant.workspaceId !== tenant.workspaceId ||
    handle.operation !== operation ||
    handle.handleId.length === 0 ||
    handle.scopeDigest.length === 0 ||
    !Number.isFinite(expiresAt) ||
    !Number.isFinite(now) ||
    expiresAt <= now
  ) {
    throw runtimeError(
      'SECRET_EXPOSURE_BLOCKED',
      'Secret handle is invalid, expired, or out of scope',
    );
  }
}
