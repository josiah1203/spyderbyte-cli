import { createHash, randomUUID, verify } from 'node:crypto';
import { accessSync, constants, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { runtimeError } from '@agentic-platform/runtime-contracts';
import type {
  ConnectorArtifact,
  ConnectorCheckpoint,
  ConnectorDiscoveryResult,
  ConnectorLineageV1,
  ConnectorManifestV1,
  ConnectorResourceV1,
  ConnectorRun,
  ConnectorRuntime,
  ConnectorSchemaChangeEventV1,
  ConnectionBinding,
} from './connector-registry.js';
import { ConnectorRegistry, verifyConnectorManifest } from './connector-registry.js';

export interface MeltanoConnectorRuntimeOptions {
  readonly rootPath: string;
  readonly executable?: string;
  readonly runtimeManifestPath?: string;
  readonly runtimePublicKey?: string;
  readonly requireSignedRuntime?: boolean;
  readonly clock?: () => string;
  readonly credentialResolver?: (connectionId: string) => Promise<string | undefined>;
  readonly registry?: ConnectorRegistry;
}

export interface MeltanoRuntimeManifestV1 {
  readonly schemaVersion: 1;
  readonly product: 'Spyderbyte';
  readonly version: string;
  readonly platform: string;
  readonly architecture: string;
  readonly executableDigest: string;
  readonly signature: string;
  readonly signedAt: string;
}

export interface MeltanoRuntimeStatus {
  readonly configured: boolean;
  readonly executable?: string;
  readonly executableDigest?: string;
  readonly signed: boolean;
  readonly verified: boolean;
  readonly manifest?: MeltanoRuntimeManifestV1;
  readonly reason?: string;
}

interface ProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface RunState {
  readonly run: ConnectorRun;
  readonly process?: ChildProcess;
}

const PACKAGE_BY_CONNECTOR: Record<string, string> = {
  'meltano-tap-postgres': 'tap-postgres',
  'meltano-tap-s3': 'tap-s3',
  'meltano-target-postgres': 'target-postgres',
};

function now(): string {
  return new Date().toISOString();
}

function canonicalRuntimeManifest(manifest: Omit<MeltanoRuntimeManifestV1, 'signature'>): string {
  return JSON.stringify(manifest);
}

function digestFile(path: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

function parseRuntimeManifest(path: string | undefined): MeltanoRuntimeManifestV1 | undefined {
  if (path === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (
      record['schemaVersion'] !== 1 ||
      record['product'] !== 'Spyderbyte' ||
      typeof record['version'] !== 'string' ||
      typeof record['platform'] !== 'string' ||
      typeof record['architecture'] !== 'string' ||
      typeof record['executableDigest'] !== 'string' ||
      typeof record['signature'] !== 'string' ||
      typeof record['signedAt'] !== 'string'
    ) {
      return undefined;
    }
    return value as MeltanoRuntimeManifestV1;
  } catch {
    return undefined;
  }
}

function resolveExecutable(rootPath: string, configured: string | undefined): string | undefined {
  const candidates = [
    configured,
    process.env['SPYDERBYTE_MELTANO_BIN'],
    process.env['SPYDERBYTE_BUNDLED_MELTANO_BIN'],
    join(rootPath, 'apps', 'desktop', 'src-tauri', 'resources', 'meltano', 'meltano'),
    join(rootPath, '.agentic', 'meltano', 'bin', 'meltano'),
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate.trim().length === 0) continue;
    const path = resolve(candidate);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      continue;
    }
  }
  return undefined;
}

function verifyRuntime(
  executable: string | undefined,
  manifestPath: string | undefined,
  publicKey: string | undefined,
): MeltanoRuntimeStatus {
  const manifest = parseRuntimeManifest(manifestPath);
  if (executable === undefined) {
    return { configured: false, signed: false, verified: false, reason: 'runtime-not-found' };
  }
  let digest: string;
  try {
    digest = digestFile(executable);
  } catch {
    return {
      configured: false,
      executable,
      signed: false,
      verified: false,
      reason: 'runtime-not-readable',
    };
  }
  if (manifest === undefined) {
    return {
      configured: true,
      executable,
      executableDigest: digest,
      signed: false,
      verified: false,
      reason: 'runtime-manifest-not-found',
    };
  }
  if (manifest.executableDigest !== digest) {
    return {
      configured: false,
      executable,
      executableDigest: digest,
      signed: false,
      verified: false,
      manifest,
      reason: 'runtime-digest-mismatch',
    };
  }
  if (publicKey === undefined || publicKey.trim().length === 0) {
    return {
      configured: true,
      executable,
      executableDigest: digest,
      signed: false,
      verified: false,
      manifest,
      reason: 'runtime-public-key-not-configured',
    };
  }
  try {
    const unsigned: Omit<MeltanoRuntimeManifestV1, 'signature'> = {
      schemaVersion: manifest.schemaVersion,
      product: manifest.product,
      version: manifest.version,
      platform: manifest.platform,
      architecture: manifest.architecture,
      executableDigest: manifest.executableDigest,
      signedAt: manifest.signedAt,
    };
    const valid = verify(
      null,
      Buffer.from(canonicalRuntimeManifest(unsigned)),
      publicKey,
      Buffer.from(manifest.signature, 'base64'),
    );
    return {
      configured: valid,
      executable,
      executableDigest: digest,
      signed: valid,
      verified: valid,
      manifest,
      ...(valid ? {} : { reason: 'runtime-signature-invalid' }),
    };
  } catch {
    return {
      configured: false,
      executable,
      executableDigest: digest,
      signed: false,
      verified: false,
      manifest,
      reason: 'runtime-signature-invalid',
    };
  }
}

export function inspectMeltanoRuntime(options: {
  readonly rootPath: string;
  readonly executable?: string;
  readonly runtimeManifestPath?: string;
  readonly runtimePublicKey?: string;
}): MeltanoRuntimeStatus {
  const executable = resolveExecutable(options.rootPath, options.executable);
  const manifestPath =
    options.runtimeManifestPath ??
    process.env['SPYDERBYTE_MELTANO_MANIFEST'] ??
    (executable === undefined ? undefined : join(dirname(executable), 'runtime-manifest.json'));
  return verifyRuntime(
    executable,
    manifestPath,
    options.runtimePublicKey ?? process.env['SPYDERBYTE_MELTANO_PUBLIC_KEY'],
  );
}

function safeId(value: string, label: string): string {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(value)) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} is invalid`);
  }
  return value;
}

function connectorPackage(manifest: ConnectorManifestV1): string {
  const packageName = PACKAGE_BY_CONNECTOR[manifest.connectorId];
  if (manifest.runtimeAdapter !== 'meltano' || packageName === undefined) {
    throw runtimeError(
      'VALIDATION_INVALID_INPUT',
      `No curated Meltano adapter exists for ${manifest.connectorId}`,
    );
  }
  return packageName;
}

function parseCredential(value: string | undefined): Record<string, string> {
  if (value === undefined || value.trim().length === 0) {
    throw runtimeError('POLICY_DENIED', 'The connector has no credential binding');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw runtimeError('POLICY_DENIED', 'The connector credential binding is invalid');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw runtimeError('POLICY_DENIED', 'The connector credential binding must be an object');
  }
  const config: Record<string, string> = {};
  for (const [key, item] of Object.entries(parsed)) {
    if (typeof item !== 'string')
      throw runtimeError('POLICY_DENIED', `Connector credential ${key} is invalid`);
    config[key] = item;
  }
  return config;
}

function jsonLines(value: string): Array<Record<string, unknown>> {
  return value.split(/\r?\n/).flatMap((line) => {
    if (line.trim().length === 0) return [];
    try {
      const parsed: unknown = JSON.parse(line);
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? [parsed as Record<string, unknown>]
        : [];
    } catch {
      return [];
    }
  });
}

function discoveredResources(
  value: string,
  fallback: readonly ConnectorResourceV1[],
): ConnectorResourceV1[] {
  const parsed = jsonLines(value);
  const streams = parsed.find((item) => Array.isArray(item['streams']))?.['streams'];
  if (!Array.isArray(streams)) return [...fallback];
  const resources = streams.flatMap((stream, index) => {
    if (stream === null || typeof stream !== 'object' || Array.isArray(stream)) return [];
    const record = stream as Record<string, unknown>;
    const streamId =
      typeof record['tap_stream_id'] === 'string'
        ? record['tap_stream_id']
        : typeof record['stream'] === 'string'
          ? record['stream']
          : `stream-${index + 1}`;
    const schema = record['schema'];
    const properties =
      schema !== null && typeof schema === 'object' && !Array.isArray(schema)
        ? (schema as Record<string, unknown>)['properties']
        : undefined;
    const fields =
      properties !== null && typeof properties === 'object' && !Array.isArray(properties)
        ? Object.keys(properties as Record<string, unknown>)
        : undefined;
    return [
      {
        resourceId: streamId,
        label: streamId,
        kind: 'stream' as const,
        selectable: true,
        ...(fields === undefined ? {} : { fields }),
      },
    ];
  });
  return resources.length > 0 ? resources : [...fallback];
}

function schemaFingerprint(resources: readonly ConnectorResourceV1[]): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(resources)).digest('hex')}`;
}

export class MeltanoConnectorRuntime implements ConnectorRuntime {
  private readonly rootPath: string;
  private readonly executable: string;
  private readonly clock: () => string;
  private readonly credentialResolver: (connectionId: string) => Promise<string | undefined>;
  readonly registry: ConnectorRegistry;
  readonly available: boolean;
  readonly runtimeStatus: MeltanoRuntimeStatus;
  private readonly statePath: string;
  private readonly runs = new Map<string, RunState>();
  private readonly checkpoints = new Map<string, ConnectorCheckpoint>();
  private readonly schemaEvents = new Map<string, ConnectorSchemaChangeEventV1>();
  private readonly discoveries = new Map<string, string>();

  constructor(options: MeltanoConnectorRuntimeOptions) {
    this.rootPath = options.rootPath;
    this.statePath = join(options.rootPath, '.agentic', 'meltano', 'sync-state.json');
    const configuredExecutable = resolveExecutable(options.rootPath, options.executable);
    this.executable = configuredExecutable ?? 'meltano';
    this.runtimeStatus = inspectMeltanoRuntime({
      rootPath: options.rootPath,
      ...(options.executable === undefined ? {} : { executable: options.executable }),
      ...(options.runtimeManifestPath === undefined
        ? {}
        : { runtimeManifestPath: options.runtimeManifestPath }),
      ...(options.runtimePublicKey === undefined
        ? {}
        : { runtimePublicKey: options.runtimePublicKey }),
    });
    const requireSigned =
      options.requireSignedRuntime ?? process.env['SPYDERBYTE_REQUIRE_SIGNED_MELTANO'] !== 'false';
    const configuredValue =
      options.executable ??
      process.env['SPYDERBYTE_MELTANO_BIN'] ??
      process.env['SPYDERBYTE_BUNDLED_MELTANO_BIN'];
    this.available =
      configuredValue !== undefined &&
      configuredValue.trim().length > 0 &&
      (!requireSigned || this.runtimeStatus.verified);
    this.clock = options.clock ?? now;
    this.credentialResolver = options.credentialResolver ?? (async () => undefined);
    this.registry = options.registry ?? new ConnectorRegistry();
    this.loadPersistedState();
  }

  async discover(input: {
    manifest: ConnectorManifestV1;
    binding: ConnectionBinding;
  }): Promise<ConnectorDiscoveryResult> {
    this.verifyRegisteredManifest(input.manifest);
    if (!this.available) {
      throw runtimeError(
        'COMPUTE_RESOURCE_UNAVAILABLE',
        'Configure a signed Meltano executable before connector discovery can run',
      );
    }
    const packageName = connectorPackage(input.manifest);
    const config = parseCredential(await this.credentialResolver(input.binding.connectionId));
    await mkdir(join(this.rootPath, '.agentic', 'meltano'), { recursive: true, mode: 0o700 });
    const result = await this.runProcess(
      `discover-${input.binding.bindingId}`,
      [
        'invoke',
        packageName,
        '--config',
        await this.writeConfig(input.binding.connectionId, config),
        '--discover',
      ],
      config,
    );
    if (result.code !== 0 || result.signal !== null) {
      throw runtimeError(
        'EXTERNAL_DEPENDENCY_UNAVAILABLE',
        result.stderr.trim() || 'Meltano discovery failed',
      );
    }
    const resources = discoveredResources(result.stdout, input.manifest.resources);
    const fingerprint = schemaFingerprint(resources);
    const discoveryKey = `${input.manifest.connectorId}:${input.binding.connectionId}`;
    const previousFingerprint = this.discoveries.get(discoveryKey);
    const event = this.recordSchemaEvent(
      input.manifest.connectorId,
      input.binding.connectionId,
      '*',
      previousFingerprint,
      fingerprint,
    );
    this.discoveries.set(discoveryKey, fingerprint);
    this.persistState();
    return {
      connectorId: input.manifest.connectorId,
      connectionId: input.binding.connectionId,
      status: 'ready',
      resources,
      schemaFingerprint: fingerprint,
      ...(event === undefined ? {} : { schemaChangeEventIds: [event.eventId] }),
      discoveredAt: this.clock(),
    };
  }

  async execute(input: {
    manifest: ConnectorManifestV1;
    binding: ConnectionBinding;
    operation: string;
    checkpoint?: ConnectorCheckpoint;
    idempotencyKey?: string;
  }): Promise<ConnectorRun> {
    this.verifyRegisteredManifest(input.manifest);
    const idempotencyKey = input.idempotencyKey?.trim();
    if (
      idempotencyKey !== undefined &&
      (idempotencyKey.length === 0 || idempotencyKey.length > 200)
    ) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Connector idempotencyKey is invalid');
    }
    if (idempotencyKey !== undefined) {
      const existing = [...this.runs.values()].find(
        (state) =>
          state.run.connectorId === input.manifest.connectorId &&
          state.run.connectionId === input.binding.connectionId &&
          state.run.operation === input.operation &&
          state.run.idempotencyKey === idempotencyKey,
      );
      if (existing !== undefined) return structuredClone(existing.run);
    }
    if (!this.available) {
      throw runtimeError(
        'COMPUTE_RESOURCE_UNAVAILABLE',
        'Configure a signed Meltano executable before connector runs can execute',
      );
    }
    const packageName = connectorPackage(input.manifest);
    if (!input.manifest.operations.includes(input.operation)) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        `Connector operation is not allowed: ${input.operation}`,
      );
    }
    if (input.manifest.connectorId === 'meltano-target-postgres') {
      throw runtimeError(
        'POLICY_DENIED',
        'Destination writes require an approved pipeline target binding',
      );
    }
    const runId = `connector-run-${randomUUID()}`;
    const startedAt = this.clock();
    const config = parseCredential(await this.credentialResolver(input.binding.connectionId));
    const configPath = await this.writeConfig(input.binding.connectionId, config);
    const args = [
      'invoke',
      packageName,
      '--config',
      configPath,
      ...(input.checkpoint?.cursor === undefined ? [] : ['--state', input.checkpoint.cursor]),
    ];
    const queued: ConnectorRun = {
      runId,
      connectorId: input.manifest.connectorId,
      connectionId: input.binding.connectionId,
      operation: input.operation,
      status: 'running',
      startedAt,
      artifactIds: [],
      metrics: {},
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      ...(input.binding.syncMode === undefined ? {} : { syncMode: input.binding.syncMode }),
      ...(input.binding.destination === undefined
        ? {}
        : { destination: input.binding.destination }),
      ...(input.checkpoint === undefined ? {} : { checkpointId: input.checkpoint.checkpointId }),
    };
    this.runs.set(runId, { run: queued });
    this.persistState();
    try {
      const result = await this.runProcess(runId, args, config);
      const cancelled = result.signal !== null && result.signal !== undefined;
      const lines = jsonLines(result.stdout);
      const state = [...lines].reverse().find((line) => line['type'] === 'STATE');
      const records = lines.filter((line) => line['type'] === 'RECORD').length;
      const artifact = await this.writeArtifact(
        runId,
        input.manifest.connectorId,
        result.stdout,
        records,
      );
      const runSchemaFingerprint = schemaFingerprint(
        input.binding.schemaSelection?.map((resourceId) => ({
          resourceId,
          label: resourceId,
          kind: 'stream' as const,
          selectable: true,
        })) ??
          input.manifest.resources.filter((resource) =>
            input.binding.resources.includes(resource.resourceId),
          ),
      );
      const checkpoint =
        state === undefined
          ? undefined
          : this.saveCheckpoint(
              input.manifest.connectorId,
              input.binding,
              state,
              runSchemaFingerprint,
            );
      const lineage: ConnectorLineageV1 = {
        runId,
        connectorId: input.manifest.connectorId,
        connectionId: input.binding.connectionId,
        source: `connector://${input.manifest.connectorId}/${input.binding.connectionId}`,
        ...(input.binding.destination === undefined
          ? {}
          : { destination: input.binding.destination }),
        ...(checkpoint === undefined ? {} : { checkpointId: checkpoint.checkpointId }),
        artifactIds: [`connector-artifact-${runId}`],
        schemaFingerprint: runSchemaFingerprint,
        recordedAt: this.clock(),
      };
      const finished: ConnectorRun = {
        ...queued,
        status: cancelled ? 'cancelled' : result.code === 0 ? 'completed' : 'failed',
        completedAt: this.clock(),
        artifactIds: [artifact.artifactId],
        metrics: {
          outputBytes: Buffer.byteLength(result.stdout),
          recordCount: records,
          durationMs: Math.max(0, Date.parse(this.clock()) - Date.parse(startedAt)),
        },
        schemaFingerprint: runSchemaFingerprint,
        ...(lineage === undefined ? {} : { lineage }),
        ...(checkpoint === undefined ? {} : { checkpointId: checkpoint.checkpointId }),
        ...(result.code === 0 || cancelled
          ? {}
          : { error: result.stderr.trim() || 'Meltano connector failed' }),
      };
      this.runs.set(runId, { run: finished });
      this.persistState();
      return structuredClone(finished);
    } catch (error) {
      const failed: ConnectorRun = {
        ...queued,
        status: 'failed',
        completedAt: this.clock(),
        error: error instanceof Error ? error.message : String(error),
      };
      this.runs.set(runId, { run: failed });
      this.persistState();
      return structuredClone(failed);
    }
  }

  async cancel(runId: string): Promise<void> {
    const state = this.runs.get(safeId(runId, 'runId'));
    if (state?.process !== undefined) state.process.kill('SIGTERM');
  }

  listRuns(): ConnectorRun[] {
    return structuredClone([...this.runs.values()].map((state) => state.run));
  }

  getRun(runId: string): ConnectorRun | undefined {
    const state = this.runs.get(runId);
    return state === undefined ? undefined : structuredClone(state.run);
  }

  getCheckpoint(checkpointId: string): ConnectorCheckpoint | undefined {
    const checkpoint = [...this.checkpoints.values()].find(
      (item) => item.checkpointId === checkpointId,
    );
    return checkpoint === undefined ? undefined : structuredClone(checkpoint);
  }

  listCheckpoints(): ConnectorCheckpoint[] {
    return structuredClone([...this.checkpoints.values()]);
  }

  listSchemaChangeEvents(
    input: {
      readonly connectorId?: string;
      readonly connectionId?: string;
    } = {},
  ): ConnectorSchemaChangeEventV1[] {
    return structuredClone(
      [...this.schemaEvents.values()].filter(
        (event) =>
          (input.connectorId === undefined || event.connectorId === input.connectorId) &&
          (input.connectionId === undefined || event.connectionId === input.connectionId),
      ),
    );
  }

  private async writeConfig(connectionId: string, config: Record<string, string>): Promise<string> {
    const directory = join(this.rootPath, '.agentic', 'meltano', 'bindings');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${safeId(connectionId, 'connectionId')}.json`);
    await writeFile(path, JSON.stringify(config), { mode: 0o600 });
    return path;
  }

  private async writeArtifact(
    runId: string,
    connectorId: string,
    output: string,
    rowCount: number,
  ): Promise<ConnectorArtifact> {
    const directory = join(this.rootPath, '.agentic', 'connectors', 'artifacts');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const bytes = Buffer.from(output, 'utf8');
    const hash = createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(directory, `${runId}.jsonl`), bytes, { mode: 0o600 });
    return {
      artifactId: `connector-artifact-${runId}`,
      runId,
      connectorId,
      mediaType: 'application/x-ndjson',
      contentHash: `sha256:${hash}`,
      rowCount,
      createdAt: this.clock(),
    };
  }

  private saveCheckpoint(
    connectorId: string,
    binding: ConnectionBinding,
    state: Record<string, unknown>,
    fingerprint?: string,
  ): ConnectorCheckpoint {
    const checkpoint: ConnectorCheckpoint = {
      checkpointId: `checkpoint-${binding.bindingId}-${randomUUID()}`,
      connectorId,
      stream: typeof state['stream'] === 'string' ? state['stream'] : '*',
      cursor:
        typeof state['value'] === 'string'
          ? state['value']
          : JSON.stringify(state['value'] ?? state),
      ...(fingerprint === undefined ? {} : { schemaFingerprint: fingerprint }),
      bindingId: binding.bindingId,
      ...(binding.destination === undefined ? {} : { destination: binding.destination }),
      updatedAt: this.clock(),
    };
    this.checkpoints.set(checkpoint.checkpointId, checkpoint);
    this.persistState();
    return checkpoint;
  }

  private loadPersistedState(): void {
    try {
      const raw = JSON.parse(readFileSync(this.statePath, 'utf8')) as {
        runs?: readonly ConnectorRun[];
        checkpoints?: readonly ConnectorCheckpoint[];
        schemaEvents?: readonly ConnectorSchemaChangeEventV1[];
        discoveries?: Readonly<Record<string, string>>;
      };
      for (const run of raw.runs ?? []) {
        const recovered =
          run.status === 'running' || run.status === 'queued'
            ? {
                ...run,
                status: 'failed' as const,
                completedAt: this.clock(),
                error: 'Connector process was interrupted by a daemon restart',
              }
            : run;
        this.runs.set(run.runId, { run: recovered });
      }
      for (const checkpoint of raw.checkpoints ?? []) {
        this.checkpoints.set(checkpoint.checkpointId, checkpoint);
      }
      for (const event of raw.schemaEvents ?? []) this.schemaEvents.set(event.eventId, event);
      for (const [key, fingerprint] of Object.entries(raw.discoveries ?? {})) {
        this.discoveries.set(key, fingerprint);
      }
      this.persistState();
    } catch {
      // A missing or corrupt local history is recoverable; new syncs start with empty history.
    }
  }

  private persistState(): void {
    try {
      mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
      writeFileSync(
        this.statePath,
        `${JSON.stringify(
          {
            runs: [...this.runs.values()].map((state) => state.run),
            checkpoints: [...this.checkpoints.values()],
            schemaEvents: [...this.schemaEvents.values()],
            discoveries: Object.fromEntries(this.discoveries),
          },
          null,
        )}\n`,
        { mode: 0o600 },
      );
    } catch {
      // Sync history is best effort when the workspace is read-only; execution still fails closed.
    }
  }

  private verifyRegisteredManifest(manifest: ConnectorManifestV1): void {
    verifyConnectorManifest(manifest);
    const registered = this.registry.get(manifest.connectorId);
    if (
      registered === undefined ||
      registered.version !== manifest.version ||
      registered.packageDigest !== manifest.packageDigest
    ) {
      throw runtimeError(
        'POLICY_DENIED',
        `Connector ${manifest.connectorId} is not the signed registered version`,
      );
    }
  }

  private recordSchemaEvent(
    connectorId: string,
    connectionId: string | undefined,
    stream: string,
    previousFingerprint: string | undefined,
    nextFingerprint: string,
  ): ConnectorSchemaChangeEventV1 | undefined {
    if (previousFingerprint === nextFingerprint) return undefined;
    const change: ConnectorSchemaChangeEventV1['change'] =
      previousFingerprint === undefined ? 'initial' : 'changed';
    const event: ConnectorSchemaChangeEventV1 = {
      eventId: `connector-schema-${randomUUID()}`,
      connectorId,
      ...(connectionId === undefined ? {} : { connectionId }),
      stream,
      ...(previousFingerprint === undefined ? {} : { previousFingerprint }),
      nextFingerprint,
      change,
      occurredAt: this.clock(),
    };
    this.schemaEvents.set(event.eventId, event);
    return event;
  }

  private runProcess(
    runId: string,
    args: readonly string[],
    config: Record<string, string>,
  ): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, [...args], {
        cwd: join(this.rootPath, '.agentic', 'meltano'),
        env: { ...process.env, ...config, SPYDERBYTE_CONNECTOR_RUN_ID: runId },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const state = this.runs.get(runId);
      if (state !== undefined) this.runs.set(runId, { ...state, process: child });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        if (Buffer.byteLength(stdout) > 100 * 1024 * 1024) child.kill('SIGTERM');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.once('error', (error) =>
        reject(
          runtimeError(
            'EXTERNAL_DEPENDENCY_UNAVAILABLE',
            `Meltano could not start: ${error.message}`,
          ),
        ),
      );
      child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
  }
}
