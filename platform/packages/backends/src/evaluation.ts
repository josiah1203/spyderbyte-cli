import { createHash } from 'node:crypto';
import {
  newSortableId,
  runtimeError,
  type ArtifactReference,
  type HashSha256,
  type Id,
  type JsonPrimitive,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';

export type EvaluationMetricName = 'accuracy' | 'mae' | 'rmse';
export type EvaluationRecommendation = 'promote' | 'reject' | 'investigate';

export interface EvaluationObservationV1 {
  readonly expected: JsonPrimitive;
  readonly candidate: JsonPrimitive;
  readonly baseline?: JsonPrimitive;
}

export interface EvaluationMetricSpecV1 {
  readonly name: EvaluationMetricName;
  readonly higherIsBetter: boolean;
  readonly requiredMinimum?: number;
  readonly maximumRegression?: number;
}

export interface EvaluationRequestV1 {
  readonly evaluationId?: Id;
  readonly tenant: TenantRef;
  readonly candidateArtifact: ArtifactReference;
  readonly baselineArtifact?: ArtifactReference;
  readonly datasetVersion: ArtifactReference;
  readonly benchmarkId: string;
  readonly benchmarkVersion: number;
  readonly observations: readonly EvaluationObservationV1[];
  readonly metrics?: readonly EvaluationMetricSpecV1[];
  readonly minimumSampleSize?: number;
  readonly limitations?: readonly string[];
}

export interface EvaluationMetricResultV1 {
  readonly name: EvaluationMetricName;
  readonly candidate: number;
  readonly baseline?: number;
  readonly regression?: number;
  readonly passed: boolean;
}

export interface EvaluationResultV1 {
  readonly schemaVersion: 1;
  readonly evaluationId: Id;
  readonly tenant: TenantRef;
  readonly candidateArtifact: ArtifactReference;
  readonly baselineArtifact?: ArtifactReference;
  readonly datasetVersion: ArtifactReference;
  readonly benchmarkId: string;
  readonly benchmarkVersion: number;
  readonly sampleSize: number;
  readonly inputDigest: HashSha256;
  readonly evaluationArtifact: ArtifactReference;
  readonly metrics: readonly EvaluationMetricResultV1[];
  readonly recommendation: EvaluationRecommendation;
  readonly limitations: readonly string[];
  readonly immutable: true;
  readonly createdAt: string;
}

export interface EvaluationBackend {
  evaluate(request: EvaluationRequestV1): Promise<EvaluationResultV1>;
  get(evaluationId: Id): Promise<EvaluationResultV1 | undefined>;
  list(tenant?: TenantRef): Promise<readonly EvaluationResultV1[]>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sameTenant(left: TenantRef, right: TenantRef): boolean {
  return left.tenantId === right.tenantId && left.workspaceId === right.workspaceId;
}

function assertTenant(tenant: TenantRef, artifact: ArtifactReference, label: string): void {
  if (!sameTenant(tenant, artifact.tenant)) {
    throw runtimeError('POLICY_DENIED', `${label} crosses the evaluation tenant boundary`);
  }
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value))
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} must be finite`);
}

function numericPair(
  observations: readonly EvaluationObservationV1[],
  name: string,
): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (const observation of observations) {
    if (typeof observation.expected !== 'number' || typeof observation.candidate !== 'number') {
      throw runtimeError('VALIDATION_INVALID_INPUT', `${name} requires numeric observations`);
    }
    assertFinite(observation.expected, 'Expected value');
    assertFinite(observation.candidate, 'Candidate value');
    pairs.push([observation.expected, observation.candidate]);
  }
  return pairs;
}

function metricValue(
  observations: readonly EvaluationObservationV1[],
  name: EvaluationMetricName,
): number {
  if (name === 'accuracy') {
    if (observations.length === 0) return 0;
    return (
      observations.filter((observation) => observation.expected === observation.candidate).length /
      observations.length
    );
  }
  const pairs = numericPair(observations, name);
  if (pairs.length === 0) return 0;
  const error = pairs.reduce((total, [expected, candidate]) => {
    const difference = candidate - expected;
    return total + (name === 'rmse' ? difference * difference : Math.abs(difference));
  }, 0);
  const mean = error / pairs.length;
  return name === 'rmse' ? Math.sqrt(mean) : mean;
}

function artifactFor(
  tenant: TenantRef,
  evaluationId: Id,
  value: string,
  createdAt: string,
): ArtifactReference {
  return {
    schemaVersion: 1,
    tenant: clone(tenant),
    artifactId: newSortableId(),
    version: 1,
    contentHash: `sha256:${createHash('sha256').update(value).digest('hex')}` as HashSha256,
    mediaType: 'application/json',
    sizeBytes: Buffer.byteLength(value, 'utf8'),
    createdAt,
  };
}

function tenantFilter(tenant: TenantRef | undefined, candidate: EvaluationResultV1): boolean {
  return tenant === undefined || sameTenant(tenant, candidate.tenant);
}

/**
 * Deterministic evaluation backend. Inputs are snapshotted and hashed before metrics run, so an
 * evaluation result cannot silently change when a mutable dataset or benchmark is edited later.
 */
export class InMemoryEvaluationBackend implements EvaluationBackend {
  private readonly results = new Map<Id, EvaluationResultV1>();
  private readonly clock: () => string;

  constructor(options: { readonly clock?: () => string } = {}) {
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async evaluate(request: EvaluationRequestV1): Promise<EvaluationResultV1> {
    const evaluationId = request.evaluationId ?? newSortableId();
    assertTenant(request.tenant, request.candidateArtifact, 'Candidate artifact');
    assertTenant(request.tenant, request.datasetVersion, 'Dataset version');
    if (request.baselineArtifact !== undefined) {
      assertTenant(request.tenant, request.baselineArtifact, 'Baseline artifact');
    }
    if (request.benchmarkId.trim().length === 0 || request.benchmarkId.length > 160) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'benchmarkId is required and must be bounded');
    }
    if (!Number.isSafeInteger(request.benchmarkVersion) || request.benchmarkVersion < 1) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'benchmarkVersion must be positive');
    }
    const minimumSampleSize = request.minimumSampleSize ?? 1;
    if (
      !Number.isSafeInteger(minimumSampleSize) ||
      minimumSampleSize < 1 ||
      minimumSampleSize > 1_000_000
    ) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'minimumSampleSize is outside the allowed range',
      );
    }
    if (request.observations.length < minimumSampleSize) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        `Evaluation requires at least ${minimumSampleSize} observations`,
      );
    }
    if (this.results.has(evaluationId)) {
      throw runtimeError('CONCURRENCY_STALE_VERSION', `Evaluation ${evaluationId} already exists`);
    }
    const specs =
      request.metrics === undefined || request.metrics.length === 0
        ? [{ name: 'accuracy' as const, higherIsBetter: true }]
        : request.metrics;
    const metricNames = new Set<EvaluationMetricName>();
    for (const spec of specs) {
      if (metricNames.has(spec.name)) {
        throw runtimeError('VALIDATION_INVALID_INPUT', `Duplicate evaluation metric ${spec.name}`);
      }
      metricNames.add(spec.name);
      if (spec.requiredMinimum !== undefined)
        assertFinite(spec.requiredMinimum, `${spec.name} minimum`);
      if (spec.maximumRegression !== undefined) {
        assertFinite(spec.maximumRegression, `${spec.name} regression threshold`);
        if (spec.maximumRegression < 0) {
          throw runtimeError(
            'VALIDATION_INVALID_INPUT',
            `${spec.name} regression threshold must be non-negative`,
          );
        }
      }
    }
    const observations = clone(request.observations);
    const inputDigest = createHash('sha256')
      .update(
        JSON.stringify({
          candidateArtifact: request.candidateArtifact,
          baselineArtifact: request.baselineArtifact ?? null,
          datasetVersion: request.datasetVersion,
          benchmarkId: request.benchmarkId,
          benchmarkVersion: request.benchmarkVersion,
          observations,
          metrics: specs,
        }),
      )
      .digest('hex') as HashSha256;
    const metrics: EvaluationMetricResultV1[] = [];
    let failedThreshold = false;
    let regression = false;
    for (const spec of specs) {
      const candidate = metricValue(observations, spec.name);
      const baseline =
        request.baselineArtifact === undefined ||
        observations.some((item) => item.baseline === undefined)
          ? undefined
          : metricValue(
              observations.map((item) => ({
                expected: item.expected,
                candidate: item.baseline ?? null,
              })),
              spec.name,
            );
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
      metrics.push({
        name: spec.name,
        candidate,
        ...(baseline === undefined ? {} : { baseline }),
        ...(delta === undefined ? {} : { regression: delta }),
        passed: !belowMinimum && !aboveRegression,
      });
    }
    const recommendation: EvaluationRecommendation = regression
      ? 'investigate'
      : failedThreshold
        ? 'reject'
        : 'promote';
    const createdAt = this.clock();
    const limitations = [
      ...(request.limitations ?? []),
      ...(request.baselineArtifact === undefined ? ['No baseline comparison was supplied.'] : []),
      ...(observations.some((item) => item.baseline === undefined) &&
      request.baselineArtifact !== undefined
        ? ['Some baseline observations were unavailable.']
        : []),
    ];
    const resultWithoutArtifact = {
      schemaVersion: 1 as const,
      evaluationId,
      tenant: clone(request.tenant),
      candidateArtifact: clone(request.candidateArtifact),
      ...(request.baselineArtifact === undefined
        ? {}
        : { baselineArtifact: clone(request.baselineArtifact) }),
      datasetVersion: clone(request.datasetVersion),
      benchmarkId: request.benchmarkId,
      benchmarkVersion: request.benchmarkVersion,
      sampleSize: observations.length,
      inputDigest,
      metrics: clone(metrics),
      recommendation,
      limitations: [
        ...new Set(limitations.map((item) => item.trim()).filter((item) => item.length > 0)),
      ],
      immutable: true as const,
      createdAt,
    };
    const serialized = JSON.stringify(resultWithoutArtifact);
    const result: EvaluationResultV1 = {
      ...resultWithoutArtifact,
      evaluationArtifact: artifactFor(request.tenant, evaluationId, serialized, createdAt),
    };
    this.results.set(evaluationId, result);
    return clone(result);
  }

  async get(evaluationId: Id): Promise<EvaluationResultV1 | undefined> {
    const result = this.results.get(evaluationId);
    return result === undefined ? undefined : clone(result);
  }

  async list(tenant?: TenantRef): Promise<readonly EvaluationResultV1[]> {
    return clone([...this.results.values()].filter((result) => tenantFilter(tenant, result)));
  }
}
