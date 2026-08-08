import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { runtimeError } from '@agentic-platform/runtime-contracts';

const execFileAsync = promisify(execFile);

export type OAuthConnectionStatus = 'connected' | 'expired' | 'revoked' | 'error';

export interface ConnectorDefinition {
  readonly connectorId: string;
  readonly displayName: string;
  readonly authKind: 'oauth2' | 'cline-cli';
  readonly authorizationEndpoint?: string;
  readonly tokenEndpoint?: string;
  readonly clientIdEnv?: string;
  readonly clientSecretEnv?: string;
  /** Public desktop clients may exchange an authorization code with PKCE without a secret. */
  readonly publicClient?: boolean;
  readonly scopes: readonly string[];
  readonly cliCommand?: readonly string[];
  readonly revocationEndpoint?: string;
}

export type PublicConnectorDefinition = Omit<
  ConnectorDefinition,
  'clientIdEnv' | 'clientSecretEnv' | 'cliCommand' | 'revocationEndpoint'
> & {
  readonly configured: boolean;
};

export interface OAuthConnection {
  readonly connectionId: string;
  readonly connectorId: string;
  readonly displayName: string;
  readonly status: OAuthConnectionStatus;
  readonly scopes: readonly string[];
  readonly accountLabel?: string;
  readonly expiresAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OAuthTransaction {
  readonly transactionId: string;
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  readonly connectorId: string;
  readonly sessionId: string;
  readonly returnTo: string;
  readonly redirectUri: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/** Provider-neutral OIDC boundary for hosted connectors that need identity claims. */
export interface IdentityProvider {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly scopes: readonly string[];
}

export interface OAuthStartResult {
  readonly mode: 'browser' | 'cli';
  readonly transactionId: string;
  readonly connectorId: string;
  readonly authorizationUrl?: string;
  readonly cliCommand?: readonly string[];
}

export interface CliAuthRunner {
  run(command: readonly string[]): Promise<{ accountLabel?: string }>;
}

export class ExecFileCliAuthRunner implements CliAuthRunner {
  constructor(
    private readonly timeoutMs = 10 * 60 * 1000,
    private readonly executableOverride?: string,
  ) {}

  async run(command: readonly string[]): Promise<{ accountLabel?: string }> {
    const executable = this.executableOverride ?? command[0];
    if (executable === undefined) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'CLI authentication command is empty');
    }
    await execFileAsync(
      executable,
      this.executableOverride === undefined ? [...command.slice(1)] : [...command],
      {
        timeout: this.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    return {};
  }
}

export interface OAuthCallbackResult {
  readonly connection: OAuthConnection;
  readonly returnTo: string;
}

export interface CredentialVault {
  put(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | undefined>;
  delete(key: string): Promise<void>;
}

/**
 * Host-provided encrypted secret boundary. Implementations keep encryption,
 * access control, and audit logging in the hosted secret manager; the runtime
 * only supplies a logical name while storing or resolving a value.
 */
export interface HostedEncryptedSecretClient {
  put(input: { readonly secretName: string; readonly value: string }): Promise<void>;
  get(input: { readonly secretName: string }): Promise<string | undefined>;
  delete(input: { readonly secretName: string }): Promise<void>;
}

/**
 * CredentialVault adapter for hosted deployments. Secret values never appear
 * in provider configuration records or API responses; the injected client is
 * responsible for encrypted-at-rest storage and returns only status/handles
 * at its public boundary.
 */
export class HostedEncryptedSecretVault implements CredentialVault {
  constructor(
    private readonly client: HostedEncryptedSecretClient,
    private readonly namespace = 'provider',
  ) {}

  async put(key: string, value: string): Promise<void> {
    await this.client.put({ secretName: `${this.namespace}:${key}`, value });
  }

  async get(key: string): Promise<string | undefined> {
    return this.client.get({ secretName: `${this.namespace}:${key}` });
  }

  async delete(key: string): Promise<void> {
    await this.client.delete({ secretName: `${this.namespace}:${key}` });
  }
}

/** Connection metadata is safe to persist; access and refresh tokens never enter this store. */
export interface OAuthConnectionStore {
  load(): readonly OAuthConnection[];
  save(connections: readonly OAuthConnection[]): void;
}

export class FileOAuthConnectionStore implements OAuthConnectionStore {
  constructor(private readonly path: string) {}

  load(): readonly OAuthConnection[] {
    try {
      const value: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      if (!Array.isArray(value)) return [];
      return value.filter((item): item is OAuthConnection => {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) return false;
        const record = item as Record<string, unknown>;
        return (
          typeof record['connectionId'] === 'string' &&
          typeof record['connectorId'] === 'string' &&
          typeof record['displayName'] === 'string' &&
          typeof record['status'] === 'string' &&
          Array.isArray(record['scopes']) &&
          record['scopes'].every((scope) => typeof scope === 'string') &&
          typeof record['createdAt'] === 'string' &&
          typeof record['updatedAt'] === 'string'
        );
      });
    } catch {
      return [];
    }
  }

  save(connections: readonly OAuthConnection[]): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp-${process.pid}`;
    writeFileSync(temporary, JSON.stringify(connections, null, 2), { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}

export class MemoryCredentialVault implements CredentialVault {
  private readonly values = new Map<string, string>();

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

export interface MacOsKeychainVaultOptions {
  /** Override the platform in deterministic adapter tests; production defaults to process.platform. */
  readonly platform?: NodeJS.Platform;
  /** Override the command runner in tests without shelling out to a real Keychain. */
  readonly runCommand?: (
    executable: string,
    args: readonly string[],
  ) => Promise<{ readonly stdout: string }>;
}

export class MacOsKeychainVault implements CredentialVault {
  private readonly platform: NodeJS.Platform;
  private readonly runCommand: NonNullable<MacOsKeychainVaultOptions['runCommand']>;

  constructor(
    private readonly service = 'com.agentic.platform.local.connections',
    private readonly accountPrefix = 'connection:',
    options: MacOsKeychainVaultOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.runCommand =
      options.runCommand ??
      (async (executable, args) => {
        const result = await execFileAsync(executable, [...args]);
        return { stdout: result.stdout };
      });
  }

  async put(key: string, value: string): Promise<void> {
    if (this.platform !== 'darwin') {
      throw runtimeError(
        'COMPUTE_RESOURCE_UNAVAILABLE',
        'macOS Keychain is only available on macOS',
      );
    }
    await this.runCommand('/usr/bin/security', [
      'add-generic-password',
      '-U',
      '-s',
      this.service,
      '-a',
      `${this.accountPrefix}${key}`,
      '-w',
      value,
    ]);
  }

  async get(key: string): Promise<string | undefined> {
    if (this.platform !== 'darwin') return undefined;
    try {
      const result = await this.runCommand('/usr/bin/security', [
        'find-generic-password',
        '-s',
        this.service,
        '-a',
        `${this.accountPrefix}${key}`,
        '-w',
      ]);
      return result.stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async delete(key: string): Promise<void> {
    if (this.platform !== 'darwin') return;
    try {
      await this.runCommand('/usr/bin/security', [
        'delete-generic-password',
        '-s',
        this.service,
        '-a',
        `${this.accountPrefix}${key}`,
      ]);
    } catch {
      // Deleting an already absent connection is idempotent.
    }
  }
}

export interface OAuthServiceOptions {
  readonly connectors?: readonly ConnectorDefinition[];
  readonly vault?: CredentialVault;
  readonly fetcher?: typeof fetch;
  readonly clock?: () => string;
  readonly transactionTtlMs?: number;
  readonly metadataStore?: OAuthConnectionStore;
  readonly cliAuthRunner?: CliAuthRunner;
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

function randomToken(bytes = 32): string {
  return base64Url(randomBytes(bytes));
}

function pkceChallenge(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest());
}

function validatedReturnTo(value: string): string {
  const candidate = value.trim();
  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\')) {
    throw runtimeError(
      'VALIDATION_INVALID_INPUT',
      'OAuth returnTo must be an internal platform path',
    );
  }
  return candidate;
}

function validatedRedirectUri(value: string): string {
  let uri: URL;
  try {
    uri = new URL(value);
  } catch {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'OAuth redirectUri is invalid');
  }
  const loopback =
    uri.protocol === 'http:' &&
    (uri.hostname === '127.0.0.1' || uri.hostname === 'localhost' || uri.hostname === '[::1]');
  const deepLink =
    (uri.protocol === 'spyderbyte:' || uri.protocol === 'agentic:') && uri.hostname === 'oauth';
  const hosted = uri.protocol === 'https:' && uri.pathname.endsWith('/v1/oauth/callback');
  if (!loopback && !deepLink && !hosted) {
    throw runtimeError(
      'VALIDATION_INVALID_INPUT',
      'OAuth redirectUri must be loopback, spyderbyte://, agentic://, or a hosted callback',
    );
  }
  return uri.toString();
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function validateNonce(
  payload: Record<string, unknown>,
  expected: string,
  connector: ConnectorDefinition,
): void {
  if (!connector.scopes.includes('openid')) return;
  const token = stringValue(payload['id_token']);
  if (token === undefined) {
    throw runtimeError('POLICY_DENIED', 'OAuth identity response did not include an ID token');
  }
  const parts = token.split('.');
  if (parts.length !== 3) throw runtimeError('POLICY_DENIED', 'OAuth ID token is invalid');
  let claims: Record<string, unknown>;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'));
    claims = record(decoded);
  } catch {
    throw runtimeError('POLICY_DENIED', 'OAuth ID token claims are invalid');
  }
  if (claims['nonce'] !== expected) {
    throw runtimeError('POLICY_DENIED', 'OAuth nonce validation failed');
  }
}

export function defaultConnectorDefinitions(): ConnectorDefinition[] {
  return [
    {
      connectorId: 'github',
      displayName: 'GitHub',
      authKind: 'oauth2',
      authorizationEndpoint: 'https://github.com/login/oauth/authorize',
      tokenEndpoint: 'https://github.com/login/oauth/access_token',
      clientIdEnv: 'AGENTIC_GITHUB_CLIENT_ID',
      clientSecretEnv: 'AGENTIC_GITHUB_CLIENT_SECRET',
      scopes: ['read:user', 'repo'],
    },
    {
      connectorId: 'google',
      displayName: 'Google',
      authKind: 'oauth2',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      clientIdEnv: 'AGENTIC_GOOGLE_CLIENT_ID',
      clientSecretEnv: 'AGENTIC_GOOGLE_CLIENT_SECRET',
      publicClient: true,
      scopes: ['openid', 'email', 'profile'],
      revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
    },
    {
      connectorId: 'slack',
      displayName: 'Slack',
      authKind: 'oauth2',
      authorizationEndpoint: 'https://slack.com/oauth/v2/authorize',
      tokenEndpoint: 'https://slack.com/api/oauth.v2.access',
      clientIdEnv: 'AGENTIC_SLACK_CLIENT_ID',
      clientSecretEnv: 'AGENTIC_SLACK_CLIENT_SECRET',
      scopes: ['chat:write'],
    },
    {
      connectorId: 'google-drive',
      displayName: 'Google Drive',
      authKind: 'oauth2',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      clientIdEnv: 'AGENTIC_GOOGLE_CLIENT_ID',
      clientSecretEnv: 'AGENTIC_GOOGLE_CLIENT_SECRET',
      publicClient: true,
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
    },
    {
      connectorId: 'youtube',
      displayName: 'YouTube',
      authKind: 'oauth2',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      clientIdEnv: 'AGENTIC_GOOGLE_CLIENT_ID',
      clientSecretEnv: 'AGENTIC_GOOGLE_CLIENT_SECRET',
      publicClient: true,
      scopes: ['https://www.googleapis.com/auth/youtube.readonly'],
      revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
    },
    {
      connectorId: 'frame-io',
      displayName: 'Frame.io',
      authKind: 'oauth2',
      authorizationEndpoint: 'https://ims-na1.adobelogin.com/ims/authorize/v2',
      tokenEndpoint: 'https://ims-na1.adobelogin.com/ims/token/v3',
      clientIdEnv: 'AGENTIC_FRAMEIO_CLIENT_ID',
      clientSecretEnv: 'AGENTIC_FRAMEIO_CLIENT_SECRET',
      scopes: ['project:read'],
    },
    {
      connectorId: 'openai-codex',
      displayName: 'ChatGPT Subscription / Codex',
      authKind: 'cline-cli',
      scopes: ['model:use'],
      cliCommand: ['cline', 'auth', '--provider', 'openai-codex'],
    },
    {
      connectorId: 'claude-code',
      displayName: 'Claude Code subscription',
      authKind: 'cline-cli',
      scopes: ['model:use'],
      cliCommand: ['claude'],
    },
  ];
}

export class OAuthService {
  private readonly connectors: Map<string, ConnectorDefinition>;
  private readonly transactions = new Map<string, OAuthTransaction>();
  private readonly connections = new Map<string, OAuthConnection>();
  private readonly vault: CredentialVault;
  private readonly fetcher: typeof fetch;
  private readonly clock: () => string;
  private readonly transactionTtlMs: number;
  private readonly metadataStore: OAuthConnectionStore | undefined;
  private readonly cliAuthRunner: CliAuthRunner | undefined;

  constructor(options: OAuthServiceOptions = {}) {
    this.connectors = new Map(
      (options.connectors ?? defaultConnectorDefinitions()).map((connector) => [
        connector.connectorId,
        connector,
      ]),
    );
    this.vault = options.vault ?? new MemoryCredentialVault();
    this.fetcher = options.fetcher ?? fetch;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.transactionTtlMs = options.transactionTtlMs ?? 10 * 60 * 1000;
    this.metadataStore = options.metadataStore;
    this.cliAuthRunner = options.cliAuthRunner;
    for (const connection of options.metadataStore?.load() ?? []) {
      this.connections.set(connection.connectionId, connection);
    }
  }

  listConnectors(): PublicConnectorDefinition[] {
    return structuredClone(
      [...this.connectors.values()].map((connector) => {
        const { connectorId, displayName, authKind, authorizationEndpoint, tokenEndpoint, scopes } =
          connector;
        return {
          connectorId,
          displayName,
          authKind,
          ...(authorizationEndpoint === undefined ? {} : { authorizationEndpoint }),
          ...(tokenEndpoint === undefined ? {} : { tokenEndpoint }),
          scopes,
          configured: this.isConfigured(connector),
        };
      }),
    );
  }

  private isConfigured(connector: ConnectorDefinition): boolean {
    if (connector.authKind === 'cline-cli') {
      return this.cliAuthRunner !== undefined && connector.cliCommand !== undefined;
    }
    const clientId =
      connector.clientIdEnv === undefined ? undefined : process.env[connector.clientIdEnv];
    const clientSecret =
      connector.clientSecretEnv === undefined ? undefined : process.env[connector.clientSecretEnv];
    return Boolean(
      clientId &&
        connector.authorizationEndpoint &&
        connector.tokenEndpoint &&
        (clientSecret !== undefined || connector.publicClient === true),
    );
  }

  listConnections(): OAuthConnection[] {
    return structuredClone([...this.connections.values()]);
  }

  async start(input: {
    connectorId: string;
    sessionId: string;
    redirectUri: string;
    returnTo: string;
  }): Promise<OAuthStartResult> {
    const connector = this.connectors.get(input.connectorId);
    if (connector === undefined)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Unknown OAuth connector');
    const now = this.clock();
    const nowMs = Date.parse(now);
    for (const [state, candidate] of this.transactions.entries()) {
      if (Date.parse(candidate.expiresAt) <= nowMs) this.transactions.delete(state);
    }
    const transaction: OAuthTransaction = {
      transactionId: randomUUID(),
      state: randomToken(24),
      nonce: randomToken(24),
      verifier: randomToken(48),
      connectorId: connector.connectorId,
      sessionId: input.sessionId,
      returnTo: validatedReturnTo(input.returnTo),
      redirectUri: validatedRedirectUri(input.redirectUri),
      createdAt: now,
      expiresAt: new Date(Date.parse(now) + this.transactionTtlMs).toISOString(),
    };
    this.transactions.set(transaction.state, transaction);
    if (connector.authKind === 'cline-cli') {
      if (this.cliAuthRunner !== undefined && connector.cliCommand !== undefined) {
        void this.cliAuthRunner
          .run(connector.cliCommand)
          .then((result) =>
            this.completeCli({ transactionId: transaction.transactionId, ...result }),
          )
          .catch(() => {
            this.transactions.delete(transaction.state);
          });
      }
      return {
        mode: 'cli',
        transactionId: transaction.transactionId,
        connectorId: connector.connectorId,
        ...(connector.cliCommand === undefined ? {} : { cliCommand: connector.cliCommand }),
      };
    }
    const clientId =
      connector.clientIdEnv === undefined ? undefined : process.env[connector.clientIdEnv];
    if (!clientId || !connector.authorizationEndpoint || !connector.tokenEndpoint) {
      this.transactions.delete(transaction.state);
      throw runtimeError(
        'COMPUTE_RESOURCE_UNAVAILABLE',
        `${connector.displayName} OAuth is not configured for this platform`,
      );
    }
    const authorization = new URL(connector.authorizationEndpoint);
    authorization.searchParams.set('client_id', clientId);
    authorization.searchParams.set('redirect_uri', transaction.redirectUri);
    authorization.searchParams.set('response_type', 'code');
    authorization.searchParams.set('scope', connector.scopes.join(' '));
    authorization.searchParams.set('state', transaction.state);
    authorization.searchParams.set('code_challenge', pkceChallenge(transaction.verifier));
    authorization.searchParams.set('code_challenge_method', 'S256');
    authorization.searchParams.set('nonce', transaction.nonce);
    return {
      mode: 'browser',
      transactionId: transaction.transactionId,
      connectorId: connector.connectorId,
      authorizationUrl: authorization.toString(),
    };
  }

  async complete(input: {
    state: string;
    code?: string;
    error?: string;
    errorDescription?: string;
  }): Promise<OAuthCallbackResult> {
    const transaction = this.transactions.get(input.state);
    if (transaction === undefined)
      throw runtimeError('POLICY_DENIED', 'OAuth state is invalid or expired');
    this.transactions.delete(input.state);
    if (Date.parse(transaction.expiresAt) <= Date.parse(this.clock())) {
      throw runtimeError('POLICY_DENIED', 'OAuth transaction expired');
    }
    if (input.error !== undefined) {
      throw runtimeError('POLICY_DENIED', input.errorDescription ?? input.error);
    }
    if (input.code === undefined || input.code.length === 0) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'OAuth callback code is required');
    }
    const connector = this.connectors.get(transaction.connectorId);
    if (connector?.tokenEndpoint === undefined || connector.clientIdEnv === undefined) {
      throw runtimeError('COMPUTE_RESOURCE_UNAVAILABLE', 'OAuth connector has no token endpoint');
    }
    const clientId = process.env[connector.clientIdEnv];
    if (!clientId)
      throw runtimeError('COMPUTE_RESOURCE_UNAVAILABLE', 'OAuth client is not configured');
    const params = new URLSearchParams({
      client_id: clientId,
      code: input.code,
      redirect_uri: transaction.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: transaction.verifier,
    });
    const clientSecret =
      connector.clientSecretEnv === undefined ? undefined : process.env[connector.clientSecretEnv];
    if (clientSecret !== undefined) params.set('client_secret', clientSecret);
    const response = await this.fetcher(connector.tokenEndpoint, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    const payload = record(await response.json().catch(() => ({})));
    if (!response.ok || payload['error'] !== undefined) {
      throw runtimeError('COMPUTE_RESOURCE_UNAVAILABLE', 'OAuth token exchange failed');
    }
    const accessToken = stringValue(payload['access_token']);
    if (accessToken === undefined)
      throw runtimeError('COMPUTE_RESOURCE_UNAVAILABLE', 'OAuth token response was invalid');
    validateNonce(payload, transaction.nonce, connector);
    const connectionId = randomUUID();
    const now = this.clock();
    const expiresIn = typeof payload['expires_in'] === 'number' ? payload['expires_in'] : undefined;
    const connection: OAuthConnection = {
      connectionId,
      connectorId: connector.connectorId,
      displayName: connector.displayName,
      status: 'connected',
      scopes: connector.scopes,
      createdAt: now,
      updatedAt: now,
      ...(expiresIn === undefined
        ? {}
        : { expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() }),
    };
    await this.vault.put(connectionId, JSON.stringify(payload));
    this.connections.set(connectionId, connection);
    this.metadataStore?.save(this.listConnections());
    return { connection: structuredClone(connection), returnTo: transaction.returnTo };
  }

  async completeCli(input: {
    transactionId: string;
    accountLabel?: string;
  }): Promise<OAuthConnection> {
    const transaction = [...this.transactions.values()].find(
      (candidate) => candidate.transactionId === input.transactionId,
    );
    if (transaction === undefined)
      throw runtimeError('POLICY_DENIED', 'OAuth CLI transaction not found');
    this.transactions.delete(transaction.state);
    if (Date.parse(transaction.expiresAt) <= Date.parse(this.clock())) {
      throw runtimeError('POLICY_DENIED', 'OAuth CLI transaction expired');
    }
    const connector = this.connectors.get(transaction.connectorId);
    if (connector === undefined)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'OAuth connector not found');
    const now = this.clock();
    const connection: OAuthConnection = {
      connectionId: randomUUID(),
      connectorId: connector.connectorId,
      displayName: connector.displayName,
      status: 'connected',
      scopes: connector.scopes,
      createdAt: now,
      updatedAt: now,
      ...(input.accountLabel === undefined ? {} : { accountLabel: input.accountLabel }),
    };
    await this.vault.put(connection.connectionId, JSON.stringify({ authenticated: true }));
    this.connections.set(connection.connectionId, connection);
    this.metadataStore?.save(this.listConnections());
    return structuredClone(connection);
  }

  async createManagedConnection(input: {
    connectorId: string;
    displayName: string;
    scopes: readonly string[];
    config: Record<string, string>;
    accountLabel?: string;
  }): Promise<OAuthConnection> {
    const connection: OAuthConnection = {
      connectionId: randomUUID(),
      connectorId: input.connectorId,
      displayName: input.displayName,
      status: 'connected',
      scopes: input.scopes,
      createdAt: this.clock(),
      updatedAt: this.clock(),
      ...(input.accountLabel === undefined ? {} : { accountLabel: input.accountLabel }),
    };
    await this.vault.put(connection.connectionId, JSON.stringify(input.config));
    this.connections.set(connection.connectionId, connection);
    this.metadataStore?.save(this.listConnections());
    return structuredClone(connection);
  }

  async credential(connectionId: string): Promise<string | undefined> {
    return this.vault.get(connectionId);
  }

  async storeSecret(name: string, value: string): Promise<void> {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Credential name is invalid');
    }
    if (value.trim().length === 0) {
      await this.vault.delete(`secret:${name}`);
      return;
    }
    await this.vault.put(`secret:${name}`, value);
  }

  async secret(name: string): Promise<string | undefined> {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) return undefined;
    return this.vault.get(`secret:${name}`);
  }

  async refresh(connectionId: string): Promise<OAuthConnection> {
    const connection = this.connections.get(connectionId);
    if (connection === undefined)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'OAuth connection not found');
    const connector = this.connectors.get(connection.connectorId);
    const stored = await this.vault.get(connectionId);
    const payload = stored === undefined ? {} : record(JSON.parse(stored));
    const refreshToken = stringValue(payload['refresh_token']);
    const clientId =
      connector?.clientIdEnv === undefined ? undefined : process.env[connector.clientIdEnv];
    if (
      connector?.tokenEndpoint === undefined ||
      clientId === undefined ||
      refreshToken === undefined
    ) {
      throw runtimeError('COMPUTE_RESOURCE_UNAVAILABLE', 'OAuth connection cannot be refreshed');
    }
    const params = new URLSearchParams({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    const clientSecret =
      connector.clientSecretEnv === undefined ? undefined : process.env[connector.clientSecretEnv];
    if (clientSecret !== undefined) params.set('client_secret', clientSecret);
    const response = await this.fetcher(connector.tokenEndpoint, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    const renewed = record(await response.json().catch(() => ({})));
    if (!response.ok || stringValue(renewed['access_token']) === undefined) {
      throw runtimeError('COMPUTE_RESOURCE_UNAVAILABLE', 'OAuth token refresh failed');
    }
    const merged = {
      ...payload,
      ...renewed,
      refresh_token: stringValue(renewed['refresh_token']) ?? refreshToken,
    };
    await this.vault.put(connectionId, JSON.stringify(merged));
    const now = this.clock();
    const expiresIn = typeof renewed['expires_in'] === 'number' ? renewed['expires_in'] : undefined;
    const refreshed: OAuthConnection = {
      ...connection,
      status: 'connected',
      updatedAt: now,
      ...(expiresIn === undefined
        ? {}
        : { expiresAt: new Date(Date.parse(now) + expiresIn * 1000).toISOString() }),
    };
    this.connections.set(connectionId, refreshed);
    this.metadataStore?.save(this.listConnections());
    return structuredClone(refreshed);
  }

  async revoke(connectionId: string): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (connection === undefined) return;
    const connector = this.connectors.get(connection.connectorId);
    const revocationEndpoint = connector?.revocationEndpoint;
    if (revocationEndpoint !== undefined) {
      const stored = await this.vault.get(connectionId);
      const token =
        stored === undefined ? undefined : stringValue(record(JSON.parse(stored))['access_token']);
      if (token !== undefined) {
        await this.fetcher(revocationEndpoint, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ token }),
        }).catch(() => undefined);
      }
    }
    await this.vault.delete(connectionId);
    this.connections.set(connectionId, {
      ...connection,
      status: 'revoked',
      updatedAt: this.clock(),
    });
    this.metadataStore?.save(this.listConnections());
  }
}
