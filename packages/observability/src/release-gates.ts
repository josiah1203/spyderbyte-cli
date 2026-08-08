export type SloMetric =
  | 'success_rate'
  | 'p95_latency_ms'
  | 'max_latency_ms'
  | 'recovery_time_ms'
  | 'audit_completeness'
  | 'budget_variance_minor';

export type SloComparator = 'at_least' | 'at_most';

export interface SloTarget {
  readonly name: string;
  readonly metric: SloMetric;
  readonly comparator: SloComparator;
  readonly target: number;
  readonly unit: 'ratio' | 'milliseconds' | 'minor_units';
}

export interface SloEvaluation {
  readonly target: SloTarget;
  readonly observed: number | undefined;
  readonly sampleCount: number;
  readonly passed: boolean;
  readonly reason: string;
}

export interface CapacityProbeOptions {
  readonly taskCount: number;
  readonly concurrency: number;
  readonly run: (index: number) => Promise<void>;
  readonly clock?: () => number;
}

export interface CapacityObservation {
  readonly attempted: number;
  readonly completed: number;
  readonly failed: number;
  readonly latenciesMs: readonly number[];
  readonly durationMs: number;
}

export interface CapacityTarget {
  readonly name: string;
  readonly minimumCompleted: number;
  readonly maximumFailed: number;
  readonly maximumP95LatencyMs?: number;
}

export interface CapacityEvaluation {
  readonly target: CapacityTarget;
  readonly p95LatencyMs: number | undefined;
  readonly passed: boolean;
  readonly checks: readonly {
    readonly name: string;
    readonly passed: boolean;
    readonly observed: number;
    readonly target: number;
  }[];
}

export type RolloutStage = 'shadow' | 'canary' | 'limited' | 'general';

export interface ReleaseGateCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly observed?: number;
  readonly target?: number;
  readonly evidenceDigest?: HashSha256;
}

export interface ReleaseGateInput {
  readonly releaseId: Id;
  readonly harnessVersion: string;
  readonly stage: RolloutStage;
  readonly previousReleaseId?: Id;
  readonly checks: readonly ReleaseGateCheck[];
  readonly operatorApproved: boolean;
  readonly operator?: Actor;
  readonly evaluatedAt: string;
}

export interface ReleaseGateEvaluation {
  readonly evaluationId: Id;
  readonly releaseId: Id;
  readonly harnessVersion: string;
  readonly stage: RolloutStage;
  readonly checks: readonly ReleaseGateCheck[];
  readonly operatorApproved: boolean;
  readonly evaluatedAt: string;
  readonly passed: boolean;
  readonly decision: 'advance' | 'hold';
  readonly rollbackRequired: boolean;
  readonly previousReleaseId?: Id;
  readonly nextStage?: RolloutStage;
  readonly evidenceDigest: HashSha256;
}

export function summarizeSlo(metric: SloMetric, samples: readonly number[]): number | undefined {
  if (samples.length === 0) return undefined;
  if (samples.some((sample) => !Number.isFinite(sample))) {
    throw new TypeError('SLO samples must be finite numbers');
  }
  switch (metric) {
    case 'success_rate':
    case 'audit_completeness':
      return samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
    case 'p95_latency_ms':
      return percentile(samples, 0.95);
    case 'max_latency_ms':
    case 'recovery_time_ms':
    case 'budget_variance_minor':
      return Math.max(...samples);
  }
}

export function evaluateSlo(target: SloTarget, samples: readonly number[]): SloEvaluation {
  validateSloTarget(target);
  const observed = summarizeSlo(target.metric, samples);
  if (observed === undefined) {
    return {
      target,
      observed,
      sampleCount: 0,
      passed: false,
      reason: 'No observations were supplied',
    };
  }
  const passed =
    target.comparator === 'at_least' ? observed >= target.target : observed <= target.target;
  return {
    target,
    observed,
    sampleCount: samples.length,
    passed,
    reason: passed
      ? 'Observed value satisfies the supplied target'
      : 'Observed value violates the supplied target',
  };
}

export async function runCapacityProbe(
  options: CapacityProbeOptions,
): Promise<CapacityObservation> {
  if (!Number.isSafeInteger(options.taskCount) || options.taskCount < 1) {
    throw new TypeError('taskCount must be a positive integer');
  }
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
    throw new TypeError('concurrency must be a positive integer');
  }
  const clock = options.clock ?? (() => Date.now());
  const startedAt = clock();
  const latencies: number[] = [];
  let completed = 0;
  let failed = 0;
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < options.taskCount) {
      const index = nextIndex;
      nextIndex += 1;
      const taskStartedAt = clock();
      try {
        await options.run(index);
        completed += 1;
        latencies.push(Math.max(0, clock() - taskStartedAt));
      } catch {
        failed += 1;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, options.taskCount) }, () => worker()),
  );
  return {
    attempted: options.taskCount,
    completed,
    failed,
    latenciesMs: latencies,
    durationMs: Math.max(0, clock() - startedAt),
  };
}

export function evaluateCapacity(
  target: CapacityTarget,
  observation: CapacityObservation,
): CapacityEvaluation {
  if (!Number.isSafeInteger(target.minimumCompleted) || target.minimumCompleted < 0) {
    throw new TypeError('minimumCompleted must be a non-negative integer');
  }
  if (!Number.isSafeInteger(target.maximumFailed) || target.maximumFailed < 0) {
    throw new TypeError('maximumFailed must be a non-negative integer');
  }
  const p95LatencyMs = summarizeSlo('p95_latency_ms', observation.latenciesMs);
  const checks = [
    {
      name: 'minimum_completed',
      passed: observation.completed >= target.minimumCompleted,
      observed: observation.completed,
      target: target.minimumCompleted,
    },
    {
      name: 'maximum_failed',
      passed: observation.failed <= target.maximumFailed,
      observed: observation.failed,
      target: target.maximumFailed,
    },
    ...(target.maximumP95LatencyMs === undefined || p95LatencyMs === undefined
      ? []
      : [
          {
            name: 'maximum_p95_latency_ms',
            passed: p95LatencyMs <= target.maximumP95LatencyMs,
            observed: p95LatencyMs,
            target: target.maximumP95LatencyMs,
          },
        ]),
  ] as const;
  return {
    target,
    p95LatencyMs,
    passed: checks.every((check) => check.passed),
    checks,
  };
}

export function evaluateReleaseGate(input: ReleaseGateInput): ReleaseGateEvaluation {
  if (input.harnessVersion.trim().length === 0) {
    throw new TypeError('harnessVersion is required');
  }
  if (input.evaluatedAt.trim().length === 0) throw new TypeError('evaluatedAt is required');
  const names = new Set<string>();
  for (const check of input.checks) {
    if (check.name.trim().length === 0) throw new TypeError('release gate check name is required');
    if (names.has(check.name)) throw new TypeError(`duplicate release gate check: ${check.name}`);
    names.add(check.name);
  }
  if (input.operatorApproved && input.operator?.type !== 'human') {
    throw new TypeError('operator approval must identify a human actor');
  }
  const checks = [...input.checks];
  const operatorCheck: ReleaseGateCheck = {
    name: 'operator_approval',
    passed: input.operatorApproved,
  };
  const allChecks = [...checks, operatorCheck];
  const passed = allChecks.length > 0 && allChecks.every((check) => check.passed);
  const nextStage = input.stage === 'general' ? undefined : nextRolloutStage(input.stage);
  const evidenceDigest = createHash('sha256')
    .update(
      JSON.stringify({
        releaseId: input.releaseId,
        harnessVersion: input.harnessVersion,
        stage: input.stage,
        previousReleaseId: input.previousReleaseId,
        checks: allChecks,
        operatorApproved: input.operatorApproved,
        evaluatedAt: input.evaluatedAt,
      }),
    )
    .digest('hex') as HashSha256;
  return {
    evaluationId: newSortableId(),
    releaseId: input.releaseId,
    harnessVersion: input.harnessVersion,
    stage: input.stage,
    checks: allChecks,
    operatorApproved: input.operatorApproved,
    evaluatedAt: input.evaluatedAt,
    passed,
    decision: passed ? 'advance' : 'hold',
    rollbackRequired: !passed && input.previousReleaseId !== undefined,
    ...(input.previousReleaseId === undefined
      ? {}
      : { previousReleaseId: input.previousReleaseId }),
    ...(nextStage === undefined ? {} : { nextStage }),
    evidenceDigest,
  };
}

function nextRolloutStage(stage: RolloutStage): RolloutStage {
  switch (stage) {
    case 'shadow':
      return 'canary';
    case 'canary':
      return 'limited';
    case 'limited':
      return 'general';
    case 'general':
      return 'general';
  }
}

function validateSloTarget(target: SloTarget): void {
  if (target.name.trim().length === 0) throw new TypeError('SLO target name is required');
  if (!Number.isFinite(target.target) || target.target < 0) {
    throw new TypeError('SLO target must be a non-negative finite number');
  }
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[index] ?? 0;
}
import { createHash } from 'node:crypto';
import {
  newSortableId,
  type Actor,
  type HashSha256,
  type Id,
} from '@agentic-platform/runtime-contracts';
