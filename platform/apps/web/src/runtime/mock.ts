import type {
  CapabilitiesProjection,
  CommandAcknowledgement,
  FrontendCommand,
  LicenseProjection,
  ProjectionEnvelope,
  RuntimeClient,
  SessionProjection,
  TenantRef,
  WorkspaceContext,
} from './contracts';

function mockId(value: string): TenantRef['tenantId'] {
  return value as TenantRef['tenantId'];
}

const MOCK_TENANT: TenantRef = {
  tenantId: mockId('019b4d00-0000-7000-8000-000000000101'),
  workspaceId: mockId('019b4d00-0000-7000-8000-000000000102'),
};
const MOCK_WORKSPACE_CONTEXT: WorkspaceContext = {
  ...MOCK_TENANT,
  mode: 'personal_local',
};
const MOCK_NOW = '2026-01-01T00:00:00.000Z';

function envelope<T>(projectionName: string, state: T): ProjectionEnvelope<T> {
  return {
    projectionName,
    projectionVersion: 1,
    tenant: MOCK_TENANT,
    state,
    data: state,
    cursor: 0,
    streamHead: 0,
    lag: 0,
    stale: false,
    freshness: 'fresh',
    generatedAt: MOCK_NOW,
    permissions: ['read'],
  };
}

function capabilities(): CapabilitiesProjection {
  const enabled = [
    'projects',
    'runs',
    'run-timeline',
    'run-metrics',
    'run-logs',
    'machine-state',
    'deployment-traffic',
    'deployments.serve',
    'deployments.observe',
    'deployments.approval',
  ];
  return {
    schemaVersion: 1,
    runtimeMode: 'mock',
    workspaceMode: 'personal_local',
    policyEnforcement: 'local',
    projectionVersion: 1,
    generatedAt: MOCK_NOW,
    projections: enabled,
    commands: ['CreateProject', 'CancelRun'],
    capabilities: Object.fromEntries(
      enabled.map((name) => [name, { enabled: true, projections: [name] }]),
    ),
  };
}

export class DeterministicMockRuntimeClient implements RuntimeClient {
  private readonly projects: Record<string, Record<string, unknown>> = {};
  private sequence = 1;

  async query<T>(projection: string): Promise<ProjectionEnvelope<T>> {
    const state = this.stateFor(projection);
    return envelope(projection, state as T);
  }

  async get<T>(path: string, options: { signal?: AbortSignal } = {}): Promise<T> {
    void options;
    if (path === '/v1/health') {
      return {
        status: 'ok',
        service: 'deterministic-mock-runtime',
        tenant: MOCK_TENANT,
      } as T;
    }
    if (path === '/v1/session') {
      return {
        schemaVersion: 1,
        sessionId: '019b4d00-0000-7000-8000-000000000103',
        actor: {
          actorId: mockId('019b4d00-0000-7000-8000-000000000104'),
          type: 'human',
          displayName: 'Design review user',
        },
        tenant: MOCK_TENANT,
        workspaces: [MOCK_TENANT],
        workspaceContext: MOCK_WORKSPACE_CONTEXT,
        workspaceContexts: [MOCK_WORKSPACE_CONTEXT],
        scopes: ['mock'],
        issuedAt: MOCK_NOW,
      } satisfies SessionProjection as T;
    }
    if (path === '/v1/license/status') {
      return {
        status: 'valid',
        reason: 'explicit_mock_mode',
        licenseId: 'mock-license',
      } satisfies LicenseProjection as T;
    }
    if (path === '/v1/capabilities') return capabilities() as T;
    throw new Error(`Deterministic mock runtime has no resource for ${path}`);
  }

  async command(command: FrontendCommand): Promise<CommandAcknowledgement> {
    if (command.commandType === 'CreateProject') {
      const payload =
        command.payload !== null &&
        typeof command.payload === 'object' &&
        !Array.isArray(command.payload)
          ? command.payload
          : {};
      const projectId = `019b4d00-0000-7000-8000-${String(this.sequence++).padStart(12, '0')}`;
      const name = typeof payload.name === 'string' ? payload.name : 'Mock project';
      const objective = typeof payload.objective === 'string' ? payload.objective : undefined;
      this.projects[projectId] = {
        projectId,
        name,
        ...(objective === undefined ? {} : { objective }),
        status: 'active',
        createdAt: MOCK_NOW,
        updatedAt: MOCK_NOW,
      };
      return {
        accepted: true,
        commandId: command.commandId,
        correlationId: command.correlationId,
        result: { projectId, name, status: 'active' },
      };
    }
    return {
      accepted: true,
      commandId: command.commandId,
      correlationId: command.correlationId,
      result: {},
    };
  }

  async plan(command: FrontendCommand): Promise<CommandAcknowledgement> {
    return this.command(command);
  }

  subscribe(): () => void {
    return () => undefined;
  }

  async refresh(): Promise<void> {
    return Promise.resolve();
  }

  setSession(): void {
    return undefined;
  }

  private stateFor(projection: string): unknown {
    if (projection === 'projects') return { projects: this.projects };
    if (projection === 'runs') return { runs: {} };
    if (projection === 'run-timeline') return { events: {} };
    if (projection === 'run-metrics') return { observations: {} };
    if (projection === 'run-logs') return { lines: {} };
    if (projection === 'artifact-catalog-lineage') return { artifacts: {} };
    if (projection === 'machine-state')
      return {
        observations: {
          latest: {
            cpuPercent: 24,
            memoryPercent: 41,
            storagePercent: 62,
            gpuAvailable: null,
            gpuActive: null,
            platform: 'mock',
            observedAt: MOCK_NOW,
          },
        },
      };
    return {};
  }
}
