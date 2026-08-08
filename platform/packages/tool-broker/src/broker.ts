import {
  isJsonValue,
  newSortableId,
  runtimeError,
  validateContract,
  type Actor,
  type AuthorityEnvelope,
  type BudgetCategory,
  type Id,
  type JsonValue,
  type Money,
  type ResourceSelector,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import { BudgetLedger } from '@agentic-platform/budget';
import {
  ApprovalService,
  AuthorityService,
  PolicyDecisionService,
  selectorAllows,
  type ApprovalAction,
  type AuditSink,
} from '@agentic-platform/policy';

export interface ToolExecutionContext {
  tenant: TenantRef;
  invocationId: Id;
  correlationId?: Id;
  authority: AuthorityEnvelope;
  grant: ToolGrantRecord;
  resources: ResourceSelector[];
  now: string;
}

export interface ToolDefinition {
  toolName: string;
  operation: string;
  category?: BudgetCategory;
  estimatedCost?: Money;
  requiresApproval?: boolean;
  execute(input: JsonValue, context: ToolExecutionContext): Promise<JsonValue> | JsonValue;
}

export interface ToolGrantRecord {
  grant: import('@agentic-platform/runtime-contracts').ToolGrant;
  authority: AuthorityEnvelope;
  usesConsumed: number;
}

export interface IssueToolGrantInput {
  tenant: TenantRef;
  invocationId: Id;
  authority: AuthorityEnvelope;
  toolName: string;
  operation: string;
  resourceScopes: ResourceSelector[];
  expiresAt: string;
  maxUses?: number;
  requiresApproval?: boolean;
  approval?: { approvalId: Id; action: ApprovalAction };
  now?: string;
}

export interface ExecuteToolInput {
  tenant: TenantRef;
  invocationId: Id;
  grantId: Id;
  authority: AuthorityEnvelope;
  resources: ResourceSelector[];
  input: JsonValue;
  budgetId?: Id;
  correlationId?: Id;
  approval?: { approvalId: Id; action: ApprovalAction };
  now?: string;
}

export interface ToolExecutionResult {
  grant: ToolGrantRecord;
  output: JsonValue;
  redacted: boolean;
  decisionId: Id;
}

export interface ToolBrokerOptions {
  authority: AuthorityService;
  policy: PolicyDecisionService;
  approvals?: ApprovalService;
  budget?: BudgetLedger;
  audit?: AuditSink;
  clock?: () => string;
}

function toolOperation(toolName: string, operation: string): string {
  return `${toolName}.${operation}`;
}

function actingActor(authority: AuthorityEnvelope): Actor {
  return { actorId: authority.subjectAgentId, type: 'agent' };
}

function sameTenant(left: TenantRef, right: TenantRef): boolean {
  return left.tenantId === right.tenantId && left.workspaceId === right.workspaceId;
}

function secretKey(key: string): boolean {
  return /(?:secret|password|passwd|token|api[_-]?key|private[_-]?key|authorization)/i.test(key);
}

function redactString(value: string): { value: string; changed: boolean } {
  const patterns = [
    /sk-[A-Za-z0-9_-]{12,}/g,
    /AKIA[0-9A-Z]{16}/g,
    /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
    /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g,
  ];
  let redacted = value;
  for (const pattern of patterns) redacted = redacted.replace(pattern, '[REDACTED]');
  return { value: redacted, changed: redacted !== value };
}

export function redactSecrets(value: JsonValue): JsonValue {
  if (typeof value === 'string') return redactString(value).value;
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry));
  if (value === null || typeof value !== 'object') return value;
  const result: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = secretKey(key) ? '[REDACTED]' : redactSecrets(entry);
  }
  return result;
}

function containsRedaction(original: JsonValue, redacted: JsonValue): boolean {
  return JSON.stringify(original) !== JSON.stringify(redacted);
}

export class ToolBroker {
  private readonly authority: AuthorityService;
  private readonly policy: PolicyDecisionService;
  private readonly approvals: ApprovalService | undefined;
  private readonly budget: BudgetLedger | undefined;
  private readonly audit: AuditSink | undefined;
  private readonly clock: () => string;
  private readonly definitions = new Map<string, ToolDefinition>();
  private readonly grants = new Map<string, ToolGrantRecord>();

  constructor(options: ToolBrokerOptions) {
    this.authority = options.authority;
    this.policy = options.policy;
    this.approvals = options.approvals;
    this.budget = options.budget;
    this.audit = options.audit;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  register(definition: ToolDefinition): void {
    const key = toolOperation(definition.toolName, definition.operation);
    if (this.definitions.has(key))
      throw runtimeError('VALIDATION_INVALID_INPUT', `Tool already registered: ${key}`);
    this.definitions.set(key, definition);
  }

  async issueGrant(input: IssueToolGrantInput): Promise<ToolGrantRecord> {
    const now = input.now ?? this.clock();
    const definition = this.requireDefinition(input.toolName, input.operation);
    if (
      !sameTenant(input.tenant, input.authority.tenant) ||
      input.invocationId !== input.authority.invocationId
    ) {
      throw runtimeError(
        'POLICY_DENIED',
        'Tool grant is not bound to the authority tenant/invocation',
      );
    }
    if (
      Date.parse(input.expiresAt) <= Date.parse(now) ||
      Date.parse(input.expiresAt) > Date.parse(input.authority.expiresAt)
    ) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'Tool grant expiration must be within the authority lifetime',
      );
    }
    if (
      input.maxUses !== undefined &&
      (!Number.isSafeInteger(input.maxUses) || input.maxUses < 1)
    ) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'Tool grant maxUses must be a positive integer',
      );
    }
    this.authority.assertAuthorized(input.authority, {
      tenant: input.tenant,
      workflowId: input.authority.workflowId,
      invocationId: input.invocationId,
      actorId: input.authority.subjectAgentId,
      action: 'tool.grant',
      toolOperation: toolOperation(input.toolName, input.operation),
      resources: input.resourceScopes,
      now,
    });
    const requiresApproval = input.requiresApproval ?? definition.requiresApproval ?? false;
    const decision = this.policy.decide({
      action: 'tool_use',
      tenant: input.tenant,
      workflowId: input.authority.workflowId,
      invocationId: input.invocationId,
      actor: actingActor(input.authority),
      authority: input.authority,
      resources: input.resourceScopes,
      evaluatedAt: now,
      toolName: input.toolName,
      operation: input.operation,
      requiresApproval,
    });
    if (decision.outcome === 'approval_required') {
      if (!this.approvals || !input.approval)
        throw runtimeError('APPROVAL_REQUIRED', 'Tool grant requires approval');
      this.approvals.assertValid(
        input.tenant,
        input.approval.approvalId,
        input.approval.action,
        input.authority,
        now,
      );
    } else {
      this.policy.assertAllowed(decision);
    }
    const grant = {
      schemaVersion: 1,
      grantId: newSortableId(),
      tenant: input.tenant,
      invocationId: input.invocationId,
      toolName: input.toolName,
      operation: input.operation,
      issuedAt: now,
      expiresAt: input.expiresAt,
      authorityEnvelopeId: input.authority.envelopeId,
      resourceScopes: structuredClone(input.resourceScopes),
      ...(input.maxUses !== undefined ? { maxUses: input.maxUses } : {}),
    } satisfies import('@agentic-platform/runtime-contracts').ToolGrant;
    const validation = validateContract('ToolGrant', grant);
    if (!validation.valid)
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Tool grant failed contract validation');
    const record: ToolGrantRecord = {
      grant,
      authority: structuredClone(input.authority),
      usesConsumed: 0,
    };
    this.grants.set(this.grantKey(input.tenant, grant.grantId), structuredClone(record));
    this.audit?.record({
      auditId: newSortableId(),
      tenant: input.tenant,
      actor: actingActor(input.authority),
      action: 'tool.grant',
      target: input.resourceScopes,
      result: 'allowed',
      evidence: { grantId: grant.grantId, tool: toolOperation(input.toolName, input.operation) },
      occurredAt: now,
    });
    return structuredClone(record);
  }

  async execute(request: ExecuteToolInput): Promise<ToolExecutionResult> {
    const now = request.now ?? this.clock();
    const stored = this.grants.get(this.grantKey(request.tenant, request.grantId));
    if (!stored) throw runtimeError('AUTHORITY_MISSING', 'Tool grant was not found');
    const definition = this.requireDefinition(stored.grant.toolName, stored.grant.operation);
    if (
      stored.grant.invocationId !== request.invocationId ||
      stored.grant.authorityEnvelopeId !== request.authority.envelopeId ||
      !sameTenant(stored.grant.tenant, request.tenant)
    ) {
      throw runtimeError(
        'POLICY_DENIED',
        'Tool grant is bound to a different invocation or authority',
      );
    }
    if (Date.parse(now) >= Date.parse(stored.grant.expiresAt)) {
      throw runtimeError('AUTHORITY_EXPIRED', 'Tool grant has expired');
    }
    if (stored.grant.maxUses !== undefined && stored.usesConsumed >= stored.grant.maxUses) {
      throw runtimeError('POLICY_DENIED', 'Tool grant usage limit has been exhausted');
    }
    this.authority.assertAuthorized(request.authority, {
      tenant: request.tenant,
      workflowId: request.authority.workflowId,
      invocationId: request.invocationId,
      actorId: request.authority.subjectAgentId,
      action: 'tool.use',
      toolOperation: toolOperation(stored.grant.toolName, stored.grant.operation),
      resources: request.resources,
      now,
    });
    if (
      !request.resources.every((resource) =>
        stored.grant.resourceScopes.some((scope) => selectorAllows(scope, resource)),
      )
    ) {
      throw runtimeError('POLICY_DENIED', 'Tool request escaped the grant resource scope');
    }
    const requiresApproval = definition.requiresApproval ?? false;
    const decision = this.policy.decide({
      action: 'tool_use',
      tenant: request.tenant,
      workflowId: request.authority.workflowId,
      invocationId: request.invocationId,
      actor: actingActor(request.authority),
      authority: request.authority,
      resources: request.resources,
      evaluatedAt: now,
      toolName: stored.grant.toolName,
      operation: stored.grant.operation,
      requiresApproval,
    });
    if (decision.outcome === 'approval_required') {
      if (!this.approvals || !request.approval)
        throw runtimeError('APPROVAL_REQUIRED', 'Tool execution requires approval');
      this.approvals.assertValid(
        request.tenant,
        request.approval.approvalId,
        request.approval.action,
        request.authority,
        now,
      );
    } else {
      this.policy.assertAllowed(decision);
    }

    let reservationId: Id | undefined;
    if (definition.estimatedCost !== undefined) {
      if (!this.budget || request.budgetId === undefined) {
        throw runtimeError(
          'BUDGET_EXCEEDED',
          'A budget binding is required for metered tool execution',
        );
      }
      const reservation = await this.budget.reserve({
        budgetId: request.budgetId,
        tenant: request.tenant,
        invocationId: request.invocationId,
        category: definition.category ?? 'external_api',
        amount: definition.estimatedCost,
        authority: request.authority,
        now,
      });
      reservationId = reservation.reservation.reservationId;
    }
    try {
      const rawOutput = await definition.execute(request.input, {
        tenant: request.tenant,
        invocationId: request.invocationId,
        ...(request.correlationId === undefined ? {} : { correlationId: request.correlationId }),
        authority: request.authority,
        grant: stored,
        resources: request.resources,
        now,
      });
      if (!isJsonValue(rawOutput))
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Tool returned a non-JSON response');
      const output = redactSecrets(rawOutput);
      const redacted = containsRedaction(rawOutput, output);
      if (reservationId && definition.estimatedCost && this.budget) {
        await this.budget.reconcile({
          tenant: request.tenant,
          invocationId: request.invocationId,
          reservationId,
          actual: definition.estimatedCost,
          authority: request.authority,
          now,
        });
      }
      const updated: ToolGrantRecord = { ...stored, usesConsumed: stored.usesConsumed + 1 };
      this.grants.set(this.grantKey(request.tenant, request.grantId), structuredClone(updated));
      this.audit?.record({
        auditId: newSortableId(),
        tenant: request.tenant,
        actor: actingActor(request.authority),
        action: toolOperation(stored.grant.toolName, stored.grant.operation),
        target: request.resources,
        result: redacted ? 'redacted' : 'executed',
        evidence: {
          grantId: request.grantId,
          decisionId: decision.decisionId,
          invocationId: request.invocationId,
          ...(request.correlationId === undefined ? {} : { correlationId: request.correlationId }),
        },
        occurredAt: now,
      });
      return { grant: structuredClone(updated), output, redacted, decisionId: decision.decisionId };
    } catch (error) {
      if (reservationId && this.budget) {
        await this.budget.release({
          tenant: request.tenant,
          invocationId: request.invocationId,
          reservationId,
          authority: request.authority,
          now,
        });
      }
      throw error;
    }
  }

  grant(tenant: TenantRef, grantId: Id): ToolGrantRecord | undefined {
    const record = this.grants.get(this.grantKey(tenant, grantId));
    return record ? structuredClone(record) : undefined;
  }

  private grantKey(tenant: TenantRef, grantId: Id): string {
    return `${tenant.tenantId}:${tenant.workspaceId}:${grantId}`;
  }

  private requireDefinition(toolName: string, operation: string): ToolDefinition {
    const definition = this.definitions.get(toolOperation(toolName, operation));
    if (!definition)
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        `Tool operation is not registered: ${toolName}.${operation}`,
      );
    return definition;
  }
}
