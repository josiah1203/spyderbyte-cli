import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
  lstat,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { runtimeError } from '@agentic-platform/runtime-contracts';
import type { ProviderActionRuntime } from './provider-actions.js';
import type { RuntimeProfileRuntime } from './runtime-profiles.js';

const execFileAsync = promisify(execFile);
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 1 * 1024 * 1024;
const MAX_TEST_OUTPUT_BYTES = 256 * 1024;
const MAX_TEST_TIMEOUT_MS = 120_000;
const MAX_SEARCH_RESULTS = 200;
const MAX_TREE_ENTRIES = 20_000;
const MAX_OPERATION_HISTORY = 2_000;
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]+$/;
const IGNORED_DIRECTORY_NAMES = new Set([
  '.git',
  '.agentic',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
]);

export type LocalRepositoryKind = 'git' | 'directory';
export type LocalFileOrigin = 'manual' | 'generated' | 'upload' | 'artifact-derived';
export type LocalRepositoryRunRuntime =
  | 'local-command'
  | 'local-python'
  | 'managed-python'
  | 'dependency-install';

export interface LocalRepositoryRecord {
  readonly repositoryId: string;
  readonly name: string;
  readonly path: string;
  readonly kind: LocalRepositoryKind;
  readonly remoteUrl?: string;
  readonly registeredAt: string;
  readonly updatedAt: string;
}

export interface LocalRepositoryStatus {
  readonly repositoryId: string;
  readonly branch: string;
  readonly head?: string;
  readonly ahead: number;
  readonly behind: number;
  readonly changedFiles: number;
  readonly stagedFiles: number;
  readonly unstagedFiles: number;
  readonly clean: boolean;
  readonly checkedAt: string;
}

export interface LocalRepositoryDiff {
  readonly repositoryId: string;
  readonly content: string;
  readonly contentHash: string;
  readonly truncated: boolean;
  readonly generatedAt: string;
}

export interface LocalRepositoryFile {
  readonly path: string;
  readonly kind: 'file' | 'directory';
  readonly sizeBytes?: number;
}

export interface LocalRepositoryFileContent {
  readonly path: string;
  readonly content: string;
  readonly encoding: 'utf-8';
  readonly sizeBytes: number;
  readonly truncated: boolean;
}

export interface LocalRepositoryFileWriteResult {
  readonly repositoryId: string;
  readonly path: string;
  readonly operationId: string;
  readonly operation: 'created' | 'modified';
  readonly origin: LocalFileOrigin;
  readonly artifactId?: string;
  readonly changeSetId?: string;
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly writtenAt: string;
}

export interface LocalRepositoryFileMoveResult {
  readonly repositoryId: string;
  readonly operationId: string;
  readonly from: string;
  readonly to: string;
  readonly movedAt: string;
}

export interface LocalRepositoryFileDeleteResult {
  readonly repositoryId: string;
  readonly operationId: string;
  readonly path: string;
  readonly deletedAt: string;
}

export interface LocalRepositorySearchMatch {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly snippet: string;
}

export interface LocalRepositoryHistoryEntry {
  readonly historyId: string;
  readonly path: string;
  readonly kind: 'commit' | 'file-operation';
  readonly revision?: string;
  readonly author?: string;
  readonly authoredAt: string;
  readonly subject: string;
  readonly operationId?: string;
}

export interface LocalEditorResolution {
  readonly command: string;
  readonly args: readonly string[];
  readonly source:
    | 'spyderbyte-setting'
    | 'VISUAL'
    | 'EDITOR'
    | 'detected-editor'
    | 'platform-default';
  readonly available: boolean;
}

export interface LocalChangeSetHunk {
  readonly hunkId: string;
  readonly filePath: string;
  readonly header: string;
  readonly patch: string;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
}

export interface LocalChangeSetChange {
  readonly path: string;
  readonly status: 'created' | 'modified' | 'deleted' | 'dependency';
  readonly dependencyKind?: 'manifest' | 'lockfile';
}

export interface LocalChangeSet {
  readonly changeSetId: string;
  readonly repositoryId: string;
  readonly baseHead?: string;
  readonly diffHash: string;
  readonly changes: readonly LocalChangeSetChange[];
  readonly hunks: readonly LocalChangeSetHunk[];
  readonly acceptedHunkIds: readonly string[];
  readonly state: 'draft' | 'partially_accepted' | 'accepted' | 'reverted';
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LocalChangeSetApplyResult {
  readonly changeSet: LocalChangeSet;
  readonly appliedHunkIds: readonly string[];
  readonly action: 'accept' | 'revert';
}

export interface LocalRepositoryTestResult {
  readonly repositoryId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly status: 'passed' | 'failed' | 'timed_out' | 'cancelled';
  readonly exitCode?: number;
  readonly output: string;
  readonly truncated: boolean;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly runId: string;
  readonly codeRevision: string;
  readonly environmentRevision?: string;
  readonly runtime: LocalRepositoryRunRuntime;
  readonly metrics: LocalRepositoryRunMetrics;
  readonly artifacts: readonly string[];
}

export interface LocalRepositoryRunMetrics {
  readonly durationMs: number;
  readonly exitCode?: number;
}

export interface LocalRepositoryRun {
  readonly runId: string;
  readonly repositoryId: string;
  readonly status: 'running' | 'passed' | 'failed' | 'timed_out' | 'cancelled';
  readonly codeRevision: string;
  readonly environmentRevision?: string;
  readonly runtime: LocalRepositoryRunRuntime;
  readonly inputs: { readonly command: string; readonly args: readonly string[] };
  readonly logs: { readonly output: string; readonly truncated: boolean };
  readonly metrics: LocalRepositoryRunMetrics;
  readonly outputs: readonly {
    readonly kind: 'command';
    readonly status: LocalRepositoryRun['status'];
    readonly exitCode?: number;
  }[];
  readonly artifacts: readonly string[];
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly error?: string;
}

export interface LocalRepositoryFileOperation {
  readonly operationId: string;
  readonly repositoryId: string;
  readonly operation: 'created' | 'modified' | 'moved' | 'deleted';
  readonly path: string;
  readonly from?: string;
  readonly to?: string;
  readonly origin?: LocalFileOrigin;
  readonly artifactId?: string;
  readonly contentHash?: string;
  readonly occurredAt: string;
}

export interface LocalRepositoryCheck {
  readonly repositoryId: string;
  readonly name: 'git-diff-check';
  readonly status: 'passed' | 'failed';
  readonly output: string;
  readonly checkedAt: string;
}

export interface LocalWorktreeRecord {
  readonly worktreeId: string;
  readonly repositoryId: string;
  readonly path: string;
  readonly branch: string;
  readonly createdAt: string;
}

export interface LocalRepositoryCommit {
  readonly repositoryId: string;
  readonly commit: string;
  readonly branch: string;
  readonly message: string;
  readonly committedAt: string;
}

export interface LocalRepositoryPush {
  readonly repositoryId: string;
  readonly remote: string;
  readonly branch: string;
  readonly commit: string;
  readonly pushedAt: string;
}

export interface LocalRepositoryPullRequest {
  readonly provider: 'github';
  readonly connectionId: string;
  readonly owner: string;
  readonly repo: string;
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly body?: string;
  readonly draft?: boolean;
}

export interface LocalRepositoryMergeRequest {
  readonly provider: 'github';
  readonly connectionId: string;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly mergeMethod?: 'merge' | 'squash' | 'rebase';
  readonly commitTitle?: string;
  readonly commitMessage?: string;
}

export interface RepositoryRuntime {
  list(): Promise<readonly LocalRepositoryRecord[]>;
  register(input: {
    path: string;
    name?: string;
    remoteUrl?: string;
    kind?: LocalRepositoryKind;
  }): Promise<LocalRepositoryRecord>;
  status(repositoryId: string): Promise<LocalRepositoryStatus>;
  diff(repositoryId: string): Promise<LocalRepositoryDiff>;
  listFiles(repositoryId: string, prefix?: string): Promise<readonly LocalRepositoryFile[]>;
  readFile(repositoryId: string, path: string): Promise<LocalRepositoryFileContent>;
  search(
    repositoryId: string,
    query: string,
    prefix?: string,
  ): Promise<readonly LocalRepositorySearchMatch[]>;
  history(repositoryId: string, path?: string): Promise<readonly LocalRepositoryHistoryEntry[]>;
  writeFile(input: {
    repositoryId: string;
    path: string;
    content: string;
    origin: LocalFileOrigin;
    artifactId?: string;
  }): Promise<LocalRepositoryFileWriteResult>;
  moveFile(input: {
    repositoryId: string;
    from: string;
    to: string;
  }): Promise<LocalRepositoryFileMoveResult>;
  deleteFile(input: {
    repositoryId: string;
    path: string;
  }): Promise<LocalRepositoryFileDeleteResult>;
  setEditorSetting(value: string | undefined): Promise<LocalEditorResolution>;
  resolveEditor(): Promise<LocalEditorResolution>;
  createChangeSet(repositoryId: string): Promise<LocalChangeSet>;
  refreshChangeSet(changeSetId: string): Promise<LocalChangeSet>;
  getChangeSet(changeSetId: string): Promise<LocalChangeSet | undefined>;
  applyChangeSetHunks(input: {
    changeSetId: string;
    hunkIds: readonly string[];
    action: 'accept' | 'revert';
  }): Promise<LocalChangeSetApplyResult>;
  runTest(input: {
    repositoryId: string;
    command: string;
    args?: readonly string[];
    timeoutMs?: number;
    runtime?: LocalRepositoryRunRuntime;
    environmentRevisionId?: string;
  }): Promise<LocalRepositoryTestResult>;
  runPython(input: {
    repositoryId: string;
    source: string;
    args?: readonly string[];
    runtimeProfileId?: string;
    environmentRevisionId?: string;
    timeoutMs?: number;
  }): Promise<LocalRepositoryTestResult>;
  installDependencies(input: {
    repositoryId: string;
    command: string;
    args?: readonly string[];
    timeoutMs?: number;
  }): Promise<LocalRepositoryTestResult>;
  listRuns(repositoryId?: string): Promise<readonly LocalRepositoryRun[]>;
  getRun(runId: string): Promise<LocalRepositoryRun | undefined>;
  cancelRun(runId: string): Promise<LocalRepositoryRun>;
  check(repositoryId: string): Promise<LocalRepositoryCheck>;
  listWorktrees(repositoryId?: string): Promise<readonly LocalWorktreeRecord[]>;
  createWorktree(input: {
    repositoryId: string;
    branch: string;
    base?: string;
  }): Promise<LocalWorktreeRecord>;
  commit(repositoryId: string, message: string): Promise<LocalRepositoryCommit>;
  push(
    repositoryId: string,
    input?: { remote?: string; branch?: string },
  ): Promise<LocalRepositoryPush>;
  createPullRequest(input: LocalRepositoryPullRequest): Promise<JsonRepositoryActionResult>;
  mergePullRequest(input: LocalRepositoryMergeRequest): Promise<JsonRepositoryActionResult>;
}

export interface JsonRepositoryActionResult {
  readonly repositoryId?: string;
  readonly output: unknown;
  readonly completedAt: string;
}

interface RepositoryState {
  readonly repositories: LocalRepositoryRecord[];
  readonly worktrees: LocalWorktreeRecord[];
  readonly changeSets: LocalChangeSet[];
  readonly runs: LocalRepositoryRun[];
  readonly fileOperations: LocalRepositoryFileOperation[];
  editorSetting?: string;
}

function emptyState(): RepositoryState {
  return { repositories: [], worktrees: [], changeSets: [], runs: [], fileOperations: [] };
}

function outputText(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function boundedOutput(value: string): { content: string; truncated: boolean } {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes <= MAX_DIFF_BYTES) return { content: value, truncated: false };
  return {
    content: Buffer.from(value, 'utf8').subarray(0, MAX_DIFF_BYTES).toString('utf8'),
    truncated: true,
  };
}

function boundedTestOutput(value: string): { content: string; truncated: boolean } {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes <= MAX_TEST_OUTPUT_BYTES) return { content: value, truncated: false };
  return {
    content: Buffer.from(value, 'utf8').subarray(0, MAX_TEST_OUTPUT_BYTES).toString('utf8'),
    truncated: true,
  };
}

function parseHunkHeader(header: string):
  | {
      oldStart: number;
      oldLines: number;
      newStart: number;
      newLines: number;
    }
  | undefined {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (!match) return undefined;
  return {
    oldStart: Number(match[1]),
    oldLines: Number(match[2] ?? '1'),
    newStart: Number(match[3]),
    newLines: Number(match[4] ?? '1'),
  };
}

function parseDiffHunks(content: string): LocalChangeSetHunk[] {
  const lines = content.split('\n');
  const hunks: LocalChangeSetHunk[] = [];
  let filePath: string | undefined;
  let fileHeader: string[] = [];
  let current: { header: string; lines: string[]; filePath: string } | undefined;
  const flush = (): void => {
    if (!current) return;
    const parsed = parseHunkHeader(current.header);
    if (!parsed) {
      current = undefined;
      return;
    }
    const hunkId = `hunk-${hunks.length + 1}-${createHash('sha256')
      .update(`${current.filePath}\n${current.header}\n${current.lines.join('\n')}`)
      .digest('hex')
      .slice(0, 12)}`;
    hunks.push({
      hunkId,
      filePath: current.filePath,
      header: current.header,
      patch: `${fileHeader.join('\n')}\n${current.header}\n${current.lines.join('\n')}\n`,
      ...parsed,
    });
    current = undefined;
  };
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      filePath = match?.[2] ?? undefined;
      fileHeader = [line];
      continue;
    }
    if (filePath && (line.startsWith('--- ') || line.startsWith('+++ '))) {
      fileHeader.push(line);
      continue;
    }
    if (filePath && line.startsWith('@@ ')) {
      flush();
      current = { header: line, lines: [], filePath };
      continue;
    }
    if (filePath && !current) {
      fileHeader.push(line);
      continue;
    }
    if (current) current.lines.push(line);
  }
  flush();
  return hunks;
}

function editorParts(value: string): { command: string; args: string[] } {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  return { command: parts[0] ?? '', args: parts.slice(1) };
}

function testCommandAllowed(command: string): boolean {
  const basename = command.split('/').at(-1) ?? command;
  return new Set([
    'cargo',
    'bash',
    'git',
    'node',
    'npm',
    'pnpm',
    'python',
    'python3',
    'pytest',
    'pip',
    'pip3',
    'uv',
    'yarn',
  ]).has(basename);
}

function normalizeRelativePath(value: string, label = 'File path'): string {
  const normalized = value.trim().replaceAll('\\', '/').replace(/^\/+/, '');
  if (
    !normalized ||
    normalized.includes('\0') ||
    isAbsolute(value) ||
    normalized.split('/').some((segment) => segment === '..' || segment.length === 0)
  ) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} must stay inside the repository`);
  }
  return normalized;
}

function isInside(rootPath: string, targetPath: string): boolean {
  const targetRelative = relative(rootPath, targetPath);
  return !(
    targetRelative.startsWith(`..${sep}`) ||
    targetRelative === '..' ||
    isAbsolute(targetRelative)
  );
}

function dependencyKind(path: string): LocalChangeSetChange['dependencyKind'] | undefined {
  const name = basename(path).toLowerCase();
  if (
    name === 'package.json' ||
    name === 'pyproject.toml' ||
    name === 'setup.py' ||
    name === 'requirements.txt' ||
    name === 'cargo.toml' ||
    name === 'go.mod' ||
    name === 'pom.xml'
  ) {
    return 'manifest';
  }
  if (
    name === 'package-lock.json' ||
    name === 'pnpm-lock.yaml' ||
    name === 'yarn.lock' ||
    name === 'poetry.lock' ||
    name === 'cargo.lock' ||
    name === 'go.sum' ||
    name === 'composer.lock'
  ) {
    return 'lockfile';
  }
  return undefined;
}

function classifyChange(
  path: string,
  status: Exclude<LocalChangeSetChange['status'], 'dependency'>,
): LocalChangeSetChange {
  const dependency = dependencyKind(path);
  return dependency === undefined
    ? { path, status }
    : { path, status: 'dependency', dependencyKind: dependency };
}

function fileOperationSubject(operation: LocalRepositoryFileOperation): string {
  switch (operation.operation) {
    case 'created':
      return `Created ${operation.path}`;
    case 'modified':
      return `Modified ${operation.path}`;
    case 'moved':
      return `Moved ${operation.from ?? operation.path} to ${operation.to ?? operation.path}`;
    case 'deleted':
      return `Deleted ${operation.path}`;
  }
}

function parseStatus(output: string): Omit<LocalRepositoryStatus, 'repositoryId' | 'checkedAt'> {
  const lines = output.split(/\r?\n/).filter(Boolean);
  const branchLine = lines[0]?.startsWith('## ') ? (lines.shift()?.slice(3) ?? '') : '';
  const branchMatch = /^([^.]+)(?:\.\.\S+)?(?: \[(.+)\])?$/.exec(branchLine);
  const branch = (branchMatch?.[1] ?? branchLine) || 'HEAD';
  const tracking = branchMatch?.[2] ?? '';
  const ahead = Number.parseInt(/ahead (\d+)/.exec(tracking)?.[1] ?? '0', 10) || 0;
  const behind = Number.parseInt(/behind (\d+)/.exec(tracking)?.[1] ?? '0', 10) || 0;
  let stagedFiles = 0;
  let unstagedFiles = 0;
  for (const line of lines) {
    if (line.length < 2) continue;
    if (line[0] !== ' ' && line[0] !== '?') stagedFiles += 1;
    if (line[1] !== ' ') unstagedFiles += 1;
  }
  const changedFiles = lines.length;
  return {
    branch,
    ...(branchLine.includes('...') ? {} : {}),
    ahead,
    behind,
    changedFiles,
    stagedFiles,
    unstagedFiles,
    clean: changedFiles === 0,
  };
}

export interface LocalRepositoryRuntimeOptions {
  readonly rootPath: string;
  readonly gitCommand?: string;
  readonly clock?: () => string;
  readonly providerActions?: ProviderActionRuntime;
  readonly testCommands?: readonly string[];
  readonly pythonExecutable?: string;
  readonly runtimeProfiles?: Pick<RuntimeProfileRuntime, 'getProfile' | 'listRevisions'>;
}

/**
 * A bounded local Git adapter. It only operates on explicitly registered repositories and creates
 * worktrees inside the workspace-managed worktree directory.
 */
export class LocalRepositoryRuntime implements RepositoryRuntime {
  private readonly statePath: string;
  private readonly gitCommand: string;
  private readonly pythonExecutable: string;
  private readonly clock: () => string;
  private state: RepositoryState | undefined;
  private loading: Promise<void> | undefined;
  private readonly activeRuns = new Map<string, ChildProcess>();
  private readonly cancelRequested = new Set<string>();

  constructor(private readonly options: LocalRepositoryRuntimeOptions) {
    this.statePath = join(options.rootPath, '.agentic', 'repositories.json');
    this.gitCommand = options.gitCommand ?? process.env['SPYDERBYTE_GIT_BIN'] ?? 'git';
    this.pythonExecutable =
      options.pythonExecutable ?? process.env['SPYDERBYTE_PYTHON_BIN'] ?? 'python3';
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async list(): Promise<readonly LocalRepositoryRecord[]> {
    await this.ensureLoaded();
    return structuredClone(this.state?.repositories ?? []);
  }

  async register(input: {
    path: string;
    name?: string;
    remoteUrl?: string;
    kind?: LocalRepositoryKind;
  }): Promise<LocalRepositoryRecord> {
    await this.ensureLoaded();
    const path = resolve(input.path);
    if (!isAbsolute(path))
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Repository path is invalid');
    let canonicalPath: string;
    let kind: LocalRepositoryKind;
    try {
      const topLevel = outputText(await this.git(['rev-parse', '--show-toplevel'], path)).trim();
      if (!topLevel) throw new Error('not a Git repository');
      canonicalPath = resolve(topLevel);
      kind = 'git';
    } catch (error) {
      if (input.kind === 'git') {
        throw runtimeError('VALIDATION_INVALID_INPUT', 'Path is not a Git repository');
      }
      try {
        const canonical = await realpath(path);
        const details = await stat(canonical);
        if (!details.isDirectory()) throw new Error('not a directory');
        canonicalPath = canonical;
        kind = 'directory';
      } catch {
        throw runtimeError(
          'VALIDATION_INVALID_INPUT',
          error instanceof Error && error.message.includes('not a Git repository')
            ? 'Path is not a Git repository or local project directory'
            : 'Project path must be an existing directory',
        );
      }
    }
    if (input.kind !== undefined && input.kind !== kind) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        `Path does not match requested project kind ${input.kind}`,
      );
    }
    const existing = this.state?.repositories.find((item) => item.path === canonicalPath);
    if (existing) return structuredClone(existing);
    const now = this.clock();
    let remote = input.remoteUrl?.trim() ?? '';
    if (!remote && kind === 'git') {
      try {
        remote = outputText(
          await this.git(['config', '--get', 'remote.origin.url'], canonicalPath),
        ).trim();
      } catch {
        remote = '';
      }
    }
    const record: LocalRepositoryRecord = {
      repositoryId: randomUUID(),
      name: input.name?.trim() || basename(canonicalPath),
      path: canonicalPath,
      kind,
      ...(remote ? { remoteUrl: remote } : {}),
      registeredAt: now,
      updatedAt: now,
    };
    this.state?.repositories.push(record);
    await this.persist();
    return structuredClone(record);
  }

  async status(repositoryId: string): Promise<LocalRepositoryStatus> {
    const repository = await this.repository(repositoryId);
    if (repository.kind === 'directory') {
      await this.ensureLoaded();
      const changedPaths = new Set(
        (this.state?.fileOperations ?? [])
          .filter((operation) => operation.repositoryId === repositoryId)
          .flatMap((operation) => [operation.path, operation.from, operation.to])
          .filter((value): value is string => value !== undefined),
      );
      return {
        repositoryId,
        branch: 'directory',
        ahead: 0,
        behind: 0,
        changedFiles: changedPaths.size,
        stagedFiles: 0,
        unstagedFiles: changedPaths.size,
        clean: changedPaths.size === 0,
        checkedAt: this.clock(),
      };
    }
    const statusOutput = outputText(
      await this.git(['status', '--porcelain=v1', '--branch'], repository.path),
    );
    const parsed = parseStatus(statusOutput);
    const head = outputText(await this.git(['rev-parse', 'HEAD'], repository.path)).trim();
    return {
      repositoryId,
      ...parsed,
      ...(head ? { head } : {}),
      checkedAt: this.clock(),
    };
  }

  async diff(repositoryId: string): Promise<LocalRepositoryDiff> {
    const repository = await this.repository(repositoryId);
    const content =
      repository.kind === 'git'
        ? await this.reviewDiffContent(repository.path)
        : await this.directoryOperationDiff(repositoryId);
    const bounded = boundedOutput(content);
    return {
      repositoryId,
      content: bounded.content,
      contentHash: `sha256:${createHash('sha256').update(bounded.content).digest('hex')}`,
      truncated: bounded.truncated,
      generatedAt: this.clock(),
    };
  }

  async listFiles(repositoryId: string, prefix = ''): Promise<readonly LocalRepositoryFile[]> {
    const repository = await this.repository(repositoryId);
    const normalizedPrefix = prefix.trim() ? normalizeRelativePath(prefix, 'File prefix') : '';
    return this.walkProjectTree(repository, normalizedPrefix);
  }

  async readFile(repositoryId: string, path: string): Promise<LocalRepositoryFileContent> {
    const repository = await this.repository(repositoryId);
    const normalized = normalizeRelativePath(path);
    const { target, targetRelative } = await this.safeExistingPath(repository, normalized);
    const details = await stat(target);
    if (!details.isFile()) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Only regular files can be previewed');
    }
    if (details.size > MAX_FILE_BYTES) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'File preview is limited to 1 MiB');
    }
    const content = await readFile(target, 'utf8');
    return {
      path: targetRelative.replaceAll(sep, '/'),
      content,
      encoding: 'utf-8',
      sizeBytes: details.size,
      truncated: false,
    };
  }

  async search(
    repositoryId: string,
    query: string,
    prefix = '',
  ): Promise<readonly LocalRepositorySearchMatch[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery || normalizedQuery.length > 500) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'Search query must be between 1 and 500 characters',
      );
    }
    const files = await this.listFiles(repositoryId, prefix);
    const matches: LocalRepositorySearchMatch[] = [];
    for (const file of files) {
      if (file.kind !== 'file' || matches.length >= MAX_SEARCH_RESULTS) continue;
      try {
        const preview = await this.readFile(repositoryId, file.path);
        if (preview.content.includes('\0')) continue;
        for (const [lineIndex, line] of preview.content.split(/\r?\n/).entries()) {
          let offset = line.indexOf(normalizedQuery);
          while (offset >= 0 && matches.length < MAX_SEARCH_RESULTS) {
            matches.push({
              path: file.path,
              line: lineIndex + 1,
              column: offset + 1,
              snippet: line.slice(
                Math.max(0, offset - 80),
                Math.min(line.length, offset + normalizedQuery.length + 80),
              ),
            });
            offset = line.indexOf(normalizedQuery, offset + normalizedQuery.length);
          }
          if (matches.length >= MAX_SEARCH_RESULTS) break;
        }
      } catch {
        // Binary, oversized, or concurrently removed files are not searchable previews.
      }
    }
    return matches;
  }

  async history(
    repositoryId: string,
    path?: string,
  ): Promise<readonly LocalRepositoryHistoryEntry[]> {
    const repository = await this.repository(repositoryId);
    const normalizedPath =
      path === undefined || path.trim() === '' ? undefined : normalizeRelativePath(path);
    if (repository.kind === 'git') {
      const args = ['log', '--max-count=100', '--format=%H%x00%an%x00%aI%x00%s'];
      if (normalizedPath !== undefined) args.push('--follow', '--', normalizedPath);
      const output = outputText(await this.git(args, repository.path));
      return output
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const [revision, author, authoredAt, ...subjectParts] = line.split('\0');
          return {
            historyId: revision ?? randomUUID(),
            path: normalizedPath ?? '',
            kind: 'commit' as const,
            ...(revision === undefined ? {} : { revision }),
            ...(author === undefined ? {} : { author }),
            authoredAt: authoredAt ?? this.clock(),
            subject: subjectParts.join('\0'),
          };
        });
    }
    await this.ensureLoaded();
    return (this.state?.fileOperations ?? [])
      .filter(
        (operation) =>
          operation.repositoryId === repositoryId &&
          (normalizedPath === undefined ||
            operation.path === normalizedPath ||
            operation.from === normalizedPath ||
            operation.to === normalizedPath),
      )
      .slice(-100)
      .reverse()
      .map((operation) => ({
        historyId: operation.operationId,
        path: normalizedPath ?? operation.path,
        kind: 'file-operation' as const,
        authoredAt: operation.occurredAt,
        subject: fileOperationSubject(operation),
        operationId: operation.operationId,
      }));
  }

  async writeFile(input: {
    repositoryId: string;
    path: string;
    content: string;
    origin: LocalFileOrigin;
    artifactId?: string;
  }): Promise<LocalRepositoryFileWriteResult> {
    const repository = await this.repository(input.repositoryId);
    const normalized = normalizeRelativePath(input.path);
    if (input.content.length > MAX_FILE_BYTES) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'File writes are limited to 1 MiB');
    }
    if (input.artifactId !== undefined && !/^sha256:[a-f0-9]{64}$/.test(input.artifactId)) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'artifactId must be a content hash');
    }
    const target = await this.safeWritePath(repository, normalized);
    let operation: LocalRepositoryFileWriteResult['operation'] = 'created';
    try {
      const existing = await lstat(target);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw runtimeError('POLICY_DENIED', 'Only regular files can be replaced');
      }
      operation = 'modified';
    } catch (error) {
      if (error instanceof Error && 'code' in error && String(error.code) === 'ENOENT') {
        operation = 'created';
      } else if (error instanceof Error && error.name === 'RuntimeError') {
        throw error;
      } else {
        throw runtimeError('COMPUTE_RESOURCE_UNAVAILABLE', 'Unable to inspect the target file');
      }
    }
    const temporary = join(dirname(target), `.spyderbyte-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, input.content, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, target);
    } finally {
      try {
        await unlink(temporary);
      } catch {
        // The atomic rename already removed the temporary path.
      }
    }
    const contentHash = `sha256:${createHash('sha256').update(input.content).digest('hex')}`;
    const operationId = randomUUID();
    await this.recordFileOperation({
      operationId,
      repositoryId: input.repositoryId,
      operation,
      path: normalized,
      origin: input.origin,
      ...(input.artifactId === undefined ? {} : { artifactId: input.artifactId }),
      contentHash,
      occurredAt: this.clock(),
    });
    const inspectableChangeSet =
      input.origin === 'manual' ? undefined : await this.createChangeSet(input.repositoryId);
    return {
      repositoryId: input.repositoryId,
      path: normalized,
      operationId,
      operation,
      origin: input.origin,
      ...(input.artifactId === undefined ? {} : { artifactId: input.artifactId }),
      ...(inspectableChangeSet === undefined
        ? {}
        : { changeSetId: inspectableChangeSet.changeSetId }),
      contentHash,
      sizeBytes: Buffer.byteLength(input.content, 'utf8'),
      writtenAt: this.clock(),
    };
  }

  async moveFile(input: {
    repositoryId: string;
    from: string;
    to: string;
  }): Promise<LocalRepositoryFileMoveResult> {
    const repository = await this.repository(input.repositoryId);
    const from = normalizeRelativePath(input.from, 'Source path');
    const to = normalizeRelativePath(input.to, 'Destination path');
    if (from === to)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Source and destination must differ');
    const source = await this.safeExistingPath(repository, from);
    const sourceDetails = await lstat(source.target);
    if (!sourceDetails.isFile() || sourceDetails.isSymbolicLink()) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Only regular files can be moved');
    }
    const destination = await this.safeWritePath(repository, to);
    try {
      await lstat(destination);
      throw runtimeError('CONCURRENCY_STALE_VERSION', 'Destination file already exists');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && String(error.code) === 'ENOENT'))
        throw error;
    }
    await rename(source.target, destination);
    const operationId = randomUUID();
    await this.recordFileOperation({
      operationId,
      repositoryId: input.repositoryId,
      operation: 'moved',
      path: to,
      from,
      to,
      occurredAt: this.clock(),
    });
    return {
      repositoryId: input.repositoryId,
      operationId,
      from,
      to,
      movedAt: this.clock(),
    };
  }

  async deleteFile(input: {
    repositoryId: string;
    path: string;
  }): Promise<LocalRepositoryFileDeleteResult> {
    const repository = await this.repository(input.repositoryId);
    const normalized = normalizeRelativePath(input.path);
    const target = await this.safeExistingPath(repository, normalized);
    const details = await lstat(target.target);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Only regular files can be deleted');
    }
    await unlink(target.target);
    const operationId = randomUUID();
    await this.recordFileOperation({
      operationId,
      repositoryId: input.repositoryId,
      operation: 'deleted',
      path: normalized,
      occurredAt: this.clock(),
    });
    return {
      repositoryId: input.repositoryId,
      operationId,
      path: normalized,
      deletedAt: this.clock(),
    };
  }

  async resolveEditor(): Promise<LocalEditorResolution> {
    await this.ensureLoaded();
    const candidates: Array<{
      value: string | undefined;
      source: LocalEditorResolution['source'];
    }> = [
      {
        value: this.state?.editorSetting ?? process.env['SPYDERBYTE_EDITOR'],
        source: 'spyderbyte-setting',
      },
      { value: process.env['VISUAL'], source: 'VISUAL' },
      { value: process.env['EDITOR'], source: 'EDITOR' },
    ];
    const selected = candidates.find((candidate) => candidate.value?.trim());
    const fallback =
      process.platform === 'darwin'
        ? { command: 'open', args: [] }
        : { command: 'xdg-open', args: [] };
    let parts = selected ? editorParts(selected.value ?? '') : undefined;
    let source: LocalEditorResolution['source'] = selected?.source ?? 'detected-editor';
    if (parts?.command === '') parts = undefined;
    if (parts === undefined) {
      const detected = await this.detectEditor();
      if (detected !== undefined) {
        parts = detected;
        source = 'detected-editor';
      } else {
        parts = fallback;
        source = 'platform-default';
      }
    }
    const available = await this.commandAvailable(parts.command);
    return {
      command: parts.command,
      args: parts.args,
      source,
      available,
    };
  }

  async setEditorSetting(value: string | undefined): Promise<LocalEditorResolution> {
    await this.ensureLoaded();
    const trimmed = value?.trim();
    if (
      trimmed !== undefined &&
      (trimmed.length === 0 || trimmed.length > 500 || trimmed.includes('\0'))
    ) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Editor setting is invalid');
    }
    if (trimmed === undefined || trimmed.length === 0) delete this.state?.editorSetting;
    else if (this.state !== undefined) this.state.editorSetting = trimmed;
    await this.persist();
    return this.resolveEditor();
  }

  async createChangeSet(repositoryId: string): Promise<LocalChangeSet> {
    const repository = await this.repository(repositoryId);
    const [diff, status, changes] = await Promise.all([
      this.diff(repositoryId),
      this.status(repositoryId),
      this.changesForRepository(repository),
    ]);
    const now = this.clock();
    const changeSet: LocalChangeSet = {
      changeSetId: randomUUID(),
      repositoryId,
      ...(status.head === undefined ? {} : { baseHead: status.head }),
      diffHash: diff.contentHash,
      changes,
      hunks: parseDiffHunks(diff.content),
      acceptedHunkIds: [],
      state: 'draft',
      createdAt: now,
      updatedAt: now,
    };
    await this.ensureLoaded();
    this.state?.changeSets.push(changeSet);
    await this.persist();
    return structuredClone(changeSet);
  }

  async refreshChangeSet(changeSetId: string): Promise<LocalChangeSet> {
    await this.ensureLoaded();
    const changeSet = this.state?.changeSets.find((item) => item.changeSetId === changeSetId);
    if (changeSet === undefined) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Change set was not found');
    }
    const repository = await this.repository(changeSet.repositoryId);
    const [diff, status, changes] = await Promise.all([
      this.diff(changeSet.repositoryId),
      this.status(changeSet.repositoryId),
      this.changesForRepository(repository),
    ]);
    const { baseHead, ...changeSetWithoutBaseHead } = changeSet;
    void baseHead;
    const updated: LocalChangeSet = {
      ...changeSetWithoutBaseHead,
      ...(status.head === undefined ? {} : { baseHead: status.head }),
      diffHash: diff.contentHash,
      changes,
      hunks: parseDiffHunks(diff.content),
      acceptedHunkIds: [],
      state: 'draft',
      updatedAt: this.clock(),
    };
    const state = this.state;
    if (state === undefined) throw new Error('Repository state was not initialized');
    const index = state.changeSets.findIndex((item) => item.changeSetId === changeSetId);
    state.changeSets.splice(index, 1, updated);
    await this.persist();
    return structuredClone(updated);
  }

  async getChangeSet(changeSetId: string): Promise<LocalChangeSet | undefined> {
    await this.ensureLoaded();
    const changeSet = this.state?.changeSets.find((item) => item.changeSetId === changeSetId);
    return changeSet === undefined ? undefined : structuredClone(changeSet);
  }

  async applyChangeSetHunks(input: {
    changeSetId: string;
    hunkIds: readonly string[];
    action: 'accept' | 'revert';
  }): Promise<LocalChangeSetApplyResult> {
    await this.ensureLoaded();
    const changeSet = this.state?.changeSets.find((item) => item.changeSetId === input.changeSetId);
    if (!changeSet) throw runtimeError('VALIDATION_INVALID_INPUT', 'Change set was not found');
    if (input.hunkIds.length === 0)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'At least one hunk must be selected');
    const selected = input.hunkIds.map((hunkId) => {
      const hunk = changeSet.hunks.find((item) => item.hunkId === hunkId);
      if (!hunk) throw runtimeError('VALIDATION_INVALID_INPUT', `Hunk ${hunkId} was not found`);
      return hunk;
    });
    const acceptedHunkIds = new Set(changeSet.acceptedHunkIds ?? []);
    if (input.action === 'accept') {
      const duplicate = selected.find((hunk) => acceptedHunkIds.has(hunk.hunkId));
      if (duplicate) {
        throw runtimeError(
          'CONCURRENCY_STALE_VERSION',
          `Hunk ${duplicate.hunkId} has already been accepted in this change set`,
        );
      }
    }
    const currentHead = (await this.status(changeSet.repositoryId)).head;
    if (changeSet.baseHead !== undefined && currentHead !== changeSet.baseHead) {
      throw runtimeError(
        'CONCURRENCY_STALE_VERSION',
        'Repository HEAD changed since this change set was reviewed',
      );
    }
    const repository = await this.repository(changeSet.repositoryId);
    const patchPath = join(
      this.options.rootPath,
      '.agentic',
      'change-sets',
      `${changeSet.changeSetId}.patch`,
    );
    await mkdir(dirname(patchPath), { recursive: true, mode: 0o700 });
    await writeFile(patchPath, selected.map((hunk) => hunk.patch).join(''), { mode: 0o600 });
    try {
      if (input.action === 'accept') {
        await this.git(['apply', '--cached', patchPath], repository.path);
        for (const hunk of selected) acceptedHunkIds.add(hunk.hunkId);
      } else {
        // Accepted hunks are staged; remove them from the index first, then discard the
        // working-tree copy. For an unstaged hunk the cached reverse is expected to fail.
        try {
          await this.git(['apply', '--cached', '--reverse', patchPath], repository.path);
        } catch {
          // The hunk was not staged; the working-tree reverse below is sufficient.
        }
        await this.git(['apply', '--reverse', patchPath], repository.path);
        for (const hunk of selected) acceptedHunkIds.delete(hunk.hunkId);
      }
    } finally {
      try {
        const { unlink } = await import('node:fs/promises');
        await unlink(patchPath);
      } catch {
        // Temporary review patches are best-effort cleaned; they contain no credentials.
      }
    }
    const applied = new Set(input.hunkIds);
    const nextState =
      acceptedHunkIds.size === changeSet.hunks.length
        ? 'accepted'
        : acceptedHunkIds.size === 0
          ? input.action === 'revert'
            ? 'reverted'
            : 'draft'
          : 'partially_accepted';
    const updated: LocalChangeSet = {
      ...changeSet,
      acceptedHunkIds: [...acceptedHunkIds],
      state: nextState,
      updatedAt: this.clock(),
    };
    const repositoryState = this.state;
    if (repositoryState === undefined) throw new Error('Repository state was not initialized');
    const changeSetIndex = repositoryState.changeSets.findIndex(
      (item) => item.changeSetId === updated.changeSetId,
    );
    if (changeSetIndex >= 0) repositoryState.changeSets.splice(changeSetIndex, 1, updated);
    await this.persist();
    return {
      changeSet: structuredClone(updated),
      appliedHunkIds: [...applied],
      action: input.action,
    };
  }

  async runTest(input: {
    repositoryId: string;
    command: string;
    args?: readonly string[];
    timeoutMs?: number;
    runtime?: LocalRepositoryRunRuntime;
    environmentRevisionId?: string;
  }): Promise<LocalRepositoryTestResult> {
    const repository = await this.repository(input.repositoryId);
    const command = input.command.trim();
    const configured = this.options.testCommands ?? [];
    const allowed =
      configured.length > 0 ? configured.includes(command) : testCommandAllowed(command);
    if (!allowed)
      throw runtimeError(
        'POLICY_DENIED',
        `Test command ${command} is not allowed by the local policy`,
      );
    const args = [...(input.args ?? [])];
    if (args.some((arg) => arg.includes('\0'))) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Test arguments cannot contain NUL bytes');
    }
    const timeoutMs = Math.max(
      1_000,
      Math.min(input.timeoutMs ?? MAX_TEST_TIMEOUT_MS, MAX_TEST_TIMEOUT_MS),
    );
    const runId = randomUUID();
    const startedAt = this.clock();
    const codeRevision = await this.codeRevision(repository);
    const runtime =
      input.runtime ??
      (/^(?:python|python3|.*\/python|.*\/python3)$/.test(command)
        ? 'local-python'
        : 'local-command');
    const running: LocalRepositoryRun = {
      runId,
      repositoryId: input.repositoryId,
      status: 'running',
      codeRevision,
      ...(input.environmentRevisionId === undefined
        ? {}
        : { environmentRevision: input.environmentRevisionId }),
      runtime,
      inputs: { command, args },
      logs: { output: '', truncated: false },
      metrics: { durationMs: 0 },
      outputs: [{ kind: 'command', status: 'running' }],
      artifacts: [],
      startedAt,
    };
    await this.ensureLoaded();
    this.state?.runs.push(running);
    await this.persist();
    const execution = await this.executeBounded(runId, command, args, repository.path, timeoutMs);
    const completedAt = this.clock();
    const durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
    const completed: LocalRepositoryRun = {
      ...running,
      status: execution.status,
      logs: { output: execution.output, truncated: execution.truncated },
      metrics: {
        durationMs,
        ...(execution.exitCode === undefined ? {} : { exitCode: execution.exitCode }),
      },
      outputs: [
        {
          kind: 'command',
          status: execution.status,
          ...(execution.exitCode === undefined ? {} : { exitCode: execution.exitCode }),
        },
      ],
      ...(execution.error === undefined ? {} : { error: execution.error }),
      completedAt,
    };
    const runIndex = this.state?.runs.findIndex((item) => item.runId === runId) ?? -1;
    if (this.state !== undefined && runIndex >= 0) this.state.runs.splice(runIndex, 1, completed);
    await this.persist();
    return {
      repositoryId: input.repositoryId,
      command,
      args,
      status: execution.status,
      ...(execution.exitCode === undefined ? {} : { exitCode: execution.exitCode }),
      output: execution.output,
      truncated: execution.truncated,
      startedAt,
      completedAt,
      runId,
      codeRevision,
      ...(input.environmentRevisionId === undefined
        ? {}
        : { environmentRevision: input.environmentRevisionId }),
      runtime,
      metrics: completed.metrics,
      artifacts: [],
    };
  }

  async runPython(input: {
    repositoryId: string;
    source: string;
    args?: readonly string[];
    runtimeProfileId?: string;
    environmentRevisionId?: string;
    timeoutMs?: number;
  }): Promise<LocalRepositoryTestResult> {
    if (!input.source || input.source.length > 128 * 1024 || input.source.includes('\0')) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Python source must be between 1 and 128 KiB');
    }
    const args = [...(input.args ?? [])];
    if (args.some((arg) => arg.includes('\0'))) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Python arguments cannot contain NUL bytes');
    }
    let executable = this.pythonExecutable;
    if (input.runtimeProfileId !== undefined) {
      const profiles = this.options.runtimeProfiles;
      if (profiles === undefined) {
        throw runtimeError('CAPABILITY_UNAVAILABLE', 'Managed runtime profiles are not configured');
      }
      const profile = await profiles.getProfile(input.runtimeProfileId);
      if (profile === undefined || profile.kind !== 'python') {
        throw runtimeError(
          'VALIDATION_INVALID_INPUT',
          'The selected runtime profile is not a Python profile',
        );
      }
      executable = profile.executable;
      if (input.environmentRevisionId !== undefined) {
        const revisions = await profiles.listRevisions(input.runtimeProfileId);
        if (!revisions.some((revision) => revision.revisionId === input.environmentRevisionId)) {
          throw runtimeError(
            'VALIDATION_INVALID_INPUT',
            'Environment revision does not belong to the selected runtime profile',
          );
        }
      }
    }
    return this.runTest({
      repositoryId: input.repositoryId,
      command: executable,
      args: ['-c', input.source, ...args],
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.runtimeProfileId === undefined
        ? { runtime: 'local-python' as const }
        : { runtime: 'managed-python' as const }),
      ...(input.environmentRevisionId === undefined
        ? {}
        : { environmentRevisionId: input.environmentRevisionId }),
    });
  }

  async installDependencies(input: {
    repositoryId: string;
    command: string;
    args?: readonly string[];
    timeoutMs?: number;
  }): Promise<LocalRepositoryTestResult> {
    const command = input.command.trim();
    const executable = command.split('/').at(-1) ?? command;
    if (!new Set(['npm', 'pnpm', 'yarn', 'pip', 'pip3', 'uv', 'cargo']).has(executable)) {
      throw runtimeError('POLICY_DENIED', `Dependency command ${command} is not allowed`);
    }
    return this.runTest({
      repositoryId: input.repositoryId,
      command,
      ...(input.args === undefined ? {} : { args: input.args }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      runtime: 'dependency-install',
    });
  }

  async listRuns(repositoryId?: string): Promise<readonly LocalRepositoryRun[]> {
    await this.ensureLoaded();
    return structuredClone(
      (this.state?.runs ?? [])
        .filter((run) => repositoryId === undefined || run.repositoryId === repositoryId)
        .reverse(),
    );
  }

  async getRun(runId: string): Promise<LocalRepositoryRun | undefined> {
    await this.ensureLoaded();
    const run = this.state?.runs.find((item) => item.runId === runId);
    return run === undefined ? undefined : structuredClone(run);
  }

  async cancelRun(runId: string): Promise<LocalRepositoryRun> {
    await this.ensureLoaded();
    const run = this.state?.runs.find((item) => item.runId === runId);
    if (run === undefined)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Repository run was not found');
    if (run.status === 'running') {
      this.cancelRequested.add(runId);
      this.activeRuns.get(runId)?.kill('SIGTERM');
      if (!this.activeRuns.has(runId)) {
        const cancelled: LocalRepositoryRun = {
          ...run,
          status: 'cancelled',
          completedAt: this.clock(),
          error: 'Repository run was cancelled before execution completed',
          outputs: [{ kind: 'command', status: 'cancelled' }],
        };
        const state = this.state;
        if (state === undefined) throw new Error('Repository state was not initialized');
        const index = state.runs.findIndex((item) => item.runId === runId);
        state.runs.splice(index, 1, cancelled);
        await this.persist();
        return structuredClone(cancelled);
      }
    }
    const state = this.state;
    if (state === undefined) throw new Error('Repository state was not initialized');
    return structuredClone(state.runs.find((item) => item.runId === runId) ?? run);
  }

  async check(repositoryId: string): Promise<LocalRepositoryCheck> {
    const repository = await this.repository(repositoryId);
    try {
      await this.git(['diff', '--check'], repository.path);
      return {
        repositoryId,
        name: 'git-diff-check',
        status: 'passed',
        output: 'git diff --check passed',
        checkedAt: this.clock(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        repositoryId,
        name: 'git-diff-check',
        status: 'failed',
        output: message.slice(0, 16_000),
        checkedAt: this.clock(),
      };
    }
  }

  async listWorktrees(repositoryId?: string): Promise<readonly LocalWorktreeRecord[]> {
    await this.ensureLoaded();
    return structuredClone(
      (this.state?.worktrees ?? []).filter(
        (item) => repositoryId === undefined || item.repositoryId === repositoryId,
      ),
    );
  }

  async createWorktree(input: {
    repositoryId: string;
    branch: string;
    base?: string;
  }): Promise<LocalWorktreeRecord> {
    const repository = await this.repository(input.repositoryId);
    const branch = input.branch.trim();
    if (!BRANCH_PATTERN.test(branch) || branch.startsWith('/') || branch.endsWith('/')) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Worktree branch name is invalid');
    }
    const worktreeId = randomUUID();
    const destination = join(this.options.rootPath, '.agentic', 'worktrees', worktreeId);
    await mkdir(dirname(destination), { recursive: true });
    const exists = await this.branchExists(repository.path, branch);
    const args = exists
      ? ['worktree', 'add', destination, branch]
      : ['worktree', 'add', '-b', branch, destination, input.base?.trim() || 'HEAD'];
    await this.git(args, repository.path);
    const record: LocalWorktreeRecord = {
      worktreeId,
      repositoryId: input.repositoryId,
      path: normalize(destination),
      branch,
      createdAt: this.clock(),
    };
    await this.ensureLoaded();
    this.state?.worktrees.push(record);
    await this.persist();
    return structuredClone(record);
  }

  async commit(repositoryId: string, message: string): Promise<LocalRepositoryCommit> {
    const repository = await this.repository(repositoryId);
    const trimmed = message.trim();
    if (trimmed.length < 1 || trimmed.length > 500) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'Commit message must be between 1 and 500 characters',
      );
    }
    await this.git(['add', '--all'], repository.path);
    await this.git(['commit', '--message', trimmed], repository.path);
    const commit = outputText(await this.git(['rev-parse', 'HEAD'], repository.path)).trim();
    const status = await this.status(repositoryId);
    return {
      repositoryId,
      commit,
      branch: status.branch,
      message: trimmed,
      committedAt: this.clock(),
    };
  }

  async push(
    repositoryId: string,
    input: { remote?: string; branch?: string } = {},
  ): Promise<LocalRepositoryPush> {
    const repository = await this.repository(repositoryId);
    const remote = input.remote?.trim() || 'origin';
    const branch = input.branch?.trim() || (await this.status(repositoryId)).branch;
    if (!/^[A-Za-z0-9._-]+$/.test(remote) || !BRANCH_PATTERN.test(branch)) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Remote or branch is invalid');
    }
    await this.git(['push', '--set-upstream', remote, branch], repository.path);
    return {
      repositoryId,
      remote,
      branch,
      commit: outputText(await this.git(['rev-parse', 'HEAD'], repository.path)).trim(),
      pushedAt: this.clock(),
    };
  }

  async createPullRequest(input: LocalRepositoryPullRequest): Promise<JsonRepositoryActionResult> {
    const actions = this.options.providerActions;
    if (actions === undefined) {
      throw runtimeError(
        'COMPUTE_RESOURCE_UNAVAILABLE',
        'A provider action runtime is not configured',
      );
    }
    const result = await actions.execute({
      providerId: input.provider,
      connectionId: input.connectionId,
      operation: 'createPullRequest',
      input: {
        owner: input.owner,
        repo: input.repo,
        head: input.head,
        base: input.base,
        title: input.title,
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.draft === undefined ? {} : { draft: input.draft }),
      },
    });
    return { output: result.output, completedAt: result.completedAt };
  }

  async mergePullRequest(input: LocalRepositoryMergeRequest): Promise<JsonRepositoryActionResult> {
    const actions = this.options.providerActions;
    if (actions === undefined) {
      throw runtimeError(
        'COMPUTE_RESOURCE_UNAVAILABLE',
        'A provider action runtime is not configured',
      );
    }
    const result = await actions.execute({
      providerId: input.provider,
      connectionId: input.connectionId,
      operation: 'mergePullRequest',
      input: {
        owner: input.owner,
        repo: input.repo,
        number: input.number,
        ...(input.mergeMethod === undefined ? {} : { mergeMethod: input.mergeMethod }),
        ...(input.commitTitle === undefined ? {} : { commitTitle: input.commitTitle }),
        ...(input.commitMessage === undefined ? {} : { commitMessage: input.commitMessage }),
      },
    });
    return { output: result.output, completedAt: result.completedAt };
  }

  private async repository(repositoryId: string): Promise<LocalRepositoryRecord> {
    await this.ensureLoaded();
    const repository = this.state?.repositories.find((item) => item.repositoryId === repositoryId);
    if (!repository)
      throw runtimeError('VALIDATION_INVALID_INPUT', `Repository ${repositoryId} was not found`);
    return repository;
  }

  private async safeExistingPath(
    repository: LocalRepositoryRecord,
    normalized: string,
  ): Promise<{ target: string; targetRelative: string }> {
    const repositoryRoot = await realpath(repository.path);
    const candidate = resolve(repositoryRoot, normalized);
    if (!isInside(repositoryRoot, candidate)) {
      throw runtimeError('POLICY_DENIED', 'File path resolves outside the repository');
    }
    try {
      const candidateDetails = await lstat(candidate);
      if (candidateDetails.isSymbolicLink()) {
        throw runtimeError('POLICY_DENIED', 'Symbolic links are not valid project file targets');
      }
      const target = await realpath(candidate);
      if (!isInside(repositoryRoot, target)) {
        throw runtimeError('POLICY_DENIED', 'File path resolves outside the repository');
      }
      return {
        target,
        targetRelative: relative(repositoryRoot, target).replaceAll(sep, '/'),
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'RuntimeError') throw error;
      throw runtimeError('VALIDATION_INVALID_INPUT', `File ${normalized} was not found`);
    }
  }

  private async safeWritePath(
    repository: LocalRepositoryRecord,
    normalized: string,
  ): Promise<string> {
    const repositoryRoot = await realpath(repository.path);
    const candidate = resolve(repositoryRoot, normalized);
    if (!isInside(repositoryRoot, candidate)) {
      throw runtimeError('POLICY_DENIED', 'File path resolves outside the repository');
    }
    const parent = dirname(candidate);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const resolvedParent = await realpath(parent);
    if (!isInside(repositoryRoot, resolvedParent)) {
      throw runtimeError('POLICY_DENIED', 'File path resolves outside the repository');
    }
    let current = repositoryRoot;
    for (const segment of relative(repositoryRoot, parent).split(sep).filter(Boolean)) {
      current = join(current, segment);
      const details = await lstat(current);
      if (details.isSymbolicLink() || !details.isDirectory()) {
        throw runtimeError('POLICY_DENIED', 'Project path contains an unsafe directory');
      }
    }
    return candidate;
  }

  private async walkProjectTree(
    repository: LocalRepositoryRecord,
    prefix: string,
  ): Promise<readonly LocalRepositoryFile[]> {
    const root = await realpath(repository.path);
    const start = prefix === '' ? root : resolve(root, prefix);
    if (!isInside(root, start))
      throw runtimeError('POLICY_DENIED', 'File prefix resolves outside the repository');
    const startDetails = await lstat(start).catch(() => undefined);
    if (startDetails === undefined)
      throw runtimeError('VALIDATION_INVALID_INPUT', `Path ${prefix} was not found`);
    if (startDetails.isSymbolicLink())
      throw runtimeError('POLICY_DENIED', 'Symbolic links are not project files');
    const files: LocalRepositoryFile[] = [];
    const visit = async (absolutePath: string, projectPath: string): Promise<void> => {
      if (files.length >= MAX_TREE_ENTRIES) return;
      const details = await lstat(absolutePath);
      if (details.isSymbolicLink()) return;
      if (details.isDirectory()) {
        if (projectPath !== '') files.push({ path: projectPath, kind: 'directory' });
        const entries = await readdir(absolutePath, { withFileTypes: true });
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
          if (IGNORED_DIRECTORY_NAMES.has(entry.name)) continue;
          await visit(
            join(absolutePath, entry.name),
            projectPath ? `${projectPath}/${entry.name}` : entry.name,
          );
          if (files.length >= MAX_TREE_ENTRIES) break;
        }
        return;
      }
      if (details.isFile()) {
        files.push({ path: projectPath, kind: 'file' });
      }
    };
    await visit(start, prefix);
    return files.sort((left, right) => left.path.localeCompare(right.path));
  }

  private async recordFileOperation(operation: LocalRepositoryFileOperation): Promise<void> {
    await this.ensureLoaded();
    if (this.state === undefined) throw new Error('Repository state was not initialized');
    this.state.fileOperations.push(operation);
    if (this.state.fileOperations.length > MAX_OPERATION_HISTORY) {
      this.state.fileOperations.splice(0, this.state.fileOperations.length - MAX_OPERATION_HISTORY);
    }
    await this.persist();
  }

  private async directoryOperationDiff(repositoryId: string): Promise<string> {
    await this.ensureLoaded();
    const operations = (this.state?.fileOperations ?? []).filter(
      (operation) => operation.repositoryId === repositoryId,
    );
    return operations.length === 0
      ? ''
      : `${operations.map((operation) => JSON.stringify(operation)).join('\n')}\n`;
  }

  private async changesForRepository(
    repository: LocalRepositoryRecord,
  ): Promise<readonly LocalChangeSetChange[]> {
    if (repository.kind === 'directory') {
      await this.ensureLoaded();
      const changes = new Map<string, LocalChangeSetChange>();
      for (const operation of this.state?.fileOperations ?? []) {
        if (operation.repositoryId !== repository.repositoryId) continue;
        if (operation.operation === 'deleted')
          changes.set(operation.path, classifyChange(operation.path, 'deleted'));
        else if (operation.operation === 'moved') {
          if (operation.from !== undefined)
            changes.set(operation.from, classifyChange(operation.from, 'deleted'));
          changes.set(
            operation.to ?? operation.path,
            classifyChange(operation.to ?? operation.path, 'created'),
          );
        } else {
          changes.set(operation.path, classifyChange(operation.path, operation.operation));
        }
      }
      return [...changes.values()].sort((left, right) => left.path.localeCompare(right.path));
    }
    const changes = new Map<string, LocalChangeSetChange>();
    let namedStatus = '';
    try {
      namedStatus = await this.git(['diff', '--name-status', 'HEAD', '--'], repository.path);
    } catch {
      namedStatus = await this.git(['diff', '--name-status', '--'], repository.path);
    }
    for (const line of namedStatus.split(/\r?\n/).filter(Boolean)) {
      const fields = line.split('\t');
      const status = fields[0] ?? '';
      const paths = fields.slice(1).filter(Boolean);
      if (status.startsWith('R') || status.startsWith('C')) {
        if (paths[0]) changes.set(paths[0], classifyChange(paths[0], 'deleted'));
        if (paths[1]) changes.set(paths[1], classifyChange(paths[1], 'created'));
        continue;
      }
      const path = paths[0];
      if (!path) continue;
      const normalizedStatus =
        status[0] === 'A' ? 'created' : status[0] === 'D' ? 'deleted' : 'modified';
      changes.set(path, classifyChange(path, normalizedStatus));
    }
    const status = outputText(
      await this.git(['status', '--porcelain=v1', '--untracked-files=all'], repository.path),
    );
    for (const line of status.split(/\r?\n/).filter((item) => item.startsWith('?? '))) {
      const path = line.slice(3).trim();
      if (path) changes.set(path, classifyChange(path, 'created'));
    }
    return [...changes.values()].sort((left, right) => left.path.localeCompare(right.path));
  }

  private async codeRevision(repository: LocalRepositoryRecord): Promise<string> {
    if (repository.kind === 'directory') {
      const content = await this.directoryOperationDiff(repository.repositoryId);
      return `working-tree:sha256:${createHash('sha256').update(content).digest('hex')}`;
    }
    let head = 'HEAD';
    try {
      head = outputText(await this.git(['rev-parse', 'HEAD'], repository.path)).trim() || head;
    } catch {
      // An unborn repository still receives a stable working-tree revision below.
    }
    const diff = await this.reviewDiffContent(repository.path);
    return `${head}:sha256:${createHash('sha256').update(diff).digest('hex')}`;
  }

  private async executeBounded(
    runId: string,
    command: string,
    args: readonly string[],
    cwd: string,
    timeoutMs: number,
  ): Promise<{
    status: Exclude<LocalRepositoryRun['status'], 'running'>;
    output: string;
    truncated: boolean;
    exitCode?: number;
    error?: string;
  }> {
    return new Promise((resolveResult) => {
      const child = execFile(
        command,
        [...args],
        { cwd, timeout: timeoutMs, maxBuffer: MAX_TEST_OUTPUT_BYTES * 2 },
        (error, stdout, stderr) => {
          this.activeRuns.delete(runId);
          const value =
            error === null
              ? undefined
              : (error as { code?: number | string; killed?: boolean } & Error);
          const cancelled = this.cancelRequested.delete(runId);
          const status: Exclude<LocalRepositoryRun['status'], 'running'> = cancelled
            ? 'cancelled'
            : value === undefined
              ? 'passed'
              : value.killed
                ? 'timed_out'
                : 'failed';
          const bounded = boundedTestOutput(
            `${stdout ?? ''}${stderr ?? ''}${value === undefined ? '' : `\n${value.message}`}`,
          );
          resolveResult({
            status,
            output: bounded.content,
            truncated: bounded.truncated,
            ...(typeof value?.code === 'number' ? { exitCode: value.code } : {}),
            ...(value === undefined || cancelled ? {} : { error: value.message }),
          });
        },
      );
      this.activeRuns.set(runId, child);
    });
  }

  private async commandAvailable(command: string): Promise<boolean> {
    try {
      if (command.includes('/')) await execFileAsync('test', ['-x', command]);
      else await execFileAsync('which', [command]);
      return true;
    } catch {
      return false;
    }
  }

  private async detectEditor(): Promise<{ command: string; args: string[] } | undefined> {
    for (const candidate of ['code', 'cursor', 'zed', 'subl', 'vim', 'nano']) {
      if (await this.commandAvailable(candidate)) return { command: candidate, args: [] };
    }
    return undefined;
  }

  private async branchExists(repositoryPath: string, branch: string): Promise<boolean> {
    try {
      await this.git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repositoryPath);
      return true;
    } catch {
      return false;
    }
  }

  private async git(args: readonly string[], cwd: string): Promise<string> {
    try {
      const result = await execFileAsync(this.gitCommand, [...args], {
        cwd,
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      return result.stdout;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw runtimeError(
        'COMPUTE_RESOURCE_UNAVAILABLE',
        `Git operation failed: ${message.slice(0, 4000)}`,
      );
    }
  }

  private async reviewDiffContent(repositoryPath: string): Promise<string> {
    const tracked = outputText(
      await this.git(['diff', '--no-ext-diff', '--binary'], repositoryPath),
    );
    let status: string;
    try {
      status = await this.git(
        ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
        repositoryPath,
      );
    } catch {
      status = '';
    }
    const untracked = status
      .split('\0')
      .filter((entry) => entry.startsWith('?? '))
      .map((entry) => entry.slice(3))
      .filter(Boolean);
    const untrackedDiffs = await Promise.all(
      untracked.map(async (filePath) => {
        try {
          await execFileAsync(
            this.gitCommand,
            ['diff', '--no-ext-diff', '--binary', '--no-index', '--', '/dev/null', filePath],
            { cwd: repositoryPath, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
          );
          return '';
        } catch (error) {
          const value = error as { stdout?: string };
          return (value.stdout ?? '').replace(
            /^diff --git a\/\/dev\/null b\/(.+)$/m,
            (_match, filePath: string) => `diff --git a/${filePath} b/${filePath}`,
          );
        }
      }),
    );
    return [tracked, ...untrackedDiffs].filter(Boolean).join('');
  }

  private async ensureLoaded(): Promise<void> {
    if (this.state) return;
    this.loading ??= (async () => {
      try {
        const raw = JSON.parse(await readFile(this.statePath, 'utf8')) as Partial<RepositoryState>;
        this.state = {
          repositories: Array.isArray(raw.repositories)
            ? raw.repositories.map((repository) => ({
                ...repository,
                kind: repository.kind === 'directory' ? 'directory' : 'git',
              }))
            : [],
          worktrees: Array.isArray(raw.worktrees) ? raw.worktrees : [],
          changeSets: Array.isArray(raw.changeSets)
            ? raw.changeSets.map((changeSet) => ({
                ...changeSet,
                acceptedHunkIds: Array.isArray(changeSet.acceptedHunkIds)
                  ? changeSet.acceptedHunkIds
                  : [],
                changes: Array.isArray(changeSet.changes) ? changeSet.changes : [],
              }))
            : [],
          runs: Array.isArray(raw.runs)
            ? raw.runs.map((run) =>
                run.status === 'running'
                  ? {
                      ...run,
                      status: 'failed' as const,
                      completedAt: this.clock(),
                      error: 'Repository run was interrupted before the daemon restarted',
                      outputs: [{ kind: 'command' as const, status: 'failed' as const }],
                    }
                  : run,
              )
            : [],
          fileOperations: Array.isArray(raw.fileOperations) ? raw.fileOperations : [],
          ...(typeof raw.editorSetting === 'string' ? { editorSetting: raw.editorSetting } : {}),
        };
      } catch {
        this.state = emptyState();
      }
    })();
    await this.loading;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    await writeFile(this.statePath, `${JSON.stringify(this.state ?? emptyState(), null, 2)}\n`, {
      mode: 0o600,
    });
  }
}
