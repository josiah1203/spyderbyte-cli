import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  runtimeError,
  type JsonPrimitive,
  type JsonValue,
} from '@agentic-platform/runtime-contracts';

export interface QuerySource {
  readonly tableName?: string;
  readonly columns?: readonly string[];
  readonly rows: readonly (readonly JsonValue[])[] | readonly Record<string, JsonValue>[];
}

export interface QueryExecutionRequest {
  readonly queryId: string;
  readonly sql: string;
  readonly parameters?: Readonly<Record<string, JsonPrimitive>>;
  readonly source?: QuerySource;
  readonly maxRows?: number;
  readonly timeoutMs?: number;
  readonly costLimit?: number;
}

export interface QueryValidationResultV1 {
  readonly valid: boolean;
  readonly error?: string;
  readonly approvalRequired?: boolean;
}

export interface QueryColumn {
  readonly name: string;
  readonly type: 'string' | 'number' | 'boolean' | 'null' | 'unknown';
}

export interface QueryResultArtifact {
  readonly artifactId: string;
  readonly contentHash: string;
  readonly mediaType: 'application/json';
  readonly createdAt: string;
}

export interface QueryPlanV1 {
  readonly queryId: string;
  readonly engine: 'duckdb' | 'sqlite3-local-fallback';
  readonly sql: string;
  readonly estimatedRows: number;
  readonly estimatedCost: number;
  readonly steps: readonly (readonly JsonValue[])[];
  readonly createdAt: string;
}

export interface QueryExecutionResult {
  readonly queryId: string;
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly engine: 'duckdb' | 'sqlite3-local-fallback';
  readonly sql: string;
  readonly columns: readonly QueryColumn[];
  readonly rows: readonly (readonly JsonValue[])[];
  readonly rowCount: number;
  readonly truncated: boolean;
  readonly estimatedCost: number;
  readonly elapsedMs: number;
  readonly executedAt: string;
  readonly artifact: QueryResultArtifact;
  readonly error?: string;
}

export interface QueryRuntime {
  validate(sql: string): QueryValidationResultV1;
  execute(request: QueryExecutionRequest): Promise<QueryExecutionResult>;
  explain(request: QueryExecutionRequest): Promise<QueryPlanV1>;
  cancel(queryId: string): boolean;
  result(queryId: string): QueryExecutionResult | undefined;
}

interface BridgeResponse {
  readonly engine?: 'duckdb' | 'sqlite3-local-fallback';
  readonly columns?: readonly QueryColumn[];
  readonly rows?: readonly (readonly JsonValue[])[];
  readonly truncated?: boolean;
  readonly error?: string;
}

const PYTHON_SQL_BRIDGE = String.raw`
import json, sys

try:
    import duckdb
    db = duckdb.connect(':memory:')
    engine = 'duckdb'
except ImportError:
    import sqlite3
    db = sqlite3.connect(':memory:')
    engine = 'sqlite3-local-fallback'

def quote(value):
    return '"' + str(value).replace('"', '""') + '"'

def json_value(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)

try:
    payload = json.load(sys.stdin)
    table = payload.get('tableName') or 'dataset'
    rows = payload.get('rows') or []
    columns = payload.get('columns') or []
    if rows and isinstance(rows[0], dict):
        if not columns:
            columns = list(rows[0].keys())
        rows = [[row.get(column) for column in columns] for row in rows]
    if not columns:
        columns = ['value']
    types = []
    for index, column in enumerate(columns):
        values = [row[index] for row in rows if index < len(row) and row[index] is not None]
        if values and all(isinstance(value, bool) for value in values):
            data_type = 'BOOLEAN'
        elif values and all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in values):
            data_type = 'DOUBLE'
        else:
            data_type = 'VARCHAR'
        types.append(quote(column) + ' ' + data_type)
    db.execute('CREATE TABLE ' + quote(table) + ' (' + ', '.join(types) + ')')
    if rows:
        placeholders = ', '.join('?' for _ in columns)
        db.executemany('INSERT INTO ' + quote(table) + ' VALUES (' + placeholders + ')', rows)
    params = payload.get('parameters') or {}
    cursor = db.execute(payload['sql'], params)
    names = [item[0] for item in (cursor.description or [])]
    limit = int(payload.get('maxRows') or 1000)
    fetched = cursor.fetchmany(limit + 1)
    truncated = len(fetched) > limit
    fetched = fetched[:limit]
    output = {
        'engine': engine,
        'columns': [{'name': name, 'type': 'unknown'} for name in names],
        'rows': [[json_value(value) for value in row] for row in fetched],
        'truncated': truncated,
    }
    print(json.dumps(output, separators=(',', ':')))
except Exception as error:
    print(json.dumps({'error': str(error)}, separators=(',', ':')))
`;

function primitiveType(value: JsonValue): QueryColumn['type'] {
  if (value === null) return 'null';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'unknown';
}

function validateSql(sql: string): QueryValidationResultV1 {
  const normalized = sql.trim();
  if (normalized.length === 0) return { valid: false, error: 'SQL is required.' };
  if (normalized.length > 200_000) return { valid: false, error: 'SQL exceeds the 200 KB limit.' };
  const withoutTrailingSemicolon = normalized.replace(/;\s*$/, '');
  if (withoutTrailingSemicolon.includes(';')) {
    return { valid: false, error: 'Only one SQL statement may be executed at a time.' };
  }
  if (!/^(select|with|explain)\b/i.test(withoutTrailingSemicolon)) {
    const approvalRequired =
      /^(insert|update|delete|merge|create|alter|drop|truncate|replace|grant|revoke|attach|detach|vacuum|reindex)\b/i.test(
        withoutTrailingSemicolon,
      );
    return {
      valid: false,
      error:
        'Only read-only SELECT, WITH, and EXPLAIN statements are allowed. Destructive SQL is approval-gated and disabled in the local runtime.',
      ...(approvalRequired ? { approvalRequired: true } : {}),
    };
  }
  return { valid: true };
}

function normalizedSql(sql: string): string {
  return sql.trim().replace(/;\s*$/, '');
}

function estimateCost(source: QuerySource | undefined): number {
  const rowCount = source?.rows.length ?? 0;
  const columnCount = source?.columns?.length ?? 1;
  return Math.max(1, Math.ceil(((rowCount + 1) * Math.max(1, columnCount)) / 100));
}

function artifactFor(
  queryId: string,
  rows: readonly (readonly JsonValue[])[],
  executedAt: string,
): QueryResultArtifact {
  const contentHash = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  return {
    artifactId: `query-result-${queryId}-${contentHash.slice(0, 16)}`,
    contentHash: `sha256:${contentHash}`,
    mediaType: 'application/json',
    createdAt: executedAt,
  };
}

function rowObjectsToArrays(source: QuerySource): {
  columns: readonly string[];
  rows: readonly (readonly JsonValue[])[];
} {
  const first = source.rows[0];
  if (Array.isArray(first)) {
    return {
      columns: source.columns ?? first.map((_, index) => `column_${index + 1}`),
      rows: source.rows as readonly (readonly JsonValue[])[],
    };
  }
  const objects = source.rows as readonly Record<string, JsonValue>[];
  const columns = source.columns ?? [...new Set(objects.flatMap((row) => Object.keys(row)))];
  return { columns, rows: objects.map((row) => columns.map((column) => row[column] ?? null)) };
}

export class LocalQueryRuntime implements QueryRuntime {
  private readonly results = new Map<string, QueryExecutionResult>();
  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();

  validate(sql: string): QueryValidationResultV1 {
    return validateSql(sql);
  }

  async execute(request: QueryExecutionRequest): Promise<QueryExecutionResult> {
    const validation = this.validate(request.sql);
    if (!validation.valid)
      throw runtimeError('VALIDATION_INVALID_INPUT', validation.error ?? 'SQL is invalid');
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(request.queryId)) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'queryId is invalid');
    }
    const maxRows = Math.max(1, Math.min(request.maxRows ?? 1000, 10_000));
    const timeoutMs = Math.max(100, Math.min(request.timeoutMs ?? 30_000, 120_000));
    const source =
      request.source === undefined
        ? { columns: ['value'], rows: [] as JsonValue[][] }
        : rowObjectsToArrays(request.source);
    const estimatedCost = estimateCost(request.source);
    if (request.costLimit !== undefined && estimatedCost > request.costLimit) {
      throw runtimeError(
        'POLICY_DENIED',
        `Estimated query cost ${estimatedCost} exceeds the limit ${request.costLimit}`,
      );
    }
    const started = Date.now();
    const executedAt = new Date().toISOString();
    const response = await this.runBridge(
      request.queryId,
      {
        sql: normalizedSql(request.sql),
        tableName: request.source?.tableName ?? 'dataset',
        columns: [...source.columns],
        rows: source.rows.map((row) => [...row]),
        parameters: request.parameters ?? {},
        maxRows,
      },
      timeoutMs,
    );
    const rows = response.rows ?? [];
    const columns = (response.columns ?? []).map((column, index) => ({
      ...column,
      type:
        column.type === 'unknown' && rows[0]?.[index] !== undefined
          ? primitiveType(rows[0][index] as JsonValue)
          : column.type,
    }));
    const result: QueryExecutionResult = {
      queryId: request.queryId,
      status: response.error === undefined ? 'completed' : 'failed',
      engine: response.engine ?? 'sqlite3-local-fallback',
      sql: request.sql,
      columns,
      rows,
      rowCount: rows.length,
      truncated: response.truncated === true,
      estimatedCost,
      elapsedMs: Date.now() - started,
      executedAt,
      artifact: artifactFor(request.queryId, rows, executedAt),
      ...(response.error === undefined ? {} : { error: response.error }),
    };
    this.results.set(request.queryId, result);
    return structuredClone(result);
  }

  async explain(request: QueryExecutionRequest): Promise<QueryPlanV1> {
    const validation = this.validate(request.sql);
    if (!validation.valid) {
      throw runtimeError('VALIDATION_INVALID_INPUT', validation.error ?? 'SQL is invalid');
    }
    const sql = normalizedSql(request.sql);
    const explainSql = /^explain\b/i.test(sql) ? sql : `EXPLAIN ${sql}`;
    const result = await this.execute({
      ...request,
      queryId: `${request.queryId.slice(0, 148)}-explain`,
      sql: explainSql,
      maxRows: Math.min(request.maxRows ?? 100, 100),
      ...(request.costLimit === undefined ? {} : { costLimit: request.costLimit }),
    });
    return {
      queryId: request.queryId,
      engine: result.engine,
      sql,
      estimatedRows: request.source?.rows.length ?? 0,
      estimatedCost: estimateCost(request.source),
      steps: result.rows,
      createdAt: result.executedAt,
    };
  }

  cancel(queryId: string): boolean {
    const process = this.processes.get(queryId);
    if (process === undefined) return false;
    process.kill('SIGTERM');
    this.processes.delete(queryId);
    return true;
  }

  result(queryId: string): QueryExecutionResult | undefined {
    const result = this.results.get(queryId);
    return result === undefined ? undefined : structuredClone(result);
  }

  private runBridge(
    queryId: string,
    payload: Record<string, JsonValue>,
    timeoutMs: number,
  ): Promise<BridgeResponse> {
    return new Promise((resolve, reject) => {
      const executable = process.env['SPYDERBYTE_PYTHON'] ?? 'python3';
      const child = spawn(executable, ['-c', PYTHON_SQL_BRIDGE], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.processes.set(queryId, child);
      let output = '';
      let errors = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        this.processes.delete(queryId);
        reject(runtimeError('COMPUTE_RESOURCE_UNAVAILABLE', 'SQL execution timed out'));
      }, timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        errors += chunk.toString('utf8');
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        this.processes.delete(queryId);
        reject(
          runtimeError(
            'COMPUTE_RESOURCE_UNAVAILABLE',
            `Local SQL runtime could not start: ${error.message}`,
          ),
        );
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        this.processes.delete(queryId);
        if (signal !== null && signal !== undefined) {
          reject(runtimeError('COMPUTE_RESOURCE_UNAVAILABLE', 'SQL execution was cancelled'));
          return;
        }
        if (code !== 0 && output.trim().length === 0) {
          reject(
            runtimeError(
              'COMPUTE_RESOURCE_UNAVAILABLE',
              errors.trim() || 'Local SQL runtime failed',
            ),
          );
          return;
        }
        try {
          const parsed = JSON.parse(output) as BridgeResponse;
          resolve(parsed);
        } catch {
          reject(
            runtimeError(
              'COMPUTE_RESOURCE_UNAVAILABLE',
              errors.trim() || 'Local SQL runtime returned invalid output',
            ),
          );
        }
      });
      child.stdin.end(JSON.stringify(payload));
    });
  }
}
