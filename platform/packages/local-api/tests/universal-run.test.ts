import { describe, expect, it } from 'vitest';
import {
  handleLocalApiRequest,
  InMemorySettingsStore,
  isMaterialExecutionPath,
  type LocalApiOptions,
} from '../src/index.js';
import { UniversalRunCoordinator } from '@agentic-platform/runtime-domain';
import { InMemoryStateStore, type StateStore } from '@agentic-platform/state';
import {
  newSortableId,
  type Actor,
  type Id,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';

const now = '2026-08-07T00:00:00.000Z';

function fixture(): {
  readonly tenant: TenantRef;
  readonly actor: Actor;
  readonly state: InMemoryStateStore;
  readonly coordinator: UniversalRunCoordinator;
  readonly options: LocalApiOptions;
} {
  const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
  const actor: Actor = { actorId: newSortableId(), type: 'human', displayName: 'Acceptance user' };
  const state = new InMemoryStateStore();
  const coordinator = new UniversalRunCoordinator(state, () => now);
  return {
    tenant,
    actor,
    state,
    coordinator,
    options: {
      orchestrator: {} as LocalApiOptions['orchestrator'],
      tenant,
      actor,
      state,
      universalRuns: coordinator,
      settings: new InMemorySettingsStore(),
      clock: () => now,
    } as LocalApiOptions,
  };
}

function runIdFrom(response: { headers?: Readonly<Record<string, string>> }): Id {
  const runId = response.headers?.['x-spyderbyte-run-id'];
  if (runId === undefined) throw new Error('Expected x-spyderbyte-run-id');
  return runId;
}

describe('Phase 4 universal Run acceptance', () => {
  it('classifies every material action family at the API boundary', () => {
    const materialPaths = [
      '/v1/commands',
      '/v1/data/queries',
      '/v1/notebooks/018f0c4b-4e90-7abc-8def-0123456789ab/run',
      '/v1/visualizations',
      '/v1/training-runs',
      '/v1/evaluation-runs',
      '/v1/connections/sync',
      '/v1/automations/tick',
      '/v1/deployments',
      '/v1/repositories/018f0c4b-4e90-7abc-8def-0123456789ab/changes',
      '/v1/acp/execute',
      '/v1/jupyter/cells/execute',
    ];
    for (const path of materialPaths) expect(isMaterialExecutionPath('POST', path)).toBe(true);
    expect(isMaterialExecutionPath('GET', '/v1/data/queries')).toBe(false);
    expect(
      isMaterialExecutionPath(
        'POST',
        '/v1/projects/018f0c4b-4e90-7abc-8def-0123456789ab/conversation',
      ),
    ).toBe(false);
    expect(
      isMaterialExecutionPath('POST', '/v1/runs/018f0c4b-4e90-7abc-8def-0123456789ab/cancel'),
    ).toBe(false);
    expect(
      isMaterialExecutionPath('POST', '/v1/runs/018f0c4b-4e90-7abc-8def-0123456789ab/retry'),
    ).toBe(false);
  });

  it('creates equivalent authoritative records for API, CLI, TUI, ACP, Jupyter, web, automation, and system', async () => {
    const { coordinator, options } = fixture();
    const interfaces = [
      'api',
      'cli',
      'tui',
      'acp',
      'jupyter',
      'web',
      'automation',
      'system',
    ] as const;
    const runIds: Id[] = [];
    for (const sourceInterface of interfaces) {
      const response = await handleLocalApiRequest(
        {
          method: 'PUT',
          path: '/v1/settings',
          body: { scope: 'user', patch: { [`source_${sourceInterface}`]: true } },
          headers: { 'x-spyderbyte-interface': sourceInterface },
        },
        options,
      );
      expect(response.statusCode).toBe(200);
      const runId = runIdFrom(response);
      runIds.push(runId);
      const detail = await coordinator.read(options.tenant, runId);
      expect(detail.run).toMatchObject({
        runId,
        requestedAction: 'PUT /v1/settings',
        sourceInterface,
        state: 'succeeded',
        executionRequest: {
          runId,
          sourceInterface,
          action: 'PUT /v1/settings',
          replay: { type: 'http', method: 'PUT', path: '/v1/settings' },
        },
        executionPlan: {
          executionRequestId: detail.run.executionRequest?.executionRequestId,
        },
      });
      expect(detail.attempts).toHaveLength(1);
      expect(detail.attempts[0]).toMatchObject({
        runId,
        attemptNumber: 1,
        executionRequestId: detail.run.executionRequest?.executionRequestId,
        state: 'succeeded',
      });
      expect(detail.logs.some((log) => log.eventName === 'run.progress.v1')).toBe(true);
    }
    const listed = await handleLocalApiRequest(
      { method: 'GET', path: '/v1/runs', body: undefined },
      options,
    );
    expect(listed.statusCode).toBe(200);
    expect((listed.body as { runs: unknown[] }).runs).toHaveLength(interfaces.length);
    const reconnected = new UniversalRunCoordinator(options.state as StateStore, () => now);
    const detail = await reconnected.read(options.tenant, runIds[0] as Id);
    expect(detail.run.executionPlan?.executionRequestId).toBe(
      detail.run.executionRequest?.executionRequestId,
    );
  });

  it('preserves one Run across failure, restart, retry, and authoritative attempt history', async () => {
    const { options, coordinator } = fixture();
    const first = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/speech/transcriptions',
        body: { audioBase64: 'AA==', mimeType: 'audio/wav' },
        headers: { 'x-spyderbyte-interface': 'cli' },
      },
      options,
    );
    expect(first.statusCode).toBe(501);
    const runId = runIdFrom(first);
    expect((await coordinator.read(options.tenant, runId)).run.state).toBe('failed');

    options.providerRuntime = {
      speech: { transcribe: async () => ({ text: 'transcribed locally' }) },
    } as LocalApiOptions['providerRuntime'];
    options.universalRuns = new UniversalRunCoordinator(options.state as StateStore, () => now);
    const retried = await handleLocalApiRequest(
      { method: 'POST', path: `/v1/runs/${runId}/retry`, body: {} },
      options,
    );
    expect(retried.statusCode).toBe(200);
    expect(retried.body).toEqual({ text: 'transcribed locally' });
    expect(runIdFrom(retried)).toBe(runId);

    const retryCoordinator = options.universalRuns;
    if (retryCoordinator === undefined) throw new Error('Expected universal coordinator');
    const detail = await retryCoordinator.read(options.tenant, runId);
    expect(detail.run).toMatchObject({ runId, state: 'succeeded' });
    expect(detail.attempts).toHaveLength(2);
    expect(detail.attempts.map((attempt) => attempt.attemptNumber)).toEqual([1, 2]);
    expect(detail.attempts[0]?.state).toBe('failed');
    expect(detail.attempts[1]?.state).toBe('succeeded');
    const snapshot = await options.state.snapshot();
    const runEvents = snapshot.events.filter((event) => event.event.aggregateId === runId);
    expect(runEvents.filter((event) => event.event.eventName === 'run.created.v1')).toHaveLength(1);
    expect(
      runEvents.filter((event) => event.event.eventName === 'run.attempt-created.v1'),
    ).toHaveLength(2);
    expect(runEvents.some((event) => event.event.eventName === 'execution.completed.v1')).toBe(
      true,
    );
  });

  it('deduplicates idempotent material requests and supports cancellation, approval waits, and partial failure', async () => {
    const { coordinator, options, tenant, actor } = fixture();
    const idempotencyKey = 'phase4-idempotency-key';
    const first = await handleLocalApiRequest(
      {
        method: 'PUT',
        path: '/v1/settings',
        body: { scope: 'user', patch: { once: true } },
        headers: { 'idempotency-key': idempotencyKey },
      },
      options,
    );
    const second = await handleLocalApiRequest(
      {
        method: 'PUT',
        path: '/v1/settings',
        body: { scope: 'user', patch: { once: true } },
        headers: { 'idempotency-key': idempotencyKey },
      },
      options,
    );
    expect(runIdFrom(first)).toBe(runIdFrom(second));
    expect(await coordinator.list(tenant)).toHaveLength(1);

    let operationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      operationStarted = resolve;
    });
    const pending = coordinator.execute(
      { tenant, actor, sourceInterface: 'cli', action: 'python.execute' },
      async ({ signal }) => {
        operationStarted();
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
        return { statusCode: 200, body: { state: 'succeeded' } };
      },
    );
    await started;
    const pendingRun = (await coordinator.list(tenant)).find(
      (run) => run.requestedAction === 'python.execute',
    );
    if (pendingRun === undefined) throw new Error('Expected pending Run');
    await expect(
      coordinator.cancel(tenant, pendingRun.runId, actor, 'operator stopped it'),
    ).resolves.toMatchObject({
      cancelled: true,
      state: 'cancelled',
    });
    await expect(pending).resolves.toMatchObject({ runId: pendingRun.runId, state: 'cancelled' });
    expect((await coordinator.read(tenant, pendingRun.runId)).attempts[0]?.state).toBe('cancelled');

    const waiting = await coordinator.execute(
      { tenant, actor, sourceInterface: 'api', action: 'deployment.execute' },
      async () => ({
        statusCode: 202,
        state: 'awaiting_approval',
        body: { state: 'awaiting_approval' },
      }),
    );
    expect((await coordinator.read(tenant, waiting.runId)).run.state).toBe('awaiting_approval');
    const partial = await coordinator.execute(
      { tenant, actor, sourceInterface: 'jupyter', action: 'notebook.cell.execute' },
      async () => ({
        statusCode: 200,
        state: 'partially_succeeded',
        body: { state: 'partially_succeeded' },
        resourceUsage: { cpuMs: 12 },
      }),
    );
    const partialDetail = await coordinator.read(tenant, partial.runId);
    expect(partialDetail.run.state).toBe('partially_succeeded');
    expect(partialDetail.attempts[0]).toMatchObject({
      state: 'partially_succeeded',
      resourceUsage: { cpuMs: 12 },
    });
  });
});
