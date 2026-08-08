import {
  newSortableId,
  makeMoney,
  runtimeError,
  type AgentInvocation,
  type AgentRegistration,
  type ArtifactReference,
  type Actor,
  type ApprovalRequest,
  type ExecutionPlan,
  type HashSha256,
  type Id,
  type JsonValue,
  type RuntimeCommand,
  type RuntimeEvent,
  type TenantRef,
  type Workflow,
} from '@agentic-platform/runtime-contracts';
import {
  ContentAddressedArtifactRegistry,
  type ArtifactVersionRecord,
} from '@agentic-platform/artifact-registry';
import { InMemoryAgentRegistry } from '@agentic-platform/agent-registry';
import { InvocationService, type InvocationCreateRequest } from '@agentic-platform/harness-core';
import { ApprovalService, AuthorityService, sha256Digest } from '@agentic-platform/policy';
import { CommandDispatcher, type CommandHandlerResult } from '@agentic-platform/runtime-domain';
import type { StateStore, StateTransaction, VersionedAggregate } from '@agentic-platform/state';
import { artifactIdForTask, profileDataset, type DatasetScalarType } from '@agentic-platform/tasks';
import {
  ConnectorSpecialist,
  DataEngineerSpecialist,
  GovernanceSpecialist,
  type ConnectorBuildResult,
} from '@agentic-platform/specialists';
import {
  ConnectorPublicationWorkflow,
  connectorPublicationDigest,
  InMemoryDeploymentController,
  InMemoryExperimentBackend,
  InMemoryModelRegistry,
  LocalTrainingSmokeWorkflow,
  type ConnectorPackage,
  type ConnectorPublicationMaterial,
  type DeploymentRecord,
  type ExperimentBackend,
  type ModelVersion,
  type RunHandle,
  type TrafficGrant,
  type TrainingWorkflowResult,
} from '@agentic-platform/backends';
import {
  ClusterSpecialist,
  EvalSpecialist,
  MlEngineerSpecialist,
  type EvaluationResult,
} from '@agentic-platform/specialists';

export interface ValidateDatasetPayload {
  sourceArtifactId: string;
  sourceArtifactVersion: number;
  intendedUse: string;
  requestedAccessScopes: string[];
  retentionDays: number;
  requiredColumns?: string[];
  expectedTypes?: Record<string, DatasetScalarType>;
  labelColumn?: string;
  leakageThreshold?: number;
  splitSeed?: string;
  projectId?: Id;
  displayName?: string;
  trigger?: string;
}

interface LocalPlanRecord {
  plan: ExecutionPlan;
  sourceArtifact: ArtifactReference;
  approvalId?: Id;
  payload: ValidateDatasetPayload;
  outputArtifactIds: {
    governanceDecision: Id;
    qualityReport: Id;
    validatedDataset: Id;
  };
}

export interface DatasetWorkflowResult {
  workflowId: Id;
  status: Workflow['state'];
  sourceArtifact: ArtifactReference;
  governanceDecisionArtifact?: ArtifactReference;
  dataQualityReportArtifact?: ArtifactReference;
  validatedDatasetArtifact?: ArtifactReference;
  reasonCodes: string[];
}

export interface DatasetWorkflowPlan {
  workflowId: Id;
  planVersion: number;
  plan: ExecutionPlan;
  sourceArtifact: ArtifactReference;
  approval?: ApprovalRequest;
}

export interface BeforePublishContext {
  workflowId: Id;
  stage: 'governance-decision' | 'quality-report' | 'validated-dataset';
  sourceArtifact: ArtifactReference;
}

export interface LocalDatasetOrchestratorOptions {
  state: StateStore;
  artifacts: ContentAddressedArtifactRegistry;
  agents: InMemoryAgentRegistry;
  authority?: AuthorityService;
  approvals?: ApprovalService;
  /** Explicit workflow gate selection. Local composition must pass `none` for personal workspaces. */
  workflowApprovalMode?: 'none' | 'organization';
  /** Governs advisory governance findings without changing technical validation. */
  workspaceMode?: 'personal_local' | 'organization';
  governance?: GovernanceSpecialist;
  dataEngineer?: DataEngineerSpecialist;
  clock?: () => string;
  beforePublish?: (context: BeforePublishContext) => Promise<void> | void;
}

export interface LocalDatasetOrchestrator {
  plan(command: RuntimeCommand): Promise<DatasetWorkflowPlan>;
  submit(command: RuntimeCommand, signal?: AbortSignal): Promise<DatasetWorkflowResult>;
  runPlanned(
    tenant: TenantRef,
    workflowId: Id,
    signal?: AbortSignal,
  ): Promise<DatasetWorkflowResult>;
  cancel(tenant: TenantRef, workflowId: Id, reason?: string): Promise<DatasetWorkflowResult>;
  getWorkflow(tenant: TenantRef, workflowId: Id): Promise<VersionedAggregate<Workflow> | undefined>;
  listWorkflowsByProject(tenant: TenantRef, projectId: Id): Promise<Workflow[]>;
  getWorkflowPlan(tenant: TenantRef, workflowId: Id): Promise<ExecutionPlan | undefined>;
  listWorkflowInvocations(
    tenant: TenantRef,
    workflowId: Id,
  ): Promise<VersionedAggregate<AgentInvocation>[] | undefined>;
  getInvocation(
    tenant: TenantRef,
    invocationId: Id,
  ): Promise<VersionedAggregate<AgentInvocation> | undefined>;
  listEvents(tenant: TenantRef, workflowId: Id): Promise<RuntimeEvent[]>;
  getArtifact(tenant: TenantRef, artifactId: Id, version: number): Promise<ArtifactVersionRecord>;
  getCurrentArtifact(tenant: TenantRef, artifactId: Id): Promise<ArtifactVersionRecord | undefined>;
  listArtifactVersions(tenant: TenantRef, artifactId: Id): Promise<ArtifactVersionRecord[]>;
  listCurrentArtifacts(tenant: TenantRef): Promise<ArtifactVersionRecord[]>;
  readArtifactContent(tenant: TenantRef, artifactId: Id, version: number): Promise<Uint8Array>;
  listAgents(): AgentRegistration[];
}

export { LocalProductCommandService, type ProductCommandService } from './products.js';

function isRecord(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(payload: { [key: string]: JsonValue }, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${key} is required`);
  }
  return value;
}

function requiredInteger(payload: { [key: string]: JsonValue }, key: string): number {
  const value = payload[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${key} must be a safe integer`);
  }
  return value;
}

function stringArray(payload: { [key: string]: JsonValue }, key: string): string[] {
  const value = payload[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${key} must be an array of strings`);
  }
  return value.map((entry) => String(entry));
}

function optionalStringArray(
  payload: { [key: string]: JsonValue },
  key: string,
): string[] | undefined {
  const value = payload[key];
  if (value === undefined) return undefined;
  return stringArray(payload, key);
}

function optionalTypes(
  payload: { [key: string]: JsonValue },
  key: string,
): Record<string, DatasetScalarType> | undefined {
  const value = payload[key];
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${key} must be an object`);
  }
  const output: Record<string, DatasetScalarType> = {};
  for (const [column, type] of Object.entries(value)) {
    if (typeof type !== 'string') {
      throw runtimeError('VALIDATION_INVALID_INPUT', `Unsupported expected type for ${column}`);
    }
    if (
      type !== 'null' &&
      type !== 'string' &&
      type !== 'number' &&
      type !== 'boolean' &&
      type !== 'mixed'
    ) {
      throw runtimeError('VALIDATION_INVALID_INPUT', `Unsupported expected type for ${column}`);
    }
    output[column] = type;
  }
  return output;
}

function parsePayload(command: RuntimeCommand): ValidateDatasetPayload {
  if (!isRecord(command.payload)) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'ValidateDataset payload must be an object');
  }
  const leakageThreshold = command.payload['leakageThreshold'];
  if (leakageThreshold !== undefined && typeof leakageThreshold !== 'number') {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'leakageThreshold must be a number');
  }
  const retentionDays = requiredInteger(command.payload, 'retentionDays');
  const requiredColumns = optionalStringArray(command.payload, 'requiredColumns');
  const expectedTypes = optionalTypes(command.payload, 'expectedTypes');
  const projectId =
    command.payload['projectId'] === undefined
      ? undefined
      : typeof command.payload['projectId'] === 'string'
        ? (command.payload['projectId'] as Id)
        : (() => {
            throw runtimeError('VALIDATION_INVALID_INPUT', 'projectId must be a UUIDv7 id');
          })();
  const displayName = command.payload['displayName'];
  const trigger = command.payload['trigger'];
  if (
    displayName !== undefined &&
    (typeof displayName !== 'string' || displayName.trim().length === 0)
  ) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'displayName must be a non-empty string');
  }
  if (trigger !== undefined && (typeof trigger !== 'string' || trigger.trim().length === 0)) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'trigger must be a non-empty string');
  }
  return {
    sourceArtifactId: requiredString(command.payload, 'sourceArtifactId'),
    sourceArtifactVersion: requiredInteger(command.payload, 'sourceArtifactVersion'),
    intendedUse: requiredString(command.payload, 'intendedUse'),
    requestedAccessScopes: stringArray(command.payload, 'requestedAccessScopes'),
    retentionDays,
    ...(requiredColumns !== undefined ? { requiredColumns } : {}),
    ...(expectedTypes !== undefined ? { expectedTypes } : {}),
    ...(typeof command.payload['labelColumn'] === 'string'
      ? { labelColumn: command.payload['labelColumn'] }
      : {}),
    ...(leakageThreshold !== undefined ? { leakageThreshold } : {}),
    ...(typeof command.payload['splitSeed'] === 'string'
      ? { splitSeed: command.payload['splitSeed'] }
      : {}),
    ...(projectId === undefined ? {} : { projectId }),
    ...(typeof displayName === 'string' ? { displayName } : {}),
    ...(typeof trigger === 'string' ? { trigger } : {}),
  };
}

function artifactSelector(reference: ArtifactReference): {
  kind: 'artifact';
  id: Id;
  version: number;
} {
  return { kind: 'artifact', id: reference.artifactId, version: reference.version };
}

function actorForAgent(agentId: Id, agentType: 'agent' | 'system' = 'agent'): Actor {
  return { actorId: agentId, type: agentType };
}

function resourceEnvelope(): AgentInvocation['resource'] {
  return {
    limits: {
      cpuMillicores: 1000,
      memoryBytes: 256 * 1024 * 1024,
      wallTimeMs: 60_000,
      outputBytes: 4 * 1024 * 1024,
      storageBytes: 64 * 1024 * 1024,
      processCount: 1,
    },
    networkAllowlist: [],
    readOnlyArtifactMounts: true,
  };
}

function retryEnvelope(): AgentInvocation['retry'] {
  return { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0, retryableErrorCodes: [] };
}

function budgetEnvelope(budgetId: Id, limit: number): AgentInvocation['budget'] {
  return { budgetId, limit, reserved: 0, consumed: 0, currency: 'USD' };
}

async function appendEvent(
  transaction: StateTransaction,
  event: RuntimeEvent,
  now: string,
): Promise<void> {
  const stored = await transaction.events.append(event, event.aggregateVersion - 1);
  await transaction.outbox.enqueue(stored.event, 'runtime.events', now);
}

async function nextEventVersion(
  transaction: StateTransaction,
  tenant: TenantRef,
  aggregateType: string,
  aggregateId: Id,
): Promise<number> {
  const events = await transaction.events.all();
  return (
    events
      .filter(
        ({ event }) =>
          event.tenant.tenantId === tenant.tenantId &&
          event.tenant.workspaceId === tenant.workspaceId &&
          event.aggregateType === aggregateType &&
          event.aggregateId === aggregateId,
      )
      .reduce((latest, stored) => Math.max(latest, stored.event.aggregateVersion), 0) + 1
  );
}

function planDigest(plan: Omit<ExecutionPlan, 'digest'>): HashSha256 {
  return sha256Digest(plan);
}

function workflowResultFrom(
  workflow: Workflow,
  sourceArtifact: ArtifactReference,
  reasonCodes: string[] = [],
  artifacts: Partial<
    Pick<
      DatasetWorkflowResult,
      'governanceDecisionArtifact' | 'dataQualityReportArtifact' | 'validatedDatasetArtifact'
    >
  > = {},
): DatasetWorkflowResult {
  return {
    workflowId: workflow.workflowId,
    status: workflow.state,
    sourceArtifact,
    reasonCodes: [...new Set(reasonCodes)].sort(),
    ...artifacts,
  };
}

export class LocalDatasetWorkflowOrchestrator implements LocalDatasetOrchestrator {
  private readonly state: StateStore;
  private readonly artifacts: ContentAddressedArtifactRegistry;
  private readonly agents: InMemoryAgentRegistry;
  private readonly authority: AuthorityService;
  private readonly approvals: ApprovalService | undefined;
  private readonly workflowApprovalMode: 'none' | 'organization';
  private readonly workspaceMode: 'personal_local' | 'organization';
  private readonly governance: GovernanceSpecialist;
  private readonly dataEngineer: DataEngineerSpecialist;
  private readonly clock: () => string;
  private readonly beforePublish:
    | ((context: BeforePublishContext) => Promise<void> | void)
    | undefined;
  private readonly dispatcher: CommandDispatcher;
  private readonly runs = new Map<Id, Promise<DatasetWorkflowResult>>();
  private readonly controllers = new Map<Id, AbortController>();
  private readonly invocationService: InvocationService;

  constructor(options: LocalDatasetOrchestratorOptions) {
    this.state = options.state;
    this.artifacts = options.artifacts;
    this.agents = options.agents;
    this.authority = options.authority ?? new AuthorityService();
    this.approvals = options.approvals;
    this.workflowApprovalMode =
      options.workflowApprovalMode ?? (options.approvals === undefined ? 'none' : 'organization');
    this.workspaceMode = options.workspaceMode ?? 'organization';
    this.governance = options.governance ?? new GovernanceSpecialist();
    this.dataEngineer = options.dataEngineer ?? new DataEngineerSpecialist();
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.beforePublish = options.beforePublish;
    this.invocationService = new InvocationService({
      state: this.state,
      authority: this.authority,
    });
    this.dispatcher = new CommandDispatcher(this.state);
    this.dispatcher.register({
      commandType: 'ValidateDataset',
      handle: (context) => this.buildPlan(context.command, context.transaction),
    });
    for (const commandType of ['CreateRun', 'PlanRun']) {
      this.dispatcher.register({
        commandType,
        handle: (context) => this.buildPlan(context.command, context.transaction),
      });
    }
  }

  async submit(command: RuntimeCommand, signal?: AbortSignal): Promise<DatasetWorkflowResult> {
    const planned = await this.plan(command);
    return this.runPlanned(command.tenant, planned.workflowId, signal);
  }

  async plan(command: RuntimeCommand): Promise<DatasetWorkflowPlan> {
    const dispatched = await this.dispatcher.dispatch(command);
    const result = dispatched.result;
    if (!isRecord(result) || typeof result['workflowId'] !== 'string') {
      throw runtimeError(
        'VALIDATION_SCHEMA_MISMATCH',
        'Planner returned an invalid workflow result',
      );
    }
    const workflowId = result['workflowId'] as Id;
    const planRecord = await this.loadPlan(command.tenant, workflowId);
    const approval =
      planRecord.approvalId === undefined || this.approvals === undefined
        ? undefined
        : this.approvals.get(command.tenant, planRecord.approvalId)?.request;
    return {
      workflowId,
      planVersion: planRecord.plan.version,
      plan: planRecord.plan,
      sourceArtifact: planRecord.sourceArtifact,
      ...(approval === undefined ? {} : { approval }),
    };
  }

  async runPlanned(
    tenant: TenantRef,
    workflowId: Id,
    signal?: AbortSignal,
  ): Promise<DatasetWorkflowResult> {
    const id = workflowId;
    const existing = this.runs.get(id);
    if (existing) return existing;
    if ((await this.getWorkflow(tenant, id)) === undefined) {
      throw runtimeError('ARTIFACT_NOT_FOUND', 'Planned workflow is unavailable');
    }
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort(signal?.reason);
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    const run = this.execute(id, tenant, controller.signal);
    this.runs.set(id, run);
    this.controllers.set(id, controller);
    try {
      return await run;
    } finally {
      this.runs.delete(id);
      this.controllers.delete(id);
      signal?.removeEventListener('abort', forwardAbort);
    }
  }

  async cancel(
    tenant: TenantRef,
    workflowId: Id,
    reason = 'cancelled by caller',
  ): Promise<DatasetWorkflowResult> {
    this.controllers.get(workflowId)?.abort(reason);
    const existing = await this.getWorkflow(tenant, workflowId);
    if (!existing) throw runtimeError('ARTIFACT_NOT_FOUND', 'Workflow is unavailable');
    if (!['completed', 'failed', 'blocked', 'cancelled'].includes(existing.value.state)) {
      await this.finishRootAndWorkflow(tenant, workflowId, 'cancel');
    }
    const plan = await this.loadPlan(tenant, workflowId);
    return this.terminalResult((await this.requireWorkflow(tenant, workflowId)).value, plan);
  }

  async getWorkflow(
    tenant: TenantRef,
    workflowId: Id,
  ): Promise<VersionedAggregate<Workflow> | undefined> {
    return this.state.transaction((transaction) => transaction.workflows.get(tenant, workflowId));
  }

  async listWorkflowsByProject(tenant: TenantRef, projectId: Id): Promise<Workflow[]> {
    return this.state.transaction(async (transaction) => {
      const events = await transaction.events.list(tenant);
      const workflowIds = new Set<Id>();
      for (const stored of events) {
        if (!stored.event.eventName.startsWith('workflow.')) continue;
        const payload = stored.event.payload;
        if (
          payload !== null &&
          typeof payload === 'object' &&
          !Array.isArray(payload) &&
          payload['projectId'] === projectId
        ) {
          workflowIds.add(stored.event.aggregateId);
        }
      }
      const workflows: Workflow[] = [];
      for (const workflowId of workflowIds) {
        const workflow = await transaction.workflows.get(tenant, workflowId);
        if (workflow !== undefined) workflows.push(workflow.value);
      }
      return workflows;
    });
  }

  async getWorkflowPlan(tenant: TenantRef, workflowId: Id): Promise<ExecutionPlan | undefined> {
    if (!(await this.getWorkflow(tenant, workflowId))) return undefined;
    return (await this.loadPlan(tenant, workflowId)).plan;
  }

  async listWorkflowInvocations(
    tenant: TenantRef,
    workflowId: Id,
  ): Promise<VersionedAggregate<AgentInvocation>[] | undefined> {
    const workflow = await this.getWorkflow(tenant, workflowId);
    if (!workflow) return undefined;
    return this.state.transaction(async (transaction) => {
      const invocations: VersionedAggregate<AgentInvocation>[] = [];
      for (const invocationId of workflow.value.invocationIds) {
        const invocation = await transaction.invocations.get(tenant, invocationId);
        if (invocation !== undefined) invocations.push(invocation);
      }
      return invocations;
    });
  }

  getInvocation(
    tenant: TenantRef,
    invocationId: Id,
  ): Promise<VersionedAggregate<AgentInvocation> | undefined> {
    return this.state.transaction((transaction) =>
      transaction.invocations.get(tenant, invocationId),
    );
  }

  async listEvents(tenant: TenantRef, workflowId: Id): Promise<RuntimeEvent[]> {
    const events = await this.state.transaction((transaction) => transaction.events.list(tenant));
    return events
      .filter(({ event }) => event.aggregateId === workflowId || event.correlationId === workflowId)
      .map(({ event }) => structuredClone(event));
  }

  getArtifact(tenant: TenantRef, artifactId: Id, version: number): Promise<ArtifactVersionRecord> {
    return this.artifacts.getVersion(tenant, artifactId, version);
  }

  getCurrentArtifact(
    tenant: TenantRef,
    artifactId: Id,
  ): Promise<ArtifactVersionRecord | undefined> {
    return this.artifacts.currentVersion(tenant, artifactId);
  }

  listArtifactVersions(tenant: TenantRef, artifactId: Id): Promise<ArtifactVersionRecord[]> {
    return this.artifacts.listVersions(tenant, artifactId);
  }

  listCurrentArtifacts(tenant: TenantRef): Promise<ArtifactVersionRecord[]> {
    return this.artifacts.listCurrent(tenant);
  }

  readArtifactContent(tenant: TenantRef, artifactId: Id, version: number): Promise<Uint8Array> {
    return this.artifacts.readContent(tenant, artifactId, version);
  }

  listAgents(): AgentRegistration[] {
    return this.agents.list();
  }

  private async buildPlan(
    command: RuntimeCommand,
    transaction: StateTransaction,
  ): Promise<CommandHandlerResult> {
    const payload = parsePayload(command);
    const source = await transaction.artifactVersions.get(
      command.tenant,
      payload.sourceArtifactId as Id,
      payload.sourceArtifactVersion,
    );
    const current = await transaction.artifactVersions.current(
      command.tenant,
      payload.sourceArtifactId as Id,
    );
    if (!source || !current || current.reference.version !== payload.sourceArtifactVersion) {
      throw runtimeError('ARTIFACT_NOT_FOUND', 'Requested source artifact version is unavailable');
    }
    const governanceRegistration = this.agents.requireActive('governance', 'governance.v1');
    const dataEngineerRegistration = this.agents.requireActive('data-engineer', 'data-engineer.v1');
    const workflowId = command.correlationId;
    const rootInvocationId = newSortableId();
    const outputArtifactIds = {
      governanceDecision: artifactIdForTask(workflowId, 'governance'),
      qualityReport: artifactIdForTask(workflowId, 'quality-report'),
      validatedDataset: artifactIdForTask(workflowId, 'validated-dataset'),
    };
    const requiresApproval = this.workflowApprovalMode === 'organization';
    const governanceStepId = newSortableId();
    const planWithoutDigest = {
      schemaVersion: 1 as const,
      planId: newSortableId(),
      workflowId,
      version: 1,
      steps: [
        {
          stepId: governanceStepId,
          tier: 1 as const,
          agentType: 'governance',
          title: 'Review governance and access policy',
          description:
            'Evaluate intended use, access scopes, retention, and governance policy before execution.',
          dependsOn: [],
          inputArtifactIds: [source.reference.artifactId],
          requiredCapabilities: governanceRegistration.capabilities,
          approvalRequired: requiresApproval,
          expectedOutputs: ['Governance decision'],
          acceptanceCriteria: ['GovernanceDecision.v1 is published'],
        },
        {
          stepId: newSortableId(),
          tier: 1 as const,
          agentType: 'data-engineer',
          title: 'Profile and validate the dataset',
          description:
            'Profile the source, evaluate data quality, and publish the validated dataset outputs.',
          dependsOn: [governanceStepId],
          inputArtifactIds: [source.reference.artifactId, outputArtifactIds.governanceDecision],
          requiredCapabilities: dataEngineerRegistration.capabilities,
          approvalRequired: requiresApproval,
          expectedOutputs: ['Data quality report', 'Validated dataset'],
          acceptanceCriteria: [
            'DataQualityReport.v1 is published',
            'ValidatedDataset.v1 is published',
          ],
        },
      ],
      createdAt: command.issuedAt,
      createdByInvocationId: rootInvocationId,
    } satisfies Omit<ExecutionPlan, 'digest'>;
    const plan: ExecutionPlan = { ...planWithoutDigest, digest: planDigest(planWithoutDigest) };

    const artifactSelectors = [
      artifactSelector(source.reference),
      { kind: 'artifact' as const, id: outputArtifactIds.governanceDecision, version: 1 },
      { kind: 'artifact' as const, id: outputArtifactIds.qualityReport, version: 1 },
      { kind: 'artifact' as const, id: outputArtifactIds.validatedDataset, version: 1 },
    ];
    const governanceArtifactSelector = artifactSelectors[1];
    if (!governanceArtifactSelector) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Governance output scope is missing');
    }
    const parentAgentId = newSortableId();
    const parentAuthority = this.authority.issue({
      tenant: command.tenant,
      workflowId,
      invocationId: rootInvocationId,
      issuer: command.actor,
      subjectAgentId: parentAgentId,
      tier: 0,
      harnessVersion: 'orchestrator.v1',
      permittedActions: [
        'artifact.read',
        'artifact.write',
        'invocation.create',
        'report.create',
        'workflow.plan',
        'approval.request',
      ],
      capabilities: [
        ...governanceRegistration.capabilities,
        ...dataEngineerRegistration.capabilities,
      ],
      resourceScopes: artifactSelectors,
      allowedArtifactReads: [artifactSelector(source.reference), governanceArtifactSelector],
      allowedArtifactWrites: artifactSelectors.slice(1),
      allowedChildAgentTypes: ['data-engineer', 'governance'],
      maxChildCount: 2,
      toolOperations: [],
      issuedAt: command.issuedAt,
      expiresAt: new Date(Date.parse(command.issuedAt) + 60 * 60 * 1000).toISOString(),
    });
    const approval =
      this.workflowApprovalMode !== 'organization' || this.approvals === undefined
        ? undefined
        : this.approvals.request({
            action: {
              actionType: 'workflow.execute',
              tenant: command.tenant,
              workflowId,
              invocationId: rootInvocationId,
              actor: actorForAgent(parentAgentId),
              artifactVersions: artifactSelectors,
              resources: [],
              credentialScopes: payload.requestedAccessScopes,
              estimatedCost: makeMoney(0, 'USD'),
              policyVersion: parentAuthority.policyVersion,
              revocationEpoch: parentAuthority.revocationEpoch,
            },
            authority: parentAuthority,
            expiresAt: parentAuthority.expiresAt,
            now: command.issuedAt,
          });
    const planRecord: LocalPlanRecord = {
      plan,
      sourceArtifact: source.reference,
      ...(approval === undefined ? {} : { approvalId: approval.request.approvalId }),
      payload,
      outputArtifactIds,
    };
    const rootInvocation: AgentInvocation = {
      schemaVersion: 1,
      invocationId: rootInvocationId,
      workflowId,
      tenant: command.tenant,
      tier: 0,
      agentType: 'orchestrator',
      harnessVersion: 'orchestrator.v1',
      input: command.payload,
      authority: parentAuthority,
      resource: resourceEnvelope(),
      retry: retryEnvelope(),
      budget: budgetEnvelope(workflowId, 10_000),
      state: 'created',
      attempt: 0,
      createdAt: command.issuedAt,
      correlationId: workflowId,
    };
    const workflow: Workflow = {
      schemaVersion: 1,
      workflowId,
      tenant: command.tenant,
      objective: `Validate dataset ${source.reference.artifactId}@${source.reference.version}`,
      state: 'planning',
      planVersion: 1,
      createdAt: command.issuedAt,
      updatedAt: command.issuedAt,
      invocationIds: [rootInvocationId],
      ...(payload.projectId === undefined ? {} : { projectId: payload.projectId }),
      ...(payload.displayName === undefined ? {} : { displayName: payload.displayName }),
      ...(payload.trigger === undefined ? {} : { trigger: payload.trigger }),
      constraints: {
        sourceArtifactId: source.reference.artifactId,
        sourceArtifactVersion: source.reference.version,
        retentionDays: payload.retentionDays,
      },
      completionCriteria: [
        'GovernanceDecision.v1 is approved and published',
        'DataQualityReport.v1 is valid and published',
        'ValidatedDataset.v1 is published',
      ],
    };
    await transaction.workflows.create(command.tenant, workflowId, workflow, command.issuedAt);
    await transaction.invocations.create(
      command.tenant,
      rootInvocationId,
      rootInvocation,
      command.issuedAt,
    );
    await appendEvent(
      transaction,
      {
        schemaVersion: 1,
        eventId: newSortableId(),
        eventName: 'workflow.planned.v1',
        tenant: command.tenant,
        aggregateType: 'workflow',
        aggregateId: workflowId,
        aggregateVersion: 1,
        occurredAt: command.issuedAt,
        actor: command.actor,
        correlationId: workflowId,
        payload: {
          planRecord: planRecord as unknown as JsonValue,
          sourceArtifact: source.reference as unknown as JsonValue,
          objective: workflow.objective,
          ...(workflow.projectId === undefined ? {} : { projectId: workflow.projectId }),
          ...(workflow.displayName === undefined ? {} : { displayName: workflow.displayName }),
          ...(workflow.trigger === undefined ? {} : { trigger: workflow.trigger }),
        },
      },
      command.issuedAt,
    );
    await appendEvent(
      transaction,
      {
        schemaVersion: 1,
        eventId: newSortableId(),
        eventName: 'workflow.plan-draft-updated.v1',
        tenant: command.tenant,
        aggregateType: 'workflow',
        aggregateId: workflowId,
        aggregateVersion: 2,
        occurredAt: command.issuedAt,
        actor: command.actor,
        correlationId: workflowId,
        payload: {
          workflowId,
          plan: plan as unknown as JsonValue,
          status: 'draft',
        } as unknown as JsonValue,
      },
      command.issuedAt,
    );
    await appendEvent(
      transaction,
      {
        schemaVersion: 1,
        eventId: newSortableId(),
        eventName: 'workflow.plan-updated.v1',
        tenant: command.tenant,
        aggregateType: 'workflow',
        aggregateId: workflowId,
        aggregateVersion: 3,
        occurredAt: command.issuedAt,
        actor: command.actor,
        correlationId: workflowId,
        payload: {
          workflowId,
          plan: plan as unknown as JsonValue,
          status: 'authoritative',
        } as unknown as JsonValue,
      },
      command.issuedAt,
    );
    await appendEvent(
      transaction,
      {
        schemaVersion: 1,
        eventId: newSortableId(),
        eventName: 'invocation.created.v1',
        tenant: command.tenant,
        aggregateType: 'invocation',
        aggregateId: rootInvocationId,
        aggregateVersion: 1,
        occurredAt: command.issuedAt,
        actor: actorForAgent(parentAgentId),
        correlationId: workflowId,
        payload: { agentType: 'orchestrator', tier: 0 },
      },
      command.issuedAt,
    );
    return {
      result: {
        workflowId,
        planVersion: 1,
        sourceArtifact: source.reference as unknown as JsonValue,
      },
      events: [],
    };
  }

  private async execute(
    workflowId: Id,
    tenant: TenantRef,
    signal?: AbortSignal,
  ): Promise<DatasetWorkflowResult> {
    const planRecord = await this.loadPlan(tenant, workflowId);
    const workflowAggregate = await this.getWorkflow(tenant, workflowId);
    if (!workflowAggregate)
      throw runtimeError('ARTIFACT_NOT_FOUND', 'Planned workflow is unavailable');
    if (
      workflowAggregate.value.state === 'completed' ||
      workflowAggregate.value.state === 'failed' ||
      workflowAggregate.value.state === 'blocked' ||
      workflowAggregate.value.state === 'cancelled'
    ) {
      return this.terminalResult(workflowAggregate.value, planRecord);
    }
    let governanceArtifact: ArtifactReference | undefined;
    let qualityArtifact: ArtifactReference | undefined;
    let validatedArtifact: ArtifactReference | undefined;
    let activeInvocationId: Id | undefined;
    const reasons: string[] = [];
    try {
      const approvalWait = await this.prepareApproval(tenant, workflowId, planRecord);
      if (approvalWait !== undefined) return approvalWait;
      if ((await this.requireWorkflow(tenant, workflowId)).value.state === 'planning') {
        await this.transitionWorkflow(tenant, workflowId, 'beginExecution');
      }
      await this.emitRunEvent(tenant, workflowId, 'run.progress.v1', {
        progress: 5,
        stage: 'preparing',
      });
      await this.emitRunEvent(tenant, workflowId, 'run.log.v1', {
        level: 'info',
        message: 'Run execution started from the authoritative workflow plan',
      });
      const rootBeforeExecution = await this.requireRoot(tenant, workflowId);
      if (rootBeforeExecution.value.state === 'created') {
        await this.transitionRoot(tenant, workflowId, 'prepare');
        await this.transitionRoot(tenant, workflowId, 'start');
      } else if (rootBeforeExecution.value.state === 'preparing') {
        await this.transitionRoot(tenant, workflowId, 'start');
      } else if (rootBeforeExecution.value.state !== 'running') {
        throw runtimeError(
          'VALIDATION_INVALID_INPUT',
          `Workflow root cannot begin execution from ${rootBeforeExecution.value.state}`,
        );
      }
      const root = await this.requireRoot(tenant, workflowId);
      const governanceRegistration = this.agents.requireActive('governance', 'governance.v1');
      const governanceInvocation = await this.createChildInvocation(
        root,
        governanceRegistration,
        planRecord,
        'governance',
        0,
      );
      activeInvocationId = governanceInvocation.id;
      await this.transitionInvocation(tenant, governanceInvocation.id, 'prepare');
      await this.transitionInvocation(tenant, governanceInvocation.id, 'start');
      this.assertNotCancelled(signal);
      const sourceContent = await this.artifacts.readContent(
        tenant,
        planRecord.sourceArtifact.artifactId,
        planRecord.sourceArtifact.version,
      );
      const profile = profileDataset(
        sourceContent,
        planRecord.payload.splitSeed !== undefined
          ? { splitSeed: planRecord.payload.splitSeed }
          : {},
      );
      const decision = this.governance.evaluate({
        sourceArtifact: planRecord.sourceArtifact,
        intendedUse: planRecord.payload.intendedUse,
        requestedAccessScopes: planRecord.payload.requestedAccessScopes,
        retentionDays: planRecord.payload.retentionDays,
        profile,
        now: this.clock(),
        enforcementMode: this.workspaceMode,
      });
      governanceArtifact = await this.publishJson(
        tenant,
        planRecord.outputArtifactIds.governanceDecision,
        decision as unknown as JsonValue,
        governanceInvocation.value.authority.subjectAgentId,
        governanceInvocation.id,
        [planRecord.sourceArtifact],
        'GovernanceDecision.v1',
        workflowId,
        'governance-decision',
      );
      await this.emitRunEvent(tenant, workflowId, 'run.progress.v1', {
        progress: 35,
        stage: 'governance',
      });
      await this.emitRunEvent(tenant, workflowId, 'run.log.v1', {
        level: 'info',
        message: 'Governance decision artifact published',
      });
      await this.finishInvocation(
        tenant,
        governanceInvocation.id,
        decision.decision === 'denied' ? 'block' : 'succeed',
      );
      reasons.push(...decision.reasonCodes);
      if (decision.decision === 'denied') {
        await this.finishRootAndWorkflow(tenant, workflowId, 'block');
        return workflowResultFrom(
          (await this.requireWorkflow(tenant, workflowId)).value,
          planRecord.sourceArtifact,
          reasons,
          { governanceDecisionArtifact: governanceArtifact },
        );
      }

      this.assertNotCancelled(signal);
      const updatedRoot = await this.requireRoot(tenant, workflowId);
      const dataEngineerRegistration = this.agents.requireActive(
        'data-engineer',
        'data-engineer.v1',
      );
      const dataEngineerInvocation = await this.createChildInvocation(
        updatedRoot,
        dataEngineerRegistration,
        planRecord,
        'data-engineer',
        1,
        governanceArtifact,
      );
      activeInvocationId = dataEngineerInvocation.id;
      await this.transitionInvocation(tenant, dataEngineerInvocation.id, 'prepare');
      await this.transitionInvocation(tenant, dataEngineerInvocation.id, 'start');
      const validation = this.dataEngineer.validate({
        content: sourceContent,
        validation: {
          ...(planRecord.payload.requiredColumns !== undefined
            ? { requiredColumns: planRecord.payload.requiredColumns }
            : {}),
          ...(planRecord.payload.expectedTypes !== undefined
            ? { expectedTypes: planRecord.payload.expectedTypes }
            : {}),
          ...(planRecord.payload.labelColumn !== undefined
            ? { labelColumn: planRecord.payload.labelColumn }
            : {}),
          ...(planRecord.payload.leakageThreshold !== undefined
            ? { leakageThreshold: planRecord.payload.leakageThreshold }
            : {}),
          ...(planRecord.payload.splitSeed !== undefined
            ? { splitSeed: planRecord.payload.splitSeed }
            : {}),
        },
      });
      await this.emitRunEvent(tenant, workflowId, 'run.progress.v1', {
        progress: 70,
        stage: 'validation',
      });
      await this.emitRunEvent(tenant, workflowId, 'run.metric.v1', {
        name: 'dataset.rows',
        value: profile.rowCount,
        unit: 'rows',
      });
      await this.emitRunEvent(tenant, workflowId, 'run.log.v1', {
        level: 'info',
        message: `Dataset validation completed with status ${validation.status}`,
      });
      reasons.push(...validation.reasonCodes);
      qualityArtifact = await this.publishJson(
        tenant,
        planRecord.outputArtifactIds.qualityReport,
        validation.qualityReport as unknown as JsonValue,
        dataEngineerInvocation.value.authority.subjectAgentId,
        dataEngineerInvocation.id,
        [planRecord.sourceArtifact, governanceArtifact],
        'DataQualityReport.v1',
        workflowId,
        'quality-report',
      );
      if (validation.status === 'success') {
        validatedArtifact = await this.publishJson(
          tenant,
          planRecord.outputArtifactIds.validatedDataset,
          validation.validatedDataset as unknown as JsonValue,
          dataEngineerInvocation.value.authority.subjectAgentId,
          dataEngineerInvocation.id,
          [planRecord.sourceArtifact, governanceArtifact, qualityArtifact],
          'ValidatedDataset.v1',
          workflowId,
          'validated-dataset',
        );
        await this.finishInvocation(tenant, dataEngineerInvocation.id, 'succeed');
        await this.finishRootAndWorkflow(tenant, workflowId, 'succeed');
        await this.emitRunEvent(tenant, workflowId, 'run.progress.v1', {
          progress: 100,
          stage: 'completed',
        });
        await this.emitRunEvent(tenant, workflowId, 'run.log.v1', {
          level: 'info',
          message: 'Run completed and validated dataset artifact published',
        });
      } else {
        await this.finishInvocation(
          tenant,
          dataEngineerInvocation.id,
          validation.status === 'blocked' ? 'block' : 'fail',
        );
        await this.finishRootAndWorkflow(
          tenant,
          workflowId,
          validation.status === 'blocked' ? 'block' : 'fail',
        );
        await this.emitRunEvent(tenant, workflowId, 'run.log.v1', {
          level: 'error',
          message: `Run ended with validation status ${validation.status}`,
        });
      }
    } catch (error) {
      if (signal?.aborted) reasons.push('CANCELLED');
      else reasons.push(error instanceof Error ? error.message : String(error));
      if (activeInvocationId !== undefined) {
        await this.transitionInvocation(
          tenant,
          activeInvocationId,
          signal?.aborted ? 'cancel' : 'fail',
        );
      }
      await this.finishRootAndWorkflow(tenant, workflowId, signal?.aborted ? 'cancel' : 'fail');
      await this.emitRunEvent(tenant, workflowId, 'run.log.v1', {
        level: 'error',
        message: signal?.aborted ? 'Run cancelled' : 'Run failed',
      });
    }
    const finished = await this.requireWorkflow(tenant, workflowId);
    return workflowResultFrom(finished.value, planRecord.sourceArtifact, reasons, {
      ...(governanceArtifact !== undefined
        ? { governanceDecisionArtifact: governanceArtifact }
        : {}),
      ...(qualityArtifact !== undefined ? { dataQualityReportArtifact: qualityArtifact } : {}),
      ...(validatedArtifact !== undefined ? { validatedDatasetArtifact: validatedArtifact } : {}),
    });
  }

  private async emitRunEvent(
    tenant: TenantRef,
    workflowId: Id,
    eventName: string,
    payload: { [key: string]: JsonValue },
  ): Promise<void> {
    await this.state.transaction(async (transaction) => {
      const now = this.clock();
      const aggregateVersion = await nextEventVersion(transaction, tenant, 'workflow', workflowId);
      await appendEvent(
        transaction,
        {
          schemaVersion: 1,
          eventId: newSortableId(),
          eventName,
          tenant,
          aggregateType: 'workflow',
          aggregateId: workflowId,
          aggregateVersion,
          occurredAt: now,
          actor: { actorId: workflowId, type: 'system' },
          correlationId: workflowId,
          payload,
        },
        now,
      );
    });
  }

  private async prepareApproval(
    tenant: TenantRef,
    workflowId: Id,
    planRecord: LocalPlanRecord,
  ): Promise<DatasetWorkflowResult | undefined> {
    if (planRecord.approvalId === undefined || this.approvals === undefined) return undefined;
    const approval = this.approvals.get(tenant, planRecord.approvalId);
    if (approval === undefined) {
      throw runtimeError('APPROVAL_INVALIDATED', 'The workflow approval is unavailable');
    }
    const now = this.clock();
    if (
      approval.request.state === 'pending' &&
      Date.parse(now) >= Date.parse(approval.request.expiresAt)
    ) {
      throw runtimeError('APPROVAL_INVALIDATED', 'The workflow approval has expired');
    }
    let workflow = await this.requireWorkflow(tenant, workflowId);
    let root = await this.requireRoot(tenant, workflowId);
    if (approval.request.state === 'pending') {
      if (workflow.value.state === 'planning') {
        await this.transitionWorkflow(tenant, workflowId, 'requestApproval');
      }
      if (root.value.state === 'created') {
        await this.transitionRoot(tenant, workflowId, 'prepare');
        await this.transitionRoot(tenant, workflowId, 'requestApproval');
      } else if (root.value.state === 'preparing') {
        await this.transitionRoot(tenant, workflowId, 'requestApproval');
      }
      workflow = await this.requireWorkflow(tenant, workflowId);
      return workflowResultFrom(workflow.value, planRecord.sourceArtifact, ['AWAITING_APPROVAL']);
    }
    if (approval.request.state !== 'approved') {
      throw runtimeError(
        'APPROVAL_INVALIDATED',
        `The workflow approval is ${approval.request.state}`,
      );
    }
    this.approvals.assertValid(
      tenant,
      planRecord.approvalId,
      approval.action,
      root.value.authority,
      now,
    );
    if (workflow.value.state === 'planning') {
      await this.transitionWorkflow(tenant, workflowId, 'requestApproval');
    }
    if (root.value.state === 'created') {
      await this.transitionRoot(tenant, workflowId, 'prepare');
      await this.transitionRoot(tenant, workflowId, 'requestApproval');
    } else if (root.value.state === 'preparing') {
      await this.transitionRoot(tenant, workflowId, 'requestApproval');
    }
    workflow = await this.requireWorkflow(tenant, workflowId);
    root = await this.requireRoot(tenant, workflowId);
    if (workflow.value.state === 'awaiting_approval') {
      await this.transitionWorkflow(tenant, workflowId, 'approve');
    }
    if (root.value.state === 'awaiting_approval') {
      await this.transitionRoot(tenant, workflowId, 'approve');
    }
    return undefined;
  }

  private async loadPlan(tenant: TenantRef, workflowId: Id): Promise<LocalPlanRecord> {
    const events = await this.state.transaction((transaction) => transaction.events.list(tenant));
    const planned = events.find(
      ({ event }) => event.aggregateId === workflowId && event.eventName === 'workflow.planned.v1',
    );
    const payload = planned?.event.payload;
    if (!isRecord(payload) || !isRecord(payload['planRecord'])) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Workflow plan record is unavailable');
    }
    const planRecord = payload['planRecord'] as unknown as LocalPlanRecord;
    if (!planRecord.plan || !planRecord.sourceArtifact || !planRecord.outputArtifactIds) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Workflow plan record is invalid');
    }
    return planRecord;
  }

  private async terminalResult(
    workflow: Workflow,
    planRecord: LocalPlanRecord,
  ): Promise<DatasetWorkflowResult> {
    const governance = await this.artifacts.currentVersion(
      workflow.tenant,
      planRecord.outputArtifactIds.governanceDecision,
    );
    const quality = await this.artifacts.currentVersion(
      workflow.tenant,
      planRecord.outputArtifactIds.qualityReport,
    );
    const validated = await this.artifacts.currentVersion(
      workflow.tenant,
      planRecord.outputArtifactIds.validatedDataset,
    );
    return workflowResultFrom(workflow, planRecord.sourceArtifact, [], {
      ...(governance !== undefined ? { governanceDecisionArtifact: governance.reference } : {}),
      ...(quality !== undefined ? { dataQualityReportArtifact: quality.reference } : {}),
      ...(validated !== undefined ? { validatedDatasetArtifact: validated.reference } : {}),
    });
  }

  private async requireWorkflow(
    tenant: TenantRef,
    workflowId: Id,
  ): Promise<VersionedAggregate<Workflow>> {
    const workflow = await this.getWorkflow(tenant, workflowId);
    if (!workflow) throw runtimeError('ARTIFACT_NOT_FOUND', 'Workflow is unavailable');
    return workflow;
  }

  private async requireRoot(
    tenant: TenantRef,
    workflowId: Id,
  ): Promise<VersionedAggregate<AgentInvocation>> {
    const workflow = await this.requireWorkflow(tenant, workflowId);
    const rootId = workflow.value.invocationIds[0];
    if (!rootId)
      throw runtimeError('INVOCATION_INVALID_PARENT', 'Workflow root invocation is missing');
    const root = await this.state.transaction((transaction) =>
      transaction.invocations.get(tenant, rootId),
    );
    if (!root)
      throw runtimeError('INVOCATION_INVALID_PARENT', 'Workflow root invocation is unavailable');
    return root;
  }

  private async transitionWorkflow(
    tenant: TenantRef,
    workflowId: Id,
    action:
      | 'requestApproval'
      | 'approve'
      | 'beginExecution'
      | 'complete'
      | 'block'
      | 'fail'
      | 'cancel',
  ): Promise<void> {
    await this.state.transaction(async (transaction) => {
      const current = await transaction.workflows.get(tenant, workflowId);
      if (!current) throw runtimeError('ARTIFACT_NOT_FOUND', 'Workflow is unavailable');
      if (
        current.value.state === 'completed' ||
        current.value.state === 'failed' ||
        current.value.state === 'blocked' ||
        current.value.state === 'cancelled'
      )
        return;
      const now = this.clock();
      const transitions: Record<
        typeof action,
        { from: readonly Workflow['state'][]; to: Workflow['state'] }
      > = {
        requestApproval: { from: ['planning', 'executing'], to: 'awaiting_approval' },
        approve: { from: ['awaiting_approval'], to: 'executing' },
        beginExecution: { from: ['planning'], to: 'executing' },
        complete: { from: ['executing'], to: 'completed' },
        block: { from: ['executing'], to: 'blocked' },
        fail: { from: ['planning', 'awaiting_approval', 'executing', 'blocked'], to: 'failed' },
        cancel: {
          from: ['planning', 'awaiting_approval', 'executing', 'blocked'],
          to: 'cancelled',
        },
      };
      const transition = transitions[action];
      if (!transition.from.includes(current.value.state)) {
        throw runtimeError(
          'VALIDATION_INVALID_INPUT',
          `Workflow cannot transition from ${current.value.state}`,
        );
      }
      const value = { ...current.value, state: transition.to, updatedAt: now };
      await transaction.workflows.update(tenant, workflowId, current.version, value, now);
      const eventVersion = await nextEventVersion(transaction, tenant, 'workflow', workflowId);
      await appendEvent(
        transaction,
        {
          schemaVersion: 1,
          eventId: newSortableId(),
          eventName: 'workflow.state-changed.v1',
          tenant,
          aggregateType: 'workflow',
          aggregateId: workflowId,
          aggregateVersion: eventVersion,
          occurredAt: now,
          actor: { actorId: workflowId, type: 'system' },
          correlationId: workflowId,
          payload: { from: current.value.state, to: transition.to, action },
        },
        now,
      );
    });
  }

  private async transitionRoot(
    tenant: TenantRef,
    workflowId: Id,
    action: 'prepare' | 'start' | 'requestApproval' | 'approve',
  ): Promise<void> {
    const root = await this.requireRoot(tenant, workflowId);
    await this.transitionInvocation(tenant, root.id, action);
  }

  private async transitionInvocation(
    tenant: TenantRef,
    invocationId: Id,
    action:
      | 'prepare'
      | 'start'
      | 'requestApproval'
      | 'approve'
      | 'succeed'
      | 'block'
      | 'fail'
      | 'cancel',
  ): Promise<void> {
    await this.state.transaction(async (transaction) => {
      const current = await transaction.invocations.get(tenant, invocationId);
      if (!current) throw runtimeError('INVOCATION_INVALID_PARENT', 'Invocation is unavailable');
      const now = this.clock();
      if (
        current.value.state === 'succeeded' ||
        current.value.state === 'failed' ||
        current.value.state === 'blocked' ||
        current.value.state === 'cancelled'
      )
        return;
      const transitions: Record<
        string,
        { from: AgentInvocation['state'][]; to: AgentInvocation['state'] }
      > = {
        prepare: { from: ['created', 'blocked'], to: 'preparing' },
        start: { from: ['preparing'], to: 'running' },
        requestApproval: { from: ['preparing', 'running'], to: 'awaiting_approval' },
        approve: { from: ['awaiting_approval'], to: 'running' },
        succeed: { from: ['running', 'validating_report'], to: 'succeeded' },
        block: { from: ['running', 'validating_report'], to: 'blocked' },
        fail: {
          from: [
            'created',
            'preparing',
            'running',
            'awaiting_approval',
            'validating_report',
            'blocked',
          ],
          to: 'failed',
        },
        cancel: {
          from: [
            'created',
            'preparing',
            'running',
            'awaiting_approval',
            'validating_report',
            'blocked',
          ],
          to: 'cancelled',
        },
      };
      const selected = transitions[action];
      if (!selected) {
        throw runtimeError('VALIDATION_INVALID_INPUT', `Unsupported workflow action: ${action}`);
      }
      if (!selected.from.includes(current.value.state)) {
        throw runtimeError(
          'VALIDATION_INVALID_INPUT',
          `Invocation cannot transition from ${current.value.state}`,
        );
      }
      const value = { ...current.value, state: selected.to };
      await transaction.invocations.update(tenant, invocationId, current.version, value, now);
      await appendEvent(
        transaction,
        {
          schemaVersion: 1,
          eventId: newSortableId(),
          eventName: 'invocation.state-changed.v1',
          tenant,
          aggregateType: 'invocation',
          aggregateId: invocationId,
          aggregateVersion: current.version + 2,
          occurredAt: now,
          actor: actorForAgent(current.value.authority.subjectAgentId),
          correlationId: current.value.workflowId,
          payload: { from: current.value.state, to: selected.to, action },
        },
        now,
      );
    });
  }

  private async createChildInvocation(
    parent: VersionedAggregate<AgentInvocation>,
    registration: AgentRegistration,
    planRecord: LocalPlanRecord,
    kind: 'governance' | 'data-engineer',
    currentChildCount: number,
    governanceArtifact?: ArtifactReference,
  ): Promise<VersionedAggregate<AgentInvocation>> {
    const invocationId = newSortableId();
    const outputArtifactIds =
      kind === 'governance'
        ? [planRecord.outputArtifactIds.governanceDecision]
        : [
            planRecord.outputArtifactIds.qualityReport,
            planRecord.outputArtifactIds.validatedDataset,
          ];
    const sourceSelector = artifactSelector(planRecord.sourceArtifact);
    const governanceSelector = {
      kind: 'artifact' as const,
      id: planRecord.outputArtifactIds.governanceDecision,
      version: 1,
    };
    const outputSelectors = outputArtifactIds.map((id) => ({
      kind: 'artifact' as const,
      id,
      version: 1,
    }));
    const reads = kind === 'governance' ? [sourceSelector] : [sourceSelector, governanceSelector];
    const writes = outputSelectors;
    const authority = this.authority.issue({
      tenant: parent.value.tenant,
      workflowId: parent.value.workflowId,
      invocationId,
      issuer: actorForAgent(parent.value.authority.subjectAgentId),
      subjectAgentId: registration.agentId,
      tier: 1,
      harnessVersion: registration.version,
      permittedActions: ['artifact.read', 'artifact.write', 'report.create'],
      capabilities: registration.capabilities,
      resourceScopes: [...reads, ...writes],
      allowedArtifactReads: reads,
      allowedArtifactWrites: writes,
      allowedChildAgentTypes: [],
      maxChildCount: 0,
      toolOperations: [],
      issuedAt: this.clock(),
      expiresAt: new Date(Date.parse(this.clock()) + 30 * 60 * 1000).toISOString(),
    });
    const input: JsonValue = {
      sourceArtifact: planRecord.sourceArtifact as unknown as JsonValue,
      ...(governanceArtifact !== undefined
        ? { governanceArtifact: governanceArtifact as unknown as JsonValue }
        : {}),
      ...(kind === 'governance'
        ? {
            intendedUse: planRecord.payload.intendedUse,
            requestedAccessScopes: planRecord.payload.requestedAccessScopes,
            retentionDays: planRecord.payload.retentionDays,
          }
        : {}),
    };
    const child: AgentInvocation = {
      schemaVersion: 1,
      invocationId,
      workflowId: parent.value.workflowId,
      parentInvocationId: parent.value.invocationId,
      tenant: parent.value.tenant,
      tier: 1,
      agentType: registration.agentType,
      harnessVersion: registration.version,
      input,
      authority,
      resource: resourceEnvelope(),
      retry: retryEnvelope(),
      budget: budgetEnvelope(parent.value.budget.budgetId, kind === 'governance' ? 2_000 : 6_000),
      state: 'created',
      attempt: 0,
      createdAt: this.clock(),
      correlationId: parent.value.workflowId,
    };
    const request: InvocationCreateRequest = {
      parent: parent.value,
      child,
      registration,
      delegatingAuthority: parent.value.authority,
      currentChildCount,
      depth: 1,
      maxDepth: 1,
      now: this.clock(),
    };
    const created = await this.invocationService.create(request);
    await this.state.transaction(async (transaction) => {
      const workflow = await transaction.workflows.get(
        parent.value.tenant,
        parent.value.workflowId,
      );
      if (!workflow) throw runtimeError('ARTIFACT_NOT_FOUND', 'Workflow is unavailable');
      const value = {
        ...workflow.value,
        invocationIds: [...workflow.value.invocationIds, invocationId],
        updatedAt: this.clock(),
      };
      await transaction.workflows.update(
        parent.value.tenant,
        parent.value.workflowId,
        workflow.version,
        value,
        value.updatedAt,
      );
      const eventVersion = await nextEventVersion(
        transaction,
        parent.value.tenant,
        'workflow',
        parent.value.workflowId,
      );
      await appendEvent(
        transaction,
        {
          schemaVersion: 1,
          eventId: newSortableId(),
          eventName: 'workflow.invocation-added.v1',
          tenant: parent.value.tenant,
          aggregateType: 'workflow',
          aggregateId: parent.value.workflowId,
          aggregateVersion: eventVersion,
          occurredAt: value.updatedAt,
          actor: actorForAgent(parent.value.authority.subjectAgentId),
          correlationId: parent.value.workflowId,
          payload: { invocationId },
        },
        value.updatedAt,
      );
      await appendEvent(
        transaction,
        {
          schemaVersion: 1,
          eventId: newSortableId(),
          eventName: 'invocation.created.v1',
          tenant: parent.value.tenant,
          aggregateType: 'invocation',
          aggregateId: invocationId,
          aggregateVersion: 1,
          occurredAt: value.updatedAt,
          actor: actorForAgent(registration.agentId),
          correlationId: parent.value.workflowId,
          payload: { agentType: registration.agentType, tier: registration.tier },
        },
        value.updatedAt,
      );
    });
    return created;
  }

  private async finishInvocation(
    tenant: TenantRef,
    invocationId: Id,
    action: 'succeed' | 'block' | 'fail',
  ): Promise<void> {
    await this.transitionInvocation(tenant, invocationId, action);
  }

  private async finishRootAndWorkflow(
    tenant: TenantRef,
    workflowId: Id,
    action: 'succeed' | 'block' | 'fail' | 'cancel',
  ): Promise<void> {
    const root = await this.requireRoot(tenant, workflowId);
    if (
      root.value.state !== 'succeeded' &&
      root.value.state !== 'failed' &&
      root.value.state !== 'blocked' &&
      root.value.state !== 'cancelled'
    ) {
      await this.transitionInvocation(tenant, root.id, action);
    }
    const workflowAction = action === 'succeed' ? 'complete' : action;
    await this.transitionWorkflow(tenant, workflowId, workflowAction);
  }

  private async publishJson(
    tenant: TenantRef,
    artifactId: Id,
    value: JsonValue,
    actorId: Id,
    invocationId: Id,
    derivedFrom: ArtifactReference[],
    schemaName: string,
    workflowId: Id,
    stage: BeforePublishContext['stage'],
  ): Promise<ArtifactReference> {
    const sourceArtifact = derivedFrom[0];
    if (!sourceArtifact)
      throw runtimeError('ARTIFACT_NOT_FOUND', 'Artifact lineage source is missing');
    await this.beforePublish?.({ workflowId, stage, sourceArtifact });
    const currentSource = await this.artifacts.currentVersion(tenant, sourceArtifact.artifactId);
    if (!currentSource || currentSource.reference.version !== sourceArtifact.version) {
      throw runtimeError('CONCURRENCY_STALE_VERSION', 'Source artifact changed during validation');
    }
    const now = this.clock();
    const staged = await this.artifacts.stageUpload(
      tenant,
      JSON.stringify(value),
      'application/json',
      now,
    );
    const publication = await this.artifacts.publish({
      tenant,
      artifactId,
      stagedUploadId: staged.stagedUploadId,
      mediaType: 'application/json',
      createdBy: actorForAgent(actorId),
      invocationId,
      derivedFrom,
      schemaName,
      now,
    });
    return publication.record.reference;
  }

  private assertNotCancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted)
      throw runtimeError('COMPUTE_RESOURCE_UNAVAILABLE', 'Workflow was cancelled');
  }
}

export interface LocalTrainingSliceRequest {
  readonly tenant: TenantRef;
  readonly validatedDataset: ArtifactReference;
  readonly sourceRevision: string;
  readonly baseModel: string;
  readonly method: 'full_finetune' | 'lora' | 'prompt_tuning';
  readonly objective: string;
  readonly resources: {
    readonly cpuMillicores: number;
    readonly memoryBytes: number;
    readonly gpuCount: number;
  };
  readonly budgetLimitMinor: number;
  readonly currency: string;
  readonly authority: AgentInvocation['authority'];
  readonly approvalDigest: string;
  readonly approved: boolean;
  readonly now: string;
}

export interface LocalTrainingSliceResult {
  readonly strategy: ReturnType<MlEngineerSpecialist['proposeStrategy']>;
  readonly configs: ReturnType<MlEngineerSpecialist['generateCandidateConfigs']>;
  readonly run: TrainingWorkflowResult;
}

export class LocalTrainingSliceOrchestrator {
  private readonly mlEngineer: MlEngineerSpecialist;
  private readonly cluster: ClusterSpecialist;
  private readonly training: LocalTrainingSmokeWorkflow;

  constructor(
    options: {
      training?: LocalTrainingSmokeWorkflow;
      mlEngineer?: MlEngineerSpecialist;
      cluster?: ClusterSpecialist;
    } = {},
  ) {
    this.mlEngineer = options.mlEngineer ?? new MlEngineerSpecialist();
    this.cluster = options.cluster ?? new ClusterSpecialist();
    this.training = options.training ?? new LocalTrainingSmokeWorkflow();
  }

  async run(request: LocalTrainingSliceRequest): Promise<LocalTrainingSliceResult> {
    const strategy = this.mlEngineer.proposeStrategy({
      baseModel: request.baseModel,
      method: request.method,
      objective: request.objective,
      dataset: request.validatedDataset,
      resources: request.resources,
    });
    const configs = this.mlEngineer.generateCandidateConfigs(strategy, request.resources);
    const run = await this.training.run({
      tenant: request.tenant,
      validatedDataset: request.validatedDataset,
      sourceRevision: request.sourceRevision,
      configs,
      budgetLimitMinor: request.budgetLimitMinor,
      currency: request.currency,
      clusterGrantFor: (offer: import('@agentic-platform/backends').ComputeOffer) =>
        this.cluster.createAllocationGrant({
          offer,
          tenant: request.tenant,
          authority: request.authority,
          approvalDigest: request.approvalDigest,
          budgetId: request.authority.workflowId,
          approved: request.approved,
          now: request.now,
        }),
    });
    return { strategy, configs, run };
  }
}

export interface LocalModelLifecycleRequest {
  readonly workflowId: Id;
  readonly training: LocalTrainingSliceRequest;
  readonly modelName: string;
  readonly baseline: ArtifactReference;
  readonly benchmark: ArtifactReference;
  readonly evaluationArtifact: ArtifactReference;
  readonly environmentSnapshot: ArtifactReference;
  readonly originalDataLineage: readonly ArtifactReference[];
  readonly candidateMetric: number;
  readonly baselineMetric: number;
  readonly safetyRegression: boolean;
  readonly candidateSamples?: readonly number[];
  readonly baselineSamples?: readonly number[];
  readonly minimumSampleSize?: number;
  readonly modelApprovalDigest: string;
  readonly commitModelApprovalDigest: string;
  readonly policyApproved: boolean;
  readonly trafficGrant: TrafficGrant;
  readonly injectCanaryFailure?: boolean;
}

export interface LocalModelLifecycleResult {
  readonly status: 'succeeded' | 'rolled_back';
  readonly training: LocalTrainingSliceResult;
  readonly experimentRun: RunHandle;
  readonly evaluation: EvaluationResult;
  readonly model: ModelVersion;
  readonly deployment: DeploymentRecord;
  readonly rollback?: DeploymentRecord;
  readonly report: LocalModelLifecycleReport;
}

export interface LocalModelLifecycleReport {
  readonly schemaVersion: 1;
  readonly artifacts: {
    readonly checkpoint: ArtifactReference;
    readonly validatedDataset: ArtifactReference;
    readonly baseline: ArtifactReference;
    readonly benchmark: ArtifactReference;
    readonly evaluation: ArtifactReference;
    readonly environmentSnapshot: ArtifactReference;
    readonly originalDataLineage: readonly ArtifactReference[];
  };
  readonly metrics: {
    readonly selectedTrainingMetric: number;
    readonly candidateMetric: number;
    readonly baselineMetric: number;
    readonly delta: number;
    readonly recommendation: EvaluationResult['recommendation'];
  };
  readonly cost: {
    readonly currency: string;
    readonly budgetLimitMinor: number;
    readonly estimatedCostMinor: number;
    readonly actualCostMinor: number;
    readonly reconciled: boolean;
  };
  readonly rollout: {
    readonly status: 'succeeded' | 'rolled_back';
    readonly deploymentId: Id;
    readonly state: DeploymentRecord['state'];
    readonly trafficPercent: number;
    readonly rollbackDeploymentId?: Id;
    readonly rollbackState?: DeploymentRecord['state'];
  };
}

type LocalModelRegistry = Pick<InMemoryModelRegistry, 'publish'>;
type LocalDeploymentController = Pick<
  InMemoryDeploymentController,
  'request' | 'advance' | 'observeHealth' | 'automaticRollbackIfUnhealthy'
>;

export interface LocalModelLifecycleOptions {
  readonly training?: LocalTrainingSliceOrchestrator;
  readonly experiment?: ExperimentBackend;
  readonly modelRegistry?: LocalModelRegistry;
  readonly deploymentController?: LocalDeploymentController;
  readonly evaluator?: EvalSpecialist;
}

/**
 * Provider-neutral local composition for the Phase 9 model path. Hosted adapters
 * can replace each injected port without changing the lifecycle ordering or its
 * approval/lineage checks.
 */
export class LocalModelLifecycleOrchestrator {
  private readonly training: LocalTrainingSliceOrchestrator;
  private readonly experiment: ExperimentBackend;
  private readonly modelRegistry: LocalModelRegistry;
  private readonly deploymentController: LocalDeploymentController;
  private readonly evaluator: EvalSpecialist;

  constructor(options: LocalModelLifecycleOptions = {}) {
    this.training = options.training ?? new LocalTrainingSliceOrchestrator();
    this.experiment = options.experiment ?? new InMemoryExperimentBackend();
    this.modelRegistry = options.modelRegistry ?? new InMemoryModelRegistry();
    this.deploymentController = options.deploymentController ?? new InMemoryDeploymentController();
    this.evaluator = options.evaluator ?? new EvalSpecialist();
  }

  async run(request: LocalModelLifecycleRequest): Promise<LocalModelLifecycleResult> {
    const training = await this.training.run(request.training);
    const checkpoint = training.run.checkpoint;
    if (training.run.summary.status !== 'succeeded' || checkpoint === undefined) {
      throw runtimeError(
        'COMPUTE_RESOURCE_UNAVAILABLE',
        'Model lifecycle requires a successful training run and checkpoint',
      );
    }

    const experimentRun = await this.experiment.createRun({
      tenant: request.training.tenant,
      workflowId: request.workflowId,
      name: `training:${request.modelName}`,
      sourceRevision: request.training.sourceRevision,
      dataset: request.training.validatedDataset,
    });
    await this.experiment.logMetric(experimentRun, {
      metricId: newSortableId(),
      name: 'smoke_metric',
      value: request.candidateMetric,
      unit: 'ratio',
      observedAt: request.training.now,
    });
    await this.experiment.logArtifact(experimentRun, checkpoint);
    const registeredCheckpoint = await this.experiment.registerCheckpoint(
      experimentRun,
      checkpoint,
    );

    const evaluation = this.evaluator.evaluate({
      candidate: registeredCheckpoint.artifact,
      baseline: request.baseline,
      benchmark: request.benchmark,
      candidateMetric: request.candidateMetric,
      baselineMetric: request.baselineMetric,
      safetyRegression: request.safetyRegression,
      ...(request.candidateSamples !== undefined
        ? { candidateSamples: request.candidateSamples }
        : {}),
      ...(request.baselineSamples !== undefined
        ? { baselineSamples: request.baselineSamples }
        : {}),
      ...(request.minimumSampleSize !== undefined
        ? { minimumSampleSize: request.minimumSampleSize }
        : {}),
    });
    if (evaluation.recommendation !== 'promote') {
      throw runtimeError(
        'POLICY_DENIED',
        `Independent evaluation recommendation was ${evaluation.recommendation}`,
      );
    }

    const selectedConfiguration = training.configs.find(
      (config) => config.configId === training.run.summary.selectedConfigId,
    );
    if (selectedConfiguration === undefined) {
      throw runtimeError(
        'VALIDATION_SCHEMA_MISMATCH',
        'Training result does not identify a published configuration',
      );
    }

    const model = this.modelRegistry.publish({
      tenant: request.training.tenant,
      modelName: request.modelName,
      candidateArtifact: registeredCheckpoint.artifact,
      lineage: {
        checkpoint: registeredCheckpoint.artifact,
        trainingRun: {
          run: experimentRun,
          configuration: selectedConfiguration,
          sourceRevision: request.training.sourceRevision,
          environmentSnapshot: request.environmentSnapshot,
        },
        validatedDataset: request.training.validatedDataset,
        originalDataLineage: request.originalDataLineage,
      },
      evaluation: {
        recommendation: evaluation.recommendation,
        evaluationArtifact: request.evaluationArtifact,
      },
      policyApproved: request.policyApproved,
      approvalDigest: request.modelApprovalDigest,
      commitApprovalDigest: request.commitModelApprovalDigest,
    });
    const requested = this.deploymentController.request(request.training.tenant, model);
    await this.deploymentController.advance(
      request.training.tenant,
      requested.deploymentId,
      'provision',
    );
    await this.deploymentController.advance(
      request.training.tenant,
      requested.deploymentId,
      'smokePass',
    );
    const canary = await this.deploymentController.advance(
      request.training.tenant,
      requested.deploymentId,
      'startCanary',
      request.trafficGrant,
    );
    if (!request.injectCanaryFailure) {
      const report = reconcileModelLifecycle({
        request,
        training,
        checkpoint,
        evaluation,
        deployment: canary,
      });
      return {
        status: 'succeeded',
        training,
        experimentRun,
        evaluation,
        model,
        deployment: canary,
        report,
      };
    }

    await this.deploymentController.observeHealth(
      request.training.tenant,
      requested.deploymentId,
      false,
    );
    const rollback = await this.deploymentController.automaticRollbackIfUnhealthy(
      request.training.tenant,
      requested.deploymentId,
      request.trafficGrant,
    );
    const report = reconcileModelLifecycle({
      request,
      training,
      checkpoint,
      evaluation,
      deployment: canary,
      rollback,
    });
    return {
      status: 'rolled_back',
      training,
      experimentRun,
      evaluation,
      model,
      deployment: canary,
      rollback,
      report,
    };
  }
}

function reconcileModelLifecycle(input: {
  readonly request: LocalModelLifecycleRequest;
  readonly training: LocalTrainingSliceResult;
  readonly checkpoint: ArtifactReference;
  readonly evaluation: EvaluationResult;
  readonly deployment: DeploymentRecord;
  readonly rollback?: DeploymentRecord;
}): LocalModelLifecycleReport {
  const trainingSummary = input.training.run.summary;
  const selectedMetric = trainingSummary.metrics['smoke_metric'] ?? 0;
  const candidateActualCost = input.training.run.candidateRuns.reduce(
    (total, candidate) => total + candidate.summary.actualCostMinor,
    0,
  );
  return {
    schemaVersion: 1,
    artifacts: {
      checkpoint: input.checkpoint,
      validatedDataset: input.request.training.validatedDataset,
      baseline: input.request.baseline,
      benchmark: input.request.benchmark,
      evaluation: input.request.evaluationArtifact,
      environmentSnapshot: input.request.environmentSnapshot,
      originalDataLineage: [...input.request.originalDataLineage],
    },
    metrics: {
      selectedTrainingMetric: selectedMetric,
      candidateMetric: input.request.candidateMetric,
      baselineMetric: input.request.baselineMetric,
      delta: input.evaluation.metricDelta,
      recommendation: input.evaluation.recommendation,
    },
    cost: {
      currency: input.request.training.currency,
      budgetLimitMinor: input.request.training.budgetLimitMinor,
      estimatedCostMinor: trainingSummary.estimatedCostMinor,
      actualCostMinor: trainingSummary.actualCostMinor,
      reconciled:
        trainingSummary.actualCostMinor === trainingSummary.costMinor &&
        candidateActualCost === trainingSummary.actualCostMinor,
    },
    rollout: {
      status: input.rollback === undefined ? 'succeeded' : 'rolled_back',
      deploymentId: input.deployment.deploymentId,
      state: input.deployment.state,
      trafficPercent: input.deployment.trafficPercent,
      ...(input.rollback === undefined
        ? {}
        : {
            rollbackDeploymentId: input.rollback.deploymentId,
            rollbackState: input.rollback.state,
          }),
    },
  };
}

export interface LocalConnectorPublicationInput {
  readonly tenant: TenantRef;
  readonly sourceArtifact: ArtifactReference;
  readonly connectorName: string;
  readonly specification: JsonValue;
  readonly requestedScopes: readonly string[];
  readonly source: string;
  readonly authorAgentId: Id;
  readonly publisherAgentId: Id;
  readonly governanceApproved: boolean;
  readonly humanApproved: boolean;
}

export interface LocalConnectorPublicationRequest extends LocalConnectorPublicationInput {
  readonly approvalDigest: HashSha256;
  readonly commitApprovalDigest: HashSha256;
}

export interface ConnectorContractTestResult {
  readonly passed: boolean;
  readonly evidenceDigest: HashSha256;
}

export interface ConnectorContractTestRunner {
  run(
    build: ConnectorBuildResult,
  ): Promise<ConnectorContractTestResult> | ConnectorContractTestResult;
}

export class DeterministicConnectorContractTestRunner implements ConnectorContractTestRunner {
  run(build: ConnectorBuildResult): ConnectorContractTestResult {
    const expectedTests = [
      '// Generated deterministic contract-test plan.',
      ...build.toolSchemas.map(
        (schema) => `assertToolSchema(${JSON.stringify(schema.name)}, toolSchemas);`,
      ),
    ].join('\n');
    const passed =
      build.scan.valid &&
      build.toolSchemas.length > 0 &&
      build.generatedTests === expectedTests &&
      build.generatedSource.includes('toolSchemas');
    return {
      passed,
      evidenceDigest: sha256Digest({
        schemaVersion: 1,
        sourceHash: build.sourceHash,
        generatedSource: build.generatedSource,
        generatedTests: build.generatedTests,
        packageManifest: build.packageManifest,
        passed,
      }),
    };
  }
}

export interface PreparedConnectorPublication {
  readonly build: ConnectorBuildResult;
  readonly contractTests: ConnectorContractTestResult;
  readonly material: ConnectorPublicationMaterial;
  readonly publicationDigest: HashSha256;
}

export interface LocalConnectorPublicationResult extends PreparedConnectorPublication {
  readonly connector: ConnectorPackage;
}

export interface LocalConnectorPublicationOptions {
  readonly specialist?: ConnectorSpecialist;
  readonly contractTests?: ConnectorContractTestRunner;
  readonly publication?: ConnectorPublicationWorkflow;
}

/**
 * Provider-neutral local composition for the Phase 10 connector path. The source and resolved
 * specification are rebuilt deterministically, then a separate contract-test port produces
 * verification evidence before the approval-bound registry action can be performed.
 */
export class LocalConnectorPublicationOrchestrator {
  private readonly specialist: ConnectorSpecialist;
  private readonly contractTests: ConnectorContractTestRunner;
  private readonly publication: ConnectorPublicationWorkflow;

  constructor(options: LocalConnectorPublicationOptions = {}) {
    this.specialist = options.specialist ?? new ConnectorSpecialist();
    this.contractTests = options.contractTests ?? new DeterministicConnectorContractTestRunner();
    this.publication = options.publication ?? new ConnectorPublicationWorkflow();
  }

  async prepare(request: LocalConnectorPublicationInput): Promise<PreparedConnectorPublication> {
    const build = this.specialist.build({
      connectorName: request.connectorName,
      specification: request.specification,
      requestedScopes: request.requestedScopes,
      source: request.source,
    });
    const contractTests = await this.contractTests.run(build);
    const material: ConnectorPublicationMaterial = {
      tenant: request.tenant,
      name: request.connectorName,
      sourceArtifact: request.sourceArtifact,
      authorAgentId: request.authorAgentId,
      publisherAgentId: request.publisherAgentId,
      sourceHash: build.sourceHash,
      scopeDigest: build.scopeDigest,
      packageDigest: sha256Digest({
        packageManifest: build.packageManifest,
        generatedSource: build.generatedSource,
        toolSchemas: build.toolSchemas,
      }),
      verificationDigest: sha256Digest({
        sourceHash: build.sourceHash,
        contractTests,
      }),
      scansPassed: build.scan.valid,
      contractTestsPassed: contractTests.passed,
    };
    return {
      build,
      contractTests,
      material,
      publicationDigest: connectorPublicationDigest(material),
    };
  }

  async publish(
    request: LocalConnectorPublicationRequest,
  ): Promise<LocalConnectorPublicationResult> {
    const prepared = await this.prepare(request);
    const connector = this.publication.publish({
      material: prepared.material,
      authorAgentId: request.authorAgentId,
      publisherAgentId: request.publisherAgentId,
      governanceApproved: request.governanceApproved,
      humanApproved: request.humanApproved,
      approvalDigest: request.approvalDigest,
      commitApprovalDigest: request.commitApprovalDigest,
    });
    return { ...prepared, connector };
  }
}
