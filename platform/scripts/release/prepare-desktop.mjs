import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';

const root = resolve(new URL('../..', import.meta.url).pathname);
const buildFrontend = resolve(root, 'scripts/release/build-frontend.mjs');
const prepareMeltano = resolve(root, 'scripts/release/prepare-meltano-runtime.mjs');
const prepareUpdater = resolve(root, 'scripts/release/prepare-updater-config.mjs');
const prepareBridges = resolve(root, 'scripts/release/prepare-local-bridges.mjs');

execFileSync(process.execPath, [buildFrontend], { cwd: root, stdio: 'inherit' });
execFileSync(process.execPath, [prepareMeltano], { cwd: root, stdio: 'inherit' });
execFileSync(process.execPath, [prepareUpdater], { cwd: root, stdio: 'inherit' });
execFileSync(process.execPath, [prepareBridges], { cwd: root, stdio: 'inherit' });
execFileSync('pnpm', ['--filter', '@agentic-platform/desktop', 'build:sidecar'], {
  cwd: root,
  stdio: 'inherit',
});
