import { describe, expect, it } from 'vitest';
import {
  newSortableId,
  type AgentInvocation,
  type JsonValue,
} from '@agentic-platform/runtime-contracts';
import {
  ClineGatewaySdkFactory,
  ClineSdkCompatibilityAdapter,
  FixtureClineSdkFactory,
} from '../src/index.js';

const now = '2026-08-02T00:00:00.000Z';
const invocation: AgentInvocation = {
  schemaVersion: 1,
  invocationId: newSortableId(),
  workflowId: newSortableId(),
  tenant: { tenantId: newSortableId(), workspaceId: newSortableId() },
  tier: 2,
  agentType: 'worker',
  harnessVersion: 'cline-fixture.v1',
  input: { task: 'fixture' },
  authority: {
    schemaVersion: 1,
    envelopeId: newSortableId(),
    tenant: { tenantId: newSortableId(), workspaceId: newSortableId() },
    issuer: { actorId: newSortableId(), type: 'system' },
    subjectAgentId: newSortableId(),
    workflowId: newSortableId(),
    invocationId: newSortableId(),
    tier: 2,
    harnessVersion: 'cline-fixture.v1',
    permittedActions: [],
    capabilities: [],
    resourceScopes: [],
    allowedArtifactReads: [],
    allowedArtifactWrites: [],
    allowedChildAgentTypes: [],
    maxChildCount: 0,
    toolOperations: [],
    issuedAt: now,
    expiresAt: '2026-08-02T01:00:00.000Z',
    nonce: 'nonce',
    policyVersion: 'policy.v1',
    revocationEpoch: 0,
    integrityProof: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
  resource: {
    limits: {
      cpuMillicores: 100,
      memoryBytes: 1024,
      wallTimeMs: 1000,
      outputBytes: 1000,
      storageBytes: 1000,
      processCount: 1,
    },
    networkAllowlist: [],
    readOnlyArtifactMounts: true,
  },
  retry: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0, retryableErrorCodes: [] },
  budget: { budgetId: newSortableId(), limit: 100, reserved: 0, consumed: 0, currency: 'USD' },
  state: 'created',
  attempt: 0,
  createdAt: now,
  correlationId: newSortableId(),
};

describe('Cline SDK compatibility fixture', () => {
  it('maps the documented run/subscribe/abort surface into the internal adapter contract', async () => {
    const adapter = new ClineSdkCompatibilityAdapter(
      new FixtureClineSdkFactory({
        async *run(_input, tools, signal) {
          yield { type: 'assistant-text-delta', text: 'hello' };
          const result = await tools.get('search.read')?.({ query: 'x' });
          if (result !== undefined) yield { type: 'completed', output: result };
          yield {
            type: 'usage',
            usage: {
              usageId: newSortableId(),
              invocationId: invocation.invocationId,
              quantity: { value: 2, unit: 'tokens' },
              observedAt: now,
            },
          };
          if (signal.aborted) return;
        },
      }),
    );
    const runtime = await adapter.createRuntime(invocation);
    runtime.registerTool({
      grant: {
        schemaVersion: 1,
        grantId: newSortableId(),
        tenant: invocation.tenant,
        invocationId: invocation.invocationId,
        toolName: 'search',
        operation: 'read',
        issuedAt: now,
        expiresAt: '2026-08-02T01:00:00.000Z',
        authorityEnvelopeId: invocation.authority.envelopeId,
        resourceScopes: [],
      },
      execute: async () => ({ result: 'tool-output' }),
    });
    const events = [];
    for await (const event of runtime.streamEvents({ query: 'x' })) events.push(event);
    expect(
      events.some(
        (event) =>
          event.type === 'output' &&
          typeof event.value === 'object' &&
          event.value !== null &&
          !Array.isArray(event.value) &&
          event.value['result'] === 'tool-output',
      ),
    ).toBe(true);
    expect((await runtime.usage()).length).toBeGreaterThan(0);
    await runtime.dispose();
    expect(adapter.normalizeError({ name: 'AbortError' }).code).toBe(
      'COMPUTE_RESOURCE_UNAVAILABLE',
    );
  });

  it('normalizes fixture failures without leaking SDK error objects', async () => {
    const adapter = new ClineSdkCompatibilityAdapter(
      new FixtureClineSdkFactory({
        async *run() {
          yield {
            type: 'failed',
            error: { code: 'POLICY_DENIED', message: 'secret should not escape' },
          };
        },
      }),
    );
    const runtime = await adapter.createRuntime(invocation);
    const output: JsonValue[] = [];
    for await (const value of runtime.executeStructured(null)) output.push(value);
    expect(output).toEqual([]);
    expect(adapter.normalizeError({ code: 'POLICY_DENIED', message: 'denied' }).retryable).toBe(
      false,
    );
  });

  it('surfaces streamed SDK failures instead of silently closing the event stream', async () => {
    const adapter = new ClineSdkCompatibilityAdapter(
      new FixtureClineSdkFactory({
        async *run() {
          yield { type: 'failed', error: { code: 'POLICY_DENIED', message: 'denied' } };
        },
      }),
    );
    const runtime = await adapter.createRuntime(invocation);
    const events = [];
    for await (const event of runtime.streamEvents({ query: 'x' })) events.push(event);
    expect(events.some((event) => event.type === 'failed')).toBe(true);
    await runtime.dispose();
  });

  it('wins cancellation races and closes the stream without hanging', async () => {
    const adapter = new ClineSdkCompatibilityAdapter(
      new FixtureClineSdkFactory({
        async *run(_input, _tools, signal) {
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          if (!signal.aborted) yield { type: 'completed', output: null };
        },
      }),
    );
    const runtime = await adapter.createRuntime(invocation);
    const controller = new AbortController();
    const iterator = runtime
      .streamEvents({ query: 'x' }, controller.signal)
      [Symbol.asyncIterator]();
    const pending = iterator.next();
    controller.abort();
    await expect(pending).resolves.toMatchObject({ done: true });
    await runtime.dispose();
  });

  it('creates the gateway model from the resolved provider and model ids', () => {
    const selected: Array<{ providerId: string; modelId: string }> = [];
    const gatewayModel = { id: 'gateway-model' };
    const fixture = new FixtureClineSdkFactory({
      async *run() {
        yield { type: 'completed', output: null };
      },
    });
    let receivedModel: unknown;
    const factory = new ClineGatewaySdkFactory(
      {
        createAgentModel(selection) {
          selected.push(selection);
          return gatewayModel;
        },
      },
      {
        createAgent(config) {
          receivedModel = config.model;
          return fixture.createAgent(config);
        },
      },
    );
    factory.createAgent({
      agentId: 'agent',
      agentRole: 'worker',
      providerId: 'openai-codex',
      modelId: 'gpt-5.3-codex',
    });
    expect(selected).toEqual([{ providerId: 'openai-codex', modelId: 'gpt-5.3-codex' }]);
    expect(receivedModel).toBe(gatewayModel);
  });
});
