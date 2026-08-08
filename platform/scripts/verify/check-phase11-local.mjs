import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  RELEASE_CHANNELS,
  RELEASE_TARGETS,
  createReleaseManifest,
  verifyReleaseManifest,
} from '../release/release-targets.mjs';

const root = resolve(new URL('../..', import.meta.url).pathname);
const requiredFiles = [
  'apps/desktop/src-tauri/tauri.conf.json',
  'apps/desktop/src-tauri/entitlements.plist',
  'scripts/release/check-macos-release.sh',
  'scripts/release/build-platform-release.mjs',
  'scripts/verify/check-container-images.mjs',
  'scripts/release/write-platform-release-manifest.mjs',
  'scripts/release/verify-platform-release-manifest.mjs',
  'docs/operations/phase11-local-targets.md',
  'docs/operations/phase11-product-metrics.md',
  'docs/runbooks/phase11-release-operations.md',
  'packages/provider-runtime/src/updates.ts',
  'packages/observability/src/index.ts',
];
for (const relativePath of requiredFiles) {
  if (!existsSync(join(root, relativePath)))
    throw new Error(`Missing Phase 11 file: ${relativePath}`);
}

const tauri = JSON.parse(
  readFileSync(join(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
);
if (tauri.productName !== 'Spyderbyte') throw new Error('Tauri product identity is not Spyderbyte');
if (tauri.identifier !== 'com.spyderbyte.desktop') {
  throw new Error('Tauri bundle identifier is not Spyderbyte-owned');
}
const schemes = tauri.plugins?.['deep-link']?.desktop?.schemes;
if (!Array.isArray(schemes) || !schemes.includes('spyderbyte')) {
  throw new Error('Spyderbyte deep-link scheme is not configured');
}
const endpoint = tauri.plugins?.updater?.endpoints?.[0];
if (typeof endpoint !== 'string' || !endpoint.startsWith('https://')) {
  throw new Error('Tauri updater endpoint is not HTTPS');
}

const workflow = readFileSync(join(root, '.github/workflows/verify.yml'), 'utf8');
for (const required of [
  'pnpm audit --audit-level=high',
  'gitleaks/gitleaks-action',
  'trivy-action',
]) {
  if (!workflow.includes(required)) throw new Error(`Phase 11 CI gate is missing: ${required}`);
}

const releaseRoot = mkdtempSync(join(tmpdir(), 'spyderbyte-phase11-release-'));
try {
  const artifactPath = join(releaseRoot, 'Spyderbyte_0.0.2_arm64.AppImage');
  writeFileSync(artifactPath, 'phase11 release fixture');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const manifest = createReleaseManifest({
    artifactPath,
    version: '0.0.2',
    channel: 'nightly',
    platform: 'linux',
    architecture: 'arm64',
    artifactBaseUrl: 'https://updates.spyderbyte.com/releases',
    signingKey: privateKey,
    publishedAt: '2026-08-07T00:00:00.000Z',
  });
  verifyReleaseManifest({
    artifactPath,
    manifest,
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  });
} finally {
  rmSync(releaseRoot, { recursive: true, force: true });
}

const evidence = {
  schemaVersion: 1,
  status: 'passed',
  scope: 'local-release-controls',
  channels: RELEASE_CHANNELS,
  releaseTargets: RELEASE_TARGETS,
  checks: [
    'release target matrix',
    'signed artifact manifest fixture',
    'updater HTTPS endpoint',
    'Spyderbyte desktop identity',
    'deep-link preparation',
    'operations target and runbook presence',
  ],
  evaluatedAt: new Date().toISOString(),
};
console.log(JSON.stringify(evidence, null, 2));
