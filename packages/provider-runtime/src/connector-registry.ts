import { createHash } from 'node:crypto';
import { runtimeError, type JsonValue } from '@agentic-platform/runtime-contracts';
import type { OAuthCallbackResult, OAuthService, OAuthStartResult } from './oauth.js';

/** The product-level categories stay stable even when a connector implementation changes. */
export type ConnectorCategory =
  | 'data-source'
  | 'destination'
  | 'application'
  | 'media'
  | 'model'
  | 'local-bridge';

export type ConnectorAuthMode =
  | 'oauth2-pkce'
  | 'oauth2-byo'
  | 'credentials'
  | 'api-key'
  | 'cli'
  | 'local-signed-bridge';

export interface ConnectorResourceV1 {
  readonly resourceId: string;
  readonly label: string;
  readonly kind: 'stream' | 'project' | 'repository' | 'workspace' | 'media-library' | 'model';
  readonly selectable: boolean;
  readonly fields?: readonly string[];
}

export interface ConnectorManifestV1 {
  readonly schemaVersion: 1;
  readonly connectorId: string;
  readonly version: string;
  readonly displayName: string;
  readonly description: string;
  readonly category: ConnectorCategory;
  readonly auth: {
    readonly mode: ConnectorAuthMode;
    readonly scopes: readonly string[];
    readonly supportsPkce: boolean;
    readonly supportsByoClient: boolean;
  };
  readonly resources: readonly ConnectorResourceV1[];
  readonly operations: readonly string[];
  readonly configurationSchema: JsonValue;
  readonly runtimeAdapter: 'meltano' | 'oauth-api' | 'local-bridge' | 'model-provider';
  readonly supportedPlatforms: readonly string[];
  readonly supportedProductVersions: readonly string[];
  readonly packageDigest: string;
  readonly signature: string;
}

export interface ConnectorRegistryEntry extends ConnectorManifestV1 {
  readonly source: 'bundled-curated' | 'installed-curated';
  readonly publishedAt: string;
}

export interface ConnectorPluginValidationV1 {
  readonly connectorId: string;
  readonly version: string;
  readonly packageDigest: string;
  readonly signature: string;
  readonly verified: true;
}

export interface ConnectionBinding {
  readonly bindingId: string;
  readonly connectorId: string;
  readonly connectionId: string;
  readonly resources: readonly string[];
  readonly fields?: readonly string[];
  /** Explicit schema/resource selection sent to the connector adapter. */
  readonly schemaSelection?: readonly string[];
  readonly syncMode?: 'full' | 'incremental';
  /** Secret-free destination reference; credentials remain in the vault resolver. */
  readonly destination?: string;
  readonly authRef?: string;
  readonly pluginVersion?: string;
  readonly pluginDigest?: string;
  readonly pluginSignature?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ConnectorRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ConnectorRun {
  readonly runId: string;
  readonly connectorId: string;
  readonly connectionId?: string;
  readonly operation: string;
  readonly status: ConnectorRunStatus;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly checkpointId?: string;
  readonly artifactIds: readonly string[];
  readonly metrics: Readonly<Record<string, number>>;
  readonly idempotencyKey?: string;
  readonly syncMode?: 'full' | 'incremental';
  readonly destination?: string;
  readonly schemaFingerprint?: string;
  readonly schemaChangeEventIds?: readonly string[];
  readonly lineage?: ConnectorLineageV1;
  readonly error?: string;
}

export interface ConnectorCheckpoint {
  readonly checkpointId: string;
  readonly connectorId: string;
  readonly stream: string;
  readonly cursor: string;
  readonly schemaFingerprint?: string;
  readonly bindingId?: string;
  readonly destination?: string;
  readonly updatedAt: string;
}

export interface ConnectorLineageV1 {
  readonly runId: string;
  readonly connectorId: string;
  readonly connectionId?: string;
  readonly source: string;
  readonly destination?: string;
  readonly checkpointId?: string;
  readonly artifactIds: readonly string[];
  readonly schemaFingerprint?: string;
  readonly recordedAt: string;
}

export interface ConnectorSchemaChangeEventV1 {
  readonly eventId: string;
  readonly connectorId: string;
  readonly connectionId?: string;
  readonly stream: string;
  readonly previousFingerprint?: string;
  readonly nextFingerprint: string;
  readonly change: 'added' | 'removed' | 'changed' | 'initial';
  readonly occurredAt: string;
}

export interface ConnectorArtifact {
  readonly artifactId: string;
  readonly runId: string;
  readonly connectorId: string;
  readonly mediaType: string;
  readonly contentHash: string;
  readonly rowCount?: number;
  readonly schemaFingerprint?: string;
  readonly createdAt: string;
}

export interface ConnectorDiscoveryResult {
  readonly connectorId: string;
  readonly connectionId?: string;
  readonly status: 'ready' | 'authorization-required' | 'not-connected';
  readonly resources: readonly ConnectorResourceV1[];
  readonly schemaFingerprint?: string;
  readonly schemaChangeEventIds?: readonly string[];
  readonly discoveredAt: string;
}

export interface ConnectorRuntime {
  discover(input: {
    readonly manifest: ConnectorManifestV1;
    readonly binding: ConnectionBinding;
  }): Promise<ConnectorDiscoveryResult>;
  execute(input: {
    readonly manifest: ConnectorManifestV1;
    readonly binding: ConnectionBinding;
    readonly operation: string;
    readonly checkpoint?: ConnectorCheckpoint;
    readonly idempotencyKey?: string;
  }): Promise<ConnectorRun>;
  cancel(runId: string): Promise<void>;
}

export interface ConnectorAuthBroker {
  start(input: {
    readonly connectorId: string;
    readonly sessionId: string;
    readonly redirectUri: string;
    readonly returnTo: string;
  }): Promise<OAuthStartResult>;
  complete(input: {
    readonly state: string;
    readonly code?: string;
    readonly error?: string;
    readonly errorDescription?: string;
  }): Promise<OAuthCallbackResult>;
}

/** The auth broker keeps OAuth protocol details behind the connector boundary. */
export class OAuthConnectorAuthBroker implements ConnectorAuthBroker {
  constructor(private readonly oauth: OAuthService) {}

  start(input: {
    readonly connectorId: string;
    readonly sessionId: string;
    readonly redirectUri: string;
    readonly returnTo: string;
  }): Promise<OAuthStartResult> {
    return this.oauth.start(input);
  }

  complete(input: {
    readonly state: string;
    readonly code?: string;
    readonly error?: string;
    readonly errorDescription?: string;
  }): Promise<OAuthCallbackResult> {
    return this.oauth.complete(input);
  }
}

function canonicalManifest(
  manifest: Omit<ConnectorManifestV1, 'packageDigest' | 'signature'>,
): string {
  return JSON.stringify(manifest);
}

export function connectorDigest(
  manifest: Omit<ConnectorManifestV1, 'packageDigest' | 'signature'>,
): string {
  return `sha256:${createHash('sha256').update(canonicalManifest(manifest)).digest('hex')}`;
}

export function signCuratedConnector(
  manifest: Omit<ConnectorManifestV1, 'packageDigest' | 'signature'>,
): ConnectorManifestV1 {
  const packageDigest = connectorDigest(manifest);
  return {
    ...manifest,
    packageDigest,
    // Bundled manifests are immutable and verified against their canonical digest at boot.
    signature: `curated:${packageDigest}`,
  };
}

export function verifyConnectorManifest(manifest: ConnectorManifestV1): void {
  const {
    packageDigest,
    signature,
    source: _source,
    publishedAt: _publishedAt,
    ...unsigned
  } = manifest as ConnectorManifestV1 &
    Partial<Pick<ConnectorRegistryEntry, 'source' | 'publishedAt'>>;
  void _source;
  void _publishedAt;
  const expected = connectorDigest(unsigned);
  if (packageDigest !== expected || signature !== `curated:${expected}`) {
    throw runtimeError(
      'POLICY_DENIED',
      `Connector manifest ${manifest.connectorId} failed curated registry verification`,
    );
  }
}

/** Validate the signed, version-pinned plugin envelope before it enters the executable registry. */
export function validateConnectorPlugin(
  manifest: ConnectorManifestV1,
): ConnectorPluginValidationV1 {
  verifyConnectorManifest(manifest);
  return {
    connectorId: manifest.connectorId,
    version: manifest.version,
    packageDigest: manifest.packageDigest,
    signature: manifest.signature,
    verified: true,
  };
}

function manifest(
  input: Omit<ConnectorManifestV1, 'schemaVersion' | 'packageDigest' | 'signature'>,
): ConnectorRegistryEntry {
  const signed = signCuratedConnector({ schemaVersion: 1, ...input });
  return {
    ...signed,
    source: 'bundled-curated',
    publishedAt: '2026-01-01T00:00:00.000Z',
  };
}

const CSV_FIELDS = ['id', 'created_at', 'updated_at', 'value'];
const FILE_SCHEMA: JsonValue = {
  type: 'object',
  properties: { path: { type: 'string' }, format: { enum: ['csv', 'json', 'jsonl'] } },
  required: ['path'],
};

/** Curated initial catalog. Community packages are intentionally not executable by default. */
export const CURATED_CONNECTOR_REGISTRY: readonly ConnectorRegistryEntry[] = [
  manifest({
    connectorId: 'meltano-tap-postgres',
    version: '1.0.0',
    displayName: 'PostgreSQL',
    description: 'Extract relational data into a governed staging area with Meltano.',
    category: 'data-source',
    auth: {
      mode: 'credentials',
      scopes: ['read-only by default'],
      supportsPkce: false,
      supportsByoClient: false,
    },
    resources: [
      {
        resourceId: 'schemas',
        label: 'Schemas and tables',
        kind: 'stream',
        selectable: true,
        fields: CSV_FIELDS,
      },
    ],
    operations: [
      'discover schemas',
      'select streams',
      'stage tables',
      'profile data',
      'incremental sync',
    ],
    configurationSchema: { type: 'object', required: ['host', 'database', 'username', 'password'] },
    runtimeAdapter: 'meltano',
    supportedPlatforms: ['macos'],
    supportedProductVersions: ['0.x'],
  }),
  manifest({
    connectorId: 'meltano-tap-s3',
    version: '1.0.0',
    displayName: 'Amazon S3',
    description: 'Stage files from an S3 bucket for cataloging and analysis.',
    category: 'data-source',
    auth: {
      mode: 'credentials',
      scopes: ['bucket read'],
      supportsPkce: false,
      supportsByoClient: false,
    },
    resources: [
      {
        resourceId: 'objects',
        label: 'Bucket objects',
        kind: 'stream',
        selectable: true,
        fields: ['key', 'size', 'last_modified'],
      },
    ],
    operations: [
      'list objects',
      'select objects',
      'stage files',
      'profile data',
      'incremental sync',
    ],
    configurationSchema: {
      type: 'object',
      required: ['bucket', 'region', 'accessKeyId', 'secretAccessKey'],
    },
    runtimeAdapter: 'meltano',
    supportedPlatforms: ['macos'],
    supportedProductVersions: ['0.x'],
  }),
  manifest({
    connectorId: 'meltano-target-postgres',
    version: '1.0.0',
    displayName: 'PostgreSQL warehouse',
    description: 'Publish governed datasets and pipeline outputs to PostgreSQL.',
    category: 'destination',
    auth: {
      mode: 'credentials',
      scopes: ['write datasets'],
      supportsPkce: false,
      supportsByoClient: false,
    },
    resources: [
      { resourceId: 'tables', label: 'Destination tables', kind: 'stream', selectable: true },
    ],
    operations: ['validate schema', 'write tables', 'publish artifacts'],
    configurationSchema: { type: 'object', required: ['host', 'database', 'username', 'password'] },
    runtimeAdapter: 'meltano',
    supportedPlatforms: ['macos'],
    supportedProductVersions: ['0.x'],
  }),
  manifest({
    connectorId: 'github',
    version: '1.0.0',
    displayName: 'GitHub',
    description: 'Connect repositories and worktrees through a scoped OAuth grant.',
    category: 'application',
    auth: {
      mode: 'oauth2-pkce',
      scopes: ['read:user', 'repo'],
      supportsPkce: true,
      supportsByoClient: true,
    },
    resources: [
      {
        resourceId: 'repositories',
        label: 'Repositories',
        kind: 'repository',
        selectable: true,
        fields: ['default_branch', 'visibility'],
      },
    ],
    operations: ['list repositories', 'create pull request', 'merge pull request'],
    configurationSchema: { type: 'object', properties: {} },
    runtimeAdapter: 'oauth-api',
    supportedPlatforms: ['macos'],
    supportedProductVersions: ['0.x'],
  }),
  manifest({
    connectorId: 'google',
    version: '1.0.0',
    displayName: 'Google',
    description: 'Connect approved Google identity and workspace resources.',
    category: 'application',
    auth: {
      mode: 'oauth2-pkce',
      scopes: ['openid', 'email', 'profile'],
      supportsPkce: true,
      supportsByoClient: true,
    },
    resources: [
      {
        resourceId: 'workspace',
        label: 'Workspace resources',
        kind: 'workspace',
        selectable: true,
      },
    ],
    operations: ['identity', 'discover workspace resources'],
    configurationSchema: { type: 'object', properties: {} },
    runtimeAdapter: 'oauth-api',
    supportedPlatforms: ['macos'],
    supportedProductVersions: ['0.x'],
  }),
  manifest({
    connectorId: 'google-drive',
    version: '1.0.0',
    displayName: 'Google Drive',
    description: 'Browse and import creator, research, and project files from Drive.',
    category: 'media',
    auth: {
      mode: 'oauth2-pkce',
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      supportsPkce: true,
      supportsByoClient: true,
    },
    resources: [
      {
        resourceId: 'files',
        label: 'Drive files',
        kind: 'media-library',
        selectable: true,
        fields: ['name', 'mimeType', 'modifiedTime'],
      },
    ],
    operations: ['list files'],
    configurationSchema: { type: 'object', properties: {} },
    runtimeAdapter: 'oauth-api',
    supportedPlatforms: ['macos'],
    supportedProductVersions: ['0.x'],
  }),
  manifest({
    connectorId: 'slack',
    version: '1.0.0',
    displayName: 'Slack',
    description: 'Connect Slack workspaces for brokered, policy-controlled actions.',
    category: 'application',
    auth: {
      mode: 'oauth2-pkce',
      scopes: ['chat:write'],
      supportsPkce: true,
      supportsByoClient: true,
    },
    resources: [
      { resourceId: 'workspace', label: 'Workspace', kind: 'workspace', selectable: true },
    ],
    operations: ['send message'],
    configurationSchema: { type: 'object', properties: {} },
    runtimeAdapter: 'oauth-api',
    supportedPlatforms: ['macos'],
    supportedProductVersions: ['0.x'],
  }),
  manifest({
    connectorId: 'youtube',
    version: '1.0.0',
    displayName: 'YouTube',
    description: 'Browse the connected YouTube channel for approved media workflows.',
    category: 'media',
    auth: {
      mode: 'oauth2-pkce',
      scopes: ['https://www.googleapis.com/auth/youtube.readonly'],
      supportsPkce: true,
      supportsByoClient: true,
    },
    resources: [
      { resourceId: 'channel', label: 'Channel', kind: 'media-library', selectable: true },
    ],
    operations: ['list channels'],
    configurationSchema: { type: 'object', properties: {} },
    runtimeAdapter: 'oauth-api',
    supportedPlatforms: ['macos'],
    supportedProductVersions: ['0.x'],
  }),
  manifest({
    connectorId: 'frame-io',
    version: '1.0.0',
    displayName: 'Frame.io',
    description: 'Browse media projects through the Frame.io API.',
    category: 'media',
    auth: {
      mode: 'oauth2-byo',
      scopes: ['project:read'],
      supportsPkce: true,
      supportsByoClient: true,
    },
    resources: [
      {
        resourceId: 'projects',
        label: 'Media projects',
        kind: 'project',
        selectable: true,
        fields: ['name', 'owner', 'updated_at'],
      },
    ],
    operations: ['list projects'],
    configurationSchema: { type: 'object', properties: {} },
    runtimeAdapter: 'oauth-api',
    supportedPlatforms: ['macos'],
    supportedProductVersions: ['0.x'],
  }),
  manifest({
    connectorId: 'local-media-bridge',
    version: '1.0.0',
    displayName: 'Local media bridge',
    description:
      'Connect a signed desktop editing bridge for local projects, renders, and watched folders.',
    category: 'local-bridge',
    auth: {
      mode: 'local-signed-bridge',
      scopes: ['local media project access'],
      supportsPkce: false,
      supportsByoClient: false,
    },
    resources: [
      { resourceId: 'projects', label: 'Editing projects', kind: 'project', selectable: true },
      { resourceId: 'assets', label: 'Media assets', kind: 'media-library', selectable: true },
    ],
    operations: [
      'list projects',
      'read timeline',
      'import asset',
      'update timeline',
      'start render',
      'observe render',
      'export media',
      'publish result',
    ],
    configurationSchema: FILE_SCHEMA,
    runtimeAdapter: 'local-bridge',
    supportedPlatforms: ['macos'],
    supportedProductVersions: ['0.x'],
  }),
  manifest({
    connectorId: 'openai-codex',
    version: '1.0.0',
    displayName: 'ChatGPT subscription / Codex',
    description: 'Use an existing ChatGPT subscription through supported platform authentication.',
    category: 'model',
    auth: { mode: 'cli', scopes: ['model:use'], supportsPkce: false, supportsByoClient: false },
    resources: [{ resourceId: 'models', label: 'Models', kind: 'model', selectable: true }],
    operations: ['agent assistance', 'streaming responses'],
    configurationSchema: { type: 'object', properties: {} },
    runtimeAdapter: 'model-provider',
    supportedPlatforms: ['macos'],
    supportedProductVersions: ['0.x'],
  }),
  manifest({
    connectorId: 'claude-code',
    version: '1.0.0',
    displayName: 'Claude Code subscription',
    description: 'Use a Claude Code subscription through its supported authentication surface.',
    category: 'model',
    auth: { mode: 'cli', scopes: ['model:use'], supportsPkce: false, supportsByoClient: false },
    resources: [{ resourceId: 'models', label: 'Models', kind: 'model', selectable: true }],
    operations: ['agent assistance', 'streaming responses'],
    configurationSchema: { type: 'object', properties: {} },
    runtimeAdapter: 'model-provider',
    supportedPlatforms: ['macos'],
    supportedProductVersions: ['0.x'],
  }),
];

export class ConnectorRegistry {
  private readonly entries: Map<string, ConnectorRegistryEntry>;

  constructor(entries: readonly ConnectorRegistryEntry[] = CURATED_CONNECTOR_REGISTRY) {
    for (const entry of entries) verifyConnectorManifest(entry);
    this.entries = new Map(entries.map((entry) => [entry.connectorId, structuredClone(entry)]));
  }

  list(
    input: { query?: string; category?: ConnectorCategory; limit?: number } = {},
  ): ConnectorRegistryEntry[] {
    const query = input.query?.trim().toLowerCase() ?? '';
    const result = [...this.entries.values()].filter((entry) => {
      if (input.category !== undefined && entry.category !== input.category) return false;
      if (query.length === 0) return true;
      return [
        entry.connectorId,
        entry.displayName,
        entry.description,
        entry.category,
        ...entry.operations,
      ]
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
    return structuredClone(result.slice(0, Math.max(1, Math.min(input.limit ?? 100, 100))));
  }

  get(connectorId: string): ConnectorRegistryEntry | undefined {
    const entry = this.entries.get(connectorId);
    return entry === undefined ? undefined : structuredClone(entry);
  }

  require(connectorId: string): ConnectorRegistryEntry {
    const entry = this.get(connectorId);
    if (entry === undefined)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Connector is not in the curated registry');
    return entry;
  }

  /** Install only a signed curated plugin and reject a version downgrade for an existing id. */
  registerPlugin(
    plugin: ConnectorManifestV1,
    input: {
      readonly source?: ConnectorRegistryEntry['source'];
      readonly publishedAt?: string;
    } = {},
  ): ConnectorRegistryEntry {
    validateConnectorPlugin(plugin);
    const existing = this.entries.get(plugin.connectorId);
    if (existing !== undefined && compareVersions(plugin.version, existing.version) < 0) {
      throw runtimeError(
        'CONCURRENCY_STALE_VERSION',
        `Connector ${plugin.connectorId} cannot be downgraded from ${existing.version} to ${plugin.version}`,
      );
    }
    const entry: ConnectorRegistryEntry = {
      ...structuredClone(plugin),
      source: input.source ?? 'installed-curated',
      publishedAt: input.publishedAt ?? new Date().toISOString(),
    };
    this.entries.set(entry.connectorId, entry);
    return structuredClone(entry);
  }

  requireVersion(connectorId: string, version: string): ConnectorRegistryEntry {
    const entry = this.require(connectorId);
    if (entry.version !== version) {
      throw runtimeError(
        'POLICY_DENIED',
        `Connector ${connectorId} version ${version} is not the registered ${entry.version}`,
      );
    }
    return entry;
  }

  health(): { status: 'healthy'; count: number; verifiedAt: string } {
    return { status: 'healthy', count: this.entries.size, verifiedAt: new Date().toISOString() };
  }
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] =>
    value
      .replace(/^[^0-9]*/, '')
      .split(/[.+-]/)
      .map((part) => Number(part))
      .map((part) => (Number.isSafeInteger(part) ? part : 0));
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
