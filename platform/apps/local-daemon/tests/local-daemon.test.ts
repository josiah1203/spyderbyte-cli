import { mkdtemp, rm } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLicenseGate, createSignedEntitlement } from '@agentic-platform/license';
import { handleLocalApiRequest } from '@agentic-platform/local-api';
import { createProviderRuntime, type ProviderTransport } from '@agentic-platform/provider-runtime';
import { makeMoney, newSortableId, type Id } from '@agentic-platform/runtime-contracts';
import { createLocalDaemon, createSqliteLocalDaemon, runFixtureDataset } from '../src/index.js';

const tenant = {
  tenantId: '018f0c4b-4e80-7abc-8def-0123456789ab' as never,
  workspaceId: '018f0c4b-4e81-7abc-8def-0123456789ab' as never,
};
const now = '2026-08-02T00:00:00.000Z';
const keyPair = generateKeyPairSync('ed25519');
const license = createLicenseGate({
  entitlement: createSignedEntitlement(
    {
      schemaVersion: 1,
      licenseId: 'local-daemon-test',
      product: 'agentic-ml-data-platform',
      edition: 'local',
      features: ['local.workflow'],
      issuedAt: '2026-08-01T00:00:00.000Z',
      expiresAt: '2026-09-01T00:00:00.000Z',
    },
    { keyId: 'test', privateKey: keyPair.privateKey },
  ),
  publicKeys: { test: keyPair.publicKey },
  clock: () => now,
});

async function approvePendingWorkflow(
  daemon: ReturnType<typeof createLocalDaemon>,
  workflowId: Id,
) {
  const approval = daemon.approvals
    .list(tenant)
    .find((record) => record.action.workflowId === workflowId);
  if (approval === undefined) throw new Error('Pending workflow approval was not persisted');
  const approver = { actorId: newSortableId(), type: 'human' as const, displayName: 'Reviewer' };
  const authority = daemon.authority.issue({
    tenant,
    workflowId: approval.action.workflowId,
    invocationId: approval.action.invocationId,
    issuer: approver,
    subjectAgentId: approver.actorId,
    tier: 0,
    harnessVersion: 'local-daemon.test.v1',
    permittedActions: ['approval.decide'],
    capabilities: [],
    resourceScopes: approval.request.resources,
    allowedArtifactReads: approval.action.artifactVersions,
    allowedArtifactWrites: [],
    allowedChildAgentTypes: [],
    maxChildCount: 0,
    toolOperations: [],
    issuedAt: now,
    expiresAt: '2026-08-02T01:00:00.000Z',
  });
  daemon.approvals.decide(
    tenant,
    approval.request.approvalId,
    'approved',
    approver,
    authority,
    now,
    'Reviewed locally',
  );
  return daemon.orchestrator.runPlanned(tenant, workflowId);
}

describe('local daemon smoke path', () => {
  it('persists project conversation messages and completes agent assistance', async () => {
    const daemon = createLocalDaemon({ clock: () => now });
    const projectId = newSortableId();
    await daemon.state.transaction(async (transaction) => {
      await transaction.projects.create(
        tenant,
        projectId,
        {
          schemaVersion: 1,
          projectId,
          tenant,
          name: 'Churn analysis',
          objective: 'Profile customer churn data',
          state: 'active',
          createdAt: now,
          updatedAt: now,
        },
        now,
      );
    });
    const actor = { actorId: newSortableId(), type: 'human' as const, displayName: 'Analyst' };
    const initial = await daemon.conversation.read(tenant, projectId);
    expect(initial.messages[0]).toMatchObject({
      projectId,
      role: 'user',
      text: 'Profile customer churn data',
    });
    const accepted = await daemon.conversation.send({
      tenant,
      projectId,
      actor,
      text: 'What should I inspect first?',
    });
    expect(accepted).toMatchObject({ projectId, accepted: true });
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const snapshot = await daemon.conversation.read(tenant, projectId);
      if (!snapshot.generating) break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const completed = await daemon.conversation.read(tenant, projectId);
    expect(completed.messages.some((message) => message.role === 'assistant')).toBe(true);
    expect(completed.generating).toBe(false);
    const run = await daemon.conversation.readRun(tenant, accepted.runId);
    expect(run.run).toMatchObject({ runId: accepted.runId, state: 'succeeded', projectId });
    expect(run.attempts[0]).toMatchObject({ state: 'succeeded', runId: accepted.runId });
    expect(run.run.cost).toEqual(makeMoney(0, 'USD'));
    expect(run.attempts[0]?.resourceUsage).toMatchObject({
      inputTokens: 0,
      outputTokens: 1,
      totalTokens: 1,
    });
    expect(run.logs.some((line) => line.level === 'output')).toBe(true);

    const apiOptions = {
      orchestrator: daemon.orchestrator,
      tenant,
      providerRuntime: daemon.providerRuntime,
      conversation: daemon.conversation,
      license: daemon.license,
      clock: () => now,
    };
    const providers = await handleLocalApiRequest(
      { method: 'GET', path: '/v1/providers', body: undefined },
      apiOptions,
    );
    expect(providers.statusCode).toBe(200);
    expect(providers.body).toMatchObject({
      providers: [expect.objectContaining({ providerId: 'deterministic' })],
      credentials: [],
    });
    const models = await handleLocalApiRequest(
      { method: 'GET', path: '/v1/models', body: undefined },
      apiOptions,
    );
    expect(models.statusCode).toBe(200);
    expect((models.body as { models: unknown[] }).models.length).toBeGreaterThan(0);
    const diagnostics = await handleLocalApiRequest(
      { method: 'GET', path: '/v1/diagnostics', body: undefined },
      apiOptions,
    );
    expect(diagnostics.statusCode).toBe(200);
    expect(JSON.stringify(diagnostics.body)).not.toContain('secret');
    const supportBundle = await handleLocalApiRequest(
      { method: 'POST', path: '/v1/diagnostics/support-bundle', body: {} },
      apiOptions,
    );
    expect(supportBundle.body).toMatchObject({
      bundleType: 'spyderbyte-support',
      diagnostics: { schemaVersion: 1 },
    });
    const runDetail = await handleLocalApiRequest(
      { method: 'GET', path: `/v1/runs/${accepted.runId}`, body: undefined },
      apiOptions,
    );
    expect(runDetail.statusCode).toBe(200);
    expect(runDetail.body).toMatchObject({ run: { runId: accepted.runId, state: 'succeeded' } });
    const logs = await handleLocalApiRequest(
      { method: 'GET', path: `/v1/runs/${accepted.runId}/logs`, body: undefined },
      apiOptions,
    );
    expect(logs.statusCode).toBe(200);
    expect(logs.body).toMatchObject({ runId: accepted.runId });
  });

  it('treats the client message id as an idempotency key while a run is active', async () => {
    const daemon = createLocalDaemon({ clock: () => now });
    const projectId = newSortableId();
    await daemon.state.transaction(async (transaction) => {
      await transaction.projects.create(
        tenant,
        projectId,
        {
          schemaVersion: 1,
          projectId,
          tenant,
          name: 'Idempotent conversation',
          objective: 'Exercise duplicate submission handling',
          state: 'active',
          createdAt: now,
          updatedAt: now,
        },
        now,
      );
    });
    const actor = { actorId: newSortableId(), type: 'human' as const, displayName: 'Analyst' };
    const clientMessageId = newSortableId();
    const first = await daemon.conversation.send({
      tenant,
      projectId,
      actor,
      text: 'Submit once',
      clientMessageId,
    });
    const duplicate = await daemon.conversation.send({
      tenant,
      projectId,
      actor,
      text: 'Submit once',
      clientMessageId,
    });
    expect(duplicate).toMatchObject({
      accepted: true,
      runId: first.runId,
      userMessageId: clientMessageId,
    });
  });

  it('fails closed before staging work when no license is configured', async () => {
    const daemon = createLocalDaemon({ clock: () => now });
    await expect(runFixtureDataset(daemon, tenant, 'id,value\n1,10\n', { now })).rejects.toThrow(
      'valid Spyderbyte license is required',
    );
  });

  it('persists provider failures and retries a terminal model run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentic-conversation-provider-'));
    let fail = true;
    const transport = {
      async complete() {
        if (fail) throw new Error('provider unavailable');
        return {
          output: 'recovered',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cost: makeMoney(0, 'USD') },
        };
      },
      async *stream() {
        if (fail) throw new Error('provider unavailable');
        yield { type: 'delta' as const, value: 'recovered' };
        yield { type: 'completed' as const, output: 'recovered' };
      },
    };
    try {
      const providerRuntime = createProviderRuntime({
        rootPath: root,
        clock: () => now,
        useKeychain: false,
        deterministicTransport: transport,
      });
      const daemon = createLocalDaemon({ clock: () => now, providerRuntime });
      const projectId = newSortableId();
      await daemon.state.transaction(async (transaction) => {
        await transaction.projects.create(
          tenant,
          projectId,
          {
            schemaVersion: 1,
            projectId,
            tenant,
            name: 'Retryable conversation',
            objective: 'Exercise model failure recovery',
            state: 'active',
            createdAt: now,
            updatedAt: now,
          },
          now,
        );
      });
      const actor = { actorId: newSortableId(), type: 'human' as const, displayName: 'Analyst' };
      const first = await daemon.conversation.send({
        tenant,
        projectId,
        actor,
        text: 'Retry this request',
      });
      let firstDetail = await daemon.conversation.readRun(tenant, first.runId);
      const terminalStates = new Set(['succeeded', 'failed', 'cancelled']);
      for (
        let attempt = 0;
        attempt < 1000 && !terminalStates.has(firstDetail.run.state);
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        firstDetail = await daemon.conversation.readRun(tenant, first.runId);
      }
      expect(firstDetail.run.state).toBe('failed');
      expect(firstDetail.logs.some((line) => line.level === 'error')).toBe(true);

      fail = false;
      const retry = await daemon.conversation.retryRun(tenant, first.runId, actor);
      let retryDetail = await daemon.conversation.readRun(tenant, retry.runId);
      for (
        let attempt = 0;
        attempt < 1000 && !terminalStates.has(retryDetail.run.state);
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        retryDetail = await daemon.conversation.readRun(tenant, retry.runId);
      }
      expect(retryDetail.run.state).toBe('succeeded');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('cancels an active model run and persists the terminal cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentic-conversation-cancel-'));
    let streamStarted = false;
    const transport: ProviderTransport = {
      async complete() {
        throw new Error('streaming transport expected');
      },
      async *stream(_metadata, request) {
        streamStarted = true;
        await new Promise<never>((_resolve, reject) => {
          if (request.signal?.aborted) {
            reject(new Error('cancelled'));
            return;
          }
          request.signal?.addEventListener('abort', () => reject(new Error('cancelled')), {
            once: true,
          });
        });
        yield { type: 'completed' as const, output: '' };
      },
    };
    try {
      const providerRuntime = createProviderRuntime({
        rootPath: root,
        clock: () => now,
        useKeychain: false,
        deterministicTransport: transport,
      });
      const daemon = createLocalDaemon({ clock: () => now, providerRuntime });
      const projectId = newSortableId();
      await daemon.state.transaction(async (transaction) => {
        await transaction.projects.create(
          tenant,
          projectId,
          {
            schemaVersion: 1,
            projectId,
            tenant,
            name: 'Cancellable conversation',
            objective: 'Exercise run cancellation',
            state: 'active',
            createdAt: now,
            updatedAt: now,
          },
          now,
        );
      });
      const actor = { actorId: newSortableId(), type: 'human' as const, displayName: 'Analyst' };
      const accepted = await daemon.conversation.send({
        tenant,
        projectId,
        actor,
        text: 'Cancel this request',
      });
      for (let attempt = 0; attempt < 1000 && !streamStarted; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      expect(streamStarted).toBe(true);
      await expect(
        daemon.conversation.cancel(tenant, projectId, 'operator stopped it'),
      ).resolves.toMatchObject({
        cancelled: true,
      });
      let detail = await daemon.conversation.readRun(tenant, accepted.runId);
      for (let attempt = 0; attempt < 1000 && detail.run.state !== 'cancelled'; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        detail = await daemon.conversation.readRun(tenant, accepted.runId);
      }
      expect(detail.run.state).toBe('cancelled');
      expect(detail.attempts[0]).toMatchObject({ state: 'cancelled' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('runs a fixture dataset through the local command path', async () => {
    const daemon = createLocalDaemon({
      clock: () => now,
      license,
      workspaceMode: 'organization_local',
    });
    const pending = await runFixtureDataset(daemon, tenant, 'id,value\n1,10\n2,20\n', { now });

    expect(pending.status).toBe('awaiting_approval');
    const result = await approvePendingWorkflow(daemon, pending.workflowId);
    expect(result.status).toBe('completed');
    expect(result.validatedDatasetArtifact).toBeDefined();
  });

  it('defaults to personal-local execution without an organization approval record', async () => {
    const daemon = createLocalDaemon({ clock: () => now, license });
    const result = await runFixtureDataset(daemon, tenant, 'id,value\n1,10\n2,20\n', { now });

    expect(result.status).toBe('completed');
    expect(daemon.approvals.list(tenant)).toHaveLength(0);
  });

  it('binds Spyderbyte approval decisions to the reviewed workflow authority', async () => {
    const daemon = createLocalDaemon({
      clock: () => now,
      license,
      workspaceMode: 'organization_local',
    });
    const pending = await runFixtureDataset(daemon, tenant, 'id,value\n1,10\n', { now });
    const approval = daemon.approvals
      .list(tenant)
      .find((record) => record.action.workflowId === pending.workflowId);
    if (approval === undefined) throw new Error('Pending workflow approval is missing');
    const approver = { actorId: newSortableId(), type: 'human' as const, displayName: 'Reviewer' };
    const apiOptions = {
      orchestrator: daemon.orchestrator,
      tenant,
      license,
      approvals: {
        service: daemon.approvals,
        actor: approver,
        authorityFor: ({ approval: requested, actor, action, now: decisionNow }) =>
          daemon.authority.issue({
            tenant,
            workflowId: requested.action.workflowId,
            invocationId: requested.action.invocationId,
            issuer: actor,
            subjectAgentId: actor.actorId,
            tier: 0,
            harnessVersion: 'local-daemon-api.test.v1',
            permittedActions: [action === 'revoke' ? 'approval.revoke' : 'approval.decide'],
            capabilities: [],
            resourceScopes: requested.request.resources,
            allowedArtifactReads: requested.action.artifactVersions,
            allowedArtifactWrites: [],
            allowedChildAgentTypes: [],
            maxChildCount: 0,
            toolOperations: [],
            issuedAt: decisionNow,
            expiresAt: '2026-08-02T01:00:00.000Z',
          }),
        clock: () => now,
      },
    };
    const decided = await handleLocalApiRequest(
      {
        method: 'POST',
        path: `/v1/approvals/${approval.request.approvalId}/approve`,
        body: { reason: 'Reviewed in the Spyderbyte UI' },
      },
      apiOptions,
    );
    expect(decided.statusCode).toBe(202);
    const result = await handleLocalApiRequest(
      { method: 'POST', path: `/v1/workflows/${pending.workflowId}/run`, body: {} },
      apiOptions,
    );
    expect(result.statusCode).toBe(202);
    expect(result.body).toMatchObject({ workflowId: pending.workflowId, status: 'completed' });
  });

  it('reopens workflow metadata and CAS artifacts from SQLite plus filesystem storage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentic-local-daemon-'));
    const databasePath = join(root, 'state.sqlite');
    const artifactRoot = join(root, 'objects');
    try {
      const first = createSqliteLocalDaemon(databasePath, {
        clock: () => now,
        artifactRoot,
        license,
        workspaceMode: 'organization_local',
      });
      const pending = await runFixtureDataset(first, tenant, 'id,value\n1,10\n', { now });
      expect(pending.status).toBe('awaiting_approval');
      first.close();

      const reopened = createSqliteLocalDaemon(databasePath, {
        clock: () => now,
        artifactRoot,
        license,
        workspaceMode: 'organization_local',
      });
      expect(reopened.approvals.list(tenant)).toHaveLength(1);
      const result = await approvePendingWorkflow(reopened, pending.workflowId);
      expect(result.status).toBe('completed');
      const validatedArtifact = result.validatedDatasetArtifact;
      if (!validatedArtifact) throw new Error('Validated dataset artifact was not published');
      const workflow = await reopened.orchestrator.getWorkflow(tenant, result.workflowId);
      expect(workflow?.value.state).toBe('completed');
      const projection = await reopened.projections.read(tenant, 'workflow-summary');
      expect(projection).toMatchObject({
        projectionName: 'workflow-summary',
        state: { workflows: { [result.workflowId]: { state: 'completed' } } },
      });
      expect(
        await reopened.orchestrator.getArtifact(
          tenant,
          validatedArtifact.artifactId,
          validatedArtifact.version,
        ),
      ).toMatchObject({ state: 'valid' });
      reopened.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
