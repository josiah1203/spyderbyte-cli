import { describe, expect, it } from 'vitest';
import {
  makeMoney,
  newSortableId,
  type ProviderConfiguration,
} from '@agentic-platform/runtime-contracts';
import { ModelRouter } from '@agentic-platform/harness-core';
import {
  DefaultProviderAdapterFactory,
  HostedEncryptedSecretVault,
  MacOsKeychainVault,
  MemoryCredentialVault,
  MemoryProviderConfigurationStore,
  ProviderCatalog,
  ProviderConfigurationService,
  createOpenAiCompatibleLocalTransport,
} from '../src/index.js';

const tenant = { tenantId: newSortableId(), workspaceId: newSortableId() };

function configuration(providerType: ProviderConfiguration['providerType']): ProviderConfiguration {
  return {
    schemaVersion: 1,
    providerConfigurationId: newSortableId(),
    tenant,
    providerId: `${providerType}-test`,
    providerType,
    displayName: `${providerType} test`,
    endpoint:
      providerType === 'deterministic' ? 'local://deterministic' : 'http://127.0.0.1:8080/v1',
    capabilities: ['streaming', 'structured-output'],
    supportedModalities: ['text'],
    modelDiscoveryMode: providerType === 'deterministic' ? 'configured' : 'api',
    state: 'configured',
    authenticationState: providerType === 'deterministic' ? 'not_applicable' : 'required',
    local: providerType !== 'openai',
    timeoutMs: 1000,
    retryMaxAttempts: 1,
    usagePolicy: { maxTokensPerRequest: 4096 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('Phase 1 provider vertical slice', () => {
  it('supports a hosted encrypted-secret vault boundary without persisting secret metadata', async () => {
    const values = new Map<string, string>();
    const calls: string[] = [];
    const vault = new HostedEncryptedSecretVault({
      async put(input) {
        calls.push(`put:${input.secretName}`);
        values.set(input.secretName, input.value);
      },
      async get(input) {
        calls.push(`get:${input.secretName}`);
        return values.get(input.secretName);
      },
      async delete(input) {
        calls.push(`delete:${input.secretName}`);
        values.delete(input.secretName);
      },
    });
    await vault.put('credential-1', 'hosted-secret');
    expect(await vault.get('credential-1')).toBe('hosted-secret');
    await vault.delete('credential-1');
    expect(await vault.get('credential-1')).toBeUndefined();
    expect(calls).toEqual([
      'put:provider:credential-1',
      'get:provider:credential-1',
      'delete:provider:credential-1',
      'get:provider:credential-1',
    ]);
  });

  it('maps provider credentials to macOS Keychain security commands', async () => {
    const values = new Map<string, string>();
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const vault = new MacOsKeychainVault('com.spyderbyte.test', 'provider:', {
      platform: 'darwin',
      async runCommand(executable, args) {
        calls.push({ executable, args });
        const command = args[0];
        const account = args[args.indexOf('-a') + 1];
        if (account === undefined) throw new Error('missing Keychain account');
        if (command === 'add-generic-password') {
          const value = args[args.indexOf('-w') + 1];
          if (value === undefined) throw new Error('missing Keychain value');
          values.set(account, value);
          return { stdout: '' };
        }
        if (command === 'find-generic-password') {
          return { stdout: `${values.get(account) ?? ''}\n` };
        }
        if (command === 'delete-generic-password') {
          values.delete(account);
          return { stdout: '' };
        }
        throw new Error(`unexpected Keychain command: ${command}`);
      },
    });

    await vault.put('openai', 'provider-secret');
    expect(await vault.get('openai')).toBe('provider-secret');
    await vault.delete('openai');
    expect(await vault.get('openai')).toBeUndefined();
    expect(calls).toEqual([
      {
        executable: '/usr/bin/security',
        args: [
          'add-generic-password',
          '-U',
          '-s',
          'com.spyderbyte.test',
          '-a',
          'provider:openai',
          '-w',
          'provider-secret',
        ],
      },
      {
        executable: '/usr/bin/security',
        args: ['find-generic-password', '-s', 'com.spyderbyte.test', '-a', 'provider:openai', '-w'],
      },
      {
        executable: '/usr/bin/security',
        args: ['delete-generic-password', '-s', 'com.spyderbyte.test', '-a', 'provider:openai'],
      },
      {
        executable: '/usr/bin/security',
        args: ['find-generic-password', '-s', 'com.spyderbyte.test', '-a', 'provider:openai', '-w'],
      },
    ]);
  });

  it('does not attempt Keychain access on non-macOS hosts', async () => {
    let calls = 0;
    const vault = new MacOsKeychainVault('com.spyderbyte.test', 'provider:', {
      platform: 'linux',
      async runCommand() {
        calls += 1;
        return { stdout: '' };
      },
    });

    await expect(vault.put('openai', 'provider-secret')).rejects.toMatchObject({
      code: 'COMPUTE_RESOURCE_UNAVAILABLE',
    });
    expect(await vault.get('openai')).toBeUndefined();
    await vault.delete('openai');
    expect(calls).toBe(0);
  });

  it('routes provider configuration through the explicit adapter factory boundary', () => {
    const factory = new DefaultProviderAdapterFactory();
    const adapter = factory.create(configuration('ollama'), {});
    expect(adapter.transport.stream).toBeTypeOf('function');
    expect(adapter.capabilities).toEqual(
      expect.arrayContaining([
        { capability: 'streaming', enabled: true },
        { capability: 'structured-output', enabled: true },
      ]),
    );
  });

  it('reports actionable preflight evidence and rate-limit state', async () => {
    const service = new ProviderConfigurationService({
      tenant,
      store: new MemoryProviderConfigurationStore(),
      vault: new MemoryCredentialVault(),
      catalog: new ProviderCatalog(),
      router: new ModelRouter(),
      fetcher: async () =>
        new Response(JSON.stringify({ error: 'slow down' }), {
          status: 429,
          headers: { 'retry-after': '4', 'x-ratelimit-limit': '10', 'x-ratelimit-remaining': '0' },
        }),
    });
    const provider = await service.add({
      providerId: 'rate-limited',
      providerType: 'openai',
      displayName: 'Rate limited',
      endpoint: 'https://provider.test/v1',
      defaultModelId: 'model-a',
      apiKey: 'secret',
    });
    const report = await service.test(provider.providerConfigurationId);
    expect(report.state).toBe('rate_limited');
    expect(report.rateLimit).toMatchObject({ statusCode: 429, retryAfterMs: 4000, remaining: 0 });
    expect(report.checks.map((check) => check.name)).toEqual(
      expect.arrayContaining(['authentication', 'reachability', 'capability_report']),
    );
    expect(report.actionableErrors).toEqual(
      expect.arrayContaining([
        'Provider rate limit reached; wait for the retry window before trying again.',
      ]),
    );
    expect(service.get(provider.providerConfigurationId)?.state).toBe('rate_limited');
  });

  it('marks a missing vault value as an expired credential instead of returning a secret', async () => {
    const vault = new MemoryCredentialVault();
    const service = new ProviderConfigurationService({
      tenant,
      store: new MemoryProviderConfigurationStore(),
      vault,
      catalog: new ProviderCatalog(),
      router: new ModelRouter(),
      fetcher: async () =>
        new Response(JSON.stringify({ data: [{ id: 'model-a' }] }), { status: 200 }),
    });
    const provider = await service.add({
      providerId: 'expired-credential',
      providerType: 'openai',
      displayName: 'Expired credential',
      endpoint: 'https://provider.test/v1',
      defaultModelId: 'model-a',
      apiKey: 'secret',
    });
    await service.revokeCredential(provider.providerConfigurationId);
    const report = await service.test(provider.providerConfigurationId);
    expect(report.state).toBe('degraded');
    expect(service.get(provider.providerConfigurationId)).toMatchObject({
      authenticationState: 'expired',
    });
    expect(JSON.stringify(report)).not.toContain('secret');
  });

  it('streams from an OpenAI-compatible local endpoint', async () => {
    const transport = createOpenAiCompatibleLocalTransport(
      'http://local.test',
      async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { stream?: boolean };
        return body.stream === true
          ? new Response(
              'data: {"choices":[{"delta":{"content":"local"}}]}\n\n' + 'data: [DONE]\n\n',
              { status: 200, headers: { 'content-type': 'text/event-stream' } },
            )
          : new Response(
              JSON.stringify({
                choices: [{ message: { content: 'local' } }],
                usage: { total_tokens: 1 },
              }),
              { status: 200 },
            );
      },
    );
    const events: string[] = [];
    const stream = await transport.stream?.(
      {
        providerId: 'ollama',
        modelId: 'model-a',
        capabilities: [],
        dataClasses: ['internal'],
        billingMode: 'local',
        state: 'ready',
        local: true,
      },
      {
        requestId: newSortableId(),
        model: 'model-a',
        input: { instruction: 'hello' },
        maxTokens: 8,
      },
    );
    for await (const event of stream ?? []) {
      if (event.type === 'delta') events.push(String(event.value));
    }
    expect(events).toEqual(['local']);
  });

  it('keeps the deterministic adapter cost shape stable', async () => {
    const adapter = new DefaultProviderAdapterFactory().create(configuration('deterministic'), {});
    const response = await adapter.transport.complete(
      {
        providerId: 'deterministic',
        modelId: 'fixture-model',
        capabilities: [],
        dataClasses: ['internal'],
        billingMode: 'local',
        state: 'ready',
        local: true,
      },
      { requestId: newSortableId(), model: 'fixture-model', input: { ok: true }, maxTokens: 8 },
    );
    expect(response.usage.cost).toEqual(makeMoney(0, 'USD'));
  });
});
