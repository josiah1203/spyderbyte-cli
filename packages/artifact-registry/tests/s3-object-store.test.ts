import { describe, expect, it } from 'vitest';
import { S3CompatibleArtifactObjectStore, type S3CompatibleObjectClient } from '../src/index.js';

class FakeObjectClient implements S3CompatibleObjectClient {
  readonly objects = new Map<string, Uint8Array>();

  async putObjectIfAbsent(request: {
    bucket: string;
    key: string;
    body: Uint8Array;
  }): Promise<boolean> {
    const fullKey = `${request.bucket}/${request.key}`;
    if (this.objects.has(fullKey)) return false;
    this.objects.set(fullKey, new Uint8Array(request.body));
    return true;
  }

  async getObject(request: { bucket: string; key: string }): Promise<Uint8Array | undefined> {
    const value = this.objects.get(`${request.bucket}/${request.key}`);
    return value === undefined ? undefined : new Uint8Array(value);
  }
}

const key = `sha256/${'a'.repeat(64)}`;

describe('S3CompatibleArtifactObjectStore', () => {
  it('uses tenant-independent content keys with conditional immutable writes', async () => {
    const client = new FakeObjectClient();
    const store = new S3CompatibleArtifactObjectStore({
      client,
      bucket: 'artifacts',
      prefix: 'production',
    });
    await store.put(key, new TextEncoder().encode('content'));
    await store.put(key, new TextEncoder().encode('content'));
    await expect(store.get(key)).resolves.toEqual(new TextEncoder().encode('content'));
    await expect(store.put(key, new TextEncoder().encode('changed'))).rejects.toThrow(
      'already contains different bytes',
    );
    expect([...client.objects.keys()]).toEqual([`artifacts/production/${key}`]);
  });

  it('rejects unsafe prefixes and non-content-addressed keys', () => {
    const client = new FakeObjectClient();
    expect(
      () =>
        new S3CompatibleArtifactObjectStore({ client, bucket: 'artifacts', prefix: '../escape' }),
    ).toThrow('unsafe');
    const store = new S3CompatibleArtifactObjectStore({ client, bucket: 'artifacts' });
    expect(() => store.get('arbitrary-key')).toThrow('Invalid content-addressed object key');
  });
});
