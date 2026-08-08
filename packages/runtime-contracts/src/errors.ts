import type { AgentTier } from './contracts.js';

export type ErrorCategory =
  | 'validation'
  | 'concurrency'
  | 'authority'
  | 'policy'
  | 'approval'
  | 'budget'
  | 'artifact'
  | 'invocation_hierarchy'
  | 'harness_output'
  | 'external_dependency'
  | 'compute_resource'
  | 'secret_handling'
  | 'confirmation'
  | 'capability'
  | 'retry_exhaustion';

export type RuntimeErrorCode =
  | 'VALIDATION_INVALID_INPUT'
  | 'VALIDATION_SCHEMA_MISMATCH'
  | 'CONCURRENCY_STALE_VERSION'
  | 'AUTHORITY_MISSING'
  | 'AUTHORITY_EXPIRED'
  | 'AUTHORITY_SCOPE_VIOLATION'
  | 'POLICY_DENIED'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_INVALIDATED'
  | 'LOCAL_CONFIRMATION_REQUIRED'
  | 'CAPABILITY_UNAVAILABLE'
  | 'BUDGET_EXCEEDED'
  | 'ARTIFACT_IMMUTABLE'
  | 'ARTIFACT_NOT_FOUND'
  | 'INVOCATION_INVALID_PARENT'
  | 'INVOCATION_TIER_VIOLATION'
  | 'HARNESS_OUTPUT_INVALID'
  | 'EXTERNAL_DEPENDENCY_UNAVAILABLE'
  | 'COMPUTE_RESOURCE_UNAVAILABLE'
  | 'SECRET_EXPOSURE_BLOCKED'
  | 'RETRY_EXHAUSTED';

export interface RuntimeErrorDefinition {
  category: ErrorCategory;
  retryable: boolean;
  owningTier: AgentTier | 'control-plane';
  userMessage: string;
  internalDiagnostic: string;
  evidenceRequired: boolean;
}

const definitions: Record<RuntimeErrorCode, RuntimeErrorDefinition> = {
  VALIDATION_INVALID_INPUT: {
    category: 'validation',
    retryable: false,
    owningTier: 'control-plane',
    userMessage: 'The request is invalid.',
    internalDiagnostic: 'Input failed domain validation.',
    evidenceRequired: false,
  },
  VALIDATION_SCHEMA_MISMATCH: {
    category: 'validation',
    retryable: false,
    owningTier: 'control-plane',
    userMessage: 'The payload does not match the required contract.',
    internalDiagnostic: 'Runtime schema validation failed.',
    evidenceRequired: true,
  },
  CONCURRENCY_STALE_VERSION: {
    category: 'concurrency',
    retryable: true,
    owningTier: 'control-plane',
    userMessage: 'The resource changed; refresh and retry.',
    internalDiagnostic: 'Optimistic concurrency version was stale.',
    evidenceRequired: true,
  },
  AUTHORITY_MISSING: {
    category: 'authority',
    retryable: false,
    owningTier: 'control-plane',
    userMessage: 'This operation is not authorized.',
    internalDiagnostic: 'No valid authority envelope was provided.',
    evidenceRequired: true,
  },
  AUTHORITY_EXPIRED: {
    category: 'authority',
    retryable: false,
    owningTier: 'control-plane',
    userMessage: 'The operation authorization has expired.',
    internalDiagnostic: 'Authority envelope expired before use.',
    evidenceRequired: true,
  },
  AUTHORITY_SCOPE_VIOLATION: {
    category: 'authority',
    retryable: false,
    owningTier: 'control-plane',
    userMessage: 'This operation is outside the active workspace scope.',
    internalDiagnostic: 'Tenant, workspace, authority, or resource scope validation failed.',
    evidenceRequired: true,
  },
  POLICY_DENIED: {
    category: 'policy',
    retryable: false,
    owningTier: 'control-plane',
    userMessage: 'Policy does not allow this operation.',
    internalDiagnostic: 'Policy decision denied the operation.',
    evidenceRequired: true,
  },
  APPROVAL_REQUIRED: {
    category: 'approval',
    retryable: false,
    owningTier: 'control-plane',
    userMessage: 'Human approval is required before this operation can proceed.',
    internalDiagnostic: 'No valid approval was bound to the action digest.',
    evidenceRequired: true,
  },
  APPROVAL_INVALIDATED: {
    category: 'approval',
    retryable: false,
    owningTier: 'control-plane',
    userMessage: 'The approval no longer matches the requested operation.',
    internalDiagnostic: 'Approval digest or bound resources changed.',
    evidenceRequired: true,
  },
  LOCAL_CONFIRMATION_REQUIRED: {
    category: 'confirmation',
    retryable: false,
    owningTier: 'control-plane',
    userMessage: 'Confirm this action on this device before continuing.',
    internalDiagnostic: 'A local safety confirmation was required for this action.',
    evidenceRequired: true,
  },
  CAPABILITY_UNAVAILABLE: {
    category: 'capability',
    retryable: true,
    owningTier: 'control-plane',
    userMessage: 'This capability is unavailable or disabled in the active workspace.',
    internalDiagnostic: 'The requested local capability is unavailable.',
    evidenceRequired: true,
  },
  BUDGET_EXCEEDED: {
    category: 'budget',
    retryable: false,
    owningTier: 0,
    userMessage: 'The operation exceeds the available budget.',
    internalDiagnostic: 'Budget reservation or reconciliation exceeded its limit.',
    evidenceRequired: true,
  },
  ARTIFACT_IMMUTABLE: {
    category: 'artifact',
    retryable: false,
    owningTier: 'control-plane',
    userMessage: 'Published artifacts cannot be edited in place.',
    internalDiagnostic: 'An immutable artifact version was targeted for mutation.',
    evidenceRequired: true,
  },
  ARTIFACT_NOT_FOUND: {
    category: 'artifact',
    retryable: false,
    owningTier: 'control-plane',
    userMessage: 'The requested artifact was not found.',
    internalDiagnostic: 'Artifact lookup failed within tenant scope.',
    evidenceRequired: true,
  },
  INVOCATION_INVALID_PARENT: {
    category: 'invocation_hierarchy',
    retryable: false,
    owningTier: 0,
    userMessage: 'The agent hierarchy does not permit this invocation.',
    internalDiagnostic: 'Parent and child invocation relationship is invalid.',
    evidenceRequired: true,
  },
  INVOCATION_TIER_VIOLATION: {
    category: 'invocation_hierarchy',
    retryable: false,
    owningTier: 0,
    userMessage: 'This agent tier cannot perform the requested invocation.',
    internalDiagnostic: 'Tier authority boundary was violated.',
    evidenceRequired: true,
  },
  HARNESS_OUTPUT_INVALID: {
    category: 'harness_output',
    retryable: false,
    owningTier: 1,
    userMessage: 'The agent result could not be accepted.',
    internalDiagnostic: 'Agent output failed schema or acceptance validation.',
    evidenceRequired: true,
  },
  EXTERNAL_DEPENDENCY_UNAVAILABLE: {
    category: 'external_dependency',
    retryable: true,
    owningTier: 'control-plane',
    userMessage: 'A required external service is temporarily unavailable.',
    internalDiagnostic: 'Adapter dependency returned an availability failure.',
    evidenceRequired: true,
  },
  COMPUTE_RESOURCE_UNAVAILABLE: {
    category: 'compute_resource',
    retryable: true,
    owningTier: 1,
    userMessage: 'The requested compute resource is unavailable.',
    internalDiagnostic: 'Compute backend could not satisfy the resource envelope.',
    evidenceRequired: true,
  },
  SECRET_EXPOSURE_BLOCKED: {
    category: 'secret_handling',
    retryable: false,
    owningTier: 'control-plane',
    userMessage: 'The operation was blocked because sensitive data handling was unsafe.',
    internalDiagnostic: 'Secret detection or redaction policy blocked the operation.',
    evidenceRequired: true,
  },
  RETRY_EXHAUSTED: {
    category: 'retry_exhaustion',
    retryable: false,
    owningTier: 'control-plane',
    userMessage: 'The operation failed after the permitted retries.',
    internalDiagnostic: 'Retry envelope was exhausted.',
    evidenceRequired: true,
  },
};

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly owningTier: AgentTier | 'control-plane';
  readonly userMessage: string;
  readonly internalDiagnostic: string;
  readonly evidence: readonly string[];

  constructor(code: RuntimeErrorCode, details?: string, evidence: string[] = []) {
    const definition = definitions[code];
    super(details ? `${definition.internalDiagnostic} ${details}` : definition.internalDiagnostic);
    this.name = 'RuntimeError';
    this.code = code;
    this.category = definition.category;
    this.retryable = definition.retryable;
    this.owningTier = definition.owningTier;
    this.userMessage = definition.userMessage;
    this.internalDiagnostic = definition.internalDiagnostic;
    this.evidence = evidence;
  }
}

export function getErrorDefinition(code: RuntimeErrorCode): RuntimeErrorDefinition {
  return definitions[code];
}

export function runtimeError(
  code: RuntimeErrorCode,
  details?: string,
  evidence?: string[],
): RuntimeError {
  return new RuntimeError(code, details, evidence);
}
