import { createHash } from 'node:crypto';
import type { JsonValue } from '@agentic-platform/runtime-contracts';

export type ArtifactDiffFormat = 'json' | 'text' | 'binary';
export type ArtifactDiffChangeKind = 'added' | 'removed' | 'changed';

export interface ArtifactDiffChange {
  readonly kind: ArtifactDiffChangeKind;
  readonly path: string;
  readonly before?: JsonValue;
  readonly after?: JsonValue;
  readonly line?: number;
}

export interface StructuredArtifactDiff {
  readonly schemaVersion: 1;
  readonly artifactId: string;
  readonly fromVersion?: number;
  readonly toVersion: number;
  readonly mediaType: string;
  readonly format: ArtifactDiffFormat;
  readonly changed: boolean;
  readonly summary: {
    readonly added: number;
    readonly removed: number;
    readonly changed: number;
  };
  readonly changes: readonly ArtifactDiffChange[];
  readonly generatedAt: string;
}

const MAX_CHANGES = 200;

function isJsonContainer(
  value: JsonValue,
): value is JsonValue[] | { readonly [key: string]: JsonValue } {
  return Array.isArray(value) || (value !== null && typeof value === 'object');
}

function equalJson(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function jsonChanges(
  before: JsonValue | undefined,
  after: JsonValue | undefined,
  path: string,
  changes: ArtifactDiffChange[],
): void {
  if (changes.length >= MAX_CHANGES) return;
  if (before === undefined) {
    changes.push({ kind: 'added', path, after: after as JsonValue });
    return;
  }
  if (after === undefined) {
    changes.push({ kind: 'removed', path, before });
    return;
  }
  if (equalJson(before, after)) return;
  if (!isJsonContainer(before) || !isJsonContainer(after)) {
    changes.push({ kind: 'changed', path, before, after });
    return;
  }
  if (Array.isArray(before) !== Array.isArray(after)) {
    changes.push({ kind: 'changed', path, before, after });
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length && changes.length < MAX_CHANGES; index += 1) {
      jsonChanges(before[index], after[index], `${path}[${index}]`, changes);
    }
    return;
  }
  const beforeRecord = before as { readonly [key: string]: JsonValue };
  const afterRecord = after as { readonly [key: string]: JsonValue };
  const keys = [...new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])].sort();
  for (const key of keys) {
    if (changes.length >= MAX_CHANGES) break;
    jsonChanges(
      beforeRecord[key],
      afterRecord[key],
      path === '$' ? `$.${key}` : `${path}.${key}`,
      changes,
    );
  }
}

function textChanges(before: string, after: string): ArtifactDiffChange[] {
  const left = before.split(/\r?\n/);
  const right = after.split(/\r?\n/);
  const changes: ArtifactDiffChange[] = [];
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length && changes.length < MAX_CHANGES; index += 1) {
    const previous = left[index];
    const next = right[index];
    if (previous === next) continue;
    if (previous === undefined) {
      changes.push({
        kind: 'added',
        path: `line:${index + 1}`,
        line: index + 1,
        after: next ?? '',
      });
    } else if (next === undefined) {
      changes.push({
        kind: 'removed',
        path: `line:${index + 1}`,
        line: index + 1,
        before: previous,
      });
    } else {
      changes.push({
        kind: 'changed',
        path: `line:${index + 1}`,
        line: index + 1,
        before: previous,
        after: next,
      });
    }
  }
  return changes;
}

function parseJson(value: string): JsonValue | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      parsed === null ||
      typeof parsed === 'boolean' ||
      typeof parsed === 'string' ||
      (typeof parsed === 'number' && Number.isFinite(parsed)) ||
      Array.isArray(parsed) ||
      typeof parsed === 'object'
    ) {
      return parsed as JsonValue;
    }
  } catch {
    // Fall back to a line-oriented text diff.
  }
  return undefined;
}

function formatFor(mediaType: string, before: Uint8Array, after: Uint8Array): ArtifactDiffFormat {
  const normalized = mediaType.toLowerCase();
  if (normalized.includes('json')) return 'json';
  const isText =
    normalized.startsWith('text/') ||
    /(?:csv|tsv|sql|javascript|typescript|python)/.test(normalized);
  if (isText) return 'text';
  const printable = (bytes: Uint8Array): boolean => {
    const sample = bytes.subarray(0, Math.min(bytes.byteLength, 4096));
    return !sample.some((byte) => byte === 0);
  };
  return printable(before) && printable(after) ? 'text' : 'binary';
}

export function createStructuredArtifactDiff(input: {
  readonly artifactId: string;
  readonly fromVersion?: number;
  readonly toVersion: number;
  readonly mediaType: string;
  readonly before?: Uint8Array;
  readonly after: Uint8Array;
  readonly generatedAt?: string;
}): StructuredArtifactDiff {
  const before = input.before ?? new Uint8Array();
  const format = formatFor(input.mediaType, before, input.after);
  let changes: ArtifactDiffChange[];
  if (format === 'json') {
    const beforeJson =
      input.before === undefined ? undefined : parseJson(new TextDecoder().decode(before));
    const afterJson = parseJson(new TextDecoder().decode(input.after));
    changes = [];
    if (afterJson === undefined || (input.before !== undefined && beforeJson === undefined)) {
      changes = textChanges(
        new TextDecoder().decode(before),
        new TextDecoder().decode(input.after),
      );
    } else {
      jsonChanges(beforeJson, afterJson, '$', changes);
    }
  } else if (format === 'text') {
    changes = textChanges(new TextDecoder().decode(before), new TextDecoder().decode(input.after));
  } else {
    const beforeHash = createHash('sha256').update(before).digest('hex');
    const afterHash = createHash('sha256').update(input.after).digest('hex');
    changes =
      beforeHash === afterHash
        ? []
        : [{ kind: 'changed', path: '$binary', before: beforeHash, after: afterHash }];
  }
  const summary = {
    added: changes.filter((change) => change.kind === 'added').length,
    removed: changes.filter((change) => change.kind === 'removed').length,
    changed: changes.filter((change) => change.kind === 'changed').length,
  };
  return {
    schemaVersion: 1,
    artifactId: input.artifactId,
    ...(input.fromVersion === undefined ? {} : { fromVersion: input.fromVersion }),
    toVersion: input.toVersion,
    mediaType: input.mediaType,
    format,
    changed: changes.length > 0,
    summary,
    changes,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  };
}
