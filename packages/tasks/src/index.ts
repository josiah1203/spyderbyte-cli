import { createHash } from 'node:crypto';
import {
  makeQuantity,
  runtimeError,
  type HashSha256,
  type Id,
  type JsonValue,
  type Quantity,
} from '@agentic-platform/runtime-contracts';

export type DatasetScalarType = 'null' | 'string' | 'number' | 'boolean' | 'mixed';

export interface DatasetRow {
  [column: string]: JsonValue;
}

export interface DatasetColumn {
  [key: string]: JsonValue;
  name: string;
  inferredType: DatasetScalarType;
  nullable: boolean;
  pii: boolean;
}

export interface DatasetSplitCounts {
  [key: string]: JsonValue;
  train: number;
  validation: number;
  test: number;
}

export interface DatasetProfile {
  [key: string]: JsonValue;
  format: 'csv' | 'json';
  contentHash: HashSha256;
  rowCount: number;
  columns: DatasetColumn[];
  rows: DatasetRow[];
  parseErrors: string[];
  duplicateRows: number;
  crossSplitDuplicateRows: number;
  leakageRate: number;
  splitCounts: DatasetSplitCounts;
  splitAssignments: Array<'train' | 'validation' | 'test'>;
}

export interface DatasetValidationOptions {
  requiredColumns?: string[];
  expectedTypes?: Record<string, DatasetScalarType>;
  labelColumn?: string;
  leakageThreshold?: number;
  splitSeed?: string;
}

export interface DatasetValidationResult {
  valid: boolean;
  profile: DatasetProfile;
  violations: string[];
  qualityReport: DataQualityReport;
  validatedDataset: ValidatedDataset;
}

export interface DataQualityReport {
  [key: string]: JsonValue;
  schemaVersion: 1;
  profileHash: HashSha256;
  rowCount: number;
  columns: DatasetColumn[];
  duplicateRows: number;
  crossSplitDuplicateRows: number;
  leakageRate: number;
  splitCounts: DatasetSplitCounts;
  violations: string[];
  valid: boolean;
}

export interface ValidatedDataset {
  [key: string]: JsonValue;
  schemaVersion: 1;
  sourceContentHash: HashSha256;
  rowCount: number;
  canonicalSchema: DatasetColumn[];
  splitCounts: DatasetSplitCounts;
  limitations: string[];
  qualityReportHash: HashSha256;
}

interface ParsedDataset {
  format: 'csv' | 'json';
  rows: DatasetRow[];
  columns: string[];
  parseErrors: string[];
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
    .join(',')}}`;
}

function digest(value: JsonValue): HashSha256 {
  return createHash('sha256').update(canonicalJson(value)).digest('hex') as HashSha256;
}

function asText(content: Uint8Array | string): string {
  return typeof content === 'string' ? content : new TextDecoder().decode(content);
}

function scalarValue(value: string): JsonValue {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) {
    const numberValue = Number(trimmed);
    if (Number.isFinite(numberValue)) return numberValue;
  }
  return value;
}

function parseCsv(text: string): ParsedDataset {
  const records: string[][] = [];
  const errors: string[] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  const pushField = (): void => {
    row.push(field);
    field = '';
  };
  const pushRow = (): void => {
    pushField();
    if (row.some((value) => value.length > 0) || records.length === 0) records.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === undefined) continue;
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ',') {
      pushField();
    } else if (character === '\n') {
      pushRow();
    } else if (character !== '\r') {
      field += character;
    }
  }
  if (quoted) errors.push('CSV contains an unterminated quoted field');
  if (field.length > 0 || row.length > 0) pushRow();

  const headerRecord = records[0] ?? [];
  const columns = headerRecord.map((column) => column.trim());
  const seen = new Set<string>();
  for (const column of columns) {
    if (column.length === 0) errors.push('CSV contains an empty column name');
    if (seen.has(column)) errors.push(`CSV contains duplicate column ${column}`);
    seen.add(column);
  }

  const rows: DatasetRow[] = [];
  for (const [rowIndex, record] of records.slice(1).entries()) {
    if (record.length !== columns.length) {
      errors.push(
        `CSV row ${rowIndex + 2} has ${record.length} fields; expected ${columns.length}`,
      );
    }
    const output: DatasetRow = {};
    for (const [columnIndex, column] of columns.entries()) {
      if (column.length === 0) continue;
      output[column] = scalarValue(record[columnIndex] ?? '');
    }
    rows.push(output);
  }
  return { format: 'csv', rows, columns, parseErrors: errors };
}

function parseJson(text: string): ParsedDataset {
  try {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value) || value.some((row) => typeof row !== 'object' || row === null)) {
      return {
        format: 'json',
        rows: [],
        columns: [],
        parseErrors: ['JSON dataset must be an array of objects'],
      };
    }
    const columns: string[] = [];
    const seen = new Set<string>();
    for (const row of value as Array<Record<string, unknown>>) {
      for (const column of Object.keys(row)) {
        if (!seen.has(column)) {
          seen.add(column);
          columns.push(column);
        }
      }
    }
    const rows: DatasetRow[] = value.map((row) => {
      const output: DatasetRow = {};
      for (const column of columns) {
        const field = (row as Record<string, unknown>)[column];
        output[column] = field === undefined ? null : (field as JsonValue);
      }
      return output;
    });
    return { format: 'json', rows, columns, parseErrors: [] };
  } catch {
    return {
      format: 'json',
      rows: [],
      columns: [],
      parseErrors: ['JSON dataset is not valid JSON'],
    };
  }
}

function parseDataset(content: Uint8Array | string): ParsedDataset {
  const text = asText(content).replace(/^\uFEFF/, '');
  const trimmed = text.trimStart();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return parseJson(text);
  return parseCsv(text);
}

function scalarType(value: JsonValue): DatasetScalarType {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  return 'mixed';
}

function inferredType(values: JsonValue[]): DatasetScalarType {
  const types = new Set(values.filter((value) => value !== null).map(scalarType));
  if (types.size === 0) return 'null';
  if (types.size === 1) return [...types][0] ?? 'mixed';
  return 'mixed';
}

function containsPiiMarker(column: string): boolean {
  return /(^|[_\s-])(email|e-mail|phone|telephone|ssn|social.?security|address|dob|birth.?date|name)([_\s-]|$)/i.test(
    column,
  );
}

function splitFor(index: number, seed: string): 'train' | 'validation' | 'test' {
  const value = Number.parseInt(digest(`${seed}:${index}`).slice(0, 8), 16);
  if (value % 100 < 80) return 'train';
  if (value % 100 < 90) return 'validation';
  return 'test';
}

function rowKey(row: DatasetRow): string {
  return canonicalJson(row);
}

function profileDigest(profile: DatasetProfile): HashSha256 {
  return digest({
    format: profile.format,
    contentHash: profile.contentHash,
    rowCount: profile.rowCount,
    columns: profile.columns,
    duplicateRows: profile.duplicateRows,
    crossSplitDuplicateRows: profile.crossSplitDuplicateRows,
    leakageRate: profile.leakageRate,
    splitCounts: profile.splitCounts,
    splitAssignments: profile.splitAssignments,
    parseErrors: profile.parseErrors,
  });
}

export function profileDataset(
  content: Uint8Array | string,
  options: Pick<DatasetValidationOptions, 'splitSeed'> = {},
): DatasetProfile {
  const parsed = parseDataset(content);
  const contentHash = createHash('sha256').update(asText(content)).digest('hex') as HashSha256;
  const columns: DatasetColumn[] = parsed.columns.map((name) => {
    const values = parsed.rows.map((row) => row[name] ?? null);
    return {
      name,
      inferredType: inferredType(values),
      nullable: values.some((value) => value === null),
      pii: containsPiiMarker(name),
    };
  });
  const seed = options.splitSeed ?? 'dataset-validation.v1';
  const splitAssignments = parsed.rows.map((_, index) => splitFor(index, seed));
  const splitCounts: DatasetSplitCounts = { train: 0, validation: 0, test: 0 };
  for (const split of splitAssignments) splitCounts[split] += 1;
  const rowCounts = new Map<string, number>();
  const rowSplits = new Map<string, Set<string>>();
  for (const [index, row] of parsed.rows.entries()) {
    const key = rowKey(row);
    rowCounts.set(key, (rowCounts.get(key) ?? 0) + 1);
    const splits = rowSplits.get(key) ?? new Set<string>();
    splits.add(splitAssignments[index] ?? 'train');
    rowSplits.set(key, splits);
  }
  const duplicateRows = [...rowCounts.values()]
    .filter((count) => count > 1)
    .reduce((total, count) => total + count - 1, 0);
  const crossSplitDuplicateRows = [...rowSplits.entries()]
    .filter(([key, splits]) => splits.size > 1 && (rowCounts.get(key) ?? 0) > 1)
    .reduce((total, [key]) => total + (rowCounts.get(key) ?? 0), 0);
  const leakageRate = parsed.rows.length === 0 ? 0 : crossSplitDuplicateRows / parsed.rows.length;
  return {
    format: parsed.format,
    contentHash,
    rowCount: parsed.rows.length,
    columns,
    rows: parsed.rows,
    parseErrors: parsed.parseErrors,
    duplicateRows,
    crossSplitDuplicateRows,
    leakageRate,
    splitCounts,
    splitAssignments,
  };
}

export function validateDataset(
  content: Uint8Array | string,
  options: DatasetValidationOptions = {},
): DatasetValidationResult {
  const profile = profileDataset(content, options);
  const violations = [...profile.parseErrors];
  if (profile.rowCount === 0) violations.push('Dataset contains no rows');
  const availableColumns = new Set(profile.columns.map((column) => column.name));
  for (const requiredColumn of options.requiredColumns ?? []) {
    if (!availableColumns.has(requiredColumn)) {
      violations.push(`Required column is missing: ${requiredColumn}`);
    }
  }
  for (const [column, expectedType] of Object.entries(options.expectedTypes ?? {})) {
    const actual = profile.columns.find((candidate) => candidate.name === column)?.inferredType;
    if (actual === undefined) {
      violations.push(`Expected column is missing: ${column}`);
    } else if (actual !== expectedType && actual !== 'null') {
      violations.push(`Column ${column} has type ${actual}; expected ${expectedType}`);
    }
  }
  const leakageThreshold = options.leakageThreshold ?? 0;
  if (profile.leakageRate > leakageThreshold) {
    violations.push(
      `Potential split leakage rate ${profile.leakageRate.toFixed(4)} exceeds ${leakageThreshold.toFixed(4)}`,
    );
  }
  const valid = violations.length === 0;
  const reportBase = {
    schemaVersion: 1 as const,
    profileHash: profileDigest(profile),
    rowCount: profile.rowCount,
    columns: profile.columns,
    duplicateRows: profile.duplicateRows,
    crossSplitDuplicateRows: profile.crossSplitDuplicateRows,
    leakageRate: profile.leakageRate,
    splitCounts: profile.splitCounts,
    violations,
    valid,
  } satisfies DataQualityReport;
  const qualityReportHash = digest(reportBase);
  const validatedDataset: ValidatedDataset = {
    schemaVersion: 1,
    sourceContentHash: profile.contentHash,
    rowCount: profile.rowCount,
    canonicalSchema: profile.columns,
    splitCounts: profile.splitCounts,
    limitations: violations,
    qualityReportHash,
  };
  return {
    valid,
    profile,
    violations,
    qualityReport: reportBase,
    validatedDataset,
  };
}

export function usageForRows(rowCount: number): Quantity {
  if (!Number.isSafeInteger(rowCount) || rowCount < 0) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Row count must be a non-negative safe integer');
  }
  return makeQuantity(rowCount, 'items');
}

export function artifactIdForTask(
  workflowId: Id,
  task: 'governance' | 'quality-report' | 'validated-dataset',
): Id {
  const hash = digest(`${workflowId}:${task}`);
  const variant = ((Number.parseInt(hash.slice(16, 17), 16) || 0) & 0x03) | 0x08;
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-7${hash.slice(13, 16)}-${variant.toString(16)}${hash.slice(17, 20)}-${hash.slice(20, 32)}` as Id;
}
