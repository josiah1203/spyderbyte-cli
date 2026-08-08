import type { JsonValue } from './json.js';
import type { Id, HashSha256 } from './ids.js';
import type { Actor, Money, Quantity, ResourceSelector, TenantRef } from './primitives.js';

export type SchemaVersion = number;

export type ActorType = 'human' | 'agent' | 'system';
export type AgentTier = 0 | 1 | 2;

export interface RuntimeCommand<TPayload extends JsonValue = JsonValue> {
  schemaVersion: SchemaVersion;
  commandId: Id;
  commandType: string;
  tenant: TenantRef;
  actor: Actor;
  issuedAt: string;
  idempotencyKey: string;
  correlationId: Id;
  causationId?: Id;
  payload: TPayload;
}

export type WorkflowState =
  | 'planning'
  | 'awaiting_approval'
  | 'executing'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ProjectState = 'active' | 'archived';

export interface Project {
  schemaVersion: SchemaVersion;
  projectId: Id;
  tenant: TenantRef;
  name: string;
  objective?: string;
  description?: string;
  state: ProjectState;
  createdAt: string;
  updatedAt: string;
}

/** Interfaces that can submit work to the single Spyderbyte agent session model. */
export type AgentInterface =
  | 'tui'
  | 'cli'
  | 'acp'
  | 'api'
  | 'jupyter'
  | 'web'
  | 'automation'
  | 'system';

export type AgentSessionMode = 'conversation' | 'planning' | 'approval' | 'execution' | 'review';

export type AgentSessionState =
  | 'active'
  | 'awaiting_approval'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AgentSessionContext {
  workspaceId: Id;
  projectId?: Id;
  organizationId?: Id;
  sourceInterface: AgentInterface;
  mode: AgentSessionMode;
  resources: ResourceSelector[];
  values?: Record<string, JsonValue>;
}

export interface AgentSession {
  schemaVersion: SchemaVersion;
  sessionId: Id;
  tenant: TenantRef;
  workspaceId: Id;
  projectId?: Id;
  organizationId?: Id;
  user: Actor;
  sourceInterface: AgentInterface;
  context: AgentSessionContext;
  mode: AgentSessionMode;
  state: AgentSessionState;
  requestIds: Id[];
  currentRunId?: Id;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRequest {
  schemaVersion: SchemaVersion;
  requestId: Id;
  sessionId: Id;
  tenant: TenantRef;
  workspaceId: Id;
  projectId?: Id;
  organizationId?: Id;
  actor: Actor;
  sourceInterface: AgentInterface;
  mode: AgentSessionMode;
  context: AgentSessionContext;
  text: string;
  clientMessageId?: Id;
  modelOverride?: { providerId: string; modelId: string };
  createdAt: string;
  correlationId: Id;
}

export type AgentEventKind =
  | 'context_inspected'
  | 'recommendation_created'
  | 'plan_created'
  | 'estimate_created'
  | 'policy_evaluated'
  | 'permission_requested'
  | 'run_created'
  | 'run_updated'
  | 'artifact_published'
  | 'explanation_created'
  | 'next_action_created'
  | 'message_delta'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AgentEvent<TPayload extends JsonValue = JsonValue> {
  schemaVersion: SchemaVersion;
  eventId: Id;
  sessionId: Id;
  requestId: Id;
  tenant: TenantRef;
  sequence: number;
  kind: AgentEventKind;
  payload: TPayload;
  occurredAt: string;
  correlationId: Id;
}

export type AgentPermissionKind = 'policy' | 'approval' | 'confirmation' | 'capability';
export type AgentPermissionState = 'pending' | 'approved' | 'rejected' | 'expired' | 'revoked';

export interface AgentPermissionRequest {
  schemaVersion: SchemaVersion;
  permissionRequestId: Id;
  sessionId: Id;
  requestId: Id;
  tenant: TenantRef;
  kind: AgentPermissionKind;
  action: string;
  reason: string;
  resources: ResourceSelector[];
  estimatedCost?: Money;
  state: AgentPermissionState;
  requestedAt: string;
  expiresAt?: string;
  decidedAt?: string;
  decidedBy?: Actor;
}

export interface AgentRecommendation {
  summary: string;
  actions: string[];
  rationale: string[];
  confidence: number;
}

export interface AgentEstimate {
  estimatedCost: Money;
  estimatedDurationMs: number;
  resourceClass: string;
}

export type AgentResponseState =
  | 'accepted'
  | 'awaiting_permission'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AgentResponse {
  schemaVersion: SchemaVersion;
  responseId: Id;
  sessionId: Id;
  requestId: Id;
  tenant: TenantRef;
  state: AgentResponseState;
  recommendation: AgentRecommendation;
  plan: ExecutionPlan;
  estimate: AgentEstimate;
  runId?: Id;
  permissionRequestId?: Id;
  artifacts: ArtifactReference[];
  explanation?: string;
  nextAction?: string;
  createdAt: string;
  completedAt?: string;
}

export type ProviderType =
  | 'openai'
  | 'anthropic'
  | 'openai-compatible'
  | 'spyderbyte-cloud'
  | 'customer-owned'
  | 'ollama'
  | 'llama.cpp'
  | 'mlx'
  | 'huggingface-local'
  | 'codex-cli'
  | 'claude-code-cli'
  | 'deterministic';

export type ProviderConfigurationState =
  | 'configured'
  | 'authenticated'
  | 'reachable'
  | 'callable'
  | 'degraded'
  | 'rate_limited'
  | 'misconfigured'
  | 'disabled';

export type ProviderCredentialStatus = 'active' | 'revoked' | 'disabled' | 'error';

export interface ProviderUsagePolicy {
  maxTokensPerRequest: number;
  maxRequestsPerMinute?: number;
  maxCostMinorPerRequest?: number;
}

export interface ProviderConfiguration {
  schemaVersion: SchemaVersion;
  providerConfigurationId: Id;
  tenant: TenantRef;
  providerId: string;
  providerType: ProviderType;
  displayName: string;
  endpoint: string;
  apiVersion?: string;
  credentialRef?: Id;
  defaultModelId?: string;
  capabilities: string[];
  supportedModalities: string[];
  modelDiscoveryMode: 'api' | 'configured' | 'local' | 'none';
  state: ProviderConfigurationState;
  authenticationState: 'authenticated' | 'required' | 'expired' | 'not_applicable';
  local: boolean;
  timeoutMs: number;
  retryMaxAttempts: number;
  usagePolicy: ProviderUsagePolicy;
  createdAt: string;
  updatedAt: string;
  lastTestedAt?: string;
  lastSuccessfulUseAt?: string;
  lastFailureAt?: string;
}

export interface ProviderCredential {
  schemaVersion: SchemaVersion;
  credentialId: Id;
  tenant: TenantRef;
  providerConfigurationId: Id;
  authMethod: 'api_key' | 'oauth' | 'cli' | 'none';
  status: ProviderCredentialStatus;
  createdAt: string;
  updatedAt: string;
  lastSuccessfulUseAt?: string;
  lastFailureAt?: string;
}

export interface ProviderModel {
  schemaVersion: SchemaVersion;
  providerModelId: Id;
  tenant: TenantRef;
  providerConfigurationId: Id;
  providerId: string;
  modelId: string;
  displayName: string;
  contextWindow?: number;
  inputModalities: string[];
  outputModalities: string[];
  capabilities: string[];
  dataClasses: string[];
  billingMode: 'subscription' | 'metered' | 'local' | 'unknown';
  local: boolean;
  state: 'ready' | 'unconfigured' | 'unavailable' | 'degraded';
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeProfile {
  schemaVersion: SchemaVersion;
  runtimeProfileId: Id;
  tenant: TenantRef;
  runtimeType: 'local-host' | 'local-docker' | 'remote-ssh' | 'managed-worker' | 'customer-cloud';
  displayName: string;
  state: 'configured' | 'ready' | 'degraded' | 'unavailable' | 'disabled';
  endpoint?: string;
  cpuMillicores?: number;
  memoryBytes?: number;
  gpuType?: string;
  gpuCount?: number;
  networkPolicy?: string;
  createdAt: string;
  updatedAt: string;
  lastPreflightAt?: string;
}

export interface EnvironmentRevision {
  schemaVersion: SchemaVersion;
  environmentId: Id;
  tenant: TenantRef;
  name: string;
  revision: number;
  runtimeProfileId: Id;
  lockfileHash?: HashSha256;
  state: 'draft' | 'ready' | 'degraded' | 'invalid';
  createdAt: string;
}

export interface ComputeRequirements {
  cpuMillicores?: number;
  memoryBytes?: number;
  gpuCount?: number;
  gpuType?: string;
  wallTimeMs?: number;
  storageBytes?: number;
}

export type NetworkPolicyMode = 'offline' | 'allowlist' | 'unrestricted';

export interface NetworkPolicy {
  mode: NetworkPolicyMode;
  allowlist: string[];
}

export interface SecretReference {
  secretId: Id;
  purpose: string;
}

export interface ExecutionLimits {
  wallTimeMs: number;
  outputBytes: number;
  storageBytes: number;
  processCount: number;
}

/** A redacted, provider-neutral replay descriptor for restart-safe retry. */
export interface ExecutionReplay {
  type: 'http';
  method: string;
  path: string;
  body?: JsonValue;
  headers?: Record<string, string>;
}

/** The durable, provider-neutral request envelope for every material action. */
export interface ExecutionRequest {
  schemaVersion: SchemaVersion;
  executionRequestId: Id;
  runId: Id;
  tenant: TenantRef;
  actor: Actor;
  projectId?: Id;
  sourceInterface: AgentInterface;
  action: string;
  inputReferences: ArtifactReference[];
  environment: EnvironmentRevision;
  runtime: RuntimeProfile;
  computeRequirements: ComputeRequirements;
  networkPolicy: NetworkPolicy;
  secrets: SecretReference[];
  limits: ExecutionLimits;
  estimatedCost?: Money;
  idempotencyKey?: string;
  replay?: ExecutionReplay;
  createdAt: string;
}

export type CapabilityStatus = 'ready' | 'metadata-only' | 'unavailable';

export interface CapabilityDescriptor {
  enabled: boolean;
  status?: CapabilityStatus;
  executor?: string;
  reason?: string;
  commands?: string[];
  projections?: string[];
  actions?: string[];
  unlockPath?: string;
}

export interface CapabilitiesProjection {
  schemaVersion?: SchemaVersion;
  runtimeMode?: 'managed-local-daemon' | 'hosted' | 'mock';
  workspaceMode?: 'personal_local' | 'organization_local' | 'organization_hosted';
  policyEnforcement?: 'local' | 'organization';
  projectionVersion?: number;
  generatedAt?: string;
  projections?: string[];
  commands?: string[];
  capabilities: Record<string, CapabilityDescriptor>;
}

export type NotebookCellType = 'markdown' | 'python' | 'sql';

export type NotebookCellState =
  | 'idle'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface NotebookCellRecord {
  schemaVersion: SchemaVersion;
  cellId: Id;
  cellType: NotebookCellType;
  sourceHash: HashSha256;
  state: NotebookCellState;
  executionCount?: number;
  inputReferences: ArtifactReference[];
  outputReferences: ArtifactReference[];
  error?: FailureRecord;
  createdAt: string;
  updatedAt: string;
}

export interface Notebook {
  schemaVersion: SchemaVersion;
  notebookId: Id;
  tenant: TenantRef;
  projectId?: Id;
  title: string;
  revision: number;
  runtimeProfileId?: Id;
  environmentRevisionId?: Id;
  state: 'draft' | 'active' | 'archived';
  cellIds: Id[];
  createdAt: string;
  updatedAt: string;
}

export interface JupyterSessionRequest {
  schemaVersion: SchemaVersion;
  sessionRequestId: Id;
  tenant: TenantRef;
  projectId?: Id;
  notebookId?: Id;
  runtimeProfileId?: Id;
  environmentRevisionId?: Id;
  computeProfile?: string;
  idleTimeoutMs?: number;
  requestedAt: string;
}

export interface JupyterSession {
  schemaVersion: SchemaVersion;
  sessionId: Id;
  tenant: TenantRef;
  projectId?: Id;
  notebookId?: Id;
  user: Actor;
  runtimeProfileId?: Id;
  environmentRevisionId?: Id;
  runtime?: string;
  endpoint?: string;
  kernelId?: string;
  state: 'requested' | 'starting' | 'ready' | 'idle' | 'stopping' | 'stopped' | 'failed';
  idleTimeoutMs: number;
  lastActivityAt: string;
  associatedRunIds: Id[];
  error?: FailureRecord;
  createdAt: string;
  updatedAt: string;
}

export type RunState =
  | 'draft'
  | 'validating'
  | 'awaiting_configuration'
  | 'awaiting_approval'
  | 'queued'
  | 'provisioning'
  | 'running'
  | 'finalizing'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'partially_succeeded';

export interface Run {
  schemaVersion: SchemaVersion;
  runId: Id;
  tenant: TenantRef;
  projectId?: Id;
  requestedAction: string;
  initiatingPrincipal: Actor;
  sourceInterface: AgentInterface;
  clientVersion?: string;
  providerConfigurationId?: Id;
  providerId?: string;
  modelId?: string;
  runtimeProfileId?: Id;
  environmentRevisionId?: Id;
  inputReferences: ArtifactReference[];
  executionRequest?: ExecutionRequest;
  executionPlan?: ExecutionPlan;
  state: RunState;
  attemptIds: Id[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: FailureRecord;
  cost?: Money;
}

export interface RunAttempt {
  schemaVersion: SchemaVersion;
  attemptId: Id;
  runId: Id;
  tenant: TenantRef;
  attemptNumber: number;
  executionRequestId?: Id;
  state: RunState;
  providerId?: string;
  modelId?: string;
  runtimeProfileId?: Id;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  outputReferences: ArtifactReference[];
  resourceUsage?: JsonValue;
  error?: FailureRecord;
}

export interface Workflow {
  schemaVersion: SchemaVersion;
  workflowId: Id;
  tenant: TenantRef;
  objective: string;
  state: WorkflowState;
  planVersion: number;
  createdAt: string;
  updatedAt: string;
  invocationIds: Id[];
  projectId?: Id;
  displayName?: string;
  trigger?: string;
  budgetId?: Id;
  constraints?: Record<string, JsonValue>;
  completionCriteria: string[];
}

export interface PlanStep {
  stepId: Id;
  tier: AgentTier;
  agentType: string;
  /** Agent-facing summary fields are optional for backwards-compatible plans. */
  title?: string;
  description?: string;
  dependsOn: Id[];
  inputArtifactIds: Id[];
  requiredCapabilities: string[];
  approvalRequired: boolean;
  expectedOutputs?: string[];
  acceptanceCriteria: string[];
}

export interface ExecutionPlan {
  schemaVersion: SchemaVersion;
  planId: Id;
  workflowId: Id;
  version: number;
  executionRequestId?: Id;
  steps: PlanStep[];
  createdAt: string;
  createdByInvocationId?: Id;
  digest: HashSha256;
}

export interface BudgetEnvelope {
  budgetId: Id;
  limit: number;
  reserved: number;
  consumed: number;
  currency: string;
}

export interface AuthorityEnvelope {
  schemaVersion: SchemaVersion;
  envelopeId: Id;
  tenant: TenantRef;
  issuer: Actor;
  subjectAgentId: Id;
  workflowId: Id;
  invocationId: Id;
  tier: AgentTier;
  harnessVersion: string;
  permittedActions: string[];
  capabilities: string[];
  resourceScopes: ResourceSelector[];
  allowedArtifactReads: ResourceSelector[];
  allowedArtifactWrites: ResourceSelector[];
  allowedChildAgentTypes: string[];
  maxChildCount: number;
  toolOperations: string[];
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  policyVersion: string;
  revocationEpoch: number;
  integrityProof: HashSha256;
  signature?: string;
}

export interface ResourceLimits {
  cpuMillicores: number;
  memoryBytes: number;
  wallTimeMs: number;
  outputBytes: number;
  storageBytes: number;
  processCount: number;
}

export interface ResourceEnvelope {
  limits: ResourceLimits;
  networkAllowlist: string[];
  readOnlyArtifactMounts: boolean;
}

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs: number;
  maxBackoffMs: number;
  retryableErrorCodes: string[];
}

export type InvocationState =
  | 'created'
  | 'preparing'
  | 'running'
  | 'awaiting_approval'
  | 'validating_report'
  | 'succeeded'
  | 'partially_succeeded'
  | 'blocked'
  | 'failed'
  | 'cancelled';

export interface AgentInvocation<TInput extends JsonValue = JsonValue> {
  schemaVersion: SchemaVersion;
  invocationId: Id;
  workflowId: Id;
  parentInvocationId?: Id;
  tenant: TenantRef;
  tier: AgentTier;
  agentType: string;
  harnessVersion: string;
  input: TInput;
  authority: AuthorityEnvelope;
  resource: ResourceEnvelope;
  retry: RetryPolicy;
  budget: BudgetEnvelope;
  state: InvocationState;
  attempt: number;
  createdAt: string;
  correlationId: Id;
}

export interface ArtifactReference {
  schemaVersion: SchemaVersion;
  tenant: TenantRef;
  artifactId: Id;
  version: number;
  contentHash: HashSha256;
  mediaType: string;
  sizeBytes: number;
  createdAt: string;
  uri?: string;
}

export interface DecisionRecord {
  decisionId: Id;
  kind: string;
  summary: string;
  decidedBy: Actor;
  decidedAt: string;
  evidence?: ArtifactReference[];
}

export interface MetricObservation {
  metricId: Id;
  name: string;
  value: number;
  unit: string;
  observedAt: string;
  labels?: Record<string, string>;
}

export interface CostObservation {
  observationId: Id;
  amount: Money;
  source: string;
  observedAt: string;
  externalRequestId?: string;
}

export interface FailureRecord {
  failureId: Id;
  code: string;
  message: string;
  retryable: boolean;
  occurredAt: string;
  evidence?: ArtifactReference[];
}

export type AgentReportStatus = 'success' | 'partial' | 'blocked' | 'failure';

export interface AgentReport<TOutput extends JsonValue = JsonValue> {
  schemaVersion: SchemaVersion;
  reportId: Id;
  invocationId: Id;
  agentType: string;
  tier: AgentTier;
  harnessVersion: string;
  status: AgentReportStatus;
  output: TOutput;
  decisions: DecisionRecord[];
  artifacts: ArtifactReference[];
  metrics: MetricObservation[];
  costs: CostObservation[];
  failures: FailureRecord[];
  childInvocationIds: Id[];
  stateAssertions: StateAssertion[];
  producedAt: string;
}

export type ArtifactState = 'draft' | 'valid' | 'blocked' | 'stale' | 'superseded' | 'archived';

export interface Artifact<TContent extends JsonValue = JsonValue> {
  schemaVersion: SchemaVersion;
  reference: ArtifactReference;
  state: ArtifactState;
  createdBy: Actor;
  lineage: ArtifactReference[];
  content: TContent;
}

export interface RuntimeEvent<TPayload extends JsonValue = JsonValue> {
  schemaVersion: SchemaVersion;
  eventId: Id;
  eventName: string;
  tenant: TenantRef;
  aggregateType: string;
  aggregateId: Id;
  aggregateVersion: number;
  occurredAt: string;
  actor: Actor;
  correlationId: Id;
  causationId?: Id;
  payload: TPayload;
}

export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'expired' | 'revoked';

export interface ApprovalRequest {
  schemaVersion: SchemaVersion;
  approvalId: Id;
  tenant: TenantRef;
  workflowId?: Id;
  invocationId?: Id;
  actionDigest: HashSha256;
  actionType: string;
  requestedBy: Actor;
  resources: ResourceSelector[];
  estimatedCost: Money;
  policyVersion: string;
  revocationEpoch: number;
  state: ApprovalState;
  requestedAt: string;
  expiresAt: string;
  decidedBy?: Actor;
  decidedAt?: string;
  decisionReason?: string;
}

export type BudgetReservationState =
  | 'requested'
  | 'reserved'
  | 'partially_consumed'
  | 'reconciled'
  | 'released'
  | 'rejected';

export type BudgetCategory = 'llm' | 'compute' | 'storage' | 'external_api' | 'retry';

export interface BudgetReservation {
  reservationId: Id;
  budgetId: Id;
  amount: Money;
  category: BudgetCategory;
  state: BudgetReservationState;
  createdAt: string;
  reconciledAt?: string;
}

export interface UsageObservation {
  usageId: Id;
  invocationId: Id;
  quantity: Quantity;
  budgetId?: Id;
  reservationId?: Id;
  category?: BudgetCategory;
  observedAt: string;
  cost?: Money;
}

export type AgentRegistrationStatus = 'draft' | 'active' | 'deprecated' | 'disabled';

export interface AgentRegistration {
  schemaVersion: SchemaVersion;
  agentId: Id;
  agentType: string;
  version: string;
  tier: AgentTier;
  supportedContracts: string[];
  capabilities: string[];
  status: AgentRegistrationStatus;
}

export interface ToolGrant {
  schemaVersion: SchemaVersion;
  grantId: Id;
  tenant: TenantRef;
  invocationId: Id;
  toolName: string;
  operation: string;
  issuedAt: string;
  expiresAt: string;
  authorityEnvelopeId: Id;
  resourceScopes: ResourceSelector[];
  maxUses?: number;
}

export interface Escalation {
  escalationId: Id;
  reason: string;
  requestedAt: string;
  requestedBy: Actor;
  requiredTier?: AgentTier;
}

export interface StateAssertion {
  assertionId: Id;
  subjectType: string;
  subjectId: Id;
  state: string;
  assertedAt: string;
  evidence?: ArtifactReference[];
}

export type DeploymentState =
  | 'requested'
  | 'provisioning'
  | 'smoke_testing'
  | 'canary'
  | 'ramping'
  | 'active'
  | 'rolled_back'
  | 'failed';
