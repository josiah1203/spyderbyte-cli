import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ModelRouter } from '@agentic-platform/harness-core';
import { newSortableId, type TenantRef } from '@agentic-platform/runtime-contracts';
import {
  FileComputeProfileRegistry,
  MemoryCredentialVault,
  MemoryProviderConfigurationStore,
  ProviderCatalog,
  ProviderConfigurationService,
} from '../src/index.js';

const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };

describe('Phase 5 provider-neutral selection', () => {
  it('selects an offline local runtime first and keeps customer profiles provider-neutral', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-phase5-compute-'));
    const registry = new FileComputeProfileRegistry(root, tenant, () => '2026-08-07T00:00:00.000Z');
    const local = registry.list()[0];
    expect(local).toMatchObject({
      runtimeType: 'local-host',
      state: 'ready',
      networkPolicy: 'offline',
    });

    const customer = await registry.create({
      runtimeType: 'customer-cloud',
      displayName: 'Customer compute',
      state: 'ready',
      cpuMillicores: 4_000,
      memoryBytes: 16 * 1024 * 1024 * 1024,
      networkPolicy: 'allowlist',
    });
    const selected = registry.select({
      requirements: { cpuMillicores: 1_000 },
      networkPolicy: 'offline',
    });
    expect(selected.selected.runtimeType).toBe('local-host');
    expect(selected.reason).toBe('local-first');
    expect(selected.fallback).toEqual([]);

    const explicit = registry.select({ explicitProfileId: customer.runtimeProfileId });
    expect(explicit.selected.runtimeProfileId).toBe(customer.runtimeProfileId);
    expect(explicit.reason).toBe('explicit');
    expect(
      JSON.stringify(await readFile(join(root, '.agentic', 'compute-profiles.json'), 'utf8')),
    ).not.toContain('apiKey');
    expect(local?.tenant).toEqual(tenant);
  });

  it('exposes a redacted preflight for API-key, cloud, and customer-owned provider types', async () => {
    const store = new MemoryProviderConfigurationStore();
    const vault = new MemoryCredentialVault();
    const catalog = new ProviderCatalog();
    const router = new ModelRouter();
    const service = new ProviderConfigurationService({
      tenant,
      store,
      vault,
      catalog,
      router,
      fetcher: async () => {
        throw new Error('network should not be called by unconfigured preflight');
      },
    });
    const cloud = await service.add({
      providerType: 'spyderbyte-cloud',
      displayName: 'Spyderbyte Cloud',
      defaultModelId: 'managed-default',
    });
    const customer = await service.add({
      providerId: 'customer-endpoint',
      providerType: 'customer-owned',
      displayName: 'Customer endpoint',
      endpoint: 'http://127.0.0.1:9999/v1',
      defaultModelId: 'customer-model',
      apiKey: 'never-return-this-secret',
    });
    expect(cloud.providerType).toBe('spyderbyte-cloud');
    expect(customer.providerType).toBe('customer-owned');
    const report = await service.preflight(cloud.providerConfigurationId);
    expect(report).toMatchObject({
      schemaVersion: 1,
      providerId: 'spyderbyte-cloud',
      credentialState: 'missing',
    });
    expect(JSON.stringify(report)).not.toContain('never-return-this-secret');
    expect(JSON.stringify(store.load())).not.toContain('never-return-this-secret');
    expect(JSON.stringify(service.listCredentials())).not.toContain('never-return-this-secret');
  });
});
