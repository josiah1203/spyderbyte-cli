import {
  makeMoney,
  newSortableId,
  runtimeError,
  type CloudAccountV1,
  type CloudBillingRecordV1,
  type CloudEstimateV1,
  type CloudRunRequestV1,
  type CloudUsageRecordV1,
  type Id,
  type Money,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';

export interface CloudPricingRates {
  readonly currency: string;
  readonly llmInputMinorPerMillionTokens: number;
  readonly llmOutputMinorPerMillionTokens: number;
  readonly cpuMinorPerSecond: number;
  readonly gpuMinorPerSecond: number;
  readonly storageMinorPerMiB: number;
  readonly platformFeeMinor: number;
}

export interface CloudUsageInput {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly computeSeconds: number;
  readonly storageBytes: number;
  readonly providerRequestId?: string;
}

export interface CloudUsageLedger {
  record(record: CloudUsageRecordV1): CloudUsageRecordV1 | Promise<CloudUsageRecordV1>;
  get(
    tenant: TenantRef,
    idempotencyKey: string,
  ): CloudUsageRecordV1 | undefined | Promise<CloudUsageRecordV1 | undefined>;
  list(tenant: TenantRef): CloudUsageRecordV1[] | Promise<CloudUsageRecordV1[]>;
}

export interface CloudPrepaidBalanceLedger {
  credit(tenant: TenantRef, amount: Money): Money | Promise<Money>;
  reserve(tenant: TenantRef, reservationId: Id, amount: Money): void | Promise<void>;
  reconcile(tenant: TenantRef, reservationId: Id, actual: Money): void | Promise<void>;
  release(tenant: TenantRef, reservationId: Id): void | Promise<void>;
  snapshot(tenant: TenantRef):
    | { readonly availableMinor: number; readonly reservedMinor: number }
    | Promise<{
        readonly availableMinor: number;
        readonly reservedMinor: number;
      }>;
}

export interface CloudBillingStateStore {
  get(
    tenant: TenantRef,
    estimateId: Id,
  ): CloudBillingRecordV1 | undefined | Promise<CloudBillingRecordV1 | undefined>;
  save(record: CloudBillingRecordV1): void | Promise<void>;
  getAuthorizationId(
    tenant: TenantRef,
    estimateId: Id,
  ): string | undefined | Promise<string | undefined>;
  saveAuthorizationId(
    tenant: TenantRef,
    estimateId: Id,
    authorizationId: string,
  ): void | Promise<void>;
}

export interface CloudCostBreakdown {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly computeSeconds: number;
  readonly llm: Money;
  readonly compute: Money;
  readonly storage: Money;
  readonly platformFee: Money;
  readonly total: Money;
}

function tenantKey(tenant: TenantRef): string {
  return `${tenant.tenantId}:${tenant.workspaceId}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} must be a non-negative integer`);
  }
}

function ceilRate(value: number, rate: number, divisor: number): number {
  if (value === 0 || rate === 0) return 0;
  const numerator = value * rate;
  if (!Number.isSafeInteger(numerator)) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Cloud pricing calculation overflowed');
  }
  return Math.ceil(numerator / divisor);
}

function assertRates(rates: CloudPricingRates): void {
  if (rates.currency.trim().length !== 3) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Cloud pricing currency is required');
  }
  for (const [label, value] of Object.entries(rates)) {
    if (label === 'currency') continue;
    assertNonNegativeInteger(value as number, `Cloud pricing ${label}`);
  }
}

export class CloudPricingCatalog {
  private readonly rates: CloudPricingRates;

  constructor(rates: CloudPricingRates) {
    assertRates(rates);
    this.rates = clone(rates);
  }

  estimate(request: CloudRunRequestV1): CloudCostBreakdown {
    const inputTokens = estimateInputTokens(request.prompt);
    const outputTokens = request.maxOutputTokens;
    const computeSeconds = Math.ceil(request.compute.wallTimeMs / 1_000);
    return this.cost({
      inputTokens,
      outputTokens,
      computeSeconds,
      storageBytes: request.compute.maxOutputBytes,
    });
  }

  cost(usage: CloudUsageInput): CloudCostBreakdown {
    assertNonNegativeInteger(usage.inputTokens, 'Cloud input tokens');
    assertNonNegativeInteger(usage.outputTokens, 'Cloud output tokens');
    assertNonNegativeInteger(usage.computeSeconds, 'Cloud compute seconds');
    assertNonNegativeInteger(usage.storageBytes, 'Cloud storage bytes');
    const currency = this.rates.currency;
    const llm = makeMoney(
      ceilRate(usage.inputTokens, this.rates.llmInputMinorPerMillionTokens, 1_000_000) +
        ceilRate(usage.outputTokens, this.rates.llmOutputMinorPerMillionTokens, 1_000_000),
      currency,
    );
    const compute = makeMoney(usage.computeSeconds * this.rates.cpuMinorPerSecond, currency);
    const storageMiB = Math.ceil(usage.storageBytes / (1024 * 1024));
    const storage = makeMoney(storageMiB * this.rates.storageMinorPerMiB, currency);
    const platformFee = makeMoney(this.rates.platformFeeMinor, currency);
    const total = makeMoney(
      llm.amountMinor + compute.amountMinor + storage.amountMinor + platformFee.amountMinor,
      currency,
    );
    return { ...usage, llm, compute, storage, platformFee, total };
  }

  currency(): Money['currency'] {
    return makeMoney(0, this.rates.currency).currency;
  }
}

export function estimateInputTokens(prompt: string): number {
  if (prompt.length === 0) return 0;
  return Math.max(1, Math.ceil(prompt.length / 4));
}

interface StoredUsage {
  readonly record: CloudUsageRecordV1;
  readonly digest: string;
}

export class InMemoryCloudUsageLedger implements CloudUsageLedger {
  private readonly records = new Map<string, StoredUsage>();

  record(record: CloudUsageRecordV1): CloudUsageRecordV1 {
    const key = `${tenantKey(record.tenant)}:${record.idempotencyKey}`;
    const existing = this.records.get(key);
    if (existing !== undefined) {
      if (
        existing.digest !== JSON.stringify({ ...record, recordedAt: existing.record.recordedAt })
      ) {
        throw runtimeError(
          'VALIDATION_INVALID_INPUT',
          'Usage idempotency key was reused differently',
        );
      }
      return clone(existing.record);
    }
    const stored: StoredUsage = { record: clone(record), digest: JSON.stringify(record) };
    this.records.set(key, stored);
    return clone(record);
  }

  get(tenant: TenantRef, idempotencyKey: string): CloudUsageRecordV1 | undefined {
    return clone(this.records.get(`${tenantKey(tenant)}:${idempotencyKey}`)?.record);
  }

  list(tenant: TenantRef): CloudUsageRecordV1[] {
    const prefix = `${tenantKey(tenant)}:`;
    return [...this.records.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, stored]) => clone(stored.record));
  }
}

interface PrepaidReservation {
  readonly reservationId: Id;
  readonly tenant: TenantRef;
  readonly originalMinor: number;
  remainingMinor: number;
  reconciledMinor?: number;
}

interface PrepaidAccount {
  availableMinor: number;
  reservedMinor: number;
  currency?: Money['currency'];
}

export class InMemoryPrepaidBalanceLedger implements CloudPrepaidBalanceLedger {
  private readonly accounts = new Map<string, PrepaidAccount>();
  private readonly reservations = new Map<string, PrepaidReservation>();

  credit(tenant: TenantRef, amount: Money): Money {
    assertNonNegativeInteger(amount.amountMinor, 'Prepaid credit');
    const account = this.account(tenant);
    this.assertCurrency(account, amount);
    account.availableMinor += amount.amountMinor;
    return makeMoney(account.availableMinor, amount.currency);
  }

  reserve(tenant: TenantRef, reservationId: Id, amount: Money): void {
    const existing = this.reservations.get(`${tenantKey(tenant)}:${reservationId}`);
    if (existing !== undefined) {
      if (existing.originalMinor !== amount.amountMinor) {
        throw runtimeError(
          'VALIDATION_INVALID_INPUT',
          'Prepaid reservation was reused differently',
        );
      }
      return;
    }
    const account = this.account(tenant);
    this.assertCurrency(account, amount);
    if (account.availableMinor < amount.amountMinor) {
      throw runtimeError('BUDGET_EXCEEDED', 'Prepaid balance is insufficient for cloud estimate');
    }
    account.availableMinor -= amount.amountMinor;
    account.reservedMinor += amount.amountMinor;
    this.reservations.set(`${tenantKey(tenant)}:${reservationId}`, {
      reservationId,
      tenant: clone(tenant),
      originalMinor: amount.amountMinor,
      remainingMinor: amount.amountMinor,
    });
  }

  reconcile(tenant: TenantRef, reservationId: Id, actual: Money): void {
    const reservation = this.reservations.get(`${tenantKey(tenant)}:${reservationId}`);
    if (reservation === undefined) {
      throw runtimeError('ARTIFACT_NOT_FOUND', 'Prepaid reservation was not found');
    }
    if (reservation.reconciledMinor !== undefined) {
      if (reservation.reconciledMinor !== actual.amountMinor) {
        throw runtimeError(
          'VALIDATION_INVALID_INPUT',
          'Prepaid reconciliation was reused differently',
        );
      }
      return;
    }
    const account = this.account(tenant);
    this.assertCurrency(account, actual);
    const extra = Math.max(0, actual.amountMinor - reservation.remainingMinor);
    if (extra > account.availableMinor) {
      throw runtimeError('BUDGET_EXCEEDED', 'Actual cloud usage exceeds prepaid balance');
    }
    account.availableMinor -= extra;
    account.reservedMinor -= reservation.remainingMinor;
    account.availableMinor += Math.max(0, reservation.remainingMinor - actual.amountMinor);
    reservation.remainingMinor = 0;
    reservation.reconciledMinor = actual.amountMinor;
  }

  release(tenant: TenantRef, reservationId: Id): void {
    const reservation = this.reservations.get(`${tenantKey(tenant)}:${reservationId}`);
    if (reservation === undefined || reservation.reconciledMinor !== undefined) return;
    const account = this.account(tenant);
    account.reservedMinor -= reservation.remainingMinor;
    account.availableMinor += reservation.remainingMinor;
    reservation.remainingMinor = 0;
    reservation.reconciledMinor = 0;
  }

  snapshot(tenant: TenantRef): { readonly availableMinor: number; readonly reservedMinor: number } {
    return clone(this.account(tenant));
  }

  private account(tenant: TenantRef): PrepaidAccount {
    const key = tenantKey(tenant);
    const existing = this.accounts.get(key);
    if (existing !== undefined) return existing;
    const created = { availableMinor: 0, reservedMinor: 0 };
    this.accounts.set(key, created);
    return created;
  }

  private assertCurrency(account: PrepaidAccount, amount: Money): void {
    if (account.currency === undefined) {
      account.currency = amount.currency;
      return;
    }
    if (account.currency !== amount.currency) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'Prepaid balance currency does not match cloud charge',
      );
    }
  }
}

export interface StripeBillingClient {
  authorize(input: {
    readonly customerId: string;
    readonly amount: Money;
    readonly idempotencyKey: string;
  }): Promise<{ readonly authorizationId: string }>;
  capture(input: {
    readonly customerId: string;
    readonly authorizationId: string;
    readonly amount: Money;
    readonly idempotencyKey: string;
  }): Promise<{ readonly paymentId: string }>;
}

export class StripeBillingAdapter {
  private readonly client: StripeBillingClient;
  private readonly authorizations = new Map<string, string>();
  private readonly payments = new Map<string, string>();

  constructor(client: StripeBillingClient) {
    this.client = client;
  }

  async authorize(account: CloudAccountV1, estimate: CloudEstimateV1): Promise<string> {
    const customerId = account.stripeCustomerId;
    if (customerId === undefined || customerId.trim().length === 0) {
      throw runtimeError('POLICY_DENIED', 'Stripe customer is not configured for cloud account');
    }
    const key = `${tenantKey(account.tenant)}:${estimate.estimateId}`;
    const existing = this.authorizations.get(key);
    if (existing !== undefined) return existing;
    const result = await this.client.authorize({
      customerId,
      amount: estimate.total,
      idempotencyKey: `cloud-authorize:${estimate.estimateId}`,
    });
    if (result.authorizationId.trim().length === 0) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Stripe returned no authorization ID');
    }
    this.authorizations.set(key, result.authorizationId);
    return result.authorizationId;
  }

  async capture(
    account: CloudAccountV1,
    estimate: CloudEstimateV1,
    authorizationId: string,
    actual: Money,
  ): Promise<string> {
    const customerId = account.stripeCustomerId;
    if (customerId === undefined || customerId.trim().length === 0) {
      throw runtimeError('POLICY_DENIED', 'Stripe customer is not configured for cloud account');
    }
    const key = `${tenantKey(account.tenant)}:${estimate.estimateId}`;
    const existing = this.payments.get(key);
    if (existing !== undefined) return existing;
    const result = await this.client.capture({
      customerId,
      authorizationId,
      amount: actual,
      idempotencyKey: `cloud-capture:${estimate.estimateId}`,
    });
    if (result.paymentId.trim().length === 0) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Stripe returned no payment ID');
    }
    this.payments.set(key, result.paymentId);
    return result.paymentId;
  }
}

export class InMemoryCloudBillingStateStore implements CloudBillingStateStore {
  private readonly records = new Map<string, CloudBillingRecordV1>();
  private readonly authorizationIds = new Map<string, string>();

  get(tenant: TenantRef, estimateId: Id): CloudBillingRecordV1 | undefined {
    return clone(this.records.get(`${tenantKey(tenant)}:cloud-billing:${estimateId}`));
  }

  save(record: CloudBillingRecordV1): void {
    this.records.set(`${tenantKey(record.tenant)}:${record.idempotencyKey}`, clone(record));
  }

  getAuthorizationId(tenant: TenantRef, estimateId: Id): string | undefined {
    return this.authorizationIds.get(`${tenantKey(tenant)}:${estimateId}`);
  }

  saveAuthorizationId(tenant: TenantRef, estimateId: Id, authorizationId: string): void {
    this.authorizationIds.set(`${tenantKey(tenant)}:${estimateId}`, authorizationId);
  }
}

export interface CloudBillingCoordinatorOptions {
  readonly usageLedger: CloudUsageLedger;
  readonly prepaidLedger?: CloudPrepaidBalanceLedger;
  readonly state?: CloudBillingStateStore;
  readonly stripe?: StripeBillingAdapter;
  readonly clock?: () => string;
}

export class CloudBillingCoordinator {
  private readonly usageLedger: CloudUsageLedger;
  private readonly prepaidLedger: CloudPrepaidBalanceLedger;
  private readonly state: CloudBillingStateStore;
  private readonly stripe: StripeBillingAdapter | undefined;
  private readonly clock: () => string;
  constructor(options: CloudBillingCoordinatorOptions) {
    this.usageLedger = options.usageLedger;
    this.prepaidLedger = options.prepaidLedger ?? new InMemoryPrepaidBalanceLedger();
    this.state = options.state ?? new InMemoryCloudBillingStateStore();
    this.stripe = options.stripe;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async authorize(
    account: CloudAccountV1,
    estimate: CloudEstimateV1,
  ): Promise<CloudBillingRecordV1> {
    const existing = await this.state.get(account.tenant, estimate.estimateId);
    if (existing !== undefined) return clone(existing);
    let authorizationId: string | undefined;
    if (account.billingMode === 'prepaid') {
      await this.prepaidLedger.reserve(account.tenant, estimate.estimateId, estimate.total);
    } else {
      if (this.stripe === undefined)
        throw runtimeError('EXTERNAL_DEPENDENCY_UNAVAILABLE', 'Stripe adapter is not configured');
      authorizationId = await this.stripe.authorize(account, estimate);
      await this.state.saveAuthorizationId(account.tenant, estimate.estimateId, authorizationId);
    }
    const record: CloudBillingRecordV1 = {
      schemaVersion: 1,
      billingId: newSortableId(),
      runId: estimate.runId,
      tenant: clone(account.tenant),
      mode: account.billingMode,
      state: 'authorized',
      estimated: clone(estimate.total),
      actual: makeMoney(0, estimate.total.currency),
      ...(authorizationId === undefined ? {} : { providerPaymentId: authorizationId }),
      idempotencyKey: `cloud-billing:${estimate.estimateId}`,
      authorizedAt: this.clock(),
    };
    await this.state.save(record);
    return clone(record);
  }

  async reconcile(
    account: CloudAccountV1,
    estimate: CloudEstimateV1,
    usageInput: CloudUsageInput,
    actual: CloudCostBreakdown,
  ): Promise<{ readonly usage: CloudUsageRecordV1; readonly billing: CloudBillingRecordV1 }> {
    const authorization = await this.state.get(account.tenant, estimate.estimateId);
    if (authorization === undefined)
      throw runtimeError('APPROVAL_REQUIRED', 'Cloud estimate was not authorized');
    if (actual.total.currency !== estimate.total.currency) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'Cloud billing currency does not match estimate',
      );
    }
    const usageIdempotencyKey = `cloud-usage:${estimate.estimateId}`;
    const existingUsage = await this.usageLedger.get(account.tenant, usageIdempotencyKey);
    if (
      existingUsage !== undefined &&
      existingUsage.amount.amountMinor !== actual.total.amountMinor
    ) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Cloud usage was reconciled differently');
    }
    const usage =
      existingUsage ??
      (await this.usageLedger.record({
        schemaVersion: 1,
        usageId: newSortableId(),
        estimateId: estimate.estimateId,
        runId: estimate.runId,
        tenant: clone(account.tenant),
        quantities: [
          { value: usageInput.inputTokens, unit: 'tokens' },
          { value: usageInput.outputTokens, unit: 'tokens' },
          { value: usageInput.computeSeconds, unit: 'seconds' },
          { value: usageInput.storageBytes, unit: 'bytes' },
        ],
        amount: clone(actual.total),
        ...(usageInput.providerRequestId === undefined
          ? {}
          : { providerRequestId: usageInput.providerRequestId }),
        idempotencyKey: usageIdempotencyKey,
        recordedAt: this.clock(),
      }));
    let providerPaymentId = authorization.providerPaymentId;
    if (account.billingMode === 'prepaid') {
      await this.prepaidLedger.reconcile(account.tenant, estimate.estimateId, actual.total);
    } else {
      if (this.stripe === undefined || providerPaymentId === undefined) {
        throw runtimeError(
          'EXTERNAL_DEPENDENCY_UNAVAILABLE',
          'Stripe authorization is unavailable',
        );
      }
      providerPaymentId = await this.stripe.capture(
        account,
        estimate,
        (await this.state.getAuthorizationId(account.tenant, estimate.estimateId)) ??
          providerPaymentId,
        actual.total,
      );
    }
    const billing: CloudBillingRecordV1 = {
      ...authorization,
      state: 'reconciled',
      actual: clone(actual.total),
      ...(providerPaymentId === undefined ? {} : { providerPaymentId }),
      reconciledAt: this.clock(),
    };
    await this.state.save(billing);
    return { usage, billing: clone(billing) };
  }

  record(
    tenant: TenantRef,
    estimateId: Id,
  ): CloudBillingRecordV1 | undefined | Promise<CloudBillingRecordV1 | undefined> {
    return this.state.get(tenant, estimateId);
  }
}
