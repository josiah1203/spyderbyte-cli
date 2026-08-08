import { runtimeError } from '@agentic-platform/runtime-contracts';
import type { OAuthConnection, OAuthService } from './oauth.js';
import {
  ConnectorRegistry,
  type ConnectorDiscoveryResult,
  type ConnectorResourceV1,
} from './connector-registry.js';

export type ConnectionCatalogCategory =
  | 'data-source'
  | 'destination'
  | 'application'
  | 'media'
  | 'local-bridge'
  | 'model-subscription';

export type ConnectionSetupKind = 'oauth' | 'cli' | 'form' | 'local-bridge';

export interface ConnectionCatalogField {
  readonly key: string;
  readonly label: string;
  readonly type: 'text' | 'url' | 'secret' | 'number';
  readonly required: boolean;
  readonly description?: string;
  readonly placeholder?: string;
}

export interface ConnectionCatalogEntry {
  readonly connectorId: string;
  readonly displayName: string;
  readonly description: string;
  readonly category: ConnectionCatalogCategory;
  readonly setupKind: ConnectionSetupKind;
  readonly authKind: string;
  readonly scopes: readonly string[];
  readonly configurationFields: readonly ConnectionCatalogField[];
  readonly supportedOperations: readonly string[];
  readonly manifestVersion?: string;
  readonly packageDigest?: string;
  readonly signature?: string;
  readonly runtimeAdapter?: string;
  readonly resources?: readonly ConnectorResourceV1[];
  readonly supportedPlatforms?: readonly string[];
  readonly configured: boolean;
  readonly setupRequired?: string;
}

export interface ConnectionCatalogPage {
  readonly items: readonly ConnectionCatalogEntry[];
  readonly nextCursor?: string;
}

export interface ConnectionSetupResult {
  readonly connection: OAuthConnection;
  readonly configured: true;
}

export interface ConnectionTestResult {
  readonly connectionId: string;
  readonly status: 'passed' | 'failed';
  readonly checkedAt: string;
  readonly message: string;
}

interface CatalogDefinition extends Omit<ConnectionCatalogEntry, 'configured' | 'setupRequired'> {
  readonly oauthConnectorId?: string;
}

const CATALOG: readonly CatalogDefinition[] = [
  {
    connectorId: 'meltano-tap-postgres',
    displayName: 'PostgreSQL',
    description: 'Extract relational data into a governed staging area with Meltano.',
    category: 'data-source',
    setupKind: 'form',
    authKind: 'credentials',
    scopes: ['read-only by default'],
    configurationFields: [
      { key: 'host', label: 'Host', type: 'text', required: true, placeholder: 'db.example.com' },
      { key: 'port', label: 'Port', type: 'number', required: false, placeholder: '5432' },
      { key: 'database', label: 'Database', type: 'text', required: true },
      { key: 'username', label: 'Username', type: 'text', required: true },
      { key: 'password', label: 'Password', type: 'secret', required: true },
    ],
    supportedOperations: ['discover schemas', 'stage tables', 'profile data'],
  },
  {
    connectorId: 'meltano-tap-s3',
    displayName: 'Amazon S3',
    description: 'Stage files from an S3 bucket for cataloging and analysis.',
    category: 'data-source',
    setupKind: 'form',
    authKind: 'credentials',
    scopes: ['bucket read'],
    configurationFields: [
      { key: 'bucket', label: 'Bucket', type: 'text', required: true },
      { key: 'region', label: 'Region', type: 'text', required: true, placeholder: 'us-east-1' },
      { key: 'accessKeyId', label: 'Access key ID', type: 'text', required: true },
      { key: 'secretAccessKey', label: 'Secret access key', type: 'secret', required: true },
    ],
    supportedOperations: ['list objects', 'stage files', 'profile data'],
  },
  {
    connectorId: 'meltano-target-postgres',
    displayName: 'PostgreSQL warehouse',
    description: 'Publish governed datasets and pipeline outputs to PostgreSQL.',
    category: 'destination',
    setupKind: 'form',
    authKind: 'credentials',
    scopes: ['write datasets'],
    configurationFields: [
      { key: 'host', label: 'Host', type: 'text', required: true },
      { key: 'port', label: 'Port', type: 'number', required: false, placeholder: '5432' },
      { key: 'database', label: 'Database', type: 'text', required: true },
      { key: 'username', label: 'Username', type: 'text', required: true },
      { key: 'password', label: 'Password', type: 'secret', required: true },
    ],
    supportedOperations: ['write tables', 'publish artifacts', 'validate schema'],
  },
  {
    connectorId: 'github',
    oauthConnectorId: 'github',
    displayName: 'GitHub',
    description: 'Connect repositories and worktrees through a scoped OAuth grant.',
    category: 'application',
    setupKind: 'oauth',
    authKind: 'oauth2',
    scopes: ['read:user', 'repo'],
    configurationFields: [],
    supportedOperations: ['repositories', 'branches', 'pull requests'],
  },
  {
    connectorId: 'google',
    oauthConnectorId: 'google',
    displayName: 'Google',
    description: 'Connect approved Google identity and workspace resources.',
    category: 'application',
    setupKind: 'oauth',
    authKind: 'oauth2',
    scopes: ['openid', 'email', 'profile'],
    configurationFields: [],
    supportedOperations: ['identity', 'workspace resources'],
  },
  {
    connectorId: 'slack',
    oauthConnectorId: 'slack',
    displayName: 'Slack',
    description: 'Connect Slack workspaces for brokered, policy-controlled actions.',
    category: 'application',
    setupKind: 'oauth',
    authKind: 'oauth2',
    scopes: ['chat:write'],
    configurationFields: [],
    supportedOperations: ['send message'],
  },
  {
    connectorId: 'google-drive',
    oauthConnectorId: 'google-drive',
    displayName: 'Google Drive',
    description: 'Browse and import creator, research, and project files from Drive.',
    category: 'media',
    setupKind: 'oauth',
    authKind: 'oauth2',
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    configurationFields: [],
    supportedOperations: ['list files'],
  },
  {
    connectorId: 'youtube',
    oauthConnectorId: 'youtube',
    displayName: 'YouTube',
    description: 'Browse the connected YouTube channel for approved media workflows.',
    category: 'media',
    setupKind: 'oauth',
    authKind: 'oauth2',
    scopes: ['https://www.googleapis.com/auth/youtube.readonly'],
    configurationFields: [],
    supportedOperations: ['list channels'],
  },
  {
    connectorId: 'frame-io',
    oauthConnectorId: 'frame-io',
    displayName: 'Frame.io',
    description: 'Browse media projects through the Frame.io API.',
    category: 'media',
    setupKind: 'oauth',
    authKind: 'oauth2',
    scopes: ['project:read'],
    configurationFields: [],
    supportedOperations: ['list projects'],
  },
  {
    connectorId: 'local-media-bridge',
    displayName: 'Local media bridge',
    description:
      'Connect a signed desktop editing bridge for local projects, renders, and watched folders.',
    category: 'local-bridge',
    setupKind: 'local-bridge',
    authKind: 'local-signed-bridge',
    scopes: ['local media project access'],
    configurationFields: [
      {
        key: 'path',
        label: 'Bridge or watched-folder path',
        type: 'text',
        required: true,
        placeholder: '/Users/you/Media/SpyderbyteBridge',
      },
    ],
    supportedOperations: [
      'list projects',
      'read timeline',
      'import asset',
      'update timeline',
      'start render',
      'observe render',
      'export media',
      'publish result',
    ],
  },
  {
    connectorId: 'openai-codex',
    oauthConnectorId: 'openai-codex',
    displayName: 'ChatGPT subscription / Codex',
    description: 'Use an existing ChatGPT subscription through supported platform authentication.',
    category: 'model-subscription',
    setupKind: 'cli',
    authKind: 'cline-cli',
    scopes: ['model:use'],
    configurationFields: [],
    supportedOperations: ['agent assistance', 'streaming responses'],
  },
  {
    connectorId: 'claude-code',
    oauthConnectorId: 'claude-code',
    displayName: 'Claude Code subscription',
    description: 'Use a Claude Code subscription through its supported authentication surface.',
    category: 'model-subscription',
    setupKind: 'cli',
    authKind: 'cline-cli',
    scopes: ['model:use'],
    configurationFields: [],
    supportedOperations: ['agent assistance', 'streaming responses'],
  },
];

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor.length === 0) return 0;
  const value = Number.parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function encodeCursor(value: number): string {
  return Buffer.from(String(value), 'utf8').toString('base64url');
}

export class ConnectionCatalogService {
  readonly registry: ConnectorRegistry;

  constructor(
    private readonly oauth: OAuthService,
    private readonly clock = () => new Date().toISOString(),
    registry = new ConnectorRegistry(),
  ) {
    this.registry = registry;
  }

  list(
    input: {
      query?: string;
      category?: string;
      cursor?: string;
      limit?: number;
    } = {},
  ): ConnectionCatalogPage {
    const query = input.query?.trim().toLowerCase() ?? '';
    const category = input.category?.trim();
    const oauthConnectors = new Map(
      this.oauth.listConnectors().map((connector) => [connector.connectorId, connector]),
    );
    const connections = this.oauth.listConnections();
    const filtered = CATALOG.filter((definition) => {
      if (category !== undefined && category.length > 0 && definition.category !== category)
        return false;
      if (query.length === 0) return true;
      return [
        definition.connectorId,
        definition.displayName,
        definition.description,
        definition.category,
      ]
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
    const start = decodeCursor(input.cursor);
    const limit = Math.max(1, Math.min(input.limit ?? 24, 100));
    const items = filtered.slice(start, start + limit).map((definition) => {
      const manifest = this.registry.get(definition.connectorId);
      const connector = oauthConnectors.get(definition.oauthConnectorId ?? definition.connectorId);
      const connection = connections.find(
        (candidate) =>
          candidate.connectorId === (definition.oauthConnectorId ?? definition.connectorId) &&
          candidate.status === 'connected',
      );
      const configured =
        definition.setupKind === 'form' ? connection !== undefined : connector?.configured === true;
      return {
        ...definition,
        ...(manifest === undefined
          ? {}
          : {
              manifestVersion: manifest.version,
              packageDigest: manifest.packageDigest,
              signature: manifest.signature,
              runtimeAdapter: manifest.runtimeAdapter,
              resources: manifest.resources,
              supportedPlatforms: manifest.supportedPlatforms,
            }),
        configured,
        ...(configured
          ? {}
          : {
              setupRequired:
                definition.setupKind === 'form'
                  ? 'Complete the connection fields to enable this source.'
                  : 'Platform setup is required before this authentication flow can start.',
            }),
      };
    });
    const next = start + items.length;
    return {
      items,
      ...(next < filtered.length ? { nextCursor: encodeCursor(next) } : {}),
    };
  }

  async setup(input: {
    connectorId: string;
    config: Record<string, string>;
    accountLabel?: string;
  }): Promise<ConnectionSetupResult> {
    const definition = CATALOG.find((candidate) => candidate.connectorId === input.connectorId);
    if (definition === undefined)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Connection is not in the platform catalog');
    if (definition.setupKind !== 'form' && definition.setupKind !== 'local-bridge') {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'This connection uses its supported sign-in flow',
      );
    }
    const keys = new Set(definition.configurationFields.map((field) => field.key));
    for (const key of Object.keys(input.config)) {
      if (!keys.has(key))
        throw runtimeError('VALIDATION_INVALID_INPUT', `Unknown configuration field: ${key}`);
    }
    for (const field of definition.configurationFields) {
      if (field.required && (input.config[field.key] ?? '').trim().length === 0) {
        throw runtimeError('VALIDATION_INVALID_INPUT', `${field.label} is required`);
      }
    }
    const connection = await this.oauth.createManagedConnection({
      connectorId: definition.connectorId,
      displayName: definition.displayName,
      scopes: definition.scopes,
      config: input.config,
      ...(input.accountLabel === undefined ? {} : { accountLabel: input.accountLabel }),
    });
    return { connection, configured: true };
  }

  discover(connectorId: string, connectionId?: string): ConnectorDiscoveryResult {
    const definition = CATALOG.find((candidate) => candidate.connectorId === connectorId);
    const manifest = this.registry.require(connectorId);
    if (definition === undefined) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Connector is not in the platform catalog');
    }
    const candidate =
      connectionId === undefined
        ? this.oauth
            .listConnections()
            .find((item) => item.connectorId === (definition.oauthConnectorId ?? connectorId))
        : this.oauth.listConnections().find((item) => item.connectionId === connectionId);
    return {
      connectorId,
      ...(candidate === undefined ? {} : { connectionId: candidate.connectionId }),
      status:
        candidate?.status === 'connected'
          ? 'ready'
          : definition.setupKind === 'oauth'
            ? 'authorization-required'
            : 'not-connected',
      resources: manifest.resources,
      discoveredAt: this.clock(),
    };
  }

  async test(connectionId: string): Promise<ConnectionTestResult> {
    const connection = this.oauth
      .listConnections()
      .find((candidate) => candidate.connectionId === connectionId);
    if (connection === undefined)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Connection not found');
    if (connection.status !== 'connected') {
      return {
        connectionId,
        status: 'failed',
        checkedAt: this.clock(),
        message: `Connection is ${connection.status}. Reconnect it before testing.`,
      };
    }
    const credential = await this.oauth.credential(connectionId);
    return {
      connectionId,
      status: credential === undefined ? 'failed' : 'passed',
      checkedAt: this.clock(),
      message:
        credential === undefined
          ? 'The secure credential is missing.'
          : 'Secure connection metadata is available.',
    };
  }
}
