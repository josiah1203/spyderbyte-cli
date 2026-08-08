import { useEffect, useState, type ReactElement } from 'react';
import {
  BrowserRouter,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useOutletContext,
  useParams,
} from 'react-router-dom';
import { RuntimeProvider } from './runtime/RuntimeProvider';
import { ThemeProvider } from './contexts/ThemeContext';
import Layout from './components/Layout';
import type { Page } from './data/profiles';
import {
  loadLayoutPreferences,
  parseLayoutPreferences,
  saveLayoutPreferences,
  type LayoutPreferences,
} from './data/layout';

import Home from './screens/Home';
import Projects from './screens/Projects';
import ProjectDetail from './screens/ProjectDetail';
import Runs from './screens/Runs';
import RunDetail from './screens/RunDetail';
import Assets from './screens/Assets';
import Connections from './screens/Connections';
import Machine from './screens/Machine';
import License from './screens/License';
import Settings from './screens/Settings';
import Visualizations from './screens/Visualizations';
import Media from './screens/Media';
import Automations from './screens/Automations';
import Data from './screens/Data';
import SQL from './screens/SQL';
import Notebooks from './screens/Notebooks';
import Models from './screens/Models';
import Deployments from './screens/Deployments';
import Environments from './screens/Environments';
import Approvals from './screens/Approvals';
import Governance from './screens/Governance';
import Usage from './screens/Usage';
import Audit from './screens/Audit';
import Incidents from './screens/Incidents';
import Catalog from './screens/Catalog';
import Repositories from './screens/Repositories';
import Experiments from './screens/Experiments';
import Pipelines from './screens/Pipelines';
import Resources from './screens/Resources';
import ResourcePage from './screens/ResourcePage';
import { RESOURCE_PAGE_CONFIGS } from './screens/resource-configs';
import type { RuntimeStore } from './runtime/store';
import CapabilityGate from './components/CapabilityGate';
import Onboarding from './screens/Onboarding';
import { useRuntime } from './runtime/RuntimeProvider';
import { useTheme } from './contexts/ThemeContext';

interface FrameContext {
  layoutPreferences: LayoutPreferences;
  onLayoutChange: (next: LayoutPreferences) => void;
  onNavigate: (page: Page) => void;
  onSelectProject: (id: string) => void;
  onSelectRun: (id: string) => void;
}

function useFrame(): FrameContext {
  return useOutletContext<FrameContext>();
}

function pageForPath(pathname: string): Page {
  if (pathname.startsWith('/projects/') && pathname.includes('/runs/')) return 'run-detail';
  if (pathname.startsWith('/projects/')) return 'project-detail';
  if (pathname.startsWith('/runs/')) return 'run-detail';
  if (pathname.startsWith('/settings/')) return 'settings';
  const segment = pathname.split('/').filter(Boolean)[0] as Page | undefined;
  return segment ?? 'home';
}

function routeForPage(page: Page): string {
  if (page === 'home') return '/';
  if (page === 'project-detail') return '/projects';
  if (page === 'run-detail') return '/runs';
  if (page === 'settings') return '/settings/workspace/general';
  return `/${page}`;
}

function applyAccessibilityPreferences(values: Record<string, unknown>): void {
  const root = document.documentElement;
  for (const [key, attribute] of [
    ['reducedMotion', 'data-reduced-motion'],
    ['highContrast', 'data-high-contrast'],
    ['largerText', 'data-larger-text'],
  ] as const) {
    if (values[key] === true) root.setAttribute(attribute, 'true');
    else root.removeAttribute(attribute);
  }
}

function AppFrame(): ReactElement {
  const navigate = useNavigate();
  const location = useLocation();
  const runtime = useRuntime();
  const { setTheme } = useTheme();
  const [layoutPreferences, setLayoutPreferences] = useState<LayoutPreferences>(() =>
    loadLayoutPreferences(),
  );
  const [defaultLandingApplied, setDefaultLandingApplied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!runtime.client.get) return () => undefined;
    void runtime.client
      .get<{ revision?: number; values?: Record<string, unknown> }>('/v1/settings?scope=user')
      .then((envelope) => {
        if (cancelled) return;
        const persistedLayout = parseLayoutPreferences(envelope.values?.layout);
        if (persistedLayout !== undefined) setLayoutPreferences(persistedLayout);
        applyAccessibilityPreferences(envelope.values ?? {});
        if (typeof envelope.values?.showStatusText === 'boolean') {
          setLayoutPreferences((current) => ({
            ...current,
            showStatusText: envelope.values?.showStatusText as boolean,
          }));
        }
        const appearance = envelope.values?.appearance;
        if (
          appearance !== null &&
          typeof appearance === 'object' &&
          !Array.isArray(appearance) &&
          (appearance as Record<string, unknown>).theme !== undefined
        ) {
          const theme = (appearance as Record<string, unknown>).theme;
          if (theme === 'dark' || theme === 'light' || theme === 'system') setTheme(theme);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [runtime, setTheme]);

  useEffect(() => {
    saveLayoutPreferences(layoutPreferences);
  }, [layoutPreferences]);

  useEffect(() => {
    if (
      defaultLandingApplied ||
      location.pathname !== '/' ||
      layoutPreferences.defaultLandingPage === 'home'
    ) {
      return;
    }
    setDefaultLandingApplied(true);
    navigate(routeForPage(layoutPreferences.defaultLandingPage), { replace: true });
  }, [defaultLandingApplied, layoutPreferences.defaultLandingPage, location.pathname, navigate]);

  const onLayoutChange = (next: LayoutPreferences): void => {
    setLayoutPreferences(next);
  };

  const onNavigate = (page: Page): void => {
    navigate(routeForPage(page));
  };
  const onSelectProject = (id: string): void => {
    navigate(`/projects/${id}`);
  };
  const onSelectRun = (id: string): void => {
    navigate(`/runs/${id}`);
  };
  const onOpenSettings = (tab = 'general'): void => {
    navigate(`/settings/workspace/${tab}`);
  };
  const page = pageForPath(location.pathname);

  return (
    <Layout
      page={page}
      sidebarOpen={!layoutPreferences.sidebarCollapsed}
      onToggleSidebar={() =>
        onLayoutChange({
          ...layoutPreferences,
          sidebarCollapsed: !layoutPreferences.sidebarCollapsed,
        })
      }
      onNavigate={onNavigate}
      layoutPreferences={layoutPreferences}
      onLayoutChange={onLayoutChange}
      onOpenSettings={onOpenSettings}
    >
      <Outlet
        context={{ layoutPreferences, onLayoutChange, onNavigate, onSelectProject, onSelectRun }}
      />
    </Layout>
  );
}

function HomeRoute(): ReactElement {
  const { layoutPreferences, onNavigate, onSelectProject, onSelectRun } = useFrame();
  const runtime = useRuntime();
  const navigate = useNavigate();
  const [profileChecked, setProfileChecked] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (!runtime.client.get) {
      setProfileChecked(true);
      return () => undefined;
    }
    void runtime.client
      .get<{ profile?: { displayName?: string; onboardingComplete?: boolean } }>('/v1/profile')
      .then((result) => {
        if (cancelled) return;
        if (!result.profile?.displayName || result.profile.onboardingComplete !== true) {
          navigate('/onboarding', { replace: true });
          return;
        }
        setProfileChecked(true);
      })
      .catch(() => {
        if (!cancelled) setProfileChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [navigate, runtime]);
  if (!profileChecked) return <div className="page-loading">Preparing your workspace…</div>;
  return (
    <Home
      layoutPreferences={layoutPreferences}
      onNavigate={onNavigate}
      onSelectProject={onSelectProject}
      onSelectRun={onSelectRun}
    />
  );
}

function OnboardingRoute(): ReactElement {
  const { layoutPreferences, onLayoutChange } = useFrame();
  return <Onboarding layoutPreferences={layoutPreferences} onLayoutChange={onLayoutChange} />;
}

function ProjectsRoute(): ReactElement {
  const { onSelectProject } = useFrame();
  return <Projects onSelectProject={onSelectProject} />;
}

function ProjectDetailRoute(): ReactElement {
  const { projectId } = useParams();
  const { onNavigate, onSelectRun } = useFrame();
  const navigate = useNavigate();
  return (
    <ProjectDetail
      projectId={projectId ?? ''}
      onBack={() => navigate('/projects')}
      onSelectRun={onSelectRun}
      onNavigate={onNavigate}
    />
  );
}

function RunsRoute(): ReactElement {
  const { onSelectRun } = useFrame();
  return <Runs onSelectRun={onSelectRun} />;
}

function RunDetailRoute(): ReactElement {
  const { runId } = useParams();
  const navigate = useNavigate();
  return (
    <RunDetail
      runId={runId ?? ''}
      onBack={() => navigate('/runs')}
      onSelectProject={(id) => navigate(`/projects/${id}`)}
    />
  );
}

function SettingsRoute(): ReactElement {
  const { layoutPreferences, onLayoutChange } = useFrame();
  const { section } = useParams();
  return (
    <Settings
      layoutPreferences={layoutPreferences}
      onLayoutChange={onLayoutChange}
      initialTab={section ?? 'general'}
    />
  );
}

function ProfileScreen({
  children,
}: {
  children: (context: FrameContext) => ReactElement;
}): ReactElement {
  return children(useFrame());
}

export default function App({
  runtimeStore,
}: {
  runtimeStore?: RuntimeStore;
} = {}): ReactElement {
  return (
    <ThemeProvider>
      <RuntimeProvider store={runtimeStore}>
        <BrowserRouter>
          <Routes>
            <Route element={<AppFrame />}>
              <Route index element={<HomeRoute />} />
              <Route path="onboarding" element={<OnboardingRoute />} />
              <Route
                path="projects"
                element={
                  <CapabilityGate page="projects">
                    <ProjectsRoute />
                  </CapabilityGate>
                }
              />
              <Route
                path="projects/:projectId"
                element={
                  <CapabilityGate page="project-detail">
                    <ProjectDetailRoute />
                  </CapabilityGate>
                }
              />
              <Route
                path="projects/:projectId/runs/:runId"
                element={
                  <CapabilityGate page="run-detail">
                    <RunDetailRoute />
                  </CapabilityGate>
                }
              />
              <Route
                path="runs"
                element={
                  <CapabilityGate page="runs">
                    <RunsRoute />
                  </CapabilityGate>
                }
              />
              <Route
                path="runs/:runId"
                element={
                  <CapabilityGate page="run-detail">
                    <RunDetailRoute />
                  </CapabilityGate>
                }
              />
              <Route
                path="assets"
                element={
                  <CapabilityGate page="assets">
                    <Assets />
                  </CapabilityGate>
                }
              />
              <Route path="connections" element={<Connections />} />
              <Route
                path="machine"
                element={
                  <CapabilityGate page="machine">
                    <Machine />
                  </CapabilityGate>
                }
              />
              <Route
                path="license"
                element={
                  <CapabilityGate page="license">
                    <License />
                  </CapabilityGate>
                }
              />
              <Route path="settings/:scope/:section" element={<SettingsRoute />} />
              <Route
                path="settings"
                element={<Navigate to="/settings/workspace/workspace" replace />}
              />
              <Route
                path="visualizations"
                element={
                  <CapabilityGate page="visualizations">
                    <ProfileScreen>{() => <Visualizations />}</ProfileScreen>
                  </CapabilityGate>
                }
              />
              <Route
                path="media"
                element={
                  <CapabilityGate page="media">
                    <ProfileScreen>{() => <Media />}</ProfileScreen>
                  </CapabilityGate>
                }
              />
              <Route
                path="automations"
                element={
                  <CapabilityGate page="automations">
                    <ProfileScreen>{() => <Automations />}</ProfileScreen>
                  </CapabilityGate>
                }
              />
              <Route
                path="data"
                element={
                  <CapabilityGate page="data">
                    <ProfileScreen>{() => <Data />}</ProfileScreen>
                  </CapabilityGate>
                }
              />
              <Route
                path="sql"
                element={
                  <CapabilityGate page="sql">
                    <SQL />
                  </CapabilityGate>
                }
              />
              <Route
                path="notebooks"
                element={
                  <CapabilityGate page="notebooks">
                    <Notebooks />
                  </CapabilityGate>
                }
              />
              <Route path="code" element={<Navigate to="/repositories" replace />} />
              <Route
                path="models"
                element={
                  <CapabilityGate page="models">
                    <Models />
                  </CapabilityGate>
                }
              />
              <Route path="deployments" element={<Deployments />} />
              <Route
                path="environments"
                element={
                  <CapabilityGate page="environments">
                    <Environments />
                  </CapabilityGate>
                }
              />
              <Route
                path="approvals"
                element={
                  <CapabilityGate page="approvals">
                    <Approvals />
                  </CapabilityGate>
                }
              />
              <Route
                path="governance"
                element={
                  <CapabilityGate page="governance">
                    <Governance />
                  </CapabilityGate>
                }
              />
              <Route
                path="usage"
                element={
                  <CapabilityGate page="usage">
                    <Usage />
                  </CapabilityGate>
                }
              />
              <Route
                path="audit"
                element={
                  <CapabilityGate page="audit">
                    <Audit />
                  </CapabilityGate>
                }
              />
              <Route
                path="incidents"
                element={
                  <CapabilityGate page="incidents">
                    <Incidents />
                  </CapabilityGate>
                }
              />
              <Route
                path="catalog"
                element={
                  <CapabilityGate page="catalog">
                    <Catalog />
                  </CapabilityGate>
                }
              />
              <Route
                path="repositories"
                element={
                  <CapabilityGate page="repositories">
                    <Repositories />
                  </CapabilityGate>
                }
              />
              <Route
                path="experiments"
                element={
                  <CapabilityGate page="experiments">
                    <Experiments />
                  </CapabilityGate>
                }
              />
              <Route
                path="pipelines"
                element={
                  <CapabilityGate page="pipelines">
                    <Pipelines />
                  </CapabilityGate>
                }
              />
              <Route
                path="resources"
                element={
                  <CapabilityGate page="resources">
                    <Resources />
                  </CapabilityGate>
                }
              />
              <Route
                path="worktrees"
                element={
                  <CapabilityGate page="worktrees">
                    <ResourcePage config={RESOURCE_PAGE_CONFIGS.worktrees} />
                  </CapabilityGate>
                }
              />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </RuntimeProvider>
    </ThemeProvider>
  );
}
