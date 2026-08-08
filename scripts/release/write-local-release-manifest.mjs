import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';

const root = resolve(new URL('../..', import.meta.url).pathname);
const dmgArgument = process.argv[2];
if (dmgArgument === undefined) throw new Error('A DMG path is required');
const dmgPath = resolve(dmgArgument);
const appPath = resolve(
  process.argv[3] ??
    join(root, 'apps/desktop/src-tauri/target/release/bundle/macos/Spyderbyte.app'),
);
const architecture = normalizeArchitecture(process.argv[4] ?? process.arch);

const tauriConfigPath = join(root, 'apps/desktop/src-tauri/tauri.conf.json');
const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, 'utf8'));
const dmgFilename = basename(dmgPath);
const checksumPath = `${dmgPath}.sha256`;
const manifestPath = `${dmgPath}.manifest.json`;
const executable = plistValue(join(appPath, 'Contents/Info.plist'), 'CFBundleExecutable');
const mainExecutablePath =
  executable === undefined ? undefined : join(appPath, 'Contents/MacOS', executable);
const sidecarPath = join(appPath, 'Contents/MacOS/agentic-local-daemon');

const manifest = {
  schemaVersion: 1,
  product: {
    name: tauriConfig.productName,
    version: tauriConfig.version,
    identifier: tauriConfig.identifier,
    minimumMacOS: tauriConfig.bundle?.macOS?.minimumSystemVersion,
  },
  release: {
    status: process.env['AGENTIC_RELEASE_BUILD'] === 'true' ? 'production' : 'developer',
    architecture,
    supportedArchitectures: ['x86_64', 'arm64'],
    supportedMacOS: `>=${tauriConfig.bundle?.macOS?.minimumSystemVersion ?? '13.0'}`,
  },
  artifact: {
    filename: dmgFilename,
    format: 'UDZO/HFS+',
    sha256: sha256File(dmgPath),
    checksumFile: basename(checksumPath),
    manifestFile: basename(manifestPath),
  },
  app: {
    bundleRelativePath: basename(appPath),
    executable,
    architectures: {
      main: binaryArchitectures(mainExecutablePath),
      sidecar: binaryArchitectures(sidecarPath),
    },
  },
  source: {
    revision: command('git', ['-C', root, 'rev-parse', 'HEAD']),
    lockfileSha256: sha256File(join(root, 'pnpm-lock.yaml')),
    tauriConfigSha256: sha256File(tauriConfigPath),
  },
  toolchain: {
    node: process.version,
    pnpm: command('pnpm', ['--version']),
    rustc: command('rustc', ['--version']),
    packager: 'repo-owned hdiutil create -format UDZO -fs HFS+ -imagekey zlib-level=9',
  },
};

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
console.log(`Spyderbyte release manifest: ${manifestPath}`);

function normalizeArchitecture(value) {
  switch (value) {
    case 'arm64':
    case 'aarch64':
      return 'arm64';
    case 'x86_64':
    case 'x64':
    case 'ia32':
      return 'x86_64';
    case 'universal':
    case 'universal2':
      return 'universal';
    default:
      return value;
  }
}

function command(commandName, args) {
  try {
    return execFileSync(commandName, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function plistValue(path, key) {
  const output = command('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path]);
  return output === undefined || output.length === 0 ? undefined : output;
}

function binaryArchitectures(path) {
  if (path === undefined) return { status: 'not-declared' };
  const output = command('lipo', ['-info', path]);
  return output === undefined ? { status: 'unavailable' } : { status: 'ok', lipoInfo: output };
}
