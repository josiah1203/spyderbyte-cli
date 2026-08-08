import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProviderRuntime } from '@agentic-platform/provider-runtime';
import {
  newSortableId,
  type JsonValue,
  type TenantRef,
  type WorkspaceContext,
} from '@agentic-platform/runtime-contracts';
import { InMemoryStateStore } from '@agentic-platform/state';
import {
  handleLocalApiRequest,
  InMemorySettingsStore,
  type LocalApiOptions,
} from '../src/index.js';

function options(rootPath: string): LocalApiOptions {
  const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
  const workspaceContext: WorkspaceContext = { ...tenant, mode: 'personal_local' };
  return {
    orchestrator: {} as LocalApiOptions['orchestrator'],
    state: new InMemoryStateStore(),
    tenant,
    workspaceContext,
    workspace: {
      rootPath,
      manifest: {} as JsonValue,
      exportArchive: async () => ({}),
      previewRestore: async () => ({}),
      importArchive: async () => ({}),
    },
    settings: new InMemorySettingsStore(),
    providerRuntime: createProviderRuntime({
      rootPath,
      useKeychain: false,
      fetcher: async () => {
        throw new Error('network disconnected');
      },
    }),
  };
}

describe('Phase 5 first-run and local-first provider surfaces', () => {
  it('detects project context, completes local onboarding, and selects offline compute', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-phase5-onboarding-'));
    await mkdir(join(root, 'notebooks'));
    await writeFile(join(root, 'pyproject.toml'), '[project]\nname="offline-fixture"\n');
    const api = options(root);

    const initial = await handleLocalApiRequest(
      { method: 'GET', path: '/v1/onboarding', body: undefined },
      api,
    );
    expect(initial).toMatchObject({
      statusCode: 200,
      body: {
        firstQuestionReady: true,
        authenticationRequiredForFirstQuestion: false,
        onboarding: { status: 'not_started', environment: { project: { rootPath: root } } },
      },
    });
    expect(
      (initial.body as { onboarding: { environment: { project: { likelyWorkloads: string[] } } } })
        .onboarding.environment.project.likelyWorkloads,
    ).toEqual(expect.arrayContaining(['python', 'notebook']));

    const completed = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/onboarding',
        body: { choice: 'local-model', modelId: 'fixture-model' },
      },
      api,
    );
    expect(completed).toMatchObject({
      statusCode: 200,
      body: {
        firstQuestionReady: true,
        onboarding: { status: 'configured', choice: 'local-model', modelId: 'fixture-model' },
      },
    });

    const selection = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/runtimes/compute-selection',
        body: { networkPolicy: 'offline' },
      },
      api,
    );
    expect(selection).toMatchObject({
      statusCode: 200,
      body: {
        selected: { runtimeType: 'local-host', networkPolicy: 'offline' },
        reason: 'local-first',
      },
    });

    const catalog = await handleLocalApiRequest(
      { method: 'GET', path: '/v1/models/catalog', body: undefined },
      api,
    );
    expect(catalog).toMatchObject({ statusCode: 200, body: { models: expect.any(Array) } });
  });

  it('stores BYOK credentials only in the vault and exposes preflight/health/usage safely', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-phase5-byok-'));
    const api = options(root);
    const completed = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/onboarding',
        body: {
          choice: 'provider-key',
          provider: {
            providerId: 'local-compatible',
            providerType: 'openai-compatible',
            displayName: 'Local compatible BYOK',
            endpoint: 'http://127.0.0.1:9999/v1',
            defaultModelId: 'local-byok',
            modelIds: ['local-byok'],
            apiKey: 'phase5-secret-must-not-escape',
          },
        },
      },
      api,
    );
    const providerConfigurationId = (
      completed.body as { onboarding: { providerConfigurationId: string } }
    ).onboarding.providerConfigurationId;
    expect(JSON.stringify(completed.body)).not.toContain('phase5-secret-must-not-escape');
    expect(JSON.stringify(await api.state?.snapshot())).not.toContain(
      'phase5-secret-must-not-escape',
    );
    const listed = await handleLocalApiRequest(
      { method: 'GET', path: '/v1/providers', body: undefined },
      api,
    );
    expect(JSON.stringify(listed.body)).not.toContain('phase5-secret-must-not-escape');
    expect(listed.body).toMatchObject({
      credentials: [expect.objectContaining({ providerConfigurationId, status: 'active' })],
    });

    const preflight = await handleLocalApiRequest(
      { method: 'POST', path: `/v1/providers/${providerConfigurationId}/preflight`, body: {} },
      api,
    );
    expect(preflight.statusCode).toBe(200);
    expect(JSON.stringify(preflight.body)).not.toContain('phase5-secret-must-not-escape');
    await expect(
      handleLocalApiRequest(
        { method: 'GET', path: `/v1/providers/${providerConfigurationId}/health`, body: undefined },
        api,
      ),
    ).resolves.toMatchObject({ statusCode: 200, body: { providerConfigurationId } });
    await expect(
      handleLocalApiRequest(
        { method: 'GET', path: `/v1/providers/${providerConfigurationId}/usage`, body: undefined },
        api,
      ),
    ).resolves.toMatchObject({ statusCode: 200, body: { quotaState: 'unknown' } });
  });
});
