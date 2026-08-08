import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SpyderbyteUpdateService,
  verifyUpdateManifestSignature,
  type SpyderbyteUpdateManifestV1,
} from '../src/updates.js';

const artifact = new Uint8Array([83, 112, 121, 100, 101, 114, 98, 121, 116, 101]);
const artifactDigest = 'sha256:45aa38b744be51002fbc242cb5effb48410c936212344db416b38cf277498b00';

function unsignedManifest(): Omit<SpyderbyteUpdateManifestV1, 'signature'> {
  return {
    product: 'Spyderbyte',
    version: '0.0.2',
    channel: 'nightly',
    platform: 'darwin',
    architecture: 'arm64',
    minimumOs: '13.0',
    releaseNotes: 'Phase 11 fixture',
    artifactUrl: 'https://updates.example.test/Spyderbyte.update',
    artifactDigest,
    publishedAt: '2026-08-07T00:00:00.000Z',
  };
}

function signManifest(
  manifest: Omit<SpyderbyteUpdateManifestV1, 'signature'>,
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
): SpyderbyteUpdateManifestV1 {
  const payload = JSON.stringify(manifest);
  return {
    ...manifest,
    signature: sign(null, Buffer.from(payload), privateKey).toString('base64'),
  };
}

describe('Phase 11 release and updater controls', () => {
  it('accepts a cryptographically signed nightly manifest and verifies the downloaded artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-phase11-update-'));
    try {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const manifest = signManifest(unsignedManifest(), privateKey);
      const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
      expect(verifyUpdateManifestSignature(manifest, publicKeyPem)).toBe(true);
      const service = new SpyderbyteUpdateService({
        rootPath: root,
        currentVersion: '0.0.1',
        channel: 'nightly',
        platform: 'darwin',
        architecture: 'arm64',
        target: 'aarch64-apple-darwin',
        endpoint: 'https://updates.example.test/v1/{{target}}/{{arch}}/{{current_version}}',
        publicKey: publicKeyPem,
        fetcher: async (input) =>
          String(input).includes('updates.example.test/v1')
            ? new Response(JSON.stringify(manifest), { status: 200 })
            : new Response(artifact, { status: 200 }),
      });

      await expect(service.check()).resolves.toMatchObject({
        state: 'available',
        available: { channel: 'nightly', version: '0.0.2' },
      });
      const downloaded = await service.download();
      expect(downloaded).toMatchObject({
        state: 'ready-to-install',
        downloadedDigest: artifactDigest,
      });
      await expect(readFile(downloaded.downloadedPath as string)).resolves.toEqual(
        Buffer.from(artifact),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed for invalid metadata signatures and missing production verification keys', async () => {
    const invalid = { ...unsignedManifest(), signature: 'invalid' };
    const service = new SpyderbyteUpdateService({
      rootPath: '/tmp/spyderbyte-phase11-invalid-update',
      currentVersion: '0.0.1',
      channel: 'nightly',
      platform: 'darwin',
      architecture: 'arm64',
      endpoint: 'https://updates.example.test/v1/{{target}}/{{arch}}/{{current_version}}',
      publicKey: '-----BEGIN PUBLIC KEY-----\ninvalid\n-----END PUBLIC KEY-----',
      fetcher: async () => new Response(JSON.stringify(invalid), { status: 200 }),
    });
    await expect(service.check()).resolves.toMatchObject({
      state: 'failed',
      lastError: expect.stringContaining('signature'),
    });

    const missingKey = new SpyderbyteUpdateService({
      rootPath: '/tmp/spyderbyte-phase11-no-key',
      endpoint: 'https://updates.example.test/v1/{{target}}/{{arch}}/{{current_version}}',
      channel: 'nightly',
      platform: 'darwin',
      architecture: 'arm64',
      requireSignature: true,
      fetcher: async () => new Response(JSON.stringify(invalid), { status: 200 }),
    });
    await expect(missingKey.check()).resolves.toMatchObject({
      state: 'failed',
      lastError: expect.stringContaining('public key'),
    });
  });

  it('keeps rollback explicit and preserves the workspace boundary', async () => {
    let rollbackCalls = 0;
    const service = new SpyderbyteUpdateService({
      rootPath: '/tmp/spyderbyte-phase11-rollback',
      onRollback: async () => {
        rollbackCalls += 1;
      },
    });
    await expect(service.rollback()).resolves.toMatchObject({
      state: 'rollback-requested',
      workspacePreserved: true,
    });
    expect(rollbackCalls).toBe(1);
  });
});
