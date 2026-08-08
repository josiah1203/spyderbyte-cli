import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  handleLocalApiRequest,
  type ApiSession,
  type LocalApiOptions,
} from '@agentic-platform/local-api';
import { InMemoryGovernanceService } from '@agentic-platform/policy';
import {
  makeMoney,
  newSortableId,
  type Actor,
  type Id,
  type RuntimeCommand,
  type TenantRef,
  type WorkspaceContext,
} from '@agentic-platform/runtime-contracts';
import { createLocalDaemon, createSqliteLocalDaemon, type LocalDaemon } from '../src/index.js';

const now = '2026-08-07T00:00:00.000Z';

function session(tenant: TenantRef, context: WorkspaceContext, actor: Actor): ApiSession {
  return {
    schemaVersion: 1,
    sessionId: newSortableId(),
    actor,
    tenant,
    workspaces: [tenant],
    workspaceContext: context,
    workspaceContexts: [context],
    scopes: ['local'],
    issuedAt: now,
    expiresAt: '2026-08-08T00:00:00.000Z',
  };
}

function api(
  daemon: LocalDaemon,
  tenant: TenantRef,
  context: WorkspaceContext,
  actor: Actor,
): LocalApiOptions {
  return {
    orchestrator: daemon.orchestrator,
    state: daemon.state,
    artifacts: daemon.artifacts,
    tenant,
    localSession: session(tenant, context, actor),
    workspaceContext: context,
    providerRuntime: daemon.providerRuntime,
    conversation: daemon.conversation,
    projections: {
      read: (scopedTenant, projectionName) => daemon.projections.read(scopedTenant, projectionName),
    },
    productCommands: daemon.productCommands,
    productionScale: {
      governance: daemon.governance,
      providerRuntime: daemon.providerRuntime,
    },
    license: daemon.license,
    clock: () => now,
  };
}

async function createProject(daemon: LocalDaemon, tenant: TenantRef, actor: Actor): Promise<Id> {
  const command: RuntimeCommand = {
    schemaVersion: 1,
    commandId: newSortableId(),
    commandType: 'CreateProject',
    tenant,
    actor,
    issuedAt: now,
    idempotencyKey: `create-project-${newSortableId()}`,
    correlationId: newSortableId(),
    payload: { name: 'Shared project', objective: 'Govern one shared Run path' },
  };
  const response = await handleLocalApiRequest(
    { method: 'POST', path: '/v1/commands', body: command },
    api(daemon, tenant, daemon.workspaceContext as WorkspaceContext, actor),
  );
  const projectId = (response.body as { projectId?: unknown }).projectId;
  if (typeof projectId !== 'string') throw new Error('Project command did not return a project id');
  return projectId as Id;
}

describe('Phase 9 shared organization workspace', () => {
  it('shares projects, conversation history, artifacts, governed Runs, usage, and audit across members', async () => {
    const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
    const organizationId = newSortableId();
    const context: WorkspaceContext = { ...tenant, mode: 'organization_local', organizationId };
    const owner: Actor = { actorId: newSortableId(), type: 'human', displayName: 'Owner' };
    const operator: Actor = { actorId: newSortableId(), type: 'human', displayName: 'Operator' };
    const outsider: Actor = { actorId: newSortableId(), type: 'human', displayName: 'Outsider' };
    const governance = new InMemoryGovernanceService(() => now);
    governance.createOrganization({
      tenant,
      organizationId,
      name: 'Shared Acme',
      actor: owner,
      now,
    });
    governance.upsertMembership({
      tenant,
      organizationId,
      actorId: operator.actorId,
      role: 'operator',
      scopes: [{ organizationId, workspaceId: tenant.workspaceId }],
      changedBy: owner,
      now,
    });
    governance.putPolicy({
      tenant,
      organizationId,
      version: 'governance.phase9',
      scope: { organizationId },
      allowedInterfaces: ['cli'],
      allowedProviders: ['deterministic'],
      allowedRuntimes: ['deterministic'],
      changedBy: owner,
      now,
    });
    governance.setBudget({
      tenant,
      organizationId,
      scope: { organizationId },
      currency: 'USD',
      hardLimitMinor: 100,
      softLimitMinor: 50,
      changedBy: owner,
      now,
    });
    const disallowedProvider = governance.evaluate({
      tenant,
      organizationId,
      workspaceId: tenant.workspaceId,
      actor: operator,
      action: 'run.execute',
      target: [{ kind: 'workspace', id: tenant.workspaceId }],
      interfaceName: 'cli',
      providerId: 'unapproved-provider',
      runtimeName: 'unapproved-runtime',
      now,
    });
    expect(disallowedProvider).toMatchObject({
      outcome: 'blocked',
      reasonCodes: expect.arrayContaining(['provider_not_allowed', 'runtime_not_allowed']),
    });

    const daemon = createLocalDaemon({
      clock: () => now,
      workspaceMode: 'organization_local',
      workspaceContext: context,
      governance,
    });
    try {
      const overview = await handleLocalApiRequest(
        {
          method: 'GET',
          path: `/v1/governance/organizations/${organizationId}/overview`,
          body: undefined,
        },
        api(daemon, tenant, context, owner),
      );
      expect(overview.body).toMatchObject({
        membership: { actorId: owner.actorId, role: 'owner' },
        allowedProviders: ['deterministic'],
        allowedRuntimes: ['deterministic'],
      });
      const outsiderOrganizations = await handleLocalApiRequest(
        { method: 'GET', path: '/v1/governance/organizations', body: undefined },
        api(daemon, tenant, context, outsider),
      );
      expect(outsiderOrganizations.body).toEqual({ organizations: [] });

      const projectId = await createProject(daemon, tenant, owner);
      const sharedProjects = await handleLocalApiRequest(
        { method: 'GET', path: '/v1/projections/projects', body: undefined },
        api(daemon, tenant, context, operator),
      );
      expect(sharedProjects.body).toMatchObject({
        state: {
          projects: { [projectId]: { name: 'Shared project', status: 'active' } },
        },
      });

      const staged = await daemon.artifacts.stageUpload(
        tenant,
        '{"shared":true}',
        'application/json',
        now,
      );
      await daemon.artifacts.publish({
        tenant,
        artifactId: newSortableId(),
        stagedUploadId: staged.stagedUploadId,
        mediaType: 'application/json',
        createdBy: operator,
        now,
      });
      const sharedArtifacts = await handleLocalApiRequest(
        { method: 'GET', path: '/v1/artifacts', body: undefined },
        api(daemon, tenant, context, owner),
      );
      expect((sharedArtifacts.body as { artifacts: readonly unknown[] }).artifacts).toHaveLength(1);

      const accepted = await daemon.conversation.send({
        tenant,
        projectId,
        actor: operator,
        sourceInterface: 'cli',
        text: 'Summarize the shared project context.',
      });
      let snapshot = await daemon.conversation.readSession(tenant, accepted.sessionId as Id);
      for (
        let attempt = 0;
        attempt < 200 && snapshot.responses.at(-1)?.state === 'accepted';
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        snapshot = await daemon.conversation.readSession(tenant, accepted.sessionId as Id);
      }
      expect(snapshot.responses.at(-1)?.state).toBe('completed');

      const sharedHistory = await handleLocalApiRequest(
        { method: 'GET', path: `/v1/projects/${projectId}/conversation`, body: undefined },
        api(daemon, tenant, context, owner),
      );
      expect(sharedHistory.body).toMatchObject({
        projectId,
        messages: expect.arrayContaining([
          expect.objectContaining({ role: 'user', text: 'Summarize the shared project context.' }),
        ]),
      });

      await expect(
        handleLocalApiRequest(
          { method: 'GET', path: '/v1/providers', body: undefined },
          api(daemon, tenant, context, outsider),
        ),
      ).rejects.toMatchObject({ code: 'AUTHORITY_SCOPE_VIOLATION' });
      await expect(
        handleLocalApiRequest(
          {
            method: 'POST',
            path: '/v1/providers',
            body: { providerType: 'deterministic', displayName: 'Operator cannot configure' },
          },
          api(daemon, tenant, context, operator),
        ),
      ).rejects.toMatchObject({ code: 'POLICY_DENIED' });

      const usage = governance.usageSummary({
        tenant,
        organizationId,
        periodStart: '2026-08-07T00:00:00.000Z',
        periodEnd: '2026-08-08T00:00:00.000Z',
      });
      expect(usage.byActor[operator.actorId]).toBe(0);
      expect(usage.byProject[projectId]).toBe(0);
      expect(usage.matchingBudget?.remainingMinor).toBe(100);
      expect(
        governance
          .auditRecords(tenant, organizationId)
          .some((record) => record.action === 'run.execute' && record.runId === accepted.runId),
      ).toBe(true);
      expect(governance.verifyAudit(tenant, organizationId)).toBe(true);

      await expect(
        handleLocalApiRequest(
          { method: 'GET', path: '/v1/artifacts', body: undefined },
          api(daemon, tenant, context, outsider),
        ),
      ).rejects.toMatchObject({ code: 'AUTHORITY_SCOPE_VIOLATION' });
      await expect(
        daemon.conversation.send({
          tenant,
          projectId,
          actor: outsider,
          sourceInterface: 'cli',
          text: 'This must be denied.',
        }),
      ).rejects.toMatchObject({ code: 'AUTHORITY_SCOPE_VIOLATION' });
    } finally {
      daemon.close();
    }
  });

  it('persists organization membership, policy, budgets, usage, and audit across daemon restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-phase9-governance-'));
    const databasePath = join(root, 'state.db');
    const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
    const organizationId = newSortableId();
    const context: WorkspaceContext = { ...tenant, mode: 'organization_local', organizationId };
    const owner: Actor = { actorId: newSortableId(), type: 'human', displayName: 'Durable owner' };
    let first: LocalDaemon | undefined;
    let second: LocalDaemon | undefined;
    try {
      first = createSqliteLocalDaemon(databasePath, {
        clock: () => now,
        workspaceMode: 'organization_local',
        workspaceContext: context,
      });
      first.governance.createOrganization({
        tenant,
        organizationId,
        name: 'Durable Acme',
        actor: owner,
        now,
      });
      first.governance.setBudget({
        tenant,
        organizationId,
        scope: { organizationId },
        currency: 'USD',
        hardLimitMinor: 500,
        softLimitMinor: 250,
        changedBy: owner,
        now,
      });
      const decision = first.governance.evaluate({
        tenant,
        organizationId,
        workspaceId: tenant.workspaceId,
        actor: owner,
        action: 'workspace.read',
        target: [{ kind: 'workspace', id: tenant.workspaceId }],
        interfaceName: 'cli',
        runId: newSortableId(),
        now,
      });
      first.governance.commit({
        tenant,
        organizationId,
        workspaceId: tenant.workspaceId,
        actor: owner,
        action: 'workspace.read',
        target: [{ kind: 'workspace', id: tenant.workspaceId }],
        interfaceName: 'cli',
        runId: newSortableId(),
        now,
        before: { secret: 'must-not-persist-in-plain-audit' },
        after: { state: 'read' },
      });
      first.governance.recordUsage({
        tenant,
        organizationId,
        workspaceId: tenant.workspaceId,
        actorId: owner.actorId,
        category: 'llm',
        amount: makeMoney(25, 'USD'),
        interfaceName: 'cli',
        occurredAt: now,
      });
      expect(decision.outcome).toBe('allowed');
      first.close();
      first = undefined;

      second = createSqliteLocalDaemon(databasePath, {
        clock: () => now,
        workspaceMode: 'organization_local',
        workspaceContext: context,
      });
      expect(second.governance.listOrganizations(tenant)).toHaveLength(1);
      expect(second.governance.listMemberships(tenant, organizationId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ actorId: owner.actorId, role: 'owner' }),
        ]),
      );
      expect(second.governance.listBudgets(tenant, organizationId)).toEqual(
        expect.arrayContaining([expect.objectContaining({ hardLimitMinor: 500 })]),
      );
      expect(
        second.governance.usageSummary({
          tenant,
          organizationId,
          periodStart: '2026-08-07T00:00:00.000Z',
          periodEnd: '2026-08-08T00:00:00.000Z',
        }).consumedMinor,
      ).toBe(25);
      expect(second.governance.auditRecords(tenant, organizationId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: 'workspace.read', decision: 'executed' }),
        ]),
      );
      expect(second.governance.verifyAudit(tenant, organizationId)).toBe(true);
    } finally {
      second?.close();
      first?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
