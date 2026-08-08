import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

const root = resolve(new URL('../..', import.meta.url).pathname);
const sourcePath = join(root, 'apps/desktop/src-tauri/tauri.conf.json');
const outputPath = join(root, 'apps/desktop/src-tauri/tauri.generated.conf.json');
const release = process.env['AGENTIC_RELEASE_BUILD'] === 'true';
const endpoint = process.env['SPYDERBYTE_UPDATE_ENDPOINT'];
const publicKey = process.env['SPYDERBYTE_UPDATE_PUBLIC_KEY'];

if (release && (endpoint === undefined || endpoint.trim().length === 0)) {
  throw new Error('Production Spyderbyte builds require SPYDERBYTE_UPDATE_ENDPOINT.');
}
if (release && (publicKey === undefined || publicKey.trim().length === 0)) {
  throw new Error('Production Spyderbyte builds require SPYDERBYTE_UPDATE_PUBLIC_KEY.');
}

const config = JSON.parse(readFileSync(sourcePath, 'utf8'));
// The release wrapper runs preparation before invoking Tauri. The canonical config retains its
// beforeBuildCommand for direct development builds; the generated release config must not recurse.
config.build.beforeBuildCommand = '';
if (endpoint !== undefined && publicKey !== undefined) {
  config.plugins ??= {};
  config.plugins.updater ??= {};
  config.plugins.updater.pubkey = publicKey;
  config.plugins.updater.endpoints = [endpoint];
}
writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
console.log(`Spyderbyte updater config prepared: ${outputPath}`);
