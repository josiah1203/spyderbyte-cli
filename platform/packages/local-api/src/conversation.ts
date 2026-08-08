import type {
  AgentEvent,
  AgentPermissionRequest,
  AgentRequest,
  AgentResponse,
  AgentSession,
  Actor,
  Id,
  JsonValue,
  Run,
  RunAttempt,
  TenantRef,
} from '@agentic-platform/runtime-contracts';
import type { GovernanceApprovalContextV1 } from '@agentic-platform/policy';

export type ConversationMessageRole = 'user' | 'assistant' | 'system' | 'tool';
export type ConversationMessageState = 'streaming' | 'completed' | 'failed' | 'cancelled';

export interface ConversationMessage {
  readonly messageId: Id;
  readonly conversationId: Id;
  readonly projectId: Id;
  readonly role: ConversationMessageRole;
  readonly state: ConversationMessageState;
  readonly text: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly correlationId?: Id;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly toolName?: string;
  readonly toolOperation?: string;
}

export interface ConversationSnapshot {
  readonly conversationId: Id;
  readonly projectId: Id;
  readonly session?: AgentSession;
  readonly latestResponse?: AgentResponse;
  readonly runId?: Id;
  readonly workflowId?: Id;
  readonly messages: readonly ConversationMessage[];
  readonly generating: boolean;
  readonly updatedAt: string;
}

export interface ConversationSendInput {
  readonly tenant: TenantRef;
  readonly projectId: Id;
  readonly actor: Actor;
  readonly text: string;
  readonly clientMessageId?: Id;
  readonly sourceInterface?: Run['sourceInterface'];
  readonly clientVersion?: string;
  readonly modelOverride?: { readonly providerId: string; readonly modelId: string };
  readonly governanceApprovalContext?: GovernanceApprovalContextV1;
}

export interface ConversationRunLog {
  readonly eventId: Id;
  readonly runId: Id;
  readonly eventName: string;
  readonly occurredAt: string;
  readonly message: string;
  readonly level: 'info' | 'error' | 'output';
}

export interface ConversationRunDetail {
  readonly run: Run;
  readonly attempts: readonly RunAttempt[];
  readonly logs: readonly ConversationRunLog[];
}

export interface ConversationTurnAccepted {
  readonly conversationId: Id;
  readonly projectId: Id;
  readonly sessionId?: Id;
  readonly requestId?: Id;
  readonly response?: AgentResponse;
  readonly runId: Id;
  readonly userMessageId: Id;
  readonly assistantMessageId: Id;
  readonly correlationId: Id;
  readonly accepted: true;
}

/** Durable AgentSession view reconstructed from the authoritative event stream. */
export interface AgentSessionSnapshot {
  readonly session: AgentSession;
  readonly requests: readonly AgentRequest[];
  readonly events: readonly AgentEvent[];
  readonly permissions: readonly AgentPermissionRequest[];
  readonly responses: readonly AgentResponse[];
}

export interface AgentSessionService {
  readSession(tenant: TenantRef, sessionId: Id): Promise<AgentSessionSnapshot>;
  readProjectSession(tenant: TenantRef, projectId: Id): Promise<AgentSessionSnapshot>;
}

export interface ConversationService extends AgentSessionService {
  read(tenant: TenantRef, projectId: Id): Promise<ConversationSnapshot>;
  send(input: ConversationSendInput): Promise<ConversationTurnAccepted>;
  cancel(tenant: TenantRef, conversationId: Id, reason?: string): Promise<JsonValue>;
  listRuns(tenant: TenantRef, projectId?: Id): Promise<readonly Run[]>;
  readRun(tenant: TenantRef, runId: Id): Promise<ConversationRunDetail>;
  retryRun(tenant: TenantRef, runId: Id, actor: Actor): Promise<ConversationTurnAccepted>;
}
