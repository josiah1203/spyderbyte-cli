import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ContentAddressedArtifactRegistry,
  type ArtifactVersionRecord,
} from '@agentic-platform/artifact-registry';
import { createProviderRuntime } from '@agentic-platform/provider-runtime';
import {
  newSortableId,
  type Actor,
  type Id,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import { InMemoryStateStore } from '@agentic-platform/state';
import { handleLocalApiRequest, type LocalApiOptions } from '../src/index.js';

function artifactApi(
  registry: ContentAddressedArtifactRegistry,
  tenant: TenantRef,
): LocalApiOptions {
  const current = async (
    scopedTenant: TenantRef,
    artifactId: Id,
  ): Promise<ArtifactVersionRecord | undefined> =>
    registry.currentVersion(scopedTenant, artifactId);
  return {
    orchestrator: {
      getCurrentArtifact: current,
      getArtifact: (scopedTenant: TenantRef, artifactId: Id, version: number) =>
        registry.getVersion(scopedTenant, artifactId, version),
      readArtifactContent: (scopedTenant: TenantRef, artifactId: Id, version: number) =>
        registry.readContent(scopedTenant, artifactId, version),
      listArtifactVersions: (scopedTenant: TenantRef, artifactId: Id) =>
        registry.listVersions(scopedTenant, artifactId),
      listCurrentArtifacts: async () => {
        const records = await registry.listCurrent(tenant);
        return records;
      },
    } as unknown as LocalApiOptions['orchestrator'],
    tenant,
    artifacts: registry,
  };
}

const now = '2026-08-07T00:00:00.000Z';

describe('Phase 6 terminal artifact and workspace surfaces', () => {
  it('publishes immutable versions, exposes lineage, and returns a structured artifact diff', async () => {
    const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
    const registry = new ContentAddressedArtifactRegistry(new InMemoryStateStore());
    const api = artifactApi(registry, tenant);
    const artifactId = newSortableId();
    const actor: Actor = { actorId: newSortableId(), type: 'human', displayName: 'Phase 6 user' };
    const publish = async (content: string, expectedParentVersion: number) => {
      const upload = await handleLocalApiRequest(
        {
          method: 'POST',
          path: '/v1/artifacts/uploads',
          body: { content, mediaType: 'application/json', now },
        },
        api,
      );
      expect(upload.statusCode).toBe(201);
      return handleLocalApiRequest(
        {
          method: 'POST',
          path: `/v1/artifacts/${artifactId}/versions`,
          body: {
            stagedUploadId: (upload.body as Record<string, unknown>)['stagedUploadId'],
            mediaType: 'application/json',
            createdBy: actor,
            expectedParentVersion,
            now,
          },
        },
        api,
      );
    };

    const first = await publish('{"columns":["name","value"],"rows":[["a",1]]}', 0);
    expect(first.statusCode).toBe(201);
    const second = await publish('{"columns":["name","value"],"rows":[["a",2],["b",3]]}', 1);
    expect(second.statusCode).toBe(201);

    const versions = await handleLocalApiRequest(
      { method: 'GET', path: `/v1/artifacts/${artifactId}/versions`, body: undefined },
      api,
    );
    expect(versions.statusCode).toBe(200);
    expect(
      (versions.body as ArtifactVersionRecord[]).map((record) => record.reference.version),
    ).toEqual([1, 2]);
    await expect(
      handleLocalApiRequest(
        { method: 'GET', path: `/v1/artifacts/${artifactId}/lineage`, body: undefined },
        api,
      ),
    ).resolves.toMatchObject({ statusCode: 200, body: [{ artifactId, version: 1 }] });
    await expect(
      handleLocalApiRequest(
        {
          method: 'GET',
          path: `/v1/artifacts/${artifactId}/diff?fromVersion=1&toVersion=2`,
          body: undefined,
        },
        api,
      ),
    ).resolves.toMatchObject({
      statusCode: 200,
      body: {
        format: 'json',
        changed: true,
        summary: { changed: expect.any(Number) },
        changes: expect.arrayContaining([
          expect.objectContaining({ path: '$.rows[0][1]', kind: 'changed' }),
        ]),
      },
    });
  });

  it('chooses or overrides a visualization and classifies inbox/watch resources with recommendations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-phase6-intake-'));
    try {
      await mkdir(join(root, '.spyderbyte', 'inbox'), { recursive: true });
      await mkdir(join(root, '.spyderbyte', 'watch'), { recursive: true });
      await writeFile(join(root, '.spyderbyte', 'inbox', 'customers.csv'), 'name,value\na,1\n');
      await writeFile(join(root, '.spyderbyte', 'watch', 'analysis.ipynb'), '{}');
      const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
      const api: LocalApiOptions = {
        orchestrator: {} as LocalApiOptions['orchestrator'],
        tenant,
        providerRuntime: createProviderRuntime({ rootPath: root, tenant, useKeychain: false }),
      };

      await expect(
        handleLocalApiRequest(
          {
            method: 'POST',
            path: '/v1/visualizations/choose',
            body: { columns: ['name', 'value'], rows: [['a', 1]] },
          },
          api,
        ),
      ).resolves.toMatchObject({ statusCode: 200, body: { type: 'bar', source: 'automatic' } });
      await expect(
        handleLocalApiRequest(
          {
            method: 'POST',
            path: '/v1/visualizations/choose',
            body: { type: 'heatmap', columns: ['x', 'y'], rows: [[1, 2]] },
          },
          api,
        ),
      ).resolves.toMatchObject({ statusCode: 200, body: { type: 'heatmap', source: 'override' } });
      await expect(
        handleLocalApiRequest(
          {
            method: 'POST',
            path: '/v1/visualizations/render',
            body: {
              spec: { type: 'table' },
              columns: ['name', 'value'],
              rows: [['a', 1]],
              sourceArtifactId: newSortableId(),
            },
          },
          api,
        ),
      ).resolves.toMatchObject({
        statusCode: 200,
        body: { status: 'rendered', title: expect.any(String) },
      });
      await expect(
        handleLocalApiRequest({ method: 'GET', path: '/v1/visualizations/catalog' }, api),
      ).resolves.toMatchObject({
        statusCode: 200,
        body: {
          schemaVersion: 1,
          resourceType: 'visualization',
          available: true,
          types: expect.arrayContaining(['table', 'bar', 'time-series']),
          operations: expect.arrayContaining(['discover', 'invoke', 'inspect']),
        },
      });
      await expect(
        handleLocalApiRequest({ method: 'GET', path: '/v1/workspace/intake' }, api),
      ).resolves.toMatchObject({
        statusCode: 200,
        body: {
          inbox: [
            expect.objectContaining({
              path: '.spyderbyte/inbox/customers.csv',
              classification: 'data',
            }),
          ],
          watch: [
            expect.objectContaining({
              path: '.spyderbyte/watch/analysis.ipynb',
              classification: 'notebook',
            }),
          ],
          recommendations: expect.arrayContaining([
            expect.objectContaining({ actions: expect.arrayContaining(['publish artifact']) }),
            expect.objectContaining({ actions: expect.arrayContaining(['open notebook']) }),
          ]),
        },
      });
      await expect(
        handleLocalApiRequest({ method: 'GET', path: '/v1/workspace/context' }, api),
      ).resolves.toMatchObject({
        statusCode: 200,
        body: { schemaVersion: 1, intake: expect.any(Object) },
      });
      expect(await readFile(join(root, '.spyderbyte', 'inbox', 'customers.csv'), 'utf8')).toContain(
        'value',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
