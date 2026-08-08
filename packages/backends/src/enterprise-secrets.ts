import { createHash } from 'node:crypto';
import {
  newSortableId,
  runtimeError,
  type Id,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import type { SecretHandle } from './secret-broker.js';

export interface EnterpriseSecretAuditRecord {
  readonly auditId: Id;
  readonly tenant: TenantRef;
  readonly secretName: string;
  readonly operation: string;
  readonly action: 'stored' | 'issued' | 'resolved' | 'rotated' | 'revoked' | 'denied' | 'redacted';
  readonly version: number;
  readonly at: string;
}

export interface EnterpriseSecretManagerClient {
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
  rotate(input: {
    readonly handleId: Id;
    readonly tenant: TenantRef;
    readonly operation: string;
    readonly ttlMs: number;
  }): Promise<SecretHandle>;
  revoke(handleId: Id): Promise<void>;
  redact(value: string): Promise<string>;
}

interface SecretVersion {
  readonly tenant: TenantRef;
  readonly secretName: string;
  readonly version: number;
  value: string;
  active: boolean;
}

interface StoredHandle extends SecretHandle {
  readonly version: number;
  revoked: boolean;
}

function tenantKey(tenant: TenantRef): string {
  return `${tenant.tenantId}:${tenant.workspaceId}`;
}

function sameTenant(left: TenantRef, right: TenantRef): boolean {
  return left.tenantId === right.tenantId && left.workspaceId === right.workspaceId;
}

function secretKey(tenant: TenantRef, secretName: string): string {
  return `${tenantKey(tenant)}:${secretName}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertText(value: string, label: string): string {
  if (value.trim().length === 0 || value.length > 320)
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} is required`);
  return value.trim();
}

export class InMemoryEnterpriseSecretManager implements EnterpriseSecretManagerClient {
  private readonly versions = new Map<string, SecretVersion>();
  private readonly handles = new Map<Id, StoredHandle>();
  private readonly audits: EnterpriseSecretAuditRecord[] = [];
  private readonly clock: () => string;

  constructor(clock: () => string = () => new Date().toISOString()) {
    this.clock = clock;
  }

  putSecret(input: {
    readonly tenant: TenantRef;
    readonly secretName: string;
    readonly value: string;
    readonly now?: string;
  }): void {
    const secretName = assertText(input.secretName, 'Secret name');
    if (input.value.length === 0)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Secret value is required');
    const key = secretKey(input.tenant, secretName);
    const current = [...this.versions.values()]
      .filter(
        (version) =>
          version.tenant.tenantId === input.tenant.tenantId &&
          version.tenant.workspaceId === input.tenant.workspaceId &&
          version.secretName === secretName,
      )
      .sort((left, right) => right.version - left.version)[0];
    const version: SecretVersion = {
      tenant: clone(input.tenant),
      secretName,
      version: (current?.version ?? 0) + 1,
      value: input.value,
      active: true,
    };
    if (current !== undefined) current.active = false;
    this.versions.set(`${key}:${version.version}`, version);
    this.record(input.tenant, secretName, 'stored', version.version, input.now);
  }

  async issue(input: {
    readonly tenant: TenantRef;
    readonly secretName: string;
    readonly operation: string;
    readonly ttlMs: number;
  }): Promise<SecretHandle> {
    const secretName = assertText(input.secretName, 'Secret name');
    const operation = assertText(input.operation, 'Secret operation');
    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Secret TTL must be positive');
    const version = this.current(input.tenant, secretName);
    const now = Date.parse(this.clock());
    const handle: StoredHandle = {
      handleId: newSortableId(),
      tenant: clone(input.tenant),
      secretName,
      operation,
      expiresAt: new Date(now + input.ttlMs).toISOString(),
      scopeDigest: createHash('sha256')
        .update(`${tenantKey(input.tenant)}:${secretName}:${operation}:${version.version}`)
        .digest('hex'),
      version: version.version,
      revoked: false,
    };
    this.handles.set(handle.handleId, handle);
    this.record(input.tenant, secretName, 'issued', version.version);
    return publicHandle(handle);
  }

  async resolve(input: {
    readonly handleId: Id;
    readonly tenant: TenantRef;
    readonly operation: string;
  }): Promise<string> {
    const handle = this.handles.get(input.handleId);
    if (
      handle === undefined ||
      handle.revoked ||
      !sameTenant(handle.tenant, input.tenant) ||
      handle.operation !== input.operation ||
      Date.parse(handle.expiresAt) <= Date.parse(this.clock())
    ) {
      if (handle !== undefined)
        this.record(input.tenant, handle.secretName, 'denied', handle.version);
      throw runtimeError(
        'SECRET_EXPOSURE_BLOCKED',
        'Secret handle is invalid, expired, or out of scope',
      );
    }
    const version = this.versions.get(
      `${secretKey(handle.tenant, handle.secretName)}:${handle.version}`,
    );
    if (version === undefined || !version.active) {
      this.record(input.tenant, handle.secretName, 'denied', handle.version);
      throw runtimeError('SECRET_EXPOSURE_BLOCKED', 'Secret handle was invalidated by rotation');
    }
    this.record(input.tenant, handle.secretName, 'resolved', handle.version);
    return version.value;
  }

  async rotate(input: {
    readonly handleId: Id;
    readonly tenant: TenantRef;
    readonly operation: string;
    readonly ttlMs: number;
  }): Promise<SecretHandle> {
    const current = this.handles.get(input.handleId);
    if (
      current === undefined ||
      !sameTenant(current.tenant, input.tenant) ||
      current.operation !== input.operation
    ) {
      throw runtimeError(
        'SECRET_EXPOSURE_BLOCKED',
        'Secret handle cannot be rotated outside its scope',
      );
    }
    const oldVersion = this.versions.get(
      `${secretKey(current.tenant, current.secretName)}:${current.version}`,
    );
    if (oldVersion === undefined)
      throw runtimeError('ARTIFACT_NOT_FOUND', 'Secret version was not found');
    this.putSecret({
      tenant: input.tenant,
      secretName: current.secretName,
      value: oldVersion.value,
    });
    const next = await this.issue({
      tenant: input.tenant,
      secretName: current.secretName,
      operation: input.operation,
      ttlMs: input.ttlMs,
    });
    this.record(input.tenant, current.secretName, 'rotated', current.version + 1);
    return next;
  }

  async revoke(handleId: Id): Promise<void> {
    const handle = this.handles.get(handleId);
    if (handle === undefined) return;
    handle.revoked = true;
    this.record(handle.tenant, handle.secretName, 'revoked', handle.version);
  }

  async redact(value: string): Promise<string> {
    let result = value;
    for (const version of this.versions.values())
      result = result.split(version.value).join('[REDACTED]');
    return result;
  }

  auditRecords(tenant?: TenantRef): readonly EnterpriseSecretAuditRecord[] {
    return clone(
      tenant === undefined
        ? this.audits
        : this.audits.filter((record) => sameTenant(record.tenant, tenant)),
    );
  }

  private current(tenant: TenantRef, secretName: string): SecretVersion {
    const version = [...this.versions.values()]
      .filter(
        (candidate) =>
          sameTenant(candidate.tenant, tenant) &&
          candidate.secretName === secretName &&
          candidate.active,
      )
      .sort((left, right) => right.version - left.version)[0];
    if (version === undefined)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Secret ${secretName} is not configured`);
    return version;
  }

  private record(
    tenant: TenantRef,
    secretName: string,
    action: EnterpriseSecretAuditRecord['action'],
    version: number,
    at = this.clock(),
  ): void {
    this.audits.push({
      auditId: newSortableId(),
      tenant: clone(tenant),
      secretName,
      operation: 'brokered',
      action,
      version,
      at,
    });
  }
}

export class HostedEnterpriseSecretManager implements EnterpriseSecretManagerClient {
  constructor(private readonly client: EnterpriseSecretManagerClient) {}

  async issue(input: {
    readonly tenant: TenantRef;
    readonly secretName: string;
    readonly operation: string;
    readonly ttlMs: number;
  }): Promise<SecretHandle> {
    const handle = await this.client.issue({ ...input });
    assertHandle(handle, input.tenant, input.secretName, input.operation);
    return clone(handle);
  }

  async resolve(input: {
    readonly handleId: Id;
    readonly tenant: TenantRef;
    readonly operation: string;
  }): Promise<string> {
    return this.client.resolve({ ...input });
  }

  async rotate(input: {
    readonly handleId: Id;
    readonly tenant: TenantRef;
    readonly operation: string;
    readonly ttlMs: number;
  }): Promise<SecretHandle> {
    const handle = await this.client.rotate({ ...input });
    assertHandle(handle, input.tenant, handle.secretName, input.operation);
    return clone(handle);
  }

  revoke(handleId: Id): Promise<void> {
    return this.client.revoke(handleId);
  }

  redact(value: string): Promise<string> {
    return this.client.redact(value);
  }
}

function publicHandle(handle: StoredHandle): SecretHandle {
  const { version, revoked, ...publicValue } = handle;
  void version;
  void revoked;
  return publicValue;
}

function assertHandle(
  handle: SecretHandle,
  tenant: TenantRef,
  secretName: string,
  operation: string,
): void {
  if (
    !sameTenant(handle.tenant, tenant) ||
    handle.secretName !== secretName ||
    handle.operation !== operation ||
    handle.scopeDigest.length === 0 ||
    Date.parse(handle.expiresAt) <= Date.now()
  ) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Secret manager returned an invalid handle');
  }
}
