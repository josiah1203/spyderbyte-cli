import {
  makeMoney,
  newSortableId,
  runtimeError,
  type AuthorityEnvelope,
  type BudgetCategory,
  type BudgetReservation,
  type Currency,
  type Id,
  type Money,
  type Quantity,
  type TenantRef,
  type UsageObservation,
} from '@agentic-platform/runtime-contracts';
import type { AuthorityService } from '@agentic-platform/policy';

export const budgetCategories: readonly BudgetCategory[] = [
  'llm',
  'compute',
  'storage',
  'external_api',
  'retry',
];

export type CategoryTotals = Record<BudgetCategory, number>;

export interface BudgetDefinition {
  budgetId: Id;
  tenant: TenantRef;
  workflowId?: Id;
  currency: Currency;
  hardLimitMinor: number;
  softLimitMinor: number;
  categoryHardLimits: CategoryTotals;
  categorySoftLimits?: Partial<CategoryTotals>;
  createdAt: string;
}

export interface BudgetSnapshot {
  definition: BudgetDefinition;
  reservedMinor: number;
  consumedMinor: number;
  reservedByCategory: CategoryTotals;
  consumedByCategory: CategoryTotals;
  version: number;
}

export type BudgetAlertKind = 'soft_limit_exceeded' | 'category_soft_limit_exceeded' | 'anomaly';

export interface BudgetAlert {
  alertId: Id;
  budgetId: Id;
  tenant: TenantRef;
  kind: BudgetAlertKind;
  category?: BudgetCategory;
  thresholdMinor: number;
  observedMinor: number;
  message: string;
  createdAt: string;
}

export interface BudgetReservationRecord {
  reservation: BudgetReservation;
  tenant: TenantRef;
  invocationId: Id;
  originalAmountMinor: number;
  remainingMinor: number;
  consumedMinor: number;
}

export interface BudgetUsageRecord {
  observation: UsageObservation;
  amountMinor: number;
}

export interface BudgetReserveInput {
  budgetId: Id;
  tenant: TenantRef;
  invocationId: Id;
  category: BudgetCategory;
  amount: Money;
  authority: AuthorityEnvelope;
  now?: string;
  reservationId?: Id;
}

export interface BudgetConsumeInput {
  tenant: TenantRef;
  invocationId: Id;
  reservationId: Id;
  amount: Money;
  quantity: Quantity;
  authority: AuthorityEnvelope;
  now?: string;
  usageId?: Id;
}

export interface BudgetReconcileInput {
  tenant: TenantRef;
  invocationId: Id;
  reservationId: Id;
  actual: Money;
  authority: AuthorityEnvelope;
  now?: string;
}

export interface BudgetReleaseInput {
  tenant: TenantRef;
  invocationId: Id;
  reservationId: Id;
  amount?: Money;
  authority: AuthorityEnvelope;
  now?: string;
}

export interface BudgetLedgerOptions {
  authority: Pick<AuthorityService, 'assertAuthorized'>;
  clock?: () => string;
}

interface MutableBudget {
  snapshot: BudgetSnapshot;
  alerts: BudgetAlert[];
}

function emptyTotals(): CategoryTotals {
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

function reservationKey(tenant: TenantRef, reservationId: Id): string {
  return `${tenantKey(tenant)}:${reservationId}`;
}

function assertNonNegativeMinor(value: number, label: string, allowZero = true): void {
  if (!Number.isSafeInteger(value) || value < 0 || (!allowZero && value === 0)) {
    throw runtimeError(
      'VALIDATION_INVALID_INPUT',
      `${label} must be a ${allowZero ? 'non-negative' : 'positive'} integer`,
    );
  }
}

function assertTenant(left: TenantRef, right: TenantRef): void {
  if (left.tenantId !== right.tenantId || left.workspaceId !== right.workspaceId) {
    throw runtimeError('POLICY_DENIED', 'Budget tenant/workspace does not match authority');
  }
}

function authorizationCheck(
  tenant: TenantRef,
  invocationId: Id,
  action: string,
  now: string,
  workflowId?: Id,
): Parameters<BudgetLedgerOptions['authority']['assertAuthorized']>[1] {
  return {
    tenant,
    invocationId,
    action,
    now,
    ...(workflowId !== undefined ? { workflowId } : {}),
  };
}

function assertMoney(amount: Money, currency: Currency, label: string, allowZero = false): void {
  assertNonNegativeMinor(amount.amountMinor, label, allowZero);
  if (amount.currency !== currency) {
    throw runtimeError(
      'BUDGET_EXCEEDED',
      `${label} currency ${amount.currency} does not match ${currency}`,
    );
  }
}

function normalizeDefinition(definition: BudgetDefinition): BudgetDefinition {
  assertNonNegativeMinor(definition.hardLimitMinor, 'hardLimitMinor');
  assertNonNegativeMinor(definition.softLimitMinor, 'softLimitMinor');
  if (definition.softLimitMinor > definition.hardLimitMinor) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'softLimitMinor cannot exceed hardLimitMinor');
  }
  const categorySoftLimits = { ...definition.categorySoftLimits };
  for (const category of budgetCategories) {
    assertNonNegativeMinor(definition.categoryHardLimits[category], `${category} hard limit`);
    const soft = categorySoftLimits[category] ?? definition.categoryHardLimits[category];
    assertNonNegativeMinor(soft, `${category} soft limit`);
    if (soft > definition.categoryHardLimits[category]) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        `${category} soft limit cannot exceed hard limit`,
      );
    }
    categorySoftLimits[category] = soft;
  }
  return { ...clone(definition), categorySoftLimits };
}

function addAlert(
  account: MutableBudget,
  kind: BudgetAlertKind,
  thresholdMinor: number,
  observedMinor: number,
  createdAt: string,
  message: string,
  category?: BudgetCategory,
): void {
  account.alerts.push({
    alertId: newSortableId(),
    budgetId: account.snapshot.definition.budgetId,
    tenant: account.snapshot.definition.tenant,
    kind,
    ...(category !== undefined ? { category } : {}),
    thresholdMinor,
    observedMinor,
    message,
    createdAt,
  });
}

export class BudgetLedger {
  private readonly authority: BudgetLedgerOptions['authority'];
  private readonly clock: () => string;
  private readonly budgets = new Map<string, MutableBudget>();
  private readonly reservations = new Map<string, BudgetReservationRecord>();
  private readonly usage = new Map<string, BudgetUsageRecord>();
  private readonly locks = new Map<string, Promise<void>>();

  constructor(options: BudgetLedgerOptions) {
    this.authority = options.authority;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  createBudget(
    definition: BudgetDefinition,
    authority: AuthorityEnvelope,
    now = this.clock(),
  ): BudgetSnapshot {
    const normalized = normalizeDefinition(definition);
    this.authority.assertAuthorized(
      authority,
      authorizationCheck(
        normalized.tenant,
        authority.invocationId,
        'budget.create',
        now,
        normalized.workflowId,
      ),
    );
    const key = budgetKey(normalized.tenant, normalized.budgetId);
    if (this.budgets.has(key))
      throw runtimeError('CONCURRENCY_STALE_VERSION', 'Budget already exists');
    const snapshot: BudgetSnapshot = {
      definition: normalized,
      reservedMinor: 0,
      consumedMinor: 0,
      reservedByCategory: emptyTotals(),
      consumedByCategory: emptyTotals(),
      version: 0,
    };
    this.budgets.set(key, { snapshot, alerts: [] });
    return clone(snapshot);
  }

  async reserve(input: BudgetReserveInput): Promise<BudgetReservationRecord> {
    const now = input.now ?? this.clock();
    this.authority.assertAuthorized(
      input.authority,
      authorizationCheck(
        input.tenant,
        input.invocationId,
        'budget.reserve',
        now,
        this.budgets.get(budgetKey(input.tenant, input.budgetId))?.snapshot.definition.workflowId,
      ),
    );
    return this.serialized(budgetKey(input.tenant, input.budgetId), async () => {
      const account = this.requireBudget(input.tenant, input.budgetId);
      assertTenant(input.authority.tenant, input.tenant);
      assertMoney(input.amount, account.snapshot.definition.currency, 'Reservation amount');
      const key = reservationKey(input.tenant, input.reservationId ?? newSortableId());
      const existing = this.reservations.get(key);
      if (existing) {
        if (
          existing.invocationId !== input.invocationId ||
          existing.reservation.amount.amountMinor !== input.amount.amountMinor ||
          existing.reservation.category !== input.category
        ) {
          throw runtimeError(
            'VALIDATION_INVALID_INPUT',
            'Reservation id was reused with different details',
          );
        }
        return clone(existing);
      }
      const totalAfter =
        account.snapshot.consumedMinor + account.snapshot.reservedMinor + input.amount.amountMinor;
      const categoryAfter =
        account.snapshot.consumedByCategory[input.category] +
        account.snapshot.reservedByCategory[input.category] +
        input.amount.amountMinor;
      if (totalAfter > account.snapshot.definition.hardLimitMinor) {
        throw runtimeError('BUDGET_EXCEEDED', 'Reservation exceeds the workflow hard budget limit');
      }
      if (categoryAfter > account.snapshot.definition.categoryHardLimits[input.category]) {
        throw runtimeError(
          'BUDGET_EXCEEDED',
          `Reservation exceeds the ${input.category} hard limit`,
        );
      }
      account.snapshot.reservedMinor += input.amount.amountMinor;
      account.snapshot.reservedByCategory[input.category] += input.amount.amountMinor;
      account.snapshot.version += 1;
      const reservation: BudgetReservation = {
        reservationId: input.reservationId ?? (key.slice(key.lastIndexOf(':') + 1) as Id),
        budgetId: input.budgetId,
        amount: clone(input.amount),
        category: input.category,
        state: 'reserved',
        createdAt: now,
      };
      const record: BudgetReservationRecord = {
        reservation,
        tenant: input.tenant,
        invocationId: input.invocationId,
        originalAmountMinor: input.amount.amountMinor,
        remainingMinor: input.amount.amountMinor,
        consumedMinor: 0,
      };
      this.reservations.set(reservationKey(input.tenant, reservation.reservationId), clone(record));
      this.emitThresholdAlerts(account, input.category, now);
      return clone(record);
    });
  }

  async consume(input: BudgetConsumeInput): Promise<{
    reservation: BudgetReservationRecord;
    usage: BudgetUsageRecord;
    alerts: BudgetAlert[];
  }> {
    const now = input.now ?? this.clock();
    const existing = this.requireReservation(input.tenant, input.reservationId);
    this.authority.assertAuthorized(
      input.authority,
      authorizationCheck(
        input.tenant,
        input.invocationId,
        'budget.consume',
        now,
        this.requireBudget(input.tenant, existing.reservation.budgetId).snapshot.definition
          .workflowId,
      ),
    );
    return this.serialized(budgetKey(input.tenant, existing.reservation.budgetId), async () => {
      const record = this.requireReservation(input.tenant, input.reservationId);
      this.assertReservationOwner(record, input.invocationId);
      const account = this.requireBudget(input.tenant, record.reservation.budgetId);
      assertMoney(input.amount, account.snapshot.definition.currency, 'Consumed amount');
      if (input.amount.amountMinor > record.remainingMinor) {
        throw runtimeError('BUDGET_EXCEEDED', 'Actual usage exceeds the reserved amount');
      }
      account.snapshot.reservedMinor -= input.amount.amountMinor;
      account.snapshot.reservedByCategory[record.reservation.category] -= input.amount.amountMinor;
      account.snapshot.consumedMinor += input.amount.amountMinor;
      account.snapshot.consumedByCategory[record.reservation.category] += input.amount.amountMinor;
      account.snapshot.version += 1;
      record.remainingMinor -= input.amount.amountMinor;
      record.consumedMinor += input.amount.amountMinor;
      record.reservation.state =
        record.remainingMinor === 0 ? 'partially_consumed' : 'partially_consumed';
      const observation: UsageObservation = {
        usageId: input.usageId ?? newSortableId(),
        invocationId: input.invocationId,
        quantity: clone(input.quantity),
        budgetId: record.reservation.budgetId,
        reservationId: record.reservation.reservationId,
        category: record.reservation.category,
        observedAt: now,
        cost: clone(input.amount),
      };
      const usage: BudgetUsageRecord = { observation, amountMinor: input.amount.amountMinor };
      this.usage.set(reservationKey(input.tenant, observation.usageId), clone(usage));
      this.reservations.set(reservationKey(input.tenant, input.reservationId), clone(record));
      this.emitThresholdAlerts(account, record.reservation.category, now);
      return {
        reservation: clone(record),
        usage: clone(usage),
        alerts: this.alertsFor(account, now),
      };
    });
  }

  async reconcile(
    input: BudgetReconcileInput,
  ): Promise<{ reservation: BudgetReservationRecord; alerts: BudgetAlert[] }> {
    const now = input.now ?? this.clock();
    const existing = this.requireReservation(input.tenant, input.reservationId);
    const accountForAuth = this.requireBudget(input.tenant, existing.reservation.budgetId);
    this.authority.assertAuthorized(
      input.authority,
      authorizationCheck(
        input.tenant,
        input.invocationId,
        'budget.reconcile',
        now,
        accountForAuth.snapshot.definition.workflowId,
      ),
    );
    return this.serialized(budgetKey(input.tenant, existing.reservation.budgetId), async () => {
      const record = this.requireReservation(input.tenant, input.reservationId);
      this.assertReservationOwner(record, input.invocationId);
      const account = this.requireBudget(input.tenant, record.reservation.budgetId);
      assertMoney(input.actual, account.snapshot.definition.currency, 'Reconciled amount', true);
      if (input.actual.amountMinor < record.consumedMinor) {
        throw runtimeError(
          'VALIDATION_INVALID_INPUT',
          'Reconciled amount cannot be below recorded usage',
        );
      }
      const desiredOutstanding = input.actual.amountMinor - record.consumedMinor;
      const additional = Math.max(0, desiredOutstanding - record.remainingMinor);
      if (additional > 0) {
        const totalAfter =
          account.snapshot.consumedMinor + account.snapshot.reservedMinor + additional;
        const categoryAfter =
          account.snapshot.consumedByCategory[record.reservation.category] +
          account.snapshot.reservedByCategory[record.reservation.category] +
          additional;
        if (totalAfter > account.snapshot.definition.hardLimitMinor) {
          throw runtimeError(
            'BUDGET_EXCEEDED',
            'Reconciliation exceeds the workflow hard budget limit',
          );
        }
        if (
          categoryAfter >
          account.snapshot.definition.categoryHardLimits[record.reservation.category]
        ) {
          throw runtimeError('BUDGET_EXCEEDED', 'Reconciliation exceeds the category hard limit');
        }
        account.snapshot.reservedMinor += additional;
        account.snapshot.reservedByCategory[record.reservation.category] += additional;
      }
      const release = record.remainingMinor + additional - desiredOutstanding;
      const consume = desiredOutstanding;
      account.snapshot.reservedMinor -= record.remainingMinor + additional;
      account.snapshot.reservedByCategory[record.reservation.category] -=
        record.remainingMinor + additional;
      account.snapshot.consumedMinor += consume;
      account.snapshot.consumedByCategory[record.reservation.category] += consume;
      account.snapshot.version += 1;
      record.remainingMinor = 0;
      record.consumedMinor = input.actual.amountMinor;
      record.reservation.state = 'reconciled';
      record.reservation.reconciledAt = now;
      this.reservations.set(reservationKey(input.tenant, input.reservationId), clone(record));
      if (input.actual.amountMinor > record.originalAmountMinor) {
        addAlert(
          account,
          'anomaly',
          record.originalAmountMinor,
          input.actual.amountMinor,
          now,
          'Actual usage exceeded the original reservation',
          record.reservation.category,
        );
      }
      if (release < 0)
        throw runtimeError(
          'VALIDATION_INVALID_INPUT',
          'Budget reconciliation arithmetic underflow',
        );
      this.emitThresholdAlerts(account, record.reservation.category, now);
      return { reservation: clone(record), alerts: this.alertsFor(account, now) };
    });
  }

  async release(input: BudgetReleaseInput): Promise<BudgetReservationRecord> {
    const now = input.now ?? this.clock();
    const existing = this.requireReservation(input.tenant, input.reservationId);
    const accountForAuth = this.requireBudget(input.tenant, existing.reservation.budgetId);
    this.authority.assertAuthorized(
      input.authority,
      authorizationCheck(
        input.tenant,
        input.invocationId,
        'budget.release',
        now,
        accountForAuth.snapshot.definition.workflowId,
      ),
    );
    return this.serialized(budgetKey(input.tenant, existing.reservation.budgetId), async () => {
      const record = this.requireReservation(input.tenant, input.reservationId);
      this.assertReservationOwner(record, input.invocationId);
      const account = this.requireBudget(input.tenant, record.reservation.budgetId);
      const amountMinor = input.amount?.amountMinor ?? record.remainingMinor;
      if (input.amount !== undefined)
        assertMoney(input.amount, account.snapshot.definition.currency, 'Released amount');
      assertNonNegativeMinor(amountMinor, 'Released amount');
      if (amountMinor > record.remainingMinor) {
        throw runtimeError(
          'VALIDATION_INVALID_INPUT',
          'Cannot release more than the remaining reservation',
        );
      }
      account.snapshot.reservedMinor -= amountMinor;
      account.snapshot.reservedByCategory[record.reservation.category] -= amountMinor;
      account.snapshot.version += 1;
      record.remainingMinor -= amountMinor;
      record.reservation.state =
        record.remainingMinor === 0 ? 'released' : record.reservation.state;
      this.reservations.set(reservationKey(input.tenant, input.reservationId), clone(record));
      return clone(record);
    });
  }

  snapshot(tenant: TenantRef, budgetId: Id): BudgetSnapshot {
    return clone(this.requireBudget(tenant, budgetId).snapshot);
  }

  reservation(tenant: TenantRef, reservationId: Id): BudgetReservationRecord | undefined {
    const record = this.reservations.get(reservationKey(tenant, reservationId));
    return record ? clone(record) : undefined;
  }

  alerts(tenant: TenantRef, budgetId: Id): BudgetAlert[] {
    return clone(this.requireBudget(tenant, budgetId).alerts);
  }

  usageRecords(tenant: TenantRef): BudgetUsageRecord[] {
    const prefix = `${tenantKey(tenant)}:`;
    return clone(
      [...this.usage.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, record]) => record),
    );
  }

  private requireBudget(tenant: TenantRef, budgetId: Id): MutableBudget {
    const account = this.budgets.get(budgetKey(tenant, budgetId));
    if (!account)
      throw runtimeError('VALIDATION_INVALID_INPUT', `Budget ${budgetId} was not found`);
    return account;
  }

  private requireReservation(tenant: TenantRef, reservationId: Id): BudgetReservationRecord {
    const record = this.reservations.get(reservationKey(tenant, reservationId));
    if (!record)
      throw runtimeError('VALIDATION_INVALID_INPUT', `Reservation ${reservationId} was not found`);
    return record;
  }

  private assertReservationOwner(record: BudgetReservationRecord, invocationId: Id): void {
    if (record.invocationId !== invocationId) {
      throw runtimeError('POLICY_DENIED', 'Reservation is bound to a different invocation');
    }
  }

  private emitThresholdAlerts(account: MutableBudget, category: BudgetCategory, now: string): void {
    const total = account.snapshot.consumedMinor + account.snapshot.reservedMinor;
    if (total > account.snapshot.definition.softLimitMinor) {
      addAlert(
        account,
        'soft_limit_exceeded',
        account.snapshot.definition.softLimitMinor,
        total,
        now,
        'Workflow budget soft limit exceeded',
      );
    }
    const categoryTotal =
      account.snapshot.consumedByCategory[category] + account.snapshot.reservedByCategory[category];
    const categorySoft =
      account.snapshot.definition.categorySoftLimits?.[category] ??
      account.snapshot.definition.categoryHardLimits[category];
    if (categoryTotal > categorySoft) {
      addAlert(
        account,
        'category_soft_limit_exceeded',
        categorySoft,
        categoryTotal,
        now,
        `${category} budget soft limit exceeded`,
        category,
      );
    }
  }

  private alertsFor(account: MutableBudget, now: string): BudgetAlert[] {
    return account.alerts.filter((alert) => alert.createdAt === now).map(clone);
  }

  private async serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(key, current);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }
}

export function moneyFromMinor(amountMinor: number, currency: string): Money {
  return makeMoney(amountMinor, currency);
}
