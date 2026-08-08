import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import CapabilityGate from '../components/CapabilityGate';
import RuntimeStateNotice from '../components/RuntimeStateNotice';
import {
  Badge,
  Button,
  Card,
  Dialog,
  Field,
  Input,
  ProgressBar,
  Select,
  SectionLabel,
  StatusDot,
} from '../components/primitives';
import { useRuntime } from '../runtime/RuntimeProvider';
import { useRuntimeStore } from '../runtime/store';

interface ModelEntry {
  providerId: string;
  modelId: string;
  displayName?: string;
  source?: string;
  state: string;
  authenticationState?: string;
  billingMode: string;
  local: boolean;
  capabilities?: string[];
  dataClasses?: string[];
  runtimeRequirements?: string[];
  contextWindow?: number;
  usageStatus?: { quotaState: string; usedUnits?: number; limitUnits?: number; resetAt?: string };
}

interface ModelCatalog {
  models: ModelEntry[];
  runtimes: Array<{
    runtimeId: string;
    format: string;
    state: string;
    version: string;
    binaryPath?: string;
    endpoint?: string;
  }>;
  installed: Array<{
    modelId: string;
    repoId: string;
    revision: string;
    format: string;
    path?: string;
    files?: string[];
  }>;
  downloads: Array<{
    jobId: string;
    repoId: string;
    revision: string;
    state: string;
    progress: number;
    error?: string;
  }>;
  providerPriority: string[];
  routingPolicy?: {
    allowExternalModels: boolean;
    allowProviderFallback: boolean;
    allowedDataClasses: string[];
  };
}

interface ProviderConfiguration {
  providerConfigurationId: string;
  providerId: string;
  providerType: string;
  displayName: string;
  endpoint: string;
  defaultModelId?: string;
  state: string;
  authenticationState: string;
  local: boolean;
}

interface ProviderCredential {
  providerConfigurationId: string;
  status: string;
}

interface ProviderResponse {
  providers: ProviderConfiguration[];
  credentials: ProviderCredential[];
}

interface ProviderTestReport {
  providerConfigurationId: string;
  state: string;
  checks: Array<{ name: string; status: string; message: string }>;
  actionableErrors: string[];
}

type SetupProviderType = 'openai' | 'anthropic' | 'openai-compatible' | 'ollama' | 'deterministic';

interface HuggingFaceResult {
  id: string;
  author?: string;
  pipelineTag?: string;
  downloads?: number;
  likes?: number;
  private?: boolean;
  lastModified?: string;
  license?: string;
}

interface HuggingFaceDetails extends HuggingFaceResult {
  revisions: Array<{ name: string; commitHash?: string }>;
  files: Array<{ path: string; size?: number; sha256?: string }>;
  supportedFormats: Array<'gguf' | 'mlx' | 'unknown'>;
  recommendedFiles: string[];
  defaultRevision: string;
}

export default function Models() {
  const runtime = useRuntime();
  const runtimeSnapshot = useRuntimeStore(runtime);
  const [catalog, setCatalog] = useState<ModelCatalog>();
  const [providers, setProviders] = useState<ProviderConfiguration[]>([]);
  const [credentials, setCredentials] = useState<ProviderCredential[]>([]);
  const [providerType, setProviderType] = useState<SetupProviderType>('openai');
  const [providerId, setProviderId] = useState('');
  const [providerName, setProviderName] = useState('');
  const [providerEndpoint, setProviderEndpoint] = useState('');
  const [providerModelId, setProviderModelId] = useState('');
  const [providerApiKey, setProviderApiKey] = useState('');
  const [providerTest, setProviderTest] = useState<ProviderTestReport>();
  const [providerBusyId, setProviderBusyId] = useState<string>();
  const [query, setQuery] = useState('');
  const [repoId, setRepoId] = useState('');
  const [revision, setRevision] = useState('main');
  const [results, setResults] = useState<HuggingFaceResult[]>([]);
  const [details, setDetails] = useState<HuggingFaceDetails>();
  const [searchOpen, setSearchOpen] = useState(false);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [searchBusy, setSearchBusy] = useState(false);
  const [detailsBusy, setDetailsBusy] = useState(false);
  const [downloadDialogOpen, setDownloadDialogOpen] = useState(false);
  const searchAbort = useRef<AbortController | undefined>(undefined);
  const huggingFaceTokenRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    if (!runtime.client.get) return;
    const [catalogResult, providersResult] = await Promise.allSettled([
      runtime.client.get<ModelCatalog>('/v1/models/catalog'),
      runtime.client.get<ProviderResponse>('/v1/providers'),
    ]);
    if (catalogResult.status === 'fulfilled') setCatalog(catalogResult.value);
    else
      setMessage(
        catalogResult.reason instanceof Error
          ? catalogResult.reason.message
          : String(catalogResult.reason),
      );
    if (providersResult.status === 'fulfilled') {
      setProviders(providersResult.value.providers ?? []);
      setCredentials(providersResult.value.credentials ?? []);
    }
  }, [runtime]);

  useEffect(() => {
    void load();
  }, [load, runtimeSnapshot.cursor]);

  const searchHuggingFace = useCallback(
    async (value: string): Promise<void> => {
      const normalized = value.trim();
      searchAbort.current?.abort();
      if (!runtime.client.post || normalized.length < 2) {
        setResults([]);
        setSearchBusy(false);
        return;
      }
      const controller = new AbortController();
      searchAbort.current = controller;
      setSearchBusy(true);
      setMessage(undefined);
      try {
        setResults(
          await runtime.client.post<HuggingFaceResult[]>(
            '/v1/models/huggingface/search',
            { query: normalized, limit: 20 },
            { signal: controller.signal },
          ),
        );
        setSuggestionIndex(0);
        setSearchOpen(true);
      } catch (error) {
        if (controller.signal.aborted) return;
        setMessage(error instanceof Error ? error.message : String(error));
      } finally {
        if (searchAbort.current === controller) setSearchBusy(false);
      }
    },
    [runtime],
  );

  useEffect(() => {
    const timer = setTimeout(() => void searchHuggingFace(query), query.trim() ? 280 : 0);
    return () => clearTimeout(timer);
  }, [query, searchHuggingFace]);

  async function loadDetails(value: string, selectedRevision = revision): Promise<void> {
    if (!runtime.client.get || !value.trim()) return;
    setDetailsBusy(true);
    setMessage(undefined);
    try {
      const params = new URLSearchParams({
        repoId: value.trim(),
        revision: selectedRevision.trim() || 'main',
      });
      const result = await runtime.client.get<HuggingFaceDetails>(
        `/v1/models/huggingface/details?${params.toString()}`,
      );
      setDetails(result);
      setRevision(result.defaultRevision);
      setSearchOpen(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setDetailsBusy(false);
    }
  }

  function selectSuggestion(result: HuggingFaceResult): void {
    setRepoId(result.id);
    setDetails(undefined);
    void loadDetails(result.id);
  }

  function handleSuggestionKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape') {
      setSearchOpen(false);
      return;
    }
    if (!searchOpen || results.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSuggestionIndex((current) => Math.min(current + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSuggestionIndex((current) => Math.max(current - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const result = results[suggestionIndex] ?? results[0];
      if (result) selectSuggestion(result);
    }
  }

  async function download(value = repoId): Promise<void> {
    if (!runtime.client.post || !value.trim()) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const pinnedRevision = revision.trim() || 'main';
      await runtime.client.post('/v1/models/downloads', {
        repoId: value.trim(),
        revision: pinnedRevision,
      });
      setMessage(`Downloading ${value.trim()}@${pinnedRevision}…`);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveHuggingFaceToken(): Promise<void> {
    if (!runtime.client.post) return;
    setBusy(true);
    try {
      const token = huggingFaceTokenRef.current?.value ?? '';
      await runtime.client.post('/v1/models/huggingface/token', { token });
      if (huggingFaceTokenRef.current) huggingFaceTokenRef.current.value = '';
      setMessage('Hugging Face access token stored in the platform vault.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function addProvider(): Promise<void> {
    if (!runtime.client.post) return;
    if (!providerName.trim()) {
      setMessage('A provider display name is required.');
      return;
    }
    setProviderBusyId('new');
    setProviderTest(undefined);
    setMessage(undefined);
    try {
      await runtime.client.post<ProviderConfiguration>('/v1/providers', {
        providerType,
        ...(providerId.trim() ? { providerId: providerId.trim() } : {}),
        displayName: providerName.trim(),
        ...(providerEndpoint.trim() ? { endpoint: providerEndpoint.trim() } : {}),
        ...(providerModelId.trim() ? { defaultModelId: providerModelId.trim() } : {}),
        ...(providerApiKey ? { apiKey: providerApiKey } : {}),
      });
      setProviderApiKey('');
      setProviderName('');
      setProviderId('');
      setProviderEndpoint('');
      setProviderModelId('');
      setMessage('Provider added. The credential was stored by the local secret vault.');
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setProviderBusyId(undefined);
    }
  }

  async function testProvider(provider: ProviderConfiguration): Promise<void> {
    if (!runtime.client.post) return;
    setProviderBusyId(provider.providerConfigurationId);
    setMessage(undefined);
    try {
      const report = await runtime.client.post<ProviderTestReport>(
        `/v1/providers/${encodeURIComponent(provider.providerConfigurationId)}/test`,
        provider.defaultModelId === undefined ? {} : { modelId: provider.defaultModelId },
      );
      setProviderTest(report);
      setMessage(
        report.state === 'callable'
          ? `${provider.displayName} passed provider validation.`
          : `${provider.displayName} needs attention before it can run models.`,
      );
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setProviderBusyId(undefined);
    }
  }

  async function movePriority(providerId: string, direction: -1 | 1): Promise<void> {
    if (!runtime.client.post || !catalog) return;
    const current = [...catalog.providerPriority];
    const index = current.indexOf(providerId);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= current.length) return;
    [current[index], current[nextIndex]] = [current[nextIndex] as string, current[index] as string];
    await runtime.client.post('/v1/model-routing', { providerPriority: current });
    setCatalog({ ...catalog, providerPriority: current });
  }

  async function cancelDownload(jobId: string): Promise<void> {
    if (!runtime.client.post) return;
    try {
      await runtime.client.post(`/v1/models/downloads/${encodeURIComponent(jobId)}/cancel`, {});
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function removeModel(modelId: string): Promise<void> {
    if (!runtime.client.post) return;
    try {
      await runtime.client.post('/v1/models/installed/remove', { modelId });
      await load();
      setMessage('Local model removed.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <CapabilityGate page="models">
      <div className="page-scroll">
        <div className="page stack">
          <div className="page-heading">
            <div>
              <SectionLabel>Model providers</SectionLabel>
              <h1>Models</h1>
              <p className="page-subtitle">
                Choose subscription models or install local Hugging Face models for platform
                workflows.
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
          <Card>
            <div className="card-heading">
              <div>
                <h2>Connect a model provider</h2>
                <p>
                  Add a local or remote provider for the first-run workflow. API keys are sent only
                  to the local runtime and are never returned to this screen.
                </p>
              </div>
            </div>
            <div className="provider-setup-grid">
              <Field label="Provider type">
                <Select
                  aria-label="Provider type"
                  value={providerType}
                  onChange={(event) => setProviderType(event.target.value as SetupProviderType)}
                >
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="openai-compatible">OpenAI-compatible</option>
                  <option value="ollama">Ollama</option>
                  <option value="deterministic">Deterministic local fixture</option>
                </Select>
              </Field>
              <Field label="Display name" required>
                <Input
                  aria-label="Provider display name"
                  value={providerName}
                  onChange={(event) => setProviderName(event.target.value)}
                  placeholder="My model provider"
                />
              </Field>
              <Field label="Provider ID" hint="Optional; defaults from the provider type.">
                <Input
                  aria-label="Provider ID"
                  value={providerId}
                  onChange={(event) => setProviderId(event.target.value)}
                  placeholder="openai-primary"
                />
              </Field>
              <Field label="Endpoint" hint="Leave blank to use the provider default.">
                <Input
                  aria-label="Provider endpoint"
                  value={providerEndpoint}
                  onChange={(event) => setProviderEndpoint(event.target.value)}
                  placeholder="https://api.example.com/v1"
                  type="url"
                />
              </Field>
              <Field label="Default model" hint="Optional until model discovery completes.">
                <Input
                  aria-label="Default model ID"
                  value={providerModelId}
                  onChange={(event) => setProviderModelId(event.target.value)}
                  placeholder="model-name"
                />
              </Field>
              <Field
                label="API key"
                hint="Stored as a provider credential; the value is cleared after submission."
              >
                <Input
                  aria-label="Provider API key"
                  type="password"
                  autoComplete="new-password"
                  value={providerApiKey}
                  onChange={(event) => setProviderApiKey(event.target.value)}
                  placeholder={
                    providerType === 'deterministic' || providerType === 'ollama'
                      ? 'Not required'
                      : 'Enter once; never displayed'
                  }
                />
              </Field>
            </div>
            <div className="home-objective-row provider-setup-actions">
              <Button
                variant="primary"
                loading={providerBusyId === 'new'}
                onClick={() => void addProvider()}
              >
                Add provider securely
              </Button>
              <span className="home-card-subtitle">
                The runtime stores only a credential reference in provider metadata.
              </span>
            </div>
          </Card>
          {providers.length > 0 && (
            <Card>
              <div className="card-heading">
                <div>
                  <h2>Configured providers</h2>
                  <p>Review connection state and run a governed preflight before using a model.</p>
                </div>
              </div>
              <div className="stack">
                {providers.map((provider) => {
                  const credential = credentials.find(
                    (candidate) =>
                      candidate.providerConfigurationId === provider.providerConfigurationId,
                  );
                  return (
                    <div className="provider-card" key={provider.providerConfigurationId}>
                      <div className="provider-card-heading">
                        <span className="home-list-title">
                          <StatusDot
                            color={
                              provider.state === 'callable' || provider.state === 'reachable'
                                ? 'green'
                                : provider.state === 'degraded'
                                  ? 'amber'
                                  : 'gray'
                            }
                          />
                          {provider.displayName}
                        </span>
                        <Badge color={provider.state === 'callable' ? 'green' : 'gray'}>
                          {provider.state}
                        </Badge>
                      </div>
                      <div className="home-list-subtitle">
                        {provider.providerId} · {provider.providerType} ·{' '}
                        {credential?.status === 'active' || provider.local
                          ? provider.local
                            ? 'local'
                            : 'credential active'
                          : 'credential required'}
                      </div>
                      <div className="home-objective-row provider-setup-actions">
                        <Button
                          variant="secondary"
                          loading={providerBusyId === provider.providerConfigurationId}
                          onClick={() => void testProvider(provider)}
                        >
                          Test {provider.displayName}
                        </Button>
                        <span className="home-card-subtitle">
                          {provider.defaultModelId ??
                            'Model discovery will select a default model.'}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
              {providerTest && (
                <div className="provider-test-report" role="status">
                  <strong>Provider preflight: {providerTest.state}</strong>
                  <div className="provider-test-checks">
                    {providerTest.checks.map((check) => (
                      <span key={check.name} data-status={check.status}>
                        {check.name}: {check.status}
                      </span>
                    ))}
                  </div>
                  {providerTest.actionableErrors.length > 0 && (
                    <p>{providerTest.actionableErrors.join(' ')}</p>
                  )}
                </div>
              )}
            </Card>
          )}
          <Card>
            <div className="card-heading">
              <div>
                <h2>Available providers</h2>
                <p>Automatic routing uses readiness and your provider priority.</p>
              </div>
            </div>
            <div className="stack">
              {(catalog?.models ?? []).map((model) => (
                <div className="provider-card" key={`${model.providerId}:${model.modelId}`}>
                  <div className="provider-card-heading">
                    <span className="home-list-title">
                      <StatusDot
                        color={
                          model.state === 'ready'
                            ? 'green'
                            : model.state === 'degraded'
                              ? 'amber'
                              : 'gray'
                        }
                      />
                      {model.displayName ?? model.modelId}
                    </span>
                    <Badge
                      color={
                        model.state === 'ready'
                          ? 'green'
                          : model.state === 'degraded'
                            ? 'amber'
                            : 'gray'
                      }
                    >
                      {model.state}
                    </Badge>
                  </div>
                  <div className="home-list-subtitle">
                    {model.providerId} · {model.modelId} · {model.billingMode} ·{' '}
                    {model.authenticationState ?? 'not_applicable'}
                    {model.local ? ' · on-device' : ''}
                  </div>
                  <div className="provider-card-meta">
                    <span>{model.capabilities?.join(' · ') || 'No capability metadata'}</span>
                    {model.contextWindow && (
                      <span>{model.contextWindow.toLocaleString()} token context</span>
                    )}
                    {model.runtimeRequirements?.length ? (
                      <span>Requires {model.runtimeRequirements.join(', ')}</span>
                    ) : null}
                  </div>
                  {model.usageStatus && (
                    <div className="provider-usage">
                      <span>Quota: {model.usageStatus.quotaState}</span>
                      {model.usageStatus.usedUnits !== undefined &&
                        model.usageStatus.limitUnits !== undefined && (
                          <ProgressBar
                            value={Math.min(
                              100,
                              (model.usageStatus.usedUnits /
                                Math.max(1, model.usageStatus.limitUnits)) *
                                100,
                            )}
                            tone="info"
                            h={4}
                          />
                        )}
                      {model.usageStatus.resetAt && (
                        <span>Resets {new Date(model.usageStatus.resetAt).toLocaleString()}</span>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {!catalog && <div className="home-state">Loading provider catalog…</div>}
            </div>
          </Card>
          <Card>
            <div className="card-heading">
              <div>
                <h2>Automatic routing priority</h2>
                <p>Privacy and workflow policy still constrain this order.</p>
              </div>
            </div>
            {catalog?.routingPolicy && (
              <div className="provider-policy-summary">
                <Badge color={catalog.routingPolicy.allowExternalModels ? 'green' : 'gray'}>
                  External providers{' '}
                  {catalog.routingPolicy.allowExternalModels ? 'allowed' : 'blocked'}
                </Badge>
                <Badge color={catalog.routingPolicy.allowProviderFallback ? 'blue' : 'gray'}>
                  Fallback {catalog.routingPolicy.allowProviderFallback ? 'enabled' : 'disabled'}
                </Badge>
                <span>Data: {catalog.routingPolicy.allowedDataClasses.join(', ')}</span>
              </div>
            )}
            {(catalog?.providerPriority ?? []).map((providerId, index, priority) => (
              <div className="home-list-button" key={providerId}>
                <span className="home-list-copy">
                  <span className="home-list-title">
                    {index + 1}. {providerId}
                  </span>
                </span>
                <span className="home-objective-row">
                  <Button
                    variant="tertiary"
                    disabled={index === 0}
                    onClick={() => void movePriority(providerId, -1)}
                  >
                    Up
                  </Button>
                  <Button
                    variant="tertiary"
                    disabled={index === priority.length - 1}
                    onClick={() => void movePriority(providerId, 1)}
                  >
                    Down
                  </Button>
                </span>
              </div>
            ))}
          </Card>
          <Card>
            <div className="card-heading">
              <div>
                <h2>Install from Hugging Face</h2>
                <p>
                  Public repositories are available immediately; private access uses the platform
                  credential vault.
                </p>
              </div>
            </div>
            <div className="hf-search-wrap">
              <div className="home-objective-row">
                <Input
                  value={query}
                  onFocus={() => results.length > 0 && setSearchOpen(true)}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={handleSuggestionKeyDown}
                  placeholder="Search Hugging Face models…"
                  role="combobox"
                  aria-expanded={searchOpen}
                  aria-controls="huggingface-suggestions"
                  aria-autocomplete="list"
                  aria-activedescendant={
                    results[suggestionIndex]
                      ? `huggingface-suggestion-${suggestionIndex}`
                      : undefined
                  }
                />
                <Button
                  variant="secondary"
                  loading={searchBusy}
                  onClick={() => void searchHuggingFace(query)}
                >
                  Search
                </Button>
              </div>
              {searchOpen && results.length > 0 && (
                <div
                  id="huggingface-suggestions"
                  className="hf-suggestions"
                  role="listbox"
                  aria-label="Hugging Face model suggestions"
                >
                  {results.map((result, index) => (
                    <button
                      className="hf-suggestion"
                      key={result.id}
                      id={`huggingface-suggestion-${index}`}
                      type="button"
                      role="option"
                      aria-selected={index === suggestionIndex}
                      data-active={index === suggestionIndex}
                      onMouseEnter={() => setSuggestionIndex(index)}
                      onClick={() => selectSuggestion(result)}
                    >
                      <span className="home-list-copy">
                        <span className="home-list-title">{result.id}</span>
                        <span className="home-list-subtitle">
                          {result.author ?? 'Community model'} · {result.pipelineTag ?? 'General'}
                          {result.private ? ' · private' : ' · public'}
                        </span>
                      </span>
                      <span className="hf-suggestion-meta">{result.downloads ?? 0} downloads</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="home-objective-row">
              {details && details.revisions.length > 1 ? (
                <Select
                  aria-label="Model revision"
                  value={revision}
                  onChange={(event) => {
                    setRevision(event.target.value);
                    setDetails(undefined);
                    void loadDetails(repoId, event.target.value);
                  }}
                >
                  {details.revisions.flatMap((item) => [
                    <option key={`${item.name}:ref`} value={item.name}>
                      {item.name} · branch or tag
                    </option>,
                    ...(item.commitHash
                      ? [
                          <option key={`${item.name}:commit`} value={item.commitHash}>
                            {item.name} · pinned {item.commitHash.slice(0, 12)}
                          </option>,
                        ]
                      : []),
                  ])}
                </Select>
              ) : (
                <Input
                  value={revision}
                  onChange={(event) => setRevision(event.target.value)}
                  placeholder="Revision or commit SHA"
                  aria-label="Model revision"
                />
              )}
              <span className="home-card-subtitle">
                Select a commit SHA when you need a reproducible install.
              </span>
            </div>
            <div className="home-objective-row">
              <Input
                value={repoId}
                onChange={(event) => setRepoId(event.target.value)}
                placeholder="owner/model-repository"
              />
              <Button
                variant="secondary"
                loading={detailsBusy}
                onClick={() => void loadDetails(repoId)}
              >
                Inspect
              </Button>
              <Button
                variant="primary"
                loading={busy}
                disabled={details === undefined || details.recommendedFiles.length === 0}
                onClick={() => setDownloadDialogOpen(true)}
              >
                {details && details.recommendedFiles.length === 0
                  ? 'No supported file'
                  : 'Download'}
              </Button>
            </div>
            <div className="home-objective-row">
              <input
                className="ds-input"
                type="password"
                ref={huggingFaceTokenRef}
                aria-label="Private repository token"
                autoComplete="current-password"
                placeholder="Optional private-repository token"
              />
              <Button variant="tertiary" loading={busy} onClick={() => void saveHuggingFaceToken()}>
                Save token
              </Button>
            </div>
            {details && (
              <Card className="hf-details-card">
                <div className="card-heading">
                  <div>
                    <h3>{details.id}</h3>
                    <p>
                      {details.author ?? 'Community model'} · {details.pipelineTag ?? 'General'} ·{' '}
                      {details.private ? 'Private' : 'Public'}
                    </p>
                  </div>
                  <Badge color={details.private ? 'amber' : 'green'}>
                    {details.private ? 'Token required' : 'Public repository'}
                  </Badge>
                </div>
                <div className="provider-card-meta">
                  <span>License: {details.license ?? 'Not listed'}</span>
                  <span>Formats: {details.supportedFormats.join(', ')}</span>
                  <span>{details.files.length} repository files</span>
                </div>
                <div className="hf-detail-files">
                  {details.recommendedFiles.length === 0 ? (
                    <span className="home-card-subtitle">
                      No GGUF or MLX file was detected in this revision.
                    </span>
                  ) : (
                    details.recommendedFiles.map((file) => (
                      <span key={file} className="hf-file-chip">
                        {file}
                      </span>
                    ))
                  )}
                </div>
              </Card>
            )}
            {(catalog?.downloads ?? []).map((job) => (
              <div className="home-list-button" key={job.jobId}>
                <span className="home-list-copy">
                  <span className="home-list-title">
                    {job.repoId}@{job.revision}
                  </span>
                  <span className="home-list-subtitle">
                    {job.state}
                    {job.error ? ` · ${job.error}` : ''}
                  </span>
                </span>
                <span className="home-objective-row">
                  <span className="home-list-open">{Math.round(job.progress * 100)}%</span>
                  {(job.state === 'queued' || job.state === 'downloading') && (
                    <Button variant="tertiary" onClick={() => void cancelDownload(job.jobId)}>
                      Cancel
                    </Button>
                  )}
                </span>
              </div>
            ))}
          </Card>
          <Card>
            <div className="card-heading">
              <div>
                <h2>On-device execution backends</h2>
                <p>GGUF uses llama.cpp; MLX uses the Apple Silicon backend when available.</p>
              </div>
            </div>
            {(catalog?.runtimes ?? []).map((runtimeInfo) => (
              <div className="home-list-button" key={runtimeInfo.runtimeId}>
                <span className="home-list-copy">
                  <span className="home-list-title">{runtimeInfo.runtimeId}</span>
                  <span className="home-list-subtitle">
                    {runtimeInfo.format} · {runtimeInfo.version}
                  </span>
                </span>
                <span className="home-list-open">{runtimeInfo.state}</span>
              </div>
            ))}
            {(catalog?.installed ?? []).map((model) => (
              <div className="home-list-button" key={model.modelId}>
                <span className="home-list-copy">
                  <span className="home-list-title">{model.repoId}</span>
                  <span className="home-list-subtitle">
                    {model.revision} · {model.format}
                  </span>
                </span>
                <span className="home-objective-row">
                  <span className="home-list-open">installed</span>
                  <Button variant="tertiary" onClick={() => void removeModel(model.modelId)}>
                    Remove
                  </Button>
                </span>
              </div>
            ))}
          </Card>
        </div>
      </div>
      <Dialog
        open={downloadDialogOpen}
        title="Confirm model download"
        onClose={() => setDownloadDialogOpen(false)}
        actions={
          <>
            <Button variant="tertiary" onClick={() => setDownloadDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={busy}
              onClick={() => {
                setDownloadDialogOpen(false);
                void download();
              }}
            >
              Start download
            </Button>
          </>
        }
      >
        <div className="stack">
          <p>
            Download <strong>{repoId}</strong> at <strong>{revision.trim() || 'main'}</strong> into
            the managed on-device model cache?
          </p>
          <div className="provider-card-meta">
            <span>License: {details?.license ?? 'Not listed'}</span>
            <span>Formats: {details?.supportedFormats.join(', ') ?? 'Unknown'}</span>
            <span>
              Revision type:{' '}
              {/^[0-9a-f]{7,64}$/i.test(revision.trim()) ? 'pinned commit' : 'branch or tag'}
            </span>
          </div>
          <p className="home-card-subtitle">
            The platform will verify files, disk space, and execution-backend compatibility before
            atomic installation. No download starts until you confirm.
          </p>
        </div>
      </Dialog>
    </CapabilityGate>
  );
}
