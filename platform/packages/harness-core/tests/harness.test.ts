import { describe, expect, it } from 'vitest';
import {
  type AgentInvocation,
  type AgentRegistration,
  type AuthorityEnvelope,
  type HashSha256,
  type Id,
  type JsonValue,
  type ResourceSelector,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import { AuthorityService } from '@agentic-platform/policy';
import { InMemoryStateStore } from '@agentic-platform/state';
import {
  ContextAssembler,
  ClineAgentRuntimeAdapter,
  FakeClineAdapter,
  HarnessExecutor,
  HarnessFactory,
  InvocationService,
  assertInvocationHierarchy,
  mayInvoke,
  type HarnessDefinition,
} from '../src/index.js';

const tenant: TenantRef = {
  tenantId: '018f0c4b-4e40-7abc-8def-0123456789ab' as Id,
  workspaceId: '018f0c4b-4e41-7abc-8def-0123456789ab' as Id,
};
const workflowId = '018f0c4b-4e42-7abc-8def-0123456789ab' as Id;
const parentInvocationId = '018f0c4b-4e43-7abc-8def-0123456789ab' as Id;
const childInvocationId = '018f0c4b-4e44-7abc-8def-0123456789ab' as Id;
const parentAgentId = '018f0c4b-4e45-7abc-8def-0123456789ab' as Id;
const childAgentId = '018f0c4b-4e46-7abc-8def-0123456789ab' as Id;
const now = '2026-08-02T00:00:00.000Z';

function schema<T extends JsonValue>(name: string, validate: (value: unknown) => value is T) {
  return {
    name,
    validate(value: unknown) {
      return validate(value)
        ? { valid: true, value, errors: [] }
        : { valid: false, errors: [`Expected ${name}`] };
    },
  };
}

const jsonObjectSchema = schema<{ ok: boolean }>('Result.v1', (value): value is { ok: boolean } => {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'ok' in value &&
    typeof value.ok === 'boolean'
  );
});

function authority(
  service: AuthorityService,
  subjectAgentId: Id,
  invocationId: Id,
  tier: 0 | 1 | 2,
  actions: string[],
  childTypes: string[] = [],
  resourceScopes: ResourceSelector[] = [],
): AuthorityEnvelope {
  return service.issue({
    tenant,
    workflowId,
    invocationId,
    issuer: { actorId: subjectAgentId, type: 'agent' },
    subjectAgentId,
    tier,
    harnessVersion: tier === 1 ? 'governance.v1' : 'worker.v1',
    permittedActions: actions,
    capabilities: [],
    resourceScopes,
    allowedArtifactReads: [],
    allowedArtifactWrites: [],
    allowedChildAgentTypes: childTypes,
    maxChildCount: childTypes.length,
    toolOperations: [],
    issuedAt: now,
    expiresAt: '2026-08-02T01:00:00.000Z',
  });
}

function invocation(
  service: AuthorityService,
  invocationId: Id,
  agentId: Id,
  tier: 0 | 1 | 2,
  state: AgentInvocation['state'] = 'running',
  parentInvocationId?: Id,
): AgentInvocation {
  const envelope = authority(
    service,
    agentId,
    invocationId,
    tier,
    tier === 1 ? ['invocation.create'] : [],
    tier === 1 ? ['worker'] : [],
  );
  return {
    schemaVersion: 1,
    invocationId,
    workflowId,
    ...(parentInvocationId !== undefined ? { parentInvocationId } : {}),
    tenant,
    tier,
    agentType: tier === 1 ? 'governance' : 'worker',
    harnessVersion: tier === 1 ? 'governance.v1' : 'worker.v1',
    input: { task: 'validate' },
    authority: envelope,
    resource: {
      limits: {
        cpuMillicores: 100,
        memoryBytes: 1024,
        wallTimeMs: 10_000,
        outputBytes: 1024,
        storageBytes: 1024,
        processCount: 1,
      },
      networkAllowlist: [],
      readOnlyArtifactMounts: true,
    },
    retry: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0, retryableErrorCodes: [] },
    budget: {
      budgetId: parentInvocationId ?? invocationId,
      limit: 1000,
      reserved: 0,
      consumed: 0,
      currency: 'USD',
    },
    state,
    attempt: 0,
    createdAt: now,
    correlationId: workflowId,
  };
}

function definition(tier: 0 | 1 | 2 = 1): HarnessDefinition<{ task: string }, { ok: boolean }> {
  return {
    identity: {
      agentType: tier === 1 ? 'governance' : 'worker',
      version: tier === 1 ? 'governance.v1' : 'worker.v1',
    },
    tier,
    inputSchema: schema<{ task: string }>('Task.v1', (value): value is { task: string } => {
      return (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        'task' in value &&
        typeof value.task === 'string'
      );
    }),
    outputSchema: jsonObjectSchema,
    promptPolicy: { maxPromptBytes: 10_000, allowExternalInstructions: false },
    contextPolicy: {
      maxContextBytes: 100_000,
      artifactContent: 'authorized_content',
      includeWorkspacePolicy: true,
      includeChildReports: true,
    },
    toolPolicy: { requireGrants: true, allowedOperations: [], maxCalls: 0 },
    modelPolicy: {
      allowedModels: ['fake-model'],
      fallbackModels: [],
      maxTokens: 100,
      allowProviderFallback: false,
    },
    authorityPolicy: {
      permittedActions: ['invocation.create'],
      allowedChildTiers: tier === 1 ? [2] : [],
      maxDepth: 2,
      maxChildren: 2,
    },
    budgetPolicy: {
      budgetId: workflowId,
      currency: 'USD',
      maxMinorUnits: 1000,
      requireReservation: true,
    },
    retryPolicy: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0, retryableErrorCodes: [] },
    approvalPolicy: { requiredActions: [], expiryMs: 60_000 },
    plugins: [],
    hooks: {},
    acceptancePolicy: {
      validate: (output) => {
        if (!output.ok) throw new Error('not accepted');
      },
    },
  };
}

describe('harness core', () => {
  it('enforces the mechanical tier invocation matrix and factory capability checks', () => {
    expect(mayInvoke(0, 1)).toBe(true);
    expect(mayInvoke(0, 2)).toBe(false);
    expect(mayInvoke(1, 1)).toBe(false);
    expect(mayInvoke(1, 2)).toBe(true);
    expect(mayInvoke(2, 0)).toBe(false);
    expect(() => assertInvocationHierarchy(0, 2)).toThrow('cannot invoke');
    expect(() =>
      new HarnessFactory().create({
        ...definition(1),
        authorityPolicy: { ...definition(1).authorityPolicy, allowedChildTiers: [1] },
      }),
    ).toThrow('prohibited child tier');
  });

  it('rejects Tier 2 child creation at the invocation service boundary', async () => {
    const service = new AuthorityService({ policyVersion: 'policy.v1', clock: () => now });
    const parent = invocation(service, parentInvocationId, parentAgentId, 2);
    const child = invocation(
      service,
      childInvocationId,
      childAgentId,
      2,
      'created',
      parentInvocationId,
    );
    const registration: AgentRegistration = {
      schemaVersion: 1,
      agentId: childAgentId,
      agentType: child.agentType,
      version: child.harnessVersion,
      tier: child.tier,
      supportedContracts: ['AgentInvocation.v1', 'AgentReport.v1'],
      capabilities: [],
      status: 'active',
    };
    await expect(
      new InvocationService({ state: new InMemoryStateStore(), authority: service }).create({
        parent,
        child,
        registration,
        delegatingAuthority: parent.authority,
        currentChildCount: 0,
        depth: 1,
        maxDepth: 2,
        now,
      }),
    ).rejects.toThrow('cannot invoke');
  });

  it('assembles trust-separated context with a manifest and tier-specific visibility', () => {
    const service = new AuthorityService({ policyVersion: 'policy.v1', clock: () => now });
    const tier0 = invocation(service, parentInvocationId, parentAgentId, 1);
    const assembler = new ContextAssembler();
    const tier0Context = assembler.assemble({
      invocation: tier0,
      systemPolicy: { rule: 'system' },
      workspacePolicy: { rule: 'workspace' },
      objective: 'Validate dataset',
      artifacts: [
        {
          reference: {
            schemaVersion: 1,
            tenant,
            artifactId: workflowId,
            version: 1,
            contentHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            mediaType: 'application/json',
            sizeBytes: 10,
            createdAt: now,
          },
          summary: { rows: 10 },
          content: { raw: 'should-not-be-visible' },
          source: 'artifact-store',
          reason: 'validation input',
        },
      ],
      constraints: { maxRows: 100 },
      priorChildReports: [{ child: 'done' }],
      externalContent: [{ instruction: 'untrusted' }],
      mountedWorkingFiles: [{ path: '/tmp/data.csv', content: 'raw', reason: 'fixture' }],
    });
    expect(tier0Context.sections.some((section) => section.trustClass === 'artifact_summary')).toBe(
      true,
    );
    expect(tier0Context.sections.some((section) => section.trustClass === 'artifact_content')).toBe(
      false,
    );
    expect(
      tier0Context.sections.some((section) => section.trustClass === 'mounted_working_file'),
    ).toBe(false);
    expect(
      tier0Context.sections.find((section) => section.trustClass === 'untrusted_external')?.content,
    ).toEqual({ instruction: 'untrusted' });
    expect(tier0Context.manifest).toHaveLength(tier0Context.sections.length);
    expect(tier0Context.digest).toHaveLength(64);

    const tier2 = invocation(
      service,
      childInvocationId,
      childAgentId,
      2,
      'running',
      parentInvocationId,
    );
    const tier2Context = assembler.assemble({
      invocation: tier2,
      systemPolicy: { rule: 'system' },
      workspacePolicy: { rule: 'hidden' },
      objective: 'hidden organization objective',
      exactTaskInput: { path: 'data.csv' },
      artifacts: [],
      constraints: {},
      priorChildReports: [{ hidden: true }],
      externalContent: [],
      mountedWorkingFiles: [{ path: '/tmp/data.csv', content: 'raw', reason: 'fixture' }],
    });
    expect(tier2Context.sections.some((section) => section.key === 'exact-task-input')).toBe(true);
    expect(tier2Context.sections.some((section) => section.key === 'workspace-policy')).toBe(false);
    expect(tier2Context.sections.some((section) => section.trustClass === 'child_report')).toBe(
      false,
    );
    expect(
      tier2Context.sections.some((section) => section.trustClass === 'mounted_working_file'),
    ).toBe(true);
  });

  it('persists a valid child invocation only after registration, hierarchy, authority, and budget checks', async () => {
    const service = new AuthorityService({ policyVersion: 'policy.v1', clock: () => now });
    const parent = invocation(service, parentInvocationId, parentAgentId, 1);
    const childAuthority = authority(service, childAgentId, childInvocationId, 2, []);
    const child: AgentInvocation = {
      ...invocation(service, childInvocationId, childAgentId, 2, 'created', parentInvocationId),
      authority: childAuthority,
      budget: {
        budgetId: parent.budget.budgetId,
        limit: 500,
        reserved: 0,
        consumed: 0,
        currency: 'USD',
      },
    };
    const registration: AgentRegistration = {
      schemaVersion: 1,
      agentId: childAgentId,
      agentType: 'worker',
      version: 'worker.v1',
      tier: 2,
      supportedContracts: ['AgentInvocation.v1', 'AgentReport.v1'],
      capabilities: [],
      status: 'active',
    };
    const state = new InMemoryStateStore();
    await state.transaction((transaction) =>
      transaction.invocations
        .create(parent.tenant, parent.invocationId, parent, now)
        .then(() => undefined),
    );
    const invocations = new InvocationService({
      state,
      authority: service,
    });
    const created = await invocations.create({
      parent,
      child,
      registration,
      delegatingAuthority: parent.authority,
      currentChildCount: 0,
      depth: 1,
      maxDepth: 2,
      now,
    });
    expect(created.value.invocationId).toBe(childInvocationId);
    const staleState = new InMemoryStateStore();
    await staleState.transaction((transaction) =>
      transaction.invocations
        .create(parent.tenant, parent.invocationId, parent, now)
        .then(() => undefined),
    );
    await staleState.transaction((transaction) =>
      transaction.invocations
        .update(parent.tenant, parent.invocationId, 0, { ...parent, state: 'succeeded' }, now)
        .then(() => undefined),
    );
    await expect(
      new InvocationService({ state: staleState, authority: service }).create({
        parent,
        child,
        registration,
        delegatingAuthority: parent.authority,
        currentChildCount: 0,
        depth: 1,
        maxDepth: 2,
        now,
      }),
    ).rejects.toThrow('lifecycle is stale');
    const staleBudgetState = new InMemoryStateStore();
    await staleBudgetState.transaction((transaction) =>
      transaction.invocations
        .create(parent.tenant, parent.invocationId, parent, now)
        .then(() => undefined),
    );
    await staleBudgetState.transaction((transaction) =>
      transaction.invocations
        .update(
          parent.tenant,
          parent.invocationId,
          0,
          { ...parent, budget: { ...parent.budget, reserved: 1 } },
          now,
        )
        .then(() => undefined),
    );
    await expect(
      new InvocationService({ state: staleBudgetState, authority: service }).create({
        parent,
        child,
        registration,
        delegatingAuthority: parent.authority,
        currentChildCount: 0,
        depth: 1,
        maxDepth: 2,
        now,
      }),
    ).rejects.toThrow('lifecycle is stale');
    await expect(
      invocations.create({
        parent,
        child,
        registration,
        delegatingAuthority: parent.authority,
        currentChildCount: 0,
        depth: 1,
        maxDepth: 2,
        now,
      }),
    ).rejects.toThrow('child count is stale');
    await expect(
      invocations.create({
        parent,
        child: {
          ...child,
          budget: { ...child.budget, limit: parent.budget.limit + 1 },
        },
        registration,
        delegatingAuthority: parent.authority,
        currentChildCount: 1,
        depth: 1,
        maxDepth: 2,
        now,
      }),
    ).rejects.toThrow('parent available budget');
    await expect(
      invocations.create({
        parent,
        child,
        registration,
        delegatingAuthority: authority(
          service,
          parentAgentId,
          parentInvocationId,
          1,
          ['invocation.create'],
          ['worker'],
        ),
        currentChildCount: 0,
        depth: 1,
        maxDepth: 2,
        now,
      }),
    ).rejects.toThrow('parent invocation authority');

    const allowedResource: ResourceSelector = { kind: 'dataset', id: 'allowed-dataset' };
    const deniedResource: ResourceSelector = { kind: 'dataset', id: 'denied-dataset' };
    const scopedParent = {
      ...parent,
      authority: authority(
        service,
        parentAgentId,
        parentInvocationId,
        1,
        ['invocation.create'],
        ['worker'],
        [allowedResource],
      ),
    };
    const outOfScopeChild = {
      ...child,
      authority: authority(service, childAgentId, childInvocationId, 2, [], [], [deniedResource]),
    };
    await expect(
      invocations.create({
        parent: scopedParent,
        child: outOfScopeChild,
        registration,
        delegatingAuthority: scopedParent.authority,
        currentChildCount: 0,
        depth: 1,
        maxDepth: 2,
        now,
      }),
    ).rejects.toThrow('outside the authority scope');

    const terminalParent = { ...parent, state: 'succeeded' as const };
    const terminalState = new InMemoryStateStore();
    await terminalState.transaction((transaction) =>
      transaction.invocations
        .create(terminalParent.tenant, terminalParent.invocationId, terminalParent, now)
        .then(() => undefined),
    );
    const terminalInvocations = new InvocationService({
      state: terminalState,
      authority: service,
    });
    await expect(
      terminalInvocations.create({
        parent: terminalParent,
        child,
        registration,
        delegatingAuthority: parent.authority,
        currentChildCount: 0,
        depth: 1,
        maxDepth: 2,
        now,
      }),
    ).rejects.toThrow('terminal');
  });

  it('runs a fake agent through ordered hooks and rejects invalid reports', async () => {
    const service = new AuthorityService({ policyVersion: 'policy.v1', clock: () => now });
    const invocationValue = invocation(service, parentInvocationId, parentAgentId, 1);
    const events: string[] = [];
    const harnessDefinition = definition(1);
    const registration = (name: string) => ({
      failureMode: 'fail_closed' as const,
      run: () => {
        events.push(name);
      },
    });
    harnessDefinition.hooks = {
      beforeInvocation: registration('beforeInvocation'),
      afterContextAssembly: registration('afterContextAssembly'),
      beforeModelCall: registration('beforeModelCall'),
      afterModelCall: registration('afterModelCall'),
      onArtifactProduced: registration('onArtifactProduced'),
      afterInvocation: registration('afterInvocation'),
    };
    const harness = new HarnessFactory().create(harnessDefinition);
    const executor = new HarnessExecutor();
    const report = {
      schemaVersion: 1,
      reportId: childInvocationId,
      invocationId: parentInvocationId,
      agentType: 'governance',
      tier: 1,
      harnessVersion: 'governance.v1',
      status: 'success' as const,
      output: { ok: true },
      decisions: [],
      artifacts: [],
      metrics: [],
      costs: [],
      failures: [],
      childInvocationIds: [],
      stateAssertions: [],
      producedAt: now,
    };
    const result = await executor.execute({
      harness,
      invocation: invocationValue,
      context: {
        invocation: invocationValue,
        systemPolicy: { allow: true },
        objective: 'Validate',
        artifacts: [],
        constraints: {},
        priorChildReports: [],
        externalContent: [],
        mountedWorkingFiles: [],
      },
      modelCall: async (context) => {
        expect(context.manifest.length).toBeGreaterThan(0);
        return { report };
      },
    });
    expect(result.report.output).toEqual({ ok: true });
    expect(events).toEqual([
      'beforeInvocation',
      'afterContextAssembly',
      'beforeModelCall',
      'afterModelCall',
      'afterInvocation',
    ]);
    await expect(
      executor.execute({
        harness,
        invocation: invocationValue,
        context: {
          invocation: invocationValue,
          systemPolicy: {},
          objective: 'Validate',
          artifacts: [],
          constraints: {},
          priorChildReports: [],
          externalContent: [],
          mountedWorkingFiles: [],
        },
        modelCall: async () => ({ report: { ...report, invocationId: childInvocationId } }),
      }),
    ).rejects.toThrow('does not match');

    await expect(
      executor.execute({
        harness,
        invocation: invocationValue,
        context: {
          invocation: invocationValue,
          systemPolicy: {},
          objective: 'Validate',
          artifacts: [],
          constraints: {},
          priorChildReports: [],
          externalContent: [],
          mountedWorkingFiles: [],
        },
        modelCall: async () => ({
          report: {
            ...report,
            stateAssertions: [
              {
                assertionId: childInvocationId,
                subjectType: 'invocation',
                subjectId: parentInvocationId,
                state: 'running',
                assertedAt: now,
              },
            ],
          },
        }),
      }),
    ).rejects.toThrow('State assertions require authoritative verification');
  });

  it('keeps the Cline SDK behind a fake adapter lifecycle', async () => {
    const adapter = new FakeClineAdapter({
      async *run(input) {
        yield { echoed: input };
      },
    });
    const runtime = await adapter.createRuntime(
      invocation(new AuthorityService({ clock: () => now }), parentInvocationId, parentAgentId, 1),
    );
    const values: JsonValue[] = [];
    for await (const value of runtime.executeStructured({ task: 'run' })) values.push(value);
    expect(values).toEqual([{ echoed: { task: 'run' } }]);
    const events = [];
    for await (const event of runtime.streamEvents({ task: 'run' })) events.push(event);
    expect(events.map((event) => event.type)).toEqual(['output', 'completed']);
    expect(
      adapter.normalizeError(Object.assign(new Error('blocked'), { code: 'POLICY_DENIED' })),
    ).toEqual({
      code: 'POLICY_DENIED',
      message: 'blocked',
      retryable: false,
    });
    await runtime.cancel();
    await runtime.dispose();
  });

  it('cancels a pending fake runtime stream through the adapter lifecycle', async () => {
    const adapter = new FakeClineAdapter({
      async *run(_input, signal) {
        await new Promise<void>((resolve) =>
          signal?.addEventListener('abort', () => resolve(), { once: true }),
        );
        if (!signal?.aborted) yield null;
      },
    });
    const runtime = await adapter.createRuntime(
      invocation(new AuthorityService({ clock: () => now }), parentInvocationId, parentAgentId, 1),
    );
    const iterator = runtime.streamEvents({ task: 'run' })[Symbol.asyncIterator]();
    const pending = iterator.next();
    await runtime.cancel('test cancellation');
    await expect(pending).resolves.toMatchObject({ done: true });
    await runtime.dispose();
  });

  it('exposes a provider-neutral runtime adapter with validated output and normalized failures', async () => {
    const invocationValue = invocation(
      new AuthorityService({ clock: () => now }),
      parentInvocationId,
      parentAgentId,
      1,
    );
    const harness = new HarnessFactory().create(definition(1));
    const context = {
      invocation: invocationValue,
      input: { task: 'run' },
      document: { sections: [], manifest: [], digest: 'a'.repeat(64) as HashSha256 },
    };
    const runtimeAdapter = new ClineAgentRuntimeAdapter(
      new FakeClineAdapter({
        async *run() {
          yield { ok: true };
        },
      }),
    );
    const events = [];
    for await (const event of runtimeAdapter.run(
      harness,
      context,
      { tools: [] },
      new AbortController().signal,
    ))
      events.push(event);
    expect(events.map((event) => event.type)).toEqual(['output', 'completed']);
    expect(events[0]).toMatchObject({ type: 'output', value: { ok: true } });

    const invalidAdapter = new ClineAgentRuntimeAdapter(
      new FakeClineAdapter({
        async *run() {
          yield { invalid: true };
        },
      }),
    );
    const failures = [];
    for await (const event of invalidAdapter.run(
      harness,
      context,
      { tools: [] },
      new AbortController().signal,
    ))
      failures.push(event);
    expect(failures).toEqual([
      {
        type: 'failed',
        error: expect.objectContaining({ code: 'HARNESS_OUTPUT_INVALID', retryable: false }),
      },
    ]);
  });
});
