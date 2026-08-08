import { createHash, verify as verifySignature } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runtimeError } from '@agentic-platform/runtime-contracts';

export type UpdateChannel = 'stable' | 'beta' | 'nightly' | 'developer';
export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready-to-install'
  | 'up-to-date'
  | 'unconfigured'
  | 'failed'
  | 'rollback-requested';

export interface SpyderbyteUpdateManifestV1 {
  readonly product: 'Spyderbyte';
  readonly version: string;
  readonly channel: UpdateChannel;
  readonly platform: string;
  readonly architecture: string;
  readonly minimumOs: string;
  readonly releaseNotes: string;
  readonly artifactUrl: string;
  readonly artifactDigest: string;
  readonly signature: string;
  readonly publishedAt: string;
}

export interface UpdateStatus {
  readonly product: 'Spyderbyte';
  readonly currentVersion: string;
  readonly channel: UpdateChannel;
  readonly platform: string;
  readonly architecture: string;
  readonly state: UpdateState;
  readonly lastCheckedAt?: string;
  readonly available?: SpyderbyteUpdateManifestV1;
  readonly downloadedPath?: string;
  readonly downloadedDigest?: string;
  readonly lastError?: string;
  readonly workspacePreserved: true;
}

export interface UpdateServiceOptions {
  readonly rootPath: string;
  readonly currentVersion?: string;
  readonly channel?: UpdateChannel;
  readonly platform?: string;
  readonly architecture?: string;
  readonly endpoint?: string;
  readonly target?: string;
  /** PEM/SPKI Ed25519 public key used to verify the signed update metadata. */
  readonly publicKey?: string;
  /** Production endpoints must set this; local fixtures may explicitly opt out. */
  readonly requireSignature?: boolean;
  readonly fetcher?: typeof fetch;
  readonly clock?: () => string;
  readonly onInstall?: (
    manifest: SpyderbyteUpdateManifestV1,
    downloadedPath: string,
  ) => Promise<void>;
  readonly onRollback?: () => Promise<void>;
}

function versionParts(value: string): number[] {
  const base = value.split(/[+-]/, 1)[0] ?? '0';
  return base
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function expectedDigest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function signedPayload(manifest: SpyderbyteUpdateManifestV1): string {
  return JSON.stringify({
    product: manifest.product,
    version: manifest.version,
    channel: manifest.channel,
    platform: manifest.platform,
    architecture: manifest.architecture,
    minimumOs: manifest.minimumOs,
    releaseNotes: manifest.releaseNotes,
    artifactUrl: manifest.artifactUrl,
    artifactDigest: manifest.artifactDigest,
    publishedAt: manifest.publishedAt,
  });
}

export function verifyUpdateManifestSignature(
  manifest: SpyderbyteUpdateManifestV1,
  publicKey: string,
): boolean {
  try {
    return verifySignature(
      null,
      Buffer.from(signedPayload(manifest)),
      publicKey,
      Buffer.from(manifest.signature, 'base64'),
    );
  } catch {
    return false;
  }
}

function validateManifest(
  manifest: SpyderbyteUpdateManifestV1,
  current: { version: string; channel: UpdateChannel; platform: string; architecture: string },
  publicKey: string | undefined,
  requireSignature: boolean,
): void {
  if (manifest.product !== 'Spyderbyte')
    throw runtimeError('POLICY_DENIED', 'Update product does not match Spyderbyte');
  if (manifest.channel !== current.channel)
    throw runtimeError('POLICY_DENIED', 'Update channel does not match the selected channel');
  if (manifest.platform !== current.platform || manifest.architecture !== current.architecture) {
    throw runtimeError('POLICY_DENIED', 'Update platform or architecture does not match this app');
  }
  if (compareVersions(manifest.version, current.version) <= 0)
    throw runtimeError(
      'VALIDATION_INVALID_INPUT',
      'Update is not newer than the installed version',
    );
  if (!manifest.artifactUrl.startsWith('https://'))
    throw runtimeError('POLICY_DENIED', 'Update artifact must use HTTPS');
  if (!/^sha256:[a-f0-9]{64}$/.test(manifest.artifactDigest))
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Update artifact digest is invalid');
  if (manifest.signature.trim().length === 0)
    throw runtimeError('POLICY_DENIED', 'Update signature is missing');
  if (requireSignature && publicKey === undefined) {
    throw runtimeError('POLICY_DENIED', 'A public key is required to verify update metadata');
  }
  if (publicKey !== undefined && !verifyUpdateManifestSignature(manifest, publicKey)) {
    throw runtimeError('POLICY_DENIED', 'Update metadata signature is invalid');
  }
}

export class SpyderbyteUpdateService {
  private readonly rootPath: string;
  private readonly currentVersion: string;
  private readonly channel: UpdateChannel;
  private readonly platform: string;
  private readonly architecture: string;
  private readonly endpoint: string | undefined;
  private readonly target: string;
  private readonly publicKey: string | undefined;
  private readonly requireSignature: boolean;
  private readonly fetcher: typeof fetch;
  private readonly clock: () => string;
  private readonly onInstall: UpdateServiceOptions['onInstall'] | undefined;
  private readonly onRollback: UpdateServiceOptions['onRollback'] | undefined;
  private current: UpdateStatus;

  constructor(options: UpdateServiceOptions) {
    this.rootPath = options.rootPath;
    this.currentVersion = options.currentVersion ?? '0.0.1';
    this.channel = options.channel ?? 'stable';
    this.platform = options.platform ?? process.platform;
    this.architecture = options.architecture ?? process.arch;
    this.endpoint = options.endpoint;
    this.publicKey = options.publicKey;
    this.requireSignature = options.requireSignature ?? options.endpoint !== undefined;
    this.target =
      options.target ??
      process.env['SPYDERBYTE_UPDATE_TARGET'] ??
      (this.platform === 'darwin'
        ? `${this.architecture === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`
        : this.platform);
    this.fetcher = options.fetcher ?? fetch;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.onInstall = options.onInstall;
    this.onRollback = options.onRollback;
    this.current = {
      product: 'Spyderbyte',
      currentVersion: this.currentVersion,
      channel: this.channel,
      platform: this.platform,
      architecture: this.architecture,
      state: this.endpoint === undefined ? 'unconfigured' : 'idle',
      workspacePreserved: true,
    };
  }

  status(): UpdateStatus {
    return structuredClone(this.current);
  }

  async check(): Promise<UpdateStatus> {
    if (this.endpoint === undefined) {
      this.current = { ...this.current, state: 'unconfigured', lastCheckedAt: this.clock() };
      return this.status();
    }
    const checking = { ...this.current };
    delete checking.lastError;
    this.current = { ...checking, state: 'checking', lastCheckedAt: this.clock() };
    try {
      const url = new URL(
        this.endpoint
          .replaceAll('{{target}}', encodeURIComponent(this.target))
          .replaceAll('{{arch}}', encodeURIComponent(this.architecture))
          .replaceAll('{{current_version}}', encodeURIComponent(this.currentVersion)),
      );
      url.searchParams.set('product', 'Spyderbyte');
      url.searchParams.set('version', this.currentVersion);
      url.searchParams.set('channel', this.channel);
      url.searchParams.set('platform', this.platform);
      url.searchParams.set('architecture', this.architecture);
      const response = await this.fetcher(url, { headers: { accept: 'application/json' } });
      if (response.status === 204) {
        this.current = { ...this.current, state: 'up-to-date', lastCheckedAt: this.clock() };
        return this.status();
      }
      if (!response.ok) throw new Error(`Update check returned ${response.status}`);
      const manifest = (await response.json()) as SpyderbyteUpdateManifestV1;
      validateManifest(
        manifest,
        {
          version: this.currentVersion,
          channel: this.channel,
          platform: this.platform,
          architecture: this.architecture,
        },
        this.publicKey,
        this.requireSignature,
      );
      this.current = {
        ...this.current,
        state: 'available',
        available: manifest,
        lastCheckedAt: this.clock(),
      };
      return this.status();
    } catch (error) {
      this.current = {
        ...this.current,
        state: 'failed',
        lastError: error instanceof Error ? error.message : String(error),
        lastCheckedAt: this.clock(),
      };
      return this.status();
    }
  }

  async download(): Promise<UpdateStatus> {
    const manifest = this.current.available;
    if (manifest === undefined)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Check for an update before downloading');
    const downloading = { ...this.current };
    delete downloading.lastError;
    this.current = { ...downloading, state: 'downloading' };
    try {
      const response = await this.fetcher(manifest.artifactUrl, {
        headers: { accept: 'application/octet-stream' },
      });
      if (!response.ok) throw new Error(`Update download returned ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const digest = expectedDigest(bytes);
      if (digest !== manifest.artifactDigest)
        throw runtimeError(
          'POLICY_DENIED',
          'Downloaded update digest does not match signed metadata',
        );
      const destination = join(
        this.rootPath,
        '.agentic',
        'updates',
        `Spyderbyte-${manifest.version}-${manifest.architecture}.update`,
      );
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes, { mode: 0o600 });
      this.current = {
        ...this.current,
        state: 'ready-to-install',
        downloadedPath: destination,
        downloadedDigest: digest,
      };
      return this.status();
    } catch (error) {
      this.current = {
        ...this.current,
        state: 'failed',
        lastError: error instanceof Error ? error.message : String(error),
      };
      return this.status();
    }
  }

  async install(): Promise<UpdateStatus> {
    const manifest = this.current.available;
    const downloadedPath = this.current.downloadedPath;
    if (manifest === undefined || downloadedPath === undefined)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Download an update before installation');
    if (this.onInstall === undefined) {
      this.current = {
        ...this.current,
        state: 'ready-to-install',
        lastError: 'The desktop installer must confirm installation and restart Spyderbyte.',
      };
      return this.status();
    }
    await this.onInstall(manifest, downloadedPath);
    return this.status();
  }

  async rollback(): Promise<UpdateStatus> {
    if (this.onRollback === undefined) {
      this.current = {
        ...this.current,
        state: 'rollback-requested',
        lastError: 'Rollback is delegated to the signed desktop updater.',
      };
      return this.status();
    }
    await this.onRollback();
    this.current = { ...this.current, state: 'rollback-requested' };
    return this.status();
  }
}
