import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, join } from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import {
  newSortableId,
  runtimeError,
  type ArtifactReference,
  type HashSha256,
  type Id,
  type JsonPrimitive,
  type JsonValue,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';

export type LocalExperimentStateV1 =
  | 'draft'
  | 'validating'
  | 'ready'
  | 'running'
  | 'completed'
  | 'compared'
  | 'promoted'
  | 'archived';

export type LocalExperimentTaskV1 = 'classification' | 'regression' | 'generation' | 'custom';

export interface ExperimentComputeSpecV1 {
  readonly runtimeProfileId?: Id;
  readonly cpuMillicores: number;
  readonly memoryBytes: number;
  readonly gpuType?: string;
  readonly gpuCount: number;
  readonly maxDurationMs: number;
  readonly estimatedCostMinor?: number;
  readonly currency: string;
}

export interface ExperimentMetricSpecV1 {
  readonly name: string;
  readonly higherIsBetter: boolean;
  readonly requiredMinimum?: number;
  readonly maximumRegression?: number;
}

export interface LocalExperimentDefinitionInputV1 {
  readonly experimentId?: Id;
  readonly tenant: TenantRef;
  readonly name: string;
  readonly datasetVersion: ArtifactReference;
  readonly target: string;
  readonly features: readonly string[];
  readonly task: LocalExperimentTaskV1;
  readonly algorithm: string;
  readonly baseModel?: string;
  readonly environmentRevision: ArtifactReference;
  readonly compute: ExperimentComputeSpecV1;
  readonly metrics: readonly ExperimentMetricSpecV1[];
  readonly hyperparameters: Readonly<Record<string, JsonValue>>;
  readonly seed: number;
  readonly outputDestination: string;
  readonly environmentLockfile?: string;
}

export interface LocalExperimentDefinitionV1 extends LocalExperimentDefinitionInputV1 {
  readonly schemaVersion: 1;
  readonly experimentId: Id;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ExperimentStateTransitionV1 {
  readonly from: LocalExperimentStateV1;
  readonly to: LocalExperimentStateV1;
  readonly at: string;
}

export type ExperimentRunStatusV1 =
  | 'queued'
  | 'provisioning'
  | 'running'
  | 'finalizing'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'partially_succeeded';

export type ExperimentEventKindV1 =
  | 'queued'
  | 'provisioning'
  | 'started'
  | 'epoch'
  | 'step'
  | 'log'
  | 'loss'
  | 'metric'
  | 'resource'
  | 'checkpoint'
  | 'cost'
  | 'retry'
  | 'failure'
  | 'evaluation'
  | 'completed'
  | 'cancelled';

export interface ExperimentRunEventV1 {
  readonly sequence: number;
  readonly eventId: Id;
  readonly kind: ExperimentEventKindV1;
  readonly runId: Id;
  readonly attemptId: Id;
  readonly occurredAt: string;
  readonly payload: Record<string, JsonValue>;
}

export interface ExperimentAttemptV1 {
  readonly attemptId: Id;
  readonly attemptNumber: number;
  readonly status: ExperimentRunStatusV1;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly error?: string;
  readonly eventStartSequence: number;
  readonly eventEndSequence?: number;
}

export interface ExperimentMetricObservationV1 {
  readonly metricId: Id;
  readonly name: string;
  readonly value: number;
  readonly step?: number;
  readonly epoch?: number;
  readonly unit: string;
  readonly observedAt: string;
  readonly labels?: Readonly<Record<string, string>>;
}

export interface ExperimentResourceObservationV1 {
  readonly observedAt: string;
  readonly cpuMillicores?: number;
  readonly memoryBytes?: number;
  readonly gpuMemoryBytes?: number;
  readonly gpuUtilizationPercent?: number;
}

export interface ExperimentCostV1 {
  readonly currency: string;
  readonly estimatedMinor: number;
  readonly actualMinor: number;
}

export type PublishedExperimentArtifactKindV1 =
  | 'checkpoint'
  | 'metrics'
  | 'evaluation'
  | 'plot'
  | 'report'
  | 'environment-lockfile'
  | 'model';

export interface PublishedExperimentArtifactV1 extends ArtifactReference {
  readonly kind: PublishedExperimentArtifactKindV1;
  readonly experimentId: Id;
  readonly runId?: Id;
  readonly immutable: true;
  readonly lineage: readonly ArtifactReference[];
  readonly localPath: string;
}

export interface LocalExperimentRunV1 {
  readonly schemaVersion: 1;
  readonly runId: Id;
  readonly experimentId: Id;
  readonly tenant: TenantRef;
  readonly variantId: string;
  readonly variantLabel?: string;
  readonly configuration: Readonly<Record<string, JsonValue>>;
  readonly status: ExperimentRunStatusV1;
  readonly attemptIds: readonly Id[];
  readonly attempts: readonly ExperimentAttemptV1[];
  readonly events: readonly ExperimentRunEventV1[];
  readonly logs: readonly string[];
  readonly metrics: readonly ExperimentMetricObservationV1[];
  readonly resources: readonly ExperimentResourceObservationV1[];
  readonly checkpoints: readonly PublishedExperimentArtifactV1[];
  readonly artifacts: readonly PublishedExperimentArtifactV1[];
  readonly cost: ExperimentCostV1;
  readonly output?: Readonly<Record<string, JsonValue>>;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly error?: string;
}

export interface LocalExperimentRecordV1 extends LocalExperimentDefinitionV1 {
  readonly state: LocalExperimentStateV1;
  readonly runIds: readonly Id[];
  readonly comparisonIds: readonly Id[];
  readonly modelVersionIds: readonly Id[];
  readonly history: readonly ExperimentStateTransitionV1[];
}

export interface LocalExperimentComparisonV1 {
  readonly schemaVersion: 1;
  readonly comparisonId: Id;
  readonly tenant: TenantRef;
  readonly experimentIds: readonly Id[];
  readonly runIds: readonly Id[];
  readonly metrics: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly curves: Readonly<Record<string, Readonly<Record<string, readonly JsonValue[]>>>>;
  readonly distributions: Readonly<Record<string, Readonly<Record<string, readonly number[]>>>>;
  readonly confusionMatrices: Readonly<Record<string, readonly JsonValue[]>>;
  readonly explainability: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly artifacts: readonly PublishedExperimentArtifactV1[];
  readonly immutable: true;
  readonly createdAt: string;
}

export interface ExperimentEvaluationRequestV1 {
  readonly runId: Id;
  readonly benchmarkId: string;
  readonly benchmarkVersion: number;
  readonly observations: readonly ExperimentEvaluationObservationV1[];
  readonly metrics?: readonly ExperimentMetricSpecV1[];
  readonly baselineRunId?: Id;
  readonly minimumSampleSize?: number;
  readonly limitations?: readonly string[];
}

export interface ExperimentEvaluationObservationV1 {
  readonly expected: JsonPrimitive;
  readonly candidate: JsonPrimitive;
  readonly baseline?: JsonPrimitive;
}

export interface ExperimentEvaluationMetricV1 {
  readonly name: string;
  readonly candidate: number;
  readonly baseline?: number;
  readonly regression?: number;
  readonly passed: boolean;
}

export interface LocalExperimentEvaluationV1 {
  readonly schemaVersion: 1;
  readonly evaluationId: Id;
  readonly tenant: TenantRef;
  readonly experimentId: Id;
  readonly runId: Id;
  readonly candidateArtifact: PublishedExperimentArtifactV1;
  readonly baselineArtifact?: PublishedExperimentArtifactV1;
  readonly datasetVersion: ArtifactReference;
  readonly benchmarkId: string;
  readonly benchmarkVersion: number;
  readonly sampleSize: number;
  readonly inputDigest: HashSha256;
  readonly evaluationArtifact: PublishedExperimentArtifactV1;
  readonly metrics: readonly ExperimentEvaluationMetricV1[];
  readonly recommendation: 'promote' | 'reject' | 'investigate';
  readonly limitations: readonly string[];
  readonly immutable: true;
  readonly createdAt: string;
}

export type ModelRegistryStageV1 = 'candidate' | 'validated' | 'production' | 'archived';
export type ModelValidationStateV1 = 'pending' | 'passed' | 'failed';
export type ModelApprovalStateV1 = 'pending' | 'approved' | 'rejected';

export interface ModelCardV1 {
  readonly summary: string;
  readonly intendedUse: string;
  readonly limitations: readonly string[];
  readonly risks: readonly string[];
  readonly owner?: string;
}

export interface ModelDeploymentHistoryEntryV1 {
  readonly deploymentId: Id;
  readonly stage: string;
  readonly status: string;
  readonly at: string;
}

export interface LocalModelRegistryRecordV1 {
  readonly schemaVersion: 1;
  readonly modelVersionId: Id;
  readonly tenant: TenantRef;
  readonly modelName: string;
  readonly version: number;
  readonly stage: ModelRegistryStageV1;
  readonly sourceExperimentId: Id;
  readonly sourceRunId: Id;
  readonly candidateArtifact: PublishedExperimentArtifactV1;
  readonly metrics: Readonly<Record<string, number>>;
  readonly datasetLineage: readonly ArtifactReference[];
  readonly environmentRevision: ArtifactReference;
  readonly validation: {
    readonly state: ModelValidationStateV1;
    readonly evaluationId?: Id;
    readonly evidenceArtifactIds: readonly Id[];
    readonly checkedAt?: string;
  };
  readonly approval: {
    readonly state: ModelApprovalStateV1;
    readonly decisionId?: Id;
    readonly digest?: string;
    readonly decidedAt?: string;
  };
  readonly modelCard: ModelCardV1;
  readonly deploymentHistory: readonly ModelDeploymentHistoryEntryV1[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ModelPromotionDecisionV1 {
  readonly schemaVersion: 1;
  readonly decisionId: Id;
  readonly tenant: TenantRef;
  readonly modelVersionId: Id;
  readonly from: ModelRegistryStageV1;
  readonly to: ModelRegistryStageV1;
  readonly evaluationId: Id;
  readonly validationEvidenceArtifactIds: readonly Id[];
  readonly policyApproved: true;
  readonly approvalDigest: string;
  readonly reason?: string;
  readonly immutable: true;
  readonly decidedAt: string;
}

export interface ExperimentRunStartInputV1 {
  readonly experimentId: Id;
  readonly variantId: string;
  readonly variantLabel?: string;
  readonly hyperparameters?: Readonly<Record<string, JsonValue>>;
  readonly configuration?: Readonly<Record<string, JsonValue>>;
}

export interface ExperimentComparisonInputV1 {
  readonly runIds: readonly Id[];
}

export interface ModelCandidateInputV1 {
  readonly runId: Id;
  readonly modelName: string;
  readonly modelCard: ModelCardV1;
}

export interface ModelValidationInputV1 {
  readonly modelVersionId: Id;
  readonly evaluationId: Id;
}

export interface ModelPromotionInputV1 {
  readonly modelVersionId: Id;
  readonly policyApproved: boolean;
  readonly approvalDigest: string;
  readonly commitApprovalDigest: string;
  readonly reason?: string;
}

export interface LocalExperimentRuntime {
  readonly available: boolean;
  list(tenant: TenantRef): Promise<readonly LocalExperimentRecordV1[]>;
  get(tenant: TenantRef, experimentId: Id): Promise<LocalExperimentRecordV1 | undefined>;
  create(input: LocalExperimentDefinitionInputV1): Promise<LocalExperimentRecordV1>;
  validate(tenant: TenantRef, experimentId: Id): Promise<LocalExperimentRecordV1>;
  archive(tenant: TenantRef, experimentId: Id): Promise<LocalExperimentRecordV1>;
  start(
    input: ExperimentRunStartInputV1 & { readonly tenant: TenantRef },
  ): Promise<LocalExperimentRunV1>;
  getRun(tenant: TenantRef, runId: Id): Promise<LocalExperimentRunV1 | undefined>;
  listRuns(tenant: TenantRef, experimentId?: Id): Promise<readonly LocalExperimentRunV1[]>;
  listEvents(
    tenant: TenantRef,
    runId: Id,
    afterSequence?: number,
  ): Promise<readonly ExperimentRunEventV1[]>;
  cancel(tenant: TenantRef, runId: Id): Promise<LocalExperimentRunV1>;
  retry(tenant: TenantRef, runId: Id): Promise<LocalExperimentRunV1>;
  compare(
    tenant: TenantRef,
    input: ExperimentComparisonInputV1,
  ): Promise<LocalExperimentComparisonV1>;
  listComparisons(tenant: TenantRef): Promise<readonly LocalExperimentComparisonV1[]>;
  getComparison(
    tenant: TenantRef,
    comparisonId: Id,
  ): Promise<LocalExperimentComparisonV1 | undefined>;
  evaluate(
    tenant: TenantRef,
    input: ExperimentEvaluationRequestV1,
  ): Promise<LocalExperimentEvaluationV1>;
  listEvaluations(tenant: TenantRef): Promise<readonly LocalExperimentEvaluationV1[]>;
  getEvaluation(
    tenant: TenantRef,
    evaluationId: Id,
  ): Promise<LocalExperimentEvaluationV1 | undefined>;
  registerCandidate(
    tenant: TenantRef,
    input: ModelCandidateInputV1,
  ): Promise<LocalModelRegistryRecordV1>;
  validateModel(
    tenant: TenantRef,
    input: ModelValidationInputV1,
  ): Promise<LocalModelRegistryRecordV1>;
  promoteModel(tenant: TenantRef, input: ModelPromotionInputV1): Promise<ModelPromotionDecisionV1>;
  listModels(tenant: TenantRef, modelName?: string): Promise<readonly LocalModelRegistryRecordV1[]>;
  getModel(tenant: TenantRef, modelVersionId: Id): Promise<LocalModelRegistryRecordV1 | undefined>;
  listPromotionDecisions(tenant: TenantRef): Promise<readonly ModelPromotionDecisionV1[]>;
  getArtifact(
    tenant: TenantRef,
    artifactId: Id,
  ): Promise<
    { readonly artifact: PublishedExperimentArtifactV1; readonly content: string } | undefined
  >;
}

export interface LocalExperimentRuntimeOptions {
  readonly rootPath: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly clock?: () => string;
  readonly maxLogBytes?: number;
}

interface ExperimentStateFileV1 {
  readonly schemaVersion: 1;
  experiments: LocalExperimentRecordV1[];
  runs: LocalExperimentRunV1[];
  comparisons: LocalExperimentComparisonV1[];
  evaluations: LocalExperimentEvaluationV1[];
  models: LocalModelRegistryRecordV1[];
  decisions: ModelPromotionDecisionV1[];
  artifacts: PublishedExperimentArtifactV1[];
  nextEventSequence: number;
}

interface ParsedTrainingOutput {
  readonly metrics: Record<string, number>;
  readonly events: readonly Record<string, JsonValue>[];
  readonly checkpoint?: JsonValue;
  readonly output?: Record<string, JsonValue>;
  readonly featureImportance?: Record<string, number>;
  readonly confusionMatrix?: readonly JsonValue[];
}

const MAX_VARIANT_LENGTH = 160;
const MAX_EVENTS_PER_RUN = 20_000;
const MAX_LOG_LINES = 2_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sameTenant(left: TenantRef, right: TenantRef): boolean {
  return left.tenantId === right.tenantId && left.workspaceId === right.workspaceId;
}

function safeId(value: string, label: string): string {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(value)) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} is invalid`);
  }
  return value;
}

function required(value: string, label: string, maxLength = 256): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} is required and bounded`);
  }
  return value.trim();
}

function assertArtifact(tenant: TenantRef, artifact: ArtifactReference, label: string): void {
  if (!sameTenant(tenant, artifact.tenant)) {
    throw runtimeError('POLICY_DENIED', `${label} crosses the experiment tenant boundary`);
  }
  if (!safeId(artifact.artifactId, `${label} artifactId`)) return;
  if (!Number.isSafeInteger(artifact.version) || artifact.version < 1) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} version must be positive`);
  }
  if (!/^[a-f0-9]{64}$/.test(artifact.contentHash)) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} contentHash must be SHA-256`);
  }
}

function hashContent(content: string): HashSha256 {
  return createHash('sha256').update(content).digest('hex') as HashSha256;
}

function numericMap(value: unknown): Record<string, number> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) =>
      typeof item === 'number' && Number.isFinite(item) ? [[key, item]] : [],
    ),
  );
}

function transitionAllowed(from: LocalExperimentStateV1, to: LocalExperimentStateV1): boolean {
  const allowed: Record<LocalExperimentStateV1, readonly LocalExperimentStateV1[]> = {
    draft: ['validating', 'ready', 'archived'],
    validating: ['ready', 'draft', 'archived'],
    ready: ['running', 'archived'],
    running: ['completed', 'archived'],
    completed: ['compared', 'archived'],
    compared: ['promoted', 'archived'],
    promoted: ['archived'],
    archived: [],
  };
  return from === to || allowed[from].includes(to);
}

function artifactReference(
  tenant: TenantRef,
  content: string,
  mediaType: string,
  createdAt: string,
): ArtifactReference {
  return {
    schemaVersion: 1,
    tenant: clone(tenant),
    artifactId: newSortableId(),
    version: 1,
    contentHash: hashContent(content),
    mediaType,
    sizeBytes: Buffer.byteLength(content, 'utf8'),
    createdAt,
  };
}

function outputFromText(text: string): ParsedTrainingOutput {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  let finalRecord: Record<string, JsonValue> = {};
  const events: Record<string, JsonValue>[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const record = parsed as Record<string, JsonValue>;
      finalRecord = record;
      if (typeof record['type'] === 'string') events.push(record);
    } catch {
      // Human-readable process output is retained as a log, not treated as structured evidence.
    }
  }
  const metrics = numericMap(finalRecord['metrics']);
  if (typeof finalRecord['metric'] === 'number' && Number.isFinite(finalRecord['metric'])) {
    metrics['primary'] = finalRecord['metric'];
  }
  const nestedEvents = finalRecord['events'];
  if (Array.isArray(nestedEvents)) {
    for (const entry of nestedEvents) {
      if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
        events.push(entry as Record<string, JsonValue>);
      }
    }
  }
  const outputValue = finalRecord['output'];
  const output =
    outputValue !== null && typeof outputValue === 'object' && !Array.isArray(outputValue)
      ? (outputValue as Record<string, JsonValue>)
      : undefined;
  const featureImportance = numericMap(finalRecord['featureImportance']);
  const confusionValue = finalRecord['confusionMatrix'];
  const confusionMatrix = Array.isArray(confusionValue) ? confusionValue : undefined;
  return {
    metrics,
    events,
    ...(finalRecord['checkpoint'] === undefined ? {} : { checkpoint: finalRecord['checkpoint'] }),
    ...(output === undefined ? {} : { output }),
    ...(Object.keys(featureImportance).length === 0 ? {} : { featureImportance }),
    ...(confusionMatrix === undefined ? {} : { confusionMatrix }),
  };
}

function eventPayload(value: Record<string, unknown>): Record<string, JsonValue> {
  return value as Record<string, JsonValue>;
}

function modelDigest(
  model: LocalModelRegistryRecordV1,
  evaluation: LocalExperimentEvaluationV1,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        modelVersionId: model.modelVersionId,
        candidateArtifact: model.candidateArtifact.contentHash,
        sourceExperimentId: model.sourceExperimentId,
        sourceRunId: model.sourceRunId,
        evaluationId: evaluation.evaluationId,
        evaluationArtifact: evaluation.evaluationArtifact.contentHash,
        validationEvidenceArtifactIds: model.validation.evidenceArtifactIds,
      }),
    )
    .digest('hex');
}

/**
 * Durable local experiment and model lifecycle. The configured command receives an immutable
 * request file and can emit newline-delimited JSON telemetry while it runs. Every line is retained
 * as a bounded event/log record, while terminal evidence is published as content-addressed local
 * artifacts. Hosted composition can replace this adapter without changing the API contract.
 */
export class FileExperimentRuntime implements LocalExperimentRuntime {
  readonly available: boolean;

  private readonly rootPath: string;
  private readonly statePath: string;
  private readonly artifactRoot: string;
  private readonly command: string | undefined;
  private readonly args: readonly string[];
  private readonly clock: () => string;
  private readonly maxLogBytes: number;
  private state: ExperimentStateFileV1 | undefined;
  private loading: Promise<void> | undefined;
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly processes = new Map<Id, ChildProcessWithoutNullStreams>();
  private readonly cancelledRuns = new Set<Id>();
  private readonly timedOutRuns = new Set<Id>();

  constructor(options: LocalExperimentRuntimeOptions) {
    this.rootPath = options.rootPath;
    this.statePath = join(options.rootPath, '.agentic', 'experiments.json');
    this.artifactRoot = join(options.rootPath, '.agentic', 'experiments', 'artifacts');
    this.command = options.command ?? process.env['SPYDERBYTE_TRAIN_COMMAND'];
    const envArgs = process.env['SPYDERBYTE_TRAIN_ARGS'];
    let configuredArgs: string[] | undefined;
    if (envArgs !== undefined && envArgs.trim().length > 0) {
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
    this.maxLogBytes = Math.max(
      4_096,
      Math.min(options.maxLogBytes ?? 256 * 1024, 4 * 1024 * 1024),
    );
  }

  async list(tenant: TenantRef): Promise<readonly LocalExperimentRecordV1[]> {
    await this.ensureLoaded();
    await this.mutationQueue;
    return clone((this.state?.experiments ?? []).filter((item) => sameTenant(item.tenant, tenant)));
  }

  async get(tenant: TenantRef, experimentId: Id): Promise<LocalExperimentRecordV1 | undefined> {
    await this.ensureLoaded();
    await this.mutationQueue;
    const record = this.state?.experiments.find((item) => item.experimentId === experimentId);
    if (record !== undefined && !sameTenant(record.tenant, tenant)) {
      throw runtimeError('POLICY_DENIED', 'Experiment crosses the tenant boundary');
    }
    return record === undefined ? undefined : clone(record);
  }

  async create(input: LocalExperimentDefinitionInputV1): Promise<LocalExperimentRecordV1> {
    await this.ensureLoaded();
    this.validateDefinition(input);
    const experimentId = input.experimentId ?? newSortableId();
    const now = this.clock();
    return this.mutate(async () => {
      if (this.state?.experiments.some((item) => item.experimentId === experimentId)) {
        throw runtimeError(
          'CONCURRENCY_STALE_VERSION',
          `Experiment ${experimentId} already exists`,
        );
      }
      const record: LocalExperimentRecordV1 = {
        schemaVersion: 1,
        ...clone(input),
        experimentId,
        state: 'draft',
        runIds: [],
        comparisonIds: [],
        modelVersionIds: [],
        history: [],
        createdAt: now,
        updatedAt: now,
      };
      this.state?.experiments.push(record);
      await this.writeState();
      return clone(record);
    });
  }

  async validate(tenant: TenantRef, experimentId: Id): Promise<LocalExperimentRecordV1> {
    const record = await this.requiredExperiment(tenant, experimentId);
    if (record.state !== 'draft' && record.state !== 'validating') {
      throw runtimeError('CONCURRENCY_STALE_VERSION', `Experiment ${experimentId} is not draft`);
    }
    await this.setExperimentState(record, 'validating');
    return this.setExperimentState(await this.requiredExperiment(tenant, experimentId), 'ready');
  }

  async archive(tenant: TenantRef, experimentId: Id): Promise<LocalExperimentRecordV1> {
    const record = await this.requiredExperiment(tenant, experimentId);
    return this.setExperimentState(record, 'archived');
  }

  async start(
    input: ExperimentRunStartInputV1 & { readonly tenant: TenantRef },
  ): Promise<LocalExperimentRunV1> {
    if (!this.available) {
      throw runtimeError(
        'COMPUTE_RESOURCE_UNAVAILABLE',
        'Configure SPYDERBYTE_TRAIN_COMMAND before starting an experiment',
      );
    }
    await this.ensureLoaded();
    const record = await this.requiredExperiment(input.tenant, input.experimentId);
    if (!['ready', 'running'].includes(record.state)) {
      throw runtimeError(
        'CONCURRENCY_STALE_VERSION',
        `Experiment ${input.experimentId} must be ready or running before a variant starts`,
      );
    }
    const variantId = required(input.variantId, 'variantId', MAX_VARIANT_LENGTH);
    const existing = (this.state?.runs ?? []).find(
      (run) =>
        run.experimentId === record.experimentId &&
        run.variantId === variantId &&
        ['queued', 'provisioning', 'running', 'finalizing'].includes(run.status),
    );
    if (existing !== undefined) {
      throw runtimeError('CONCURRENCY_STALE_VERSION', `Variant ${variantId} is already running`);
    }
    const runId = newSortableId();
    const attemptId = newSortableId();
    const now = this.clock();
    const mergedConfiguration: Record<string, JsonValue> = {
      ...clone(record.hyperparameters),
      ...(input.hyperparameters === undefined ? {} : clone(input.hyperparameters)),
      ...(input.configuration === undefined ? {} : clone(input.configuration)),
      seed: record.seed,
      variantId,
      datasetVersion: record.datasetVersion.contentHash,
      environmentRevision: record.environmentRevision.contentHash,
    };
    const run: LocalExperimentRunV1 = {
      schemaVersion: 1,
      runId,
      experimentId: record.experimentId,
      tenant: clone(input.tenant),
      variantId,
      ...(input.variantLabel === undefined ? {} : { variantLabel: input.variantLabel }),
      configuration: mergedConfiguration,
      status: 'queued',
      attemptIds: [attemptId],
      attempts: [
        {
          attemptId,
          attemptNumber: 1,
          status: 'queued',
          eventStartSequence: this.state?.nextEventSequence ?? 1,
        },
      ],
      events: [],
      logs: [],
      metrics: [],
      resources: [],
      checkpoints: [],
      artifacts: [],
      cost: {
        currency: record.compute.currency,
        estimatedMinor: record.compute.estimatedCostMinor ?? 0,
        actualMinor: 0,
      },
      createdAt: now,
    };
    await this.mutate(async () => {
      this.state?.runs.push(run);
      const current = this.requireExperimentState(input.tenant, input.experimentId);
      const next =
        current.state === 'ready'
          ? this.transitionRecord(current, 'running')
          : { ...current, updatedAt: now };
      this.replaceExperimentState({
        ...next,
        runIds: next.runIds.includes(runId) ? next.runIds : [...next.runIds, runId],
      });
      await this.writeState();
    });
    await this.appendEvent(runId, attemptId, 'queued', { variantId });
    void this.execute(runId).catch(async (error: unknown) => {
      const current = await this.getRun(input.tenant, runId);
      if (current === undefined || ['failed', 'cancelled', 'timed_out'].includes(current.status))
        return;
      await this.finishRun(runId, 'failed', error instanceof Error ? error.message : String(error));
    });
    return clone(run);
  }

  async getRun(tenant: TenantRef, runId: Id): Promise<LocalExperimentRunV1 | undefined> {
    await this.ensureLoaded();
    await this.mutationQueue;
    const run = this.state?.runs.find((item) => item.runId === runId);
    if (run !== undefined && !sameTenant(run.tenant, tenant)) {
      throw runtimeError('POLICY_DENIED', 'Experiment run crosses the tenant boundary');
    }
    return run === undefined ? undefined : clone(run);
  }

  async listRuns(tenant: TenantRef, experimentId?: Id): Promise<readonly LocalExperimentRunV1[]> {
    await this.ensureLoaded();
    await this.mutationQueue;
    return clone(
      (this.state?.runs ?? []).filter(
        (run) =>
          sameTenant(run.tenant, tenant) &&
          (experimentId === undefined || run.experimentId === experimentId),
      ),
    );
  }

  async listEvents(
    tenant: TenantRef,
    runId: Id,
    afterSequence = 0,
  ): Promise<readonly ExperimentRunEventV1[]> {
    const run = await this.requiredRun(tenant, runId);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'afterSequence must be a non-negative integer',
      );
    }
    return clone(run.events.filter((event) => event.sequence > afterSequence));
  }

  async cancel(tenant: TenantRef, runId: Id): Promise<LocalExperimentRunV1> {
    const run = await this.requiredRun(tenant, runId);
    if (!['queued', 'provisioning', 'running', 'finalizing'].includes(run.status)) return run;
    this.cancelledRuns.add(runId);
    const process = this.processes.get(runId);
    if (process !== undefined) process.kill('SIGTERM');
    await this.finishRun(runId, 'cancelled', 'Experiment run was cancelled');
    return (await this.requiredRun(tenant, runId)) as LocalExperimentRunV1;
  }

  async retry(tenant: TenantRef, runId: Id): Promise<LocalExperimentRunV1> {
    const run = await this.requiredRun(tenant, runId);
    if (!['failed', 'cancelled', 'timed_out', 'partially_succeeded'].includes(run.status)) {
      throw runtimeError('CONCURRENCY_STALE_VERSION', 'Only a terminal unsuccessful run can retry');
    }
    const previousAttempt = run.attempts.at(-1);
    if (previousAttempt === undefined) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Run has no attempt to retry');
    }
    const attemptId = newSortableId();
    const nextAttempt: ExperimentAttemptV1 = {
      attemptId,
      attemptNumber: previousAttempt.attemptNumber + 1,
      status: 'queued',
      eventStartSequence: this.state?.nextEventSequence ?? 1,
    };
    await this.mutate(async () => {
      const current = this.requireRunState(runId);
      const withoutTerminalFields = Object.fromEntries(
        Object.entries(current).filter(([key]) => key !== 'error' && key !== 'completedAt'),
      ) as Omit<LocalExperimentRunV1, 'error' | 'completedAt'>;
      const next: LocalExperimentRunV1 = {
        ...withoutTerminalFields,
        status: 'queued',
        attemptIds: [...current.attemptIds, attemptId],
        attempts: [...current.attempts, nextAttempt],
      };
      this.replaceRunState(next);
      await this.writeState();
    });
    await this.appendEvent(runId, attemptId, 'retry', {
      previousAttemptId: previousAttempt.attemptId,
      attemptNumber: nextAttempt.attemptNumber,
    });
    this.cancelledRuns.delete(runId);
    this.timedOutRuns.delete(runId);
    void this.execute(runId).catch(async (error: unknown) => {
      const current = await this.getRun(tenant, runId);
      if (current === undefined || ['failed', 'cancelled', 'timed_out'].includes(current.status)) {
        return;
      }
      await this.finishRun(runId, 'failed', error instanceof Error ? error.message : String(error));
    });
    return (await this.requiredRun(tenant, runId)) as LocalExperimentRunV1;
  }

  async compare(
    tenant: TenantRef,
    input: ExperimentComparisonInputV1,
  ): Promise<LocalExperimentComparisonV1> {
    if (input.runIds.length < 2 || new Set(input.runIds).size !== input.runIds.length) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Comparison requires two unique run IDs');
    }
    const runs = await Promise.all(input.runIds.map((runId) => this.requiredRun(tenant, runId)));
    if (runs.some((run) => run.status !== 'succeeded')) {
      throw runtimeError('CONCURRENCY_STALE_VERSION', 'Only successful runs can be compared');
    }
    const experimentIds = [...new Set(runs.map((run) => run.experimentId))];
    const metrics: Record<string, Record<string, number>> = {};
    const curves: Record<string, Record<string, JsonValue[]>> = {};
    const distributions: Record<string, Record<string, number[]>> = {};
    const confusionMatrices: Record<string, readonly JsonValue[]> = {};
    const explainability: Record<string, Record<string, number>> = {};
    for (const run of runs) {
      for (const observation of run.metrics) {
        (metrics[observation.name] ??= {})[run.runId] = observation.value;
        (curves[observation.name] ??= {})[run.runId] ??= [];
        curves[observation.name]?.[run.runId]?.push({
          x:
            observation.step ??
            observation.epoch ??
            (curves[observation.name]?.[run.runId]?.length ?? 0) + 1,
          y: observation.value,
        });
        (distributions[observation.name] ??= {})[run.runId] ??= [];
        distributions[observation.name]?.[run.runId]?.push(observation.value);
      }
      const confusion = run.output?.['confusionMatrix'];
      if (Array.isArray(confusion)) confusionMatrices[run.runId] = clone(confusion);
      const importance = run.output?.['featureImportance'];
      const importanceMap = numericMap(importance);
      if (Object.keys(importanceMap).length > 0) explainability[run.runId] = importanceMap;
    }
    const comparisonId = newSortableId();
    const now = this.clock();
    const firstRun = runs[0];
    if (firstRun === undefined)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'No runs to compare');
    const content = JSON.stringify({
      experimentIds,
      runIds: input.runIds,
      metrics,
      curves,
      distributions,
    });
    const artifact = await this.publishArtifact(firstRun, 'plot', content, 'application/json', []);
    const report = await this.publishArtifact(
      firstRun,
      'report',
      JSON.stringify({
        comparisonId,
        experimentIds,
        runIds: input.runIds,
        metrics,
        explainability,
      }),
      'application/json',
      [],
    );
    const comparison: LocalExperimentComparisonV1 = {
      schemaVersion: 1,
      comparisonId,
      tenant: clone(tenant),
      experimentIds,
      runIds: [...input.runIds],
      metrics,
      curves,
      distributions,
      confusionMatrices,
      explainability,
      artifacts: [artifact, report],
      immutable: true,
      createdAt: now,
    };
    await this.mutate(async () => {
      this.state?.comparisons.push(comparison);
      for (const experimentId of experimentIds) {
        const record = this.requireExperimentState(tenant, experimentId);
        const next = {
          ...record,
          state: record.state === 'completed' ? ('compared' as const) : record.state,
          comparisonIds: record.comparisonIds.includes(comparisonId)
            ? record.comparisonIds
            : [...record.comparisonIds, comparisonId],
          updatedAt: now,
        };
        this.replaceExperimentState(next);
      }
      await this.writeState();
    });
    return clone(comparison);
  }

  async listComparisons(tenant: TenantRef): Promise<readonly LocalExperimentComparisonV1[]> {
    await this.ensureLoaded();
    await this.mutationQueue;
    return clone((this.state?.comparisons ?? []).filter((item) => sameTenant(item.tenant, tenant)));
  }

  async getComparison(
    tenant: TenantRef,
    comparisonId: Id,
  ): Promise<LocalExperimentComparisonV1 | undefined> {
    await this.ensureLoaded();
    await this.mutationQueue;
    const comparison = this.state?.comparisons.find((item) => item.comparisonId === comparisonId);
    if (comparison !== undefined && !sameTenant(comparison.tenant, tenant)) {
      throw runtimeError('POLICY_DENIED', 'Experiment comparison crosses the tenant boundary');
    }
    return comparison === undefined ? undefined : clone(comparison);
  }

  async evaluate(
    tenant: TenantRef,
    input: ExperimentEvaluationRequestV1,
  ): Promise<LocalExperimentEvaluationV1> {
    const run = await this.requiredRun(tenant, input.runId);
    if (run.status !== 'succeeded') {
      throw runtimeError('CONCURRENCY_STALE_VERSION', 'Only successful runs can be evaluated');
    }
    const experiment = await this.requiredExperiment(tenant, run.experimentId);
    const observations = clone(input.observations);
    const minimumSampleSize = input.minimumSampleSize ?? 1;
    if (!Number.isSafeInteger(minimumSampleSize) || minimumSampleSize < 1) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'minimumSampleSize must be positive');
    }
    if (observations.length < minimumSampleSize) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Evaluation sample is smaller than required');
    }
    const metrics = input.metrics ?? experiment.metrics;
    if (metrics.length === 0)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Evaluation metrics are required');
    const baselineRun =
      input.baselineRunId === undefined
        ? undefined
        : await this.requiredRun(tenant, input.baselineRunId);
    if (baselineRun !== undefined && baselineRun.status !== 'succeeded') {
      throw runtimeError('CONCURRENCY_STALE_VERSION', 'Baseline run must be successful');
    }
    const resultMetrics: ExperimentEvaluationMetricV1[] = [];
    let failedThreshold = false;
    let regression = false;
    for (const spec of metrics) {
      const candidate = this.evaluationMetric(observations, spec.name, run);
      const baseline =
        baselineRun === undefined
          ? undefined
          : this.evaluationMetric(observations, spec.name, baselineRun);
      const delta =
        baseline === undefined
          ? undefined
          : spec.higherIsBetter
            ? baseline - candidate
            : candidate - baseline;
      const belowMinimum = spec.requiredMinimum !== undefined && candidate < spec.requiredMinimum;
      const aboveRegression =
        delta !== undefined &&
        spec.maximumRegression !== undefined &&
        delta > spec.maximumRegression;
      failedThreshold ||= belowMinimum;
      regression ||= aboveRegression;
      resultMetrics.push({
        name: spec.name,
        candidate,
        ...(baseline === undefined ? {} : { baseline }),
        ...(delta === undefined ? {} : { regression: delta }),
        passed: !belowMinimum && !aboveRegression,
      });
    }
    const recommendation = regression ? 'investigate' : failedThreshold ? 'reject' : 'promote';
    const evaluationId = newSortableId();
    const candidateArtifact =
      run.checkpoints[0] ?? run.artifacts.find((item) => item.kind === 'model');
    if (candidateArtifact === undefined) {
      throw runtimeError(
        'ARTIFACT_NOT_FOUND',
        'Successful run has no checkpoint artifact to evaluate',
      );
    }
    const baselineArtifact = baselineRun?.checkpoints[0];
    const inputDigest = hashContent(
      JSON.stringify({
        candidateArtifact: candidateArtifact.contentHash,
        baselineArtifact: baselineArtifact?.contentHash,
        datasetVersion: experiment.datasetVersion.contentHash,
        benchmarkId: input.benchmarkId,
        benchmarkVersion: input.benchmarkVersion,
        observations,
        metrics,
      }),
    );
    const limitations = [
      ...(input.limitations ?? []),
      ...(baselineArtifact === undefined ? ['No baseline run was supplied.'] : []),
    ];
    const evaluationContent = JSON.stringify({
      evaluationId,
      runId: run.runId,
      benchmarkId: input.benchmarkId,
      benchmarkVersion: input.benchmarkVersion,
      sampleSize: observations.length,
      inputDigest,
      metrics: resultMetrics,
      recommendation,
      limitations,
    });
    const evaluationArtifact = await this.publishArtifact(
      run,
      'evaluation',
      evaluationContent,
      'application/json',
      [experiment.datasetVersion, experiment.environmentRevision, candidateArtifact],
    );
    const evaluation: LocalExperimentEvaluationV1 = {
      schemaVersion: 1,
      evaluationId,
      tenant: clone(tenant),
      experimentId: experiment.experimentId,
      runId: run.runId,
      candidateArtifact,
      ...(baselineArtifact === undefined ? {} : { baselineArtifact }),
      datasetVersion: clone(experiment.datasetVersion),
      benchmarkId: required(input.benchmarkId, 'benchmarkId', 160),
      benchmarkVersion: input.benchmarkVersion,
      sampleSize: observations.length,
      inputDigest,
      evaluationArtifact,
      metrics: resultMetrics,
      recommendation,
      limitations: [...new Set(limitations.map((item) => item.trim()).filter(Boolean))],
      immutable: true,
      createdAt: this.clock(),
    };
    await this.mutate(async () => {
      this.state?.evaluations.push(evaluation);
      await this.writeState();
    });
    const evaluationAttemptId = run.attemptIds.at(-1);
    if (evaluationAttemptId === undefined) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Experiment run has no attempt');
    }
    await this.appendEvent(run.runId, evaluationAttemptId, 'evaluation', {
      evaluationId,
      recommendation,
    });
    return clone(evaluation);
  }

  async listEvaluations(tenant: TenantRef): Promise<readonly LocalExperimentEvaluationV1[]> {
    await this.ensureLoaded();
    await this.mutationQueue;
    return clone((this.state?.evaluations ?? []).filter((item) => sameTenant(item.tenant, tenant)));
  }

  async getEvaluation(
    tenant: TenantRef,
    evaluationId: Id,
  ): Promise<LocalExperimentEvaluationV1 | undefined> {
    await this.ensureLoaded();
    await this.mutationQueue;
    const evaluation = this.state?.evaluations.find((item) => item.evaluationId === evaluationId);
    if (evaluation !== undefined && !sameTenant(evaluation.tenant, tenant)) {
      throw runtimeError('POLICY_DENIED', 'Evaluation crosses the tenant boundary');
    }
    return evaluation === undefined ? undefined : clone(evaluation);
  }

  async registerCandidate(
    tenant: TenantRef,
    input: ModelCandidateInputV1,
  ): Promise<LocalModelRegistryRecordV1> {
    const run = await this.requiredRun(tenant, input.runId);
    if (run.status !== 'succeeded') {
      throw runtimeError('CONCURRENCY_STALE_VERSION', 'Only successful runs can register a model');
    }
    const experiment = await this.requiredExperiment(tenant, run.experimentId);
    const checkpoint = run.checkpoints[0];
    if (checkpoint === undefined) {
      throw runtimeError('ARTIFACT_NOT_FOUND', 'Model candidate requires a checkpoint artifact');
    }
    const modelName = required(input.modelName, 'modelName', 160);
    const modelCard = this.validateModelCard(input.modelCard);
    const modelArtifact = await this.publishArtifact(
      run,
      'model',
      JSON.stringify({ modelName, runId: run.runId, checkpoint }),
      'application/octet-stream',
      [checkpoint, experiment.datasetVersion, experiment.environmentRevision],
    );
    const versions = (this.state?.models ?? []).filter(
      (model) => sameTenant(model.tenant, tenant) && model.modelName === modelName,
    );
    const now = this.clock();
    const model: LocalModelRegistryRecordV1 = {
      schemaVersion: 1,
      modelVersionId: newSortableId(),
      tenant: clone(tenant),
      modelName,
      version: versions.length + 1,
      stage: 'candidate',
      sourceExperimentId: experiment.experimentId,
      sourceRunId: run.runId,
      candidateArtifact: modelArtifact,
      metrics: this.finalMetrics(run),
      datasetLineage: [clone(experiment.datasetVersion)],
      environmentRevision: clone(experiment.environmentRevision),
      validation: { state: 'pending', evidenceArtifactIds: [] },
      approval: { state: 'pending' },
      modelCard,
      deploymentHistory: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.mutate(async () => {
      this.state?.models.push(model);
      const current = this.requireExperimentState(tenant, experiment.experimentId);
      this.replaceExperimentState({
        ...current,
        modelVersionIds: [...current.modelVersionIds, model.modelVersionId],
        updatedAt: now,
      });
      await this.writeState();
    });
    return clone(model);
  }

  async validateModel(
    tenant: TenantRef,
    input: ModelValidationInputV1,
  ): Promise<LocalModelRegistryRecordV1> {
    const model = await this.requiredModel(tenant, input.modelVersionId);
    const evaluation = await this.requiredEvaluation(tenant, input.evaluationId);
    if (
      evaluation.runId !== model.sourceRunId ||
      evaluation.candidateArtifact.contentHash !== model.candidateArtifact.lineage[0]?.contentHash
    ) {
      throw runtimeError('APPROVAL_INVALIDATED', 'Evaluation is not bound to the model candidate');
    }
    const passed =
      evaluation.recommendation === 'promote' &&
      evaluation.metrics.every((metric) => metric.passed);
    const now = this.clock();
    await this.mutate(async () => {
      const current = this.requireModelState(input.modelVersionId);
      const validation: LocalModelRegistryRecordV1['validation'] = {
        state: passed ? 'passed' : 'failed',
        evaluationId: evaluation.evaluationId,
        evidenceArtifactIds: [evaluation.evaluationArtifact.artifactId],
        checkedAt: now,
      };
      const next: LocalModelRegistryRecordV1 = {
        ...current,
        stage: passed ? 'validated' : 'candidate',
        validation,
        approval: {
          state: 'pending',
          ...(passed ? { digest: modelDigest({ ...current, validation }, evaluation) } : {}),
        },
        updatedAt: now,
      };
      this.replaceModelState(next);
      await this.writeState();
    });
    return (await this.requiredModel(tenant, input.modelVersionId)) as LocalModelRegistryRecordV1;
  }

  async promoteModel(
    tenant: TenantRef,
    input: ModelPromotionInputV1,
  ): Promise<ModelPromotionDecisionV1> {
    const model = await this.requiredModel(tenant, input.modelVersionId);
    if (model.validation.state !== 'passed' || model.validation.evaluationId === undefined) {
      throw runtimeError('POLICY_DENIED', 'Model promotion requires passed validation evidence');
    }
    const evaluation = await this.requiredEvaluation(tenant, model.validation.evaluationId);
    if (evaluation.recommendation !== 'promote') {
      throw runtimeError('POLICY_DENIED', 'Model evaluation does not recommend promotion');
    }
    const expectedDigest = modelDigest(model, evaluation);
    if (!input.policyApproved) {
      throw runtimeError('POLICY_DENIED', 'Model promotion requires an approved policy decision');
    }
    if (input.approvalDigest !== expectedDigest || input.commitApprovalDigest !== expectedDigest) {
      throw runtimeError('APPROVAL_INVALIDATED', 'Model promotion approval digest is stale');
    }
    if (model.stage === 'production') {
      throw runtimeError('CONCURRENCY_STALE_VERSION', 'Model version is already in production');
    }
    const now = this.clock();
    const decision: ModelPromotionDecisionV1 = {
      schemaVersion: 1,
      decisionId: newSortableId(),
      tenant: clone(tenant),
      modelVersionId: model.modelVersionId,
      from: model.stage,
      to: 'production',
      evaluationId: evaluation.evaluationId,
      validationEvidenceArtifactIds: [...model.validation.evidenceArtifactIds],
      policyApproved: true,
      approvalDigest: expectedDigest,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      immutable: true,
      decidedAt: now,
    };
    await this.mutate(async () => {
      for (const existing of this.state?.models ?? []) {
        if (
          existing.modelName === model.modelName &&
          sameTenant(existing.tenant, tenant) &&
          existing.stage === 'production'
        ) {
          this.replaceModelState({
            ...existing,
            stage: 'archived',
            deploymentHistory: [
              ...existing.deploymentHistory,
              {
                deploymentId: newSortableId(),
                stage: 'production',
                status: 'archived',
                at: now,
              },
            ],
            updatedAt: now,
          });
        }
      }
      this.replaceModelState({
        ...model,
        stage: 'production',
        approval: {
          state: 'approved',
          decisionId: decision.decisionId,
          digest: expectedDigest,
          decidedAt: now,
        },
        deploymentHistory: [
          ...model.deploymentHistory,
          {
            deploymentId: decision.decisionId,
            stage: 'production',
            status: 'promoted',
            at: now,
          },
        ],
        updatedAt: now,
      });
      this.state?.decisions.push(decision);
      const experiment = this.requireExperimentState(tenant, model.sourceExperimentId);
      if (experiment.state === 'compared')
        this.replaceExperimentState(this.transitionRecord(experiment, 'promoted'));
      await this.writeState();
    });
    return clone(decision);
  }

  async listModels(
    tenant: TenantRef,
    modelName?: string,
  ): Promise<readonly LocalModelRegistryRecordV1[]> {
    await this.ensureLoaded();
    await this.mutationQueue;
    return clone(
      (this.state?.models ?? []).filter(
        (model) =>
          sameTenant(model.tenant, tenant) &&
          (modelName === undefined || model.modelName === modelName),
      ),
    );
  }

  async getModel(
    tenant: TenantRef,
    modelVersionId: Id,
  ): Promise<LocalModelRegistryRecordV1 | undefined> {
    await this.ensureLoaded();
    await this.mutationQueue;
    const model = this.state?.models.find((item) => item.modelVersionId === modelVersionId);
    if (model !== undefined && !sameTenant(model.tenant, tenant)) {
      throw runtimeError('POLICY_DENIED', 'Model version crosses the tenant boundary');
    }
    return model === undefined ? undefined : clone(model);
  }

  async listPromotionDecisions(tenant: TenantRef): Promise<readonly ModelPromotionDecisionV1[]> {
    await this.ensureLoaded();
    await this.mutationQueue;
    return clone((this.state?.decisions ?? []).filter((item) => sameTenant(item.tenant, tenant)));
  }

  async getArtifact(
    tenant: TenantRef,
    artifactId: Id,
  ): Promise<
    { readonly artifact: PublishedExperimentArtifactV1; readonly content: string } | undefined
  > {
    await this.ensureLoaded();
    await this.mutationQueue;
    const artifact = this.state?.artifacts.find((item) => item.artifactId === artifactId);
    if (artifact !== undefined && !sameTenant(artifact.tenant, tenant)) {
      throw runtimeError('POLICY_DENIED', 'Experiment artifact crosses the tenant boundary');
    }
    if (artifact === undefined) return undefined;
    try {
      const content = await readFile(artifact.localPath, 'utf8');
      if (hashContent(content) !== artifact.contentHash) {
        throw runtimeError('VALIDATION_INVALID_INPUT', 'Experiment artifact digest does not match');
      }
      return { artifact: clone(artifact), content };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private validateDefinition(input: LocalExperimentDefinitionInputV1): void {
    required(input.name, 'Experiment name');
    required(input.target, 'Experiment target');
    required(input.algorithm, 'Experiment algorithm');
    required(input.outputDestination, 'Experiment outputDestination');
    if (!['classification', 'regression', 'generation', 'custom'].includes(input.task)) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Experiment task is invalid');
    }
    if (!Number.isSafeInteger(input.seed) || input.seed < 0) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Experiment seed must be non-negative');
    }
    if (input.features.length === 0 || new Set(input.features).size !== input.features.length) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'Experiment features must be unique and non-empty',
      );
    }
    if (
      input.metrics.length === 0 ||
      new Set(input.metrics.map((metric) => metric.name)).size !== input.metrics.length
    ) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'Experiment metrics must be unique and non-empty',
      );
    }
    assertArtifact(input.tenant, input.datasetVersion, 'Dataset version');
    assertArtifact(input.tenant, input.environmentRevision, 'Environment revision');
    if (!Number.isSafeInteger(input.compute.cpuMillicores) || input.compute.cpuMillicores < 1) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'compute.cpuMillicores must be positive');
    }
    if (!Number.isSafeInteger(input.compute.memoryBytes) || input.compute.memoryBytes < 1) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'compute.memoryBytes must be positive');
    }
    if (!Number.isSafeInteger(input.compute.gpuCount) || input.compute.gpuCount < 0) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'compute.gpuCount must be non-negative');
    }
    if (!Number.isSafeInteger(input.compute.maxDurationMs) || input.compute.maxDurationMs < 1) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'compute.maxDurationMs must be positive');
    }
    required(input.compute.currency, 'compute.currency', 12);
  }

  private validateModelCard(modelCard: ModelCardV1): ModelCardV1 {
    return {
      summary: required(modelCard.summary, 'modelCard.summary', 2_000),
      intendedUse: required(modelCard.intendedUse, 'modelCard.intendedUse', 2_000),
      limitations: modelCard.limitations.map((item) =>
        required(item, 'modelCard.limitations', 1_000),
      ),
      risks: modelCard.risks.map((item) => required(item, 'modelCard.risks', 1_000)),
      ...(modelCard.owner === undefined
        ? {}
        : { owner: required(modelCard.owner, 'modelCard.owner', 256) }),
    };
  }

  private evaluationMetric(
    observations: readonly ExperimentEvaluationObservationV1[],
    name: string,
    run: LocalExperimentRunV1,
  ): number {
    if (name === 'accuracy') {
      return observations.length === 0
        ? 0
        : observations.filter((item) => item.expected === item.candidate).length /
            observations.length;
    }
    if (name === 'mae' || name === 'rmse') {
      const pairs = observations.map((item) => {
        if (typeof item.expected !== 'number' || typeof item.candidate !== 'number') {
          throw runtimeError('VALIDATION_INVALID_INPUT', `${name} requires numeric observations`);
        }
        const delta = item.candidate - item.expected;
        return name === 'rmse' ? delta * delta : Math.abs(delta);
      });
      if (pairs.length === 0) return 0;
      const mean = pairs.reduce((sum, item) => sum + item, 0) / pairs.length;
      return name === 'rmse' ? Math.sqrt(mean) : mean;
    }
    const observed = run.metrics.filter((metric) => metric.name === name).at(-1)?.value;
    return observed ?? 0;
  }

  private finalMetrics(run: LocalExperimentRunV1): Record<string, number> {
    return Object.fromEntries(
      run.metrics
        .map((metric) => [metric.name, metric.value])
        .filter(([, value]) => Number.isFinite(value)),
    );
  }

  private async execute(runId: Id): Promise<void> {
    const run = await this.runState(runId);
    if (run === undefined) return;
    const experiment = await this.experimentState(run.tenant, run.experimentId);
    if (experiment === undefined) return;
    const attemptId = run.attemptIds.at(-1);
    if (attemptId === undefined) return;
    const runDirectory = join(this.rootPath, '.agentic', 'experiments', runId);
    const inputPath = join(runDirectory, 'request.json');
    const outputPath = join(runDirectory, 'result.json');
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      inputPath,
      `${JSON.stringify(
        {
          runId,
          experimentId: experiment.experimentId,
          variantId: run.variantId,
          configuration: run.configuration,
          datasetVersion: experiment.datasetVersion,
          environmentRevision: experiment.environmentRevision,
          outputPath,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    if (this.cancelledRuns.has(runId)) return;
    await this.setRunStatus(runId, 'provisioning');
    await this.appendEvent(runId, attemptId, 'provisioning', {
      runtimeProfileId: experiment.compute.runtimeProfileId ?? 'local-host',
      cpuMillicores: experiment.compute.cpuMillicores,
      memoryBytes: experiment.compute.memoryBytes,
      gpuCount: experiment.compute.gpuCount,
    });
    if (this.cancelledRuns.has(runId)) return;
    await this.setRunStatus(runId, 'running');
    await this.appendEvent(runId, attemptId, 'started', {
      attemptNumber: run.attempts.at(-1)?.attemptNumber ?? 1,
    });
    if (this.cancelledRuns.has(runId)) return;
    const command = this.command;
    if (command === undefined) {
      await this.finishRun(runId, 'failed', 'Training command is unavailable');
      return;
    }
    const args = this.args.map((arg) =>
      arg
        .replaceAll('%INPUT%', inputPath)
        .replaceAll('%OUTPUT%', outputPath)
        .replaceAll('%RUN_ID%', runId)
        .replaceAll('%VARIANT%', run.variantId),
    );
    const child = spawn(command, args, {
      cwd: this.rootPath,
      env: {
        ...process.env,
        SPYDERBYTE_EXPERIMENT_ID: experiment.experimentId,
        SPYDERBYTE_EXPERIMENT_RUN_ID: runId,
        SPYDERBYTE_EXPERIMENT_VARIANT: run.variantId,
        SPYDERBYTE_EXPERIMENT_ATTEMPT: String(run.attempts.at(-1)?.attemptNumber ?? 1),
      },
      stdio: 'pipe',
    });
    this.processes.set(runId, child);
    let stdout = '';
    let stderr = '';
    const logWrites: Promise<void>[] = [];
    const appendChunk = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      if (stream === 'stdout') stdout = `${stdout}${text}`.slice(-MAX_OUTPUT_BYTES);
      else stderr = `${stderr}${text}`.slice(-MAX_OUTPUT_BYTES);
      for (const line of text.split(/\r?\n/).filter((value) => value.trim().length > 0)) {
        logWrites.push(this.appendLog(runId, attemptId, stream, line));
      }
    };
    child.stdout.on('data', (chunk: Buffer) => appendChunk('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => appendChunk('stderr', chunk));
    const timeout = setTimeout(() => {
      this.timedOutRuns.add(runId);
      child.kill('SIGTERM');
    }, experiment.compute.maxDurationMs);
    const result = await new Promise<{ readonly code: number | null; readonly error?: Error }>(
      (resolve) => {
        let settled = false;
        child.once('error', (error) => {
          if (!settled) {
            settled = true;
            resolve({ code: null, error });
          }
        });
        child.once('close', (code) => {
          if (!settled) {
            settled = true;
            resolve({ code });
          }
        });
      },
    );
    clearTimeout(timeout);
    this.processes.delete(runId);
    await Promise.all(logWrites);
    await this.mutationQueue;
    const current = await this.runState(runId);
    if (current === undefined || current.status === 'cancelled') return;
    if (this.timedOutRuns.has(runId)) {
      await this.finishRun(
        runId,
        'timed_out',
        `Experiment exceeded ${experiment.compute.maxDurationMs}ms`,
      );
      return;
    }
    if (result.code !== 0) {
      await this.finishRun(
        runId,
        'failed',
        result.error?.message ??
          (stderr.slice(-8_000) || `Training exited with code ${result.code ?? 'unknown'}`),
      );
      return;
    }
    let fileOutput = '';
    try {
      fileOutput = await readFile(outputPath, 'utf8');
    } catch {
      fileOutput = '';
    }
    const parsed = outputFromText(fileOutput.trim().length > 0 ? fileOutput : stdout);
    await this.recordStructuredOutput(runId, attemptId, parsed);
    await this.setRunStatus(runId, 'finalizing');
    const refreshed = await this.runState(runId);
    if (refreshed === undefined) return;
    await this.publishTerminalArtifacts(refreshed, experiment, parsed);
    const completed = await this.runState(runId);
    if (completed === undefined || completed.status === 'cancelled') return;
    const finalEvidence = (await this.runState(runId)) as LocalExperimentRunV1;
    await this.appendEvent(runId, attemptId, 'completed', {
      metrics: this.finalMetrics(finalEvidence),
      costMinor: finalEvidence.cost.actualMinor,
    });
    await this.setRunStatus(runId, 'succeeded', parsed.output);
    await this.maybeCompleteExperiment(experiment.experimentId, experiment.tenant);
  }

  private async recordStructuredOutput(
    runId: Id,
    attemptId: Id,
    output: ParsedTrainingOutput,
  ): Promise<void> {
    for (const event of output.events) {
      const type = event['type'];
      if (typeof type !== 'string') continue;
      const kind: ExperimentEventKindV1 =
        type === 'epoch' ||
        type === 'step' ||
        type === 'loss' ||
        type === 'metric' ||
        type === 'resource' ||
        type === 'checkpoint' ||
        type === 'cost'
          ? type
          : 'log';
      await this.appendEvent(runId, attemptId, kind, eventPayload(event));
      if (kind === 'metric' || kind === 'loss') {
        const name = typeof event['name'] === 'string' ? event['name'] : kind;
        const value = typeof event['value'] === 'number' ? event['value'] : undefined;
        if (value !== undefined && Number.isFinite(value)) {
          await this.appendMetric(runId, {
            metricId: newSortableId(),
            name,
            value,
            ...(typeof event['step'] === 'number' ? { step: event['step'] } : {}),
            ...(typeof event['epoch'] === 'number' ? { epoch: event['epoch'] } : {}),
            unit: 'value',
            observedAt: this.clock(),
          });
        }
      }
      if (kind === 'resource') {
        await this.appendResource(runId, {
          observedAt: this.clock(),
          ...(typeof event['cpuMillicores'] === 'number'
            ? { cpuMillicores: event['cpuMillicores'] }
            : {}),
          ...(typeof event['memoryBytes'] === 'number'
            ? { memoryBytes: event['memoryBytes'] }
            : {}),
          ...(typeof event['gpuMemoryBytes'] === 'number'
            ? { gpuMemoryBytes: event['gpuMemoryBytes'] }
            : {}),
          ...(typeof event['gpuUtilizationPercent'] === 'number'
            ? { gpuUtilizationPercent: event['gpuUtilizationPercent'] }
            : {}),
        });
      }
      if (kind === 'cost') {
        const actualMinor =
          typeof event['actualMinor'] === 'number'
            ? event['actualMinor']
            : typeof event['costMinor'] === 'number'
              ? event['costMinor']
              : typeof event['value'] === 'number'
                ? event['value']
                : undefined;
        if (actualMinor !== undefined && Number.isFinite(actualMinor) && actualMinor >= 0) {
          await this.updateRun(runId, (run) => ({
            ...run,
            cost: { ...run.cost, actualMinor },
          }));
        }
      }
    }
    for (const [name, value] of Object.entries(output.metrics)) {
      await this.appendMetric(runId, {
        metricId: newSortableId(),
        name,
        value,
        unit: 'value',
        observedAt: this.clock(),
      });
    }
    await this.updateRun(runId, (run) => {
      const outputExtras: Record<string, JsonValue> = {
        ...(output.featureImportance === undefined
          ? {}
          : { featureImportance: output.featureImportance }),
        ...(output.confusionMatrix === undefined
          ? {}
          : { confusionMatrix: [...output.confusionMatrix] }),
      };
      return {
        ...run,
        ...(output.output === undefined && Object.keys(outputExtras).length === 0
          ? {}
          : { output: { ...run.output, ...(output.output ?? {}), ...outputExtras } }),
        cost: {
          ...run.cost,
          actualMinor:
            typeof output.output?.['actualCostMinor'] === 'number'
              ? output.output['actualCostMinor']
              : run.cost.estimatedMinor,
        },
      };
    });
  }

  private async publishTerminalArtifacts(
    run: LocalExperimentRunV1,
    experiment: LocalExperimentRecordV1,
    output: ParsedTrainingOutput,
  ): Promise<void> {
    const lineage = [experiment.datasetVersion, experiment.environmentRevision];
    await this.publishArtifact(
      run,
      'environment-lockfile',
      experiment.environmentLockfile ??
        JSON.stringify({
          environmentRevision: experiment.environmentRevision,
          compute: experiment.compute,
        }),
      'application/json',
      [experiment.environmentRevision],
    );
    const current = (await this.runState(run.runId)) as LocalExperimentRunV1;
    await this.publishArtifact(
      current,
      'metrics',
      JSON.stringify({
        runId: run.runId,
        metrics: current.metrics,
        resources: current.resources,
        cost: current.cost,
      }),
      'application/json',
      lineage,
    );
    const afterMetrics = (await this.runState(run.runId)) as LocalExperimentRunV1;
    await this.publishArtifact(
      afterMetrics,
      'plot',
      JSON.stringify({
        curves: afterMetrics.metrics.map((metric) => ({
          name: metric.name,
          step: metric.step,
          epoch: metric.epoch,
          value: metric.value,
        })),
      }),
      'application/json',
      lineage,
    );
    if (output.checkpoint !== undefined) {
      const afterPlot = (await this.runState(run.runId)) as LocalExperimentRunV1;
      await this.publishArtifact(
        afterPlot,
        'checkpoint',
        JSON.stringify({
          runId: run.runId,
          variantId: run.variantId,
          checkpoint: output.checkpoint,
        }),
        'application/octet-stream',
        lineage,
        true,
      );
    } else {
      const afterPlot = (await this.runState(run.runId)) as LocalExperimentRunV1;
      await this.publishArtifact(
        afterPlot,
        'checkpoint',
        JSON.stringify({ runId: run.runId, variantId: run.variantId, output: output.output ?? {} }),
        'application/octet-stream',
        lineage,
        true,
      );
    }
    const finalRun = (await this.runState(run.runId)) as LocalExperimentRunV1;
    await this.publishArtifact(
      finalRun,
      'report',
      JSON.stringify({
        runId: run.runId,
        experimentId: experiment.experimentId,
        status: 'succeeded',
        metrics: finalRun.metrics,
        artifacts: finalRun.artifacts.map((artifact) => artifact.artifactId),
      }),
      'application/json',
      lineage,
    );
  }

  private async finishRun(
    runId: Id,
    status: Extract<ExperimentRunStatusV1, 'failed' | 'cancelled' | 'timed_out'>,
    error: string,
  ): Promise<void> {
    const run = await this.runState(runId);
    if (run === undefined || run.status === 'cancelled') return;
    const attemptId = run.attemptIds.at(-1);
    if (attemptId === undefined) return;
    await this.appendEvent(runId, attemptId, status === 'cancelled' ? 'cancelled' : 'failure', {
      error: error.slice(0, 8_000),
      status,
    });
    await this.updateRun(runId, (current) => ({
      ...current,
      status,
      completedAt: this.clock(),
      error: error.slice(0, 8_000),
    }));
    await this.updateAttempt(runId, attemptId, (attempt) => ({
      ...attempt,
      status,
      completedAt: this.clock(),
      error: error.slice(0, 8_000),
    }));
    const experiment = await this.experimentState(run.tenant, run.experimentId);
    if (experiment !== undefined)
      await this.maybeCompleteExperiment(experiment.experimentId, experiment.tenant);
  }

  private async maybeCompleteExperiment(experimentId: Id, tenant: TenantRef): Promise<void> {
    const experiment = await this.experimentState(tenant, experimentId);
    if (
      experiment === undefined ||
      experiment.state !== 'running' ||
      experiment.runIds.length === 0
    )
      return;
    const runs = (this.state?.runs ?? []).filter((run) => run.experimentId === experimentId);
    if (
      runs.length < experiment.runIds.length ||
      runs.some((run) => ['queued', 'provisioning', 'running', 'finalizing'].includes(run.status))
    )
      return;
    await this.mutate(async () => {
      const current = this.requireExperimentState(tenant, experimentId);
      if (current.state === 'running')
        this.replaceExperimentState(this.transitionRecord(current, 'completed'));
      await this.writeState();
    });
  }

  private async appendLog(runId: Id, attemptId: Id, stream: string, line: string): Promise<void> {
    const bounded = line.slice(0, this.maxLogBytes);
    await this.updateRun(runId, (run) => ({
      ...run,
      logs: [...run.logs, `[${stream}] ${bounded}`].slice(-MAX_LOG_LINES),
      events: run.events,
    }));
    await this.appendEvent(runId, attemptId, 'log', { stream, line: bounded });
  }

  private async appendMetric(runId: Id, metric: ExperimentMetricObservationV1): Promise<void> {
    await this.updateRun(runId, (run) => ({
      ...run,
      metrics: [...run.metrics, metric].slice(-MAX_EVENTS_PER_RUN),
    }));
  }

  private async appendResource(
    runId: Id,
    resource: ExperimentResourceObservationV1,
  ): Promise<void> {
    await this.updateRun(runId, (run) => ({
      ...run,
      resources: [...run.resources, resource].slice(-MAX_EVENTS_PER_RUN),
    }));
  }

  private async appendEvent(
    runId: Id,
    attemptId: Id,
    kind: ExperimentEventKindV1,
    payload: Record<string, JsonValue>,
  ): Promise<void> {
    await this.updateRun(runId, (run) => {
      const sequence = this.state?.nextEventSequence ?? 1;
      if (this.state !== undefined) this.state.nextEventSequence = sequence + 1;
      const event: ExperimentRunEventV1 = {
        sequence,
        eventId: newSortableId(),
        kind,
        runId,
        attemptId,
        occurredAt: this.clock(),
        payload: clone(payload),
      };
      return { ...run, events: [...run.events, event].slice(-MAX_EVENTS_PER_RUN) };
    });
  }

  private async setRunStatus(
    runId: Id,
    status: ExperimentRunStatusV1,
    output?: Readonly<Record<string, JsonValue>>,
  ): Promise<void> {
    await this.updateRun(runId, (run) => ({
      ...run,
      status,
      ...(status === 'running' && run.startedAt === undefined ? { startedAt: this.clock() } : {}),
      ...(['succeeded', 'failed', 'cancelled', 'timed_out', 'partially_succeeded'].includes(status)
        ? { completedAt: this.clock() }
        : {}),
      ...(output === undefined ? {} : { output }),
    }));
    const run = await this.runState(runId);
    const attemptId = run?.attemptIds.at(-1);
    if (attemptId !== undefined) {
      await this.updateAttempt(runId, attemptId, (attempt) => {
        if (
          ['succeeded', 'failed', 'cancelled', 'timed_out', 'partially_succeeded'].includes(status)
        ) {
          const eventEndSequence = run?.events.at(-1)?.sequence;
          return {
            ...attempt,
            status,
            completedAt: this.clock(),
            ...(eventEndSequence === undefined ? {} : { eventEndSequence }),
          };
        }
        return {
          ...attempt,
          status,
          ...(status === 'running' && attempt.startedAt === undefined
            ? { startedAt: this.clock() }
            : {}),
        };
      });
    }
  }

  private async updateAttempt(
    runId: Id,
    attemptId: Id,
    updater: (attempt: ExperimentAttemptV1) => ExperimentAttemptV1,
  ): Promise<void> {
    await this.updateRun(runId, (run) => ({
      ...run,
      attempts: run.attempts.map((attempt) =>
        attempt.attemptId === attemptId ? updater(attempt) : attempt,
      ),
    }));
  }

  private async publishArtifact(
    run: LocalExperimentRunV1,
    kind: PublishedExperimentArtifactKindV1,
    content: string,
    mediaType: string,
    lineage: readonly ArtifactReference[],
    checkpoint = false,
  ): Promise<PublishedExperimentArtifactV1> {
    const reference = artifactReference(run.tenant, content, mediaType, this.clock());
    const localPath = join(this.artifactRoot, `${reference.artifactId}.artifact`);
    await mkdir(dirname(localPath), { recursive: true, mode: 0o700 });
    await writeFile(localPath, content, { mode: 0o600 });
    const artifact: PublishedExperimentArtifactV1 = {
      ...reference,
      kind,
      experimentId: run.experimentId,
      runId: run.runId,
      immutable: true,
      lineage: clone(lineage),
      localPath,
    };
    await this.mutate(async () => {
      this.state?.artifacts.push(artifact);
      const current = this.requireRunState(run.runId);
      this.replaceRunState({
        ...current,
        artifacts: [...current.artifacts, artifact],
        ...(checkpoint ? { checkpoints: [...current.checkpoints, artifact] } : {}),
      });
      await this.writeState();
    });
    return clone(artifact);
  }

  private async updateRun(
    runId: Id,
    updater: (run: LocalExperimentRunV1) => LocalExperimentRunV1,
  ): Promise<void> {
    await this.mutate(async () => {
      const current = this.requireRunState(runId);
      this.replaceRunState(updater(clone(current)));
      await this.writeState();
    });
  }

  private async setExperimentState(
    record: LocalExperimentRecordV1,
    state: LocalExperimentStateV1,
  ): Promise<LocalExperimentRecordV1> {
    if (!transitionAllowed(record.state, state)) {
      throw runtimeError(
        'CONCURRENCY_STALE_VERSION',
        `Invalid experiment transition ${record.state} → ${state}`,
      );
    }
    if (record.state === state) return clone(record);
    return this.mutate(async () => {
      const current = this.requireExperimentState(record.tenant, record.experimentId);
      const next = this.transitionRecord(current, state);
      this.replaceExperimentState(next);
      await this.writeState();
      return clone(next);
    });
  }

  private transitionRecord(
    record: LocalExperimentRecordV1,
    state: LocalExperimentStateV1,
  ): LocalExperimentRecordV1 {
    return {
      ...record,
      state,
      updatedAt: this.clock(),
      history: [...record.history, { from: record.state, to: state, at: this.clock() }],
    };
  }

  private async maybeRecordRecovery(run: LocalExperimentRunV1): Promise<void> {
    if (!['queued', 'provisioning', 'running', 'finalizing'].includes(run.status)) return;
    const attempt = run.attempts.at(-1);
    if (attempt === undefined) return;
    const error = 'Experiment process was interrupted by a daemon restart';
    const recovered: LocalExperimentRunV1 = {
      ...run,
      status: 'failed',
      completedAt: this.clock(),
      error,
      attempts: run.attempts.map((item) =>
        item.attemptId === attempt.attemptId
          ? { ...item, status: 'failed', completedAt: this.clock(), error }
          : item,
      ),
      events: [
        ...run.events,
        {
          sequence: this.state?.nextEventSequence ?? 1,
          eventId: newSortableId(),
          kind: 'failure',
          runId: run.runId,
          attemptId: attempt.attemptId,
          occurredAt: this.clock(),
          payload: { error, recovered: true },
        },
      ],
    };
    if (this.state !== undefined) this.state.nextEventSequence += 1;
    this.replaceRunState(recovered);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.state !== undefined) return;
    this.loading ??= (async () => {
      const fallback: ExperimentStateFileV1 = {
        schemaVersion: 1,
        experiments: [],
        runs: [],
        comparisons: [],
        evaluations: [],
        models: [],
        decisions: [],
        artifacts: [],
        nextEventSequence: 1,
      };
      try {
        const parsed = JSON.parse(
          await readFile(this.statePath, 'utf8'),
        ) as Partial<ExperimentStateFileV1>;
        this.state = {
          ...fallback,
          ...parsed,
          experiments: Array.isArray(parsed.experiments) ? parsed.experiments : [],
          runs: Array.isArray(parsed.runs) ? parsed.runs : [],
          comparisons: Array.isArray(parsed.comparisons) ? parsed.comparisons : [],
          evaluations: Array.isArray(parsed.evaluations) ? parsed.evaluations : [],
          models: Array.isArray(parsed.models) ? parsed.models : [],
          decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
          artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
          nextEventSequence:
            Number.isSafeInteger(parsed.nextEventSequence) &&
            (parsed.nextEventSequence as number) > 0
              ? (parsed.nextEventSequence as number)
              : 1,
        };
      } catch {
        this.state = fallback;
      }
      let recovered = false;
      for (const run of this.state.runs) {
        if (['queued', 'provisioning', 'running', 'finalizing'].includes(run.status)) {
          await this.maybeRecordRecovery(run);
          recovered = true;
        }
      }
      if (recovered) await this.writeState();
    })();
    await this.loading;
  }

  private async mutate<T>(task: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(task);
    this.mutationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async writeState(): Promise<void> {
    if (this.state === undefined) return;
    const temporary = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.statePath);
  }

  private async runState(runId: Id): Promise<LocalExperimentRunV1 | undefined> {
    await this.ensureLoaded();
    await this.mutationQueue;
    const run = this.state?.runs.find((item) => item.runId === runId);
    return run === undefined ? undefined : clone(run);
  }

  private async experimentState(
    tenant: TenantRef,
    experimentId: Id,
  ): Promise<LocalExperimentRecordV1 | undefined> {
    const experiment = await this.get(tenant, experimentId);
    return experiment === undefined ? undefined : clone(experiment);
  }

  private async requiredExperiment(
    tenant: TenantRef,
    experimentId: Id,
  ): Promise<LocalExperimentRecordV1> {
    const record = await this.get(tenant, experimentId);
    if (record === undefined)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Experiment ${experimentId} was not found`);
    return record;
  }

  private async requiredRun(tenant: TenantRef, runId: Id): Promise<LocalExperimentRunV1> {
    const run = await this.getRun(tenant, runId);
    if (run === undefined)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Experiment run ${runId} was not found`);
    return run;
  }

  private async requiredEvaluation(
    tenant: TenantRef,
    evaluationId: Id,
  ): Promise<LocalExperimentEvaluationV1> {
    const evaluation = await this.getEvaluation(tenant, evaluationId);
    if (evaluation === undefined)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Evaluation ${evaluationId} was not found`);
    return evaluation;
  }

  private async requiredModel(
    tenant: TenantRef,
    modelVersionId: Id,
  ): Promise<LocalModelRegistryRecordV1> {
    const model = await this.getModel(tenant, modelVersionId);
    if (model === undefined)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Model version ${modelVersionId} was not found`);
    return model;
  }

  private requireRunState(runId: Id): LocalExperimentRunV1 {
    const run = this.state?.runs.find((item) => item.runId === runId);
    if (run === undefined)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Experiment run ${runId} was not found`);
    return run;
  }

  private requireExperimentState(tenant: TenantRef, experimentId: Id): LocalExperimentRecordV1 {
    const experiment = this.state?.experiments.find((item) => item.experimentId === experimentId);
    if (experiment === undefined)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Experiment ${experimentId} was not found`);
    if (!sameTenant(experiment.tenant, tenant))
      throw runtimeError('POLICY_DENIED', 'Experiment crosses the tenant boundary');
    return experiment;
  }

  private requireModelState(modelVersionId: Id): LocalModelRegistryRecordV1 {
    const model = this.state?.models.find((item) => item.modelVersionId === modelVersionId);
    if (model === undefined)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Model version ${modelVersionId} was not found`);
    return model;
  }

  private replaceRunState(run: LocalExperimentRunV1): void {
    if (this.state === undefined) return;
    const index = this.state.runs.findIndex((item) => item.runId === run.runId);
    if (index < 0)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Experiment run ${run.runId} was not found`);
    this.state.runs[index] = clone(run);
  }

  private replaceExperimentState(record: LocalExperimentRecordV1): void {
    if (this.state === undefined) return;
    const index = this.state.experiments.findIndex(
      (item) => item.experimentId === record.experimentId,
    );
    if (index < 0)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Experiment ${record.experimentId} was not found`);
    this.state.experiments[index] = clone(record);
  }

  private replaceModelState(model: LocalModelRegistryRecordV1): void {
    if (this.state === undefined) return;
    const index = this.state.models.findIndex(
      (item) => item.modelVersionId === model.modelVersionId,
    );
    if (index < 0)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Model ${model.modelVersionId} was not found`);
    this.state.models[index] = clone(model);
  }
}

export function experimentPromotionDigest(
  model: LocalModelRegistryRecordV1,
  evaluation: LocalExperimentEvaluationV1,
): string {
  return modelDigest(model, evaluation);
}
