import { createHash, verify } from 'node:crypto';
import { accessSync, constants, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

const root = resolve(new URL('../..', import.meta.url).pathname);
const executable = resolve(
  process.env['SPYDERBYTE_MELTANO_BIN'] ??
    join(root, 'apps/desktop/src-tauri/resources/meltano/meltano'),
);
const manifestPath = resolve(
  process.env['SPYDERBYTE_MELTANO_MANIFEST'] ?? join(dirname(executable), 'runtime-manifest.json'),
);
const publicKey = process.env['SPYDERBYTE_MELTANO_PUBLIC_KEY'];

accessSync(executable, constants.X_OK);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const digest = `sha256:${createHash('sha256').update(readFileSync(executable)).digest('hex')}`;
if (manifest.product !== 'Spyderbyte' || manifest.executableDigest !== digest) {
  throw new Error('Meltano runtime manifest does not match the executable digest.');
}
if (publicKey === undefined || manifest.signature === 'development-unverified') {
  throw new Error('A production Meltano verification requires SPYDERBYTE_MELTANO_PUBLIC_KEY.');
}
const { signature, ...unsigned } = manifest;
const valid = verify(
  null,
  Buffer.from(JSON.stringify(unsigned)),
  publicKey,
  Buffer.from(signature, 'base64'),
);
if (!valid) throw new Error('Meltano runtime signature verification failed.');
console.log(`Verified signed Meltano runtime: ${executable}`);
