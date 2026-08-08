import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FileExperimentRuntime,
  experimentPromotionDigest,
  type LocalExperimentDefinitionInputV1,
} from '../src/index.js';
import {
  newSortableId,
  type ArtifactReference,
  type HashSha256,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';

const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };

function artifact(): ArtifactReference {
  return {
    schemaVersion: 1,
    tenant,
    artifactId: newSortableId(),
    version: 1,
    contentHash: 'a'.repeat(64) as HashSha256,
    mediaType: 'application/json',
    sizeBytes: 1,
    createdAt: '2026-08-06T00:00:00.000Z',
  };
}

function definition(): LocalExperimentDefinitionInputV1 {
  return {
    tenant,
    name: 'Phase 5 fixture experiment',
    datasetVersion: artifact(),
    target: 'label',
    features: ['feature_a', 'feature_b'],
    task: 'classification',
    algorithm: 'fixture-adapter',
    environmentRevision: artifact(),
    compute: {
      cpuMillicores: 100,
      memoryBytes: 1024 * 1024,
      gpuCount: 0,
      maxDurationMs: 10_000,
      estimatedCostMinor: 5,
      currency: 'USD',
    },
    metrics: [{ name: 'accuracy', higherIsBetter: true, requiredMinimum: 0.8 }],
    hyperparameters: { epochs: 1 },
    seed: 42,
    outputDestination: 'artifacts://phase5',
    environmentLockfile: '{"lockfile":"fixture"}',
  };
}

async function waitForRun(
  runtime: FileExperimentRuntime,
  runId: string,
): Promise<
  Awaited<ReturnType<FileExperimentRuntime['getRun']>> extends infer T
    ? Exclude<T, undefined>
    : never
> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await runtime.getRun(tenant, runId as never);
    if (
      run !== undefined &&
      ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(run.status)
    ) {
      return run as never;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`run ${runId} did not finish`);
}

async function waitForStatus(
  runtime: FileExperimentRuntime,
  runId: string,
  statuses: readonly string[],
): Promise<NonNullable<Awaited<ReturnType<FileExperimentRuntime['getRun']>>>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await runtime.getRun(tenant, runId as never);
    if (run !== undefined && statuses.includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`run ${runId} did not reach ${statuses.join(', ')}`);
}

describe('FileExperimentRuntime Phase 5 lifecycle', () => {
  it('trains two variants, persists telemetry/artifacts, compares, evaluates, and promotes with lineage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-phase5-experiments-'));
    const script = [
      "const fs=require('node:fs');",
      "const input=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));",
      "const score=input.configuration.variantId==='variant-a'?0.91:0.83;",
      "fs.writeFileSync(process.argv[2],JSON.stringify({metrics:{accuracy:score},events:[{type:'epoch',epoch:1},{type:'metric',name:'loss',value:1-score,step:1},{type:'resource',memoryBytes:4096}],checkpoint:{variant:input.configuration.variantId},output:{featureImportance:{feature_a:0.7,feature_b:0.3},confusionMatrix:[[2,0],[0,2]]}}));",
    ].join('');
    const runtime = new FileExperimentRuntime({
      rootPath: root,
      command: process.execPath,
      args: ['-e', script, '%INPUT%', '%OUTPUT%'],
      clock: () => '2026-08-06T00:00:00.000Z',
    });
    const created = await runtime.create(definition());
    await expect(runtime.validate(tenant, created.experimentId)).resolves.toMatchObject({
      state: 'ready',
    });
    const first = await runtime.start({
      tenant,
      experimentId: created.experimentId,
      variantId: 'variant-a',
    });
    const second = await runtime.start({
      tenant,
      experimentId: created.experimentId,
      variantId: 'variant-b',
    });
    const firstDone = await waitForRun(runtime, first.runId);
    const secondDone = await waitForRun(runtime, second.runId);
    expect(firstDone.status).toBe('succeeded');
    expect(secondDone.status).toBe('succeeded');
    expect(firstDone.attempts).toHaveLength(1);
    expect(firstDone.events.map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        'provisioning',
        'started',
        'epoch',
        'metric',
        'resource',
        'completed',
      ]),
    );
    expect(firstDone.artifacts.map((item) => item.kind)).toEqual(
      expect.arrayContaining(['checkpoint', 'metrics', 'plot', 'report', 'environment-lockfile']),
    );

    const comparison = await runtime.compare(tenant, { runIds: [first.runId, second.runId] });
    expect(comparison).toMatchObject({
      immutable: true,
      metrics: { accuracy: expect.any(Object) },
      curves: { loss: expect.any(Object) },
      explainability: { [first.runId]: { feature_a: 0.7 } },
    });
    const evaluation = await runtime.evaluate(tenant, {
      runId: first.runId,
      benchmarkId: 'phase5-benchmark',
      benchmarkVersion: 1,
      observations: [
        { expected: 1, candidate: 1 },
        { expected: 1, candidate: 1 },
        { expected: 0, candidate: 0 },
      ],
      metrics: [{ name: 'accuracy', higherIsBetter: true, requiredMinimum: 0.8 }],
    });
    expect(evaluation.recommendation).toBe('promote');
    const model = await runtime.registerCandidate(tenant, {
      runId: first.runId,
      modelName: 'phase5-model',
      modelCard: {
        summary: 'Fixture model',
        intendedUse: 'Lifecycle verification',
        limitations: ['Fixture data'],
        risks: ['Not production trained'],
      },
    });
    const validated = await runtime.validateModel(tenant, {
      modelVersionId: model.modelVersionId,
      evaluationId: evaluation.evaluationId,
    });
    expect(validated).toMatchObject({ stage: 'validated', validation: { state: 'passed' } });
    const digest = validated.approval.digest;
    expect(digest).toEqual(experimentPromotionDigest(validated, evaluation));
    const decision = await runtime.promoteModel(tenant, {
      modelVersionId: model.modelVersionId,
      policyApproved: true,
      approvalDigest: digest as string,
      commitApprovalDigest: digest as string,
      reason: 'Phase 5 acceptance fixture',
    });
    expect(decision).toMatchObject({ to: 'production', policyApproved: true, immutable: true });
    await expect(runtime.getModel(tenant, model.modelVersionId)).resolves.toMatchObject({
      stage: 'production',
      deploymentHistory: [expect.objectContaining({ stage: 'production', status: 'promoted' })],
    });

    const restarted = new FileExperimentRuntime({
      rootPath: root,
      command: process.execPath,
      args: ['-e', script, '%INPUT%', '%OUTPUT%'],
    });
    await expect(restarted.get(tenant, created.experimentId)).resolves.toMatchObject({
      state: 'promoted',
    });
    await expect(restarted.getComparison(tenant, comparison.comparisonId)).resolves.toMatchObject({
      immutable: true,
    });
    await expect(restarted.getModel(tenant, model.modelVersionId)).resolves.toMatchObject({
      stage: 'production',
    });
    await expect(
      restarted.getArtifact(tenant, firstDone.artifacts[0]?.artifactId as never),
    ).resolves.toMatchObject({
      artifact: { immutable: true },
    });
  });

  it('cancels, retries, records failures, and recovers interrupted runs after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-phase5-recovery-'));
    const retryScript = [
      "const fs=require('node:fs');",
      "if(process.env.SPYDERBYTE_EXPERIMENT_ATTEMPT==='1'){setTimeout(()=>{},10000);}else{fs.writeFileSync(process.argv[2],JSON.stringify({metrics:{accuracy:0.9},events:[{type:'metric',name:'accuracy',value:0.9,step:1}]}));}",
    ].join('');
    const runtime = new FileExperimentRuntime({
      rootPath: root,
      command: process.execPath,
      args: ['-e', retryScript, '%INPUT%', '%OUTPUT%'],
    });
    const created = await runtime.create({ ...definition(), name: 'Phase 5 retry fixture' });
    await runtime.validate(tenant, created.experimentId);
    const cancelled = await runtime.start({
      tenant,
      experimentId: created.experimentId,
      variantId: 'cancel-me',
    });
    await waitForStatus(runtime, cancelled.runId, ['running']);
    const cancelledRun = await runtime.cancel(tenant, cancelled.runId);
    expect(cancelledRun).toMatchObject({ status: 'cancelled' });
    expect(cancelledRun.events.some((event) => event.kind === 'cancelled')).toBe(true);

    const retried = await runtime.retry(tenant, cancelled.runId);
    const retriedRun = await waitForRun(runtime, retried.runId);
    expect(retriedRun.status).toBe('succeeded');
    expect(retriedRun.attempts).toHaveLength(2);
    expect(retriedRun.events.some((event) => event.kind === 'retry')).toBe(true);

    const failingRoot = await mkdtemp(join(tmpdir(), 'spyderbyte-phase5-failure-'));
    const failingRuntime = new FileExperimentRuntime({
      rootPath: failingRoot,
      command: process.execPath,
      args: [
        '-e',
        "process.stderr.write('fixture failure');process.exit(3);",
        '%INPUT%',
        '%OUTPUT%',
      ],
    });
    const failingExperiment = await failingRuntime.create({
      ...definition(),
      name: 'Phase 5 failure fixture',
    });
    await failingRuntime.validate(tenant, failingExperiment.experimentId);
    const failed = await failingRuntime.start({
      tenant,
      experimentId: failingExperiment.experimentId,
      variantId: 'fails',
    });
    const failedRun = await waitForRun(failingRuntime, failed.runId);
    expect(failedRun.status).toBe('failed');
    expect(failedRun.error).toContain('fixture failure');
    expect(failedRun.events.at(-1)).toMatchObject({ kind: 'failure' });

    const recoveryRoot = await mkdtemp(join(tmpdir(), 'spyderbyte-phase5-restart-'));
    const recoveryScript = 'setTimeout(() => {}, 10000);';
    const activeRuntime = new FileExperimentRuntime({
      rootPath: recoveryRoot,
      command: process.execPath,
      args: ['-e', recoveryScript, '%INPUT%', '%OUTPUT%'],
    });
    const recoveryExperiment = await activeRuntime.create({
      ...definition(),
      name: 'Phase 5 restart fixture',
    });
    await activeRuntime.validate(tenant, recoveryExperiment.experimentId);
    const active = await activeRuntime.start({
      tenant,
      experimentId: recoveryExperiment.experimentId,
      variantId: 'interrupted',
    });
    await waitForStatus(activeRuntime, active.runId, ['running']);
    const restarted = new FileExperimentRuntime({ rootPath: recoveryRoot });
    const recovered = await waitForStatus(restarted, active.runId, ['failed']);
    expect(recovered.events.at(-1)).toMatchObject({
      kind: 'failure',
      payload: { recovered: true },
    });
    await activeRuntime.cancel(tenant, active.runId);
  });
});
