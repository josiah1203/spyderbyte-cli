import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { newSortableId, type TenantRef, type Workflow } from '@agentic-platform/runtime-contracts';
import { InMemoryStateStore } from '@agentic-platform/state';
import {
  DurableWorkflowEngine,
  EventSubscriptionGateway,
  ExternalWorkflowEngine,
  type ExternalWorkflowClient,
  type WorkflowEngineState,
} from '../src/index.js';

const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
const workflowId = newSortableId();
const now = '2026-08-02T00:00:00.000Z';
const workflow: Workflow = {
  schemaVersion: 1,
  workflowId,
  tenant,
  objective: 'durable fixture',
  state: 'executing',
  planVersion: 1,
  createdAt: now,
  updatedAt: now,
  invocationIds: [],
  completionCriteria: ['activity completes'],
};

describe('DurableWorkflowEngine', () => {
  it('persists engine state, resumes a scheduled activity in a new engine instance, and deduplicates start', async () => {
    const state = new InMemoryStateStore();
    await state.transaction((transaction) =>
      transaction.workflows.create(tenant, workflowId, workflow, now),
    );
    const first = new DurableWorkflowEngine({ state, clock: () => now });
    const handle = await first.start({ tenant, workflowId, definitionVersion: 'workflow.v1', now });
    const secondHandle = await first.start({
      tenant,
      workflowId,
      definitionVersion: 'workflow.v1',
      now,
    });
    expect(secondHandle.engineWorkflowId).toBe(handle.engineWorkflowId);
    await first.scheduleActivity(handle, {
      activityId: 'validate',
      name: 'validate',
      input: { source: 'fixture' },
      ownerTier: 2,
      maxAttempts: 2,
      retryableFailureCodes: ['TRANSIENT'],
    });
    const restarted = new DurableWorkflowEngine({ state, clock: () => now });
    restarted.registerActivity('validate', async () => ({ ok: true }));
    const result = await restarted.resumeAfterRestart(handle);
    expect(result.status).toBe('running');
    expect(result.activity?.status).toBe('succeeded');
    expect((await restarted.query(handle)).activity?.result).toEqual({ ok: true });
  });

  it('propagates cancellation and ignores a late activity completion', async () => {
    const state = new InMemoryStateStore();
    await state.transaction((transaction) =>
      transaction.workflows.create(tenant, workflowId, workflow, now),
    );
    const engine = new DurableWorkflowEngine({ state, clock: () => now });
    const handle = await engine.start({
      tenant,
      workflowId,
      definitionVersion: 'workflow.v1',
      now,
    });
    await engine.scheduleActivity(handle, {
      activityId: 'cancel-me',
      name: 'cancel-me',
      input: null,
      ownerTier: 2,
      maxAttempts: 1,
      retryableFailureCodes: [],
    });
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aborted = false;
    engine.registerActivity('cancel-me', async (_input, _attempt, signal) => {
      started();
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new Error('activity aborted'));
          },
          { once: true },
        );
      });
    });
    const recovery = engine.resumeAfterRestart(handle);
    await startedPromise;
    await engine.cancel(handle, 'user requested cancellation');
    const recovered = await recovery;
    expect(aborted).toBe(true);
    expect(recovered.status).toBe('cancelled');
    expect((await engine.query(handle)).status).toBe('cancelled');
  });

  it('records retry ownership and the successful attempt after a transient failure', async () => {
    const state = new InMemoryStateStore();
    await state.transaction((transaction) =>
      transaction.workflows.create(tenant, workflowId, workflow, now),
    );
    const engine = new DurableWorkflowEngine({ state, clock: () => now });
    const handle = await engine.start({
      tenant,
      workflowId,
      definitionVersion: 'workflow.v1',
      now,
    });
    await engine.scheduleActivity(handle, {
      activityId: 'retry-me',
      name: 'retry-me',
      input: null,
      ownerTier: 2,
      maxAttempts: 2,
      retryableFailureCodes: ['TRANSIENT'],
    });
    let attempts = 0;
    engine.registerActivity('retry-me', async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('temporary failure') as Error & { code: string };
        error.code = 'TRANSIENT';
        throw error;
      }
      return { ok: true };
    });
    const waiting = await engine.resumeAfterRestart(handle);
    expect(waiting.status).toBe('waiting_for_activity');
    expect(waiting.activity?.attempts).toMatchObject([
      { attempt: 1, ownerTier: 'control-plane', outcome: 'retrying' },
    ]);
    const succeeded = await engine.resumeAfterRestart(handle);
    expect(succeeded.activity?.status).toBe('succeeded');
    expect(succeeded.activity?.attempts).toMatchObject([
      { attempt: 1, outcome: 'retrying' },
      { attempt: 2, outcome: 'succeeded' },
    ]);
  });

  it('requires an explicit compatible upgrade, pins the new handle, and rejects stale handles', async () => {
    const state = new InMemoryStateStore();
    await state.transaction((transaction) =>
      transaction.workflows.create(tenant, workflowId, workflow, now),
    );
    const engine = new DurableWorkflowEngine({
      state,
      clock: () => now,
      definitionUpgrades: [
        { fromVersion: 'workflow.v1', toVersion: 'workflow.v2', migrationId: 'fixture-v1-v2' },
      ],
    });
    const handle = await engine.start({
      tenant,
      workflowId,
      definitionVersion: 'workflow.v1',
      now,
    });
    await engine.scheduleActivity(handle, {
      activityId: 'upgrade-me',
      name: 'upgrade-me',
      input: { version: 1 },
      ownerTier: 1,
      maxAttempts: 1,
      retryableFailureCodes: [],
    });

    const upgraded = await engine.upgradeDefinition(handle, {
      fromVersion: 'workflow.v1',
      toVersion: 'workflow.v2',
      migrationId: 'fixture-v1-v2',
      now,
    });
    expect(upgraded.definitionVersion).toBe('workflow.v2');
    expect((await engine.query(upgraded)).definitionVersion).toBe('workflow.v2');
    await expect(engine.query(handle)).rejects.toThrow('Unknown workflow engine handle');
    await expect(
      engine.upgradeDefinition(handle, {
        fromVersion: 'workflow.v1',
        toVersion: 'workflow.v3',
        migrationId: 'unregistered',
        now,
      }),
    ).rejects.toThrow('not registered as compatible');

    engine.registerActivity('upgrade-me', async (input) => input);
    const resumed = await engine.resumeAfterRestart(upgraded);
    expect(resumed.activity?.status).toBe('succeeded');
    const events = await state.transaction((transaction) => transaction.events.list(tenant));
    expect(events.map(({ event }) => event.eventName)).toContain(
      'workflow-engine.definition-upgraded.v1',
    );
  });

  it('recovers a workflow after the worker process is killed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentic-workflow-kill-'));
    const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const startedPath = join(directory, 'started');
    const resultPath = join(directory, 'result.json');
    const childFixture = join(
      repositoryRoot,
      'packages/runtime-domain/tests/fixtures/process-kill-child.test.ts',
    );
    const vitestCli = join(repositoryRoot, 'node_modules/vitest/vitest.mjs');
    const runChild = (phase: 'prepare' | 'recover') => {
      const child = spawn(
        process.execPath,
        [vitestCli, 'run', childFixture, '--config', join(repositoryRoot, 'vitest.config.ts')],
        {
          cwd: repositoryRoot,
          env: {
            ...process.env,
            RUNTIME_PROCESS_KILL_PHASE: phase,
            RUNTIME_PROCESS_KILL_DIRECTORY: directory,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child.once('error', reject);
          child.once('exit', (code, signal) => resolve({ code, signal }));
        },
      );
      return { child, exited, output: () => output };
    };
    const waitForFile = async (path: string): Promise<void> => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        try {
          await stat(path);
          return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      throw new Error(`Timed out waiting for ${path}`);
    };
    let prepare: ReturnType<typeof runChild> | undefined;
    let recover: ReturnType<typeof runChild> | undefined;
    try {
      prepare = runChild('prepare');
      await waitForFile(startedPath);
      prepare.child.kill('SIGKILL');
      const killed = await prepare.exited;
      expect(killed.signal).toBe('SIGKILL');
      expect(prepare.output()).not.toContain('FAIL');

      recover = runChild('recover');
      const recovered = await recover.exited;
      if (recovered.code !== 0) {
        throw new Error(`Recovery child failed (${recover.output()})`);
      }
      const result = JSON.parse(await readFile(resultPath, 'utf8')) as {
        status: string;
        activityStatus: string | undefined;
        recovered: boolean | undefined;
      };
      expect(result.status).toBe('running');
      expect(result.activityStatus).toBe('succeeded');
      expect(result.recovered).toBe(true);
    } finally {
      prepare?.child.kill('SIGKILL');
      recover?.child.kill('SIGKILL');
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('keeps approval waits durable and records retry ownership', async () => {
    const state = new InMemoryStateStore();
    await state.transaction((transaction) =>
      transaction.workflows.create(tenant, workflowId, workflow, now),
    );
    const engine = new DurableWorkflowEngine({ state, clock: () => now });
    const handle = await engine.start({
      tenant,
      workflowId,
      definitionVersion: 'workflow.v1',
      now,
    });
    await engine.waitForApproval(handle, newSortableId());
    expect((await engine.query(handle)).status).toBe('waiting_for_approval');
    const waiting = await engine.query(handle);
    expect(waiting.approvalId).toBeDefined();
    if (waiting.approvalId === undefined) throw new Error('approval wait was not persisted');
    const approvalId = waiting.approvalId;
    await engine.signal(handle, { type: 'approval', approvalId, outcome: 'approved' });
    expect((await engine.query(handle)).status).toBe('running');
    await engine.scheduleActivity(handle, {
      activityId: 'retry',
      name: 'retry',
      input: null,
      ownerTier: 2,
      maxAttempts: 1,
      retryableFailureCodes: [],
    });
    engine.registerActivity('retry', async () => {
      throw new Error('permanent');
    });
    const failed = await engine.resumeAfterRestart(handle);
    expect(failed.status).toBe('failed');
    expect(failed.activity?.attempts[0]?.ownerTier).toBe('control-plane');
  });

  it('keeps an external durable-engine adapter behind the internal workflow contract', async () => {
    const handle = {
      engine: 'external' as const,
      engineWorkflowId: 'external:fixture',
      workflowId,
      tenant,
      definitionVersion: 'workflow.v1',
    };
    const externalState: WorkflowEngineState = {
      workflowId,
      engineWorkflowId: handle.engineWorkflowId,
      definitionVersion: handle.definitionVersion,
      status: 'running',
    };
    const client: ExternalWorkflowClient = {
      start: async () => handle,
      upgradeDefinition: async (_handle, request) => ({
        ...handle,
        definitionVersion: request.toVersion,
      }),
      signal: async () => undefined,
      query: async () => externalState,
      scheduleActivity: async () => ({
        activityId: 'external-activity',
        name: 'fixture',
        input: null,
        ownerTier: 2,
        maxAttempts: 1,
        retryableFailureCodes: [],
        status: 'scheduled',
        attempt: 0,
        attempts: [],
      }),
      waitForApproval: async () => undefined,
      cancel: async () => undefined,
      resumeAfterRestart: async () => externalState,
    };
    const engine = new ExternalWorkflowEngine(client);
    const started = await engine.start({
      tenant,
      workflowId,
      definitionVersion: 'workflow.v1',
      now,
    });
    expect(started.engine).toBe('external');
    expect(await engine.query(started)).toEqual(externalState);
    expect(() => engine.query({ ...started, engine: 'internal' })).toThrow('another engine');
  });
});

describe('EventSubscriptionGateway', () => {
  it('replays from a cursor, detects retention gaps, and enforces authorization', async () => {
    const state = new InMemoryStateStore();
    const artifactId = newSortableId();
    await state.transaction(async (transaction) => {
      await transaction.events.append(
        {
          schemaVersion: 1,
          eventId: newSortableId(),
          eventName: 'workflow.created.v1',
          tenant,
          aggregateType: 'workflow',
          aggregateId: workflowId,
          aggregateVersion: 1,
          occurredAt: now,
          actor: { actorId: newSortableId(), type: 'system' },
          correlationId: workflowId,
          payload: { ok: true },
        },
        0,
      );
      await transaction.events.append(
        {
          schemaVersion: 1,
          eventId: newSortableId(),
          eventName: 'artifact.published.v1',
          tenant,
          aggregateType: 'artifact',
          aggregateId: artifactId,
          aggregateVersion: 1,
          occurredAt: now,
          actor: { actorId: newSortableId(), type: 'system' },
          correlationId: workflowId,
          payload: { version: 1 },
        },
        0,
      );
      await transaction.events.append(
        {
          schemaVersion: 1,
          eventId: newSortableId(),
          eventName: 'workflow.state-changed.v1',
          tenant,
          aggregateType: 'workflow',
          aggregateId: workflowId,
          aggregateVersion: 2,
          occurredAt: now,
          actor: { actorId: newSortableId(), type: 'system' },
          correlationId: workflowId,
          payload: { state: 'executing' },
        },
        1,
      );
      await transaction.events.append(
        {
          schemaVersion: 1,
          eventId: newSortableId(),
          eventName: 'artifact.published.v1',
          tenant,
          aggregateType: 'artifact',
          aggregateId: artifactId,
          aggregateVersion: 2,
          occurredAt: now,
          actor: { actorId: newSortableId(), type: 'system' },
          correlationId: workflowId,
          payload: { version: 2 },
        },
        1,
      );
    });
    const gateway = new EventSubscriptionGateway({
      state,
      authorizer: {
        authorize(request) {
          if (request.tenant.tenantId !== tenant.tenantId) throw new Error('unauthorized');
        },
      },
    });
    const page = await gateway.replay({ tenant, afterCursor: 0, topics: ['workflow'] });
    expect(page.events).toHaveLength(2);
    const firstArtifactPage = await gateway.replay({
      tenant,
      afterCursor: 0,
      topics: ['artifact'],
      maxEvents: 1,
    });
    expect(firstArtifactPage.events).toHaveLength(1);
    expect(firstArtifactPage.cursor).toBe(2);
    const secondArtifactPage = await gateway.replay({
      tenant,
      afterCursor: firstArtifactPage.cursor,
      topics: ['artifact'],
      maxEvents: 1,
    });
    expect(secondArtifactPage.events).toHaveLength(1);
    expect(secondArtifactPage.cursor).toBe(4);
    gateway.setRetentionFloor(tenant, 2);
    const gap = await gateway.replay({ tenant, afterCursor: 0, topics: ['approval'] });
    expect(gap.refreshRequired).toBe(true);
    expect(gap.cursor).toBe(4);
  });
});
