import { describe, expect, it } from 'vitest';
import { InMemoryArtifactObjectStore } from '@agentic-platform/artifact-registry';
import type { SecretHandle } from '@agentic-platform/backends';
import {
  makeMoney,
  newSortableId,
  type CloudRunRequestV1,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import {
  CloudBillingCoordinator,
  CloudPricingCatalog,
  CloudRunContinuityService,
  DeterministicCloudComputeProvider,
  DeterministicCloudInferenceProvider,
  InMemoryCloudAccountService,
  InMemoryCloudEventPublisher,
  InMemoryCloudUsageLedger,
  InMemoryPrepaidBalanceLedger,
  ModalComputeAdapter,
  OpenRouterInferenceAdapter,
  StateStoreCloudBillingStateStore,
  StateStoreCloudPrepaidBalanceLedger,
  StateStoreCloudRuntimeStore,
  StateStoreCloudUsageLedger,
  StripeBillingAdapter,
} from '../src/index.js';
import { InMemoryStateStore } from '@agentic-platform/state';

const now = '2026-08-07T00:00:00.000Z';

function tenant(): TenantRef {
  return { tenantId: newSortableId(), workspaceId: newSortableId() };
}

function request(
  inputTenant: TenantRef,
  actorId: ReturnType<typeof newSortableId>,
): CloudRunRequestV1 {
  return {
    schemaVersion: 1,
    runId: newSortableId(),
    localAttemptId: newSortableId(),
    tenant: inputTenant,
    actor: { actorId, type: 'human', displayName: 'Ada' },
    requestedAction: 'generate-report',
    provider: 'openrouter',
    modelId: 'openai/gpt-4o-mini',
    prompt: 'Summarize the run.',
    maxOutputTokens: 64,
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
    idempotencyKey: `run-${newSortableId()}`,
  };
}

function serviceFor(input: {
  readonly accountService: InMemoryCloudAccountService;
  readonly billing: CloudBillingCoordinator;
  readonly events?: InMemoryCloudEventPublisher;
  readonly store?: StateStoreCloudRuntimeStore;
}): CloudRunContinuityService {
  return new CloudRunContinuityService({
    accounts: input.accountService,
    inference: new DeterministicCloudInferenceProvider(),
    compute: new DeterministicCloudComputeProvider({ clock: () => now }),
    artifacts: new InMemoryArtifactObjectStore(),
    events: input.events ?? new InMemoryCloudEventPublisher({ clock: () => now }),
    pricing: new CloudPricingCatalog({
      currency: 'USD',
      llmInputMinorPerMillionTokens: 100,
      llmOutputMinorPerMillionTokens: 100,
      cpuMinorPerSecond: 1,
      gpuMinorPerSecond: 10,
      storageMinorPerMiB: 1,
      platformFeeMinor: 0,
    }),
    billing: input.billing,
    store: input.store,
    clock: () => now,
  });
}

describe('Phase 8 managed cloud execution', () => {
  it('switches a free individual Run from local to cloud and settles live usage', async () => {
    const inputTenant = tenant();
    const actorId = newSortableId();
    const accounts = new InMemoryCloudAccountService({ clock: () => now });
    const account = accounts.createIndividual({
      tenant: inputTenant,
      owner: { actorId, type: 'human', displayName: 'Ada' },
      billingMode: 'stripe',
      stripeCustomerId: 'cus_spyderbyte_test',
      now,
    });
    const login = accounts.issueSession(
      account.accountId,
      { actorId, type: 'human', displayName: 'Ada' },
      now,
    );
    const stripeCalls: string[] = [];
    const stripe = new StripeBillingAdapter({
      async authorize(input) {
        stripeCalls.push(`authorize:${input.amount.amountMinor}:${input.idempotencyKey}`);
        return { authorizationId: 'auth_1' };
      },
      async capture(input) {
        stripeCalls.push(`capture:${input.amount.amountMinor}:${input.idempotencyKey}`);
        return { paymentId: 'pi_1' };
      },
    });
    const events = new InMemoryCloudEventPublisher({ clock: () => now });
    const billing = new CloudBillingCoordinator({
      usageLedger: new InMemoryCloudUsageLedger(),
      stripe,
      clock: () => now,
    });
    const artifacts = new InMemoryArtifactObjectStore();
    const service = new CloudRunContinuityService({
      accounts,
      inference: new DeterministicCloudInferenceProvider(),
      compute: new DeterministicCloudComputeProvider({ clock: () => now }),
      artifacts,
      events,
      pricing: new CloudPricingCatalog({
        currency: 'USD',
        llmInputMinorPerMillionTokens: 100,
        llmOutputMinorPerMillionTokens: 100,
        cpuMinorPerSecond: 1,
        gpuMinorPerSecond: 10,
        storageMinorPerMiB: 1,
        platformFeeMinor: 0,
      }),
      billing,
      clock: () => now,
    });
    const runRequest = request(inputTenant, actorId);

    const estimate = await service.estimate(runRequest, login.accessToken);
    expect(estimate.platformFee.amountMinor).toBe(0);
    await expect(
      service.execute({
        accessToken: login.accessToken,
        estimateId: estimate.estimateId,
        approvalId: newSortableId(),
      }),
    ).rejects.toThrow('approval');
    const approval = await service.approve({
      accessToken: login.accessToken,
      estimateId: estimate.estimateId,
      actionDigest: estimate.actionDigest,
    });
    const result = await service.execute({
      accessToken: login.accessToken,
      estimateId: estimate.estimateId,
      approvalId: approval.approvalId,
    });

    expect(result.state).toBe('succeeded');
    expect(result.runId).toBe(runRequest.runId);
    expect(result.localAttemptId).toBe(runRequest.localAttemptId);
    expect(result.cloudAttemptId).not.toBe(runRequest.localAttemptId);
    expect(result.artifacts).toHaveLength(1);
    expect(result.billing?.state).toBe('reconciled');
    expect(result.billing?.providerPaymentId).toBe('pi_1');
    expect(result.usage?.amount.amountMinor).toBe(result.billing?.actual.amountMinor);
    expect(stripeCalls.filter((call) => call.startsWith('authorize:'))).toHaveLength(1);
    expect(stripeCalls.filter((call) => call.startsWith('capture:'))).toHaveLength(1);
    const object = await artifacts.get(result.artifacts[0]?.objectKey ?? '');
    expect(object).toBeDefined();
    expect(new TextDecoder().decode(object ?? new Uint8Array())).toContain(
      'cloud:openai/gpt-4o-mini',
    );
    const runEvents = await events.replay(inputTenant, 'cloud-runs');
    expect(runEvents.map((event) => event.eventName)).toEqual([
      'cloud.estimate.created.v1',
      'cloud.approval.required.v1',
      'cloud.run.switched.v1',
      'cloud.run.progress.v1',
      'cloud.run.progress.v1',
      'cloud.run.artifact.created.v1',
      'cloud.usage.recorded.v1',
      'cloud.billing.reconciled.v1',
      'cloud.run.completed.v1',
    ]);

    const repeated = await service.execute({
      accessToken: login.accessToken,
      estimateId: estimate.estimateId,
      approvalId: approval.approvalId,
    });
    expect(repeated).toEqual(result);
    expect(stripeCalls.filter((call) => call.startsWith('capture:'))).toHaveLength(1);
  });

  it('keeps estimates, sessions, and hosted work tenant-scoped', async () => {
    const firstTenant = tenant();
    const secondTenant = tenant();
    const firstActorId = newSortableId();
    const secondActorId = newSortableId();
    const accounts = new InMemoryCloudAccountService({ clock: () => now });
    const first = accounts.createIndividual({
      tenant: firstTenant,
      owner: { actorId: firstActorId, type: 'human' },
      now,
    });
    const second = accounts.createIndividual({
      tenant: secondTenant,
      owner: { actorId: secondActorId, type: 'human' },
      now,
    });
    const firstLogin = accounts.issueSession(
      first.accountId,
      { actorId: firstActorId, type: 'human' },
      now,
    );
    const secondLogin = accounts.issueSession(
      second.accountId,
      { actorId: secondActorId, type: 'human' },
      now,
    );
    const billing = new CloudBillingCoordinator({
      usageLedger: new InMemoryCloudUsageLedger(),
      clock: () => now,
    });
    const service = serviceFor({ accountService: accounts, billing });
    const runRequest = request(firstTenant, firstActorId);
    const estimate = await service.estimate(runRequest, firstLogin.accessToken);
    await expect(
      service.approve({
        accessToken: secondLogin.accessToken,
        estimateId: estimate.estimateId,
        actionDigest: estimate.actionDigest,
      }),
    ).rejects.toThrow('estimate');
    await expect(
      service.estimate(
        { ...runRequest, tenant: secondTenant, actor: { actorId: secondActorId, type: 'human' } },
        firstLogin.accessToken,
      ),
    ).rejects.toThrow('scope');
  });

  it('restores cloud estimates, approvals, results, and events after coordinator restart', async () => {
    const inputTenant = tenant();
    const actorId = newSortableId();
    const accounts = new InMemoryCloudAccountService({ clock: () => now });
    const account = accounts.createIndividual({
      tenant: inputTenant,
      owner: { actorId, type: 'human' },
      billingMode: 'prepaid',
      now,
    });
    const login = accounts.issueSession(account.accountId, { actorId, type: 'human' }, now);
    const state = new InMemoryStateStore();
    const store = new StateStoreCloudRuntimeStore(state);
    const prepaid = new StateStoreCloudPrepaidBalanceLedger(state);
    await prepaid.credit(inputTenant, makeMoney(100, 'USD'));
    const billing = new CloudBillingCoordinator({
      usageLedger: new StateStoreCloudUsageLedger(state),
      prepaidLedger: prepaid,
      state: new StateStoreCloudBillingStateStore(state),
      clock: () => now,
    });
    const runRequest = request(inputTenant, actorId);
    const first = serviceFor({ accountService: accounts, billing, store });
    const estimate = await first.estimate(runRequest, login.accessToken);
    const approval = await first.approve({
      accessToken: login.accessToken,
      estimateId: estimate.estimateId,
      actionDigest: estimate.actionDigest,
    });
    const result = await first.execute({
      accessToken: login.accessToken,
      estimateId: estimate.estimateId,
      approvalId: approval.approvalId,
    });

    const restarted = serviceFor({
      accountService: accounts,
      billing,
      store: new StateStoreCloudRuntimeStore(state),
    });
    await expect(restarted.estimate(runRequest, login.accessToken)).resolves.toEqual(estimate);
    await expect(
      restarted.execute({
        accessToken: login.accessToken,
        estimateId: estimate.estimateId,
        approvalId: approval.approvalId,
      }),
    ).resolves.toEqual(result);
    await expect(
      restarted.eventsForSession(login.accessToken, runRequest.runId),
    ).resolves.toHaveLength(9);
    const restartedPrepaid = new StateStoreCloudPrepaidBalanceLedger(state);
    const restartedBilling = new CloudBillingCoordinator({
      usageLedger: new StateStoreCloudUsageLedger(state),
      prepaidLedger: restartedPrepaid,
      state: new StateStoreCloudBillingStateStore(state),
      clock: () => now,
    });
    await expect(restartedBilling.record(inputTenant, estimate.estimateId)).resolves.toEqual(
      result.billing,
    );
    await expect(restartedPrepaid.snapshot(inputTenant)).resolves.toEqual({
      availableMinor: 100 - (result.billing?.actual.amountMinor ?? 0),
      reservedMinor: 0,
    });
  });

  it('supports prepaid balances and reconciles only actual usage', async () => {
    const inputTenant = tenant();
    const actorId = newSortableId();
    const accounts = new InMemoryCloudAccountService({ clock: () => now });
    const account = accounts.createIndividual({
      tenant: inputTenant,
      owner: { actorId, type: 'human' },
      billingMode: 'prepaid',
      now,
    });
    const login = accounts.issueSession(account.accountId, { actorId, type: 'human' }, now);
    const prepaid = new InMemoryPrepaidBalanceLedger();
    prepaid.credit(inputTenant, makeMoney(100, 'USD'));
    const billing = new CloudBillingCoordinator({
      usageLedger: new InMemoryCloudUsageLedger(),
      prepaidLedger: prepaid,
      clock: () => now,
    });
    const service = serviceFor({ accountService: accounts, billing });
    const estimate = await service.estimate(request(inputTenant, actorId), login.accessToken);
    const approval = await service.approve({
      accessToken: login.accessToken,
      estimateId: estimate.estimateId,
      actionDigest: estimate.actionDigest,
    });
    const result = await service.execute({
      accessToken: login.accessToken,
      estimateId: estimate.estimateId,
      approvalId: approval.approvalId,
    });
    expect(result.billing?.mode).toBe('prepaid');
    expect(prepaid.snapshot(inputTenant).reservedMinor).toBe(0);
    expect(prepaid.snapshot(inputTenant).availableMinor).toBe(
      100 - (result.billing?.actual.amountMinor ?? 0),
    );
  });

  it('keeps OpenRouter and Modal credentials behind the secret-handle boundary', async () => {
    const inputTenant = tenant();
    const handle: SecretHandle = {
      handleId: newSortableId(),
      tenant: inputTenant,
      secretName: 'openrouter-key',
      operation: 'cloud.model.invoke',
      expiresAt: '2026-08-07T01:00:00.000Z',
      scopeDigest: 'scope',
    };
    const resolved: string[] = [];
    const secretResolver = {
      async resolve(
        secretHandle: SecretHandle,
        scopedTenant: TenantRef,
        operation: string,
      ): Promise<string> {
        resolved.push(`${secretHandle.handleId}:${scopedTenant.tenantId}:${operation}`);
        return 'ephemeral-secret';
      },
    };
    const fetcher: typeof fetch = async (_url, init) => {
      const body = String(init?.body);
      expect(body).not.toContain('ephemeral-secret');
      expect((init?.headers as Record<string, string>).authorization).toBe(
        'Bearer ephemeral-secret',
      );
      return new Response(
        'data: {"id":"or_1","choices":[{"delta":{"content":"hello"}}]}\n\ndata: {"id":"or_1","usage":{"prompt_tokens":2,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    };
    const inference = new OpenRouterInferenceAdapter({
      apiKeyHandle: handle,
      secretResolver,
      fetcher,
    });
    const streamed = [];
    for await (const event of await inference.stream({
      tenant: inputTenant,
      modelId: 'openai/gpt-4o-mini',
      prompt: 'hi',
      maxOutputTokens: 8,
    }))
      streamed.push(event);
    expect(streamed).toEqual([
      { type: 'delta', text: 'hello' },
      { type: 'usage', inputTokens: 2, outputTokens: 1, providerRequestId: 'or_1' },
      { type: 'completed', providerRequestId: 'or_1' },
    ]);
    expect(resolved).toHaveLength(1);

    const modalCalls: string[] = [];
    const modal = new ModalComputeAdapter({
      authHandle: { ...handle, operation: 'cloud.compute.submit', secretName: 'modal-key' },
      secretResolver,
      gateway: {
        async estimate(input) {
          modalCalls.push(input.authorizationToken);
          return { externalOfferId: 'offer_1', estimatedCost: makeMoney(1, 'USD') };
        },
        async submit(input) {
          modalCalls.push(input.authorizationToken);
          return { externalExecutionId: 'modal_1', state: 'running' as const };
        },
        async observe(input) {
          modalCalls.push(input.authorizationToken);
          return {
            handle: input.handle,
            state: 'succeeded' as const,
            observedAt: now,
            stdout: 'ok',
            stderr: '',
            computeSeconds: 1,
            outputBytes: 2,
          };
        },
        async terminate(input) {
          modalCalls.push(input.authorizationToken);
        },
      },
      clock: () => now,
    });
    const compute = request(inputTenant, newSortableId()).compute;
    await modal.estimate({ tenant: inputTenant, compute });
    expect(modalCalls).toEqual(['ephemeral-secret']);
  });
});
