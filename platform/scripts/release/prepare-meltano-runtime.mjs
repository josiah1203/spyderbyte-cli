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
const resourceRoot = join(root, 'apps/desktop/src-tauri/resources/meltano');
const outputBinary = join(resourceRoot, 'meltano');
const outputManifest = join(resourceRoot, 'runtime-manifest.json');
const configured = process.env['SPYDERBYTE_MELTANO_BIN'];
const release = process.env['AGENTIC_RELEASE_BUILD'] === 'true';

mkdirSync(resourceRoot, { recursive: true });

if (configured === undefined || configured.trim().length === 0) {
  if (release) {
    throw new Error(
      'Production Spyderbyte builds require SPYDERBYTE_MELTANO_BIN to point to the signed Meltano executable.',
    );
  }
  console.log('Meltano runtime: not bundled (set SPYDERBYTE_MELTANO_BIN to package one).');
  process.exit(0);
}

const source = resolve(configured);
try {
  accessSync(source, constants.X_OK);
} catch {
  throw new Error(`SPYDERBYTE_MELTANO_BIN is not an executable file: ${source}`);
}

copyFileSync(source, outputBinary);
const digest = `sha256:${createHash('sha256').update(readFileSync(outputBinary)).digest('hex')}`;
const version = process.env['SPYDERBYTE_MELTANO_VERSION'] ?? 'bundled';
const publicKey = process.env['SPYDERBYTE_MELTANO_PUBLIC_KEY'];
const signature = process.env['SPYDERBYTE_MELTANO_SIGNATURE'];
if (release && (publicKey === undefined || signature === undefined)) {
  throw new Error(
    'Production Meltano packaging requires SPYDERBYTE_MELTANO_PUBLIC_KEY and SPYDERBYTE_MELTANO_SIGNATURE.',
  );
}

const manifest = {
  schemaVersion: 1,
  product: 'Spyderbyte',
  version,
  platform: process.platform,
  architecture: process.arch,
  executableDigest: digest,
  // The signature covers the canonical manifest without this field. The private key never enters
  // the repository; release automation supplies the detached Ed25519 signature.
  signature: signature ?? 'development-unverified',
  signedAt: new Date().toISOString(),
};
writeFileSync(outputManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(`Meltano runtime bundled: ${outputBinary}`);
