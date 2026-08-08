import { createHash, verify } from 'node:crypto';
import { accessSync, constants, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { runtimeError, type JsonValue } from '@agentic-platform/runtime-contracts';
import type { OAuthConnection, OAuthService } from './oauth.js';

export interface ProviderActionManifestV1 {
  readonly schemaVersion: 1;
  readonly providerId: 'github' | 'google-drive' | 'slack' | 'youtube' | 'frame-io';
  readonly displayName: string;
  readonly operations: readonly string[];
  readonly scopes: readonly string[];
  readonly apiBase: string;
}

export interface ProviderActionRequestV1 {
  readonly providerId: ProviderActionManifestV1['providerId'];
  readonly connectionId: string;
  readonly operation: string;
  readonly input?: Record<string, JsonValue>;
}

export interface ProviderActionResultV1 {
  readonly providerId: ProviderActionManifestV1['providerId'];
  readonly connectionId: string;
  readonly operation: string;
  readonly status: 'completed';
  readonly output: JsonValue;
  readonly completedAt: string;
}

export interface ProviderActionRuntime {
  readonly available: boolean;
  list(): readonly ProviderActionManifestV1[];
  execute(input: ProviderActionRequestV1): Promise<ProviderActionResultV1>;
}

const PROVIDER_ACTIONS: readonly ProviderActionManifestV1[] = [
  {
    schemaVersion: 1,
    providerId: 'github',
    displayName: 'GitHub',
    operations: ['listRepositories', 'createPullRequest', 'mergePullRequest'],
    scopes: ['repo'],
    apiBase: 'https://api.github.com',
  },
  {
    schemaVersion: 1,
    providerId: 'google-drive',
    displayName: 'Google Drive',
    operations: ['listFiles'],
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    apiBase: 'https://www.googleapis.com/drive/v3',
  },
  {
    schemaVersion: 1,
    providerId: 'slack',
    displayName: 'Slack',
    operations: ['sendMessage'],
    scopes: ['chat:write'],
    apiBase: 'https://slack.com/api',
  },
  {
    schemaVersion: 1,
    providerId: 'youtube',
    displayName: 'YouTube',
    operations: ['listChannels'],
    scopes: ['https://www.googleapis.com/auth/youtube.readonly'],
    apiBase: 'https://www.googleapis.com/youtube/v3',
  },
  {
    schemaVersion: 1,
    providerId: 'frame-io',
    displayName: 'Frame.io',
    operations: ['listProjects'],
    scopes: ['project:read'],
    apiBase: 'https://api.frame.io/v2',
  },
];

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requiredString(input: Record<string, JsonValue>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${key} is required`);
  }
  return value.trim();
}

function positiveInteger(input: Record<string, JsonValue>, key: string, fallback: number): number {
  const value = input[key];
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1000) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${key} must be a positive bounded integer`);
  }
  return value as number;
}

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => jsonValue(item));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, jsonValue(item)]),
    );
  }
  return String(value);
}

function assertHttps(url: string): void {
  if (!url.startsWith('https://'))
    throw runtimeError('POLICY_DENIED', 'Provider URL must use HTTPS');
}

export class CloudProviderActionRuntime implements ProviderActionRuntime {
  readonly available = true;

  constructor(
    private readonly options: {
      readonly oauth: OAuthService;
      readonly fetcher?: typeof fetch;
      readonly clock?: () => string;
    },
  ) {}

  list(): readonly ProviderActionManifestV1[] {
    return structuredClone(PROVIDER_ACTIONS);
  }

  async execute(input: ProviderActionRequestV1): Promise<ProviderActionResultV1> {
    const manifest = PROVIDER_ACTIONS.find((item) => item.providerId === input.providerId);
    if (manifest === undefined) {
      throw runtimeError('VALIDATION_INVALID_INPUT', `Unknown provider ${input.providerId}`);
    }
    if (!manifest.operations.includes(input.operation)) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        `Provider operation ${input.operation} is not supported by ${input.providerId}`,
      );
    }
    const connection = this.connection(input.connectionId, input.providerId);
    const token = await this.accessToken(connection);
    const output = await this.executeProvider(manifest, token, input.operation, input.input ?? {});
    return {
      providerId: input.providerId,
      connectionId: input.connectionId,
      operation: input.operation,
      status: 'completed',
      output,
      completedAt: this.options.clock?.() ?? new Date().toISOString(),
    };
  }

  private connection(connectionId: string, providerId: string): OAuthConnection {
    const connection = this.options.oauth
      .listConnections()
      .find((item) => item.connectionId === connectionId && item.connectorId === providerId);
    if (connection === undefined) {
      throw runtimeError('POLICY_DENIED', `A connected ${providerId} account is required`);
    }
    return connection;
  }

  private async accessToken(connection: OAuthConnection): Promise<string> {
    let raw = await this.options.oauth.credential(connection.connectionId);
    let payload = this.parseCredential(raw);
    let token = typeof payload['access_token'] === 'string' ? payload['access_token'] : undefined;
    if (token === undefined && connection.status === 'expired') {
      await this.options.oauth.refresh(connection.connectionId);
      raw = await this.options.oauth.credential(connection.connectionId);
      payload = this.parseCredential(raw);
      token = typeof payload['access_token'] === 'string' ? payload['access_token'] : undefined;
    }
    if (token === undefined || token.trim().length === 0) {
      throw runtimeError('POLICY_DENIED', 'The connected provider has no usable access token');
    }
    return token;
  }

  private parseCredential(raw: string | undefined): Record<string, unknown> {
    if (raw === undefined) return {};
    try {
      return record(JSON.parse(raw));
    } catch {
      throw runtimeError('POLICY_DENIED', 'The connected provider credential is invalid');
    }
  }

  private async executeProvider(
    manifest: ProviderActionManifestV1,
    token: string,
    operation: string,
    input: Record<string, JsonValue>,
  ): Promise<JsonValue> {
    switch (`${manifest.providerId}:${operation}`) {
      case 'github:listRepositories':
        return this.request(manifest, token, '/user/repos?per_page=100', 'GET');
      case 'github:createPullRequest': {
        const owner = requiredString(input, 'owner');
        const repo = requiredString(input, 'repo');
        return this.request(
          manifest,
          token,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
          'POST',
          {
            title: requiredString(input, 'title'),
            head: requiredString(input, 'head'),
            base: requiredString(input, 'base'),
            ...(typeof input['body'] === 'string' ? { body: input['body'] } : {}),
            ...(typeof input['draft'] === 'boolean' ? { draft: input['draft'] } : {}),
          },
        );
      }
      case 'github:mergePullRequest': {
        const owner = requiredString(input, 'owner');
        const repo = requiredString(input, 'repo');
        const number = positiveInteger(input, 'number', 1);
        return this.request(
          manifest,
          token,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/merge`,
          'PUT',
          {
            ...(typeof input['commitTitle'] === 'string'
              ? { commit_title: input['commitTitle'] }
              : {}),
            ...(typeof input['commitMessage'] === 'string'
              ? { commit_message: input['commitMessage'] }
              : {}),
            ...(typeof input['mergeMethod'] === 'string'
              ? { merge_method: input['mergeMethod'] }
              : {}),
          },
        );
      }
      case 'google-drive:listFiles': {
        const query = new URLSearchParams({
          pageSize: String(positiveInteger(input, 'pageSize', 100)),
          fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,size,webViewLink)',
        });
        if (typeof input['query'] === 'string' && input['query'].trim())
          query.set('q', input['query'].trim());
        if (typeof input['pageToken'] === 'string' && input['pageToken'].trim())
          query.set('pageToken', input['pageToken'].trim());
        return this.request(manifest, token, `/files?${query.toString()}`, 'GET');
      }
      case 'slack:sendMessage':
        return this.request(manifest, token, '/chat.postMessage', 'POST', {
          channel: requiredString(input, 'channel'),
          text: requiredString(input, 'text'),
        });
      case 'youtube:listChannels':
        return this.request(manifest, token, '/channels?part=snippet&mine=true', 'GET');
      case 'frame-io:listProjects':
        return this.request(manifest, token, '/accounts', 'GET');
      default:
        throw runtimeError(
          'VALIDATION_INVALID_INPUT',
          `Provider operation ${operation} is not implemented`,
        );
    }
  }

  private async request(
    manifest: ProviderActionManifestV1,
    token: string,
    path: string,
    method: 'GET' | 'POST' | 'PUT',
    body?: Record<string, JsonValue>,
  ): Promise<JsonValue> {
    const url = new URL(path, `${manifest.apiBase}/`);
    assertHttps(url.toString());
    const response = await (this.options.fetcher ?? fetch)(url, {
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw runtimeError(
        'EXTERNAL_DEPENDENCY_UNAVAILABLE',
        `${manifest.displayName} returned HTTP ${response.status}`,
      );
    }
    return jsonValue(payload);
  }
}

export interface LocalBridgeManifestV1 {
  readonly schemaVersion: 1;
  readonly product: 'Spyderbyte';
  readonly bridgeId:
    | 'adobe-premiere'
    | 'blackmagic-resolve'
    | 'apple-final-cut'
    | 'local-media-bridge';
  readonly displayName: string;
  readonly version: string;
  readonly platform: 'macos';
  readonly operations: readonly [
    'listProjects',
    'readTimeline',
    'importAsset',
    'updateTimeline',
    'startRender',
    'observeRender',
    'exportMedia',
    'publishResult',
  ];
  readonly executableDigest: string;
  readonly signature: string;
  readonly signedAt: string;
}

export interface LocalBridgeStatus {
  readonly bridgeId: LocalBridgeManifestV1['bridgeId'];
  readonly displayName: string;
  readonly operations: readonly string[];
  readonly executable?: string;
  readonly configured: boolean;
  readonly signed: boolean;
  readonly available: boolean;
  readonly reason?: string;
}

export interface LocalBridgeRuntime {
  list(): readonly LocalBridgeStatus[];
  execute(input: {
    readonly bridgeId: LocalBridgeManifestV1['bridgeId'];
    readonly operation: string;
    readonly input?: Record<string, JsonValue>;
  }): Promise<JsonValue>;
}

const BRIDGE_CATALOG: readonly {
  readonly bridgeId: LocalBridgeManifestV1['bridgeId'];
  readonly displayName: string;
  readonly executableEnv: string;
}[] = [
  {
    bridgeId: 'adobe-premiere',
    displayName: 'Adobe Premiere Pro',
    executableEnv: 'SPYDERBYTE_PREMIERE_BRIDGE_BIN',
  },
  {
    bridgeId: 'blackmagic-resolve',
    displayName: 'DaVinci Resolve',
    executableEnv: 'SPYDERBYTE_RESOLVE_BRIDGE_BIN',
  },
  {
    bridgeId: 'apple-final-cut',
    displayName: 'Final Cut Pro',
    executableEnv: 'SPYDERBYTE_FINAL_CUT_BRIDGE_BIN',
  },
  {
    bridgeId: 'local-media-bridge',
    displayName: 'Local media bridge',
    executableEnv: 'SPYDERBYTE_MEDIA_BRIDGE_BIN',
  },
];

const BRIDGE_OPERATIONS: LocalBridgeManifestV1['operations'] = [
  'listProjects',
  'readTimeline',
  'importAsset',
  'updateTimeline',
  'startRender',
  'observeRender',
  'exportMedia',
  'publishResult',
];

function bridgeKey(bridgeId: string): string {
  return bridgeId.replaceAll('-', '_').toUpperCase();
}

function canonicalBridgeManifest(manifest: Omit<LocalBridgeManifestV1, 'signature'>): string {
  return JSON.stringify(manifest);
}

function bridgeStatus(entry: (typeof BRIDGE_CATALOG)[number]): LocalBridgeStatus {
  const executable = process.env[entry.executableEnv];
  const manifestPath =
    process.env[`SPYDERBYTE_${bridgeKey(entry.bridgeId)}_MANIFEST`] ??
    (executable === undefined ? undefined : join(dirname(executable), 'runtime-manifest.json'));
  const publicKey =
    process.env[`SPYDERBYTE_${bridgeKey(entry.bridgeId)}_PUBLIC_KEY`] ??
    process.env['SPYDERBYTE_BRIDGE_PUBLIC_KEY'];
  if (executable === undefined || executable.trim().length === 0) {
    return {
      bridgeId: entry.bridgeId,
      displayName: entry.displayName,
      operations: BRIDGE_OPERATIONS,
      configured: false,
      signed: false,
      available: false,
      reason: 'bridge-not-configured',
    };
  }
  try {
    accessSync(resolve(executable), constants.X_OK);
  } catch {
    return {
      bridgeId: entry.bridgeId,
      displayName: entry.displayName,
      operations: BRIDGE_OPERATIONS,
      executable,
      configured: false,
      signed: false,
      available: false,
      reason: 'bridge-executable-not-found',
    };
  }
  let manifest: LocalBridgeManifestV1;
  try {
    const value: unknown = JSON.parse(readFileSync(manifestPath ?? '', 'utf8'));
    manifest = value as LocalBridgeManifestV1;
  } catch {
    return {
      bridgeId: entry.bridgeId,
      displayName: entry.displayName,
      operations: BRIDGE_OPERATIONS,
      executable,
      configured: true,
      signed: false,
      available: false,
      reason: 'bridge-manifest-not-found',
    };
  }
  const digest = `sha256:${createHash('sha256')
    .update(readFileSync(resolve(executable)))
    .digest('hex')}`;
  const unsigned: Omit<LocalBridgeManifestV1, 'signature'> = {
    schemaVersion: manifest.schemaVersion,
    product: manifest.product,
    bridgeId: manifest.bridgeId,
    displayName: manifest.displayName,
    version: manifest.version,
    platform: manifest.platform,
    operations: manifest.operations,
    executableDigest: manifest.executableDigest,
    signedAt: manifest.signedAt,
  };
  let signed = false;
  try {
    const operationsValid =
      Array.isArray(manifest.operations) &&
      manifest.operations.length === BRIDGE_OPERATIONS.length &&
      manifest.operations.every((operation) => BRIDGE_OPERATIONS.includes(operation));
    signed =
      manifest.schemaVersion === 1 &&
      manifest.product === 'Spyderbyte' &&
      manifest.platform === 'macos' &&
      manifest.bridgeId === entry.bridgeId &&
      operationsValid &&
      manifest.executableDigest === digest &&
      publicKey !== undefined &&
      verify(
        null,
        Buffer.from(canonicalBridgeManifest(unsigned)),
        publicKey,
        Buffer.from(manifest.signature, 'base64'),
      );
  } catch {
    signed = false;
  }
  const available = signed;
  return {
    bridgeId: entry.bridgeId,
    displayName: entry.displayName,
    operations: manifest.operations,
    executable,
    configured: true,
    signed,
    available,
    ...(available ? {} : { reason: 'bridge-signature-invalid' }),
  };
}

export class SignedLocalBridgeRuntime implements LocalBridgeRuntime {
  constructor(private readonly options: { readonly rootPath: string }) {}

  list(): readonly LocalBridgeStatus[] {
    return BRIDGE_CATALOG.map((entry) => bridgeStatus(entry));
  }

  async execute(input: {
    readonly bridgeId: LocalBridgeManifestV1['bridgeId'];
    readonly operation: string;
    readonly input?: Record<string, JsonValue>;
  }): Promise<JsonValue> {
    const entry = BRIDGE_CATALOG.find((item) => item.bridgeId === input.bridgeId);
    if (entry === undefined) throw runtimeError('VALIDATION_INVALID_INPUT', 'Unknown local bridge');
    if (!BRIDGE_OPERATIONS.includes(input.operation as (typeof BRIDGE_OPERATIONS)[number])) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Local bridge operation is not allowed');
    }
    const status = bridgeStatus(entry);
    if (!status.available || status.executable === undefined) {
      throw runtimeError(
        'COMPUTE_RESOURCE_UNAVAILABLE',
        status.reason ?? 'Local bridge is unavailable',
      );
    }
    const executable = status.executable;
    return new Promise<JsonValue>((resolveOutput, reject) => {
      const child = spawn(resolve(executable), [], {
        cwd: this.options.rootPath,
        env: {
          ...process.env,
          SPYDERBYTE_BRIDGE_OPERATION: input.operation,
          SPYDERBYTE_BRIDGE_ID: input.bridgeId,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        if (Buffer.byteLength(stdout) > 32 * 1024 * 1024) child.kill('SIGTERM');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.once('error', (error) =>
        reject(runtimeError('EXTERNAL_DEPENDENCY_UNAVAILABLE', error.message)),
      );
      child.once('close', (code) => {
        if (code !== 0) {
          reject(
            runtimeError('EXTERNAL_DEPENDENCY_UNAVAILABLE', stderr.trim() || 'Local bridge failed'),
          );
          return;
        }
        const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
        const last = lines.at(-1);
        if (last === undefined) {
          reject(
            runtimeError('EXTERNAL_DEPENDENCY_UNAVAILABLE', 'Local bridge returned no result'),
          );
          return;
        }
        try {
          resolveOutput(jsonValue(JSON.parse(last)));
        } catch {
          reject(
            runtimeError('EXTERNAL_DEPENDENCY_UNAVAILABLE', 'Local bridge returned invalid JSON'),
          );
        }
      });
      child.stdin.end(
        JSON.stringify({ schemaVersion: 1, operation: input.operation, input: input.input ?? {} }) +
          '\n',
      );
    });
  }
}

export function providerActionManifests(): readonly ProviderActionManifestV1[] {
  return structuredClone(PROVIDER_ACTIONS);
}

export function localBridgeCatalog(): readonly Pick<
  LocalBridgeStatus,
  'bridgeId' | 'displayName' | 'operations'
>[] {
  return BRIDGE_CATALOG.map((entry) => ({
    bridgeId: entry.bridgeId,
    displayName: entry.displayName,
    operations: BRIDGE_OPERATIONS,
  }));
}
