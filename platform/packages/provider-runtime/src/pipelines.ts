import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { runtimeError, type JsonValue } from '@agentic-platform/runtime-contracts';
import type { MeltanoConnectorRuntime } from './meltano.js';
import type { NotebookCellType, NotebookRuntime } from './notebook.js';
import type { QueryRuntime, QuerySource } from './query.js';

export const PIPELINE_STAGE_TYPES = [
  'query',
  'sql',
  'python',
  'notebook',
  'connector',
  'inference',
  'training',
  'evaluation',
  'visualization',
  'artifact-transformation',
  'artifact_transformation',
  'approval',
  'condition',
  'notification',
  'deployment',
] as const;

export type PipelineStageType = (typeof PIPELINE_STAGE_TYPES)[number];
export type PipelineStageStatus = 'queued' | 'running' | 'completed' | 'failed' | 'skipped';
export type PipelineRunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

type JsonRecord = Record<string, JsonValue>;
export type PipelineInputs = Readonly<Record<string, JsonValue>>;

export interface PipelineRetryPolicyV1 {
  readonly maxAttempts: number;
  readonly backoffMs: number;
  readonly maxBackoffMs: number;
}

export interface PipelineStageV1 {
  readonly stageId: string;
  readonly label: string;
  readonly type: PipelineStageType;
  readonly dependsOn: readonly string[];
  readonly config: JsonRecord;
  readonly retryPolicy?: PipelineRetryPolicyV1;
  readonly cache?: boolean;
}

export interface PipelineDefinitionV1 {
  readonly schemaVersion: 1;
  readonly pipelineId: string;
  readonly name: string;
  readonly version: number;
  readonly stages: readonly PipelineStageV1[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly publishedVersion?: number;
  readonly publishedAt?: string;
  readonly sourcePath?: string;
  readonly sourceHash?: string;
}

export interface PipelineVersionV1 {
  readonly pipelineId: string;
  readonly version: number;
  readonly digest: string;
  readonly definition: PipelineDefinitionV1;
  readonly createdAt: string;
  readonly publishedAt?: string;
}

export interface PipelineNodeLogV1 {
  readonly stageId: string;
  readonly attempt: number;
  readonly level: 'info' | 'warn' | 'error';
  readonly message: string;
  readonly occurredAt: string;
}

export interface PipelineResourceUsageV1 {
  readonly durationMs: number;
  readonly costMinor: number;
  readonly resourceUsage: Readonly<Record<string, number>>;
}

export interface PipelineStageResultV1 {
  readonly stageId: string;
  readonly status: PipelineStageStatus;
  readonly attempt?: number;
  readonly cacheHit?: boolean;
  readonly dependencyFailure?: boolean;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly input?: JsonValue;
  readonly output?: JsonValue;
  readonly artifactIds?: readonly string[];
  readonly costMinor?: number;
  readonly resourceUsage?: Readonly<Record<string, number>>;
  readonly logs?: readonly PipelineNodeLogV1[];
  readonly error?: string;
}

export interface PipelineRunV1 {
  readonly runId: string;
  readonly pipelineId: string;
  readonly version: number;
  readonly status: PipelineRunStatus;
  readonly stageResults: readonly PipelineStageResultV1[];
  readonly inputs: PipelineInputs;
  readonly outputs: Readonly<Record<string, JsonValue>>;
  readonly artifacts: readonly string[];
  readonly nodeLogs: readonly PipelineNodeLogV1[];
  readonly usage: PipelineResourceUsageV1;
  readonly idempotencyKey?: string;
  readonly dryRun?: boolean;
  readonly retryOfRunId?: string;
  readonly retryStageId?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly error?: string;
}

export interface PipelineValidationResultV1 {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly executionOrder: readonly string[];
}

export interface PipelinePlanV1 {
  readonly pipelineId: string;
  readonly version: number;
  readonly digest: string;
  readonly executionOrder: readonly string[];
  readonly stages: readonly Pick<PipelineStageV1, 'stageId' | 'type' | 'dependsOn'>[];
  readonly generatedAt: string;
}

export interface PipelineEstimateV1 {
  readonly pipelineId: string;
  readonly version: number;
  readonly digest: string;
  readonly durationMs: number;
  readonly costMinor: number;
  readonly stages: readonly {
    readonly stageId: string;
    readonly type: PipelineStageType;
    readonly durationMs: number;
    readonly costMinor: number;
  }[];
  readonly generatedAt: string;
}

export interface PipelineRunInput {
  readonly inputs?: PipelineInputs;
  readonly version?: number | 'published';
  readonly idempotencyKey?: string;
  readonly dryRun?: boolean;
  readonly forceStages?: readonly string[];
  readonly retryOfRunId?: string;
  readonly retryStageId?: string;
}

export interface PipelineStageAdapterContext {
  readonly pipelineId: string;
  readonly version: number;
  readonly runId: string;
  readonly stage: PipelineStageV1;
  readonly inputs: PipelineInputs;
  readonly outputs: Readonly<Record<string, JsonValue>>;
  readonly dryRun: boolean;
}

export interface PipelineStageAdapterResult {
  readonly output: JsonValue;
  readonly artifactIds?: readonly string[];
  readonly costMinor?: number;
  readonly resourceUsage?: Readonly<Record<string, number>>;
  readonly status?: 'completed' | 'awaiting_approval';
}

export interface PipelineStageAdapter {
  readonly type: PipelineStageType;
  readonly version: string;
  readonly validate?: (stage: PipelineStageV1) => readonly string[];
  readonly execute: (context: PipelineStageAdapterContext) => Promise<PipelineStageAdapterResult>;
}

export interface PipelineRuntime {
  list(): Promise<readonly PipelineDefinitionV1[]>;
  get(pipelineId: string): Promise<PipelineDefinitionV1 | undefined>;
  create(pipelineId: string, name?: string): Promise<PipelineDefinitionV1>;
  upsert(definition: PipelineDefinitionV1): Promise<PipelineDefinitionV1>;
  publish(pipelineId: string, version?: number): Promise<PipelineVersionV1>;
  listVersions(pipelineId: string): Promise<readonly PipelineVersionV1[]>;
  getVersion(pipelineId: string, version: number): Promise<PipelineVersionV1 | undefined>;
  loadFile(path: string): Promise<PipelineDefinitionV1>;
  saveFile(pipelineId: string, path?: string): Promise<{ path: string; contentHash: string }>;
  validate(definition: PipelineDefinitionV1): PipelineValidationResultV1;
  plan(pipelineId: string, version?: number | 'published'): Promise<PipelinePlanV1>;
  estimate(pipelineId: string, version?: number | 'published'): Promise<PipelineEstimateV1>;
  dryRun(pipelineId: string, input?: PipelineRunInput): Promise<PipelineRunV1>;
  run(pipelineId: string, input?: PipelineRunInput): Promise<PipelineRunV1>;
  retryStage(runId: string, stageId: string): Promise<PipelineRunV1>;
  getRun(runId: string): Promise<PipelineRunV1 | undefined>;
  cancel(runId: string): boolean;
  listRuns(pipelineId?: string): Promise<readonly PipelineRunV1[]>;
}

interface PipelineCacheRecord {
  readonly cacheKey: string;
  readonly pipelineId: string;
  readonly version: number;
  readonly stageId: string;
  readonly result: PipelineStageResultV1;
  readonly createdAt: string;
}

interface PipelineState {
  readonly definitions: PipelineDefinitionV1[];
  readonly versions: PipelineVersionV1[];
  readonly runs: PipelineRunV1[];
  readonly cache: PipelineCacheRecord[];
}

interface RunningPipeline {
  cancelled: boolean;
}

function isRecord(value: JsonValue | undefined): value is JsonRecord {
  return (
    value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
  );
}

function stringConfig(config: JsonRecord, key: string): string | undefined {
  const value = config[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function numberConfig(config: JsonRecord, key: string, fallback: number): number {
  const value = config[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function stringArrayConfig(config: JsonRecord, key: string): string[] {
  const value = config[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function stageOutput(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function digestDefinition(definition: PipelineDefinitionV1): string {
  const canonical = JSON.stringify({
    schemaVersion: definition.schemaVersion,
    pipelineId: definition.pipelineId,
    name: definition.name,
    version: definition.version,
    stages: definition.stages,
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function validStageType(value: string): value is PipelineStageType {
  return (PIPELINE_STAGE_TYPES as readonly string[]).includes(value);
}

function elapsedMs(startedAt: string | undefined, completedAt: string | undefined): number {
  if (startedAt === undefined || completedAt === undefined) return 0;
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
}

function defaultRetryPolicy(policy: PipelineRetryPolicyV1 | undefined): PipelineRetryPolicyV1 {
  return policy ?? { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 };
}

export interface LocalPipelineRuntimeOptions {
  readonly rootPath: string;
  readonly query: QueryRuntime;
  readonly notebooks: NotebookRuntime;
  readonly connectors: MeltanoConnectorRuntime;
  readonly clock?: () => string;
  readonly adapters?: readonly PipelineStageAdapter[];
}

/**
 * Executes typed local stages and persists the complete pipeline control plane. Typed pipeline
 * definitions are the source format; JSON files are the portable serialization of that config.
 */
export class LocalPipelineRuntime implements PipelineRuntime {
  private readonly statePath: string;
  private readonly rootPath: string;
  private readonly clock: () => string;
  private readonly query: QueryRuntime;
  private readonly notebooks: NotebookRuntime;
  private readonly connectors: MeltanoConnectorRuntime;
  private readonly adapters = new Map<PipelineStageType, PipelineStageAdapter>();
  private readonly stateLocks = new Map<string, Promise<void>>();
  private state: PipelineState | undefined;
  private loading: Promise<void> | undefined;
  private readonly running = new Map<string, RunningPipeline>();

  constructor(options: LocalPipelineRuntimeOptions) {
    this.rootPath = options.rootPath;
    this.statePath = join(options.rootPath, '.agentic', 'pipelines.json');
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.query = options.query;
    this.notebooks = options.notebooks;
    this.connectors = options.connectors;
    this.registerBuiltInAdapters();
    for (const adapter of options.adapters ?? []) this.registerAdapter(adapter);
  }

  registerAdapter(adapter: PipelineStageAdapter): void {
    this.adapters.set(adapter.type, adapter);
  }

  async list(): Promise<readonly PipelineDefinitionV1[]> {
    await this.ensureLoaded();
    return clone(this.state?.definitions ?? []);
  }

  async get(pipelineId: string): Promise<PipelineDefinitionV1 | undefined> {
    await this.ensureLoaded();
    const definition = this.state?.definitions.find((item) => item.pipelineId === pipelineId);
    return definition === undefined ? undefined : clone(definition);
  }

  async create(pipelineId: string, name = 'Untitled pipeline'): Promise<PipelineDefinitionV1> {
    await this.ensureLoaded();
    if (this.state?.definitions.some((item) => item.pipelineId === pipelineId)) {
      throw runtimeError('CONCURRENCY_STALE_VERSION', `Pipeline ${pipelineId} already exists`);
    }
    const now = this.clock();
    const definition: PipelineDefinitionV1 = {
      schemaVersion: 1,
      pipelineId,
      name: name.trim() || 'Untitled pipeline',
      version: 1,
      stages: [],
      createdAt: now,
      updatedAt: now,
    };
    this.state?.definitions.push(definition);
    await this.persist();
    return clone(definition);
  }

  async upsert(definition: PipelineDefinitionV1): Promise<PipelineDefinitionV1> {
    const validation = this.validate(definition);
    if (!validation.valid) {
      throw runtimeError('VALIDATION_INVALID_INPUT', validation.errors.join('; '));
    }
    await this.ensureLoaded();
    const index =
      this.state?.definitions.findIndex((item) => item.pipelineId === definition.pipelineId) ?? -1;
    const now = this.clock();
    const previous = index < 0 ? undefined : this.state?.definitions[index];
    if (previous !== undefined) this.recordVersion(previous);
    const next: PipelineDefinitionV1 = {
      ...clone(definition),
      version: index < 0 ? Math.max(1, definition.version) : (previous?.version ?? 0) + 1,
      updatedAt: now,
    };
    if (index < 0) this.state?.definitions.push(next);
    else if (this.state) this.state.definitions[index] = next;
    await this.persist();
    return clone(next);
  }

  async publish(pipelineId: string, version?: number): Promise<PipelineVersionV1> {
    await this.ensureLoaded();
    const definition = await this.resolveDefinition(pipelineId, version);
    const validation = this.validate(definition);
    if (!validation.valid) {
      throw runtimeError('VALIDATION_INVALID_INPUT', validation.errors.join('; '));
    }
    const publishedAt = this.clock();
    const published: PipelineVersionV1 = {
      pipelineId,
      version: definition.version,
      digest: digestDefinition(definition),
      definition: clone(definition),
      createdAt: definition.updatedAt,
      publishedAt,
    };
    this.saveVersionRecord(published);
    const currentIndex =
      this.state?.definitions.findIndex((item) => item.pipelineId === pipelineId) ?? -1;
    const currentDefinition = this.state?.definitions[currentIndex];
    if (currentDefinition !== undefined && this.state) {
      this.state.definitions[currentIndex] = {
        ...currentDefinition,
        publishedVersion: definition.version,
        publishedAt,
        updatedAt: publishedAt,
      };
    }
    await this.persist();
    return clone(published);
  }

  async listVersions(pipelineId: string): Promise<readonly PipelineVersionV1[]> {
    await this.ensureLoaded();
    const current = this.state?.definitions.find((item) => item.pipelineId === pipelineId);
    const versions = (this.state?.versions ?? []).filter((item) => item.pipelineId === pipelineId);
    if (current !== undefined && !versions.some((item) => item.version === current.version)) {
      versions.push({
        pipelineId,
        version: current.version,
        digest: digestDefinition(current),
        definition: clone(current),
        createdAt: current.updatedAt,
        ...(current.publishedAt === undefined ? {} : { publishedAt: current.publishedAt }),
      });
    }
    return clone(versions.sort((left, right) => right.version - left.version));
  }

  async getVersion(pipelineId: string, version: number): Promise<PipelineVersionV1 | undefined> {
    const versions = await this.listVersions(pipelineId);
    return versions.find((item) => item.version === version);
  }

  async loadFile(path: string): Promise<PipelineDefinitionV1> {
    const filePath = this.safeSourcePath(path);
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (error) {
      throw runtimeError(
        'ARTIFACT_NOT_FOUND',
        `Pipeline source could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (Buffer.byteLength(raw, 'utf8') > 2 * 1024 * 1024) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Pipeline source exceeds the 2 MB limit');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw runtimeError(
        'VALIDATION_SCHEMA_MISMATCH',
        'Pipeline source must be valid JSON typed configuration',
      );
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Pipeline source must contain an object');
    }
    const candidate = parsed as Partial<PipelineDefinitionV1>;
    const definition: PipelineDefinitionV1 = {
      ...candidate,
      pipelineId: typeof candidate.pipelineId === 'string' ? candidate.pipelineId : '',
      name: typeof candidate.name === 'string' ? candidate.name : '',
      schemaVersion: candidate.schemaVersion ?? 1,
      version:
        candidate.version !== undefined && Number.isSafeInteger(candidate.version)
          ? candidate.version
          : 1,
      createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : this.clock(),
      updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : this.clock(),
      stages: Array.isArray(candidate.stages) ? candidate.stages : [],
      sourcePath: filePath,
      sourceHash: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
    };
    return this.upsert(definition);
  }

  async saveFile(
    pipelineId: string,
    path?: string,
  ): Promise<{ path: string; contentHash: string }> {
    const definition = await this.get(pipelineId);
    if (definition === undefined) {
      throw runtimeError('ARTIFACT_NOT_FOUND', `Pipeline ${pipelineId} was not found`);
    }
    const filePath = this.safeSourcePath(
      path ?? definition.sourcePath ?? `${pipelineId}.pipeline.json`,
    );
    const serializable = {
      schemaVersion: definition.schemaVersion,
      pipelineId: definition.pipelineId,
      name: definition.name,
      version: definition.version,
      stages: definition.stages,
      createdAt: definition.createdAt,
      updatedAt: definition.updatedAt,
      ...(definition.publishedVersion === undefined
        ? {}
        : { publishedVersion: definition.publishedVersion }),
      ...(definition.publishedAt === undefined ? {} : { publishedAt: definition.publishedAt }),
    };
    const raw = `${JSON.stringify(serializable, null, 2)}\n`;
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, raw, { mode: 0o600 });
    const contentHash = `sha256:${createHash('sha256').update(raw).digest('hex')}`;
    await this.replaceDefinition({
      ...definition,
      sourcePath: filePath,
      sourceHash: contentHash,
    });
    return { path: filePath, contentHash };
  }

  validate(definition: PipelineDefinitionV1): PipelineValidationResultV1 {
    const errors: string[] = [];
    const candidate = definition as unknown as Record<string, unknown>;
    if (candidate['schemaVersion'] !== 1) errors.push('Pipeline schemaVersion must be 1');
    const pipelineId = typeof candidate['pipelineId'] === 'string' ? candidate['pipelineId'] : '';
    const name = typeof candidate['name'] === 'string' ? candidate['name'] : '';
    if (!pipelineId.trim()) errors.push('Pipeline pipelineId is required');
    if (!name.trim()) errors.push('Pipeline name is required');
    const rawStages = Array.isArray(candidate['stages']) ? candidate['stages'] : [];
    if (!Array.isArray(candidate['stages'])) errors.push('Pipeline stages must be an array');
    if (rawStages.length > 64) errors.push('Pipelines may contain at most 64 stages');
    const stages = new Map<string, PipelineStageV1>();
    for (const rawStage of rawStages) {
      if (rawStage === null || typeof rawStage !== 'object' || Array.isArray(rawStage)) {
        errors.push('Every pipeline stage must be an object');
        continue;
      }
      const stage = rawStage as Partial<PipelineStageV1>;
      const stageId = typeof stage.stageId === 'string' ? stage.stageId : '';
      const label = typeof stage.label === 'string' ? stage.label : '';
      const type = typeof stage.type === 'string' ? stage.type : '';
      const dependencies = Array.isArray(stage.dependsOn)
        ? stage.dependsOn.filter(
            (dependency): dependency is string => typeof dependency === 'string',
          )
        : [];
      if (!stageId.trim()) errors.push('Every stage requires a stageId');
      if (stageId.length > 160)
        errors.push(`Stage ${stageId || '<unknown>'} has an invalid stageId`);
      if (stages.has(stageId)) errors.push(`Duplicate stage ${stageId}`);
      if (stageId) stages.set(stageId, stage as PipelineStageV1);
      if (!label.trim()) errors.push(`Stage ${stageId || '<unknown>'} requires a label`);
      if (!isRecord(stage.config as JsonValue | undefined)) {
        errors.push(`Stage ${stageId || '<unknown>'} config must be an object`);
      }
      const config = isRecord(stage.config as JsonValue | undefined)
        ? (stage.config as JsonRecord)
        : {};
      if ((type === 'query' || type === 'sql') && stringConfig(config, 'sql') === undefined) {
        errors.push(`SQL stage ${stageId} requires config.sql`);
      }
      if (type === 'python' && stringConfig(config, 'source') === undefined) {
        errors.push(`Python stage ${stageId} requires config.source`);
      }
      if (type === 'notebook') {
        for (const key of ['notebookId', 'cellId', 'source']) {
          if (stringConfig(config, key) === undefined)
            errors.push(`Notebook stage ${stageId} requires config.${key}`);
        }
      }
      if (type === 'connector') {
        for (const key of ['connectorId', 'connectionId', 'operation']) {
          if (stringConfig(config, key) === undefined)
            errors.push(`Connector stage ${stageId} requires config.${key}`);
        }
        const connectorId = stringConfig(config, 'connectorId');
        if (connectorId !== undefined && this.connectors.registry.get(connectorId) === undefined) {
          errors.push(`Connector stage ${stageId} references an unregistered connector`);
        }
      }
      if (!validStageType(type)) {
        errors.push(`Stage ${stageId || '<unknown>'} has an unsupported type`);
      } else {
        const adapter = this.adapters.get(type);
        if (adapter === undefined) errors.push(`Stage ${stageId} has no registered adapter`);
        else if (adapter.validate !== undefined)
          errors.push(...adapter.validate(stage as PipelineStageV1));
      }
      if (stage.retryPolicy !== undefined)
        errors.push(...this.validateRetryPolicy(stage.retryPolicy, stageId));
      if (!Array.isArray(stage.dependsOn)) {
        errors.push(`Stage ${stageId || '<unknown>'} dependsOn must be an array`);
      }
      if (new Set(dependencies).size !== dependencies.length) {
        errors.push(`Stage ${stageId || '<unknown>'} contains duplicate dependencies`);
      }
      for (const dependency of dependencies) {
        if (
          !stages.has(dependency) &&
          !rawStages.some(
            (item) =>
              item !== null &&
              typeof item === 'object' &&
              !Array.isArray(item) &&
              (item as Record<string, unknown>)['stageId'] === dependency,
          )
        ) {
          errors.push(`Stage ${stageId} depends on missing stage ${dependency}`);
        }
      }
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const order: string[] = [];
    const visit = (stageId: string): void => {
      if (visiting.has(stageId)) {
        errors.push(`Pipeline dependency cycle includes ${stageId}`);
        return;
      }
      if (visited.has(stageId)) return;
      const stage = stages.get(stageId);
      if (!stage) return;
      visiting.add(stageId);
      const dependencies = Array.isArray(stage.dependsOn) ? stage.dependsOn : [];
      for (const dependency of dependencies) visit(dependency);
      visiting.delete(stageId);
      visited.add(stageId);
      order.push(stageId);
    };
    for (const stage of rawStages) {
      if (stage !== null && typeof stage === 'object' && !Array.isArray(stage)) {
        const stageId = (stage as Record<string, unknown>)['stageId'];
        if (typeof stageId === 'string') visit(stageId);
      }
    }
    return { valid: errors.length === 0, errors: [...new Set(errors)], executionOrder: order };
  }

  async plan(pipelineId: string, version?: number | 'published'): Promise<PipelinePlanV1> {
    const definition = await this.resolveDefinition(pipelineId, version);
    const validation = this.validate(definition);
    if (!validation.valid) {
      throw runtimeError('VALIDATION_INVALID_INPUT', validation.errors.join('; '));
    }
    return {
      pipelineId: definition.pipelineId,
      version: definition.version,
      digest: digestDefinition(definition),
      executionOrder: validation.executionOrder,
      stages: definition.stages.map(({ stageId, type, dependsOn }) => ({
        stageId,
        type,
        dependsOn,
      })),
      generatedAt: this.clock(),
    };
  }

  async estimate(pipelineId: string, version?: number | 'published'): Promise<PipelineEstimateV1> {
    const definition = await this.resolveDefinition(pipelineId, version);
    const plan = await this.plan(pipelineId, version);
    const stages = plan.executionOrder.flatMap((stageId) => {
      const stage = definition.stages.find((item) => item.stageId === stageId);
      if (stage === undefined) return [];
      return [
        {
          stageId,
          type: stage.type,
          durationMs: numberConfig(stage.config, 'estimatedDurationMs', 50),
          costMinor: numberConfig(stage.config, 'estimatedCostMinor', 0),
        },
      ];
    });
    return {
      pipelineId,
      version: definition.version,
      digest: plan.digest,
      durationMs: stages.reduce((total, stage) => total + stage.durationMs, 0),
      costMinor: stages.reduce((total, stage) => total + stage.costMinor, 0),
      stages,
      generatedAt: this.clock(),
    };
  }

  async dryRun(pipelineId: string, input: PipelineRunInput = {}): Promise<PipelineRunV1> {
    return this.run(pipelineId, { ...input, dryRun: true });
  }

  async run(pipelineId: string, input: PipelineRunInput = {}): Promise<PipelineRunV1> {
    const idempotencyKey = input.idempotencyKey?.trim();
    if (
      idempotencyKey !== undefined &&
      (idempotencyKey.length === 0 || idempotencyKey.length > 200)
    ) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Pipeline idempotencyKey is invalid');
    }
    return this.withStateLock(`run:${pipelineId}`, async () => {
      await this.ensureLoaded();
      if (idempotencyKey !== undefined) {
        const existing = this.state?.runs.find(
          (run) => run.pipelineId === pipelineId && run.idempotencyKey === idempotencyKey,
        );
        if (existing !== undefined) return clone(existing);
      }
      const definition = await this.resolveDefinition(pipelineId, input.version);
      const validation = this.validate(definition);
      if (!validation.valid) {
        throw runtimeError('VALIDATION_INVALID_INPUT', validation.errors.join('; '));
      }
      const now = this.clock();
      const run: PipelineRunV1 = {
        runId: `pipeline-run-${randomUUID()}`,
        pipelineId,
        version: definition.version,
        status: 'running',
        stageResults: validation.executionOrder.map((stageId) => ({ stageId, status: 'queued' })),
        inputs: clone(input.inputs ?? {}),
        outputs: {},
        artifacts: [],
        nodeLogs: [],
        usage: { durationMs: 0, costMinor: 0, resourceUsage: {} },
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        ...(input.dryRun === true ? { dryRun: true } : {}),
        ...(input.retryOfRunId === undefined ? {} : { retryOfRunId: input.retryOfRunId }),
        ...(input.retryStageId === undefined ? {} : { retryStageId: input.retryStageId }),
        startedAt: now,
      };
      this.running.set(run.runId, { cancelled: false });
      await this.saveRun(run);
      try {
        return await this.executeRun(definition, validation.executionOrder, run, input);
      } finally {
        this.running.delete(run.runId);
      }
    });
  }

  async retryStage(runId: string, stageId: string): Promise<PipelineRunV1> {
    const run = await this.getRun(runId);
    if (run === undefined)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Pipeline run ${runId} was not found`);
    const stage = run.stageResults.find((item) => item.stageId === stageId);
    if (stage === undefined)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Pipeline stage ${stageId} was not found`);
    if (stage.status !== 'failed') {
      throw runtimeError('VALIDATION_INVALID_INPUT', `Pipeline stage ${stageId} is not failed`);
    }
    return this.run(run.pipelineId, {
      inputs: run.inputs,
      version: run.version,
      idempotencyKey: `retry:${runId}:${stageId}`,
      forceStages: [stageId],
      retryOfRunId: runId,
      retryStageId: stageId,
    });
  }

  async getRun(runId: string): Promise<PipelineRunV1 | undefined> {
    await this.ensureLoaded();
    const run = this.state?.runs.find((item) => item.runId === runId);
    return run === undefined ? undefined : clone(run);
  }

  cancel(runId: string): boolean {
    const control = this.running.get(runId);
    if (!control) return false;
    control.cancelled = true;
    return true;
  }

  async listRuns(pipelineId?: string): Promise<readonly PipelineRunV1[]> {
    await this.ensureLoaded();
    return clone(
      (this.state?.runs ?? []).filter(
        (run) => pipelineId === undefined || run.pipelineId === pipelineId,
      ),
    );
  }

  private registerBuiltInAdapters(): void {
    const sqlAdapter: PipelineStageAdapter = {
      type: 'query',
      version: 'local-query.v1',
      execute: async (context) => {
        const result = await this.query.execute({
          queryId: `${context.runId}:${context.stage.stageId}`,
          sql: stringConfig(context.stage.config, 'sql') ?? '',
          ...(isRecord(context.stage.config['source'])
            ? { source: context.stage.config['source'] as unknown as QuerySource }
            : {}),
        });
        return { output: stageOutput(result) };
      },
    };
    this.adapters.set('query', sqlAdapter);
    this.adapters.set('sql', { ...sqlAdapter, type: 'sql' });
    this.adapters.set('notebook', {
      type: 'notebook',
      version: 'local-notebook.v1',
      execute: async (context) => {
        const type = stringConfig(context.stage.config, 'type');
        if (type !== 'markdown' && type !== 'python' && type !== 'sql') {
          throw runtimeError(
            'VALIDATION_INVALID_INPUT',
            `Notebook stage ${context.stage.stageId} has an invalid cell type`,
          );
        }
        const result = await this.notebooks.runCell({
          notebookId: stringConfig(context.stage.config, 'notebookId') ?? '',
          cellId: stringConfig(context.stage.config, 'cellId') ?? '',
          type: type as NotebookCellType,
          source: stringConfig(context.stage.config, 'source') ?? '',
        });
        return { output: stageOutput(result) };
      },
    });
    this.adapters.set('connector', {
      type: 'connector',
      version: 'curated-connector.v1',
      execute: async (context) => {
        const connectorId = stringConfig(context.stage.config, 'connectorId') ?? '';
        const connectionId = stringConfig(context.stage.config, 'connectionId') ?? '';
        const operation = stringConfig(context.stage.config, 'operation') ?? '';
        const manifest = this.connectors.registry.require(connectorId);
        const resources = stringArrayConfig(context.stage.config, 'resources');
        const schemaSelection = stringArrayConfig(context.stage.config, 'schemaSelection');
        const syncMode = stringConfig(context.stage.config, 'syncMode');
        const destination = stringConfig(context.stage.config, 'destination');
        const now = this.clock();
        const result = await this.connectors.execute({
          manifest,
          binding: {
            bindingId:
              stringConfig(context.stage.config, 'bindingId') ??
              `pipeline-binding-${context.runId}-${context.stage.stageId}`,
            connectorId,
            connectionId,
            resources:
              resources.length > 0 ? resources : manifest.resources.map((item) => item.resourceId),
            ...(schemaSelection.length === 0 ? {} : { schemaSelection }),
            ...(syncMode === 'full' || syncMode === 'incremental' ? { syncMode } : {}),
            ...(destination === undefined ? {} : { destination }),
            createdAt: now,
            updatedAt: now,
          },
          operation,
        });
        return {
          output: stageOutput(result),
          artifactIds: result.artifactIds,
          resourceUsage: result.metrics,
        };
      },
    });
    const genericTypes: readonly PipelineStageType[] = [
      'python',
      'inference',
      'training',
      'evaluation',
      'visualization',
      'artifact-transformation',
      'artifact_transformation',
      'approval',
      'condition',
      'notification',
      'deployment',
    ];
    for (const type of genericTypes) {
      this.adapters.set(type, {
        type,
        version: 'local-typed.v1',
        execute: async (context) => {
          if (context.stage.config['fail'] === true) {
            throw new Error(`Registered ${type} adapter was instructed to fail`);
          }
          return {
            output:
              type === 'approval'
                ? { awaitingApproval: true }
                : {
                    stageId: context.stage.stageId,
                    type,
                    inputs: context.inputs,
                    config: context.stage.config,
                  },
            status: type === 'approval' ? 'awaiting_approval' : 'completed',
            costMinor: numberConfig(context.stage.config, 'estimatedCostMinor', 0),
            resourceUsage: isRecord(context.stage.config['resourceUsage'])
              ? Object.fromEntries(
                  Object.entries(context.stage.config['resourceUsage']).flatMap(([key, value]) =>
                    typeof value === 'number' && Number.isFinite(value) ? [[key, value]] : [],
                  ),
                )
              : {},
          };
        },
      });
    }
  }

  private async executeRun(
    definition: PipelineDefinitionV1,
    executionOrder: readonly string[],
    initial: PipelineRunV1,
    input: PipelineRunInput,
  ): Promise<PipelineRunV1> {
    let current = initial;
    const outputs: Record<string, JsonValue> = {};
    const artifacts: string[] = [];
    const nodeLogs: PipelineNodeLogV1[] = [];
    const forceStages = new Set(input.forceStages ?? []);
    for (const stageId of executionOrder) {
      const control = this.running.get(initial.runId);
      if (control?.cancelled) {
        current = { ...current, status: 'cancelled', completedAt: this.clock() };
        break;
      }
      const stage = definition.stages.find((item) => item.stageId === stageId);
      if (stage === undefined) continue;
      const dependencies = stage.dependsOn.map((dependency) =>
        current.stageResults.find((result) => result.stageId === dependency),
      );
      if (dependencies.some((dependency) => dependency?.status !== 'completed')) {
        const occurredAt = this.clock();
        const log: PipelineNodeLogV1 = {
          stageId,
          attempt: 0,
          level: 'error',
          message: 'Stage skipped because a dependency failed or was not completed',
          occurredAt,
        };
        nodeLogs.push(log);
        current = this.updateStage(current, stageId, {
          status: 'skipped',
          dependencyFailure: true,
          completedAt: occurredAt,
          error: log.message,
          logs: [log],
        });
        continue;
      }
      if (current.dryRun === true) {
        const occurredAt = this.clock();
        const log: PipelineNodeLogV1 = {
          stageId,
          attempt: 0,
          level: 'info',
          message: `Dry-run: ${stage.type} adapter would execute`,
          occurredAt,
        };
        nodeLogs.push(log);
        current = this.updateStage(current, stageId, {
          status: 'skipped',
          completedAt: occurredAt,
          input: current.inputs,
          logs: [log],
        });
        continue;
      }
      const startedAt = this.clock();
      current = this.updateStage(current, stageId, {
        status: 'running',
        startedAt,
        input: current.inputs,
        attempt: 0,
      });
      await this.saveRun(current);
      const cacheKey = this.cacheKey(definition, stage, current.inputs, outputs);
      const canCache =
        stage.cache !== false && !['connector', 'notification', 'deployment'].includes(stage.type);
      if (canCache && !forceStages.has(stageId)) {
        const cached = this.state?.cache.find((entry) => entry.cacheKey === cacheKey);
        if (cached !== undefined) {
          const completedAt = this.clock();
          const result = {
            ...clone(cached.result),
            status: 'completed' as const,
            cacheHit: true,
            startedAt,
            completedAt,
            durationMs: elapsedMs(startedAt, completedAt),
          };
          current = this.updateStage(current, stageId, result);
          if (result.output !== undefined) outputs[stageId] = result.output;
          for (const artifactId of result.artifactIds ?? []) artifacts.push(artifactId);
          await this.saveRun({
            ...current,
            outputs: clone(outputs),
            artifacts: [...new Set(artifacts)],
          });
          continue;
        }
      }
      const adapter = this.adapters.get(stage.type);
      if (adapter === undefined) {
        current = this.failStage(current, stageId, 'No registered adapter is available');
        await this.saveRun(current);
        break;
      }
      const retryPolicy = defaultRetryPolicy(stage.retryPolicy);
      let succeeded = false;
      for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt += 1) {
        const attemptStarted = this.clock();
        const info: PipelineNodeLogV1 = {
          stageId,
          attempt,
          level: 'info',
          message: `Executing ${stage.type} adapter ${adapter.version}`,
          occurredAt: attemptStarted,
        };
        nodeLogs.push(info);
        const priorLogs =
          current.stageResults.find((result) => result.stageId === stageId)?.logs ?? [];
        current = this.updateStage(current, stageId, {
          status: 'running',
          attempt,
          logs: [...priorLogs, info],
        });
        try {
          const adapterResult = await adapter.execute({
            pipelineId: definition.pipelineId,
            version: definition.version,
            runId: initial.runId,
            stage,
            inputs: current.inputs,
            outputs,
            dryRun: false,
          });
          const completedAt = this.clock();
          const output = stageOutput(adapterResult.output);
          const stageArtifacts = [
            ...(adapterResult.artifactIds ?? []),
            ...stringArrayConfig(stage.config, 'artifactIds'),
            ...(stringConfig(stage.config, 'artifactId') === undefined
              ? []
              : [stringConfig(stage.config, 'artifactId') as string]),
          ];
          const result: PipelineStageResultV1 = {
            stageId,
            status: adapterResult.status === 'awaiting_approval' ? 'skipped' : 'completed',
            attempt,
            cacheHit: false,
            startedAt,
            completedAt,
            durationMs: elapsedMs(startedAt, completedAt),
            input: current.inputs,
            output,
            artifactIds: [...new Set(stageArtifacts)],
            costMinor:
              adapterResult.costMinor ?? numberConfig(stage.config, 'estimatedCostMinor', 0),
            resourceUsage: adapterResult.resourceUsage ?? {},
            logs: [
              ...(current.stageResults.find((item) => item.stageId === stageId)?.logs ?? []),
              {
                stageId,
                attempt,
                level: 'info',
                message:
                  adapterResult.status === 'awaiting_approval'
                    ? 'Approval is required'
                    : 'Stage completed',
                occurredAt: completedAt,
              },
            ],
          };
          current = this.updateStage(current, stageId, result);
          outputs[stageId] = output;
          artifacts.push(...stageArtifacts);
          if (canCache)
            this.saveCache({
              cacheKey,
              pipelineId: definition.pipelineId,
              version: definition.version,
              stageId,
              result,
              createdAt: completedAt,
            });
          succeeded = true;
          if (adapterResult.status === 'awaiting_approval') {
            current = { ...current, status: 'awaiting_approval', completedAt };
          }
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const failureLog: PipelineNodeLogV1 = {
            stageId,
            attempt,
            level: 'error',
            message,
            occurredAt: this.clock(),
          };
          nodeLogs.push(failureLog);
          const previousLogs =
            current.stageResults.find((item) => item.stageId === stageId)?.logs ?? [];
          current = this.updateStage(current, stageId, {
            status: 'running',
            attempt,
            logs: [...previousLogs, failureLog],
          });
          if (attempt < retryPolicy.maxAttempts) {
            const delay = Math.min(
              retryPolicy.maxBackoffMs,
              retryPolicy.backoffMs * 2 ** Math.max(0, attempt - 1),
            );
            if (delay > 0)
              await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delay));
          } else {
            current = this.updateStage(current, stageId, {
              status: 'failed',
              completedAt: this.clock(),
              durationMs: elapsedMs(startedAt, this.clock()),
              error: message,
              logs: [...previousLogs, failureLog],
            });
          }
          await this.saveRun(current);
        }
      }
      if (!succeeded) {
        const failedError = current.stageResults.find((item) => item.stageId === stageId)?.error;
        current = {
          ...current,
          status: 'failed',
          completedAt: this.clock(),
          ...(failedError === undefined ? {} : { error: failedError }),
        };
        for (const remainingId of executionOrder.slice(executionOrder.indexOf(stageId) + 1)) {
          if (
            current.stageResults.find((item) => item.stageId === remainingId)?.status !== 'queued'
          )
            continue;
          current = this.updateStage(current, remainingId, {
            status: 'skipped',
            dependencyFailure: true,
            completedAt: current.completedAt ?? this.clock(),
            error: `Dependency ${stageId} failed`,
          });
        }
        break;
      }
      await this.saveRun({
        ...current,
        outputs: clone(outputs),
        artifacts: [...new Set(artifacts)],
        nodeLogs: clone(nodeLogs),
      });
      if (current.status === 'awaiting_approval') break;
    }
    if (current.status === 'running')
      current = { ...current, status: 'completed', completedAt: this.clock() };
    const completedAt = current.completedAt ?? this.clock();
    const stageCost = current.stageResults.reduce(
      (total, result) => total + (result.costMinor ?? 0),
      0,
    );
    const resources: Record<string, number> = {};
    for (const result of current.stageResults) {
      for (const [key, value] of Object.entries(result.resourceUsage ?? {}))
        resources[key] = (resources[key] ?? 0) + value;
    }
    current = {
      ...current,
      outputs: clone(outputs),
      artifacts: [...new Set(artifacts)],
      nodeLogs: clone(nodeLogs),
      completedAt,
      usage: {
        durationMs: elapsedMs(current.startedAt, completedAt),
        costMinor: stageCost,
        resourceUsage: resources,
      },
    };
    await this.saveRun(current);
    return clone(current);
  }

  private failStage(run: PipelineRunV1, stageId: string, message: string): PipelineRunV1 {
    return {
      ...this.updateStage(run, stageId, {
        status: 'failed',
        completedAt: this.clock(),
        error: message,
      }),
      status: 'failed',
      completedAt: this.clock(),
      error: message,
    };
  }

  private updateStage(
    run: PipelineRunV1,
    stageId: string,
    patch: Partial<PipelineStageResultV1>,
  ): PipelineRunV1 {
    return {
      ...run,
      stageResults: run.stageResults.map((item) =>
        item.stageId === stageId ? { ...item, ...patch } : item,
      ),
    };
  }

  private cacheKey(
    definition: PipelineDefinitionV1,
    stage: PipelineStageV1,
    inputs: PipelineInputs,
    outputs: Readonly<Record<string, JsonValue>>,
  ): string {
    return `sha256:${createHash('sha256')
      .update(
        JSON.stringify({
          pipelineId: definition.pipelineId,
          version: definition.version,
          stage,
          inputs,
          outputs,
        }),
      )
      .digest('hex')}`;
  }

  private saveCache(record: PipelineCacheRecord): void {
    if (this.state === undefined) return;
    const index = this.state.cache.findIndex((item) => item.cacheKey === record.cacheKey);
    if (index < 0) this.state.cache.push(record);
    else this.state.cache[index] = record;
  }

  private async saveRun(run: PipelineRunV1): Promise<void> {
    await this.ensureLoaded();
    const index = this.state?.runs.findIndex((item) => item.runId === run.runId) ?? -1;
    if (index < 0) this.state?.runs.push(run);
    else if (this.state) this.state.runs[index] = run;
    await this.persist();
  }

  private recordVersion(definition: PipelineDefinitionV1): void {
    this.saveVersionRecord({
      pipelineId: definition.pipelineId,
      version: definition.version,
      digest: digestDefinition(definition),
      definition: clone(definition),
      createdAt: definition.updatedAt,
      ...(definition.publishedAt === undefined ? {} : { publishedAt: definition.publishedAt }),
    });
  }

  private saveVersionRecord(version: PipelineVersionV1): void {
    if (this.state === undefined) return;
    const index = this.state.versions.findIndex(
      (item) => item.pipelineId === version.pipelineId && item.version === version.version,
    );
    if (index < 0) this.state.versions.push(version);
    else this.state.versions[index] = version;
  }

  private async resolveDefinition(
    pipelineId: string,
    version?: number | 'published',
  ): Promise<PipelineDefinitionV1> {
    await this.ensureLoaded();
    const current = this.state?.definitions.find((item) => item.pipelineId === pipelineId);
    if (current === undefined)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Pipeline ${pipelineId} was not found`);
    if (version === undefined) return clone(current);
    const requested = version === 'published' ? current.publishedVersion : version;
    if (requested === undefined)
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        `Pipeline ${pipelineId} has no published version`,
      );
    if (requested === current.version) return clone(current);
    const historical = this.state?.versions.find(
      (item) => item.pipelineId === pipelineId && item.version === requested,
    );
    if (historical === undefined)
      throw runtimeError(
        'ARTIFACT_NOT_FOUND',
        `Pipeline ${pipelineId} version ${requested} was not found`,
      );
    return clone(historical.definition);
  }

  private async replaceDefinition(definition: PipelineDefinitionV1): Promise<void> {
    await this.ensureLoaded();
    const index =
      this.state?.definitions.findIndex((item) => item.pipelineId === definition.pipelineId) ?? -1;
    if (index < 0) {
      throw runtimeError('ARTIFACT_NOT_FOUND', `Pipeline ${definition.pipelineId} was not found`);
    }
    if (this.state) this.state.definitions[index] = definition;
    await this.persist();
  }

  private validateRetryPolicy(policy: PipelineRetryPolicyV1, stageId: string): string[] {
    const errors: string[] = [];
    if (
      !Number.isSafeInteger(policy.maxAttempts) ||
      policy.maxAttempts < 1 ||
      policy.maxAttempts > 10
    ) {
      errors.push(`Stage ${stageId} retryPolicy.maxAttempts must be between 1 and 10`);
    }
    if (
      !Number.isSafeInteger(policy.backoffMs) ||
      policy.backoffMs < 0 ||
      policy.backoffMs > 3_600_000
    ) {
      errors.push(`Stage ${stageId} retryPolicy.backoffMs is invalid`);
    }
    if (
      !Number.isSafeInteger(policy.maxBackoffMs) ||
      policy.maxBackoffMs < policy.backoffMs ||
      policy.maxBackoffMs > 3_600_000
    ) {
      errors.push(`Stage ${stageId} retryPolicy.maxBackoffMs is invalid`);
    }
    return errors;
  }

  private async withStateLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.stateLocks.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolveCurrent) => {
      release = resolveCurrent;
    });
    const chain = previous.then(() => current);
    this.stateLocks.set(key, chain);
    await previous;
    try {
      return await action();
    } finally {
      release?.();
      if (this.stateLocks.get(key) === chain) this.stateLocks.delete(key);
    }
  }

  private safeSourcePath(path: string): string {
    const candidate = isAbsolute(path) ? path : join(this.rootPath, path);
    const resolved = resolve(candidate);
    const root = resolve(this.rootPath);
    const relativePath = relative(root, resolved);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw runtimeError('POLICY_DENIED', 'Pipeline source must stay inside the workspace');
    }
    return resolved;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.state) return;
    this.loading ??= (async () => {
      try {
        const raw = JSON.parse(await readFile(this.statePath, 'utf8')) as Partial<PipelineState>;
        this.state = {
          definitions: Array.isArray(raw.definitions) ? raw.definitions : [],
          versions: Array.isArray(raw.versions) ? raw.versions : [],
          runs: Array.isArray(raw.runs)
            ? raw.runs.map((run) => ({
                ...run,
                version: run.version ?? 1,
                inputs: run.inputs ?? {},
                outputs: run.outputs ?? {},
                artifacts: run.artifacts ?? [],
                nodeLogs: run.nodeLogs ?? [],
                usage: run.usage ?? { durationMs: 0, costMinor: 0, resourceUsage: {} },
              }))
            : [],
          cache: Array.isArray(raw.cache) ? raw.cache : [],
        };
      } catch {
        this.state = { definitions: [], versions: [], runs: [], cache: [] };
      }
    })();
    await this.loading;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    await writeFile(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
  }
}
