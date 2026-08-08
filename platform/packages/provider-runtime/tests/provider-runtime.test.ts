import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash, createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { makeMoney, newSortableId } from '@agentic-platform/runtime-contracts';
import {
  FileOAuthConnectionStore,
  MemoryProviderConfigurationStore,
  FunctionWhisperBackend,
  HuggingFaceHubClient,
  ConnectionCatalogService,
  MemoryCredentialVault,
  ModelDownloadManager,
  OAuthService,
  ProviderCatalog,
  ProviderConfigurationService,
  SpeechTranscriptionService,
  createDefaultProviderCatalog,
  ConnectorRegistry,
  LocalQueryRuntime,
  LocalNotebookRuntime,
  MeltanoConnectorRuntime,
  LocalVisualizationRuntime,
  LocalRepositoryRuntime,
  LocalRuntimeProfileRuntime,
  LocalJupyterSessionRuntime,
  LocalPipelineRuntime,
  LocalAutomationRuntime,
  LocalTrainingRuntime,
  LocalServingRuntime,
  CloudProviderActionRuntime,
  SpyderbyteUpdateService,
  createOpenAiHttpTransport,
  verifyConnectorManifest,
} from '../src/index.js';
import type { ConnectorDefinition } from '../src/index.js';
import { ModelRouter, type ModelProviderRequest } from '@agentic-platform/harness-core';

const envKeys = ['AGENTIC_TEST_CLIENT_ID', 'AGENTIC_TEST_CLIENT_SECRET'];
const execFileAsync = promisify(execFile);

afterEach(() => {
  for (const key of envKeys) Reflect.deleteProperty(process.env, key);
});

function providerRequest(input: unknown, model = 'local-model'): ModelProviderRequest {
  return {
    requestId: '018f0c4b-4e50-7abc-8def-0123456789ab',
    model,
    input: input as ModelProviderRequest['input'],
    maxTokens: 20,
  };
}

describe('provider catalog and routing', () => {
  it('filters by readiness and ranks ready providers by workspace priority', () => {
    const catalog = createDefaultProviderCatalog({
      localProviders: [
        {
          modelId: 'local-model',
          transport: {
            async complete() {
              return {
                output: { ok: true },
                usage: {
                  inputTokens: 1,
                  outputTokens: 1,
                  totalTokens: 2,
                  cost: makeMoney(0, 'USD'),
                },
              };
            },
          },
        },
      ],
    });
    const router = new ModelRouter();
    catalog.registerWith(router);
    router.registerRoute({
      taskShape: 'coding',
      tier: 1,
      providers: catalog.list().map((model) => model.providerKey),
      maxTokens: 20,
    });

    const resolved = router.resolveSelection({
      taskShape: 'coding',
      tier: 1,
      allowedModels: ['local-model', 'fixture-model'],
      providerPriority: ['huggingface-local', 'deterministic'],
      requiredCapabilities: ['structured-output'],
    }).resolved;
    expect(resolved.selected).toEqual({ providerId: 'huggingface-local', modelId: 'local-model' });

    expect(() =>
      router.resolveSelection({
        taskShape: 'coding',
        tier: 1,
        allowedModels: ['local-model'],
        override: { providerId: 'openai-codex', modelId: 'gpt-5.3-codex' },
      }),
    ).toThrow('not available');
  });

  it('passes selected models through a gateway transport', async () => {
    const seen: string[] = [];
    const catalog = new ProviderCatalog();
    catalog.register(
      {
        providerId: 'gateway',
        modelId: 'model-a',
        providerKey: 'gateway:model-a',
        modelRef: { providerId: 'gateway', modelId: 'model-a' },
        source: 'codex-subscription',
        capabilities: ['structured-output'],
        dataClasses: ['public'],
        billingMode: 'subscription',
        state: 'ready',
        local: false,
      },
      {
        async complete(_metadata, request) {
          seen.push(request.model);
          return {
            output: { received: request.model },
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: makeMoney(0, 'USD') },
          };
        },
      },
    );
    const model = catalog.get({ providerId: 'gateway', modelId: 'model-a' });
    expect(model).toBeDefined();
    expect(await model?.complete(providerRequest({ prompt: 'safe' }, 'model-a'))).toMatchObject({
      output: { received: 'model-a' },
    });
    expect(seen).toEqual(['model-a']);
  });
});

describe('direct provider configuration and transport', () => {
  it('discovers, tests, streams, and rehydrates an API-key provider without persisting its secret', async () => {
    const tenant = { tenantId: newSortableId(), workspaceId: newSortableId() };
    const store = new MemoryProviderConfigurationStore();
    const vault = new MemoryCredentialVault();
    const catalog = new ProviderCatalog();
    const router = new ModelRouter();
    const requests: Array<{ url: string; body: string; headers: Headers }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const request = {
        url: String(input),
        body: typeof init?.body === 'string' ? init.body : '',
        headers: new Headers(init?.headers),
      };
      requests.push(request);
      if (request.url.endsWith('/models')) {
        return new Response(
          JSON.stringify({ data: [{ id: 'gpt-test', display_name: 'Test model' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      const body = JSON.parse(request.body) as { stream?: boolean };
      if (body.stream === true) {
        return new Response(
          'data: {"choices":[{"delta":{"content":"hello "}}]}\n\n' +
            'data: {"choices":[{"delta":{"content":"world"}}]}\n\n' +
            'data: [DONE]\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return new Response(
        JSON.stringify({
          id: 'request-1',
          choices: [{ message: { content: 'OK' } }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const service = new ProviderConfigurationService({
      tenant,
      store,
      vault,
      catalog,
      router,
      fetcher,
    });

    const configuration = await service.add({
      providerId: 'openai-test',
      providerType: 'openai',
      displayName: 'OpenAI test',
      endpoint: 'https://provider.test/v1',
      defaultModelId: 'gpt-test',
      apiKey: 'do-not-persist-this-secret',
    });
    expect(service.listCredentials()[0]).not.toHaveProperty('secret');
    expect(JSON.stringify(store.load())).not.toContain('do-not-persist-this-secret');
    expect(await vault.get(`provider:${service.listCredentials()[0]?.credentialId}`)).toBe(
      'do-not-persist-this-secret',
    );

    const report = await service.test(configuration.providerConfigurationId);
    expect(report.checks.every((check) => check.status === 'passed')).toBe(true);
    expect(report.models).toEqual([
      expect.objectContaining({ providerId: 'openai-test', modelId: 'gpt-test' }),
    ]);
    expect(catalog.get({ providerId: 'openai-test', modelId: 'gpt-test' })?.metadata.state).toBe(
      'ready',
    );
    expect(
      requests.some(
        (request) => request.headers.get('authorization') === 'Bearer do-not-persist-this-secret',
      ),
    ).toBe(true);

    const restartedCatalog = new ProviderCatalog();
    const restarted = new ProviderConfigurationService({
      tenant,
      store,
      vault,
      catalog: restartedCatalog,
      router: new ModelRouter(),
      fetcher,
    });
    await restarted.refresh();
    expect(restarted.list()).toEqual([expect.objectContaining({ providerId: 'openai-test' })]);
    expect(restarted.listModels()).toEqual([
      expect.objectContaining({ providerId: 'openai-test', modelId: 'gpt-test' }),
    ]);
    expect(
      restartedCatalog.get({ providerId: 'openai-test', modelId: 'gpt-test' })?.metadata.state,
    ).toBe('ready');
  });

  it('redacts provider credentials from transport error messages', async () => {
    const secret = 'do-not-leak-this-secret';
    const transport = createOpenAiHttpTransport({
      providerId: 'openai-test',
      endpoint: 'https://provider.test/v1',
      apiKey: secret,
      fetcher: async () =>
        new Response(JSON.stringify({ error: `invalid api_key=${secret}` }), {
          status: 401,
          statusText: 'Unauthorized',
          headers: { 'content-type': 'application/json' },
        }),
    });
    await expect(
      transport.complete({} as never, providerRequest({ prompt: 'safe' }, 'gpt-test')),
    ).rejects.toThrow('[REDACTED]');
    await expect(
      transport.complete({} as never, providerRequest({ prompt: 'safe' }, 'gpt-test')),
    ).rejects.not.toThrow(secret);
  });
});

describe('platform OAuth', () => {
  const connector: ConnectorDefinition = {
    connectorId: 'test',
    displayName: 'Test OAuth',
    authKind: 'oauth2',
    authorizationEndpoint: 'https://provider.example/authorize',
    tokenEndpoint: 'https://provider.example/token',
    clientIdEnv: 'AGENTIC_TEST_CLIENT_ID',
    clientSecretEnv: 'AGENTIC_TEST_CLIENT_SECRET',
    scopes: ['read'],
  };

  it('reports connector readiness without exposing configuration internals', () => {
    process.env.AGENTIC_TEST_CLIENT_ID = 'client-id';
    process.env.AGENTIC_TEST_CLIENT_SECRET = 'client-secret';
    const service = new OAuthService({ connectors: [connector] });
    expect(service.listConnectors()).toEqual([
      expect.objectContaining({
        connectorId: 'test',
        configured: true,
      }),
    ]);
    expect(service.listConnectors()[0]).not.toHaveProperty('clientIdEnv');
    expect(service.listConnectors()[0]).not.toHaveProperty('clientSecretEnv');
  });

  it('uses PKCE, rejects open redirects, consumes state once, and stores only metadata outside the vault', async () => {
    process.env.AGENTIC_TEST_CLIENT_ID = 'client-id';
    process.env.AGENTIC_TEST_CLIENT_SECRET = 'client-secret';
    let tokenRequest = '';
    const vault = new MemoryCredentialVault();
    const service = new OAuthService({
      connectors: [connector],
      vault,
      fetcher: async (_input, init) => {
        tokenRequest = String(init?.body ?? '');
        return new Response(
          JSON.stringify({
            access_token: 'access-secret',
            refresh_token: 'refresh-secret',
            expires_in: 3600,
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      },
    });
    await expect(
      service.start({
        connectorId: 'test',
        sessionId: 'session',
        redirectUri: 'https://evil.example/callback',
        returnTo: '/connections',
      }),
    ).rejects.toThrow('redirectUri');
    const started = await service.start({
      connectorId: 'test',
      sessionId: 'session',
      redirectUri: 'http://127.0.0.1:4321/v1/oauth/callback',
      returnTo: '/connections',
    });
    const url = new URL(started.authorizationUrl ?? '');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(started.authorizationUrl).not.toContain('access-secret');

    const completed = await service.complete({
      state: url.searchParams.get('state') ?? '',
      code: 'auth-code',
    });
    expect(completed.returnTo).toBe('/connections');
    expect(service.listConnections()[0]?.connectionId).toBe(completed.connection.connectionId);
    expect(JSON.stringify(service.listConnections())).not.toContain('access-secret');
    expect(tokenRequest).toContain('code_verifier=');
    expect(await service.credential(completed.connection.connectionId)).toContain('refresh-secret');
    await expect(
      service.complete({ state: url.searchParams.get('state') ?? '', code: 'replay' }),
    ).rejects.toThrow('invalid or expired');
  });

  it('persists connection metadata across daemon restarts without persisting tokens', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentic-oauth-'));
    const path = join(root, 'connections.json');
    const store = new FileOAuthConnectionStore(path);
    const cliConnector: ConnectorDefinition = {
      connectorId: 'test-cli',
      displayName: 'Test CLI',
      authKind: 'cline-cli',
      scopes: ['model:use'],
      cliCommand: ['test-cli'],
    };
    const service = new OAuthService({ connectors: [cliConnector], metadataStore: store });
    const started = await service.start({
      connectorId: 'test-cli',
      sessionId: 'session',
      redirectUri: 'agentic://oauth/callback',
      returnTo: '/connections',
    });
    const connection = await service.completeCli({
      transactionId: started.transactionId,
      accountLabel: 'Test account',
    });
    const restarted = new OAuthService({
      connectors: [cliConnector],
      metadataStore: new FileOAuthConnectionStore(path),
    });
    expect(restarted.listConnections()).toEqual([connection]);
    expect(await readFile(path, 'utf8')).not.toContain('access_token');
  });

  it('completes supported CLI authentication through the supervised runner hook', async () => {
    const cli: ConnectorDefinition = {
      connectorId: 'cli',
      displayName: 'CLI provider',
      authKind: 'cline-cli',
      scopes: ['model:use'],
      cliCommand: ['provider', 'login'],
    };
    const service = new OAuthService({
      connectors: [cli],
      cliAuthRunner: {
        run: async (command) => {
          expect(command).toEqual(['provider', 'login']);
          return { accountLabel: 'account' };
        },
      },
    });
    await service.start({
      connectorId: 'cli',
      sessionId: 'session',
      redirectUri: 'agentic://oauth/callback',
      returnTo: '/connections',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.listConnections()[0]).toMatchObject({
      connectorId: 'cli',
      accountLabel: 'account',
      status: 'connected',
    });
  });
});

describe('local speech and Hugging Face boundaries', () => {
  it('transcribes locally and rejects empty output', async () => {
    const service = new SpeechTranscriptionService(
      new FunctionWhisperBackend(async () => ({ text: '  hello local  ', local: true })),
    );
    await expect(
      service.transcribe({ audio: new Uint8Array([1]), mimeType: 'audio/webm' }),
    ).resolves.toMatchObject({ text: 'hello local', local: true });
    const empty = new SpeechTranscriptionService(
      new FunctionWhisperBackend(async () => ({ text: '', local: true })),
    );
    await expect(
      empty.transcribe({ audio: new Uint8Array([1]), mimeType: 'audio/webm' }),
    ).rejects.toThrow('no speech');
  });

  it('requests a byte range when resuming a Hub download', async () => {
    const calls: RequestInit[] = [];
    const hub = new HuggingFaceHubClient({
      fetcher: async (_input, init) => {
        calls.push(init ?? {});
        return new Response(new Uint8Array([3, 4]), {
          status: 206,
          headers: { 'content-range': 'bytes 2-3/4', 'content-length': '2' },
        });
      },
    });
    const result = await hub.downloadResumable('owner/model', 'pinned', 'model.gguf', 2);
    expect(result.offset).toBe(2);
    expect(result.totalBytes).toBe(4);
    expect((calls[0]?.headers as Record<string, string>)['range']).toBe('bytes=2-');
  });

  it('maps Hugging Face repository details into safe install metadata', async () => {
    const hub = new HuggingFaceHubClient({
      fetcher: async (input) => {
        expect(String(input)).toContain('/api/models/owner/model');
        return new Response(
          JSON.stringify({
            id: 'owner/model',
            author: 'owner',
            pipeline_tag: 'text-generation',
            downloads: 42,
            likes: 7,
            cardData: { license: 'apache-2.0' },
            sha: '0123456789abcdef',
            siblings: [
              {
                rfilename: 'model.gguf',
                size: 12,
                lfs: {
                  oid: 'sha256:abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd',
                },
              },
              { rfilename: 'README.md', size: 4 },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    await expect(hub.details('owner/model', '0123456789abcdef')).resolves.toMatchObject({
      id: 'owner/model',
      license: 'apache-2.0',
      defaultRevision: '0123456789abcdef',
      supportedFormats: ['gguf', 'unknown'],
      recommendedFiles: ['model.gguf'],
    });
    const details = await hub.details('owner/model', '0123456789abcdef');
    expect(details.files[0]).toMatchObject({
      path: 'model.gguf',
      lfs: { sha256: 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd' },
    });
  });

  it('searches and configures catalog connections without returning credentials', async () => {
    const oauth = new OAuthService({ vault: new MemoryCredentialVault() });
    const connections = new ConnectionCatalogService(oauth);
    const page = connections.list({ query: 'postgres' });
    expect(page.items.map((item) => item.connectorId)).toEqual([
      'meltano-tap-postgres',
      'meltano-target-postgres',
    ]);
    const setup = await connections.setup({
      connectorId: 'meltano-tap-postgres',
      config: {
        host: 'db.example.com',
        database: 'warehouse',
        username: 'analyst',
        password: 'secret',
      },
    });
    expect(setup.connection).not.toHaveProperty('password');
    expect(await connections.test(setup.connection.connectionId)).toMatchObject({
      connectionId: setup.connection.connectionId,
      status: 'passed',
    });
  });

  it('installs a pinned model atomically, verifies its checksum, and removes it by id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentic-models-'));
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const checksum = createHash('sha256').update(bytes).digest('hex');
    const hub = new HuggingFaceHubClient({
      fetcher: async (input) => {
        const url = String(input);
        if (url.includes('/tree/')) {
          return new Response(
            JSON.stringify([{ path: 'model.gguf', size: bytes.length, lfs: { sha256: checksum } }]),
            { status: 200 },
          );
        }
        return new Response(bytes, {
          status: 200,
          headers: { 'content-length': String(bytes.length) },
        });
      },
    });
    const manager = new ModelDownloadManager({ rootPath: root, hub });
    const job = await manager.start('owner/model', 'pinned');
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = manager.listJobs().find((candidate) => candidate.jobId === job.jobId);
      if (current?.state === 'completed' || current?.state === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(manager.listJobs().find((candidate) => candidate.jobId === job.jobId)?.state).toBe(
      'completed',
    );
    const installed = await manager.listInstalled();
    expect(installed[0]).toMatchObject({
      repoId: 'owner/model',
      revision: 'pinned',
      format: 'gguf',
    });
    expect(await manager.removeById(installed[0]?.modelId ?? '')).toBe(true);
    expect(await manager.listInstalled()).toEqual([]);
  });

  it('verifies the curated connector registry and exposes media/local bridge resources', () => {
    const registry = new ConnectorRegistry();
    expect(registry.get('local-media-bridge')).toMatchObject({
      category: 'local-bridge',
      runtimeAdapter: 'local-bridge',
    });
    expect(registry.list({ category: 'media' }).map((entry) => entry.connectorId)).toEqual([
      'google-drive',
      'youtube',
      'frame-io',
    ]);
    const entry = registry.require('github');
    expect(() => verifyConnectorManifest({ ...entry, displayName: 'tampered' })).toThrow();
  });

  it('executes bounded local SQL and preserves a result artifact reference', async () => {
    const runtime = new LocalQueryRuntime();
    const result = await runtime.execute({
      queryId: 'query-smoke',
      sql: 'SELECT category, COUNT(*) AS total FROM dataset GROUP BY category ORDER BY category',
      source: {
        columns: ['category', 'value'],
        rows: [
          ['a', 1],
          ['a', 2],
          ['b', 3],
        ],
      },
      maxRows: 10,
    });
    expect(result).toMatchObject({ status: 'completed', rowCount: 2 });
    expect(result.rows).toEqual([
      ['a', 2],
      ['b', 1],
    ]);
    expect(result.artifact.contentHash).toMatch(/^sha256:/);
    expect(runtime.result('query-smoke')).toEqual(result);
  });

  it('checks and downloads a signed update manifest with digest verification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-updates-'));
    const bytes = new Uint8Array([7, 8, 9]);
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const service = new SpyderbyteUpdateService({
      rootPath: root,
      currentVersion: '0.0.1',
      platform: 'darwin',
      architecture: 'arm64',
      endpoint: 'https://updates.example.test/manifest',
      requireSignature: false,
      fetcher: async (input) =>
        String(input).includes('artifact')
          ? new Response(bytes, { status: 200 })
          : new Response(
              JSON.stringify({
                product: 'Spyderbyte',
                version: '0.0.2',
                channel: 'stable',
                platform: 'darwin',
                architecture: 'arm64',
                minimumOs: '13.0',
                releaseNotes: 'Test update',
                artifactUrl: 'https://updates.example.test/artifact',
                artifactDigest: digest,
                signature: 'minisign:test',
                publishedAt: '2026-08-05T00:00:00.000Z',
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
    });
    await expect(service.check()).resolves.toMatchObject({
      state: 'available',
      available: { version: '0.0.2' },
    });
    await expect(service.download()).resolves.toMatchObject({
      state: 'ready-to-install',
      downloadedDigest: digest,
    });
    const downloaded = service.status().downloadedPath;
    expect(downloaded).toBeDefined();
    await expect(readFile(downloaded as string)).resolves.toEqual(Buffer.from(bytes));
  });

  it('runs Python and SQL notebook cells, preserves outputs, and exports ipynb', async () => {
    const runtime = new LocalNotebookRuntime(new LocalQueryRuntime());
    const python = await runtime.runCell({
      notebookId: 'notebook-test',
      cellId: 'cell-python',
      type: 'python',
      source: 'print("hello notebook")',
    });
    expect(python.cell).toMatchObject({ type: 'python', status: 'completed', executionCount: 1 });
    expect(python.cell.outputs[0]?.value).toContain('hello notebook');
    await expect(runtime.getArtifact(python.artifact?.artifactId ?? '')).resolves.toMatchObject({
      content: expect.stringContaining('hello notebook'),
      mediaType: 'text/plain',
    });
    const sql = await runtime.runCell({
      notebookId: 'notebook-test',
      cellId: 'cell-sql',
      type: 'sql',
      source: 'SELECT category, COUNT(*) AS total FROM dataset GROUP BY category',
      sourceData: { columns: ['category'], rows: [['a'], ['a'], ['b']] },
    });
    expect(sql.cell).toMatchObject({ type: 'sql', status: 'completed' });
    expect(sql.cell.outputs[0]?.value).toMatchObject({ artifactId: expect.any(String) });
    expect(runtime.exportIpynb('notebook-test')).toMatchObject({
      nbformat: 4,
      cells: expect.any(Array),
    });
  });

  it('fails closed when the Meltano executable or credential is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-meltano-'));
    const runtime = new MeltanoConnectorRuntime({
      rootPath: root,
      executable: join(root, 'missing-meltano'),
      requireSignedRuntime: false,
    });
    const manifest = new ConnectorRegistry().require('meltano-tap-postgres');
    await expect(
      runtime.execute({
        manifest,
        binding: {
          bindingId: 'binding-test',
          connectorId: manifest.connectorId,
          connectionId: 'connection-test',
          resources: ['schemas'],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        operation: 'stage tables',
      }),
    ).rejects.toThrow('credential binding');
  });

  it('renders a bounded chart model with source lineage', () => {
    const runtime = new LocalVisualizationRuntime();
    const result = runtime.render(
      { type: 'bar', title: 'Scores', xColumn: 'name', yColumn: 'score' },
      {
        columns: ['name', 'score'],
        rows: [
          ['A', 2],
          ['B', 5],
        ],
        sourceArtifactId: 'dataset-artifact',
      },
    );
    expect(result).toMatchObject({
      status: 'rendered',
      artifactId: expect.any(String),
      lineage: ['dataset-artifact'],
    });
    expect(result.series).toEqual([
      { x: 'A', y: 2 },
      { x: 'B', y: 5 },
    ]);
  });
});

describe('local repository runtime', () => {
  it('registers a repository, reports a diff, checks it, and creates a worktree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-repository-'));
    const repositoryPath = join(root, 'repo');
    await mkdir(repositoryPath, { recursive: true });
    await execFileAsync('git', ['init', repositoryPath]);
    await execFileAsync('git', [
      '-C',
      repositoryPath,
      'config',
      'user.email',
      'test@spyderbyte.local',
    ]);
    await execFileAsync('git', ['-C', repositoryPath, 'config', 'user.name', 'Spyderbyte Test']);
    await writeFile(join(repositoryPath, 'README.md'), '# Spyderbyte\n');
    await execFileAsync('git', ['-C', repositoryPath, 'add', 'README.md']);
    await execFileAsync('git', ['-C', repositoryPath, 'commit', '-m', 'initial']);

    const runtime = new LocalRepositoryRuntime({ rootPath: root });
    const repository = await runtime.register({ path: repositoryPath });
    await writeFile(join(repositoryPath, 'README.md'), '# Spyderbyte\n\nLocal workbench\n');
    await expect(runtime.status(repository.repositoryId)).resolves.toMatchObject({
      repositoryId: repository.repositoryId,
      changedFiles: 1,
      clean: false,
    });
    await expect(runtime.diff(repository.repositoryId)).resolves.toMatchObject({
      repositoryId: repository.repositoryId,
      truncated: false,
    });
    await expect(runtime.check(repository.repositoryId)).resolves.toMatchObject({
      name: 'git-diff-check',
      status: 'passed',
    });
    await expect(
      runtime.createWorktree({ repositoryId: repository.repositoryId, branch: 'feature/local' }),
    ).resolves.toMatchObject({ repositoryId: repository.repositoryId, branch: 'feature/local' });
  });

  it('creates a persisted change set, stages selected hunks, and runs bounded tests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-change-set-'));
    const repositoryPath = join(root, 'repo');
    await mkdir(repositoryPath, { recursive: true });
    await execFileAsync('git', ['init', repositoryPath]);
    await execFileAsync('git', [
      '-C',
      repositoryPath,
      'config',
      'user.email',
      'test@spyderbyte.local',
    ]);
    await execFileAsync('git', ['-C', repositoryPath, 'config', 'user.name', 'Spyderbyte Test']);
    await writeFile(
      join(repositoryPath, 'README.md'),
      'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n',
    );
    await execFileAsync('git', ['-C', repositoryPath, 'add', 'README.md']);
    await execFileAsync('git', ['-C', repositoryPath, 'commit', '-m', 'initial']);
    await writeFile(
      join(repositoryPath, 'README.md'),
      'ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n',
    );

    const runtime = new LocalRepositoryRuntime({ rootPath: root });
    const repository = await runtime.register({ path: repositoryPath });
    const files = await runtime.listFiles(repository.repositoryId);
    expect(files).toContainEqual({ path: 'README.md', kind: 'file' });
    const changeSet = await runtime.createChangeSet(repository.repositoryId);
    expect(changeSet.hunks).toHaveLength(2);
    const first = changeSet.hunks[0];
    expect(first).toBeDefined();
    const applied = await runtime.applyChangeSetHunks({
      changeSetId: changeSet.changeSetId,
      hunkIds: [first?.hunkId ?? ''],
      action: 'accept',
    });
    expect(applied.changeSet.state).toBe('partially_accepted');
    await expect(
      runtime.runTest({
        repositoryId: repository.repositoryId,
        command: 'git',
        args: ['diff', '--check'],
      }),
    ).resolves.toMatchObject({ status: 'passed' });
    await expect(
      runtime.runTest({
        repositoryId: repository.repositoryId,
        command: 'sh',
        args: ['-c', 'true'],
      }),
    ).rejects.toThrow('not allowed');
    await expect(runtime.getChangeSet(changeSet.changeSetId)).resolves.toMatchObject({
      state: 'partially_accepted',
    });

    await writeFile(join(repositoryPath, 'generated.txt'), 'generated artifact\n');
    const untrackedChangeSet = await runtime.createChangeSet(repository.repositoryId);
    const generatedHunk = untrackedChangeSet.hunks.find(
      (hunk) => hunk.filePath === 'generated.txt',
    );
    expect(generatedHunk).toBeDefined();
    await runtime.applyChangeSetHunks({
      changeSetId: untrackedChangeSet.changeSetId,
      hunkIds: [generatedHunk?.hunkId ?? ''],
      action: 'accept',
    });
    await expect(
      execFileAsync('git', [
        '-C',
        repositoryPath,
        'diff',
        '--cached',
        '--exit-code',
        '--',
        'generated.txt',
      ]),
    ).rejects.toBeDefined();
    await expect(
      runtime.applyChangeSetHunks({
        changeSetId: untrackedChangeSet.changeSetId,
        hunkIds: [generatedHunk?.hunkId ?? ''],
        action: 'revert',
      }),
    ).resolves.toMatchObject({ changeSet: { state: 'reverted' } });
  });
});

describe('runtime profiles and Jupyter discovery', () => {
  it('persists profiles and immutable environment revisions without secret values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-runtime-profile-'));
    const profiles = new LocalRuntimeProfileRuntime(root, () => '2026-08-06T00:00:00.000Z');
    const profile = await profiles.createProfile({
      profileId: 'python-local',
      name: 'Local Python',
      kind: 'python',
      executable: 'python3',
      environmentVariableNames: ['DATASET_TOKEN', 'INVALID-NAME'],
    });
    const revision = await profiles.createRevision({
      profileId: profile.profileId,
      lockfile: 'numpy==2.0.0\n',
      packages: ['numpy==2.0.0'],
    });
    expect(revision).toMatchObject({
      profileId: 'python-local',
      revision: 1,
      lockfileHash: expect.stringMatching(/^sha256:/),
    });
    expect(JSON.stringify(await profiles.listProfiles())).not.toContain('DATASET_TOKEN_VALUE');
    const jupyter = new LocalJupyterSessionRuntime({
      rootPath: root,
      profiles,
      executable: 'spyderbyte-jupyter-not-installed',
      clock: () => '2026-08-06T00:00:00.000Z',
    });
    await expect(jupyter.discover()).resolves.toMatchObject({ available: false });
  });

  it('launches a loopback Jupyter session with an ephemeral token and recovers its lifecycle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-jupyter-session-'));
    const executable = join(root, 'fake-jupyter');
    await writeFile(
      executable,
      '#!/usr/bin/env node\nif (process.argv.includes("--version")) { console.log("fake-jupyter 1.0"); process.exit(0); }\nsetTimeout(() => console.log("http://127.0.0.1:43123/lab"), 20);\nsetInterval(() => {}, 1000);\n',
      { mode: 0o755 },
    );
    await chmod(executable, 0o755);
    const profiles = new LocalRuntimeProfileRuntime(root);
    const runtime = new LocalJupyterSessionRuntime({
      rootPath: root,
      profiles,
      executable,
      tokenTtlMs: 60_000,
    });
    const launched = await runtime.launch({ projectPath: root });
    expect(launched.session).toMatchObject({ state: 'ready', port: 43123 });
    expect(launched.accessUrl).toContain('token=');
    expect((await runtime.list())[0]?.accessUrl).not.toContain('token=');
    await expect(runtime.stop(launched.session.sessionId)).resolves.toMatchObject({
      state: 'stopped',
    });
  });
});

describe('local pipeline runtime', () => {
  it('validates and executes a typed query stage with durable run state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-pipeline-'));
    const query = new LocalQueryRuntime();
    const notebooks = new LocalNotebookRuntime(
      query,
      () => '2026-08-05T00:00:00.000Z',
      join(root, 'notebooks.json'),
    );
    const connectors = new MeltanoConnectorRuntime({ rootPath: root });
    const runtime = new LocalPipelineRuntime({ rootPath: root, query, notebooks, connectors });
    const created = await runtime.create('pipeline-test', 'Pipeline test');
    const definition = await runtime.upsert({
      ...created,
      stages: [
        {
          stageId: 'query-1',
          label: 'Bounded query',
          type: 'query',
          dependsOn: [],
          config: { sql: 'SELECT 1 AS value' },
        },
      ],
    });
    expect(runtime.validate(definition)).toMatchObject({
      valid: true,
      executionOrder: ['query-1'],
    });
    const run = await runtime.run(definition.pipelineId);
    expect(run).toMatchObject({ status: 'completed', pipelineId: definition.pipelineId });
    expect(run.stageResults[0]).toMatchObject({ stageId: 'query-1', status: 'completed' });
    await expect(runtime.listRuns(definition.pipelineId)).resolves.toHaveLength(1);
  });
});

describe('local automation runtime', () => {
  it('persists a manual trigger over a pipeline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-automation-'));
    const query = new LocalQueryRuntime();
    const notebooks = new LocalNotebookRuntime(
      query,
      () => '2026-08-05T00:00:00.000Z',
      join(root, 'notebooks.json'),
    );
    const connectors = new MeltanoConnectorRuntime({ rootPath: root });
    const pipelines = new LocalPipelineRuntime({ rootPath: root, query, notebooks, connectors });
    await pipelines.create('automation-pipeline', 'Automation pipeline');
    const automations = new LocalAutomationRuntime({ rootPath: root, pipelines });
    const automation = await automations.create({
      automationId: 'automation-test',
      name: 'Manual test',
      pipelineId: 'automation-pipeline',
      trigger: { type: 'manual' },
    });
    await expect(automations.trigger(automation.automationId)).resolves.toMatchObject({
      automationId: automation.automationId,
      status: 'completed',
    });
    await expect(automations.listRuns(automation.automationId)).resolves.toHaveLength(1);
  });

  it('verifies signed webhooks, dispatches events, and bounds backfills', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-automation-triggers-'));
    const query = new LocalQueryRuntime();
    const notebooks = new LocalNotebookRuntime(query);
    const connectors = new MeltanoConnectorRuntime({ rootPath: root });
    const pipelines = new LocalPipelineRuntime({ rootPath: root, query, notebooks, connectors });
    await pipelines.create('automation-pipeline', 'Automation pipeline');
    const automations = new LocalAutomationRuntime({
      rootPath: root,
      pipelines,
      secretResolver: async (secretId) => (secretId === 'webhook-secret' ? 'secret' : undefined),
    });
    const webhook = await automations.create({
      automationId: 'automation-webhook',
      name: 'Signed webhook',
      pipelineId: 'automation-pipeline',
      trigger: { type: 'webhook', secretId: 'webhook-secret' },
    });
    const payload = { event: 'published' };
    const signature = createHmac('sha256', 'secret').update(JSON.stringify(payload)).digest('hex');
    await expect(
      automations.receiveWebhook(webhook.automationId, { payload, signature }),
    ).resolves.toMatchObject({
      triggeredBy: 'webhook',
      status: 'completed',
    });
    const event = await automations.create({
      automationId: 'automation-event',
      name: 'Runtime event',
      pipelineId: 'automation-pipeline',
      trigger: { type: 'event', topic: 'media', eventName: 'render.completed' },
      maxBackfillRuns: 2,
    });
    await expect(
      automations.receiveEvent({ topic: 'media', eventName: 'render.completed' }),
    ).resolves.toHaveLength(1);
    await expect(automations.backfill(event.automationId, { count: 2 })).resolves.toHaveLength(2);
    await expect(automations.backfill(event.automationId, { count: 3 })).rejects.toThrow(
      'between 1 and 2',
    );
  });
});

describe('provider actions and serving runtime', () => {
  it('executes a scoped GitHub pull request action with a vault token', async () => {
    const oauth = new OAuthService({
      connectors: [
        {
          connectorId: 'github',
          displayName: 'GitHub',
          authKind: 'oauth2',
          scopes: ['repo'],
        },
      ],
      vault: new MemoryCredentialVault(),
    });
    const connection = await oauth.createManagedConnection({
      connectorId: 'github',
      displayName: 'GitHub account',
      scopes: ['repo'],
      config: { access_token: 'github-token' },
    });
    let request: { url: string; method: string; body?: string } | undefined;
    const runtime = new CloudProviderActionRuntime({
      oauth,
      fetcher: async (input, init) => {
        request = {
          url: String(input),
          method: init?.method ?? 'GET',
          ...(typeof init?.body === 'string' ? { body: init.body } : {}),
        };
        return new Response(JSON.stringify({ number: 42 }), { status: 201 });
      },
    });
    await expect(
      runtime.execute({
        providerId: 'github',
        connectionId: connection.connectionId,
        operation: 'createPullRequest',
        input: {
          owner: 'spyderbyte',
          repo: 'demo',
          title: 'Change',
          head: 'feature/change',
          base: 'main',
        },
      }),
    ).resolves.toMatchObject({ status: 'completed', output: { number: 42 } });
    expect(request).toMatchObject({
      url: 'https://api.github.com/repos/spyderbyte/demo/pulls',
      method: 'POST',
    });
    expect(request?.body).toContain('feature/change');
  });

  it('serves a configured local process through health, canary, promote, and rollback states', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-serving-'));
    const runtime = new LocalServingRuntime({
      rootPath: root,
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 5000)'],
      fetcher: async () => new Response('{}', { status: 200 }),
    });
    const deployment = await runtime.serve({
      deploymentId: 'deployment-test',
      modelId: 'model-test',
      port: 8000,
      healthUrl: 'http://127.0.0.1:8000/health',
    });
    await expect(runtime.observe(deployment.deploymentId)).resolves.toMatchObject({
      state: 'healthy',
    });
    await expect(runtime.canary(deployment.deploymentId, 10)).resolves.toMatchObject({
      trafficPercent: 10,
    });
    await expect(runtime.promote(deployment.deploymentId)).resolves.toMatchObject({
      trafficPercent: 100,
    });
    await expect(runtime.rollback(deployment.deploymentId)).resolves.toMatchObject({
      state: 'rolled-back',
      trafficPercent: 0,
    });
  });
});

describe('configured local training runtime', () => {
  it('runs an explicitly configured command and preserves metrics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-training-'));
    const runtime = new LocalTrainingRuntime({
      rootPath: root,
      command: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify({metrics:{accuracy:0.9}}))'],
    });
    expect(runtime.available).toBe(true);
    await expect(runtime.train({ configuration: { epochs: 1 } })).resolves.toMatchObject({
      status: 'completed',
      metrics: { accuracy: 0.9 },
    });
    await expect(runtime.list()).resolves.toHaveLength(1);
  });
});
