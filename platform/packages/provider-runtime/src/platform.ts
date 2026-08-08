import { join } from 'node:path';
import { ModelRouter, type ModelDataClass } from '@agentic-platform/harness-core';
import type { TenantRef } from '@agentic-platform/runtime-contracts';
import {
  FileOAuthConnectionStore,
  ExecFileCliAuthRunner,
  MacOsKeychainVault,
  MemoryCredentialVault,
  OAuthService,
  type CredentialVault,
} from './oauth.js';
import { HuggingFaceHubClient, ModelDownloadManager } from './huggingface.js';
import { ConnectionCatalogService } from './connections.js';
import {
  createDefaultProviderCatalog,
  createGatewayTransport,
  createOpenAiCompatibleLocalTransport,
  LocalRuntimeRegistry,
  defaultProviderPriority,
  type DefaultProviderCatalogOptions,
  type GatewayModelFactory,
  type ProviderAdapterFactory,
  type ProviderCatalog,
  type ProviderTransport,
} from './providers.js';
import {
  FileProviderConfigurationStore,
  ProviderConfigurationService,
  type ProviderConfigurationStore,
} from './provider-configurations.js';
import {
  CommandWhisperBackend,
  SpeechTranscriptionService,
  type WhisperBackend,
} from './speech.js';
import { LocalQueryRuntime } from './query.js';
import { LocalNotebookRuntime } from './notebook.js';
import { MeltanoConnectorRuntime } from './meltano.js';
import { LocalVisualizationRuntime } from './visualizations.js';
import { SpyderbyteUpdateService, type UpdateChannel } from './updates.js';
import { LocalRepositoryRuntime } from './repositories.js';
import { LocalRuntimeProfileRuntime } from './runtime-profiles.js';
import { LocalJupyterSessionRuntime, type ManagedJupyterServerAdapter } from './jupyter.js';
import { LocalPipelineRuntime } from './pipelines.js';
import { LocalAutomationRuntime } from './automations.js';
import { LocalTrainingRuntime } from './training.js';
import { FileExperimentRuntime } from './experiments.js';
import { LocalDataCatalogRuntime, type LocalDataCatalogRuntimeImpl } from './datasets.js';
import { LocalServingRuntime } from './serving.js';
import { LocalWorkspaceIntakeRuntime } from './workspace-intake.js';
import {
  CloudProviderActionRuntime,
  SignedLocalBridgeRuntime,
  type ProviderActionRuntime,
  type LocalBridgeRuntime,
} from './provider-actions.js';
import {
  FileComputeProfileRegistry,
  type ComputeProfileRegistry,
  type ComputeProfileSelection,
  type ComputeProfileSelectionRequest,
} from './compute-profiles.js';

export interface ProviderRuntimeServices {
  readonly catalog: ProviderCatalog;
  readonly providers: ProviderConfigurationService;
  readonly router: ModelRouter;
  readonly oauth: OAuthService;
  readonly connections: ConnectionCatalogService;
  readonly hub: HuggingFaceHubClient;
  readonly downloads: ModelDownloadManager;
  readonly runtimes: LocalRuntimeRegistry;
  readonly speech: SpeechTranscriptionService;
  readonly queries: LocalQueryRuntime;
  readonly data: LocalDataCatalogRuntimeImpl;
  readonly notebooks: LocalNotebookRuntime;
  readonly connectors: MeltanoConnectorRuntime;
  readonly visualizations: LocalVisualizationRuntime;
  readonly updates: SpyderbyteUpdateService;
  readonly repositories: LocalRepositoryRuntime;
  readonly runtimeProfiles: LocalRuntimeProfileRuntime;
  readonly computeProfiles: ComputeProfileRegistry;
  readonly jupyter: LocalJupyterSessionRuntime;
  readonly pipelines: LocalPipelineRuntime;
  readonly automations: LocalAutomationRuntime;
  readonly training: LocalTrainingRuntime;
  readonly experiments: FileExperimentRuntime;
  readonly providerActions: ProviderActionRuntime;
  readonly bridges: LocalBridgeRuntime;
  readonly serving: LocalServingRuntime;
  readonly workspaceIntake: LocalWorkspaceIntakeRuntime;
  readonly providerPriority: string[];
  readonly routingPolicy: ModelRoutingPolicy;
  readonly refreshLocalModels: () => Promise<void>;
  readonly selectComputeProfile: (
    request: ComputeProfileSelectionRequest,
  ) => ComputeProfileSelection;
  readonly setHuggingFaceToken: (token: string) => Promise<void>;
  setProviderPriority(priority: readonly string[]): void;
  setRoutingPolicy(policy: ModelRoutingPolicy): void;
}

export interface HarnessModelPolicy {
  readonly allowedProviders?: readonly string[];
  readonly requiredCapabilities?: readonly string[];
  readonly dataClass?: ModelDataClass;
  readonly allowExternalModels: boolean;
  readonly allowProviderFallback: boolean;
}

export interface ModelRoutingPolicy {
  readonly allowExternalModels: boolean;
  readonly allowProviderFallback: boolean;
  readonly allowedDataClasses: readonly ModelDataClass[];
  readonly harnessPolicies: Readonly<Record<string, HarnessModelPolicy>>;
}

export interface ProviderRuntimeOptions {
  readonly rootPath: string;
  readonly tenant?: TenantRef;
  readonly providerConfigurationStore?: ProviderConfigurationStore;
  readonly adapterFactory?: ProviderAdapterFactory;
  readonly codexTransport?: ProviderTransport;
  readonly claudeTransport?: ProviderTransport;
  readonly deterministicTransport?: ProviderTransport;
  /** Cline's documented gateway can be injected by desktop/hosted composition. */
  readonly clineGateway?: GatewayModelFactory;
  readonly whisperBackend?: WhisperBackend;
  readonly whisperCommand?: string;
  readonly whisperArgs?: readonly string[];
  readonly meltanoCommand?: string;
  readonly clock?: () => string;
  readonly fetcher?: typeof fetch;
  readonly huggingFaceToken?: string;
  readonly useKeychain?: boolean;
  /** Hosted composition may inject an encrypted secret manager adapter. */
  readonly credentialVault?: CredentialVault;
  readonly clineCliPath?: string;
  readonly runtimeOptions?: ConstructorParameters<typeof LocalRuntimeRegistry>[0];
  /** Hosted composition may inject a managed Jupyter provisioner; local mode remains loopback. */
  readonly managedJupyterServer?: ManagedJupyterServerAdapter;
}

export function createProviderRuntime(options: ProviderRuntimeOptions): ProviderRuntimeServices {
  const configuredUpdateChannel = process.env['SPYDERBYTE_UPDATE_CHANNEL'];
  const updateChannel =
    configuredUpdateChannel === 'stable' ||
    configuredUpdateChannel === 'beta' ||
    configuredUpdateChannel === 'nightly' ||
    configuredUpdateChannel === 'developer'
      ? (configuredUpdateChannel as UpdateChannel)
      : undefined;
  const vault =
    options.credentialVault ??
    (options.useKeychain === false || process.platform !== 'darwin'
      ? new MemoryCredentialVault()
      : new MacOsKeychainVault());
  const oauth = new OAuthService({
    vault,
    metadataStore: new FileOAuthConnectionStore(
      join(options.rootPath, '.agentic', 'connections.json'),
    ),
    ...((options.clineCliPath ?? process.env['AGENTIC_CLINE_CLI_PATH']) === undefined
      ? {}
      : {
          cliAuthRunner: new ExecFileCliAuthRunner(
            10 * 60 * 1000,
            options.clineCliPath ?? process.env['AGENTIC_CLINE_CLI_PATH'],
          ),
        }),
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const hub = new HuggingFaceHubClient({
    ...(options.huggingFaceToken === undefined ? {} : { token: options.huggingFaceToken }),
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
  });
  void oauth.secret('huggingface-token').then((token) => {
    if (token !== undefined) hub.setToken(token);
  });
  const downloads = new ModelDownloadManager({
    rootPath: join(options.rootPath, '.agentic', 'models'),
    hub,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const gatewayTransport =
    options.clineGateway === undefined ? undefined : createGatewayTransport(options.clineGateway);
  const codexTransport = options.codexTransport ?? gatewayTransport;
  const claudeTransport = options.claudeTransport ?? gatewayTransport;
  const catalogOptions: DefaultProviderCatalogOptions = {
    ...(codexTransport === undefined ? {} : { codexTransport }),
    ...(claudeTransport === undefined ? {} : { claudeTransport }),
    ...(options.deterministicTransport === undefined
      ? {}
      : { deterministicTransport: options.deterministicTransport }),
  };
  const catalog = createDefaultProviderCatalog(catalogOptions);
  for (const connection of oauth.listConnections().filter((item) => item.status === 'connected')) {
    catalog.connect(connection.connectorId, connection.connectionId);
  }
  const router = new ModelRouter();
  catalog.registerWith(router);
  const runtimes = new LocalRuntimeRegistry(options.runtimeOptions);
  const providerKeys = catalog.list().map((model) => model.providerKey);
  for (const taskShape of ['default', 'governance', 'worker', 'coding', 'data']) {
    for (const tier of [0, 1, 2] as const) {
      router.registerRoute({ taskShape, tier, providers: providerKeys, maxTokens: 4096 });
    }
  }
  const providerTenant =
    options.tenant ??
    ({
      tenantId: '00000000-0000-7000-8000-000000000000' as never,
      workspaceId: '00000000-0000-7000-8000-000000000001' as never,
    } satisfies TenantRef);
  const computeProfiles = new FileComputeProfileRegistry(
    options.rootPath,
    providerTenant,
    options.clock,
  );
  const providers = new ProviderConfigurationService({
    tenant: providerTenant,
    store:
      options.providerConfigurationStore ??
      new FileProviderConfigurationStore(join(options.rootPath, '.agentic', 'providers.json')),
    vault,
    catalog,
    router,
    ...(options.deterministicTransport === undefined
      ? {}
      : { deterministicTransport: options.deterministicTransport }),
    seedDeterministicProvider: true,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    ...(options.adapterFactory === undefined ? {} : { adapterFactory: options.adapterFactory }),
  });
  const refreshLocalModels = async (): Promise<void> => {
    const installed = await downloads.listInstalled();
    const installedIds = new Set(installed.map((model) => model.modelId));
    for (const catalogEntry of catalog
      .list()
      .filter((entry) => entry.source === 'huggingface-local')) {
      if (
        !installedIds.has(catalogEntry.modelId) &&
        catalog.removeLocalModel(catalogEntry.modelId)
      ) {
        router.removeProvider(catalogEntry.providerKey);
      }
    }
    for (const model of installed) {
      const runtime = model.format === 'unknown' ? undefined : runtimes.get(model.format);
      const transport =
        runtime?.endpoint === undefined
          ? undefined
          : createOpenAiCompatibleLocalTransport(runtime.endpoint, options.fetcher ?? fetch);
      const localModel = {
        modelId: model.modelId,
        displayName: model.repoId,
        format: model.format,
        ready: runtime?.state === 'ready',
        ...(runtime?.runtimeId === undefined ? {} : { runtimeId: runtime.runtimeId }),
        ...(transport === undefined ? {} : { transport }),
      };
      const provider = catalog.registerLocalModel(localModel);
      const providerKey = `${provider.providerId}:${provider.model}`;
      try {
        router.registerProvider(provider);
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? String(error.code) : undefined;
        if (code !== 'VALIDATION_INVALID_INPUT') throw error;
      }
      router.addProviderToRoutes(providerKey);
    }
  };
  let providerPriority = defaultProviderPriority();
  let providerPriorityCustomized = false;
  const effectiveProviderPriority = (): string[] => {
    if (providerPriorityCustomized) return [...providerPriority];
    const configured = providers.list().map((configuration) => configuration.providerId);
    const defaultWithoutFixture = providerPriority.filter(
      (providerId) => providerId !== 'deterministic',
    );
    return [
      ...new Set([
        ...configured.filter((providerId) => providerId !== 'deterministic'),
        ...defaultWithoutFixture,
        'deterministic',
      ]),
    ];
  };
  let routingPolicy: ModelRoutingPolicy = {
    allowExternalModels: true,
    allowProviderFallback: true,
    allowedDataClasses: ['public', 'internal', 'confidential', 'restricted'],
    harnessPolicies: {},
  };
  const whisperBackend =
    options.whisperBackend ??
    ((options.whisperCommand ?? process.env['AGENTIC_WHISPER_COMMAND']) === undefined
      ? undefined
      : new CommandWhisperBackend({
          command: options.whisperCommand ?? process.env['AGENTIC_WHISPER_COMMAND'] ?? 'whisper',
          ...(options.whisperArgs === undefined ? {} : { args: options.whisperArgs }),
        }));
  const queries = new LocalQueryRuntime();
  const data = new LocalDataCatalogRuntime({
    rootPath: options.rootPath,
    query: queries,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const notebooks = new LocalNotebookRuntime(
    queries,
    options.clock ?? (() => new Date().toISOString()),
    join(options.rootPath, '.agentic', 'notebooks.json'),
  );
  const connectors = new MeltanoConnectorRuntime({
    rootPath: options.rootPath,
    ...(options.meltanoCommand === undefined ? {} : { executable: options.meltanoCommand }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    credentialResolver: (connectionId) => oauth.credential(connectionId),
  });
  const providerActions = new CloudProviderActionRuntime({
    oauth,
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const visualizations = new LocalVisualizationRuntime();
  const runtimeProfiles = new LocalRuntimeProfileRuntime(
    options.rootPath,
    options.clock ?? (() => new Date().toISOString()),
  );
  const repositories = new LocalRepositoryRuntime({
    rootPath: options.rootPath,
    providerActions,
    runtimeProfiles,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const jupyter = new LocalJupyterSessionRuntime({
    rootPath: options.rootPath,
    profiles: runtimeProfiles,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.managedJupyterServer === undefined
      ? {}
      : { managedServer: options.managedJupyterServer }),
  });
  const pipelines = new LocalPipelineRuntime({
    rootPath: options.rootPath,
    query: queries,
    notebooks,
    connectors,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const automations = new LocalAutomationRuntime({
    rootPath: options.rootPath,
    pipelines,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  automations.start();
  const training = new LocalTrainingRuntime({
    rootPath: options.rootPath,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const experiments = new FileExperimentRuntime({
    rootPath: options.rootPath,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const bridges = new SignedLocalBridgeRuntime({ rootPath: options.rootPath });
  const serving = new LocalServingRuntime({
    rootPath: options.rootPath,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
  });
  const workspaceIntake = new LocalWorkspaceIntakeRuntime({
    rootPath: options.rootPath,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  return {
    catalog,
    providers,
    router,
    oauth,
    connections: new ConnectionCatalogService(
      oauth,
      options.clock ?? (() => new Date().toISOString()),
    ),
    hub,
    downloads,
    runtimes,
    speech: new SpeechTranscriptionService(whisperBackend),
    queries,
    data,
    notebooks,
    connectors,
    visualizations,
    repositories,
    runtimeProfiles,
    computeProfiles,
    jupyter,
    pipelines,
    automations,
    training,
    experiments,
    providerActions,
    bridges,
    serving,
    workspaceIntake,
    updates: new SpyderbyteUpdateService({
      rootPath: options.rootPath,
      currentVersion: process.env['SPYDERBYTE_VERSION'] ?? '0.0.1',
      ...(updateChannel === undefined ? {} : { channel: updateChannel }),
      ...(process.env['SPYDERBYTE_UPDATE_ENDPOINT'] === undefined
        ? {}
        : { endpoint: process.env['SPYDERBYTE_UPDATE_ENDPOINT'] }),
      ...(process.env['SPYDERBYTE_UPDATE_TARGET'] === undefined
        ? {}
        : { target: process.env['SPYDERBYTE_UPDATE_TARGET'] }),
      ...(process.env['SPYDERBYTE_UPDATE_PUBLIC_KEY'] === undefined
        ? {}
        : { publicKey: process.env['SPYDERBYTE_UPDATE_PUBLIC_KEY'] }),
      ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    }),
    refreshLocalModels,
    selectComputeProfile(request: ComputeProfileSelectionRequest): ComputeProfileSelection {
      return computeProfiles.select(request);
    },
    async setHuggingFaceToken(token: string): Promise<void> {
      await oauth.storeSecret('huggingface-token', token);
      hub.setToken(token);
    },
    get providerPriority(): string[] {
      return effectiveProviderPriority();
    },
    setProviderPriority(priority: readonly string[]): void {
      const available = new Set([
        ...catalog.list().map((model) => model.providerId),
        ...defaultProviderPriority(),
      ]);
      const unique = [...new Set(priority)];
      if (unique.some((providerId) => !available.has(providerId))) {
        throw new Error('Provider priority contains an unknown provider');
      }
      providerPriority = unique;
      providerPriorityCustomized = true;
    },
    get routingPolicy(): ModelRoutingPolicy {
      return structuredClone(routingPolicy);
    },
    setRoutingPolicy(policy: ModelRoutingPolicy): void {
      routingPolicy = structuredClone(policy);
    },
  };
}
