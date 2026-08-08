import {
  PAGE_LABELS,
  PLATFORM_NAV_GROUPS,
  type Page,
  type PlatformNavGroup,
  type ProfileId,
} from './profiles';

export type LayoutDensity = 'comfortable' | 'compact';
export type WidgetSize = 'compact' | 'expanded';
export type HomeWidgetId =
  | 'welcome'
  | 'quick-actions'
  | 'recent-work'
  | 'activity'
  | 'compute'
  | 'safety'
  | 'deployments'
  | 'license';

export interface LayoutPreferences {
  schemaVersion: 1;
  visiblePages: Page[];
  navigationGroups: PlatformNavGroup[];
  pinnedPages: Page[];
  defaultLandingPage: Page;
  sidebarCollapsed: boolean;
  homeWidgets: HomeWidgetId[];
  widgetSizes: Partial<Record<HomeWidgetId, WidgetSize>>;
  density: LayoutDensity;
  showStatusText: boolean;
}

export const ALL_LAYOUT_PAGES: Page[] = [
  ...new Set(PLATFORM_NAV_GROUPS.flatMap((group) => group.pages)),
];

export const ORGANIZATION_ONLY_PAGES: Page[] = ['approvals', 'governance', 'usage'];

export const DEFAULT_HOME_WIDGETS: HomeWidgetId[] = [
  'welcome',
  'quick-actions',
  'recent-work',
  'activity',
  'compute',
  'safety',
  'deployments',
  'license',
];

function cloneGroups(groups: PlatformNavGroup[]): PlatformNavGroup[] {
  return groups.map((group) => ({ label: group.label, pages: [...group.pages] }));
}

function groupForPages(pages: Page[]): PlatformNavGroup[] {
  const allowed = new Set(pages);
  return cloneGroups(PLATFORM_NAV_GROUPS)
    .map((group) => ({ ...group, pages: group.pages.filter((page) => allowed.has(page)) }))
    .filter((group) => group.pages.length > 0);
}

export function layoutForPages(
  pages: Page[],
  base: Partial<LayoutPreferences> = {},
): LayoutPreferences {
  const visiblePages = [...new Set(pages)].filter((page) => ALL_LAYOUT_PAGES.includes(page));
  const navigationGroups = base.navigationGroups
    ? cloneGroups(base.navigationGroups).map((group) => ({
        ...group,
        pages: group.pages.filter((page) => visiblePages.includes(page)),
      }))
    : groupForPages(visiblePages);
  const groupsWithUnplaced = [...visiblePages].filter(
    (page) => !navigationGroups.some((group) => group.pages.includes(page)),
  );
  if (groupsWithUnplaced.length > 0) {
    navigationGroups.push({ label: 'More', pages: groupsWithUnplaced });
  }
  return {
    schemaVersion: 1,
    visiblePages,
    navigationGroups: navigationGroups.filter((group) => group.pages.length > 0),
    pinnedPages: (base.pinnedPages ?? []).filter((page) => visiblePages.includes(page)),
    defaultLandingPage:
      base.defaultLandingPage !== undefined && visiblePages.includes(base.defaultLandingPage)
        ? base.defaultLandingPage
        : 'home',
    sidebarCollapsed: base.sidebarCollapsed ?? false,
    homeWidgets: base.homeWidgets ?? [...DEFAULT_HOME_WIDGETS],
    widgetSizes: base.widgetSizes ?? {},
    density: base.density ?? 'comfortable',
    showStatusText: base.showStatusText ?? true,
  };
}

export const DEFAULT_LAYOUT: LayoutPreferences = layoutForPages(
  ALL_LAYOUT_PAGES.filter((page) => !ORGANIZATION_ONLY_PAGES.includes(page)),
);

export const STARTER_LAYOUTS: Record<
  'focus' | 'explore' | 'build' | 'monitor',
  { label: string; description: string; layout: LayoutPreferences }
> = {
  focus: {
    label: 'Focus',
    description: 'Projects, runs, data, and a calm Home workspace.',
    layout: layoutForPages([
      'home',
      'projects',
      'runs',
      'data',
      'visualizations',
      'connections',
      'machine',
      'settings',
    ]),
  },
  explore: {
    label: 'Explore',
    description: 'Data, SQL, notebooks, visualizations, and recent work.',
    layout: layoutForPages([
      'home',
      'projects',
      'data',
      'catalog',
      'sql',
      'notebooks',
      'visualizations',
      'assets',
      'runs',
      'connections',
      'settings',
    ]),
  },
  build: {
    label: 'Build',
    description: 'Repositories, code, models, experiments, and environments.',
    layout: layoutForPages([
      'home',
      'projects',
      'data',
      'repositories',
      'code',
      'worktrees',
      'models',
      'experiments',
      'runs',
      'pipelines',
      'connections',
      'environments',
      'machine',
      'settings',
    ]),
  },
  monitor: {
    label: 'Monitor',
    description: 'Runs, automations, deployments, incidents, and operations.',
    layout: layoutForPages([
      'home',
      'projects',
      'runs',
      'automations',
      'deployments',
      'environments',
      'resources',
      'incidents',
      'audit',
      'connections',
      'machine',
      'settings',
    ]),
  },
};

function starterForLegacyProfile(profile: ProfileId): LayoutPreferences {
  const mapping: Record<ProfileId, keyof typeof STARTER_LAYOUTS> = {
    guided: 'focus',
    explorer: 'explore',
    builder: 'build',
    operator: 'monitor',
  };
  return structuredClone(STARTER_LAYOUTS[mapping[profile]].layout);
}

function isPage(value: unknown): value is Page {
  return typeof value === 'string' && ALL_LAYOUT_PAGES.includes(value as Page);
}

function isWidget(value: unknown): value is HomeWidgetId {
  return (
    value === 'welcome' ||
    value === 'quick-actions' ||
    value === 'recent-work' ||
    value === 'activity' ||
    value === 'compute' ||
    value === 'safety' ||
    value === 'deployments' ||
    value === 'license'
  );
}

export function parseLayoutPreferences(value: unknown): LayoutPreferences | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const visiblePages = Array.isArray(record['visiblePages'])
    ? record['visiblePages'].filter(isPage)
    : [];
  if (visiblePages.length === 0) return undefined;
  const groups = Array.isArray(record['navigationGroups'])
    ? record['navigationGroups']
        .filter(
          (group): group is { label: string; pages: unknown[] } =>
            group !== null &&
            typeof group === 'object' &&
            typeof (group as Record<string, unknown>)['label'] === 'string' &&
            Array.isArray((group as Record<string, unknown>)['pages']),
        )
        .map((group) => ({
          label: group.label.trim() || 'More',
          pages: group.pages.filter(isPage),
        }))
    : undefined;
  const widgets = Array.isArray(record['homeWidgets'])
    ? record['homeWidgets'].filter(isWidget)
    : DEFAULT_HOME_WIDGETS;
  return layoutForPages(visiblePages, {
    ...(groups === undefined ? {} : { navigationGroups: groups }),
    pinnedPages: Array.isArray(record['pinnedPages']) ? record['pinnedPages'].filter(isPage) : [],
    defaultLandingPage: isPage(record['defaultLandingPage'])
      ? record['defaultLandingPage']
      : 'home',
    sidebarCollapsed: record['sidebarCollapsed'] === true,
    homeWidgets: widgets.length > 0 ? widgets : [...DEFAULT_HOME_WIDGETS],
    density: record['density'] === 'compact' ? 'compact' : 'comfortable',
    showStatusText: record['showStatusText'] !== false,
    widgetSizes:
      record['widgetSizes'] !== null &&
      typeof record['widgetSizes'] === 'object' &&
      !Array.isArray(record['widgetSizes'])
        ? (record['widgetSizes'] as Partial<Record<HomeWidgetId, WidgetSize>>)
        : {},
  });
}

const LAYOUT_STORAGE_KEY = 'spyderbyte.layout.v1';

export function loadLayoutPreferences(): LayoutPreferences {
  if (typeof window === 'undefined') return structuredClone(DEFAULT_LAYOUT);
  try {
    const saved = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    const parsed =
      saved === null ? undefined : parseLayoutPreferences(JSON.parse(saved) as unknown);
    if (parsed !== undefined) return parsed;
    const legacy = window.localStorage.getItem('agentic.profile');
    if (
      legacy === 'guided' ||
      legacy === 'explorer' ||
      legacy === 'builder' ||
      legacy === 'operator'
    ) {
      return starterForLegacyProfile(legacy);
    }
  } catch {
    // Fall through to a clean personal layout when local storage is unavailable or corrupt.
  }
  return structuredClone(DEFAULT_LAYOUT);
}

export function saveLayoutPreferences(layout: LayoutPreferences): void {
  try {
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // The durable API remains authoritative when local storage is unavailable.
  }
}

export function pageLabel(page: Page): string {
  return PAGE_LABELS[page] ?? page.replace(/-/g, ' ');
}
