import { randomBytes } from 'node:crypto';

export type Id = string & { readonly __brand: 'Id' };
export type HashSha256 = string & { readonly __brand: 'HashSha256' };

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hashPattern = /^[a-f0-9]{64}$/;

export function isId(value: unknown): value is Id {
  return typeof value === 'string' && idPattern.test(value);
}

export function parseId(value: string): Id {
  if (!isId(value)) throw new TypeError(`Expected a UUIDv7 identifier, received ${value}`);
  return value;
}

export function newSortableId(now = new Date()): Id {
  const timestamp = now.getTime();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError('UUIDv7 requires a non-negative safe millisecond timestamp');
  }

  const bytes = randomBytes(16);
  let remaining = BigInt(timestamp);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as Id;
}

export function sha256Hash(value: string): HashSha256 {
  if (!hashPattern.test(value)) throw new TypeError('Expected a lowercase SHA-256 hex digest');
  return value as HashSha256;
}
