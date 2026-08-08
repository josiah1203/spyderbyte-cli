import { describe, expect, it } from 'vitest';
import {
  makeCurrency,
  makeMoney,
  newSortableId,
  type BudgetCategory,
  type Id,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import { ScopedBudgetLedger, type ScopedBudgetDefinition } from '../src/index.js';

const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
const now = '2026-08-06T00:00:00.000Z';
const categories: BudgetCategory[] = ['llm', 'compute', 'storage', 'external_api', 'retry'];

function definition(
  budgetId: Id,
  scope: ScopedBudgetDefinition['scope'],
  hardLimitMinor: number,
): ScopedBudgetDefinition {
  return {
    budgetId,
    tenant,
    scope,
    currency: makeCurrency('USD'),
    hardLimitMinor,
    softLimitMinor: Math.floor(hardLimitMinor / 2),
    categoryHardLimits: Object.fromEntries(
      categories.map((category) => [category, hardLimitMinor]),
    ) as ScopedBudgetDefinition['categoryHardLimits'],
    policyVersion: 'cost-policy.v1',
    createdAt: now,
  };
}

describe('scoped budget and cost policy ledger', () => {
  it('enforces organization/workspace hard limits atomically and reconciles unused reservations', async () => {
    const ledger = new ScopedBudgetLedger({ clock: () => now });
    const organizationId = newSortableId();
    const workspaceId = newSortableId();
    ledger.createBudget(
      definition(organizationId, { kind: 'organization', id: organizationId }, 1000),
    );
    ledger.createBudget(
      definition(
        workspaceId,
        { kind: 'workspace', id: workspaceId, parentBudgetId: organizationId },
        700,
      ),
    );
    const reservation = await ledger.reserve({
      tenant,
      budgetId: workspaceId,
      invocationId: newSortableId(),
      category: 'llm',
      amount: makeMoney(600, 'USD'),
      now,
    });
    expect(ledger.snapshot(tenant, organizationId).reservedMinor).toBe(600);
    expect(ledger.snapshot(tenant, workspaceId).reservedMinor).toBe(600);
    await expect(
      ledger.reserve({
        tenant,
        budgetId: workspaceId,
        invocationId: newSortableId(),
        category: 'llm',
        amount: makeMoney(200, 'USD'),
        now,
      }),
    ).rejects.toThrow('hard limit');
    await ledger.consume({
      tenant,
      reservationId: reservation.reservationId,
      amount: makeMoney(200, 'USD'),
      now,
    });
    const reconciled = await ledger.reconcile({
      tenant,
      reservationId: reservation.reservationId,
      actual: makeMoney(350, 'USD'),
      now,
    });
    expect(reconciled.state).toBe('reconciled');
    expect(ledger.snapshot(tenant, organizationId)).toMatchObject({
      reservedMinor: 0,
      consumedMinor: 350,
    });
    expect(ledger.snapshot(tenant, workspaceId)).toMatchObject({
      reservedMinor: 0,
      consumedMinor: 350,
    });
  });

  it('calculates provider/model cost and denies policy-incompatible routes', () => {
    const ledger = new ScopedBudgetLedger({ clock: () => now });
    const organizationId = newSortableId();
    ledger.createBudget(
      definition(organizationId, { kind: 'organization', id: organizationId }, 10_000),
    );
    ledger.setPolicy({
      policyId: newSortableId(),
      tenant,
      scope: { kind: 'organization', id: organizationId },
      policyVersion: 'cost-policy.v1',
      allowedProviders: ['openai'],
      allowedModels: ['gpt-fixture'],
      maxInvocationCostMinor: 500,
      rates: [
        {
          providerId: 'openai',
          modelId: 'gpt-fixture',
          unit: 'input_tokens',
          category: 'llm',
          minorPerUnit: 2,
          currency: makeCurrency('USD'),
        },
        {
          providerId: 'openai',
          modelId: 'gpt-fixture',
          unit: 'output_tokens',
          category: 'llm',
          minorPerUnit: 4,
          currency: makeCurrency('USD'),
        },
      ],
    });
    const estimate = ledger.estimateModelCost({
      tenant,
      providerId: 'openai',
      modelId: 'gpt-fixture',
      inputTokens: 100,
      outputTokens: 50,
      currency: makeCurrency('USD'),
    });
    expect(estimate.amountMinor).toBe(400);
    expect(
      ledger.checkModelPolicy({
        tenant,
        providerId: 'openai',
        modelId: 'gpt-fixture',
        estimatedCost: makeMoney(400, 'USD'),
      }).allowed,
    ).toBe(true);
    expect(
      ledger.checkModelPolicy({
        tenant,
        providerId: 'anthropic',
        modelId: 'other',
        estimatedCost: makeMoney(1, 'USD'),
      }),
    ).toMatchObject({ allowed: false });
  });
});
