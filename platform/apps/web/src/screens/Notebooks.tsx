import { useEffect, useState } from 'react';
import CapabilityGate from '../components/CapabilityGate';
import RuntimeStateNotice from '../components/RuntimeStateNotice';
import {
  Badge,
  Button,
  Card,
  Field,
  Notice,
  SectionLabel,
  Select,
  Textarea,
} from '../components/primitives';
import type { JsonValue } from '../runtime/contracts';
import { useRuntime } from '../runtime/RuntimeProvider';
import { useRuntimeStore } from '../runtime/store';

type CellType = 'markdown' | 'python' | 'sql';
type CellStatus = 'idle' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

interface NotebookOutput {
  outputId: string;
  type: 'text' | 'table' | 'error';
  value: JsonValue;
  artifactId?: string;
  artifactVersion?: number;
  mediaType?: string;
  lineage?: string[];
  createdAt: string;
}

interface NotebookCell {
  cellId: string;
  type: CellType;
  source: string;
  status: CellStatus;
  executionCount?: number;
  outputs: NotebookOutput[];
  updatedAt: string;
}

interface NotebookDocument {
  notebookId: string;
  title: string;
  kernel: string;
  environment: string;
  cells: NotebookCell[];
}

interface RuntimeProfile {
  profileId: string;
  name: string;
  kind: string;
  executable: string;
}

interface RuntimeProfileResponse {
  profiles: RuntimeProfile[];
  revisions: Array<{ profileId: string; revision: number; lockfileHash?: string }>;
}

interface JupyterDiscovery {
  executable: string;
  available: boolean;
  version?: string;
  error?: string;
}

interface JupyterSession {
  sessionId: string;
  state: string;
  profileId?: string;
  port?: number;
  accessUrl?: string;
  tokenExpiresAt: string;
}

interface JupyterLaunchResult {
  session: JupyterSession;
  accessUrl: string;
}

interface ArtifactContentResponse {
  artifactId: string;
  version: number;
  mediaType: string;
  contentHash: string;
  contentBase64: string;
}

interface QuerySource {
  tableName: string;
  columns: string[];
  rows: Array<readonly JsonValue[]>;
}

interface ArtifactContext {
  artifactId: string;
  version: number;
  mediaType: string;
  contentHash: string;
  sourceData?: QuerySource;
}

const NOTEBOOK_ID = 'notebook-main';

function newCellId(): string {
  const random =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `cell-${random}`;
}

function outputText(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function artifactFromLocation(): { artifactId: string; version: number } | undefined {
  if (typeof window === 'undefined') return undefined;
  const params = new URLSearchParams(window.location.search);
  const artifactId = params.get('artifact');
  const version = Number(params.get('version') ?? '1');
  if (
    artifactId === null ||
    artifactId.length === 0 ||
    !Number.isSafeInteger(version) ||
    version < 1
  ) {
    return undefined;
  }
  return { artifactId, version };
}

function decodeBase64(value: string): string {
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      fields.push(field);
      field = '';
    } else {
      field += character;
    }
  }
  fields.push(field);
  return fields;
}

function parseCsvSource(content: string): QuerySource | undefined {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0) return undefined;
  const parsed = lines.map(parseCsvLine);
  const header = parsed.shift();
  if (header === undefined || header.length === 0 || header.every((item) => item.length === 0)) {
    return undefined;
  }
  const columns = header.map((column, index) => column.trim() || `column_${index + 1}`);
  const rows = parsed
    .filter((row) => row.length > 1 || row[0]?.length > 0)
    .map((row) => columns.map((_, index) => row[index] ?? null));
  return { tableName: 'dataset', columns, rows };
}

export default function Notebooks() {
  const runtime = useRuntime();
  const snapshot = useRuntimeStore(runtime);
  const [notebook, setNotebook] = useState<NotebookDocument>();
  const [runtimeProfiles, setRuntimeProfiles] = useState<RuntimeProfileResponse>();
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [jupyterDiscovery, setJupyterDiscovery] = useState<JupyterDiscovery>();
  const [jupyterSession, setJupyterSession] = useState<JupyterSession>();
  const [jupyterUrl, setJupyterUrl] = useState<string>();
  const [artifactContext, setArtifactContext] = useState<ArtifactContext>();
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      const get = runtime.client.get?.bind(runtime.client);
      if (!get || !runtime.client.post) return;
      try {
        let document: NotebookDocument;
        try {
          document = await get<NotebookDocument>(`/v1/notebooks/${NOTEBOOK_ID}`);
        } catch {
          document = await runtime.client.post<NotebookDocument>(`/v1/notebooks/${NOTEBOOK_ID}`, {
            title: 'Individual user notebook',
          });
        }
        if (!cancelled) setNotebook(document);
        const [profileResult, discoveryResult, sessionsResult] = await Promise.allSettled([
          get<RuntimeProfileResponse>('/v1/runtimes/profiles'),
          get<JupyterDiscovery>('/v1/jupyter/discovery'),
          get<JupyterSession[]>('/v1/jupyter/sessions'),
        ]);
        if (!cancelled && profileResult.status === 'fulfilled') {
          setRuntimeProfiles(profileResult.value);
          setSelectedProfileId(
            (current) => current || profileResult.value.profiles[0]?.profileId || '',
          );
        }
        if (!cancelled && discoveryResult.status === 'fulfilled')
          setJupyterDiscovery(discoveryResult.value);
        if (!cancelled && sessionsResult.status === 'fulfilled') {
          const existing = sessionsResult.value.find((session) =>
            ['starting', 'ready', 'idle'].includes(session.state),
          );
          if (existing) setJupyterSession(existing);
        }
        const artifact = artifactFromLocation();
        if (artifact !== undefined) {
          try {
            const content = await get<ArtifactContentResponse>(
              `/v1/artifacts/${encodeURIComponent(artifact.artifactId)}/versions/${artifact.version}/content`,
            );
            const sourceData = content.mediaType.toLowerCase().includes('csv')
              ? parseCsvSource(decodeBase64(content.contentBase64))
              : undefined;
            if (!cancelled) {
              setArtifactContext({
                artifactId: content.artifactId,
                version: content.version,
                mediaType: content.mediaType,
                contentHash: content.contentHash,
                ...(sourceData === undefined ? {} : { sourceData }),
              });
              setMessage(
                sourceData === undefined
                  ? `Opened artifact ${content.artifactId} v${content.version}; only CSV artifacts can currently seed SQL cells.`
                  : `Loaded artifact ${content.artifactId} v${content.version} as notebook SQL context.`,
              );
            }
          } catch (error) {
            if (!cancelled)
              setMessage(`Notebook artifact context unavailable: ${errorMessage(error)}`);
          }
        }
      } catch (error) {
        if (!cancelled) setMessage(errorMessage(error));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [runtime]);

  function updateCell(cellId: string, patch: Partial<NotebookCell>): void {
    setNotebook((current) =>
      current === undefined
        ? current
        : {
            ...current,
            cells: current.cells.map((cell) =>
              cell.cellId === cellId ? { ...cell, ...patch } : cell,
            ),
          },
    );
  }

  async function addCell(type: CellType): Promise<void> {
    if (!runtime.client.post || notebook === undefined) return;
    const cellId = newCellId();
    try {
      const document = await runtime.client.post<NotebookDocument>(
        `/v1/notebooks/${NOTEBOOK_ID}/cells/${encodeURIComponent(cellId)}`,
        {
          type,
          source:
            type === 'python'
              ? '# Write Python here'
              : type === 'sql'
                ? 'SELECT * FROM dataset LIMIT 100'
                : '## Notes',
        },
      );
      setNotebook(document);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  async function runCell(cell: NotebookCell): Promise<void> {
    if (!runtime.client.post || notebook === undefined) return;
    setBusy(true);
    setMessage(undefined);
    updateCell(cell.cellId, { status: 'running' });
    try {
      const result = await runtime.client.post<{ notebook: NotebookDocument }>(
        `/v1/notebooks/${NOTEBOOK_ID}/cells/${encodeURIComponent(cell.cellId)}/run`,
        {
          type: cell.type,
          source: cell.source,
          ...(artifactContext?.sourceData === undefined
            ? {}
            : {
                sourceData: {
                  tableName: artifactContext.sourceData.tableName,
                  columns: [...artifactContext.sourceData.columns],
                  rows: artifactContext.sourceData.rows.map((row) => [...row]),
                },
              }),
        },
      );
      setNotebook(result.notebook);
      const updated = result.notebook.cells.find((item) => item.cellId === cell.cellId);
      setMessage(
        updated?.status === 'completed'
          ? `Cell ${updated.executionCount ?? ''} completed.`
          : updated?.outputs[0]?.value
            ? outputText(updated.outputs[0].value)
            : 'Cell failed.',
      );
    } catch (error) {
      updateCell(cell.cellId, { status: 'failed' });
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function cancelCell(cell: NotebookCell): Promise<void> {
    if (!runtime.client.post || cell.status !== 'running') return;
    setBusy(true);
    try {
      await runtime.client.post(
        `/v1/notebooks/${NOTEBOOK_ID}/cells/${encodeURIComponent(cell.cellId)}/cancel`,
        {},
      );
      updateCell(cell.cellId, { status: 'cancelled' });
      setMessage(`Cell ${cell.cellId} cancellation requested.`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function openJupyter(): Promise<void> {
    if (!runtime.client.post) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await runtime.client.post<JupyterLaunchResult>('/v1/jupyter/sessions', {
        notebookId: NOTEBOOK_ID,
        ...(selectedProfileId ? { profileId: selectedProfileId } : {}),
      });
      setJupyterSession(result.session);
      setJupyterUrl(result.accessUrl);
      setMessage('JupyterLab session started with a short-lived scoped token.');
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function stopJupyter(): Promise<void> {
    if (!runtime.client.post || !jupyterSession) return;
    setBusy(true);
    try {
      await runtime.client.post(
        `/v1/jupyter/sessions/${encodeURIComponent(jupyterSession.sessionId)}/stop`,
        {},
      );
      setJupyterSession({ ...jupyterSession, state: 'stopped' });
      setJupyterUrl(undefined);
      setMessage('JupyterLab session stopped.');
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function restartKernel(): Promise<void> {
    if (!runtime.client.post) return;
    setBusy(true);
    try {
      setNotebook(
        await runtime.client.post<NotebookDocument>(`/v1/notebooks/${NOTEBOOK_ID}/restart`, {}),
      );
      setMessage('Local Python kernel restarted and cell outputs cleared.');
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function publishArtifact(cell: NotebookCell, output: NotebookOutput): Promise<void> {
    if (!runtime.client.post || output.artifactId === undefined) return;
    setBusy(true);
    try {
      const published = await runtime.client.post<{ publishedArtifactId: string }>(
        `/v1/notebooks/${NOTEBOOK_ID}/cells/${encodeURIComponent(cell.cellId)}/publish`,
        { artifactId: output.artifactId },
      );
      setMessage(`Published artifact ${published.publishedArtifactId.slice(0, 16)}.`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function exportNotebook(): Promise<void> {
    if (!runtime.client.get) return;
    try {
      const document = await runtime.client.get<JsonValue>(`/v1/notebooks/${NOTEBOOK_ID}/export`);
      const blob = new Blob([JSON.stringify(document, null, 2)], {
        type: 'application/x-ipynb+json',
      });
      const url = URL.createObjectURL(blob);
      const anchor = window.document.createElement('a');
      anchor.href = url;
      anchor.download = `${notebook?.title ?? 'spyderbyte-notebook'}.ipynb`;
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage('Notebook exported as .ipynb.');
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  return (
    <CapabilityGate page="notebooks">
      <div className="page-scroll">
        <div className="page stack">
          <div className="page-heading">
            <div>
              <SectionLabel>Executable research workspace</SectionLabel>
              <h1>Notebook Workbench</h1>
              <p className="page-subtitle">
                Run Python and SQL cells in the local sandbox, preserve outputs, and export a
                reproducible notebook.
              </p>
            </div>
            <Badge color={notebook ? 'green' : 'gray'}>
              {notebook ? 'Local kernel ready' : 'Loading'}
            </Badge>
          </div>
          {message && <Notice tone="info">{message}</Notice>}
          <RuntimeStateNotice state={snapshot.connection} onRetry={() => void runtime.retry()} />
          {artifactContext && (
            <Card className="home-notice">
              <div className="home-notice-title">Artifact context</div>
              <p>
                {artifactContext.artifactId} · v{artifactContext.version} ·{' '}
                {artifactContext.mediaType} · {artifactContext.contentHash}
              </p>
              <p>
                {artifactContext.sourceData === undefined
                  ? 'This artifact is available for reference, but only CSV artifacts currently seed notebook SQL cells.'
                  : 'SQL cells run against this immutable artifact version as the dataset table.'}
              </p>
              <a className="text-action" href="/notebooks">
                Clear artifact context
              </a>
            </Card>
          )}
          <Card>
            <div className="card-heading">
              <div>
                <h2>{notebook?.title ?? 'Notebook'}</h2>
                <p>
                  {notebook?.kernel ?? 'local-python'} ·{' '}
                  {notebook?.environment ?? 'sandboxed environment'}
                </p>
              </div>
              <div className="resource-editor-actions">
                <Button variant="secondary" loading={busy} onClick={() => void restartKernel()}>
                  Restart kernel
                </Button>
                <Button variant="tertiary" onClick={() => void exportNotebook()}>
                  Export .ipynb
                </Button>
              </div>
            </div>
          </Card>
          <Card className="stack">
            <div className="card-heading">
              <div>
                <SectionLabel>Managed rich client</SectionLabel>
                <h2>JupyterLab session</h2>
                <p>
                  Launch JupyterLab against this notebook’s runtime profile. Credentials stay at the
                  local daemon boundary and the session link expires automatically.
                </p>
              </div>
              <Badge color={jupyterDiscovery?.available ? 'green' : 'amber'}>
                {jupyterDiscovery?.available
                  ? (jupyterDiscovery.version ?? 'Jupyter available')
                  : jupyterDiscovery?.error
                    ? 'Install required'
                    : 'Checking runtime'}
              </Badge>
            </div>
            <div className="resource-editor-grid">
              <Field
                label="Runtime profile"
                hint="The profile pins the executable and environment revision."
              >
                <Select
                  value={selectedProfileId}
                  onChange={(event) => setSelectedProfileId(event.target.value)}
                  aria-label="Jupyter runtime profile"
                >
                  <option value="">Default local profile</option>
                  {(runtimeProfiles?.profiles ?? []).map((profile) => (
                    <option key={profile.profileId} value={profile.profileId}>
                      {profile.name} · {profile.executable}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="resource-editor-actions">
                {jupyterSession && ['starting', 'ready', 'idle'].includes(jupyterSession.state) ? (
                  <>
                    {jupyterUrl && (
                      <a
                        className="ds-button"
                        data-variant="secondary"
                        href={jupyterUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open JupyterLab
                      </a>
                    )}
                    <Button variant="tertiary" loading={busy} onClick={() => void stopJupyter()}>
                      Stop session
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="secondary"
                    loading={busy}
                    disabled={jupyterDiscovery?.available === false}
                    onClick={() => void openJupyter()}
                  >
                    Open JupyterLab
                  </Button>
                )}
              </div>
            </div>
            {jupyterDiscovery?.error && <p className="page-subtitle">{jupyterDiscovery.error}</p>}
            {jupyterSession && (
              <div className="settings-definition-list">
                <div>
                  <dt>Session</dt>
                  <dd>{jupyterSession.sessionId.slice(0, 12)}</dd>
                </div>
                <div>
                  <dt>State</dt>
                  <dd>{jupyterSession.state}</dd>
                </div>
                <div>
                  <dt>Token expiry</dt>
                  <dd>{new Date(jupyterSession.tokenExpiresAt).toLocaleString()}</dd>
                </div>
              </div>
            )}
          </Card>
          <div className="resource-editor-actions">
            <Button variant="secondary" onClick={() => void addCell('python')}>
              + Python cell
            </Button>
            <Button variant="secondary" onClick={() => void addCell('sql')}>
              + SQL cell
            </Button>
            <Button variant="secondary" onClick={() => void addCell('markdown')}>
              + Markdown cell
            </Button>
          </div>
          {(notebook?.cells ?? []).map((cell, index) => (
            <Card className="stack" key={cell.cellId}>
              <div className="card-heading">
                <div>
                  <h2>Cell {index + 1}</h2>
                  <p>
                    {cell.executionCount === undefined
                      ? 'Not executed'
                      : `Execution ${cell.executionCount}`}
                  </p>
                </div>
                <div className="resource-editor-actions">
                  <Select
                    value={cell.type}
                    onChange={(event) =>
                      updateCell(cell.cellId, { type: event.target.value as CellType })
                    }
                    aria-label={`Cell ${index + 1} type`}
                  >
                    <option value="python">Python</option>
                    <option value="sql">SQL</option>
                    <option value="markdown">Markdown</option>
                  </Select>
                  <Badge
                    color={
                      cell.status === 'completed'
                        ? 'green'
                        : cell.status === 'failed'
                          ? 'red'
                          : cell.status === 'running'
                            ? 'amber'
                            : 'gray'
                    }
                  >
                    {cell.status}
                  </Badge>
                </div>
              </div>
              <Field
                label="Cell source"
                hint="Changes are kept in the notebook document when the cell runs."
              >
                <Textarea
                  value={cell.source}
                  rows={Math.max(4, Math.min(14, cell.source.split('\n').length + 2))}
                  spellCheck={false}
                  onChange={(event) => updateCell(cell.cellId, { source: event.target.value })}
                />
              </Field>
              <div className="resource-editor-actions">
                <Button
                  loading={busy && cell.status === 'running'}
                  onClick={() => void runCell(cell)}
                >
                  Run cell
                </Button>
                {cell.status === 'running' && (
                  <Button variant="tertiary" loading={busy} onClick={() => void cancelCell(cell)}>
                    Cancel cell
                  </Button>
                )}
              </div>
              {cell.outputs.map((output) => (
                <div
                  className="home-state"
                  key={output.outputId}
                  data-tone={output.type === 'error' ? 'danger' : undefined}
                >
                  <strong>{output.type}</strong>
                  {output.artifactId && (
                    <div className="resource-editor-actions">
                      <span className="page-subtitle">
                        Artifact {output.artifactId.slice(0, 20)} · v{output.artifactVersion ?? 1}
                        {output.lineage?.length ? ` · from ${output.lineage.join(', ')}` : ''}
                      </span>
                      <Button
                        variant="tertiary"
                        loading={busy}
                        onClick={() => void publishArtifact(cell, output)}
                      >
                        Publish artifact
                      </Button>
                    </div>
                  )}
                  <pre className="code-block">{outputText(output.value)}</pre>
                </div>
              ))}
            </Card>
          ))}
          {notebook !== undefined && notebook.cells.length === 0 && (
            <Card>
              <p className="page-subtitle">Start with a Python, SQL, or Markdown cell.</p>
            </Card>
          )}
        </div>
      </div>
    </CapabilityGate>
  );
}
