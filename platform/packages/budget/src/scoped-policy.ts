import {
  makeMoney,
  newSortableId,
  runtimeError,
  type BudgetCategory,
  type Currency,
  type Id,
  type Money,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';

export type BudgetScopeKind = 'organization' | 'workspace' | 'project' | 'agent';

export interface BudgetScopeRef {
  readonly kind: BudgetScopeKind;
  readonly id: Id;
  readonly parentBudgetId?: Id;
}

export type ScopedCategoryTotals = Record<BudgetCategory, number>;

export interface ScopedBudgetDefinition {
  readonly budgetId: Id;
  readonly tenant: TenantRef;
  readonly scope: BudgetScopeRef;
  readonly currency: Currency;
  readonly hardLimitMinor: number;
  readonly softLimitMinor: number;
  readonly categoryHardLimits: ScopedCategoryTotals;
  readonly categorySoftLimits?: Partial<ScopedCategoryTotals>;
  readonly policyVersion: string;
  readonly createdAt: string;
}

export interface ScopedBudgetSnapshot {
  readonly definition: ScopedBudgetDefinition;
  readonly reservedMinor: number;
  readonly consumedMinor: number;
  readonly reservedByCategory: ScopedCategoryTotals;
  readonly consumedByCategory: ScopedCategoryTotals;
  readonly version: number;
}

export interface CostRate {
  readonly providerId?: string;
  readonly modelId?: string;
  readonly unit: 'input_tokens' | 'output_tokens' | 'requests' | 'compute_seconds';
  readonly category: BudgetCategory;
  readonly minorPerUnit: number;
  readonly currency: Currency;
}

export interface CostPolicy {
  readonly policyId: Id;
  readonly tenant: TenantRef;
  readonly scope: BudgetScopeRef;
  readonly policyVersion: string;
  readonly allowedProviders?: readonly string[];
  readonly allowedModels?: readonly string[];
  readonly maxInvocationCostMinor?: number;
  readonly maxRetryAttempts?: number;
  readonly rates: readonly CostRate[];
}

export interface ModelCostEstimateInput {
  readonly tenant: TenantRef;
  readonly providerId: string;
  readonly modelId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly requests?: number;
  readonly currency: Currency;
}

export interface ModelCostEstimate {
  readonly currency: Currency;
  readonly amountMinor: number;
  readonly category: BudgetCategory;
  readonly providerId: string;
  readonly modelId: string;
  readonly breakdown: Readonly<Record<string, number>>;
}

export interface CostPolicyDecision {
  readonly allowed: boolean;
  readonly reason: string;
  readonly policyIds: readonly Id[];
}

export interface ScopedReservationAllocation {
  readonly budgetId: Id;
  readonly amountMinor: number;
  readonly consumedMinor: number;
}

export interface ScopedReservationRecord {
  readonly reservationId: Id;
  readonly tenant: TenantRef;
  readonly invocationId: Id;
  readonly category: BudgetCategory;
  readonly currency: Currency;
  readonly amountMinor: number;
  readonly consumedMinor: number;
  readonly state: 'reserved' | 'partially_consumed' | 'reconciled' | 'released';
  readonly allocations: readonly ScopedReservationAllocation[];
  readonly createdAt: string;
  readonly reconciledAt?: string;
}

export interface ScopedBudgetAlert {
  readonly alertId: Id;
  readonly tenant: TenantRef;
  readonly budgetId: Id;
  readonly kind: 'soft_limit_exceeded' | 'hard_limit_rejected' | 'policy_denied';
  readonly observedMinor: number;
  readonly thresholdMinor: number;
  readonly message: string;
  readonly at: string;
}

export interface ScopedBudgetAuthority {
  assertAllowed(input: {
    readonly tenant: TenantRef;
    readonly action: 'create' | 'reserve' | 'consume' | 'reconcile' | 'release' | 'policy';
    readonly invocationId?: Id;
  }): void;
}

export interface ScopedBudgetLedgerOptions {
  readonly clock?: () => string;
  readonly authority?: ScopedBudgetAuthority;
}

const categories: readonly BudgetCategory[] = [
  'llm',
  'compute',
  'storage',
  'external_api',
  'retry',
];

function emptyTotals(): ScopedCategoryTotals {
  return { llm: 0, compute: 0, storage: 0, external_api: 0, retry: 0 };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function tenantKey(tenant: TenantRef): string {
  return `${tenant.tenantId}:${tenant.workspaceId}`;
}

function budgetKey(tenant: TenantRef, budgetId: Id): string {
  return `${tenantKey(tenant)}:${budgetId}`;
}

function sameTenant(left: TenantRef, right: TenantRef): boolean {
  return left.tenantId === right.tenantId && left.workspaceId === right.workspaceId;
}

function assertInteger(value: number, label: string, positive = false): void {
  if (!Number.isSafeInteger(value) || value < 0 || (positive && value === 0)) {
    throw runtimeError(
      'VALIDATION_INVALID_INPUT',
      `${label} must be a ${positive ? 'positive' : 'non-negative'} integer`,
    );
  }
}

function assertDefinition(definition: ScopedBudgetDefinition): ScopedBudgetDefinition {
  assertInteger(definition.hardLimitMinor, 'hardLimitMinor');
  assertInteger(definition.softLimitMinor, 'softLimitMinor');
  if (definition.softLimitMinor > definition.hardLimitMinor) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'softLimitMinor cannot exceed hardLimitMinor');
  }
  if (definition.policyVersion.trim().length === 0) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Budget policyVersion is required');
  }
  const softLimits = { ...definition.categorySoftLimits };
  for (const category of categories) {
    assertInteger(definition.categoryHardLimits[category], `${category} hard limit`);
    const soft = softLimits[category] ?? definition.categoryHardLimits[category];
    assertInteger(soft, `${category} soft limit`);
    if (soft > definition.categoryHardLimits[category]) {
      throw runtimeError('VALIDATION_INVALID_INPUT', `${category} soft limit exceeds hard limit`);
    }
    softLimits[category] = soft;
  }
  return { ...clone(definition), categorySoftLimits: softLimits };
}

function assertRate(rate: CostRate): void {
  assertInteger(rate.minorPerUnit, 'Cost rate');
  if (rate.currency.length !== 3) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Cost rate currency must be ISO-4217');
  }
}

export class ScopedBudgetLedger {
  private readonly budgets = new Map<string, ScopedBudgetSnapshot>();
  private readonly policies = new Map<string, CostPolicy>();
  private readonly reservations = new Map<string, ScopedReservationRecord>();
  private readonly budgetAlerts: ScopedBudgetAlert[] = [];
  private readonly locks = new Map<string, Promise<void>>();
  private readonly clock: () => string;
  private readonly authority: ScopedBudgetAuthority | undefined;

  constructor(options: ScopedBudgetLedgerOptions = {}) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.authority = options.authority;
  }

  createBudget(definition: ScopedBudgetDefinition): ScopedBudgetSnapshot {
    const normalized = assertDefinition(definition);
    this.authority?.assertAllowed({ tenant: normalized.tenant, action: 'create' });
    const key = budgetKey(normalized.tenant, normalized.budgetId);
    if (this.budgets.has(key)) {
      throw runtimeError(
        'CONCURRENCY_STALE_VERSION',
        `Budget ${normalized.budgetId} already exists`,
      );
    }
    if (normalized.scope.parentBudgetId !== undefined) {
      const parent = this.budgets.get(
        budgetKey(normalized.tenant, normalized.scope.parentBudgetId),
      );
      if (parent === undefined)
        throw runtimeError('ARTIFACT_NOT_FOUND', 'Parent budget was not found');
      if (parent.definition.currency !== normalized.currency) {
        throw runtimeError('VALIDATION_INVALID_INPUT', 'Budget hierarchy currencies must match');
      }
      this.assertNoCycle(normalized.tenant, normalized.scope.parentBudgetId, normalized.budgetId);
    }
    const snapshot: ScopedBudgetSnapshot = {
      definition: normalized,
      reservedMinor: 0,
      consumedMinor: 0,
      reservedByCategory: emptyTotals(),
      consumedByCategory: emptyTotals(),
      version: 0,
    };
    this.budgets.set(key, snapshot);
    return clone(snapshot);
  }

  setPolicy(policy: CostPolicy): CostPolicy {
    if (policy.tenant.tenantId === '' || policy.tenant.workspaceId === '') {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Cost policy tenant is required');
    }
    if (policy.policyVersion.trim().length === 0) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Cost policy version is required');
    }
    for (const rate of policy.rates) assertRate(rate);
    if (policy.maxInvocationCostMinor !== undefined)
      assertInteger(policy.maxInvocationCostMinor, 'maxInvocationCostMinor');
    if (policy.maxRetryAttempts !== undefined)
      assertInteger(policy.maxRetryAttempts, 'maxRetryAttempts', true);
    this.authority?.assertAllowed({ tenant: policy.tenant, action: 'policy' });
    this.policies.set(
      `${tenantKey(policy.tenant)}:${policy.scope.kind}:${policy.scope.id}`,
      clone(policy),
    );
    return clone(policy);
  }

  estimateModelCost(input: ModelCostEstimateInput): ModelCostEstimate {
    assertInteger(input.inputTokens, 'inputTokens');
    assertInteger(input.outputTokens, 'outputTokens');
    const requests = input.requests ?? 1;
    assertInteger(requests, 'requests', true);
    const policies = this.policiesFor(input.tenant);
    const breakdown: Record<string, number> = {};
    let amountMinor = 0;
    for (const unit of [
      ['input_tokens', input.inputTokens],
      ['output_tokens', input.outputTokens],
      ['requests', requests],
    ] as const) {
      const rate = this.findRate(policies, input.providerId, input.modelId, unit[0]);
      if (rate === undefined) continue;
      if (rate.currency !== input.currency) {
        throw runtimeError('VALIDATION_INVALID_INPUT', 'Cost policy currency mismatch');
      }
      const cost = unit[1] * rate.minorPerUnit;
      assertInteger(cost, 'Computed cost');
      breakdown[unit[0]] = cost;
      amountMinor += cost;
    }
    return {
      currency: input.currency,
      amountMinor,
      category: 'llm',
      providerId: input.providerId,
      modelId: input.modelId,
      breakdown,
    };
  }

  checkModelPolicy(input: {
    readonly tenant: TenantRef;
    readonly providerId: string;
    readonly modelId: string;
    readonly estimatedCost: Money;
    readonly retryAttempts?: number;
  }): CostPolicyDecision {
    const policies = this.policiesFor(input.tenant);
    for (const policy of policies) {
      if (
        policy.allowedProviders !== undefined &&
        !policy.allowedProviders.includes(input.providerId)
      ) {
        return {
          allowed: false,
          reason: `Provider ${input.providerId} is not allowed`,
          policyIds: policies.map((item) => item.policyId),
        };
      }
      if (policy.allowedModels !== undefined && !policy.allowedModels.includes(input.modelId)) {
        return {
          allowed: false,
          reason: `Model ${input.modelId} is not allowed`,
          policyIds: policies.map((item) => item.policyId),
        };
      }
      if (
        policy.maxInvocationCostMinor !== undefined &&
        input.estimatedCost.amountMinor > policy.maxInvocationCostMinor
      ) {
        return {
          allowed: false,
          reason: 'Estimated invocation cost exceeds policy limit',
          policyIds: policies.map((item) => item.policyId),
        };
      }
      if (
        policy.maxRetryAttempts !== undefined &&
        (input.retryAttempts ?? 0) > policy.maxRetryAttempts
      ) {
        return {
          allowed: false,
          reason: 'Retry attempts exceed cost policy limit',
          policyIds: policies.map((item) => item.policyId),
        };
      }
    }
    return {
      allowed: true,
      reason: 'Allowed by scoped cost policy',
      policyIds: policies.map((item) => item.policyId),
    };
  }

  async reserve(input: {
    readonly tenant: TenantRef;
    readonly budgetId: Id;
    readonly invocationId: Id;
    readonly category: BudgetCategory;
    readonly amount: Money;
    readonly reservationId?: Id;
    readonly now?: string;
  }): Promise<ScopedReservationRecord> {
    this.authority?.assertAllowed({
      tenant: input.tenant,
      action: 'reserve',
      invocationId: input.invocationId,
    });
    const now = input.now ?? this.clock();
    assertInteger(input.amount.amountMinor, 'Reservation amount');
    const lockKey = tenantKey(input.tenant);
    return this.serialized(lockKey, async () => {
      const existingId = input.reservationId ?? newSortableId();
      const reservationKey = `${tenantKey(input.tenant)}:${existingId}`;
      const existing = this.reservations.get(reservationKey);
      if (existing !== undefined) {
        if (
          existing.invocationId !== input.invocationId ||
          existing.amountMinor !== input.amount.amountMinor
        ) {
          throw runtimeError(
            'VALIDATION_INVALID_INPUT',
            'Reservation ID was reused with different details',
          );
        }
        return clone(existing);
      }
      const chain = this.chain(input.tenant, input.budgetId);
      for (const budget of chain) {
        if (budget.definition.currency !== input.amount.currency) {
          throw runtimeError('BUDGET_EXCEEDED', 'Reservation currency does not match budget');
        }
        const total = budget.consumedMinor + budget.reservedMinor + input.amount.amountMinor;
        const categoryTotal =
          budget.consumedByCategory[input.category] +
          budget.reservedByCategory[input.category] +
          input.amount.amountMinor;
        if (
          total > budget.definition.hardLimitMinor ||
          categoryTotal > budget.definition.categoryHardLimits[input.category]
        ) {
          this.budgetAlerts.push({
            alertId: newSortableId(),
            tenant: clone(input.tenant),
            budgetId: budget.definition.budgetId,
            kind: 'hard_limit_rejected',
            observedMinor: Math.max(total, categoryTotal),
            thresholdMinor: Math.min(
              budget.definition.hardLimitMinor,
              budget.definition.categoryHardLimits[input.category],
            ),
            message: 'Reservation exceeds a scoped hard limit',
            at: now,
          });
          throw runtimeError(
            'BUDGET_EXCEEDED',
            `Budget ${budget.definition.budgetId} hard limit exceeded`,
          );
        }
      }
      const allocations = chain.map((budget) => {
        const next: ScopedBudgetSnapshot = {
          ...budget,
          reservedMinor: budget.reservedMinor + input.amount.amountMinor,
          reservedByCategory: {
            ...budget.reservedByCategory,
            [input.category]: budget.reservedByCategory[input.category] + input.amount.amountMinor,
          },
          version: budget.version + 1,
        };
        this.budgets.set(budgetKey(input.tenant, budget.definition.budgetId), next);
        if (next.reservedMinor > next.definition.softLimitMinor) {
          this.budgetAlerts.push({
            alertId: newSortableId(),
            tenant: clone(input.tenant),
            budgetId: budget.definition.budgetId,
            kind: 'soft_limit_exceeded',
            observedMinor: next.reservedMinor,
            thresholdMinor: next.definition.softLimitMinor,
            message: 'Scoped reservation exceeded the soft limit',
            at: now,
          });
        }
        return {
          budgetId: budget.definition.budgetId,
          amountMinor: input.amount.amountMinor,
          consumedMinor: 0,
        };
      });
      const reservation: ScopedReservationRecord = {
        reservationId: existingId,
        tenant: clone(input.tenant),
        invocationId: input.invocationId,
        category: input.category,
        currency: input.amount.currency,
        amountMinor: input.amount.amountMinor,
        consumedMinor: 0,
        state: 'reserved',
        allocations,
        createdAt: now,
      };
      this.reservations.set(reservationKey, reservation);
      return clone(reservation);
    });
  }

  async consume(input: {
    readonly tenant: TenantRef;
    readonly reservationId: Id;
    readonly amount: Money;
    readonly now?: string;
  }): Promise<ScopedReservationRecord> {
    this.authority?.assertAllowed({ tenant: input.tenant, action: 'consume' });
    const lockKey = tenantKey(input.tenant);
    const reservationKey = `${tenantKey(input.tenant)}:${input.reservationId}`;
    return this.serialized(lockKey, async () => {
      const current = this.requireReservation(input.tenant, input.reservationId);
      if (current.currency !== input.amount.currency)
        throw runtimeError('BUDGET_EXCEEDED', 'Usage currency mismatch');
      assertInteger(input.amount.amountMinor, 'Consumption amount');
      if (input.amount.amountMinor > current.amountMinor - current.consumedMinor) {
        throw runtimeError('BUDGET_EXCEEDED', 'Consumption exceeds the reservation');
      }
      const delta = input.amount.amountMinor;
      this.applyToAllocations(current, delta, 'consume');
      const consumed = current.consumedMinor + delta;
      const next: ScopedReservationRecord = {
        ...current,
        consumedMinor: consumed,
        state: consumed === current.amountMinor ? 'reconciled' : 'partially_consumed',
        ...(consumed === current.amountMinor ? { reconciledAt: input.now ?? this.clock() } : {}),
        allocations: current.allocations.map((allocation) => ({
          ...allocation,
          consumedMinor: allocation.consumedMinor + delta,
        })),
      };
      this.reservations.set(reservationKey, next);
      return clone(next);
    });
  }

  async reconcile(input: {
    readonly tenant: TenantRef;
    readonly reservationId: Id;
    readonly actual: Money;
    readonly now?: string;
  }): Promise<ScopedReservationRecord> {
    this.authority?.assertAllowed({ tenant: input.tenant, action: 'reconcile' });
    const lockKey = tenantKey(input.tenant);
    const reservationKey = `${tenantKey(input.tenant)}:${input.reservationId}`;
    return this.serialized(lockKey, async () => {
      const current = this.requireReservation(input.tenant, input.reservationId);
      if (current.currency !== input.actual.currency) {
        throw runtimeError('BUDGET_EXCEEDED', 'Reconciliation currency mismatch');
      }
      assertInteger(input.actual.amountMinor, 'Reconciled amount');
      if (input.actual.amountMinor < current.consumedMinor) {
        throw runtimeError(
          'VALIDATION_INVALID_INPUT',
          'Reconciled amount cannot be below already consumed usage',
        );
      }
      const delta = input.actual.amountMinor - current.consumedMinor;
      if (delta > 0) this.applyToAllocations(current, delta, 'consume');
      const remaining = Math.max(0, current.amountMinor - input.actual.amountMinor);
      if (remaining > 0) this.applyToAllocations(current, remaining, 'release');
      const next: ScopedReservationRecord = {
        ...current,
        consumedMinor: input.actual.amountMinor,
        state: 'reconciled',
        reconciledAt: input.now ?? this.clock(),
        allocations: current.allocations.map((allocation) => ({
          ...allocation,
          consumedMinor: allocation.consumedMinor + delta,
        })),
      };
      this.reservations.set(reservationKey, next);
      return clone(next);
    });
  }

  async release(input: {
    readonly tenant: TenantRef;
    readonly reservationId: Id;
    readonly now?: string;
  }): Promise<ScopedReservationRecord> {
    this.authority?.assertAllowed({ tenant: input.tenant, action: 'release' });
    const lockKey = tenantKey(input.tenant);
    const reservationKey = `${tenantKey(input.tenant)}:${input.reservationId}`;
    return this.serialized(lockKey, async () => {
      const current = this.requireReservation(input.tenant, input.reservationId);
      const remaining = current.amountMinor - current.consumedMinor;
      if (remaining > 0) this.applyToAllocations(current, remaining, 'release');
      const next: ScopedReservationRecord = {
        ...current,
        state: 'released',
        allocations: current.allocations.map((allocation) => ({
          ...allocation,
          amountMinor: allocation.consumedMinor,
        })),
      };
      this.reservations.set(reservationKey, next);
      return clone(next);
    });
  }

  snapshot(tenant: TenantRef, budgetId: Id): ScopedBudgetSnapshot {
    const snapshot = this.budgets.get(budgetKey(tenant, budgetId));
    if (snapshot === undefined)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Budget ${budgetId} was not found`);
    return clone(snapshot);
  }

  listBudgets(tenant: TenantRef): readonly ScopedBudgetSnapshot[] {
    return clone(
      [...this.budgets.values()].filter((budget) => sameTenant(budget.definition.tenant, tenant)),
    );
  }

  reservation(tenant: TenantRef, reservationId: Id): ScopedReservationRecord | undefined {
    const record = this.reservations.get(`${tenantKey(tenant)}:${reservationId}`);
    return record === undefined ? undefined : clone(record);
  }

  alerts(tenant: TenantRef): readonly ScopedBudgetAlert[] {
    return clone(this.budgetAlerts.filter((alert) => sameTenant(alert.tenant, tenant)));
  }

  private policiesFor(tenant: TenantRef): CostPolicy[] {
    return [...this.policies.values()]
      .filter((policy) => sameTenant(policy.tenant, tenant))
      .sort((left, right) =>
        left.scope.kind === right.scope.kind ? 0 : left.scope.kind === 'organization' ? -1 : 1,
      );
  }

  private findRate(
    policies: readonly CostPolicy[],
    providerId: string,
    modelId: string,
    unit: CostRate['unit'],
  ): CostRate | undefined {
    const candidates = policies
      .flatMap((policy) => policy.rates)
      .filter((rate) => rate.unit === unit);
    return (
      candidates.find((rate) => rate.providerId === providerId && rate.modelId === modelId) ??
      candidates.find((rate) => rate.providerId === providerId && rate.modelId === undefined) ??
      candidates.find((rate) => rate.providerId === undefined && rate.modelId === undefined)
    );
  }

  private chain(tenant: TenantRef, budgetId: Id): ScopedBudgetSnapshot[] {
    const result: ScopedBudgetSnapshot[] = [];
    const visited = new Set<Id>();
    let currentId: Id | undefined = budgetId;
    while (currentId !== undefined) {
      if (visited.has(currentId))
        throw runtimeError('VALIDATION_INVALID_INPUT', 'Budget hierarchy contains a cycle');
      visited.add(currentId);
      const current = this.budgets.get(budgetKey(tenant, currentId));
      if (current === undefined)
        throw runtimeError('ARTIFACT_NOT_FOUND', `Budget ${currentId} was not found`);
      result.push(current);
      currentId = current.definition.scope.parentBudgetId;
    }
    return result;
  }

  private assertNoCycle(tenant: TenantRef, parentBudgetId: Id, childBudgetId: Id): void {
    let currentId: Id | undefined = parentBudgetId;
    const visited = new Set<Id>();
    while (currentId !== undefined) {
      if (currentId === childBudgetId)
        throw runtimeError('VALIDATION_INVALID_INPUT', 'Budget hierarchy contains a cycle');
      if (visited.has(currentId))
        throw runtimeError('VALIDATION_INVALID_INPUT', 'Budget hierarchy contains a cycle');
      visited.add(currentId);
      currentId = this.budgets.get(budgetKey(tenant, currentId))?.definition.scope.parentBudgetId;
    }
  }

  private requireReservation(tenant: TenantRef, reservationId: Id): ScopedReservationRecord {
    const current = this.reservations.get(`${tenantKey(tenant)}:${reservationId}`);
    if (current === undefined)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Reservation ${reservationId} was not found`);
    if (!sameTenant(current.tenant, tenant))
      throw runtimeError('POLICY_DENIED', 'Reservation crosses tenant boundary');
    if (current.state === 'released' || current.state === 'reconciled')
      throw runtimeError('CONCURRENCY_STALE_VERSION', 'Reservation is terminal');
    return current;
  }

  private applyToAllocations(
    reservation: ScopedReservationRecord,
    amountMinor: number,
    operation: 'consume' | 'release',
  ): void {
    for (const allocation of reservation.allocations) {
      const budget = this.budgets.get(budgetKey(reservation.tenant, allocation.budgetId));
      if (budget === undefined)
        throw runtimeError('ARTIFACT_NOT_FOUND', 'Reservation budget was deleted');
      const category = reservation.category;
      const next: ScopedBudgetSnapshot = {
        ...budget,
        reservedMinor: Math.max(0, budget.reservedMinor - amountMinor),
        ...(operation === 'consume'
          ? {
              consumedMinor: budget.consumedMinor + amountMinor,
              consumedByCategory: {
                ...budget.consumedByCategory,
                [category]: budget.consumedByCategory[category] + amountMinor,
              },
            }
          : {}),
        reservedByCategory: {
          ...budget.reservedByCategory,
          [category]: Math.max(0, budget.reservedByCategory[category] - amountMinor),
        },
        version: budget.version + 1,
      };
      if (
        next.consumedMinor > next.definition.hardLimitMinor ||
        next.consumedByCategory[category] > next.definition.categoryHardLimits[category]
      ) {
        throw runtimeError(
          'BUDGET_EXCEEDED',
          `Budget ${budget.definition.budgetId} hard limit exceeded during reconciliation`,
        );
      }
      this.budgets.set(budgetKey(reservation.tenant, allocation.budgetId), next);
    }
  }

  private async serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.locks.set(key, queued);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.locks.get(key) === queued) this.locks.delete(key);
    }
  }
}

/** The public port a durable hosted budget ledger must implement. */
export type ScopedBudgetService = Pick<
  ScopedBudgetLedger,
  | 'createBudget'
  | 'listBudgets'
  | 'snapshot'
  | 'alerts'
  | 'setPolicy'
  | 'reserve'
  | 'consume'
  | 'reconcile'
  | 'release'
  | 'estimateModelCost'
  | 'checkModelPolicy'
>;

export function estimateCost(amountMinor: number, currency: string): Money {
  return makeMoney(amountMinor, currency);
}
