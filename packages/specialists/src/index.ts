import { createHash } from 'node:crypto';
import {
  type ArtifactReference,
  type HashSha256,
  type JsonValue,
} from '@agentic-platform/runtime-contracts';
import {
  type DatasetProfile,
  type DatasetValidationOptions,
  type DatasetValidationResult,
  validateDataset,
} from '@agentic-platform/tasks';
import {
  type ApprovedAllocationGrant,
  type ComputeOffer,
  type ComputeResources,
  type TrainingConfig,
  type TrainingStrategy,
} from '@agentic-platform/backends';
import {
  newSortableId,
  runtimeError,
  type AgentTier,
  type AuthorityEnvelope,
  type DeploymentState,
  type Id,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';

export interface GovernanceInput {
  sourceArtifact: ArtifactReference;
  intendedUse: string;
  requestedAccessScopes: string[];
  retentionDays: number;
  profile: DatasetProfile;
  now: string;
  policyVersion?: string;
  enforcementMode?: 'personal_local' | 'organization';
}

export interface GovernanceEvidence {
  [key: string]: JsonValue;
  column?: string;
  code: string;
  detail: string;
}

export interface GovernanceDecision {
  schemaVersion: 1;
  decision: 'approved' | 'warning' | 'denied';
  sourceArtifact: ArtifactReference;
  intendedUse: string;
  requestedAccessScopes: string[];
  retentionDays: number;
  constraints: string[];
  reasonCodes: string[];
  evidence: GovernanceEvidence[];
  policyVersion: string;
  expiresAt: string;
}

export class GovernanceSpecialist {
  evaluate(input: GovernanceInput): GovernanceDecision {
    const reasonCodes: string[] = [];
    const evidence: GovernanceEvidence[] = [];
    const constraints: string[] = [];
    if (input.intendedUse.trim().length === 0) {
      reasonCodes.push('INTENDED_USE_REQUIRED');
    }
    if (
      !Number.isSafeInteger(input.retentionDays) ||
      input.retentionDays < 1 ||
      input.retentionDays > 365
    ) {
      reasonCodes.push('RETENTION_OUTSIDE_POLICY');
      evidence.push({
        code: 'RETENTION_OUTSIDE_POLICY',
        detail: 'Local governance policy permits retention from 1 through 365 days',
      });
    }
    if (input.requestedAccessScopes.length === 0) {
      reasonCodes.push('ACCESS_SCOPE_REQUIRED');
    }
    if (input.profile.parseErrors.length > 0) {
      reasonCodes.push('DATASET_PARSE_INVALID');
      for (const detail of input.profile.parseErrors) {
        evidence.push({ code: 'DATASET_PARSE_INVALID', detail });
      }
    }
    const piiColumns = input.profile.columns
      .filter((column) => column.pii)
      .map((column) => column.name);
    if (piiColumns.length > 0) {
      constraints.push('PII columns require purpose limitation and access logging');
      for (const column of piiColumns) {
        evidence.push({
          column,
          code: 'PII_COLUMN_DETECTED',
          detail: 'Column name matches the local PII scanner fixture',
        });
      }
      if (
        !input.requestedAccessScopes.includes('pii.read') &&
        !input.requestedAccessScopes.includes('pii:read')
      ) {
        reasonCodes.push('PII_SCOPE_NOT_REQUESTED');
      }
    }
    if (input.profile.rowCount === 0) reasonCodes.push('DATASET_EMPTY');
    if (input.profile.leakageRate > 0) {
      constraints.push('Split leakage must remain below the configured validation threshold');
    }
    const policyVersion = input.policyVersion ?? 'dataset-governance.v1';
    const expiresAt = new Date(Date.parse(input.now) + 30 * 24 * 60 * 60 * 1000).toISOString();
    const uniqueReasonCodes = [...new Set(reasonCodes)].sort();
    const hardLocalFailures = new Set([
      'INTENDED_USE_REQUIRED',
      'ACCESS_SCOPE_REQUIRED',
      'DATASET_PARSE_INVALID',
      'DATASET_EMPTY',
    ]);
    const decision =
      uniqueReasonCodes.length === 0
        ? 'approved'
        : input.enforcementMode === 'personal_local' &&
            uniqueReasonCodes.every((reasonCode) => !hardLocalFailures.has(reasonCode))
          ? 'warning'
          : 'denied';
    return {
      schemaVersion: 1,
      decision,
      sourceArtifact: input.sourceArtifact,
      intendedUse: input.intendedUse,
      requestedAccessScopes: [...input.requestedAccessScopes].sort(),
      retentionDays: input.retentionDays,
      constraints,
      reasonCodes: uniqueReasonCodes,
      evidence,
      policyVersion,
      expiresAt,
    };
  }
}

export interface DataEngineerInput {
  content: Uint8Array | string;
  validation: DatasetValidationOptions;
}

export interface DataEngineerResult {
  schemaVersion: 1;
  status: 'success' | 'blocked' | 'failure';
  reasonCodes: string[];
  profileHash: HashSha256;
  qualityReport: DatasetValidationResult['qualityReport'];
  validatedDataset: DatasetValidationResult['validatedDataset'];
}

export class DataEngineerSpecialist {
  validate(input: DataEngineerInput): DataEngineerResult {
    const result = validateDataset(input.content, input.validation);
    const reasonCodes = result.violations.map((violation) => {
      if (violation.includes('leakage')) return 'LEAKAGE_THRESHOLD_EXCEEDED';
      if (violation.includes('Required column') || violation.includes('Expected column')) {
        return 'SCHEMA_INVALID';
      }
      if (violation.includes('type')) return 'SCHEMA_INVALID';
      if (violation.includes('parse') || violation.includes('JSON') || violation.includes('CSV')) {
        return 'PARSE_INVALID';
      }
      return 'DATASET_INVALID';
    });
    const status = result.valid
      ? 'success'
      : reasonCodes.includes('LEAKAGE_THRESHOLD_EXCEEDED')
        ? 'blocked'
        : 'failure';
    return {
      schemaVersion: 1,
      status,
      reasonCodes: [...new Set(reasonCodes)].sort(),
      profileHash: result.qualityReport.profileHash,
      qualityReport: result.qualityReport,
      validatedDataset: result.validatedDataset,
    };
  }
}

export interface MlEngineerInput {
  readonly baseModel: string;
  readonly method: TrainingStrategy['method'];
  readonly objective: string;
  readonly dataset: ArtifactReference;
  readonly resources: ComputeResources;
}

export class MlEngineerSpecialist {
  proposeStrategy(input: MlEngineerInput): TrainingStrategy {
    if (input.baseModel.length === 0 || input.objective.length === 0) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'ML Engineer requires a base model and objective',
      );
    }
    return {
      strategyId: `strategy-${input.baseModel}-${input.method}`,
      baseModel: input.baseModel,
      method: input.method,
      objective: input.objective,
      checkpointEverySteps: 100,
      earlyStopMetric: 'validation_loss',
    };
  }

  generateCandidateConfigs(
    strategy: TrainingStrategy,
    resources: ComputeResources,
  ): [TrainingConfig, TrainingConfig] {
    return [
      {
        configId: `${strategy.strategyId}-small-batch`,
        strategy,
        hyperparameters: { learningRate: 0.0001, microBatchSize: 1 },
        resources,
        durationSeconds: 60,
      },
      {
        configId: `${strategy.strategyId}-larger-batch`,
        strategy,
        hyperparameters: { learningRate: 0.00005, microBatchSize: 2 },
        resources,
        durationSeconds: 60,
      },
    ];
  }
}

export interface ClusterGrantInput {
  readonly offer: ComputeOffer;
  readonly tenant: TenantRef;
  readonly authority: AuthorityEnvelope;
  readonly approvalDigest: string;
  readonly budgetId: Id;
  readonly approved: boolean;
  readonly ttlMs?: number;
  readonly now: string;
}

export class ClusterSpecialist {
  createAllocationGrant(input: ClusterGrantInput): ApprovedAllocationGrant {
    if (input.authority.tier !== 1 || !input.approved) {
      throw runtimeError(
        'AUTHORITY_MISSING',
        'Cluster allocation requires approved Tier 1 authority',
      );
    }
    if (
      input.offer.tenant.tenantId !== input.tenant.tenantId ||
      input.offer.tenant.workspaceId !== input.tenant.workspaceId
    ) {
      throw runtimeError('POLICY_DENIED', 'Cluster offer tenant does not match the request');
    }
    return {
      grantId: newSortableId(),
      offerId: input.offer.offerId,
      tenant: input.tenant,
      specialistType: 'cluster',
      tier: 1,
      authority: input.authority,
      approved: input.approved,
      approvalDigest: input.approvalDigest,
      budgetId: input.budgetId,
      estimatedCost: input.offer.estimatedCost,
      expiresAt: new Date(Date.parse(input.now) + (input.ttlMs ?? 60_000)).toISOString(),
    };
  }
}

export interface EvaluationInput {
  readonly candidate: ArtifactReference;
  readonly baseline: ArtifactReference;
  readonly benchmark: ArtifactReference;
  readonly candidateMetric: number;
  readonly baselineMetric: number;
  readonly safetyRegression: boolean;
  readonly candidateSamples?: readonly number[];
  readonly baselineSamples?: readonly number[];
  readonly minimumSampleSize?: number;
}

export interface StatisticalComparison {
  readonly candidateSampleSize: number;
  readonly baselineSampleSize: number;
  readonly minimumSampleSize: number;
  readonly sufficientSampleSize: boolean;
  readonly standardError?: number;
  readonly zScore?: number;
  readonly statisticallySignificant?: boolean;
}

export interface EvaluationResult {
  readonly schemaVersion: 1;
  readonly candidate: ArtifactReference;
  readonly baseline: ArtifactReference;
  readonly benchmark: ArtifactReference;
  readonly metricDelta: number;
  readonly comparison: StatisticalComparison;
  readonly recommendation: 'promote' | 'reject' | 'investigate';
  readonly limitations: string[];
}

export class EvalSpecialist {
  evaluate(input: EvaluationInput): EvaluationResult {
    if (!Number.isFinite(input.candidateMetric) || !Number.isFinite(input.baselineMetric)) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Evaluation metrics must be finite numbers');
    }
    const hasSamples = input.candidateSamples !== undefined || input.baselineSamples !== undefined;
    if (
      hasSamples &&
      (input.candidateSamples === undefined || input.baselineSamples === undefined)
    ) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'Candidate and baseline samples must be supplied together',
      );
    }
    const minimumSampleSize = input.minimumSampleSize ?? 1;
    if (!Number.isSafeInteger(minimumSampleSize) || minimumSampleSize < 1) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Minimum sample size must be positive');
    }
    const candidateSamples = input.candidateSamples ?? [];
    const baselineSamples = input.baselineSamples ?? [];
    if (
      candidateSamples.some((value) => !Number.isFinite(value)) ||
      baselineSamples.some((value) => !Number.isFinite(value))
    ) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Evaluation samples must be finite numbers');
    }
    const metricDelta = input.candidateMetric - input.baselineMetric;
    const sufficientSampleSize =
      !hasSamples ||
      (candidateSamples.length >= minimumSampleSize && baselineSamples.length >= minimumSampleSize);
    let standardError: number | undefined;
    let zScore: number | undefined;
    let statisticallySignificant: boolean | undefined;
    if (hasSamples) {
      const candidateVariance = sampleVariance(candidateSamples);
      const baselineVariance = sampleVariance(baselineSamples);
      standardError = Math.sqrt(
        candidateVariance / Math.max(1, candidateSamples.length) +
          baselineVariance / Math.max(1, baselineSamples.length),
      );
      zScore =
        standardError === 0
          ? metricDelta === 0
            ? 0
            : Number.POSITIVE_INFINITY
          : metricDelta / standardError;
      statisticallySignificant = sufficientSampleSize && Math.abs(zScore) >= 1.96;
    }
    const recommendation = input.safetyRegression
      ? 'reject'
      : !sufficientSampleSize || (hasSamples && !statisticallySignificant)
        ? 'investigate'
        : metricDelta > 0
          ? 'promote'
          : metricDelta === 0
            ? 'investigate'
            : 'reject';
    const comparison: StatisticalComparison = {
      candidateSampleSize: hasSamples ? candidateSamples.length : 1,
      baselineSampleSize: hasSamples ? baselineSamples.length : 1,
      minimumSampleSize,
      sufficientSampleSize,
      ...(standardError !== undefined ? { standardError } : {}),
      ...(zScore !== undefined ? { zScore } : {}),
      ...(statisticallySignificant !== undefined ? { statisticallySignificant } : {}),
    };
    return {
      schemaVersion: 1,
      candidate: input.candidate,
      baseline: input.baseline,
      benchmark: input.benchmark,
      metricDelta,
      comparison,
      recommendation,
      limitations: [
        ...(hasSamples
          ? []
          : ['Raw evaluation samples were not supplied; statistical power is not established.']),
        'Evaluation inputs and benchmark references are immutable caller-provided artifacts; the evaluator cannot alter weights, thresholds, or benchmark content.',
      ],
    };
  }
}

function sampleVariance(samples: readonly number[]): number {
  if (samples.length < 2) return 0;
  const mean = samples.reduce((total, value) => total + value, 0) / samples.length;
  return samples.reduce((total, value) => total + (value - mean) ** 2, 0) / (samples.length - 1);
}

export class DeploymentSpecialist {
  transition(
    current: DeploymentState,
    action: 'provision' | 'smokePass' | 'startCanary' | 'ramp' | 'activate' | 'rollback' | 'fail',
  ): DeploymentState {
    const transitions: Record<DeploymentState, Partial<Record<typeof action, DeploymentState>>> = {
      requested: { provision: 'provisioning', fail: 'failed' },
      provisioning: { smokePass: 'smoke_testing', fail: 'failed' },
      smoke_testing: { startCanary: 'canary', fail: 'failed' },
      canary: { ramp: 'ramping', rollback: 'rolled_back', fail: 'failed' },
      ramping: { activate: 'active', rollback: 'rolled_back', fail: 'failed' },
      active: { rollback: 'rolled_back' },
      rolled_back: {},
      failed: {},
    };
    const next = transitions[current][action];
    if (next === undefined)
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        `Illegal deployment transition ${current} -> ${action}`,
      );
    return next;
  }
}

export interface ConnectorScanResult {
  readonly schemaVersion: 1;
  readonly valid: boolean;
  readonly toolNames: string[];
  readonly findings: string[];
}

export interface ConnectorToolSchema {
  readonly name: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, JsonValue>;
    readonly additionalProperties: false;
  };
}

export interface ConnectorBuildInput {
  readonly connectorName: string;
  readonly specification: JsonValue;
  readonly requestedScopes: readonly string[];
  readonly source: string;
}

export interface ConnectorBuildResult {
  readonly schemaVersion: 1;
  readonly connectorName: string;
  readonly scan: ConnectorScanResult;
  readonly toolSchemas: readonly ConnectorToolSchema[];
  readonly generatedSource: string;
  readonly generatedTests: string;
  readonly packageManifest: {
    readonly name: string;
    readonly version: '0.0.0-generated';
    readonly private: true;
    readonly dependencies: Record<string, never>;
  };
  readonly sourceHash: HashSha256;
  readonly scopeDigest: HashSha256;
}

export class ConnectorSpecialist {
  scan(input: {
    readonly specification: JsonValue;
    readonly requestedScopes: readonly string[];
    readonly source: string;
  }): ConnectorScanResult {
    const findings: string[] = [];
    const toolNames: string[] = [];
    if (input.source.trim().length === 0) findings.push('SOURCE_REQUIRED');
    if (input.requestedScopes.length === 0) findings.push('SCOPE_REQUIRED');
    if (
      typeof input.specification !== 'object' ||
      input.specification === null ||
      Array.isArray(input.specification)
    )
      findings.push('SPECIFICATION_INVALID');
    else {
      const tools = input.specification['tools'];
      if (!Array.isArray(tools)) findings.push('TOOLS_REQUIRED');
      else {
        for (const tool of tools) {
          if (typeof tool !== 'string' || tool.trim().length === 0) {
            findings.push('TOOL_NAME_INVALID');
          } else {
            toolNames.push(tool.trim());
          }
        }
        if (new Set(toolNames).size !== toolNames.length) findings.push('DUPLICATE_TOOL_NAME');
      }
    }
    if (input.source.trim().length > 0 && secretPattern.test(input.source)) {
      findings.push('SECRET_PATTERN');
    }
    if (sourceHasUnsafeDependency(input.source)) findings.push('UNSAFE_SOURCE_DEPENDENCY');
    if (unsafeRuntimeConstruction.test(input.source)) findings.push('UNSAFE_RUNTIME_CONSTRUCTION');
    if (unsafeDependencyReference(input.specification)) findings.push('UNSAFE_DEPENDENCY');
    if (input.requestedScopes.some((scope) => scope.includes('write') || scope.includes('admin')))
      findings.push('HIGH_RISK_SCOPE_REQUIRES_HUMAN_APPROVAL');
    return {
      schemaVersion: 1,
      valid: findings.length === 0,
      toolNames: [...toolNames].sort(),
      findings: [...new Set(findings)].sort(),
    };
  }

  build(input: ConnectorBuildInput): ConnectorBuildResult {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(input.connectorName)) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'Connector name must use 1-64 letters, numbers, dots, underscores, or hyphens',
      );
    }
    const scan = this.scan({
      specification: input.specification,
      requestedScopes: input.requestedScopes,
      source: input.source,
    });
    if (!scan.valid) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        `Connector build is blocked by findings: ${scan.findings.join(', ')}`,
      );
    }
    const toolSchemas = scan.toolNames.map((name) => ({
      name,
      inputSchema: {
        type: 'object' as const,
        properties: {},
        additionalProperties: false as const,
      },
    }));
    const packageManifest = {
      name: input.connectorName,
      version: '0.0.0-generated' as const,
      private: true as const,
      dependencies: {},
    };
    const generatedSource = [
      '// Generated deterministically from the approved connector specification.',
      `export const connectorName = ${JSON.stringify(input.connectorName)};`,
      `export const requestedScopes = ${stableJson([...input.requestedScopes].sort())} as const;`,
      `export const toolSchemas = ${stableJson(toolSchemas)} as const;`,
    ].join('\n');
    const generatedTests = [
      '// Generated deterministic contract-test plan.',
      ...scan.toolNames.map((name) => `assertToolSchema(${JSON.stringify(name)}, toolSchemas);`),
    ].join('\n');
    const sourceHash = digest(
      stableJson({
        connectorName: input.connectorName,
        source: input.source,
        specification: input.specification,
        generatedSource,
        generatedTests,
        packageManifest,
      }),
    );
    const scopeDigest = digest(stableJson([...input.requestedScopes].sort()));
    return {
      schemaVersion: 1,
      connectorName: input.connectorName,
      scan,
      toolSchemas,
      generatedSource,
      generatedTests,
      packageManifest,
      sourceHash,
      scopeDigest,
    };
  }
}

const secretPattern =
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:password|secret|token|api[_-]?key)\s*[:=]\s*["'][^"']{8,}["'])/i;
const unsafeRuntimeConstruction = /\b(?:eval|Function)\s*\(/;
const sourceImportPattern =
  /\b(?:import|export)\s+(?:[^'";]+\s+from\s+)?['"]([^'"]+)['"]|\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]/g;

function unsafeDependencyReference(specification: JsonValue): boolean {
  if (typeof specification !== 'object' || specification === null || Array.isArray(specification)) {
    return false;
  }
  const dependencies = specification['dependencies'];
  if (typeof dependencies !== 'object' || dependencies === null || Array.isArray(dependencies)) {
    return false;
  }
  return Object.values(dependencies).some(
    (value) => typeof value === 'string' && /^(?:file:|https?:|git\+|git@)/i.test(value),
  );
}

function sourceHasUnsafeDependency(source: string): boolean {
  sourceImportPattern.lastIndex = 0;
  for (const match of source.matchAll(sourceImportPattern)) {
    const specifier = match[1] ?? match[2];
    if (
      specifier !== undefined &&
      !specifier.startsWith('./') &&
      !specifier.startsWith('../') &&
      !specifier.startsWith('node:')
    ) {
      return true;
    }
  }
  return false;
}

function digest(value: string): HashSha256 {
  return createHash('sha256').update(value).digest('hex') as HashSha256;
}

function stableJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key] ?? null)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export interface GovernanceConsultation {
  readonly consultationId: Id;
  readonly requesterAgentType: string;
  readonly action: string;
  readonly resources: string[];
  readonly justification: string;
  readonly response: 'approved' | 'denied' | 'conditional';
  readonly obligations: string[];
  readonly policyVersion: string;
  readonly evidence: ArtifactReference[];
}

export function assertGovernanceConsultationTier(tier: AgentTier): void {
  if (tier === 2)
    throw runtimeError(
      'INVOCATION_TIER_VIOLATION',
      'Tier 2 tasks cannot initiate Governance directly',
    );
}
