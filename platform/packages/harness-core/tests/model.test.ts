import { describe, expect, it } from 'vitest';
import {
  makeMoney,
  type AuthorityEnvelope,
  type Id,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import { BudgetLedger, type BudgetDefinition } from '@agentic-platform/budget';
import {
  AuthorityService,
  InMemoryPolicyDecisionStore,
  PolicyDecisionService,
} from '@agentic-platform/policy';
import {
  InMemoryModelAuditSink,
  InMemoryModelTelemetrySink,
  InMemoryModelUsageSink,
  MeteredModelClient,
  ModelRouter,
  type ModelProvider,
} from '../src/index.js';

const tenant: TenantRef = {
  tenantId: '018f0c4b-4e50-7abc-8def-0123456789ab' as Id,
  workspaceId: '018f0c4b-4e51-7abc-8def-0123456789ab' as Id,
};
const workflowId = '018f0c4b-4e52-7abc-8def-0123456789ab' as Id;
const invocationId = '018f0c4b-4e53-7abc-8def-0123456789ab' as Id;
const agentId = '018f0c4b-4e54-7abc-8def-0123456789ab' as Id;
const budgetId = '018f0c4b-4e55-7abc-8def-0123456789ab' as Id;
const correlationId = '018f0c4b-4e56-7abc-8def-0123456789ab' as Id;
const now = '2026-08-02T00:00:00.000Z';
const actions = [
  'model.call',
  'compute.allocate',
  'budget.create',
  'budget.reserve',
  'budget.reconcile',
  'budget.release',
];

function setup(): {
  authority: AuthorityService;
  envelope: AuthorityEnvelope;
  budget: BudgetLedger;
  router: ModelRouter;
  telemetry: InMemoryModelTelemetrySink;
  audit: InMemoryModelAuditSink;
  usage: InMemoryModelUsageSink;
} {
  const authority = new AuthorityService({ policyVersion: 'policy.v1', clock: () => now });
  const envelope = authority.issue({
    tenant,
    workflowId,
    invocationId,
    issuer: { actorId: agentId, type: 'agent' },
    subjectAgentId: agentId,
    tier: 1,
    harnessVersion: 'governance.v1',
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
  });
  const budget = new BudgetLedger({ authority, clock: () => now });
  const categoryHardLimits = {
    llm: 1000,
    compute: 1000,
    storage: 1000,
    external_api: 1000,
    retry: 1000,
  } as const;
  const definition: BudgetDefinition = {
    budgetId,
    tenant,
    workflowId,
    currency: 'USD',
    hardLimitMinor: 1000,
    softLimitMinor: 900,
    categoryHardLimits,
    categorySoftLimits: categoryHardLimits,
    createdAt: now,
  };
  budget.createBudget(definition, envelope, now);
  const router = new ModelRouter();
  const telemetry = new InMemoryModelTelemetrySink();
  const audit = new InMemoryModelAuditSink();
  const usage = new InMemoryModelUsageSink();
  return { authority, envelope, budget, router, telemetry, audit, usage };
}

function provider(
  providerId: string,
  model: string,
  output: Record<string, unknown>,
  cost = 100,
): ModelProvider {
  return {
    providerId,
    model,
    async complete() {
      return {
        output,
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5, cost: makeMoney(cost, 'USD') },
      };
    },
  };
}

describe('metered model client', () => {
  it('routes, reserves, reconciles, and emits non-sensitive telemetry', async () => {
    const { authority, envelope, budget, router, telemetry, audit, usage } = setup();
    router.registerProvider(provider('local', 'fake-model', { ok: true }));
    router.registerRoute({
      taskShape: 'governance',
      tier: 1,
      providers: ['local:fake-model'],
      maxTokens: 20,
    });
    const client = new MeteredModelClient({
      authority,
      policy: new PolicyDecisionService({ authority, store: new InMemoryPolicyDecisionStore() }),
      budget,
      router,
      telemetry,
      audit,
      usage,
      clock: () => now,
    });
    const response = await client.complete({
      tenant,
      invocationId,
      correlationId,
      authority: envelope,
      budgetId,
      taskShape: 'governance',
      tier: 1,
      input: { prompt: 'private input' },
      allowedModels: ['fake-model'],
      maxTokens: 10,
      estimatedCost: makeMoney(150, 'USD'),
      now,
    });
    expect(response.output).toEqual({ ok: true });
    expect(response.model).toBe('fake-model');
    expect(budget.snapshot(tenant, budgetId)).toMatchObject({
      reservedMinor: 0,
      consumedMinor: 100,
    });
    expect(telemetry.list().map((event) => event.type)).toEqual(['start', 'completion']);
    expect(JSON.stringify(telemetry.list())).not.toContain('private input');
    expect(usage.list()).toHaveLength(1);
    expect(usage.list()[0]).toMatchObject({
      invocationId,
      correlationId,
      providerId: 'local',
      model: 'fake-model',
      reservationId: expect.any(String),
    });
    expect(audit.list().map((event) => event.type)).toEqual(['selection', 'attempt', 'completed']);
  });

  it('uses a bounded provider fallback and releases the reservation on token overflow', async () => {
    const { authority, envelope, budget, router, telemetry } = setup();
    const failing: ModelProvider = {
      providerId: 'primary',
      model: 'primary-model',
      async complete() {
        throw new Error('provider unavailable');
      },
    };
    router.registerProvider(failing);
    router.registerProvider(provider('fallback', 'fallback-model', { ok: true }, 80));
    router.registerRoute({
      taskShape: 'governance',
      tier: 1,
      providers: ['primary:primary-model', 'fallback:fallback-model'],
      maxTokens: 20,
    });
    const client = new MeteredModelClient({
      authority,
      policy: new PolicyDecisionService({ authority }),
      budget,
      router,
      telemetry,
      clock: () => now,
    });
    const response = await client.complete({
      tenant,
      invocationId,
      correlationId,
      authority: envelope,
      budgetId,
      taskShape: 'governance',
      tier: 1,
      input: { prompt: 'input' },
      allowedModels: ['primary-model', 'fallback-model'],
      maxTokens: 10,
      estimatedCost: makeMoney(150, 'USD'),
      now,
    });
    expect(response.providerId).toBe('fallback');
    expect(telemetry.list().map((event) => event.type)).toEqual([
      'start',
      'failure',
      'start',
      'completion',
    ]);

    const overflowing: ModelProvider = {
      providerId: 'overflow',
      model: 'overflow-model',
      async complete() {
        return {
          output: { ok: true },
          usage: {
            inputTokens: 20,
            outputTokens: 20,
            totalTokens: 40,
            cost: makeMoney(100, 'USD'),
          },
        };
      },
    };
    router.registerProvider(overflowing);
    router.registerRoute({
      taskShape: 'overflow',
      tier: 1,
      providers: ['overflow:overflow-model'],
      maxTokens: 5,
    });
    await expect(
      client.complete({
        tenant,
        invocationId,
        correlationId,
        authority: envelope,
        budgetId,
        taskShape: 'overflow',
        tier: 1,
        input: {},
        allowedModels: ['overflow-model'],
        maxTokens: 5,
        estimatedCost: makeMoney(100, 'USD'),
        now,
      }),
    ).rejects.toThrow('token limit');
    expect(budget.snapshot(tenant, budgetId).reservedMinor).toBe(0);
  });

  it('cancels in-flight providers and stops fallback after a deadline', async () => {
    const { authority, envelope, budget, router } = setup();
    let cancelled = false;
    let resolveProvider: (() => void) | undefined;
    const primary: ModelProvider = {
      providerId: 'primary',
      model: 'primary-model',
      complete() {
        return new Promise((resolve) => {
          resolveProvider = () =>
            resolve({
              output: { ok: true },
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cost: makeMoney(1, 'USD') },
            });
        });
      },
      async cancel() {
        cancelled = true;
        resolveProvider?.();
        throw new Error('provider cancellation endpoint unavailable');
      },
    };
    let fallbackCalls = 0;
    const fallback: ModelProvider = {
      providerId: 'fallback',
      model: 'fallback-model',
      async complete() {
        fallbackCalls += 1;
        return {
          output: { ok: true },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cost: makeMoney(1, 'USD') },
        };
      },
    };
    router.registerProvider(primary);
    router.registerProvider(fallback);
    router.registerRoute({
      taskShape: 'governance',
      tier: 1,
      providers: ['primary:primary-model', 'fallback:fallback-model'],
      maxTokens: 20,
    });
    const client = new MeteredModelClient({
      authority,
      policy: new PolicyDecisionService({ authority }),
      budget,
      router,
      clock: () => now,
    });
    const controller = new AbortController();
    const pending = client.complete({
      tenant,
      invocationId,
      correlationId,
      authority: envelope,
      budgetId,
      taskShape: 'governance',
      tier: 1,
      input: {},
      allowedModels: ['primary-model', 'fallback-model'],
      maxTokens: 10,
      estimatedCost: makeMoney(10, 'USD'),
      now,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow('cancelled');
    expect(cancelled).toBe(true);
    expect(budget.snapshot(tenant, budgetId).reservedMinor).toBe(0);

    await expect(
      client.complete({
        tenant,
        invocationId,
        correlationId,
        authority: envelope,
        budgetId,
        taskShape: 'governance',
        tier: 1,
        input: {},
        allowedModels: ['primary-model', 'fallback-model'],
        maxTokens: 10,
        estimatedCost: makeMoney(10, 'USD'),
        now,
        deadlineAt: new Date(Date.now() - 1_000).toISOString(),
      }),
    ).rejects.toThrow('cancelled');
    expect(fallbackCalls).toBe(0);
    expect(budget.snapshot(tenant, budgetId).reservedMinor).toBe(0);
  });
});
