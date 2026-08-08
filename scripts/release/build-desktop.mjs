import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const root = resolve(new URL('../..', import.meta.url).pathname);
const desktopRoot = resolve(root, 'apps/desktop');
const prepareDesktop = resolve(root, 'scripts/release/prepare-desktop.mjs');
const generatedConfig = resolve(desktopRoot, 'src-tauri/tauri.generated.conf.json');
const requireDmg = process.env.AGENTIC_REQUIRE_DMG === 'true';

function desktopBuildEnvironment() {
  const environment = { ...process.env, CI: 'true' };
  if (process.env.AGENTIC_RELEASE_BUILD === 'true') return environment;
  if (process.env.AGENTIC_USE_DEVELOPMENT_LICENSE === 'false') return environment;
  const publicKeyPath = resolve(desktopRoot, 'dev/development-public-key.txt');
  const keyIdPath = resolve(desktopRoot, 'dev/development-key-id.txt');
  try {
    return {
      ...environment,
      AGENTIC_LICENSE_PUBLIC_KEY:
        process.env.AGENTIC_LICENSE_PUBLIC_KEY ?? readFileSync(publicKeyPath, 'utf8').trim(),
      AGENTIC_LICENSE_KEY_ID:
        process.env.AGENTIC_LICENSE_KEY_ID ?? readFileSync(keyIdPath, 'utf8').trim(),
      AGENTIC_DEVELOPMENT_LICENSE: 'true',
    };
  } catch {
    return environment;
  }
}

if (process.platform !== 'darwin') {
  if (requireDmg) {
    throw new Error('Spyderbyte DMG packaging requires macOS');
  }
  execFileSync(process.execPath, [prepareDesktop], { cwd: root, stdio: 'inherit' });
  execFileSync(
    'cargo',
    ['build', '--release', '--manifest-path', resolve(desktopRoot, 'src-tauri/Cargo.toml')],
    { cwd: root, stdio: 'inherit' },
  );
} else {
  execFileSync(process.execPath, [prepareDesktop], {
    cwd: root,
    stdio: 'inherit',
    env: desktopBuildEnvironment(),
  });
  execFileSync(
    'pnpm',
    ['exec', 'tauri', 'build', '--config', generatedConfig, '--bundles', 'app'],
    {
      cwd: desktopRoot,
      stdio: 'inherit',
      env: desktopBuildEnvironment(),
    },
  );
  if (requireDmg) {
    execFileSync('bash', [resolve(root, 'scripts/release/package-local-dmg.sh')], {
      cwd: root,
      stdio: 'inherit',
      env: desktopBuildEnvironment(),
    });
  } else {
    console.log('Spyderbyte app bundle built; DMG packaging is opt-in via pnpm bundle:dmg.');
  }
}
