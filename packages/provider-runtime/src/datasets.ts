import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import {
  runtimeError,
  type JsonPrimitive,
  type JsonValue,
} from '@agentic-platform/runtime-contracts';
import {
  LocalQueryRuntime,
  type QueryColumn,
  type QueryExecutionResult,
  type QueryPlanV1,
  type QueryRuntime,
  type QuerySource,
} from './query.js';

export type DataConnectionKind = 'memory' | 'file' | 'sql' | 'connector';
export type DataConnectionStatus = 'configured' | 'ready' | 'degraded' | 'failed';
export type DataCredentialStatus = 'unbound' | 'bound' | 'revoked';

export interface DataConnectionV1 {
  readonly schemaVersion: 1;
  readonly connectionId: string;
  readonly name: string;
  readonly kind: DataConnectionKind;
  readonly connectorId?: string;
  readonly credentialRef?: string;
  readonly credentialStatus: DataCredentialStatus;
  readonly sourceId: string;
  readonly sourceReference: string;
  readonly path?: string;
  readonly tableName?: string;
  readonly status: DataConnectionStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastTestedAt?: string;
  readonly lastError?: string;
}

export interface DataSourceV1 {
  readonly schemaVersion: 1;
  readonly sourceId: string;
  readonly connectionId: string;
  readonly name: string;
  readonly kind: DataConnectionKind;
  readonly sourceReference: string;
  readonly status: DataConnectionStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastDiscoveredAt?: string;
}

export interface DataFieldStatisticsV1 {
  readonly nullCount: number;
  readonly nullFraction: number;
  readonly distinctCount: number;
  readonly min?: JsonPrimitive;
  readonly max?: JsonPrimitive;
  readonly mean?: number;
  readonly sampleValues: readonly JsonPrimitive[];
}

export interface DataSchemaFieldV1 {
  readonly name: string;
  readonly type: QueryColumn['type'];
  readonly nullable: boolean;
  readonly statistics?: DataFieldStatisticsV1;
  readonly anomalies?: readonly string[];
}

export interface DataTableSchemaV1 {
  readonly tableName: string;
  readonly fields: readonly DataSchemaFieldV1[];
  readonly rowCount: number;
}

export interface DataSchemaBrowserResultV1 {
  readonly connectionId: string;
  readonly tables: readonly DataTableSchemaV1[];
  readonly previewRows: readonly (readonly JsonValue[])[];
  readonly fetchedAt: string;
}

export interface DataProfileFieldV1 extends DataFieldStatisticsV1 {
  readonly name: string;
  readonly type: QueryColumn['type'];
  readonly nullable: boolean;
  readonly anomalies: readonly string[];
}

export interface DataProfileV1 {
  readonly schemaVersion: 1;
  readonly profileId: string;
  readonly datasetId: string;
  readonly datasetVersion: number;
  readonly sourceConnectionId: string;
  readonly tableName: string;
  readonly rowCount: number;
  readonly fields: readonly DataProfileFieldV1[];
  readonly generatedAt: string;
  readonly lineage: readonly DatasetLineageReferenceV1[];
}

export type DataQualityStatus = 'passed' | 'warned' | 'failed';

export interface DataQualityCheckV1 {
  readonly checkId: string;
  readonly name: string;
  readonly status: DataQualityStatus;
  readonly observed: JsonPrimitive;
  readonly threshold?: JsonPrimitive;
  readonly message: string;
}

export interface DataQualityResultV1 {
  readonly schemaVersion: 1;
  readonly qualityId: string;
  readonly datasetId: string;
  readonly datasetVersion: number;
  readonly rowCount: number;
  readonly status: DataQualityStatus;
  readonly checks: readonly DataQualityCheckV1[];
  readonly generatedAt: string;
  readonly lineage: readonly DatasetLineageReferenceV1[];
}

export interface DatasetLineageReferenceV1 {
  readonly relation: 'derived-from' | 'queried-from' | 'synced-from';
  readonly reference: string;
  readonly datasetId?: string;
  readonly version?: number;
  readonly connectionId?: string;
  readonly artifactId?: string;
}

export interface DatasetVersionV1 {
  readonly schemaVersion: 1;
  readonly datasetId: string;
  readonly name: string;
  readonly version: number;
  readonly artifactId: string;
  readonly sourceConnectionId: string;
  readonly sourceReference: string;
  readonly mediaType: string;
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly rowCount: number;
  readonly schema: DataTableSchemaV1;
  readonly immutable: true;
  readonly lineage: readonly DatasetLineageReferenceV1[];
  readonly createdAt: string;
}

export interface DatasetQueryRequestV1 {
  readonly queryId: string;
  readonly sql: string;
  readonly connectionId?: string;
  readonly datasetId?: string;
  readonly datasetVersion?: number;
  readonly parameters?: Readonly<Record<string, JsonPrimitive>>;
  readonly source?: QuerySource;
  readonly maxRows?: number;
  readonly timeoutMs?: number;
  readonly costLimit?: number;
  readonly savedQueryId?: string;
}

export interface DatasetQueryRecordV1 {
  readonly queryId: string;
  readonly sql: string;
  readonly connectionId?: string;
  readonly datasetId?: string;
  readonly datasetVersion?: number;
  readonly savedQueryId?: string;
  readonly result: QueryExecutionResult;
  readonly createdAt: string;
}

export interface DataSavedQueryV1 {
  readonly schemaVersion: 1;
  readonly savedQueryId: string;
  readonly name: string;
  readonly sql: string;
  readonly connectionId?: string;
  readonly datasetId?: string;
  readonly datasetVersion?: number;
  readonly parameters?: Readonly<Record<string, JsonPrimitive>>;
  readonly maxRows?: number;
  readonly timeoutMs?: number;
  readonly costLimit?: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DataSavedQueryInputV1 {
  readonly savedQueryId: string;
  readonly name: string;
  readonly sql: string;
  readonly connectionId?: string;
  readonly datasetId?: string;
  readonly datasetVersion?: number;
  readonly parameters?: Readonly<Record<string, JsonPrimitive>>;
  readonly maxRows?: number;
  readonly timeoutMs?: number;
  readonly costLimit?: number;
}

export type DataExportFormat = 'json' | 'csv';

export interface DataQueryExportV1 {
  readonly schemaVersion: 1;
  readonly exportId: string;
  readonly queryId: string;
  readonly format: DataExportFormat;
  readonly path: string;
  readonly artifactId: string;
  readonly contentHash: string;
  readonly mediaType: 'application/json' | 'text/csv';
  readonly sizeBytes: number;
  readonly createdAt: string;
  readonly lineage: readonly DatasetLineageReferenceV1[];
}

export type DataHandoffTarget = 'browser' | 'jupyter';

export interface DataQueryHandoffV1 {
  readonly schemaVersion: 1;
  readonly handoffId: string;
  readonly queryId: string;
  readonly target: DataHandoffTarget;
  readonly route: string;
  readonly connectionId?: string;
  readonly datasetId?: string;
  readonly datasetVersion?: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lineage: readonly DatasetLineageReferenceV1[];
}

export interface DataConnectionInputV1 {
  readonly connectionId: string;
  readonly name: string;
  readonly kind: DataConnectionKind;
  readonly connectorId?: string;
  readonly credentialRef?: string;
  readonly path?: string;
  readonly tableName?: string;
  readonly sourceId?: string;
  readonly sourceReference?: string;
  readonly schema?: DataTableSchemaV1;
  readonly source?: QuerySource;
}

export interface DataQualityRequestV1 {
  readonly datasetId: string;
  readonly datasetVersion?: number;
  readonly requiredFields?: readonly string[];
  readonly maxNullFraction?: number;
}

export interface DatasetVersionInputV1 {
  readonly datasetId: string;
  readonly name: string;
  readonly connectionId: string;
  readonly sourceReference: string;
  readonly source?: QuerySource;
  readonly schema?: DataTableSchemaV1;
  readonly mediaType?: string;
  readonly lineage?: readonly DatasetLineageReferenceV1[];
}

interface StoredConnection extends DataConnectionV1 {
  readonly schema?: DataTableSchemaV1;
  readonly source?: QuerySource;
}

type StoredSource = DataSourceV1;

interface StoredDataset extends DatasetVersionV1 {
  readonly source: QuerySource;
}

interface DatasetState {
  readonly schemaVersion: 1;
  readonly connections: StoredConnection[];
  readonly sources: StoredSource[];
  readonly datasets: StoredDataset[];
  readonly queries: DatasetQueryRecordV1[];
  readonly profiles: DataProfileV1[];
  readonly qualityResults: DataQualityResultV1[];
  readonly savedQueries: DataSavedQueryV1[];
  readonly exports: DataQueryExportV1[];
  readonly handoffs: DataQueryHandoffV1[];
}

interface MigratedDatasetState {
  readonly state: DatasetState;
  readonly migrated: boolean;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function connectionKind(value: unknown): DataConnectionKind {
  return value === 'memory' || value === 'file' || value === 'sql' || value === 'connector'
    ? value
    : 'memory';
}

function connectionStatus(value: unknown): DataConnectionStatus {
  return value === 'configured' || value === 'ready' || value === 'degraded' || value === 'failed'
    ? value
    : 'configured';
}

function credentialStatus(value: unknown, credentialRef: string | undefined): DataCredentialStatus {
  if (value === 'unbound' || value === 'bound' || value === 'revoked') return value;
  return credentialRef === undefined ? 'unbound' : 'bound';
}

function querySource(value: unknown): QuerySource | undefined {
  const candidate = recordValue(value);
  return candidate !== undefined && Array.isArray(candidate['rows'])
    ? (candidate as unknown as QuerySource)
    : undefined;
}

function migrateConnection(
  value: unknown,
  now: string,
  index: number,
): {
  readonly connection: StoredConnection;
  readonly migrated: boolean;
} {
  const candidate = recordValue(value) ?? {};
  const connectionId = stringValue(candidate['connectionId']) ?? `migrated-connection-${index + 1}`;
  const sourceId = stringValue(candidate['sourceId']) ?? `source-${connectionId}`;
  const path = stringValue(candidate['path']);
  const credentialRef = stringValue(candidate['credentialRef']);
  const connectorId = stringValue(candidate['connectorId']);
  const tableName = stringValue(candidate['tableName']);
  const lastTestedAt = stringValue(candidate['lastTestedAt']);
  const lastError = stringValue(candidate['lastError']);
  const schema = recordValue(candidate['schema']);
  const source = querySource(candidate['source']);
  const connection: StoredConnection = {
    schemaVersion: 1,
    connectionId,
    name: stringValue(candidate['name']) ?? connectionId,
    kind: connectionKind(candidate['kind']),
    ...(connectorId === undefined ? {} : { connectorId }),
    ...(credentialRef === undefined ? {} : { credentialRef }),
    credentialStatus: credentialStatus(candidate['credentialStatus'], credentialRef),
    sourceId,
    sourceReference:
      stringValue(candidate['sourceReference']) ?? path ?? `migrated://${connectionId}`,
    ...(path === undefined ? {} : { path }),
    ...(tableName === undefined ? {} : { tableName }),
    status: connectionStatus(candidate['status']),
    createdAt: stringValue(candidate['createdAt']) ?? now,
    updatedAt: stringValue(candidate['updatedAt']) ?? now,
    ...(lastTestedAt === undefined ? {} : { lastTestedAt }),
    ...(lastError === undefined ? {} : { lastError }),
    ...(schema === undefined ? {} : { schema: schema as unknown as DataTableSchemaV1 }),
    ...(source === undefined ? {} : { source }),
  };
  const requiredFields = [
    'schemaVersion',
    'connectionId',
    'name',
    'kind',
    'credentialStatus',
    'sourceId',
    'sourceReference',
    'status',
    'createdAt',
    'updatedAt',
  ] as const;
  return {
    connection,
    migrated:
      requiredFields.some((field) => candidate[field] === undefined) ||
      candidate['schemaVersion'] !== 1 ||
      connectionKind(candidate['kind']) !== candidate['kind'] ||
      connectionStatus(candidate['status']) !== candidate['status'],
  };
}

function migrateSource(
  value: unknown,
  connection: StoredConnection | undefined,
  now: string,
  index: number,
): { readonly source: StoredSource; readonly migrated: boolean } {
  const candidate = recordValue(value) ?? {};
  const connectionId =
    stringValue(candidate['connectionId']) ??
    connection?.connectionId ??
    `migrated-connection-${index + 1}`;
  const sourceId =
    stringValue(candidate['sourceId']) ?? connection?.sourceId ?? `source-${connectionId}`;
  const lastDiscoveredAt = stringValue(candidate['lastDiscoveredAt']);
  const source: StoredSource = {
    schemaVersion: 1,
    sourceId,
    connectionId,
    name: stringValue(candidate['name']) ?? connection?.name ?? connectionId,
    kind: connectionKind(candidate['kind'] ?? connection?.kind),
    sourceReference:
      stringValue(candidate['sourceReference']) ??
      connection?.sourceReference ??
      `migrated://${connectionId}`,
    status: connectionStatus(candidate['status'] ?? connection?.status),
    createdAt: stringValue(candidate['createdAt']) ?? connection?.createdAt ?? now,
    updatedAt: stringValue(candidate['updatedAt']) ?? connection?.updatedAt ?? now,
    ...(lastDiscoveredAt === undefined ? {} : { lastDiscoveredAt }),
  };
  const requiredFields = [
    'schemaVersion',
    'sourceId',
    'connectionId',
    'name',
    'kind',
    'sourceReference',
    'status',
    'createdAt',
    'updatedAt',
  ] as const;
  return {
    source,
    migrated:
      requiredFields.some((field) => candidate[field] === undefined) ||
      candidate['schemaVersion'] !== 1 ||
      connectionKind(candidate['kind'] ?? connection?.kind) !==
        (candidate['kind'] ?? connection?.kind) ||
      connectionStatus(candidate['status'] ?? connection?.status) !==
        (candidate['status'] ?? connection?.status),
  };
}

function migrateDatasetState(raw: unknown, now: string): MigratedDatasetState | undefined {
  const record = recordValue(raw);
  if (record === undefined) return undefined;
  const rawConnections = Array.isArray(record['connections']) ? record['connections'] : [];
  const migratedConnections = rawConnections.map((value, index) =>
    migrateConnection(value, now, index),
  );
  const connections = migratedConnections.map((entry) => entry.connection);
  const rawSources = Array.isArray(record['sources']) ? record['sources'] : undefined;
  const migratedSources =
    rawSources === undefined
      ? connections.map((connection, index) => migrateSource(undefined, connection, now, index))
      : rawSources.map((value, index) => migrateSource(value, connections[index], now, index));
  const arrayFields = [
    'connections',
    'sources',
    'datasets',
    'queries',
    'profiles',
    'qualityResults',
    'savedQueries',
    'exports',
    'handoffs',
  ] as const;
  const hasAllArrays = arrayFields.every((field) => Array.isArray(record[field]));
  return {
    state: {
      schemaVersion: 1,
      connections,
      sources: migratedSources.map((entry) => entry.source),
      datasets: Array.isArray(record['datasets']) ? (record['datasets'] as StoredDataset[]) : [],
      queries: Array.isArray(record['queries'])
        ? (record['queries'] as DatasetQueryRecordV1[])
        : [],
      profiles: Array.isArray(record['profiles']) ? (record['profiles'] as DataProfileV1[]) : [],
      qualityResults: Array.isArray(record['qualityResults'])
        ? (record['qualityResults'] as DataQualityResultV1[])
        : [],
      savedQueries: Array.isArray(record['savedQueries'])
        ? (record['savedQueries'] as DataSavedQueryV1[])
        : [],
      exports: Array.isArray(record['exports']) ? (record['exports'] as DataQueryExportV1[]) : [],
      handoffs: Array.isArray(record['handoffs'])
        ? (record['handoffs'] as DataQueryHandoffV1[])
        : [],
    },
    migrated:
      record['schemaVersion'] !== 1 ||
      !hasAllArrays ||
      migratedConnections.some((entry) => entry.migrated) ||
      migratedSources.some((entry) => entry.migrated) ||
      rawSources === undefined,
  };
}

export interface LocalDataCatalogRuntimeOptions {
  readonly rootPath: string;
  readonly query?: QueryRuntime;
  readonly clock?: () => string;
  readonly maxRows?: number;
}

export interface DataConnectionTestResultV1 {
  readonly connectionId: string;
  readonly status: 'passed' | 'failed';
  readonly checkedAt: string;
  readonly message: string;
}

export interface DataConnectionCredentialResultV1 {
  readonly connectionId: string;
  readonly credentialStatus: DataCredentialStatus;
  readonly credentialRef?: string;
  readonly updatedAt: string;
}

export interface LocalDataCatalogRuntime {
  listSources(): Promise<readonly DataSourceV1[]>;
  getSource(sourceId: string): Promise<DataSourceV1 | undefined>;
  listConnections(): Promise<readonly DataConnectionV1[]>;
  getConnection(connectionId: string): Promise<DataConnectionV1 | undefined>;
  registerConnection(input: DataConnectionInputV1): Promise<DataConnectionV1>;
  removeConnection(connectionId: string): Promise<boolean>;
  bindCredential(
    connectionId: string,
    credentialRef: string,
  ): Promise<DataConnectionCredentialResultV1>;
  revokeCredential(connectionId: string): Promise<DataConnectionCredentialResultV1>;
  reauthorizeCredential(
    connectionId: string,
    credentialRef?: string,
  ): Promise<DataConnectionCredentialResultV1>;
  testConnection(connectionId: string): Promise<DataConnectionTestResultV1>;
  browseSchema(connectionId: string): Promise<DataSchemaBrowserResultV1>;
  publishDatasetVersion(input: DatasetVersionInputV1): Promise<DatasetVersionV1>;
  getDatasetVersion(datasetId: string, version?: number): Promise<DatasetVersionV1 | undefined>;
  listDatasetVersions(datasetId?: string): Promise<readonly DatasetVersionV1[]>;
  lineage(datasetId: string, version?: number): Promise<readonly DatasetLineageReferenceV1[]>;
  profileDataset(datasetId: string, version?: number): Promise<DataProfileV1>;
  getDatasetProfile(datasetId: string, version?: number): Promise<DataProfileV1 | undefined>;
  qualityDataset(request: DataQualityRequestV1): Promise<DataQualityResultV1>;
  getDatasetQuality(datasetId: string, version?: number): Promise<DataQualityResultV1 | undefined>;
  executeQuery(request: DatasetQueryRequestV1): Promise<DatasetQueryRecordV1>;
  explainQuery(request: DatasetQueryRequestV1): Promise<QueryPlanV1>;
  cancelQuery(queryId: string): Promise<boolean>;
  getQueryResult(queryId: string): Promise<DatasetQueryRecordV1 | undefined>;
  listQueries(): Promise<readonly DatasetQueryRecordV1[]>;
  saveQuery(input: DataSavedQueryInputV1): Promise<DataSavedQueryV1>;
  getSavedQuery(savedQueryId: string): Promise<DataSavedQueryV1 | undefined>;
  listSavedQueries(): Promise<readonly DataSavedQueryV1[]>;
  exportQueryResult(
    queryId: string,
    format?: DataExportFormat,
    destinationPath?: string,
  ): Promise<DataQueryExportV1>;
  createQueryHandoff(queryId: string, target: DataHandoffTarget): Promise<DataQueryHandoffV1>;
}

const MAX_SOURCE_ROWS = 100_000;
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function safeId(value: string, label: string): string {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(value)) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} is invalid`);
  }
  return value;
}

function required(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} is required`);
  }
  return value.trim();
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return (
    value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
  );
}

function normalizeSource(source: QuerySource): QuerySource {
  if (!Array.isArray(source.rows)) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Data source rows must be an array');
  }
  if (source.rows.length > MAX_SOURCE_ROWS) {
    throw runtimeError(
      'VALIDATION_INVALID_INPUT',
      `Data sources may contain at most ${MAX_SOURCE_ROWS} rows`,
    );
  }
  const columnNames = source.columns === undefined ? undefined : [...source.columns];
  if (columnNames !== undefined) {
    if (
      columnNames.length > 1_000 ||
      columnNames.some((column) => typeof column !== 'string' || column.trim().length === 0)
    ) {
      throw runtimeError(
        'VALIDATION_SCHEMA_MISMATCH',
        'Data source columns must be non-empty strings',
      );
    }
    if (new Set(columnNames).size !== columnNames.length) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Data source columns must be unique');
    }
  }
  for (const row of source.rows) {
    if (!Array.isArray(row) && !isRecord(row as JsonValue)) {
      throw runtimeError(
        'VALIDATION_SCHEMA_MISMATCH',
        'Data source rows must be arrays or objects',
      );
    }
    if (Array.isArray(row) && row.length > 1_000) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'Data source rows may contain at most 1,000 columns',
      );
    }
  }
  const sourceBytes = Buffer.byteLength(JSON.stringify(source), 'utf8');
  if (sourceBytes > MAX_SOURCE_BYTES) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Data source exceeds the 25 MB local limit');
  }
  return clone(source);
}

function sourceColumns(source: QuerySource): string[] {
  if (source.columns !== undefined && source.columns.length > 0) return [...source.columns];
  const first = source.rows[0];
  if (Array.isArray(first)) return first.map((_, index) => `column_${index + 1}`);
  if (first !== undefined && isRecord(first as JsonValue)) return Object.keys(first);
  return ['value'];
}

function fieldType(values: readonly JsonValue[]): QueryColumn['type'] {
  const present = values.filter((value) => value !== null);
  if (present.length === 0) return 'null';
  if (present.every((value) => typeof value === 'boolean')) return 'boolean';
  if (present.every((value) => typeof value === 'number')) return 'number';
  if (present.every((value) => typeof value === 'string')) return 'string';
  return 'unknown';
}

function primitiveValue(value: JsonValue): JsonPrimitive {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  return JSON.stringify(value);
}

function fieldStatistics(values: readonly JsonValue[]): DataFieldStatisticsV1 {
  const primitiveValues = values.map(primitiveValue);
  const present = primitiveValues.filter((value) => value !== null);
  const numbers = present.filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  );
  const distinct = new Set(present.map((value) => JSON.stringify(value))).size;
  const ordered = present.filter(
    (value): value is string | number | boolean =>
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
  );
  const min =
    ordered.length === 0
      ? undefined
      : ordered.reduce((left, right) => (left < right ? left : right));
  const max =
    ordered.length === 0
      ? undefined
      : ordered.reduce((left, right) => (left > right ? left : right));
  return {
    nullCount: primitiveValues.length - present.length,
    nullFraction:
      primitiveValues.length === 0
        ? 0
        : (primitiveValues.length - present.length) / primitiveValues.length,
    distinctCount: distinct,
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    ...(numbers.length === 0
      ? {}
      : { mean: numbers.reduce((total, value) => total + value, 0) / numbers.length }),
    sampleValues: present.slice(0, 5),
  };
}

function fieldAnomalies(
  type: QueryColumn['type'],
  statistics: DataFieldStatisticsV1,
): readonly string[] {
  const anomalies: string[] = [];
  if (type === 'unknown') anomalies.push('mixed-or-nested-types');
  if (statistics.nullFraction >= 0.5) anomalies.push('high-null-rate');
  if (statistics.distinctCount === 1 && statistics.nullCount === 0)
    anomalies.push('constant-value');
  return anomalies;
}

function sourceRows(source: QuerySource): readonly (readonly JsonValue[])[] {
  const columns = sourceColumns(source);
  return source.rows.map((row) => {
    if (Array.isArray(row)) return [...row];
    const objectRow = isRecord(row as JsonValue) ? (row as Record<string, JsonValue>) : {};
    return columns.map((column) => objectRow[column] ?? null);
  });
}

function schemaFor(source: QuerySource, tableName: string): DataTableSchemaV1 {
  const columns = sourceColumns(source);
  const rows = sourceRows(source);
  return {
    tableName,
    fields: columns.map((name, index) => {
      const values = rows.map((row) => row[index] ?? null);
      const type = fieldType(values);
      const statistics = fieldStatistics(values);
      return {
        name,
        type,
        nullable: values.some((value) => value === null),
        statistics,
        anomalies: fieldAnomalies(type, statistics),
      };
    }),
    rowCount: rows.length,
  };
}

function sourceForTable(source: QuerySource, tableName: string): QuerySource {
  return {
    ...clone(source),
    tableName,
    columns: sourceColumns(source),
  };
}

function csvRows(value: string): QuerySource {
  const rows: string[][] = [];
  let current: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const next = value[index + 1];
    if (character === '"' && quoted && next === '"') {
      field += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ',' && !quoted) {
      current.push(field);
      field = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && next === '\n') index += 1;
      current.push(field);
      if (current.some((item) => item.length > 0)) rows.push(current);
      current = [];
      field = '';
    } else {
      field += character;
    }
  }
  current.push(field);
  if (current.some((item) => item.length > 0)) rows.push(current);
  const columns = rows.shift() ?? ['value'];
  return { columns, rows };
}

function fileSource(path: string, value: string): QuerySource {
  const lower = path.toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.tsv')) {
    const source = csvRows(lower.endsWith('.tsv') ? value.replaceAll('\t', ',') : value);
    return source;
  }
  if (lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) {
    const rows = value
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as JsonValue);
    return { rows: rows as readonly Record<string, JsonValue>[] };
  }
  const parsed = JSON.parse(value) as unknown;
  if (Array.isArray(parsed)) return { rows: parsed as readonly Record<string, JsonValue>[] };
  if (parsed !== null && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>;
    if (Array.isArray(record['rows'])) {
      return {
        ...(Array.isArray(record['columns']) ? { columns: record['columns'] as string[] } : {}),
        rows: record['rows'] as readonly (readonly JsonValue[])[],
      };
    }
  }
  throw runtimeError(
    'VALIDATION_SCHEMA_MISMATCH',
    'JSON data sources must be an array or { rows }',
  );
}

function publicConnection(connection: StoredConnection): DataConnectionV1 {
  const { schema: _schema, source: _source, ...publicValue } = connection;
  void _schema;
  void _source;
  return clone(publicValue);
}

function queryLineage(record: DatasetQueryRecordV1): readonly DatasetLineageReferenceV1[] {
  return [
    ...(record.datasetId === undefined
      ? []
      : [
          {
            relation: 'queried-from' as const,
            reference: `dataset://${record.datasetId}/v${record.datasetVersion ?? 'latest'}`,
            datasetId: record.datasetId,
            ...(record.datasetVersion === undefined ? {} : { version: record.datasetVersion }),
            ...(record.connectionId === undefined ? {} : { connectionId: record.connectionId }),
          },
        ]),
    {
      relation: 'queried-from' as const,
      reference: record.result.artifact.artifactId,
      ...(record.connectionId === undefined ? {} : { connectionId: record.connectionId }),
      ...(record.datasetId === undefined ? {} : { datasetId: record.datasetId }),
      ...(record.datasetVersion === undefined ? {} : { version: record.datasetVersion }),
      artifactId: record.result.artifact.artifactId,
    },
  ];
}

function csvCell(value: JsonValue): string {
  const text = value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvResult(result: QueryExecutionResult): string {
  const header = result.columns.map((column) => csvCell(column.name)).join(',');
  const rows = result.rows.map((row) => row.map(csvCell).join(','));
  return `${[header, ...rows].join('\n')}\n`;
}

/**
 * Local-first data catalog with durable connections, immutable dataset versions, query history,
 * and explicit lineage. Secrets are represented only by credential references; source rows are
 * kept in the workspace state so a version can be queried again after a daemon restart.
 */
export class LocalDataCatalogRuntimeImpl implements LocalDataCatalogRuntime {
  private readonly statePath: string;
  private readonly rootPath: string;
  private readonly query: QueryRuntime;
  private readonly clock: () => string;
  private readonly maxRows: number;
  private state: DatasetState | undefined;
  private loading: Promise<void> | undefined;

  constructor(options: LocalDataCatalogRuntimeOptions) {
    this.rootPath = resolve(options.rootPath);
    this.statePath = join(this.rootPath, '.agentic', 'data-catalog.json');
    this.query = options.query ?? new LocalQueryRuntime();
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.maxRows = Math.max(1, Math.min(options.maxRows ?? 10_000, 10_000));
  }

  async listSources(): Promise<readonly DataSourceV1[]> {
    await this.ensureLoaded();
    return clone(this.state?.sources ?? []);
  }

  async getSource(sourceId: string): Promise<DataSourceV1 | undefined> {
    await this.ensureLoaded();
    const source = this.state?.sources.find((item) => item.sourceId === sourceId);
    return source === undefined ? undefined : clone(source);
  }

  async listConnections(): Promise<readonly DataConnectionV1[]> {
    await this.ensureLoaded();
    return clone((this.state?.connections ?? []).map(publicConnection));
  }

  async getConnection(connectionId: string): Promise<DataConnectionV1 | undefined> {
    await this.ensureLoaded();
    const connection = this.state?.connections.find((item) => item.connectionId === connectionId);
    return connection === undefined ? undefined : publicConnection(connection);
  }

  async registerConnection(input: DataConnectionInputV1): Promise<DataConnectionV1> {
    await this.ensureLoaded();
    const connectionId = safeId(input.connectionId, 'connectionId');
    const name = required(input.name, 'connection name');
    if (!['memory', 'file', 'sql', 'connector'].includes(input.kind)) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Unsupported data connection kind');
    }
    if (this.state?.connections.some((item) => item.connectionId === connectionId)) {
      throw runtimeError(
        'CONCURRENCY_STALE_VERSION',
        `Data connection ${connectionId} already exists`,
      );
    }
    if (input.credentialRef !== undefined) safeId(input.credentialRef, 'credentialRef');
    if (input.kind === 'file' && input.path === undefined && input.source === undefined) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'File connections require path or source');
    }
    const source = input.source === undefined ? undefined : normalizeSource(input.source);
    const path = input.path === undefined ? undefined : this.safePath(input.path);
    const sourceId = safeId(input.sourceId ?? `source-${connectionId}`, 'sourceId');
    const sourceReference = required(
      input.sourceReference ?? path ?? `${input.kind}://${connectionId}`,
      'sourceReference',
    );
    if (this.state?.sources.some((item) => item.sourceId === sourceId)) {
      throw runtimeError('CONCURRENCY_STALE_VERSION', `Data source ${sourceId} already exists`);
    }
    const now = this.clock();
    const connection: StoredConnection = {
      schemaVersion: 1,
      connectionId,
      name,
      kind: input.kind,
      ...(input.connectorId === undefined
        ? {}
        : { connectorId: required(input.connectorId, 'connectorId') }),
      ...(input.credentialRef === undefined ? {} : { credentialRef: input.credentialRef }),
      credentialStatus: input.credentialRef === undefined ? 'unbound' : 'bound',
      sourceId,
      sourceReference,
      ...(path === undefined ? {} : { path }),
      ...(input.tableName === undefined
        ? {}
        : { tableName: required(input.tableName, 'tableName') }),
      status: 'configured',
      createdAt: now,
      updatedAt: now,
      ...(input.schema === undefined ? {} : { schema: clone(input.schema) }),
      ...(source === undefined ? {} : { source }),
    };
    this.state?.connections.push(connection);
    this.state?.sources.push({
      schemaVersion: 1,
      sourceId,
      connectionId,
      name,
      kind: input.kind,
      sourceReference,
      status: 'configured',
      createdAt: now,
      updatedAt: now,
    });
    await this.persist();
    return publicConnection(connection);
  }

  async removeConnection(connectionId: string): Promise<boolean> {
    await this.ensureLoaded();
    const index =
      this.state?.connections.findIndex((item) => item.connectionId === connectionId) ?? -1;
    if (index < 0) return false;
    this.state?.connections.splice(index, 1);
    if (this.state) {
      this.state.sources.splice(
        0,
        this.state.sources.length,
        ...this.state.sources.filter((source) => source.connectionId !== connectionId),
      );
    }
    await this.persist();
    return true;
  }

  async bindCredential(
    connectionId: string,
    credentialRef: string,
  ): Promise<DataConnectionCredentialResultV1> {
    const connection = await this.requiredConnection(connectionId);
    const reference = safeId(credentialRef, 'credentialRef');
    const updatedAt = this.clock();
    const { lastError: _lastError, ...withoutError } = connection;
    void _lastError;
    await this.replaceConnection({
      ...withoutError,
      credentialRef: reference,
      credentialStatus: 'bound',
      updatedAt,
    });
    return { connectionId, credentialRef: reference, credentialStatus: 'bound', updatedAt };
  }

  async revokeCredential(connectionId: string): Promise<DataConnectionCredentialResultV1> {
    const connection = await this.requiredConnection(connectionId);
    const updatedAt = this.clock();
    const { credentialRef: _credentialRef, ...withoutCredential } = connection;
    void _credentialRef;
    await this.replaceConnection({
      ...withoutCredential,
      credentialStatus: 'revoked',
      updatedAt,
    });
    return { connectionId, credentialStatus: 'revoked', updatedAt };
  }

  async reauthorizeCredential(
    connectionId: string,
    credentialRef?: string,
  ): Promise<DataConnectionCredentialResultV1> {
    const connection = await this.requiredConnection(connectionId);
    const reference = credentialRef ?? connection.credentialRef;
    if (reference === undefined) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        `Data connection ${connectionId} requires a credentialRef to reauthorize`,
      );
    }
    return this.bindCredential(connectionId, reference);
  }

  async testConnection(connectionId: string): Promise<DataConnectionTestResultV1> {
    const connection = await this.requiredConnection(connectionId);
    try {
      const source = await this.sourceFor(connection);
      const checkedAt = this.clock();
      const tableName = connection.tableName ?? source.tableName ?? 'dataset';
      const { lastError, ...connectionWithoutError } = connection;
      void lastError;
      await this.replaceConnection({
        ...connectionWithoutError,
        schema: schemaFor(source, tableName),
        status: 'ready',
        lastTestedAt: checkedAt,
        updatedAt: checkedAt,
      });
      await this.replaceSourceStatus(connection.sourceId, 'ready', checkedAt);
      return {
        connectionId,
        status: 'passed',
        checkedAt,
        message: `Read ${source.rows.length} rows.`,
      };
    } catch (error) {
      const checkedAt = this.clock();
      const message = error instanceof Error ? error.message : String(error);
      await this.replaceConnection({
        ...connection,
        status: 'failed',
        lastTestedAt: checkedAt,
        updatedAt: checkedAt,
        lastError: message.slice(0, 1000),
      });
      await this.replaceSourceStatus(connection.sourceId, 'failed', checkedAt);
      return { connectionId, status: 'failed', checkedAt, message: message.slice(0, 1000) };
    }
  }

  async browseSchema(connectionId: string): Promise<DataSchemaBrowserResultV1> {
    const connection = await this.requiredConnection(connectionId);
    const source = await this.sourceFor(connection);
    const tableName = connection.tableName ?? source.tableName ?? 'dataset';
    const table = schemaFor(source, tableName);
    const fetchedAt = this.clock();
    await this.replaceConnection({
      ...connection,
      schema: table,
      status: 'ready',
      updatedAt: fetchedAt,
    });
    await this.replaceSourceStatus(connection.sourceId, 'ready', fetchedAt, fetchedAt);
    return {
      connectionId,
      tables: [table],
      previewRows: clone(sourceRows(source).slice(0, 25)),
      fetchedAt,
    };
  }

  async publishDatasetVersion(input: DatasetVersionInputV1): Promise<DatasetVersionV1> {
    await this.ensureLoaded();
    const datasetId = safeId(input.datasetId, 'datasetId');
    const name = required(input.name, 'dataset name');
    const connection = await this.requiredConnection(input.connectionId);
    const source = normalizeSource(input.source ?? (await this.sourceFor(connection)));
    const tableName = connection.tableName ?? source.tableName ?? 'dataset';
    const schema = input.schema === undefined ? schemaFor(source, tableName) : clone(input.schema);
    const versions = this.state?.datasets.filter((item) => item.datasetId === datasetId) ?? [];
    const version = Math.max(0, ...versions.map((item) => item.version)) + 1;
    const createdAt = this.clock();
    const canonical = JSON.stringify({
      tableName,
      columns: sourceColumns(source),
      rows: source.rows,
    });
    const contentHash = `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
    const previous = versions.at(-1);
    const lineage = [
      ...(input.lineage ?? [
        {
          relation: 'synced-from' as const,
          reference: input.sourceReference,
          connectionId: connection.connectionId,
        },
      ]),
      ...(previous === undefined
        ? []
        : [
            {
              relation: 'derived-from' as const,
              reference: previous.artifactId,
              datasetId,
              version: previous.version,
              connectionId: previous.sourceConnectionId,
            },
          ]),
    ];
    const dataset: StoredDataset = {
      schemaVersion: 1,
      datasetId,
      name,
      version,
      artifactId: `dataset-${datasetId}-v${version}`,
      sourceConnectionId: connection.connectionId,
      sourceReference: required(input.sourceReference, 'sourceReference'),
      mediaType: input.mediaType ?? 'application/json',
      contentHash,
      sizeBytes: Buffer.byteLength(canonical, 'utf8'),
      rowCount: source.rows.length,
      schema,
      immutable: true,
      lineage: clone(lineage),
      createdAt,
      source: sourceForTable(source, tableName),
    };
    this.state?.datasets.push(dataset);
    await this.persist();
    return this.publicDataset(dataset);
  }

  async getDatasetVersion(
    datasetId: string,
    version?: number,
  ): Promise<DatasetVersionV1 | undefined> {
    await this.ensureLoaded();
    const versions = this.state?.datasets.filter((item) => item.datasetId === datasetId) ?? [];
    const selected =
      version === undefined ? versions.at(-1) : versions.find((item) => item.version === version);
    return selected === undefined ? undefined : this.publicDataset(selected);
  }

  async listDatasetVersions(datasetId?: string): Promise<readonly DatasetVersionV1[]> {
    await this.ensureLoaded();
    return clone(
      (this.state?.datasets ?? [])
        .filter((item) => datasetId === undefined || item.datasetId === datasetId)
        .map((item) => this.publicDataset(item)),
    );
  }

  async lineage(
    datasetId: string,
    version?: number,
  ): Promise<readonly DatasetLineageReferenceV1[]> {
    const dataset = await this.getStoredDataset(datasetId, version);
    return dataset === undefined ? [] : clone(dataset.lineage);
  }

  async profileDataset(datasetId: string, version?: number): Promise<DataProfileV1> {
    const dataset = await this.getStoredDataset(datasetId, version);
    if (dataset === undefined) {
      throw runtimeError('ARTIFACT_NOT_FOUND', `Dataset ${datasetId} was not found`);
    }
    const rows = sourceRows(dataset.source);
    const fields = dataset.schema.fields.map((field, index) => {
      const values = rows.map((row) => row[index] ?? null);
      const statistics = fieldStatistics(values);
      const type = fieldType(values);
      return {
        name: field.name,
        type,
        nullable: values.some((value) => value === null),
        ...statistics,
        anomalies: fieldAnomalies(type, statistics),
      };
    });
    const generatedAt = this.clock();
    const profile: DataProfileV1 = {
      schemaVersion: 1,
      profileId: `profile-${dataset.datasetId}-v${dataset.version}`,
      datasetId: dataset.datasetId,
      datasetVersion: dataset.version,
      sourceConnectionId: dataset.sourceConnectionId,
      tableName: dataset.schema.tableName,
      rowCount: rows.length,
      fields,
      generatedAt,
      lineage: clone(dataset.lineage),
    };
    await this.ensureLoaded();
    const existing =
      this.state?.profiles.findIndex((item) => item.profileId === profile.profileId) ?? -1;
    if (existing >= 0 && this.state) this.state.profiles[existing] = profile;
    else this.state?.profiles.push(profile);
    await this.persist();
    return clone(profile);
  }

  async getDatasetProfile(datasetId: string, version?: number): Promise<DataProfileV1 | undefined> {
    await this.ensureLoaded();
    const dataset = await this.getStoredDataset(datasetId, version);
    if (dataset === undefined) return undefined;
    const profile = this.state?.profiles.find(
      (item) => item.datasetId === dataset.datasetId && item.datasetVersion === dataset.version,
    );
    return profile === undefined ? undefined : clone(profile);
  }

  async qualityDataset(request: DataQualityRequestV1): Promise<DataQualityResultV1> {
    const dataset = await this.getStoredDataset(request.datasetId, request.datasetVersion);
    if (dataset === undefined) {
      throw runtimeError('ARTIFACT_NOT_FOUND', `Dataset ${request.datasetId} was not found`);
    }
    const rows = sourceRows(dataset.source);
    const columns = sourceColumns(dataset.source);
    const checks: DataQualityCheckV1[] = [];
    const duplicateRows = rows.length - new Set(rows.map((row) => JSON.stringify(row))).size;
    checks.push({
      checkId: 'non-empty',
      name: 'Dataset is non-empty',
      status: rows.length === 0 ? 'failed' : 'passed',
      observed: rows.length,
      threshold: 1,
      message: rows.length === 0 ? 'The dataset has no rows.' : 'The dataset contains rows.',
    });
    checks.push({
      checkId: 'duplicate-rows',
      name: 'Duplicate rows',
      status: duplicateRows === 0 ? 'passed' : 'warned',
      observed: duplicateRows,
      threshold: 0,
      message:
        duplicateRows === 0
          ? 'No duplicate rows were detected.'
          : `${duplicateRows} duplicate row${duplicateRows === 1 ? '' : 's'} detected.`,
    });
    for (const field of request.requiredFields ?? []) {
      const index = columns.indexOf(field);
      const missing = index < 0 ? rows.length : rows.filter((row) => row[index] === null).length;
      checks.push({
        checkId: `required:${field}`,
        name: `Required field ${field}`,
        status: missing === 0 ? 'passed' : 'failed',
        observed: missing,
        threshold: 0,
        message:
          missing === 0
            ? `${field} is present for every row.`
            : `${field} is missing for ${missing} row${missing === 1 ? '' : 's'}.`,
      });
    }
    const maxNullFraction = request.maxNullFraction ?? 0.5;
    for (const [index, field] of columns.entries()) {
      const nullCount = rows.filter((row) => row[index] === null).length;
      const nullFraction = rows.length === 0 ? 0 : nullCount / rows.length;
      if (nullFraction > 0) {
        checks.push({
          checkId: `null-rate:${field}`,
          name: `Null rate ${field}`,
          status: nullFraction > maxNullFraction ? 'failed' : 'warned',
          observed: nullFraction,
          threshold: maxNullFraction,
          message: `${field} has ${(nullFraction * 100).toFixed(1)}% null values.`,
        });
      }
    }
    const status: DataQualityStatus = checks.some((check) => check.status === 'failed')
      ? 'failed'
      : checks.some((check) => check.status === 'warned')
        ? 'warned'
        : 'passed';
    const generatedAt = this.clock();
    const result: DataQualityResultV1 = {
      schemaVersion: 1,
      qualityId: `quality-${dataset.datasetId}-v${dataset.version}`,
      datasetId: dataset.datasetId,
      datasetVersion: dataset.version,
      rowCount: rows.length,
      status,
      checks,
      generatedAt,
      lineage: clone(dataset.lineage),
    };
    await this.ensureLoaded();
    const existing =
      this.state?.qualityResults.findIndex((item) => item.qualityId === result.qualityId) ?? -1;
    if (existing >= 0 && this.state) this.state.qualityResults[existing] = result;
    else this.state?.qualityResults.push(result);
    await this.persist();
    return clone(result);
  }

  async getDatasetQuality(
    datasetId: string,
    version?: number,
  ): Promise<DataQualityResultV1 | undefined> {
    await this.ensureLoaded();
    const dataset = await this.getStoredDataset(datasetId, version);
    if (dataset === undefined) return undefined;
    const result = this.state?.qualityResults.find(
      (item) => item.datasetId === dataset.datasetId && item.datasetVersion === dataset.version,
    );
    return result === undefined ? undefined : clone(result);
  }

  async executeQuery(request: DatasetQueryRequestV1): Promise<DatasetQueryRecordV1> {
    await this.ensureLoaded();
    const queryId = safeId(request.queryId, 'queryId');
    let source = request.source;
    let connectionId = request.connectionId;
    let datasetVersion = request.datasetVersion;
    if (request.datasetId !== undefined) {
      const dataset = await this.getStoredDataset(request.datasetId, request.datasetVersion);
      if (dataset === undefined) {
        throw runtimeError('ARTIFACT_NOT_FOUND', `Dataset ${request.datasetId} was not found`);
      }
      source = dataset.source;
      connectionId = dataset.sourceConnectionId;
      datasetVersion = dataset.version;
    } else if (source === undefined && connectionId !== undefined) {
      source = await this.sourceFor(await this.requiredConnection(connectionId));
    }
    const result = await this.query.execute({
      queryId,
      sql: required(request.sql, 'SQL'),
      ...(request.parameters === undefined ? {} : { parameters: request.parameters }),
      ...(source === undefined ? {} : { source }),
      ...(request.maxRows === undefined ? { maxRows: this.maxRows } : { maxRows: request.maxRows }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      ...(request.costLimit === undefined ? {} : { costLimit: request.costLimit }),
    });
    const record: DatasetQueryRecordV1 = {
      queryId,
      sql: request.sql,
      ...(connectionId === undefined ? {} : { connectionId }),
      ...(request.datasetId === undefined ? {} : { datasetId: request.datasetId }),
      ...(datasetVersion === undefined ? {} : { datasetVersion }),
      ...(request.savedQueryId === undefined ? {} : { savedQueryId: request.savedQueryId }),
      result,
      createdAt: this.clock(),
    };
    const existing = this.state?.queries.findIndex((item) => item.queryId === queryId) ?? -1;
    if (existing >= 0 && this.state) this.state.queries[existing] = record;
    else this.state?.queries.push(record);
    await this.persist();
    return clone(record);
  }

  async explainQuery(request: DatasetQueryRequestV1): Promise<QueryPlanV1> {
    await this.ensureLoaded();
    let source = request.source;
    if (request.datasetId !== undefined) {
      const dataset = await this.getStoredDataset(request.datasetId, request.datasetVersion);
      if (dataset === undefined) {
        throw runtimeError('ARTIFACT_NOT_FOUND', `Dataset ${request.datasetId} was not found`);
      }
      source = dataset.source;
    } else if (source === undefined && request.connectionId !== undefined) {
      source = await this.sourceFor(await this.requiredConnection(request.connectionId));
    }
    return this.query.explain({
      queryId: safeId(request.queryId, 'queryId'),
      sql: required(request.sql, 'SQL'),
      ...(request.parameters === undefined ? {} : { parameters: request.parameters }),
      ...(source === undefined ? {} : { source }),
      ...(request.maxRows === undefined ? {} : { maxRows: request.maxRows }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      ...(request.costLimit === undefined ? {} : { costLimit: request.costLimit }),
    });
  }

  async cancelQuery(queryId: string): Promise<boolean> {
    return this.query.cancel(safeId(queryId, 'queryId'));
  }

  async getQueryResult(queryId: string): Promise<DatasetQueryRecordV1 | undefined> {
    await this.ensureLoaded();
    const result = this.state?.queries.find((item) => item.queryId === queryId);
    return result === undefined ? undefined : clone(result);
  }

  async listQueries(): Promise<readonly DatasetQueryRecordV1[]> {
    await this.ensureLoaded();
    return clone(this.state?.queries ?? []);
  }

  async saveQuery(input: DataSavedQueryInputV1): Promise<DataSavedQueryV1> {
    await this.ensureLoaded();
    const savedQueryId = safeId(input.savedQueryId, 'savedQueryId');
    const name = required(input.name, 'saved query name');
    const sql = required(input.sql, 'SQL');
    const validation = this.query.validate(sql);
    if (!validation.valid) {
      throw runtimeError('VALIDATION_INVALID_INPUT', validation.error ?? 'SQL is invalid');
    }
    const existing = this.state?.savedQueries.find((item) => item.savedQueryId === savedQueryId);
    const now = this.clock();
    const saved: DataSavedQueryV1 = {
      schemaVersion: 1,
      savedQueryId,
      name,
      sql,
      ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
      ...(input.datasetId === undefined ? {} : { datasetId: input.datasetId }),
      ...(input.datasetVersion === undefined ? {} : { datasetVersion: input.datasetVersion }),
      ...(input.parameters === undefined ? {} : { parameters: clone(input.parameters) }),
      ...(input.maxRows === undefined ? {} : { maxRows: input.maxRows }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.costLimit === undefined ? {} : { costLimit: input.costLimit }),
      revision: (existing?.revision ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const index =
      this.state?.savedQueries.findIndex((item) => item.savedQueryId === savedQueryId) ?? -1;
    if (index >= 0 && this.state) this.state.savedQueries[index] = saved;
    else this.state?.savedQueries.push(saved);
    await this.persist();
    return clone(saved);
  }

  async getSavedQuery(savedQueryId: string): Promise<DataSavedQueryV1 | undefined> {
    await this.ensureLoaded();
    const saved = this.state?.savedQueries.find((item) => item.savedQueryId === savedQueryId);
    return saved === undefined ? undefined : clone(saved);
  }

  async listSavedQueries(): Promise<readonly DataSavedQueryV1[]> {
    await this.ensureLoaded();
    return clone(this.state?.savedQueries ?? []);
  }

  async exportQueryResult(
    queryId: string,
    format: DataExportFormat = 'json',
    destinationPath?: string,
  ): Promise<DataQueryExportV1> {
    await this.ensureLoaded();
    const normalizedQueryId = safeId(queryId, 'queryId');
    const record = await this.getQueryResult(normalizedQueryId);
    if (record === undefined) {
      throw runtimeError('ARTIFACT_NOT_FOUND', `Query ${queryId} was not found`);
    }
    if (format !== 'json' && format !== 'csv') {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Export format must be json or csv');
    }
    const path = this.safePath(
      destinationPath ?? join('.agentic', 'exports', `${normalizedQueryId}.${format}`),
    );
    const content =
      format === 'json'
        ? `${JSON.stringify({ columns: record.result.columns, rows: record.result.rows }, null, 2)}\n`
        : csvResult(record.result);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, content, { mode: 0o600 });
    const contentHash = createHash('sha256').update(content).digest('hex');
    const exported: DataQueryExportV1 = {
      schemaVersion: 1,
      exportId: `export-${normalizedQueryId}-${format}`,
      queryId: normalizedQueryId,
      format,
      path,
      artifactId: `query-export-${normalizedQueryId}-${contentHash.slice(0, 16)}`,
      contentHash: `sha256:${contentHash}`,
      mediaType: format === 'json' ? 'application/json' : 'text/csv',
      sizeBytes: Buffer.byteLength(content, 'utf8'),
      createdAt: this.clock(),
      lineage: queryLineage(record),
    };
    const index =
      this.state?.exports.findIndex((item) => item.exportId === exported.exportId) ?? -1;
    if (index >= 0 && this.state) this.state.exports[index] = exported;
    else this.state?.exports.push(exported);
    await this.persist();
    return clone(exported);
  }

  async createQueryHandoff(
    queryId: string,
    target: DataHandoffTarget,
  ): Promise<DataQueryHandoffV1> {
    await this.ensureLoaded();
    const normalizedQueryId = safeId(queryId, 'queryId');
    const record = await this.getQueryResult(normalizedQueryId);
    if (record === undefined) {
      throw runtimeError('ARTIFACT_NOT_FOUND', `Query ${queryId} was not found`);
    }
    if (target !== 'browser' && target !== 'jupyter') {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Handoff target must be browser or jupyter');
    }
    const createdAt = this.clock();
    const handoff: DataQueryHandoffV1 = {
      schemaVersion: 1,
      handoffId: `handoff-${normalizedQueryId}-${target}`,
      queryId: normalizedQueryId,
      target,
      route:
        target === 'browser'
          ? `/sql?queryId=${encodeURIComponent(normalizedQueryId)}`
          : `/v1/data/queries/${encodeURIComponent(normalizedQueryId)}`,
      ...(record.connectionId === undefined ? {} : { connectionId: record.connectionId }),
      ...(record.datasetId === undefined ? {} : { datasetId: record.datasetId }),
      ...(record.datasetVersion === undefined ? {} : { datasetVersion: record.datasetVersion }),
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + 60 * 60 * 1000).toISOString(),
      lineage: queryLineage(record),
    };
    const index =
      this.state?.handoffs.findIndex((item) => item.handoffId === handoff.handoffId) ?? -1;
    if (index >= 0 && this.state) this.state.handoffs[index] = handoff;
    else this.state?.handoffs.push(handoff);
    await this.persist();
    return clone(handoff);
  }

  private publicDataset(dataset: StoredDataset): DatasetVersionV1 {
    const { source: _source, ...publicValue } = dataset;
    void _source;
    return clone(publicValue);
  }

  private async getStoredDataset(
    datasetId: string,
    version?: number,
  ): Promise<StoredDataset | undefined> {
    await this.ensureLoaded();
    const versions = this.state?.datasets.filter((item) => item.datasetId === datasetId) ?? [];
    return version === undefined
      ? versions.at(-1)
      : versions.find((item) => item.version === version);
  }

  private async requiredConnection(connectionId: string): Promise<StoredConnection> {
    await this.ensureLoaded();
    const connection = this.state?.connections.find((item) => item.connectionId === connectionId);
    if (connection === undefined) {
      throw runtimeError('ARTIFACT_NOT_FOUND', `Data connection ${connectionId} was not found`);
    }
    return connection;
  }

  private async sourceFor(connection: StoredConnection): Promise<QuerySource> {
    if (connection.source !== undefined) return normalizeSource(connection.source);
    if (connection.path === undefined) {
      throw runtimeError(
        'COMPUTE_RESOURCE_UNAVAILABLE',
        `Data connection ${connection.connectionId} has no readable source`,
      );
    }
    const value = await readFile(connection.path, 'utf8');
    if (Buffer.byteLength(value, 'utf8') > MAX_SOURCE_BYTES) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Data file exceeds the 25 MB local limit');
    }
    return normalizeSource(fileSource(connection.path, value));
  }

  private safePath(path: string): string {
    const candidate = isAbsolute(path) ? resolve(path) : resolve(this.rootPath, path);
    const rel = relative(this.rootPath, candidate);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw runtimeError('POLICY_DENIED', 'Data file must stay inside the workspace');
    }
    return candidate;
  }

  private async replaceSourceStatus(
    sourceId: string,
    status: DataConnectionStatus,
    updatedAt: string,
    lastDiscoveredAt?: string,
  ): Promise<void> {
    await this.ensureLoaded();
    const index = this.state?.sources.findIndex((source) => source.sourceId === sourceId) ?? -1;
    if (index < 0 || this.state === undefined) return;
    const source = this.state.sources[index];
    if (source === undefined) return;
    this.state.sources[index] = {
      ...source,
      status,
      updatedAt,
      ...(lastDiscoveredAt === undefined ? {} : { lastDiscoveredAt }),
    };
    await this.persist();
  }

  private async replaceConnection(connection: StoredConnection): Promise<void> {
    await this.ensureLoaded();
    const index =
      this.state?.connections.findIndex((item) => item.connectionId === connection.connectionId) ??
      -1;
    if (index < 0) return;
    if (this.state) this.state.connections[index] = connection;
    await this.persist();
  }

  private async ensureLoaded(): Promise<void> {
    if (this.state) return;
    this.loading ??= (async () => {
      try {
        const raw = JSON.parse(await readFile(this.statePath, 'utf8')) as unknown;
        const migrated = migrateDatasetState(raw, this.clock());
        if (migrated === undefined) throw new Error('Invalid data catalog state');
        this.state = migrated.state;
        if (migrated.migrated) await this.persist();
      } catch {
        this.state = {
          schemaVersion: 1,
          connections: [],
          sources: [],
          datasets: [],
          queries: [],
          profiles: [],
          qualityResults: [],
          savedQueries: [],
          exports: [],
          handoffs: [],
        };
      }
    })();
    await this.loading;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.statePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporaryPath, this.statePath);
  }
}

export const LocalDataCatalogRuntime = LocalDataCatalogRuntimeImpl;
export const LocalDataRuntime = LocalDataCatalogRuntimeImpl;
