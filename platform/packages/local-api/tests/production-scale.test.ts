import { describe, expect, it } from 'vitest';
import { createLocalDatasetRegistry } from '@agentic-platform/agent-registry';
import { AdvancedAgentRouter } from '@agentic-platform/agent-registry';
import { InMemoryServingEndpointManager } from '@agentic-platform/backends';
import { ScopedBudgetLedger } from '@agentic-platform/budget';
import { InMemoryCollaborationService } from '@agentic-platform/runtime-domain';
import { InMemoryDisasterRecoveryService } from '@agentic-platform/state';
import {
  newSortableId,
  type Actor,
  type Id,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import { LocalDatasetWorkflowOrchestrator } from '@agentic-platform/orchestrator';
import { InMemoryStateStore } from '@agentic-platform/state';
import { handleLocalApiRequest, type LocalApiOptions } from '../src/index.js';

const now = '2026-08-06T00:00:00.000Z';
const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
const actor: Actor = { actorId: newSortableId(), type: 'human', displayName: 'P3 tester' };

function apiOptions(): {
  readonly options: LocalApiOptions;
  readonly serving: InMemoryServingEndpointManager;
  readonly budgets: ScopedBudgetLedger;
  readonly recovery: InMemoryDisasterRecoveryService;
} {
  const state = new InMemoryStateStore();
  const orchestrator = new LocalDatasetWorkflowOrchestrator({
    state,
    agents: createLocalDatasetRegistry(),
    clock: () => now,
  });
  const serving = new InMemoryServingEndpointManager({ clock: () => now });
  const budgets = new ScopedBudgetLedger({ clock: () => now });
  const recovery = new InMemoryDisasterRecoveryService({ clock: () => now });
  const agents = new AdvancedAgentRouter({ clock: () => now });
  agents.register({
    agentId: newSortableId(),
    agentType: 'profile-agent',
    version: 'v1',
    tier: 1,
    status: 'active',
    taskShapes: ['dataset.profile'],
    capabilities: ['schema.profile'],
    dataClasses: ['internal'],
    requiredModelProviders: ['deterministic'],
    maxConcurrent: 2,
    rollout: { stage: 'general', percentage: 100, cohortSalt: 'p3-test' },
    createdAt: now,
  });
  const collaboration = new InMemoryCollaborationService(() => now);
  return {
    options: {
      orchestrator,
      tenant,
      localSession: { tenant, actor },
      productionScale: { serving, budgets, agents, recovery, collaboration },
      clock: () => now,
    },
    serving,
    budgets,
    recovery,
  };
}

describe('production-scale API surface', () => {
  it('exposes serving, budgets, routing, recovery, and collaboration as tenant-scoped operations', async () => {
    const { options } = apiOptions();
    const endpointResponse = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/serving/endpoints',
        body: { name: 'profile', modelName: 'profile-model' },
      },
      options,
    );
    expect(endpointResponse.statusCode).toBe(201);
    const endpointId = (endpointResponse.body as { endpointId: Id }).endpointId;

    const deploymentResponse = await handleLocalApiRequest(
      {
        method: 'POST',
        path: `/v1/serving/endpoints/${endpointId}/deployments`,
        body: { modelVersionId: newSortableId(), manifest: { digest: 'model-digest' } },
      },
      options,
    );
    const deploymentId = (deploymentResponse.body as { deploymentId: Id }).deploymentId;
    for (const action of ['provision', 'smokePass'] as const) {
      await handleLocalApiRequest(
        {
          method: 'POST',
          path: `/v1/serving/deployments/${deploymentId}/actions`,
          body: { action },
        },
        options,
      );
    }
    const approval = {
      approved: true,
      actionDigest: 'digest',
      commitDigest: 'digest',
      expiresAt: '2026-08-06T01:00:00.000Z',
      now,
    };
    const canary = await handleLocalApiRequest(
      {
        method: 'POST',
        path: `/v1/serving/deployments/${deploymentId}/actions`,
        body: { action: 'startCanary', approval },
      },
      options,
    );
    expect(canary).toMatchObject({
      statusCode: 200,
      body: { state: 'canary', trafficPercent: 10 },
    });

    const budgetId = newSortableId();
    const budget = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/scoped-budgets',
        body: {
          budgetId,
          scope: { kind: 'organization', id: newSortableId() },
          currency: 'USD',
          hardLimitMinor: 100,
          softLimitMinor: 80,
          categoryHardLimits: {
            llm: 100,
            compute: 100,
            storage: 100,
            external_api: 100,
            retry: 100,
          },
          policyVersion: 'p3-v1',
        },
      },
      options,
    );
    expect(budget.statusCode).toBe(201);
    const invocationId = newSortableId();
    const reservation = await handleLocalApiRequest(
      {
        method: 'POST',
        path: `/v1/scoped-budgets/${budgetId}/reservations`,
        body: {
          invocationId,
          category: 'llm',
          amount: { amountMinor: 50, currency: 'USD' },
        },
      },
      options,
    );
    const reservationId = (reservation.body as { reservationId: Id }).reservationId;
    await handleLocalApiRequest(
      {
        method: 'POST',
        path: `/v1/scoped-reservations/${reservationId}/reconcile`,
        body: { actual: { amountMinor: 30, currency: 'USD' } },
      },
      options,
    );
    const budgetSnapshot = await handleLocalApiRequest(
      { method: 'GET', path: `/v1/scoped-budgets/${budgetId}`, body: undefined },
      options,
    );
    expect(budgetSnapshot).toMatchObject({
      statusCode: 200,
      body: { consumedMinor: 30, reservedMinor: 0 },
    });

    const route = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/agent-definitions/resolve',
        body: {
          taskShape: 'dataset.profile',
          tier: 1,
          cohortKey: 'project-1',
          requiredCapabilities: ['schema.profile'],
          dataClass: 'internal',
          modelProvider: 'deterministic',
        },
      },
      options,
    );
    expect(route).toMatchObject({ statusCode: 200, body: { selected: { version: 'v1' } } });

    const backup = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/recovery/backups',
        body: {
          snapshot: { project: 'p3' },
          schemaVersion: '1',
          eventCursor: 0,
          encryptionKeyId: 'kms-key-1',
          retentionUntil: '2026-09-01T00:00:00.000Z',
        },
      },
      options,
    );
    const backupBody = backup.body as { manifest: { backupId: Id; contentDigest: string } };
    const restored = await handleLocalApiRequest(
      {
        method: 'POST',
        path: `/v1/recovery/backups/${backupBody.manifest.backupId}/restore`,
        body: { approvalDigest: backupBody.manifest.contentDigest },
      },
      options,
    );
    expect(restored).toMatchObject({ statusCode: 200, body: { restored: true } });

    const documentId = newSortableId();
    await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/collaboration/documents',
        body: { resourceType: 'notebook', resourceId: documentId, initialValue: { cells: [] } },
      },
      options,
    );
    const write = await handleLocalApiRequest(
      {
        method: 'PUT',
        path: `/v1/collaboration/documents/${documentId}`,
        body: { expectedVersion: 0, value: { cells: ['one'] } },
      },
      options,
    );
    expect(write).toMatchObject({ statusCode: 200, body: { status: 'applied' } });
    const conflict = await handleLocalApiRequest(
      {
        method: 'PUT',
        path: `/v1/collaboration/documents/${documentId}`,
        body: { expectedVersion: 0, value: { cells: ['stale'] } },
      },
      options,
    );
    expect(conflict).toMatchObject({ statusCode: 409, body: { status: 'conflict' } });
  });
});
