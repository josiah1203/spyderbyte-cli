import { createHash } from 'node:crypto';
import {
  newSortableId,
  runtimeError,
  type ArtifactReference,
  type HashSha256,
  type Id,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import {
  LocalComputeBackend,
  computeActualCost,
  type ApprovedAllocationGrant,
  type ComputeBackend,
  type ComputeResources,
  type ComputeOffer,
  type JobObservation,
} from './compute.js';

export interface TrainingStrategy {
  readonly strategyId: string;
  readonly baseModel: string;
  readonly method: 'full_finetune' | 'lora' | 'prompt_tuning';
  readonly objective: string;
  readonly checkpointEverySteps: number;
  readonly earlyStopMetric: string;
}

export interface TrainingConfig {
  readonly configId: string;
  readonly strategy: TrainingStrategy;
  readonly hyperparameters: Readonly<Record<string, number | string>>;
  readonly resources: ComputeResources;
  readonly durationSeconds: number;
}

export interface TrainingWorkflowRequest {
  readonly tenant: TenantRef;
  readonly validatedDataset: ArtifactReference;
  readonly sourceRevision: string;
  readonly configs: readonly [TrainingConfig, TrainingConfig];
  readonly budgetLimitMinor: number;
  readonly currency: string;
  readonly clusterGrantFor: (offer: ComputeOffer) => ApprovedAllocationGrant;
  readonly command?: string;
  readonly args?: readonly string[];
}

export interface TrainingSummary {
  readonly schemaVersion: 1;
  readonly runId: Id;
  readonly status: 'succeeded' | 'blocked' | 'failed';
  readonly selectedConfigId: string;
  readonly dataset: ArtifactReference;
  readonly sourceRevision: string;
  readonly metrics: Readonly<Record<string, number>>;
  readonly estimatedCostMinor: number;
  readonly actualCostMinor: number;
  readonly costMinor: number;
  readonly failureCode?: string;
}

export interface TrainingCandidateRun {
  readonly configId: string;
  readonly summary: TrainingSummary;
  readonly checkpoint?: ArtifactReference;
  readonly observations: readonly JobObservation[];
}

export interface TrainingWorkflowResult {
  readonly summary: TrainingSummary;
  readonly checkpoint?: ArtifactReference;
  readonly observations: readonly JobObservation[];
  readonly candidateRuns: readonly TrainingCandidateRun[];
}

function checkpointReference(tenant: TenantRef, output: string, now: string): ArtifactReference {
  const contentHash = createHash('sha256').update(output).digest('hex') as HashSha256;
  return {
    schemaVersion: 1,
    tenant,
    artifactId: newSortableId(),
    version: 1,
    contentHash,
    mediaType: 'application/json',
    sizeBytes: Buffer.byteLength(output),
    createdAt: now,
  };
}

export class LocalTrainingSmokeWorkflow {
  private readonly compute: ComputeBackend;
  private readonly clock: () => string;

  constructor(options: { compute?: ComputeBackend; clock?: () => string } = {}) {
    this.compute = options.compute ?? new LocalComputeBackend();
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async run(request: TrainingWorkflowRequest): Promise<TrainingWorkflowResult> {
    if (request.configs[0].configId === request.configs[1].configId) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'Training workflow requires two distinct candidate configurations',
      );
    }
    if (!Number.isSafeInteger(request.budgetLimitMinor) || request.budgetLimitMinor < 0) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'Training budget must be a non-negative integer minor-unit amount',
      );
    }

    const candidateRuns: TrainingCandidateRun[] = [];
    let estimatedCostMinor = 0;
    let actualCostMinor = 0;

    // Candidates run sequentially so a completed run releases its allocation before the
    // next offer is requested. The remaining budget is based on reconciled actual usage,
    // while each offer is still bounded by the remaining approved amount.
    for (const config of request.configs) {
      const remainingBudgetMinor = Math.max(0, request.budgetLimitMinor - actualCostMinor);
      const offers = await this.compute.estimate({
        tenant: request.tenant,
        name: `training:${config.configId}`,
        resources: config.resources,
        durationSeconds: config.durationSeconds,
        maxCostMinor: remainingBudgetMinor,
        currency: request.currency,
      });
      const offer = offers[0];
      if (offer === undefined) {
        candidateRuns.push({
          configId: config.configId,
          summary: {
            schemaVersion: 1,
            runId: newSortableId(),
            status: 'blocked',
            selectedConfigId: config.configId,
            dataset: request.validatedDataset,
            sourceRevision: request.sourceRevision,
            metrics: {},
            estimatedCostMinor: 0,
            actualCostMinor: 0,
            costMinor: 0,
            failureCode: remainingBudgetMinor === 0 ? 'BUDGET_REJECTION' : 'CAPACITY_UNAVAILABLE',
          },
          observations: [],
        });
        continue;
      }

      if (offer.estimatedCost.amountMinor > remainingBudgetMinor) {
        candidateRuns.push({
          configId: config.configId,
          summary: {
            schemaVersion: 1,
            runId: newSortableId(),
            status: 'blocked',
            selectedConfigId: config.configId,
            dataset: request.validatedDataset,
            sourceRevision: request.sourceRevision,
            metrics: {},
            estimatedCostMinor: offer.estimatedCost.amountMinor,
            actualCostMinor: 0,
            costMinor: 0,
            failureCode: 'BUDGET_REJECTION',
          },
          observations: [],
        });
        continue;
      }

      estimatedCostMinor += offer.estimatedCost.amountMinor;
      const grant = request.clusterGrantFor(offer);
      const allocation = await this.compute.allocate(offer, grant);
      const job = await this.compute.submitJob(allocation, {
        command: request.command ?? process.execPath,
        args: request.args ?? [
          '-e',
          'process.stdout.write(JSON.stringify({ checkpoint: "local-smoke", metric: 0.75 }))',
        ],
        wallTimeMs: config.durationSeconds * 1000,
        outputBytes: 1024 * 1024,
      });
      const observations: JobObservation[] = [];
      for await (const observation of this.compute.observeJob(job)) observations.push(observation);
      const final = observations.at(-1);
      const candidateActualCostMinor =
        final === undefined ? 0 : computeActualCost(offer, final).amountMinor;
      actualCostMinor += candidateActualCostMinor;
      const exceededBudget = actualCostMinor > request.budgetLimitMinor;

      if (final === undefined || final.status !== 'succeeded' || exceededBudget) {
        candidateRuns.push({
          configId: config.configId,
          summary: {
            schemaVersion: 1,
            runId: newSortableId(),
            status: 'failed',
            selectedConfigId: config.configId,
            dataset: request.validatedDataset,
            sourceRevision: request.sourceRevision,
            metrics: {},
            estimatedCostMinor: offer.estimatedCost.amountMinor,
            actualCostMinor: candidateActualCostMinor,
            costMinor: candidateActualCostMinor,
            ...(exceededBudget
              ? { failureCode: 'BUDGET_REJECTION' }
              : final?.failureCode !== undefined
                ? { failureCode: final.failureCode }
                : { failureCode: 'UNKNOWN_INFRASTRUCTURE' }),
          },
          observations,
        });
        continue;
      }

      const now = this.clock();
      const checkpoint = checkpointReference(request.tenant, final.stdout, now);
      const metric = metricFromOutput(final.stdout);
      candidateRuns.push({
        configId: config.configId,
        summary: {
          schemaVersion: 1,
          runId: newSortableId(),
          status: 'succeeded',
          selectedConfigId: config.configId,
          dataset: request.validatedDataset,
          sourceRevision: request.sourceRevision,
          metrics: { smoke_metric: metric },
          estimatedCostMinor: offer.estimatedCost.amountMinor,
          actualCostMinor: candidateActualCostMinor,
          costMinor: candidateActualCostMinor,
        },
        checkpoint,
        observations,
      });
    }

    const successful = candidateRuns.filter(
      (candidate) => candidate.summary.status === 'succeeded',
    );
    const selected = successful.reduce<TrainingCandidateRun | undefined>((best, candidate) => {
      if (best === undefined) return candidate;
      const bestMetric = best.summary.metrics['smoke_metric'] ?? Number.NEGATIVE_INFINITY;
      const candidateMetric = candidate.summary.metrics['smoke_metric'] ?? Number.NEGATIVE_INFINITY;
      return candidateMetric > bestMetric ? candidate : best;
    }, undefined);
    const allCandidatesSucceeded = successful.length === request.configs.length;
    const hasFailure = candidateRuns.some((candidate) => candidate.summary.status === 'failed');
    const status: TrainingSummary['status'] = allCandidatesSucceeded
      ? 'succeeded'
      : hasFailure
        ? 'failed'
        : 'blocked';
    const fallback = candidateRuns[0];
    if (fallback === undefined) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Training workflow produced no candidates');
    }
    const chosen = selected ?? fallback;
    const failureCode = candidateRuns
      .map((candidate) => candidate.summary.failureCode)
      .find((code): code is string => code !== undefined);
    return {
      summary: {
        ...chosen.summary,
        runId: newSortableId(),
        status,
        selectedConfigId: chosen.configId,
        estimatedCostMinor,
        actualCostMinor,
        costMinor: actualCostMinor,
        ...(failureCode !== undefined && status !== 'succeeded' ? { failureCode } : {}),
      },
      ...(status === 'succeeded' && chosen.checkpoint !== undefined
        ? { checkpoint: chosen.checkpoint }
        : {}),
      observations: candidateRuns.flatMap((candidate) => candidate.observations),
      candidateRuns,
    };
  }
}

function metricFromOutput(output: string): number {
  try {
    const parsed: unknown = JSON.parse(output);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>)['metric'] === 'number'
    ) {
      return (parsed as Record<string, number>)['metric'] ?? 0;
    }
  } catch {
    // A successful task without a metric remains valid, but has the deterministic default.
  }
  return 0;
}
