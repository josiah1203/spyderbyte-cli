import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { newSortableId, runtimeError, type JsonValue } from '@agentic-platform/runtime-contracts';
import { LocalQueryRuntime, type QuerySource } from './query.js';

export type NotebookCellType = 'markdown' | 'python' | 'sql';
export type NotebookCellStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type NotebookState = 'draft' | 'active' | 'archived';
export type NotebookCellOutputType =
  | 'text'
  | 'table'
  | 'chart'
  | 'image'
  | 'html'
  | 'report'
  | 'notebook'
  | 'error';

export interface NotebookCellOutput {
  readonly outputId: string;
  readonly type: NotebookCellOutputType;
  readonly value: JsonValue;
  readonly artifactId?: string;
  readonly artifactVersion?: number;
  readonly mediaType?: string;
  readonly lineage?: readonly string[];
  readonly createdAt: string;
}

export interface NotebookArtifactReference {
  readonly artifactId: string;
  readonly version: 1;
  readonly contentHash: string;
  readonly mediaType: string;
  readonly notebookId: string;
  readonly cellId: string;
}

export interface NotebookCellV1 {
  readonly cellId: string;
  readonly type: NotebookCellType;
  readonly source: string;
  readonly status: NotebookCellStatus;
  readonly executionCount?: number;
  readonly outputs: readonly NotebookCellOutput[];
  readonly updatedAt: string;
}

export interface NotebookDocumentV1 {
  readonly schemaVersion: 1;
  readonly notebookId: string;
  readonly title: string;
  readonly revision: number;
  readonly state: NotebookState;
  readonly projectId?: string;
  readonly runtimeProfileId?: string;
  readonly environmentRevisionId?: string;
  readonly kernel: 'local-python';
  readonly environment: string;
  readonly cells: readonly NotebookCellV1[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NotebookCreateInput {
  readonly notebookId?: string;
  readonly title?: string;
  readonly projectId?: string;
  readonly runtimeProfileId?: string;
  readonly environmentRevisionId?: string;
}

export interface NotebookVersionV1 {
  readonly schemaVersion: 1;
  readonly notebookId: string;
  readonly revision: number;
  readonly document: NotebookDocumentV1;
  readonly createdAt: string;
  readonly reason: 'created' | 'edited' | 'imported' | 'duplicated' | 'restored';
}

export interface NotebookResourceUsageV1 {
  readonly durationMs: number;
  readonly cpuMs?: number;
  readonly memoryBytes?: number;
  readonly costMinor?: number;
}

export interface NotebookCellExecutionV1 {
  readonly schemaVersion: 1;
  readonly executionId: string;
  readonly notebookId: string;
  readonly revision: number;
  readonly cellId: string;
  readonly sourceHash: string;
  readonly cellType: NotebookCellType;
  readonly state: NotebookCellStatus;
  readonly runtime: string;
  readonly environmentRevisionId?: string;
  readonly runtimeProfileId?: string;
  readonly inputReferences: readonly string[];
  readonly outputReferences: readonly NotebookArtifactReference[];
  readonly artifactIds: readonly string[];
  readonly output?: NotebookCellOutput;
  readonly error?: string;
  readonly resourceUsage: NotebookResourceUsageV1;
  readonly runId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NotebookRunV1 {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly notebookId: string;
  readonly revision: number;
  readonly state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  readonly runtime: string;
  readonly runtimeProfileId?: string;
  readonly environmentRevisionId?: string;
  readonly datasetVersion?: string;
  readonly computeProfile?: string;
  readonly parameters?: Readonly<Record<string, JsonValue>>;
  readonly cellExecutionIds: readonly string[];
  readonly artifactIds: readonly string[];
  readonly resourceUsage: NotebookResourceUsageV1;
  readonly error?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}

export interface NotebookRunResultV1 {
  readonly run: NotebookRunV1;
  readonly notebook: NotebookDocumentV1;
  readonly executions: readonly NotebookCellExecutionV1[];
}

export interface NotebookExperimentAssociationV1 {
  readonly notebookId: string;
  readonly experimentId: string;
  readonly associatedAt: string;
}

export interface NotebookCellRunResult {
  readonly notebook: NotebookDocumentV1;
  readonly cell: NotebookCellV1;
  readonly artifact?: NotebookArtifactReference;
  readonly execution: NotebookCellExecutionV1;
}

export interface NotebookRuntime {
  create(notebookId: string, title?: string): NotebookDocumentV1;
  create(input: NotebookCreateInput): NotebookDocumentV1;
  get(notebookId: string, revision?: number): NotebookDocumentV1 | undefined;
  open(notebookId: string, revision?: number): NotebookDocumentV1;
  list(): NotebookDocumentV1[];
  duplicate(input: {
    notebookId: string;
    newNotebookId?: string;
    title?: string;
  }): NotebookDocumentV1;
  rename(notebookId: string, title: string): NotebookDocumentV1;
  archive(notebookId: string): NotebookDocumentV1;
  restore(notebookId: string): NotebookDocumentV1;
  delete(notebookId: string): boolean;
  versions(notebookId: string): readonly NotebookVersionV1[];
  listExecutions(notebookId: string, revision?: number): readonly NotebookCellExecutionV1[];
  getExecution(executionId: string): NotebookCellExecutionV1 | undefined;
  listRuns(notebookId?: string): readonly NotebookRunV1[];
  getRun(runId: string): NotebookRunV1 | undefined;
  usage(notebookId: string): NotebookResourceUsageV1;
  associateExperiment(notebookId: string, experimentId: string): NotebookExperimentAssociationV1;
  experiments(notebookId: string): readonly NotebookExperimentAssociationV1[];
  getArtifact(
    artifactId: string,
  ): Promise<{ content: string; contentHash: string; mediaType: string } | undefined>;
  upsertCell(input: {
    notebookId: string;
    cellId: string;
    type: NotebookCellType;
    source: string;
  }): NotebookDocumentV1;
  runCell(input: {
    notebookId: string;
    cellId: string;
    type: NotebookCellType;
    source: string;
    sourceData?: QuerySource;
    revision?: number;
    runtimeProfileId?: string;
    environmentRevisionId?: string;
    runId?: string;
    outputType?: Exclude<NotebookCellOutputType, 'error'>;
    mediaType?: string;
  }): Promise<NotebookCellRunResult>;
  runNotebook(input: {
    notebookId: string;
    revision?: number;
    sourceData?: QuerySource;
    runtimeProfileId?: string;
    environmentRevisionId?: string;
    datasetVersion?: string;
    computeProfile?: string;
    parameters?: Readonly<Record<string, JsonValue>>;
  }): Promise<NotebookRunResultV1>;
  cancel(notebookId: string, cellId: string): boolean;
  restart(notebookId: string): NotebookDocumentV1;
  exportIpynb(notebookId: string): JsonValue;
  importIpynb(notebookId: string, document: unknown): NotebookDocumentV1;
}

const PYTHON_NOTEBOOK_BRIDGE = String.raw`
import contextlib, io, json, sys, traceback

scope = {}
for line in sys.stdin:
    try:
        request = json.loads(line)
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            exec(compile(request.get('source', ''), '<spyderbyte-notebook>', 'exec'), scope, scope)
        response = {'ok': True, 'stdout': output.getvalue()}
    except Exception as error:
        response = {'ok': False, 'error': type(error).__name__ + ': ' + str(error), 'traceback': traceback.format_exc()}
    sys.stdout.write(json.dumps(response, separators=(',', ':')) + '\n')
    sys.stdout.flush()
`;

interface PythonResponse {
  readonly ok: boolean;
  readonly stdout?: string;
  readonly error?: string;
  readonly traceback?: string;
}

interface PendingPythonCell {
  readonly cellId: string;
  readonly resolve: (value: { type: 'text'; value: JsonValue }) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function validId(value: string, label: string): string {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(value))
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} is invalid`);
  return value;
}

function now(): string {
  return new Date().toISOString();
}

function outputId(notebookId: string, cellId: string): string {
  return `${notebookId}:${cellId}:${Date.now()}`;
}

export class LocalNotebookRuntime implements NotebookRuntime {
  private readonly notebooks = new Map<string, NotebookDocumentV1>();
  private readonly notebookVersions = new Map<string, NotebookVersionV1[]>();
  private readonly executions = new Map<string, NotebookCellExecutionV1>();
  private readonly runs = new Map<string, NotebookRunV1>();
  private readonly experimentAssociations = new Map<string, NotebookExperimentAssociationV1[]>();
  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly pythonBuffers = new Map<string, string>();
  private readonly pendingPython = new Map<string, PendingPythonCell>();
  private readonly cancelledCells = new Set<string>();
  private readonly queryRuntime: LocalQueryRuntime;
  private readonly clock: () => string;
  private readonly storePath: string | undefined;
  private readonly artifacts = new Map<
    string,
    { content: string; contentHash: string; mediaType: string }
  >();

  constructor(queryRuntime = new LocalQueryRuntime(), clock = now, storePath?: string) {
    this.queryRuntime = queryRuntime;
    this.clock = clock;
    this.storePath = storePath;
    if (storePath !== undefined) {
      try {
        const value: unknown = JSON.parse(readFileSync(storePath, 'utf8'));
        if (Array.isArray(value)) {
          for (const item of value) {
            if (
              item !== null &&
              typeof item === 'object' &&
              !Array.isArray(item) &&
              typeof (item as Record<string, unknown>)['notebookId'] === 'string'
            ) {
              const document = this.normalizeDocument(item as Partial<NotebookDocumentV1>);
              this.notebooks.set(document.notebookId, document);
              this.recordVersion(document, 'created');
            }
          }
        } else if (value !== null && typeof value === 'object') {
          const record = value as Record<string, unknown>;
          const storedNotebooks = record['notebooks'];
          if (Array.isArray(storedNotebooks)) {
            for (const item of storedNotebooks) {
              if (
                item !== null &&
                typeof item === 'object' &&
                !Array.isArray(item) &&
                typeof (item as Record<string, unknown>)['notebookId'] === 'string'
              ) {
                const document = this.normalizeDocument(item as Partial<NotebookDocumentV1>);
                this.notebooks.set(document.notebookId, document);
              }
            }
          }
          const storedVersions = record['versions'];
          if (storedVersions !== null && typeof storedVersions === 'object') {
            for (const [notebookId, versions] of Object.entries(
              storedVersions as Record<string, unknown>,
            )) {
              if (!Array.isArray(versions)) continue;
              const parsed = versions.filter(
                (version): version is NotebookVersionV1 =>
                  version !== null &&
                  typeof version === 'object' &&
                  !Array.isArray(version) &&
                  typeof (version as Record<string, unknown>)['revision'] === 'number' &&
                  (version as Record<string, unknown>)['document'] !== undefined,
              );
              if (parsed.length > 0) this.notebookVersions.set(notebookId, parsed);
            }
          }
          const storedExecutions = record['executions'];
          if (Array.isArray(storedExecutions)) {
            for (const execution of storedExecutions) {
              if (
                execution !== null &&
                typeof execution === 'object' &&
                typeof (execution as Record<string, unknown>)['executionId'] === 'string'
              ) {
                this.executions.set(
                  (execution as NotebookCellExecutionV1).executionId,
                  execution as NotebookCellExecutionV1,
                );
              }
            }
          }
          const storedRuns = record['runs'];
          if (Array.isArray(storedRuns)) {
            for (const run of storedRuns) {
              if (
                run !== null &&
                typeof run === 'object' &&
                typeof (run as Record<string, unknown>)['runId'] === 'string'
              ) {
                this.runs.set((run as NotebookRunV1).runId, run as NotebookRunV1);
              }
            }
          }
          const storedAssociations = record['experiments'];
          if (storedAssociations !== null && typeof storedAssociations === 'object') {
            for (const [notebookId, associations] of Object.entries(
              storedAssociations as Record<string, unknown>,
            )) {
              if (!Array.isArray(associations)) continue;
              const parsed = associations.filter(
                (association): association is NotebookExperimentAssociationV1 =>
                  association !== null &&
                  typeof association === 'object' &&
                  typeof (association as Record<string, unknown>)['experimentId'] === 'string',
              );
              if (parsed.length > 0) this.experimentAssociations.set(notebookId, parsed);
            }
          }
        }
      } catch {
        // A first launch or incomplete prior file starts with an empty notebook catalog.
      }
    }
  }

  create(notebookId: string, title?: string): NotebookDocumentV1;
  create(input: NotebookCreateInput): NotebookDocumentV1;
  create(
    notebookOrInput: string | NotebookCreateInput,
    title = 'Untitled notebook',
  ): NotebookDocumentV1 {
    const input: NotebookCreateInput =
      typeof notebookOrInput === 'string'
        ? { notebookId: notebookOrInput, title }
        : notebookOrInput;
    const notebookId = input.notebookId ?? newSortableId();
    validId(notebookId, 'notebookId');
    const existing = this.notebooks.get(notebookId);
    if (existing !== undefined) return structuredClone(existing);
    const timestamp = this.clock();
    const document: NotebookDocumentV1 = {
      schemaVersion: 1,
      notebookId,
      title: input.title ?? title,
      revision: 1,
      state: 'draft',
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.runtimeProfileId === undefined ? {} : { runtimeProfileId: input.runtimeProfileId }),
      ...(input.environmentRevisionId === undefined
        ? {}
        : { environmentRevisionId: input.environmentRevisionId }),
      kernel: 'local-python',
      environment: 'local-python',
      cells: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.notebooks.set(notebookId, document);
    this.recordVersion(document, 'created');
    this.persist();
    return structuredClone(document);
  }

  get(notebookId: string, revision?: number): NotebookDocumentV1 | undefined {
    if (revision !== undefined) {
      const version = this.notebookVersions
        .get(validId(notebookId, 'notebookId'))
        ?.find((item) => item.revision === revision);
      return version === undefined ? undefined : structuredClone(version.document);
    }
    const document = this.notebooks.get(notebookId);
    return document === undefined ? undefined : structuredClone(document);
  }

  open(notebookId: string, revision?: number): NotebookDocumentV1 {
    const document = this.get(notebookId, revision);
    if (document === undefined)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Notebook was not found');
    return document;
  }

  list(): NotebookDocumentV1[] {
    return structuredClone([...this.notebooks.values()]);
  }

  duplicate(input: {
    notebookId: string;
    newNotebookId?: string;
    title?: string;
  }): NotebookDocumentV1 {
    const source = this.open(input.notebookId);
    const newNotebookId = input.newNotebookId ?? newSortableId();
    validId(newNotebookId, 'newNotebookId');
    if (this.notebooks.has(newNotebookId))
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Notebook already exists');
    const timestamp = this.clock();
    const copy: NotebookDocumentV1 = {
      ...source,
      notebookId: newNotebookId,
      title: input.title ?? `${source.title} copy`,
      revision: 1,
      state: 'draft',
      createdAt: timestamp,
      updatedAt: timestamp,
      cells: source.cells.map((cell) => ({ ...cell, outputs: [], status: 'idle' as const })),
    };
    this.notebooks.set(newNotebookId, copy);
    this.recordVersion(copy, 'duplicated');
    this.persist();
    return structuredClone(copy);
  }

  rename(notebookId: string, title: string): NotebookDocumentV1 {
    const document = this.open(notebookId);
    const normalizedTitle = title.trim();
    if (normalizedTitle.length === 0)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Notebook title is required');
    const updated = this.editDocument(document, { title: normalizedTitle }, 'edited');
    return structuredClone(updated);
  }

  archive(notebookId: string): NotebookDocumentV1 {
    const document = this.open(notebookId);
    const updated = this.editDocument(document, { state: 'archived' }, 'edited');
    return structuredClone(updated);
  }

  restore(notebookId: string): NotebookDocumentV1 {
    const document = this.open(notebookId);
    const updated = this.editDocument(document, { state: 'active' }, 'restored');
    return structuredClone(updated);
  }

  delete(notebookId: string): boolean {
    const normalized = validId(notebookId, 'notebookId');
    const removed = this.notebooks.delete(normalized);
    if (!removed) return false;
    this.notebookVersions.delete(normalized);
    this.experimentAssociations.delete(normalized);
    for (const [executionId, execution] of this.executions) {
      if (execution.notebookId === normalized) this.executions.delete(executionId);
    }
    for (const [runId, run] of this.runs) {
      if (run.notebookId === normalized) this.runs.delete(runId);
    }
    this.persist();
    return true;
  }

  versions(notebookId: string): readonly NotebookVersionV1[] {
    validId(notebookId, 'notebookId');
    return structuredClone(this.notebookVersions.get(notebookId) ?? []);
  }

  listExecutions(notebookId: string, revision?: number): readonly NotebookCellExecutionV1[] {
    validId(notebookId, 'notebookId');
    return structuredClone(
      [...this.executions.values()].filter(
        (execution) =>
          execution.notebookId === notebookId &&
          (revision === undefined || execution.revision === revision),
      ),
    );
  }

  getExecution(executionId: string): NotebookCellExecutionV1 | undefined {
    const execution = this.executions.get(executionId);
    return execution === undefined ? undefined : structuredClone(execution);
  }

  listRuns(notebookId?: string): readonly NotebookRunV1[] {
    return structuredClone(
      [...this.runs.values()].filter(
        (run) => notebookId === undefined || run.notebookId === notebookId,
      ),
    );
  }

  getRun(runId: string): NotebookRunV1 | undefined {
    const run = this.runs.get(runId);
    return run === undefined ? undefined : structuredClone(run);
  }

  usage(notebookId: string): NotebookResourceUsageV1 {
    const executions = this.listExecutions(notebookId);
    return executions.reduce(
      (total, execution) => ({
        durationMs: total.durationMs + execution.resourceUsage.durationMs,
        ...(total.cpuMs === undefined && execution.resourceUsage.cpuMs === undefined
          ? {}
          : { cpuMs: (total.cpuMs ?? 0) + (execution.resourceUsage.cpuMs ?? 0) }),
        ...(total.memoryBytes === undefined && execution.resourceUsage.memoryBytes === undefined
          ? {}
          : {
              memoryBytes: Math.max(
                total.memoryBytes ?? 0,
                execution.resourceUsage.memoryBytes ?? 0,
              ),
            }),
        ...(total.costMinor === undefined && execution.resourceUsage.costMinor === undefined
          ? {}
          : { costMinor: (total.costMinor ?? 0) + (execution.resourceUsage.costMinor ?? 0) }),
      }),
      { durationMs: 0 } as NotebookResourceUsageV1,
    );
  }

  associateExperiment(notebookId: string, experimentId: string): NotebookExperimentAssociationV1 {
    validId(notebookId, 'notebookId');
    const normalizedExperimentId = experimentId.trim();
    if (normalizedExperimentId.length === 0)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'experimentId is required');
    this.open(notebookId);
    const association: NotebookExperimentAssociationV1 = {
      notebookId,
      experimentId: normalizedExperimentId,
      associatedAt: this.clock(),
    };
    const existing = this.experimentAssociations.get(notebookId) ?? [];
    if (!existing.some((item) => item.experimentId === normalizedExperimentId)) {
      existing.push(association);
      this.experimentAssociations.set(notebookId, existing);
      this.persist();
    }
    return structuredClone(
      existing.find((item) => item.experimentId === normalizedExperimentId) ?? association,
    );
  }

  experiments(notebookId: string): readonly NotebookExperimentAssociationV1[] {
    validId(notebookId, 'notebookId');
    return structuredClone(this.experimentAssociations.get(notebookId) ?? []);
  }

  async getArtifact(
    artifactId: string,
  ): Promise<{ content: string; contentHash: string; mediaType: string } | undefined> {
    if (!/^sha256:[a-f0-9]{64}$/.test(artifactId)) return undefined;
    const inMemory = this.artifacts.get(artifactId);
    if (inMemory !== undefined) return structuredClone(inMemory);
    if (this.storePath === undefined) return undefined;
    const contentHash = artifactId.slice('sha256:'.length);
    try {
      const content = await readFile(
        join(dirname(this.storePath), 'notebook-artifacts', contentHash),
        'utf8',
      );
      return {
        content,
        contentHash: artifactId,
        mediaType: this.findArtifactMediaType(artifactId) ?? 'application/octet-stream',
      };
    } catch {
      return undefined;
    }
  }

  upsertCell(input: {
    notebookId: string;
    cellId: string;
    type: NotebookCellType;
    source: string;
  }): NotebookDocumentV1 {
    const document =
      this.notebooks.get(validId(input.notebookId, 'notebookId')) ?? this.create(input.notebookId);
    if (document.state === 'archived') {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'Archived notebooks must be restored before editing',
      );
    }
    validId(input.cellId, 'cellId');
    const timestamp = this.clock();
    const existing = document.cells.find((cell) => cell.cellId === input.cellId);
    const cell: NotebookCellV1 = {
      cellId: input.cellId,
      type: input.type,
      source: input.source,
      status: existing?.status ?? 'idle',
      ...(existing?.executionCount === undefined
        ? {}
        : { executionCount: existing.executionCount }),
      outputs: existing?.outputs ?? [],
      updatedAt: timestamp,
    };
    const cells =
      existing === undefined
        ? [...document.cells, cell]
        : document.cells.map((item) => (item.cellId === cell.cellId ? cell : item));
    const updated = {
      ...document,
      revision: document.revision + 1,
      state: 'active' as const,
      cells,
      updatedAt: timestamp,
    };
    this.notebooks.set(document.notebookId, updated);
    this.recordVersion(updated, 'edited');
    this.persist();
    return structuredClone(updated);
  }

  async runCell(input: {
    notebookId: string;
    cellId: string;
    type: NotebookCellType;
    source: string;
    sourceData?: QuerySource;
    revision?: number;
    runtimeProfileId?: string;
    environmentRevisionId?: string;
    runId?: string;
    outputType?: Exclude<NotebookCellOutputType, 'error'>;
    mediaType?: string;
  }): Promise<NotebookCellRunResult> {
    const existingDocument = this.notebooks.get(validId(input.notebookId, 'notebookId'));
    const existingCell = existingDocument?.cells.find((cell) => cell.cellId === input.cellId);
    const document =
      existingDocument !== undefined &&
      existingCell !== undefined &&
      existingCell.type === input.type &&
      existingCell.source === input.source
        ? structuredClone(existingDocument)
        : this.upsertCell(input);
    const cancellationKey = `${input.notebookId}:${input.cellId}`;
    this.cancelledCells.delete(cancellationKey);
    const previous = document.cells.find((cell) => cell.cellId === input.cellId);
    if (previous === undefined)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Notebook cell was not created');
    const executionId = newSortableId();
    const executionRevision = input.revision ?? document.revision;
    const startedAt = this.clock();
    const startedMs = Date.now();
    const running = this.replaceCell(document, {
      ...previous,
      status: 'running',
      updatedAt: this.clock(),
    });
    try {
      const output =
        input.type === 'markdown'
          ? { type: 'text' as const, value: input.source }
          : input.type === 'sql'
            ? await this.runSql(input)
            : await this.runPython(input.notebookId, input.cellId, input.source);
      const outputType = input.outputType ?? output.type;
      const artifact = await this.captureArtifact(
        input.notebookId,
        input.cellId,
        input.type,
        outputType,
        output.value,
        input.mediaType,
      );
      const completed = this.replaceCell(running, {
        ...previous,
        status: 'completed',
        executionCount: (previous.executionCount ?? 0) + (input.type === 'markdown' ? 0 : 1),
        outputs: [
          {
            outputId: outputId(input.notebookId, input.cellId),
            type: outputType,
            value: output.value,
            artifactId: artifact.artifactId,
            artifactVersion: artifact.version,
            mediaType: artifact.reference.mediaType,
            lineage: artifact.lineage,
            createdAt: this.clock(),
          },
        ],
        updatedAt: this.clock(),
      });
      const finishedAt = this.clock();
      const executionOutput = completed.cells
        .find((cell) => cell.cellId === input.cellId)
        ?.outputs.at(-1);
      const execution: NotebookCellExecutionV1 = {
        schemaVersion: 1,
        executionId,
        notebookId: input.notebookId,
        revision: executionRevision,
        cellId: input.cellId,
        sourceHash: createHash('sha256').update(input.source).digest('hex'),
        cellType: input.type,
        state: 'completed',
        runtime: 'local-python',
        ...(input.environmentRevisionId === undefined
          ? {}
          : { environmentRevisionId: input.environmentRevisionId }),
        ...(input.runtimeProfileId === undefined
          ? {}
          : { runtimeProfileId: input.runtimeProfileId }),
        inputReferences: [],
        outputReferences: [artifact.reference],
        artifactIds: [artifact.artifactId],
        ...(executionOutput === undefined ? {} : { output: executionOutput }),
        resourceUsage: { durationMs: Math.max(0, Date.now() - startedMs), costMinor: 0 },
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        createdAt: startedAt,
        updatedAt: finishedAt,
      };
      this.executions.set(executionId, execution);
      this.persist();
      return {
        notebook: completed,
        cell: completed.cells.find((cell) => cell.cellId === input.cellId) as NotebookCellV1,
        artifact: artifact.reference,
        execution,
      };
    } catch (error) {
      const cancelled = this.cancelledCells.delete(cancellationKey);
      const errorMessage = cancelled
        ? 'Notebook cell was cancelled'
        : error instanceof Error
          ? error.message
          : String(error);
      const failed = this.replaceCell(running, {
        ...previous,
        status: cancelled ? 'cancelled' : 'failed',
        executionCount: (previous.executionCount ?? 0) + 1,
        outputs: [
          {
            outputId: outputId(input.notebookId, input.cellId),
            type: 'error',
            value: errorMessage,
            createdAt: this.clock(),
          },
        ],
        updatedAt: this.clock(),
      });
      const finishedAt = this.clock();
      const executionOutput = failed.cells
        .find((cell) => cell.cellId === input.cellId)
        ?.outputs.at(-1);
      const execution: NotebookCellExecutionV1 = {
        schemaVersion: 1,
        executionId,
        notebookId: input.notebookId,
        revision: executionRevision,
        cellId: input.cellId,
        sourceHash: createHash('sha256').update(input.source).digest('hex'),
        cellType: input.type,
        state: cancelled ? 'cancelled' : 'failed',
        runtime: 'local-python',
        ...(input.environmentRevisionId === undefined
          ? {}
          : { environmentRevisionId: input.environmentRevisionId }),
        ...(input.runtimeProfileId === undefined
          ? {}
          : { runtimeProfileId: input.runtimeProfileId }),
        inputReferences: [],
        outputReferences: [],
        artifactIds: [],
        ...(executionOutput === undefined ? {} : { output: executionOutput }),
        error: errorMessage,
        resourceUsage: { durationMs: Math.max(0, Date.now() - startedMs), costMinor: 0 },
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        createdAt: startedAt,
        updatedAt: finishedAt,
      };
      this.executions.set(executionId, execution);
      this.persist();
      return {
        notebook: failed,
        cell: failed.cells.find((cell) => cell.cellId === input.cellId) as NotebookCellV1,
        execution,
      };
    }
  }

  async runNotebook(input: {
    notebookId: string;
    revision?: number;
    sourceData?: QuerySource;
    runtimeProfileId?: string;
    environmentRevisionId?: string;
    datasetVersion?: string;
    computeProfile?: string;
    parameters?: Readonly<Record<string, JsonValue>>;
  }): Promise<NotebookRunResultV1> {
    const notebook = this.open(input.notebookId, input.revision);
    if (notebook.state === 'archived')
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'Archived notebooks must be restored before running',
      );
    const currentDocument = this.notebooks.get(notebook.notebookId);
    const pinnedSnapshot =
      currentDocument !== undefined && currentDocument.revision !== notebook.revision
        ? structuredClone(currentDocument)
        : undefined;
    if (pinnedSnapshot !== undefined) {
      this.notebooks.set(notebook.notebookId, structuredClone(notebook));
    }
    const restorePinnedSnapshot = (): void => {
      if (pinnedSnapshot === undefined) return;
      this.notebooks.set(notebook.notebookId, pinnedSnapshot);
      this.persist();
    };
    const runId = newSortableId();
    const createdAt = this.clock();
    const baseRun: NotebookRunV1 = {
      schemaVersion: 1,
      runId,
      notebookId: notebook.notebookId,
      revision: notebook.revision,
      state: 'running',
      runtime: 'local-python',
      ...(input.runtimeProfileId === undefined ? {} : { runtimeProfileId: input.runtimeProfileId }),
      ...(input.environmentRevisionId === undefined
        ? {}
        : { environmentRevisionId: input.environmentRevisionId }),
      ...(input.datasetVersion === undefined ? {} : { datasetVersion: input.datasetVersion }),
      ...(input.computeProfile === undefined ? {} : { computeProfile: input.computeProfile }),
      ...(input.parameters === undefined ? {} : { parameters: input.parameters }),
      cellExecutionIds: [],
      artifactIds: [],
      resourceUsage: { durationMs: 0, costMinor: 0 },
      createdAt,
      updatedAt: createdAt,
    };
    this.runs.set(runId, baseRun);
    this.persist();
    const executions: NotebookCellExecutionV1[] = [];
    let state: NotebookRunV1 = baseRun;
    const startedMs = Date.now();
    try {
      for (const cell of notebook.cells) {
        if (cell.type === 'markdown' && cell.source.trim().length === 0) continue;
        const result = await this.runCell({
          notebookId: notebook.notebookId,
          cellId: cell.cellId,
          type: cell.type,
          source: cell.source,
          ...(input.sourceData === undefined ? {} : { sourceData: input.sourceData }),
          revision: notebook.revision,
          ...(input.runtimeProfileId === undefined
            ? {}
            : { runtimeProfileId: input.runtimeProfileId }),
          ...(input.environmentRevisionId === undefined
            ? {}
            : { environmentRevisionId: input.environmentRevisionId }),
          runId,
        });
        executions.push(result.execution);
        state = {
          ...state,
          cellExecutionIds: executions.map((execution) => execution.executionId),
          artifactIds: executions.flatMap((execution) => execution.artifactIds),
          updatedAt: this.clock(),
        };
        this.runs.set(runId, state);
        this.persist();
        if (result.execution.state !== 'completed') {
          state = {
            ...state,
            state: result.execution.state === 'cancelled' ? 'cancelled' : 'failed',
            ...(result.execution.error === undefined ? {} : { error: result.execution.error }),
            resourceUsage: { durationMs: Math.max(0, Date.now() - startedMs), costMinor: 0 },
            completedAt: this.clock(),
            updatedAt: this.clock(),
          };
          this.runs.set(runId, state);
          this.persist();
          restorePinnedSnapshot();
          return {
            run: structuredClone(state),
            notebook: structuredClone(notebook),
            executions,
          };
        }
      }
      state = {
        ...state,
        state: 'completed',
        resourceUsage: { durationMs: Math.max(0, Date.now() - startedMs), costMinor: 0 },
        completedAt: this.clock(),
        updatedAt: this.clock(),
      };
      this.runs.set(runId, state);
      this.persist();
      restorePinnedSnapshot();
      return { run: structuredClone(state), notebook: structuredClone(notebook), executions };
    } catch (error) {
      state = {
        ...state,
        state: 'failed',
        error: error instanceof Error ? error.message : String(error),
        resourceUsage: { durationMs: Math.max(0, Date.now() - startedMs), costMinor: 0 },
        completedAt: this.clock(),
        updatedAt: this.clock(),
      };
      this.runs.set(runId, state);
      this.persist();
      restorePinnedSnapshot();
      return { run: structuredClone(state), notebook: structuredClone(notebook), executions };
    }
  }

  cancel(notebookId: string, cellId: string): boolean {
    const process = this.processes.get(notebookId);
    const pending = this.pendingPython.get(notebookId);
    if (pending !== undefined && pending.cellId !== cellId) return false;
    if (process === undefined) return false;
    this.cancelledCells.add(`${notebookId}:${cellId}`);
    process.kill('SIGTERM');
    return true;
  }

  restart(notebookId: string): NotebookDocumentV1 {
    const process = this.processes.get(validId(notebookId, 'notebookId'));
    process?.kill('SIGTERM');
    this.processes.delete(notebookId);
    this.pythonBuffers.delete(notebookId);
    for (const key of this.cancelledCells) {
      if (key.startsWith(`${notebookId}:`)) this.cancelledCells.delete(key);
    }
    const document =
      this.notebooks.get(validId(notebookId, 'notebookId')) ?? this.create(notebookId);
    const updated = {
      ...document,
      environment: 'local-python',
      cells: document.cells.map((cell) => ({
        ...cell,
        status: 'idle' as const,
        outputs: [],
        updatedAt: this.clock(),
      })),
      updatedAt: this.clock(),
    };
    this.notebooks.set(notebookId, updated);
    this.persist();
    return structuredClone(updated);
  }

  exportIpynb(notebookId: string): JsonValue {
    const document = this.notebooks.get(validId(notebookId, 'notebookId'));
    if (document === undefined)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Notebook was not found');
    return {
      cells: document.cells.map((cell) => ({
        cell_type: cell.type === 'python' ? 'code' : cell.type,
        source: cell.source.split('\n'),
        outputs: cell.outputs.map((output) => ({
          output_type: output.type === 'error' ? 'error' : 'stream',
          text: String(output.value),
        })),
        execution_count: cell.executionCount ?? null,
      })),
      metadata: {
        spyderbyte: {
          notebookId: document.notebookId,
          kernel: document.kernel,
          environment: document.environment,
        },
      },
      nbformat: 4,
      nbformat_minor: 5,
    };
  }

  importIpynb(notebookId: string, raw: unknown): NotebookDocumentV1 {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Notebook document must be an object');
    const record = raw as Record<string, unknown>;
    if (!Array.isArray(record['cells']))
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Notebook cells must be an array');
    const document = this.create(notebookId);
    const cells = record['cells'].map((value, index) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `Notebook cell ${index + 1} is invalid`);
      const cell = value as Record<string, unknown>;
      const source = Array.isArray(cell['source'])
        ? cell['source'].filter((item): item is string => typeof item === 'string').join('')
        : typeof cell['source'] === 'string'
          ? cell['source']
          : '';
      const rawType =
        cell['cell_type'] === 'code'
          ? 'python'
          : cell['cell_type'] === 'markdown'
            ? 'markdown'
            : 'sql';
      return {
        cellId: `cell-${index + 1}`,
        type: rawType as NotebookCellType,
        source,
        status: 'idle' as const,
        outputs: [],
        updatedAt: this.clock(),
      };
    });
    const updated = {
      ...document,
      revision: document.revision + 1,
      state: 'active' as const,
      cells,
      updatedAt: this.clock(),
    };
    this.notebooks.set(notebookId, updated);
    this.recordVersion(updated, 'imported');
    this.persist();
    return structuredClone(updated);
  }

  private normalizeDocument(input: Partial<NotebookDocumentV1>): NotebookDocumentV1 {
    const notebookId = input.notebookId;
    if (typeof notebookId !== 'string')
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Notebook id is missing');
    const timestamp = input.updatedAt ?? input.createdAt ?? this.clock();
    const cells = Array.isArray(input.cells)
      ? input.cells.map((cell) => ({
          ...cell,
          outputs: Array.isArray(cell.outputs) ? cell.outputs : [],
          status: cell.status ?? 'idle',
          updatedAt: cell.updatedAt ?? timestamp,
        }))
      : [];
    return {
      schemaVersion: 1,
      notebookId,
      title: input.title ?? 'Untitled notebook',
      revision: input.revision ?? 1,
      state: input.state ?? 'draft',
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.runtimeProfileId === undefined ? {} : { runtimeProfileId: input.runtimeProfileId }),
      ...(input.environmentRevisionId === undefined
        ? {}
        : { environmentRevisionId: input.environmentRevisionId }),
      kernel: input.kernel ?? 'local-python',
      environment: input.environment ?? 'local-python',
      cells,
      createdAt: input.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
  }

  private editDocument(
    document: NotebookDocumentV1,
    patch: Partial<
      Pick<
        NotebookDocumentV1,
        'title' | 'state' | 'projectId' | 'runtimeProfileId' | 'environmentRevisionId'
      >
    >,
    reason: NotebookVersionV1['reason'],
  ): NotebookDocumentV1 {
    const updated: NotebookDocumentV1 = {
      ...document,
      ...patch,
      revision: document.revision + 1,
      updatedAt: this.clock(),
    };
    this.notebooks.set(document.notebookId, updated);
    this.recordVersion(updated, reason);
    this.persist();
    return updated;
  }

  private recordVersion(document: NotebookDocumentV1, reason: NotebookVersionV1['reason']): void {
    const versions = this.notebookVersions.get(document.notebookId) ?? [];
    if (versions.some((version) => version.revision === document.revision)) return;
    versions.push({
      schemaVersion: 1,
      notebookId: document.notebookId,
      revision: document.revision,
      document: structuredClone(document),
      createdAt: document.updatedAt,
      reason,
    });
    versions.sort((left, right) => left.revision - right.revision);
    this.notebookVersions.set(document.notebookId, versions);
  }

  private replaceCell(document: NotebookDocumentV1, cell: NotebookCellV1): NotebookDocumentV1 {
    const updated = {
      ...document,
      cells: document.cells.map((item) => (item.cellId === cell.cellId ? cell : item)),
      updatedAt: this.clock(),
    };
    this.notebooks.set(document.notebookId, updated);
    this.persist();
    return updated;
  }

  private persist(): void {
    if (this.storePath === undefined) return;
    mkdirSync(dirname(this.storePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.storePath}.tmp-${process.pid}`;
    writeFileSync(
      temporary,
      JSON.stringify({
        schemaVersion: 1,
        notebooks: [...this.notebooks.values()],
        versions: Object.fromEntries(this.notebookVersions),
        executions: [...this.executions.values()],
        runs: [...this.runs.values()],
        experiments: Object.fromEntries(this.experimentAssociations),
      }),
      { mode: 0o600 },
    );
    renameSync(temporary, this.storePath);
  }

  private async runSql(input: {
    notebookId: string;
    cellId: string;
    source: string;
    sourceData?: QuerySource;
  }): Promise<{ type: 'table'; value: JsonValue }> {
    const result = await this.queryRuntime.execute({
      queryId: `notebook-${input.notebookId}-${input.cellId}`,
      sql: input.source,
      ...(input.sourceData === undefined ? {} : { source: input.sourceData }),
    });
    return {
      type: 'table',
      value: {
        columns: result.columns.map((column) => column.name),
        rows: result.rows.map((row) => [...row]),
        artifactId: result.artifact.artifactId,
      },
    };
  }

  private async captureArtifact(
    notebookId: string,
    cellId: string,
    type: NotebookCellType,
    outputType: NotebookCellOutputType,
    value: JsonValue,
    requestedMediaType?: string,
  ): Promise<{
    reference: NotebookArtifactReference;
    artifactId: string;
    version: 1;
    lineage: readonly string[];
  }> {
    const content = typeof value === 'string' ? value : JSON.stringify(value);
    const contentHash = createHash('sha256').update(content).digest('hex');
    const artifactId = `sha256:${contentHash}`;
    if (this.storePath !== undefined) {
      const artifactRoot = join(dirname(this.storePath), 'notebook-artifacts');
      const artifactPath = join(artifactRoot, contentHash);
      mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
      try {
        writeFileSync(artifactPath, content, { mode: 0o600, flag: 'wx' });
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      }
    }
    const lineage =
      type === 'sql' && value !== null && typeof value === 'object' && !Array.isArray(value)
        ? typeof (value as Record<string, unknown>)['artifactId'] === 'string'
          ? [(value as Record<string, unknown>)['artifactId'] as string]
          : []
        : [];
    const mediaType =
      requestedMediaType ??
      (outputType === 'table'
        ? 'application/json'
        : outputType === 'chart'
          ? 'application/vnd.spyderbyte.chart+json'
          : outputType === 'image'
            ? 'image/png'
            : outputType === 'html'
              ? 'text/html'
              : outputType === 'report'
                ? 'text/html'
                : outputType === 'notebook'
                  ? 'application/x-ipynb+json'
                  : type === 'markdown'
                    ? 'text/markdown'
                    : 'text/plain');
    this.artifacts.set(artifactId, {
      content,
      contentHash: `sha256:${contentHash}`,
      mediaType,
    });
    return {
      reference: {
        artifactId,
        version: 1,
        contentHash: `sha256:${contentHash}`,
        mediaType,
        notebookId,
        cellId,
      },
      artifactId,
      version: 1,
      lineage,
    };
  }

  private findArtifactMediaType(artifactId: string): string | undefined {
    for (const notebook of this.notebooks.values()) {
      for (const cell of notebook.cells) {
        const output = cell.outputs.find((item) => item.artifactId === artifactId);
        if (output?.mediaType !== undefined) return output.mediaType;
      }
    }
    return undefined;
  }

  private runPython(
    notebookId: string,
    cellId: string,
    source: string,
  ): Promise<{ type: 'text'; value: JsonValue }> {
    const existing = this.pendingPython.get(notebookId);
    if (existing !== undefined)
      return Promise.reject(new Error('A notebook cell is already running'));
    const child = this.pythonProcess(notebookId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        this.pendingPython.delete(notebookId);
        reject(runtimeError('COMPUTE_RESOURCE_UNAVAILABLE', 'Notebook cell timed out'));
      }, 120_000);
      this.pendingPython.set(notebookId, { cellId, resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ source })}\n`);
    });
  }

  private pythonProcess(notebookId: string): ChildProcessWithoutNullStreams {
    const existing = this.processes.get(notebookId);
    if (existing !== undefined) return existing;
    const child = spawn(
      process.env['SPYDERBYTE_PYTHON'] ?? 'python3',
      ['-u', '-c', PYTHON_NOTEBOOK_BRIDGE],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.processes.set(notebookId, child);
    this.pythonBuffers.set(notebookId, '');
    child.stdout.on('data', (chunk: Buffer) => {
      const buffer = `${this.pythonBuffers.get(notebookId) ?? ''}${chunk.toString('utf8')}`;
      const lines = buffer.split('\n');
      this.pythonBuffers.set(notebookId, lines.pop() ?? '');
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        const pending = this.pendingPython.get(notebookId);
        if (pending === undefined) continue;
        clearTimeout(pending.timer);
        this.pendingPython.delete(notebookId);
        try {
          const response = JSON.parse(line) as PythonResponse;
          if (response.ok) pending.resolve({ type: 'text', value: response.stdout ?? '' });
          else
            pending.reject(new Error(response.error ?? response.traceback ?? 'Python cell failed'));
        } catch {
          pending.reject(new Error('Python kernel returned invalid output'));
        }
      }
    });
    child.once('error', (error) => {
      const pending = this.pendingPython.get(notebookId);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.pendingPython.delete(notebookId);
        pending.reject(error);
      }
    });
    child.once('close', (_code, signal) => {
      const pending = this.pendingPython.get(notebookId);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.pendingPython.delete(notebookId);
        pending.reject(
          runtimeError(
            'COMPUTE_RESOURCE_UNAVAILABLE',
            signal ? 'Notebook cell was cancelled' : 'Python kernel stopped',
          ),
        );
      }
      this.processes.delete(notebookId);
      this.pythonBuffers.delete(notebookId);
    });
    return child;
  }
}
