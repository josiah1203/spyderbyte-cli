import { createHash } from 'node:crypto';
import {
  newSortableId,
  runtimeError,
  type HashSha256,
  type Id,
  type JsonValue,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';

export type BackupState = 'created' | 'verified' | 'corrupt' | 'restored';
export type RetentionDecision = 'retain' | 'eligible' | 'blocked_legal_hold';

export interface RetentionPolicyV1 {
  readonly policyId: Id;
  readonly tenant: TenantRef;
  readonly version: string;
  readonly retentionDays: number;
  readonly legalHold: boolean;
  readonly createdAt: string;
}

export interface BackupManifestV1 {
  readonly backupId: Id;
  readonly tenant: TenantRef;
  readonly schemaVersion: string;
  readonly eventCursor: number;
  readonly artifactDigests: readonly HashSha256[];
  readonly contentDigest: HashSha256;
  readonly encryptionKeyId: string;
  readonly createdAt: string;
  readonly retentionUntil: string;
}

export interface BackupRecordV1 {
  readonly manifest: BackupManifestV1;
  readonly state: BackupState;
  readonly snapshot: JsonValue;
  readonly verifiedAt?: string;
  readonly restoredAt?: string;
}

export interface RestorePreviewV1 {
  readonly backupId: Id;
  readonly tenant: TenantRef;
  readonly targetTenant: TenantRef;
  readonly safe: boolean;
  readonly reason: string;
  readonly contentDigest: HashSha256;
  readonly wouldOverwrite: boolean;
}

export interface RestoreEvidenceV1 {
  readonly restoreId: Id;
  readonly backupId: Id;
  readonly tenant: TenantRef;
  readonly targetTenant: TenantRef;
  readonly restored: boolean;
  readonly idempotent: boolean;
  readonly contentDigest: HashSha256;
  readonly evidenceDigest: HashSha256;
  readonly restoredAt: string;
}

export interface DisasterRecoveryExerciseV1 {
  readonly exerciseId: Id;
  readonly tenant: TenantRef;
  readonly backupId: Id;
  readonly verified: boolean;
  readonly preview: RestorePreviewV1;
  readonly evidence: RestoreEvidenceV1;
}

export interface RecoveryAuditRecord {
  readonly auditId: Id;
  readonly tenant: TenantRef;
  readonly action:
    | 'backup.created'
    | 'backup.verified'
    | 'backup.corrupt'
    | 'restore.previewed'
    | 'restore.completed'
    | 'retention.evaluated';
  readonly targetId: Id;
  readonly outcome: 'completed' | 'denied' | 'failed';
  readonly at: string;
  readonly details: Readonly<Record<string, string | number | boolean>>;
}

export interface DisasterRecoveryServiceOptions {
  readonly clock?: () => string;
}

function tenantKey(tenant: TenantRef): string {
  return `${tenant.tenantId}:${tenant.workspaceId}`;
}

function sameTenant(left: TenantRef, right: TenantRef): boolean {
  return left.tenantId === right.tenantId && left.workspaceId === right.workspaceId;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function digest(value: JsonValue): HashSha256 {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex') as HashSha256;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} must be a positive integer`);
  }
}

function assertNoSecretFields(value: JsonValue, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretFields(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/(secret|token|password|api[_-]?key|private[_-]?key)/i.test(key)) {
      throw runtimeError(
        'SECRET_EXPOSURE_BLOCKED',
        `Backup snapshot contains secret-shaped field ${path}.${key}`,
      );
    }
    assertNoSecretFields(child, `${path}.${key}`);
  }
}

export class InMemoryDisasterRecoveryService {
  private readonly records = new Map<string, BackupRecordV1>();
  private readonly restores = new Map<string, RestoreEvidenceV1>();
  private readonly audits: RecoveryAuditRecord[] = [];
  private readonly clock: () => string;

  constructor(options: DisasterRecoveryServiceOptions = {}) {
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  createBackup(input: {
    readonly tenant: TenantRef;
    readonly snapshot: JsonValue;
    readonly schemaVersion: string;
    readonly eventCursor: number;
    readonly artifactDigests?: readonly HashSha256[];
    readonly encryptionKeyId: string;
    readonly retentionUntil: string;
    readonly now?: string;
  }): BackupRecordV1 {
    assertNoSecretFields(input.snapshot);
    assertPositiveInteger(input.eventCursor + 1, 'Backup event cursor');
    if (input.encryptionKeyId.trim().length === 0)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Backup encryption key ID is required');
    const now = input.now ?? this.clock();
    const contentDigest = digest(input.snapshot);
    const manifest: BackupManifestV1 = {
      backupId: newSortableId(),
      tenant: clone(input.tenant),
      schemaVersion: input.schemaVersion,
      eventCursor: input.eventCursor,
      artifactDigests: [...(input.artifactDigests ?? [])],
      contentDigest,
      encryptionKeyId: input.encryptionKeyId,
      createdAt: now,
      retentionUntil: input.retentionUntil,
    };
    const record: BackupRecordV1 = { manifest, state: 'created', snapshot: clone(input.snapshot) };
    this.records.set(`${tenantKey(input.tenant)}:${manifest.backupId}`, record);
    this.record(input.tenant, 'backup.created', manifest.backupId, 'completed', {
      eventCursor: input.eventCursor,
    });
    return clone(record);
  }

  verify(tenant: TenantRef, backupId: Id, now = this.clock()): BackupRecordV1 {
    const current = this.require(tenant, backupId);
    const valid = digest(current.snapshot) === current.manifest.contentDigest;
    const next: BackupRecordV1 = {
      ...current,
      state: valid ? 'verified' : 'corrupt',
      ...(valid ? { verifiedAt: now } : {}),
    };
    this.records.set(`${tenantKey(tenant)}:${backupId}`, next);
    this.record(
      tenant,
      valid ? 'backup.verified' : 'backup.corrupt',
      backupId,
      valid ? 'completed' : 'failed',
      {},
    );
    if (!valid)
      throw runtimeError(
        'VALIDATION_SCHEMA_MISMATCH',
        'Backup content digest does not match its manifest',
      );
    return clone(next);
  }

  previewRestore(input: {
    readonly tenant: TenantRef;
    readonly backupId: Id;
    readonly targetTenant?: TenantRef;
    readonly allowOverwrite?: boolean;
    readonly now?: string;
  }): RestorePreviewV1 {
    const record = this.require(input.tenant, input.backupId);
    const targetTenant = input.targetTenant ?? input.tenant;
    const existing = this.restores.get(`${tenantKey(targetTenant)}:${input.backupId}`);
    const digestMatches = digest(record.snapshot) === record.manifest.contentDigest;
    const wouldOverwrite = existing !== undefined || input.allowOverwrite === true;
    const safe =
      digestMatches &&
      record.state !== 'corrupt' &&
      (existing === undefined || input.allowOverwrite === true);
    const reason =
      !digestMatches || record.state === 'corrupt'
        ? 'Backup integrity verification failed'
        : existing !== undefined && input.allowOverwrite !== true
          ? 'Target already has a restore for this backup'
          : 'Restore is safe to apply';
    const preview: RestorePreviewV1 = {
      backupId: input.backupId,
      tenant: clone(input.tenant),
      targetTenant: clone(targetTenant),
      safe,
      reason,
      contentDigest: record.manifest.contentDigest,
      wouldOverwrite,
    };
    this.record(input.tenant, 'restore.previewed', input.backupId, safe ? 'completed' : 'denied', {
      safe,
      wouldOverwrite,
    });
    return clone(preview);
  }

  restore(input: {
    readonly tenant: TenantRef;
    readonly backupId: Id;
    readonly targetTenant?: TenantRef;
    readonly approvalDigest: string;
    readonly allowOverwrite?: boolean;
    readonly now?: string;
  }): RestoreEvidenceV1 {
    const targetTenant = input.targetTenant ?? input.tenant;
    const record = this.require(input.tenant, input.backupId);
    const digestMatches = digest(record.snapshot) === record.manifest.contentDigest;
    if (!digestMatches || record.state === 'corrupt')
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Backup integrity verification failed');
    if (input.approvalDigest !== record.manifest.contentDigest)
      throw runtimeError(
        'APPROVAL_INVALIDATED',
        'Restore approval is not bound to the backup digest',
      );
    const restoreKey = `${tenantKey(targetTenant)}:${input.backupId}`;
    const existing = this.restores.get(restoreKey);
    if (existing !== undefined && input.allowOverwrite !== true)
      return clone({ ...existing, idempotent: true });
    const preview = this.previewRestore({ ...input, targetTenant });
    if (!preview.safe) throw runtimeError('VALIDATION_SCHEMA_MISMATCH', preview.reason);
    const now = input.now ?? this.clock();
    const restoreId = existing?.restoreId ?? newSortableId();
    const evidenceDigest = digest({
      restoreId,
      backupId: input.backupId,
      sourceTenantId: input.tenant.tenantId,
      sourceWorkspaceId: input.tenant.workspaceId,
      targetTenantId: targetTenant.tenantId,
      targetWorkspaceId: targetTenant.workspaceId,
      contentDigest: record.manifest.contentDigest,
      restoredAt: now,
    });
    const evidence: RestoreEvidenceV1 = {
      restoreId,
      backupId: input.backupId,
      tenant: clone(input.tenant),
      targetTenant: clone(targetTenant),
      restored: true,
      idempotent: existing !== undefined,
      contentDigest: record.manifest.contentDigest,
      evidenceDigest,
      restoredAt: now,
    };
    this.restores.set(restoreKey, evidence);
    this.records.set(`${tenantKey(input.tenant)}:${input.backupId}`, {
      ...record,
      state: 'restored',
      restoredAt: now,
    });
    this.record(input.tenant, 'restore.completed', input.backupId, 'completed', {
      targetTenant: targetTenant.workspaceId,
      idempotent: evidence.idempotent,
    });
    return clone(evidence);
  }

  runExercise(input: {
    readonly tenant: TenantRef;
    readonly backupId: Id;
    readonly now?: string;
  }): DisasterRecoveryExerciseV1 {
    const verified = this.verify(input.tenant, input.backupId, input.now);
    const preview = this.previewRestore({
      tenant: input.tenant,
      backupId: input.backupId,
      targetTenant: { ...input.tenant, workspaceId: newSortableId() },
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    const evidence = this.restore({
      tenant: input.tenant,
      backupId: input.backupId,
      targetTenant: preview.targetTenant,
      approvalDigest: verified.manifest.contentDigest,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    return {
      exerciseId: newSortableId(),
      tenant: clone(input.tenant),
      backupId: input.backupId,
      verified: true,
      preview,
      evidence,
    };
  }

  evaluateRetention(
    policy: RetentionPolicyV1,
    backup: BackupRecordV1,
    now = this.clock(),
  ): RetentionDecision {
    if (!sameTenant(policy.tenant, backup.manifest.tenant))
      throw runtimeError('POLICY_DENIED', 'Retention policy crosses tenant boundary');
    const decision: RetentionDecision = policy.legalHold
      ? 'blocked_legal_hold'
      : Date.parse(backup.manifest.retentionUntil) <= Date.parse(now)
        ? 'eligible'
        : 'retain';
    this.record(policy.tenant, 'retention.evaluated', backup.manifest.backupId, 'completed', {
      decision,
    });
    return decision;
  }

  get(tenant: TenantRef, backupId: Id): BackupRecordV1 | undefined {
    const record = this.records.get(`${tenantKey(tenant)}:${backupId}`);
    return record === undefined ? undefined : clone(record);
  }

  list(tenant: TenantRef): readonly BackupRecordV1[] {
    return clone(
      [...this.records.values()].filter((record) => sameTenant(record.manifest.tenant, tenant)),
    );
  }

  auditRecords(tenant?: TenantRef): readonly RecoveryAuditRecord[] {
    return clone(
      tenant === undefined
        ? this.audits
        : this.audits.filter((record) => sameTenant(record.tenant, tenant)),
    );
  }

  private require(tenant: TenantRef, backupId: Id): BackupRecordV1 {
    const record = this.records.get(`${tenantKey(tenant)}:${backupId}`);
    if (record === undefined)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Backup ${backupId} was not found`);
    return record;
  }

  private record(
    tenant: TenantRef,
    action: RecoveryAuditRecord['action'],
    targetId: Id,
    outcome: RecoveryAuditRecord['outcome'],
    details: Readonly<Record<string, string | number | boolean>>,
  ): void {
    this.audits.push({
      auditId: newSortableId(),
      tenant: clone(tenant),
      action,
      targetId,
      outcome,
      at: this.clock(),
      details: { ...details },
    });
  }
}

/** The public port a durable hosted recovery service must implement. */
export type DisasterRecoveryService = Pick<
  InMemoryDisasterRecoveryService,
  'createBackup' | 'verify' | 'previewRestore' | 'restore' | 'runExercise' | 'get' | 'list'
> &
  Partial<Pick<InMemoryDisasterRecoveryService, 'evaluateRetention' | 'auditRecords'>>;
