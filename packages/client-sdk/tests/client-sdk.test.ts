import { describe, expect, it } from 'vitest';
import { newSortableId } from '@agentic-platform/runtime-contracts';
import {
  createSpyderbyteClients,
  SpyderbyteClient,
  SpyderbyteClientError,
  SPYDERBYTE_EXIT_CODES,
} from '../src/index.js';

describe('Spyderbyte client SDK', () => {
  it('sends authenticated JSON requests and maps API errors', async () => {
    const calls: RequestInit[] = [];
    const client = new SpyderbyteClient({
      baseUrl: 'http://127.0.0.1:8787/',
      token: 'session-token',
      workspaceId: newSortableId(),
      fetcher: async (input, init) => {
        calls.push(init ?? {});
        if (String(input).endsWith('/v1/health')) {
          return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: 'denied' }), { status: 403 });
      },
    });
    await expect(client.health()).resolves.toEqual({ status: 'ok' });
    await expect(client.get('/v1/providers')).rejects.toBeInstanceOf(SpyderbyteClientError);
    expect(calls[0]?.headers).toMatchObject({
      authorization: 'Bearer session-token',
    });
    expect(calls[0]?.headers).toMatchObject({ 'x-agentic-workspace-id': expect.any(String) });
  });

  it('parses subscription pages from SSE and resumes from the returned cursor', async () => {
    const runId = newSortableId();
    const cursors: string[] = [];
    let responseNumber = 0;
    const client = new SpyderbyteClient({
      baseUrl: 'http://127.0.0.1:8787',
      fetcher: async (input) => {
        const url = new URL(String(input));
        cursors.push(url.searchParams.get('afterCursor') ?? '');
        responseNumber += 1;
        const cursor = responseNumber === 1 ? 4 : 5;
        return new Response(
          `event: runtime.events\ndata: ${JSON.stringify({
            cursor,
            events: [
              {
                schemaVersion: 1,
                eventId: newSortableId(),
                eventName: 'run.status-changed.v1',
                tenant: { tenantId: newSortableId(), workspaceId: newSortableId() },
                aggregateType: 'run',
                aggregateId: runId,
                aggregateVersion: 1,
                occurredAt: new Date().toISOString(),
                actor: { actorId: newSortableId(), type: 'system', displayName: 'Platform' },
                correlationId: runId,
                payload: { state: 'succeeded' },
              },
            ],
            gapDetected: false,
            refreshRequired: false,
          })}\n\n`,
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    const iterator = client.events({ maxReconnects: 1, reconnectDelayMs: 0 });
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({ cursor: 4, events: [{ aggregateId: runId }] });
    const second = await iterator.next();
    expect(second.done).toBe(false);
    expect(second.value).toMatchObject({ cursor: 5, events: [{ aggregateId: runId }] });
    await iterator.return?.();
    expect(cursors).toEqual(['0', '4']);
  });

  it('builds a tenant-bound command from the local session', async () => {
    const tenant = { tenantId: newSortableId(), workspaceId: newSortableId() };
    const actor = { actorId: newSortableId(), type: 'human' as const, displayName: 'Analyst' };
    const calls: unknown[] = [];
    const client = new SpyderbyteClient({
      baseUrl: 'http://127.0.0.1:8787',
      fetcher: async (input, init) => {
        if (String(input).endsWith('/v1/session'))
          return new Response(JSON.stringify({ tenant, actor }), { status: 200 });
        calls.push(JSON.parse(String(init?.body ?? '{}')) as unknown);
        return new Response(JSON.stringify({ accepted: true }), { status: 202 });
      },
    });
    await client.createProject('Terminal project', 'Explore a local dataset');
    expect(calls[0]).toMatchObject({
      commandType: 'CreateProject',
      tenant,
      actor,
      payload: { name: 'Terminal project' },
    });
  });

  it('reports reconnect state while replaying an interrupted event stream', async () => {
    const states: string[] = [];
    let calls = 0;
    const client = new SpyderbyteClient({
      baseUrl: 'http://127.0.0.1:8787',
      fetcher: async () => {
        calls += 1;
        if (calls === 1) throw new Error('connection reset');
        return new Response(
          `data: ${JSON.stringify({ cursor: 2, events: [], gapDetected: false, refreshRequired: false })}\n\n`,
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    const stream = client.events({
      maxReconnects: 1,
      reconnectDelayMs: 0,
      onConnectionStateChange: (state) => states.push(state),
    });
    await expect(stream.next()).resolves.toMatchObject({ value: { cursor: 2 }, done: false });
    await stream.return?.();
    expect(states).toEqual(expect.arrayContaining(['reconnecting', 'connected']));
  });

  it('exposes the P3 production-scale control-plane routes', async () => {
    const requests: Array<{ readonly method: string; readonly path: string }> = [];
    const client = new SpyderbyteClient({
      baseUrl: 'http://127.0.0.1:8787',
      fetcher: async (input, init) => {
        const url = new URL(String(input));
        requests.push({ method: init?.method ?? 'GET', path: url.pathname });
        const body =
          url.pathname === '/v1/serving/endpoints'
            ? { endpoints: [] }
            : url.pathname === '/v1/scoped-budgets'
              ? { budgets: [] }
              : url.pathname === '/v1/agent-definitions'
                ? { definitions: [] }
                : { status: 'ok' };
        return new Response(JSON.stringify(body), { status: 200 });
      },
    });
    await client.servingEndpoints();
    await client.scopedBudgets();
    await client.agentDefinitions();
    await client.writeCollaborationDocument(newSortableId(), { expectedVersion: 0, value: null });
    expect(requests).toEqual([
      { method: 'GET', path: '/v1/serving/endpoints' },
      { method: 'GET', path: '/v1/scoped-budgets' },
      { method: 'GET', path: '/v1/agent-definitions' },
      { method: 'PUT', path: expect.stringMatching(/^\/v1\/collaboration\/documents\//) },
    ]);
  });

  it('exposes the durable Phase 4 data and SQL loop routes', async () => {
    const requests: Array<{ readonly method: string; readonly path: string }> = [];
    const client = new SpyderbyteClient({
      baseUrl: 'http://127.0.0.1:8787',
      fetcher: async (input, init) => {
        const url = new URL(String(input));
        requests.push({ method: init?.method ?? 'GET', path: url.pathname });
        return new Response(JSON.stringify({}), { status: 200 });
      },
    });
    await client.dataSources();
    await client.dataConnections();
    await client.dataSchema('sales/connection');
    await client.localDatasets('sales/dataset');
    await client.profileLocalDataset('sales/dataset', 2);
    await client.runDataQuery({ queryId: 'sales-query', sql: 'SELECT 1' });
    await client.explainDataQuery('sales-query', { sql: 'SELECT 1' });
    await client.exportDataQuery('sales-query', { format: 'csv' });
    await client.handoffDataQuery('sales-query', 'jupyter');
    await client.saveDataQuery({ savedQueryId: 'saved-sales', name: 'Sales', sql: 'SELECT 1' });
    expect(requests).toEqual([
      { method: 'GET', path: '/v1/data/sources' },
      { method: 'GET', path: '/v1/data/connections' },
      { method: 'GET', path: '/v1/data/connections/sales%2Fconnection/schema' },
      { method: 'GET', path: '/v1/datasets/local' },
      { method: 'POST', path: '/v1/datasets/local/sales%2Fdataset/profile' },
      { method: 'POST', path: '/v1/data/queries' },
      { method: 'POST', path: '/v1/data/queries/sales-query/explain' },
      { method: 'POST', path: '/v1/data/queries/sales-query/export' },
      { method: 'POST', path: '/v1/data/queries/sales-query/handoff' },
      { method: 'POST', path: '/v1/data/saved-queries' },
    ]);
  });

  it('exposes the shared repository-script and training routes used by the TUI', async () => {
    const requests: Array<{ readonly method: string; readonly path: string }> = [];
    const client = new SpyderbyteClient({
      baseUrl: 'http://127.0.0.1:8787',
      fetcher: async (input, init) => {
        const url = new URL(String(input));
        requests.push({ method: init?.method ?? 'GET', path: url.pathname });
        return new Response(JSON.stringify({}), { status: 200 });
      },
    });
    await client.localRepositories();
    await client.runtimeProfiles();
    await client.runRepositoryTest('repo-1', { command: 'python3', args: ['script.py'] });
    await client.artifacts();
    await client.artifact('artifact-1');
    await client.artifactVersions('artifact-1');
    await client.artifactLineage('artifact-1');
    await client.artifactContent('artifact-1', 1);
    await client.stageArtifactUpload('next', 'text/plain');
    await client.publishArtifactVersion('artifact-1', { stagedUploadId: 'upload-1' });
    await client.artifactDiff('artifact-1', 1, 2);
    await client.chooseVisualization({ columns: ['x'], rows: [[1]] }, 'kpi');
    await client.validateVisualization({ spec: { type: 'table' }, columns: ['x'], rows: [[1]] });
    await client.renderVisualization({ spec: { type: 'table' }, columns: ['x'], rows: [[1]] });
    await client.workspaceIntake();
    await client.workspaceInbox();
    await client.workspaceWatch();
    await client.workspaceRecommendations();
    await client.workspaceContext();
    await client.updateStatus();
    await client.checkForUpdates();
    await client.downloadUpdate();
    await client.installUpdate();
    await client.rollbackUpdate();
    await client.trainingRuns();
    await client.startTraining({ configuration: { epochs: 1 } });
    await client.trainingRun('train-1');
    await client.cancelTraining('train-1');
    expect(requests).toEqual([
      { method: 'GET', path: '/v1/repositories/local' },
      { method: 'GET', path: '/v1/runtimes/profiles' },
      { method: 'POST', path: '/v1/repositories/local/repo-1/tests' },
      { method: 'GET', path: '/v1/artifacts' },
      { method: 'GET', path: '/v1/artifacts/artifact-1' },
      { method: 'GET', path: '/v1/artifacts/artifact-1/versions' },
      { method: 'GET', path: '/v1/artifacts/artifact-1/lineage' },
      { method: 'GET', path: '/v1/artifacts/artifact-1/versions/1/content' },
      { method: 'POST', path: '/v1/artifacts/uploads' },
      { method: 'POST', path: '/v1/artifacts/artifact-1/versions' },
      { method: 'GET', path: '/v1/artifacts/artifact-1/diff' },
      { method: 'POST', path: '/v1/visualizations/choose' },
      { method: 'POST', path: '/v1/visualizations/validate' },
      { method: 'POST', path: '/v1/visualizations/render' },
      { method: 'GET', path: '/v1/workspace/intake' },
      { method: 'GET', path: '/v1/workspace/inbox' },
      { method: 'GET', path: '/v1/workspace/watch' },
      { method: 'GET', path: '/v1/workspace/recommendations' },
      { method: 'GET', path: '/v1/workspace/context' },
      { method: 'GET', path: '/v1/updates/status' },
      { method: 'POST', path: '/v1/updates/check' },
      { method: 'POST', path: '/v1/updates/download' },
      { method: 'POST', path: '/v1/updates/install' },
      { method: 'POST', path: '/v1/updates/rollback' },
      { method: 'GET', path: '/v1/training/runs' },
      { method: 'POST', path: '/v1/training/runs' },
      { method: 'GET', path: '/v1/training/runs/train-1' },
      { method: 'POST', path: '/v1/training/runs/train-1/cancel' },
    ]);
  });

  it('exposes the eight named clients over the same typed transport', async () => {
    const client = new SpyderbyteClient({
      baseUrl: 'http://127.0.0.1:8787',
      fetcher: async () => new Response(JSON.stringify({}), { status: 200 }),
    });
    const clients = createSpyderbyteClients(client);
    expect(Object.keys(clients)).toEqual([
      'agent',
      'project',
      'run',
      'artifact',
      'provider',
      'runtime',
      'approval',
      'usage',
      'visualization',
      'workspaceIntake',
    ]);
    expect(clients.agent).toBe(client);
    expect(client.agent).toBe(client);
    expect(client.project).toBe(client);
    expect(client.runClient).toBe(client);
    expect(client.artifactClient).toBe(client);
    expect(client.provider).toBe(client);
    expect(client.runtime).toBe(client);
    expect(client.approval).toBe(client);
    expect(client.usage).toBe(client);
    expect(client.visualization).toBe(client);
  });

  it('routes approval, provider, runtime, and usage operations through named interfaces', async () => {
    const requests: string[] = [];
    const providerId = newSortableId();
    const approvalId = newSortableId();
    const client = new SpyderbyteClient({
      baseUrl: 'http://127.0.0.1:8787',
      fetcher: async (input) => {
        const url = new URL(String(input));
        requests.push(url.pathname);
        return new Response(
          JSON.stringify(
            url.pathname === '/v1/approvals' ? { items: [], hasMore: false } : { status: 'ok' },
          ),
          { status: 200 },
        );
      },
    });
    const clients = createSpyderbyteClients(client);
    await clients.approval.listApprovals({ limit: 10 });
    await clients.approval.approveApproval(approvalId, 'reviewed');
    await clients.provider.providerUsage(providerId);
    await clients.runtime.health();
    await clients.usage.notebookUsage('notebook-1');
    expect(requests).toEqual([
      '/v1/approvals',
      `/v1/approvals/${approvalId}/approve`,
      `/v1/providers/${providerId}/usage`,
      '/v1/health',
      '/v1/notebooks/notebook-1/usage',
    ]);
  });

  it('normalizes legacy collection responses into replayable cursor pages', async () => {
    const requests: string[] = [];
    let page = 0;
    const client = new SpyderbyteClient({
      baseUrl: 'http://127.0.0.1:8787',
      fetcher: async (input) => {
        const url = new URL(String(input));
        requests.push(`${url.pathname}${url.search}`);
        page += 1;
        return new Response(
          JSON.stringify(
            page === 1
              ? { artifacts: [{ artifactId: 'artifact-1' }], hasMore: true, nextCursor: '2' }
              : { artifacts: [{ artifactId: 'artifact-2' }], hasMore: false },
          ),
          { status: 200 },
        );
      },
    });
    const first = await client.listArtifacts({ limit: 1 });
    expect(first).toEqual({
      schemaVersion: 1,
      items: [{ artifactId: 'artifact-1' }],
      hasMore: true,
      nextCursor: '2',
    });
    page = 0;
    requests.length = 0;
    await expect(client.collectPages('/v1/artifacts', { limit: 1 }, 'artifacts')).resolves.toEqual([
      { artifactId: 'artifact-1' },
      { artifactId: 'artifact-2' },
    ]);
    expect(requests).toEqual(['/v1/artifacts?limit=1', '/v1/artifacts?cursor=2&limit=1']);
  });

  it('maps structured API and transport failures to stable retry and exit semantics', async () => {
    const policyClient = new SpyderbyteClient({
      baseUrl: 'http://127.0.0.1:8787',
      fetcher: async () =>
        new Response(
          JSON.stringify({
            error: 'Policy denied',
            code: 'POLICY_DENIED',
            correlationId: newSortableId(),
          }),
          { status: 403 },
        ),
    });
    await expect(policyClient.get('/v1/runs')).rejects.toMatchObject({
      status: 403,
      code: 'POLICY_DENIED',
      retryable: false,
      exitCode: SPYDERBYTE_EXIT_CODES.policyDenied,
      correlationId: expect.any(String),
    });

    const transportClient = new SpyderbyteClient({
      baseUrl: 'http://127.0.0.1:8787',
      fetcher: async () => {
        throw new Error('connection reset');
      },
    });
    await expect(transportClient.get('/v1/health')).rejects.toMatchObject({
      code: 'EXTERNAL_DEPENDENCY_UNAVAILABLE',
      retryable: true,
      exitCode: SPYDERBYTE_EXIT_CODES.executionFailed,
    });
  });

  it('forwards AbortSignal cancellation through the versioned transport', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const client = new SpyderbyteClient({
      baseUrl: 'http://127.0.0.1:8787',
      fetcher: async (_input, init) => {
        receivedSignal = init?.signal;
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      },
    });
    await expect(client.health({ signal: controller.signal })).resolves.toEqual({ status: 'ok' });
    expect(receivedSignal).toBe(controller.signal);
  });
});
