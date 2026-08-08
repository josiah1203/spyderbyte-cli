import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConnectorRegistry,
  LocalAutomationRuntime,
  LocalNotebookRuntime,
  LocalPipelineRuntime,
  LocalQueryRuntime,
  MeltanoConnectorRuntime,
  type PipelineStageAdapter,
} from '../src/index.js';

async function pipelineRuntime(rootPath: string, adapters?: readonly PipelineStageAdapter[]) {
  const query = new LocalQueryRuntime();
  const notebooks = new LocalNotebookRuntime(query);
  const connectors = new MeltanoConnectorRuntime({ rootPath });
  return new LocalPipelineRuntime({ rootPath, query, notebooks, connectors, adapters });
}

describe('Phase 6 pipelines, automations, and connectors', () => {
  it('publishes typed pipeline versions and records dry-run, cache, idempotency, and usage evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-phase6-pipeline-'));
    const runtime = await pipelineRuntime(root);
    const created = await runtime.create('phase6-pipeline', 'Phase 6 pipeline');
    const definition = await runtime.upsert({
      ...created,
      stages: [
        {
          stageId: 'sql',
          label: 'SQL source',
          type: 'sql',
          dependsOn: [],
          config: { sql: 'SELECT 1 AS value', estimatedCostMinor: 2 },
        },
        {
          stageId: 'inference',
          label: 'Inference adapter',
          type: 'inference',
          dependsOn: ['sql'],
          config: { model: 'fixture-model', estimatedCostMinor: 3 },
        },
        {
          stageId: 'artifact',
          label: 'Artifact transformation',
          type: 'artifact-transformation',
          dependsOn: ['inference'],
          config: { artifactId: 'artifact-phase6' },
        },
      ],
    });
    expect(runtime.validate(definition)).toMatchObject({
      valid: true,
      executionOrder: ['sql', 'inference', 'artifact'],
    });
    const published = await runtime.publish(definition.pipelineId);
    expect(published).toMatchObject({
      version: definition.version,
      digest: expect.stringMatching(/^sha256:/),
    });
    await expect(runtime.listVersions(definition.pipelineId)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ version: definition.version })]),
    );
    await expect(runtime.estimate(definition.pipelineId, 'published')).resolves.toMatchObject({
      costMinor: 5,
      durationMs: expect.any(Number),
    });
    const dryRun = await runtime.dryRun(definition.pipelineId, { inputs: { source: 'fixture' } });
    expect(dryRun).toMatchObject({
      status: 'completed',
      dryRun: true,
      inputs: { source: 'fixture' },
    });
    expect(dryRun.stageResults.every((stage) => stage.status === 'skipped')).toBe(true);

    const first = await runtime.run(definition.pipelineId, {
      inputs: { source: 'fixture' },
      idempotencyKey: 'phase6-run-1',
    });
    const duplicate = await runtime.run(definition.pipelineId, {
      inputs: { source: 'fixture' },
      idempotencyKey: 'phase6-run-1',
    });
    expect(first).toMatchObject({
      status: 'completed',
      artifacts: ['artifact-phase6'],
      usage: { costMinor: 5 },
    });
    expect(duplicate.runId).toBe(first.runId);
    const cached = await runtime.run(definition.pipelineId, { inputs: { source: 'fixture' } });
    expect(cached.stageResults.find((stage) => stage.stageId === 'sql')).toMatchObject({
      status: 'completed',
      cacheHit: true,
    });
  });

  it('retries a registered adapter and marks dependent nodes when a dependency fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-phase6-retry-'));
    let calls = 0;
    const adapter: PipelineStageAdapter = {
      type: 'inference',
      version: 'fixture.inference.v1',
      execute: async () => {
        calls += 1;
        if (calls === 1) throw new Error('transient inference failure');
        return { output: { ok: true } };
      },
    };
    const runtime = await pipelineRuntime(root, [adapter]);
    const created = await runtime.create('retry-pipeline', 'Retry pipeline');
    const definition = await runtime.upsert({
      ...created,
      stages: [
        {
          stageId: 'inference',
          label: 'Retry inference',
          type: 'inference',
          dependsOn: [],
          retryPolicy: { maxAttempts: 2, backoffMs: 0, maxBackoffMs: 0 },
          config: {},
        },
        {
          stageId: 'evaluation',
          label: 'Dependent evaluation',
          type: 'evaluation',
          dependsOn: ['inference'],
          config: {},
        },
      ],
    });
    const retried = await runtime.run(definition.pipelineId);
    expect(retried).toMatchObject({ status: 'completed' });
    expect(retried.stageResults[0]).toMatchObject({ status: 'completed', attempt: 2 });

    const failing = await pipelineRuntime(join(root, 'failing'));
    const failingCreated = await failing.create('dependency-pipeline', 'Dependency pipeline');
    const failingDefinition = await failing.upsert({
      ...failingCreated,
      stages: [
        {
          stageId: 'bad',
          label: 'Bad node',
          type: 'inference',
          dependsOn: [],
          config: { fail: true },
        },
        {
          stageId: 'downstream',
          label: 'Downstream',
          type: 'evaluation',
          dependsOn: ['bad'],
          config: {},
        },
      ],
    });
    const failed = await failing.run(failingDefinition.pipelineId);
    expect(failed).toMatchObject({ status: 'failed' });
    expect(failed.stageResults.find((stage) => stage.stageId === 'downstream')).toMatchObject({
      status: 'skipped',
      dependencyFailure: true,
    });
  });

  it('supports cron, data-arrival, repository, idempotent dispatch, and bounded backfill', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-phase6-automation-'));
    let currentTime = '2026-08-06T00:00:00.000Z';
    const pipelines = await pipelineRuntime(root);
    await pipelines.create('automation-pipeline', 'Automation pipeline');
    const automations = new LocalAutomationRuntime({
      rootPath: root,
      pipelines,
      clock: () => currentTime,
    });
    const cron = await automations.create({
      automationId: 'cron-automation',
      name: 'Cron automation',
      pipelineId: 'automation-pipeline',
      trigger: { type: 'cron', expression: '*/5 * * * *', timezone: 'UTC' },
      maxBackfillRuns: 2,
    });
    expect(cron.nextRunAt).toBe('2026-08-06T00:05:00.000Z');
    currentTime = '2026-08-06T00:06:00.000Z';
    await automations.tick();
    await expect(automations.listRuns(cron.automationId)).resolves.toHaveLength(1);

    const data = await automations.create({
      automationId: 'data-automation',
      name: 'Data arrival',
      pipelineId: 'automation-pipeline',
      trigger: { type: 'data-arrival', sourceRef: 'dataset://sales', eventName: 'ready' },
      maxBackfillRuns: 2,
    });
    const arrival = { sourceRef: 'dataset://sales', eventName: 'ready', payload: { version: 2 } };
    await expect(automations.receiveDataArrival(arrival)).resolves.toHaveLength(1);
    await expect(automations.receiveDataArrival(arrival)).resolves.toHaveLength(1);
    await expect(automations.listRuns(data.automationId)).resolves.toHaveLength(1);
    await expect(automations.backfill(data.automationId, { count: 2 })).resolves.toHaveLength(2);
    await expect(automations.backfill(data.automationId, { count: 3 })).rejects.toThrow(
      'between 1 and 2',
    );

    const repository = await automations.create({
      automationId: 'repository-automation',
      name: 'Repository trigger',
      pipelineId: 'automation-pipeline',
      trigger: { type: 'repository', repositoryId: 'repo-1', eventName: 'push', branch: 'main' },
    });
    await expect(
      automations.receiveRepositoryEvent({
        repositoryId: 'repo-1',
        eventName: 'push',
        branch: 'main',
      }),
    ).resolves.toHaveLength(1);
    await expect(automations.listRuns(repository.automationId)).resolves.toHaveLength(1);
  });

  it('persists connector schema events, checkpoints, lineage, and idempotent runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-phase6-connector-'));
    const script = join(root, 'meltano-stub.sh');
    const writeScript = async (stream: string): Promise<void> => {
      await writeFile(
        script,
        `#!/bin/sh\nprintf '%s\\n' '{"streams":[{"tap_stream_id":"${stream}","schema":{"properties":{"id":{"type":"string"}}}}]}'\nprintf '%s\\n' '{"type":"STATE","stream":"${stream}","value":"cursor-2"}'\nprintf '%s\\n' '{"type":"RECORD","stream":"${stream}"}'\n`,
        { mode: 0o700 },
      );
      await chmod(script, 0o700);
    };
    await writeScript('users');
    const manifest = new ConnectorRegistry().require('meltano-tap-postgres');
    const runtime = new MeltanoConnectorRuntime({
      rootPath: root,
      executable: script,
      requireSignedRuntime: false,
      credentialResolver: async () => JSON.stringify({ host: 'localhost', database: 'fixture' }),
    });
    const binding = {
      bindingId: 'phase6-binding',
      connectorId: manifest.connectorId,
      connectionId: 'phase6-connection',
      resources: ['schemas'],
      syncMode: 'incremental' as const,
      destination: 'artifact://phase6',
      createdAt: '2026-08-06T00:00:00.000Z',
      updatedAt: '2026-08-06T00:00:00.000Z',
    };
    await expect(runtime.discover({ manifest, binding })).resolves.toMatchObject({
      status: 'ready',
      schemaFingerprint: expect.stringMatching(/^sha256:/),
      schemaChangeEventIds: [expect.any(String)],
    });
    await expect(runtime.discover({ manifest, binding })).resolves.not.toHaveProperty(
      'schemaChangeEventIds',
    );
    await writeScript('accounts');
    await runtime.discover({ manifest, binding });
    expect(runtime.listSchemaChangeEvents()).toHaveLength(2);
    const first = await runtime.execute({
      manifest,
      binding,
      operation: 'incremental sync',
      idempotencyKey: 'connector-sync-1',
    });
    const duplicate = await runtime.execute({
      manifest,
      binding,
      operation: 'incremental sync',
      idempotencyKey: 'connector-sync-1',
    });
    expect(duplicate.runId).toBe(first.runId);
    expect(first).toMatchObject({
      status: 'completed',
      checkpointId: expect.any(String),
      lineage: { destination: 'artifact://phase6', artifactIds: expect.any(Array) },
      schemaFingerprint: expect.stringMatching(/^sha256:/),
    });
    expect(runtime.getCheckpoint(first.checkpointId as string)).toMatchObject({
      bindingId: 'phase6-binding',
      destination: 'artifact://phase6',
    });
  });
});
