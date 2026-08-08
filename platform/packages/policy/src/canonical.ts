import { createHash } from 'node:crypto';
import type { HashSha256 } from '@agentic-platform/runtime-contracts';

/**
 * Canonical JSON is intentionally small and deterministic: object keys are sorted while
 * array order remains meaningful. Policy and approval digests must not depend on insertion order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') throw new TypeError('Digest input must be JSON serializable');

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

export function sha256Digest(value: unknown): HashSha256 {
  return createHash('sha256').update(canonicalJson(value)).digest('hex') as HashSha256;
}
