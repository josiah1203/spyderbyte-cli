import {
  isContract,
  runtimeError,
  type AgentInvocation,
  type AgentRegistration,
  type AuthorityEnvelope,
  type BudgetEnvelope,
  type Id,
  type ResourceSelector,
} from '@agentic-platform/runtime-contracts';
import type { StateStore, VersionedAggregate } from '@agentic-platform/state';
import { AuthorityService, selectorAllows, sha256Digest } from '@agentic-platform/policy';
import { mayInvoke } from './tiers.js';
import type { HarnessRegistryPort } from './registry.js';

export interface InvocationCreateRequest {
  parent?: AgentInvocation;
  child: AgentInvocation;
  registration: AgentRegistration;
  delegatingAuthority: AuthorityEnvelope;
  currentChildCount: number;
  depth: number;
  maxDepth: number;
  now: string;
}

export interface InvocationServiceOptions {
  state: StateStore;
  authority: Pick<AuthorityService, 'assertAuthorized' | 'assertResourceScopes' | 'verify'>;
  registry?: HarnessRegistryPort;
}

function sameTenant(left: AgentInvocation, right: AgentInvocation): boolean {
  return (
    left.tenant.tenantId === right.tenant.tenantId &&
    left.tenant.workspaceId === right.tenant.workspaceId
  );
}

function isTerminal(state: AgentInvocation['state']): boolean {
  return (
    state === 'succeeded' ||
    state === 'partially_succeeded' ||
    state === 'failed' ||
    state === 'cancelled'
  );
}

function assertBudgetDelegation(parent: BudgetEnvelope, child: BudgetEnvelope): void {
  const parentFields = [parent.limit, parent.reserved, parent.consumed];
  const childFields = [child.limit, child.reserved, child.consumed];
  if (
    child.budgetId !== parent.budgetId ||
    parentFields.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    childFields.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    parent.reserved + parent.consumed > parent.limit ||
    child.reserved + child.consumed > child.limit ||
    parent.currency !== child.currency
  ) {
    throw runtimeError('BUDGET_EXCEEDED', 'Child budget currency does not match parent budget');
  }
  if (child.limit > parent.limit - parent.reserved - parent.consumed) {
    throw runtimeError('BUDGET_EXCEEDED', 'Child budget exceeds the parent available budget');
  }
}

function assertSubset(parent: readonly string[], child: readonly string[], label: string): void {
  if (child.some((entry) => !parent.includes(entry))) {
    throw runtimeError('AUTHORITY_MISSING', `Child ${label} exceeds delegated authority`);
  }
}

function assertSelectorSubset(
  parent: readonly ResourceSelector[],
  child: readonly ResourceSelector[],
  label: string,
): void {
  if (child.some((entry) => !parent.some((scope) => selectorAllows(scope, entry)))) {
    throw runtimeError('AUTHORITY_MISSING', `Child ${label} exceeds delegated authority`);
  }
}

export function assertInvocationHierarchy(
  parentTier: AgentInvocation['tier'],
  childTier: AgentInvocation['tier'],
): void {
  if (!mayInvoke(parentTier, childTier)) {
    throw runtimeError(
      'INVOCATION_TIER_VIOLATION',
      `Tier ${parentTier} cannot invoke tier ${childTier}`,
    );
  }
}

export class InvocationService {
  private readonly state: StateStore;
  private readonly authority: InvocationServiceOptions['authority'];
  private readonly registry: HarnessRegistryPort | undefined;

  constructor(options: InvocationServiceOptions) {
    this.state = options.state;
    this.authority = options.authority;
    this.registry = options.registry;
  }

  async create(request: InvocationCreateRequest): Promise<VersionedAggregate<AgentInvocation>> {
    const child = request.child;
    if (
      !isContract('AgentInvocation', child) ||
      !isContract('AgentRegistration', request.registration)
    ) {
      throw runtimeError(
        'VALIDATION_SCHEMA_MISMATCH',
        'Invocation or registration failed contract validation',
      );
    }
    if (request.depth < 0 || request.depth > request.maxDepth || request.maxDepth < 0) {
      throw runtimeError(
        'INVOCATION_INVALID_PARENT',
        'Invocation depth exceeds the configured maximum',
      );
    }
    if (request.currentChildCount < 0) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Child count cannot be negative');
    }
    if (request.registration.status !== 'active') {
      throw runtimeError('INVOCATION_INVALID_PARENT', 'Child agent registration is not active');
    }
    const registeredChild = this.registry?.assertCompatible({
      agentType: child.agentType,
      version: child.harnessVersion,
      requiredContracts: ['AgentInvocation.v1', 'AgentReport.v1'],
    });
    if (
      request.registration.agentId !== child.authority.subjectAgentId ||
      request.registration.agentType !== child.agentType ||
      request.registration.tier !== child.tier ||
      request.registration.version !== child.harnessVersion
    ) {
      throw runtimeError(
        'INVOCATION_INVALID_PARENT',
        'Child registration does not match invocation identity',
      );
    }
    if (
      !request.registration.supportedContracts.includes('AgentInvocation.v1') ||
      !request.registration.supportedContracts.includes('AgentReport.v1')
    ) {
      throw runtimeError(
        'INVOCATION_INVALID_PARENT',
        'Child registration does not support invocation and report contracts',
      );
    }
    registeredChild?.harness.validateInput(child.input);
    this.authority.verify(child.authority, request.now);
    if (
      child.authority.tenant.tenantId !== child.tenant.tenantId ||
      child.authority.tenant.workspaceId !== child.tenant.workspaceId ||
      child.authority.workflowId !== child.workflowId ||
      child.authority.invocationId !== child.invocationId ||
      child.authority.tier !== child.tier ||
      child.authority.harnessVersion !== child.harnessVersion
    ) {
      throw runtimeError(
        'AUTHORITY_MISSING',
        'Child authority is not bound to the child invocation',
      );
    }

    if (request.parent === undefined) {
      throw runtimeError(
        'INVOCATION_INVALID_PARENT',
        'Child invocation requires a parent invocation',
      );
    }
    const parent = request.parent;
    this.authority.verify(parent.authority, request.now);
    if (
      parent.authority.tenant.tenantId !== parent.tenant.tenantId ||
      parent.authority.tenant.workspaceId !== parent.tenant.workspaceId ||
      parent.authority.workflowId !== parent.workflowId ||
      parent.authority.invocationId !== parent.invocationId ||
      parent.authority.tier !== parent.tier ||
      parent.authority.harnessVersion !== parent.harnessVersion
    ) {
      throw runtimeError(
        'AUTHORITY_MISSING',
        'Parent authority is not bound to the parent invocation',
      );
    }
    if (isTerminal(parent.state)) {
      throw runtimeError(
        'INVOCATION_INVALID_PARENT',
        'Cannot create a child from a terminal parent',
      );
    }
    if (!sameTenant(parent, child) || parent.workflowId !== child.workflowId) {
      throw runtimeError('POLICY_DENIED', 'Parent and child invocation scope does not match');
    }
    if (child.parentInvocationId !== parent.invocationId) {
      throw runtimeError(
        'INVOCATION_INVALID_PARENT',
        'Child parentInvocationId does not match the parent',
      );
    }
    assertInvocationHierarchy(parent.tier, child.tier);
    this.registry?.assertChildAllowed(
      parent.agentType,
      parent.harnessVersion,
      child.agentType,
      child.tier,
    );
    if (request.delegatingAuthority.envelopeId !== parent.authority.envelopeId) {
      throw runtimeError(
        'AUTHORITY_MISSING',
        'Child creation must be delegated by the parent invocation authority',
      );
    }
    assertBudgetDelegation(parent.budget, child.budget);
    assertSubset(parent.authority.permittedActions, child.authority.permittedActions, 'actions');
    assertSubset(parent.authority.capabilities, child.authority.capabilities, 'capabilities');
    this.authority.assertResourceScopes(
      parent.authority,
      child.authority.resourceScopes,
      request.now,
    );
    assertSelectorSubset(
      parent.authority.allowedArtifactReads,
      child.authority.allowedArtifactReads,
      'artifact read scopes',
    );
    assertSelectorSubset(
      parent.authority.allowedArtifactWrites,
      child.authority.allowedArtifactWrites,
      'artifact write scopes',
    );
    assertSubset(
      parent.authority.toolOperations,
      child.authority.toolOperations,
      'tool operations',
    );
    assertSubset(
      parent.authority.allowedChildAgentTypes,
      child.authority.allowedChildAgentTypes,
      'child types',
    );
    if (child.authority.maxChildCount > parent.authority.maxChildCount) {
      throw runtimeError('AUTHORITY_MISSING', 'Child maxChildCount exceeds delegated authority');
    }
    return this.state.transaction(async (transaction) => {
      const persistedParent = await transaction.invocations.getForUpdate(
        parent.tenant,
        parent.invocationId,
      );
      if (persistedParent === undefined) {
        throw runtimeError('INVOCATION_INVALID_PARENT', 'Parent invocation is not persisted');
      }
      if (sha256Digest(persistedParent.value) !== sha256Digest(parent)) {
        throw runtimeError('CONCURRENCY_STALE_VERSION', 'Parent invocation lifecycle is stale');
      }
      if (isTerminal(persistedParent.value.state)) {
        throw runtimeError(
          'INVOCATION_INVALID_PARENT',
          'Cannot create a child from a terminal parent',
        );
      }
      const actualChildCount = await transaction.invocations.countChildren(
        parent.tenant,
        parent.invocationId,
      );
      if (actualChildCount !== request.currentChildCount) {
        throw runtimeError(
          'CONCURRENCY_STALE_VERSION',
          `Parent child count is stale: expected ${request.currentChildCount}, actual ${actualChildCount}`,
        );
      }
      this.authority.assertAuthorized(request.delegatingAuthority, {
        tenant: parent.tenant,
        workflowId: parent.workflowId,
        invocationId: parent.invocationId,
        actorId: request.delegatingAuthority.subjectAgentId,
        action: 'invocation.create',
        childAgentType: child.agentType,
        childCount: actualChildCount + 1,
        now: request.now,
      });
      return transaction.invocations.create(child.tenant, child.invocationId, child, request.now);
    });
  }

  async get(
    tenant: AgentInvocation['tenant'],
    invocationId: Id,
  ): Promise<VersionedAggregate<AgentInvocation> | undefined> {
    return this.state.transaction((transaction) =>
      transaction.invocations.get(tenant, invocationId),
    );
  }
}
