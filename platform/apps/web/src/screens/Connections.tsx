import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import CapabilityGate from '../components/CapabilityGate';
import RuntimeStateNotice from '../components/RuntimeStateNotice';
import {
  Badge,
  Button,
  Card,
  Drawer,
  Field,
  Input,
  Notice,
  SearchInput,
  SectionLabel,
  Select,
  StatusDot,
} from '../components/primitives';
import { useRuntime } from '../runtime/RuntimeProvider';
import { useRuntimeStore } from '../runtime/store';

interface Connector {
  connectorId: string;
  displayName: string;
  authKind: string;
  scopes?: string[];
  configured?: boolean;
}

interface Connection {
  connectionId: string;
  connectorId: string;
  displayName: string;
  status: string;
  accountLabel?: string;
  scopes: string[];
  expiresAt?: string;
}

interface ConnectionResponse {
  connectors: Connector[];
  connections: Connection[];
}

type CatalogCategory =
  | 'data-source'
  | 'destination'
  | 'application'
  | 'media'
  | 'local-bridge'
  | 'model-subscription';

interface CatalogField {
  key: string;
  label: string;
  type: 'text' | 'url' | 'secret' | 'number';
  required: boolean;
  description?: string;
  placeholder?: string;
}

interface CatalogEntry {
  connectorId: string;
  displayName: string;
  description: string;
  category: CatalogCategory;
  setupKind: 'oauth' | 'cli' | 'form' | 'local-bridge';
  authKind: string;
  scopes: string[];
  configurationFields: CatalogField[];
  supportedOperations: string[];
  manifestVersion?: string;
  packageDigest?: string;
  signature?: string;
  runtimeAdapter?: string;
  resources?: Array<{
    resourceId: string;
    label: string;
    kind: string;
    selectable: boolean;
    fields?: string[];
  }>;
  supportedPlatforms?: string[];
  configured: boolean;
  setupRequired?: string;
}

interface CatalogResponse {
  items: CatalogEntry[];
  nextCursor?: string;
}

interface ConnectionTestResult {
  status: 'passed' | 'failed';
  message: string;
  checkedAt: string;
}

interface ConnectorDiscovery {
  connectorId: string;
  connectionId?: string;
  status: 'ready' | 'authorization-required' | 'not-connected';
  resources: Array<{
    resourceId: string;
    label: string;
    kind: string;
    selectable: boolean;
    fields?: string[];
  }>;
  discoveredAt: string;
}

const CATEGORY_OPTIONS: Array<{ value: '' | CatalogCategory; label: string }> = [
  { value: '', label: 'All connection types' },
  { value: 'data-source', label: 'Data sources' },
  { value: 'destination', label: 'Destinations' },
  { value: 'application', label: 'Apps and repositories' },
  { value: 'media', label: 'Media and creator tools' },
  { value: 'local-bridge', label: 'Local bridges' },
  { value: 'model-subscription', label: 'Model subscriptions' },
];

function displayCategory(category: CatalogCategory): string {
  return CATEGORY_OPTIONS.find((item) => item.value === category)?.label ?? category;
}

function errorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  if (value.includes('COMPUTE_RESOURCE_UNAVAILABLE') || value.includes('not configured')) {
    return 'Platform setup is required for this connector. Ask an administrator to configure its provider credentials, then retry.';
  }
  return value;
}

export default function Connections() {
  const runtime = useRuntime();
  const runtimeSnapshot = useRuntimeStore(runtime);
  const setupForm = useRef<HTMLFormElement>(null);
  const catalogAbort = useRef<AbortController | undefined>(undefined);
  const [data, setData] = useState<ConnectionResponse>();
  const [catalog, setCatalog] = useState<CatalogResponse>();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<'' | CatalogCategory>('');
  const [selected, setSelected] = useState<CatalogEntry>();
  const [message, setMessage] = useState<string>();
  const [catalogError, setCatalogError] = useState<string>();
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [setupBusy, setSetupBusy] = useState(false);
  const [connectionBusy, setConnectionBusy] = useState<string>();
  const [discovery, setDiscovery] = useState<ConnectorDiscovery>();
  const [discoveryBusy, setDiscoveryBusy] = useState(false);

  const loadConnections = useCallback(async (): Promise<void> => {
    if (!runtime.client.get) return;
    try {
      setData(await runtime.client.get<ConnectionResponse>('/v1/connections'));
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }, [runtime]);

  const loadCatalog = useCallback(
    async (
      search: string,
      selectedCategory: string,
      cursor?: string,
      append = false,
    ): Promise<void> => {
      if (!runtime.client.get) return;
      catalogAbort.current?.abort();
      const controller = new AbortController();
      catalogAbort.current = controller;
      setCatalogBusy(true);
      setCatalogError(undefined);
      const params = new URLSearchParams({ limit: '24' });
      if (search.trim()) params.set('query', search.trim());
      if (selectedCategory) params.set('category', selectedCategory);
      if (cursor) params.set('cursor', cursor);
      try {
        const result = await runtime.client.get<CatalogResponse>(
          `/v1/connectors/catalog?${params}`,
          { signal: controller.signal },
        );
        setCatalog((current) =>
          append && current ? { ...result, items: [...current.items, ...result.items] } : result,
        );
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setCatalogError(errorMessage(error));
        }
      } finally {
        if (!controller.signal.aborted) setCatalogBusy(false);
      }
    },
    [runtime],
  );

  useEffect(() => {
    void loadConnections();
  }, [loadConnections, runtimeSnapshot.cursor]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadCatalog(query, category), query ? 240 : 0);
    return () => window.clearTimeout(timer);
  }, [category, loadCatalog, query]);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('status') === 'connected') {
      setMessage('Connection completed and is available to platform workflows.');
    }
    const get = runtime.client.get?.bind(runtime.client);
    if (!('__TAURI_INTERNALS__' in window) || !get) return;
    let unlisten: (() => void) | undefined;
    void listen<string | string[]>('deep-link://new-url', (event) => {
      const urls = Array.isArray(event.payload) ? event.payload : [event.payload];
      for (const rawUrl of urls) {
        try {
          const url = new URL(rawUrl);
          if (!['spyderbyte:', 'agentic:'].includes(url.protocol) || url.hostname !== 'oauth')
            continue;
          void get<{ connected: boolean; connectionId: string }>(`/v1/oauth/callback${url.search}`)
            .then(() => {
              setMessage('Connection completed.');
              void loadConnections();
              void loadCatalog(query, category);
            })
            .catch((error: unknown) => setMessage(errorMessage(error)));
        } catch {
          setMessage('The connection callback link was invalid.');
        }
      }
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => {
      unlisten?.();
    };
  }, [category, loadCatalog, loadConnections, query, runtime]);

  async function startOAuth(connectorId: string): Promise<void> {
    if (!runtime.client.post) return;
    setMessage(undefined);
    try {
      const base = runtime.client.getBaseUrl?.() || window.location.origin;
      const desktop = '__TAURI_INTERNALS__' in window;
      const result = await runtime.client.post<{
        mode: string;
        authorizationUrl?: string;
        cliCommand?: string[];
      }>(`/v1/connectors/${encodeURIComponent(connectorId)}/auth/start`, {
        connectorId,
        redirectUri: desktop
          ? 'spyderbyte://oauth/callback'
          : new URL('/v1/oauth/callback', base).toString(),
        returnTo: '/connections?status=connected',
      });
      if (result.authorizationUrl) {
        if (desktop) await invoke('open_external_url', { url: result.authorizationUrl });
        else window.open(result.authorizationUrl, '_blank', 'noopener,noreferrer');
        setMessage(`Finish ${connectorId} sign-in in the browser, then return here.`);
      } else {
        setMessage(
          `Finish ${result.cliCommand?.join(' ') ?? connectorId} authentication, then refresh this page.`,
        );
      }
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  async function discoverConnector(entry: CatalogEntry): Promise<void> {
    if (!runtime.client.get) return;
    setDiscoveryBusy(true);
    setMessage(undefined);
    try {
      setDiscovery(
        await runtime.client.get<ConnectorDiscovery>(
          `/v1/connectors/${encodeURIComponent(entry.connectorId)}/discover`,
        ),
      );
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setDiscoveryBusy(false);
    }
  }

  async function setupManaged(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!runtime.client.post || !selected) return;
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    const config: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      if (typeof value === 'string') config[key] = value;
    }
    setSetupBusy(true);
    setMessage(undefined);
    try {
      await runtime.client.post('/v1/connections/setup', {
        connectorId: selected.connectorId,
        config,
      });
      setSelected(undefined);
      setMessage(`${selected.displayName} is connected and ready for platform workflows.`);
      await Promise.all([loadConnections(), loadCatalog(query, category)]);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setSetupBusy(false);
    }
  }

  async function testConnection(connectionId: string): Promise<void> {
    if (!runtime.client.post) return;
    setConnectionBusy(connectionId);
    setMessage(undefined);
    try {
      const result = await runtime.client.post<ConnectionTestResult>(
        `/v1/connections/${encodeURIComponent(connectionId)}/test`,
        {},
      );
      setMessage(
        `${result.status === 'passed' ? 'Connection test passed' : 'Connection test failed'}: ${result.message}`,
      );
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setConnectionBusy(undefined);
    }
  }

  async function revoke(connectionId: string): Promise<void> {
    if (!runtime.client.post) return;
    setConnectionBusy(connectionId);
    try {
      await runtime.client.post(`/v1/connections/${encodeURIComponent(connectionId)}/revoke`, {});
      await Promise.all([loadConnections(), loadCatalog(query, category)]);
      setMessage('Connection revoked.');
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setConnectionBusy(undefined);
    }
  }

  async function refresh(connectionId: string): Promise<void> {
    if (!runtime.client.post) return;
    setConnectionBusy(connectionId);
    try {
      await runtime.client.post(`/v1/connections/${encodeURIComponent(connectionId)}/refresh`, {});
      await Promise.all([loadConnections(), loadCatalog(query, category)]);
      setMessage('Connection refreshed.');
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setConnectionBusy(undefined);
    }
  }

  const connections = data?.connections ?? [];
  const connectorMap = new Map(
    (data?.connectors ?? []).map((connector) => [connector.connectorId, connector]),
  );

  return (
    <CapabilityGate page="connections">
      <div className="page-scroll">
        <div className="page stack">
          <div className="page-heading">
            <div>
              <SectionLabel>Platform integrations</SectionLabel>
              <h1>Connections</h1>
              <p className="page-subtitle">
                Search the connection catalog, add governed data sources, and connect apps or model
                subscriptions.
              </p>
            </div>
          </div>
          {message && (
            <div className="home-error" role="status">
              {message}
            </div>
          )}
          <RuntimeStateNotice
            state={runtimeSnapshot.connection}
            onRetry={() => void runtime.retry()}
          />

          <Card className="connection-catalog-card">
            <div className="card-heading">
              <div>
                <h2>Add a connection</h2>
                <p>
                  Browse verified connectors, authorize an account, then choose the resources and
                  operations Spyderbyte can use.
                </p>
              </div>
              {catalogBusy && <StatusDot color="blue" />}
            </div>
            <div className="connection-search-row">
              <SearchInput
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search connections, data sources, apps…"
                aria-label="Search connection catalog"
              />
              <Select
                value={category}
                onChange={(event) => setCategory(event.target.value as '' | CatalogCategory)}
                aria-label="Filter connection catalog"
              >
                {CATEGORY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </div>
            {catalogError && (
              <Notice tone="danger">
                {catalogError}{' '}
                <Button variant="tertiary" onClick={() => void loadCatalog(query, category)}>
                  Retry
                </Button>
              </Notice>
            )}
            <div className="connection-catalog-grid">
              {(catalog?.items ?? []).map((entry) => (
                <button
                  className="connection-catalog-item"
                  key={entry.connectorId}
                  onClick={() => setSelected(entry)}
                  type="button"
                >
                  <span className="connection-catalog-item-heading">
                    <span className="home-list-title">{entry.displayName}</span>
                    <Badge
                      color={entry.configured ? 'green' : entry.setupRequired ? 'amber' : 'gray'}
                    >
                      {entry.configured
                        ? 'Ready'
                        : entry.setupRequired
                          ? 'Setup required'
                          : 'Available'}
                    </Badge>
                  </span>
                  <span className="connection-catalog-category">
                    {displayCategory(entry.category)}
                  </span>
                  <span className="connection-catalog-description">{entry.description}</span>
                  <span className="home-list-subtitle">
                    {entry.setupKind === 'oauth'
                      ? 'One-click browser authorization'
                      : entry.setupKind === 'cli'
                        ? 'Supported sign-in'
                        : entry.setupKind === 'local-bridge'
                          ? 'Signed local bridge'
                          : 'Secure configuration'}{' '}
                    · {entry.scopes.join(', ')}
                  </span>
                </button>
              ))}
            </div>
            {!catalogBusy && catalog?.items.length === 0 && (
              <div className="home-state">No connections match this search.</div>
            )}
            {catalog?.nextCursor && (
              <div className="connection-catalog-more">
                <Button
                  variant="tertiary"
                  loading={catalogBusy}
                  onClick={() => void loadCatalog(query, category, catalog.nextCursor, true)}
                >
                  Load more connections
                </Button>
              </div>
            )}
          </Card>

          <Card>
            <div className="card-heading">
              <div>
                <h2>Connected accounts</h2>
                <p>
                  Connections are broker handles; access tokens and credentials never enter agent
                  context.
                </p>
              </div>
            </div>
            {connections.map((connection) => {
              const connector = connectorMap.get(connection.connectorId);
              return (
                <div className="home-list-button" key={connection.connectionId}>
                  <span className="home-list-copy">
                    <span className="home-list-title">
                      <StatusDot color={connection.status === 'connected' ? 'green' : 'amber'} />
                      {connection.displayName}
                    </span>
                    <span className="home-list-subtitle">
                      {connection.accountLabel ?? connection.connectorId} ·{' '}
                      {connection.scopes.join(', ') || 'configured connection'}
                      {connection.expiresAt
                        ? ` · expires ${new Date(connection.expiresAt).toLocaleString()}`
                        : ''}
                    </span>
                  </span>
                  <span className="home-objective-row">
                    {connector?.authKind === 'oauth2' && (
                      <Button
                        variant="tertiary"
                        disabled={connectionBusy === connection.connectionId}
                        onClick={() => void refresh(connection.connectionId)}
                      >
                        Refresh
                      </Button>
                    )}
                    <Button
                      variant="tertiary"
                      disabled={connectionBusy === connection.connectionId}
                      onClick={() => void testConnection(connection.connectionId)}
                    >
                      Test
                    </Button>
                    <Button
                      variant="tertiary"
                      disabled={connectionBusy === connection.connectionId}
                      onClick={() => void revoke(connection.connectionId)}
                    >
                      Revoke
                    </Button>
                  </span>
                </div>
              );
            })}
            {data && connections.length === 0 && (
              <div className="home-state">
                No connected accounts yet. Search the catalog above to add one.
              </div>
            )}
            {!data && <div className="home-state">Loading connected accounts…</div>}
          </Card>
        </div>
      </div>
      <Drawer
        open={selected !== undefined}
        title={selected?.displayName ?? 'Connection details'}
        onClose={() => setSelected(undefined)}
      >
        {selected && (
          <div className="connection-drawer stack">
            <div className="connection-catalog-category">{displayCategory(selected.category)}</div>
            <p>{selected.description}</p>
            <div className="connection-drawer-meta">
              <span>Authentication: {selected.authKind}</span>
              <span>Scopes: {selected.scopes.join(', ') || 'configured connection'}</span>
              {selected.manifestVersion && <span>Registry: v{selected.manifestVersion}</span>}
            </div>
            {selected.setupRequired && !selected.configured && (
              <Notice tone="warning">{selected.setupRequired}</Notice>
            )}
            {selected.setupKind === 'form' || selected.setupKind === 'local-bridge' ? (
              <form
                ref={setupForm}
                className="stack"
                onSubmit={(event) => void setupManaged(event)}
              >
                {selected.configurationFields.map((field) => (
                  <Field
                    key={field.key}
                    label={field.label}
                    hint={field.description}
                    required={field.required}
                  >
                    <Input
                      name={field.key}
                      type={field.type === 'secret' ? 'password' : field.type}
                      placeholder={field.placeholder}
                      autoComplete="off"
                      required={field.required}
                    />
                  </Field>
                ))}
                <Button loading={setupBusy} type="submit">
                  {selected.setupKind === 'local-bridge'
                    ? 'Register signed bridge'
                    : 'Secure connection'}
                </Button>
              </form>
            ) : (
              <div className="stack">
                <Notice tone={selected.configured ? 'info' : 'warning'}>
                  {selected.configured
                    ? 'This connector is ready to start its supported sign-in flow.'
                    : 'Platform setup is required before sign-in can begin. The next step is to configure this connector on the platform.'}
                </Notice>
                <Button
                  disabled={!selected.configured}
                  onClick={() => void startOAuth(selected.connectorId)}
                >
                  {selected.setupKind === 'cli' ? 'Start supported sign-in' : 'Connect in browser'}
                </Button>
              </div>
            )}
            <div className="stack">
              <div className="home-objective-row">
                <SectionLabel>Resource discovery</SectionLabel>
                <Button
                  variant="tertiary"
                  loading={discoveryBusy}
                  onClick={() => void discoverConnector(selected)}
                >
                  Discover resources
                </Button>
              </div>
              {discovery && discovery.connectorId === selected.connectorId && (
                <Notice tone={discovery.status === 'ready' ? 'info' : 'warning'}>
                  {discovery.status === 'ready'
                    ? `${discovery.resources.length} resource group${discovery.resources.length === 1 ? '' : 's'} available.`
                    : 'Authorize or register this connector to discover resources.'}
                  {discovery.resources.length > 0 && (
                    <ul className="connection-operation-list">
                      {discovery.resources.map((resource) => (
                        <li key={resource.resourceId}>
                          {resource.label} · {resource.kind}
                        </li>
                      ))}
                    </ul>
                  )}
                </Notice>
              )}
            </div>
            <div>
              <SectionLabel>Supported operations</SectionLabel>
              <ul className="connection-operation-list">
                {selected.supportedOperations.map((operation) => (
                  <li key={operation}>{operation}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </Drawer>
    </CapabilityGate>
  );
}
