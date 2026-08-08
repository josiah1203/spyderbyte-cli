import { useEffect, useState, type ReactElement } from 'react';
import CapabilityGate from '../components/CapabilityGate';
import RuntimeStateNotice from '../components/RuntimeStateNotice';
import {
  Badge,
  Button,
  Card,
  DataTable,
  Field,
  Input,
  Select,
  SectionLabel,
  Textarea,
} from '../components/primitives';
import { useRuntime } from '../runtime/RuntimeProvider';
import { useRuntimeStore } from '../runtime/store';

interface Repository {
  repositoryId: string;
  name: string;
  path: string;
  kind: 'git' | 'directory';
  remoteUrl?: string;
  registeredAt: string;
  updatedAt: string;
}

interface Worktree {
  worktreeId: string;
  repositoryId: string;
  path: string;
  branch: string;
  createdAt: string;
}

interface RepositoryStatus {
  repositoryId: string;
  branch: string;
  head?: string;
  ahead: number;
  behind: number;
  changedFiles: number;
  stagedFiles: number;
  unstagedFiles: number;
  clean: boolean;
  checkedAt: string;
}

interface RepositoryDiff {
  content: string;
  contentHash: string;
  truncated: boolean;
  generatedAt: string;
}

interface RepositoryFile {
  path: string;
  kind: 'file' | 'directory';
  sizeBytes?: number;
}

interface RepositoryFileContent {
  path: string;
  content: string;
  encoding: 'utf-8';
  sizeBytes: number;
  truncated: boolean;
}

interface SearchMatch {
  path: string;
  line: number;
  column: number;
  snippet: string;
}

interface HistoryEntry {
  historyId: string;
  path: string;
  kind: 'commit' | 'file-operation';
  revision?: string;
  author?: string;
  authoredAt: string;
  subject: string;
}

interface RepositoryCheck {
  name: string;
  status: 'passed' | 'failed';
  output: string;
  checkedAt: string;
}

interface EditorResolution {
  command: string;
  args: string[];
  source: string;
  available: boolean;
}

interface ChangeSetHunk {
  hunkId: string;
  filePath: string;
  header: string;
  patch: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

interface ChangeSet {
  changeSetId: string;
  repositoryId: string;
  baseHead?: string;
  diffHash: string;
  changes?: Array<{ path: string; status: string; dependencyKind?: string }>;
  hunks: ChangeSetHunk[];
  acceptedHunkIds?: string[];
  state: string;
}

interface TestResult {
  status: 'passed' | 'failed' | 'timed_out' | 'cancelled';
  command: string;
  args: string[];
  output: string;
  truncated: boolean;
  runId?: string;
  runtime?: string;
  codeRevision?: string;
}

interface RepositoryResponse {
  repositories: Repository[];
  worktrees: Worktree[];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function Repositories(): ReactElement {
  const runtime = useRuntime();
  const snapshot = useRuntimeStore(runtime);
  const [data, setData] = useState<RepositoryResponse>();
  const [selected, setSelected] = useState<Repository>();
  const [status, setStatus] = useState<RepositoryStatus>();
  const [diff, setDiff] = useState<RepositoryDiff>();
  const [files, setFiles] = useState<RepositoryFile[]>([]);
  const [selectedFile, setSelectedFile] = useState('');
  const [moveTo, setMoveTo] = useState('');
  const [filePreview, setFilePreview] = useState<RepositoryFileContent>();
  const [fileDraft, setFileDraft] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchMatch[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [check, setCheck] = useState<RepositoryCheck>();
  const [editor, setEditor] = useState<EditorResolution>();
  const [changeSet, setChangeSet] = useState<ChangeSet>();
  const [selectedHunks, setSelectedHunks] = useState<string[]>([]);
  const [testCommand, setTestCommand] = useState('git');
  const [testArgs, setTestArgs] = useState('diff --check');
  const [testResult, setTestResult] = useState<TestResult>();
  const [path, setPath] = useState('');
  const [branch, setBranch] = useState('spyderbyte/change');
  const [commitMessage, setCommitMessage] = useState('Describe the reviewed change');
  const [remote, setRemote] = useState('origin');
  const [owner, setOwner] = useState('');
  const [repo, setRepo] = useState('');
  const [githubConnectionId, setGithubConnectionId] = useState('');
  const [prTitle, setPrTitle] = useState('');
  const [prBody, setPrBody] = useState('');
  const [baseBranch, setBaseBranch] = useState('main');
  const [prNumber, setPrNumber] = useState('');
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function load(): Promise<void> {
    if (!runtime.client.get) return;
    try {
      const result = await runtime.client.get<RepositoryResponse>('/v1/repositories/local');
      setData(result);
      setSelected((current) =>
        current === undefined
          ? result.repositories[0]
          : result.repositories.find((item) => item.repositoryId === current.repositoryId),
      );
    } catch (error) {
      setMessage(errorText(error));
    }
  }

  useEffect(() => {
    void load();
  }, [runtime]);

  useEffect(() => {
    if (!selected || !runtime.client.get) {
      setStatus(undefined);
      setDiff(undefined);
      setFiles([]);
      setSelectedFile('');
      setFilePreview(undefined);
      setFileDraft('');
      setSearchResults([]);
      setHistory([]);
      setChangeSet(undefined);
      setSelectedHunks([]);
      return;
    }
    let cancelled = false;
    const get = runtime.client.get;
    const loadDetails = async (): Promise<void> => {
      try {
        const [nextStatus, nextDiff] = await Promise.all([
          get<RepositoryStatus>(
            `/v1/repositories/local/${encodeURIComponent(selected.repositoryId)}/status`,
          ),
          get<RepositoryDiff>(
            `/v1/repositories/local/${encodeURIComponent(selected.repositoryId)}/diff`,
          ),
        ]);
        if (!cancelled) {
          setStatus(nextStatus);
          setDiff(nextDiff);
        }
        try {
          const nextFiles = await get<RepositoryFile[]>(
            `/v1/repositories/local/${encodeURIComponent(selected.repositoryId)}/files`,
          );
          if (!cancelled) {
            setFiles(nextFiles);
            setSelectedFile((current) => current || nextFiles[0]?.path || '');
          }
        } catch {
          if (!cancelled) setFiles([]);
        }
        if (!cancelled) {
          try {
            setEditor(await get<EditorResolution>('/v1/editors/resolve'));
          } catch {
            setEditor(undefined);
          }
        }
      } catch (error) {
        if (!cancelled) setMessage(errorText(error));
      }
    };
    void loadDetails();
    return () => {
      cancelled = true;
    };
  }, [runtime, selected]);

  async function previewFile(): Promise<void> {
    if (!selected || !runtime.client.get || !selectedFile) return;
    try {
      const preview = await runtime.client.get<RepositoryFileContent>(
        `/v1/repositories/local/${encodeURIComponent(selected.repositoryId)}/file?path=${encodeURIComponent(selectedFile)}`,
      );
      setFilePreview(preview);
      setFileDraft(preview.content);
    } catch (error) {
      setMessage(errorText(error));
    }
  }

  async function searchFiles(): Promise<void> {
    if (!selected || !runtime.client.get || !searchQuery.trim()) return;
    try {
      setSearchResults(
        await runtime.client.get<SearchMatch[]>(
          `/v1/repositories/local/${encodeURIComponent(selected.repositoryId)}/search?query=${encodeURIComponent(searchQuery.trim())}`,
        ),
      );
    } catch (error) {
      setMessage(errorText(error));
    }
  }

  async function loadHistory(): Promise<void> {
    if (!selected || !runtime.client.get || !selectedFile) return;
    try {
      setHistory(
        await runtime.client.get<HistoryEntry[]>(
          `/v1/repositories/local/${encodeURIComponent(selected.repositoryId)}/history?path=${encodeURIComponent(selectedFile)}`,
        ),
      );
    } catch (error) {
      setMessage(errorText(error));
    }
  }

  async function saveFile(): Promise<void> {
    if (!selected || !runtime.client.post || !selectedFile) return;
    setBusy(true);
    try {
      await runtime.client.post(
        `/v1/repositories/local/${encodeURIComponent(selected.repositoryId)}/file`,
        { path: selectedFile, content: fileDraft, origin: 'manual' },
      );
      setMessage(`${selectedFile} saved. Refresh the review before accepting it.`);
      await previewFile();
      await load();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function moveFile(): Promise<void> {
    if (!selected || !runtime.client.post || !selectedFile || !moveTo.trim()) return;
    setBusy(true);
    try {
      await runtime.client.post(
        `/v1/repositories/local/${encodeURIComponent(selected.repositoryId)}/files/move`,
        { from: selectedFile, to: moveTo.trim() },
      );
      setSelectedFile(moveTo.trim());
      setMoveTo('');
      setMessage(`${selectedFile} moved to ${moveTo.trim()}.`);
      await load();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelectedFile(): Promise<void> {
    if (!selected || !runtime.client.post || !selectedFile) return;
    setBusy(true);
    try {
      await runtime.client.post(
        `/v1/repositories/local/${encodeURIComponent(selected.repositoryId)}/files/delete`,
        { path: selectedFile },
      );
      setFilePreview(undefined);
      setFileDraft('');
      setMessage(`${selectedFile} deleted.`);
      await load();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function refreshChangeSet(): Promise<void> {
    if (!changeSet || !runtime.client.post) return;
    setBusy(true);
    try {
      const refreshed = await runtime.client.post<ChangeSet>(
        `/v1/change-sets/${encodeURIComponent(changeSet.changeSetId)}/refresh`,
        {},
      );
      setChangeSet(refreshed);
      setSelectedHunks([]);
      setMessage('Review refreshed from the current working tree.');
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function register(): Promise<void> {
    if (!runtime.client.post || !path.trim()) {
      setMessage('Enter the absolute path to a local project directory or Git repository.');
      return;
    }
    setBusy(true);
    setMessage(undefined);
    try {
      const repository = await runtime.client.post<Repository>('/v1/repositories/local/register', {
        path: path.trim(),
      });
      setPath('');
      setSelected(repository);
      setMessage(`${repository.name} is registered.`);
      await load();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function runCheck(): Promise<void> {
    if (!selected || !runtime.client.post) return;
    setBusy(true);
    try {
      setCheck(
        await runtime.client.post<RepositoryCheck>(
          `/v1/repositories/local/${encodeURIComponent(selected.repositoryId)}/checks`,
          {},
        ),
      );
      setMessage('Repository check completed.');
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function createChangeSet(): Promise<void> {
    if (!selected || !runtime.client.post) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const created = await runtime.client.post<ChangeSet>(
        `/v1/repositories/local/${encodeURIComponent(selected.repositoryId)}/change-sets`,
        {},
      );
      setChangeSet(created);
      setSelectedHunks(created.hunks.map((hunk) => hunk.hunkId));
      setMessage(
        created.hunks.length === 0
          ? 'No reviewable hunks were found in the current diff.'
          : `Change set created with ${created.hunks.length} reviewable hunk${created.hunks.length === 1 ? '' : 's'}.`,
      );
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function applyHunks(action: 'accept' | 'revert'): Promise<void> {
    if (!changeSet || !runtime.client.post || selectedHunks.length === 0) {
      setMessage('Select at least one hunk before applying a review action.');
      return;
    }
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await runtime.client.post<{ changeSet: ChangeSet }>(
        `/v1/change-sets/${encodeURIComponent(changeSet.changeSetId)}/hunks`,
        { hunkIds: selectedHunks, action },
      );
      setChangeSet(result.changeSet);
      setMessage(
        action === 'accept'
          ? 'Selected hunks were staged for the reviewed change set.'
          : 'Selected hunks were reverted from the working tree.',
      );
      await load();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function runTest(): Promise<void> {
    if (!selected || !runtime.client.post || !testCommand.trim()) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await runtime.client.post<TestResult>(
        `/v1/repositories/local/${encodeURIComponent(selected.repositoryId)}/tests`,
        {
          command: testCommand.trim(),
          args: testArgs.trim().split(/\s+/).filter(Boolean),
        },
      );
      setTestResult(result);
      setMessage(`Bounded test command ${result.status}.`);
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function createWorktree(): Promise<void> {
    if (!selected || !runtime.client.post || !branch.trim()) return;
    setBusy(true);
    try {
      await runtime.client.post<Worktree>(
        `/v1/repositories/local/${encodeURIComponent(selected.repositoryId)}/worktrees`,
        { branch: branch.trim() },
      );
      setMessage(`Worktree ${branch.trim()} created inside the workspace.`);
      await load();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function commit(): Promise<void> {
    if (!selected || !runtime.client.post) return;
    setBusy(true);
    try {
      await runtime.client.post(
        `/v1/repositories/local/${encodeURIComponent(selected.repositoryId)}/commit`,
        { message: commitMessage },
      );
      setMessage('Commit created after staging the registered repository changes.');
      await load();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function push(): Promise<void> {
    if (!selected || !runtime.client.post) return;
    setBusy(true);
    try {
      await runtime.client.post(
        `/v1/repositories/local/${encodeURIComponent(selected.repositoryId)}/push`,
        { remote },
      );
      setMessage('Branch pushed to the configured remote.');
      await load();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function createPullRequest(): Promise<void> {
    if (!selected || !runtime.client.post || !githubConnectionId.trim()) {
      setMessage('Provide a connected GitHub connection ID before opening a pull request.');
      return;
    }
    setBusy(true);
    try {
      await runtime.client.post(
        `/v1/repositories/local/${encodeURIComponent(selected.repositoryId)}/pull-requests`,
        {
          provider: 'github',
          connectionId: githubConnectionId.trim(),
          owner: owner.trim(),
          repo: repo.trim() || selected.name,
          head: status?.branch ?? branch,
          base: baseBranch.trim(),
          title: prTitle.trim() || commitMessage.trim(),
          body: prBody,
        },
      );
      setMessage('Pull request creation requested through the scoped GitHub action.');
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function mergePullRequest(): Promise<void> {
    if (!selected || !runtime.client.post || !githubConnectionId.trim()) {
      setMessage('Provide a connected GitHub connection ID before merging.');
      return;
    }
    const number = Number(prNumber);
    if (!Number.isSafeInteger(number) || number < 1) {
      setMessage('Pull request number must be a positive integer.');
      return;
    }
    setBusy(true);
    try {
      await runtime.client.post(
        `/v1/repositories/local/${encodeURIComponent(selected.repositoryId)}/merge`,
        {
          provider: 'github',
          connectionId: githubConnectionId.trim(),
          owner: owner.trim(),
          repo: repo.trim() || selected.name,
          number,
          mergeMethod: 'squash',
        },
      );
      setMessage('Pull request merge requested through GitHub.');
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  const worktrees =
    data?.worktrees.filter((item) => item.repositoryId === selected?.repositoryId) ?? [];

  return (
    <CapabilityGate page="repositories">
      <div className="page-scroll">
        <div className="page stack">
          <div className="page-heading">
            <div>
              <SectionLabel>Code and repository workbench</SectionLabel>
              <h1>Repositories</h1>
              <p className="page-subtitle">
                Register local Git repositories, inspect immutable diffs, run bounded checks, and
                create isolated worktrees for project or game development.
              </p>
            </div>
          </div>
          <RuntimeStateNotice state={snapshot.connection} onRetry={() => void runtime.retry()} />
          {message && (
            <div className="home-error" role="status">
              {message}
            </div>
          )}
          <Card className="stack">
            <div className="card-heading">
              <div>
                <h2>Register a local project</h2>
                <p>
                  Only explicitly registered paths are available to the bounded project filesystem.
                </p>
              </div>
              <Badge color="green">Local boundary</Badge>
            </div>
            <div className="resource-editor-grid">
              <Field
                label="Repository path"
                hint="Use an absolute path to a local project directory or checked-out Git repository."
              >
                <Input
                  value={path}
                  onChange={(event) => setPath(event.target.value)}
                  placeholder="/Users/you/Code/project"
                />
              </Field>
              <div className="resource-editor-actions">
                <Button loading={busy} onClick={() => void register()}>
                  Register repository
                </Button>
              </div>
            </div>
          </Card>
          <div className="resource-editor-grid">
            <Card className="stack">
              <div className="card-heading">
                <h2>Registered repositories</h2>
                <Button variant="tertiary" onClick={() => void load()}>
                  Refresh
                </Button>
              </div>
              <DataTable
                columns={[
                  { key: 'name', header: 'Repository', render: (item) => item.name },
                  { key: 'path', header: 'Path', render: (item) => item.path },
                  {
                    key: 'remote',
                    header: 'Remote',
                    render: (item) => item.remoteUrl ?? 'Local only',
                  },
                ]}
                rows={data?.repositories ?? []}
                getRowKey={(item) => item.repositoryId}
                selectedKey={selected?.repositoryId}
                onRowClick={(item) => setSelected(item)}
                empty="No repositories registered yet."
              />
            </Card>
            <Card className="stack">
              <div className="card-heading">
                <div>
                  <h2>{selected?.name ?? 'Select a repository'}</h2>
                  <p>{selected?.path ?? 'Register a repository to inspect its worktree.'}</p>
                </div>
                {status && (
                  <Badge color={status.clean ? 'green' : 'amber'}>
                    {status.clean ? 'Clean' : 'Changes'}
                  </Badge>
                )}
              </div>
              {status && (
                <div className="settings-definition-list">
                  <div>
                    <dt>Branch</dt>
                    <dd>{status.branch}</dd>
                  </div>
                  <div>
                    <dt>HEAD</dt>
                    <dd>{status.head?.slice(0, 12) ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>Changed files</dt>
                    <dd>{status.changedFiles}</dd>
                  </div>
                  <div>
                    <dt>Tracking</dt>
                    <dd>
                      {status.ahead} ahead · {status.behind} behind
                    </dd>
                  </div>
                </div>
              )}
              <div className="resource-editor-actions">
                <Button
                  variant="secondary"
                  disabled={!selected}
                  loading={busy}
                  onClick={() => void runCheck()}
                >
                  Run git diff check
                </Button>
              </div>
              {check && (
                <div
                  className="home-error"
                  data-tone={check.status === 'passed' ? 'success' : 'danger'}
                >
                  {check.output}
                </div>
              )}
              <div className="settings-definition-list">
                <div>
                  <dt>External editor</dt>
                  <dd>
                    {editor
                      ? `${editor.command}${editor.available ? '' : ' (unavailable)'}`
                      : 'Not resolved'}
                  </dd>
                </div>
                <div>
                  <dt>Resolution source</dt>
                  <dd>{editor?.source ?? '—'}</dd>
                </div>
              </div>
            </Card>
          </div>
          <Card className="stack">
            <div className="card-heading">
              <div>
                <h2>Immutable diff</h2>
                <p>
                  {diff
                    ? `${diff.contentHash}${diff.truncated ? ' · truncated at 2 MB' : ''}`
                    : 'Select a repository to load its current diff.'}
                </p>
              </div>
            </div>
            <Textarea value={diff?.content ?? ''} readOnly rows={14} aria-label="Repository diff" />
          </Card>
          <Card className="stack">
            <div className="card-heading">
              <div>
                <h2>Project files</h2>
                <p>Preview a registered repository file through the bounded filesystem adapter.</p>
              </div>
            </div>
            <div className="resource-editor-grid">
              <Field label="File">
                <Select
                  value={selectedFile}
                  onChange={(event) => {
                    setSelectedFile(event.target.value);
                    setFilePreview(undefined);
                  }}
                  aria-label="Repository file"
                >
                  <option value="">Select a file</option>
                  {files
                    .filter((file) => file.kind === 'file')
                    .map((file) => (
                      <option key={file.path} value={file.path}>
                        {file.path}
                      </option>
                    ))}
                </Select>
              </Field>
              <div className="resource-editor-actions">
                <Button
                  variant="secondary"
                  disabled={!selectedFile}
                  onClick={() => void previewFile()}
                >
                  Preview file
                </Button>
              </div>
            </div>
            <div className="resource-editor-grid">
              <Field label="Search project files" hint="Literal search, bounded to text previews.">
                <Input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search source, config, or docs"
                />
              </Field>
              <div className="resource-editor-actions">
                <Button
                  variant="secondary"
                  disabled={!selected || !searchQuery.trim()}
                  onClick={() => void searchFiles()}
                >
                  Search
                </Button>
                <Button
                  variant="tertiary"
                  disabled={!selectedFile}
                  onClick={() => void loadHistory()}
                >
                  Load history
                </Button>
              </div>
            </div>
            {searchResults.length > 0 && (
              <div className="home-state">
                {searchResults.map((match) => (
                  <div key={`${match.path}:${match.line}:${match.column}`}>
                    <strong>
                      {match.path}:{match.line}:{match.column}
                    </strong>{' '}
                    — {match.snippet}
                  </div>
                ))}
              </div>
            )}
            {filePreview && (
              <>
                <p className="page-subtitle">
                  {filePreview.path} · {filePreview.sizeBytes} bytes
                  {filePreview.truncated ? ' · truncated' : ''}
                </p>
                <Textarea
                  value={fileDraft}
                  onChange={(event) => setFileDraft(event.target.value)}
                  rows={12}
                  aria-label="File editor"
                />
                <div className="resource-editor-actions">
                  <Button variant="secondary" loading={busy} onClick={() => void saveFile()}>
                    Save manual edit
                  </Button>
                </div>
                <div className="resource-editor-grid">
                  <Field label="Move to" hint="Regular files only; destination must not exist.">
                    <Input
                      value={moveTo}
                      onChange={(event) => setMoveTo(event.target.value)}
                      placeholder="src/renamed.py"
                    />
                  </Field>
                  <div className="resource-editor-actions">
                    <Button
                      variant="tertiary"
                      loading={busy}
                      disabled={!moveTo.trim()}
                      onClick={() => void moveFile()}
                    >
                      Move file
                    </Button>
                    <Button
                      variant="outline-danger"
                      loading={busy}
                      onClick={() => void deleteSelectedFile()}
                    >
                      Delete file
                    </Button>
                  </div>
                </div>
              </>
            )}
            {history.length > 0 && (
              <div className="home-state">
                {history.map((entry) => (
                  <div key={entry.historyId}>
                    <strong>{entry.kind}</strong> · {entry.subject} · {entry.authoredAt}
                  </div>
                ))}
              </div>
            )}
          </Card>
          <Card className="stack">
            <div className="card-heading">
              <div>
                <h2>Reviewed change set</h2>
                <p>
                  Select exact diff hunks before staging or reverting them. The daemon rechecks the
                  repository HEAD before applying a stale review.
                </p>
              </div>
              <Button
                variant="secondary"
                disabled={!selected}
                loading={busy}
                onClick={() => void createChangeSet()}
              >
                Create review
              </Button>
              <Button
                variant="tertiary"
                disabled={!changeSet}
                loading={busy}
                onClick={() => void refreshChangeSet()}
              >
                Refresh review
              </Button>
            </div>
            {changeSet ? (
              <>
                <div className="settings-definition-list">
                  <div>
                    <dt>Review state</dt>
                    <dd>{changeSet.state}</dd>
                  </div>
                  <div>
                    <dt>Base HEAD</dt>
                    <dd>{changeSet.baseHead?.slice(0, 12) ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>Diff hash</dt>
                    <dd>{changeSet.diffHash.slice(0, 20)}</dd>
                  </div>
                  <div>
                    <dt>Change classes</dt>
                    <dd>
                      {changeSet.changes
                        ?.map((change) => `${change.status}:${change.path}`)
                        .join(' · ') || '—'}
                    </dd>
                  </div>
                </div>
                <div className="stack">
                  {changeSet.hunks.map((hunk) => {
                    const checked = selectedHunks.includes(hunk.hunkId);
                    return (
                      <label className="home-state" key={hunk.hunkId}>
                        <span className="home-objective-row">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(event) =>
                              setSelectedHunks((current) =>
                                event.target.checked
                                  ? [...current, hunk.hunkId]
                                  : current.filter((value) => value !== hunk.hunkId),
                              )
                            }
                          />
                          <strong>{hunk.filePath}</strong>
                          <span>{hunk.header}</span>
                        </span>
                        <pre className="code-block">{hunk.patch}</pre>
                      </label>
                    );
                  })}
                  {changeSet.hunks.length === 0 && (
                    <div className="home-state">No textual hunks are available.</div>
                  )}
                </div>
                <div className="resource-editor-actions">
                  <Button
                    variant="secondary"
                    disabled={selectedHunks.length === 0}
                    loading={busy}
                    onClick={() => void applyHunks('accept')}
                  >
                    Accept selected hunks
                  </Button>
                  <Button
                    variant="outline-danger"
                    disabled={selectedHunks.length === 0}
                    loading={busy}
                    onClick={() => void applyHunks('revert')}
                  >
                    Revert selected hunks
                  </Button>
                </div>
              </>
            ) : (
              <div className="home-state">
                Create a review to inspect and select individual hunks.
              </div>
            )}
          </Card>
          <Card className="stack">
            <div className="card-heading">
              <div>
                <h2>Run a bounded test</h2>
                <p>
                  Commands are executed without a shell and only approved command families are
                  allowed.
                </p>
              </div>
              <Badge color="amber">Effectful action</Badge>
            </div>
            <div className="resource-editor-grid">
              <Field label="Command">
                <Input
                  value={testCommand}
                  onChange={(event) => setTestCommand(event.target.value)}
                />
              </Field>
              <Field label="Arguments" hint="Whitespace-separated; no shell operators.">
                <Input value={testArgs} onChange={(event) => setTestArgs(event.target.value)} />
              </Field>
            </div>
            <Button
              variant="secondary"
              disabled={!selected}
              loading={busy}
              onClick={() => void runTest()}
            >
              Run test command
            </Button>
            {testResult && (
              <div
                className="home-state"
                data-tone={testResult.status === 'passed' ? 'success' : 'danger'}
              >
                <strong>{testResult.status}</strong>
                {testResult.runId && (
                  <div>
                    {testResult.runtime ?? 'runtime'} · run {testResult.runId} · revision{' '}
                    {testResult.codeRevision?.slice(0, 20) ?? '—'}
                  </div>
                )}
                <pre className="code-block">{testResult.output || 'No output.'}</pre>
                {testResult.truncated && <span>Output truncated to protect the workspace.</span>}
              </div>
            )}
          </Card>
          <Card className="stack">
            <div className="card-heading">
              <div>
                <h2>Commit, push, and review</h2>
                <p>
                  Writes are explicit and bounded to the registered repository. GitHub actions use
                  the connected OAuth account.
                </p>
              </div>
              <Badge color="amber">Write actions</Badge>
            </div>
            <div className="resource-editor-grid">
              <Field label="Commit message">
                <Input
                  value={commitMessage}
                  onChange={(event) => setCommitMessage(event.target.value)}
                />
              </Field>
              <Field label="Remote">
                <Input value={remote} onChange={(event) => setRemote(event.target.value)} />
              </Field>
            </div>
            <div className="resource-editor-actions">
              <Button
                variant="secondary"
                disabled={!selected}
                loading={busy}
                onClick={() => void commit()}
              >
                Create commit
              </Button>
              <Button
                variant="secondary"
                disabled={!selected}
                loading={busy}
                onClick={() => void push()}
              >
                Push branch
              </Button>
            </div>
            <div className="resource-editor-grid">
              <Field
                label="GitHub connection ID"
                hint="Connect GitHub from the connector gallery first."
              >
                <Input
                  value={githubConnectionId}
                  onChange={(event) => setGithubConnectionId(event.target.value)}
                  placeholder="connection ID"
                />
              </Field>
              <Field label="Repository owner">
                <Input
                  value={owner}
                  onChange={(event) => setOwner(event.target.value)}
                  placeholder="owner"
                />
              </Field>
              <Field label="GitHub repository">
                <Input
                  value={repo}
                  onChange={(event) => setRepo(event.target.value)}
                  placeholder={selected?.name ?? 'repository'}
                />
              </Field>
              <Field label="Base branch">
                <Input value={baseBranch} onChange={(event) => setBaseBranch(event.target.value)} />
              </Field>
              <Field label="Pull request title">
                <Input
                  value={prTitle}
                  onChange={(event) => setPrTitle(event.target.value)}
                  placeholder="Use the commit message"
                />
              </Field>
              <Field label="Pull request number" hint="Only used for an explicit merge request.">
                <Input
                  type="number"
                  min="1"
                  value={prNumber}
                  onChange={(event) => setPrNumber(event.target.value)}
                />
              </Field>
            </div>
            <Field label="Pull request body">
              <Textarea
                value={prBody}
                onChange={(event) => setPrBody(event.target.value)}
                rows={4}
                placeholder="What changed and which checks passed?"
              />
            </Field>
            <div className="resource-editor-actions">
              <Button
                variant="secondary"
                disabled={!selected}
                loading={busy}
                onClick={() => void createPullRequest()}
              >
                Open pull request
              </Button>
              <Button
                variant="tertiary"
                disabled={!selected}
                loading={busy}
                onClick={() => void mergePullRequest()}
              >
                Merge pull request
              </Button>
            </div>
          </Card>
          <Card className="stack">
            <div className="card-heading">
              <div>
                <h2>Workspace worktrees</h2>
                <p>New branches are created under the managed workspace directory.</p>
              </div>
            </div>
            <div className="resource-editor-grid">
              <Field label="New branch">
                <Input value={branch} onChange={(event) => setBranch(event.target.value)} />
              </Field>
              <div className="resource-editor-actions">
                <Button disabled={!selected} loading={busy} onClick={() => void createWorktree()}>
                  Create worktree
                </Button>
              </div>
            </div>
            <DataTable
              columns={[
                { key: 'branch', header: 'Branch', render: (item) => item.branch },
                { key: 'path', header: 'Path', render: (item) => item.path },
                { key: 'created', header: 'Created', render: (item) => item.createdAt },
              ]}
              rows={worktrees}
              getRowKey={(item) => item.worktreeId}
              empty="No workspace worktrees yet."
            />
          </Card>
        </div>
      </div>
    </CapabilityGate>
  );
}
