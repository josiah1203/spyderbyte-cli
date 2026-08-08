import type { JsonValue } from '@agentic-platform/runtime-contracts';

export const SPYDERBYTE_JUPYTER_PLUGIN_ID = 'spyderbyte.jupyter-context';

export interface JupyterRuntimeContextV1 {
  readonly schemaVersion: 1;
  readonly notebookId: string;
  readonly projectId?: string;
  readonly projectPath?: string;
  readonly runtimeProfileId?: string;
  readonly environmentRevisionId?: string;
  readonly modelId?: string;
}

export interface JupyterCellExecutionInput {
  readonly cellId: string;
  readonly type: 'markdown' | 'python' | 'sql';
  readonly source: string;
  readonly sourceData?: JsonValue;
  readonly outputType?: 'text' | 'table' | 'chart' | 'image' | 'html' | 'report' | 'notebook';
  readonly revision?: number;
}

export interface JupyterArtifactPublication {
  readonly localArtifactId: string;
  readonly publishedArtifactId: string;
  readonly publication: JsonValue;
}

export interface JupyterExtensionApi {
  getContext(): JupyterRuntimeContextV1;
  setContext(patch: Partial<Omit<JupyterRuntimeContextV1, 'schemaVersion' | 'notebookId'>>): void;
  launchSession(input?: JsonValue): Promise<JsonValue>;
  getSession(sessionId: string): Promise<JsonValue>;
  reconnectSession(sessionId: string): Promise<JsonValue>;
  runCell(input: JupyterCellExecutionInput): Promise<JsonValue>;
  publishArtifact(cellId: string, artifactId: string, mediaType?: string): Promise<JsonValue>;
  getArtifactLineage(artifactId: string): Promise<JsonValue>;
  listRuntimeProfiles(): Promise<JsonValue>;
  runNotebook(input?: JsonValue): Promise<JsonValue>;
  listDataConnections(): Promise<JsonValue>;
  browseDataSchema(connectionId: string): Promise<JsonValue>;
  listDatasets(): Promise<JsonValue>;
  runDataQuery(input: JsonValue): Promise<JsonValue>;
  profileDataset(datasetId: string, version?: number): Promise<JsonValue>;
  qualityDataset(datasetId: string, input?: JsonValue): Promise<JsonValue>;
  handoffDataQuery(queryId: string): Promise<JsonValue>;
  listModels(): Promise<JsonValue>;
  listApprovals(): Promise<JsonValue>;
  getNotebookUsage(): Promise<JsonValue>;
  associateExperiment(experimentId: string): Promise<JsonValue>;
  listExperimentRuns(experimentId?: string): Promise<JsonValue>;
  getExperimentComparison(comparisonId: string): Promise<JsonValue>;
  compareExperiments(runIds: readonly string[]): Promise<JsonValue>;
  listDeployments(): Promise<JsonValue>;
  inspectDeployment(deploymentId: string): Promise<JsonValue>;
  invokeDeployment(deploymentId: string, input?: JsonValue): Promise<JsonValue>;
  smokeTestDeployment(deploymentId: string): Promise<JsonValue>;
  deploymentMetrics(deploymentId: string): Promise<JsonValue>;
  deploymentRevisions(deploymentId: string): Promise<JsonValue>;
}

export interface JupyterExtensionOptions {
  readonly baseUrl: string;
  readonly notebookId: string;
  readonly projectId?: string;
  readonly projectPath?: string;
  readonly runtimeProfileId?: string;
  readonly environmentRevisionId?: string;
  readonly modelId?: string;
  /** The host supplies a short-lived API token; this package never persists credentials. */
  readonly apiToken: string | (() => string | Promise<string>);
  readonly fetcher?: typeof fetch;
}

interface JupyterApiResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export interface JupyterLabCommandsLike {
  addCommand(
    id: string,
    command: {
      label: string;
      execute: (args?: Record<string, JsonValue>) => unknown | Promise<unknown>;
    },
  ): void;
}

export interface JupyterLabLike {
  readonly commands: JupyterLabCommandsLike;
}

export interface JupyterLabPluginLike {
  readonly id: string;
  readonly autoStart: true;
  activate(app: JupyterLabLike): void;
}

function cloneContext(context: JupyterRuntimeContextV1): JupyterRuntimeContextV1 {
  return structuredClone(context);
}

function identifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.includes('\0')) throw new TypeError(`${label} is required`);
  return normalized;
}

function pathSegment(value: string, label: string): string {
  return encodeURIComponent(identifier(value, label));
}

function parseJson(text: string): JsonValue {
  if (!text.trim()) return null;
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value as JsonValue;
  if (typeof value === 'object') return value as JsonValue;
  throw new Error('Spyderbyte returned a non-JSON response');
}

function objectValue(value: JsonValue): Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {};
}

export class SpyderbyteJupyterExtension implements JupyterExtensionApi {
  private readonly baseUrl: string;
  private readonly apiToken: JupyterExtensionOptions['apiToken'];
  private readonly fetcher: typeof fetch;
  private context: JupyterRuntimeContextV1;

  constructor(options: JupyterExtensionOptions) {
    this.baseUrl = options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`;
    this.apiToken = options.apiToken;
    this.fetcher = options.fetcher ?? fetch;
    this.context = {
      schemaVersion: 1,
      notebookId: identifier(options.notebookId, 'notebookId'),
      ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
      ...(options.projectPath === undefined ? {} : { projectPath: options.projectPath }),
      ...(options.runtimeProfileId === undefined
        ? {}
        : { runtimeProfileId: options.runtimeProfileId }),
      ...(options.environmentRevisionId === undefined
        ? {}
        : { environmentRevisionId: options.environmentRevisionId }),
      ...(options.modelId === undefined ? {} : { modelId: options.modelId }),
    };
  }

  getContext(): JupyterRuntimeContextV1 {
    return cloneContext(this.context);
  }

  setContext(patch: Partial<Omit<JupyterRuntimeContextV1, 'schemaVersion' | 'notebookId'>>): void {
    this.context = {
      ...this.context,
      ...patch,
    };
  }

  async launchSession(input: JsonValue = {}): Promise<JsonValue> {
    return this.post('/v1/jupyter/sessions', {
      ...objectValue(input),
      notebookId: this.context.notebookId,
      ...(this.context.projectId === undefined ? {} : { projectId: this.context.projectId }),
      ...(this.context.projectPath === undefined ? {} : { projectPath: this.context.projectPath }),
      ...(this.context.runtimeProfileId === undefined
        ? {}
        : { runtimeProfileId: this.context.runtimeProfileId }),
      ...(this.context.environmentRevisionId === undefined
        ? {}
        : { environmentRevisionId: this.context.environmentRevisionId }),
      context: this.getContext() as unknown as JsonValue,
    } as unknown as JsonValue);
  }

  async getSession(sessionId: string): Promise<JsonValue> {
    return this.get(`/v1/jupyter/sessions/${pathSegment(sessionId, 'sessionId')}`);
  }

  async reconnectSession(sessionId: string): Promise<JsonValue> {
    return this.post(`/v1/jupyter/sessions/${pathSegment(sessionId, 'sessionId')}/reconnect`, {
      context: this.getContext() as unknown as JsonValue,
    });
  }

  async runCell(input: JupyterCellExecutionInput): Promise<JsonValue> {
    return this.post(
      `/v1/notebooks/${pathSegment(this.context.notebookId, 'notebookId')}/cells/${pathSegment(input.cellId, 'cellId')}/run`,
      {
        type: input.type,
        source: input.source,
        ...(input.sourceData === undefined ? {} : { sourceData: input.sourceData }),
        ...(input.outputType === undefined ? {} : { outputType: input.outputType }),
        ...(input.revision === undefined ? {} : { revision: input.revision }),
        context: this.getContext() as unknown as JsonValue,
      } as unknown as JsonValue,
    );
  }

  async publishArtifact(
    cellId: string,
    artifactId: string,
    mediaType?: string,
  ): Promise<JsonValue> {
    return this.post(
      `/v1/notebooks/${pathSegment(this.context.notebookId, 'notebookId')}/cells/${pathSegment(cellId, 'cellId')}/publish`,
      {
        artifactId,
        ...(mediaType === undefined ? {} : { mediaType }),
        context: this.getContext() as unknown as JsonValue,
      },
    );
  }

  async getArtifactLineage(artifactId: string): Promise<JsonValue> {
    return this.get(`/v1/artifacts/${pathSegment(artifactId, 'artifactId')}/lineage`);
  }

  async listRuntimeProfiles(): Promise<JsonValue> {
    return this.get('/v1/runtimes/profiles');
  }

  async runNotebook(input: JsonValue = {}): Promise<JsonValue> {
    return this.post(`/v1/notebooks/${pathSegment(this.context.notebookId, 'notebookId')}/run`, {
      ...objectValue(input),
      context: this.getContext() as unknown as JsonValue,
    });
  }

  async listDataConnections(): Promise<JsonValue> {
    return this.get('/v1/data/connections');
  }

  async browseDataSchema(connectionId: string): Promise<JsonValue> {
    return this.get(`/v1/data/connections/${pathSegment(connectionId, 'connectionId')}/schema`);
  }

  async listDatasets(): Promise<JsonValue> {
    return this.get('/v1/datasets/local');
  }

  async runDataQuery(input: JsonValue): Promise<JsonValue> {
    return this.post('/v1/data/queries', input);
  }

  async profileDataset(datasetId: string, version?: number): Promise<JsonValue> {
    return this.post(
      `/v1/datasets/local/${pathSegment(datasetId, 'datasetId')}/profile`,
      version === undefined ? {} : { version },
    );
  }

  async qualityDataset(datasetId: string, input: JsonValue = {}): Promise<JsonValue> {
    return this.post(`/v1/datasets/local/${pathSegment(datasetId, 'datasetId')}/quality`, input);
  }

  async handoffDataQuery(queryId: string): Promise<JsonValue> {
    return this.post(`/v1/data/queries/${pathSegment(queryId, 'queryId')}/handoff`, {
      target: 'jupyter',
    });
  }

  async listModels(): Promise<JsonValue> {
    return this.get('/v1/models/catalog');
  }

  async listApprovals(): Promise<JsonValue> {
    return this.get('/v1/approvals');
  }

  async getNotebookUsage(): Promise<JsonValue> {
    return this.get(`/v1/notebooks/${pathSegment(this.context.notebookId, 'notebookId')}/usage`);
  }

  async associateExperiment(experimentId: string): Promise<JsonValue> {
    return this.post(
      `/v1/notebooks/${pathSegment(this.context.notebookId, 'notebookId')}/experiments`,
      { experimentId },
    );
  }

  async listExperimentRuns(experimentId?: string): Promise<JsonValue> {
    const query =
      experimentId === undefined ? '' : `?experimentId=${encodeURIComponent(experimentId)}`;
    return this.get(`/v1/experiment-runs/local${query}`);
  }

  async getExperimentComparison(comparisonId: string): Promise<JsonValue> {
    return this.get(
      `/v1/experiment-comparisons/local/${pathSegment(comparisonId, 'comparisonId')}`,
    );
  }

  async compareExperiments(runIds: readonly string[]): Promise<JsonValue> {
    return this.post('/v1/experiments/local/compare', { runIds: [...runIds] });
  }

  async listDeployments(): Promise<JsonValue> {
    return this.get('/v1/deployments/local');
  }

  async inspectDeployment(deploymentId: string): Promise<JsonValue> {
    return this.get(`/v1/deployments/local/${pathSegment(deploymentId, 'deploymentId')}`);
  }

  async invokeDeployment(deploymentId: string, input: JsonValue = {}): Promise<JsonValue> {
    return this.post(
      `/v1/deployments/local/${pathSegment(deploymentId, 'deploymentId')}/invoke`,
      input,
    );
  }

  async smokeTestDeployment(deploymentId: string): Promise<JsonValue> {
    return this.post(
      `/v1/deployments/local/${pathSegment(deploymentId, 'deploymentId')}/smoke-test`,
      {},
    );
  }

  async deploymentMetrics(deploymentId: string): Promise<JsonValue> {
    return this.get(`/v1/deployments/local/${pathSegment(deploymentId, 'deploymentId')}/metrics`);
  }

  async deploymentRevisions(deploymentId: string): Promise<JsonValue> {
    return this.get(`/v1/deployments/local/${pathSegment(deploymentId, 'deploymentId')}/revisions`);
  }

  private async get(path: string): Promise<JsonValue> {
    return this.request(path, { method: 'GET' });
  }

  private async post(path: string, body: JsonValue): Promise<JsonValue> {
    return this.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private async request(path: string, init: RequestInit): Promise<JsonValue> {
    const token = typeof this.apiToken === 'function' ? await this.apiToken() : this.apiToken;
    const response = (await this.fetcher(new URL(path, this.baseUrl), {
      ...init,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'x-spyderbyte-interface': 'jupyter',
        ...(init.headers ?? {}),
      },
    })) as JupyterApiResponse;
    const body = parseJson(await response.text());
    if (!response.ok) {
      const message =
        body !== null &&
        typeof body === 'object' &&
        !Array.isArray(body) &&
        typeof body['error'] === 'string'
          ? body['error']
          : `Spyderbyte request failed with status ${response.status}`;
      throw new Error(message);
    }
    return body;
  }
}

export function createJupyterLabPlugin(
  extension: SpyderbyteJupyterExtension,
): JupyterLabPluginLike {
  return {
    id: SPYDERBYTE_JUPYTER_PLUGIN_ID,
    autoStart: true,
    activate(app): void {
      app.commands.addCommand('spyderbyte:show-context', {
        label: 'Spyderbyte: Show runtime context',
        execute: () => extension.getContext(),
      });
      app.commands.addCommand('spyderbyte:launch-session', {
        label: 'Spyderbyte: Launch Jupyter session',
        execute: (args = {}) => extension.launchSession(args as JsonValue),
      });
      app.commands.addCommand('spyderbyte:reconnect-session', {
        label: 'Spyderbyte: Reconnect Jupyter session',
        execute: (args = {}) => extension.reconnectSession(String(args['sessionId'] ?? '')),
      });
      app.commands.addCommand('spyderbyte:load-runtime-profiles', {
        label: 'Spyderbyte: Load runtime profiles',
        execute: () => extension.listRuntimeProfiles(),
      });
      app.commands.addCommand('spyderbyte:run-cell', {
        label: 'Spyderbyte: Run cell',
        execute: (args = {}) =>
          extension.runCell({
            cellId: String(args['cellId'] ?? ''),
            type: (args['type'] ?? 'python') as JupyterCellExecutionInput['type'],
            source: String(args['source'] ?? ''),
            ...(args['outputType'] === undefined
              ? {}
              : {
                  outputType: String(args['outputType']) as Exclude<
                    JupyterCellExecutionInput['outputType'],
                    undefined
                  >,
                }),
          }),
      });
      app.commands.addCommand('spyderbyte:run-notebook', {
        label: 'Spyderbyte: Run notebook',
        execute: (args = {}) => extension.runNotebook(args as JsonValue),
      });
      app.commands.addCommand('spyderbyte:publish-artifact', {
        label: 'Spyderbyte: Publish artifact',
        execute: (args = {}) =>
          extension.publishArtifact(String(args['cellId'] ?? ''), String(args['artifactId'] ?? '')),
      });
      app.commands.addCommand('spyderbyte:browse-datasets', {
        label: 'Spyderbyte: Browse datasets',
        execute: () => extension.listDatasets(),
      });
      app.commands.addCommand('spyderbyte:browse-data-connections', {
        label: 'Spyderbyte: Browse data connections',
        execute: () => extension.listDataConnections(),
      });
      app.commands.addCommand('spyderbyte:browse-data-schema', {
        label: 'Spyderbyte: Browse data schema',
        execute: (args = {}) => extension.browseDataSchema(String(args['connectionId'] ?? '')),
      });
      app.commands.addCommand('spyderbyte:run-data-query', {
        label: 'Spyderbyte: Run bounded data query',
        execute: (args = {}) => extension.runDataQuery(args as JsonValue),
      });
      app.commands.addCommand('spyderbyte:profile-dataset', {
        label: 'Spyderbyte: Profile dataset version',
        execute: (args = {}) =>
          extension.profileDataset(
            String(args['datasetId'] ?? ''),
            args['version'] === undefined ? undefined : Number(args['version']),
          ),
      });
      app.commands.addCommand('spyderbyte:quality-dataset', {
        label: 'Spyderbyte: Check dataset quality',
        execute: (args = {}) =>
          extension.qualityDataset(String(args['datasetId'] ?? ''), args as JsonValue),
      });
      app.commands.addCommand('spyderbyte:handoff-data-query', {
        label: 'Spyderbyte: Handoff query to Jupyter',
        execute: (args = {}) => extension.handoffDataQuery(String(args['queryId'] ?? '')),
      });
      app.commands.addCommand('spyderbyte:browse-models', {
        label: 'Spyderbyte: Browse models',
        execute: () => extension.listModels(),
      });
      app.commands.addCommand('spyderbyte:list-approvals', {
        label: 'Spyderbyte: List approvals',
        execute: () => extension.listApprovals(),
      });
      app.commands.addCommand('spyderbyte:show-usage', {
        label: 'Spyderbyte: Show notebook usage and cost',
        execute: () => extension.getNotebookUsage(),
      });
      app.commands.addCommand('spyderbyte:associate-experiment', {
        label: 'Spyderbyte: Associate experiment',
        execute: (args = {}) => extension.associateExperiment(String(args['experimentId'] ?? '')),
      });
      app.commands.addCommand('spyderbyte:list-experiment-runs', {
        label: 'Spyderbyte: List experiment runs',
        execute: (args = {}) =>
          extension.listExperimentRuns(
            args['experimentId'] === undefined ? undefined : String(args['experimentId']),
          ),
      });
      app.commands.addCommand('spyderbyte:compare-experiments', {
        label: 'Spyderbyte: Compare experiment runs',
        execute: (args = {}) => {
          const runIds = args['runIds'];
          return extension.compareExperiments(
            Array.isArray(runIds) ? runIds.map((runId) => String(runId)) : [],
          );
        },
      });
      app.commands.addCommand('spyderbyte:list-deployments', {
        label: 'Spyderbyte: List deployments',
        execute: () => extension.listDeployments(),
      });
      app.commands.addCommand('spyderbyte:inspect-deployment', {
        label: 'Spyderbyte: Inspect deployment',
        execute: (args = {}) => extension.inspectDeployment(String(args['deploymentId'] ?? '')),
      });
      app.commands.addCommand('spyderbyte:invoke-deployment', {
        label: 'Spyderbyte: Invoke deployment',
        execute: (args = {}) =>
          extension.invokeDeployment(
            String(args['deploymentId'] ?? ''),
            args['payload'] as JsonValue,
          ),
      });
      app.commands.addCommand('spyderbyte:smoke-test-deployment', {
        label: 'Spyderbyte: Smoke test deployment',
        execute: (args = {}) => extension.smokeTestDeployment(String(args['deploymentId'] ?? '')),
      });
      app.commands.addCommand('spyderbyte:deployment-metrics', {
        label: 'Spyderbyte: Deployment metrics',
        execute: (args = {}) => extension.deploymentMetrics(String(args['deploymentId'] ?? '')),
      });
      app.commands.addCommand('spyderbyte:deployment-revisions', {
        label: 'Spyderbyte: Deployment revisions',
        execute: (args = {}) => extension.deploymentRevisions(String(args['deploymentId'] ?? '')),
      });
    },
  };
}
