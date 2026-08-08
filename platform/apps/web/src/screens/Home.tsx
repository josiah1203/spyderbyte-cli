import { useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Divider,
  EmptyState,
  ProgressBar,
  SectionLabel,
  StatusDot,
} from '../components/primitives';
import Icon from '../components/icons';
import PushToTalkButton from '../components/PushToTalkButton';
import RuntimeStateNotice from '../components/RuntimeStateNotice';
import type { LayoutPreferences } from '../data/layout';
import type { Page } from '../data/profiles';
import { isPersonalLocalWorkspace } from '../runtime/page-registry';
import { useRuntime } from '../runtime/RuntimeProvider';
import { useMachine, useProjection, useProjects, useRuns, useRuntimeStore } from '../runtime/store';

const STATUS_COLOR: Record<string, 'green' | 'amber' | 'red' | 'gray' | 'blue'> = {
  active: 'green',
  running: 'blue',
  completed: 'green',
  succeeded: 'green',
  failed: 'red',
  cancelled: 'gray',
  awaiting_approval: 'amber',
  Completed: 'green',
  Running: 'blue',
  Failed: 'red',
  Idle: 'gray',
  Paused: 'amber',
};

interface HomeProps {
  layoutPreferences: LayoutPreferences;
  onNavigate: (page: Page) => void;
  onSelectProject: (id: string) => void;
  onSelectRun: (id: string) => void;
}

export default function Home({
  layoutPreferences,
  onNavigate,
  onSelectProject,
  onSelectRun,
}: HomeProps) {
  const [objective, setObjective] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string>();
  const runtime = useRuntime();
  const snapshot = useRuntimeStore(runtime);
  const showWidget = (widget: LayoutPreferences['homeWidgets'][number]): boolean =>
    layoutPreferences.homeWidgets.includes(widget);
  const personalLocal = isPersonalLocalWorkspace(snapshot.capabilities);
  const showApprovalSurface =
    !personalLocal && snapshot.capabilities?.capabilities?.['approval-queue']?.enabled !== false;
  const { data: projects, state: projectState } = useProjects(runtime);
  const { data: runs, state: runState } = useRuns(runtime);
  const { data: machineData, state: machineState } = useMachine(runtime);
  const { data: approvalProjection, state: approvalState } = useProjection<unknown>(
    runtime,
    'approval-queue',
  );
  const { data: deploymentProjection, state: deploymentState } = useProjection<unknown>(
    runtime,
    'deployment-traffic',
  );
  const latestMachine =
    machineData?.observations &&
    typeof machineData.observations === 'object' &&
    !Array.isArray(machineData.observations)
      ? (machineData.observations as Record<string, unknown>).latest
      : undefined;
  const machineRecord =
    latestMachine !== null && typeof latestMachine === 'object' && !Array.isArray(latestMachine)
      ? (latestMachine as Record<string, unknown>)
      : {};
  const machineValue = (key: string): number | null =>
    typeof machineRecord[key] === 'number' ? Math.round(machineRecord[key] as number) : null;
  const machineStats: Array<[string, number | null]> = [
    ['CPU', machineValue('cpuPercent')],
    ['Memory', machineValue('memoryPercent')],
    ['Storage', machineValue('storagePercent')],
  ];
  const gpuActive = machineRecord.gpuActive === true;
  const approvalQueue =
    approvalProjection !== null &&
    typeof approvalProjection === 'object' &&
    !Array.isArray(approvalProjection) &&
    'queue' in approvalProjection &&
    approvalProjection.queue !== null &&
    typeof approvalProjection.queue === 'object' &&
    !Array.isArray(approvalProjection.queue)
      ? Object.values(approvalProjection.queue as Record<string, unknown>)
      : [];
  const pendingApprovals = approvalQueue.filter((candidate) => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate))
      return false;
    return (candidate as Record<string, unknown>).state === 'pending';
  });
  const deploymentRecords =
    deploymentProjection !== null &&
    typeof deploymentProjection === 'object' &&
    !Array.isArray(deploymentProjection) &&
    'deployments' in deploymentProjection &&
    deploymentProjection.deployments !== null &&
    typeof deploymentProjection.deployments === 'object' &&
    !Array.isArray(deploymentProjection.deployments)
      ? Object.values(deploymentProjection.deployments as Record<string, unknown>)
      : [];
  const activeDeployments = deploymentRecords.filter((candidate) => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate))
      return false;
    return ['active', 'running', 'ready'].includes(
      String((candidate as Record<string, unknown>).status ?? '').toLowerCase(),
    );
  });
  const projectRows = projects.map((project) => ({
    id: project.projectId,
    name: project.name,
    objective: project.objective ?? 'No objective recorded',
    status: project.status ?? 'unknown',
  }));
  const runRows = runs.map((run) => ({
    id: run.runId,
    name: run.name ?? run.runId,
    projectName: run.projectId ?? 'Unassigned',
    status: run.status,
    duration: run.updatedAt ? new Date(run.updatedAt).toLocaleTimeString() : '—',
  }));
  const activity = [
    ...projects.map((project) => ({
      text: `Project updated · ${project.name}`,
      time: project.updatedAt ?? '—',
    })),
    ...runs.map((run) => ({
      text: `Run state · ${run.name ?? run.runId} · ${run.status}`,
      time: run.updatedAt ?? '—',
    })),
  ].slice(0, 4);

  async function createProjectFromObjective(): Promise<void> {
    const value = objective.trim();
    if (!value) {
      setCreateError('Describe a project objective before starting.');
      return;
    }
    setCreating(true);
    setCreateError(undefined);
    try {
      const acknowledgement = await runtime.command({
        commandType: 'CreateProject',
        payload: { name: value.slice(0, 80), objective: value },
      });
      await runtime.refresh(['projects']);
      const result = acknowledgement.result;
      const projectId =
        result !== null &&
        typeof result === 'object' &&
        !Array.isArray(result) &&
        typeof result.projectId === 'string'
          ? result.projectId
          : undefined;
      if (projectId) onSelectProject(projectId);
      else onNavigate('projects');
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreating(false);
    }
  }

  function handleQuickAction(action: string): void {
    const destinations: Record<string, Page> = {
      'New Project': 'projects',
      'Explore Data': 'data',
      'New Notebook': 'notebooks',
      'New Pipeline': 'pipelines',
      'Deploy Model': 'deployments',
      'Review Approvals': 'approvals',
      'View Environments': 'environments',
      'Check Deployments': 'deployments',
      'View Runs': 'runs',
      'Connect a provider': 'connections',
    };
    onNavigate(destinations[action] ?? 'projects');
  }

  const quickActions = ['New Project', 'Explore Data', 'View Runs', 'Connect a provider'];
  const isUnavailable = (state: string) => state === 'unavailable' || state === 'error';

  return (
    <div className="page-scroll">
      <div className="page page-grid page-grid-two home-layout">
        <div className="home-main stack">
          <RuntimeStateNotice state={snapshot.connection} onRetry={() => void runtime.retry()} />
          {showWidget('welcome') && (
            <Card>
              <div className="home-card-title">What would you like to do today?</div>
              <div className="home-objective-row">
                <input
                  className="ds-input"
                  aria-label="Project objective"
                  placeholder="Describe a project objective…"
                  value={objective}
                  onChange={(event) => setObjective(event.target.value)}
                />
                <PushToTalkButton
                  onText={(text) =>
                    setObjective((value) => `${value}${value.trim() ? ' ' : ''}${text}`)
                  }
                />
                <Button loading={creating} onClick={() => void createProjectFromObjective()}>
                  Create project
                </Button>
              </div>
              {createError && (
                <div className="home-error" role="alert">
                  {createError}
                </div>
              )}
            </Card>
          )}

          {showWidget('recent-work') && (
            <>
              <section className="home-section">
                <div className="home-section-header">
                  <SectionLabel>Continue Working</SectionLabel>
                  <button
                    className="text-action"
                    type="button"
                    onClick={() => onNavigate('projects')}
                  >
                    All projects{' '}
                    <Icon name="arrow-right" size={14} tone="secondary" aria-hidden="true" />
                  </button>
                </div>
                <Card className="home-list-card">
                  {projectState === 'booting' || isUnavailable(projectState) ? (
                    <div className="home-state">
                      {projectState === 'booting'
                        ? 'Loading projects…'
                        : 'Projects are unavailable until the platform reconnects.'}
                    </div>
                  ) : projectRows.length === 0 ? (
                    <EmptyState
                      icon="projects"
                      title="No projects yet"
                      description="Create a project objective to start a workflow."
                      action={<Button onClick={() => onNavigate('projects')}>Open projects</Button>}
                    />
                  ) : (
                    projectRows.slice(0, 3).map((project) => (
                      <button
                        className="home-list-button"
                        key={project.id}
                        type="button"
                        onClick={() => onSelectProject(project.id)}
                      >
                        <span className="home-list-copy">
                          <span className="home-list-title">
                            <StatusDot color={STATUS_COLOR[project.status] ?? 'gray'} />
                            {project.name}
                            <Badge color={STATUS_COLOR[project.status] ?? 'gray'}>
                              {project.status}
                            </Badge>
                          </span>
                          <span className="home-list-subtitle">{project.objective}</span>
                        </span>
                        <span className="home-list-open">
                          Open{' '}
                          <Icon name="arrow-right" size={14} tone="secondary" aria-hidden="true" />
                        </span>
                      </button>
                    ))
                  )}
                </Card>
              </section>

              <section className="home-section">
                <div className="home-section-header">
                  <SectionLabel>Recent Runs</SectionLabel>
                  <button className="text-action" type="button" onClick={() => onNavigate('runs')}>
                    All runs{' '}
                    <Icon name="arrow-right" size={14} tone="secondary" aria-hidden="true" />
                  </button>
                </div>
                <Card className="home-list-card">
                  {runState === 'booting' || isUnavailable(runState) ? (
                    <div className="home-state">
                      {runState === 'booting'
                        ? 'Loading live runs…'
                        : 'Runs are unavailable until the platform reconnects.'}
                    </div>
                  ) : runRows.length === 0 ? (
                    <EmptyState
                      icon="play"
                      title="No runs yet"
                      description="Runs will appear here when a project starts executing."
                      action={<Button onClick={() => onNavigate('projects')}>Open projects</Button>}
                    />
                  ) : (
                    runRows.slice(0, 4).map((run) => (
                      <button
                        className="home-list-button"
                        key={run.id}
                        type="button"
                        onClick={() => onSelectRun(run.id)}
                      >
                        <span className="home-list-copy">
                          <span className="home-list-title">
                            <StatusDot color={STATUS_COLOR[run.status] ?? 'gray'} />
                            {run.name}
                            <Badge color={STATUS_COLOR[run.status] ?? 'gray'}>{run.status}</Badge>
                          </span>
                          <span className="home-list-subtitle">
                            {run.projectName} · {run.duration}
                          </span>
                        </span>
                        <span className="home-list-open">
                          View{' '}
                          <Icon name="arrow-right" size={14} tone="secondary" aria-hidden="true" />
                        </span>
                      </button>
                    ))
                  )}
                </Card>
              </section>
            </>
          )}

          {showWidget('safety') && showApprovalSurface && (
            <section className="home-section">
              <div className="home-section-header">
                <SectionLabel>Pending Approvals</SectionLabel>
                <button
                  className="text-action"
                  type="button"
                  onClick={() => onNavigate('approvals')}
                >
                  Review all{' '}
                  <Icon name="arrow-right" size={14} tone="secondary" aria-hidden="true" />
                </button>
              </div>
              {approvalState === 'booting' ? (
                <div className="home-state">Loading pending approvals…</div>
              ) : approvalState === 'unavailable' || approvalState === 'error' ? (
                <div className="home-state">Approval data is unavailable from the platform.</div>
              ) : pendingApprovals.length === 0 ? (
                <div className="home-notice">
                  <div className="home-notice-title">
                    <StatusDot color="green" />
                    No pending approvals
                  </div>
                  <p>
                    Organization policy requests appear here when a workflow needs human authority.
                  </p>
                  <Button variant="secondary" onClick={() => onNavigate('approvals')}>
                    Open approvals
                  </Button>
                </div>
              ) : (
                <div className="home-notice">
                  <div className="home-notice-title">
                    <StatusDot color="amber" />
                    {pendingApprovals.length} approval
                    {pendingApprovals.length === 1 ? '' : 's'} awaiting review
                  </div>
                  <p>Review authority, resource, and policy context before execution.</p>
                  <Button variant="secondary" onClick={() => onNavigate('approvals')}>
                    Review approvals
                  </Button>
                </div>
              )}
            </section>
          )}

          {showWidget('quick-actions') && (
            <section className="home-section">
              <SectionLabel>Start with a workflow</SectionLabel>
              <div className="home-template-grid">
                {quickActions.map((action) => (
                  <button
                    className="home-template-card"
                    key={action}
                    type="button"
                    onClick={() => handleQuickAction(action)}
                  >
                    <div className="home-template-title">{action}</div>
                    <div className="home-template-subtitle">
                      Open the connected workspace workflow.
                    </div>
                    <div className="home-template-badges">
                      <Badge color="gray">Platform workflow</Badge>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>

        <aside className="home-aside stack">
          {showWidget('compute') && (
            <Card>
              <SectionLabel>Compute</SectionLabel>
              <div className="home-card-subtitle">Execution resources reported by the platform</div>
              {machineStats.map(([label, value]) => (
                <div className="home-stat" key={label}>
                  <div className="home-stat-header">
                    <span>{label}</span>
                    <strong>{value === null ? 'Unavailable' : `${value}%`}</strong>
                  </div>
                  {value === null ? (
                    <span className="home-stat-unavailable">No sensor observation</span>
                  ) : (
                    <ProgressBar value={value} tone="info" />
                  )}
                </div>
              ))}
              {showWidget('deployments') && (
                <>
                  <Divider />
                  <div className="home-card-subtitle">
                    Active deployments:{' '}
                    {deploymentState === 'booting'
                      ? 'Loading'
                      : deploymentState === 'unavailable' || deploymentState === 'error'
                        ? 'Unavailable'
                        : activeDeployments.length}
                  </div>
                  <div className="home-runtime-state">
                    <StatusDot color={gpuActive ? 'green' : 'gray'} />
                    GPU:{' '}
                    {machineState === 'booting' ? 'Loading' : gpuActive ? 'Active' : 'Unavailable'}
                  </div>
                </>
              )}
              <Button
                variant="secondary"
                className="home-full-button"
                onClick={() => onNavigate('machine')}
              >
                View details <Icon name="arrow-right" size={14} aria-hidden="true" />
              </Button>
            </Card>
          )}

          {showWidget('license') && (
            <Card>
              <SectionLabel>License</SectionLabel>
              <div className="home-license-row">
                <span>{snapshot.license?.status ?? 'Unavailable'}</span>
                <Badge color={snapshot.license?.status === 'valid' ? 'green' : 'gray'}>
                  {snapshot.license?.status ?? 'Unavailable'}
                </Badge>
              </div>
              <div className="home-card-subtitle">
                {snapshot.license?.reason ?? 'License status is supplied by the platform service.'}
              </div>
            </Card>
          )}

          {showWidget('activity') && (
            <Card>
              <SectionLabel>Activity</SectionLabel>
              {activity.length === 0 ? (
                <div className="home-card-subtitle">No recent activity.</div>
              ) : (
                activity.map((item, index) => (
                  <div className="home-activity" key={`${item.text}-${index}`}>
                    <div>{item.text}</div>
                    <small>{item.time}</small>
                  </div>
                ))
              )}
            </Card>
          )}
        </aside>
      </div>
    </div>
  );
}
