import {
  makeMoney,
  newSortableId,
  isId,
  runtimeError,
  type AgentEvent,
  type AgentEstimate,
  type AgentInvocation,
  type AgentInterface,
  type AgentPermissionRequest,
  type AgentRecommendation,
  type AgentRequest,
  type AgentResponse,
  type AgentSession,
  type AgentSessionContext,
  type AgentSessionMode,
  type AgentSessionState,
  type Actor,
  type ExecutionPlan,
  type Id,
  type JsonValue,
  type Run,
  type RunAttempt,
  type RunState,
  type RuntimeEvent,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import {
  AuthorityService,
  PolicyDecisionService,
  sha256Digest,
  type GovernanceApprovalContextV1,
  type GovernanceService,
  type GovernanceUsageCategory,
  type PolicyDecision,
} from '@agentic-platform/policy';
import type { StateStore, StoredEvent } from '@agentic-platform/state';
import type { ProviderRuntimeServices } from '@agentic-platform/provider-runtime';
import { createExecutionRequest } from '@agentic-platform/local-api';
import type {
  ConversationMessage,
  ConversationRunDetail,
  ConversationRunLog,
  ConversationSendInput,
  ConversationService,
  ConversationSnapshot,
  ConversationTurnAccepted,
  AgentSessionSnapshot,
} from '@agentic-platform/local-api';

interface ConversationRuntime {
  streamEvents(input: JsonValue, signal?: AbortSignal): AsyncIterable<ConversationRuntimeEvent>;
  dispose(): Promise<void>;
}

export interface ConversationAgentAdapter {
  createRuntime(
    invocation: AgentInvocation,
    options?: { model?: unknown },
  ): Promise<ConversationRuntime>;
}

interface ProviderRequest {
  readonly requestId: Id;
  readonly model: string;
  readonly input: JsonValue;
  readonly maxTokens: number;
  readonly signal?: AbortSignal;
}

interface ProviderEvent {
  readonly type: 'delta' | 'usage' | 'completed';
  readonly value?: JsonValue;
  readonly output?: JsonValue;
  readonly usage?: unknown;
}

interface ProviderLike {
  readonly providerId: string;
  readonly model: string;
  stream?(
    request: ProviderRequest,
  ): AsyncIterable<ProviderEvent> | Promise<AsyncIterable<ProviderEvent>>;
  complete?(request: ProviderRequest): Promise<{
    readonly output: JsonValue;
    readonly usage?: unknown;
  }>;
}

interface ProviderSelection {
  readonly selected: { readonly providerId: string; readonly modelId: string };
  readonly providers: readonly ProviderLike[];
}

export interface LocalProjectConversationOptions {
  readonly organizationId?: Id;
  readonly enforcementMode?: 'personal_local' | 'organization';
  readonly policy?: PolicyDecisionService;
  readonly governance?: GovernanceService;
}

type ConversationRuntimeEvent =
  | { readonly type: 'output'; readonly value: JsonValue }
  | {
      readonly type: 'tool_call';
      readonly toolName: string;
      readonly operation: string;
      readonly input: JsonValue;
    }
  | { readonly type: 'usage'; readonly usage: JsonValue }
  | { readonly type: 'completed'; readonly output?: JsonValue };

interface ActiveTurn {
  readonly controller: AbortController;
  readonly request: AgentRequest;
  readonly response: AgentResponse;
  readonly assistantMessageId: Id;
  readonly projectId: Id;
  readonly actor: Actor;
  readonly correlationId: Id;
  readonly runId: Id;
  readonly attemptId: Id;
  readonly modelOverride?: { readonly providerId: string; readonly modelId: string };
  readonly governanceApprovalContext?: GovernanceApprovalContextV1;
  readonly invocation?: AgentInvocation;
  cancelled: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function eventPayload(event: StoredEvent): Record<string, unknown> {
  return record(event.event.payload);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function textValue(value: JsonValue | undefined): string {
  if (typeof value === 'string') return value;
  if (value !== undefined && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const text = value['text'];
    if (typeof text === 'string') return text;
    const output = value['output'];
    if (typeof output === 'string') return output;
  }
  return value === undefined ? '' : JSON.stringify(value);
}

function usageCost(value: JsonValue | undefined): Run['cost'] | undefined {
  const usage = record(value);
  const cost = record(usage['cost']);
  return typeof cost['amountMinor'] === 'number' && typeof cost['currency'] === 'string'
    ? (cost as unknown as Run['cost'])
    : undefined;
}

function systemActor(tenant: TenantRef): Actor {
  return { actorId: tenant.tenantId, type: 'system', displayName: 'Platform' };
}

function messageFrom(value: unknown): ConversationMessage | undefined {
  const candidate = record(value);
  if (
    typeof candidate['messageId'] !== 'string' ||
    typeof candidate['conversationId'] !== 'string' ||
    typeof candidate['projectId'] !== 'string' ||
    typeof candidate['role'] !== 'string' ||
    typeof candidate['state'] !== 'string' ||
    typeof candidate['text'] !== 'string' ||
    typeof candidate['createdAt'] !== 'string' ||
    typeof candidate['updatedAt'] !== 'string'
  ) {
    return undefined;
  }
  return candidate as unknown as ConversationMessage;
}

function sessionFrom(value: unknown): AgentSession | undefined {
  const candidate = record(value);
  if (
    typeof candidate['sessionId'] !== 'string' ||
    typeof candidate['workspaceId'] !== 'string' ||
    typeof candidate['sourceInterface'] !== 'string' ||
    typeof candidate['mode'] !== 'string' ||
    typeof candidate['state'] !== 'string' ||
    !Array.isArray(candidate['requestIds']) ||
    typeof candidate['createdAt'] !== 'string' ||
    typeof candidate['updatedAt'] !== 'string'
  ) {
    return undefined;
  }
  return candidate as unknown as AgentSession;
}

function requestFrom(value: unknown): AgentRequest | undefined {
  const candidate = record(value);
  if (
    typeof candidate['requestId'] !== 'string' ||
    typeof candidate['sessionId'] !== 'string' ||
    typeof candidate['workspaceId'] !== 'string' ||
    typeof candidate['actor'] !== 'object' ||
    candidate['actor'] === null ||
    typeof candidate['text'] !== 'string' ||
    typeof candidate['createdAt'] !== 'string' ||
    typeof candidate['correlationId'] !== 'string'
  ) {
    return undefined;
  }
  return candidate as unknown as AgentRequest;
}

function agentEventFrom(value: unknown): AgentEvent | undefined {
  const candidate = record(value);
  if (
    typeof candidate['eventId'] !== 'string' ||
    typeof candidate['sessionId'] !== 'string' ||
    typeof candidate['requestId'] !== 'string' ||
    typeof candidate['sequence'] !== 'number' ||
    typeof candidate['kind'] !== 'string' ||
    typeof candidate['occurredAt'] !== 'string' ||
    typeof candidate['correlationId'] !== 'string'
  ) {
    return undefined;
  }
  return candidate as unknown as AgentEvent;
}

function permissionFrom(value: unknown): AgentPermissionRequest | undefined {
  const candidate = record(value);
  if (
    typeof candidate['permissionRequestId'] !== 'string' ||
    typeof candidate['sessionId'] !== 'string' ||
    typeof candidate['requestId'] !== 'string' ||
    typeof candidate['kind'] !== 'string' ||
    typeof candidate['action'] !== 'string' ||
    typeof candidate['reason'] !== 'string' ||
    !Array.isArray(candidate['resources']) ||
    typeof candidate['state'] !== 'string' ||
    typeof candidate['requestedAt'] !== 'string'
  ) {
    return undefined;
  }
  return candidate as unknown as AgentPermissionRequest;
}

function responseFrom(value: unknown): AgentResponse | undefined {
  const candidate = record(value);
  if (
    typeof candidate['responseId'] !== 'string' ||
    typeof candidate['sessionId'] !== 'string' ||
    typeof candidate['requestId'] !== 'string' ||
    typeof candidate['state'] !== 'string' ||
    typeof candidate['recommendation'] !== 'object' ||
    candidate['recommendation'] === null ||
    typeof candidate['plan'] !== 'object' ||
    candidate['plan'] === null ||
    typeof candidate['estimate'] !== 'object' ||
    candidate['estimate'] === null ||
    !Array.isArray(candidate['artifacts']) ||
    typeof candidate['createdAt'] !== 'string'
  ) {
    return undefined;
  }
  return candidate as unknown as AgentResponse;
}

function latestAgentSequence(events: readonly StoredEvent[]): number {
  return events.reduce((sequence, stored) => {
    const event = agentEventFrom(eventPayload(stored)['agentEvent']);
    return event === undefined ? sequence : Math.max(sequence, event.sequence);
  }, 0);
}

function latestVersion(
  events: readonly StoredEvent[],
  aggregateType: string,
  aggregateId: Id,
): number {
  return events.reduce(
    (version, stored) =>
      stored.event.aggregateType === aggregateType && stored.event.aggregateId === aggregateId
        ? Math.max(version, stored.event.aggregateVersion)
        : version,
    0,
  );
}

function latestLinkedRunId(events: readonly StoredEvent[], runId: Id): Id | undefined {
  const linked = events
    .filter(
      (stored) =>
        stored.event.aggregateType === 'run' &&
        stored.event.aggregateId === runId &&
        stored.event.eventName === 'run.action-linked.v1',
    )
    .at(-1);
  const operationRunId = record(linked?.event.payload)['operationRunId'];
  return typeof operationRunId === 'string' ? (operationRunId as Id) : undefined;
}

const RUN_STATES: readonly RunState[] = [
  'draft',
  'validating',
  'awaiting_configuration',
  'awaiting_approval',
  'queued',
  'provisioning',
  'running',
  'finalizing',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'partially_succeeded',
];

function runState(value: unknown, fallback: RunState): RunState {
  return RUN_STATES.includes(value as RunState) ? (value as RunState) : fallback;
}

function terminalRunState(state: RunState): boolean {
  return (
    state === 'succeeded' ||
    state === 'failed' ||
    state === 'cancelled' ||
    state === 'timed_out' ||
    state === 'partially_succeeded'
  );
}

function failureRecord(error: unknown, occurredAt: string) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    failureId: newSortableId(),
    code: error instanceof Error && 'code' in error ? String(error.code) : 'RUN_FAILED',
    message: message.slice(0, 1000),
    retryable: true,
    occurredAt,
  };
}

function toolRequiresApproval(toolName: string, operation: string): boolean {
  return /(?:write|delete|remove|publish|deploy|execute|send|update|create|commit|push|merge|secret|external)/i.test(
    `${toolName}.${operation}`,
  );
}

function usageAmount(usage: JsonValue | undefined): ReturnType<typeof makeMoney> {
  const input = record(usage);
  const cost = record(input['cost']);
  const amountCandidate = cost['amountMinor'] ?? input['costMinor'] ?? input['amountMinor'];
  const currencyCandidate = cost['currency'] ?? input['currency'];
  const amountMinor =
    typeof amountCandidate === 'number' &&
    Number.isSafeInteger(amountCandidate) &&
    amountCandidate >= 0
      ? amountCandidate
      : 0;
  const currency =
    typeof currencyCandidate === 'string' && /^[A-Z]{3}$/.test(currencyCandidate)
      ? currencyCandidate
      : 'USD';
  return makeMoney(amountMinor, currency);
}

function usageQuantity(usage: JsonValue | undefined): number | undefined {
  const input = record(usage);
  const value = input['totalTokens'] ?? input['tokens'] ?? input['quantity'];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export class LocalProjectConversationService implements ConversationService {
  private readonly active = new Map<string, ActiveTurn>();
  private readonly organizationId: Id | undefined;
  private readonly policy: PolicyDecisionService | undefined;
  private readonly governance: GovernanceService | undefined;

  constructor(
    private readonly state: StateStore,
    private readonly providerRuntime: ProviderRuntimeServices,
    private readonly clock = () => new Date().toISOString(),
    private readonly agentAdapter?: ConversationAgentAdapter,
    private readonly authority?: AuthorityService,
    options: LocalProjectConversationOptions = {},
  ) {
    this.organizationId = options.organizationId;
    this.governance = options.governance;
    this.policy =
      options.policy ??
      (authority === undefined
        ? undefined
        : new PolicyDecisionService({
            authority,
            enforcementMode: options.enforcementMode ?? 'organization',
          }));
  }

  private governedRunInput(
    tenant: TenantRef,
    projectId: Id,
    actor: Actor,
    runId: Id,
    interfaceName: AgentInterface,
    providerId?: string,
    estimatedCost?: ReturnType<typeof makeMoney>,
  ) {
    if (this.organizationId === undefined || this.governance === undefined) return undefined;
    return {
      tenant,
      organizationId: this.organizationId,
      workspaceId: tenant.workspaceId,
      projectId,
      actor,
      action: 'run.execute',
      target: [{ kind: 'workspace' as const, id: tenant.workspaceId }],
      dataClassification: 'internal' as const,
      ...(estimatedCost === undefined ? {} : { estimatedCost }),
      runId,
      interfaceName,
      ...(providerId === undefined ? {} : { providerId, runtimeName: providerId }),
      now: this.clock(),
    };
  }

  private enforceGovernedRun(
    tenant: TenantRef,
    projectId: Id,
    actor: Actor,
    runId: Id,
    interfaceName: AgentInterface,
    approvalContext: GovernanceApprovalContextV1 | undefined,
    providerId?: string,
  ): void {
    const input = this.governedRunInput(tenant, projectId, actor, runId, interfaceName, providerId);
    if (input === undefined || this.governance === undefined) return;
    const decision = this.governance.evaluate(input);
    const blocked = decision.outcome === 'blocked' || decision.outcome === 'denied';
    const missingApproval =
      decision.outcome === 'approval_required' && approvalContext === undefined;
    if (!blocked && !missingApproval) return;
    try {
      this.governance.commit({
        ...input,
        ...(approvalContext === undefined ? {} : { approvalContext }),
      });
    } catch {
      // commit records the denied/approval-required audit before returning the API error.
    }
    throw runtimeError(
      missingApproval ? 'APPROVAL_REQUIRED' : 'POLICY_DENIED',
      missingApproval
        ? 'Organization approval is required before this Run can start'
        : `Organization policy denied this Run (${decision.reasonCodes.join(', ')})`,
    );
  }

  private commitGovernedRun(
    tenant: TenantRef,
    projectId: Id,
    turn: ActiveTurn,
    providerId: string,
    state: 'succeeded' | 'failed',
    usage: JsonValue | undefined,
  ): void {
    const input = this.governedRunInput(
      tenant,
      projectId,
      turn.actor,
      turn.runId,
      turn.request.sourceInterface,
      providerId,
      usageAmount(usage),
    );
    if (input === undefined || this.governance === undefined) return;
    const quantity = usageQuantity(usage);
    this.governance.commit({
      ...input,
      before: { state: 'running', providerId },
      after: { state, providerId },
      ...(turn.governanceApprovalContext === undefined
        ? {}
        : { approvalContext: turn.governanceApprovalContext }),
      usage: {
        category: 'llm' satisfies GovernanceUsageCategory,
        amount: usageAmount(usage),
        ...(quantity === undefined ? {} : { quantity }),
      },
    });
  }

  async readSession(tenant: TenantRef, sessionId: Id): Promise<AgentSessionSnapshot> {
    const events = (await this.eventsForTenant(tenant)).filter(
      (stored) =>
        stored.event.aggregateType === 'agent-session' && stored.event.aggregateId === sessionId,
    );
    let session: AgentSession | undefined;
    const requests = new Map<string, AgentRequest>();
    const agentEvents = new Map<string, AgentEvent>();
    const permissions = new Map<string, AgentPermissionRequest>();
    const responses = new Map<string, AgentResponse>();
    for (const stored of events) {
      const payload = eventPayload(stored);
      const candidateSession = sessionFrom(payload['session']);
      if (candidateSession !== undefined) session = candidateSession;
      const request = requestFrom(payload['request']);
      if (request !== undefined) requests.set(String(request.requestId), request);
      const agentEvent = agentEventFrom(payload['agentEvent']);
      if (agentEvent !== undefined) agentEvents.set(String(agentEvent.eventId), agentEvent);
      const permission = permissionFrom(payload['permission']);
      if (permission !== undefined) {
        permissions.set(String(permission.permissionRequestId), permission);
      }
      const response = responseFrom(payload['response']);
      if (response !== undefined) responses.set(String(response.responseId), response);
    }
    if (session === undefined)
      throw runtimeError('ARTIFACT_NOT_FOUND', 'Agent session was not found');
    return {
      session: structuredClone(session),
      requests: [...requests.values()].sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      ),
      events: [...agentEvents.values()].sort((left, right) => left.sequence - right.sequence),
      permissions: [...permissions.values()].sort((left, right) =>
        left.requestedAt.localeCompare(right.requestedAt),
      ),
      responses: [...responses.values()].sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      ),
    };
  }

  async readProjectSession(tenant: TenantRef, projectId: Id): Promise<AgentSessionSnapshot> {
    await this.read(tenant, projectId);
    return this.readSession(tenant, projectId);
  }

  async read(tenant: TenantRef, projectId: Id): Promise<ConversationSnapshot> {
    const project = await this.state.transaction((transaction) =>
      transaction.projects.get(tenant, projectId),
    );
    if (project === undefined)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Project was not found');
    const conversationId = await this.ensureObjective(
      tenant,
      project.value.projectId,
      project.value.objective ?? project.value.name,
    );
    const snapshot = await this.snapshot(tenant, projectId, conversationId);
    const session = await this.readSession(tenant, conversationId);
    const latestResponse = session.responses.at(-1);
    return {
      ...snapshot,
      session: session.session,
      ...(latestResponse === undefined ? {} : { latestResponse }),
    };
  }

  async send(input: ConversationSendInput): Promise<ConversationTurnAccepted> {
    const text = input.text.trim();
    if (text.length === 0) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Agent request text is required');
    }
    const project = await this.state.transaction((transaction) =>
      transaction.projects.get(input.tenant, input.projectId),
    );
    if (project === undefined)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Project was not found');
    const sourceInterface: AgentInterface = input.sourceInterface ?? 'api';
    const correlationId = newSortableId();
    // Evaluate before creating the lazily initialized conversation so an unauthorized
    // organization actor cannot create even the objective/session seed event.
    this.enforceGovernedRun(
      input.tenant,
      input.projectId,
      input.actor,
      correlationId,
      sourceInterface,
      input.governanceApprovalContext,
      input.modelOverride?.providerId,
    );
    const conversationId = await this.ensureObjective(
      input.tenant,
      input.projectId,
      project.value.objective ?? project.value.name,
    );
    const existing = await this.snapshot(input.tenant, input.projectId, conversationId);
    const sessionState = await this.readSession(input.tenant, conversationId);
    const duplicate =
      input.clientMessageId === undefined
        ? undefined
        : existing.messages.find((message) => message.messageId === input.clientMessageId);
    if (duplicate !== undefined) {
      const duplicateRequest = sessionState.requests.find(
        (request) => request.clientMessageId === duplicate.messageId,
      );
      const duplicateResponse =
        duplicateRequest === undefined
          ? undefined
          : sessionState.responses.find(
              (response) => response.requestId === duplicateRequest.requestId,
            );
      const assistant = [...existing.messages]
        .reverse()
        .find(
          (message) =>
            message.role === 'assistant' && message.correlationId === duplicate.correlationId,
        );
      const assistantMessage =
        assistant ??
        [...existing.messages].find(
          (message) =>
            message.role === 'assistant' && message.correlationId === duplicate.correlationId,
        );
      if (assistantMessage !== undefined) {
        return {
          conversationId,
          projectId: input.projectId,
          ...(duplicateRequest === undefined ? {} : { sessionId: duplicateRequest.sessionId }),
          ...(duplicateRequest === undefined ? {} : { requestId: duplicateRequest.requestId }),
          ...(duplicateResponse === undefined ? {} : { response: duplicateResponse }),
          runId: duplicate.correlationId ?? conversationId,
          userMessageId: duplicate.messageId,
          assistantMessageId: assistantMessage.messageId,
          correlationId: duplicate.correlationId ?? conversationId,
          accepted: true,
        };
      }
    }
    if (this.active.has(String(conversationId))) {
      throw runtimeError('CONCURRENCY_STALE_VERSION', 'The project agent is already responding');
    }
    const now = this.clock();
    const userMessageId = input.clientMessageId ?? newSortableId();
    const assistantMessageId = newSortableId();
    const requestId = newSortableId();
    const attemptId = newSortableId();
    const mode: AgentSessionMode = 'conversation';
    const invocation = this.createInvocation(
      input.tenant,
      input.projectId,
      conversationId,
      text,
      input.actor,
      correlationId,
    );
    const context: AgentSessionContext = {
      workspaceId: input.tenant.workspaceId,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(this.organizationId === undefined ? {} : { organizationId: this.organizationId }),
      sourceInterface,
      mode,
      resources: sessionState.session.context.resources,
      values: {
        ...(sessionState.session.context.values ?? {}),
        requestTextLength: text.length,
      },
    };
    const request: AgentRequest = {
      schemaVersion: 1,
      requestId,
      sessionId: conversationId,
      tenant: input.tenant,
      workspaceId: input.tenant.workspaceId,
      projectId: input.projectId,
      ...(this.organizationId === undefined ? {} : { organizationId: this.organizationId }),
      actor: input.actor,
      sourceInterface,
      mode,
      context,
      text,
      ...(input.clientMessageId === undefined ? {} : { clientMessageId: input.clientMessageId }),
      ...(input.modelOverride === undefined ? {} : { modelOverride: input.modelOverride }),
      createdAt: now,
      correlationId,
    };
    const executionRequest = createExecutionRequest({
      runId: correlationId,
      tenant: input.tenant,
      actor: input.actor,
      projectId: input.projectId,
      sourceInterface,
      action: 'conversation.respond',
      clock: this.clock,
    });
    const recommendation: AgentRecommendation = {
      summary: 'Inspect the project context and prepare a bounded agent response.',
      actions: ['inspect context', 'prepare a typed plan', 'execute through the shared Run path'],
      rationale: [`Received a ${sourceInterface} request with ${text.length} characters.`],
      confidence: 0.5,
    };
    const planBase = {
      schemaVersion: 1 as const,
      planId: newSortableId(),
      workflowId: input.projectId,
      executionRequestId: executionRequest.executionRequestId,
      version: 1,
      steps: [
        {
          stepId: newSortableId(),
          tier: 0 as const,
          agentType: 'spyderbyte-agent',
          title: 'Understand and respond',
          description: 'Inspect the session context, apply policy, and execute the request.',
          dependsOn: [],
          inputArtifactIds: [],
          requiredCapabilities: ['context.read'],
          approvalRequired: false,
          expectedOutputs: ['typed agent response'],
          acceptanceCriteria: ['The response is persisted with a shared Run reference.'],
        },
      ],
      createdAt: now,
      ...(invocation === undefined ? {} : { createdByInvocationId: invocation.invocationId }),
    };
    const plan: ExecutionPlan = { ...planBase, digest: sha256Digest(planBase) };
    const estimate: AgentEstimate = {
      estimatedCost: makeMoney(0, 'USD'),
      estimatedDurationMs: 120_000,
      resourceClass: 'local-agent',
    };
    const run: Run = {
      schemaVersion: 1,
      runId: correlationId,
      tenant: input.tenant,
      projectId: input.projectId,
      requestedAction: 'conversation.respond',
      initiatingPrincipal: input.actor,
      sourceInterface: input.sourceInterface ?? 'api',
      ...(input.clientVersion === undefined ? {} : { clientVersion: input.clientVersion }),
      inputReferences: [],
      executionRequest,
      executionPlan: plan,
      state: 'queued',
      attemptIds: [attemptId],
      createdAt: now,
      updatedAt: now,
    };
    const response: AgentResponse = {
      schemaVersion: 1,
      responseId: newSortableId(),
      sessionId: conversationId,
      requestId,
      tenant: input.tenant,
      state: 'accepted',
      recommendation,
      plan,
      estimate,
      runId: correlationId,
      artifacts: [],
      nextAction: 'Wait for the agent Run to complete.',
      createdAt: now,
    };
    const session: AgentSession = {
      ...sessionState.session,
      user: input.actor,
      sourceInterface,
      context,
      mode,
      state: 'running',
      requestIds: [...new Set([...sessionState.session.requestIds, requestId])],
      currentRunId: correlationId,
      updatedAt: now,
    };
    const sequence = latestAgentSequence(
      (await this.eventsForTenant(input.tenant)).filter(
        (stored) =>
          stored.event.aggregateType === 'agent-session' &&
          stored.event.aggregateId === conversationId,
      ),
    );
    const agentEvent = (
      kind: AgentEvent['kind'],
      payload: JsonValue,
      offset: number,
    ): AgentEvent => ({
      schemaVersion: 1,
      eventId: newSortableId(),
      sessionId: conversationId,
      requestId,
      tenant: input.tenant,
      sequence: sequence + offset,
      kind,
      payload,
      occurredAt: now,
      correlationId,
    });
    const initialAgentEvents = [
      agentEvent('context_inspected', { context } as unknown as JsonValue, 1),
      agentEvent('recommendation_created', { recommendation } as unknown as JsonValue, 2),
      agentEvent('plan_created', { plan } as unknown as JsonValue, 3),
      agentEvent('estimate_created', { estimate } as unknown as JsonValue, 4),
      agentEvent('run_created', { runId: correlationId } as unknown as JsonValue, 5),
    ];
    const attempt: RunAttempt = {
      schemaVersion: 1,
      attemptId,
      runId: correlationId,
      tenant: input.tenant,
      attemptNumber: 1,
      executionRequestId: executionRequest.executionRequestId,
      state: 'queued',
      outputReferences: [],
    };
    const userMessage: ConversationMessage = {
      messageId: userMessageId,
      conversationId,
      projectId: input.projectId,
      role: 'user',
      state: 'completed',
      text: input.text.trim(),
      createdAt: now,
      updatedAt: now,
      correlationId,
    };
    const assistantMessage: ConversationMessage = {
      messageId: assistantMessageId,
      conversationId,
      projectId: input.projectId,
      role: 'assistant',
      state: 'streaming',
      text: '',
      createdAt: now,
      updatedAt: now,
      correlationId,
    };
    await this.append(
      input.tenant,
      conversationId,
      input.actor,
      [
        {
          eventName: 'chat.message-created.v1',
          payload: {
            projectId: input.projectId,
            message: { ...userMessage, text },
          } as unknown as JsonValue,
        },
        {
          eventName: 'chat.message-created.v1',
          payload: {
            projectId: input.projectId,
            message: assistantMessage,
          } as unknown as JsonValue,
        },
        {
          eventName: 'chat.run-started.v1',
          payload: {
            projectId: input.projectId,
            conversationId,
            userMessageId,
            assistantMessageId,
            correlationId,
            runId: correlationId,
          } as unknown as JsonValue,
        },
        {
          eventName: 'agent.request-created.v1',
          aggregateType: 'agent-session',
          aggregateId: conversationId,
          correlationId,
          payload: { request } as unknown as JsonValue,
        },
        {
          eventName: 'agent.session-updated.v1',
          aggregateType: 'agent-session',
          aggregateId: conversationId,
          correlationId,
          payload: { session } as unknown as JsonValue,
        },
        ...initialAgentEvents.map((event) => ({
          eventName: `agent.${event.kind.replaceAll('_', '-')}.v1`,
          aggregateType: 'agent-session',
          aggregateId: conversationId,
          correlationId,
          payload: { agentEvent: event } as unknown as JsonValue,
        })),
        {
          eventName: 'agent.response-created.v1',
          aggregateType: 'agent-session',
          aggregateId: conversationId,
          correlationId,
          payload: { response } as unknown as JsonValue,
        },
        {
          eventName: 'execution.requested.v1',
          aggregateType: 'run',
          aggregateId: correlationId,
          correlationId,
          payload: { request: executionRequest } as unknown as JsonValue,
        },
        {
          eventName: 'run.created.v1',
          aggregateType: 'run',
          aggregateId: correlationId,
          correlationId,
          payload: {
            run: run as unknown as JsonValue,
            projectId: input.projectId,
            conversationId,
            displayName: 'Conversation response',
            state: 'queued',
          } as unknown as JsonValue,
        },
        {
          eventName: 'run.plan-created.v1',
          aggregateType: 'run',
          aggregateId: correlationId,
          correlationId,
          payload: { plan } as unknown as JsonValue,
        },
        {
          eventName: 'run.attempt-created.v1',
          aggregateType: 'run',
          aggregateId: correlationId,
          correlationId,
          payload: { attempt: attempt as unknown as JsonValue } as unknown as JsonValue,
        },
      ],
      invocation,
    );
    const turn: ActiveTurn = {
      controller: new AbortController(),
      request,
      response,
      assistantMessageId,
      projectId: input.projectId,
      actor: input.actor,
      correlationId,
      runId: correlationId,
      attemptId,
      ...(input.modelOverride === undefined ? {} : { modelOverride: input.modelOverride }),
      ...(input.governanceApprovalContext === undefined
        ? {}
        : { governanceApprovalContext: input.governanceApprovalContext }),
      ...(invocation === undefined ? {} : { invocation }),
      cancelled: false,
    };
    this.active.set(String(conversationId), turn);
    void this.runTurn(input.tenant, input.projectId, conversationId, text, turn).catch(
      () => undefined,
    );
    return {
      conversationId,
      projectId: input.projectId,
      sessionId: conversationId,
      requestId,
      response,
      runId: correlationId,
      userMessageId,
      assistantMessageId,
      correlationId,
      accepted: true,
    };
  }

  async cancel(
    tenant: TenantRef,
    conversationId: Id,
    reason = 'cancelled by user',
  ): Promise<JsonValue> {
    const turn = this.active.get(String(conversationId));
    if (turn === undefined) return { conversationId, cancelled: false, status: 'already_terminal' };
    turn.cancelled = true;
    turn.controller.abort(reason);
    const now = this.clock();
    const sessionState = await this.readSession(tenant, conversationId);
    const cancelledResponse: AgentResponse = {
      ...turn.response,
      state: 'cancelled',
      explanation: 'The agent request was cancelled before completion.',
      nextAction: 'Submit a new request when ready.',
      completedAt: now,
    };
    const cancelledSession: AgentSession = {
      ...sessionState.session,
      state: 'active',
      updatedAt: now,
    };
    const cancelledEvent: AgentEvent = {
      schemaVersion: 1,
      eventId: newSortableId(),
      sessionId: conversationId,
      requestId: turn.request.requestId,
      tenant,
      sequence:
        latestAgentSequence(
          (await this.eventsForTenant(tenant)).filter(
            (stored) =>
              stored.event.aggregateType === 'agent-session' &&
              stored.event.aggregateId === conversationId,
          ),
        ) + 1,
      kind: 'cancelled',
      payload: { reason } as unknown as JsonValue,
      occurredAt: now,
      correlationId: turn.correlationId,
    };
    await this.append(tenant, conversationId, turn.actor, [
      {
        eventName: 'chat.run-cancelled.v1',
        payload: {
          conversationId,
          assistantMessageId: turn.assistantMessageId,
          reason,
        } as unknown as JsonValue,
      },
      {
        eventName: 'chat.message-completed.v1',
        payload: {
          message: {
            messageId: turn.assistantMessageId,
            conversationId,
            projectId: turn.projectId,
            role: 'assistant',
            state: 'cancelled',
            text: 'Agent response cancelled.',
            createdAt: this.clock(),
            updatedAt: this.clock(),
            correlationId: turn.correlationId,
          },
        } as unknown as JsonValue,
      },
      {
        eventName: 'run.status-changed.v1',
        aggregateType: 'run',
        aggregateId: turn.runId,
        correlationId: turn.runId,
        payload: {
          runId: turn.runId,
          projectId: turn.projectId,
          state: 'cancelled',
          completedAt: this.clock(),
          reason,
        } as unknown as JsonValue,
      },
      {
        eventName: 'run.attempt-completed.v1',
        aggregateType: 'run',
        aggregateId: turn.runId,
        correlationId: turn.runId,
        payload: {
          attemptId: turn.attemptId,
          runId: turn.runId,
          state: 'cancelled',
          completedAt: this.clock(),
          error: failureRecord(new Error(reason), this.clock()),
        } as unknown as JsonValue,
      },
      {
        eventName: 'run.cancelled.v1',
        aggregateType: 'run',
        aggregateId: turn.runId,
        correlationId: turn.runId,
        payload: { runId: turn.runId, state: 'cancelled', reason } as unknown as JsonValue,
      },
      {
        eventName: 'agent.session-updated.v1',
        aggregateType: 'agent-session',
        aggregateId: conversationId,
        correlationId: turn.correlationId,
        payload: { session: cancelledSession } as unknown as JsonValue,
      },
      {
        eventName: 'agent.response-updated.v1',
        aggregateType: 'agent-session',
        aggregateId: conversationId,
        correlationId: turn.correlationId,
        payload: { response: cancelledResponse } as unknown as JsonValue,
      },
      {
        eventName: 'agent.cancelled.v1',
        aggregateType: 'agent-session',
        aggregateId: conversationId,
        correlationId: turn.correlationId,
        payload: { agentEvent: cancelledEvent } as unknown as JsonValue,
      },
    ]);
    await this.updateInvocationState(tenant, turn.invocation?.invocationId, 'cancelled');
    return { conversationId, cancelled: true, status: 'cancel_requested' };
  }

  private async ensureObjective(tenant: TenantRef, projectId: Id, objective: string): Promise<Id> {
    const events = await this.eventsForTenant(tenant);
    const existingSession = events.find((stored) => {
      if (stored.event.aggregateType !== 'agent-session') return false;
      const payload = eventPayload(stored);
      const session = sessionFrom(payload['session']);
      return session?.projectId === projectId;
    });
    if (existingSession !== undefined) return existingSession.event.aggregateId;
    const existing = events.find((stored) => {
      const payload = eventPayload(stored);
      return (
        stored.event.eventName === 'chat.message-created.v1' && payload['projectId'] === projectId
      );
    });
    const existingMessage =
      existing === undefined ? undefined : messageFrom(eventPayload(existing)['message']);
    const conversationId = existingMessage?.conversationId ?? projectId;
    const now = this.clock();
    const context: AgentSessionContext = {
      workspaceId: tenant.workspaceId,
      projectId,
      ...(this.organizationId === undefined ? {} : { organizationId: this.organizationId }),
      sourceInterface: 'system',
      mode: 'conversation',
      resources: [],
    };
    const session: AgentSession = {
      schemaVersion: 1,
      sessionId: conversationId,
      tenant,
      workspaceId: tenant.workspaceId,
      projectId,
      ...(this.organizationId === undefined ? {} : { organizationId: this.organizationId }),
      user: systemActor(tenant),
      sourceInterface: 'system',
      context,
      mode: 'conversation',
      state: 'active',
      requestIds: [],
      createdAt: now,
      updatedAt: now,
    };
    const initialEvents: Array<{
      eventName: string;
      payload: JsonValue;
      aggregateType?: string;
      aggregateId?: Id;
      correlationId?: Id;
    }> = [
      {
        eventName: 'agent.session-created.v1',
        aggregateType: 'agent-session',
        aggregateId: conversationId,
        correlationId: conversationId,
        payload: { session } as unknown as JsonValue,
      },
    ];
    if (existingMessage === undefined) {
      const message: ConversationMessage = {
        messageId: newSortableId(),
        conversationId,
        projectId,
        role: 'user',
        state: 'completed',
        text: objective,
        createdAt: now,
        updatedAt: now,
      };
      initialEvents.push({
        eventName: 'chat.message-created.v1',
        payload: { projectId, message } as unknown as JsonValue,
      });
    }
    await this.append(tenant, conversationId, systemActor(tenant), initialEvents);
    return conversationId;
  }

  private async snapshot(
    tenant: TenantRef,
    projectId: Id,
    conversationId: Id,
  ): Promise<ConversationSnapshot> {
    const events = (await this.eventsForTenant(tenant)).filter(
      (stored) =>
        stored.event.aggregateType === 'conversation' &&
        stored.event.aggregateId === conversationId,
    );
    const messages = new Map<string, ConversationMessage>();
    let generating = false;
    let runId: Id | undefined;
    let updatedAt = this.clock();
    for (const stored of events) {
      const payload = eventPayload(stored);
      updatedAt = stored.event.occurredAt;
      if (stored.event.eventName === 'chat.message-created.v1') {
        const message = messageFrom(payload['message']);
        if (message !== undefined) messages.set(String(message.messageId), message);
      } else if (stored.event.eventName === 'chat.message-delta.v1') {
        const messageId = stringValue(payload['messageId']);
        const delta = stringValue(payload['delta']);
        const current = messageId === undefined ? undefined : messages.get(messageId);
        if (messageId !== undefined && current !== undefined && delta !== undefined) {
          messages.set(messageId, {
            ...current,
            state: 'streaming',
            text: current.text + delta,
            updatedAt: stored.event.occurredAt,
          });
        }
      } else if (stored.event.eventName === 'chat.message-completed.v1') {
        const complete = messageFrom(payload['message']);
        const messageId = stringValue(payload['messageId']) ?? complete?.messageId;
        const current = messageId === undefined ? undefined : messages.get(messageId);
        if (messageId !== undefined && current !== undefined) {
          messages.set(messageId, {
            ...current,
            ...(complete === undefined ? {} : complete),
            state: complete?.state ?? 'completed',
            updatedAt: stored.event.occurredAt,
          });
        }
      } else if (stored.event.eventName === 'chat.tool-activity.v1') {
        const toolName = stringValue(payload['toolName']);
        const toolOperation = stringValue(payload['toolOperation']);
        if (toolName !== undefined) {
          messages.set(String(stored.event.eventId), {
            messageId: stored.event.eventId,
            conversationId,
            projectId,
            role: 'tool',
            state: 'completed',
            text: `${toolName} · ${toolOperation ?? 'activity'}`,
            createdAt: stored.event.occurredAt,
            updatedAt: stored.event.occurredAt,
            toolName,
            ...(toolOperation === undefined ? {} : { toolOperation }),
          });
        }
      } else if (stored.event.eventName === 'chat.run-started.v1') {
        generating = true;
        const startedRunId = stringValue(payload['runId']) ?? stringValue(payload['correlationId']);
        if (startedRunId !== undefined && isId(startedRunId)) runId = startedRunId;
      } else if (
        stored.event.eventName === 'chat.run-cancelled.v1' ||
        stored.event.eventName === 'chat.run-completed.v1' ||
        stored.event.eventName === 'chat.run-failed.v1'
      ) {
        generating = false;
      }
    }
    return {
      conversationId,
      projectId,
      ...(runId === undefined ? {} : { runId }),
      messages: [...messages.values()].sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      ),
      generating,
      updatedAt,
    };
  }

  private async eventsForTenant(tenant: TenantRef): Promise<StoredEvent[]> {
    return this.state.transaction((transaction) => transaction.events.list(tenant, 0));
  }

  private async append(
    tenant: TenantRef,
    conversationId: Id,
    actor: Actor,
    events: readonly {
      eventName: string;
      payload: JsonValue;
      aggregateType?: string;
      aggregateId?: Id;
      correlationId?: Id;
    }[],
    invocation?: AgentInvocation,
  ): Promise<void> {
    await this.state.transaction(async (transaction) => {
      if (invocation !== undefined) {
        await transaction.invocations.create(
          tenant,
          invocation.invocationId,
          invocation,
          invocation.createdAt,
        );
      }
      const all = await transaction.events.all();
      const versions = new Map<string, number>();
      for (const item of events) {
        const aggregateType = item.aggregateType ?? 'conversation';
        const aggregateId = item.aggregateId ?? conversationId;
        const versionKey = `${aggregateType}:${aggregateId}`;
        const previousVersion =
          versions.get(versionKey) ?? latestVersion(all, aggregateType, aggregateId);
        const occurredAt = this.clock();
        const event: RuntimeEvent = {
          schemaVersion: 1,
          eventId: newSortableId(),
          eventName: item.eventName,
          tenant,
          aggregateType,
          aggregateId,
          aggregateVersion: previousVersion + 1,
          occurredAt,
          actor,
          correlationId: item.correlationId ?? conversationId,
          payload: item.payload,
        };
        const stored = await transaction.events.append(event, previousVersion);
        versions.set(versionKey, stored.event.aggregateVersion);
        await transaction.outbox.enqueue(stored.event, 'runtime.events', occurredAt);
      }
    });
  }

  private createInvocation(
    tenant: TenantRef,
    projectId: Id,
    conversationId: Id,
    text: string,
    actor: Actor,
    invocationId: Id,
  ): AgentInvocation | undefined {
    if (this.authority === undefined) return undefined;
    const now = this.clock();
    const authority = this.authority.issue({
      tenant,
      workflowId: projectId,
      invocationId,
      issuer: actor,
      subjectAgentId: invocationId,
      tier: 0,
      harnessVersion: 'spyderbyte-agent.v1',
      permittedActions: ['agent.request', 'conversation.respond', 'tool.use'],
      capabilities: ['agent-session', 'context.read', 'planning', 'tool-calling'],
      resourceScopes: [],
      allowedArtifactReads: [],
      allowedArtifactWrites: [],
      allowedChildAgentTypes: [],
      maxChildCount: 0,
      toolOperations: ['agent.*', 'conversation.*'],
      issuedAt: now,
    });
    return {
      schemaVersion: 1,
      invocationId,
      workflowId: projectId,
      tenant,
      tier: 0,
      agentType: 'spyderbyte-agent',
      harnessVersion: 'spyderbyte-agent.v1',
      input: { projectId, conversationId, instruction: text } as JsonValue,
      authority,
      resource: {
        limits: {
          cpuMillicores: 1000,
          memoryBytes: 512 * 1024 * 1024,
          wallTimeMs: 120_000,
          outputBytes: 4 * 1024 * 1024,
          storageBytes: 64 * 1024 * 1024,
          processCount: 1,
        },
        networkAllowlist: [],
        readOnlyArtifactMounts: true,
      },
      retry: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0, retryableErrorCodes: [] },
      budget: { budgetId: projectId, limit: 10_000, reserved: 0, consumed: 0, currency: 'USD' },
      state: 'created',
      attempt: 0,
      createdAt: now,
      correlationId: invocationId,
    };
  }

  private async updateInvocationState(
    tenant: TenantRef,
    invocationId: Id | undefined,
    state: AgentInvocation['state'],
  ): Promise<void> {
    if (invocationId === undefined) return;
    await this.state.transaction(async (transaction) => {
      const current = await transaction.invocations.get(tenant, invocationId);
      if (current === undefined || current.value.state === state) return;
      const now = this.clock();
      const value: AgentInvocation = {
        ...current.value,
        state,
        attempt: state === 'running' ? Math.max(current.value.attempt, 1) : current.value.attempt,
      };
      await transaction.invocations.update(tenant, invocationId, current.version, value, now);
      const all = await transaction.events.all();
      const version = latestVersion(all, 'invocation', invocationId);
      const event: RuntimeEvent = {
        schemaVersion: 1,
        eventId: newSortableId(),
        eventName: 'invocation.state-changed.v1',
        tenant,
        aggregateType: 'invocation',
        aggregateId: invocationId,
        aggregateVersion: version + 1,
        occurredAt: now,
        actor: systemActor(tenant),
        correlationId: value.correlationId,
        payload: { from: current.value.state, to: state, attempt: value.attempt },
      };
      const stored = await transaction.events.append(event, version);
      await transaction.outbox.enqueue(stored.event, 'runtime.events', now);
    });
  }

  async listRuns(tenant: TenantRef, projectId?: Id): Promise<readonly Run[]> {
    const events = await this.eventsForTenant(tenant);
    const runIds = [
      ...new Set(
        events
          .filter(
            (stored) =>
              stored.event.aggregateType === 'run' && stored.event.eventName === 'run.created.v1',
          )
          .map((stored) => stored.event.aggregateId),
      ),
    ];
    const details = await Promise.all(
      runIds.map((runId) => this.runDetailFromEvents(events, runId)),
    );
    return details
      .flatMap((detail) => (detail === undefined ? [] : [detail.run]))
      .filter((run) => projectId === undefined || run.projectId === projectId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async readRun(tenant: TenantRef, runId: Id): Promise<ConversationRunDetail> {
    const events = await this.eventsForTenant(tenant);
    const detail = await this.runDetailFromEvents(events, runId);
    if (detail === undefined) throw runtimeError('ARTIFACT_NOT_FOUND', 'Run was not found');
    const linkedRunId = latestLinkedRunId(events, runId);
    if (linkedRunId !== undefined && !terminalRunState(detail.run.state)) {
      await this.reconcileLinkedRetry(tenant, runId, linkedRunId, detail.run.initiatingPrincipal);
      const refreshed = await this.runDetailFromEvents(await this.eventsForTenant(tenant), runId);
      if (refreshed !== undefined) return refreshed;
    }
    return detail;
  }

  async retryRun(tenant: TenantRef, runId: Id, actor: Actor): Promise<ConversationTurnAccepted> {
    const detail = await this.readRun(tenant, runId);
    if (!['failed', 'cancelled', 'timed_out', 'partially_succeeded'].includes(detail.run.state)) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Only terminal failed runs can be retried');
    }
    if (detail.run.projectId === undefined)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Run is not attached to a project');
    const snapshot = await this.read(tenant, detail.run.projectId);
    const message = [...snapshot.messages]
      .reverse()
      .find((candidate) => candidate.role === 'user' && candidate.correlationId === runId);
    if (message === undefined)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'The original run request is unavailable');
    const retry = await this.send({
      tenant,
      projectId: detail.run.projectId,
      actor,
      text: message.text,
      sourceInterface: detail.run.sourceInterface,
      ...(detail.run.clientVersion === undefined
        ? {}
        : { clientVersion: detail.run.clientVersion }),
    });
    const attemptId = newSortableId();
    const attemptNumber =
      Math.max(0, ...detail.attempts.map((attempt) => attempt.attemptNumber)) + 1;
    const executionRequestId = detail.run.executionRequest?.executionRequestId;
    const attempt: RunAttempt = {
      schemaVersion: 1,
      attemptId,
      runId,
      tenant,
      attemptNumber,
      ...(executionRequestId === undefined ? {} : { executionRequestId }),
      state: 'queued',
      outputReferences: [],
    };
    await this.append(tenant, detail.run.projectId, actor, [
      {
        eventName: 'run.attempt-created.v1',
        aggregateType: 'run',
        aggregateId: runId,
        correlationId: runId,
        payload: { attempt } as unknown as JsonValue,
      },
      {
        eventName: 'run.status-changed.v1',
        aggregateType: 'run',
        aggregateId: runId,
        correlationId: runId,
        payload: { runId, state: 'queued' } as unknown as JsonValue,
      },
      {
        eventName: 'run.action-linked.v1',
        aggregateType: 'run',
        aggregateId: runId,
        correlationId: runId,
        payload: { runId, operationRunId: retry.runId, action: 'conversation.retry' },
      },
      {
        eventName: 'run.progress.v1',
        aggregateType: 'run',
        aggregateId: runId,
        correlationId: runId,
        payload: {
          runId,
          phase: 'retrying',
          message: `Retry attempt ${attemptNumber} delegated to the conversation runtime.`,
        },
      },
    ]);
    void this.monitorLinkedRetry(tenant, runId, retry.runId, actor).catch(() => undefined);
    return {
      ...retry,
      runId,
      correlationId: runId,
      ...(retry.response === undefined ? {} : { response: { ...retry.response, runId } }),
    };
  }

  private async reconcileLinkedRetry(
    tenant: TenantRef,
    runId: Id,
    linkedRunId: Id,
    actor: Actor,
  ): Promise<void> {
    const events = await this.eventsForTenant(tenant);
    const parent = await this.runDetailFromEvents(events, runId);
    const child = await this.runDetailFromEvents(events, linkedRunId);
    if (parent === undefined || child === undefined || terminalRunState(parent.run.state)) return;
    if (!terminalRunState(child.run.state)) return;
    const attempt = parent.attempts.at(-1);
    if (attempt === undefined) return;
    const at = this.clock();
    const childAttempt = child.attempts.at(-1);
    const error = child.run.error ?? childAttempt?.error;
    await this.append(tenant, parent.run.projectId ?? linkedRunId, actor, [
      {
        eventName: 'run.status-changed.v1',
        aggregateType: 'run',
        aggregateId: runId,
        correlationId: runId,
        payload: {
          runId,
          state: child.run.state,
          completedAt: at,
          ...(error === undefined ? {} : { error }),
        } as unknown as JsonValue,
      },
      {
        eventName: 'run.attempt-completed.v1',
        aggregateType: 'run',
        aggregateId: runId,
        correlationId: runId,
        payload: {
          attemptId: attempt.attemptId,
          runId,
          state: child.run.state,
          completedAt: at,
          ...(childAttempt?.resourceUsage === undefined
            ? {}
            : { resourceUsage: childAttempt.resourceUsage }),
          ...(error === undefined ? {} : { error }),
        } as unknown as JsonValue,
      },
      {
        eventName:
          child.run.state === 'failed'
            ? 'run.failed.v1'
            : child.run.state === 'cancelled'
              ? 'run.cancelled.v1'
              : 'execution.completed.v1',
        aggregateType: 'run',
        aggregateId: runId,
        correlationId: runId,
        payload: { runId, state: child.run.state } as unknown as JsonValue,
      },
    ]);
  }

  private async monitorLinkedRetry(
    tenant: TenantRef,
    runId: Id,
    linkedRunId: Id,
    actor: Actor,
  ): Promise<void> {
    for (let attempt = 0; attempt < 6000; attempt += 1) {
      await this.reconcileLinkedRetry(tenant, runId, linkedRunId, actor);
      const detail = await this.runDetailFromEvents(await this.eventsForTenant(tenant), runId);
      if (detail === undefined || terminalRunState(detail.run.state)) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private runDetailFromEvents(
    events: readonly StoredEvent[],
    runId: Id,
  ): ConversationRunDetail | undefined {
    const runEvents = events.filter(
      (stored) => stored.event.aggregateType === 'run' && stored.event.aggregateId === runId,
    );
    let run: Run | undefined;
    const attempts = new Map<string, RunAttempt>();
    const logs: ConversationRunLog[] = [];
    for (const stored of runEvents) {
      const payload = eventPayload(stored);
      if (stored.event.eventName === 'run.created.v1') {
        const candidate = record(payload['run']);
        if (typeof candidate['runId'] === 'string') run = candidate as unknown as Run;
      }
      if (run !== undefined && stored.event.eventName.startsWith('run.status-')) {
        const nextState = runState(payload['state'] ?? payload['to'], run.state);
        const usage = usageCost(payload['usage'] as JsonValue | undefined);
        const cost = usageCost(payload['cost'] as JsonValue | undefined);
        run = {
          ...run,
          state: nextState,
          updatedAt: stored.event.occurredAt,
          ...(typeof payload['providerId'] === 'string'
            ? { providerId: payload['providerId'] }
            : {}),
          ...(typeof payload['modelId'] === 'string' ? { modelId: payload['modelId'] } : {}),
          ...(typeof payload['startedAt'] === 'string' ? { startedAt: payload['startedAt'] } : {}),
          ...(typeof payload['completedAt'] === 'string'
            ? { completedAt: payload['completedAt'] }
            : {}),
          ...(payload['error'] !== undefined
            ? { error: payload['error'] as NonNullable<Run['error']> }
            : {}),
          ...(usage === undefined ? {} : { cost: usage }),
          ...(cost === undefined ? {} : { cost }),
        };
        if (!terminalRunState(nextState)) {
          const reopened = { ...run };
          delete reopened.completedAt;
          delete reopened.error;
          run = reopened;
        }
      }
      if (stored.event.eventName === 'run.attempt-created.v1') {
        const candidate = record(payload['attempt']);
        if (typeof candidate['attemptId'] === 'string') {
          attempts.set(candidate['attemptId'], candidate as unknown as RunAttempt);
          if (run !== undefined && !run.attemptIds.includes(candidate['attemptId'] as Id)) {
            run = {
              ...run,
              attemptIds: [...run.attemptIds, candidate['attemptId'] as Id],
              updatedAt: stored.event.occurredAt,
            };
          }
        }
      }
      if (
        stored.event.eventName === 'run.attempt-state-changed.v1' ||
        stored.event.eventName === 'run.attempt-started.v1' ||
        stored.event.eventName === 'run.attempt-completed.v1'
      ) {
        const attemptId = stringValue(payload['attemptId']);
        if (attemptId !== undefined) {
          const current = attempts.get(attemptId);
          const nextState = runState(payload['state'], current?.state ?? 'queued');
          const next: RunAttempt = {
            ...(current ?? {
              schemaVersion: 1,
              attemptId,
              runId,
              tenant: run?.tenant,
              attemptNumber: 1,
              outputReferences: [],
            }),
            state: nextState,
            ...(typeof payload['providerId'] === 'string'
              ? { providerId: payload['providerId'] }
              : {}),
            ...(typeof payload['modelId'] === 'string' ? { modelId: payload['modelId'] } : {}),
            ...(typeof payload['startedAt'] === 'string'
              ? { startedAt: payload['startedAt'] }
              : {}),
            ...(typeof payload['completedAt'] === 'string'
              ? { completedAt: payload['completedAt'] }
              : {}),
            ...(payload['error'] !== undefined
              ? { error: payload['error'] as unknown as RunAttempt['error'] }
              : {}),
            ...(payload['resourceUsage'] === undefined
              ? {}
              : { resourceUsage: payload['resourceUsage'] as JsonValue }),
          } as RunAttempt;
          attempts.set(attemptId, next);
        }
      }
      if (stored.event.eventName.startsWith('run.log.')) {
        const rawMessage = payload['message'] ?? payload['line'] ?? payload['output'];
        const message =
          typeof rawMessage === 'string'
            ? rawMessage
            : rawMessage === undefined
              ? stored.event.eventName
              : JSON.stringify(rawMessage);
        const level = payload['level'];
        logs.push({
          eventId: stored.event.eventId,
          runId,
          eventName: stored.event.eventName,
          occurredAt: stored.event.occurredAt,
          message,
          level: level === 'error' || level === 'output' ? level : 'info',
        });
      }
    }
    if (run === undefined) return undefined;
    return {
      run,
      attempts: [...attempts.values()].sort(
        (left, right) => left.attemptNumber - right.attemptNumber,
      ),
      logs,
    };
  }

  private async appendAgentEvent(
    tenant: TenantRef,
    sessionId: Id,
    requestId: Id,
    correlationId: Id,
    actor: Actor,
    kind: AgentEvent['kind'],
    payload: JsonValue,
  ): Promise<AgentEvent> {
    const sequence =
      latestAgentSequence(
        (await this.eventsForTenant(tenant)).filter(
          (stored) =>
            stored.event.aggregateType === 'agent-session' &&
            stored.event.aggregateId === sessionId,
        ),
      ) + 1;
    const event: AgentEvent = {
      schemaVersion: 1,
      eventId: newSortableId(),
      sessionId,
      requestId,
      tenant,
      sequence,
      kind,
      payload,
      occurredAt: this.clock(),
      correlationId,
    };
    await this.append(tenant, sessionId, actor, [
      {
        eventName: `agent.${kind.replaceAll('_', '-')}.v1`,
        aggregateType: 'agent-session',
        aggregateId: sessionId,
        correlationId,
        payload: { agentEvent: event } as unknown as JsonValue,
      },
    ]);
    return event;
  }

  private async updateAgentState(
    tenant: TenantRef,
    sessionId: Id,
    actor: Actor,
    response: AgentResponse,
    state: AgentSessionState,
  ): Promise<void> {
    const current = await this.readSession(tenant, sessionId);
    const session: AgentSession = {
      ...current.session,
      state,
      updatedAt: this.clock(),
    };
    await this.append(tenant, sessionId, actor, [
      {
        eventName: 'agent.session-updated.v1',
        aggregateType: 'agent-session',
        aggregateId: sessionId,
        correlationId: response.requestId,
        payload: { session } as unknown as JsonValue,
      },
      {
        eventName: 'agent.response-updated.v1',
        aggregateType: 'agent-session',
        aggregateId: sessionId,
        correlationId: response.requestId,
        payload: { response } as unknown as JsonValue,
      },
    ]);
  }

  private async requestAgentPermission(
    tenant: TenantRef,
    projectId: Id,
    conversationId: Id,
    turn: ActiveTurn,
    decision: PolicyDecision,
    action: string,
  ): Promise<AgentPermissionRequest> {
    const now = this.clock();
    const permission: AgentPermissionRequest = {
      schemaVersion: 1,
      permissionRequestId: newSortableId(),
      sessionId: conversationId,
      requestId: turn.request.requestId,
      tenant,
      kind: decision.outcome === 'confirmation_required' ? 'confirmation' : 'approval',
      action,
      reason: decision.reasonCodes.join(', ') || 'Policy requires operator permission.',
      resources: turn.request.context.resources,
      state: 'pending',
      requestedAt: now,
      expiresAt: new Date(Date.parse(now) + 15 * 60 * 1000).toISOString(),
    };
    const response: AgentResponse = {
      ...turn.response,
      state: 'awaiting_permission',
      permissionRequestId: permission.permissionRequestId,
      nextAction: 'Review and decide the pending permission request.',
    };
    const sessionState = await this.readSession(tenant, conversationId);
    const session: AgentSession = {
      ...sessionState.session,
      state: 'awaiting_approval',
      currentRunId: turn.runId,
      updatedAt: now,
    };
    await this.append(tenant, conversationId, turn.actor, [
      {
        eventName: 'agent.permission-requested.v1',
        aggregateType: 'agent-session',
        aggregateId: conversationId,
        correlationId: turn.correlationId,
        payload: { permission, decision } as unknown as JsonValue,
      },
      {
        eventName: 'agent.session-updated.v1',
        aggregateType: 'agent-session',
        aggregateId: conversationId,
        correlationId: turn.correlationId,
        payload: { session } as unknown as JsonValue,
      },
      {
        eventName: 'agent.response-updated.v1',
        aggregateType: 'agent-session',
        aggregateId: conversationId,
        correlationId: turn.correlationId,
        payload: { response } as unknown as JsonValue,
      },
      {
        eventName: 'run.status-changed.v1',
        aggregateType: 'run',
        aggregateId: turn.runId,
        correlationId: turn.runId,
        payload: {
          runId: turn.runId,
          projectId,
          state: 'awaiting_approval',
        } as unknown as JsonValue,
      },
      {
        eventName: 'run.log.v1',
        aggregateType: 'run',
        aggregateId: turn.runId,
        correlationId: turn.runId,
        payload: {
          runId: turn.runId,
          level: 'info',
          message: `Permission required: ${permission.reason}`,
        } as unknown as JsonValue,
      },
    ]);
    await this.appendAgentEvent(
      tenant,
      conversationId,
      turn.request.requestId,
      turn.correlationId,
      turn.actor,
      'permission_requested',
      { permission, decision } as unknown as JsonValue,
    );
    await this.updateInvocationState(tenant, turn.invocation?.invocationId, 'awaiting_approval');
    return permission;
  }

  private async runTurn(
    tenant: TenantRef,
    projectId: Id,
    conversationId: Id,
    text: string,
    turn: ActiveTurn,
  ): Promise<void> {
    let assistantText = '';
    let usage: JsonValue | undefined;
    try {
      await this.providerRuntime.providers.refresh();
      const snapshot = await this.snapshot(tenant, projectId, conversationId);
      if (this.policy !== undefined && turn.invocation !== undefined) {
        const agentActor: Actor = {
          actorId: turn.invocation.authority.subjectAgentId,
          type: 'agent',
          displayName: 'Spyderbyte Agent',
        };
        const policyDecision = this.policy.decide({
          action: 'tool_use',
          toolName: 'spyderbyte-agent',
          operation: 'request',
          tenant,
          workflowId: projectId,
          invocationId: turn.invocation.invocationId,
          actor: agentActor,
          authority: turn.invocation.authority,
          resources: turn.request.context.resources,
          evaluatedAt: this.clock(),
          requiresApproval: false,
        });
        await this.appendAgentEvent(
          tenant,
          conversationId,
          turn.request.requestId,
          turn.correlationId,
          turn.actor,
          'policy_evaluated',
          { decision: policyDecision } as unknown as JsonValue,
        );
        if (policyDecision.outcome !== 'allow') {
          await this.requestAgentPermission(
            tenant,
            projectId,
            conversationId,
            turn,
            policyDecision,
            'agent.request',
          );
          return;
        }
      }
      const configuredModels = this.providerRuntime.providers
        .listModels()
        .filter((model) => model.state !== 'unavailable')
        .map((model) => model.modelId);
      const selection = this.providerRuntime.router.resolveSelection({
        tier: 0,
        taskShape: 'default',
        allowedModels:
          configuredModels.length > 0
            ? configuredModels
            : this.providerRuntime.catalog.list().map((entry) => entry.modelId),
        requiredCapabilities: [],
        dataClass: 'internal',
        allowExternalModels: this.providerRuntime.routingPolicy.allowExternalModels,
        providerPriority: this.providerRuntime.providerPriority,
        allowProviderFallback: this.providerRuntime.routingPolicy.allowProviderFallback,
        ...(turn.modelOverride === undefined
          ? {}
          : { hierarchy: { explicit: turn.modelOverride } }),
      }).resolved;
      this.enforceGovernedRun(
        tenant,
        projectId,
        turn.actor,
        turn.runId,
        turn.request.sourceInterface,
        turn.governanceApprovalContext,
        selection.selected.providerId,
      );
      const startedAt = this.clock();
      await this.append(tenant, conversationId, turn.actor, [
        {
          eventName: 'run.status-changed.v1',
          aggregateType: 'run',
          aggregateId: turn.runId,
          correlationId: turn.runId,
          payload: {
            runId: turn.runId,
            projectId,
            state: 'running',
            startedAt,
            providerId: selection.selected.providerId,
            modelId: selection.selected.modelId,
          } as unknown as JsonValue,
        },
        {
          eventName: 'run.attempt-started.v1',
          aggregateType: 'run',
          aggregateId: turn.runId,
          correlationId: turn.runId,
          payload: {
            attemptId: turn.attemptId,
            runId: turn.runId,
            attemptNumber: 1,
            state: 'running',
            startedAt,
            providerId: selection.selected.providerId,
            modelId: selection.selected.modelId,
          } as unknown as JsonValue,
        },
      ]);
      await this.updateInvocationState(tenant, turn.invocation?.invocationId, 'running');
      const input: JsonValue = {
        projectId,
        conversationId,
        messages: snapshot.messages
          .filter((message) => message.state === 'completed' && message.text.length > 0)
          .map((message) => ({ role: message.role, text: message.text })) as unknown as JsonValue,
        instruction: text,
      };
      const stream =
        this.agentAdapter !== undefined && this.authority !== undefined
          ? await this.runWithCline(input, selection, turn)
          : this.runWithProvider(input, selection, turn.controller.signal);
      for await (const event of stream) {
        if (turn.controller.signal.aborted) break;
        if (event.type === 'usage') {
          usage = event.usage;
          continue;
        }
        if (event.type === 'tool_call') {
          if (this.policy !== undefined && turn.invocation !== undefined) {
            const agentActor: Actor = {
              actorId: turn.invocation.authority.subjectAgentId,
              type: 'agent',
              displayName: 'Spyderbyte Agent',
            };
            const toolDecision = this.policy.decide({
              action: 'tool_use',
              toolName: event.toolName,
              operation: event.operation,
              tenant,
              workflowId: projectId,
              invocationId: turn.invocation.invocationId,
              actor: agentActor,
              authority: turn.invocation.authority,
              resources: turn.request.context.resources,
              evaluatedAt: this.clock(),
              requiresApproval: toolRequiresApproval(event.toolName, event.operation),
            });
            await this.appendAgentEvent(
              tenant,
              conversationId,
              turn.request.requestId,
              turn.correlationId,
              turn.actor,
              'policy_evaluated',
              {
                decision: toolDecision,
                toolName: event.toolName,
                operation: event.operation,
              } as unknown as JsonValue,
            );
            if (toolDecision.outcome !== 'allow') {
              await this.requestAgentPermission(
                tenant,
                projectId,
                conversationId,
                turn,
                toolDecision,
                `${event.toolName}.${event.operation}`,
              );
              return;
            }
            this.authority?.assertAuthorized(turn.invocation.authority, {
              tenant,
              workflowId: projectId,
              invocationId: turn.invocation.invocationId,
              actorId: turn.invocation.authority.subjectAgentId,
              toolOperation: `${event.toolName}.${event.operation}`,
              resources: turn.request.context.resources,
              now: this.clock(),
            });
          }
          await this.append(tenant, conversationId, turn.actor, [
            {
              eventName: 'chat.tool-activity.v1',
              payload: {
                conversationId,
                assistantMessageId: turn.assistantMessageId,
                toolName: event.toolName,
                toolOperation: event.operation,
              } as unknown as JsonValue,
            },
            {
              eventName: 'run.log.v1',
              aggregateType: 'run',
              aggregateId: turn.runId,
              correlationId: turn.runId,
              payload: {
                runId: turn.runId,
                level: 'info',
                message: `${event.toolName} · ${event.operation}`,
              } as unknown as JsonValue,
            },
          ]);
          continue;
        }
        if (event.type !== 'output') continue;
        const delta = textValue(event.value);
        if (!delta) continue;
        assistantText += delta;
        await this.appendAgentEvent(
          tenant,
          conversationId,
          turn.request.requestId,
          turn.correlationId,
          turn.actor,
          'message_delta',
          { text: delta } as unknown as JsonValue,
        );
        await this.append(tenant, conversationId, turn.actor, [
          {
            eventName: 'chat.message-delta.v1',
            payload: {
              projectId,
              conversationId,
              messageId: turn.assistantMessageId,
              delta,
              providerId: selection.selected.providerId,
              modelId: selection.selected.modelId,
            } as unknown as JsonValue,
          },
          {
            eventName: 'run.log.v1',
            aggregateType: 'run',
            aggregateId: turn.runId,
            correlationId: turn.runId,
            payload: {
              runId: turn.runId,
              level: 'output',
              message: delta,
              providerId: selection.selected.providerId,
              modelId: selection.selected.modelId,
            } as unknown as JsonValue,
          },
        ]);
      }
      if (turn.controller.signal.aborted || turn.cancelled) {
        if (!turn.cancelled) await this.cancel(tenant, conversationId, 'cancelled by user');
        return;
      }
      this.commitGovernedRun(
        tenant,
        projectId,
        turn,
        selection.selected.providerId,
        'succeeded',
        usage,
      );
      const completedMessage: ConversationMessage = {
        messageId: turn.assistantMessageId,
        conversationId,
        projectId,
        role: 'assistant',
        state: 'completed',
        text: assistantText || 'The agent completed without a textual response.',
        createdAt: this.clock(),
        updatedAt: this.clock(),
        correlationId: turn.correlationId,
        providerId: selection.selected.providerId,
        modelId: selection.selected.modelId,
      };
      await this.append(tenant, conversationId, turn.actor, [
        {
          eventName: 'chat.message-completed.v1',
          payload: { message: completedMessage } as unknown as JsonValue,
        },
        {
          eventName: 'chat.run-completed.v1',
          payload: {
            conversationId,
            assistantMessageId: turn.assistantMessageId,
            runId: turn.runId,
          } as unknown as JsonValue,
        },
        {
          eventName: 'run.status-changed.v1',
          aggregateType: 'run',
          aggregateId: turn.runId,
          correlationId: turn.runId,
          payload: {
            runId: turn.runId,
            projectId,
            state: 'succeeded',
            completedAt: this.clock(),
            providerId: selection.selected.providerId,
            modelId: selection.selected.modelId,
            ...(usage === undefined ? {} : { usage }),
          } as unknown as JsonValue,
        },
        {
          eventName: 'run.attempt-completed.v1',
          aggregateType: 'run',
          aggregateId: turn.runId,
          correlationId: turn.runId,
          payload: {
            attemptId: turn.attemptId,
            runId: turn.runId,
            state: 'succeeded',
            completedAt: this.clock(),
            providerId: selection.selected.providerId,
            modelId: selection.selected.modelId,
            ...(usage === undefined ? {} : { resourceUsage: usage }),
          } as unknown as JsonValue,
        },
        {
          eventName: 'run.completed.v1',
          aggregateType: 'run',
          aggregateId: turn.runId,
          correlationId: turn.runId,
          payload: { runId: turn.runId, state: 'succeeded' } as unknown as JsonValue,
        },
      ]);
      const completedAt = this.clock();
      const completedResponse: AgentResponse = {
        ...turn.response,
        state: 'completed',
        explanation: 'The Spyderbyte agent completed the request through the shared Run path.',
        nextAction: 'Inspect the response or submit a follow-up request.',
        completedAt,
      };
      await this.updateAgentState(tenant, conversationId, turn.actor, completedResponse, 'active');
      await this.appendAgentEvent(
        tenant,
        conversationId,
        turn.request.requestId,
        turn.correlationId,
        turn.actor,
        'explanation_created',
        { text: completedResponse.explanation } as unknown as JsonValue,
      );
      await this.appendAgentEvent(
        tenant,
        conversationId,
        turn.request.requestId,
        turn.correlationId,
        turn.actor,
        'next_action_created',
        { text: completedResponse.nextAction } as unknown as JsonValue,
      );
      await this.appendAgentEvent(
        tenant,
        conversationId,
        turn.request.requestId,
        turn.correlationId,
        turn.actor,
        'completed',
        { responseId: completedResponse.responseId, runId: turn.runId } as unknown as JsonValue,
      );
      await this.updateInvocationState(tenant, turn.invocation?.invocationId, 'succeeded');
    } catch (error) {
      if (turn.controller.signal.aborted || turn.cancelled) {
        if (!turn.cancelled) await this.cancel(tenant, conversationId, 'cancelled by user');
        return;
      }
      const safe = error instanceof Error ? error.message : 'Agent assistance failed';
      const failedMessage: ConversationMessage = {
        messageId: turn.assistantMessageId,
        conversationId,
        projectId,
        role: 'assistant',
        state: 'failed',
        text: safe,
        createdAt: this.clock(),
        updatedAt: this.clock(),
        correlationId: turn.correlationId,
      };
      await this.append(tenant, conversationId, turn.actor, [
        {
          eventName: 'chat.message-completed.v1',
          payload: { message: failedMessage } as unknown as JsonValue,
        },
        {
          eventName: 'chat.run-failed.v1',
          payload: {
            conversationId,
            assistantMessageId: turn.assistantMessageId,
            runId: turn.runId,
          } as unknown as JsonValue,
        },
        {
          eventName: 'run.log.v1',
          aggregateType: 'run',
          aggregateId: turn.runId,
          correlationId: turn.runId,
          payload: {
            runId: turn.runId,
            level: 'error',
            message: safe,
          } as unknown as JsonValue,
        },
        {
          eventName: 'run.status-changed.v1',
          aggregateType: 'run',
          aggregateId: turn.runId,
          correlationId: turn.runId,
          payload: {
            runId: turn.runId,
            projectId,
            state: 'failed',
            completedAt: this.clock(),
            error: failureRecord(error, this.clock()),
          } as unknown as JsonValue,
        },
        {
          eventName: 'run.attempt-completed.v1',
          aggregateType: 'run',
          aggregateId: turn.runId,
          correlationId: turn.runId,
          payload: {
            attemptId: turn.attemptId,
            runId: turn.runId,
            state: 'failed',
            completedAt: this.clock(),
            error: failureRecord(error, this.clock()),
          } as unknown as JsonValue,
        },
        {
          eventName: 'run.failed.v1',
          aggregateType: 'run',
          aggregateId: turn.runId,
          correlationId: turn.runId,
          payload: { runId: turn.runId, state: 'failed' } as unknown as JsonValue,
        },
      ]);
      const failedAt = this.clock();
      const failedResponse: AgentResponse = {
        ...turn.response,
        state: 'failed',
        explanation: safe,
        nextAction: 'Review the failed Run and retry when the cause is resolved.',
        completedAt: failedAt,
      };
      await this.updateAgentState(tenant, conversationId, turn.actor, failedResponse, 'active');
      await this.appendAgentEvent(
        tenant,
        conversationId,
        turn.request.requestId,
        turn.correlationId,
        turn.actor,
        'failed',
        { responseId: failedResponse.responseId, error: safe } as unknown as JsonValue,
      );
      await this.updateInvocationState(tenant, turn.invocation?.invocationId, 'failed');
    } finally {
      this.active.delete(String(conversationId));
    }
  }

  private async runWithCline(
    input: JsonValue,
    selection: unknown,
    turn: ActiveTurn,
  ): Promise<AsyncIterable<ConversationRuntimeEvent>> {
    const invocation = turn.invocation;
    if (invocation === undefined) throw new Error('Conversation invocation is unavailable');
    const runtime = await this.agentAdapter?.createRuntime(invocation, { model: selection });
    if (runtime === undefined) throw new Error('Agent adapter is unavailable');
    const source = runtime.streamEvents(input, turn.controller.signal);
    return (async function* (): AsyncIterable<ConversationRuntimeEvent> {
      try {
        for await (const event of source) yield event;
      } finally {
        await runtime.dispose();
      }
    })();
  }

  private runWithProvider(
    input: JsonValue,
    selection: ProviderSelection,
    signal: AbortSignal,
  ): AsyncIterable<ConversationRuntimeEvent> {
    const selected = selection.providers[0];
    if (selected === undefined) throw new Error('No model provider is ready for agent assistance');
    const request = {
      requestId: newSortableId(),
      model: selected.model,
      input,
      maxTokens: 4096,
      signal,
    };
    return (async function* (): AsyncIterable<ConversationRuntimeEvent> {
      if (selected.stream !== undefined) {
        for await (const event of await selected.stream(request)) {
          const value = record(event);
          if (value['type'] === 'delta')
            yield { type: 'output', value: (value['value'] ?? '') as JsonValue };
          if (value['type'] === 'usage' && value['usage'] !== undefined)
            yield { type: 'usage', usage: value['usage'] as JsonValue };
          if (value['type'] === 'completed') {
            const output = value['output'];
            yield output === undefined
              ? { type: 'completed' }
              : { type: 'completed', output: output as JsonValue };
          }
        }
        return;
      }
      if (selected.complete === undefined)
        throw new Error('Selected model provider cannot respond');
      const response = await selected.complete(request);
      if (response.usage !== undefined) yield { type: 'usage', usage: response.usage as JsonValue };
      yield { type: 'output', value: response.output };
      yield { type: 'completed', output: response.output };
    })();
  }
}
