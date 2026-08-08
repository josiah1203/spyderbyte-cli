import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import {
  findReleaseTarget,
  normalizeReleaseArchitecture,
  normalizeReleasePlatform,
} from './release-targets.mjs';

const root = resolve(new URL('../..', import.meta.url).pathname);
const desktopRoot = join(root, 'apps/desktop');
const generatedConfig = join(desktopRoot, 'src-tauri/tauri.generated.conf.json');
const platform = normalizeReleasePlatform(
  process.env['SPYDERBYTE_RELEASE_PLATFORM'] ?? process.platform,
);
const architecture = normalizeReleaseArchitecture(
  process.env['SPYDERBYTE_RELEASE_ARCHITECTURE'] ?? process.arch,
);
const target = findReleaseTarget(platform, architecture);
if (target === undefined) {
  throw new Error(`Unsupported Spyderbyte release target: ${platform}/${architecture}`);
}

const environment = {
  ...process.env,
  AGENTIC_RELEASE_BUILD: process.env['AGENTIC_RELEASE_BUILD'] ?? 'false',
  SPYDERBYTE_RELEASE_PLATFORM: platform,
  SPYDERBYTE_RELEASE_ARCHITECTURE: architecture,
  AGENTIC_SIDECAR_TARGETS: target.target,
};

if (process.env['SPYDERBYTE_RELEASE_DRY_RUN'] === 'true') {
  console.log(
    JSON.stringify(
      {
        status: 'planned',
        platform,
        architecture,
        target: target.target,
        installer: target.installer,
        generatedConfig,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

execFileSync(process.execPath, [join(root, 'scripts/release/prepare-desktop.mjs')], {
  cwd: root,
  env: environment,
  stdio: 'inherit',
});
execFileSync(
  'pnpm',
  [
    '--dir',
    desktopRoot,
    'exec',
    'tauri',
    'build',
    '--config',
    generatedConfig,
    '--target',
    target.target,
    '--bundles',
    target.installer,
  ],
  { cwd: root, env: environment, stdio: 'inherit' },
);

const bundleRoot = join(desktopRoot, 'src-tauri/target');
const artifactExtensions = {
  dmg: ['.dmg'],
  appimage: ['.AppImage'],
  nsis: ['.exe'],
};
const candidates = [];
function collect(directory) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collect(path);
    else if (artifactExtensions[target.installer]?.some((suffix) => entry.name.endsWith(suffix))) {
      candidates.push(path);
    }
  }
}
collect(bundleRoot);
console.log(
  JSON.stringify(
    {
      status: 'built',
      platform,
      architecture,
      target: target.target,
      installer: target.installer,
      artifacts: candidates.sort(),
    },
    null,
    2,
  ),
);
