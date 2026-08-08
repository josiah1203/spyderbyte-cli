// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import App from '../src/App';
import Assets from '../src/screens/Assets';
import Models from '../src/screens/Models';
import Notebooks from '../src/screens/Notebooks';
import Onboarding from '../src/screens/Onboarding';
import ProjectDetail from '../src/screens/ProjectDetail';
import SQLWorkbench from '../src/screens/SQLWorkbench';
import { RuntimeProvider } from '../src/runtime/RuntimeProvider';
import { DeterministicMockRuntimeClient } from '../src/runtime/mock';
import { RuntimeStore } from '../src/runtime/store';
import type {
  CapabilitiesProjection,
  FrontendCommand,
  JsonValue,
  ProjectionEnvelope,
} from '../src/runtime/contracts';
import { DEFAULT_LAYOUT } from '../src/data/layout';

const routeCases = [
  ['/', 'Home'],
  ['/projects', 'Projects'],
  ['/runs', 'Runs'],
  ['/assets', 'Assets'],
  ['/connections', 'Connections'],
  ['/machine', 'Compute'],
  ['/license', 'License'],
  ['/settings/workspace/general', 'Settings'],
  ['/visualizations', 'Visualizations'],
  ['/automations', 'Automations'],
  ['/data', 'Data'],
  ['/sql', 'SQL'],
  ['/notebooks', 'Notebooks'],
  ['/code', 'Repositories'],
  ['/models', 'Models'],
  ['/deployments', 'Deployments'],
  ['/environments', 'Environments'],
  ['/approvals', 'Approvals'],
  ['/governance', 'Governance'],
  ['/audit', 'Audit'],
  ['/incidents', 'Incidents'],
  ['/catalog', 'Catalog'],
  ['/repositories', 'Repositories'],
  ['/experiments', 'Experiments'],
  ['/pipelines', 'Pipelines'],
  ['/resources', 'Resources'],
  ['/worktrees', 'Worktrees'],
] as const;

function renderApp(pathname: string) {
  window.history.replaceState({}, '', pathname);
  return render(<App runtimeStore={new RuntimeStore(new DeterministicMockRuntimeClient())} />);
}

class ArtifactRuntimeClient extends DeterministicMockRuntimeClient {
  override async query<T>(projection: string): Promise<ProjectionEnvelope<T>> {
    if (projection === 'artifact-catalog-lineage') {
      const state = {
        artifacts: {
          'artifact-source': {
            artifactId: 'artifact-source',
            state: 'valid',
            currentVersion: 2,
            lastEventAt: '2026-08-07T00:00:00.000Z',
          },
        },
      };
      return {
        projectionName: projection,
        state,
        data: state,
        cursor: 0,
        streamHead: 0,
        freshness: 'fresh',
      } as ProjectionEnvelope<T>;
    }
    return super.query<T>(projection);
  }

  override async get<T>(path: string, options: { signal?: AbortSignal } = {}): Promise<T> {
    void options;
    if (path === '/v1/artifacts/artifact-source') {
      return {
        artifactId: 'artifact-source',
        state: 'valid',
        currentVersion: 2,
        reference: {
          artifactId: 'artifact-source',
          version: 2,
          mediaType: 'text/csv',
          contentHash: 'sha256:current',
        },
        createdBy: { actorId: 'actor-1', displayName: 'Local user' },
        publishedAt: '2026-08-07T00:00:00.000Z',
      } as T;
    }
    if (path === '/v1/artifacts/artifact-source/versions') {
      return [
        {
          reference: {
            artifactId: 'artifact-source',
            version: 1,
            mediaType: 'text/csv',
            contentHash: 'sha256:old',
          },
          publishedAt: '2026-08-06T00:00:00.000Z',
        },
        {
          reference: {
            artifactId: 'artifact-source',
            version: 2,
            mediaType: 'text/csv',
            contentHash: 'sha256:current',
          },
          publishedAt: '2026-08-07T00:00:00.000Z',
        },
      ] as T;
    }
    if (path === '/v1/artifacts/artifact-source/lineage') {
      return [
        {
          artifactId: 'artifact-upstream',
          version: 1,
          mediaType: 'text/csv',
        },
      ] as T;
    }
    if (path === '/v1/artifacts/artifact-source/versions/2/content') {
      return {
        artifactId: 'artifact-source',
        version: 2,
        mediaType: 'text/csv',
        contentHash: 'sha256:current',
        contentBase64: btoa('name,value\na,2\nb,3\n'),
      } as T;
    }
    if (path === '/v1/artifacts/artifact-source/diff?fromVersion=1&toVersion=2') {
      return {
        schemaVersion: 1,
        artifactId: 'artifact-source',
        fromVersion: 1,
        toVersion: 2,
        mediaType: 'text/csv',
        format: 'text',
        changed: true,
        summary: { added: 1, removed: 0, changed: 1 },
        changes: [
          {
            kind: 'changed',
            path: 'line:2',
            before: 'a,1',
            after: 'a,2',
          },
        ],
      } as T;
    }
    return super.get<T>(path);
  }
}

class NotebookContextRuntimeClient extends DeterministicMockRuntimeClient {
  readonly runRequests: JsonValue[] = [];
  private readonly notebook = {
    schemaVersion: 1,
    notebookId: 'notebook-main',
    title: 'Individual user notebook',
    revision: 2,
    state: 'active',
    kernel: 'local-python',
    environment: 'local-python',
    cells: [
      {
        cellId: 'cell-1',
        type: 'sql',
        source: 'SELECT * FROM dataset LIMIT 100',
        status: 'idle',
        outputs: [],
        updatedAt: '2026-08-07T00:00:00.000Z',
      },
    ],
    createdAt: '2026-08-07T00:00:00.000Z',
    updatedAt: '2026-08-07T00:00:00.000Z',
  };

  override async get<T>(path: string, options: { signal?: AbortSignal } = {}): Promise<T> {
    void options;
    if (path === '/v1/capabilities') {
      return {
        runtimeMode: 'mock',
        workspaceMode: 'personal_local',
        projections: ['notebooks'],
        commands: ['RunNotebook'],
        capabilities: { 'notebooks.execute': { enabled: true, projections: ['notebooks'] } },
      } satisfies CapabilitiesProjection as T;
    }
    if (path === '/v1/notebooks/notebook-main') return this.notebook as T;
    if (path === '/v1/runtimes/profiles') return { profiles: [], revisions: [] } as T;
    if (path === '/v1/jupyter/discovery') return { available: false, executable: 'jupyter' } as T;
    if (path === '/v1/jupyter/sessions') return [] as T;
    if (path === '/v1/artifacts/artifact-source/versions/2/content') {
      return {
        artifactId: 'artifact-source',
        version: 2,
        mediaType: 'text/csv',
        contentHash: 'sha256:current',
        contentBase64: btoa('name,value\na,2\nb,3\n'),
      } as T;
    }
    return super.get<T>(path, options);
  }

  async post<T>(path: string, body: JsonValue): Promise<T> {
    if (path === '/v1/notebooks/notebook-main/cells/cell-1/run') {
      this.runRequests.push(body);
      return {
        notebook: {
          ...this.notebook,
          cells: [
            {
              ...this.notebook.cells[0],
              status: 'completed',
              executionCount: 1,
              outputs: [
                {
                  outputId: 'output-1',
                  type: 'table',
                  value: { columns: ['name', 'value'], rows: [['a', '2']] },
                  createdAt: '2026-08-07T00:00:00.000Z',
                },
              ],
            },
          ],
        },
      } as T;
    }
    throw new Error(`Notebook context mock has no POST resource for ${path}`);
  }
}

class ProviderSetupRuntimeClient extends DeterministicMockRuntimeClient {
  readonly providerRequests: unknown[] = [];
  private provider = {
    providerConfigurationId: 'provider-config-1',
    providerId: 'openai-primary',
    providerType: 'openai',
    displayName: 'Primary OpenAI',
    endpoint: 'https://api.openai.com/v1',
    defaultModelId: 'gpt-test',
    state: 'configured',
    authenticationState: 'required',
    local: false,
  };

  override async get<T>(path: string, options: { signal?: AbortSignal } = {}): Promise<T> {
    if (path === '/v1/capabilities') {
      return {
        runtimeMode: 'mock',
        workspaceMode: 'personal_local',
        projections: [],
        commands: [],
        capabilities: { 'model-runtime': { enabled: true, projections: [] } },
      } satisfies CapabilitiesProjection as T;
    }
    if (path === '/v1/models/catalog') {
      return {
        models: [],
        runtimes: [],
        installed: [],
        downloads: [],
        providerPriority: ['openai-primary'],
        routingPolicy: {
          allowExternalModels: true,
          allowProviderFallback: true,
          allowedDataClasses: ['public'],
        },
      } as T;
    }
    if (path === '/v1/providers') {
      return {
        providers: [this.provider],
        credentials: [
          { providerConfigurationId: this.provider.providerConfigurationId, status: 'active' },
        ],
      } as T;
    }
    return super.get<T>(path, options);
  }

  async post<T>(path: string, body: JsonValue): Promise<T> {
    if (path === '/v1/providers') {
      this.providerRequests.push(body);
      this.provider = {
        ...this.provider,
        displayName:
          body !== null && typeof body === 'object' && 'displayName' in body
            ? String(body.displayName)
            : this.provider.displayName,
        state: 'configured',
        authenticationState: 'authenticated',
      };
      return this.provider as T;
    }
    if (path === `/v1/providers/${this.provider.providerConfigurationId}/test`) {
      return {
        providerConfigurationId: this.provider.providerConfigurationId,
        state: 'callable',
        checks: [
          { name: 'authentication', status: 'passed', message: 'Credential is available.' },
          { name: 'inference', status: 'passed', message: 'Minimal inference request succeeded.' },
        ],
        actionableErrors: [],
      } as T;
    }
    throw new Error(`Provider setup mock has no resource for ${path}`);
  }
}

class QueryHandoffRuntimeClient extends DeterministicMockRuntimeClient {
  override async get<T>(path: string, options: { signal?: AbortSignal } = {}): Promise<T> {
    void options;
    if (path === '/v1/capabilities') {
      return {
        runtimeMode: 'mock',
        workspaceMode: 'personal_local',
        projections: ['queries'],
        commands: [],
        capabilities: { 'queries.execute': { enabled: true, projections: [] } },
      } satisfies CapabilitiesProjection as T;
    }
    if (path === '/v1/data/queries/query-from-handoff') {
      return {
        queryId: 'query-from-handoff',
        sql: 'SELECT * FROM dataset LIMIT 1',
        connectionId: 'connection-sales',
        datasetId: 'dataset-sales',
        datasetVersion: 3,
        result: {
          queryId: 'query-from-handoff',
          status: 'completed',
          engine: 'sqlite3-local-fallback',
          sql: 'SELECT * FROM dataset LIMIT 1',
          columns: [{ name: 'customer', type: 'string' }],
          rows: [['persisted-customer']],
          rowCount: 1,
          truncated: false,
          estimatedCost: 1,
          elapsedMs: 4,
          executedAt: '2026-08-07T00:00:00.000Z',
          artifact: {
            artifactId: 'query-result-query-from-handoff',
            contentHash: 'sha256:persisted-result',
            mediaType: 'application/json',
            createdAt: '2026-08-07T00:00:00.000Z',
          },
        },
      } as T;
    }
    return super.get<T>(path, options);
  }
}

class OnboardingRuntimeClient extends DeterministicMockRuntimeClient {
  readonly onboardingRequests: JsonValue[] = [];
  readonly settingsWrites: JsonValue[] = [];

  override async get<T>(path: string, options: { signal?: AbortSignal } = {}): Promise<T> {
    if (path === '/v1/profile') {
      return {
        profile: { displayName: 'Local user', onboardingComplete: false },
        revision: 0,
      } as T;
    }
    if (path === '/v1/workspace') return { manifest: { name: 'Analysis workspace' } } as T;
    if (path === '/v1/settings?scope=user' || path === '/v1/settings?scope=workspace') {
      return { revision: 0, values: {} } as T;
    }
    if (path === '/v1/onboarding') {
      return {
        onboarding: {
          status: 'not_started',
          environment: {
            project: {
              projectName: 'sample-analysis',
              likelyWorkloads: ['python', 'notebook'],
            },
          },
        },
        firstQuestionReady: true,
        authenticationRequiredForFirstQuestion: false,
        choices: [
          { id: 'local-model', label: 'Use a local model', requiresAuthentication: false },
          { id: 'provider-key', label: 'Use a provider key', requiresAuthentication: true },
          { id: 'spyderbyte-cloud', label: 'Use Spyderbyte Cloud', requiresAuthentication: true },
          { id: 'configure-later', label: 'Configure later', requiresAuthentication: false },
        ],
      } as T;
    }
    if (path === '/v1/models/catalog') {
      return {
        models: [
          {
            modelId: 'fixture-model',
            providerId: 'deterministic',
            displayName: 'Offline fixture',
            state: 'ready',
            local: true,
          },
        ],
      } as T;
    }
    return super.get<T>(path, options);
  }

  async post<T>(path: string, body: JsonValue): Promise<T> {
    if (path === '/v1/onboarding') {
      this.onboardingRequests.push(body);
      return {
        onboarding: {
          status: 'configured',
          choice: 'provider-key',
          environment: { project: { projectName: 'sample-analysis' } },
        },
        firstQuestionReady: false,
        authenticationRequiredForFirstQuestion: false,
      } as T;
    }
    throw new Error(`Onboarding test client has no POST resource for ${path}`);
  }

  async put<T>(_path: string, body: JsonValue): Promise<T> {
    this.settingsWrites.push(body);
    return { revision: this.settingsWrites.length } as T;
  }
}

class DatasetRuntimeClient extends DeterministicMockRuntimeClient {
  readonly uploadRequests: JsonValue[] = [];
  readonly publishRequests: JsonValue[] = [];
  readonly planRequests: FrontendCommand[] = [];
  readonly runRequests: string[] = [];
  readonly projectId = '019b4d00-0000-7000-8000-000000000201';
  readonly workflowId = '019b4d00-0000-7000-8000-000000000202';

  override async query<T>(projection: string): Promise<ProjectionEnvelope<T>> {
    if (projection === 'projects') {
      const state = {
        projects: {
          [this.projectId]: {
            projectId: this.projectId,
            name: 'CSV analysis',
            objective: 'Validate this sales dataset for local analysis',
            status: 'active',
          },
        },
      };
      return {
        projectionName: projection,
        state,
        data: state,
        cursor: 0,
        freshness: 'fresh',
      } as ProjectionEnvelope<T>;
    }
    return super.query<T>(projection);
  }

  override async get<T>(path: string, options: { signal?: AbortSignal } = {}): Promise<T> {
    void options;
    if (path === `/v1/projects/${this.projectId}/conversation`) {
      return {
        conversationId: '019b4d00-0000-7000-8000-000000000203',
        projectId: this.projectId,
        messages: [],
        generating: false,
        updatedAt: '2026-08-07T00:00:00.000Z',
      } as T;
    }
    return super.get<T>(path, options);
  }

  async post<T>(path: string, body: JsonValue): Promise<T> {
    if (path === '/v1/artifacts/uploads') {
      this.uploadRequests.push(body);
      return { stagedUploadId: '019b4d00-0000-7000-8000-000000000204' } as T;
    }
    if (path.includes('/versions')) {
      this.publishRequests.push(body);
      return {} as T;
    }
    if (path === `/v1/workflows/${this.workflowId}/run`) {
      this.runRequests.push(path);
      return {
        workflowId: this.workflowId,
        status: 'completed',
        sourceArtifact: { artifactId: '019b4d00-0000-7000-8000-000000000205', version: 1 },
        governanceDecisionArtifact: {
          artifactId: '019b4d00-0000-7000-8000-000000000206',
          version: 1,
        },
        dataQualityReportArtifact: {
          artifactId: '019b4d00-0000-7000-8000-000000000207',
          version: 1,
        },
        validatedDatasetArtifact: {
          artifactId: '019b4d00-0000-7000-8000-000000000208',
          version: 1,
        },
        reasonCodes: [],
      } as T;
    }
    throw new Error(`Dataset test client has no POST resource for ${path}`);
  }

  override async plan(command: FrontendCommand) {
    this.planRequests.push(command);
    const sourceArtifactId =
      command.payload !== null &&
      typeof command.payload === 'object' &&
      !Array.isArray(command.payload)
        ? String(command.payload.sourceArtifactId)
        : '019b4d00-0000-7000-8000-000000000205';
    return {
      accepted: true,
      result: {
        workflowId: this.workflowId,
        planVersion: 1,
        plan: {
          workflowId: this.workflowId,
          version: 1,
          steps: [
            {
              stepId: '019b4d00-0000-7000-8000-000000000209',
              title: 'Review governance and access policy',
              description: 'Review dataset access and retention before validation.',
              tier: 1,
              agentType: 'governance',
              dependsOn: [],
              requiredCapabilities: ['dataset.read'],
              approvalRequired: false,
              acceptanceCriteria: ['Governance decision is published'],
            },
          ],
        },
        sourceArtifact: { artifactId: sourceArtifactId, version: 1, mediaType: 'text/csv' },
      },
    };
  }
}

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
  window.localStorage.clear();
});

describe('React frontend route and shell smoke coverage', () => {
  it.each(routeCases)('renders %s as %s', (pathname, title) => {
    renderApp(pathname);
    expect(document.querySelector('.app-shell')).not.toBeNull();
    expect(document.querySelector('.topbar-title')?.textContent).toBe(title);
  });

  it('redirects unknown paths to Home', async () => {
    renderApp('/unknown-capability');
    await waitFor(() => {
      expect(window.location.pathname).toBe('/');
    });
    expect(document.querySelector('.topbar-title')?.textContent).toBe('Home');
  });

  it('supports navigation collapse, profile theme selection, and notifications', () => {
    renderApp('/');

    fireEvent.click(screen.getByRole('button', { name: 'Collapse navigation' }));
    expect(document.querySelector('.app-sidebar')?.getAttribute('data-open')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'Expand navigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open profile menu' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Light' }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(window.localStorage.getItem('design-system-theme')).toBe('light');

    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
    expect(screen.getByRole('dialog', { name: 'Notifications' })).toBeTruthy();
  });

  it('loads immutable artifact versions and lineage from the asset catalog', async () => {
    const store = new RuntimeStore(new ArtifactRuntimeClient());
    render(
      <RuntimeProvider store={store}>
        <Assets />
      </RuntimeProvider>,
    );

    await waitFor(() => expect(screen.getByText('artifact-source')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Inspect versions and lineage' }));
    await waitFor(() => expect(screen.getByText('artifact-upstream · v1 · text/csv')).toBeTruthy());
    expect(screen.getByText('sha256:current')).toBeTruthy();
    expect(screen.getByText('artifact-source · v2 · text/csv')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Continue in notebook' }).getAttribute('href')).toBe(
      '/notebooks?artifact=artifact-source&version=2',
    );
  });

  it('opens an artifact detail directly from the lineage route query', async () => {
    window.history.replaceState({}, '', '/assets?artifact=artifact-source');
    const store = new RuntimeStore(new ArtifactRuntimeClient());
    render(
      <RuntimeProvider store={store}>
        <Assets />
      </RuntimeProvider>,
    );

    await waitFor(() => expect(screen.getByText('artifact-source · v2 · text/csv')).toBeTruthy());
    expect(screen.getByRole('heading', { name: 'artifact-source' })).toBeTruthy();
  });

  it('opens, previews, and diffs immutable artifact content', async () => {
    const store = new RuntimeStore(new ArtifactRuntimeClient());
    render(
      <RuntimeProvider store={store}>
        <Assets />
      </RuntimeProvider>,
    );

    await waitFor(() => expect(screen.getByText('artifact-source')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Inspect versions and lineage' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Open current artifact' })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open current artifact' }));
    await waitFor(() => expect(screen.getByText(/name,value/)).toBeTruthy());
    expect(screen.getByText('Opened immutable artifact v2.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Compare v1 → v2' }));
    await waitFor(() => expect(screen.getByText('Changed')).toBeTruthy());
    expect(screen.getByText('line:2')).toBeTruthy();
    expect(screen.getByText('+1 / -0 · 1 changed')).toBeTruthy();
  });

  it('continues an immutable CSV artifact into notebook SQL context', async () => {
    window.history.replaceState({}, '', '/notebooks?artifact=artifact-source&version=2');
    const client = new NotebookContextRuntimeClient();
    render(
      <MemoryRouter>
        <RuntimeProvider store={new RuntimeStore(client)}>
          <Notebooks />
        </RuntimeProvider>
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(screen.getByText(/SQL cells run against this immutable artifact/)).toBeTruthy(),
    );
    expect(screen.getByText(/artifact-source · v2 · text\/csv/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Run cell' }));
    await waitFor(() => expect(client.runRequests).toHaveLength(1));
    expect(client.runRequests[0]).toMatchObject({
      sourceData: {
        tableName: 'dataset',
        columns: ['name', 'value'],
        rows: [
          ['a', '2'],
          ['b', '3'],
        ],
      },
    });
    await waitFor(() => expect(screen.getByText('Cell 1 completed.')).toBeTruthy());
  });

  it('hydrates the SQL workbench from an authoritative persisted query handoff', async () => {
    window.history.replaceState({}, '', '/sql?queryId=query-from-handoff');
    render(
      <MemoryRouter>
        <RuntimeProvider store={new RuntimeStore(new QueryHandoffRuntimeClient())}>
          <SQLWorkbench />
        </RuntimeProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('persisted-customer')).toBeTruthy());
    expect(
      screen.getByText(
        'Loaded persisted query result query-result-query-from-handoff from the workspace.',
      ),
    ).toBeTruthy();
    expect(screen.getByDisplayValue('SELECT * FROM dataset LIMIT 1')).toBeTruthy();
    expect(
      screen.getByText('1 rows · sqlite3-local-fallback · query-result-query-from-handoff'),
    ).toBeTruthy();
  });

  it('configures and preflights a provider without retaining its API key in the UI', async () => {
    const client = new ProviderSetupRuntimeClient();
    render(
      <MemoryRouter>
        <RuntimeProvider store={new RuntimeStore(client)}>
          <Models />
        </RuntimeProvider>
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Connect a model provider' })).toBeTruthy(),
    );
    fireEvent.change(screen.getByLabelText('Provider display name'), {
      target: { value: 'Local OpenAI gateway' },
    });
    fireEvent.change(screen.getByLabelText('Provider API key'), {
      target: { value: 'super-secret-provider-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add provider securely' }));

    await waitFor(() => expect(screen.getByText('Local OpenAI gateway')).toBeTruthy());
    expect(screen.queryByText('super-secret-provider-key')).toBeNull();
    expect(client.providerRequests[0]).toMatchObject({
      providerType: 'openai',
      displayName: 'Local OpenAI gateway',
      apiKey: 'super-secret-provider-key',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Test Local OpenAI gateway' }));
    await waitFor(() => expect(screen.getByText('Provider preflight: callable')).toBeTruthy());
    expect(screen.getByText('inference: passed')).toBeTruthy();
    expect(screen.queryByText('super-secret-provider-key')).toBeNull();
  });

  it('stages, plans, runs, and exposes CSV workflow artifacts from Project Detail', async () => {
    const client = new DatasetRuntimeClient();
    render(
      <MemoryRouter>
        <RuntimeProvider store={new RuntimeStore(client)}>
          <ProjectDetail
            projectId={client['projectId']}
            onBack={() => undefined}
            onSelectRun={() => undefined}
            onNavigate={() => undefined}
          />
        </RuntimeProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('CSV analysis')).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: 'Dataset' }));
    fireEvent.change(screen.getByLabelText('CSV dataset'), {
      target: {
        files: [new File(['id,value\n1,10\n'], 'sales.csv', { type: 'text/csv' })],
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Stage and create plan' }));

    await waitFor(() => expect(screen.getByText('Typed dataset plan')).toBeTruthy());
    expect(client.uploadRequests).toHaveLength(1);
    expect(client.publishRequests).toHaveLength(1);
    expect(client.planRequests[0]?.commandType).toBe('ValidateDataset');
    expect(screen.getByText('Review before execution')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Run reviewed plan' }));
    await waitFor(() => expect(screen.getByText('Validated dataset')).toBeTruthy());
    expect(client.runRequests).toEqual([`/v1/workflows/${client['workflowId']}/run`]);
    expect(screen.getByRole('button', { name: 'Inspect artifact lineage' })).toBeTruthy();
  });

  it('completes first-run provider onboarding through the local API boundary', async () => {
    const client = new OnboardingRuntimeClient();
    render(
      <MemoryRouter>
        <RuntimeProvider store={new RuntimeStore(client)}>
          <Onboarding layoutPreferences={DEFAULT_LAYOUT} onLayoutChange={() => undefined} />
        </RuntimeProvider>
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Analyst' } });
    for (let step = 0; step < 5; step += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    }
    await waitFor(() => expect(screen.getByText('Choose how to start')).toBeTruthy());
    expect(screen.getByText('Detected project: sample-analysis')).toBeTruthy();
    expect(screen.getByText('Workloads: python, notebook')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /Use a provider key/ }));
    fireEvent.change(screen.getByLabelText('Onboarding provider display name'), {
      target: { value: 'Primary provider' },
    });
    fireEvent.change(screen.getByLabelText('Onboarding provider API key'), {
      target: { value: 'first-run-secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));

    await waitFor(() => expect(client.onboardingRequests).toHaveLength(1));
    expect(client.onboardingRequests[0]).toMatchObject({
      choice: 'provider-key',
      provider: {
        providerType: 'openai',
        displayName: 'Primary provider',
        apiKey: 'first-run-secret',
      },
    });
    expect((screen.getByLabelText('Onboarding provider API key') as HTMLInputElement).value).toBe(
      '',
    );
    expect(screen.queryByText('first-run-secret')).toBeNull();
    expect(client.settingsWrites).toHaveLength(3);
  });
});
