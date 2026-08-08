import { useEffect, useMemo, useRef, useState } from 'react';
import CapabilityGate from '../components/CapabilityGate';
import RuntimeStateNotice from '../components/RuntimeStateNotice';
import {
  Badge,
  Button,
  Card,
  DataTable,
  Field,
  Input,
  Notice,
  SectionLabel,
  Select,
  Textarea,
} from '../components/primitives';
import type { JsonValue } from '../runtime/contracts';
import { useRuntime } from '../runtime/RuntimeProvider';
import { useRuntimeStore } from '../runtime/store';

interface QueryResult {
  queryId: string;
  status: 'completed' | 'failed' | 'cancelled';
  engine: string;
  sql: string;
  columns: Array<{ name: string; type: string }>;
  rows: Array<readonly JsonValue[]>;
  rowCount: number;
  truncated: boolean;
  estimatedCost?: number;
  elapsedMs: number;
  executedAt: string;
  artifact: { artifactId: string; contentHash: string; mediaType: string; createdAt: string };
  error?: string;
}

interface DurableQueryRecord {
  queryId: string;
  sql: string;
  connectionId?: string;
  datasetId?: string;
  result: QueryResult;
  datasetVersion?: number;
}

type SourceRow = JsonValue[];

function parseCsv(text: string): { columns: string[]; rows: SourceRow[] } {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === ',' && !quoted) {
      record.push(cell);
      cell = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      record.push(cell);
      if (record.some((value) => value.length > 0)) records.push(record);
      record = [];
      cell = '';
    } else cell += character;
  }
  if (cell.length > 0 || record.length > 0) {
    record.push(cell);
    if (record.some((value) => value.length > 0)) records.push(record);
  }
  const columns = records[0]?.map((value, index) => value.trim() || `column_${index + 1}`) ?? [];
  return {
    columns,
    rows: records.slice(1).map((row) =>
      columns.map((_, index) => {
        const value = row[index] ?? '';
        if (value.trim() === '') return null;
        const number = Number(value);
        return Number.isFinite(number) ? number : value;
      }),
    ),
  };
}

function parseJson(text: string): { columns: string[]; rows: SourceRow[] } {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error('JSON input must be an array of objects or arrays.');
  if (parsed.length === 0) return { columns: [], rows: [] };
  const first = parsed[0];
  if (Array.isArray(first)) {
    return {
      columns: first.map((_, index) => `column_${index + 1}`),
      rows: parsed.map((row) => (Array.isArray(row) ? (row as SourceRow) : [])),
    };
  }
  if (first === null || typeof first !== 'object')
    throw new Error('JSON rows must be objects or arrays.');
  const columns = [
    ...new Set(
      parsed.flatMap((row) =>
        row !== null && typeof row === 'object' && !Array.isArray(row) ? Object.keys(row) : [],
      ),
    ),
  ];
  return {
    columns,
    rows: parsed.map((row) =>
      columns.map((column) => {
        if (row === null || typeof row !== 'object' || Array.isArray(row)) return null;
        const value = (row as Record<string, unknown>)[column];
        return value === null ||
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean'
          ? value
          : JSON.stringify(value);
      }),
    ),
  };
}

function queryId(): string {
  const random =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `sql-${random}`;
}

function queryIdFromLocation(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const value = new URLSearchParams(window.location.search).get('queryId');
  return value !== null && /^[A-Za-z0-9._:-]{1,160}$/.test(value) ? value : undefined;
}

export default function SQLWorkbench() {
  const runtime = useRuntime();
  const snapshot = useRuntimeStore(runtime);
  const fileInput = useRef<HTMLInputElement>(null);
  const initialQueryId = useRef(queryIdFromLocation());
  const queryLoadAttempted = useRef(false);
  const [sql, setSql] = useState('SELECT * FROM dataset LIMIT 100');
  const [tableName, setTableName] = useState('dataset');
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<SourceRow[]>([]);
  const [sourceLabel, setSourceLabel] = useState(
    'No file loaded · use the dataset table for an empty local source',
  );
  const [result, setResult] = useState<QueryResult>();
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [validated, setValidated] = useState<boolean>();
  const [currentQueryId, setCurrentQueryId] = useState(() => initialQueryId.current ?? queryId());
  const [connectionId, setConnectionId] = useState('');
  const [datasetId, setDatasetId] = useState('');
  const [maxRows, setMaxRows] = useState('1000');
  const [costLimit, setCostLimit] = useState('10000');
  const [plan, setPlan] = useState<JsonValue>();

  const resultRows = useMemo(() => result?.rows ?? [], [result]);
  const resultColumns = result?.columns ?? [];

  useEffect(() => {
    const persistedQueryId = initialQueryId.current;
    if (
      queryLoadAttempted.current ||
      persistedQueryId === undefined ||
      snapshot.connection === 'booting' ||
      runtime.client.get === undefined
    ) {
      return undefined;
    }
    queryLoadAttempted.current = true;
    let cancelled = false;
    setBusy(true);
    void runtime.client
      .get<DurableQueryRecord>(`/v1/data/queries/${encodeURIComponent(persistedQueryId)}`)
      .then((record) => {
        if (cancelled) return;
        setCurrentQueryId(record.queryId);
        setSql(record.sql);
        setConnectionId(record.connectionId ?? '');
        setDatasetId(record.datasetId ?? '');
        setResult(record.result);
        setValidated(record.result.status === 'completed');
        setMessage(
          `Loaded persisted query result ${record.result.artifact.artifactId} from the workspace.`,
        );
      })
      .catch((error: unknown) => {
        if (!cancelled) setMessage(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runtime, snapshot.connection]);

  async function validate(): Promise<void> {
    if (!runtime.client.post) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const response = await runtime.client.post<{
        valid: boolean;
        error?: string;
        approvalRequired?: boolean;
      }>(`/v1/data/queries/${encodeURIComponent(currentQueryId)}/validate`, { sql });
      setValidated(response.valid);
      setMessage(
        response.valid
          ? 'Read-only SQL is valid.'
          : response.approvalRequired
            ? 'Destructive SQL requires approval and is disabled in the local runtime.'
            : (response.error ?? 'SQL is invalid.'),
      );
    } catch (error) {
      setValidated(false);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function run(): Promise<void> {
    if (!runtime.client.post) return;
    setBusy(true);
    setMessage(undefined);
    setValidated(undefined);
    try {
      const nextId = currentQueryId || queryId();
      const response = await runtime.client.post<DurableQueryRecord>('/v1/data/queries', {
        queryId: nextId,
        sql,
        ...(connectionId.trim() ? { connectionId: connectionId.trim() } : {}),
        ...(datasetId.trim() ? { datasetId: datasetId.trim() } : {}),
        source: { tableName, columns, rows },
        maxRows: Number(maxRows),
        costLimit: Number(costLimit),
        timeoutMs: 30_000,
      });
      setCurrentQueryId(nextId);
      setResult(response.result);
      setValidated(response.result.status === 'completed');
      setMessage(
        response.result.status === 'completed'
          ? `Returned ${response.result.rowCount} row${response.result.rowCount === 1 ? '' : 's'} in ${response.result.elapsedMs} ms.`
          : (response.result.error ?? 'Query failed.'),
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function cancel(): Promise<void> {
    if (!runtime.client.post) return;
    try {
      await runtime.client.post(
        `/v1/data/queries/${encodeURIComponent(currentQueryId)}/cancel`,
        {},
      );
      setMessage('Cancellation requested.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveQuery(): Promise<void> {
    if (!runtime.client.post) return;
    try {
      await runtime.client.post('/v1/data/saved-queries', {
        savedQueryId: currentQueryId,
        name: `SQL query ${new Date().toLocaleString()}`,
        sql,
        ...(connectionId.trim() ? { connectionId: connectionId.trim() } : {}),
        ...(datasetId.trim() ? { datasetId: datasetId.trim() } : {}),
        maxRows: Number(maxRows),
        costLimit: Number(costLimit),
      });
      setMessage('Query saved with a durable revision and lineage scope.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function explain(): Promise<void> {
    if (!runtime.client.post) return;
    setBusy(true);
    try {
      const response = await runtime.client.post(
        `/v1/data/queries/${encodeURIComponent(currentQueryId)}/explain`,
        {
          sql,
          ...(connectionId.trim() ? { connectionId: connectionId.trim() } : {}),
          ...(datasetId.trim() ? { datasetId: datasetId.trim() } : {}),
          source: { tableName, columns, rows },
          costLimit: Number(costLimit),
        },
      );
      setPlan(response as JsonValue);
      setMessage('Query plan and bounded cost estimate loaded.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function exportResult(): Promise<void> {
    if (!runtime.client.post) return;
    try {
      await runtime.client.post(`/v1/data/queries/${encodeURIComponent(currentQueryId)}/export`, {
        format: 'csv',
      });
      setMessage('CSV result export written to the workspace artifact directory.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function handoff(target: 'browser' | 'jupyter'): Promise<void> {
    if (!runtime.client.post) return;
    try {
      await runtime.client.post(`/v1/data/queries/${encodeURIComponent(currentQueryId)}/handoff`, {
        target,
      });
      setMessage(`Query handoff created for ${target}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function readFile(file: File): Promise<void> {
    try {
      const text = await file.text();
      const parsed =
        file.name.toLowerCase().endsWith('.json') || file.name.toLowerCase().endsWith('.jsonl')
          ? parseJson(
              file.name.toLowerCase().endsWith('.jsonl')
                ? `[${text.split(/\r?\n/).filter(Boolean).join(',')}]`
                : text,
            )
          : parseCsv(text);
      setColumns(parsed.columns);
      setRows(parsed.rows);
      setTableName(
        file.name.replace(/[^A-Za-z0-9_]/g, '_').replace(/^[^A-Za-z_]+/, '') || 'dataset',
      );
      setSourceLabel(
        `${file.name} · ${parsed.rows.length} rows · ${parsed.columns.length} columns`,
      );
      setMessage(
        'Local source loaded. The file remains in this workspace and is sent only to the local query runtime when you run SQL.',
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  const tableColumns = resultColumns.map((column, index) => ({
    key: `${column.name}-${index}`,
    header: (
      <span>
        {column.name}
        <small className="table-column-type">{column.type}</small>
      </span>
    ),
    render: (row: readonly JsonValue[]) => String(row[index] ?? '—'),
  }));

  return (
    <CapabilityGate page="sql">
      <div className="page-scroll">
        <div className="page stack">
          <div className="page-heading">
            <div>
              <SectionLabel>Executable data workspace</SectionLabel>
              <h1>SQL Workbench</h1>
              <p className="page-subtitle">
                Run read-only SQL locally, inspect bounded results, and keep the result artifact
                with its query lineage.
              </p>
            </div>
            <Badge color={validated === true ? 'green' : validated === false ? 'red' : 'gray'}>
              {validated === true
                ? 'Validated'
                : validated === false
                  ? 'Needs attention'
                  : 'Not validated'}
            </Badge>
          </div>
          {message && <Notice tone={validated === false ? 'danger' : 'info'}>{message}</Notice>}
          <RuntimeStateNotice state={snapshot.connection} onRetry={() => void runtime.retry()} />
          <div className="resource-editor-grid">
            <Card className="stack">
              <div className="card-heading">
                <div>
                  <h2>Query editor</h2>
                  <p>Only one read-only statement is accepted per run.</p>
                </div>
                <span className="home-list-subtitle">{currentQueryId}</span>
              </div>
              <Field
                label="SQL statement"
                hint="Use dataset as the local table name. Parameters are supported through the API contract."
              >
                <Textarea
                  value={sql}
                  onChange={(event) => setSql(event.target.value)}
                  rows={14}
                  spellCheck={false}
                />
              </Field>
              <div className="resource-editor-grid">
                <Field label="Connection ID" hint="Optional durable connection lineage scope.">
                  <Input
                    value={connectionId}
                    onChange={(event) => setConnectionId(event.target.value)}
                    placeholder="sales-connection"
                  />
                </Field>
                <Field
                  label="Dataset ID"
                  hint="Pin SQL to an immutable dataset version when available."
                >
                  <Input
                    value={datasetId}
                    onChange={(event) => setDatasetId(event.target.value)}
                    placeholder="sales-dataset"
                  />
                </Field>
                <Field label="Max rows">
                  <Input
                    type="number"
                    min="1"
                    max="10000"
                    value={maxRows}
                    onChange={(event) => setMaxRows(event.target.value)}
                  />
                </Field>
                <Field label="Cost limit">
                  <Input
                    type="number"
                    min="1"
                    value={costLimit}
                    onChange={(event) => setCostLimit(event.target.value)}
                  />
                </Field>
              </div>
              <div className="resource-editor-actions">
                <Button variant="secondary" loading={busy} onClick={() => void validate()}>
                  Validate
                </Button>
                <Button variant="secondary" loading={busy} onClick={() => void explain()}>
                  Explain
                </Button>
                <Button variant="secondary" disabled={!busy} onClick={() => void cancel()}>
                  Cancel
                </Button>
                <span className="toolbar-fill" />
                <Button variant="tertiary" onClick={() => void saveQuery()}>
                  Save version
                </Button>
                <Button variant="tertiary" disabled={!result} onClick={() => void exportResult()}>
                  Export CSV
                </Button>
                <Button loading={busy} onClick={() => void run()}>
                  Run query
                </Button>
              </div>
            </Card>
            <Card className="stack">
              <div className="card-heading">
                <div>
                  <h2>Local source</h2>
                  <p>Import CSV, JSON, or JSONL for analysis in the local runtime.</p>
                </div>
              </div>
              <Field label="Table name">
                <Input
                  value={tableName}
                  onChange={(event) =>
                    setTableName(event.target.value.replace(/[^A-Za-z0-9_]/g, '_'))
                  }
                />
              </Field>
              <input
                ref={fileInput}
                type="file"
                aria-label="Load a local CSV or JSON source"
                accept=".csv,.json,.jsonl,text/csv,application/json"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void readFile(file);
                }}
              />
              <Button variant="secondary" onClick={() => fileInput.current?.click()}>
                Load CSV / JSON
              </Button>
              <div className="resource-editor-actions">
                <Button
                  variant="tertiary"
                  disabled={!result}
                  onClick={() => void handoff('browser')}
                >
                  Browser handoff
                </Button>
                <Button
                  variant="tertiary"
                  disabled={!result}
                  onClick={() => void handoff('jupyter')}
                >
                  Jupyter handoff
                </Button>
              </div>
              <div className="home-state">{sourceLabel}</div>
              {columns.length > 0 && (
                <Select
                  value={tableName}
                  onChange={(event) => setTableName(event.target.value)}
                  aria-label="Source table"
                >
                  <option value={tableName}>
                    {tableName} · {columns.join(', ')}
                  </option>
                </Select>
              )}
            </Card>
          </div>
          <Card>
            <div className="card-heading">
              <div>
                <h2>Result set</h2>
                <p>
                  {result
                    ? `${result.rowCount} rows · ${result.engine} · ${result.artifact.artifactId}`
                    : 'Run a query to produce an immutable result artifact.'}
                </p>
              </div>
              {result?.truncated && <Badge color="amber">Row limit reached</Badge>}
            </div>
            <DataTable
              columns={tableColumns}
              rows={resultRows}
              getRowKey={(_, index) => `${currentQueryId}-${index}`}
              empty="No result rows yet. Run the query or load a source file."
            />
          </Card>
          {plan && (
            <Card className="stack">
              <div className="card-heading">
                <div>
                  <h2>Explain plan</h2>
                  <p>
                    Local engine plan, estimated rows, and bounded cost are retained for inspection.
                  </p>
                </div>
              </div>
              <pre className="code-block">{JSON.stringify(plan, null, 2)}</pre>
            </Card>
          )}
        </div>
      </div>
    </CapabilityGate>
  );
}
