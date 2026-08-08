import { describe, expect, it } from 'vitest';
import { InMemoryArtifactObjectStore } from '@agentic-platform/artifact-registry';
import {
  CloudBillingCoordinator,
  CloudPricingCatalog,
  CloudRunContinuityService,
  DeterministicCloudComputeProvider,
  DeterministicCloudInferenceProvider,
  InMemoryCloudAccountService,
  InMemoryCloudEventPublisher,
  InMemoryCloudUsageLedger,
  StripeBillingAdapter,
} from '@agentic-platform/cloud-runtime';
import {
  makeMoney,
  newSortableId,
  type CloudRunRequestV1,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import { handleLocalApiRequest, type LocalApiOptions } from '../src/index.js';

const now = '2026-08-07T00:00:00.000Z';

function buildApi(): {
  readonly api: LocalApiOptions;
  readonly request: CloudRunRequestV1;
  readonly token: string;
} {
  const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
  const actorId = newSortableId();
  const actor = { actorId, type: 'human' as const, displayName: 'Ada' };
  const accounts = new InMemoryCloudAccountService({ clock: () => now });
  const account = accounts.createIndividual({
    tenant,
    owner: actor,
    stripeCustomerId: 'cus_api',
    now,
  });
  const login = accounts.issueSession(account.accountId, actor, now);
  const service = new CloudRunContinuityService({
    accounts,
    inference: new DeterministicCloudInferenceProvider(),
    compute: new DeterministicCloudComputeProvider({ clock: () => now }),
    artifacts: new InMemoryArtifactObjectStore(),
    events: new InMemoryCloudEventPublisher({ clock: () => now }),
    pricing: new CloudPricingCatalog({
      currency: 'USD',
      llmInputMinorPerMillionTokens: 100,
      llmOutputMinorPerMillionTokens: 100,
      cpuMinorPerSecond: 1,
      gpuMinorPerSecond: 10,
      storageMinorPerMiB: 1,
      platformFeeMinor: 0,
    }),
    billing: new CloudBillingCoordinator({
      usageLedger: new InMemoryCloudUsageLedger(),
      stripe: new StripeBillingAdapter({
        async authorize() {
          return { authorizationId: 'auth_api' };
        },
        async capture() {
          return { paymentId: 'payment_api' };
        },
      }),
      clock: () => now,
    }),
    clock: () => now,
  });
  const request: CloudRunRequestV1 = {
    schemaVersion: 1,
    runId: newSortableId(),
    localAttemptId: newSortableId(),
    tenant,
    actor,
    requestedAction: 'api-cloud-run',
    provider: 'openrouter',
    modelId: 'openai/gpt-4o-mini',
    prompt: 'hello',
    maxOutputTokens: 16,
    compute: {
      cpuMillicores: 500,
      memoryBytes: 128 * 1024 * 1024,
      gpuCount: 0,
      wallTimeMs: 1_000,
      maxOutputBytes: 10_000,
      maxProcessCount: 1,
    },
    maxCost: makeMoney(100, 'USD'),
    outputMediaType: 'text/plain',
    idempotencyKey: `api-${newSortableId()}`,
  };
  return {
    api: {
      orchestrator: { submit: async () => ({}) as never },
      tenant,
      localSession: { tenant, actor },
      cloud: { service },
      clock: () => now,
    },
    request,
    token: login.accessToken,
  };
}

describe('local-api Phase 8 cloud Run routes', () => {
  it('exposes estimate, approval, execution, and live event continuity', async () => {
    const { api, request, token } = buildApi();
    const headers = { authorization: `Bearer ${token}` };
    const estimated = await handleLocalApiRequest(
      { method: 'POST', path: '/v1/cloud/runs/estimate', body: request, headers },
      api,
    );
    expect(estimated.statusCode).toBe(200);
    const estimate = estimated.body as { estimateId: string; actionDigest: string };
    const approved = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/cloud/runs/approve',
        body: { estimateId: estimate.estimateId, actionDigest: estimate.actionDigest },
        headers,
      },
      api,
    );
    expect(approved.statusCode).toBe(200);
    const approval = approved.body as { approvalId: string };
    const executed = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/cloud/runs/execute',
        body: { estimateId: estimate.estimateId, approvalId: approval.approvalId },
        headers,
      },
      api,
    );
    expect(executed).toMatchObject({
      statusCode: 200,
      body: { state: 'succeeded', runId: request.runId },
    });
    const events = await handleLocalApiRequest(
      { method: 'GET', path: `/v1/cloud/runs/${request.runId}/events`, body: undefined, headers },
      api,
    );
    expect(events.statusCode).toBe(200);
    expect((events.body as { events: unknown[] }).events.length).toBeGreaterThanOrEqual(5);
  });
});
