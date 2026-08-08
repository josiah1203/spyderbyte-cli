import { describe, expect, it } from 'vitest';
import {
  HostedExecutionAdapter,
  InMemoryEnterpriseIdentityService,
  InMemoryEnterpriseSecretManager,
  InMemoryServingEndpointManager,
  type HostedExecutionClient,
  type HostedExecutionObservationV1,
  type HostedExecutionTargetV1,
} from '../src/index.js';
import { newSortableId, type TenantRef } from '@agentic-platform/runtime-contracts';

const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
const otherTenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
const now = '2026-08-06T00:00:00.000Z';

function approval() {
  return {
    approved: true,
    actionDigest: 'digest',
    commitDigest: 'digest',
    expiresAt: '2026-08-06T01:00:00.000Z',
    now,
  } as const;
}

describe('P3 production and enterprise foundations', () => {
  it('manages endpoint revisions and automatically rolls back an unhealthy canary', () => {
    const manager = new InMemoryServingEndpointManager({
      clock: () => now,
      healthFailureThreshold: 2,
    });
    const endpoint = manager.createEndpoint({
      tenant,
      name: 'fraud-score',
      modelName: 'fraud-model',
      now,
    });
    const revision = manager.requestDeployment({
      tenant,
      endpointId: endpoint.endpointId,
      modelVersionId: newSortableId(),
      manifest: { image: 'registry.example/fraud:v2', smokePath: '/health' },
      now,
    });
    manager.advance(tenant, revision.deploymentId, 'provision');
    manager.advance(tenant, revision.deploymentId, 'smokePass');
    expect(manager.advance(tenant, revision.deploymentId, 'startCanary', approval())).toMatchObject(
      {
        state: 'canary',
        trafficPercent: 10,
      },
    );
    manager.observeHealth(tenant, revision.deploymentId, { healthy: false, observedAt: now });
    const unhealthy = manager.observeHealth(tenant, revision.deploymentId, {
      healthy: false,
      error: 'probe failed',
      observedAt: now,
    });
    expect(unhealthy.consecutiveFailures).toBe(2);
    const rolledBack = manager.automaticRollbackIfUnhealthy(
      tenant,
      revision.deploymentId,
      approval(),
    );
    expect(rolledBack).toMatchObject({ state: 'rolled_back', trafficPercent: 0 });
    expect(manager.getEndpoint(tenant, endpoint.endpointId)?.state).toBe('failed');
    expect(() =>
      manager.advance(otherTenant, revision.deploymentId, 'rollback', approval()),
    ).toThrow('not found');
  });

  it('provides SSO/SCIM sessions without storing bearer material and honors deprovisioning', () => {
    const identity = new InMemoryEnterpriseIdentityService({ clock: () => now });
    const provider = identity.registerProvider({
      tenant,
      displayName: 'Acme SSO',
      protocol: 'oidc',
      issuerUrl: 'https://idp.example.com',
      clientId: 'spyderbyte',
      redirectUris: ['https://app.example.com/callback'],
      now,
    });
    const user = identity.upsertScimUser({
      tenant,
      externalId: 'scim-1',
      userName: 'ada',
      email: 'ada@example.com',
      groups: ['ml-platform'],
      now,
    });
    const login = identity.beginLogin({
      tenant,
      providerId: provider.providerId,
      redirectUri: 'https://app.example.com/callback',
      now,
    });
    const session = identity.completeLogin({
      tenant,
      providerId: provider.providerId,
      state: login.state,
      claims: {
        subject: 'subject-1',
        email: user.email,
        displayName: 'Ada',
        groups: user.groups,
        issuer: provider.issuerUrl,
        issuedAt: now,
        expiresAt: '2026-08-06T01:00:00.000Z',
      },
      now,
    });
    expect(identity.authenticate(tenant, session.sessionId, now).actor.actorId).toBe(user.userId);
    expect(identity.auditRecords(tenant).every((record) => !('token' in record.details))).toBe(
      true,
    );
    identity.deprovisionScimUser(tenant, user.userId, now);
    expect(identity.listScimUsers(tenant)[0]?.active).toBe(false);
    expect(() => identity.authenticate(tenant, session.sessionId, now)).toThrow(
      'expired or revoked',
    );
  });

  it('supports versioned secret rotation and hosted execution tenant/quota boundaries', async () => {
    const secrets = new InMemoryEnterpriseSecretManager(() => now);
    secrets.putSecret({ tenant, secretName: 'provider-api-key', value: 'secret-v1', now });
    const handle = await secrets.issue({
      tenant,
      secretName: 'provider-api-key',
      operation: 'model.invoke',
      ttlMs: 3_600_000,
    });
    await expect(
      secrets.resolve({ handleId: handle.handleId, tenant, operation: 'model.invoke' }),
    ).resolves.toBe('secret-v1');
    const rotated = await secrets.rotate({
      handleId: handle.handleId,
      tenant,
      operation: 'model.invoke',
      ttlMs: 3_600_000,
    });
    await expect(
      secrets.resolve({ handleId: handle.handleId, tenant, operation: 'model.invoke' }),
    ).rejects.toThrow('invalidated');
    await expect(
      secrets.resolve({ handleId: rotated.handleId, tenant, operation: 'model.invoke' }),
    ).resolves.toBe('secret-v1');
    expect(secrets.auditRecords(tenant).every((record) => !('value' in record))).toBe(true);

    let terminal = false;
    const client: HostedExecutionClient = {
      submit: async () => ({ externalExecutionId: 'cloud-1', state: 'running' }),
      observe: async (handleValue): Promise<HostedExecutionObservationV1> => ({
        handle: handleValue,
        state: terminal ? 'succeeded' : 'running',
        observedAt: now,
        attempt: 1,
        stdout: 'ok',
        stderr: '',
      }),
      terminate: async () => undefined,
    };
    const adapter = new HostedExecutionAdapter(client, {
      clock: () => now,
      maxConcurrentPerTenant: 1,
    });
    const target: HostedExecutionTargetV1 = {
      targetId: newSortableId(),
      tenant,
      kind: 'customer_cloud',
      region: 'us-central',
      capabilities: ['python'],
      enabled: true,
    };
    adapter.registerTarget(target);
    const request = {
      tenant,
      targetId: target.targetId,
      command: 'python',
      args: ['-c', 'print(1)'],
      resources: { cpuMillicores: 100, memoryBytes: 1024 },
      sandbox: {
        networkAllowlist: ['pypi.org'],
        readOnlyArtifactMounts: true,
        ephemeralFilesystem: true,
        maxOutputBytes: 1024,
        maxWallTimeMs: 1000,
        maxProcessCount: 1,
      },
    } as const;
    const execution = await adapter.submit(request);
    await expect(adapter.submit(request)).rejects.toThrow('quota');
    terminal = true;
    await expect(adapter.observe(tenant, execution.executionId)).resolves.toMatchObject({
      state: 'succeeded',
    });
    expect(adapter.get(otherTenant, execution.executionId)).toBeUndefined();
  });
});
