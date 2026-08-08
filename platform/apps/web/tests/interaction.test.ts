import { describe, expect, it } from 'vitest';
import { newSortableId } from '@agentic-platform/runtime-contracts';
import {
  FetchEventSource,
  HttpProjectionApi,
  ReconnectableSubscriptionClient,
  type EventSourceLike,
} from '../src/client.js';
import {
  ProjectionDrivenInteractionModel,
  renderAccessibleShell,
  type ProjectionApi,
} from '../src/index.js';

const tenant = { tenantId: newSortableId(), workspaceId: newSortableId() };

describe('projection-driven interaction model', () => {
  it('replays tenant-scoped events, handles cursor gaps, and exposes optimistic edit versions', () => {
    const model = new ProjectionDrivenInteractionModel(tenant);
    model.connect();
    const workflowId = newSortableId();
    model.applySubscription({
      cursor: 2,
      gapDetected: false,
      refreshRequired: false,
      events: [
        {
          schemaVersion: 1,
          eventId: newSortableId(),
          eventName: 'workflow.state-changed.v1',
          tenant,
          aggregateType: 'workflow',
          aggregateId: workflowId,
          aggregateVersion: 1,
          occurredAt: '2026-08-02T00:00:00.000Z',
          actor: { actorId: newSortableId(), type: 'system' },
          correlationId: workflowId,
          payload: { state: 'executing' },
        },
      ],
    });
    expect(model.snapshot().workflows[workflowId]).toBeDefined();
    const deploymentId = newSortableId();
    model.applySubscription({
      cursor: 3,
      gapDetected: false,
      refreshRequired: false,
      events: [
        {
          schemaVersion: 1,
          eventId: newSortableId(),
          eventName: 'deployment.requested.v1',
          tenant,
          aggregateType: 'deployment',
          aggregateId: deploymentId,
          aggregateVersion: 1,
          occurredAt: '2026-08-02T00:00:00.000Z',
          actor: { actorId: newSortableId(), type: 'system' },
          correlationId: deploymentId,
          payload: { state: 'requested' },
        },
      ],
    });
    expect(model.snapshot().deployments[deploymentId]).toBeDefined();
    model.applySubscription({ cursor: 3, gapDetected: true, refreshRequired: true, events: [] });
    expect(model.snapshot().stale).toBe(true);
    const command = model.buildOptimisticEditCommand({
      artifactId: newSortableId(),
      expectedVersion: 1,
      content: { name: 'edited' },
      commandId: newSortableId(),
      correlationId: newSortableId(),
      actor: { actorId: newSortableId(), type: 'human' },
      issuedAt: '2026-08-02T00:00:00.000Z',
      idempotencyKey: 'edit-1',
    });
    expect(command.payload).toMatchObject({ expectedVersion: 1 });
    const shell = renderAccessibleShell('approvals');
    expect(shell).toContain('aria-label="Primary navigation"');
    expect(shell).toContain('href="#deployments"');
    expect(shell).toContain('href="#audit"');
    expect(shell).toContain('Skip to content');
    const storageShell = renderAccessibleShell('workflows', undefined, {
      workspaceExport: true,
      workspaceBackup: true,
      workspaceImport: true,
    });
    expect(storageShell).toContain('data-action="export-workspace"');
    expect(storageShell).toContain('data-action="backup-workspace"');
    expect(storageShell).toContain('data-action="import-workspace"');
    expect(renderAccessibleShell('workflows')).toContain('disabled');
    const plannedWorkflowId = newSortableId();
    model.setPendingPlan({
      workflowId: plannedWorkflowId,
      planVersion: 1,
      plan: { steps: [{ stepId: newSortableId() }, { stepId: newSortableId() }] },
      sourceArtifact: { artifactId: newSortableId(), version: 1 },
    });
    const reviewShell = renderAccessibleShell('workflows', model.snapshot(), {
      runPlanned: true,
      approvePlan: true,
      rejectPlan: true,
    });
    expect(reviewShell).toContain('data-plan-review="' + plannedWorkflowId + '"');
    expect(reviewShell).toContain('Review before execution');
    expect(reviewShell).toContain('data-action="run-planned"');

    const approvalId = newSortableId();
    model.setPendingPlan({
      workflowId: plannedWorkflowId,
      planVersion: 1,
      plan: {
        steps: [{ stepId: newSortableId(), approvalRequired: true }],
      },
      sourceArtifact: { artifactId: newSortableId(), version: 1 },
      approval: { approvalId, state: 'pending' },
    });
    const pendingReviewShell = renderAccessibleShell('workflows', model.snapshot(), {
      runPlanned: true,
      approvePlan: true,
      rejectPlan: true,
    });
    expect(pendingReviewShell).toContain('Pending review');
    expect(pendingReviewShell).toContain('data-action="approve-plan"');
    expect(pendingReviewShell).toContain('data-action="reject-plan"');
    expect(pendingReviewShell).toContain('data-action="run-planned" disabled');
    model.setPendingApproval({ approvalId, state: 'approved' });
    expect(renderAccessibleShell('workflows', model.snapshot(), { runPlanned: true })).toContain(
      'Run approved plan',
    );
  });

  it('loads authoritative projections and exposes concurrent-edit conflicts', async () => {
    const model = new ProjectionDrivenInteractionModel(tenant);
    const workflowId = newSortableId();
    const api: ProjectionApi = {
      async query<T>(path: string): Promise<T> {
        if (path === '/v1/projections/workflow-summary') {
          return {
            projectionName: 'workflow-summary',
            tenant,
            state: { workflows: { [workflowId]: { state: 'completed' } } },
            cursor: 9,
            streamHead: 9,
            lag: 0,
            stale: false,
          } as T;
        }
        if (path === '/v1/projections/model-lifecycle') {
          return {
            projectionName: 'model-lifecycle',
            tenant,
            state: { models: {} },
            cursor: 9,
            streamHead: 9,
            lag: 0,
            stale: false,
          } as T;
        }
        throw new Error(`unexpected projection path ${path}`);
      },
      async command() {
        return null;
      },
    };
    await expect(model.loadProjection(api, 'workflows')).resolves.toBe(true);
    expect(model.snapshot()).toMatchObject({
      cursor: 9,
      stale: false,
      workflows: { [workflowId]: { state: 'completed' } },
    });
    await expect(model.loadProjection(api, 'models')).resolves.toBe(true);
    expect(model.snapshot().models).toEqual({});

    const artifactId = newSortableId();
    model.noteOptimisticConflict({
      artifactId,
      expectedVersion: 2,
      currentVersion: 3,
    });
    expect(renderAccessibleShell('artifacts', model.snapshot())).toContain('role="alert"');
    expect(renderAccessibleShell('artifacts', model.snapshot())).toContain('current version 3');
    model.clearOptimisticConflict();
    expect(model.snapshot().optimisticConflict).toBeUndefined();
  });

  it('keeps workspace selection tenant-bound and resets stale projection state', () => {
    const model = new ProjectionDrivenInteractionModel(tenant);
    const otherWorkspace = { tenantId: newSortableId(), workspaceId: newSortableId() };
    const workflowId = newSortableId();
    model.applySubscription({
      cursor: 4,
      gapDetected: false,
      refreshRequired: false,
      events: [
        {
          schemaVersion: 1,
          eventId: newSortableId(),
          eventName: 'workflow.state-changed.v1',
          tenant,
          aggregateType: 'workflow',
          aggregateId: workflowId,
          aggregateVersion: 1,
          occurredAt: '2026-08-02T00:00:00.000Z',
          actor: { actorId: newSortableId(), type: 'system' },
          correlationId: workflowId,
          payload: { state: 'executing' },
        },
      ],
    });
    model.setWorkspaces([tenant, otherWorkspace, tenant]);
    expect(model.selectWorkspace(otherWorkspace)).toBe(true);
    expect(model.snapshot()).toMatchObject({
      tenant: otherWorkspace,
      cursor: 0,
      workflows: {},
      workspaces: [tenant, otherWorkspace],
    });
    expect(model.selectWorkspace({ tenantId: newSortableId(), workspaceId: newSortableId() })).toBe(
      false,
    );
    expect(renderAccessibleShell('workflows', model.snapshot())).toContain(
      'data-action="select-workspace"',
    );
  });

  it('surfaces two-user conflicts from typed commands', async () => {
    const model = new ProjectionDrivenInteractionModel(tenant);
    const artifactId = newSortableId();
    const command = model.buildOptimisticEditCommand({
      artifactId,
      expectedVersion: 2,
      content: { value: 'edited' },
      commandId: newSortableId(),
      correlationId: newSortableId(),
      actor: { actorId: newSortableId(), type: 'human' },
      issuedAt: '2026-08-02T00:00:00.000Z',
      idempotencyKey: 'race-1',
    });
    const api: ProjectionApi = {
      async query<T>() {
        return null as T;
      },
      async command() {
        throw Object.assign(new Error('stale version; actual 3'), {
          status: 409,
          code: 'CONCURRENCY_STALE_VERSION',
        });
      },
    };
    await expect(model.submitCommand(api, command)).rejects.toThrow('stale version');
    expect(model.snapshot().optimisticConflict).toMatchObject({
      artifactId,
      expectedVersion: 2,
      currentVersion: 3,
    });
  });

  it('uses the HTTP API and reconnects SSE from the last accepted cursor', async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const api = new HttpProjectionApi({
      baseUrl: 'https://api.example.test',
      fetch: async (input, init) => {
        requests.push({ url: String(input), method: init?.method ?? 'GET' });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    await expect(api.query('/v1/projections/workflow-summary')).resolves.toEqual({ ok: true });
    await expect(
      api.command({
        schemaVersion: 1,
        commandId: newSortableId(),
        commandType: 'fixture',
        tenant,
        actor: { actorId: newSortableId(), type: 'human' },
        issuedAt: '2026-08-02T00:00:00.000Z',
        idempotencyKey: 'http-1',
        correlationId: newSortableId(),
        payload: {},
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      api.planCommand({
        schemaVersion: 1,
        commandId: newSortableId(),
        commandType: 'fixture',
        tenant,
        actor: { actorId: newSortableId(), type: 'human' },
        issuedAt: '2026-08-02T00:00:00.000Z',
        idempotencyKey: 'http-plan-1',
        correlationId: newSortableId(),
        payload: {},
      }),
    ).resolves.toEqual({ ok: true });
    await expect(api.runPlannedWorkflow(newSortableId())).resolves.toEqual({ ok: true });
    expect(requests).toEqual([
      { url: 'https://api.example.test/v1/projections/workflow-summary', method: 'GET' },
      { url: 'https://api.example.test/v1/commands', method: 'POST' },
      { url: 'https://api.example.test/v1/commands/plan', method: 'POST' },
      { url: expect.any(String), method: 'POST' },
    ]);
    expect(requests[3]?.url).toMatch(/https:\/\/api\.example\.test\/v1\/workflows\/[^/]+\/run$/);

    class FakeSource implements EventSourceLike {
      readonly listeners = new Map<string, (event: MessageEvent<string>) => void>();
      closed = false;

      addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
        this.listeners.set(type, listener);
      }

      close(): void {
        this.closed = true;
      }

      emit(type: string, data = ''): void {
        this.listeners.get(type)?.({ data } as MessageEvent<string>);
      }
    }

    const sources: FakeSource[] = [];
    const pages: number[] = [];
    const client = new ReconnectableSubscriptionClient({
      baseUrl: 'https://api.example.test',
      retryDelayMs: 0,
      eventSource: (url) => {
        expect(url).toContain(`afterCursor=${sources.length === 0 ? 4 : 8}`);
        const source = new FakeSource();
        sources.push(source);
        return source;
      },
      onPage: (page) => pages.push(page.cursor),
    });
    client.start(4);
    sources[0]?.emit(
      'runtime.events',
      JSON.stringify({ cursor: 8, events: [], gapDetected: false, refreshRequired: false }),
    );
    expect(client.currentCursor()).toBe(8);
    expect(pages).toEqual([8]);
    sources[0]?.emit('error');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sources).toHaveLength(2);
    client.stop();
    expect(sources[1]?.closed).toBe(true);
  });

  it('keeps desktop SSE authentication in headers instead of the stream URL', async () => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const source = new FetchEventSource('http://127.0.0.1:8787/v1/subscriptions/events', {
      headers: { authorization: 'Bearer desktop-session-token' },
      credentials: 'include',
      fetch: async (input, init) => {
        requestUrl = String(input);
        requestInit = init;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                ': connected\n\nevent: runtime.events\ndata: {"cursor":2,"events":[],"gapDetected":false,"refreshRequired":false}\n\n',
              ),
            );
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      },
    });
    const pages: string[] = [];
    source.addEventListener('runtime.events', (event) => pages.push(event.data));
    await new Promise((resolve) => setTimeout(resolve, 10));
    source.close();

    expect(requestUrl).toBe('http://127.0.0.1:8787/v1/subscriptions/events');
    expect(requestInit?.headers).toMatchObject({
      accept: 'text/event-stream',
      authorization: 'Bearer desktop-session-token',
    });
    expect(requestInit?.credentials).toBe('include');
    expect(pages).toEqual(['{"cursor":2,"events":[],"gapDetected":false,"refreshRequired":false}']);
  });

  it('binds JSON and SSE transport to the selected workspace without putting credentials in URLs', async () => {
    const otherWorkspace = newSortableId();
    let requestHeaders: HeadersInit | undefined;
    const api = new HttpProjectionApi({
      baseUrl: 'https://api.example.test',
      fetch: async (_input, init) => {
        requestHeaders = init?.headers;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
      credentials: 'include',
    });
    api.setWorkspace(otherWorkspace);
    await api.query('/v1/session');
    expect(requestHeaders).toMatchObject({
      accept: 'application/json',
      'x-agentic-workspace-id': otherWorkspace,
    });

    class Source implements EventSourceLike {
      addEventListener(): void {}
      close(): void {}
    }
    const urls: string[] = [];
    const client = new ReconnectableSubscriptionClient({
      baseUrl: 'https://api.example.test',
      workspaceId: otherWorkspace,
      eventSource: (url) => {
        urls.push(url);
        return new Source();
      },
      onPage: () => undefined,
    });
    client.start();
    expect(urls[0]).toContain(`workspaceId=${otherWorkspace}`);
    client.setWorkspace(newSortableId());
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain('afterCursor=0');
    client.stop();
  });

  it('updates JSON and SSE endpoints after a desktop workspace restart', async () => {
    const requests: string[] = [];
    const api = new HttpProjectionApi({
      baseUrl: 'https://old.local',
      fetch: async (input) => {
        requests.push(String(input));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    api.setWorkspace(newSortableId());
    api.setRuntime('https://new.local', { authorization: 'Bearer session' });
    await api.query('/v1/session');
    expect(requests[0]).toBe('https://new.local/v1/session');

    class Source implements EventSourceLike {
      addEventListener(): void {}
      close(): void {}
    }
    const urls: string[] = [];
    const client = new ReconnectableSubscriptionClient({
      baseUrl: 'https://old.local',
      eventSource: (url) => {
        urls.push(url);
        return new Source();
      },
      onPage: () => undefined,
    });
    client.start();
    client.setBaseUrl('https://new.local');
    expect(urls[1]).toContain('https://new.local/v1/subscriptions/events');
    client.stop();
  });
});
