import { createHash } from 'node:crypto';
import {
  newSortableId,
  runtimeError,
  transitionDeployment,
  type ArtifactReference,
  type DeploymentState,
  type Id,
  type JsonValue,
  type MetricObservation,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import type { TrainingConfig } from './training.js';
import type { EvaluationResultV1 } from './evaluation.js';

export interface LifecycleAuditRecord {
  readonly auditId: Id;
  readonly tenant: TenantRef;
  readonly action: string;
  readonly target: string;
  readonly at: string;
  readonly outcome: 'completed' | 'denied' | 'failed';
  readonly details: JsonValue;
}

export class InMemoryLifecycleAuditLog {
  private readonly records: LifecycleAuditRecord[] = [];
  private readonly clock: () => string;

  constructor(clock: () => string = () => new Date().toISOString()) {
    this.clock = clock;
  }

  append(input: Omit<LifecycleAuditRecord, 'auditId' | 'at'>): LifecycleAuditRecord {
    const record: LifecycleAuditRecord = {
      auditId: newSortableId(),
      ...input,
      at: this.clock(),
    };
    this.records.push(record);
    return structuredClone(record);
  }

  list(): LifecycleAuditRecord[] {
    return structuredClone(this.records);
  }
}

export interface RunMetadata {
  readonly tenant: TenantRef;
  readonly workflowId: Id;
  readonly name: string;
  readonly sourceRevision: string;
  readonly dataset: ArtifactReference;
}

export interface RunHandle {
  readonly runId: Id;
  readonly tenant: TenantRef;
  readonly externalRunId: string;
}

export interface RegisteredCheckpoint {
  readonly checkpointId: Id;
  readonly run: RunHandle;
  readonly artifact: ArtifactReference;
}

export interface ExperimentBackend {
  createRun(metadata: RunMetadata): Promise<RunHandle>;
  logMetric(run: RunHandle, metric: MetricObservation): Promise<void>;
  logArtifact(run: RunHandle, artifact: ArtifactReference): Promise<void>;
  registerCheckpoint(run: RunHandle, checkpoint: ArtifactReference): Promise<RegisteredCheckpoint>;
}

interface StoredRun {
  readonly handle: RunHandle;
  readonly metadata: RunMetadata;
  readonly metrics: MetricObservation[];
  readonly artifacts: ArtifactReference[];
  readonly checkpoints: RegisteredCheckpoint[];
}

export class InMemoryExperimentBackend implements ExperimentBackend {
  private readonly runs = new Map<Id, StoredRun>();
  private readonly audit: InMemoryLifecycleAuditLog;

  constructor(options: { audit?: InMemoryLifecycleAuditLog; clock?: () => string } = {}) {
    this.audit = options.audit ?? new InMemoryLifecycleAuditLog(options.clock);
  }

  async createRun(metadata: RunMetadata): Promise<RunHandle> {
    const handle: RunHandle = {
      runId: newSortableId(),
      tenant: metadata.tenant,
      externalRunId: `local-run-${newSortableId()}`,
    };
    this.runs.set(handle.runId, { handle, metadata, metrics: [], artifacts: [], checkpoints: [] });
    this.audit.append({
      tenant: metadata.tenant,
      action: 'experiment.run.created',
      target: handle.runId,
      outcome: 'completed',
      details: { name: metadata.name, externalRunId: handle.externalRunId },
    });
    return structuredClone(handle);
  }

  async logMetric(run: RunHandle, metric: MetricObservation): Promise<void> {
    const stored = this.require(run);
    stored.metrics.push(structuredClone(metric));
    this.audit.append({
      tenant: run.tenant,
      action: 'experiment.metric.logged',
      target: run.runId,
      outcome: 'completed',
      details: { metricId: metric.metricId, name: metric.name },
    });
  }

  async logArtifact(run: RunHandle, artifact: ArtifactReference): Promise<void> {
    const stored = this.require(run);
    assertSameTenant(stored.handle.tenant, artifact.tenant);
    stored.artifacts.push(structuredClone(artifact));
    this.audit.append({
      tenant: run.tenant,
      action: 'experiment.artifact.logged',
      target: run.runId,
      outcome: 'completed',
      details: { artifactId: artifact.artifactId, version: artifact.version },
    });
  }

  async registerCheckpoint(
    run: RunHandle,
    checkpoint: ArtifactReference,
  ): Promise<RegisteredCheckpoint> {
    const stored = this.require(run);
    assertSameTenant(stored.handle.tenant, checkpoint.tenant);
    const registered = {
      checkpointId: newSortableId(),
      run: stored.handle,
      artifact: structuredClone(checkpoint),
    };
    stored.checkpoints.push(registered);
    this.audit.append({
      tenant: run.tenant,
      action: 'experiment.checkpoint.registered',
      target: registered.checkpointId,
      outcome: 'completed',
      details: { runId: run.runId, artifactId: checkpoint.artifactId, version: checkpoint.version },
    });
    return structuredClone(registered);
  }

  get(runId: Id): StoredRun | undefined {
    const run = this.runs.get(runId);
    return run === undefined ? undefined : structuredClone(run);
  }

  auditRecords(): LifecycleAuditRecord[] {
    return this.audit.list();
  }

  private require(run: RunHandle): StoredRun {
    const stored = this.runs.get(run.runId);
    if (stored === undefined || stored.handle.externalRunId !== run.externalRunId)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Experiment run ${run.runId} was not found`);
    assertSameTenant(stored.handle.tenant, run.tenant);
    return stored;
  }
}

export interface HostedExperimentClient {
  createRun(metadata: RunMetadata): Promise<RunHandle>;
  logMetric(request: {
    readonly run: RunHandle;
    readonly metric: MetricObservation;
  }): Promise<void>;
  logArtifact(request: {
    readonly run: RunHandle;
    readonly artifact: ArtifactReference;
  }): Promise<void>;
  registerCheckpoint(request: {
    readonly run: RunHandle;
    readonly checkpoint: ArtifactReference;
  }): Promise<RegisteredCheckpoint>;
}

export class HostedExperimentBackend implements ExperimentBackend {
  constructor(private readonly client: HostedExperimentClient) {}

  async createRun(metadata: RunMetadata): Promise<RunHandle> {
    const handle = await this.client.createRun(structuredClone(metadata));
    return assertHostedRunHandle(handle, metadata.tenant);
  }

  async logMetric(run: RunHandle, metric: MetricObservation): Promise<void> {
    assertRunHandle(run);
    await this.client.logMetric({ run: structuredClone(run), metric: structuredClone(metric) });
  }

  async logArtifact(run: RunHandle, artifact: ArtifactReference): Promise<void> {
    assertRunHandle(run);
    assertSameTenant(run.tenant, artifact.tenant);
    await this.client.logArtifact({
      run: structuredClone(run),
      artifact: structuredClone(artifact),
    });
  }

  async registerCheckpoint(
    run: RunHandle,
    checkpoint: ArtifactReference,
  ): Promise<RegisteredCheckpoint> {
    assertRunHandle(run);
    assertSameTenant(run.tenant, checkpoint.tenant);
    const registered = await this.client.registerCheckpoint({
      run: structuredClone(run),
      checkpoint: structuredClone(checkpoint),
    });
    if (
      registered.run.runId !== run.runId ||
      registered.run.externalRunId !== run.externalRunId ||
      !tenantMatches(registered.run.tenant, run.tenant) ||
      !tenantMatches(registered.artifact.tenant, run.tenant) ||
      registered.artifact.artifactId !== checkpoint.artifactId ||
      registered.artifact.version !== checkpoint.version
    ) {
      throw runtimeError(
        'VALIDATION_SCHEMA_MISMATCH',
        'Hosted experiment backend returned an invalid checkpoint',
      );
    }
    return structuredClone(registered);
  }
}

export interface ModelPublicationRequest {
  readonly tenant: TenantRef;
  readonly modelName: string;
  readonly candidateArtifact: ArtifactReference;
  readonly lineage: ModelLineage;
  readonly evaluation: {
    readonly recommendation: 'promote' | 'reject' | 'investigate';
    readonly evaluationArtifact: ArtifactReference;
  };
  readonly policyApproved: boolean;
  readonly approvalDigest: string;
  readonly commitApprovalDigest: string;
}

export interface ModelLineage {
  readonly checkpoint: ArtifactReference;
  readonly trainingRun: {
    readonly run: RunHandle;
    readonly configuration: TrainingConfig;
    readonly sourceRevision: string;
    readonly environmentSnapshot: ArtifactReference;
  };
  readonly validatedDataset: ArtifactReference;
  readonly originalDataLineage: readonly ArtifactReference[];
}

export interface ModelVersion {
  readonly modelVersionId: Id;
  readonly tenant: TenantRef;
  readonly modelName: string;
  readonly version: number;
  readonly candidateArtifact: ArtifactReference;
  readonly lineage: ModelLineage;
  readonly evaluationArtifact: ArtifactReference;
  readonly approvalDigest: string;
  readonly status?: ModelPromotionState;
}

export type ModelPromotionState = 'candidate' | 'promoted' | 'rejected' | 'investigate';

export class InMemoryModelRegistry {
  private readonly models = new Map<string, ModelVersion[]>();
  private readonly audit: InMemoryLifecycleAuditLog;

  constructor(options: { audit?: InMemoryLifecycleAuditLog; clock?: () => string } = {}) {
    this.audit = options.audit ?? new InMemoryLifecycleAuditLog(options.clock);
  }

  publish(request: ModelPublicationRequest): ModelVersion {
    if (!request.policyApproved || request.evaluation.recommendation !== 'promote') {
      this.audit.append({
        tenant: request.tenant,
        action: 'model.publish',
        target: request.modelName,
        outcome: 'denied',
        details: { reason: 'policy_or_evaluation' },
      });
      throw runtimeError(
        'POLICY_DENIED',
        'Model publication requires policy approval and a promote recommendation',
      );
    }
    if (request.approvalDigest !== request.commitApprovalDigest) {
      this.audit.append({
        tenant: request.tenant,
        action: 'model.publish',
        target: request.modelName,
        outcome: 'denied',
        details: { reason: 'approval_invalidated' },
      });
      throw runtimeError(
        'APPROVAL_INVALIDATED',
        'Model publication approval digest changed before commit',
      );
    }
    if (!isCompleteModelLineage(request.lineage, request.candidateArtifact)) {
      this.audit.append({
        tenant: request.tenant,
        action: 'model.publish',
        target: request.modelName,
        outcome: 'denied',
        details: { reason: 'incomplete_lineage' },
      });
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Model lineage is incomplete');
    }
    assertSameTenant(request.tenant, request.candidateArtifact.tenant);
    assertSameTenant(request.tenant, request.evaluation.evaluationArtifact.tenant);
    assertModelLineageTenants(request.tenant, request.lineage);
    const key = `${request.tenant.tenantId}:${request.tenant.workspaceId}:${request.modelName}`;
    const versions = this.models.get(key) ?? [];
    const model: ModelVersion = {
      modelVersionId: newSortableId(),
      tenant: request.tenant,
      modelName: request.modelName,
      version: versions.length + 1,
      candidateArtifact: structuredClone(request.candidateArtifact),
      lineage: structuredClone(request.lineage),
      evaluationArtifact: structuredClone(request.evaluation.evaluationArtifact),
      approvalDigest: request.commitApprovalDigest,
      status: 'promoted',
    };
    versions.push(model);
    this.models.set(key, versions);
    this.audit.append({
      tenant: request.tenant,
      action: 'model.published',
      target: model.modelVersionId,
      outcome: 'completed',
      details: { modelName: model.modelName, version: model.version },
    });
    return structuredClone(model);
  }

  list(tenant: TenantRef, modelName: string): ModelVersion[] {
    return structuredClone(
      this.models.get(`${tenant.tenantId}:${tenant.workspaceId}:${modelName}`) ?? [],
    );
  }

  registerCandidate(
    request: Pick<
      ModelPublicationRequest,
      'tenant' | 'modelName' | 'candidateArtifact' | 'lineage' | 'evaluation'
    >,
  ): ModelVersion {
    if (!isCompleteModelLineage(request.lineage, request.candidateArtifact)) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Model lineage is incomplete');
    }
    assertSameTenant(request.tenant, request.candidateArtifact.tenant);
    assertSameTenant(request.tenant, request.evaluation.evaluationArtifact.tenant);
    assertModelLineageTenants(request.tenant, request.lineage);
    const key = `${request.tenant.tenantId}:${request.tenant.workspaceId}:${request.modelName}`;
    const versions = this.models.get(key) ?? [];
    const candidate: ModelVersion = {
      modelVersionId: newSortableId(),
      tenant: structuredClone(request.tenant),
      modelName: request.modelName,
      version: versions.length + 1,
      candidateArtifact: structuredClone(request.candidateArtifact),
      lineage: structuredClone(request.lineage),
      evaluationArtifact: structuredClone(request.evaluation.evaluationArtifact),
      approvalDigest: '',
      status: 'candidate',
    };
    versions.push(candidate);
    this.models.set(key, versions);
    this.audit.append({
      tenant: request.tenant,
      action: 'model.candidate.registered',
      target: candidate.modelVersionId,
      outcome: 'completed',
      details: { modelName: candidate.modelName, version: candidate.version },
    });
    return structuredClone(candidate);
  }

  get(tenant: TenantRef, modelVersionId: Id): ModelVersion | undefined {
    for (const versions of this.models.values()) {
      const model = versions.find((candidate) => candidate.modelVersionId === modelVersionId);
      if (model !== undefined) {
        assertSameTenant(tenant, model.tenant);
        return structuredClone(model);
      }
    }
    return undefined;
  }

  setStatus(tenant: TenantRef, modelVersionId: Id, status: ModelPromotionState): ModelVersion {
    for (const [key, versions] of this.models.entries()) {
      const index = versions.findIndex((candidate) => candidate.modelVersionId === modelVersionId);
      if (index < 0) continue;
      const current = versions[index];
      if (current === undefined) break;
      assertSameTenant(tenant, current.tenant);
      const next: ModelVersion = { ...current, status };
      versions[index] = next;
      this.models.set(key, versions);
      return structuredClone(next);
    }
    throw runtimeError('ARTIFACT_NOT_FOUND', `Model version ${modelVersionId} was not found`);
  }

  auditRecords(): LifecycleAuditRecord[] {
    return this.audit.list();
  }
}

export interface ModelPromotionRequestV1 {
  readonly tenant: TenantRef;
  readonly modelVersionId: Id;
  readonly evaluation: EvaluationResultV1;
  readonly policyApproved: boolean;
  readonly approvalDigest: string;
  readonly commitApprovalDigest: string;
  readonly reason?: string;
}

export interface ModelPromotionDecisionV1 {
  readonly schemaVersion: 1;
  readonly decisionId: Id;
  readonly tenant: TenantRef;
  readonly modelVersionId: Id;
  readonly from: ModelPromotionState;
  readonly to: Exclude<ModelPromotionState, 'candidate'>;
  readonly evaluationId: Id;
  readonly evaluationArtifact: ArtifactReference;
  readonly approvalDigest: string;
  readonly reason?: string;
  readonly immutable: true;
  readonly decidedAt: string;
}

export function modelPromotionDigest(request: {
  readonly tenant: TenantRef;
  readonly modelVersionId: Id;
  readonly evaluation: EvaluationResultV1;
  readonly policyApproved: boolean;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        request.tenant.tenantId,
        request.tenant.workspaceId,
        request.modelVersionId,
        request.evaluation.evaluationId,
        request.evaluation.inputDigest,
        request.evaluation.evaluationArtifact.artifactId,
        request.evaluation.evaluationArtifact.version,
        request.evaluation.evaluationArtifact.contentHash,
        request.evaluation.recommendation,
        request.policyApproved,
      ]),
    )
    .digest('hex');
}

/**
 * Applies immutable evaluation decisions to registered model candidates. Promotion is a separate
 * commit step, so a completed training run or a UI recommendation cannot publish by itself.
 */
export class InMemoryModelPromotionWorkflow {
  private readonly decisions: ModelPromotionDecisionV1[] = [];
  private readonly clock: () => string;

  constructor(
    private readonly registry: InMemoryModelRegistry,
    options: { readonly clock?: () => string; readonly audit?: InMemoryLifecycleAuditLog } = {},
  ) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.audit = options.audit ?? new InMemoryLifecycleAuditLog(this.clock);
  }

  private readonly audit: InMemoryLifecycleAuditLog;

  decide(request: ModelPromotionRequestV1): ModelPromotionDecisionV1 {
    if (!request.policyApproved) {
      this.audit.append({
        tenant: request.tenant,
        action: 'model.promotion',
        target: request.modelVersionId,
        outcome: 'denied',
        details: { reason: 'policy_not_approved' },
      });
      throw runtimeError('POLICY_DENIED', 'Model promotion requires policy approval');
    }
    assertSameTenant(request.tenant, request.evaluation.tenant);
    const model = this.registry.get(request.tenant, request.modelVersionId);
    if (model === undefined) {
      throw runtimeError(
        'ARTIFACT_NOT_FOUND',
        `Model version ${request.modelVersionId} was not found`,
      );
    }
    if (!sameArtifact(model.candidateArtifact, request.evaluation.candidateArtifact)) {
      throw runtimeError('APPROVAL_INVALIDATED', 'Evaluation is not bound to the model candidate');
    }
    if (!sameArtifact(model.evaluationArtifact, request.evaluation.evaluationArtifact)) {
      throw runtimeError(
        'APPROVAL_INVALIDATED',
        'Promotion is not bound to the registered evaluation',
      );
    }
    const expectedDigest = modelPromotionDigest(request);
    if (
      request.approvalDigest !== expectedDigest ||
      request.commitApprovalDigest !== expectedDigest
    ) {
      this.audit.append({
        tenant: request.tenant,
        action: 'model.promotion',
        target: request.modelVersionId,
        outcome: 'denied',
        details: { reason: 'approval_invalidated' },
      });
      throw runtimeError(
        'APPROVAL_INVALIDATED',
        'Model promotion approval no longer matches evaluation inputs',
      );
    }
    if (model.status !== undefined && model.status !== 'candidate') {
      throw runtimeError(
        'CONCURRENCY_STALE_VERSION',
        'Model version has already received a promotion decision',
      );
    }
    const to: Exclude<ModelPromotionState, 'candidate'> =
      request.evaluation.recommendation === 'promote'
        ? 'promoted'
        : request.evaluation.recommendation === 'reject'
          ? 'rejected'
          : 'investigate';
    this.registry.setStatus(request.tenant, request.modelVersionId, to);
    const decision: ModelPromotionDecisionV1 = {
      schemaVersion: 1,
      decisionId: newSortableId(),
      tenant: structuredClone(request.tenant),
      modelVersionId: request.modelVersionId,
      from: 'candidate',
      to,
      evaluationId: request.evaluation.evaluationId,
      evaluationArtifact: structuredClone(request.evaluation.evaluationArtifact),
      approvalDigest: expectedDigest,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      immutable: true,
      decidedAt: this.clock(),
    };
    this.decisions.push(decision);
    this.audit.append({
      tenant: request.tenant,
      action: 'model.promotion.decided',
      target: request.modelVersionId,
      outcome: 'completed',
      details: { decisionId: decision.decisionId, state: decision.to },
    });
    return structuredClone(decision);
  }

  list(tenant?: TenantRef): readonly ModelPromotionDecisionV1[] {
    return structuredClone(
      this.decisions.filter(
        (decision) => tenant === undefined || tenantMatches(decision.tenant, tenant),
      ),
    );
  }

  auditRecords(): LifecycleAuditRecord[] {
    return this.audit.list();
  }
}

export interface HostedModelRegistryClient {
  publish(request: ModelPublicationRequest): Promise<ModelVersion>;
  list(request: {
    readonly tenant: TenantRef;
    readonly modelName: string;
  }): Promise<readonly ModelVersion[]>;
}

export class HostedModelRegistry {
  constructor(private readonly client: HostedModelRegistryClient) {}

  async publish(request: ModelPublicationRequest): Promise<ModelVersion> {
    assertModelPublicationPolicy(request);
    assertModelPublicationTenants(request);
    const model = await this.client.publish(structuredClone(request));
    return assertHostedModel(model, request.tenant, request.modelName);
  }

  async list(tenant: TenantRef, modelName: string): Promise<ModelVersion[]> {
    const models = await this.client.list({ tenant, modelName });
    return models.map((model) => assertHostedModel(model, tenant, modelName));
  }
}

export interface DeploymentRecord {
  readonly deploymentId: Id;
  readonly tenant: TenantRef;
  readonly model: ModelVersion;
  readonly state: DeploymentState;
  readonly trafficPercent: number;
  readonly health: 'unknown' | 'healthy' | 'unhealthy';
}

export interface TrafficGrant {
  readonly approved: boolean;
  readonly actionDigest: string;
  readonly commitDigest: string;
  readonly expiresAt: string;
  readonly now: string;
}

export type DeploymentAction =
  | 'provision'
  | 'smokePass'
  | 'startCanary'
  | 'ramp'
  | 'activate'
  | 'rollback'
  | 'fail';

export class InMemoryDeploymentController {
  private readonly deployments = new Map<Id, DeploymentRecord>();
  private readonly audit: InMemoryLifecycleAuditLog;

  constructor(options: { audit?: InMemoryLifecycleAuditLog; clock?: () => string } = {}) {
    this.audit = options.audit ?? new InMemoryLifecycleAuditLog(options.clock);
  }

  request(tenant: TenantRef, model: ModelVersion): DeploymentRecord {
    assertSameTenant(tenant, model.tenant);
    const record: DeploymentRecord = {
      deploymentId: newSortableId(),
      tenant,
      model,
      state: 'requested',
      trafficPercent: 0,
      health: 'unknown',
    };
    this.deployments.set(record.deploymentId, record);
    this.audit.append({
      tenant,
      action: 'deployment.requested',
      target: record.deploymentId,
      outcome: 'completed',
      details: { modelVersionId: model.modelVersionId, modelName: model.modelName },
    });
    return structuredClone(record);
  }

  advance(
    tenant: TenantRef,
    deploymentId: Id,
    action: DeploymentAction,
    grant?: TrafficGrant,
  ): DeploymentRecord {
    const current = this.require(tenant, deploymentId);
    if (
      action === 'startCanary' ||
      action === 'ramp' ||
      action === 'activate' ||
      action === 'rollback'
    ) {
      try {
        this.assertTrafficGrant(grant);
      } catch (error) {
        this.audit.append({
          tenant: current.tenant,
          action: `deployment.${action}`,
          target: deploymentId,
          outcome: 'denied',
          details: { reason: error instanceof Error ? error.message : 'invalid_grant' },
        });
        throw error;
      }
    }
    const nextState = transitionDeployment(current.state, action).state;
    const trafficPercent =
      nextState === 'canary'
        ? 10
        : nextState === 'ramping'
          ? 50
          : nextState === 'active'
            ? 100
            : nextState === 'rolled_back'
              ? 0
              : current.trafficPercent;
    const next: DeploymentRecord = {
      ...current,
      state: nextState,
      trafficPercent,
      health: nextState === 'rolled_back' ? 'unhealthy' : current.health,
    };
    this.deployments.set(deploymentId, next);
    this.audit.append({
      tenant: current.tenant,
      action: `deployment.${action}`,
      target: deploymentId,
      outcome: 'completed',
      details: { from: current.state, to: next.state, trafficPercent: next.trafficPercent },
    });
    return structuredClone(next);
  }

  observeHealth(tenant: TenantRef, deploymentId: Id, healthy: boolean): DeploymentRecord {
    const current = this.require(tenant, deploymentId);
    const next: DeploymentRecord = { ...current, health: healthy ? 'healthy' : 'unhealthy' };
    this.deployments.set(deploymentId, next);
    this.audit.append({
      tenant: current.tenant,
      action: 'deployment.health.observed',
      target: deploymentId,
      outcome: 'completed',
      details: { health: next.health },
    });
    return structuredClone(next);
  }

  automaticRollbackIfUnhealthy(
    tenant: TenantRef,
    deploymentId: Id,
    grant: TrafficGrant,
  ): DeploymentRecord {
    const current = this.require(tenant, deploymentId);
    if (
      current.health !== 'unhealthy' ||
      (current.state !== 'canary' && current.state !== 'ramping' && current.state !== 'active')
    ) {
      this.audit.append({
        tenant: current.tenant,
        action: 'deployment.rollback.skipped',
        target: deploymentId,
        outcome: 'completed',
        details: { state: current.state, health: current.health },
      });
      return structuredClone(current);
    }
    return this.advance(tenant, deploymentId, 'rollback', grant);
  }

  get(tenant: TenantRef, deploymentId: Id): DeploymentRecord | undefined {
    const record = this.deployments.get(deploymentId);
    if (record === undefined) return undefined;
    assertSameTenant(tenant, record.tenant);
    return structuredClone(record);
  }

  auditRecords(): LifecycleAuditRecord[] {
    return this.audit.list();
  }

  private require(tenant: TenantRef, deploymentId: Id): DeploymentRecord {
    const record = this.deployments.get(deploymentId);
    if (record === undefined)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Deployment ${deploymentId} was not found`);
    assertSameTenant(tenant, record.tenant);
    return record;
  }

  private assertTrafficGrant(grant: TrafficGrant | undefined): void {
    assertTrafficGrant(grant);
  }
}

export interface HostedDeploymentClient {
  request(request: {
    readonly tenant: TenantRef;
    readonly model: ModelVersion;
  }): Promise<DeploymentRecord>;
  advance(request: {
    readonly tenant: TenantRef;
    readonly deploymentId: Id;
    readonly action: DeploymentAction;
    readonly grant?: TrafficGrant;
  }): Promise<DeploymentRecord>;
  observeHealth(request: {
    readonly tenant: TenantRef;
    readonly deploymentId: Id;
    readonly healthy: boolean;
  }): Promise<DeploymentRecord>;
  automaticRollbackIfUnhealthy(request: {
    readonly tenant: TenantRef;
    readonly deploymentId: Id;
    readonly grant: TrafficGrant;
  }): Promise<DeploymentRecord>;
  get(request: {
    readonly tenant: TenantRef;
    readonly deploymentId: Id;
  }): Promise<DeploymentRecord | undefined>;
}

export class HostedDeploymentController {
  constructor(private readonly client: HostedDeploymentClient) {}

  async request(tenant: TenantRef, model: ModelVersion): Promise<DeploymentRecord> {
    assertSameTenant(tenant, model.tenant);
    return assertHostedDeployment(
      await this.client.request({ tenant, model: structuredClone(model) }),
      tenant,
    );
  }

  async advance(
    tenant: TenantRef,
    deploymentId: Id,
    action: DeploymentAction,
    grant?: TrafficGrant,
  ): Promise<DeploymentRecord> {
    if (requiresTrafficGrant(action)) assertTrafficGrant(grant);
    return assertHostedDeployment(
      await this.client.advance({
        tenant,
        deploymentId,
        action,
        ...(grant !== undefined ? { grant: structuredClone(grant) } : {}),
      }),
      tenant,
    );
  }

  async observeHealth(
    tenant: TenantRef,
    deploymentId: Id,
    healthy: boolean,
  ): Promise<DeploymentRecord> {
    return assertHostedDeployment(
      await this.client.observeHealth({ tenant, deploymentId, healthy }),
      tenant,
    );
  }

  async automaticRollbackIfUnhealthy(
    tenant: TenantRef,
    deploymentId: Id,
    grant: TrafficGrant,
  ): Promise<DeploymentRecord> {
    assertTrafficGrant(grant);
    return assertHostedDeployment(
      await this.client.automaticRollbackIfUnhealthy({
        tenant,
        deploymentId,
        grant: structuredClone(grant),
      }),
      tenant,
    );
  }

  async get(tenant: TenantRef, deploymentId: Id): Promise<DeploymentRecord | undefined> {
    const record = await this.client.get({ tenant, deploymentId });
    return record === undefined ? undefined : assertHostedDeployment(record, tenant);
  }
}

function tenantMatches(left: TenantRef | undefined, right: TenantRef): boolean {
  return left?.tenantId === right.tenantId && left?.workspaceId === right.workspaceId;
}

function assertSameTenant(left: TenantRef, right: TenantRef): void {
  if (!tenantMatches(left, right))
    throw runtimeError('POLICY_DENIED', 'Backend reference crosses tenant scope');
}

function assertRunHandle(run: RunHandle): void {
  if (typeof run.externalRunId !== 'string' || run.externalRunId.trim().length === 0) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Experiment external run ID is required');
  }
}

function assertHostedRunHandle(handle: RunHandle, tenant: TenantRef): RunHandle {
  if (
    !tenantMatches(handle.tenant, tenant) ||
    typeof handle.externalRunId !== 'string' ||
    handle.externalRunId.trim().length === 0
  ) {
    throw runtimeError(
      'VALIDATION_SCHEMA_MISMATCH',
      'Hosted experiment backend returned an invalid run',
    );
  }
  return structuredClone(handle);
}

function assertModelPublicationTenants(request: ModelPublicationRequest): void {
  if (!isCompleteModelLineage(request.lineage, request.candidateArtifact)) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Model lineage is incomplete');
  }
  assertSameTenant(request.tenant, request.candidateArtifact.tenant);
  assertSameTenant(request.tenant, request.evaluation.evaluationArtifact.tenant);
  assertModelLineageTenants(request.tenant, request.lineage);
}

function assertModelPublicationPolicy(request: ModelPublicationRequest): void {
  if (!request.policyApproved || request.evaluation.recommendation !== 'promote') {
    throw runtimeError(
      'POLICY_DENIED',
      'Model publication requires policy approval and a promote recommendation',
    );
  }
  if (request.approvalDigest !== request.commitApprovalDigest) {
    throw runtimeError(
      'APPROVAL_INVALIDATED',
      'Model publication approval digest changed before commit',
    );
  }
}

function requiresTrafficGrant(action: DeploymentAction): boolean {
  return (
    action === 'startCanary' || action === 'ramp' || action === 'activate' || action === 'rollback'
  );
}

function assertTrafficGrant(grant: TrafficGrant | undefined): void {
  const expiresAt = grant === undefined ? Number.NaN : Date.parse(grant.expiresAt);
  const now = grant === undefined ? Number.NaN : Date.parse(grant.now);
  if (
    grant === undefined ||
    !grant.approved ||
    grant.actionDigest !== grant.commitDigest ||
    !Number.isFinite(expiresAt) ||
    !Number.isFinite(now) ||
    expiresAt <= now
  ) {
    throw runtimeError('APPROVAL_INVALIDATED', 'Traffic change lacks a fresh bound approval');
  }
}

function isCompleteModelLineage(
  lineage: ModelLineage | undefined,
  candidateArtifact: ArtifactReference | undefined,
): lineage is ModelLineage {
  if (
    !isArtifactReference(lineage?.checkpoint) ||
    !isArtifactReference(candidateArtifact) ||
    !isRecord(lineage.trainingRun) ||
    !isRunHandle(lineage.trainingRun.run) ||
    !isTrainingConfig(lineage.trainingRun.configuration) ||
    typeof lineage.trainingRun.sourceRevision !== 'string' ||
    !isArtifactReference(lineage.trainingRun.environmentSnapshot) ||
    !isArtifactReference(lineage.validatedDataset) ||
    !Array.isArray(lineage.originalDataLineage) ||
    lineage.originalDataLineage.some((artifact) => !isArtifactReference(artifact))
  ) {
    return false;
  }
  return (
    sameArtifact(lineage.checkpoint, candidateArtifact) &&
    lineage.trainingRun.run.externalRunId.trim().length > 0 &&
    lineage.trainingRun.configuration.configId.trim().length > 0 &&
    lineage.trainingRun.configuration.strategy.strategyId.trim().length > 0 &&
    lineage.trainingRun.sourceRevision.trim().length > 0 &&
    Number.isSafeInteger(lineage.trainingRun.configuration.durationSeconds) &&
    lineage.trainingRun.configuration.durationSeconds > 0 &&
    lineage.originalDataLineage.length > 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTenantRef(value: unknown): value is TenantRef {
  return (
    isRecord(value) &&
    typeof value['tenantId'] === 'string' &&
    typeof value['workspaceId'] === 'string'
  );
}

function isArtifactReference(value: unknown): value is ArtifactReference {
  return (
    isRecord(value) &&
    typeof value['artifactId'] === 'string' &&
    Number.isSafeInteger(value['version']) &&
    typeof value['contentHash'] === 'string' &&
    isTenantRef(value['tenant'])
  );
}

function isRunHandle(value: unknown): value is RunHandle {
  return (
    isRecord(value) &&
    typeof value['runId'] === 'string' &&
    typeof value['externalRunId'] === 'string' &&
    isTenantRef(value['tenant'])
  );
}

function isTrainingConfig(value: unknown): value is TrainingConfig {
  if (!isRecord(value) || typeof value['configId'] !== 'string') return false;
  const strategy = value['strategy'];
  return (
    isRecord(strategy) &&
    typeof strategy['strategyId'] === 'string' &&
    typeof strategy['baseModel'] === 'string' &&
    typeof strategy['method'] === 'string' &&
    typeof strategy['objective'] === 'string' &&
    Number.isSafeInteger(strategy['checkpointEverySteps']) &&
    typeof strategy['earlyStopMetric'] === 'string' &&
    Number.isSafeInteger(value['durationSeconds'])
  );
}

function assertModelLineageTenants(tenant: TenantRef, lineage: ModelLineage): void {
  assertSameTenant(tenant, lineage.checkpoint.tenant);
  assertSameTenant(tenant, lineage.trainingRun.run.tenant);
  assertSameTenant(tenant, lineage.trainingRun.environmentSnapshot.tenant);
  assertSameTenant(tenant, lineage.validatedDataset.tenant);
  for (const artifact of lineage.originalDataLineage) assertSameTenant(tenant, artifact.tenant);
}

function sameArtifact(left: ArtifactReference, right: ArtifactReference): boolean {
  return (
    left.artifactId === right.artifactId &&
    left.version === right.version &&
    left.contentHash === right.contentHash
  );
}

function assertHostedModel(
  model: ModelVersion,
  tenant: TenantRef,
  modelName: string,
): ModelVersion {
  if (
    !tenantMatches(model.tenant, tenant) ||
    model.modelName !== modelName ||
    !tenantMatches(model.candidateArtifact?.tenant, tenant) ||
    !tenantMatches(model.evaluationArtifact?.tenant, tenant) ||
    !isCompleteModelLineage(model.lineage, model.candidateArtifact) ||
    !tenantMatches(model.lineage.trainingRun.run.tenant, tenant) ||
    !tenantMatches(model.lineage.trainingRun.environmentSnapshot.tenant, tenant) ||
    !tenantMatches(model.lineage.validatedDataset.tenant, tenant) ||
    model.lineage.originalDataLineage.some((artifact) => !tenantMatches(artifact.tenant, tenant))
  ) {
    throw runtimeError(
      'VALIDATION_SCHEMA_MISMATCH',
      'Hosted model registry returned an invalid model',
    );
  }
  return structuredClone(model);
}

function assertHostedDeployment(record: DeploymentRecord, tenant: TenantRef): DeploymentRecord {
  const states: readonly DeploymentState[] = [
    'requested',
    'provisioning',
    'smoke_testing',
    'canary',
    'ramping',
    'active',
    'rolled_back',
    'failed',
  ];
  const health = record.health;
  if (
    !tenantMatches(record.tenant, tenant) ||
    !tenantMatches(record.model?.tenant, tenant) ||
    !states.includes(record.state) ||
    !Number.isSafeInteger(record.trafficPercent) ||
    record.trafficPercent < 0 ||
    record.trafficPercent > 100 ||
    (health !== 'unknown' && health !== 'healthy' && health !== 'unhealthy')
  ) {
    throw runtimeError(
      'VALIDATION_SCHEMA_MISMATCH',
      'Hosted deployment backend returned an invalid record',
    );
  }
  return structuredClone(record);
}
