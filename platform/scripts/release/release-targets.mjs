import { createHash, sign, verify } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

export const RELEASE_CHANNELS = ['stable', 'beta', 'nightly'];

export const RELEASE_TARGETS = [
  { platform: 'darwin', architecture: 'arm64', target: 'aarch64-apple-darwin', installer: 'dmg' },
  { platform: 'darwin', architecture: 'x86_64', target: 'x86_64-apple-darwin', installer: 'dmg' },
  {
    platform: 'linux',
    architecture: 'arm64',
    target: 'aarch64-unknown-linux-gnu',
    installer: 'appimage',
  },
  {
    platform: 'linux',
    architecture: 'x86_64',
    target: 'x86_64-unknown-linux-gnu',
    installer: 'appimage',
  },
  {
    platform: 'windows',
    architecture: 'x86_64',
    target: 'x86_64-pc-windows-msvc',
    installer: 'nsis',
  },
];

export function normalizeReleasePlatform(value) {
  if (value === 'win32') return 'windows';
  if (value === 'darwin' || value === 'linux' || value === 'windows') return value;
  throw new Error(`Unsupported release platform: ${value}`);
}

export function normalizeReleaseArchitecture(value) {
  if (value === 'x64' || value === 'x86_64') return 'x86_64';
  if (value === 'arm64' || value === 'aarch64') return 'arm64';
  throw new Error(`Unsupported release architecture: ${value}`);
}

export function findReleaseTarget(platform, architecture) {
  return RELEASE_TARGETS.find(
    (target) => target.platform === platform && target.architecture === architecture,
  );
}

export function canonicalReleasePayload(manifest) {
  return JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    product: manifest.product,
    version: manifest.version,
    channel: manifest.channel,
    platform: manifest.platform,
    architecture: manifest.architecture,
    target: manifest.target,
    installer: manifest.installer,
    artifact: manifest.artifact,
    publishedAt: manifest.publishedAt,
  });
}

export function artifactDigest(path) {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

export function createReleaseManifest({
  artifactPath,
  version,
  channel,
  platform,
  architecture,
  artifactBaseUrl,
  signingKey,
  publishedAt = new Date().toISOString(),
}) {
  if (!RELEASE_CHANNELS.includes(channel))
    throw new Error(`Unsupported release channel: ${channel}`);
  const target = findReleaseTarget(platform, architecture);
  if (target === undefined)
    throw new Error(`Unsupported release target: ${platform}/${architecture}`);
  if (typeof version !== 'string' || version.trim().length === 0) {
    throw new Error('SPYDERBYTE_VERSION is required');
  }
  if (typeof artifactBaseUrl !== 'string' || !artifactBaseUrl.startsWith('https://')) {
    throw new Error('SPYDERBYTE_UPDATE_ARTIFACT_BASE_URL must be HTTPS');
  }
  if (artifactBaseUrl.includes('{{')) {
    throw new Error('SPYDERBYTE_UPDATE_ARTIFACT_BASE_URL must be concrete');
  }
  if (signingKey === undefined || signingKey === null) {
    throw new Error('SPYDERBYTE_UPDATE_SIGNING_KEY is required');
  }
  const resolvedArtifact = resolve(artifactPath);
  const stat = statSync(resolvedArtifact);
  const manifest = {
    schemaVersion: 1,
    product: 'Spyderbyte',
    version,
    channel,
    platform,
    architecture,
    target: target.target,
    installer: target.installer,
    artifact: {
      filename: basename(resolvedArtifact),
      sizeBytes: stat.size,
      sha256: artifactDigest(resolvedArtifact),
      url: `${artifactBaseUrl.replace(/\/$/, '')}/${basename(resolvedArtifact)}`,
    },
    publishedAt,
  };
  return {
    ...manifest,
    signature: sign(null, Buffer.from(canonicalReleasePayload(manifest)), signingKey).toString(
      'base64',
    ),
  };
}

export function verifyReleaseManifest({ artifactPath, manifest, publicKey }) {
  if (manifest.schemaVersion !== 1 || manifest.product !== 'Spyderbyte') {
    throw new Error('Release manifest schema or product is invalid');
  }
  const target = findReleaseTarget(manifest.platform, manifest.architecture);
  if (
    target === undefined ||
    target.target !== manifest.target ||
    target.installer !== manifest.installer
  ) {
    throw new Error('Release manifest target is not supported');
  }
  if (!RELEASE_CHANNELS.includes(manifest.channel)) {
    throw new Error('Release manifest channel is not supported');
  }
  const resolvedArtifact = resolve(artifactPath);
  const stat = statSync(resolvedArtifact);
  if (
    manifest.artifact.sizeBytes !== stat.size ||
    manifest.artifact.sha256 !== artifactDigest(resolvedArtifact)
  ) {
    throw new Error('Release artifact digest or size does not match its manifest');
  }
  if (publicKey === undefined || publicKey === null) {
    throw new Error('Release verification requires a public key');
  }
  if (
    !verify(
      null,
      Buffer.from(canonicalReleasePayload(manifest)),
      publicKey,
      Buffer.from(manifest.signature, 'base64'),
    )
  ) {
    throw new Error('Release manifest signature is invalid');
  }
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [artifactPath, outputPath] = process.argv.slice(2);
  if (artifactPath === undefined || outputPath === undefined) {
    throw new Error(
      'Usage: node scripts/release/release-targets.mjs <artifact> <manifest> (library module)',
    );
  }
  const manifest = createReleaseManifest({
    artifactPath,
    version: process.env['SPYDERBYTE_VERSION'],
    channel: process.env['SPYDERBYTE_RELEASE_CHANNEL'] ?? 'stable',
    platform: normalizeReleasePlatform(
      process.env['SPYDERBYTE_RELEASE_PLATFORM'] ?? process.platform,
    ),
    architecture: normalizeReleaseArchitecture(
      process.env['SPYDERBYTE_RELEASE_ARCHITECTURE'] ?? process.arch,
    ),
    artifactBaseUrl: process.env['SPYDERBYTE_UPDATE_ARTIFACT_BASE_URL'],
    signingKey: process.env['SPYDERBYTE_UPDATE_SIGNING_KEY'],
  });
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
}
