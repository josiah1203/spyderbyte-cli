import { useMemo, useRef, useState } from 'react';
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
} from '../components/primitives';
import type { JsonValue } from '../runtime/contracts';
import { useRuntime } from '../runtime/RuntimeProvider';
import { useRuntimeStore } from '../runtime/store';

type VisualizationType =
  | 'table'
  | 'metric'
  | 'line'
  | 'bar'
  | 'scatter'
  | 'histogram'
  | 'time-series'
  | 'confusion-matrix';
type SourceRow = JsonValue[];

interface Point {
  x: JsonValue;
  y: number;
  series?: string;
}
interface RenderedVisualization {
  spec: { type: VisualizationType };
  title: string;
  status: 'rendered';
  columns: string[];
  rows: SourceRow[];
  series: Point[];
  artifactId: string;
  lineage: string[];
  renderedAt: string;
}

function parseSource(file: File, text: string): { columns: string[]; rows: SourceRow[] } {
  if (file.name.toLowerCase().endsWith('.json')) {
    const parsed: unknown = JSON.parse(text);
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      parsed[0] === null ||
      typeof parsed[0] !== 'object' ||
      Array.isArray(parsed[0])
    )
      throw new Error('JSON must be a non-empty array of objects.');
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
          const value =
            row !== null && typeof row === 'object' && !Array.isArray(row)
              ? (row as Record<string, unknown>)[column]
              : null;
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
  const records = text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => line.split(','));
  const columns = records[0]?.map((value, index) => value.trim() || `column_${index + 1}`) ?? [];
  return {
    columns,
    rows: records.slice(1).map((row) =>
      columns.map((_, index) => {
        const value = row[index]?.trim() ?? '';
        const number = Number(value);
        return value === '' ? null : Number.isFinite(number) ? number : value;
      }),
    ),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function Visualizations() {
  const runtime = useRuntime();
  const snapshot = useRuntimeStore(runtime);
  const fileInput = useRef<HTMLInputElement>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<SourceRow[]>([]);
  const [sourceLabel, setSourceLabel] = useState('Load CSV or JSON to render a chart locally.');
  const [type, setType] = useState<VisualizationType>('line');
  const [title, setTitle] = useState('Local visualization');
  const [xColumn, setXColumn] = useState('');
  const [yColumn, setYColumn] = useState('');
  const [rendered, setRendered] = useState<RenderedVisualization>();
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);

  const tableColumns = useMemo(
    () =>
      columns.map((column, index) => ({
        key: `${column}-${index}`,
        header: column,
        render: (row: SourceRow) => String(row[index] ?? '—'),
      })),
    [columns],
  );

  async function loadFile(file: File): Promise<void> {
    try {
      const parsed = parseSource(file, await file.text());
      setColumns(parsed.columns);
      setRows(parsed.rows);
      setXColumn(parsed.columns[0] ?? '');
      setYColumn(parsed.columns[1] ?? parsed.columns[0] ?? '');
      setSourceLabel(
        `${file.name} · ${parsed.rows.length} rows · ${parsed.columns.length} columns`,
      );
      setRendered(undefined);
      setMessage(undefined);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  async function render(): Promise<void> {
    if (!runtime.client.post) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await runtime.client.post<RenderedVisualization>('/v1/visualizations/render', {
        spec: { type, title, ...(xColumn ? { xColumn } : {}), ...(yColumn ? { yColumn } : {}) },
        columns,
        rows,
      });
      setRendered(result);
      setMessage(
        `Rendered ${result.title}. Artifact ${result.artifactId} preserves the source lineage.`,
      );
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const maxY = Math.max(...(rendered?.series.map((point) => point.y) ?? [1]), 1);
  const chartWidth = 640;
  const chartHeight = 220;
  const linePoints = rendered?.series
    .map(
      (point, index) =>
        `${(index / Math.max(1, rendered.series.length - 1)) * chartWidth},${chartHeight - (point.y / maxY) * (chartHeight - 20)}`,
    )
    .join(' ');

  return (
    <CapabilityGate page="visualizations">
      <div className="page-scroll">
        <div className="page stack">
          <div className="page-heading">
            <div>
              <SectionLabel>Executable analysis surface</SectionLabel>
              <h1>Visualization Builder</h1>
              <p className="page-subtitle">
                Bind a chart specification to local query or dataset rows and keep the rendered
                artifact lineage.
              </p>
            </div>
            <Badge color={rendered ? 'green' : 'gray'}>
              {rendered ? 'Rendered' : 'Not rendered'}
            </Badge>
          </div>
          {message && <Notice tone="info">{message}</Notice>}
          <RuntimeStateNotice state={snapshot.connection} onRetry={() => void runtime.retry()} />
          <div className="resource-editor-grid">
            <Card className="stack">
              <div className="card-heading">
                <div>
                  <h2>Chart specification</h2>
                  <p>Use the same contract for query, notebook, and dataset-backed charts.</p>
                </div>
              </div>
              <Field label="Title">
                <Input value={title} onChange={(event) => setTitle(event.target.value)} />
              </Field>
              <Field label="Chart type">
                <Select
                  value={type}
                  onChange={(event) => setType(event.target.value as VisualizationType)}
                >
                  {[
                    'table',
                    'metric',
                    'line',
                    'bar',
                    'scatter',
                    'histogram',
                    'time-series',
                    'confusion-matrix',
                  ].map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="X column">
                <Select value={xColumn} onChange={(event) => setXColumn(event.target.value)}>
                  <option value="">First column</option>
                  {columns.map((column) => (
                    <option key={column} value={column}>
                      {column}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Y column">
                <Select value={yColumn} onChange={(event) => setYColumn(event.target.value)}>
                  <option value="">First column</option>
                  {columns.map((column) => (
                    <option key={column} value={column}>
                      {column}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button loading={busy} disabled={rows.length === 0} onClick={() => void render()}>
                Render visualization
              </Button>
            </Card>
            <Card className="stack">
              <div className="card-heading">
                <div>
                  <h2>Local data</h2>
                  <p>Files are sent only to the local visualization runtime.</p>
                </div>
              </div>
              <input
                ref={fileInput}
                type="file"
                aria-label="Load a local CSV or JSON source"
                accept=".csv,.json,text/csv,application/json"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void loadFile(file);
                }}
              />
              <Button variant="secondary" onClick={() => fileInput.current?.click()}>
                Load CSV / JSON
              </Button>
              <div className="home-state">{sourceLabel}</div>
              <DataTable
                columns={tableColumns}
                rows={rows.slice(0, 5)}
                getRowKey={(_, index) => `source-${index}`}
                empty="No rows loaded."
              />
            </Card>
          </div>
          <Card className="stack">
            <div className="card-heading">
              <div>
                <h2>{rendered?.title ?? 'Rendered output'}</h2>
                <p>
                  {rendered
                    ? `${rendered.series.length} plotted points · ${rendered.artifactId}`
                    : 'Render a chart to produce a bounded output model.'}
                </p>
              </div>
            </div>
            {rendered?.spec.type === 'table' ? (
              <DataTable
                columns={tableColumns}
                rows={rendered.rows}
                getRowKey={(_, index) => `rendered-${index}`}
                empty="No result rows."
              />
            ) : rendered && rendered.series.length > 0 ? (
              <div className="stack">
                {['line', 'time-series'].includes(rendered.spec.type) && (
                  <svg
                    viewBox={`0 0 ${chartWidth} ${chartHeight}`}
                    role="img"
                    aria-label={rendered.title}
                    style={{
                      width: '100%',
                      minHeight: 220,
                      background: 'var(--surface-subtle)',
                      borderRadius: 8,
                    }}
                  >
                    <polyline
                      points={linePoints}
                      fill="none"
                      stroke="var(--accent)"
                      strokeWidth="3"
                    />
                    {rendered.series.map((point, index) => (
                      <circle
                        key={`${String(point.x)}-${index}`}
                        cx={(index / Math.max(1, rendered.series.length - 1)) * chartWidth}
                        cy={chartHeight - (point.y / maxY) * (chartHeight - 20)}
                        r="4"
                        fill="var(--accent)"
                      />
                    ))}
                  </svg>
                )}
                {['bar', 'histogram', 'metric', 'confusion-matrix', 'scatter'].includes(
                  rendered.spec.type,
                ) && (
                  <div className="stack">
                    {rendered.series.map((point, index) => (
                      <div key={`${String(point.x)}-${index}`}>
                        <div className="home-list-subtitle">
                          {String(point.x)} · {point.y}
                        </div>
                        <div
                          style={{
                            height: 10,
                            width: `${Math.max(2, (point.y / maxY) * 100)}%`,
                            background: 'var(--accent)',
                            borderRadius: 4,
                          }}
                        />
                      </div>
                    ))}
                  </div>
                )}
                <DataTable
                  columns={[
                    { key: 'x', header: 'X', render: (point: Point) => String(point.x) },
                    { key: 'y', header: 'Y', render: (point: Point) => point.y },
                    {
                      key: 'series',
                      header: 'Series',
                      render: (point: Point) => point.series ?? '—',
                    },
                  ]}
                  rows={rendered.series}
                  getRowKey={(_, index) => `point-${index}`}
                  empty="No plotted points."
                />
              </div>
            ) : (
              <p className="page-subtitle">No rendered series yet.</p>
            )}
          </Card>
        </div>
      </div>
    </CapabilityGate>
  );
}
