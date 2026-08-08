import {
  newSortableId,
  runtimeError,
  type ArtifactReference,
  type Id,
  type JsonValue,
  type MetricObservation,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import {
  InMemoryExperimentBackend,
  type ExperimentBackend,
  type RegisteredCheckpoint,
  type RunHandle,
} from './lifecycle.js';

export type ExperimentStateV1 =
  | 'draft'
  | 'validating'
  | 'ready'
  | 'running'
  | 'completed'
  | 'compared'
  | 'promoted'
  | 'archived';

export type ExperimentTaskV1 = 'classification' | 'regression' | 'generation' | 'custom';

export interface ExperimentDefinitionV1 {
  readonly schemaVersion: 1;
  readonly experimentId: Id;
  readonly tenant: TenantRef;
  readonly name: string;
  readonly datasetVersion: ArtifactReference;
  readonly target: string;
  readonly features: readonly string[];
  readonly task: ExperimentTaskV1;
  readonly algorithm: string;
  readonly baseModel?: string;
  readonly environmentRevision: ArtifactReference;
  readonly computeProfile: string;
  readonly metricNames: readonly string[];
  readonly hyperparameters: Readonly<Record<string, JsonValue>>;
  readonly seed: number;
  readonly outputDestination: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ExperimentDefinitionInputV1 = Omit<
  ExperimentDefinitionV1,
  'experimentId' | 'createdAt' | 'updatedAt'
> & {
  readonly experimentId?: Id;
};

export interface ExperimentStateTransitionV1 {
  readonly from: ExperimentStateV1;
  readonly to: ExperimentStateV1;
  readonly at: string;
}

export interface ExperimentRecordV1 extends ExperimentDefinitionV1 {
  readonly state: ExperimentStateV1;
  readonly run?: RunHandle;
  readonly metrics: readonly MetricObservation[];
  readonly artifacts: readonly ArtifactReference[];
  readonly checkpoints: readonly RegisteredCheckpoint[];
  readonly history: readonly ExperimentStateTransitionV1[];
}

export interface ExperimentComparisonV1 {
  readonly schemaVersion: 1;
  readonly comparisonId: Id;
  readonly tenant: TenantRef;
  readonly experimentIds: readonly Id[];
  readonly metrics: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly immutable: true;
  readonly createdAt: string;
}

export interface StructuredExperimentBackend {
  create(input: ExperimentDefinitionInputV1): Promise<ExperimentRecordV1>;
  get(tenant: TenantRef, experimentId: Id): Promise<ExperimentRecordV1 | undefined>;
  list(tenant: TenantRef): Promise<readonly ExperimentRecordV1[]>;
  validate(tenant: TenantRef, experimentId: Id): Promise<ExperimentRecordV1>;
  start(tenant: TenantRef, experimentId: Id): Promise<ExperimentRecordV1>;
  complete(tenant: TenantRef, experimentId: Id): Promise<ExperimentRecordV1>;
  transition(
    tenant: TenantRef,
    experimentId: Id,
    state: ExperimentStateV1,
  ): Promise<ExperimentRecordV1>;
  logMetric(tenant: TenantRef, experimentId: Id, metric: MetricObservation): Promise<void>;
  logArtifact(tenant: TenantRef, experimentId: Id, artifact: ArtifactReference): Promise<void>;
  registerCheckpoint(
    tenant: TenantRef,
    experimentId: Id,
    checkpoint: ArtifactReference,
  ): Promise<RegisteredCheckpoint>;
  compare(tenant: TenantRef, experimentIds: readonly Id[]): Promise<ExperimentComparisonV1>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sameTenant(left: TenantRef, right: TenantRef): boolean {
  return left.tenantId === right.tenantId && left.workspaceId === right.workspaceId;
}

function assertTenant(tenant: TenantRef, artifact: ArtifactReference, label: string): void {
  if (!sameTenant(tenant, artifact.tenant)) {
    throw runtimeError('POLICY_DENIED', `${label} crosses the experiment tenant boundary`);
  }
}

function required(value: string, label: string, maxLength = 256): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} is required and bounded`);
  }
  return value.trim();
}

function assertUnique(values: readonly string[], label: string): void {
  if (
    values.length === 0 ||
    values.length > 256 ||
    values.some((value) => required(value, label) !== value)
  ) {
    throw runtimeError(
      'VALIDATION_INVALID_INPUT',
      `${label} must contain bounded non-empty values`,
    );
  }
  if (new Set(values).size !== values.length) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} must contain unique values`);
  }
}

function validateDefinition(input: ExperimentDefinitionInputV1): void {
  if (input.schemaVersion !== 1) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Experiment schemaVersion must be 1');
  }
  required(input.name, 'Experiment name');
  required(input.target, 'Experiment target');
  required(input.algorithm, 'Experiment algorithm');
  required(input.computeProfile, 'Experiment computeProfile');
  required(input.outputDestination, 'Experiment outputDestination');
  assertUnique(input.features, 'Experiment features');
  assertUnique(input.metricNames, 'Experiment metrics');
  if (!['classification', 'regression', 'generation', 'custom'].includes(input.task)) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Experiment task is invalid');
  }
  if (!Number.isSafeInteger(input.seed) || input.seed < 0) {
    throw runtimeError(
      'VALIDATION_INVALID_INPUT',
      'Experiment seed must be a non-negative integer',
    );
  }
  assertTenant(input.tenant, input.datasetVersion, 'Dataset version');
  assertTenant(input.tenant, input.environmentRevision, 'Environment revision');
}

const TRANSITIONS: Record<ExperimentStateV1, readonly ExperimentStateV1[]> = {
  draft: ['validating', 'ready', 'archived'],
  validating: ['ready', 'draft', 'archived'],
  ready: ['running', 'archived'],
  running: ['completed', 'archived'],
  completed: ['compared', 'archived'],
  compared: ['promoted', 'archived'],
  promoted: ['archived'],
  archived: [],
};

/**
 * Durable experiment state around the generic experiment run adapter. Configuration, immutable
 * dataset/environment references, metrics, checkpoints, and transitions remain queryable after
 * the adapter has finished.
 */
export class InMemoryStructuredExperimentBackend implements StructuredExperimentBackend {
  private readonly experiments = new Map<Id, ExperimentRecordV1>();
  private readonly clock: () => string;
  private readonly runs: ExperimentBackend;

  constructor(options: { readonly clock?: () => string; readonly runs?: ExperimentBackend } = {}) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.runs = options.runs ?? new InMemoryExperimentBackend({ clock: this.clock });
  }

  async create(input: ExperimentDefinitionInputV1): Promise<ExperimentRecordV1> {
    validateDefinition(input);
    const experimentId = input.experimentId ?? newSortableId();
    if (this.experiments.has(experimentId)) {
      throw runtimeError('CONCURRENCY_STALE_VERSION', `Experiment ${experimentId} already exists`);
    }
    const now = this.clock();
    const record: ExperimentRecordV1 = {
      ...clone(input),
      experimentId,
      state: 'draft',
      metrics: [],
      artifacts: [],
      checkpoints: [],
      history: [],
      createdAt: now,
      updatedAt: now,
    };
    this.experiments.set(experimentId, record);
    return clone(record);
  }

  async get(tenant: TenantRef, experimentId: Id): Promise<ExperimentRecordV1 | undefined> {
    const record = this.experiments.get(experimentId);
    if (record === undefined) return undefined;
    if (!sameTenant(tenant, record.tenant)) {
      throw runtimeError('POLICY_DENIED', 'Experiment crosses the tenant boundary');
    }
    return clone(record);
  }

  async list(tenant: TenantRef): Promise<readonly ExperimentRecordV1[]> {
    return clone(
      [...this.experiments.values()].filter((record) => sameTenant(tenant, record.tenant)),
    );
  }

  async validate(tenant: TenantRef, experimentId: Id): Promise<ExperimentRecordV1> {
    let record = await this.required(tenant, experimentId);
    if (record.state !== 'draft' && record.state !== 'validating') {
      throw runtimeError(
        'CONCURRENCY_STALE_VERSION',
        `Experiment ${experimentId} is not validating`,
      );
    }
    if (record.state === 'draft') record = await this.setState(record, 'validating');
    return this.setState(record, 'ready');
  }

  async start(tenant: TenantRef, experimentId: Id): Promise<ExperimentRecordV1> {
    const record = await this.required(tenant, experimentId);
    if (record.state !== 'ready') {
      throw runtimeError('CONCURRENCY_STALE_VERSION', `Experiment ${experimentId} is not ready`);
    }
    const run = await this.runs.createRun({
      tenant,
      workflowId: record.experimentId,
      name: record.name,
      sourceRevision: record.environmentRevision.contentHash,
      dataset: record.datasetVersion,
    });
    return this.replace(
      { ...record, state: 'running', run, updatedAt: this.clock() },
      record.state,
    );
  }

  async complete(tenant: TenantRef, experimentId: Id): Promise<ExperimentRecordV1> {
    const record = await this.required(tenant, experimentId);
    if (record.state !== 'running') {
      throw runtimeError('CONCURRENCY_STALE_VERSION', `Experiment ${experimentId} is not running`);
    }
    return this.setState(record, 'completed');
  }

  async transition(
    tenant: TenantRef,
    experimentId: Id,
    state: ExperimentStateV1,
  ): Promise<ExperimentRecordV1> {
    const record = await this.required(tenant, experimentId);
    return this.setState(record, state);
  }

  async logMetric(tenant: TenantRef, experimentId: Id, metric: MetricObservation): Promise<void> {
    const record = await this.required(tenant, experimentId);
    if (record.run === undefined || !['running', 'completed', 'compared'].includes(record.state)) {
      throw runtimeError(
        'CONCURRENCY_STALE_VERSION',
        'Experiment must have an active run before logging metrics',
      );
    }
    if (!Number.isFinite(metric.value) || !required(metric.name, 'Metric name')) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Metric value and name are required');
    }
    await this.runs.logMetric(record.run, metric);
    await this.replace({
      ...record,
      metrics: [...record.metrics, clone(metric)],
      updatedAt: this.clock(),
    });
  }

  async logArtifact(
    tenant: TenantRef,
    experimentId: Id,
    artifact: ArtifactReference,
  ): Promise<void> {
    const record = await this.required(tenant, experimentId);
    if (record.run === undefined) {
      throw runtimeError(
        'CONCURRENCY_STALE_VERSION',
        'Experiment must be started before logging artifacts',
      );
    }
    assertTenant(tenant, artifact, 'Experiment artifact');
    await this.runs.logArtifact(record.run, artifact);
    await this.replace({
      ...record,
      artifacts: [...record.artifacts, clone(artifact)],
      updatedAt: this.clock(),
    });
  }

  async registerCheckpoint(
    tenant: TenantRef,
    experimentId: Id,
    checkpoint: ArtifactReference,
  ): Promise<RegisteredCheckpoint> {
    const record = await this.required(tenant, experimentId);
    if (record.run === undefined) {
      throw runtimeError(
        'CONCURRENCY_STALE_VERSION',
        'Experiment must be started before registering checkpoints',
      );
    }
    assertTenant(tenant, checkpoint, 'Experiment checkpoint');
    const registered = await this.runs.registerCheckpoint(record.run, checkpoint);
    await this.replace({
      ...record,
      checkpoints: [...record.checkpoints, clone(registered)],
      updatedAt: this.clock(),
    });
    return clone(registered);
  }

  async compare(tenant: TenantRef, experimentIds: readonly Id[]): Promise<ExperimentComparisonV1> {
    if (experimentIds.length < 2 || new Set(experimentIds).size !== experimentIds.length) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'Comparison requires two or more unique experiments',
      );
    }
    const records = await Promise.all(
      experimentIds.map((experimentId) => this.required(tenant, experimentId)),
    );
    if (records.some((record) => !['completed', 'compared', 'promoted'].includes(record.state))) {
      throw runtimeError('CONCURRENCY_STALE_VERSION', 'Only completed experiments can be compared');
    }
    const metrics: Record<string, Record<string, number>> = {};
    for (const record of records) {
      for (const metric of record.metrics) {
        (metrics[metric.name] ??= {})[record.experimentId] = metric.value;
      }
    }
    const comparison: ExperimentComparisonV1 = {
      schemaVersion: 1,
      comparisonId: newSortableId(),
      tenant: clone(tenant),
      experimentIds: [...experimentIds],
      metrics,
      immutable: true,
      createdAt: this.clock(),
    };
    for (const record of records) {
      if (record.state === 'completed') await this.setState(record, 'compared');
    }
    return clone(comparison);
  }

  private async required(tenant: TenantRef, experimentId: Id): Promise<ExperimentRecordV1> {
    const record = await this.get(tenant, experimentId);
    if (record === undefined) {
      throw runtimeError('ARTIFACT_NOT_FOUND', `Experiment ${experimentId} was not found`);
    }
    return record;
  }

  private async setState(
    record: ExperimentRecordV1,
    state: ExperimentStateV1,
  ): Promise<ExperimentRecordV1> {
    if (record.state === state) return clone(record);
    if (!TRANSITIONS[record.state].includes(state)) {
      throw runtimeError(
        'CONCURRENCY_STALE_VERSION',
        `Invalid experiment transition ${record.state} → ${state}`,
      );
    }
    return this.replace(
      {
        ...record,
        state,
        updatedAt: this.clock(),
      },
      record.state,
    );
  }

  private async replace(
    record: ExperimentRecordV1,
    from: ExperimentStateV1 = record.state,
  ): Promise<ExperimentRecordV1> {
    const next: ExperimentRecordV1 = {
      ...clone(record),
      history:
        record.state === from
          ? record.history
          : [...record.history, { from, to: record.state, at: record.updatedAt }],
    };
    this.experiments.set(record.experimentId, next);
    return clone(next);
  }
}
