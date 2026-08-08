import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalDataCatalogRuntime } from '../src/index.js';

describe('Phase 4 data and SQL loop', () => {
  it('migrates legacy catalog records to durable v1 state before serving them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-phase4-data-migration-'));
    const statePath = join(root, '.agentic', 'data-catalog.json');
    await mkdir(join(root, '.agentic'), { recursive: true });
    await writeFile(
      statePath,
      `${JSON.stringify({
        connections: [
          {
            connectionId: 'legacy-connection',
            name: 'Legacy sales',
            kind: 'memory',
            credentialRef: 'vault-legacy',
            source: {
              columns: ['id', 'value'],
              rows: [[1, 'ok']],
            },
          },
        ],
      })}\n`,
    );

    const runtime = new LocalDataCatalogRuntime({
      rootPath: root,
      clock: () => '2026-08-07T00:00:00.000Z',
    });
    await expect(runtime.getConnection('legacy-connection')).resolves.toMatchObject({
      schemaVersion: 1,
      connectionId: 'legacy-connection',
      sourceId: 'source-legacy-connection',
      sourceReference: 'migrated://legacy-connection',
      credentialStatus: 'bound',
      status: 'configured',
      createdAt: '2026-08-07T00:00:00.000Z',
      updatedAt: '2026-08-07T00:00:00.000Z',
    });
    await expect(runtime.listSources()).resolves.toMatchObject([
      {
        schemaVersion: 1,
        sourceId: 'source-legacy-connection',
        connectionId: 'legacy-connection',
        sourceReference: 'migrated://legacy-connection',
      },
    ]);
    await expect(runtime.browseSchema('legacy-connection')).resolves.toMatchObject({
      previewRows: [[1, 'ok']],
    });

    const persisted = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      schemaVersion: 1,
      connections: [
        expect.objectContaining({
          schemaVersion: 1,
          credentialStatus: 'bound',
          sourceId: 'source-legacy-connection',
        }),
      ],
      sources: [expect.objectContaining({ schemaVersion: 1 })],
      datasets: [],
      queries: [],
      profiles: [],
      qualityResults: [],
      savedQueries: [],
      exports: [],
      handoffs: [],
    });

    const restarted = new LocalDataCatalogRuntime({
      rootPath: root,
      clock: () => '2026-08-07T00:01:00.000Z',
    });
    await expect(restarted.getConnection('legacy-connection')).resolves.toMatchObject({
      schemaVersion: 1,
      sourceId: 'source-legacy-connection',
      credentialStatus: 'bound',
    });
  });

  it('connects, discovers, profiles, quality-checks, queries, versions, exports, and hands off data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-phase4-data-'));
    const runtime = new LocalDataCatalogRuntime({ rootPath: root });
    const connection = await runtime.registerConnection({
      connectionId: 'sales-connection',
      name: 'Sales fixture',
      kind: 'memory',
      credentialRef: 'vault-sales-ref',
      sourceReference: 'fixture://sales',
      source: {
        tableName: 'sales',
        columns: ['id', 'score', 'label'],
        rows: [
          [1, 10, 'a'],
          [2, null, 'b'],
          [3, 30, 'c'],
        ],
      },
    });

    expect(connection).toMatchObject({
      credentialStatus: 'bound',
      sourceId: 'source-sales-connection',
      sourceReference: 'fixture://sales',
    });
    expect(connection).not.toHaveProperty('source');
    expect(connection).not.toHaveProperty('secret');
    await expect(runtime.listSources()).resolves.toMatchObject([
      { sourceId: 'source-sales-connection', status: 'configured' },
    ]);
    await expect(runtime.testConnection(connection.connectionId)).resolves.toMatchObject({
      status: 'passed',
    });
    const schema = await runtime.browseSchema(connection.connectionId);
    expect(schema.previewRows).toHaveLength(3);
    expect(schema.tables[0]?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'score',
          nullable: true,
          statistics: expect.objectContaining({ nullCount: 1, mean: 20 }),
        }),
      ]),
    );

    await expect(runtime.revokeCredential(connection.connectionId)).resolves.toMatchObject({
      credentialStatus: 'revoked',
    });
    await expect(
      runtime.reauthorizeCredential(connection.connectionId, 'vault-sales-ref-2'),
    ).resolves.toMatchObject({ credentialStatus: 'bound', credentialRef: 'vault-sales-ref-2' });

    const version = await runtime.publishDatasetVersion({
      datasetId: 'sales-dataset',
      name: 'Sales',
      connectionId: connection.connectionId,
      sourceReference: 'fixture://sales',
    });
    expect(version).toMatchObject({ version: 1, immutable: true, rowCount: 3 });

    const profile = await runtime.profileDataset('sales-dataset', 1);
    expect(profile).toMatchObject({
      datasetId: 'sales-dataset',
      datasetVersion: 1,
      fields: expect.arrayContaining([
        expect.objectContaining({ name: 'score', nullCount: 1, mean: 20 }),
      ]),
    });
    const quality = await runtime.qualityDataset({
      datasetId: 'sales-dataset',
      requiredFields: ['id', 'label'],
      maxNullFraction: 0.4,
    });
    expect(quality).toMatchObject({ status: 'warned', rowCount: 3 });
    expect(quality.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: 'null-rate:score', status: 'warned' }),
      ]),
    );

    const query = await runtime.executeQuery({
      queryId: 'sales-query',
      datasetId: 'sales-dataset',
      sql: 'SELECT id, score FROM sales ORDER BY id',
      maxRows: 2,
      costLimit: 10,
    });
    expect(query).toMatchObject({
      datasetVersion: 1,
      result: { status: 'completed', rowCount: 2, truncated: true },
    });
    expect(query.result.estimatedCost).toBeGreaterThan(0);
    await expect(
      runtime.explainQuery({
        queryId: 'sales-query',
        datasetId: 'sales-dataset',
        sql: 'SELECT id FROM sales',
      }),
    ).resolves.toMatchObject({
      queryId: 'sales-query',
      estimatedCost: expect.any(Number),
      steps: expect.any(Array),
    });

    await expect(
      runtime.saveQuery({
        savedQueryId: 'saved-sales',
        name: 'Sales rows',
        datasetId: 'sales-dataset',
        sql: 'SELECT * FROM sales',
      }),
    ).resolves.toMatchObject({ revision: 1 });
    await expect(
      runtime.saveQuery({
        savedQueryId: 'saved-sales',
        name: 'Sales rows v2',
        datasetId: 'sales-dataset',
        sql: 'SELECT id FROM sales',
      }),
    ).resolves.toMatchObject({ revision: 2, name: 'Sales rows v2' });

    const exported = await runtime.exportQueryResult('sales-query', 'csv');
    expect(exported).toMatchObject({ format: 'csv', mediaType: 'text/csv' });
    await expect(readFile(exported.path, 'utf8')).resolves.toContain('id,score');
    await expect(runtime.createQueryHandoff('sales-query', 'browser')).resolves.toMatchObject({
      target: 'browser',
      route: '/sql?queryId=sales-query',
      datasetVersion: 1,
    });
    await expect(runtime.createQueryHandoff('sales-query', 'jupyter')).resolves.toMatchObject({
      target: 'jupyter',
    });

    await expect(
      runtime.executeQuery({
        queryId: 'destructive-query',
        datasetId: 'sales-dataset',
        sql: 'DELETE FROM sales',
      }),
    ).rejects.toThrow(/read-only/i);
    await expect(
      runtime.executeQuery({
        queryId: 'over-budget-query',
        datasetId: 'sales-dataset',
        sql: 'SELECT * FROM sales',
        costLimit: 0,
      }),
    ).rejects.toThrow(/cost/i);

    const restarted = new LocalDataCatalogRuntime({ rootPath: root });
    await expect(restarted.listSources()).resolves.toHaveLength(1);
    await expect(restarted.getDatasetProfile('sales-dataset', 1)).resolves.toMatchObject({
      profileId: 'profile-sales-dataset-v1',
    });
    await expect(restarted.getDatasetQuality('sales-dataset', 1)).resolves.toMatchObject({
      qualityId: 'quality-sales-dataset-v1',
    });
    await expect(restarted.listSavedQueries()).resolves.toMatchObject([
      { savedQueryId: 'saved-sales', revision: 2 },
    ]);
    await expect(restarted.getQueryResult('sales-query')).resolves.toMatchObject({
      result: { status: 'completed' },
    });
  });
});
