import {
  isJsonValue,
  isContract,
  runtimeError,
  type AgentInvocation,
  type AgentReport,
  type ArtifactReference,
  type CostObservation,
  type Id,
  type MetricObservation,
  type StateAssertion,
} from '@agentic-platform/runtime-contracts';
import type { Harness } from './definition.js';

export interface ArtifactVerification {
  readonly exists: boolean;
  readonly createdByInvocationId: Id;
  readonly lineageVerified: boolean;
  readonly hashVerified: boolean;
}

export interface ObservationVerification {
  readonly verified: true;
  readonly source: string;
}

export function parseStructuredReport(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      throw runtimeError('HARNESS_OUTPUT_INVALID', 'Report was not valid JSON');
    }
  }
  if (!isJsonValue(value)) {
    throw runtimeError('HARNESS_OUTPUT_INVALID', 'Report was not JSON serializable');
  }
  return value;
}

export interface ReportValidationOptions<
  TInput extends import('@agentic-platform/runtime-contracts').JsonValue,
  TOutput extends import('@agentic-platform/runtime-contracts').JsonValue,
> {
  harness: Harness<TInput, TOutput>;
  invocation: AgentInvocation<TInput>;
  artifactVerifier?: (
    reference: ArtifactReference,
    invocation: AgentInvocation<TInput>,
  ) => ArtifactVerification | Promise<ArtifactVerification>;
  costVerifier?: (
    cost: CostObservation,
    invocation: AgentInvocation<TInput>,
  ) => ObservationVerification | Promise<ObservationVerification>;
  metricVerifier?: (
    metric: MetricObservation,
    invocation: AgentInvocation<TInput>,
  ) => ObservationVerification | Promise<ObservationVerification>;
  childInvocationVerifier?: (
    childInvocationId: Id,
    invocation: AgentInvocation<TInput>,
  ) => ObservationVerification | Promise<ObservationVerification>;
  stateAssertionVerifier?: (
    assertion: StateAssertion,
    invocation: AgentInvocation<TInput>,
  ) => ObservationVerification | Promise<ObservationVerification>;
}

export class ReportValidator<
  TInput extends import('@agentic-platform/runtime-contracts').JsonValue,
  TOutput extends import('@agentic-platform/runtime-contracts').JsonValue,
> {
  async validate(
    reportValue: unknown,
    options: ReportValidationOptions<TInput, TOutput>,
  ): Promise<AgentReport<TOutput>> {
    const { harness, invocation } = options;
    const report = parseStructuredReport(reportValue);
    if (!isContract('AgentReport', report)) {
      throw runtimeError('HARNESS_OUTPUT_INVALID', 'Report did not satisfy AgentReport.v1');
    }
    if (
      report.invocationId !== invocation.invocationId ||
      report.agentType !== harness.definition.identity.agentType ||
      report.tier !== harness.definition.tier ||
      report.harnessVersion !== harness.definition.identity.version
    ) {
      throw runtimeError(
        'HARNESS_OUTPUT_INVALID',
        'Report identity does not match the invocation harness',
      );
    }
    const output = harness.validateOutput(report.output);
    if (report.status === 'success' && report.failures.length > 0) {
      throw runtimeError('HARNESS_OUTPUT_INVALID', 'A successful report cannot contain failures');
    }
    if (
      (report.status === 'blocked' || report.status === 'failure') &&
      report.failures.length === 0
    ) {
      throw runtimeError(
        'HARNESS_OUTPUT_INVALID',
        'Blocked or failed reports require failure detail',
      );
    }
    const evidenceReferences = [
      ...report.artifacts,
      ...report.decisions.flatMap((decision) => decision.evidence ?? []),
      ...report.failures.flatMap((failure) => failure.evidence ?? []),
    ];
    if (evidenceReferences.length > 0) {
      const artifactVerifier = options.artifactVerifier;
      if (artifactVerifier === undefined) {
        throw runtimeError(
          'HARNESS_OUTPUT_INVALID',
          'Artifact and evidence references require authoritative verification',
        );
      }
      for (const reference of evidenceReferences) {
        if (
          reference.tenant.tenantId !== invocation.tenant.tenantId ||
          reference.tenant.workspaceId !== invocation.tenant.workspaceId
        ) {
          throw runtimeError('POLICY_DENIED', 'Report contains a cross-tenant artifact reference');
        }
        const verification = await artifactVerifier(reference, invocation);
        if (
          !verification.exists ||
          verification.createdByInvocationId !== invocation.invocationId ||
          !verification.lineageVerified ||
          !verification.hashVerified
        ) {
          throw runtimeError(
            'HARNESS_OUTPUT_INVALID',
            `Artifact ${reference.artifactId}@${reference.version} failed authoritative verification`,
          );
        }
      }
    }
    for (const cost of report.costs) {
      if (options.costVerifier === undefined) {
        throw runtimeError('HARNESS_OUTPUT_INVALID', 'Cost observations require reconciliation');
      }
      const verification = await options.costVerifier(cost, invocation);
      if (!verification.verified || verification.source.length === 0) {
        throw runtimeError('HARNESS_OUTPUT_INVALID', 'Cost observation was not reconciled');
      }
    }
    for (const metric of report.metrics) {
      if (options.metricVerifier === undefined) {
        throw runtimeError('HARNESS_OUTPUT_INVALID', 'Metric observations require reconciliation');
      }
      const verification = await options.metricVerifier(metric, invocation);
      if (!verification.verified || verification.source.length === 0) {
        throw runtimeError('HARNESS_OUTPUT_INVALID', 'Metric observation was not reconciled');
      }
    }
    for (const childInvocationId of report.childInvocationIds) {
      if (options.childInvocationVerifier === undefined) {
        throw runtimeError(
          'HARNESS_OUTPUT_INVALID',
          'Child invocation references require authoritative verification',
        );
      }
      const verification = await options.childInvocationVerifier(childInvocationId, invocation);
      if (!verification.verified || verification.source.length === 0) {
        throw runtimeError('HARNESS_OUTPUT_INVALID', 'Child invocation was not verified');
      }
    }
    for (const assertion of report.stateAssertions) {
      if (options.stateAssertionVerifier === undefined) {
        throw runtimeError(
          'HARNESS_OUTPUT_INVALID',
          'State assertions require authoritative verification',
        );
      }
      const verification = await options.stateAssertionVerifier(assertion, invocation);
      if (!verification.verified || verification.source.length === 0) {
        throw runtimeError('HARNESS_OUTPUT_INVALID', 'State assertion was not verified');
      }
    }
    await harness.definition.acceptancePolicy.validate(output, invocation);
    return { ...report, output };
  }
}
