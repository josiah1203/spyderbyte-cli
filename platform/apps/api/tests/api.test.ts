import { describe, expect, it } from 'vitest';
import { createMissingLicenseGate } from '@agentic-platform/license';
import {
  errorBody,
  formatSubscriptionFrame,
  handleLocalApiRequest,
  subscriptionRequestFromPath,
} from '../src/index.js';
import { FixedWindowRateLimiter } from '../src/rate-limit.js';
import { ContentAddressedArtifactRegistry } from '@agentic-platform/artifact-registry';
import { createLocalDatasetRegistry } from '@agentic-platform/agent-registry';
import { ApprovalService, AuthorityService, InMemoryApprovalStore } from '@agentic-platform/policy';
import {
  makeMoney,
  newSortableId,
  runtimeError,
  type Actor,
  type Id,
  type JsonValue,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import {
  LocalDatasetWorkflowOrchestrator,
  LocalProductCommandService,
} from '@agentic-platform/orchestrator';
import { InMemoryStateStore } from '@agentic-platform/state';

const tenant: TenantRef = {
  tenantId: '018f0c4b-4e90-7abc-8def-0123456789ab' as Id,
  workspaceId: '018f0c4b-4e91-7abc-8def-0123456789ab' as Id,
};
const now = '2026-08-02T00:00:00.000Z';
const actor: Actor = { actorId: '018f0c4b-4e92-7abc-8def-0123456789ab' as Id, type: 'human' };

describe('local HTTP API', () => {
  const state = new InMemoryStateStore();
  const artifacts = new ContentAddressedArtifactRegistry(state);
  const orchestrator = new LocalDatasetWorkflowOrchestrator({
    state,
    artifacts,
    agents: createLocalDatasetRegistry(),
    authority: new AuthorityService({ clock: () => now }),
    clock: () => now,
  });

  it('normalizes SSE subscription cursors, topic lists, and buffer bounds', () => {
    expect(
      subscriptionRequestFromPath(
        '/v1/subscriptions/events?afterCursor=7&topics=workflow,artifact&topic=approval&maxEvents=25',
        tenant,
      ),
    ).toMatchObject({
      tenant,
      afterCursor: 7,
      topics: ['approval', 'workflow', 'artifact'],
      maxEvents: 25,
    });
  });

  it('exposes Spyderbyte license status and blocks effectful routes when unlicensed', async () => {
    const license = createMissingLicenseGate({ clock: () => now });
    const options = { orchestrator, tenant, license };
    await expect(
      handleLocalApiRequest(
        { method: 'GET', path: '/v1/license/status', body: undefined },
        options,
      ),
    ).resolves.toMatchObject({ statusCode: 200, body: { status: 'missing', reason: 'missing' } });
    await expect(
      handleLocalApiRequest(
        {
          method: 'POST',
          path: `/v1/artifacts/${newSortableId()}/versions`,
          body: undefined,
        },
        options,
      ),
    ).rejects.toThrow('valid Spyderbyte license is required');
  });

  it('accepts a configured signed-license import and rechecks the gate', async () => {
    const license = createMissingLicenseGate({ clock: () => now });
    let imported: unknown;
    const candidate = {
      schemaVersion: 1,
      algorithm: 'Ed25519',
      keyId: 'test',
      payload: {},
      signature: 'x',
    };
    await expect(
      handleLocalApiRequest(
        { method: 'POST', path: '/v1/license/import', body: candidate },
        {
          orchestrator,
          tenant,
          license,
          licenseImport: (value) => {
            imported = value;
          },
        },
      ),
    ).resolves.toMatchObject({ statusCode: 200, body: { status: 'imported' } });
    expect(imported).toEqual(candidate);
  });

  it('persists project commands and returns normalized acknowledgements without a workflow license', async () => {
    const projectState = new InMemoryStateStore();
    const productCommands = new LocalProductCommandService(projectState);
    const correlationId = newSortableId();
    const response = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/commands',
        body: {
          schemaVersion: 1,
          commandId: newSortableId(),
          commandType: 'CreateProject',
          tenant,
          actor,
          issuedAt: now,
          idempotencyKey: 'api-project-create',
          correlationId,
          payload: { name: 'Live project', objective: 'Verify projection-backed state' },
        },
      },
      { orchestrator, tenant, productCommands },
    );
    expect(response).toMatchObject({ statusCode: 202 });
    expect(response.body).toMatchObject({
      accepted: true,
      correlationId,
      result: { name: 'Live project', status: 'active' },
    });
    const projectId = (response.body as { result: { projectId: string } }).result.projectId;
    const stored = await projectState.transaction((transaction) =>
      transaction.projects.get(tenant, projectId as Id),
    );
    expect(stored?.value).toMatchObject({ projectId, name: 'Live project', state: 'active' });
  });

  it('stages bounded local artifact content before immutable publication', async () => {
    const response = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/artifacts/uploads',
        body: { content: 'id,value\n1,10\n', mediaType: 'text/csv' },
      },
      { orchestrator, tenant, artifacts },
    );
    expect(response.statusCode).toBe(201);
    expect(response.body).toMatchObject({
      tenant,
      mediaType: 'text/csv',
      sizeBytes: 14,
    });
    expect((response.body as { stagedUploadId: string }).stagedUploadId).toBeDefined();
    expect((response.body as { contentHash: string }).contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('exports and previews a checksummed workspace archive through the local API', async () => {
    const workspaceOperations = {
      rootPath: '/tmp/agentic-api-workspace',
      manifest: { name: 'API workspace' } as JsonValue,
      exportArchive: async (archivePath: string) =>
        ({ archiveFormat: 'agentic.workspace.archive.v1', archivePath }) as unknown as JsonValue,
      previewRestore: async (archivePath: string, destinationRoot: string) =>
        ({
          archiveFormat: 'agentic.workspace.archive.v1',
          archivePath,
          destinationRoot,
          destinationExists: false,
        }) as unknown as JsonValue,
      importArchive: async (archivePath: string, destinationRoot: string) =>
        ({ archivePath, workspaceRoot: destinationRoot }) as unknown as JsonValue,
    };
    const options = { orchestrator, tenant, workspace: workspaceOperations };
    await expect(
      handleLocalApiRequest({ method: 'GET', path: '/v1/workspace', body: undefined }, options),
    ).resolves.toMatchObject({
      statusCode: 200,
      body: { archiveFormat: 'agentic.workspace.archive.v1' },
    });
    const exportResponse = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/workspace/export',
        body: { destinationPath: '/tmp/backup.agentic' },
      },
      options,
    );
    expect(exportResponse.statusCode).toBe(201);
    expect(exportResponse.body).toMatchObject({ archiveFormat: 'agentic.workspace.archive.v1' });
    const backupResponse = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/workspace/backup',
        body: { destinationPath: '/tmp/backup-snapshot.agentic' },
      },
      options,
    );
    expect(backupResponse.statusCode).toBe(201);
    expect(backupResponse.body).toMatchObject({ archiveFormat: 'agentic.workspace.archive.v1' });
    const previewResponse = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/workspace/restore-preview',
        body: { archivePath: '/tmp/backup.agentic', destinationRoot: '/tmp/restored' },
      },
      options,
    );
    expect(previewResponse.statusCode).toBe(200);
    expect(previewResponse.body).toMatchObject({ destinationExists: false });
  });

  it('rejects malformed commands through the shared runtime schema validator', async () => {
    await expect(
      handleLocalApiRequest(
        { method: 'POST', path: '/v1/commands', body: { tenant } },
        { orchestrator, tenant },
      ),
    ).rejects.toThrow('RuntimeCommand validation');
  });

  it('rejects commands that try to cross the API session tenant boundary', async () => {
    await expect(
      handleLocalApiRequest(
        {
          method: 'POST',
          path: '/v1/commands',
          body: {
            schemaVersion: 1,
            commandId: newSortableId(),
            commandType: 'ValidateDataset',
            tenant: { tenantId: newSortableId(), workspaceId: newSortableId() },
            actor,
            issuedAt: now,
            idempotencyKey: 'cross-tenant-api',
            correlationId: newSortableId(),
            payload: {},
          },
        },
        { orchestrator, tenant },
      ),
    ).rejects.toThrow('session tenant');
  });

  it('accepts a command and serves workflow/event queries', async () => {
    const staged = await artifacts.stageUpload(tenant, 'id,value\n1,10\n', 'text/csv', now);
    const sourceId = newSortableId();
    await artifacts.publish({
      tenant,
      artifactId: sourceId,
      stagedUploadId: staged.stagedUploadId,
      mediaType: 'text/csv',
      createdBy: actor,
      now,
    });
    const reviewedWorkflowId = newSortableId();
    const reviewedPlanResponse = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/commands/plan',
        body: {
          schemaVersion: 1,
          commandId: newSortableId(),
          commandType: 'ValidateDataset',
          tenant,
          actor,
          issuedAt: now,
          idempotencyKey: `api-plan-${reviewedWorkflowId}`,
          correlationId: reviewedWorkflowId,
          payload: {
            sourceArtifactId: sourceId,
            sourceArtifactVersion: 1,
            intendedUse: 'api plan review smoke test',
            requestedAccessScopes: ['dataset.read'],
            retentionDays: 30,
            requiredColumns: ['id', 'value'],
            expectedTypes: { id: 'number' },
            leakageThreshold: 0,
          },
        },
      },
      { orchestrator, tenant },
    );
    expect(reviewedPlanResponse.statusCode).toBe(200);
    expect(reviewedPlanResponse.body).toMatchObject({
      workflowId: reviewedWorkflowId,
      planVersion: 1,
    });
    const reviewedWorkflow = await handleLocalApiRequest(
      { method: 'GET', path: `/v1/workflows/${reviewedWorkflowId}`, body: undefined },
      { orchestrator, tenant },
    );
    expect(reviewedWorkflow.body).toMatchObject({ value: { state: 'planning' } });
    const reviewedRunResponse = await handleLocalApiRequest(
      { method: 'POST', path: `/v1/workflows/${reviewedWorkflowId}/run`, body: {} },
      { orchestrator, tenant },
    );
    expect(reviewedRunResponse.statusCode).toBe(202);
    expect(reviewedRunResponse.body).toMatchObject({
      workflowId: reviewedWorkflowId,
      status: 'completed',
    });
    const workflowId = newSortableId();
    const response = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/commands',
        body: {
          schemaVersion: 1,
          commandId: newSortableId(),
          commandType: 'ValidateDataset',
          tenant,
          actor,
          issuedAt: now,
          idempotencyKey: `api-${workflowId}`,
          correlationId: workflowId,
          payload: {
            sourceArtifactId: sourceId,
            sourceArtifactVersion: 1,
            intendedUse: 'api smoke test',
            requestedAccessScopes: ['dataset.read'],
            retentionDays: 30,
            requiredColumns: ['id', 'value'],
            expectedTypes: { id: 'number' },
            leakageThreshold: 0,
          },
        },
      },
      { orchestrator, tenant },
    );
    expect(response.statusCode).toBe(202);
    const body = response.body as { status: string; workflowId: string };
    expect(body.status).toBe('completed');
    const workflowResponse = await handleLocalApiRequest(
      { method: 'GET', path: `/v1/workflows/${body.workflowId}`, body: undefined },
      { orchestrator, tenant },
    );
    expect(workflowResponse.statusCode).toBe(200);
    const eventsResponse = await handleLocalApiRequest(
      { method: 'GET', path: `/v1/workflows/${body.workflowId}/events`, body: undefined },
      { orchestrator, tenant },
    );
    expect(eventsResponse.statusCode).toBe(200);
    expect(eventsResponse.body as unknown[]).toEqual(
      expect.arrayContaining([expect.objectContaining({ eventName: 'workflow.planned.v1' })]),
    );
    const planResponse = await handleLocalApiRequest(
      { method: 'GET', path: `/v1/workflows/${body.workflowId}/plan`, body: undefined },
      { orchestrator, tenant },
    );
    expect(planResponse.statusCode).toBe(200);
    const invocationsResponse = await handleLocalApiRequest(
      { method: 'GET', path: `/v1/workflows/${body.workflowId}/invocations`, body: undefined },
      { orchestrator, tenant },
    );
    expect(invocationsResponse.statusCode).toBe(200);
    const invocations = invocationsResponse.body as Array<{
      value: { invocationId: string };
    }>;
    expect(invocations.length).toBeGreaterThan(0);
    const invocationResponse = await handleLocalApiRequest(
      {
        method: 'GET',
        path: `/v1/invocations/${invocations[0]?.value.invocationId}`,
        body: undefined,
      },
      { orchestrator, tenant },
    );
    expect(invocationResponse.statusCode).toBe(200);
    const currentArtifactResponse = await handleLocalApiRequest(
      { method: 'GET', path: `/v1/artifacts/${sourceId}`, body: undefined },
      { orchestrator, tenant },
    );
    expect(currentArtifactResponse.statusCode).toBe(200);
    const versionsResponse = await handleLocalApiRequest(
      { method: 'GET', path: `/v1/artifacts/${sourceId}/versions`, body: undefined },
      { orchestrator, tenant },
    );
    expect(versionsResponse.statusCode).toBe(200);
    expect(versionsResponse.body as unknown[]).toHaveLength(1);
    const lineageResponse = await handleLocalApiRequest(
      { method: 'GET', path: `/v1/artifacts/${sourceId}/lineage`, body: undefined },
      { orchestrator, tenant },
    );
    expect(lineageResponse.statusCode).toBe(200);
    const agentsResponse = await handleLocalApiRequest(
      { method: 'GET', path: '/v1/agents', body: undefined },
      { orchestrator, tenant },
    );
    expect(agentsResponse.statusCode).toBe(200);
    expect(agentsResponse.body as unknown[]).toHaveLength(2);
  });

  it('rejects malformed resource identifiers before querying state', async () => {
    await expect(
      handleLocalApiRequest(
        { method: 'GET', path: '/v1/workflows/not-a-uuid', body: undefined },
        { orchestrator, tenant },
      ),
    ).rejects.toThrow('UUIDv7');
  });

  it('publishes staged artifact versions through the tenant-scoped API boundary', async () => {
    const staged = await artifacts.stageUpload(tenant, 'id,value\n2,20\n', 'text/csv', now);
    const artifactId = newSortableId();
    const response = await handleLocalApiRequest(
      {
        method: 'POST',
        path: `/v1/artifacts/${artifactId}/versions`,
        body: {
          stagedUploadId: staged.stagedUploadId,
          mediaType: 'text/csv',
          createdBy: actor,
          now,
        },
      },
      { orchestrator, tenant, artifacts },
    );
    expect(response.statusCode).toBe(201);
    expect(
      (response.body as { record: { reference: { artifactId: string; version: number } } }).record
        .reference,
    ).toMatchObject({ artifactId, version: 1 });
  });

  it('reports unconfigured approval, budget, and audit providers explicitly', async () => {
    const approval = await handleLocalApiRequest(
      { method: 'GET', path: '/v1/approvals', body: undefined },
      { orchestrator, tenant },
    );
    const budget = await handleLocalApiRequest(
      { method: 'GET', path: `/v1/budgets/${newSortableId()}`, body: undefined },
      { orchestrator, tenant },
    );
    const audit = await handleLocalApiRequest(
      { method: 'GET', path: '/v1/audit', body: undefined },
      { orchestrator, tenant },
    );
    expect(approval).toEqual({ statusCode: 501, body: { error: 'approvals_not_configured' } });
    expect(budget).toEqual({ statusCode: 501, body: { error: 'budget_backend_not_configured' } });
    expect(audit).toEqual({ statusCode: 501, body: { error: 'audit_backend_not_configured' } });
  });

  it('supports bounded cursor pagination and tenant-scoped projection reads', async () => {
    const firstPage = await handleLocalApiRequest(
      { method: 'GET', path: '/v1/agents?limit=1', body: undefined },
      { orchestrator, tenant },
    );
    expect(firstPage).toMatchObject({ statusCode: 200 });
    expect(firstPage.body).toMatchObject({ hasMore: true, nextCursor: '1' });
    expect((firstPage.body as { items: unknown[] }).items).toHaveLength(1);

    const secondPage = await handleLocalApiRequest(
      { method: 'GET', path: '/v1/agents?limit=1&cursor=1', body: undefined },
      { orchestrator, tenant },
    );
    expect(secondPage).toMatchObject({ statusCode: 200, body: { hasMore: false } });
    expect((secondPage.body as { items: unknown[] }).items).toHaveLength(1);

    const projection = await handleLocalApiRequest(
      { method: 'GET', path: '/v1/projections/workflow-summary', body: undefined },
      {
        orchestrator,
        tenant,
        projections: {
          read: (requestedTenant, projectionName) => ({
            projectionName,
            tenant: requestedTenant,
            state: { workflows: {} },
            cursor: 0,
            streamHead: 0,
            lag: 0,
            stale: false,
          }),
        },
      },
    );
    expect(projection).toMatchObject({
      statusCode: 200,
      body: { projectionName: 'workflow-summary', tenant },
    });
    await expect(
      handleLocalApiRequest(
        { method: 'GET', path: '/v1/projections/not-a-projection', body: undefined },
        {
          orchestrator,
          tenant,
          projections: { read: () => ({}) },
        },
      ),
    ).rejects.toThrow('Unknown projection name');
  });

  it('enforces a tenant-bound local rate limit and resets the window', async () => {
    let nowMs = 0;
    const limiter = new FixedWindowRateLimiter({
      limit: 1,
      windowMs: 1_000,
      clock: () => nowMs,
    });
    const limitedOptions = { orchestrator, tenant, rateLimiter: limiter };
    expect(
      await handleLocalApiRequest(
        { method: 'GET', path: '/v1/agents', body: undefined },
        limitedOptions,
      ),
    ).toMatchObject({ statusCode: 200 });
    expect(
      await handleLocalApiRequest(
        { method: 'GET', path: '/v1/agents', body: undefined },
        limitedOptions,
      ),
    ).toMatchObject({ statusCode: 429, body: { error: 'rate_limit_exceeded' } });
    nowMs = 1_000;
    expect(
      await handleLocalApiRequest(
        { method: 'GET', path: '/v1/agents', body: undefined },
        limitedOptions,
      ),
    ).toMatchObject({ statusCode: 200 });
  });

  it('lists and decides approvals through the injected tenant-bound approval service', async () => {
    const approvalAuthority = new AuthorityService({
      policyVersion: 'policy.v1',
      clock: () => now,
    });
    const requester: Actor = { actorId: newSortableId(), type: 'agent' };
    const approver: Actor = { actorId: newSortableId(), type: 'human' };
    const workflowId = newSortableId();
    const invocationId = newSortableId();
    const issue = (subject: Actor, permittedActions: string[]) =>
      approvalAuthority.issue({
        tenant,
        workflowId,
        invocationId,
        issuer: subject,
        subjectAgentId: subject.actorId,
        tier: 1,
        harnessVersion: 'approval.v1',
        permittedActions,
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
    const requesterAuthority = issue(requester, ['approval.request']);
    const approverAuthority = issue(approver, ['approval.decide', 'approval.revoke']);
    const approvals = new ApprovalService({
      authority: approvalAuthority,
      store: new InMemoryApprovalStore(),
      clock: () => now,
    });
    const pending = approvals.request({
      action: {
        actionType: 'fixture.action',
        tenant,
        workflowId,
        invocationId,
        actor: requester,
        artifactVersions: [],
        resources: [],
        credentialScopes: [],
        estimatedCost: makeMoney(0, 'USD'),
        policyVersion: 'policy.v1',
        revocationEpoch: requesterAuthority.revocationEpoch,
      },
      authority: requesterAuthority,
      expiresAt: '2026-08-02T00:30:00.000Z',
      now,
    });
    const apiOptions = {
      orchestrator,
      tenant,
      approvals: {
        service: approvals,
        actor: approver,
        authorityFor: ({ approval, action, now: decisionNow }) => {
          expect(approval.request.approvalId).toBe(pending.request.approvalId);
          expect(action).toBe('decide');
          expect(decisionNow).toBe(now);
          return approverAuthority;
        },
        clock: () => now,
      },
    };
    const listed = await handleLocalApiRequest(
      { method: 'GET', path: '/v1/approvals', body: undefined },
      apiOptions,
    );
    expect(listed.statusCode).toBe(200);
    expect(listed.body as unknown[]).toHaveLength(1);
    const decided = await handleLocalApiRequest(
      {
        method: 'POST',
        path: `/v1/approvals/${pending.request.approvalId}/approve`,
        body: { reason: 'fixture approved' },
      },
      apiOptions,
    );
    expect(decided.statusCode).toBe(202);
    expect((decided.body as { request: { state: string } }).request.state).toBe('approved');
  });

  it('serves cursor-based event subscriptions and a typed cancellation command', async () => {
    const staged = await artifacts.stageUpload(tenant, 'id,value\n1,10\n', 'text/csv', now);
    const sourceId = newSortableId();
    await artifacts.publish({
      tenant,
      artifactId: sourceId,
      stagedUploadId: staged.stagedUploadId,
      mediaType: 'text/csv',
      createdBy: actor,
      now,
    });
    const workflowId = newSortableId();
    const result = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/commands',
        body: {
          schemaVersion: 1,
          commandId: newSortableId(),
          commandType: 'ValidateDataset',
          tenant,
          actor,
          issuedAt: now,
          idempotencyKey: `cancel-${workflowId}`,
          correlationId: workflowId,
          payload: {
            sourceArtifactId: sourceId,
            sourceArtifactVersion: 1,
            intendedUse: 'api cancellation',
            requestedAccessScopes: ['dataset.read'],
            retentionDays: 30,
          },
        },
      },
      { orchestrator, tenant, state },
    );
    const workflow = result.body as { workflowId: string };
    const events = await handleLocalApiRequest(
      {
        method: 'GET',
        path: '/v1/subscriptions/events?afterCursor=0&topic=workflow',
        body: undefined,
      },
      { orchestrator, tenant, state },
    );
    expect(events.statusCode).toBe(200);
    expect((events.body as { events: unknown[] }).events.length).toBeGreaterThan(0);
    const cancel = await handleLocalApiRequest(
      {
        method: 'POST',
        path: `/v1/workflows/${workflow.workflowId}/cancel`,
        body: { reason: 'fixture' },
      },
      { orchestrator, tenant, state },
    );
    expect(cancel.statusCode).toBe(202);
  });

  it('keeps server error envelopes and SSE frames aligned with the browser transport', () => {
    expect(errorBody(runtimeError('CONCURRENCY_STALE_VERSION', 'expected 1, actual 2'))).toEqual({
      error: 'The resource changed; refresh and retry.',
      code: 'CONCURRENCY_STALE_VERSION',
    });
    const frame = formatSubscriptionFrame({
      cursor: 7,
      events: [],
      gapDetected: false,
      refreshRequired: false,
    });
    expect(frame).toContain('id: 7');
    expect(frame).toContain('event: runtime.events');
    expect(frame).toContain('"cursor":7');
  });
});
