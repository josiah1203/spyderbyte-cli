import { PROFILES, type Page, type ProfileId } from '../data/profiles';
import type { CapabilitiesProjection, RuntimeConnectionState } from './contracts';

export type PageAvailability = 'loading' | 'ready' | 'locked' | 'unavailable';

export interface PageDefinition {
  readonly page: Page;
  readonly label: string;
  /** Kept only for contract compatibility; runtime visibility is user-owned layout state. */
  readonly profiles?: readonly ProfileId[];
  readonly organizationOnly?: boolean;
  readonly projections?: readonly string[];
  readonly commands?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly settingsPath?: string;
}

export interface PageAvailabilityResult {
  readonly state: PageAvailability;
  readonly missing: readonly string[];
  readonly reason?: string;
}

// Kept as compatibility metadata for extensions and older consumers. Runtime
// visibility is now controlled by persisted LayoutPreferences, not profiles.
const ALL_PROFILES = Object.values(PROFILES).map((profile) => profile.id);

function definition(
  page: Page,
  label: string,
  options: Omit<PageDefinition, 'page' | 'label' | 'profiles'> & {
    profiles?: readonly ProfileId[];
  } = {},
): PageDefinition {
  const { profiles, ...rest } = options;
  return {
    page,
    label,
    profiles: profiles ?? ALL_PROFILES,
    ...rest,
  };
}

export const PAGE_REGISTRY: Readonly<Record<Page, PageDefinition>> = {
  home: definition('home', 'Home'),
  projects: definition('projects', 'Projects', {
    projections: ['projects'],
    commands: ['CreateProject', 'UpdateProject', 'ArchiveProject', 'RestoreProject'],
  }),
  'project-detail': definition('project-detail', 'Project', {
    projections: ['projects', 'runs'],
    commands: ['UpdateProject', 'ArchiveProject', 'RestoreProject', 'CancelProject'],
  }),
  data: definition('data', 'Data', {
    projections: ['catalog-datasets'],
    commands: ['ValidateDataset', 'CreateDataset', 'UpdateDataset', 'ArchiveDataset'],
  }),
  catalog: definition('catalog', 'Catalog', {
    projections: ['catalog-datasets', 'artifact-catalog-lineage'],
    commands: ['ValidateDataset', 'CreateDataset', 'UpdateDataset'],
  }),
  sql: definition('sql', 'SQL', {
    capabilities: ['queries.execute'],
    projections: ['queries'],
    commands: ['CreateQuery', 'UpdateQuery', 'RunQuery', 'CancelQuery'],
  }),
  visualizations: definition('visualizations', 'Visualizations', {
    capabilities: ['visualizations.render'],
    projections: ['visualizations'],
    commands: ['CreateVisualization', 'UpdateVisualization', 'RefreshVisualization'],
  }),
  media: definition('media', 'Media', {
    capabilities: ['connectors.catalog', 'connectors.auth'],
    settingsPath: '/settings/workspace/connections',
  }),
  runs: definition('runs', 'Runs', {
    projections: ['runs', 'run-timeline'],
    commands: ['CreateRun', 'PlanRun', 'CancelRun'],
  }),
  'run-detail': definition('run-detail', 'Run', {
    projections: ['runs', 'run-timeline', 'run-metrics', 'run-logs'],
    commands: ['CancelRun'],
  }),
  automations: definition('automations', 'Automations', {
    capabilities: ['automations.schedule'],
    projections: ['automations'],
    commands: ['CreateAutomation', 'UpdateAutomation', 'PauseAutomation', 'ResumeAutomation'],
  }),
  connections: definition('connections', 'Connections', {
    capabilities: ['connectors.catalog', 'connectors.auth'],
    settingsPath: '/settings/workspace/connections',
  }),
  notebooks: definition('notebooks', 'Notebooks', {
    capabilities: ['notebooks.execute'],
    projections: ['notebooks'],
    commands: ['CreateNotebook', 'UpdateNotebook', 'RunNotebook'],
  }),
  code: definition('code', 'Code', {
    capabilities: ['repositories.sync'],
    projections: ['repositories', 'worktrees'],
    commands: ['CreateWorktree', 'UpdateWorktree', 'DeleteWorktree'],
  }),
  repositories: definition('repositories', 'Repositories', {
    capabilities: ['repositories.sync', 'repositories.files', 'repositories.execute'],
    projections: ['repositories'],
    commands: ['CreateRepository', 'UpdateRepository', 'SyncRepository'],
  }),
  models: definition('models', 'Models', {
    capabilities: ['model-runtime'],
    settingsPath: '/settings/workspace/models',
  }),
  experiments: definition('experiments', 'Experiments', {
    capabilities: ['experiments.lifecycle'],
    projections: ['experiments'],
    commands: ['CreateExperiment', 'UpdateExperiment', 'ArchiveExperiment'],
  }),
  deployments: definition('deployments', 'Deployments', {
    capabilities: ['deployments.serve', 'deployments.observe', 'deployments.approval'],
    projections: ['deployment-traffic'],
    commands: ['CreateDeployment', 'UpdateDeployment', 'PromoteDeployment', 'RollbackDeployment'],
  }),
  pipelines: definition('pipelines', 'Pipelines', {
    capabilities: ['pipelines.execute'],
    projections: ['pipelines'],
    commands: ['CreatePipeline', 'UpdatePipeline', 'RunPipeline', 'CancelPipeline'],
  }),
  environments: definition('environments', 'Environments', {
    projections: ['environments'],
    commands: ['CreateEnvironment', 'UpdateEnvironment', 'DeleteEnvironment'],
  }),
  resources: definition('resources', 'Resources', {
    projections: ['resources'],
    commands: ['CreateResource', 'UpdateResource', 'ReleaseResource'],
  }),
  approvals: definition('approvals', 'Approvals', {
    organizationOnly: true,
    projections: ['approval-queue'],
    commands: ['ApproveApproval', 'RejectApproval', 'RevokeApproval'],
  }),
  incidents: definition('incidents', 'Incidents', {
    projections: ['incidents'],
    commands: ['CreateIncident', 'UpdateIncident', 'AcknowledgeIncident', 'ResolveIncident'],
  }),
  governance: definition('governance', 'Governance', {
    organizationOnly: true,
    projections: ['governance'],
    commands: ['UpdateGovernancePolicy'],
  }),
  usage: definition('usage', 'Usage', {
    organizationOnly: true,
  }),
  audit: definition('audit', 'Audit', {
    projections: ['audit-timeline'],
  }),
  assets: definition('assets', 'Assets', {
    projections: ['artifact-catalog-lineage'],
    commands: ['PublishArtifact'],
  }),
  worktrees: definition('worktrees', 'Worktrees', {
    projections: ['worktrees'],
    commands: ['CreateWorktree', 'UpdateWorktree', 'DeleteWorktree'],
  }),
  machine: definition('machine', 'Compute', {
    projections: ['machine-state'],
  }),
  license: definition('license', 'License'),
  settings: definition('settings', 'Settings', {
    projections: ['settings'],
    settingsPath: '/settings/workspace/general',
  }),
};

export function pageDefinition(page: Page): PageDefinition {
  return PAGE_REGISTRY[page];
}

export function isPersonalLocalWorkspace(
  capabilities: CapabilitiesProjection | undefined,
): boolean {
  return (
    capabilities?.workspaceMode === 'personal_local' ||
    capabilities?.runtimeMode === 'managed-local-daemon'
  );
}

export function pageAvailability(
  page: Page,
  connection: RuntimeConnectionState,
  capabilities: CapabilitiesProjection | undefined,
): PageAvailabilityResult {
  if (connection === 'booting') return { state: 'loading', missing: [] };
  if (connection !== 'connected' && connection !== 'stale') {
    return { state: 'unavailable', missing: [], reason: 'The platform is not connected.' };
  }
  const pageInfo = pageDefinition(page);
  if (capabilities === undefined) return { state: 'loading', missing: [] };
  if (pageInfo.organizationOnly === true && isPersonalLocalWorkspace(capabilities)) {
    return {
      state: 'locked',
      missing: [],
      reason: 'This organization surface is available when an organization workspace is connected.',
    };
  }

  const missing = new Set<string>();
  const descriptors = capabilities.capabilities;
  for (const capability of pageInfo.capabilities ?? []) {
    if (descriptors[capability]?.enabled !== true) missing.add(capability);
  }
  for (const projection of pageInfo.projections ?? []) {
    const descriptor = descriptors[projection];
    if (
      descriptor?.enabled === false ||
      (descriptor === undefined &&
        capabilities.projections !== undefined &&
        !capabilities.projections.includes(projection))
    ) {
      missing.add(projection);
    }
  }
  for (const command of pageInfo.commands ?? []) {
    const descriptor = Object.values(descriptors).find((item) => item.commands?.includes(command));
    if (descriptor !== undefined && descriptor.enabled === false) missing.add(command);
  }

  if (missing.size > 0) {
    return {
      state: 'locked',
      missing: [...missing],
      reason: 'Platform setup is required before this workflow is available.',
    };
  }
  return { state: 'ready', missing: [] };
}
