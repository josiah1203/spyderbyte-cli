import { describe, expect, it } from 'vitest';
import {
  HostedExecutionAdapter,
  InMemoryEnterpriseIdentityService,
  InMemoryEnterpriseSecretManager,
  type HostedExecutionClient,
  type HostedExecutionObservationV1,
  type HostedExecutionTargetV1,
} from '../src/index.js';
import { newSortableId, type TenantRef } from '@agentic-platform/runtime-contracts';

const now = '2026-08-07T00:00:00.000Z';
const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
const otherTenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };

describe('phase 8 enterprise failure paths', () => {
  it('rejects unregistered SSO redirects and consumes login state exactly once', () => {
    const identity = new InMemoryEnterpriseIdentityService({ clock: () => now, loginTtlMs: 1_000 });
    const provider = identity.registerProvider({
      tenant,
      displayName: 'Acme SSO',
      protocol: 'oidc',
      issuerUrl: 'https://idp.example.com',
      clientId: 'spyderbyte',
      redirectUris: ['https://app.example.com/callback'],
      now,
    });
    expect(() =>
      identity.beginLogin({
        tenant,
        providerId: provider.providerId,
        redirectUri: 'https://evil.example/callback',
        now,
      }),
    ).toThrow('not registered');
    const login = identity.beginLogin({
      tenant,
      providerId: provider.providerId,
      redirectUri: 'https://app.example.com/callback',
      now,
    });
    const claims = {
      subject: 'subject-1',
      email: 'ada@example.com',
      issuer: provider.issuerUrl,
      issuedAt: now,
      expiresAt: '2026-08-07T01:00:00.000Z',
    } as const;
    expect(() =>
      identity.completeLogin({
        tenant,
        providerId: provider.providerId,
        state: login.state,
        claims,
        now: '2026-08-07T00:00:00.002Z',
      }),
    ).not.toThrow();
    expect(() =>
      identity.completeLogin({
        tenant,
        providerId: provider.providerId,
        state: login.state,
        claims,
        now,
      }),
    ).toThrow('invalid');
  });

  it('never resolves an enterprise secret outside its tenant or operation scope', async () => {
    const secrets = new InMemoryEnterpriseSecretManager(() => now);
    secrets.putSecret({ tenant, secretName: 'provider-key', value: 'value-v1', now });
    const handle = await secrets.issue({
      tenant,
      secretName: 'provider-key',
      operation: 'model.invoke',
      ttlMs: 60_000,
    });
    await expect(
      secrets.resolve({
        handleId: handle.handleId,
        tenant: otherTenant,
        operation: 'model.invoke',
      }),
    ).rejects.toThrow('invalid');
    await expect(
      secrets.resolve({ handleId: handle.handleId, tenant, operation: 'other.operation' }),
    ).rejects.toThrow('invalid');
    await secrets.revoke(handle.handleId);
    await expect(
      secrets.resolve({ handleId: handle.handleId, tenant, operation: 'model.invoke' }),
    ).rejects.toThrow('invalid');
    await expect(secrets.redact('value-v1')).resolves.toBe('[REDACTED]');
  });

  it('rejects shell syntax, invalid network policy, and cross-tenant runner access', async () => {
    let externalState: 'running' | 'succeeded' = 'running';
    const client: HostedExecutionClient = {
      submit: async () => ({ externalExecutionId: 'customer-run-1', state: 'running' }),
      observe: async (handle): Promise<HostedExecutionObservationV1> => ({
        handle,
        state: externalState,
        observedAt: now,
        attempt: 1,
        stdout: '',
        stderr: '',
      }),
      terminate: async () => undefined,
    };
    const adapter = new HostedExecutionAdapter(client, { clock: () => now });
    const target: HostedExecutionTargetV1 = {
      targetId: newSortableId(),
      tenant,
      kind: 'customer_cloud',
      region: 'us-central',
      capabilities: ['python'],
      enabled: true,
    };
    adapter.registerTarget(target);
    expect(adapter.listTargets(otherTenant)).toHaveLength(0);
    const request = {
      tenant,
      targetId: target.targetId,
      args: [],
      resources: { cpuMillicores: 100 },
      sandbox: {
        networkAllowlist: ['pypi.org'],
        readOnlyArtifactMounts: true,
        ephemeralFilesystem: true,
        maxOutputBytes: 1024,
        maxWallTimeMs: 1_000,
        maxProcessCount: 1,
      },
    } as const;
    await expect(adapter.submit({ ...request, command: 'python -c' })).rejects.toThrow(
      'without shell',
    );
    await expect(
      adapter.submit({
        ...request,
        command: 'python',
        sandbox: { ...request.sandbox, networkAllowlist: ['https://pypi.org'] },
      }),
    ).rejects.toThrow('invalid host');
    const execution = await adapter.submit({ ...request, command: 'python' });
    expect(adapter.list(otherTenant)).toHaveLength(0);
    expect(adapter.get(otherTenant, execution.executionId)).toBeUndefined();
    externalState = 'succeeded';
    await expect(adapter.observe(tenant, execution.executionId)).resolves.toMatchObject({
      state: 'succeeded',
    });
  });
});
