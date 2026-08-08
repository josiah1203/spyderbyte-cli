import { describe, expect, it } from 'vitest';
import {
  makeMoney,
  makeQuantity,
  type Actor,
  type AuthorityEnvelope,
  type BudgetCategory,
  type Id,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import { AuthorityService } from '@agentic-platform/policy';
import { BudgetLedger, type BudgetDefinition } from '../src/index.js';

const tenant: TenantRef = {
  tenantId: '018f0c4b-4e20-7abc-8def-0123456789ab' as Id,
  workspaceId: '018f0c4b-4e21-7abc-8def-0123456789ab' as Id,
};
const workflowId = '018f0c4b-4e22-7abc-8def-0123456789ab' as Id;
const invocationId = '018f0c4b-4e23-7abc-8def-0123456789ab' as Id;
const agentId = '018f0c4b-4e24-7abc-8def-0123456789ab' as Id;
const actor: Actor = { actorId: agentId, type: 'agent' };
const now = '2026-08-02T00:00:00.000Z';
const actions = [
  'budget.create',
  'budget.reserve',
  'budget.consume',
  'budget.reconcile',
  'budget.release',
];

function authority(): { service: AuthorityService; envelope: AuthorityEnvelope } {
  const service = new AuthorityService({ policyVersion: 'policy.v1', clock: () => now });
  return {
    service,
    envelope: service.issue({
      tenant,
      workflowId,
      invocationId,
      issuer: actor,
      subjectAgentId: agentId,
      tier: 1,
      harnessVersion: 'harness.v1',
      permittedActions: actions,
      capabilities: [],
      resourceScopes: [],
      allowedArtifactReads: [],
      allowedArtifactWrites: [],
      allowedChildAgentTypes: [],
      maxChildCount: 0,
      toolOperations: [],
      issuedAt: now,
      expiresAt: '2026-08-02T01:00:00.000Z',
    }),
  };
}

function definition(): BudgetDefinition {
  const categoryHardLimits: Record<BudgetCategory, number> = {
    llm: 1000,
    compute: 1000,
    storage: 1000,
    external_api: 1000,
    retry: 1000,
  };
  return {
    budgetId: '018f0c4b-4e25-7abc-8def-0123456789ab' as Id,
    tenant,
    workflowId,
    currency: 'USD',
    hardLimitMinor: 1000,
    softLimitMinor: 500,
    categoryHardLimits,
    categorySoftLimits: { ...categoryHardLimits, compute: 300 },
    createdAt: now,
  };
}

describe('concurrency-safe budget ledger', () => {
  it('prevents concurrent reservations from oversubscribing a hard limit', async () => {
    const { service, envelope } = authority();
    const ledger = new BudgetLedger({ authority: service, clock: () => now });
    ledger.createBudget(definition(), envelope, now);
    const results = await Promise.allSettled(
      ['018f0c4b-4e26-7abc-8def-0123456789ab', '018f0c4b-4e27-7abc-8def-0123456789ab'].map(
        (reservationId) =>
          ledger.reserve({
            budgetId: definition().budgetId,
            tenant,
            invocationId,
            category: 'compute',
            amount: makeMoney(600, 'USD'),
            authority: envelope,
            reservationId: reservationId as Id,
            now,
          }),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(ledger.snapshot(tenant, definition().budgetId).reservedMinor).toBe(600);
  });

  it('supports partial consumption, release, reconciliation, alerts, and anomalies', async () => {
    const { service, envelope } = authority();
    const ledger = new BudgetLedger({ authority: service, clock: () => now });
    ledger.createBudget(definition(), envelope, now);
    const reservation = await ledger.reserve({
      budgetId: definition().budgetId,
      tenant,
      invocationId,
      category: 'compute',
      amount: makeMoney(600, 'USD'),
      authority: envelope,
      now,
    });
    expect(
      ledger
        .alerts(tenant, definition().budgetId)
        .some((alert) => alert.kind === 'soft_limit_exceeded'),
    ).toBe(true);
    const consumed = await ledger.consume({
      tenant,
      invocationId,
      reservationId: reservation.reservation.reservationId,
      amount: makeMoney(200, 'USD'),
      quantity: makeQuantity(1, 'requests'),
      authority: envelope,
      now,
    });
    expect(consumed.reservation.consumedMinor).toBe(200);
    const reconciled = await ledger.reconcile({
      tenant,
      invocationId,
      reservationId: reservation.reservation.reservationId,
      actual: makeMoney(800, 'USD'),
      authority: envelope,
      now,
    });
    expect(reconciled.reservation.reservation.state).toBe('reconciled');
    expect(reconciled.reservation.consumedMinor).toBe(800);
    expect(ledger.snapshot(tenant, definition().budgetId).reservedMinor).toBe(0);
    expect(
      ledger.alerts(tenant, definition().budgetId).some((alert) => alert.kind === 'anomaly'),
    ).toBe(true);
  });

  it('fails closed when a reservation is used by another invocation', async () => {
    const { service, envelope } = authority();
    const ledger = new BudgetLedger({ authority: service, clock: () => now });
    ledger.createBudget(definition(), envelope, now);
    const reservation = await ledger.reserve({
      budgetId: definition().budgetId,
      tenant,
      invocationId,
      category: 'retry',
      amount: makeMoney(10, 'USD'),
      authority: envelope,
      now,
    });
    await expect(
      ledger.release({
        tenant,
        invocationId: '018f0c4b-4e28-7abc-8def-0123456789ab' as Id,
        reservationId: reservation.reservation.reservationId,
        authority: envelope,
        now,
      }),
    ).rejects.toThrow('different invocation');
  });
});
