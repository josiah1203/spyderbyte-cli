import { runtimeError } from '@agentic-platform/runtime-contracts';
import type { ArtifactObjectStore } from './object-store.js';

export interface S3CompatibleObjectClient {
  putObjectIfAbsent(request: { bucket: string; key: string; body: Uint8Array }): Promise<boolean>;
  getObject(request: { bucket: string; key: string }): Promise<Uint8Array | undefined>;
}

function validContentAddressedKey(objectKey: string): void {
  if (!/^sha256\/[0-9a-f]{64}$/.test(objectKey)) {
    throw runtimeError(
      'VALIDATION_INVALID_INPUT',
      `Invalid content-addressed object key: ${objectKey}`,
    );
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  );
}

function normalizePrefix(prefix: string | undefined): string {
  if (prefix === undefined || prefix.length === 0) return '';
  const normalized = prefix.replace(/^\/+|\/+$/g, '');
  if (normalized.length === 0 || normalized.split('/').some((part) => part === '..')) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Object-store prefix is unsafe');
  }
  return `${normalized}/`;
}

export class S3CompatibleArtifactObjectStore implements ArtifactObjectStore {
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly client: S3CompatibleObjectClient;

  constructor(options: { client: S3CompatibleObjectClient; bucket: string; prefix?: string }) {
    if (options.bucket.trim().length === 0)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Object-store bucket is required');
    this.client = options.client;
    this.bucket = options.bucket;
    this.prefix = normalizePrefix(options.prefix);
  }

  async put(objectKey: string, content: Uint8Array): Promise<void> {
    validContentAddressedKey(objectKey);
    const key = `${this.prefix}${objectKey}`;
    const created = await this.client.putObjectIfAbsent({
      bucket: this.bucket,
      key,
      body: new Uint8Array(content),
    });
    if (created) return;
    const existing = await this.client.getObject({ bucket: this.bucket, key });
    if (existing === undefined)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Immutable object ${objectKey} disappeared`);
    if (!sameBytes(existing, content)) {
      throw runtimeError(
        'ARTIFACT_IMMUTABLE',
        `Object ${objectKey} already contains different bytes`,
      );
    }
  }

  get(objectKey: string): Promise<Uint8Array | undefined> {
    validContentAddressedKey(objectKey);
    return this.client.getObject({ bucket: this.bucket, key: `${this.prefix}${objectKey}` });
  }
}
