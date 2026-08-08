import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LocalAutomationRuntime,
  LocalDataCatalogRuntime,
  LocalNotebookRuntime,
  LocalPipelineRuntime,
  LocalQueryRuntime,
  LocalTrainingRuntime,
  MeltanoConnectorRuntime,
  ConnectorRegistry,
} from '../src/index.js';

async function pipelineRuntime(rootPath: string): Promise<LocalPipelineRuntime> {
  const query = new LocalQueryRuntime();
  const notebooks = new LocalNotebookRuntime(query, () => '2026-08-06T00:00:00.000Z');
  const connectors = new MeltanoConnectorRuntime({ rootPath });
  return new LocalPipelineRuntime({ rootPath, query, notebooks, connectors });
}

describe('P2 data and repeatability runtimes', () => {
  it('persists connections, immutable dataset versions, bounded query results, and lineage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-p2-data-'));
    const runtime = new LocalDataCatalogRuntime({ rootPath: root });
    const connection = await runtime.registerConnection({
      connectionId: 'sales-memory',
      name: 'Sales fixture',
      kind: 'memory',
      source: {
        tableName: 'sales',
        columns: ['label', 'score'],
        rows: [
          ['a', 1],
          ['b', 2],
        ],
      },
    });
    expect(connection).not.toHaveProperty('source');
    await expect(runtime.testConnection(connection.connectionId)).resolves.toMatchObject({
      status: 'passed',
    });
    await expect(runtime.browseSchema(connection.connectionId)).resolves.toMatchObject({
      tables: [{ tableName: 'sales', rowCount: 2 }],
    });

    const first = await runtime.publishDatasetVersion({
      datasetId: 'sales-dataset',
      name: 'Sales',
      connectionId: connection.connectionId,
      sourceReference: 'memory://sales',
    });
    const second = await runtime.publishDatasetVersion({
      datasetId: 'sales-dataset',
      name: 'Sales',
      connectionId: connection.connectionId,
      sourceReference: 'memory://sales',
      source: {
        tableName: 'sales',
        columns: ['label', 'score'],
        rows: [
          ['a', 1],
          ['b', 2],
          ['c', 3],
        ],
      },
    });
    expect(first).toMatchObject({ version: 1, immutable: true });
    expect(second).toMatchObject({ version: 2, immutable: true });
    expect(second.contentHash).not.toBe(first.contentHash);
    expect(second.lineage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relation: 'derived-from',
          reference: first.artifactId,
          version: 1,
        }),
      ]),
    );

    const query = await runtime.executeQuery({
      queryId: 'sales-query',
      datasetId: 'sales-dataset',
      sql: 'SELECT label, score FROM sales ORDER BY score',
    });
    expect(query).toMatchObject({
      datasetVersion: 2,
      result: { status: 'completed', rowCount: 3 },
    });
    expect(query.result.rows).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);

    const restarted = new LocalDataCatalogRuntime({ rootPath: root });
    await expect(restarted.listDatasetVersions('sales-dataset')).resolves.toHaveLength(2);
    await expect(restarted.getQueryResult('sales-query')).resolves.toMatchObject({
      datasetVersion: 2,
      result: { status: 'completed' },
    });
  });

  it('validates, plans, saves, and reloads pipeline-as-code inside the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-p2-pipeline-'));
    const runtime = await pipelineRuntime(root);
    const created = await runtime.create('pipeline-as-code', 'Pipeline as code');
    const definition = await runtime.upsert({
      ...created,
      stages: [
        {
          stageId: 'query',
          label: 'Read rows',
          type: 'query',
          dependsOn: [],
          config: { sql: 'SELECT 1 AS value' },
        },
      ],
    });
    await expect(runtime.plan(definition.pipelineId)).resolves.toMatchObject({
      executionOrder: ['query'],
      digest: expect.stringMatching(/^sha256:/),
    });
    const saved = await runtime.saveFile(definition.pipelineId, 'pipelines/sales.json');
    expect(saved.path).toBe(join(root, 'pipelines/sales.json'));

    const reloaded = await pipelineRuntime(root);
    await expect(reloaded.loadFile('pipelines/sales.json')).resolves.toMatchObject({
      pipelineId: definition.pipelineId,
      sourcePath: saved.path,
      sourceHash: saved.contentHash,
    });
    expect(
      reloaded.validate({
        ...definition,
        stages: undefined,
      } as unknown as typeof definition),
    ).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(['Pipeline stages must be an array']),
    });
  });

  it('retries automation runs, records notifications, and keeps connector checkpoints after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-p2-automation-'));
    const pipelines = await pipelineRuntime(root);
    await pipelines.create('retry-pipeline', 'Retry pipeline');
    const originalRun = pipelines.run.bind(pipelines);
    let attempts = 0;
    pipelines.run = async (pipelineId: string) => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient pipeline failure');
      return originalRun(pipelineId);
    };
    const delivered: string[] = [];
    const automations = new LocalAutomationRuntime({
      rootPath: root,
      pipelines,
      notificationSink: async (config) => {
        delivered.push(`${config.event}:${config.targetRef}`);
      },
    });
    await automations.create({
      automationId: 'retry-automation',
      name: 'Retry automation',
      pipelineId: 'retry-pipeline',
      trigger: { type: 'manual' },
      retryPolicy: { maxAttempts: 2, backoffMs: 0, maxBackoffMs: 0 },
      notifications: [
        { notificationId: 'retry', event: 'retrying', targetRef: 'test://retry' },
        { notificationId: 'success', event: 'succeeded', targetRef: 'test://success' },
      ],
    });
    const run = await automations.trigger('retry-automation');
    expect(run).toMatchObject({ status: 'completed', attempt: 2, maxAttempts: 2 });
    expect(delivered).toEqual(['retrying:test://retry', 'succeeded:test://success']);
    await expect(automations.listNotifications('retry-automation')).resolves.toEqual([
      expect.objectContaining({ event: 'retrying', status: 'sent' }),
      expect.objectContaining({ event: 'succeeded', status: 'sent' }),
    ]);
    const idempotentFirst = await automations.trigger('retry-automation', {
      idempotencyKey: 'manual-replay-1',
    });
    await expect(
      automations.trigger('retry-automation', { idempotencyKey: 'manual-replay-1' }),
    ).resolves.toMatchObject({ runId: idempotentFirst.runId });

    const script = join(root, 'meltano-stub.sh');
    await writeFile(
      script,
      '#!/bin/sh\nprintf \'%s\\n\' \'{"type":"STATE","stream":"users","value":"cursor-2"}\'\nprintf \'%s\\n\' \'{"type":"RECORD","stream":"users"}\'\n',
      { mode: 0o700 },
    );
    await chmod(script, 0o700);
    const manifest = new ConnectorRegistry().require('meltano-tap-postgres');
    const connector = new MeltanoConnectorRuntime({
      rootPath: root,
      executable: script,
      requireSignedRuntime: false,
      credentialResolver: async () => JSON.stringify({ host: 'localhost', database: 'fixture' }),
    });
    const connectorRun = await connector.execute({
      manifest,
      binding: {
        bindingId: 'binding-p2',
        connectorId: manifest.connectorId,
        connectionId: 'connection-p2',
        resources: ['schemas'],
        createdAt: '2026-08-06T00:00:00.000Z',
        updatedAt: '2026-08-06T00:00:00.000Z',
      },
      operation: 'incremental sync',
    });
    expect(connectorRun).toMatchObject({ status: 'completed', checkpointId: expect.any(String) });
    const restartedConnector = new MeltanoConnectorRuntime({
      rootPath: root,
      executable: script,
      requireSignedRuntime: false,
      credentialResolver: async () => JSON.stringify({ host: 'localhost', database: 'fixture' }),
    });
    expect(restartedConnector.getRun(connectorRun.runId)).toMatchObject({ status: 'completed' });
    expect(restartedConnector.getCheckpoint(connectorRun.checkpointId as string)).toMatchObject({
      cursor: 'cursor-2',
    });
  });

  it('recovers an interrupted training run as failed instead of leaving it running forever', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-p2-training-'));
    await mkdir(join(root, '.agentic'), { recursive: true });
    await writeFile(
      join(root, '.agentic', 'training-runs.json'),
      `${JSON.stringify([
        {
          runId: 'training-recovered',
          status: 'running',
          configuration: {},
          metrics: {},
          checkpointArtifacts: [],
        },
      ])}\n`,
    );
    const runtime = new LocalTrainingRuntime({ rootPath: root, command: process.execPath });
    await expect(runtime.list()).resolves.toMatchObject([
      {
        runId: 'training-recovered',
        status: 'failed',
        error: 'Training process was interrupted by a daemon restart',
      },
    ]);
  });
});
