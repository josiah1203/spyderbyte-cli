import { createHash } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LocalConfirmationService } from '@agentic-platform/policy';
import { createProviderRuntime } from '@agentic-platform/provider-runtime';
import {
  newSortableId,
  type TenantRef,
  type WorkspaceContext,
} from '@agentic-platform/runtime-contracts';
import { handleLocalApiRequest, type LocalApiOptions } from '../src/index.js';

function personalOptions(rootPath: string): LocalApiOptions {
  const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
  const workspaceContext: WorkspaceContext = { ...tenant, mode: 'personal_local' };
  return {
    orchestrator: {} as LocalApiOptions['orchestrator'],
    tenant,
    workspaceContext,
    confirmations: new LocalConfirmationService(),
    providerRuntime: createProviderRuntime({ rootPath, useKeychain: false }),
  };
}

async function challengeFor(
  action: Record<string, unknown>,
  request: () => Promise<unknown>,
  api: LocalApiOptions,
): Promise<string> {
  let challengeId = '';
  try {
    await request();
  } catch (error) {
    expect(error).toMatchObject({ code: 'LOCAL_CONFIRMATION_REQUIRED' });
    challengeId = (error as { evidence: readonly string[] }).evidence[0] ?? '';
  }
  expect(challengeId).toBeTruthy();
  const confirmation = await handleLocalApiRequest(
    {
      method: 'POST',
      path: `/v1/confirmations/${challengeId}/confirm`,
      body: { action },
    },
    api,
  );
  expect(confirmation.statusCode).toBe(200);
  return challengeId;
}

describe('Phase 2 local API coding loop', () => {
  it('exposes project search/edit/history and requires local confirmation for file writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-phase2-api-'));
    const projectPath = join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    const api = personalOptions(root);
    const registered = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/repositories/local/register',
        body: { path: projectPath, kind: 'directory', name: 'Phase 2 project' },
      },
      api,
    );
    expect(registered.statusCode).toBe(201);
    const repositoryId = (registered.body as { repositoryId: string }).repositoryId;

    const content = 'print("api phase2")\n';
    const contentHash = `sha256:${createHash('sha256').update(content).digest('hex')}`;
    const action = {
      kind: 'repository.file.write',
      repositoryId,
      path: 'src/main.py',
      contentHash,
      origin: 'manual',
      sizeBytes: Buffer.byteLength(content, 'utf8'),
    };
    const confirmationId = await challengeFor(
      action,
      () =>
        handleLocalApiRequest(
          {
            method: 'POST',
            path: `/v1/repositories/local/${repositoryId}/file`,
            body: { path: 'src/main.py', content, origin: 'manual' },
          },
          api,
        ),
      api,
    );
    const written = await handleLocalApiRequest(
      {
        method: 'POST',
        path: `/v1/repositories/local/${repositoryId}/file`,
        body: { path: 'src/main.py', content, origin: 'manual', confirmationId },
      },
      api,
    );
    expect(written.statusCode).toBe(200);

    await expect(
      handleLocalApiRequest(
        {
          method: 'GET',
          path: `/v1/repositories/local/${repositoryId}/search?query=api%20phase2`,
        },
        api,
      ),
    ).resolves.toMatchObject({
      statusCode: 200,
      body: [expect.objectContaining({ path: 'src/main.py', line: 1 })],
    });
    await expect(
      handleLocalApiRequest(
        { method: 'GET', path: `/v1/repositories/local/${repositoryId}/history?path=src/main.py` },
        api,
      ),
    ).resolves.toMatchObject({
      statusCode: 200,
      body: [expect.objectContaining({ kind: 'file-operation' })],
    });
  });

  it('stores provider credentials behind the vault boundary and returns metadata only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-provider-api-'));
    const api = personalOptions(root);
    const created = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/providers',
        body: {
          providerId: 'openai-primary',
          providerType: 'openai',
          displayName: 'Primary OpenAI',
          endpoint: 'https://api.openai.com/v1',
          defaultModelId: 'gpt-test',
          apiKey: 'provider-secret-value',
        },
      },
      api,
    );
    expect(created.statusCode).toBe(201);
    const providerConfigurationId = (created.body as { providerConfigurationId: string })
      .providerConfigurationId;
    expect(JSON.stringify(created.body)).not.toContain('provider-secret-value');

    const listed = await handleLocalApiRequest({ method: 'GET', path: '/v1/providers' }, api);
    expect(listed).toMatchObject({
      statusCode: 200,
      body: {
        providers: expect.arrayContaining([
          expect.objectContaining({ providerConfigurationId, state: 'authenticated' }),
        ]),
        credentials: expect.arrayContaining([
          expect.objectContaining({ providerConfigurationId, status: 'active' }),
        ]),
      },
    });
    expect(JSON.stringify(listed.body)).not.toContain('provider-secret-value');
  });

  it('exposes a current artifact catalog and bounded content read for terminal export', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-artifact-api-'));
    const apiBase = personalOptions(root);
    const artifactId = newSortableId();
    const artifact = {
      reference: {
        schemaVersion: 1,
        tenant: apiBase.tenant,
        artifactId,
        version: 1,
        contentHash: 'sha256:artifact-content',
        mediaType: 'text/plain',
        sizeBytes: 3,
        createdAt: new Date().toISOString(),
      },
      state: 'published',
      createdBy: { actorId: newSortableId(), type: 'system', displayName: 'Test' },
      lineage: [],
      publishedAt: new Date().toISOString(),
    };
    const orchestrator = {
      listCurrentArtifacts: vi.fn(async () => [artifact]),
      getArtifact: vi.fn(async () => artifact),
      readArtifactContent: vi.fn(async () => new Uint8Array([65, 66, 67])),
    } as unknown as LocalApiOptions['orchestrator'];
    const api = { ...apiBase, orchestrator };

    await expect(
      handleLocalApiRequest({ method: 'GET', path: '/v1/artifacts' }, api),
    ).resolves.toEqual({ statusCode: 200, body: { artifacts: [artifact] } });
    await expect(
      handleLocalApiRequest(
        {
          method: 'GET',
          path: `/v1/artifacts/${artifactId}/versions/1/content`,
        },
        api,
      ),
    ).resolves.toMatchObject({
      statusCode: 200,
      body: {
        artifactId,
        version: 1,
        mediaType: 'text/plain',
        contentBase64: 'QUJD',
      },
    });
  });
});
