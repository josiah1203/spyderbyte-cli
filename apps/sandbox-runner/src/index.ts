import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import {
  runtimeError,
  type ArtifactReference,
  type HashSha256,
  type Id,
  type ResourceLimits,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';

export interface SandboxArtifactMount {
  readonly sourcePath: string;
  readonly targetPath: string;
}

export interface SandboxRequest {
  readonly invocationId: Id;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly limits: ResourceLimits;
  readonly workingRoot?: string;
  readonly mounts?: readonly SandboxArtifactMount[];
  readonly env?: Readonly<Record<string, string>>;
  readonly networkAllowlist: readonly string[];
  readonly preserveWorkspace?: boolean;
}

export interface SandboxResult {
  readonly invocationId: Id;
  readonly status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'output_limited';
  readonly exitCode?: number;
  readonly signal?: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated: boolean;
  readonly workspacePath: string;
  readonly elapsedMs: number;
}

export interface CodingCheck {
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[];
}

export interface CodingArtifactPublicationInput {
  readonly tenant: TenantRef;
  readonly invocationId: Id;
  readonly content: string;
  readonly contentHash: HashSha256;
  readonly mediaType: 'text/x-diff';
  readonly sourceDigest: string;
  readonly resultDigest: string;
  readonly createdAt: string;
}

export interface CodingArtifactPublisher {
  publish(input: CodingArtifactPublicationInput): Promise<ArtifactReference>;
}

export interface CodingTaskRequest {
  readonly invocationId: Id;
  readonly tenant: TenantRef;
  readonly repositoryPath: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly allowedPaths: readonly string[];
  readonly requiredChecks?: readonly CodingCheck[];
  readonly limits: ResourceLimits;
  readonly workingRoot?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly networkAllowlist: readonly string[];
  readonly artifactPublisher: CodingArtifactPublisher;
  readonly createdAt?: string;
  readonly preserveWorkspace?: boolean;
}

export interface CodingCheckResult {
  readonly name: string;
  readonly status: SandboxResult['status'];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode?: number;
}

export interface CodingTaskResult {
  readonly invocationId: Id;
  readonly status: 'succeeded' | 'failed' | 'policy_denied';
  readonly main: SandboxResult;
  readonly checks: readonly CodingCheckResult[];
  readonly changedPaths: readonly string[];
  readonly diff: string;
  readonly sourceDigest: string;
  readonly resultDigest: string;
  readonly findings: readonly string[];
  readonly patchArtifact?: ArtifactReference;
  readonly workspacePath: string;
}

function assertWithin(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (
    resolvedCandidate !== resolvedRoot &&
    !resolvedCandidate.startsWith(`${resolvedRoot}${sep}`)
  ) {
    throw runtimeError('POLICY_DENIED', 'Sandbox path escapes the invocation workspace');
  }
  return resolvedCandidate;
}

function secretLike(key: string): boolean {
  return /(secret|token|password|api[_-]?key|private[_-]?key)/i.test(key);
}

function validateSandboxRequest(request: SandboxRequest): void {
  if (
    request.command.length === 0 ||
    request.limits.wallTimeMs < 1 ||
    request.limits.outputBytes < 1 ||
    request.limits.processCount < 1
  ) {
    throw runtimeError(
      'VALIDATION_INVALID_INPUT',
      'Sandbox command and resource limits are required',
    );
  }
  if (request.networkAllowlist.length > 0) {
    throw runtimeError(
      'POLICY_DENIED',
      'The local sandbox fails closed because network allowlists are not enforceable here',
    );
  }
  if (Object.keys(request.env ?? {}).some(secretLike)) {
    throw runtimeError(
      'SECRET_EXPOSURE_BLOCKED',
      'Secret-like environment keys must be injected by a broker boundary',
    );
  }
}

function inheritedEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !secretLike(key)) environment[key] = value;
  }
  return environment;
}

export async function createInvocationSandbox(
  request: Pick<SandboxRequest, 'invocationId' | 'workingRoot' | 'mounts'>,
): Promise<{ workspacePath: string; cleanup(): Promise<void> }> {
  const root = request.workingRoot ?? join(process.cwd(), '.sandbox');
  await mkdir(root, { recursive: true });
  const workspacePath = await mkdtemp(join(root, `invocation-${request.invocationId}-`));
  try {
    for (const mount of request.mounts ?? []) {
      const target = assertWithin(workspacePath, join(workspacePath, mount.targetPath));
      await cp(mount.sourcePath, target, { recursive: true, force: false });
      await chmod(target, 0o444);
    }
  } catch (error) {
    await rm(workspacePath, { recursive: true, force: true });
    throw error;
  }
  return {
    workspacePath,
    async cleanup() {
      await rm(workspacePath, { recursive: true, force: true });
    },
  };
}

async function runInWorkspace(
  request: SandboxRequest,
  workspacePath: string,
  signal?: AbortSignal,
): Promise<SandboxResult> {
  validateSandboxRequest(request);
  const cwd =
    request.cwd === undefined
      ? workspacePath
      : assertWithin(workspacePath, join(workspacePath, request.cwd));
  const startedAt = Date.now();
  const child = spawn(request.command, [...(request.args ?? [])], {
    cwd,
    env: { ...inheritedEnvironment(), ...(request.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let outputBytes = 0;
  let outputTruncated = false;
  let timedOut = false;
  let cancelled = false;
  let settled = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
    if (outputTruncated) return;
    outputBytes += chunk.byteLength;
    if (outputBytes > request.limits.outputBytes) {
      outputTruncated = true;
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, 50);
      return;
    }
    if (target === 'stdout') stdout += chunk.toString('utf8');
    else stderr += chunk.toString('utf8');
  };
  child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
  child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));
  const abort = (): void => {
    cancelled = true;
    child.kill('SIGTERM');
    forceTimer = setTimeout(() => {
      if (!settled) child.kill('SIGKILL');
    }, 50);
  };
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const deadlineTimer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    forceTimer = setTimeout(() => {
      if (!settled) child.kill('SIGKILL');
    }, 50);
  }, request.limits.wallTimeMs);

  const result = await new Promise<SandboxResult>((resolveResult) => {
    const finish = (exitCode: number | null, childSignal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      const status = cancelled
        ? 'cancelled'
        : timedOut
          ? 'timed_out'
          : outputTruncated
            ? 'output_limited'
            : exitCode === 0
              ? 'succeeded'
              : 'failed';
      resolveResult({
        invocationId: request.invocationId,
        status,
        ...(exitCode !== null ? { exitCode } : {}),
        ...(childSignal !== null ? { signal: childSignal } : {}),
        stdout,
        stderr,
        outputTruncated,
        workspacePath,
        elapsedMs: Date.now() - startedAt,
      });
    };
    child.once('error', () => finish(1, null));
    child.once('close', (exitCode, childSignal) => finish(exitCode, childSignal));
  });
  clearTimeout(deadlineTimer);
  if (forceTimer !== undefined) clearTimeout(forceTimer);
  signal?.removeEventListener('abort', abort);
  return result;
}

export async function runSandboxed(
  request: SandboxRequest,
  signal?: AbortSignal,
): Promise<SandboxResult> {
  validateSandboxRequest(request);
  const sandbox = await createInvocationSandbox(request);
  try {
    return await runInWorkspace(request, sandbox.workspacePath, signal);
  } finally {
    if (!request.preserveWorkspace) await sandbox.cleanup();
  }
}

async function runInExistingSandbox(
  request: Omit<SandboxRequest, 'workingRoot' | 'mounts' | 'preserveWorkspace'> & {
    readonly workspacePath: string;
  },
  signal?: AbortSignal,
): Promise<SandboxResult> {
  return runInWorkspace(request, request.workspacePath, signal);
}

interface SnapshotEntry {
  readonly hash: string;
  readonly sizeBytes: number;
}

const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', '.turbo']);

async function snapshotDirectory(
  root: string,
  directory = root,
): Promise<Map<string, SnapshotEntry>> {
  const snapshot = new Map<string, SnapshotEntry>();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw runtimeError(
        'POLICY_DENIED',
        `Symbolic links are not allowed in coding sandboxes: ${entry.name}`,
      );
    }
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name)) continue;
      for (const [path, value] of await snapshotDirectory(root, absolute))
        snapshot.set(path, value);
      continue;
    }
    if (!entry.isFile()) continue;
    const bytes = await readFile(absolute);
    const path = relative(root, absolute).split(sep).join('/');
    snapshot.set(path, {
      hash: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.byteLength,
    });
  }
  return snapshot;
}

function snapshotDigest(snapshot: ReadonlyMap<string, SnapshotEntry>): string {
  const hash = createHash('sha256');
  for (const [path, entry] of [...snapshot.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    hash.update(`${path}\0${entry.hash}\0${entry.sizeBytes}\n`);
  }
  return hash.digest('hex');
}

function changedPaths(
  before: ReadonlyMap<string, SnapshotEntry>,
  after: ReadonlyMap<string, SnapshotEntry>,
): { paths: string[]; diff: string } {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changed: string[] = [];
  const lines: string[] = [];
  for (const path of paths) {
    const previous = before.get(path);
    const next = after.get(path);
    if (previous?.hash === next?.hash && previous?.sizeBytes === next?.sizeBytes) continue;
    changed.push(path);
    const status = previous === undefined ? 'A' : next === undefined ? 'D' : 'M';
    lines.push(`${status} ${path} ${previous?.hash ?? '-'} -> ${next?.hash ?? '-'}`);
  }
  return { paths: changed, diff: lines.join('\n') };
}

function isAllowedPath(path: string, allowedPaths: readonly string[]): boolean {
  return allowedPaths.some((allowed) => {
    const normalized = allowed.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
    return path === normalized || path.startsWith(`${normalized}/`);
  });
}

async function scanChangedFiles(root: string, paths: readonly string[]): Promise<string[]> {
  const findings: string[] = [];
  const secretPattern =
    /(-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|pk)-[A-Za-z0-9]{16,}|(?:password|secret|token|api[_-]?key)\s*[:=]\s*["'][^"']{8,}["'])/i;
  for (const path of paths) {
    const absolute = join(root, path);
    let content: string;
    try {
      content = await readFile(absolute, 'utf8');
    } catch {
      continue;
    }
    if (secretPattern.test(content)) findings.push(`SECRET_PATTERN:${path}`);
    if (path === 'package.json' || path.endsWith('/package.json')) {
      try {
        const parsed: unknown = JSON.parse(content);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          for (const dependencyGroup of [
            'dependencies',
            'devDependencies',
            'optionalDependencies',
          ]) {
            const dependencies = (parsed as Record<string, unknown>)[dependencyGroup];
            if (
              typeof dependencies !== 'object' ||
              dependencies === null ||
              Array.isArray(dependencies)
            )
              continue;
            for (const [name, version] of Object.entries(dependencies)) {
              if (typeof version === 'string' && /^(?:file:|https?:|git\+|git@)/i.test(version)) {
                findings.push(`UNSAFE_DEPENDENCY:${path}:${name}`);
              }
            }
          }
        }
      } catch {
        findings.push(`PACKAGE_JSON_INVALID:${path}`);
      }
    }
  }
  return findings;
}

export async function runCodingTask(
  request: CodingTaskRequest,
  signal?: AbortSignal,
): Promise<CodingTaskResult> {
  const sandbox = await createInvocationSandbox({
    invocationId: request.invocationId,
    ...(request.workingRoot !== undefined ? { workingRoot: request.workingRoot } : {}),
  });
  const repository = join(sandbox.workspacePath, 'repository');
  try {
    await cp(request.repositoryPath, repository, { recursive: true, force: false });
    const before = await snapshotDirectory(repository);
    const sourceDigest = snapshotDigest(before);
    const mainRequest: Parameters<typeof runInExistingSandbox>[0] = {
      invocationId: request.invocationId,
      workspacePath: sandbox.workspacePath,
      cwd: 'repository',
      command: request.command,
      ...(request.args !== undefined ? { args: request.args } : {}),
      limits: request.limits,
      ...(request.env !== undefined ? { env: request.env } : {}),
      networkAllowlist: request.networkAllowlist,
    };
    const main = await runInExistingSandbox(mainRequest, signal);
    const checks: CodingCheckResult[] = [];
    if (main.status === 'succeeded') {
      for (const check of request.requiredChecks ?? []) {
        const checkRequest: Parameters<typeof runInExistingSandbox>[0] = {
          invocationId: request.invocationId,
          workspacePath: sandbox.workspacePath,
          cwd: 'repository',
          command: check.command,
          ...(check.args !== undefined ? { args: check.args } : {}),
          limits: request.limits,
          ...(request.env !== undefined ? { env: request.env } : {}),
          networkAllowlist: request.networkAllowlist,
        };
        const result = await runInExistingSandbox(checkRequest, signal);
        checks.push({
          name: check.name,
          status: result.status,
          stdout: result.stdout,
          stderr: result.stderr,
          ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
        });
        if (result.status !== 'succeeded') break;
      }
    }
    const after = await snapshotDirectory(repository);
    const changes = changedPaths(before, after);
    const findings = [
      ...changes.paths
        .filter((path) => !isAllowedPath(path, request.allowedPaths))
        .map((path) => `PATH_OUTSIDE_ALLOWLIST:${path}`),
      ...(await scanChangedFiles(repository, changes.paths)),
    ];
    const policyDenied = findings.length > 0;
    const checksPassed = checks.every((check) => check.status === 'succeeded');
    const status = policyDenied
      ? 'policy_denied'
      : main.status === 'succeeded' && checksPassed
        ? 'succeeded'
        : 'failed';
    let patchArtifact: ArtifactReference | undefined;
    if (status === 'succeeded') {
      const patchContentHash = createHash('sha256')
        .update(changes.diff)
        .digest('hex') as HashSha256;
      const published = await request.artifactPublisher.publish({
        tenant: request.tenant,
        invocationId: request.invocationId,
        content: changes.diff,
        contentHash: patchContentHash,
        mediaType: 'text/x-diff',
        sourceDigest,
        resultDigest: snapshotDigest(after),
        createdAt: request.createdAt ?? new Date().toISOString(),
      });
      if (
        published.tenant.tenantId !== request.tenant.tenantId ||
        published.tenant.workspaceId !== request.tenant.workspaceId ||
        published.contentHash !== patchContentHash ||
        published.mediaType !== 'text/x-diff'
      ) {
        throw runtimeError(
          'VALIDATION_SCHEMA_MISMATCH',
          'Coding artifact publisher returned an invalid patch reference',
        );
      }
      patchArtifact = published;
    }
    return {
      invocationId: request.invocationId,
      status,
      main,
      checks,
      changedPaths: changes.paths,
      diff: changes.diff,
      sourceDigest,
      resultDigest: snapshotDigest(after),
      findings,
      ...(patchArtifact === undefined ? {} : { patchArtifact }),
      workspacePath: sandbox.workspacePath,
    };
  } finally {
    if (!request.preserveWorkspace) await sandbox.cleanup();
  }
}
