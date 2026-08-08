import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProviderRuntime } from '@agentic-platform/provider-runtime';
import { newSortableId, type TenantRef } from '@agentic-platform/runtime-contracts';
import { handleLocalApiRequest, type LocalApiOptions } from '../src/index.js';

function options(rootPath: string): LocalApiOptions {
  const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
  return {
    orchestrator: {} as LocalApiOptions['orchestrator'],
    tenant,
    workspaceContext: { ...tenant, mode: 'personal_local' },
    providerRuntime: createProviderRuntime({ rootPath, useKeychain: false }),
  };
}

describe('Phase 4 data and SQL API journey', () => {
  it('exposes connection, schema, version, profile, quality, query, export, and handoff records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-phase4-api-'));
    const api = options(root);
    const created = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/data/connections',
        body: {
          connectionId: 'api-sales',
          name: 'API Sales',
          kind: 'memory',
          credentialRef: 'vault-api-sales',
          sourceReference: 'fixture://api-sales',
          source: {
            tableName: 'sales',
            columns: ['id', 'amount'],
            rows: [
              [1, 10],
              [2, 20],
            ],
          },
        },
      },
      api,
    );
    expect(created.statusCode).toBe(201);
    expect(created.body).toMatchObject({
      connectionId: 'api-sales',
      credentialStatus: 'bound',
      sourceReference: 'fixture://api-sales',
    });
    expect(created.body).not.toHaveProperty('source');

    await expect(
      handleLocalApiRequest({ method: 'GET', path: '/v1/data/sources' }, api),
    ).resolves.toMatchObject({
      statusCode: 200,
      body: [expect.objectContaining({ sourceId: 'source-api-sales' })],
    });
    await expect(
      handleLocalApiRequest({ method: 'GET', path: '/v1/data/connections/api-sales/schema' }, api),
    ).resolves.toMatchObject({
      statusCode: 200,
      body: {
        tables: [{ rowCount: 2 }],
        previewRows: [
          [1, 10],
          [2, 20],
        ],
      },
    });
    await expect(
      handleLocalApiRequest(
        {
          method: 'POST',
          path: '/v1/data/connections/api-sales/revoke-credential',
          body: {},
        },
        api,
      ),
    ).resolves.toMatchObject({ statusCode: 200, body: { credentialStatus: 'revoked' } });
    await expect(
      handleLocalApiRequest(
        {
          method: 'POST',
          path: '/v1/data/connections/api-sales/reauthorize',
          body: { credentialRef: 'vault-api-sales-2' },
        },
        api,
      ),
    ).resolves.toMatchObject({ statusCode: 200, body: { credentialStatus: 'bound' } });

    const version = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/datasets/local/versions',
        body: {
          datasetId: 'api-sales-dataset',
          name: 'API Sales Dataset',
          connectionId: 'api-sales',
          sourceReference: 'fixture://api-sales',
        },
      },
      api,
    );
    expect(version).toMatchObject({ statusCode: 201, body: { version: 1, immutable: true } });
    await expect(
      handleLocalApiRequest(
        {
          method: 'POST',
          path: '/v1/datasets/local/api-sales-dataset/profile',
          body: { version: 1 },
        },
        api,
      ),
    ).resolves.toMatchObject({ statusCode: 200, body: { datasetVersion: 1, rowCount: 2 } });
    await expect(
      handleLocalApiRequest(
        {
          method: 'POST',
          path: '/v1/datasets/local/api-sales-dataset/quality',
          body: { requiredFields: ['id', 'amount'], maxNullFraction: 0.2 },
        },
        api,
      ),
    ).resolves.toMatchObject({ statusCode: 200, body: { status: 'passed' } });
    await expect(
      handleLocalApiRequest(
        { method: 'GET', path: '/v1/datasets/local/api-sales-dataset/profile?version=1' },
        api,
      ),
    ).resolves.toMatchObject({
      statusCode: 200,
      body: { profileId: 'profile-api-sales-dataset-v1' },
    });
    await expect(
      handleLocalApiRequest(
        { method: 'GET', path: '/v1/datasets/local/api-sales-dataset/quality?version=1' },
        api,
      ),
    ).resolves.toMatchObject({
      statusCode: 200,
      body: { qualityId: 'quality-api-sales-dataset-v1' },
    });

    const query = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/data/queries',
        body: {
          queryId: 'api-sales-query',
          datasetId: 'api-sales-dataset',
          sql: 'SELECT id, amount FROM sales ORDER BY id',
          maxRows: 10,
          costLimit: 10,
        },
      },
      api,
    );
    expect(query).toMatchObject({
      statusCode: 200,
      body: { datasetVersion: 1, result: { status: 'completed', rowCount: 2 } },
    });
    await expect(
      handleLocalApiRequest(
        {
          method: 'POST',
          path: '/v1/data/queries/api-sales-query/validate',
          body: { sql: 'DELETE FROM sales' },
        },
        api,
      ),
    ).resolves.toMatchObject({
      statusCode: 200,
      body: { valid: false, approvalRequired: true },
    });
    await expect(
      handleLocalApiRequest(
        {
          method: 'POST',
          path: '/v1/data/queries/api-sales-query/explain',
          body: { datasetId: 'api-sales-dataset', sql: 'SELECT * FROM sales' },
        },
        api,
      ),
    ).resolves.toMatchObject({ statusCode: 200, body: { estimatedCost: expect.any(Number) } });
    await expect(
      handleLocalApiRequest({ method: 'GET', path: '/v1/data/queries/api-sales-query' }, api),
    ).resolves.toMatchObject({ statusCode: 200, body: { result: { status: 'completed' } } });
    await expect(
      handleLocalApiRequest(
        {
          method: 'POST',
          path: '/v1/data/queries/api-sales-query/export',
          body: { format: 'json' },
        },
        api,
      ),
    ).resolves.toMatchObject({
      statusCode: 201,
      body: { format: 'json', mediaType: 'application/json' },
    });
    await expect(
      handleLocalApiRequest(
        {
          method: 'POST',
          path: '/v1/data/queries/api-sales-query/handoff',
          body: { target: 'jupyter' },
        },
        api,
      ),
    ).resolves.toMatchObject({ statusCode: 201, body: { target: 'jupyter', datasetVersion: 1 } });

    await expect(
      handleLocalApiRequest(
        {
          method: 'POST',
          path: '/v1/data/saved-queries',
          body: {
            savedQueryId: 'api-saved-query',
            name: 'API saved query',
            datasetId: 'api-sales-dataset',
            sql: 'SELECT * FROM sales',
          },
        },
        api,
      ),
    ).resolves.toMatchObject({ statusCode: 201, body: { revision: 1 } });
    await expect(
      handleLocalApiRequest({ method: 'GET', path: '/v1/data/saved-queries' }, api),
    ).resolves.toMatchObject({ statusCode: 200, body: [{ savedQueryId: 'api-saved-query' }] });
  });
});
