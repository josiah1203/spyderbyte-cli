import { createHash, sign } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import process from 'node:process';

const artifactPath = process.argv[2];
const outputPath = process.argv[3];
if (artifactPath === undefined || outputPath === undefined) {
  throw new Error('Usage: node scripts/release/write-update-manifest.mjs <artifact> <manifest>');
}
const endpoint = process.env['SPYDERBYTE_UPDATE_ENDPOINT'];
const artifactBaseUrl = process.env['SPYDERBYTE_UPDATE_ARTIFACT_BASE_URL'];
const privateKey = process.env['SPYDERBYTE_UPDATE_SIGNING_KEY'];
if (endpoint === undefined || !endpoint.startsWith('https://')) {
  throw new Error('SPYDERBYTE_UPDATE_ENDPOINT must be an HTTPS production endpoint.');
}
if (privateKey === undefined || privateKey.trim().length === 0) {
  throw new Error(
    'SPYDERBYTE_UPDATE_SIGNING_KEY must contain the release private key or a key path.',
  );
}
if (
  artifactBaseUrl === undefined ||
  !artifactBaseUrl.startsWith('https://') ||
  artifactBaseUrl.includes('{{')
) {
  throw new Error(
    'SPYDERBYTE_UPDATE_ARTIFACT_BASE_URL must be a concrete HTTPS release-artifact base URL.',
  );
}

const artifact = resolve(artifactPath);
const keyMaterial = privateKey.includes('BEGIN')
  ? privateKey
  : readFileSync(resolve(privateKey), 'utf8');
const version = process.env['SPYDERBYTE_VERSION'];
if (version === undefined || version.trim().length === 0)
  throw new Error('SPYDERBYTE_VERSION is required.');
const channel =
  process.env['SPYDERBYTE_UPDATE_CHANNEL'] ?? process.env['SPYDERBYTE_RELEASE_CHANNEL'] ?? 'stable';
if (!['stable', 'beta', 'nightly'].includes(channel)) {
  throw new Error('SPYDERBYTE_UPDATE_CHANNEL must be stable, beta, or nightly.');
}
const unsigned = {
  product: 'Spyderbyte',
  version,
  channel,
  platform: process.env['SPYDERBYTE_UPDATE_PLATFORM'] ?? 'darwin',
  architecture: process.env['SPYDERBYTE_UPDATE_ARCHITECTURE'] ?? process.arch,
  minimumOs: process.env['SPYDERBYTE_UPDATE_MINIMUM_OS'] ?? '13.0',
  releaseNotes: process.env['SPYDERBYTE_UPDATE_RELEASE_NOTES'] ?? '',
  artifactUrl: `${artifactBaseUrl.replace(/\/$/, '')}/${basename(artifact)}`,
  artifactDigest: `sha256:${createHash('sha256').update(readFileSync(artifact)).digest('hex')}`,
  publishedAt: new Date().toISOString(),
};
const signature = sign(null, Buffer.from(JSON.stringify(unsigned)), keyMaterial).toString('base64');
writeFileSync(outputPath, `${JSON.stringify({ ...unsigned, signature }, null, 2)}\n`, {
  mode: 0o644,
});
console.log(`Spyderbyte update manifest written: ${outputPath}`);
