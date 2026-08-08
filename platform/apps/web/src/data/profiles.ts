export type ProfileId = 'guided' | 'explorer' | 'builder' | 'operator';

export interface Profile {
  id: ProfileId;
  label: string;
  tagline: string;
  nav: Page[];
  secondaryNav: Page[];
  adminNav?: Page[];
}

export interface PlatformNavGroup {
  label: string;
  pages: Page[];
}

export type Page =
  | 'home'
  | 'projects'
  | 'project-detail'
  | 'data'
  | 'catalog'
  | 'sql'
  | 'visualizations'
  | 'media'
  | 'runs'
  | 'run-detail'
  | 'automations'
  | 'connections'
  | 'notebooks'
  | 'code'
  | 'repositories'
  | 'models'
  | 'experiments'
  | 'deployments'
  | 'pipelines'
  | 'environments'
  | 'resources'
  | 'approvals'
  | 'incidents'
  | 'governance'
  | 'usage'
  | 'audit'
  | 'assets'
  | 'worktrees'
  | 'machine'
  | 'license'
  | 'settings';

export const PROFILES: Record<ProfileId, Profile> = {
  guided: {
    id: 'guided',
    label: 'Guided',
    tagline: 'For individuals and creators',
    nav: ['home', 'projects', 'runs', 'visualizations', 'media', 'automations', 'connections'],
    secondaryNav: ['machine', 'license', 'settings'],
  },
  explorer: {
    id: 'explorer',
    label: 'Explorer',
    tagline: 'For analysts and researchers',
    nav: [
      'home',
      'projects',
      'data',
      'sql',
      'visualizations',
      'media',
      'runs',
      'automations',
      'connections',
    ],
    secondaryNav: ['notebooks', 'machine', 'license', 'settings'],
  },
  builder: {
    id: 'builder',
    label: 'Builder',
    tagline: 'For developers and ML practitioners',
    nav: [
      'home',
      'projects',
      'data',
      'repositories',
      'code',
      'models',
      'experiments',
      'runs',
      'automations',
      'deployments',
      'connections',
    ],
    secondaryNav: ['notebooks', 'worktrees', 'machine', 'environments', 'license', 'settings'],
  },
  operator: {
    id: 'operator',
    label: 'Operator',
    tagline: 'For teams and production systems',
    nav: [
      'home',
      'projects',
      'data',
      'catalog',
      'models',
      'experiments',
      'runs',
      'pipelines',
      'automations',
      'deployments',
      'environments',
      'resources',
      'approvals',
      'incidents',
      'connections',
    ],
    secondaryNav: ['machine', 'license', 'settings'],
    adminNav: ['governance', 'usage', 'audit'],
  },
};

/** Profiles personalize the dashboard; the platform remains fully discoverable. */
export const PLATFORM_NAV_GROUPS: PlatformNavGroup[] = [
  { label: 'Work', pages: ['home', 'projects', 'runs', 'approvals'] },
  {
    label: 'Data',
    pages: ['data', 'catalog', 'sql', 'notebooks', 'visualizations', 'assets'],
  },
  { label: 'Creator', pages: ['media'] },
  { label: 'ML', pages: ['models', 'experiments', 'pipelines'] },
  { label: 'Operations', pages: ['automations', 'deployments', 'environments', 'resources'] },
  { label: 'Connections', pages: ['connections', 'repositories', 'code', 'worktrees'] },
  { label: 'Observability', pages: ['incidents', 'governance', 'usage', 'audit'] },
  { label: 'Workspace', pages: ['machine', 'license', 'settings'] },
];

export const PAGE_LABELS: Partial<Record<Page, string>> = {
  home: 'Home',
  projects: 'Projects',
  'project-detail': 'Project',
  data: 'Data',
  catalog: 'Catalog',
  sql: 'SQL',
  visualizations: 'Visualizations',
  media: 'Media',
  runs: 'Runs',
  'run-detail': 'Run',
  automations: 'Automations',
  connections: 'Connections',
  notebooks: 'Notebooks',
  code: 'Code',
  repositories: 'Repositories',
  models: 'Models',
  experiments: 'Experiments',
  deployments: 'Deployments',
  pipelines: 'Pipelines',
  environments: 'Environments',
  resources: 'Resources',
  approvals: 'Approvals',
  incidents: 'Incidents',
  governance: 'Governance',
  usage: 'Usage',
  audit: 'Audit',
  assets: 'Assets',
  worktrees: 'Worktrees',
  machine: 'Compute',
  license: 'License',
  settings: 'Settings',
};

export const PAGE_CTA: Partial<Record<Page, string>> = {
  home: 'New Project',
  projects: 'New Project',
  runs: 'New Run',
  data: 'Import Dataset',
  catalog: 'Register Asset',
  sql: 'New Query',
  visualizations: 'New Chart',
  media: 'Transcribe audio',
  automations: 'New Automation',
  notebooks: 'New Notebook',
  code: 'New File',
  repositories: 'Add Repository',
  models: 'Register Model',
  experiments: 'New Experiment',
  deployments: 'New Deployment',
  pipelines: 'New Pipeline',
  environments: 'New Environment',
  incidents: 'Open Incident',
  connections: 'Add Connection',
};
