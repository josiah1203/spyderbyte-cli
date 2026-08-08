import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { invoke } from '@tauri-apps/api/core';
import CapabilityGate from '../components/CapabilityGate';
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  SectionLabel,
  Select,
  StatusDot,
  Switch,
  Textarea,
} from '../components/primitives';
import {
  ALL_LAYOUT_PAGES,
  DEFAULT_HOME_WIDGETS,
  ORGANIZATION_ONLY_PAGES,
  STARTER_LAYOUTS,
  pageLabel,
  type HomeWidgetId,
  type LayoutPreferences,
} from '../data/layout';
import { isPersonalLocalWorkspace } from '../runtime/page-registry';
import { useTheme, type Theme } from '../contexts/ThemeContext';
import { useRuntime } from '../runtime/RuntimeProvider';
import { useRuntimeStore } from '../runtime/store';
import type { JsonValue } from '../runtime/contracts';
import RuntimeStateNotice from '../components/RuntimeStateNotice';

type SettingsTab =
  | 'profile'
  | 'appearance'
  | 'navigation'
  | 'home'
  | 'shortcuts'
  | 'accessibility'
  | 'workspace'
  | 'safety'
  | 'models'
  | 'connections'
  | 'data'
  | 'capabilities'
  | 'storage'
  | 'updates'
  | 'diagnostics'
  | 'project-general'
  | 'project-runs'
  | 'project-environment'
  | 'project-integrations'
  | 'organization-policies'
  | 'organization-access'
  | 'organization-approvals'
  | 'organization-audit';

interface SettingsTabMeta {
  id: SettingsTab;
  label: string;
  group: 'User' | 'Workspace' | 'Project' | 'Organization';
  description: string;
}

const SETTINGS_TABS: SettingsTabMeta[] = [
  {
    id: 'profile',
    label: 'Profile',
    group: 'User',
    description: 'Your name, avatar, and onboarding state.',
  },
  {
    id: 'appearance',
    label: 'Appearance',
    group: 'User',
    description: 'Theme, density, and visual presentation.',
  },
  {
    id: 'navigation',
    label: 'Navigation',
    group: 'User',
    description: 'Pages, groups, ordering, and visibility.',
  },
  { id: 'home', label: 'Home', group: 'User', description: 'Choose and size Home widgets.' },
  {
    id: 'shortcuts',
    label: 'Shortcuts and interaction',
    group: 'User',
    description: 'Keyboard and interaction preferences.',
  },
  {
    id: 'accessibility',
    label: 'Accessibility',
    group: 'User',
    description: 'Motion, contrast, text, and input preferences.',
  },
  {
    id: 'workspace',
    label: 'Overview and identity',
    group: 'Workspace',
    description: 'Workspace name, location, and session context.',
  },
  {
    id: 'safety',
    label: 'Local safety and confirmations',
    group: 'Workspace',
    description: 'Optional “Confirm on this device” prompts.',
  },
  {
    id: 'models',
    label: 'Models and routing',
    group: 'Workspace',
    description: 'Provider order, routing, and model defaults.',
  },
  {
    id: 'connections',
    label: 'Connections and credentials',
    group: 'Workspace',
    description: 'OAuth, credentials, and external services.',
  },
  {
    id: 'data',
    label: 'Data and privacy',
    group: 'Workspace',
    description: 'Data classes, retention, and local privacy defaults.',
  },
  {
    id: 'capabilities',
    label: 'Capabilities and runtimes',
    group: 'Workspace',
    description: 'Installed and optional local runtimes.',
  },
  {
    id: 'storage',
    label: 'Storage and backups',
    group: 'Workspace',
    description: 'Archives, backups, and restore operations.',
  },
  {
    id: 'updates',
    label: 'Updates',
    group: 'Workspace',
    description: 'Signed application update lifecycle.',
  },
  {
    id: 'diagnostics',
    label: 'Diagnostics',
    group: 'Workspace',
    description: 'Health, capability state, and troubleshooting.',
  },
  {
    id: 'project-general',
    label: 'General',
    group: 'Project',
    description: 'Project identity and shared defaults.',
  },
  {
    id: 'project-runs',
    label: 'Run defaults',
    group: 'Project',
    description: 'Preferred model, environment, and execution defaults.',
  },
  {
    id: 'project-environment',
    label: 'Environment',
    group: 'Project',
    description: 'Runtime and resource preferences.',
  },
  {
    id: 'project-integrations',
    label: 'Integrations',
    group: 'Project',
    description: 'Project-specific connections and tools.',
  },
  {
    id: 'organization-policies',
    label: 'Policies',
    group: 'Organization',
    description: 'Organization-controlled restrictions.',
  },
  {
    id: 'organization-access',
    label: 'Roles and access',
    group: 'Organization',
    description: 'Organization membership and authority.',
  },
  {
    id: 'organization-approvals',
    label: 'Approvals',
    group: 'Organization',
    description: 'Organization approval queues.',
  },
  {
    id: 'organization-audit',
    label: 'Audit',
    group: 'Organization',
    description: 'Organization audit and governance evidence.',
  },
];

type DataClass = 'public' | 'internal' | 'confidential' | 'restricted';
const DATA_CLASSES: DataClass[] = ['public', 'internal', 'confidential', 'restricted'];

interface RoutingPolicy {
  allowExternalModels: boolean;
  allowProviderFallback: boolean;
  allowedDataClasses: DataClass[];
  harnessPolicies: Record<string, Record<string, JsonValue>>;
}

interface RoutingResponse {
  providerPriority: string[];
  routingPolicy?: RoutingPolicy;
}

interface WorkspaceResponse {
  rootPath?: string;
  manifest?: Record<string, unknown>;
  workspaceContext?: { mode?: string; organizationId?: string };
}

interface SettingsEnvelope {
  revision: number;
  values: Record<string, JsonValue>;
  updatedAt: string;
}

interface ProfileState {
  displayName: string;
  initials: string;
  avatarColor: string;
  onboardingComplete: boolean;
}

interface UpdateStatus {
  product: 'Spyderbyte';
  currentVersion: string;
  channel: 'stable' | 'beta' | 'developer';
  platform: string;
  architecture: string;
  state: string;
  lastCheckedAt?: string;
  available?: {
    version: string;
    releaseNotes: string;
    publishedAt: string;
    artifactDigest: string;
  };
  downloadedPath?: string;
  lastError?: string;
  workspacePreserved: true;
}

interface DesktopUpdateInfo {
  version: string;
  body?: string;
  target: string;
}

const LEGACY_TABS: Record<string, SettingsTab> = {
  general: 'workspace',
  runtime: 'diagnostics',
};

function normalizeTab(value: string | undefined): SettingsTab {
  if (value !== undefined && value in LEGACY_TABS) return LEGACY_TABS[value] as SettingsTab;
  return SETTINGS_TABS.some((tab) => tab.id === value) ? (value as SettingsTab) : 'workspace';
}

function record(value: unknown): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : undefined;
}

function booleanSetting(values: Record<string, JsonValue>, key: string, fallback = false): boolean {
  return typeof values[key] === 'boolean' ? (values[key] as boolean) : fallback;
}

export default function Settings({
  layoutPreferences,
  onLayoutChange,
  initialTab = 'workspace',
}: {
  layoutPreferences: LayoutPreferences;
  onLayoutChange: (next: LayoutPreferences) => void;
  initialTab?: string;
}): ReactElement {
  const runtime = useRuntime();
  const snapshot = useRuntimeStore(runtime);
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();
  const [tab, setTab] = useState<SettingsTab>(normalizeTab(initialTab));
  const [profile, setProfile] = useState<ProfileState>({
    displayName: snapshot.session?.actor.displayName ?? '',
    initials: '',
    avatarColor: '#7c6cff',
    onboardingComplete: false,
  });
  const [profileRevision, setProfileRevision] = useState(0);
  const [userSettingsRevision, setUserSettingsRevision] = useState(0);
  const [userValues, setUserValues] = useState<Record<string, JsonValue>>({});
  const [workspaceValues, setWorkspaceValues] = useState<Record<string, JsonValue>>({});
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const [projectId, setProjectId] = useState('');
  const [projectValues, setProjectValues] = useState<Record<string, JsonValue>>({});
  const [projectRevision, setProjectRevision] = useState(0);
  const [routing, setRouting] = useState<RoutingResponse>();
  const [workspace, setWorkspace] = useState<WorkspaceResponse>();
  const [updates, setUpdates] = useState<UpdateStatus>();
  const [desktopUpdate, setDesktopUpdate] = useState<DesktopUpdateInfo>();
  const [archivePath, setArchivePath] = useState('');
  const [restorePath, setRestorePath] = useState('');
  const [restoreDestination, setRestoreDestination] = useState('');
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  const reportedWorkspaceMode =
    snapshot.capabilities?.workspaceMode ??
    snapshot.session?.workspaceContext?.mode ??
    workspace?.workspaceContext?.mode ??
    (typeof workspace?.manifest?.mode === 'string' ? workspace.manifest.mode : undefined);
  const workspaceMode =
    reportedWorkspaceMode ??
    (isPersonalLocalWorkspace(snapshot.capabilities) ? 'personal_local' : undefined);
  const personalLocal = workspaceMode === 'personal_local';
  const isOrganization =
    workspaceMode === 'organization_local' ||
    workspaceMode === 'organization_hosted' ||
    snapshot.session?.workspaceContext?.organizationId !== undefined;

  useEffect(() => setTab(normalizeTab(initialTab)), [initialTab]);

  useEffect(() => {
    const root = document.documentElement;
    for (const [key, attribute] of [
      ['reducedMotion', 'data-reduced-motion'],
      ['highContrast', 'data-high-contrast'],
      ['largerText', 'data-larger-text'],
    ] as const) {
      if (userValues[key] === true) root.setAttribute(attribute, 'true');
      else root.removeAttribute(attribute);
    }
  }, [userValues]);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      if (!runtime.client.get) return;
      const results = await Promise.allSettled([
        runtime.client.get<{ profile: Partial<ProfileState>; revision?: number }>('/v1/profile'),
        runtime.client.get<SettingsEnvelope>('/v1/settings?scope=user'),
        runtime.client.get<SettingsEnvelope>('/v1/settings?scope=workspace'),
        runtime.client.get<RoutingResponse>('/v1/model-routing'),
        runtime.client.get<WorkspaceResponse>('/v1/workspace'),
        runtime.client.get<UpdateStatus>('/v1/updates/status'),
      ]);
      if (cancelled) return;
      const [
        profileResult,
        userSettings,
        workspaceSettings,
        routingResult,
        workspaceResult,
        updatesResult,
      ] = results;
      if (profileResult.status === 'fulfilled') {
        const value = profileResult.value.profile;
        setProfile((current) => ({
          ...current,
          displayName: value.displayName ?? current.displayName,
          initials: value.initials ?? current.initials,
          avatarColor: value.avatarColor ?? current.avatarColor,
          onboardingComplete: value.onboardingComplete ?? current.onboardingComplete,
        }));
        setProfileRevision(profileResult.value.revision ?? 0);
      }
      if (userSettings.status === 'fulfilled') {
        setUserValues(userSettings.value.values);
        setUserSettingsRevision(userSettings.value.revision);
      }
      if (workspaceSettings.status === 'fulfilled') {
        setWorkspaceValues(workspaceSettings.value.values);
        setWorkspaceRevision(workspaceSettings.value.revision);
      }
      if (routingResult.status === 'fulfilled') setRouting(routingResult.value);
      if (workspaceResult.status === 'fulfilled') setWorkspace(workspaceResult.value);
      if (updatesResult.status === 'fulfilled') setUpdates(updatesResult.value);
    };
    void load().catch((error) =>
      setMessage(error instanceof Error ? error.message : String(error)),
    );
    return () => {
      cancelled = true;
    };
  }, [runtime]);

  const tabsByGroup = useMemo(() => {
    const allowed = isOrganization
      ? SETTINGS_TABS
      : SETTINGS_TABS.filter((item) => item.group !== 'Organization');
    return ['User', 'Workspace', 'Project', 'Organization']
      .map((group) => ({
        group,
        tabs: allowed.filter((item) => item.group === group),
      }))
      .filter((entry) => entry.tabs.length > 0);
  }, [isOrganization]);
  const activeTab = SETTINGS_TABS.find((item) => item.id === tab) ?? SETTINGS_TABS[6];
  const capabilityCount = Object.values(snapshot.capabilities?.capabilities ?? {}).filter(
    (item) => item.enabled,
  ).length;

  function selectTab(next: SettingsTab): void {
    const metadata = SETTINGS_TABS.find((item) => item.id === next);
    setTab(next);
    navigate(`/settings/${metadata?.group.toLowerCase() ?? 'workspace'}/${next}`);
  }

  async function saveUserPatch(patch: Record<string, JsonValue>, label: string): Promise<void> {
    if (!runtime.client.put) {
      setMessage('This runtime does not expose durable settings yet.');
      return;
    }
    setBusy(true);
    try {
      const result = await runtime.client.put<SettingsEnvelope>('/v1/settings', {
        scope: 'user',
        expectedRevision: userSettingsRevision,
        patch,
      } as unknown as JsonValue);
      setUserValues(result.values);
      setUserSettingsRevision(result.revision);
      setMessage(`${label} saved.`);
    } catch (error) {
      setMessage(error instanceof Error ? `${error.message} Refresh and retry.` : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveProfile(): Promise<void> {
    if (!runtime.client.put)
      return setMessage('This runtime does not expose profile persistence yet.');
    if (!profile.displayName.trim()) return setMessage('Display name is required.');
    setBusy(true);
    try {
      const result = await runtime.client.put<{ revision: number }>('/v1/profile', {
        ...profile,
        displayName: profile.displayName.trim(),
        expectedRevision: profileRevision,
      } as unknown as JsonValue);
      setProfileRevision(result.revision);
      setMessage('Profile saved.');
      await runtime.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? `${error.message} Refresh and retry.` : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveWorkspacePatch(
    patch: Record<string, JsonValue>,
    label: string,
  ): Promise<void> {
    if (!runtime.client.put)
      return setMessage('This runtime does not expose durable settings yet.');
    setBusy(true);
    try {
      const result = await runtime.client.put<SettingsEnvelope>('/v1/settings', {
        scope: 'workspace',
        expectedRevision: workspaceRevision,
        patch,
      } as unknown as JsonValue);
      setWorkspaceValues(result.values);
      setWorkspaceRevision(result.revision);
      setMessage(`${label} saved.`);
    } catch (error) {
      setMessage(error instanceof Error ? `${error.message} Refresh and retry.` : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function loadProjectSettings(): Promise<void> {
    if (!runtime.client.get || !projectId.trim()) return;
    try {
      const result = await runtime.client.get<SettingsEnvelope>(
        `/v1/settings?scope=project&projectId=${encodeURIComponent(projectId.trim())}`,
      );
      setProjectValues(result.values);
      setProjectRevision(result.revision);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveProjectSettings(): Promise<void> {
    if (!runtime.client.put || !projectId.trim()) return setMessage('Enter a project id first.');
    setBusy(true);
    try {
      const result = await runtime.client.put<SettingsEnvelope>('/v1/settings', {
        scope: 'project',
        projectId: projectId.trim(),
        expectedRevision: projectRevision,
        patch: projectValues,
      } as unknown as JsonValue);
      setProjectRevision(result.revision);
      setMessage('Project defaults saved.');
    } catch (error) {
      setMessage(error instanceof Error ? `${error.message} Refresh and retry.` : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function movePriority(providerId: string, direction: -1 | 1): Promise<void> {
    if (!runtime.client.post || !routing) return;
    const priority = [...routing.providerPriority];
    const index = priority.indexOf(providerId);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= priority.length) return;
    [priority[index], priority[next]] = [priority[next] as string, priority[index] as string];
    setBusy(true);
    try {
      const result = await runtime.client.post<RoutingResponse>('/v1/model-routing', {
        providerPriority: priority,
        ...(routing.routingPolicy === undefined ? {} : { routingPolicy: routing.routingPolicy }),
      } as unknown as JsonValue);
      setRouting(result);
      setMessage('Provider priority saved.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function updatePolicy(patch: Partial<RoutingPolicy>): void {
    if (!routing?.routingPolicy) return;
    setRouting({ ...routing, routingPolicy: { ...routing.routingPolicy, ...patch } });
  }

  async function savePolicy(): Promise<void> {
    if (!runtime.client.post || !routing?.routingPolicy) return;
    setBusy(true);
    try {
      const result = await runtime.client.post<RoutingResponse>('/v1/model-routing', {
        providerPriority: routing.providerPriority,
        routingPolicy: routing.routingPolicy,
      } as unknown as JsonValue);
      setRouting(result);
      setMessage('Routing preferences saved.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function workspaceAction(
    path: string,
    body: JsonValue | undefined,
    label: string,
  ): Promise<void> {
    if (!runtime.client.post || body === undefined) {
      setMessage('Provide the required workspace paths first.');
      return;
    }
    setBusy(true);
    try {
      await runtime.client.post(path, body);
      setMessage(`${label} completed.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function updateAction(
    path:
      | '/v1/updates/check'
      | '/v1/updates/download'
      | '/v1/updates/install'
      | '/v1/updates/rollback',
    label: string,
  ): Promise<void> {
    if (!runtime.client.post && !isDesktop) return;
    setBusy(true);
    try {
      if (isDesktop && path === '/v1/updates/check') {
        const result = await invoke<DesktopUpdateInfo | null>('check_desktop_update');
        setDesktopUpdate(result ?? undefined);
        setMessage(
          result ? `Spyderbyte ${result.version} is available.` : 'Spyderbyte is up to date.',
        );
        return;
      }
      if (isDesktop && path === '/v1/updates/install') {
        await invoke('install_desktop_update');
        setMessage('Update installed. Spyderbyte will restart.');
        return;
      }
      if (!runtime.client.post) return;
      setUpdates(await runtime.client.post<UpdateStatus>(path, {}));
      setMessage(`${label} completed.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function togglePage(page: (typeof ALL_LAYOUT_PAGES)[number]): void {
    if (ORGANIZATION_ONLY_PAGES.includes(page) && !isOrganization) return;
    const visible = layoutPreferences.visiblePages.includes(page)
      ? layoutPreferences.visiblePages.filter((candidate) => candidate !== page)
      : [...layoutPreferences.visiblePages, page];
    const groups = layoutPreferences.navigationGroups.map((group) => ({
      ...group,
      pages: group.pages.filter((candidate) => visible.includes(candidate)),
    }));
    if (visible.includes(page) && !groups.some((group) => group.pages.includes(page))) {
      groups.push({ label: 'More', pages: [page] });
    }
    onLayoutChange({
      ...layoutPreferences,
      visiblePages: visible,
      navigationGroups: groups.filter((group) => group.pages.length > 0),
      pinnedPages: layoutPreferences.pinnedPages.filter((candidate) => visible.includes(candidate)),
    });
  }

  function movePage(page: (typeof ALL_LAYOUT_PAGES)[number], direction: -1 | 1): void {
    const index = layoutPreferences.visiblePages.indexOf(page);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= layoutPreferences.visiblePages.length) return;
    const visiblePages = [...layoutPreferences.visiblePages];
    [visiblePages[index], visiblePages[next]] = [
      visiblePages[next] as typeof page,
      visiblePages[index] as typeof page,
    ];
    const navigationGroups = layoutPreferences.navigationGroups.map((group) => {
      const pages = [...group.pages];
      const groupIndex = pages.indexOf(page);
      const groupNext = groupIndex + direction;
      if (groupIndex >= 0 && groupNext >= 0 && groupNext < pages.length) {
        [pages[groupIndex], pages[groupNext]] = [
          pages[groupNext] as typeof page,
          pages[groupIndex] as typeof page,
        ];
      }
      return { ...group, pages };
    });
    onLayoutChange({ ...layoutPreferences, visiblePages, navigationGroups });
  }

  function renameGroup(index: number, label: string): void {
    const navigationGroups = layoutPreferences.navigationGroups.map((group, groupIndex) =>
      groupIndex === index ? { ...group, label: label.trim() || `Section ${index + 1}` } : group,
    );
    onLayoutChange({ ...layoutPreferences, navigationGroups });
  }

  function addGroup(): void {
    const existing = new Set(layoutPreferences.navigationGroups.map((group) => group.label));
    let suffix = layoutPreferences.navigationGroups.length + 1;
    let label = `Custom section ${suffix}`;
    while (existing.has(label)) {
      suffix += 1;
      label = `Custom section ${suffix}`;
    }
    onLayoutChange({
      ...layoutPreferences,
      navigationGroups: [...layoutPreferences.navigationGroups, { label, pages: [] }],
    });
  }

  function removeGroup(index: number): void {
    if (layoutPreferences.navigationGroups.length <= 1) return;
    const groups = layoutPreferences.navigationGroups.map((group) => ({
      ...group,
      pages: [...group.pages],
    }));
    const removed = groups.splice(index, 1)[0];
    if (removed === undefined) return;
    const target = groups[0];
    if (target !== undefined) target.pages.push(...removed.pages);
    onLayoutChange({ ...layoutPreferences, navigationGroups: groups });
  }

  function movePageToGroup(page: (typeof ALL_LAYOUT_PAGES)[number], targetIndex: number): void {
    const groups = layoutPreferences.navigationGroups.map((group) => ({
      ...group,
      pages: group.pages.filter((candidate) => candidate !== page),
    }));
    const target = groups[targetIndex];
    if (target === undefined) return;
    target.pages.push(page);
    onLayoutChange({
      ...layoutPreferences,
      navigationGroups: groups.filter((group) => group.pages.length > 0),
    });
  }

  function togglePinnedPage(page: (typeof ALL_LAYOUT_PAGES)[number]): void {
    const pinnedPages = layoutPreferences.pinnedPages.includes(page)
      ? layoutPreferences.pinnedPages.filter((candidate) => candidate !== page)
      : [...layoutPreferences.pinnedPages, page];
    onLayoutChange({ ...layoutPreferences, pinnedPages });
  }

  function moveWidget(widget: HomeWidgetId, direction: -1 | 1): void {
    const index = layoutPreferences.homeWidgets.indexOf(widget);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= layoutPreferences.homeWidgets.length) return;
    const homeWidgets = [...layoutPreferences.homeWidgets];
    [homeWidgets[index], homeWidgets[next]] = [
      homeWidgets[next] as HomeWidgetId,
      homeWidgets[index] as HomeWidgetId,
    ];
    onLayoutChange({ ...layoutPreferences, homeWidgets });
  }

  const safety = {
    confirmExternalNetwork: booleanSetting(workspaceValues, 'confirmExternalNetwork'),
    confirmExternalWrites: booleanSetting(workspaceValues, 'confirmExternalWrites'),
    confirmDestructiveActions: booleanSetting(workspaceValues, 'confirmDestructiveActions'),
    confirmSecretUse: booleanSetting(workspaceValues, 'confirmSecretUse'),
  };
  const widgets: Array<{ id: HomeWidgetId; label: string; description: string }> = [
    {
      id: 'welcome',
      label: 'Welcome and project objective',
      description: 'Quickly create a project from a plain-language objective.',
    },
    {
      id: 'quick-actions',
      label: 'Workflow starters',
      description: 'Shortcuts for common platform surfaces.',
    },
    {
      id: 'recent-work',
      label: 'Recent projects and runs',
      description: 'Continue active work from Home.',
    },
    { id: 'activity', label: 'Activity', description: 'Recent platform events and changes.' },
    {
      id: 'compute',
      label: 'Compute',
      description: 'Local CPU, memory, and storage observations.',
    },
    {
      id: 'safety',
      label: 'Safety summary',
      description: 'Local confirmations and organization context.',
    },
    {
      id: 'deployments',
      label: 'Deployment status',
      description: 'Active deployments and runtime state.',
    },
    { id: 'license', label: 'License entitlement', description: 'Application entitlement state.' },
  ];

  return (
    <CapabilityGate page="settings">
      <div className="page-scroll">
        <div className="page stack settings-page">
          <div className="page-heading settings-heading">
            <div>
              <SectionLabel>Configuration center</SectionLabel>
              <h1>Settings</h1>
              <p className="page-subtitle">
                Make this workspace yours. Changes are scoped and saved with revision protection.
              </p>
            </div>
            <div className="settings-heading-context">
              <Badge color={personalLocal ? 'green' : 'blue'}>
                {personalLocal
                  ? 'Personal local'
                  : workspaceMode === undefined
                    ? 'Workspace context'
                    : 'Organization context'}
              </Badge>
              <span>
                {typeof workspace?.manifest?.name === 'string'
                  ? workspace.manifest.name
                  : 'Active workspace'}
              </span>
            </div>
          </div>
          {message && (
            <div className="home-error" role="status">
              {message}
            </div>
          )}
          <RuntimeStateNotice state={snapshot.connection} onRetry={() => void runtime.retry()} />
          <div className="settings-layout">
            <nav className="settings-rail" aria-label="Settings sections">
              <div className="settings-rail-title">Settings</div>
              {tabsByGroup.map((entry) => (
                <div className="settings-rail-group" key={entry.group}>
                  <div className="settings-rail-heading">{entry.group}</div>
                  {entry.tabs.map((item) => (
                    <button
                      key={item.id}
                      className="settings-tab"
                      type="button"
                      aria-current={tab === item.id ? 'page' : undefined}
                      data-active={tab === item.id}
                      onClick={() => selectTab(item.id)}
                    >
                      <span>{item.label}</span>
                    </button>
                  ))}
                </div>
              ))}
            </nav>
            <section className="settings-content" aria-label={`${activeTab.label} settings`}>
              <div className="settings-content-heading">
                <SectionLabel>{activeTab.group}</SectionLabel>
                <h2>{activeTab.label}</h2>
                <p className="settings-copy">{activeTab.description}</p>
              </div>

              {tab === 'profile' && (
                <Card>
                  <Field
                    label="Display name"
                    hint="Required. This name is used in the session sidebar and audit events."
                    required
                  >
                    <Input
                      id="profile-display-name"
                      value={profile.displayName}
                      onChange={(event) =>
                        setProfile({ ...profile, displayName: event.target.value })
                      }
                      autoComplete="name"
                    />
                  </Field>
                  <div className="settings-form-grid settings-form-grid-two">
                    <Field label="Initials" hint="Optional, up to four characters.">
                      <Input
                        id="profile-initials"
                        value={profile.initials}
                        maxLength={4}
                        onChange={(event) =>
                          setProfile({ ...profile, initials: event.target.value.toUpperCase() })
                        }
                      />
                    </Field>
                    <Field label="Avatar color">
                      <Input
                        id="profile-avatar-color"
                        type="color"
                        value={profile.avatarColor}
                        onChange={(event) =>
                          setProfile({ ...profile, avatarColor: event.target.value })
                        }
                      />
                    </Field>
                  </div>
                  <Switch
                    checked={profile.onboardingComplete}
                    label="Mark first-run setup complete"
                    onCheckedChange={(checked) =>
                      setProfile({ ...profile, onboardingComplete: checked })
                    }
                  />
                  <div className="settings-action-row">
                    <Button loading={busy} onClick={() => void saveProfile()}>
                      Save profile
                    </Button>
                    <Button variant="secondary" onClick={() => navigate('/onboarding')}>
                      Reopen setup
                    </Button>
                  </div>
                </Card>
              )}

              {tab === 'appearance' && (
                <Card>
                  <div className="settings-form-grid settings-form-grid-two">
                    <Field label="Theme">
                      <Select
                        id="settings-theme"
                        value={theme}
                        onChange={(event) => setTheme(event.target.value as Theme)}
                      >
                        <option value="system">System</option>
                        <option value="dark">Dark</option>
                        <option value="light">Light</option>
                      </Select>
                    </Field>
                    <Field label="Interface density">
                      <Select
                        id="settings-density"
                        value={layoutPreferences.density}
                        onChange={(event) =>
                          onLayoutChange({
                            ...layoutPreferences,
                            density: event.target.value as LayoutPreferences['density'],
                          })
                        }
                      >
                        <option value="comfortable">Comfortable</option>
                        <option value="compact">Compact</option>
                      </Select>
                    </Field>
                  </div>
                  <Switch
                    checked={booleanSetting(userValues, 'showStatusText', true)}
                    label="Show status text beside icons"
                    onCheckedChange={(checked) => {
                      setUserValues({ ...userValues, showStatusText: checked });
                      onLayoutChange({ ...layoutPreferences, showStatusText: checked });
                    }}
                  />
                  <div className="settings-action-row">
                    <Button
                      loading={busy}
                      onClick={() =>
                        void saveUserPatch(
                          {
                            appearance: { theme, density: layoutPreferences.density },
                            showStatusText: booleanSetting(userValues, 'showStatusText', true),
                          },
                          'Appearance',
                        )
                      }
                    >
                      Save appearance
                    </Button>
                  </div>
                </Card>
              )}

              {tab === 'navigation' && (
                <Card>
                  <p className="settings-copy">
                    Hidden pages remain available through Settings, search, and direct URLs.
                    Visibility never removes a backend capability.
                  </p>
                  <div className="settings-navigation-toolbar">
                    <Field label="Default landing page">
                      <Select
                        value={layoutPreferences.defaultLandingPage}
                        onChange={(event) =>
                          onLayoutChange({
                            ...layoutPreferences,
                            defaultLandingPage: event.target
                              .value as LayoutPreferences['defaultLandingPage'],
                          })
                        }
                      >
                        {layoutPreferences.visiblePages.map((page) => (
                          <option key={page} value={page}>
                            {pageLabel(page)}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Button variant="secondary" onClick={addGroup}>
                      Add navigation section
                    </Button>
                  </div>
                  <div className="settings-navigation-groups">
                    {layoutPreferences.navigationGroups.map((group, index) => (
                      <div className="settings-navigation-group" key={`${group.label}-${index}`}>
                        <Field label={`Section ${index + 1} name`}>
                          <Input
                            value={group.label}
                            onChange={(event) => renameGroup(index, event.target.value)}
                          />
                        </Field>
                        <Button
                          variant="tertiary"
                          disabled={layoutPreferences.navigationGroups.length <= 1}
                          onClick={() => removeGroup(index)}
                        >
                          Remove section
                        </Button>
                      </div>
                    ))}
                  </div>
                  <div className="settings-navigation-list">
                    {ALL_LAYOUT_PAGES.map((page) => {
                      const visible = layoutPreferences.visiblePages.includes(page);
                      const organizationOnly = ORGANIZATION_ONLY_PAGES.includes(page);
                      const groupIndex = layoutPreferences.navigationGroups.findIndex((group) =>
                        group.pages.includes(page),
                      );
                      const pinned = layoutPreferences.pinnedPages.includes(page);
                      return (
                        <div className="settings-navigation-row" key={page}>
                          <Switch
                            checked={visible}
                            label={pageLabel(page)}
                            disabled={organizationOnly && !isOrganization}
                            onCheckedChange={() => togglePage(page)}
                          />
                          <span className="settings-navigation-meta">
                            {organizationOnly
                              ? 'Organization context'
                              : visible
                                ? 'Visible'
                                : 'Hidden'}
                          </span>
                          <Select
                            aria-label={`${pageLabel(page)} navigation section`}
                            value={groupIndex < 0 ? '' : String(groupIndex)}
                            disabled={!visible || (organizationOnly && !isOrganization)}
                            onChange={(event) => movePageToGroup(page, Number(event.target.value))}
                          >
                            <option value="" disabled>
                              Choose section
                            </option>
                            {layoutPreferences.navigationGroups.map((group, groupPosition) => (
                              <option key={`${group.label}-${groupPosition}`} value={groupPosition}>
                                {group.label}
                              </option>
                            ))}
                          </Select>
                          <Button
                            variant="tertiary"
                            disabled={!visible || (organizationOnly && !isOrganization)}
                            aria-pressed={pinned}
                            aria-label={
                              pinned ? `Unpin ${pageLabel(page)}` : `Pin ${pageLabel(page)}`
                            }
                            onClick={() => togglePinnedPage(page)}
                          >
                            {pinned ? '★' : '☆'}
                          </Button>
                          <Button
                            variant="tertiary"
                            disabled={!visible || (organizationOnly && !isOrganization)}
                            onClick={() => movePage(page, -1)}
                            aria-label={`Move ${pageLabel(page)} up`}
                          >
                            ↑
                          </Button>
                          <Button
                            variant="tertiary"
                            disabled={!visible || (organizationOnly && !isOrganization)}
                            onClick={() => movePage(page, 1)}
                            aria-label={`Move ${pageLabel(page)} down`}
                          >
                            ↓
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                  <div className="settings-action-row">
                    <Button
                      loading={busy}
                      onClick={() =>
                        void saveUserPatch(
                          { layout: layoutPreferences as unknown as JsonValue },
                          'Navigation',
                        )
                      }
                    >
                      Save navigation
                    </Button>
                  </div>
                  <div className="settings-starter-layouts">
                    <SectionLabel>Starter layouts</SectionLabel>
                    <div className="settings-template-grid">
                      {Object.entries(STARTER_LAYOUTS).map(([id, starter]) => (
                        <button
                          key={id}
                          className="settings-template-card"
                          type="button"
                          onClick={() => onLayoutChange(starter.layout)}
                        >
                          <strong>{starter.label}</strong>
                          <span>{starter.description}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </Card>
              )}

              {tab === 'home' && (
                <Card>
                  <p className="settings-copy">
                    Home is a configurable dashboard. Toggle widgets and choose their default size;
                    the grid remains responsive.
                  </p>
                  <div className="settings-navigation-list">
                    {widgets.map((widget) => (
                      <div className="settings-navigation-row" key={widget.id}>
                        <Switch
                          checked={layoutPreferences.homeWidgets.includes(widget.id)}
                          label={widget.label}
                          onCheckedChange={(checked) =>
                            onLayoutChange({
                              ...layoutPreferences,
                              homeWidgets: checked
                                ? [...layoutPreferences.homeWidgets, widget.id]
                                : layoutPreferences.homeWidgets.filter((id) => id !== widget.id),
                            })
                          }
                        />
                        <span className="settings-navigation-meta">{widget.description}</span>
                        <Select
                          aria-label={`${widget.label} size`}
                          value={layoutPreferences.widgetSizes[widget.id] ?? 'expanded'}
                          onChange={(event) =>
                            onLayoutChange({
                              ...layoutPreferences,
                              widgetSizes: {
                                ...layoutPreferences.widgetSizes,
                                [widget.id]: event.target.value as 'compact' | 'expanded',
                              },
                            })
                          }
                        >
                          <option value="expanded">Expanded</option>
                          <option value="compact">Compact</option>
                        </Select>
                        <Button
                          variant="tertiary"
                          disabled={!layoutPreferences.homeWidgets.includes(widget.id)}
                          aria-label={`Move ${widget.label} up`}
                          onClick={() => moveWidget(widget.id, -1)}
                        >
                          ↑
                        </Button>
                        <Button
                          variant="tertiary"
                          disabled={!layoutPreferences.homeWidgets.includes(widget.id)}
                          aria-label={`Move ${widget.label} down`}
                          onClick={() => moveWidget(widget.id, 1)}
                        >
                          ↓
                        </Button>
                      </div>
                    ))}
                  </div>
                  <div className="settings-action-row">
                    <Button
                      loading={busy}
                      onClick={() =>
                        void saveUserPatch(
                          {
                            home: {
                              widgets: layoutPreferences.homeWidgets,
                              sizes: layoutPreferences.widgetSizes,
                            } as unknown as JsonValue,
                          },
                          'Home',
                        )
                      }
                    >
                      Save Home
                    </Button>
                    <Button
                      variant="tertiary"
                      onClick={() =>
                        onLayoutChange({
                          ...layoutPreferences,
                          homeWidgets: [...DEFAULT_HOME_WIDGETS],
                        })
                      }
                    >
                      Reset widgets
                    </Button>
                  </div>
                </Card>
              )}

              {(tab === 'shortcuts' || tab === 'accessibility') && (
                <Card>
                  {tab === 'shortcuts' ? (
                    <>
                      <Field label="Global search shortcut">
                        <Input id="shortcut-search" defaultValue="⌘K / Ctrl K" />
                      </Field>
                      <Switch
                        checked={booleanSetting(userValues, 'confirmBeforeClose', false)}
                        label="Confirm before closing an active editor"
                        onCheckedChange={(checked) =>
                          setUserValues({ ...userValues, confirmBeforeClose: checked })
                        }
                      />
                    </>
                  ) : (
                    <>
                      <Switch
                        checked={booleanSetting(userValues, 'reducedMotion', false)}
                        label="Reduce motion"
                        onCheckedChange={(checked) =>
                          setUserValues({ ...userValues, reducedMotion: checked })
                        }
                      />
                      <Switch
                        checked={booleanSetting(userValues, 'highContrast', false)}
                        label="Increase contrast"
                        onCheckedChange={(checked) =>
                          setUserValues({ ...userValues, highContrast: checked })
                        }
                      />
                      <Switch
                        checked={booleanSetting(userValues, 'largerText', false)}
                        label="Use larger text"
                        onCheckedChange={(checked) =>
                          setUserValues({ ...userValues, largerText: checked })
                        }
                      />
                    </>
                  )}
                  <div className="settings-action-row">
                    <Button
                      loading={busy}
                      onClick={() =>
                        void saveUserPatch(
                          userValues,
                          tab === 'shortcuts'
                            ? 'Interaction preferences'
                            : 'Accessibility preferences',
                        )
                      }
                    >
                      Save preferences
                    </Button>
                  </div>
                </Card>
              )}

              {tab === 'workspace' && (
                <Card>
                  <Field
                    label="Workspace name"
                    hint="The manifest identity is trusted by the local daemon; this setting controls its user-facing label."
                  >
                    <Input
                      id="workspace-name"
                      value={
                        typeof workspaceValues.name === 'string'
                          ? workspaceValues.name
                          : String(workspace?.manifest?.name ?? '')
                      }
                      onChange={(event) =>
                        setWorkspaceValues({ ...workspaceValues, name: event.target.value })
                      }
                    />
                  </Field>
                  <dl className="settings-definition-list">
                    <div>
                      <dt>Root</dt>
                      <dd>{workspace?.rootPath ?? 'Unavailable'}</dd>
                    </div>
                    <div>
                      <dt>Workspace mode</dt>
                      <dd>{workspaceMode ?? 'Not reported'}</dd>
                    </div>
                    <div>
                      <dt>Organization</dt>
                      <dd>
                        {snapshot.session?.workspaceContext?.organizationId ??
                          (personalLocal ? 'Personal local workspace' : 'Not configured')}
                      </dd>
                    </div>
                  </dl>
                  <div className="settings-action-row">
                    <Button
                      loading={busy}
                      onClick={() =>
                        void saveWorkspacePatch(
                          { name: workspaceValues.name ?? '' },
                          'Workspace identity',
                        )
                      }
                    >
                      Save workspace
                    </Button>
                  </div>
                  <div className="settings-action-row">
                    <Button variant="secondary" onClick={() => selectTab('storage')}>
                      Manage storage and backups
                    </Button>
                  </div>
                </Card>
              )}

              {tab === 'safety' && (
                <Card>
                  {personalLocal ? (
                    <>
                      <div className="settings-local-callout">
                        <StatusDot color="green" label="Local mode" />
                        <div>
                          <strong>Personal local mode</strong>
                          <p>
                            Organization policy blocks and approval queues are not applied to this
                            workspace. Technical validation, authority scope, secrets, filesystem
                            boundaries, budgets, and audit evidence remain enforced.
                          </p>
                        </div>
                      </div>
                      <Switch
                        checked={safety.confirmExternalNetwork}
                        label="Confirm external network access"
                        onCheckedChange={(checked) =>
                          setWorkspaceValues({
                            ...workspaceValues,
                            confirmExternalNetwork: checked,
                          })
                        }
                      />
                      <Switch
                        checked={safety.confirmExternalWrites}
                        label="Confirm external writes"
                        onCheckedChange={(checked) =>
                          setWorkspaceValues({ ...workspaceValues, confirmExternalWrites: checked })
                        }
                      />
                      <Switch
                        checked={safety.confirmDestructiveActions}
                        label="Confirm destructive actions"
                        onCheckedChange={(checked) =>
                          setWorkspaceValues({
                            ...workspaceValues,
                            confirmDestructiveActions: checked,
                          })
                        }
                      />
                      <Switch
                        checked={safety.confirmSecretUse}
                        label="Confirm secret use"
                        onCheckedChange={(checked) =>
                          setWorkspaceValues({ ...workspaceValues, confirmSecretUse: checked })
                        }
                      />
                    </>
                  ) : (
                    <div className="settings-local-callout">
                      <StatusDot color="blue" label="Organization mode" />
                      <div>
                        <strong>Organization controls are active</strong>
                        <p>
                          Organization policy, roles, audit, and approval behavior are provided by
                          the trusted workspace context.
                        </p>
                      </div>
                    </div>
                  )}
                  <div className="settings-action-row">
                    <Button
                      loading={busy}
                      onClick={() =>
                        void saveWorkspacePatch({ ...safety }, 'Local safety settings')
                      }
                    >
                      Save safety settings
                    </Button>
                  </div>
                </Card>
              )}

              {tab === 'models' && (
                <Card>
                  <h3>Provider priority</h3>
                  <p className="settings-copy">
                    Model routing is a workspace preference. Organization restrictions appear only
                    when an organization context is active.
                  </p>
                  <div className="settings-priority-list">
                    {(routing?.providerPriority ?? []).map((providerId, index, priority) => (
                      <div className="settings-priority-row" key={providerId}>
                        <span>
                          <strong>{index + 1}</strong> {providerId}
                        </span>
                        <span className="settings-action-row">
                          <Button
                            variant="tertiary"
                            disabled={busy || index === 0}
                            onClick={() => void movePriority(providerId, -1)}
                          >
                            Up
                          </Button>
                          <Button
                            variant="tertiary"
                            disabled={busy || index === priority.length - 1}
                            onClick={() => void movePriority(providerId, 1)}
                          >
                            Down
                          </Button>
                        </span>
                      </div>
                    ))}
                  </div>
                  {routing?.routingPolicy && (
                    <div className="settings-policy-panel">
                      <Switch
                        checked={routing.routingPolicy.allowExternalModels}
                        label="Allow external model providers"
                        onCheckedChange={(checked) =>
                          updatePolicy({ allowExternalModels: checked })
                        }
                      />
                      <Switch
                        checked={routing.routingPolicy.allowProviderFallback}
                        label="Allow provider fallback"
                        onCheckedChange={(checked) =>
                          updatePolicy({ allowProviderFallback: checked })
                        }
                      />
                      <strong>Allowed data classes</strong>
                      <div className="settings-data-classes">
                        {DATA_CLASSES.map((dataClass) => (
                          <label key={dataClass} className="settings-checkbox-inline">
                            <input
                              type="checkbox"
                              checked={
                                routing.routingPolicy?.allowedDataClasses.includes(dataClass) ??
                                false
                              }
                              onChange={(event) =>
                                updatePolicy({
                                  allowedDataClasses: event.target.checked
                                    ? [
                                        ...new Set([
                                          ...(routing.routingPolicy?.allowedDataClasses ?? []),
                                          dataClass,
                                        ]),
                                      ]
                                    : (routing.routingPolicy?.allowedDataClasses ?? []).filter(
                                        (value) => value !== dataClass,
                                      ),
                                })
                              }
                            />
                            {dataClass}
                          </label>
                        ))}
                      </div>
                      <Button variant="secondary" loading={busy} onClick={() => void savePolicy()}>
                        Save routing
                      </Button>
                    </div>
                  )}
                  <Button variant="secondary" onClick={() => navigate('/models')}>
                    Open model catalog
                  </Button>
                </Card>
              )}

              {tab === 'connections' && (
                <Card>
                  <h3>Connections and credentials</h3>
                  <p className="settings-copy">
                    Credentials are stored and redacted by the platform boundary. Setup, reconnect,
                    test, and revoke flows live in the canonical connection surface.
                  </p>
                  <Button onClick={() => navigate('/connections')}>Manage connections</Button>
                </Card>
              )}
              {tab === 'data' && (
                <Card>
                  <h3>Data and privacy defaults</h3>
                  <p className="settings-copy">
                    Choose the data classes that may be routed to configured model providers. PII
                    findings are evidence in personal-local mode and do not become organization
                    workflow blocks.
                  </p>
                  <div className="settings-data-classes">
                    {DATA_CLASSES.map((dataClass) => (
                      <label key={dataClass} className="settings-checkbox-inline">
                        <input
                          type="checkbox"
                          checked={
                            (record(workspaceValues.dataClasses)?.[dataClass] as
                              | boolean
                              | undefined) ?? dataClass === 'public'
                          }
                          onChange={(event) =>
                            setWorkspaceValues({
                              ...workspaceValues,
                              dataClasses: {
                                ...(record(workspaceValues.dataClasses) ?? {}),
                                [dataClass]: event.target.checked,
                              } as unknown as JsonValue,
                            })
                          }
                        />
                        {dataClass}
                      </label>
                    ))}
                  </div>
                  <Field label="Default retention days">
                    <Input
                      id="retention-days"
                      type="number"
                      min={1}
                      max={365}
                      value={
                        typeof workspaceValues.retentionDays === 'number'
                          ? workspaceValues.retentionDays
                          : 30
                      }
                      onChange={(event) =>
                        setWorkspaceValues({
                          ...workspaceValues,
                          retentionDays: Number(event.target.value),
                        })
                      }
                    />
                  </Field>
                  <Button
                    loading={busy}
                    onClick={() => void saveWorkspacePatch(workspaceValues, 'Data preferences')}
                  >
                    Save data preferences
                  </Button>
                </Card>
              )}

              {tab === 'capabilities' && (
                <Card>
                  <h3>Capabilities and runtimes</h3>
                  <p className="settings-copy">
                    “Not configured” means an optional local runtime is missing. It is different
                    from an organization restriction.
                  </p>
                  <div className="settings-capability-list">
                    {Object.entries(snapshot.capabilities?.capabilities ?? {}).map(
                      ([key, value]) => (
                        <div key={key} className="settings-capability-row">
                          <span>{key}</span>
                          <Badge color={value.enabled ? 'green' : 'gray'}>
                            {value.enabled ? (value.status ?? 'enabled') : 'Not configured'}
                          </Badge>
                        </div>
                      ),
                    )}
                  </div>
                </Card>
              )}

              {tab === 'storage' && (
                <Card>
                  <h3>Storage and backups</h3>
                  <p className="settings-copy">
                    Backups preserve workspace mode, settings, and authoritative state.
                  </p>
                  <div className="settings-form-grid">
                    <Field label="Archive path for export or backup">
                      <Input
                        id="archive-path"
                        type="text"
                        value={archivePath}
                        onChange={(event) => setArchivePath(event.target.value)}
                        placeholder="/path/to/workspace.tar"
                      />
                    </Field>
                    <div className="settings-action-row">
                      <Button
                        variant="secondary"
                        loading={busy}
                        onClick={() =>
                          void workspaceAction(
                            '/v1/workspace/export',
                            archivePath.trim()
                              ? { destinationPath: archivePath.trim() }
                              : undefined,
                            'Workspace export',
                          )
                        }
                      >
                        Export workspace
                      </Button>
                      <Button
                        loading={busy}
                        onClick={() =>
                          void workspaceAction(
                            '/v1/workspace/backup',
                            archivePath.trim()
                              ? { destinationPath: archivePath.trim() }
                              : undefined,
                            'Workspace backup',
                          )
                        }
                      >
                        Create backup
                      </Button>
                    </div>
                    <Field label="Restore archive path">
                      <Input
                        id="restore-path"
                        type="text"
                        value={restorePath}
                        onChange={(event) => setRestorePath(event.target.value)}
                        placeholder="/path/to/workspace.tar"
                      />
                    </Field>
                    <Field label="Restore destination">
                      <Input
                        id="restore-destination"
                        type="text"
                        value={restoreDestination}
                        onChange={(event) => setRestoreDestination(event.target.value)}
                        placeholder="/path/to/restored-workspace"
                      />
                    </Field>
                    <div className="settings-action-row">
                      <Button
                        variant="secondary"
                        loading={busy}
                        onClick={() =>
                          void workspaceAction(
                            '/v1/workspace/restore-preview',
                            restorePath.trim() && restoreDestination.trim()
                              ? {
                                  archivePath: restorePath.trim(),
                                  destinationRoot: restoreDestination.trim(),
                                }
                              : undefined,
                            'Restore preview',
                          )
                        }
                      >
                        Preview restore
                      </Button>
                      <Button
                        variant="tertiary"
                        loading={busy}
                        onClick={() =>
                          void workspaceAction(
                            '/v1/workspace/import',
                            restorePath.trim() && restoreDestination.trim()
                              ? {
                                  archivePath: restorePath.trim(),
                                  destinationRoot: restoreDestination.trim(),
                                }
                              : undefined,
                            'Workspace import',
                          )
                        }
                      >
                        Import workspace
                      </Button>
                    </div>
                  </div>
                </Card>
              )}

              {tab === 'updates' && (
                <Card>
                  <h3>Spyderbyte updates</h3>
                  <p className="settings-copy">
                    Signed metadata, background downloads, workspace preservation, and explicit
                    install confirmation.
                  </p>
                  <dl className="settings-definition-list">
                    <div>
                      <dt>Installed</dt>
                      <dd>{updates?.currentVersion ?? 'Unavailable'}</dd>
                    </div>
                    <div>
                      <dt>Channel</dt>
                      <dd>{updates?.channel ?? 'stable'}</dd>
                    </div>
                    <div>
                      <dt>Target</dt>
                      <dd>
                        {updates ? `${updates.platform} · ${updates.architecture}` : 'Unavailable'}
                      </dd>
                    </div>
                    <div>
                      <dt>Status</dt>
                      <dd>{updates?.state ?? 'Unknown'}</dd>
                    </div>
                  </dl>
                  {updates?.available && (
                    <div className="settings-policy-panel">
                      <Badge color="blue">Version {updates.available.version} available</Badge>
                      <p className="settings-copy">{updates.available.releaseNotes}</p>
                    </div>
                  )}
                  {desktopUpdate && (
                    <div className="settings-policy-panel">
                      <Badge color="blue">Version {desktopUpdate.version} available</Badge>
                      <p className="settings-copy">
                        {desktopUpdate.body ?? 'A signed desktop update is ready.'}
                      </p>
                    </div>
                  )}
                  <div className="settings-action-row">
                    <Button
                      variant="secondary"
                      loading={busy}
                      onClick={() => void updateAction('/v1/updates/check', 'Update check')}
                    >
                      Check now
                    </Button>
                    {updates?.state === 'available' && (
                      <Button
                        loading={busy}
                        onClick={() => void updateAction('/v1/updates/download', 'Update download')}
                      >
                        Download update
                      </Button>
                    )}
                    {(isDesktop && desktopUpdate) ||
                    (!isDesktop && updates?.state === 'ready-to-install') ? (
                      <Button
                        loading={busy}
                        onClick={() =>
                          void updateAction('/v1/updates/install', 'Installation request')
                        }
                      >
                        Install and restart
                      </Button>
                    ) : null}
                  </div>
                </Card>
              )}

              {tab === 'diagnostics' && (
                <Card>
                  <h3>Diagnostics</h3>
                  <div className="settings-runtime-summary">
                    <StatusDot
                      color={snapshot.connection === 'connected' ? 'green' : 'amber'}
                      label={snapshot.connection}
                    />
                    <span>
                      {snapshot.connection} · {capabilityCount} enabled capabilities
                    </span>
                    <Badge color={snapshot.health?.status === 'ok' ? 'green' : 'amber'}>
                      {snapshot.health?.status ?? 'unknown'}
                    </Badge>
                  </div>
                  <div className="settings-capability-list">
                    {Object.entries(snapshot.capabilities?.capabilities ?? {}).map(
                      ([key, value]) => (
                        <div key={key} className="settings-capability-row">
                          <span>{key}</span>
                          <Badge color={value.enabled ? 'green' : 'gray'}>
                            {value.enabled ? 'enabled' : (value.reason ?? 'Not configured')}
                          </Badge>
                        </div>
                      ),
                    )}
                  </div>
                </Card>
              )}

              {tab.startsWith('project-') && (
                <Card>
                  <h3>Project-scoped settings</h3>
                  <p className="settings-copy">
                    Project defaults override workspace defaults without changing workspace safety
                    or authority boundaries.
                  </p>
                  <Field
                    label="Project id"
                    hint="Paste a project UUID to load its durable settings."
                  >
                    <Input
                      id="project-settings-id"
                      value={projectId}
                      onChange={(event) => setProjectId(event.target.value)}
                    />
                  </Field>
                  <Button variant="secondary" onClick={() => void loadProjectSettings()}>
                    Load project settings
                  </Button>
                  <div className="settings-form-grid">
                    <Field label="Preferred model">
                      <Input
                        id="project-model"
                        value={
                          typeof projectValues.preferredModel === 'string'
                            ? projectValues.preferredModel
                            : ''
                        }
                        onChange={(event) =>
                          setProjectValues({ ...projectValues, preferredModel: event.target.value })
                        }
                      />
                    </Field>
                    <Field label="Default environment">
                      <Input
                        id="project-environment"
                        value={
                          typeof projectValues.environment === 'string'
                            ? projectValues.environment
                            : ''
                        }
                        onChange={(event) =>
                          setProjectValues({ ...projectValues, environment: event.target.value })
                        }
                      />
                    </Field>
                    <Field label="Run objective defaults">
                      <Textarea
                        id="project-run-objective"
                        value={
                          typeof projectValues.runObjective === 'string'
                            ? projectValues.runObjective
                            : ''
                        }
                        onChange={(event) =>
                          setProjectValues({ ...projectValues, runObjective: event.target.value })
                        }
                      />
                    </Field>
                  </div>
                  <Button loading={busy} onClick={() => void saveProjectSettings()}>
                    Save project settings
                  </Button>
                </Card>
              )}

              {tab.startsWith('organization-') && (
                <Card>
                  <h3>{activeTab.label}</h3>
                  <p className="settings-copy">
                    Organization controls are visible only when the trusted workspace context
                    includes an organization. Personal-local workspaces do not show policy blocks or
                    approval queues here.
                  </p>
                  <div className="settings-action-row">
                    <Button
                      variant="secondary"
                      onClick={() =>
                        navigate(
                          activeTab.id === 'organization-approvals'
                            ? '/approvals'
                            : activeTab.id === 'organization-audit'
                              ? '/audit'
                              : '/governance',
                        )
                      }
                    >
                      Open organization surface
                    </Button>
                  </div>
                </Card>
              )}

              <div className="settings-save-bar">
                <span>Settings are scoped to {activeTab.group.toLowerCase()}.</span>
                <Button variant="tertiary" onClick={() => void runtime.refresh()}>
                  Refresh
                </Button>
              </div>
            </section>
          </div>
        </div>
      </div>
    </CapabilityGate>
  );
}
