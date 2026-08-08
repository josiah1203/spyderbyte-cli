import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runtimeError, type JsonValue } from '@agentic-platform/runtime-contracts';

const execFileAsync = promisify(execFile);

export interface TrainingRunRequestV1 {
  readonly runId?: string;
  readonly datasetArtifactId?: string;
  readonly modelId?: string;
  readonly configuration: Record<string, JsonValue>;
  readonly timeoutMs?: number;
}

export interface TrainingRunV1 {
  readonly runId: string;
  readonly status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  readonly datasetArtifactId?: string;
  readonly modelId?: string;
  readonly configuration: Record<string, JsonValue>;
  readonly metrics: Record<string, number>;
  readonly checkpointArtifacts: readonly string[];
  readonly modelArtifactId?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly error?: string;
}

export interface TrainingRuntime {
  readonly available: boolean;
  list(): Promise<readonly TrainingRunV1[]>;
  get(runId: string): Promise<TrainingRunV1 | undefined>;
  train(request: TrainingRunRequestV1): Promise<TrainingRunV1>;
  cancel(runId: string): boolean;
}

export interface LocalTrainingRuntimeOptions {
  readonly rootPath: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly clock?: () => string;
}

interface TrainingOutput {
  metrics?: Record<string, number>;
  checkpointArtifacts?: string[];
  modelArtifactId?: string;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function safeRunId(value: string): string {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(value)) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Training run ID is invalid');
  }
  return value;
}

function parseOutput(value: string): TrainingOutput {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    const metrics: Record<string, number> = {};
    if (
      record['metrics'] !== null &&
      typeof record['metrics'] === 'object' &&
      !Array.isArray(record['metrics'])
    ) {
      for (const [key, item] of Object.entries(record['metrics'] as Record<string, unknown>)) {
        if (typeof item === 'number' && Number.isFinite(item)) metrics[key] = item;
      }
    }
    const checkpointArtifacts = Array.isArray(record['checkpointArtifacts'])
      ? record['checkpointArtifacts'].filter((item): item is string => typeof item === 'string')
      : [];
    return {
      metrics,
      checkpointArtifacts,
      ...(typeof record['modelArtifactId'] === 'string'
        ? { modelArtifactId: record['modelArtifactId'] }
        : {}),
    };
  } catch {
    return {};
  }
}

/** Executes only an explicitly configured local training command inside the workspace boundary. */
export class LocalTrainingRuntime implements TrainingRuntime {
  readonly available: boolean;
  private readonly statePath: string;
  private readonly rootPath: string;
  private readonly command: string | undefined;
  private readonly args: readonly string[];
  private readonly clock: () => string;
  private readonly controllers = new Map<string, AbortController>();
  private runs: TrainingRunV1[] | undefined;
  private loading: Promise<void> | undefined;

  constructor(options: LocalTrainingRuntimeOptions) {
    this.rootPath = options.rootPath;
    this.statePath = join(options.rootPath, '.agentic', 'training-runs.json');
    this.command = options.command ?? process.env['SPYDERBYTE_TRAIN_COMMAND'];
    const envArgs = process.env['SPYDERBYTE_TRAIN_ARGS'];
    let configuredArgs: string[] | undefined;
    if (envArgs) {
      try {
        const parsed = JSON.parse(envArgs) as unknown;
        if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
          configuredArgs = parsed;
        }
      } catch {
        configuredArgs = undefined;
      }
    }
    this.args = options.args ?? configuredArgs ?? ['--input', '%INPUT%', '--output', '%OUTPUT%'];
    this.available = typeof this.command === 'string' && this.command.trim().length > 0;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async list(): Promise<readonly TrainingRunV1[]> {
    await this.ensureLoaded();
    return clone(this.runs ?? []);
  }

  async get(runId: string): Promise<TrainingRunV1 | undefined> {
    await this.ensureLoaded();
    const run = this.runs?.find((item) => item.runId === runId);
    return run === undefined ? undefined : clone(run);
  }

  async train(request: TrainingRunRequestV1): Promise<TrainingRunV1> {
    if (!this.available || this.command === undefined) {
      throw runtimeError(
        'COMPUTE_RESOURCE_UNAVAILABLE',
        'Configure SPYDERBYTE_TRAIN_COMMAND before starting local training',
      );
    }
    await this.ensureLoaded();
    const runId =
      request.runId === undefined ? `training-run-${randomUUID()}` : safeRunId(request.runId);
    const startedAt = this.clock();
    const running: TrainingRunV1 = {
      runId,
      status: 'running',
      configuration: clone(request.configuration),
      metrics: {},
      checkpointArtifacts: [],
      ...(request.datasetArtifactId === undefined
        ? {}
        : { datasetArtifactId: request.datasetArtifactId }),
      ...(request.modelId === undefined ? {} : { modelId: request.modelId }),
      startedAt,
    };
    await this.save(running);
    const runDirectory = join(this.rootPath, '.agentic', 'training', runId);
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    const inputPath = join(runDirectory, 'request.json');
    const outputPath = join(runDirectory, 'result.json');
    await writeFile(inputPath, `${JSON.stringify({ runId, ...request, outputPath }, null, 2)}\n`, {
      mode: 0o600,
    });
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    try {
      const args = this.args.map((item) =>
        item.replaceAll('%INPUT%', inputPath).replaceAll('%OUTPUT%', outputPath),
      );
      const result = await execFileAsync(this.command, args, {
        cwd: this.rootPath,
        signal: controller.signal,
        timeout: request.timeoutMs ?? 24 * 60 * 60 * 1000,
        maxBuffer: 8 * 1024 * 1024,
      });
      const output = parseOutput(result.stdout.trim());
      const completed: TrainingRunV1 = {
        ...running,
        status: 'completed',
        completedAt: this.clock(),
        metrics: output.metrics ?? {},
        checkpointArtifacts: output.checkpointArtifacts ?? [],
        ...(output.modelArtifactId === undefined
          ? {}
          : { modelArtifactId: output.modelArtifactId }),
      };
      await this.save(completed);
      return clone(completed);
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const message = error instanceof Error ? error.message : String(error);
      const failed: TrainingRunV1 = {
        ...running,
        status: cancelled ? 'cancelled' : 'failed',
        completedAt: this.clock(),
        error: cancelled ? 'Training was cancelled' : message.slice(0, 8000),
      };
      await this.save(failed);
      return clone(failed);
    } finally {
      this.controllers.delete(runId);
    }
  }

  cancel(runId: string): boolean {
    const controller = this.controllers.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  private async save(run: TrainingRunV1): Promise<void> {
    await this.ensureLoaded();
    const index = this.runs?.findIndex((item) => item.runId === run.runId) ?? -1;
    if (index < 0) this.runs?.push(run);
    else if (this.runs) this.runs[index] = run;
    await mkdir(dirname(this.statePath), { recursive: true });
    await writeFile(this.statePath, `${JSON.stringify(this.runs ?? [], null, 2)}\n`, {
      mode: 0o600,
    });
  }

  private async ensureLoaded(): Promise<void> {
    if (this.runs) return;
    this.loading ??= (async () => {
      try {
        const raw = JSON.parse(await readFile(this.statePath, 'utf8')) as unknown;
        const loaded = Array.isArray(raw) ? (raw as TrainingRunV1[]) : [];
        let recovered = false;
        this.runs = loaded.map((run) => {
          if (run.status !== 'running' && run.status !== 'queued') return run;
          recovered = true;
          return {
            ...run,
            status: 'failed' as const,
            completedAt: this.clock(),
            error: 'Training process was interrupted by a daemon restart',
          };
        });
        if (recovered) {
          await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
          await writeFile(this.statePath, `${JSON.stringify(this.runs, null, 2)}\n`, {
            mode: 0o600,
          });
        }
      } catch {
        this.runs = [];
      }
    })();
    await this.loading;
  }
}
