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
  type ContractName,
  type HashSha256,
  type Id,
  type JsonValue,
  type Project,
  type RuntimeCommand,
  type RuntimeEvent,
  type TenantRef,
  type Workflow,
  type BudgetReservation,
} from '@agentic-platform/runtime-contracts';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type {
  AggregateRepository,
  ArtifactVersionRepository,
  CommandDeduplicationRepository,
  CommandDeduplicationRecord,
  EventStore,
  InvocationRepository,
  OutboxRecord,
  OutboxRepository,
  ProjectionCheckpointRepository,
  SideEffectReceipt,
  SideEffectReceiptRepository,
  StateStore,
  StateTransaction,
  StoredEvent,
  VersionedAggregate,
  PersistedArtifactVersion,
} from './ports.js';

interface Row extends QueryResultRow {
  [key: string]: unknown;
}

interface AggregateConfig<T> {
  table: string;
  idColumn: string;
  jsonColumn: string;
  contract: ContractName;
  extraColumns(value: T): { columns: string[]; values: unknown[] };
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
  if (serialized === undefined)
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Value is not JSON serializable');
  return serialized;
}

function parseJson<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
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

function aggregateRepository<T>(
  client: PoolClient,
  config: AggregateConfig<T>,
): AggregateRepository<T> {
  const select = `
    SELECT ${config.idColumn}, aggregate_version, ${config.jsonColumn}, updated_at
    FROM ${config.table}
    WHERE tenant_id = $1 AND workspace_id = $2 AND ${config.idColumn} = $3`;

  const toRecord = (tenant: TenantRef, id: string, row: Row): VersionedAggregate<T> => ({
    tenant,
    id: id as VersionedAggregate<T>['id'],
    version: rowNumber(row, 'aggregate_version'),
    value: parseContract(config.contract, parseJson(row[config.jsonColumn])) as T,
    updatedAt: rowString(row, 'updated_at'),
  });

  return {
    async get(tenant, id) {
      const result = await client.query<Row>(select, [...tenantValues(tenant), id]);
      const row = result.rows[0];
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
      const values = [...tenantValues(tenant), id, 0, jsonText(value), updatedAt, ...extra.values];
      const placeholders = values.map((_, index) => `$${index + 1}`);
      try {
        const result = await client.query<Row>(
          `INSERT INTO ${config.table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING ${config.idColumn}, aggregate_version, ${config.jsonColumn}, updated_at`,
          values,
        );
        return toRecord(tenant, id, result.rows[0] as Row);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw runtimeError('CONCURRENCY_STALE_VERSION', `${config.table} ${id} already exists`);
        }
        throw error;
      }
    },
    async update(tenant, id, expectedVersion, value, updatedAt) {
      const extra = config.extraColumns(value);
      const assignments = [
        'aggregate_version = $4 + 1',
        `${config.jsonColumn} = $5`,
        'updated_at = $6',
        ...extra.columns.map((column, index) => `${column} = $${index + 7}`),
      ];
      const values = [
        ...tenantValues(tenant),
        id,
        expectedVersion,
        jsonText(value),
        updatedAt,
        ...extra.values,
      ];
      const result = await client.query<Row>(
        `UPDATE ${config.table}
         SET ${assignments.join(', ')}
         WHERE tenant_id = $1 AND workspace_id = $2 AND ${config.idColumn} = $3 AND aggregate_version = $4
         RETURNING ${config.idColumn}, aggregate_version, ${config.jsonColumn}, updated_at`,
        values,
      );
      const row = result.rows[0];
      if (!row) {
        const current = await client.query<Row>(select, [...tenantValues(tenant), id]);
        throw runtimeError(
          'CONCURRENCY_STALE_VERSION',
          `${config.table} ${id} expected version ${expectedVersion}, actual ${current.rows[0] ? rowNumber(current.rows[0], 'aggregate_version') : 'missing'}`,
        );
      }
      return toRecord(tenant, id, row);
    },
  };
}

function invocationRepository(client: PoolClient): InvocationRepository {
  const base = aggregateRepository(client, invocationConfig);
  return {
    ...base,
    async getForUpdate(tenant, invocationId) {
      const result = await client.query<Row>(
        `SELECT invocation_id, aggregate_version, invocation_json, updated_at
         FROM invocations
         WHERE tenant_id = $1 AND workspace_id = $2 AND invocation_id = $3
         FOR UPDATE`,
        [...tenantValues(tenant), invocationId],
      );
      const row = result.rows[0];
      if (!row) return undefined;
      return {
        tenant,
        id: invocationId,
        version: rowNumber(row, 'aggregate_version'),
        value: parseContract(
          'AgentInvocation',
          parseJson(row['invocation_json']),
        ) as AgentInvocation,
        updatedAt: rowString(row, 'updated_at'),
      };
    },
    async countChildren(tenant, parentInvocationId) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `invocation-children:${tenant.tenantId}:${tenant.workspaceId}:${parentInvocationId}`,
      ]);
      const result = await client.query<Row>(
        `SELECT invocation_json
         FROM invocations
         WHERE tenant_id = $1 AND workspace_id = $2`,
        tenantValues(tenant),
      );
      let count = 0;
      for (const row of result.rows) {
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
  const event = parseContract('RuntimeEvent', parseJson(row['event_json']));
  return { streamSequence: rowNumber(row, 'stream_sequence'), event };
}

function eventStore(client: PoolClient): EventStore {
  const select = `
    SELECT stream_sequence, event_json
    FROM domain_events`;
  return {
    async append<TPayload extends JsonValue>(
      event: RuntimeEvent<TPayload>,
      expectedAggregateVersion: number,
    ) {
      if (!isContract('RuntimeEvent', event)) {
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Event did not satisfy RuntimeEvent.v1');
      }
      const validated = parseContract('RuntimeEvent', event) as RuntimeEvent<TPayload>;
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `aggregate:${validated.tenant.tenantId}:${validated.tenant.workspaceId}:${validated.aggregateType}:${validated.aggregateId}`,
      ]);
      const aggregate = await client.query<Row>(
        `SELECT COALESCE(MAX(aggregate_version), 0) AS aggregate_version
         FROM domain_events
         WHERE tenant_id = $1 AND workspace_id = $2 AND aggregate_type = $3 AND aggregate_id = $4`,
        [
          validated.tenant.tenantId,
          validated.tenant.workspaceId,
          validated.aggregateType,
          validated.aggregateId,
        ],
      );
      const actualVersion = rowNumber(aggregate.rows[0] as Row, 'aggregate_version');
      if (actualVersion !== expectedAggregateVersion) {
        throw runtimeError(
          'CONCURRENCY_STALE_VERSION',
          `${validated.aggregateType} ${validated.aggregateId} expected event version ${expectedAggregateVersion}, actual ${actualVersion}`,
        );
      }
      const existing = await client.query<Row>(
        `${select} WHERE tenant_id = $1 AND workspace_id = $2 AND event_id = $3`,
        [validated.tenant.tenantId, validated.tenant.workspaceId, validated.eventId],
      );
      if (existing.rows[0]) return eventFromRow(existing.rows[0]) as StoredEvent<TPayload>;

      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['event-stream']);
      const sequenceResult = await client.query<Row>(
        'SELECT COALESCE(MAX(stream_sequence), 0) + 1 AS stream_sequence FROM domain_events',
      );
      const storedEvent: RuntimeEvent<TPayload> = {
        ...validated,
        aggregateVersion: actualVersion + 1,
      };
      const sequence = rowNumber(sequenceResult.rows[0] as Row, 'stream_sequence');
      await client.query(
        `INSERT INTO domain_events
          (stream_sequence, tenant_id, workspace_id, event_id, aggregate_type, aggregate_id, aggregate_version, event_name, event_json, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          sequence,
          storedEvent.tenant.tenantId,
          storedEvent.tenant.workspaceId,
          storedEvent.eventId,
          storedEvent.aggregateType,
          storedEvent.aggregateId,
          storedEvent.aggregateVersion,
          storedEvent.eventName,
          jsonText(storedEvent),
          storedEvent.occurredAt,
        ],
      );
      return { streamSequence: sequence, event: storedEvent };
    },
    async list(tenant, afterStreamSequence = 0) {
      const result = await client.query<Row>(
        `${select}
         WHERE tenant_id = $1 AND workspace_id = $2 AND stream_sequence > $3
         ORDER BY stream_sequence`,
        [...tenantValues(tenant), afterStreamSequence],
      );
      return result.rows.map(eventFromRow);
    },
    async all() {
      const result = await client.query<Row>(`${select} ORDER BY stream_sequence`);
      return result.rows.map(eventFromRow);
    },
  };
}

function outboxRepository(client: PoolClient): OutboxRepository {
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
  const select = `
    SELECT outbox_id, tenant_id, workspace_id, event_id, topic, event_json, available_at,
           published_at, attempts, claimed_by, claim_expires_at
    FROM transactional_outbox`;
  return {
    async enqueue(event, topic, availableAt) {
      const existing = await client.query<Row>(
        `${select} WHERE tenant_id = $1 AND workspace_id = $2 AND event_id = $3`,
        [event.tenant.tenantId, event.tenant.workspaceId, event.eventId],
      );
      if (existing.rows[0]) return toRecord(existing.rows[0]);
      const outboxId = newSortableId();
      try {
        const result = await client.query<Row>(
          `INSERT INTO transactional_outbox
            (tenant_id, workspace_id, outbox_id, event_id, topic, event_json, available_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING outbox_id, tenant_id, workspace_id, event_id, topic, event_json, available_at,
                     published_at, attempts, claimed_by, claim_expires_at`,
          [
            event.tenant.tenantId,
            event.tenant.workspaceId,
            outboxId,
            event.eventId,
            topic,
            jsonText(event),
            availableAt,
          ],
        );
        return toRecord(result.rows[0] as Row);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const duplicate = await client.query<Row>(
          `${select} WHERE tenant_id = $1 AND workspace_id = $2 AND event_id = $3`,
          [event.tenant.tenantId, event.tenant.workspaceId, event.eventId],
        );
        if (duplicate.rows[0]) return toRecord(duplicate.rows[0]);
        throw error;
      }
    },
    async pending(tenant, now) {
      const result = await client.query<Row>(
        `${select}
         WHERE tenant_id = $1 AND workspace_id = $2 AND published_at IS NULL AND available_at <= $3
         ORDER BY available_at, outbox_id`,
        [...tenantValues(tenant), now],
      );
      return result.rows.map(toRecord);
    },
    async claimPending(tenant, now, consumerId, claimExpiresAt, limit) {
      assertOutboxClaimInput(consumerId, claimExpiresAt, now, limit);
      const result = await client.query<Row>(
        `WITH candidates AS (
           SELECT tenant_id, workspace_id, outbox_id
           FROM transactional_outbox
           WHERE tenant_id = $1 AND workspace_id = $2 AND published_at IS NULL AND available_at <= $3
             AND (claimed_by IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= $3 OR claimed_by = $4)
           ORDER BY available_at, outbox_id
           LIMIT $5
           FOR UPDATE SKIP LOCKED
         )
         UPDATE transactional_outbox AS outbox
         SET claimed_by = $4, claim_expires_at = $6
         FROM candidates
         WHERE outbox.tenant_id = candidates.tenant_id
           AND outbox.workspace_id = candidates.workspace_id
           AND outbox.outbox_id = candidates.outbox_id
         RETURNING outbox.outbox_id, outbox.tenant_id, outbox.workspace_id, outbox.event_id,
                   outbox.topic, outbox.event_json, outbox.available_at, outbox.published_at,
                   outbox.attempts, outbox.claimed_by, outbox.claim_expires_at`,
        [...tenantValues(tenant), now, consumerId, limit, claimExpiresAt],
      );
      return result.rows.map(toRecord);
    },
    async markPublished(tenant, outboxId, publishedAt, consumerId, now) {
      const existing = await client.query<Row>(
        `${select} WHERE tenant_id = $1 AND workspace_id = $2 AND outbox_id = $3 FOR UPDATE`,
        [...tenantValues(tenant), outboxId],
      );
      const row = existing.rows[0];
      if (!row) {
        throw runtimeError('VALIDATION_INVALID_INPUT', `Outbox record ${outboxId} not found`);
      }
      if (row['published_at'] !== null && row['published_at'] !== undefined) return;
      if (consumerId !== undefined) {
        const claimedBy = optionalRowString(row, 'claimed_by');
        const expiresAt = optionalRowString(row, 'claim_expires_at');
        const active =
          claimedBy === consumerId &&
          (now === undefined ||
            (expiresAt !== undefined &&
              Number.isFinite(Date.parse(expiresAt)) &&
              Date.parse(expiresAt) > Date.parse(now)));
        if (!active) outboxOwnershipError(outboxId, consumerId);
      }
      await client.query(
        `UPDATE transactional_outbox
         SET published_at = $4, claimed_by = NULL, claim_expires_at = NULL
         WHERE tenant_id = $1 AND workspace_id = $2 AND outbox_id = $3`,
        [...tenantValues(tenant), outboxId, publishedAt],
      );
    },
    async incrementAttempt(tenant, outboxId, consumerId, now) {
      if (consumerId !== undefined) {
        const existing = await client.query<Row>(
          `${select} WHERE tenant_id = $1 AND workspace_id = $2 AND outbox_id = $3 FOR UPDATE`,
          [...tenantValues(tenant), outboxId],
        );
        const row = existing.rows[0];
        if (!row) {
          throw runtimeError('VALIDATION_INVALID_INPUT', `Outbox record ${outboxId} not found`);
        }
        const claimedBy = optionalRowString(row, 'claimed_by');
        const expiresAt = optionalRowString(row, 'claim_expires_at');
        const active =
          claimedBy === consumerId &&
          (now === undefined ||
            (expiresAt !== undefined &&
              Number.isFinite(Date.parse(expiresAt)) &&
              Date.parse(expiresAt) > Date.parse(now)));
        if (!active) outboxOwnershipError(outboxId, consumerId);
      }
      const result = await client.query(
        `UPDATE transactional_outbox SET attempts = attempts + 1
         WHERE tenant_id = $1 AND workspace_id = $2 AND outbox_id = $3`,
        [...tenantValues(tenant), outboxId],
      );
      if (result.rowCount !== 1) {
        throw runtimeError('VALIDATION_INVALID_INPUT', `Outbox record ${outboxId} not found`);
      }
    },
  };
}

function commandRepository(client: PoolClient): CommandDeduplicationRepository {
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
  const select = `
    SELECT tenant_id, workspace_id, idempotency_key, request_digest, command_id, result_json, reserved_at, completed_at
    FROM command_deduplication`;
  return {
    async reserve(command: RuntimeCommand, requestDigest: string, reservedAt: string) {
      const existing = await client.query<Row>(
        `${select} WHERE tenant_id = $1 AND workspace_id = $2 AND idempotency_key = $3 FOR UPDATE`,
        [...tenantValues(command.tenant), command.idempotencyKey],
      );
      if (existing.rows[0]) {
        const record = toRecord(existing.rows[0]);
        if (record.requestDigest !== requestDigest) {
          throw runtimeError(
            'VALIDATION_INVALID_INPUT',
            'Idempotency key was reused with a different request digest',
          );
        }
        return record;
      }
      const result = await client.query<Row>(
        `INSERT INTO command_deduplication
          (tenant_id, workspace_id, idempotency_key, request_digest, command_id, reserved_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING tenant_id, workspace_id, idempotency_key, request_digest, command_id, result_json, reserved_at, completed_at`,
        [
          ...tenantValues(command.tenant),
          command.idempotencyKey,
          requestDigest,
          command.commandId,
          reservedAt,
        ],
      );
      return toRecord(result.rows[0] as Row);
    },
    async complete(tenant, idempotencyKey, result, completedAt) {
      const updated = await client.query(
        `UPDATE command_deduplication SET result_json = $3, completed_at = $4
         WHERE tenant_id = $1 AND workspace_id = $2 AND idempotency_key = $5`,
        [tenant.tenantId, tenant.workspaceId, jsonText(result), completedAt, idempotencyKey],
      );
      if (updated.rowCount !== 1)
        throw runtimeError('VALIDATION_INVALID_INPUT', 'Cannot complete an unreserved command');
    },
    async get(tenant, idempotencyKey) {
      const result = await client.query<Row>(
        `${select} WHERE tenant_id = $1 AND workspace_id = $2 AND idempotency_key = $3`,
        [...tenantValues(tenant), idempotencyKey],
      );
      return result.rows[0] ? toRecord(result.rows[0]) : undefined;
    },
  };
}

function checkpointRepository(client: PoolClient): ProjectionCheckpointRepository {
  return {
    async get(tenant, projectionName) {
      const result = await client.query<Row>(
        `SELECT tenant_id, workspace_id, projection_name, stream_sequence, updated_at
         FROM projection_checkpoints WHERE tenant_id = $1 AND workspace_id = $2 AND projection_name = $3`,
        [...tenantValues(tenant), projectionName],
      );
      const row = result.rows[0];
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
      await client.query(
        `INSERT INTO projection_checkpoints (tenant_id, workspace_id, projection_name, stream_sequence, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, workspace_id, projection_name)
         DO UPDATE SET stream_sequence = EXCLUDED.stream_sequence, updated_at = EXCLUDED.updated_at`,
        [
          checkpoint.tenant.tenantId,
          checkpoint.tenant.workspaceId,
          checkpoint.projectionName,
          checkpoint.streamSequence,
          checkpoint.updatedAt,
        ],
      );
    },
    async clear(tenant, projectionName) {
      await client.query(
        'DELETE FROM projection_checkpoints WHERE tenant_id = $1 AND workspace_id = $2 AND projection_name = $3',
        [...tenantValues(tenant), projectionName],
      );
    },
  };
}

function receiptRepository(client: PoolClient): SideEffectReceiptRepository {
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
      const result = await client.query<Row>(
        `SELECT tenant_id, workspace_id, receipt_id, effect_key, result_json, recorded_at
         FROM side_effect_receipts WHERE tenant_id = $1 AND workspace_id = $2 AND effect_key = $3`,
        [...tenantValues(tenant), effectKey],
      );
      return result.rows[0] ? toRecord(result.rows[0]) : undefined;
    },
    async record(receipt) {
      const existing = await client.query<Row>(
        `SELECT tenant_id, workspace_id, receipt_id, effect_key, result_json, recorded_at
         FROM side_effect_receipts WHERE tenant_id = $1 AND workspace_id = $2 AND effect_key = $3`,
        [...tenantValues(receipt.tenant), receipt.effectKey],
      );
      if (existing.rows[0]) return toRecord(existing.rows[0]);
      const result = await client.query<Row>(
        `INSERT INTO side_effect_receipts
          (tenant_id, workspace_id, receipt_id, effect_key, result_json, recorded_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING tenant_id, workspace_id, receipt_id, effect_key, result_json, recorded_at`,
        [
          receipt.tenant.tenantId,
          receipt.tenant.workspaceId,
          receipt.receiptId,
          receipt.effectKey,
          jsonText(receipt.result),
          receipt.recordedAt,
        ],
      );
      return toRecord(result.rows[0] as Row);
    },
  };
}

function artifactVersionRepository(client: PoolClient): ArtifactVersionRepository {
  const select = `
    SELECT av.tenant_id, av.workspace_id, av.artifact_id, av.version, av.content_hash,
           av.object_key, av.media_type, av.size_bytes, av.creator_json, av.invocation_id,
           av.state AS initial_state, av.schema_name, av.retention_until, av.published_at,
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

  const lineageFor = async (
    tenant: TenantRef,
    artifactId: Id,
    version: number,
  ): Promise<ArtifactReference[]> => {
    const result = await client.query<Row>(
      `SELECT parent.tenant_id, parent.workspace_id, parent.artifact_id, parent.version,
              parent.content_hash, parent.object_key, parent.media_type, parent.size_bytes,
              parent.published_at
       FROM artifact_lineage_edges edge
       JOIN artifact_versions parent
         ON parent.tenant_id = edge.tenant_id
        AND parent.workspace_id = edge.workspace_id
        AND parent.artifact_id = edge.parent_artifact_id
        AND parent.version = edge.parent_version
       WHERE edge.tenant_id = $1 AND edge.workspace_id = $2
         AND edge.child_artifact_id = $3 AND edge.child_version = $4
       ORDER BY edge.parent_artifact_id, edge.parent_version`,
      [...tenantValues(tenant), artifactId, version],
    );
    return result.rows.map(referenceFromRow);
  };

  const toRecord = async (row: Row): Promise<PersistedArtifactVersion> => {
    const reference = referenceFromRow(row);
    return {
      reference,
      state: rowString(row, 'effective_state') as PersistedArtifactVersion['state'],
      createdBy: parseContract('Actor', parseJson(row['creator_json'])),
      lineage: await lineageFor(reference.tenant, reference.artifactId, reference.version),
      ...(row['invocation_id'] !== null && row['invocation_id'] !== undefined
        ? {
            invocationId: rowString(row, 'invocation_id') as Id,
          }
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
      const result = await client.query<Row>(
        `${select}
         WHERE av.tenant_id = $1 AND av.workspace_id = $2 AND av.artifact_id = $3 AND av.version = $4`,
        [...tenantValues(tenant), artifactId, version],
      );
      return result.rows[0] ? toRecord(result.rows[0]) : undefined;
    },
    async current(tenant, artifactId) {
      const aggregate = await client.query<Row>(
        `SELECT current_version
         FROM artifacts
         WHERE tenant_id = $1 AND workspace_id = $2 AND artifact_id = $3`,
        [...tenantValues(tenant), artifactId],
      );
      const row = aggregate.rows[0];
      if (!row) return undefined;
      return this.get(tenant, artifactId, rowNumber(row, 'current_version'));
    },
    async list(tenant, artifactId) {
      const conditions = ['av.tenant_id = $1', 'av.workspace_id = $2'];
      const values: unknown[] = [...tenantValues(tenant)];
      if (artifactId !== undefined) {
        conditions.push('av.artifact_id = $3');
        values.push(artifactId);
      }
      const result = await client.query<Row>(
        `${select} WHERE ${conditions.join(' AND ')} ORDER BY av.artifact_id, av.version`,
        values,
      );
      const records: PersistedArtifactVersion[] = [];
      for (const row of result.rows) records.push(await toRecord(row));
      return records;
    },
    async publish(record, expectedCurrentVersion) {
      const tenant = record.reference.tenant;
      const artifactLock = `artifact:${tenant.tenantId}:${tenant.workspaceId}:${record.reference.artifactId}`;
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [artifactLock]);
      const aggregate = await client.query<Row>(
        `SELECT current_version
         FROM artifacts
         WHERE tenant_id = $1 AND workspace_id = $2 AND artifact_id = $3
         FOR UPDATE`,
        [...tenantValues(tenant), record.reference.artifactId],
      );
      const aggregateRow = aggregate.rows[0];
      const actualVersion = aggregateRow ? rowNumber(aggregateRow, 'current_version') : 0;
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
      await client.query(
        `INSERT INTO artifact_content_objects
          (tenant_id, workspace_id, content_hash, object_key, media_type, size_bytes, created_at,
           retention_until)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (tenant_id, workspace_id, content_hash) DO NOTHING`,
        [
          tenant.tenantId,
          tenant.workspaceId,
          record.reference.contentHash,
          objectKey,
          record.reference.mediaType,
          record.reference.sizeBytes,
          record.publishedAt,
          record.retentionUntil ?? null,
        ],
      );
      try {
        await client.query(
          `INSERT INTO artifact_versions
            (tenant_id, workspace_id, artifact_id, version, content_hash, object_key, media_type,
             size_bytes, creator_json, invocation_id, state, schema_name, retention_until, published_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
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
          ],
        );
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw runtimeError(
            'CONCURRENCY_STALE_VERSION',
            `Artifact ${record.reference.artifactId}@${record.reference.version} already exists`,
          );
        }
        throw error;
      }
      await client.query(
        `INSERT INTO artifact_version_states
          (tenant_id, workspace_id, artifact_id, version, state, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          tenant.tenantId,
          tenant.workspaceId,
          record.reference.artifactId,
          record.reference.version,
          record.state,
          record.publishedAt,
        ],
      );
      for (const parent of record.lineage) {
        await client.query(
          `INSERT INTO artifact_lineage_edges
            (tenant_id, workspace_id, parent_artifact_id, parent_version,
             child_artifact_id, child_version, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            tenant.tenantId,
            tenant.workspaceId,
            parent.artifactId,
            parent.version,
            record.reference.artifactId,
            record.reference.version,
            record.publishedAt,
          ],
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
      const aggregateValues = [
        tenant.tenantId,
        tenant.workspaceId,
        record.reference.artifactId,
        record.reference.version,
        record.reference.version,
        record.state,
        jsonText(aggregateArtifact),
        record.publishedAt,
      ];
      if (aggregateRow) {
        const updated = await client.query(
          `UPDATE artifacts
           SET aggregate_version = $4, current_version = $5, logical_state = $6,
               artifact_json = $7, updated_at = $8
           WHERE tenant_id = $1 AND workspace_id = $2 AND artifact_id = $3
             AND current_version = $9`,
          [...aggregateValues, expectedCurrentVersion],
        );
        if (updated.rowCount !== 1) {
          throw runtimeError(
            'CONCURRENCY_STALE_VERSION',
            `Artifact ${record.reference.artifactId} expected parent ${expectedCurrentVersion}`,
          );
        }
      } else {
        await client.query(
          `INSERT INTO artifacts
            (tenant_id, workspace_id, artifact_id, aggregate_version, current_version,
             logical_state, artifact_json, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          aggregateValues,
        );
      }
    },
    async markStale(tenant, artifactId, version, updatedAt) {
      const status = await client.query(
        `UPDATE artifact_version_states SET state = $5, updated_at = $6
         WHERE tenant_id = $1 AND workspace_id = $2 AND artifact_id = $3 AND version = $4
           AND state <> 'archived'`,
        [...tenantValues(tenant), artifactId, version, 'stale', updatedAt],
      );
      if (status.rowCount !== 1) {
        throw runtimeError(
          'ARTIFACT_NOT_FOUND',
          `Artifact ${artifactId}@${version} is unavailable`,
        );
      }
      const aggregate = await client.query<Row>(
        `SELECT artifact_json
         FROM artifacts
         WHERE tenant_id = $1 AND workspace_id = $2 AND artifact_id = $3 AND current_version = $4
         FOR UPDATE`,
        [...tenantValues(tenant), artifactId, version],
      );
      const row = aggregate.rows[0];
      if (!row) return;
      const artifact = parseContract('Artifact', parseJson(row['artifact_json']));
      artifact.state = 'stale';
      await client.query(
        `UPDATE artifacts SET logical_state = $5, artifact_json = $6, updated_at = $7
         WHERE tenant_id = $1 AND workspace_id = $2 AND artifact_id = $3 AND current_version = $4`,
        [...tenantValues(tenant), artifactId, version, 'stale', jsonText(artifact), updatedAt],
      );
    },
  };
}

function transaction(client: PoolClient): StateTransaction {
  return {
    workflows: aggregateRepository(client, workflowConfig),
    projects: aggregateRepository(client, projectConfig),
    invocations: invocationRepository(client),
    artifacts: aggregateRepository(client, artifactConfig),
    approvals: aggregateRepository(client, approvalConfig),
    budgets: aggregateRepository(client, budgetConfig),
    agents: aggregateRepository(client, agentConfig),
    events: eventStore(client),
    outbox: outboxRepository(client),
    commands: commandRepository(client),
    checkpoints: checkpointRepository(client),
    receipts: receiptRepository(client),
    artifactVersions: artifactVersionRepository(client),
  };
}

export class PostgresStateStore implements StateStore {
  constructor(private readonly pool: Pick<Pool, 'connect'>) {}

  async transaction<T>(work: (transaction: StateTransaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(transaction(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the domain or database error that caused the transaction to fail.
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
