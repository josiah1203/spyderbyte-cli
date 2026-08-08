import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { execFile } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { runtimeError, type Actor, type TenantRef } from '@agentic-platform/runtime-contracts';
import type { RuntimeProfileRuntime } from './runtime-profiles.js';

const execFileAsync = promisify(execFile);
const DEFAULT_TOKEN_TTL_MS = 15 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export type JupyterSessionState = 'starting' | 'ready' | 'idle' | 'stopping' | 'stopped' | 'failed';

export interface JupyterSessionRequestV1 {
  readonly schemaVersion: 1;
  readonly sessionRequestId: string;
  readonly tenant?: TenantRef;
  readonly projectId?: string;
  readonly notebookId?: string;
  readonly user?: Actor;
  readonly runtimeProfileId?: string;
  readonly environmentRevisionId?: string;
  readonly runtime?: string;
  readonly computeProfile?: string;
  readonly idleTimeoutMs?: number;
  readonly mode: 'local' | 'managed';
  readonly requestedAt: string;
}

export interface JupyterSessionV1 {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly sessionRequestId: string;
  readonly tenant?: TenantRef;
  readonly projectId?: string;
  readonly notebookId?: string;
  readonly user?: Actor;
  readonly profileId?: string;
  readonly runtimeProfileId?: string;
  readonly environmentRevisionId?: string;
  readonly runtime?: string;
  readonly computeProfile?: string;
  readonly endpoint?: string;
  readonly kernelId?: string;
  readonly projectPath: string;
  readonly state: JupyterSessionState;
  readonly serverMode: 'local' | 'managed';
  readonly idleTimeoutMs: number;
  readonly lastActivityAt: string;
  readonly associatedRunIds: readonly string[];
  readonly tokenScopes: readonly string[];
  readonly port?: number;
  readonly accessUrl?: string;
  readonly tokenExpiresAt: string;
  readonly pid?: number;
  readonly error?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface JupyterSessionLaunchResult {
  readonly session: JupyterSessionV1;
  readonly token: string;
  readonly accessUrl: string;
}

export interface ManagedJupyterServerLaunchResult {
  readonly endpoint: string;
  readonly accessUrl?: string;
  readonly kernelId?: string;
  readonly serverId?: string;
}

export interface ManagedJupyterServerAdapter {
  launch(input: {
    sessionId: string;
    notebookId?: string;
    projectId?: string;
    projectPath: string;
    runtimeProfileId?: string;
    environmentRevisionId?: string;
    computeProfile?: string;
    token: string;
  }): Promise<ManagedJupyterServerLaunchResult>;
  stop(input: { session: JupyterSessionV1 }): Promise<void>;
  interrupt?(input: { session: JupyterSessionV1 }): Promise<void>;
  restart?(input: {
    session: JupyterSessionV1;
    token: string;
  }): Promise<ManagedJupyterServerLaunchResult>;
  reconnect?(input: {
    session: JupyterSessionV1;
    token: string;
  }): Promise<ManagedJupyterServerLaunchResult>;
}

export interface JupyterDiscovery {
  readonly executable: string;
  readonly available: boolean;
  readonly version?: string;
  readonly checkedAt: string;
  readonly error?: string;
}

export interface JupyterSessionRuntime {
  discover(): Promise<JupyterDiscovery>;
  list(): Promise<readonly JupyterSessionV1[]>;
  get(sessionId: string): Promise<JupyterSessionV1 | undefined>;
  launch(input: {
    tenant?: TenantRef;
    projectId?: string;
    notebookId?: string;
    user?: Actor;
    profileId?: string;
    runtimeProfileId?: string;
    environmentRevisionId?: string;
    runtime?: string;
    computeProfile?: string;
    idleTimeoutMs?: number;
    associatedRunId?: string;
    mode?: 'local' | 'managed';
    projectPath?: string;
    port?: number;
  }): Promise<JupyterSessionLaunchResult>;
  stop(sessionId: string): Promise<JupyterSessionV1 | undefined>;
  interrupt(sessionId: string): Promise<JupyterSessionV1 | undefined>;
  restart(sessionId: string): Promise<JupyterSessionLaunchResult | undefined>;
  reconnect(sessionId: string): Promise<JupyterSessionLaunchResult | undefined>;
  validateToken(sessionId: string, token: string, scope?: string): Promise<boolean>;
  touch(sessionId: string): Promise<JupyterSessionV1 | undefined>;
  sweepIdle(): Promise<readonly JupyterSessionV1[]>;
}

type PersistedSession = JupyterSessionV1;

function now(): string {
  return new Date().toISOString();
}

function id(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(normalized)) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} is invalid`);
  }
  return normalized;
}

function port(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Jupyter port must be between 0 and 65535');
  }
  return value;
}

export interface LocalJupyterSessionRuntimeOptions {
  readonly rootPath: string;
  readonly profiles: RuntimeProfileRuntime;
  readonly executable?: string;
  readonly tokenTtlMs?: number;
  readonly idleTimeoutMs?: number;
  readonly managedServer?: ManagedJupyterServerAdapter;
  readonly clock?: () => string;
}

export class LocalJupyterSessionRuntime implements JupyterSessionRuntime {
  private readonly statePath: string;
  private readonly executable: string;
  private readonly profiles: RuntimeProfileRuntime;
  private readonly tokenTtlMs: number;
  private readonly idleTimeoutMs: number;
  private readonly managedServer: ManagedJupyterServerAdapter | undefined;
  private readonly clock: () => string;
  private state: PersistedSession[] | undefined;
  private loading: Promise<void> | undefined;
  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly tokens = new Map<string, string>();

  constructor(options: LocalJupyterSessionRuntimeOptions) {
    this.statePath = join(options.rootPath, '.agentic', 'jupyter-sessions.json');
    this.executable = options.executable ?? process.env['SPYDERBYTE_JUPYTER_BIN'] ?? 'jupyter';
    this.profiles = options.profiles;
    this.tokenTtlMs = Math.max(
      60_000,
      Math.min(options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS, 60 * 60 * 1000),
    );
    this.idleTimeoutMs = Math.max(
      1_000,
      Math.min(options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS, 24 * 60 * 60 * 1000),
    );
    this.managedServer = options.managedServer;
    this.clock = options.clock ?? now;
  }

  async discover(): Promise<JupyterDiscovery> {
    return this.discoverExecutable(this.executable);
  }

  private async discoverExecutable(executable: string): Promise<JupyterDiscovery> {
    const checkedAt = this.clock();
    try {
      const result = await execFileAsync(executable, ['--version'], {
        timeout: 5_000,
        maxBuffer: 16 * 1024,
      });
      const version = `${result.stdout}${result.stderr}`.trim().split(/\r?\n/)[0];
      return {
        executable,
        available: true,
        ...(version ? { version } : {}),
        checkedAt,
      };
    } catch (error) {
      return {
        executable,
        available: false,
        checkedAt,
        error: error instanceof Error ? error.message.slice(0, 500) : String(error),
      };
    }
  }

  async list(): Promise<readonly JupyterSessionV1[]> {
    await this.ensureLoaded();
    await this.sweepIdle();
    return structuredClone(this.state ?? []);
  }

  async get(sessionId: string): Promise<JupyterSessionV1 | undefined> {
    await this.ensureLoaded();
    await this.sweepIdle();
    const session = this.state?.find((item) => item.sessionId === id(sessionId, 'sessionId'));
    return session === undefined ? undefined : structuredClone(session);
  }

  async launch(input: {
    tenant?: TenantRef;
    projectId?: string;
    notebookId?: string;
    user?: Actor;
    profileId?: string;
    runtimeProfileId?: string;
    environmentRevisionId?: string;
    runtime?: string;
    computeProfile?: string;
    idleTimeoutMs?: number;
    associatedRunId?: string;
    mode?: 'local' | 'managed';
    projectPath?: string;
    port?: number;
  }): Promise<JupyterSessionLaunchResult> {
    await this.ensureLoaded();
    const effectiveProfileId = input.profileId ?? input.runtimeProfileId;
    const profile =
      effectiveProfileId === undefined
        ? undefined
        : await this.profiles.getProfile(effectiveProfileId);
    if (effectiveProfileId !== undefined && profile === undefined) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        `Runtime profile ${effectiveProfileId} was not found`,
      );
    }
    if (profile?.kind !== undefined && profile.kind !== 'jupyter') {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        `Runtime profile ${profile.profileId} is not a Jupyter profile`,
      );
    }
    const executable = profile?.executable ?? this.executable;
    const projectPath = resolve(input.projectPath ?? profile?.workingDirectory ?? process.cwd());
    if (!isAbsolute(projectPath)) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Jupyter project path must be absolute');
    }
    try {
      if (!(await stat(projectPath)).isDirectory()) {
        throw new Error('not a directory');
      }
    } catch {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Jupyter project path must be a directory');
    }
    const selectedPort = port(input.port);
    const requestedPort = selectedPort !== undefined && selectedPort > 0 ? selectedPort : undefined;
    const token = randomBytes(24).toString('hex');
    const sessionId = randomUUID();
    const sessionRequestId = randomUUID();
    const timestamp = this.clock();
    const tokenExpiresAt = new Date(Date.parse(timestamp) + this.tokenTtlMs).toISOString();
    const serverMode = input.mode ?? 'local';
    if (serverMode === 'managed' && this.managedServer === undefined) {
      throw runtimeError(
        'CAPABILITY_UNAVAILABLE',
        'Managed Jupyter provisioning is not configured for this runtime',
      );
    }
    const idleTimeoutMs =
      input.idleTimeoutMs === undefined
        ? this.idleTimeoutMs
        : Math.max(1_000, Math.min(input.idleTimeoutMs, 24 * 60 * 60 * 1000));
    const session: PersistedSession = {
      schemaVersion: 1,
      sessionId,
      sessionRequestId,
      ...(input.tenant === undefined ? {} : { tenant: input.tenant }),
      ...(input.projectId === undefined ? {} : { projectId: id(input.projectId, 'projectId') }),
      ...(input.notebookId === undefined ? {} : { notebookId: id(input.notebookId, 'notebookId') }),
      ...(input.user === undefined ? {} : { user: input.user }),
      ...(effectiveProfileId === undefined
        ? {}
        : { profileId: id(effectiveProfileId, 'profileId') }),
      ...(effectiveProfileId === undefined
        ? {}
        : { runtimeProfileId: id(effectiveProfileId, 'runtimeProfileId') }),
      ...(input.environmentRevisionId === undefined
        ? {}
        : { environmentRevisionId: id(input.environmentRevisionId, 'environmentRevisionId') }),
      ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
      ...(input.computeProfile === undefined ? {} : { computeProfile: input.computeProfile }),
      projectPath,
      state: 'starting',
      serverMode,
      idleTimeoutMs,
      lastActivityAt: timestamp,
      associatedRunIds: input.associatedRunId === undefined ? [] : [input.associatedRunId],
      tokenScopes: [
        `jupyter:session:${sessionId}`,
        ...(input.notebookId === undefined ? [] : [`notebook:${input.notebookId}`]),
      ],
      ...(requestedPort === undefined ? {} : { port: requestedPort }),
      tokenExpiresAt,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.ensureLoaded();
    const state = this.state;
    if (state === undefined) throw new Error('Jupyter session state was not initialized');
    state.push(session);
    this.tokens.set(sessionId, token);
    await this.persist();
    if (serverMode === 'managed') {
      const managed = this.managedServer;
      if (managed === undefined) throw new Error('Managed Jupyter server is unavailable');
      try {
        const result = await managed.launch({
          sessionId,
          ...(input.notebookId === undefined ? {} : { notebookId: input.notebookId }),
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          projectPath,
          ...(effectiveProfileId === undefined ? {} : { runtimeProfileId: effectiveProfileId }),
          ...(input.environmentRevisionId === undefined
            ? {}
            : { environmentRevisionId: input.environmentRevisionId }),
          ...(input.computeProfile === undefined ? {} : { computeProfile: input.computeProfile }),
          token,
        });
        const baseUrl = result.accessUrl ?? result.endpoint;
        const ready: PersistedSession = {
          ...session,
          state: 'ready',
          endpoint: result.endpoint,
          accessUrl: baseUrl.split('?')[0] ?? baseUrl,
          ...(result.kernelId === undefined ? {} : { kernelId: result.kernelId }),
          updatedAt: this.clock(),
        };
        await this.replaceSession(ready);
        return {
          session: structuredClone(ready),
          token,
          accessUrl: `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`,
        };
      } catch (error) {
        await this.update(sessionId, {
          state: 'failed',
          error: error instanceof Error ? error.message.slice(0, 1000) : String(error),
        });
        this.tokens.delete(sessionId);
        throw error;
      }
    }
    const discovery = await this.discoverExecutable(executable);
    if (!discovery.available) {
      this.tokens.delete(sessionId);
      await this.update(sessionId, {
        state: 'failed',
        error: `Jupyter is not available at ${executable}`,
      });
      throw runtimeError(
        'COMPUTE_RESOURCE_UNAVAILABLE',
        `Jupyter is not available at ${executable}; install JupyterLab or configure SPYDERBYTE_JUPYTER_BIN`,
      );
    }
    const args = [
      'lab',
      '--no-browser',
      '--ip=127.0.0.1',
      `--port=${requestedPort ?? 0}`,
      '--ServerApp.allow_remote_access=False',
      `--ServerApp.token=${token}`,
      `--ServerApp.root_dir=${projectPath}`,
    ];
    const inheritedEnvironmentNames = new Set([
      'PATH',
      'HOME',
      'TMPDIR',
      'LANG',
      'LC_ALL',
      'USER',
      'LOGNAME',
      ...(profile?.environmentVariableNames ?? []),
    ]);
    const environment: NodeJS.ProcessEnv = {};
    for (const name of inheritedEnvironmentNames) {
      const value = process.env[name];
      if (value !== undefined) environment[name] = value;
    }
    environment['JUPYTER_CONFIG_DIR'] = join(projectPath, '.jupyter');
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable, args, {
        cwd: projectPath,
        env: environment,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw runtimeError(
        'COMPUTE_RESOURCE_UNAVAILABLE',
        `Jupyter failed to start: ${String(error)}`,
      );
    }
    this.processes.set(sessionId, child);
    this.tokens.set(sessionId, token);
    const output: string[] = [];
    const onOutput = (chunk: Buffer): void => {
      output.push(chunk.toString('utf8').slice(0, 4000));
    };
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);
    child.once('error', (error) => {
      void this.update(sessionId, {
        state: 'failed',
        error: String(error).slice(0, 1000),
      });
    });
    child.once('exit', (code) => {
      void this.update(sessionId, {
        state: code === 0 ? 'stopped' : 'failed',
        ...(code === 0
          ? {}
          : {
              error:
                output.join('').slice(-1000) || `Jupyter exited with code ${code ?? 'unknown'}`,
            }),
      });
      this.processes.delete(sessionId);
    });
    try {
      const ready = await this.waitForReady(sessionId, session, requestedPort, token, output);
      await this.replaceSession(ready.session);
      return ready;
    } catch (error) {
      const process = this.processes.get(sessionId);
      process?.kill('SIGTERM');
      await this.update(sessionId, {
        state: 'failed',
        error: error instanceof Error ? error.message.slice(0, 1000) : String(error),
      });
      this.tokens.delete(sessionId);
      this.processes.delete(sessionId);
      throw error;
    }
  }

  async stop(sessionId: string): Promise<JupyterSessionV1 | undefined> {
    const normalized = id(sessionId, 'sessionId');
    const session = await this.getWithoutSweep(normalized);
    if (session === undefined) return undefined;
    const process = this.processes.get(normalized);
    if (process) process.kill('SIGTERM');
    if (session.serverMode === 'managed' && this.managedServer !== undefined) {
      await this.managedServer.stop({ session });
    }
    const updated = await this.update(normalized, { state: 'stopped' });
    this.tokens.delete(normalized);
    this.processes.delete(normalized);
    return updated;
  }

  async interrupt(sessionId: string): Promise<JupyterSessionV1 | undefined> {
    const normalized = id(sessionId, 'sessionId');
    const session = await this.get(normalized);
    if (session === undefined) return undefined;
    if (session.serverMode === 'managed') {
      if (this.managedServer?.interrupt === undefined) {
        throw runtimeError('CAPABILITY_UNAVAILABLE', 'Managed Jupyter interrupt is unavailable');
      }
      await this.managedServer.interrupt({ session });
    } else {
      this.processes.get(normalized)?.kill('SIGINT');
    }
    return this.touch(normalized);
  }

  async restart(sessionId: string): Promise<JupyterSessionLaunchResult | undefined> {
    const normalized = id(sessionId, 'sessionId');
    const session = await this.get(normalized);
    if (session === undefined) return undefined;
    if (session.serverMode === 'managed' && this.managedServer?.restart !== undefined) {
      const token = randomBytes(24).toString('hex');
      const result = await this.managedServer.restart({ session, token });
      const updated: PersistedSession = {
        ...session,
        state: 'ready',
        endpoint: result.endpoint,
        accessUrl: (result.accessUrl ?? result.endpoint).split('?')[0] ?? result.endpoint,
        ...(result.kernelId === undefined ? {} : { kernelId: result.kernelId }),
        tokenExpiresAt: new Date(Date.parse(this.clock()) + this.tokenTtlMs).toISOString(),
        lastActivityAt: this.clock(),
        updatedAt: this.clock(),
      };
      this.tokens.set(normalized, token);
      await this.replaceSession(updated);
      const baseUrl = result.accessUrl ?? result.endpoint;
      return {
        session: structuredClone(updated),
        token,
        accessUrl: `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`,
      };
    }
    await this.stop(normalized);
    return this.launch({
      ...(session.tenant === undefined ? {} : { tenant: session.tenant }),
      ...(session.projectId === undefined ? {} : { projectId: session.projectId }),
      ...(session.notebookId === undefined ? {} : { notebookId: session.notebookId }),
      ...(session.user === undefined ? {} : { user: session.user }),
      ...(session.runtimeProfileId === undefined
        ? {}
        : { runtimeProfileId: session.runtimeProfileId }),
      ...(session.environmentRevisionId === undefined
        ? {}
        : { environmentRevisionId: session.environmentRevisionId }),
      ...(session.runtime === undefined ? {} : { runtime: session.runtime }),
      ...(session.computeProfile === undefined ? {} : { computeProfile: session.computeProfile }),
      idleTimeoutMs: session.idleTimeoutMs,
      mode: session.serverMode,
      projectPath: session.projectPath,
      ...(session.port === undefined ? {} : { port: session.port }),
    });
  }

  async reconnect(sessionId: string): Promise<JupyterSessionLaunchResult | undefined> {
    const normalized = id(sessionId, 'sessionId');
    const session = await this.get(normalized);
    if (session === undefined) return undefined;
    const existingToken = this.tokens.get(normalized);
    if (
      existingToken !== undefined &&
      Date.parse(session.tokenExpiresAt) > Date.parse(this.clock()) &&
      (this.processes.has(normalized) ||
        (session.serverMode === 'managed' && this.managedServer?.reconnect === undefined))
    ) {
      const baseUrl = session.accessUrl ?? session.endpoint;
      if (baseUrl === undefined) return undefined;
      await this.touch(normalized);
      return {
        session: structuredClone((await this.get(normalized)) ?? session),
        token: existingToken,
        accessUrl: `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(existingToken)}`,
      };
    }
    if (session.serverMode === 'managed' && this.managedServer?.reconnect !== undefined) {
      const token = randomBytes(24).toString('hex');
      const result = await this.managedServer.reconnect({ session, token });
      const updated: PersistedSession = {
        ...session,
        state: 'ready',
        endpoint: result.endpoint,
        accessUrl: (result.accessUrl ?? result.endpoint).split('?')[0] ?? result.endpoint,
        ...(result.kernelId === undefined ? {} : { kernelId: result.kernelId }),
        tokenExpiresAt: new Date(Date.parse(this.clock()) + this.tokenTtlMs).toISOString(),
        lastActivityAt: this.clock(),
        updatedAt: this.clock(),
      };
      this.tokens.set(normalized, token);
      await this.replaceSession(updated);
      const baseUrl = result.accessUrl ?? result.endpoint;
      return {
        session: structuredClone(updated),
        token,
        accessUrl: `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`,
      };
    }
    return this.restart(normalized);
  }

  async validateToken(sessionId: string, token: string, scope?: string): Promise<boolean> {
    const normalized = id(sessionId, 'sessionId');
    const session = await this.getWithoutSweep(normalized);
    if (session === undefined) return false;
    if (this.tokens.get(normalized) !== token) return false;
    if (Date.parse(session.tokenExpiresAt) <= Date.parse(this.clock())) return false;
    return scope === undefined || session.tokenScopes.includes(scope);
  }

  async touch(sessionId: string): Promise<JupyterSessionV1 | undefined> {
    const normalized = id(sessionId, 'sessionId');
    const session = await this.getWithoutSweep(normalized);
    if (session === undefined) return undefined;
    return this.update(normalized, {
      state: session.state === 'idle' ? 'ready' : session.state,
      lastActivityAt: this.clock(),
    });
  }

  async sweepIdle(): Promise<readonly JupyterSessionV1[]> {
    await this.ensureLoaded();
    const nowMs = Date.parse(this.clock());
    const expired: JupyterSessionV1[] = [];
    for (const session of [...(this.state ?? [])]) {
      if (!['ready', 'idle'].includes(session.state)) continue;
      if (nowMs - Date.parse(session.lastActivityAt) < session.idleTimeoutMs) continue;
      const stopped = await this.stop(session.sessionId);
      if (stopped !== undefined) expired.push(stopped);
    }
    return structuredClone(expired);
  }

  private async waitForReady(
    sessionId: string,
    session: PersistedSession,
    selectedPort: number | undefined,
    token: string,
    output: readonly string[],
  ): Promise<JupyterSessionLaunchResult> {
    const deadline = Date.now() + 10_000;
    let resolvedPort = selectedPort;
    while (Date.now() < deadline) {
      const outputText = output.join('');
      const match = outputText.match(/(?:127\.0\.0\.1|localhost):(\d+)(?:\/[^\s]*)?/);
      if (match?.[1]) resolvedPort = Number(match[1]);
      const readySignal =
        match !== null || /Jupyter Server|JupyterLab|is running at/i.test(outputText);
      const child = this.processes.get(sessionId);
      if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
        throw runtimeError(
          'COMPUTE_RESOURCE_UNAVAILABLE',
          outputText.slice(-1000) || 'Jupyter exited before becoming ready',
        );
      }
      if (readySignal && resolvedPort !== undefined && resolvedPort > 0) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    if (resolvedPort === undefined || resolvedPort <= 0) {
      throw runtimeError(
        'COMPUTE_RESOURCE_UNAVAILABLE',
        'Jupyter did not report a loopback URL before the startup deadline',
      );
    }
    const accessUrl = `http://127.0.0.1:${resolvedPort}/lab?token=${encodeURIComponent(token)}`;
    const ready: PersistedSession = {
      ...session,
      state: 'ready',
      port: resolvedPort,
      accessUrl: accessUrl.split('?')[0] ?? accessUrl,
      endpoint: `http://127.0.0.1:${resolvedPort}`,
      lastActivityAt: this.clock(),
      ...(this.processes.get(sessionId)?.pid === undefined
        ? {}
        : { pid: this.processes.get(sessionId)?.pid as number }),
      updatedAt: this.clock(),
    };
    return { session: structuredClone(ready), token, accessUrl };
  }

  private async replaceSession(session: PersistedSession): Promise<void> {
    await this.ensureLoaded();
    const state = this.state;
    if (state === undefined) throw new Error('Jupyter session state was not initialized');
    const index = state.findIndex((item) => item.sessionId === session.sessionId);
    if (index < 0) state.push(session);
    else state.splice(index, 1, session);
    await this.persist();
  }

  private async update(
    sessionId: string,
    patch: Partial<Pick<PersistedSession, 'state' | 'error' | 'lastActivityAt'>>,
  ): Promise<JupyterSessionV1 | undefined> {
    await this.ensureLoaded();
    const state = this.state;
    if (state === undefined) throw new Error('Jupyter session state was not initialized');
    const index = state.findIndex((item) => item.sessionId === sessionId);
    if (index < 0) return undefined;
    const updated = {
      ...state[index],
      ...patch,
      updatedAt: this.clock(),
    } as PersistedSession;
    state.splice(index, 1, updated);
    await this.persist();
    return structuredClone(updated);
  }

  private async getWithoutSweep(sessionId: string): Promise<JupyterSessionV1 | undefined> {
    await this.ensureLoaded();
    const session = this.state?.find((item) => item.sessionId === id(sessionId, 'sessionId'));
    return session === undefined ? undefined : structuredClone(session);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.state) return;
    this.loading ??= (async () => {
      try {
        const raw = JSON.parse(await readFile(this.statePath, 'utf8'));
        const values = Array.isArray(raw) ? raw : [];
        const sessions = values
          .map((value) => this.normalizeSession(value))
          .filter((value): value is PersistedSession => value !== undefined);
        let changed = false;
        this.state = sessions.map((session) => {
          if (session.state !== 'starting' && session.state !== 'ready') return session;
          changed = true;
          return {
            ...session,
            state: 'failed' as const,
            error: 'Jupyter process is not attached; reconnect or restart the session',
            updatedAt: this.clock(),
          };
        });
        if (changed) await this.persist();
      } catch {
        this.state = [];
      }
    })();
    await this.loading;
  }

  private normalizeSession(value: unknown): PersistedSession | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record['sessionId'] !== 'string' || typeof record['projectPath'] !== 'string') {
      return undefined;
    }
    const timestamp =
      typeof record['updatedAt'] === 'string'
        ? record['updatedAt']
        : typeof record['createdAt'] === 'string'
          ? record['createdAt']
          : this.clock();
    const stateValue = record['state'];
    const state: JupyterSessionState =
      stateValue === 'starting' ||
      stateValue === 'ready' ||
      stateValue === 'idle' ||
      stateValue === 'stopping' ||
      stateValue === 'stopped' ||
      stateValue === 'failed'
        ? stateValue
        : 'failed';
    const associatedRunIds = Array.isArray(record['associatedRunIds'])
      ? record['associatedRunIds'].filter((item): item is string => typeof item === 'string')
      : [];
    const tokenScopes = Array.isArray(record['tokenScopes'])
      ? record['tokenScopes'].filter((item): item is string => typeof item === 'string')
      : [`jupyter:session:${record['sessionId']}`];
    return {
      schemaVersion: 1,
      sessionId: record['sessionId'],
      sessionRequestId:
        typeof record['sessionRequestId'] === 'string' ? record['sessionRequestId'] : randomUUID(),
      ...(record['tenant'] === undefined ? {} : { tenant: record['tenant'] as TenantRef }),
      ...(typeof record['projectId'] === 'string' ? { projectId: record['projectId'] } : {}),
      ...(typeof record['notebookId'] === 'string' ? { notebookId: record['notebookId'] } : {}),
      ...(record['user'] === undefined ? {} : { user: record['user'] as Actor }),
      ...(typeof record['profileId'] === 'string' ? { profileId: record['profileId'] } : {}),
      ...(typeof record['runtimeProfileId'] === 'string'
        ? { runtimeProfileId: record['runtimeProfileId'] }
        : {}),
      ...(typeof record['environmentRevisionId'] === 'string'
        ? { environmentRevisionId: record['environmentRevisionId'] }
        : {}),
      ...(typeof record['runtime'] === 'string' ? { runtime: record['runtime'] } : {}),
      ...(typeof record['computeProfile'] === 'string'
        ? { computeProfile: record['computeProfile'] }
        : {}),
      ...(typeof record['endpoint'] === 'string' ? { endpoint: record['endpoint'] } : {}),
      ...(typeof record['kernelId'] === 'string' ? { kernelId: record['kernelId'] } : {}),
      projectPath: record['projectPath'],
      state,
      serverMode: record['serverMode'] === 'managed' ? 'managed' : 'local',
      idleTimeoutMs:
        typeof record['idleTimeoutMs'] === 'number' && record['idleTimeoutMs'] > 0
          ? record['idleTimeoutMs']
          : this.idleTimeoutMs,
      lastActivityAt:
        typeof record['lastActivityAt'] === 'string' ? record['lastActivityAt'] : timestamp,
      associatedRunIds,
      tokenScopes,
      ...(typeof record['port'] === 'number' ? { port: record['port'] } : {}),
      ...(typeof record['accessUrl'] === 'string' ? { accessUrl: record['accessUrl'] } : {}),
      tokenExpiresAt:
        typeof record['tokenExpiresAt'] === 'string' ? record['tokenExpiresAt'] : timestamp,
      ...(typeof record['pid'] === 'number' ? { pid: record['pid'] } : {}),
      ...(typeof record['error'] === 'string' ? { error: record['error'] } : {}),
      createdAt: typeof record['createdAt'] === 'string' ? record['createdAt'] : timestamp,
      updatedAt: timestamp,
    };
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
    await writeFile(this.statePath, `${JSON.stringify(this.state ?? [], null, 2)}\n`, {
      mode: 0o600,
    });
  }
}
