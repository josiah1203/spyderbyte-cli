import {
  isContract,
  newSortableId,
  parseContract,
  runtimeError,
  type AgentInvocation,
  type AgentRegistration,
  type ApprovalRequest,
  type Artifact,
  type ArtifactReference,
  type BudgetReservation,
  type ContractName,
  type HashSha256,
  type Id,
  type JsonValue,
  type Project,
  type RuntimeEvent,
  type TenantRef,
  type Workflow,
} from '@agentic-platform/runtime-contracts';
import type {
  AggregateRepository,
  ArtifactVersionRepository,
  CommandDeduplicationRepository,
  CommandDeduplicationRecord,
  EventStore,
  InvocationRepository,
  OutboxRecord,
  OutboxRepository,
  PersistedArtifactVersion,
  ProjectionCheckpointRepository,
  SideEffectReceipt,
  SideEffectReceiptRepository,
  StateStore,
  StateTransaction,
  StoredEvent,
  VersionedAggregate,
} from './ports.js';

type SqliteValue = null | number | string | Uint8Array;

interface SqliteStatement {
  all(...parameters: SqliteValue[]): unknown[];
  get(...parameters: SqliteValue[]): unknown;
  run(...parameters: SqliteValue[]): { changes: number | bigint };
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

interface Row {
  [key: string]: unknown;
}

interface AggregateConfig<T> {
  table: string;
  idColumn: string;
  jsonColumn: string;
  contract: ContractName;
  extraColumns(value: T): { columns: string[]; values: SqliteValue[] };
}

const workflowConfig: AggregateConfig<Workflow> = {
  table: 'workflows',
  idColumn: 'workflow_id',
  jsonColumn: 'workflow_json',
  contract: 'Workflow',
  extraColumns: () => ({ columns: [], values: [] }),
};
const projectConfig: AggregateConfig<Project> = {
  table: 'projects',
  idColumn: 'project_id',
  jsonColumn: 'project_json',
  contract: 'Project',
  extraColumns: () => ({ columns: [], values: [] }),
};
const invocationConfig: AggregateConfig<AgentInvocation> = {
  table: 'invocations',
  idColumn: 'invocation_id',
  jsonColumn: 'invocation_json',
  contract: 'AgentInvocation',
  extraColumns: () => ({ columns: [], values: [] }),
};
const artifactConfig: AggregateConfig<Artifact> = {
  table: 'artifacts',
  idColumn: 'artifact_id',
  jsonColumn: 'artifact_json',
  contract: 'Artifact',
  extraColumns: (value) => ({
    columns: ['current_version', 'logical_state'],
    values: [value.reference.version, value.state],
  }),
};
const approvalConfig: AggregateConfig<ApprovalRequest> = {
  table: 'approvals',
  idColumn: 'approval_id',
  jsonColumn: 'approval_json',
  contract: 'ApprovalRequest',
  extraColumns: (value) => ({ columns: ['action_digest'], values: [value.actionDigest] }),
};
const budgetConfig: AggregateConfig<BudgetReservation> = {
  table: 'budget_reservations',
  idColumn: 'reservation_id',
  jsonColumn: 'reservation_json',
  contract: 'BudgetReservation',
  extraColumns: (value) => ({
    columns: ['budget_id', 'created_at'],
    values: [value.budgetId, value.createdAt],
  }),
};
const agentConfig: AggregateConfig<AgentRegistration> = {
  table: 'agent_registrations',
  idColumn: 'agent_id',
  jsonColumn: 'registration_json',
  contract: 'AgentRegistration',
  extraColumns: () => ({ columns: [], values: [] }),
};

function tenantValues(tenant: TenantRef): [string, string] {
  return [tenant.tenantId, tenant.workspaceId];
}

function jsonText(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Value is not JSON serializable');
  }
  return serialized;
}

function parseJson<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

function rowNumber(row: Row, key: string): number {
  return Number(row[key]);
}

function rowString(row: Row, key: string): string {
  return String(row[key]);
}

function optionalRowString(row: Row, key: string): string | undefined {
  const value = row[key];
  return value === null || value === undefined ? undefined : String(value);
}

function changes(result: { changes: number | bigint }): number {
  return Number(result.changes);
}

function isConstraintViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = 'code' in error ? String((error as { code?: unknown }).code) : '';
  const message = error instanceof Error ? error.message : String(error);
  return code.startsWith('SQLITE_CONSTRAINT') || /constraint|unique|primary key/i.test(message);
}

function assertOutboxClaimInput(
  consumerId: string,
  claimExpiresAt: string,
  now: string,
  limit: number,
): void {
  if (consumerId.trim().length === 0) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Outbox consumer ID is required');
  }
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Outbox claim limit must be a positive integer');
  }
  const nowMs = Date.parse(now);
  const expiresMs = Date.parse(claimExpiresAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(expiresMs) || expiresMs <= nowMs) {
    throw runtimeError(
      'VALIDATION_INVALID_INPUT',
      'Outbox claim expiry must be a valid instant after the current time',
    );
  }
}

function outboxOwnershipError(outboxId: Id, consumerId: string): never {
  throw runtimeError(
    'CONCURRENCY_STALE_VERSION',
    `Outbox record ${outboxId} is no longer actively claimed by ${consumerId}`,
  );
}

export function ensureSqliteOutboxClaimColumns(database: SqliteDatabase): void {
  const columns = new Set(
    (database.prepare('PRAGMA table_info(transactional_outbox)').all() as Row[]).map((row) =>
      String(row['name']),
    ),
  );
  if (columns.size === 0) return;
  if (!columns.has('claimed_by')) {
    try {
      database.exec('ALTER TABLE transactional_outbox ADD COLUMN claimed_by TEXT');
    } catch (error) {
      if (!/duplicate column name/i.test(error instanceof Error ? error.message : String(error))) {
        throw error;
      }
    }
  }
  if (!columns.has('claim_expires_at')) {
    try {
      database.exec('ALTER TABLE transactional_outbox ADD COLUMN claim_expires_at TEXT');
    } catch (error) {
      if (!/duplicate column name/i.test(error instanceof Error ? error.message : String(error))) {
        throw error;
      }
    }
  }
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function aggregateRepository<T>(
  database: SqliteDatabase,
  config: AggregateConfig<T>,
): AggregateRepository<T> {
  const select = `
    SELECT ${config.idColumn}, aggregate_version, ${config.jsonColumn}, updated_at
    FROM ${config.table}
    WHERE tenant_id = ? AND workspace_id = ? AND ${config.idColumn} = ?`;
  const toRecord = (tenant: TenantRef, id: Id, row: Row): VersionedAggregate<T> => ({
    tenant,
    id,
    version: rowNumber(row, 'aggregate_version'),
    value: parseContract(config.contract, parseJson(row[config.jsonColumn])) as T,
    updatedAt: rowString(row, 'updated_at'),
  });

  return {
    async get(tenant, id) {
      const row = database.prepare(select).get(...tenantValues(tenant), id) as Row | undefined;
      return row ? toRecord(tenant, id, row) : undefined;
    },
    async create(tenant, id, value, updatedAt) {
      const extra = config.extraColumns(value);
      const columns = [
        'tenant_id',
        'workspace_id',
        config.idColumn,
        'aggregate_version',
        config.jsonColumn,
        'updated_at',
        ...extra.columns,
      ];
      const values: SqliteValue[] = [
        ...tenantValues(tenant),
        id,
        0,
        jsonText(value),
        updatedAt,
        ...extra.values,
      ];
      try {
        database
          .prepare(
            `INSERT INTO ${config.table} (${columns.join(', ')}) VALUES (${placeholders(values.length)})`,
          )
          .run(...values);
      } catch (error) {
        if (isConstraintViolation(error)) {
          throw runtimeError('CONCURRENCY_STALE_VERSION', `${config.table} ${id} already exists`);
        }
        throw error;
      }
      const row = database.prepare(select).get(...tenantValues(tenant), id) as Row;
      return toRecord(tenant, id, row);
    },
    async update(tenant, id, expectedVersion, value, updatedAt) {
      const extra = config.extraColumns(value);
      const assignments = [
        'aggregate_version = ? + 1',
        `${config.jsonColumn} = ?`,
        'updated_at = ?',
        ...extra.columns.map((column) => `${column} = ?`),
      ];
      const values: SqliteValue[] = [
        expectedVersion,
        jsonText(value),
        updatedAt,
        ...extra.values,
        ...tenantValues(tenant),
        id,
        expectedVersion,
      ];
      const result = database
        .prepare(
          `UPDATE ${config.table}
           SET ${assignments.join(', ')}
           WHERE tenant_id = ? AND workspace_id = ? AND ${config.idColumn} = ?
             AND aggregate_version = ?`,
        )
        .run(...values);
      if (changes(result) !== 1) {
        const current = database.prepare(select).get(...tenantValues(tenant), id) as
          | Row
          | undefined;
        throw runtimeError(
          'CONCURRENCY_STALE_VERSION',
          `${config.table} ${id} expected version ${expectedVersion}, actual ${current ? rowNumber(current, 'aggregate_version') : 'missing'}`,
        );
      }
      const row = database.prepare(select).get(...tenantValues(tenant), id) as Row;
      return toRecord(tenant, id, row);
    },
  };
}

function invocationRepository(database: SqliteDatabase): InvocationRepository {
  const base = aggregateRepository(database, invocationConfig);
  return {
    ...base,
    async getForUpdate(tenant, invocationId) {
      // BEGIN IMMEDIATE serializes this transaction before the row is read.
      return base.get(tenant, invocationId);
    },
    async countChildren(tenant, parentInvocationId) {
      const rows = database
        .prepare(
          `SELECT invocation_json
           FROM invocations
           WHERE tenant_id = ? AND workspace_id = ?`,
        )
        .all(...tenantValues(tenant)) as Row[];
      let count = 0;
      for (const row of rows) {
        const invocation = parseContract(
          'AgentInvocation',
          parseJson(row['invocation_json']),
        ) as AgentInvocation;
        if (invocation.parentInvocationId === parentInvocationId) count += 1;
      }
      return count;
    },
  };
}

function eventFromRow(row: Row): StoredEvent {
  return {
    streamSequence: rowNumber(row, 'stream_sequence'),
    event: parseContract('RuntimeEvent', parseJson(row['event_json'])),
  };
}

function eventStore(database: SqliteDatabase): EventStore {
  const select = `SELECT stream_sequence, event_json FROM domain_events`;
  return {
    async append<TPayload extends JsonValue>(
      event: RuntimeEvent<TPayload>,
      expectedVersion: number,
    ) {
      if (!isContract('RuntimeEvent', event)) {
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Event did not satisfy RuntimeEvent.v1');
      }
      const validated = parseContract('RuntimeEvent', event) as RuntimeEvent<TPayload>;
      const aggregate = database
        .prepare(
          `SELECT COALESCE(MAX(aggregate_version), 0) AS aggregate_version
           FROM domain_events
           WHERE tenant_id = ? AND workspace_id = ? AND aggregate_type = ? AND aggregate_id = ?`,
        )
        .get(
          validated.tenant.tenantId,
          validated.tenant.workspaceId,
          validated.aggregateType,
          validated.aggregateId,
        ) as Row;
      const actualVersion = rowNumber(aggregate, 'aggregate_version');
      if (actualVersion !== expectedVersion) {
        throw runtimeError(
          'CONCURRENCY_STALE_VERSION',
          `${validated.aggregateType} ${validated.aggregateId} expected event version ${expectedVersion}, actual ${actualVersion}`,
        );
      }
      const existing = database
        .prepare(
          `${select}
           WHERE tenant_id = ? AND workspace_id = ? AND event_id = ?`,
        )
        .get(validated.tenant.tenantId, validated.tenant.workspaceId, validated.eventId) as
        | Row
        | undefined;
      if (existing) return eventFromRow(existing) as StoredEvent<TPayload>;

      const sequence = database
        .prepare(
          'SELECT COALESCE(MAX(stream_sequence), 0) + 1 AS stream_sequence FROM domain_events',
        )
        .get() as Row;
      const storedEvent: RuntimeEvent<TPayload> = {
        ...validated,
        aggregateVersion: actualVersion + 1,
      };
      const streamSequence = rowNumber(sequence, 'stream_sequence');
      try {
        database
          .prepare(
            `INSERT INTO domain_events
              (stream_sequence, tenant_id, workspace_id, event_id, aggregate_type, aggregate_id,
               aggregate_version, event_name, event_json, occurred_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            streamSequence,
            storedEvent.tenant.tenantId,
            storedEvent.tenant.workspaceId,
            storedEvent.eventId,
            storedEvent.aggregateType,
            storedEvent.aggregateId,
            storedEvent.aggregateVersion,
            storedEvent.eventName,
            jsonText(storedEvent),
            storedEvent.occurredAt,
          );
      } catch (error) {
        if (isConstraintViolation(error)) {
          throw runtimeError(
            'CONCURRENCY_STALE_VERSION',
            `${validated.aggregateType} ${validated.aggregateId} could not append at version ${expectedVersion + 1}`,
          );
        }
        throw error;
      }
      return { streamSequence, event: storedEvent };
    },
    async list(tenant, afterStreamSequence = 0) {
      const rows = database
        .prepare(
          `${select}
           WHERE tenant_id = ? AND workspace_id = ? AND stream_sequence > ?
           ORDER BY stream_sequence`,
        )
        .all(...tenantValues(tenant), afterStreamSequence) as Row[];
      return rows.map(eventFromRow);
    },
    async all() {
      return (database.prepare(`${select} ORDER BY stream_sequence`).all() as Row[]).map(
        eventFromRow,
      );
    },
  };
}

function outboxRepository(database: SqliteDatabase): OutboxRepository {
  const select = `
    SELECT outbox_id, tenant_id, workspace_id, event_id, topic, event_json, available_at,
           published_at, attempts, claimed_by, claim_expires_at
    FROM transactional_outbox`;
  const toRecord = (row: Row): OutboxRecord => {
    const claimedBy = optionalRowString(row, 'claimed_by');
    const claimExpiresAt = optionalRowString(row, 'claim_expires_at');
    return {
      outboxId: rowString(row, 'outbox_id') as OutboxRecord['outboxId'],
      tenant: {
        tenantId: rowString(row, 'tenant_id') as TenantRef['tenantId'],
        workspaceId: rowString(row, 'workspace_id') as TenantRef['workspaceId'],
      },
      eventId: rowString(row, 'event_id') as OutboxRecord['eventId'],
      topic: rowString(row, 'topic'),
      event: parseContract('RuntimeEvent', parseJson(row['event_json'])),
      availableAt: rowString(row, 'available_at'),
      ...(row['published_at'] !== null && row['published_at'] !== undefined
        ? { publishedAt: rowString(row, 'published_at') }
        : {}),
      attempts: rowNumber(row, 'attempts'),
      ...(claimedBy === undefined ? {} : { claimedBy }),
      ...(claimExpiresAt === undefined ? {} : { claimExpiresAt }),
    };
  };
  const find = (tenant: TenantRef, eventId: Id): Row | undefined =>
    database
      .prepare(`${select} WHERE tenant_id = ? AND workspace_id = ? AND event_id = ?`)
      .get(...tenantValues(tenant), eventId) as Row | undefined;

  return {
    async enqueue(event, topic, availableAt) {
      const existing = find(event.tenant, event.eventId);
      if (existing) return toRecord(existing);
      const outboxId = newSortableId();
      try {
        database
          .prepare(
            `INSERT INTO transactional_outbox
              (tenant_id, workspace_id, outbox_id, event_id, topic, event_json, available_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            event.tenant.tenantId,
            event.tenant.workspaceId,
            outboxId,
            event.eventId,
            topic,
            jsonText(event),
            availableAt,
          );
      } catch (error) {
        if (!isConstraintViolation(error)) throw error;
        const duplicate = find(event.tenant, event.eventId);
        if (duplicate) return toRecord(duplicate);
        throw error;
      }
      const row = database
        .prepare(`${select} WHERE tenant_id = ? AND workspace_id = ? AND outbox_id = ?`)
        .get(...tenantValues(event.tenant), outboxId) as Row;
      return toRecord(row);
    },
    async pending(tenant, now) {
      return (
        database
          .prepare(
            `${select}
             WHERE tenant_id = ? AND workspace_id = ? AND published_at IS NULL AND available_at <= ?
             ORDER BY available_at, outbox_id`,
          )
          .all(...tenantValues(tenant), now) as Row[]
      ).map(toRecord);
    },
    async claimPending(tenant, now, consumerId, claimExpiresAt, limit) {
      assertOutboxClaimInput(consumerId, claimExpiresAt, now, limit);
      const candidates = database
        .prepare(
          `${select}
           WHERE tenant_id = ? AND workspace_id = ? AND published_at IS NULL AND available_at <= ?
             AND (claimed_by IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= ? OR claimed_by = ?)
           ORDER BY available_at, outbox_id
           LIMIT ?`,
        )
        .all(...tenantValues(tenant), now, now, consumerId, limit) as Row[];
      const update = database.prepare(
        `UPDATE transactional_outbox
         SET claimed_by = ?, claim_expires_at = ?
         WHERE tenant_id = ? AND workspace_id = ? AND outbox_id = ?
           AND published_at IS NULL AND available_at <= ?
           AND (claimed_by IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= ? OR claimed_by = ?)`,
      );
      const claimed: OutboxRecord[] = [];
      for (const candidate of candidates) {
        const result = update.run(
          consumerId,
          claimExpiresAt,
          ...tenantValues(tenant),
          rowString(candidate, 'outbox_id'),
          now,
          now,
          consumerId,
        );
        if (changes(result) !== 1) continue;
        const row = database
          .prepare(`${select} WHERE tenant_id = ? AND workspace_id = ? AND outbox_id = ?`)
          .get(...tenantValues(tenant), rowString(candidate, 'outbox_id')) as Row | undefined;
        if (row) claimed.push(toRecord(row));
      }
      return claimed;
    },
    async markPublished(tenant, outboxId, publishedAt, consumerId, now) {
      const existing = database
        .prepare(`${select} WHERE tenant_id = ? AND workspace_id = ? AND outbox_id = ?`)
        .get(...tenantValues(tenant), outboxId) as Row | undefined;
      if (!existing) {
        throw runtimeError('VALIDATION_INVALID_INPUT', `Outbox record ${outboxId} not found`);
      }
      if (existing['published_at'] !== null && existing['published_at'] !== undefined) return;
      if (consumerId !== undefined) {
        const claimedBy = optionalRowString(existing, 'claimed_by');
        const expiresAt = optionalRowString(existing, 'claim_expires_at');
        const active =
          claimedBy === consumerId &&
          (now === undefined ||
            (expiresAt !== undefined &&
              Number.isFinite(Date.parse(expiresAt)) &&
              Date.parse(expiresAt) > Date.parse(now)));
        if (!active) outboxOwnershipError(outboxId, consumerId);
      }
      const result = database
        .prepare(
          `UPDATE transactional_outbox SET published_at = ?, claimed_by = NULL, claim_expires_at = NULL
           WHERE tenant_id = ? AND workspace_id = ? AND outbox_id = ?`,
        )
        .run(publishedAt, ...tenantValues(tenant), outboxId);
      if (changes(result) !== 1) {
        throw runtimeError('VALIDATION_INVALID_INPUT', `Outbox record ${outboxId} not found`);
      }
    },
    async incrementAttempt(tenant, outboxId, consumerId, now) {
      if (consumerId !== undefined) {
        const existing = database
          .prepare(`${select} WHERE tenant_id = ? AND workspace_id = ? AND outbox_id = ?`)
          .get(...tenantValues(tenant), outboxId) as Row | undefined;
        if (!existing) {
          throw runtimeError('VALIDATION_INVALID_INPUT', `Outbox record ${outboxId} not found`);
        }
        const claimedBy = optionalRowString(existing, 'claimed_by');
        const expiresAt = optionalRowString(existing, 'claim_expires_at');
        const active =
          claimedBy === consumerId &&
          (now === undefined ||
            (expiresAt !== undefined &&
              Number.isFinite(Date.parse(expiresAt)) &&
              Date.parse(expiresAt) > Date.parse(now)));
        if (!active) outboxOwnershipError(outboxId, consumerId);
      }
      const result = database
        .prepare(
          `UPDATE transactional_outbox SET attempts = attempts + 1
           WHERE tenant_id = ? AND workspace_id = ? AND outbox_id = ?`,
        )
        .run(...tenantValues(tenant), outboxId);
      if (changes(result) !== 1) {
        throw runtimeError('VALIDATION_INVALID_INPUT', `Outbox record ${outboxId} not found`);
      }
    },
  };
}

function commandRepository(database: SqliteDatabase): CommandDeduplicationRepository {
  const select = `
    SELECT tenant_id, workspace_id, idempotency_key, request_digest, command_id, result_json,
           reserved_at, completed_at
    FROM command_deduplication`;
  const toRecord = (row: Row): CommandDeduplicationRecord => ({
    tenant: {
      tenantId: rowString(row, 'tenant_id') as TenantRef['tenantId'],
      workspaceId: rowString(row, 'workspace_id') as TenantRef['workspaceId'],
    },
    idempotencyKey: rowString(row, 'idempotency_key'),
    requestDigest: rowString(row, 'request_digest'),
    commandId: rowString(row, 'command_id') as CommandDeduplicationRecord['commandId'],
    ...(row['result_json'] !== null && row['result_json'] !== undefined
      ? { result: parseJson<JsonValue>(row['result_json']) }
      : {}),
    reservedAt: rowString(row, 'reserved_at'),
    ...(row['completed_at'] !== null && row['completed_at'] !== undefined
      ? { completedAt: rowString(row, 'completed_at') }
      : {}),
  });

  return {
    async reserve(command, requestDigest, reservedAt) {
      const existing = database
        .prepare(`${select} WHERE tenant_id = ? AND workspace_id = ? AND idempotency_key = ?`)
        .get(...tenantValues(command.tenant), command.idempotencyKey) as Row | undefined;
      if (existing) {
        const record = toRecord(existing);
        if (record.requestDigest !== requestDigest) {
          throw runtimeError(
            'VALIDATION_INVALID_INPUT',
            'Idempotency key was reused with a different request digest',
          );
        }
        return record;
      }
      try {
        database
          .prepare(
            `INSERT INTO command_deduplication
              (tenant_id, workspace_id, idempotency_key, request_digest, command_id, reserved_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            ...tenantValues(command.tenant),
            command.idempotencyKey,
            requestDigest,
            command.commandId,
            reservedAt,
          );
      } catch (error) {
        if (!isConstraintViolation(error)) throw error;
        const duplicate = database
          .prepare(`${select} WHERE tenant_id = ? AND workspace_id = ? AND idempotency_key = ?`)
          .get(...tenantValues(command.tenant), command.idempotencyKey) as Row | undefined;
        if (duplicate) {
          const record = toRecord(duplicate);
          if (record.requestDigest !== requestDigest) {
            throw runtimeError(
              'VALIDATION_INVALID_INPUT',
              'Idempotency key was reused with a different request digest',
            );
          }
          return record;
        }
        throw error;
      }
      const row = database
        .prepare(`${select} WHERE tenant_id = ? AND workspace_id = ? AND idempotency_key = ?`)
        .get(...tenantValues(command.tenant), command.idempotencyKey) as Row;
      return toRecord(row);
    },
    async complete(tenant, idempotencyKey, result, completedAt) {
      const updated = database
        .prepare(
          `UPDATE command_deduplication SET result_json = ?, completed_at = ?
           WHERE tenant_id = ? AND workspace_id = ? AND idempotency_key = ?`,
        )
        .run(jsonText(result), completedAt, ...tenantValues(tenant), idempotencyKey);
      if (changes(updated) !== 1) {
        throw runtimeError('VALIDATION_INVALID_INPUT', 'Cannot complete an unreserved command');
      }
    },
    async get(tenant, idempotencyKey) {
      const row = database
        .prepare(`${select} WHERE tenant_id = ? AND workspace_id = ? AND idempotency_key = ?`)
        .get(...tenantValues(tenant), idempotencyKey) as Row | undefined;
      return row ? toRecord(row) : undefined;
    },
  };
}

function checkpointRepository(database: SqliteDatabase): ProjectionCheckpointRepository {
  return {
    async get(tenant, projectionName) {
      const row = database
        .prepare(
          `SELECT tenant_id, workspace_id, projection_name, stream_sequence, updated_at
           FROM projection_checkpoints
           WHERE tenant_id = ? AND workspace_id = ? AND projection_name = ?`,
        )
        .get(...tenantValues(tenant), projectionName) as Row | undefined;
      return row
        ? {
            tenant,
            projectionName,
            streamSequence: rowNumber(row, 'stream_sequence'),
            updatedAt: rowString(row, 'updated_at'),
          }
        : undefined;
    },
    async save(checkpoint) {
      database
        .prepare(
          `INSERT INTO projection_checkpoints
            (tenant_id, workspace_id, projection_name, stream_sequence, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (tenant_id, workspace_id, projection_name)
           DO UPDATE SET stream_sequence = excluded.stream_sequence, updated_at = excluded.updated_at`,
        )
        .run(
          checkpoint.tenant.tenantId,
          checkpoint.tenant.workspaceId,
          checkpoint.projectionName,
          checkpoint.streamSequence,
          checkpoint.updatedAt,
        );
    },
    async clear(tenant, projectionName) {
      database
        .prepare(
          `DELETE FROM projection_checkpoints
           WHERE tenant_id = ? AND workspace_id = ? AND projection_name = ?`,
        )
        .run(...tenantValues(tenant), projectionName);
    },
  };
}

function receiptRepository(database: SqliteDatabase): SideEffectReceiptRepository {
  const select = `
    SELECT tenant_id, workspace_id, receipt_id, effect_key, result_json, recorded_at
    FROM side_effect_receipts`;
  const toRecord = (row: Row): SideEffectReceipt => ({
    tenant: {
      tenantId: rowString(row, 'tenant_id') as TenantRef['tenantId'],
      workspaceId: rowString(row, 'workspace_id') as TenantRef['workspaceId'],
    },
    receiptId: rowString(row, 'receipt_id') as SideEffectReceipt['receiptId'],
    effectKey: rowString(row, 'effect_key'),
    result: parseJson<JsonValue>(row['result_json']),
    recordedAt: rowString(row, 'recorded_at'),
  });
  return {
    async get(tenant, effectKey) {
      const row = database
        .prepare(`${select} WHERE tenant_id = ? AND workspace_id = ? AND effect_key = ?`)
        .get(...tenantValues(tenant), effectKey) as Row | undefined;
      return row ? toRecord(row) : undefined;
    },
    async record(receipt) {
      const existing = database
        .prepare(`${select} WHERE tenant_id = ? AND workspace_id = ? AND effect_key = ?`)
        .get(...tenantValues(receipt.tenant), receipt.effectKey) as Row | undefined;
      if (existing) return toRecord(existing);
      try {
        database
          .prepare(
            `INSERT INTO side_effect_receipts
              (tenant_id, workspace_id, receipt_id, effect_key, result_json, recorded_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            ...tenantValues(receipt.tenant),
            receipt.receiptId,
            receipt.effectKey,
            jsonText(receipt.result),
            receipt.recordedAt,
          );
      } catch (error) {
        if (!isConstraintViolation(error)) throw error;
        const duplicate = database
          .prepare(`${select} WHERE tenant_id = ? AND workspace_id = ? AND effect_key = ?`)
          .get(...tenantValues(receipt.tenant), receipt.effectKey) as Row | undefined;
        if (duplicate) return toRecord(duplicate);
        throw error;
      }
      return receipt;
    },
  };
}

function artifactVersionRepository(database: SqliteDatabase): ArtifactVersionRepository {
  const select = `
    SELECT av.tenant_id, av.workspace_id, av.artifact_id, av.version, av.content_hash,
           av.object_key, av.media_type, av.size_bytes, av.creator_json, av.invocation_id,
           av.schema_name, av.retention_until, av.published_at,
           COALESCE(avs.state, av.state) AS effective_state
    FROM artifact_versions av
    LEFT JOIN artifact_version_states avs
      ON avs.tenant_id = av.tenant_id
     AND avs.workspace_id = av.workspace_id
     AND avs.artifact_id = av.artifact_id
     AND avs.version = av.version`;

  const referenceFromRow = (row: Row): ArtifactReference => ({
    schemaVersion: 1,
    tenant: {
      tenantId: rowString(row, 'tenant_id') as TenantRef['tenantId'],
      workspaceId: rowString(row, 'workspace_id') as TenantRef['workspaceId'],
    },
    artifactId: rowString(row, 'artifact_id') as ArtifactReference['artifactId'],
    version: rowNumber(row, 'version'),
    contentHash: rowString(row, 'content_hash') as HashSha256,
    mediaType: rowString(row, 'media_type'),
    sizeBytes: rowNumber(row, 'size_bytes'),
    createdAt: rowString(row, 'published_at'),
    uri: rowString(row, 'object_key'),
  });

  const lineageFor = (tenant: TenantRef, artifactId: Id, version: number): ArtifactReference[] =>
    (
      database
        .prepare(
          `SELECT parent.tenant_id, parent.workspace_id, parent.artifact_id, parent.version,
                  parent.content_hash, parent.object_key, parent.media_type, parent.size_bytes,
                  parent.published_at
           FROM artifact_lineage_edges edge
           JOIN artifact_versions parent
             ON parent.tenant_id = edge.tenant_id
            AND parent.workspace_id = edge.workspace_id
            AND parent.artifact_id = edge.parent_artifact_id
            AND parent.version = edge.parent_version
           WHERE edge.tenant_id = ? AND edge.workspace_id = ?
             AND edge.child_artifact_id = ? AND edge.child_version = ?
           ORDER BY edge.parent_artifact_id, edge.parent_version`,
        )
        .all(...tenantValues(tenant), artifactId, version) as Row[]
    ).map(referenceFromRow);

  const toRecord = (row: Row): PersistedArtifactVersion => {
    const reference = referenceFromRow(row);
    return {
      reference,
      state: rowString(row, 'effective_state') as PersistedArtifactVersion['state'],
      createdBy: parseContract('Actor', parseJson(row['creator_json'])),
      lineage: lineageFor(reference.tenant, reference.artifactId, reference.version),
      ...(row['invocation_id'] !== null && row['invocation_id'] !== undefined
        ? { invocationId: rowString(row, 'invocation_id') as Id }
        : {}),
      ...(row['schema_name'] !== null && row['schema_name'] !== undefined
        ? { schemaName: rowString(row, 'schema_name') }
        : {}),
      ...(row['retention_until'] !== null && row['retention_until'] !== undefined
        ? { retentionUntil: rowString(row, 'retention_until') }
        : {}),
      publishedAt: rowString(row, 'published_at'),
    };
  };

  return {
    async get(tenant, artifactId, version) {
      const row = database
        .prepare(
          `${select}
           WHERE av.tenant_id = ? AND av.workspace_id = ? AND av.artifact_id = ? AND av.version = ?`,
        )
        .get(...tenantValues(tenant), artifactId, version) as Row | undefined;
      return row ? toRecord(row) : undefined;
    },
    async current(tenant, artifactId) {
      const row = database
        .prepare(
          `SELECT current_version FROM artifacts
           WHERE tenant_id = ? AND workspace_id = ? AND artifact_id = ?`,
        )
        .get(...tenantValues(tenant), artifactId) as Row | undefined;
      if (!row) return undefined;
      const version = rowNumber(row, 'current_version');
      return this.get(tenant, artifactId, version);
    },
    async list(tenant, artifactId) {
      const conditions = ['av.tenant_id = ?', 'av.workspace_id = ?'];
      const values: SqliteValue[] = [...tenantValues(tenant)];
      if (artifactId !== undefined) {
        conditions.push('av.artifact_id = ?');
        values.push(artifactId);
      }
      return (
        database
          .prepare(
            `${select} WHERE ${conditions.join(' AND ')} ORDER BY av.artifact_id, av.version`,
          )
          .all(...values) as Row[]
      ).map(toRecord);
    },
    async publish(record, expectedCurrentVersion) {
      const tenant = record.reference.tenant;
      const currentRow = database
        .prepare(
          `SELECT current_version FROM artifacts
           WHERE tenant_id = ? AND workspace_id = ? AND artifact_id = ?`,
        )
        .get(...tenantValues(tenant), record.reference.artifactId) as Row | undefined;
      const actualVersion = currentRow ? rowNumber(currentRow, 'current_version') : 0;
      if (actualVersion !== expectedCurrentVersion) {
        throw runtimeError(
          'CONCURRENCY_STALE_VERSION',
          `Artifact ${record.reference.artifactId} expected parent ${expectedCurrentVersion}, actual ${actualVersion}`,
        );
      }
      if (record.reference.version !== expectedCurrentVersion + 1) {
        throw runtimeError(
          'CONCURRENCY_STALE_VERSION',
          `Artifact ${record.reference.artifactId} next version must be ${expectedCurrentVersion + 1}`,
        );
      }
      const objectKey = record.reference.uri ?? `sha256/${record.reference.contentHash}`;
      database
        .prepare(
          `INSERT OR IGNORE INTO artifact_content_objects
            (tenant_id, workspace_id, content_hash, object_key, media_type, size_bytes,
             created_at, retention_until)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          tenant.tenantId,
          tenant.workspaceId,
          record.reference.contentHash,
          objectKey,
          record.reference.mediaType,
          record.reference.sizeBytes,
          record.publishedAt,
          record.retentionUntil ?? null,
        );
      try {
        database
          .prepare(
            `INSERT INTO artifact_versions
              (tenant_id, workspace_id, artifact_id, version, content_hash, object_key, media_type,
               size_bytes, creator_json, invocation_id, state, schema_name, retention_until,
               published_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            tenant.tenantId,
            tenant.workspaceId,
            record.reference.artifactId,
            record.reference.version,
            record.reference.contentHash,
            objectKey,
            record.reference.mediaType,
            record.reference.sizeBytes,
            jsonText(record.createdBy),
            record.invocationId ?? null,
            record.state,
            record.schemaName ?? null,
            record.retentionUntil ?? null,
            record.publishedAt,
          );
      } catch (error) {
        if (isConstraintViolation(error)) {
          throw runtimeError(
            'CONCURRENCY_STALE_VERSION',
            `Artifact ${record.reference.artifactId}@${record.reference.version} already exists`,
          );
        }
        throw error;
      }
      database
        .prepare(
          `INSERT INTO artifact_version_states
            (tenant_id, workspace_id, artifact_id, version, state, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          tenant.tenantId,
          tenant.workspaceId,
          record.reference.artifactId,
          record.reference.version,
          record.state,
          record.publishedAt,
        );
      for (const parent of record.lineage) {
        database
          .prepare(
            `INSERT INTO artifact_lineage_edges
              (tenant_id, workspace_id, parent_artifact_id, parent_version,
               child_artifact_id, child_version, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            tenant.tenantId,
            tenant.workspaceId,
            parent.artifactId,
            parent.version,
            record.reference.artifactId,
            record.reference.version,
            record.publishedAt,
          );
      }
      const aggregateArtifact: Artifact = {
        schemaVersion: 1,
        reference: record.reference,
        state: record.state,
        createdBy: record.createdBy,
        lineage: record.lineage,
        content: {},
      };
      const values: SqliteValue[] = [
        tenant.tenantId,
        tenant.workspaceId,
        record.reference.artifactId,
        record.reference.version,
        record.reference.version,
        record.state,
        jsonText(aggregateArtifact),
        record.publishedAt,
      ];
      if (currentRow) {
        const updated = database
          .prepare(
            `UPDATE artifacts
             SET aggregate_version = ?, current_version = ?, logical_state = ?,
                 artifact_json = ?, updated_at = ?
             WHERE tenant_id = ? AND workspace_id = ? AND artifact_id = ? AND current_version = ?`,
          )
          .run(
            record.reference.version,
            record.reference.version,
            record.state,
            jsonText(aggregateArtifact),
            record.publishedAt,
            ...tenantValues(tenant),
            record.reference.artifactId,
            expectedCurrentVersion,
          );
        if (changes(updated) !== 1) {
          throw runtimeError(
            'CONCURRENCY_STALE_VERSION',
            `Artifact ${record.reference.artifactId} expected parent ${expectedCurrentVersion}`,
          );
        }
      } else {
        database
          .prepare(
            `INSERT INTO artifacts
              (tenant_id, workspace_id, artifact_id, aggregate_version, current_version,
               logical_state, artifact_json, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(...values);
      }
    },
    async markStale(tenant, artifactId, version, updatedAt) {
      const status = database
        .prepare(
          `UPDATE artifact_version_states SET state = ?, updated_at = ?
           WHERE tenant_id = ? AND workspace_id = ? AND artifact_id = ? AND version = ?
             AND state <> 'archived'`,
        )
        .run('stale', updatedAt, ...tenantValues(tenant), artifactId, version);
      if (changes(status) !== 1) {
        throw runtimeError(
          'ARTIFACT_NOT_FOUND',
          `Artifact ${artifactId}@${version} is unavailable`,
        );
      }
      const aggregate = database
        .prepare(
          `SELECT artifact_json FROM artifacts
           WHERE tenant_id = ? AND workspace_id = ? AND artifact_id = ? AND current_version = ?`,
        )
        .get(...tenantValues(tenant), artifactId, version) as Row | undefined;
      if (!aggregate) return;
      const artifact = parseContract('Artifact', parseJson(aggregate['artifact_json']));
      artifact.state = 'stale';
      database
        .prepare(
          `UPDATE artifacts SET logical_state = ?, artifact_json = ?, updated_at = ?
           WHERE tenant_id = ? AND workspace_id = ? AND artifact_id = ? AND current_version = ?`,
        )
        .run('stale', jsonText(artifact), updatedAt, ...tenantValues(tenant), artifactId, version);
    },
  };
}

function transaction(database: SqliteDatabase): StateTransaction {
  return {
    workflows: aggregateRepository(database, workflowConfig),
    projects: aggregateRepository(database, projectConfig),
    invocations: invocationRepository(database),
    artifacts: aggregateRepository(database, artifactConfig),
    approvals: aggregateRepository(database, approvalConfig),
    budgets: aggregateRepository(database, budgetConfig),
    agents: aggregateRepository(database, agentConfig),
    artifactVersions: artifactVersionRepository(database),
    events: eventStore(database),
    outbox: outboxRepository(database),
    commands: commandRepository(database),
    checkpoints: checkpointRepository(database),
    receipts: receiptRepository(database),
  };
}

export class SqliteStateStore implements StateStore {
  private queue = Promise.resolve();

  constructor(private readonly database: SqliteDatabase) {}

  async transaction<T>(work: (transaction: StateTransaction) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      ensureSqliteOutboxClaimColumns(this.database);
      this.database.exec('BEGIN IMMEDIATE');
      try {
        const result = await work(transaction(this.database));
        this.database.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          this.database.exec('ROLLBACK');
        } catch {
          // Preserve the domain or database error that caused the transaction to fail.
        }
        throw error;
      }
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
