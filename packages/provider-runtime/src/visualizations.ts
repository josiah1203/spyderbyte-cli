import { createHash } from 'node:crypto';
import { runtimeError, type JsonValue } from '@agentic-platform/runtime-contracts';

export type VisualizationType =
  | 'table'
  | 'metric'
  | 'kpi'
  | 'line'
  | 'bar'
  | 'stacked-bar'
  | 'area'
  | 'pivot'
  | 'scatter'
  | 'histogram'
  | 'box'
  | 'heatmap'
  | 'point-map'
  | 'choropleth'
  | 'time-series'
  | 'confusion-matrix'
  | 'roc'
  | 'precision-recall'
  | 'feature-importance';

export interface VisualizationSpecV1 {
  readonly type: VisualizationType;
  readonly title?: string;
  readonly xColumn?: string;
  readonly yColumn?: string;
  readonly seriesColumn?: string;
  readonly bucketCount?: number;
}

export interface VisualizationInputV1 {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly JsonValue[])[];
  readonly sourceArtifactId?: string;
}

export interface VisualizationPoint {
  readonly x: JsonValue;
  readonly y: number;
  readonly series?: string;
}

export interface VisualizationRenderV1 {
  readonly schemaVersion: 1;
  readonly spec: VisualizationSpecV1;
  readonly title: string;
  readonly status: 'rendered';
  readonly columns: readonly string[];
  readonly rows: readonly (readonly JsonValue[])[];
  readonly series: readonly VisualizationPoint[];
  readonly artifactId: string;
  readonly lineage: readonly string[];
  readonly renderedAt: string;
}

export interface VisualizationChoiceV1 {
  readonly schemaVersion: 1;
  readonly type: VisualizationType;
  readonly source: 'automatic' | 'override';
  readonly rationale: string;
}

export interface VisualizationRuntime {
  choose(input: VisualizationInputV1, override?: VisualizationType): VisualizationChoiceV1;
  validate(
    spec: VisualizationSpecV1,
    input: VisualizationInputV1,
  ): { valid: boolean; error?: string };
  render(spec: VisualizationSpecV1, input: VisualizationInputV1): VisualizationRenderV1;
}

function now(): string {
  return new Date().toISOString();
}

function numberValue(value: JsonValue): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function columnIndex(
  input: VisualizationInputV1,
  column: string | undefined,
  label: string,
): number | undefined {
  if (column === undefined) return undefined;
  const index = input.columns.indexOf(column);
  if (index < 0)
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} column ${column} was not found`);
  return index;
}

function specKey(spec: VisualizationSpecV1): string {
  return JSON.stringify(spec);
}

export class LocalVisualizationRuntime implements VisualizationRuntime {
  choose(input: VisualizationInputV1, override?: VisualizationType): VisualizationChoiceV1 {
    if (override !== undefined) {
      return {
        schemaVersion: 1,
        type: override,
        source: 'override',
        rationale: 'The requested visualization type was selected explicitly.',
      };
    }
    const numericColumns = input.columns.filter((_, index) =>
      input.rows.some((row) => numberValue(row[index] ?? null) !== undefined),
    );
    const timeColumn = input.columns.find((column) => /date|time|timestamp/i.test(column));
    const type: VisualizationType =
      input.columns.length === 0 || input.rows.length === 0
        ? 'table'
        : timeColumn !== undefined && numericColumns.length > 0
          ? 'time-series'
          : numericColumns.length >= 2
            ? 'scatter'
            : numericColumns.length === 1 && input.columns.length > 1
              ? 'bar'
              : 'table';
    return {
      schemaVersion: 1,
      type,
      source: 'automatic',
      rationale:
        type === 'time-series'
          ? 'A time-like column and numeric values were detected.'
          : type === 'scatter'
            ? 'At least two numeric columns were detected.'
            : type === 'bar'
              ? 'One numeric measure and one categorical column were detected.'
              : 'The input is best represented as a table.',
    };
  }

  validate(
    spec: VisualizationSpecV1,
    input: VisualizationInputV1,
  ): { valid: boolean; error?: string } {
    try {
      if (
        !Array.isArray(input.columns) ||
        input.columns.some((column) => typeof column !== 'string')
      ) {
        return { valid: false, error: 'Visualization columns must be strings.' };
      }
      if (!Array.isArray(input.rows) || input.rows.length > 100_000) {
        return {
          valid: false,
          error: 'Visualization rows must be an array of at most 100,000 rows.',
        };
      }
      if (
        ![
          'table',
          'metric',
          'kpi',
          'line',
          'bar',
          'stacked-bar',
          'area',
          'pivot',
          'scatter',
          'histogram',
          'box',
          'heatmap',
          'point-map',
          'choropleth',
          'time-series',
          'confusion-matrix',
          'roc',
          'precision-recall',
          'feature-importance',
        ].includes(spec.type)
      ) {
        return { valid: false, error: 'Visualization type is not supported.' };
      }
      columnIndex(input, spec.xColumn, 'X');
      columnIndex(input, spec.yColumn, 'Y');
      columnIndex(input, spec.seriesColumn, 'Series');
      if (!['table', 'metric', 'kpi', 'pivot'].includes(spec.type) && spec.yColumn === undefined) {
        return { valid: false, error: 'A Y column is required for this visualization.' };
      }
      return { valid: true };
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  render(spec: VisualizationSpecV1, input: VisualizationInputV1): VisualizationRenderV1 {
    const validation = this.validate(spec, input);
    if (!validation.valid)
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        validation.error ?? 'Visualization is invalid',
      );
    const xIndex = columnIndex(input, spec.xColumn, 'X');
    const yIndex = columnIndex(input, spec.yColumn, 'Y');
    const seriesIndex = columnIndex(input, spec.seriesColumn, 'Series');
    let series: VisualizationPoint[] = [];
    if (spec.type === 'metric' || spec.type === 'kpi') {
      const values = input.rows
        .map((row) => numberValue(row[yIndex ?? 0] ?? null))
        .filter((value): value is number => value !== undefined);
      series = [
        { x: spec.title ?? 'metric', y: values.reduce((total, value) => total + value, 0) },
      ];
    } else if (spec.type === 'histogram') {
      const values = input.rows
        .map((row) => numberValue(row[yIndex ?? 0] ?? null))
        .filter((value): value is number => value !== undefined);
      const bucketCount = Math.max(2, Math.min(spec.bucketCount ?? 10, 50));
      const minimum = Math.min(...values, 0);
      const maximum = Math.max(...values, 1);
      const width = maximum === minimum ? 1 : (maximum - minimum) / bucketCount;
      const buckets = Array.from({ length: bucketCount }, (_, index) => ({
        start: minimum + index * width,
        count: 0,
      }));
      for (const value of values) {
        const bucket = buckets[Math.min(bucketCount - 1, Math.floor((value - minimum) / width))];
        if (bucket !== undefined) bucket.count += 1;
      }
      series = buckets.map((bucket) => ({ x: bucket.start, y: bucket.count }));
    } else if (spec.type === 'box') {
      const values = input.rows
        .map((row) => numberValue(row[yIndex ?? 0] ?? null))
        .filter((value): value is number => value !== undefined)
        .sort((left, right) => left - right);
      const percentile = (fraction: number): number => {
        if (values.length === 0) return 0;
        return values[Math.min(values.length - 1, Math.floor((values.length - 1) * fraction))] ?? 0;
      };
      series = [
        { x: 'min', y: percentile(0) },
        { x: 'q1', y: percentile(0.25) },
        { x: 'median', y: percentile(0.5) },
        { x: 'q3', y: percentile(0.75) },
        { x: 'max', y: percentile(1) },
      ];
    } else if (spec.type === 'confusion-matrix') {
      const counts = new Map<string, number>();
      const labels = new Set<string>();
      for (const row of input.rows) {
        const actual = String(row[xIndex ?? 0] ?? 'null');
        const predicted = String(row[yIndex ?? 0] ?? 'null');
        labels.add(actual);
        labels.add(predicted);
        const key = `${actual}→${predicted}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      series = [...counts.entries()].map(([key, count]) => ({ x: key, y: count }));
      void labels;
    } else if (!['table', 'pivot'].includes(spec.type)) {
      series = input.rows.flatMap((row) => {
        const y = numberValue(row[yIndex ?? 0] ?? null);
        if (y === undefined) return [];
        return [
          {
            x: row[xIndex ?? 0] ?? null,
            y,
            ...(seriesIndex === undefined ? {} : { series: String(row[seriesIndex] ?? '') }),
          },
        ];
      });
    }
    const renderedAt = now();
    const artifactId = `visualization-${createHash('sha256')
      .update(JSON.stringify({ spec: specKey(spec), input }))
      .digest('hex')
      .slice(0, 20)}`;
    return {
      schemaVersion: 1,
      spec: structuredClone(spec),
      title: spec.title ?? `${spec.type} visualization`,
      status: 'rendered',
      columns: [...input.columns],
      rows: input.rows.map((row) => [...row]),
      series,
      artifactId,
      lineage: input.sourceArtifactId === undefined ? [] : [input.sourceArtifactId],
      renderedAt,
    };
  }
}
