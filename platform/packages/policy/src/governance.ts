import {
  makeMoney,
  newSortableId,
  runtimeError,
  type Actor,
  type Currency,
  type HashSha256,
  type Id,
  type JsonValue,
  type Money,
  type ResourceSelector,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import { canonicalJson, sha256Digest } from './canonical.js';

/** The roles understood by the organization governance boundary. */
export type GovernanceRole = 'owner' | 'admin' | 'operator' | 'editor' | 'analyst' | 'viewer';

export type GovernanceMembershipStatus = 'active' | 'suspended' | 'removed';
export type GovernanceDecisionOutcome = 'allowed' | 'approval_required' | 'blocked' | 'denied';
export type DataClassificationV1 = 'public' | 'internal' | 'confidential' | 'restricted';
export type GovernanceUsageCategory =
  | 'llm'
  | 'compute'
  | 'storage'
  | 'external_api'
  | 'retry'
  | 'other';

export interface GovernanceScopeV1 {
  readonly organizationId: Id;
  readonly workspaceId?: Id;
  readonly projectId?: Id;
}

export interface GovernanceOrganizationV1 {
  readonly organizationId: Id;
  readonly tenant: TenantRef;
  readonly name: string;
  readonly policyVersion: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GovernanceMembershipV1 {
  readonly membershipId: Id;
  readonly tenant: TenantRef;
  readonly organizationId: Id;
  readonly actorId: Id;
  readonly displayName?: string;
  readonly email?: string;
  readonly role: GovernanceRole;
  readonly scopes: readonly GovernanceScopeV1[];
  readonly status: GovernanceMembershipStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GovernancePolicyV1 {
  readonly policyId: Id;
  readonly tenant: TenantRef;
  readonly organizationId: Id;
  readonly version: string;
  readonly scope: GovernanceScopeV1;
  readonly allowedDataClasses: readonly DataClassificationV1[];
  readonly blockedActions: readonly string[];
  readonly approvalActions: readonly string[];
  readonly approvalCostThresholdMinor?: number;
  readonly maxExecutionCostMinor?: number;
  readonly allowedInterfaces?: readonly string[];
  /** Provider identifiers allowed to service governed Runs in this scope. */
  readonly allowedProviders?: readonly string[];
  readonly allowedRuntimes?: readonly string[];
  readonly retentionDays?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GovernanceBudgetV1 {
  readonly budgetId: Id;
  readonly tenant: TenantRef;
  readonly organizationId: Id;
  readonly scope: GovernanceScopeV1;
  readonly currency: Currency;
  readonly hardLimitMinor: number;
  readonly softLimitMinor: number;
  readonly alertThresholds: readonly number[];
  readonly blockedActions: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GovernanceUsageRecordV1 {
  readonly usageId: Id;
  readonly tenant: TenantRef;
  readonly organizationId: Id;
  readonly workspaceId: Id;
  readonly projectId?: Id;
  readonly actorId: Id;
  readonly runId?: Id;
  readonly category: GovernanceUsageCategory;
  readonly amount: Money;
  readonly quantity?: number;
  readonly target?: ResourceSelector;
  readonly interfaceName: string;
  readonly occurredAt: string;
}

export interface GovernanceUsageSummaryV1 {
  readonly tenant: TenantRef;
  readonly organizationId: Id;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly currency: Currency;
  readonly consumedMinor: number;
  readonly byCategory: Readonly<Record<GovernanceUsageCategory, number>>;
  readonly byActor: Readonly<Record<string, number>>;
  readonly byProject: Readonly<Record<string, number>>;
  readonly matchingBudget?: GovernanceBudgetV1 & { readonly remainingMinor: number };
}

export type GovernanceAlertKind = 'soft_limit' | 'hard_limit' | 'forecast_threshold';

export interface GovernanceAlertV1 {
  readonly alertId: Id;
  readonly tenant: TenantRef;
  readonly organizationId: Id;
  readonly budgetId: Id;
  readonly kind: GovernanceAlertKind;
  readonly thresholdMinor: number;
  readonly observedMinor: number;
  readonly message: string;
  readonly occurredAt: string;
}

export interface GovernanceEvaluationInput {
  readonly tenant: TenantRef;
  readonly organizationId: Id;
  readonly workspaceId: Id;
  readonly projectId?: Id;
  readonly actor: Actor;
  readonly action: string;
  readonly target: readonly ResourceSelector[];
  readonly dataClassification?: DataClassificationV1;
  readonly estimatedCost?: Money;
  readonly runId?: Id;
  readonly interfaceName: string;
  readonly providerId?: string;
  readonly runtimeName?: string;
  readonly now?: string;
}

export interface GovernanceDecisionV1 {
  readonly decisionId: Id;
  readonly organizationId: Id;
  readonly policyId?: Id;
  readonly policyVersion: string;
  readonly inputDigest: HashSha256;
  readonly outcome: GovernanceDecisionOutcome;
  readonly obligations: readonly string[];
  readonly reasonCodes: readonly string[];
  readonly decidedAt: string;
}

export interface GovernanceApprovalContextV1 {
  readonly approved: boolean;
  readonly approvalId?: Id;
  readonly actionDigest: HashSha256;
  readonly approvedBy?: Actor;
  readonly expiresAt?: string;
}

export interface GovernanceAuditRecordV1 {
  readonly auditId: Id;
  readonly tenant: TenantRef;
  readonly organizationId: Id;
  readonly actor: Actor;
  readonly action: string;
  readonly target: readonly ResourceSelector[];
  readonly decision: GovernanceDecisionOutcome | 'executed';
  readonly policyDecisionId: Id;
  readonly before?: JsonValue;
  readonly after?: JsonValue;
  readonly runId?: Id;
  readonly interfaceName: string;
  readonly approvalContext?: JsonValue;
  readonly occurredAt: string;
  readonly previousDigest: string;
  readonly digest: HashSha256;
}

export interface GovernanceCommitInput extends GovernanceEvaluationInput {
  readonly approvalContext?: GovernanceApprovalContextV1;
  readonly before?: JsonValue;
  readonly after?: JsonValue;
  readonly usage?: {
    readonly category: GovernanceUsageCategory;
    readonly amount: Money;
    readonly quantity?: number;
  };
}

export interface GovernanceCommitResultV1 {
  readonly decision: GovernanceDecisionV1;
  readonly audit: GovernanceAuditRecordV1;
  readonly usage?: GovernanceUsageRecordV1;
}

export interface GovernanceForecastV1 {
  readonly tenant: TenantRef;
  readonly organizationId: Id;
  readonly asOf: string;
  readonly horizonDays: number;
  readonly observedDays: number;
  readonly observedMinor: number;
  readonly dailyRunRateMinor: number;
  readonly projectedMinor: number;
  readonly budgetRemainingMinor?: number;
  readonly thresholdState: 'within_budget' | 'approaching_limit' | 'over_limit';
}

/** Durable, versioned state used by local and hosted governance adapters. */
export interface GovernanceStateV1 {
  readonly schemaVersion: 1;
  readonly organizations: readonly GovernanceOrganizationV1[];
  readonly memberships: readonly GovernanceMembershipV1[];
  readonly policies: readonly GovernancePolicyV1[];
  readonly budgets: readonly GovernanceBudgetV1[];
  readonly usage: readonly GovernanceUsageRecordV1[];
  readonly budgetAlerts: readonly GovernanceAlertV1[];
  readonly audits: readonly GovernanceAuditRecordV1[];
}

/** Persistence port; hosted deployments can map this to a transactional store. */
export interface GovernanceStateStore {
  load(): GovernanceStateV1 | undefined;
  save(state: GovernanceStateV1): void;
}

export interface GovernanceService {
  createOrganization(input: {
    readonly tenant: TenantRef;
    readonly name: string;
    readonly actor: Actor;
    readonly organizationId?: Id;
    readonly now?: string;
  }): GovernanceOrganizationV1;
  getOrganization(tenant: TenantRef, organizationId: Id): GovernanceOrganizationV1 | undefined;
  listOrganizations(tenant: TenantRef): readonly GovernanceOrganizationV1[];
  upsertMembership(input: {
    readonly tenant: TenantRef;
    readonly organizationId: Id;
    readonly actorId: Id;
    readonly role: GovernanceRole;
    readonly scopes?: readonly GovernanceScopeV1[];
    readonly displayName?: string;
    readonly email?: string;
    readonly status?: GovernanceMembershipStatus;
    readonly changedBy?: Actor;
    readonly now?: string;
  }): GovernanceMembershipV1;
  listMemberships(tenant: TenantRef, organizationId: Id): readonly GovernanceMembershipV1[];
  putPolicy(input: {
    readonly tenant: TenantRef;
    readonly organizationId: Id;
    readonly version: string;
    readonly scope: GovernanceScopeV1;
    readonly allowedDataClasses?: readonly DataClassificationV1[];
    readonly blockedActions?: readonly string[];
    readonly approvalActions?: readonly string[];
    readonly approvalCostThresholdMinor?: number;
    readonly maxExecutionCostMinor?: number;
    readonly allowedInterfaces?: readonly string[];
    readonly allowedProviders?: readonly string[];
    readonly allowedRuntimes?: readonly string[];
    readonly retentionDays?: number;
    readonly changedBy?: Actor;
    readonly now?: string;
  }): GovernancePolicyV1;
  listPolicies(tenant: TenantRef, organizationId: Id): readonly GovernancePolicyV1[];
  evaluate(input: GovernanceEvaluationInput): GovernanceDecisionV1;
  commit(input: GovernanceCommitInput): GovernanceCommitResultV1;
  setBudget(input: {
    readonly tenant: TenantRef;
    readonly organizationId: Id;
    readonly scope: GovernanceScopeV1;
    readonly currency: string;
    readonly hardLimitMinor: number;
    readonly softLimitMinor: number;
    readonly alertThresholds?: readonly number[];
    readonly blockedActions?: readonly string[];
    readonly budgetId?: Id;
    readonly changedBy?: Actor;
    readonly now?: string;
  }): GovernanceBudgetV1;
  listBudgets(tenant: TenantRef, organizationId: Id): readonly GovernanceBudgetV1[];
  recordUsage(input: {
    readonly tenant: TenantRef;
    readonly organizationId: Id;
    readonly workspaceId: Id;
    readonly projectId?: Id;
    readonly actorId: Id;
    readonly runId?: Id;
    readonly category: GovernanceUsageCategory;
    readonly amount: Money;
    readonly quantity?: number;
    readonly target?: ResourceSelector;
    readonly interfaceName: string;
    readonly occurredAt?: string;
  }): GovernanceUsageRecordV1;
  usageSummary(input: {
    readonly tenant: TenantRef;
    readonly organizationId: Id;
    readonly periodStart: string;
    readonly periodEnd: string;
    readonly workspaceId?: Id;
    readonly projectId?: Id;
  }): GovernanceUsageSummaryV1;
  forecast(input: {
    readonly tenant: TenantRef;
    readonly organizationId: Id;
    readonly asOf?: string;
    readonly horizonDays?: number;
  }): GovernanceForecastV1;
  alerts(tenant: TenantRef, organizationId: Id): readonly GovernanceAlertV1[];
  auditRecords(tenant: TenantRef, organizationId?: Id): readonly GovernanceAuditRecordV1[];
  verifyAudit(tenant: TenantRef, organizationId?: Id): boolean;
}

const roles: readonly GovernanceRole[] = [
  'owner',
  'admin',
  'operator',
  'editor',
  'analyst',
  'viewer',
];
const classifications: readonly DataClassificationV1[] = [
  'public',
  'internal',
  'confidential',
  'restricted',
];
const usageCategories: readonly GovernanceUsageCategory[] = [
  'llm',
  'compute',
  'storage',
  'external_api',
  'retry',
  'other',
];
const roleRank: Record<GovernanceRole, number> = {
  viewer: 1,
  analyst: 2,
  editor: 3,
  operator: 4,
  admin: 5,
  owner: 6,
};

/** Stable role ordering shared by API adapters and product surfaces. */
export const GOVERNANCE_ROLE_RANK: Readonly<Record<GovernanceRole, number>> = roleRank;

export function governanceRoleAllows(role: GovernanceRole, minimum: GovernanceRole): boolean {
  return roleRank[role] >= roleRank[minimum];
}

/**
 * Resolve an active member whose scoped grants cover a workspace/project resource.
 * Adapters use this helper before reading shared resources so tenant equality alone
 * cannot be mistaken for organization membership.
 */
export function governanceMembershipForActor(
  memberships: readonly GovernanceMembershipV1[],
  actorId: Id,
  workspaceId: Id,
  projectId?: Id,
): GovernanceMembershipV1 | undefined {
  return memberships.find(
    (membership) =>
      membership.actorId === actorId &&
      membership.status === 'active' &&
      membership.scopes.some(
        (scope) =>
          (scope.workspaceId === undefined || scope.workspaceId === workspaceId) &&
          (scope.projectId === undefined || scope.projectId === projectId),
      ),
  );
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function tenantKey(tenant: TenantRef): string {
  return `${tenant.tenantId}:${tenant.workspaceId}`;
}

function organizationKey(tenant: TenantRef, organizationId: Id): string {
  return `${tenantKey(tenant)}:${organizationId}`;
}

function scopeKey(scope: GovernanceScopeV1): string {
  return `${scope.organizationId}:${scope.workspaceId ?? '*'}:${scope.projectId ?? '*'}`;
}

function sameTenant(left: TenantRef, right: TenantRef): boolean {
  return left.tenantId === right.tenantId && left.workspaceId === right.workspaceId;
}

function assertText(value: string, label: string, max = 320): string {
  if (value.trim().length === 0 || value.length > max)
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} is required`);
  return value.trim();
}

function assertInteger(value: number, label: string, positive = false): void {
  if (!Number.isSafeInteger(value) || value < 0 || (positive && value === 0))
    throw runtimeError(
      'VALIDATION_INVALID_INPUT',
      `${label} must be a ${positive ? 'positive' : 'non-negative'} integer`,
    );
}

function assertScope(scope: GovernanceScopeV1, organizationId: Id): GovernanceScopeV1 {
  if (scope.organizationId !== organizationId)
    throw runtimeError(
      'AUTHORITY_SCOPE_VIOLATION',
      'Governance scope crosses organization boundary',
    );
  return {
    organizationId,
    ...(scope.workspaceId === undefined ? {} : { workspaceId: scope.workspaceId }),
    ...(scope.projectId === undefined ? {} : { projectId: scope.projectId }),
  };
}

function matchesScope(
  scope: GovernanceScopeV1,
  organizationId: Id,
  workspaceId: Id,
  projectId: Id | undefined,
): boolean {
  return (
    scope.organizationId === organizationId &&
    (scope.workspaceId === undefined || scope.workspaceId === workspaceId) &&
    (scope.projectId === undefined || scope.projectId === projectId)
  );
}

function specificity(scope: GovernanceScopeV1): number {
  return (scope.workspaceId === undefined ? 0 : 1) + (scope.projectId === undefined ? 0 : 1);
}

function actionMatches(pattern: string, action: string): boolean {
  return pattern === action || (pattern.endsWith('*') && action.startsWith(pattern.slice(0, -1)));
}

function redact(value: JsonValue | undefined): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    return value
      .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
      .replace(/(?:postgres|mysql|mongodb):\/\/[^\s]+/gi, '[REDACTED]');
  }
  if (Array.isArray(value)) return value.map((child) => redact(child) as JsonValue);
  if (value !== null && typeof value === 'object') {
    const result: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      result[key] =
        /(secret|token|password|api[_-]?key|private[_-]?key|authorization|cookie)/i.test(key)
          ? '[REDACTED]'
          : (redact(child) as JsonValue);
    }
    return result;
  }
  return value;
}

function emptyCategories(): Record<GovernanceUsageCategory, number> {
  return {
    llm: 0,
    compute: 0,
    storage: 0,
    external_api: 0,
    retry: 0,
    other: 0,
  };
}

function nowDate(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    throw runtimeError('VALIDATION_INVALID_INPUT', `Invalid time: ${value}`);
  return parsed;
}

function digestAudit(record: Omit<GovernanceAuditRecordV1, 'digest'>): HashSha256 {
  return sha256Digest(record);
}

export class InMemoryGovernanceService implements GovernanceService {
  private readonly organizations = new Map<string, GovernanceOrganizationV1>();
  private readonly memberships = new Map<string, GovernanceMembershipV1>();
  private readonly policies = new Map<string, GovernancePolicyV1>();
  private readonly budgets = new Map<string, GovernanceBudgetV1>();
  private readonly usage: GovernanceUsageRecordV1[] = [];
  private readonly budgetAlerts: GovernanceAlertV1[] = [];
  private readonly audits: GovernanceAuditRecordV1[] = [];
  private readonly clock: () => string;
  private readonly store: GovernanceStateStore | undefined;

  constructor(clock: () => string = () => new Date().toISOString(), store?: GovernanceStateStore) {
    this.clock = clock;
    this.store = store;
    const state = store?.load();
    if (state?.schemaVersion === 1) {
      for (const organization of state.organizations)
        this.organizations.set(
          organizationKey(organization.tenant, organization.organizationId),
          clone(organization),
        );
      for (const membership of state.memberships)
        this.memberships.set(
          `${organizationKey(membership.tenant, membership.organizationId)}:${membership.actorId}`,
          clone(membership),
        );
      for (const policy of state.policies)
        this.policies.set(
          `${organizationKey(policy.tenant, policy.organizationId)}:${scopeKey(policy.scope)}`,
          clone(policy),
        );
      for (const budget of state.budgets)
        this.budgets.set(
          `${organizationKey(budget.tenant, budget.organizationId)}:${scopeKey(budget.scope)}`,
          clone(budget),
        );
      this.usage.push(...state.usage.map((record) => clone(record)));
      this.budgetAlerts.push(...state.budgetAlerts.map((alert) => clone(alert)));
      this.audits.push(...state.audits.map((record) => clone(record)));
    }
  }

  snapshot(): GovernanceStateV1 {
    return clone({
      schemaVersion: 1,
      organizations: [...this.organizations.values()],
      memberships: [...this.memberships.values()],
      policies: [...this.policies.values()],
      budgets: [...this.budgets.values()],
      usage: this.usage,
      budgetAlerts: this.budgetAlerts,
      audits: this.audits,
    });
  }

  private persist(): void {
    this.store?.save(this.snapshot());
  }

  createOrganization(input: {
    readonly tenant: TenantRef;
    readonly name: string;
    readonly actor: Actor;
    readonly organizationId?: Id;
    readonly now?: string;
  }): GovernanceOrganizationV1 {
    const name = assertText(input.name, 'Organization name');
    const now = input.now ?? this.clock();
    const organizationId = input.organizationId ?? newSortableId();
    const key = organizationKey(input.tenant, organizationId);
    if (this.organizations.has(key))
      throw runtimeError('CONCURRENCY_STALE_VERSION', 'Organization already exists');
    const organization: GovernanceOrganizationV1 = {
      organizationId,
      tenant: clone(input.tenant),
      name,
      policyVersion: 'governance.v1',
      createdAt: now,
      updatedAt: now,
    };
    this.organizations.set(key, organization);
    this.memberships.set(`${key}:${input.actor.actorId}`, {
      membershipId: newSortableId(),
      tenant: clone(input.tenant),
      organizationId,
      actorId: input.actor.actorId,
      ...(input.actor.displayName === undefined ? {} : { displayName: input.actor.displayName }),
      role: 'owner',
      scopes: [{ organizationId }],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    this.putPolicy({
      tenant: input.tenant,
      organizationId,
      version: organization.policyVersion,
      scope: { organizationId },
      changedBy: input.actor,
      now,
    });
    this.persist();
    return clone(organization);
  }

  getOrganization(tenant: TenantRef, organizationId: Id): GovernanceOrganizationV1 | undefined {
    const organization = this.organizations.get(organizationKey(tenant, organizationId));
    return organization === undefined ? undefined : clone(organization);
  }

  listOrganizations(tenant: TenantRef): readonly GovernanceOrganizationV1[] {
    return clone(
      [...this.organizations.values()].filter((organization) =>
        sameTenant(organization.tenant, tenant),
      ),
    );
  }

  upsertMembership(input: {
    readonly tenant: TenantRef;
    readonly organizationId: Id;
    readonly actorId: Id;
    readonly role: GovernanceRole;
    readonly scopes?: readonly GovernanceScopeV1[];
    readonly displayName?: string;
    readonly email?: string;
    readonly status?: GovernanceMembershipStatus;
    readonly changedBy?: Actor;
    readonly now?: string;
  }): GovernanceMembershipV1 {
    this.requireOrganization(input.tenant, input.organizationId);
    this.assertManager(input.tenant, input.organizationId, input.changedBy);
    if (!roles.includes(input.role))
      throw runtimeError('VALIDATION_INVALID_INPUT', `Unknown governance role ${input.role}`);
    const now = input.now ?? this.clock();
    const key = `${organizationKey(input.tenant, input.organizationId)}:${input.actorId}`;
    const existing = this.memberships.get(key);
    const scopes = (input.scopes ?? [{ organizationId: input.organizationId }]).map((scope) =>
      assertScope(scope, input.organizationId),
    );
    const membership: GovernanceMembershipV1 = {
      membershipId: existing?.membershipId ?? newSortableId(),
      tenant: clone(input.tenant),
      organizationId: input.organizationId,
      actorId: input.actorId,
      ...(input.displayName === undefined
        ? existing?.displayName === undefined
          ? {}
          : { displayName: existing.displayName }
        : { displayName: assertText(input.displayName, 'Membership display name') }),
      ...(input.email === undefined
        ? existing?.email === undefined
          ? {}
          : { email: existing.email }
        : { email: assertText(input.email, 'Membership email') }),
      role: input.role,
      scopes,
      status: input.status ?? existing?.status ?? 'active',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.memberships.set(key, membership);
    this.persist();
    return clone(membership);
  }

  listMemberships(tenant: TenantRef, organizationId: Id): readonly GovernanceMembershipV1[] {
    this.requireOrganization(tenant, organizationId);
    return clone(
      [...this.memberships.values()].filter(
        (membership) =>
          sameTenant(membership.tenant, tenant) && membership.organizationId === organizationId,
      ),
    );
  }

  putPolicy(input: {
    readonly tenant: TenantRef;
    readonly organizationId: Id;
    readonly version: string;
    readonly scope: GovernanceScopeV1;
    readonly allowedDataClasses?: readonly DataClassificationV1[];
    readonly blockedActions?: readonly string[];
    readonly approvalActions?: readonly string[];
    readonly approvalCostThresholdMinor?: number;
    readonly maxExecutionCostMinor?: number;
    readonly allowedInterfaces?: readonly string[];
    readonly allowedProviders?: readonly string[];
    readonly allowedRuntimes?: readonly string[];
    readonly retentionDays?: number;
    readonly changedBy?: Actor;
    readonly now?: string;
  }): GovernancePolicyV1 {
    this.requireOrganization(input.tenant, input.organizationId);
    this.assertManager(input.tenant, input.organizationId, input.changedBy);
    const version = assertText(input.version, 'Policy version', 120);
    const scope = assertScope(input.scope, input.organizationId);
    const allowedDataClasses = [...(input.allowedDataClasses ?? classifications)];
    if (allowedDataClasses.some((value) => !classifications.includes(value)))
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'Policy contains an unknown data classification',
      );
    for (const value of [input.approvalCostThresholdMinor, input.maxExecutionCostMinor]) {
      if (value !== undefined) assertInteger(value, 'Policy cost limit');
    }
    if (
      input.approvalCostThresholdMinor !== undefined &&
      input.maxExecutionCostMinor !== undefined &&
      input.approvalCostThresholdMinor > input.maxExecutionCostMinor
    ) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'Approval cost threshold cannot exceed the maximum execution cost',
      );
    }
    if (input.retentionDays !== undefined)
      assertInteger(input.retentionDays, 'retentionDays', true);
    const now = input.now ?? this.clock();
    const policy: GovernancePolicyV1 = {
      policyId: newSortableId(),
      tenant: clone(input.tenant),
      organizationId: input.organizationId,
      version,
      scope,
      allowedDataClasses,
      blockedActions: [...(input.blockedActions ?? [])].map((value) =>
        assertText(value, 'Blocked action', 160),
      ),
      approvalActions: [...(input.approvalActions ?? [])].map((value) =>
        assertText(value, 'Approval action', 160),
      ),
      ...(input.approvalCostThresholdMinor === undefined
        ? {}
        : { approvalCostThresholdMinor: input.approvalCostThresholdMinor }),
      ...(input.maxExecutionCostMinor === undefined
        ? {}
        : { maxExecutionCostMinor: input.maxExecutionCostMinor }),
      ...(input.allowedInterfaces === undefined
        ? {}
        : {
            allowedInterfaces: input.allowedInterfaces.map((value) =>
              assertText(value, 'Interface'),
            ),
          }),
      ...(input.allowedProviders === undefined
        ? {}
        : {
            allowedProviders: input.allowedProviders.map((value) => assertText(value, 'Provider')),
          }),
      ...(input.allowedRuntimes === undefined
        ? {}
        : { allowedRuntimes: input.allowedRuntimes.map((value) => assertText(value, 'Runtime')) }),
      ...(input.retentionDays === undefined ? {} : { retentionDays: input.retentionDays }),
      createdAt: now,
      updatedAt: now,
    };
    this.policies.set(
      `${organizationKey(input.tenant, input.organizationId)}:${scopeKey(scope)}`,
      policy,
    );
    const organization = this.organizations.get(
      organizationKey(input.tenant, input.organizationId),
    );
    if (organization !== undefined)
      this.organizations.set(organizationKey(input.tenant, input.organizationId), {
        ...organization,
        policyVersion: version,
        updatedAt: now,
      });
    this.persist();
    return clone(policy);
  }

  listPolicies(tenant: TenantRef, organizationId: Id): readonly GovernancePolicyV1[] {
    this.requireOrganization(tenant, organizationId);
    return clone(
      [...this.policies.values()].filter(
        (policy) => sameTenant(policy.tenant, tenant) && policy.organizationId === organizationId,
      ),
    );
  }

  evaluate(input: GovernanceEvaluationInput): GovernanceDecisionV1 {
    const now = input.now ?? this.clock();
    this.requireOrganization(input.tenant, input.organizationId);
    const membership = this.requireMembership(
      input.tenant,
      input.organizationId,
      input.actor.actorId,
    );
    const policies = this.listPolicies(input.tenant, input.organizationId)
      .filter((policy) =>
        matchesScope(policy.scope, input.organizationId, input.workspaceId, input.projectId),
      )
      .sort((left, right) => specificity(right.scope) - specificity(left.scope));
    const policy = policies[0];
    const organization = this.organizations.get(
      organizationKey(input.tenant, input.organizationId),
    );
    const reasons: string[] = [];
    const obligations: string[] = [];
    if (membership.status !== 'active') reasons.push('membership_inactive');
    if (
      !membership.scopes.some((scope) =>
        matchesScope(scope, input.organizationId, input.workspaceId, input.projectId),
      )
    )
      reasons.push('membership_scope_denied');
    if (policy === undefined) reasons.push('policy_missing');
    if (policy !== undefined) {
      if (
        input.dataClassification !== undefined &&
        !policy.allowedDataClasses.includes(input.dataClassification)
      )
        reasons.push('data_classification_blocked');
      if (policy.blockedActions.some((pattern) => actionMatches(pattern, input.action)))
        reasons.push('action_blocked');
      if (
        policy.allowedInterfaces !== undefined &&
        !policy.allowedInterfaces.includes(input.interfaceName)
      )
        reasons.push('interface_not_allowed');
      if (
        input.providerId !== undefined &&
        policy.allowedProviders !== undefined &&
        !policy.allowedProviders.includes(input.providerId)
      )
        reasons.push('provider_not_allowed');
      if (
        input.runtimeName !== undefined &&
        policy.allowedRuntimes !== undefined &&
        !policy.allowedRuntimes.includes(input.runtimeName)
      )
        reasons.push('runtime_not_allowed');
      if (
        input.estimatedCost !== undefined &&
        policy.maxExecutionCostMinor !== undefined &&
        input.estimatedCost.amountMinor > policy.maxExecutionCostMinor
      )
        reasons.push('execution_cost_limit');
    }
    const budget = this.matchingBudget(
      input.tenant,
      input.organizationId,
      input.workspaceId,
      input.projectId,
    );
    if (
      budget !== undefined &&
      input.estimatedCost !== undefined &&
      (input.estimatedCost.currency !== budget.currency ||
        input.estimatedCost.amountMinor > this.remainingForBudget(budget))
    )
      reasons.push('budget_hard_limit');
    if (reasons.length > 0) {
      const hardBlock = reasons.some((reason) =>
        [
          'membership_inactive',
          'membership_scope_denied',
          'policy_missing',
          'data_classification_blocked',
          'action_blocked',
          'interface_not_allowed',
          'provider_not_allowed',
          'runtime_not_allowed',
          'execution_cost_limit',
          'budget_hard_limit',
        ].includes(reason),
      );
      return this.decision(
        input,
        organization?.policyVersion ?? policy?.version ?? 'governance.unknown',
        policy,
        hardBlock ? 'blocked' : 'denied',
        obligations,
        reasons,
        now,
      );
    }
    const approvalRequired =
      policy !== undefined &&
      (policy.approvalActions.some((pattern) => actionMatches(pattern, input.action)) ||
        (policy.approvalCostThresholdMinor !== undefined &&
          input.estimatedCost !== undefined &&
          input.estimatedCost.amountMinor >= policy.approvalCostThresholdMinor));
    if (approvalRequired) {
      obligations.push('approval');
      return this.decision(
        input,
        policy.version,
        policy,
        'approval_required',
        obligations,
        ['approval_policy'],
        now,
      );
    }
    if (budget !== undefined && input.estimatedCost !== undefined) {
      const remaining = this.remainingForBudget(budget);
      if (remaining > 0 && input.estimatedCost.amountMinor >= remaining * 0.8)
        obligations.push('budget_threshold');
    }
    return this.decision(
      input,
      policy?.version ?? organization?.policyVersion ?? 'governance.v1',
      policy,
      'allowed',
      obligations,
      [],
      now,
    );
  }

  commit(input: GovernanceCommitInput): GovernanceCommitResultV1 {
    const decision = this.evaluate(input);
    const now = input.now ?? this.clock();
    if (decision.outcome === 'blocked' || decision.outcome === 'denied') {
      this.appendAudit(input, decision, decision.outcome, now);
      throw runtimeError('POLICY_DENIED', `Governance policy ${decision.reasonCodes.join(', ')}`);
    }
    if (decision.outcome === 'approval_required') {
      const approval = input.approvalContext;
      if (approval === undefined || !approval.approved) {
        this.appendAudit(input, decision, 'approval_required', now);
        throw runtimeError('APPROVAL_REQUIRED', 'Governance approval is required before commit');
      }
      if (approval.actionDigest !== decision.inputDigest) {
        this.appendAudit(input, decision, 'approval_required', now);
        throw runtimeError('APPROVAL_INVALIDATED', 'Governance approval does not match the action');
      }
      if (approval.expiresAt !== undefined && Date.parse(approval.expiresAt) <= Date.parse(now)) {
        this.appendAudit(input, decision, 'approval_required', now);
        throw runtimeError('APPROVAL_INVALIDATED', 'Governance approval has expired');
      }
    }
    const usage =
      input.usage === undefined
        ? undefined
        : this.recordUsage({
            tenant: input.tenant,
            organizationId: input.organizationId,
            workspaceId: input.workspaceId,
            ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
            actorId: input.actor.actorId,
            ...(input.runId === undefined ? {} : { runId: input.runId }),
            category: input.usage.category,
            amount: input.usage.amount,
            ...(input.usage.quantity === undefined ? {} : { quantity: input.usage.quantity }),
            ...(input.target[0] === undefined ? {} : { target: input.target[0] }),
            interfaceName: input.interfaceName,
            occurredAt: now,
          });
    const audit = this.appendAudit(input, decision, 'executed', now);
    this.persist();
    return { decision, audit, ...(usage === undefined ? {} : { usage }) };
  }

  setBudget(input: {
    readonly tenant: TenantRef;
    readonly organizationId: Id;
    readonly scope: GovernanceScopeV1;
    readonly currency: string;
    readonly hardLimitMinor: number;
    readonly softLimitMinor: number;
    readonly alertThresholds?: readonly number[];
    readonly blockedActions?: readonly string[];
    readonly budgetId?: Id;
    readonly changedBy?: Actor;
    readonly now?: string;
  }): GovernanceBudgetV1 {
    this.requireOrganization(input.tenant, input.organizationId);
    this.assertManager(input.tenant, input.organizationId, input.changedBy);
    assertScope(input.scope, input.organizationId);
    assertInteger(input.hardLimitMinor, 'hardLimitMinor');
    assertInteger(input.softLimitMinor, 'softLimitMinor');
    if (input.softLimitMinor > input.hardLimitMinor)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'softLimitMinor cannot exceed hardLimitMinor');
    const thresholds = [...(input.alertThresholds ?? [0.8, 0.9, 1])];
    if (thresholds.some((value) => !Number.isFinite(value) || value <= 0 || value > 1))
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'Budget alert thresholds must be between 0 and 1',
      );
    const now = input.now ?? this.clock();
    const key = `${organizationKey(input.tenant, input.organizationId)}:${scopeKey(input.scope)}`;
    const existing = this.budgets.get(key);
    const budget: GovernanceBudgetV1 = {
      budgetId: input.budgetId ?? existing?.budgetId ?? newSortableId(),
      tenant: clone(input.tenant),
      organizationId: input.organizationId,
      scope: clone(input.scope),
      currency: makeMoney(0, input.currency).currency,
      hardLimitMinor: input.hardLimitMinor,
      softLimitMinor: input.softLimitMinor,
      alertThresholds: thresholds,
      blockedActions: [...(input.blockedActions ?? [])].map((value) =>
        assertText(value, 'Budget blocked action', 160),
      ),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.budgets.set(key, budget);
    this.persist();
    return clone(budget);
  }

  listBudgets(tenant: TenantRef, organizationId: Id): readonly GovernanceBudgetV1[] {
    this.requireOrganization(tenant, organizationId);
    return clone(
      [...this.budgets.values()].filter(
        (budget) => sameTenant(budget.tenant, tenant) && budget.organizationId === organizationId,
      ),
    );
  }

  recordUsage(input: {
    readonly tenant: TenantRef;
    readonly organizationId: Id;
    readonly workspaceId: Id;
    readonly projectId?: Id;
    readonly actorId: Id;
    readonly runId?: Id;
    readonly category: GovernanceUsageCategory;
    readonly amount: Money;
    readonly quantity?: number;
    readonly target?: ResourceSelector;
    readonly interfaceName: string;
    readonly occurredAt?: string;
  }): GovernanceUsageRecordV1 {
    this.requireOrganization(input.tenant, input.organizationId);
    const membership = this.requireMembership(input.tenant, input.organizationId, input.actorId);
    if (
      !membership.scopes.some((scope) =>
        matchesScope(scope, input.organizationId, input.workspaceId, input.projectId),
      )
    ) {
      throw runtimeError('AUTHORITY_SCOPE_VIOLATION', 'Usage scope is not assigned to this member');
    }
    if (!usageCategories.includes(input.category))
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Unknown usage category');
    assertInteger(input.amount.amountMinor, 'Usage amount');
    if (input.quantity !== undefined && (!Number.isFinite(input.quantity) || input.quantity < 0))
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Usage quantity must be non-negative');
    const occurredAt = input.occurredAt ?? this.clock();
    const budget = this.matchingBudget(
      input.tenant,
      input.organizationId,
      input.workspaceId,
      input.projectId,
    );
    if (budget !== undefined) {
      if (budget.currency !== input.amount.currency)
        throw runtimeError(
          'BUDGET_EXCEEDED',
          'Usage currency does not match the governance budget',
        );
      const prior = this.usageForBudget(budget, occurredAt);
      const next = prior + input.amount.amountMinor;
      if (next > budget.hardLimitMinor) {
        this.addAlert(budget, 'hard_limit', budget.hardLimitMinor, next, occurredAt);
        throw runtimeError('BUDGET_EXCEEDED', 'Usage exceeds the governance hard budget limit');
      }
      if (prior < budget.softLimitMinor && next >= budget.softLimitMinor)
        this.addAlert(budget, 'soft_limit', budget.softLimitMinor, next, occurredAt);
      for (const threshold of budget.alertThresholds) {
        const thresholdMinor = Math.floor(budget.hardLimitMinor * threshold);
        if (prior < thresholdMinor && next >= thresholdMinor)
          this.addAlert(
            budget,
            threshold >= 1 ? 'hard_limit' : 'soft_limit',
            thresholdMinor,
            next,
            occurredAt,
          );
      }
    }
    const record: GovernanceUsageRecordV1 = {
      usageId: newSortableId(),
      tenant: clone(input.tenant),
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      actorId: input.actorId,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      category: input.category,
      amount: clone(input.amount),
      ...(input.quantity === undefined ? {} : { quantity: input.quantity }),
      ...(input.target === undefined ? {} : { target: clone(input.target) }),
      interfaceName: assertText(input.interfaceName, 'Usage interface', 160),
      occurredAt,
    };
    this.usage.push(record);
    this.persist();
    return clone(record);
  }

  usageSummary(input: {
    readonly tenant: TenantRef;
    readonly organizationId: Id;
    readonly periodStart: string;
    readonly periodEnd: string;
    readonly workspaceId?: Id;
    readonly projectId?: Id;
  }): GovernanceUsageSummaryV1 {
    this.requireOrganization(input.tenant, input.organizationId);
    const start = nowDate(input.periodStart);
    const end = nowDate(input.periodEnd);
    if (end < start) throw runtimeError('VALIDATION_INVALID_INPUT', 'Usage period is inverted');
    const matching = this.usage.filter(
      (record) =>
        sameTenant(record.tenant, input.tenant) &&
        record.organizationId === input.organizationId &&
        (input.workspaceId === undefined || record.workspaceId === input.workspaceId) &&
        (input.projectId === undefined || record.projectId === input.projectId) &&
        Date.parse(record.occurredAt) >= start &&
        Date.parse(record.occurredAt) <= end,
    );
    const byCategory = emptyCategories();
    const byActor: Record<string, number> = {};
    const byProject: Record<string, number> = {};
    let currency: Currency | undefined;
    let consumedMinor = 0;
    for (const record of matching) {
      currency ??= record.amount.currency;
      if (currency !== record.amount.currency)
        throw runtimeError('BUDGET_EXCEEDED', 'Usage summary contains multiple currencies');
      consumedMinor += record.amount.amountMinor;
      byCategory[record.category] += record.amount.amountMinor;
      byActor[record.actorId] = (byActor[record.actorId] ?? 0) + record.amount.amountMinor;
      if (record.projectId !== undefined)
        byProject[record.projectId] =
          (byProject[record.projectId] ?? 0) + record.amount.amountMinor;
    }
    const budget = this.matchingBudget(
      input.tenant,
      input.organizationId,
      input.workspaceId ?? input.tenant.workspaceId,
      input.projectId,
    );
    return {
      tenant: clone(input.tenant),
      organizationId: input.organizationId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      currency: currency ?? budget?.currency ?? makeMoney(0, 'USD').currency,
      consumedMinor,
      byCategory,
      byActor,
      byProject,
      ...(budget === undefined
        ? {}
        : {
            matchingBudget: {
              ...clone(budget),
              remainingMinor: Math.max(0, budget.hardLimitMinor - consumedMinor),
            },
          }),
    };
  }

  forecast(input: {
    readonly tenant: TenantRef;
    readonly organizationId: Id;
    readonly asOf?: string;
    readonly horizonDays?: number;
  }): GovernanceForecastV1 {
    this.requireOrganization(input.tenant, input.organizationId);
    const asOf = input.asOf ?? this.clock();
    const asOfMs = nowDate(asOf);
    const horizonDays = input.horizonDays ?? 30;
    assertInteger(horizonDays, 'horizonDays', true);
    const observedStart = asOfMs - 7 * 24 * 60 * 60 * 1000;
    const observed = this.usage.filter(
      (record) =>
        sameTenant(record.tenant, input.tenant) &&
        record.organizationId === input.organizationId &&
        Date.parse(record.occurredAt) > observedStart &&
        Date.parse(record.occurredAt) <= asOfMs,
    );
    const observedMinor = observed.reduce((sum, record) => sum + record.amount.amountMinor, 0);
    const dailyRunRateMinor = observedMinor / 7;
    const projectedMinor = Math.ceil(dailyRunRateMinor * horizonDays);
    const budget = this.listBudgets(input.tenant, input.organizationId)[0];
    const consumedToDate = this.usage
      .filter(
        (record) =>
          sameTenant(record.tenant, input.tenant) &&
          record.organizationId === input.organizationId &&
          Date.parse(record.occurredAt) <= asOfMs,
      )
      .reduce((sum, record) => sum + record.amount.amountMinor, 0);
    const remaining =
      budget === undefined ? undefined : Math.max(0, budget.hardLimitMinor - consumedToDate);
    const thresholdState =
      budget === undefined || remaining === undefined
        ? 'within_budget'
        : projectedMinor + consumedToDate > budget.hardLimitMinor
          ? 'over_limit'
          : projectedMinor + consumedToDate >= budget.softLimitMinor
            ? 'approaching_limit'
            : 'within_budget';
    if (
      budget !== undefined &&
      remaining !== undefined &&
      projectedMinor + consumedToDate >= budget.softLimitMinor
    ) {
      this.addAlert(
        budget,
        'forecast_threshold',
        budget.softLimitMinor,
        projectedMinor + consumedToDate,
        asOf,
      );
    }
    return {
      tenant: clone(input.tenant),
      organizationId: input.organizationId,
      asOf,
      horizonDays,
      observedDays: 7,
      observedMinor,
      dailyRunRateMinor,
      projectedMinor,
      ...(remaining === undefined ? {} : { budgetRemainingMinor: remaining }),
      thresholdState,
    };
  }

  alerts(tenant: TenantRef, organizationId: Id): readonly GovernanceAlertV1[] {
    this.requireOrganization(tenant, organizationId);
    return clone(
      this.budgetAlerts.filter(
        (alert) => sameTenant(alert.tenant, tenant) && alert.organizationId === organizationId,
      ),
    );
  }

  auditRecords(tenant: TenantRef, organizationId?: Id): readonly GovernanceAuditRecordV1[] {
    return clone(
      this.audits.filter(
        (record) =>
          sameTenant(record.tenant, tenant) &&
          (organizationId === undefined || record.organizationId === organizationId),
      ),
    );
  }

  verifyAudit(tenant: TenantRef, organizationId?: Id): boolean {
    const previousDigestByOrganization = new Map<Id, string>();
    for (const record of this.audits.filter(
      (candidate) =>
        sameTenant(candidate.tenant, tenant) &&
        (organizationId === undefined || candidate.organizationId === organizationId),
    )) {
      const previousDigest = previousDigestByOrganization.get(record.organizationId) ?? 'GENESIS';
      if (record.previousDigest !== previousDigest) return false;
      const { digest, ...withoutDigest } = record;
      if (digestAudit(withoutDigest) !== digest) return false;
      previousDigestByOrganization.set(record.organizationId, digest);
    }
    return true;
  }

  private decision(
    input: GovernanceEvaluationInput,
    policyVersion: string,
    policy: GovernancePolicyV1 | undefined,
    outcome: GovernanceDecisionOutcome,
    obligations: readonly string[],
    reasonCodes: readonly string[],
    decidedAt: string,
  ): GovernanceDecisionV1 {
    return {
      decisionId: newSortableId(),
      organizationId: input.organizationId,
      ...(policy === undefined ? {} : { policyId: policy.policyId }),
      policyVersion,
      inputDigest: sha256Digest({
        tenant: input.tenant,
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        actor: input.actor,
        action: input.action,
        target: input.target,
        dataClassification: input.dataClassification,
        estimatedCost: input.estimatedCost,
        runId: input.runId,
        interfaceName: input.interfaceName,
        providerId: input.providerId,
        runtimeName: input.runtimeName,
      }),
      outcome,
      obligations: [...obligations],
      reasonCodes: [...reasonCodes],
      decidedAt,
    };
  }

  private appendAudit(
    input: GovernanceCommitInput,
    decision: GovernanceDecisionV1,
    result: GovernanceAuditRecordV1['decision'],
    occurredAt: string,
  ): GovernanceAuditRecordV1 {
    let previousDigest = 'GENESIS';
    for (let index = this.audits.length - 1; index >= 0; index -= 1) {
      const candidate = this.audits[index];
      if (candidate !== undefined && sameTenant(candidate.tenant, input.tenant)) {
        if (candidate.organizationId === input.organizationId) previousDigest = candidate.digest;
        break;
      }
    }
    const before = redact(input.before);
    const after = redact(input.after);
    const approvalContext =
      input.approvalContext === undefined
        ? undefined
        : redact(input.approvalContext as unknown as JsonValue);
    const withoutDigest: Omit<GovernanceAuditRecordV1, 'digest'> = {
      auditId: newSortableId(),
      tenant: clone(input.tenant),
      organizationId: input.organizationId,
      actor: clone(input.actor),
      action: input.action,
      target: clone(input.target),
      decision: result,
      policyDecisionId: decision.decisionId,
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      interfaceName: input.interfaceName,
      ...(approvalContext === undefined ? {} : { approvalContext }),
      occurredAt,
      previousDigest,
    };
    const record: GovernanceAuditRecordV1 = {
      ...withoutDigest,
      digest: digestAudit(withoutDigest),
    };
    this.audits.push(record);
    this.persist();
    return clone(record);
  }

  private requireOrganization(tenant: TenantRef, organizationId: Id): GovernanceOrganizationV1 {
    const organization = this.organizations.get(organizationKey(tenant, organizationId));
    if (organization === undefined)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Organization ${organizationId} was not found`);
    return organization;
  }

  private requireMembership(
    tenant: TenantRef,
    organizationId: Id,
    actorId: Id,
  ): GovernanceMembershipV1 {
    const membership = this.memberships.get(
      `${organizationKey(tenant, organizationId)}:${actorId}`,
    );
    if (membership === undefined)
      throw runtimeError('AUTHORITY_SCOPE_VIOLATION', 'Actor is not a member of this organization');
    return membership;
  }

  private assertManager(tenant: TenantRef, organizationId: Id, actor: Actor | undefined): void {
    if (actor === undefined) return;
    const membership = this.requireMembership(tenant, organizationId, actor.actorId);
    if (membership.status !== 'active' || roleRank[membership.role] < roleRank.admin)
      throw runtimeError('POLICY_DENIED', 'Only organization administrators can change governance');
  }

  private matchingBudget(
    tenant: TenantRef,
    organizationId: Id,
    workspaceId: Id,
    projectId: Id | undefined,
  ): GovernanceBudgetV1 | undefined {
    return [...this.budgets.values()]
      .filter(
        (budget) =>
          sameTenant(budget.tenant, tenant) &&
          budget.organizationId === organizationId &&
          matchesScope(budget.scope, organizationId, workspaceId, projectId),
      )
      .sort((left, right) => specificity(right.scope) - specificity(left.scope))[0];
  }

  private usageForBudget(budget: GovernanceBudgetV1, at: string): number {
    return this.usage
      .filter(
        (record) =>
          sameTenant(record.tenant, budget.tenant) &&
          record.organizationId === budget.organizationId &&
          matchesScope(budget.scope, budget.organizationId, record.workspaceId, record.projectId) &&
          record.amount.currency === budget.currency &&
          Date.parse(record.occurredAt) <= Date.parse(at),
      )
      .reduce((sum, record) => sum + record.amount.amountMinor, 0);
  }

  private remainingForBudget(budget: GovernanceBudgetV1): number {
    return Math.max(0, budget.hardLimitMinor - this.usageForBudget(budget, this.clock()));
  }

  private addAlert(
    budget: GovernanceBudgetV1,
    kind: GovernanceAlertKind,
    thresholdMinor: number,
    observedMinor: number,
    occurredAt: string,
  ): void {
    const duplicate = this.budgetAlerts.some(
      (alert) =>
        alert.budgetId === budget.budgetId &&
        alert.kind === kind &&
        alert.thresholdMinor === thresholdMinor &&
        alert.observedMinor === observedMinor,
    );
    if (duplicate) return;
    this.budgetAlerts.push({
      alertId: newSortableId(),
      tenant: clone(budget.tenant),
      organizationId: budget.organizationId,
      budgetId: budget.budgetId,
      kind,
      thresholdMinor,
      observedMinor,
      message:
        kind === 'hard_limit'
          ? 'Governance budget hard limit reached'
          : kind === 'forecast_threshold'
            ? 'Forecast crosses the governance budget threshold'
            : 'Governance budget threshold reached',
      occurredAt,
    });
    this.persist();
  }
}

/** Stable public port for a durable governance control plane. */
export type DurableGovernanceService = GovernanceService;

/** Keep the compiler honest when a caller constructs a budget from untrusted JSON. */
export function governanceMoney(amountMinor: number, currency: string): Money {
  return makeMoney(amountMinor, currency);
}

/** Exposed for adapters that need the same deterministic digest as the audit chain. */
export function governanceCanonical(value: unknown): string {
  return canonicalJson(value);
}
