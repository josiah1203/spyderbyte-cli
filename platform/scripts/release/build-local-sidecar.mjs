import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const root = resolve(new URL('../..', import.meta.url).pathname);
const desktopRoot = resolve(root, 'apps/desktop');
const localDaemonEntry = resolve(root, 'apps/local-daemon/dist/sidecar.js');
const bundleRoot = resolve(desktopRoot, '.sidecar-build');
const bundleEntry = resolve(bundleRoot, 'sidecar.cjs');
const binariesRoot = resolve(desktopRoot, 'src-tauri/binaries');
const pkgCachePath = process.env.PKG_CACHE_PATH ?? resolve(desktopRoot, '.pkg-cache');
const esbuildBin = existsSync(resolve(desktopRoot, 'node_modules/.bin/esbuild'))
  ? resolve(desktopRoot, 'node_modules/.bin/esbuild')
  : resolve(root, 'node_modules/.pnpm/node_modules/.bin/esbuild');

if (!existsSync(localDaemonEntry)) {
  throw new Error('Build apps/local-daemon before packaging its desktop sidecar');
}

const hostTargetTriple = execFileSync('rustc', ['--print', 'host-tuple'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const releasePlatform = process.env.SPYDERBYTE_RELEASE_PLATFORM ?? process.platform;
const normalizedPlatform = releasePlatform === 'win32' ? 'windows' : releasePlatform;
const releaseArchitecture =
  process.env.SPYDERBYTE_RELEASE_ARCHITECTURE ?? process.env.TAURI_ENV_ARCH ?? process.arch;

function defaultTargetTriple(platform, architecture) {
  if (platform === 'darwin') {
    return architecture === 'arm64' || architecture === 'aarch64'
      ? 'aarch64-apple-darwin'
      : 'x86_64-apple-darwin';
  }
  if (platform === 'linux') {
    return architecture === 'arm64' || architecture === 'aarch64'
      ? 'aarch64-unknown-linux-gnu'
      : 'x86_64-unknown-linux-gnu';
  }
  if (platform === 'windows') return 'x86_64-pc-windows-msvc';
  return hostTargetTriple;
}

const tauriTargetTriple = defaultTargetTriple(normalizedPlatform, releaseArchitecture);
const requestedTargets = (process.env.AGENTIC_SIDECAR_TARGETS ?? tauriTargetTriple)
  .split(',')
  .map((target) => target.trim())
  .filter(Boolean);
const supportedTargets = new Set([
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'aarch64-unknown-linux-gnu',
  'x86_64-unknown-linux-gnu',
  'x86_64-pc-windows-msvc',
]);
if (requestedTargets.some((target) => !supportedTargets.has(target))) {
  throw new Error(
    `Spyderbyte sidecar packaging received an unsupported target: ${requestedTargets.join(', ')}`,
  );
}

mkdirSync(bundleRoot, { recursive: true });
mkdirSync(binariesRoot, { recursive: true });
mkdirSync(pkgCachePath, { recursive: true });

execFileSync(
  esbuildBin,
  [
    localDaemonEntry,
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--target=node22',
    `--outfile=${bundleEntry}`,
  ],
  { cwd: root, stdio: 'inherit' },
);

for (const targetTriple of requestedTargets) {
  if (
    process.platform === 'darwin' &&
    process.arch === 'x64' &&
    targetTriple === 'aarch64-apple-darwin'
  ) {
    throw new Error(
      'Building the arm64 Spyderbyte sidecar requires an arm64 macOS runner; pkg cannot execute its arm64 bootstrap on an Intel host',
    );
  }
  const pkgTarget = {
    'aarch64-apple-darwin': 'node22-macos-arm64',
    'x86_64-apple-darwin': 'node22-macos-x64',
    'aarch64-unknown-linux-gnu': 'node22-linux-arm64',
    'x86_64-unknown-linux-gnu': 'node22-linux-x64',
    'x86_64-pc-windows-msvc': 'node22-win-x64',
  }[targetTriple];
  const outputName = `agentic-local-daemon-${targetTriple}${targetTriple.includes('windows') ? '.exe' : ''}`;
  execFileSync(
    resolve(desktopRoot, 'node_modules/.bin/pkg'),
    [
      bundleEntry,
      '--config',
      resolve(desktopRoot, 'pkg.config.json'),
      '--targets',
      pkgTarget,
      '--output',
      resolve(binariesRoot, outputName),
    ],
    {
      cwd: desktopRoot,
      stdio: 'inherit',
      env: { ...process.env, PKG_CACHE_PATH: pkgCachePath },
    },
  );
}

process.stdout.write(`Built Spyderbyte sidecar for ${requestedTargets.join(', ')}\n`);
