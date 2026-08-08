import type { ErrorObject, ValidateFunction } from 'ajv';
import AjvModule from 'ajv';
import addFormatsModule from 'ajv-formats';
import schemaBundle from '../schemas/runtime-contracts.v1.json' with { type: 'json' };
import type {
  AgentInvocation,
  AgentEvent,
  AgentEstimate,
  AgentPermissionRequest,
  AgentRecommendation,
  AgentRequest,
  AgentRegistration,
  AgentReport,
  AgentResponse,
  AgentSession,
  AgentSessionContext,
  ApprovalRequest,
  Artifact,
  ArtifactReference,
  AuthorityEnvelope,
  BudgetEnvelope,
  BudgetReservation,
  CapabilitiesProjection,
  CapabilityDescriptor,
  ComputeRequirements,
  CostObservation,
  DecisionRecord,
  Escalation,
  ExecutionLimits,
  ExecutionReplay,
  ExecutionRequest,
  ExecutionPlan,
  FailureRecord,
  JupyterSession,
  JupyterSessionRequest,
  MetricObservation,
  NetworkPolicy,
  Notebook,
  NotebookCellRecord,
  Project,
  ProviderConfiguration,
  ProviderCredential,
  ProviderModel,
  ProviderUsagePolicy,
  RuntimeProfile,
  EnvironmentRevision,
  Run,
  RunAttempt,
  ResourceEnvelope,
  RetryPolicy,
  RuntimeCommand,
  RuntimeEvent,
  StateAssertion,
  SecretReference,
  ToolGrant,
  UsageObservation,
  Workflow,
} from './contracts.js';
import type { HashSha256, Id } from './ids.js';
import type { Actor, Money, Quantity, ResourceSelector, TenantRef } from './primitives.js';

const Ajv =
  (AjvModule as unknown as { default?: typeof import('ajv').default }).default ??
  (AjvModule as unknown as typeof import('ajv').default);
const addFormats =
  (addFormatsModule as unknown as { default?: typeof import('ajv-formats').default }).default ??
  (addFormatsModule as unknown as typeof import('ajv-formats').default);

export type ContractName =
  | 'Id'
  | 'HashSha256'
  | 'SchemaVersion'
  | 'UtcInstant'
  | 'TenantRef'
  | 'Actor'
  | 'Money'
  | 'Quantity'
  | 'ResourceSelector'
  | 'RuntimeCommand'
  | 'Workflow'
  | 'Project'
  | 'AgentSessionContext'
  | 'AgentSession'
  | 'AgentRequest'
  | 'AgentEvent'
  | 'AgentPermissionRequest'
  | 'AgentRecommendation'
  | 'AgentEstimate'
  | 'AgentResponse'
  | 'CapabilityDescriptor'
  | 'CapabilitiesProjection'
  | 'ComputeRequirements'
  | 'NetworkPolicy'
  | 'SecretReference'
  | 'ExecutionLimits'
  | 'ExecutionReplay'
  | 'ExecutionRequest'
  | 'NotebookCellRecord'
  | 'Notebook'
  | 'JupyterSessionRequest'
  | 'JupyterSession'
  | 'ProviderConfiguration'
  | 'ProviderCredential'
  | 'ProviderModel'
  | 'ProviderUsagePolicy'
  | 'RuntimeProfile'
  | 'EnvironmentRevision'
  | 'Run'
  | 'RunAttempt'
  | 'ExecutionPlan'
  | 'AgentInvocation'
  | 'AgentReport'
  | 'Artifact'
  | 'ArtifactReference'
  | 'RuntimeEvent'
  | 'ApprovalRequest'
  | 'BudgetEnvelope'
  | 'BudgetReservation'
  | 'UsageObservation'
  | 'AuthorityEnvelope'
  | 'ResourceEnvelope'
  | 'RetryPolicy'
  | 'FailureRecord'
  | 'AgentRegistration'
  | 'ToolGrant'
  | 'DecisionRecord'
  | 'Escalation'
  | 'StateAssertion'
  | 'MetricObservation'
  | 'CostObservation';

export type ContractByName = {
  Id: Id;
  HashSha256: HashSha256;
  SchemaVersion: number;
  UtcInstant: string;
  TenantRef: TenantRef;
  Actor: Actor;
  Money: Money;
  Quantity: Quantity;
  ResourceSelector: ResourceSelector;
  RuntimeCommand: RuntimeCommand;
  Workflow: Workflow;
  Project: Project;
  AgentSessionContext: AgentSessionContext;
  AgentSession: AgentSession;
  AgentRequest: AgentRequest;
  AgentEvent: AgentEvent;
  AgentPermissionRequest: AgentPermissionRequest;
  AgentRecommendation: AgentRecommendation;
  AgentEstimate: AgentEstimate;
  AgentResponse: AgentResponse;
  CapabilityDescriptor: CapabilityDescriptor;
  CapabilitiesProjection: CapabilitiesProjection;
  ComputeRequirements: ComputeRequirements;
  NetworkPolicy: NetworkPolicy;
  SecretReference: SecretReference;
  ExecutionLimits: ExecutionLimits;
  ExecutionReplay: ExecutionReplay;
  ExecutionRequest: ExecutionRequest;
  NotebookCellRecord: NotebookCellRecord;
  Notebook: Notebook;
  JupyterSessionRequest: JupyterSessionRequest;
  JupyterSession: JupyterSession;
  ProviderConfiguration: ProviderConfiguration;
  ProviderCredential: ProviderCredential;
  ProviderModel: ProviderModel;
  ProviderUsagePolicy: ProviderUsagePolicy;
  RuntimeProfile: RuntimeProfile;
  EnvironmentRevision: EnvironmentRevision;
  Run: Run;
  RunAttempt: RunAttempt;
  ExecutionPlan: ExecutionPlan;
  AgentInvocation: AgentInvocation;
  AgentReport: AgentReport;
  Artifact: Artifact;
  ArtifactReference: ArtifactReference;
  RuntimeEvent: RuntimeEvent;
  ApprovalRequest: ApprovalRequest;
  BudgetEnvelope: BudgetEnvelope;
  BudgetReservation: BudgetReservation;
  UsageObservation: UsageObservation;
  AuthorityEnvelope: AuthorityEnvelope;
  ResourceEnvelope: ResourceEnvelope;
  RetryPolicy: RetryPolicy;
  FailureRecord: FailureRecord;
  AgentRegistration: AgentRegistration;
  ToolGrant: ToolGrant;
  DecisionRecord: DecisionRecord;
  Escalation: Escalation;
  StateAssertion: StateAssertion;
  MetricObservation: MetricObservation;
  CostObservation: CostObservation;
};

export interface ValidationResult<T> {
  valid: boolean;
  value: T | undefined;
  errors: ErrorObject[];
}

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addSchema(schemaBundle);

function compile<T>(name: ContractName): ValidateFunction<T> {
  return ajv.compile<T>({ $ref: `${schemaBundle.$id}#/$defs/${name}` });
}

const contractNames: ContractName[] = [
  'Id',
  'HashSha256',
  'SchemaVersion',
  'UtcInstant',
  'TenantRef',
  'Actor',
  'Money',
  'Quantity',
  'ResourceSelector',
  'RuntimeCommand',
  'Workflow',
  'Project',
  'AgentSessionContext',
  'AgentSession',
  'AgentRequest',
  'AgentEvent',
  'AgentPermissionRequest',
  'AgentRecommendation',
  'AgentEstimate',
  'AgentResponse',
  'CapabilityDescriptor',
  'CapabilitiesProjection',
  'ComputeRequirements',
  'NetworkPolicy',
  'SecretReference',
  'ExecutionLimits',
  'ExecutionReplay',
  'ExecutionRequest',
  'NotebookCellRecord',
  'Notebook',
  'JupyterSessionRequest',
  'JupyterSession',
  'ProviderConfiguration',
  'ProviderCredential',
  'ProviderModel',
  'ProviderUsagePolicy',
  'RuntimeProfile',
  'EnvironmentRevision',
  'Run',
  'RunAttempt',
  'ExecutionPlan',
  'AgentInvocation',
  'AgentReport',
  'Artifact',
  'ArtifactReference',
  'RuntimeEvent',
  'ApprovalRequest',
  'BudgetEnvelope',
  'BudgetReservation',
  'UsageObservation',
  'AuthorityEnvelope',
  'ResourceEnvelope',
  'RetryPolicy',
  'FailureRecord',
  'AgentRegistration',
  'ToolGrant',
  'DecisionRecord',
  'Escalation',
  'StateAssertion',
  'MetricObservation',
  'CostObservation',
];

const validators = Object.fromEntries(contractNames.map((name) => [name, compile(name)])) as Record<
  ContractName,
  ValidateFunction<unknown>
>;

export const schemas = schemaBundle.$defs;

export function validateContract<Name extends ContractName>(
  name: Name,
  value: unknown,
): ValidationResult<ContractByName[Name]> {
  const validator = validators[name];
  const valid = validator(value);
  return {
    valid,
    value: valid ? (value as ContractByName[Name]) : undefined,
    errors: valid ? [] : [...(validator.errors ?? [])],
  };
}

export function isContract<Name extends ContractName>(
  name: Name,
  value: unknown,
): value is ContractByName[Name] {
  return validators[name](value);
}

export function parseContract<Name extends ContractName>(
  name: Name,
  value: unknown,
): ContractByName[Name] {
  const result = validateContract(name, value);
  if (!result.valid) {
    const details = result.errors
      .map((error) => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`)
      .join('; ');
    throw new TypeError(`${name} validation failed: ${details}`);
  }
  return result.value as ContractByName[Name];
}

export function serializeContract<Name extends ContractName>(
  name: Name,
  value: ContractByName[Name],
): string {
  return JSON.stringify(parseContract(name, JSON.parse(JSON.stringify(value))));
}
