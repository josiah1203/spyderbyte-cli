import { describe, expect, it } from 'vitest';
import {
  HostedExecutionAdapter,
  InMemoryEnterpriseIdentityService,
  InMemoryEnterpriseSecretManager,
  type HostedExecutionClient,
  type HostedExecutionObservationV1,
} from '@agentic-platform/backends';
import { InMemoryGovernanceService } from '@agentic-platform/policy';
import {
  newSortableId,
  type Actor,
  type Id,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import { InMemoryDisasterRecoveryService } from '@agentic-platform/state';
import { handleLocalApiRequest, type LocalApiOptions } from '../src/index.js';

const now = '2026-08-07T00:00:00.000Z';
const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
const actor: Actor = { actorId: newSortableId(), type: 'human', displayName: 'Admin' };

function options(): {
  readonly api: LocalApiOptions;
  readonly secrets: InMemoryEnterpriseSecretManager;
} {
  const secrets = new InMemoryEnterpriseSecretManager(() => now);
  const governance = new InMemoryGovernanceService(() => now);
  const identity = new InMemoryEnterpriseIdentityService({ clock: () => now });
  const recovery = new InMemoryDisasterRecoveryService({ clock: () => now });
  let state: 'running' | 'succeeded' = 'running';
  const client: HostedExecutionClient = {
    submit: async () => ({ externalExecutionId: 'cloud-execution-1', state: 'running' }),
    observe: async (handle): Promise<HostedExecutionObservationV1> => ({
      handle,
      state,
      observedAt: now,
      attempt: 1,
      stdout: 'ok',
      stderr: '',
    }),
    terminate: async () => {
      state = 'succeeded';
    },
  };
  const hostedExecution = new HostedExecutionAdapter(client, { clock: () => now });
  const api: LocalApiOptions = {
    orchestrator: {
      submit: async () => ({}) as never,
    },
    tenant,
    localSession: { tenant, actor },
    productionScale: { governance, identity, secrets, hostedExecution, recovery },
    clock: () => now,
  };
  return { api, secrets };
}

describe('phase 8 governance and enterprise API', () => {
  it('joins governance roles, policy decisions, budgets, usage, and audit evidence', async () => {
    const { api } = options();
    const created = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/governance/organizations',
        body: { name: 'Acme Platform' },
      },
      api,
    );
    expect(created.statusCode).toBe(201);
    const organizationId = (created.body as { organizationId: Id }).organizationId;

    const member = await handleLocalApiRequest(
      {
        method: 'POST',
        path: `/v1/governance/organizations/${organizationId}/members`,
        body: {
          actorId: newSortableId(),
          role: 'operator',
          scopes: [{ workspaceId: tenant.workspaceId }],
        },
      },
      api,
    );
    expect(member).toMatchObject({ statusCode: 201, body: { role: 'operator' } });

    await handleLocalApiRequest(
      {
        method: 'POST',
        path: `/v1/governance/organizations/${organizationId}/policies`,
        body: {
          version: 'governance.v2',
          scope: {},
          approvalActions: ['deployment.execute'],
          allowedDataClasses: ['internal'],
        },
      },
      api,
    );
    await handleLocalApiRequest(
      {
        method: 'POST',
        path: `/v1/governance/organizations/${organizationId}/budgets`,
        body: { scope: {}, currency: 'USD', hardLimitMinor: 100, softLimitMinor: 50 },
      },
      api,
    );

    const evaluation = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/governance/evaluate',
        body: {
          organizationId,
          action: 'deployment.execute',
          target: [{ kind: 'deployment', id: 'deployment-1' }],
          dataClassification: 'internal',
          interfaceName: 'browser',
          estimatedCost: { amountMinor: 10, currency: 'USD' },
        },
      },
      api,
    );
    expect(evaluation).toMatchObject({ statusCode: 200, body: { outcome: 'approval_required' } });
    const digest = (evaluation.body as { inputDigest: string }).inputDigest;
    await expect(
      handleLocalApiRequest(
        {
          method: 'POST',
          path: '/v1/governance/commit',
          body: {
            organizationId,
            action: 'deployment.execute',
            target: [{ kind: 'deployment', id: 'deployment-1' }],
            dataClassification: 'internal',
            interfaceName: 'browser',
            estimatedCost: { amountMinor: 10, currency: 'USD' },
          },
        },
        api,
      ),
    ).rejects.toThrow('approval');
    const committed = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/governance/commit',
        body: {
          organizationId,
          action: 'deployment.execute',
          target: [{ kind: 'deployment', id: 'deployment-1' }],
          dataClassification: 'internal',
          interfaceName: 'browser',
          estimatedCost: { amountMinor: 10, currency: 'USD' },
          approvalContext: { approved: true, actionDigest: digest },
          before: { token: 'redact-me' },
          after: { state: 'active' },
          usage: { category: 'compute', amount: { amountMinor: 10, currency: 'USD' } },
        },
      },
      api,
    );
    expect(committed).toMatchObject({ statusCode: 200, body: { audit: { decision: 'executed' } } });

    const usage = await handleLocalApiRequest(
      {
        method: 'GET',
        path: `/v1/governance/organizations/${organizationId}/usage`,
        body: undefined,
      },
      api,
    );
    expect(usage).toMatchObject({ statusCode: 200, body: { consumedMinor: 10 } });
    const audit = await handleLocalApiRequest(
      {
        method: 'GET',
        path: `/v1/governance/organizations/${organizationId}/audit`,
        body: undefined,
      },
      api,
    );
    expect(audit).toMatchObject({
      statusCode: 200,
      body: { records: [{ decision: 'approval_required' }, { decision: 'executed' }] },
    });
    const verified = await handleLocalApiRequest(
      {
        method: 'GET',
        path: `/v1/governance/organizations/${organizationId}/audit/verify`,
        body: undefined,
      },
      api,
    );
    expect(verified).toMatchObject({ statusCode: 200, body: { valid: true } });
  });

  it('exposes SSO/SCIM, brokered secret handles, and customer-cloud runners without raw secrets', async () => {
    const { api, secrets } = options();
    secrets.putSecret({ tenant, secretName: 'provider-key', value: 'secret-value', now });
    const provider = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/enterprise/sso/providers',
        body: {
          displayName: 'Acme SSO',
          protocol: 'oidc',
          issuerUrl: 'https://idp.example.com',
          clientId: 'spyderbyte',
          redirectUris: ['https://app.example.com/callback'],
        },
      },
      api,
    );
    const providerId = (provider.body as { providerId: Id }).providerId;
    const user = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/enterprise/scim/users',
        body: {
          externalId: 'scim-1',
          userName: 'ada',
          email: 'ada@example.com',
          groups: ['ml-platform'],
        },
      },
      api,
    );
    expect(user.statusCode).toBe(200);
    const login = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/enterprise/sso/login/start',
        body: { providerId, redirectUri: 'https://app.example.com/callback' },
      },
      api,
    );
    const session = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/enterprise/sso/login/complete',
        body: {
          providerId,
          state: (login.body as { state: string }).state,
          claims: {
            subject: 'subject-1',
            email: 'ada@example.com',
            issuer: 'https://idp.example.com/',
            issuedAt: now,
            expiresAt: '2026-08-07T01:00:00.000Z',
          },
        },
      },
      api,
    );
    expect(session).toMatchObject({
      statusCode: 200,
      body: { actor: { displayName: 'ada@example.com' } },
    });

    const handle = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/enterprise/secrets/handles',
        body: { secretName: 'provider-key', operation: 'model.invoke', ttlMs: 60_000 },
      },
      api,
    );
    expect(handle).toMatchObject({ statusCode: 201, body: { secretName: 'provider-key' } });
    expect(JSON.stringify(handle.body)).not.toContain('secret-value');

    const runner = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/enterprise/runners',
        body: {
          kind: 'customer_cloud',
          region: 'us-central',
          capabilities: ['python'],
        },
      },
      api,
    );
    const targetId = (runner.body as { targetId: Id }).targetId;
    const execution = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/enterprise/executions',
        body: {
          targetId,
          command: 'python',
          args: [],
          resources: { cpuMillicores: 100 },
          sandbox: {
            networkAllowlist: ['pypi.org'],
            maxOutputBytes: 1_024,
            maxWallTimeMs: 1_000,
            maxProcessCount: 1,
          },
        },
      },
      api,
    );
    const executionId = (execution.body as { executionId: Id }).executionId;
    expect(execution.statusCode).toBe(202);
    const listed = await handleLocalApiRequest(
      { method: 'GET', path: '/v1/enterprise/executions', body: undefined },
      api,
    );
    expect(listed).toMatchObject({ statusCode: 200, body: { executions: [{ executionId }] } });
  });

  it('keeps retention and enterprise surfaces tenant-scoped and hidden from personal-local mode', async () => {
    const { api } = options();
    const backup = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/recovery/backups',
        body: {
          snapshot: { state: 'safe' },
          schemaVersion: '1',
          eventCursor: 1,
          encryptionKeyId: 'kms-key',
          retentionUntil: '2026-08-01T00:00:00.000Z',
        },
      },
      api,
    );
    const backupId = (backup.body as { manifest: { backupId: Id } }).manifest.backupId;
    const retention = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/recovery/retention/evaluate',
        body: {
          backupId,
          policyId: newSortableId(),
          version: 'retention.v1',
          retentionDays: 30,
          legalHold: false,
        },
      },
      api,
    );
    expect(retention).toMatchObject({ statusCode: 200, body: { decision: 'eligible' } });
    const personal = { ...api, workspaceContext: { ...tenant, mode: 'personal_local' as const } };
    await expect(
      handleLocalApiRequest(
        { method: 'GET', path: '/v1/enterprise/sso/providers', body: undefined },
        personal,
      ),
    ).resolves.toMatchObject({
      statusCode: 404,
      body: { error: 'organization_surface_not_available' },
    });
  });
});
