import { describe, expect, it } from 'vitest';
import { InMemoryEnterpriseControlPlane } from '@agentic-platform/backends';
import { newSortableId, type Actor, type TenantRef } from '@agentic-platform/runtime-contracts';
import { handleLocalApiRequest, type LocalApiOptions } from '../src/index.js';

const now = '2026-08-07T00:00:00.000Z';

function buildApi(): { readonly api: LocalApiOptions; readonly actor: Actor } {
  const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
  const actor: Actor = { actorId: newSortableId(), type: 'human', displayName: 'Enterprise owner' };
  const enterprise = new InMemoryEnterpriseControlPlane({ clock: () => now });
  return {
    api: {
      orchestrator: { submit: async () => ({}) as never },
      tenant,
      localSession: { tenant, actor },
      enterprise,
      clock: () => now,
    },
    actor,
  };
}

describe('local-api Phase 10 enterprise control-plane routes', () => {
  it('exposes profile, identities, policy, legal hold, export, support, and procurement evidence', async () => {
    const { api } = buildApi();
    const created = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/enterprise/control-plane/profile',
        body: {
          name: 'Government tenant',
          deploymentMode: 'private_kubernetes',
          allowedDeploymentModes: ['private_kubernetes', 'on_premise', 'customer_cloud'],
          complianceProfile: 'government',
          residency: {
            homeRegion: 'us-gov-west-1',
            allowedRegions: ['us-gov-west-1'],
            blockedRegions: ['us-east-1'],
            noCrossRegionReplication: true,
            allowedDataClasses: ['public', 'internal', 'confidential', 'restricted'],
            requireCustomerManagedKey: true,
            retentionDays: 30,
            policyVersion: 'gov-retention.v1',
          },
          customerManagedKey: {
            keyId: 'gov-cmk-1',
            provider: 'government_hsm',
            keyUri: 'hsm://customer/gov-cmk-1',
            region: 'us-gov-west-1',
            rotationVersion: 'v1',
          },
        },
      },
      api,
    );
    expect(created).toMatchObject({ statusCode: 201, body: { complianceProfile: 'government' } });

    const serviceAccount = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/enterprise/control-plane/service-accounts',
        body: { name: 'automation', scopes: ['run.*'], roles: ['operator'] },
      },
      api,
    );
    expect(serviceAccount).toMatchObject({
      statusCode: 201,
      body: { accessToken: expect.any(String) },
    });

    const accountId = (serviceAccount.body as { serviceAccount: { accountId: string } })
      .serviceAccount.accountId;
    const rotated = await handleLocalApiRequest(
      {
        method: 'POST',
        path: `/v1/enterprise/control-plane/service-accounts/${accountId}/rotate`,
        body: undefined,
      },
      api,
    );
    expect(rotated.statusCode).toBe(200);

    const evaluate = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/enterprise/control-plane/policy/evaluate',
        body: {
          principal: { principalId: api.localSession?.actor.actorId, principalType: 'human' },
          action: 'data.export',
          resourceKind: 'tenant',
          resourceId: api.tenant.workspaceId,
          context: {
            region: 'us-gov-west-1',
            dataClassification: 'restricted',
            environment: 'production',
          },
        },
      },
      api,
    );
    expect(evaluate).toMatchObject({ statusCode: 200, body: { outcome: 'allowed' } });

    const hold = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/enterprise/control-plane/legal-holds',
        body: { matterReference: 'CASE-10-API', reason: 'Preserve evidence' },
      },
      api,
    );
    expect(hold.statusCode).toBe(201);
    const deletion = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/enterprise/control-plane/deletions',
        body: { reason: 'Close tenant', batchSize: 10 },
      },
      api,
    );
    expect(deletion).toMatchObject({ statusCode: 202, body: { state: 'blocked_legal_hold' } });

    const exported = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/enterprise/control-plane/exports',
        body: { records: { authoritative: { accessToken: 'Bearer api-secret' } } },
      },
      api,
    );
    expect(exported).toMatchObject({ statusCode: 201, body: { redacted: true } });
    expect(JSON.stringify(exported.body)).not.toContain('api-secret');

    const bundle = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/enterprise/control-plane/support-bundles',
        body: { diagnostics: { password: 'do-not-export', status: 'healthy' } },
      },
      api,
    );
    expect(bundle).toMatchObject({ statusCode: 201, body: { redacted: true } });
    expect(JSON.stringify(bundle.body)).not.toContain('do-not-export');

    const commitments = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/enterprise/control-plane/government/commitments',
        body: {
          serviceHours: '24x7',
          supportResponseMinutes: 30,
          incidentNoticeHours: 1,
          recoveryPointObjectiveMinutes: 15,
          recoveryTimeObjectiveMinutes: 60,
          dataResidencyStatement: 'Data remains in the approved government region.',
        },
      },
      api,
    );
    expect(commitments).toMatchObject({ statusCode: 200, body: { serviceHours: '24x7' } });
    const evidence = await handleLocalApiRequest(
      { method: 'GET', path: '/v1/enterprise/control-plane/procurement/evidence', body: undefined },
      api,
    );
    expect(evidence).toMatchObject({ statusCode: 200, body: { controls: expect.any(Array) } });
  });
});
