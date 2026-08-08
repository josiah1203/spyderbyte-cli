import { createHash } from 'node:crypto';
import {
  accessSync,
  constants,
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

const root = resolve(new URL('../..', import.meta.url).pathname);
const outputRoot = join(root, 'apps/desktop/src-tauri/resources/bridges');
const release = process.env['AGENTIC_RELEASE_BUILD'] === 'true';
const entries = [
  ['adobe-premiere', 'SPYDERBYTE_PREMIERE_BRIDGE_BIN', 'SPYDERBYTE_PREMIERE_BRIDGE_SIGNATURE'],
  ['blackmagic-resolve', 'SPYDERBYTE_RESOLVE_BRIDGE_BIN', 'SPYDERBYTE_RESOLVE_BRIDGE_SIGNATURE'],
  ['apple-final-cut', 'SPYDERBYTE_FINAL_CUT_BRIDGE_BIN', 'SPYDERBYTE_FINAL_CUT_BRIDGE_SIGNATURE'],
  ['local-media-bridge', 'SPYDERBYTE_MEDIA_BRIDGE_BIN', 'SPYDERBYTE_MEDIA_BRIDGE_SIGNATURE'],
];
const operations = [
  'listProjects',
  'readTimeline',
  'importAsset',
  'updateTimeline',
  'startRender',
  'observeRender',
  'exportMedia',
  'publishResult',
];

for (const [bridgeId, binaryEnv, signatureEnv] of entries) {
  const sourceValue = process.env[binaryEnv];
  const signature = process.env[signatureEnv];
  const directory = join(outputRoot, bridgeId);
  mkdirSync(directory, { recursive: true });
  if (sourceValue === undefined || sourceValue.trim().length === 0) {
    if (release) throw new Error(`Production builds require ${binaryEnv}.`);
    continue;
  }
  if (release && (signature === undefined || signature.trim().length === 0)) {
    throw new Error(`Production builds require ${signatureEnv}.`);
  }
  const source = resolve(sourceValue);
  try {
    accessSync(source, constants.X_OK);
  } catch {
    throw new Error(`${binaryEnv} is not an executable file: ${source}`);
  }
  const output = join(directory, 'bridge');
  copyFileSync(source, output);
  const unsigned = {
    schemaVersion: 1,
    product: 'Spyderbyte',
    bridgeId,
    displayName: bridgeId,
    version: process.env['SPYDERBYTE_BRIDGE_VERSION'] ?? 'bundled',
    platform: process.platform,
    operations,
    executableDigest: `sha256:${createHash('sha256').update(readFileSync(output)).digest('hex')}`,
    signedAt: new Date().toISOString(),
  };
  writeFileSync(
    join(directory, 'runtime-manifest.json'),
    `${JSON.stringify({ ...unsigned, signature: signature ?? 'development-unverified' }, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(`Local bridge bundled: ${bridgeId}`);
}
