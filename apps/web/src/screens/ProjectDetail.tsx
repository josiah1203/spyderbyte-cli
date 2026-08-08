import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  Input,
  Notice,
  ProgressBar,
  SectionLabel,
  StatusDot,
  Tabs,
  Textarea,
} from '../components/primitives';
import PushToTalkButton from '../components/PushToTalkButton';
import Icon from '../components/icons';
import RuntimeStateNotice from '../components/RuntimeStateNotice';
import type { Page } from '../data/profiles';
import { newRuntimeId } from '../runtime/client';
import { useRuntime } from '../runtime/RuntimeProvider';
import { useProject, useRunTimeline, useRuns, useRuntimeStore } from '../runtime/store';

type LeftTab = 'Conversation' | 'Plan' | 'Activity';
type RightTab = 'Report' | 'Dataset' | 'Code' | 'Configuration' | 'Logs';

interface PlanStep {
  stepId: string;
  title?: string;
  description?: string;
  tier: number;
  agentType?: string;
  dependsOn: string[];
  requiredCapabilities: string[];
  approvalRequired: boolean;
  expectedOutputs?: string[];
  acceptanceCriteria: string[];
}

interface WorkflowPlan {
  workflowId: string;
  version: number;
  steps: PlanStep[];
  createdAt?: string;
}

interface WorkflowInvocation {
  value?: {
    state?: string;
    planStepId?: string;
  };
  state?: string;
  planStepId?: string;
}

interface ConversationMessage {
  messageId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  state: 'streaming' | 'completed' | 'failed' | 'cancelled';
  text: string;
  createdAt: string;
  toolName?: string;
  toolOperation?: string;
}

interface ConversationSnapshot {
  conversationId: string;
  projectId: string;
  messages: ConversationMessage[];
  generating: boolean;
  updatedAt: string;
}

interface ArtifactReferenceView {
  artifactId: string;
  version: number;
  mediaType?: string;
  contentHash?: string;
}

interface DatasetApprovalView {
  approvalId: string;
  state: string;
}

interface DatasetPlanReview {
  workflowId: string;
  planVersion: number;
  plan: WorkflowPlan;
  sourceArtifact: ArtifactReferenceView;
  approval?: DatasetApprovalView;
}

interface DatasetWorkflowResult {
  workflowId: string;
  status: string;
  sourceArtifact?: ArtifactReferenceView;
  governanceDecisionArtifact?: ArtifactReferenceView;
  dataQualityReportArtifact?: ArtifactReferenceView;
  validatedDatasetArtifact?: ArtifactReferenceView;
  reasonCodes: string[];
}

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s elapsed` : `${seconds}s elapsed`;
}

function eventPayload(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function invocationState(invocation: WorkflowInvocation | undefined): string | undefined {
  if (!invocation) return undefined;
  return invocation.value?.state ?? invocation.state;
}

function artifactReference(value: unknown): ArtifactReferenceView | undefined {
  const item = eventPayload(value);
  if (typeof item.artifactId !== 'string' || typeof item.version !== 'number') return undefined;
  return {
    artifactId: item.artifactId,
    version: item.version,
    ...(typeof item.mediaType === 'string' ? { mediaType: item.mediaType } : {}),
    ...(typeof item.contentHash === 'string' ? { contentHash: item.contentHash } : {}),
  };
}

function normalizedPlan(value: unknown): WorkflowPlan | undefined {
  const root = eventPayload(value);
  const nestedPlan = eventPayload(root.plan);
  const plan = Object.keys(nestedPlan).length > 0 ? nestedPlan : root;
  const workflowId =
    typeof root.workflowId === 'string'
      ? root.workflowId
      : typeof plan.workflowId === 'string'
        ? plan.workflowId
        : undefined;
  const version =
    typeof plan.version === 'number'
      ? plan.version
      : typeof root.planVersion === 'number'
        ? root.planVersion
        : undefined;
  if (workflowId === undefined || version === undefined || !Array.isArray(plan.steps)) {
    return undefined;
  }
  const steps = plan.steps.flatMap((candidate, index): PlanStep[] => {
    const step = eventPayload(candidate);
    if (typeof step.stepId !== 'string') return [];
    const strings = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    return [
      {
        stepId: step.stepId,
        ...(typeof step.title === 'string' ? { title: step.title } : {}),
        ...(typeof step.description === 'string' ? { description: step.description } : {}),
        tier: typeof step.tier === 'number' ? step.tier : index + 1,
        ...(typeof step.agentType === 'string' ? { agentType: step.agentType } : {}),
        dependsOn: strings(step.dependsOn),
        requiredCapabilities: strings(step.requiredCapabilities),
        approvalRequired: step.approvalRequired === true,
        ...(strings(step.expectedOutputs).length > 0
          ? { expectedOutputs: strings(step.expectedOutputs) }
          : {}),
        acceptanceCriteria: strings(step.acceptanceCriteria),
      },
    ];
  });
  return {
    workflowId,
    version,
    steps,
    ...(typeof plan.createdAt === 'string' ? { createdAt: plan.createdAt } : {}),
  };
}

function datasetPlanFromAcknowledgement(value: unknown): DatasetPlanReview | undefined {
  const root = eventPayload(value);
  const plan = normalizedPlan(root);
  const sourceArtifact = artifactReference(root.sourceArtifact);
  if (plan === undefined || typeof root.workflowId !== 'string' || sourceArtifact === undefined) {
    return undefined;
  }
  const approval = eventPayload(root.approval);
  return {
    workflowId: root.workflowId,
    planVersion: typeof root.planVersion === 'number' ? root.planVersion : plan.version,
    plan,
    sourceArtifact,
    ...(typeof approval.approvalId === 'string' && typeof approval.state === 'string'
      ? { approval: { approvalId: approval.approvalId, state: approval.state } }
      : {}),
  };
}

function datasetResultFromResponse(value: unknown): DatasetWorkflowResult | undefined {
  const root = eventPayload(value);
  if (typeof root.workflowId !== 'string' || typeof root.status !== 'string') return undefined;
  const reasons = Array.isArray(root.reasonCodes)
    ? root.reasonCodes.filter((item): item is string => typeof item === 'string')
    : [];
  return {
    workflowId: root.workflowId,
    status: root.status,
    ...(artifactReference(root.sourceArtifact) === undefined
      ? {}
      : { sourceArtifact: artifactReference(root.sourceArtifact) }),
    ...(artifactReference(root.governanceDecisionArtifact) === undefined
      ? {}
      : { governanceDecisionArtifact: artifactReference(root.governanceDecisionArtifact) }),
    ...(artifactReference(root.dataQualityReportArtifact) === undefined
      ? {}
      : { dataQualityReportArtifact: artifactReference(root.dataQualityReportArtifact) }),
    ...(artifactReference(root.validatedDatasetArtifact) === undefined
      ? {}
      : { validatedDatasetArtifact: artifactReference(root.validatedDatasetArtifact) }),
    reasonCodes: reasons,
  };
}

function artifactLabel(reference: ArtifactReferenceView): string {
  return `${reference.artifactId} · v${reference.version}${reference.mediaType ? ` · ${reference.mediaType}` : ''}`;
}

async function readTextFile(file: File): Promise<string> {
  const candidate = file as File & {
    text?: () => Promise<string>;
    arrayBuffer?: () => Promise<ArrayBuffer>;
  };
  if (typeof candidate.text === 'function') return candidate.text();
  if (typeof candidate.arrayBuffer === 'function') {
    return new TextDecoder().decode(await candidate.arrayBuffer());
  }
  if (typeof FileReader === 'undefined')
    throw new Error('This runtime cannot read the selected file.');
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(reader.error ?? new Error('The selected file could not be read.'));
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsText(file);
  });
}

interface ProjectDetailProps {
  projectId: string;
  onBack: () => void;
  onSelectRun: (id: string) => void;
  onNavigate: (page: Page) => void;
}

export default function ProjectDetail({
  projectId,
  onBack,
  onSelectRun,
  onNavigate,
}: ProjectDetailProps) {
  const runtime = useRuntime();
  const runtimeSnapshot = useRuntimeStore(runtime);
  const { data: projectData, state } = useProject(runtime, projectId);
  const { data: runs } = useRuns(runtime, { projectId });
  const selectedRun =
    runs.find((run) => ['running', 'executing', 'awaiting_approval'].includes(run.status)) ??
    [...runs].sort((left, right) =>
      String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')),
    )[0];
  const { data: timeline } = useRunTimeline(runtime, selectedRun?.runId);
  const activeWorkflowId = selectedRun?.workflowId ?? selectedRun?.runId;
  const [leftTab, setLeftTab] = useState<LeftTab>('Conversation');
  const [rightTab, setRightTab] = useState<RightTab>('Report');
  const [plan, setPlan] = useState<WorkflowPlan>();
  const [invocations, setInvocations] = useState<WorkflowInvocation[]>([]);
  const [planLoading, setPlanLoading] = useState(false);
  const [conversation, setConversation] = useState<ConversationSnapshot>();
  const [conversationLoading, setConversationLoading] = useState(false);
  const [composerText, setComposerText] = useState('');
  const [conversationBusy, setConversationBusy] = useState(false);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelBusy, setCancelBusy] = useState(false);
  const [projectCancellation, setProjectCancellation] = useState<'idle' | 'requested'>('idle');
  const [message, setMessage] = useState<string>();
  const [datasetFile, setDatasetFile] = useState<File>();
  const [datasetBusy, setDatasetBusy] = useState(false);
  const [datasetPlan, setDatasetPlan] = useState<DatasetPlanReview>();
  const [datasetResult, setDatasetResult] = useState<DatasetWorkflowResult>();
  const projectName = projectData?.name ?? 'Project unavailable';
  const objective = projectData?.objective ?? 'No objective was recorded for this project.';

  const loadConversation = useCallback(async (): Promise<void> => {
    if (!runtime.client.get) return;
    setConversationLoading(true);
    try {
      setConversation(
        await runtime.client.get<ConversationSnapshot>(
          `/v1/projects/${encodeURIComponent(projectId)}/conversation`,
        ),
      );
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (!text.includes('agent_conversation_not_configured')) setMessage(text);
    } finally {
      setConversationLoading(false);
    }
  }, [projectId, runtime]);

  const loadPlan = useCallback(async (): Promise<void> => {
    if (!runtime.client.get || activeWorkflowId === undefined) {
      setPlan(undefined);
      setInvocations([]);
      return;
    }
    setPlanLoading(true);
    try {
      const [planResult, invocationResult] = await Promise.allSettled([
        runtime.client.get<WorkflowPlan>(
          `/v1/workflows/${encodeURIComponent(activeWorkflowId)}/plan`,
        ),
        runtime.client.get<WorkflowInvocation[]>(
          `/v1/workflows/${encodeURIComponent(activeWorkflowId)}/invocations`,
        ),
      ]);
      if (planResult.status === 'fulfilled') setPlan(planResult.value);
      if (invocationResult.status === 'fulfilled') setInvocations(invocationResult.value);
    } finally {
      setPlanLoading(false);
    }
  }, [activeWorkflowId, runtime]);

  useEffect(() => {
    void loadConversation();
  }, [loadConversation, runtimeSnapshot.cursor]);

  useEffect(() => {
    void loadPlan();
  }, [loadPlan, runtimeSnapshot.cursor]);

  const activeRun = selectedRun;
  const hasLiveRun = Boolean(
    activeRun &&
      !['completed', 'succeeded', 'failed', 'cancelled', 'blocked'].includes(activeRun.status),
  );
  const logLines = timeline
    .filter((event) => event.eventName.includes('log.'))
    .map((event) => {
      const payload = eventPayload(event.payload);
      return String(
        payload.message ?? payload.line ?? `${event.eventName} · ${event.occurredAt ?? ''}`,
      );
    });
  const metricValues = timeline
    .filter((event) => event.eventName.includes('metric.'))
    .map((event) => eventPayload(event.payload).value)
    .filter((value): value is number => typeof value === 'number');
  const currentMetric = metricValues.at(-1);
  const progress = activeRun?.progress ?? 0;
  const elapsedSeconds = activeRun?.startedAt
    ? Math.max(0, Math.floor((Date.now() - Date.parse(activeRun.startedAt)) / 1000))
    : 0;
  const liveStatus: 'running' | 'completed' | 'failed' | 'cancelled' =
    activeRun?.status === 'failed'
      ? 'failed'
      : activeRun?.status === 'cancelled'
        ? 'cancelled'
        : activeRun?.status === 'completed' || activeRun?.status === 'succeeded'
          ? 'completed'
          : 'running';
  const reviewPlan = datasetPlan?.plan ?? plan;
  const planSteps = reviewPlan?.steps ?? [];
  const currentStep =
    planSteps.length > 0 && hasLiveRun
      ? Math.min(planSteps.length, Math.max(1, Math.ceil((progress / 100) * planSteps.length)))
      : undefined;
  const displayStatus =
    projectCancellation === 'requested'
      ? 'Cancellation requested'
      : hasLiveRun
        ? liveStatus === 'completed'
          ? 'Completed'
          : liveStatus === 'failed'
            ? 'Failed'
            : liveStatus === 'cancelled'
              ? 'Cancelled'
              : 'Running'
        : (projectData?.status ?? 'Unavailable');
  const statusColor: Record<string, 'green' | 'amber' | 'red' | 'gray' | 'blue'> = {
    Running: 'green',
    Completed: 'gray',
    Failed: 'red',
    Cancelled: 'amber',
    Idle: 'gray',
    'Awaiting Approval': 'amber',
    Unavailable: 'gray',
    'Cancellation requested': 'amber',
  };
  const projectRuns = runs.map((run) => ({
    id: run.runId,
    name: run.name ?? run.runId,
    status:
      run.status === 'succeeded'
        ? 'Completed'
        : run.status === 'cancelled'
          ? 'Cancelled'
          : run.status === 'failed'
            ? 'Failed'
            : run.status === 'awaiting_approval'
              ? 'Awaiting Approval'
              : ['running', 'executing'].includes(run.status)
                ? 'Running'
                : run.status,
  }));
  const activityItems = timeline.map((event) => ({
    text: event.eventName,
    time: event.occurredAt ?? '—',
  }));
  const messages = conversation?.messages ?? [];

  async function sendMessage(): Promise<void> {
    const text = composerText.trim();
    if (!text || !runtime.client.post) return;
    setConversationBusy(true);
    setMessage(undefined);
    try {
      await runtime.client.post(
        `/v1/projects/${encodeURIComponent(projectId)}/conversation/messages`,
        { text },
      );
      setComposerText('');
      setMessage('Message sent to the project agent.');
      await loadConversation();
    } catch (error) {
      const value = error instanceof Error ? error.message : String(error);
      setMessage(
        value.includes('agent_conversation_not_configured')
          ? 'Agent assistance is not configured for this platform.'
          : value,
      );
    } finally {
      setConversationBusy(false);
    }
  }

  async function planDataset(): Promise<void> {
    if (!datasetFile || !runtime.client.post) {
      setMessage('Choose a CSV file before creating a plan.');
      return;
    }
    const actor = runtimeSnapshot.session?.actor;
    if (!actor) {
      setMessage('The platform session is not ready to publish this dataset.');
      return;
    }
    setDatasetBusy(true);
    setMessage(undefined);
    try {
      const content = await readTextFile(datasetFile);
      if (!content.trim()) throw new Error('The selected CSV file is empty.');
      const mediaType = 'text/csv';
      const staged = await runtime.client.post<{ stagedUploadId?: string }>(
        '/v1/artifacts/uploads',
        { content, mediaType },
      );
      if (typeof staged.stagedUploadId !== 'string') {
        throw new Error('The platform did not return a staged artifact handle.');
      }
      const sourceArtifactId = newRuntimeId();
      await runtime.client.post(`/v1/artifacts/${sourceArtifactId}/versions`, {
        stagedUploadId: staged.stagedUploadId,
        mediaType,
        createdBy: { ...actor },
      });
      const acknowledgement = await runtime.plan({
        commandType: 'ValidateDataset',
        payload: {
          sourceArtifactId,
          sourceArtifactVersion: 1,
          intendedUse: objective,
          requestedAccessScopes: ['dataset.read'],
          retentionDays: 30,
          projectId,
          displayName: datasetFile.name,
          trigger: 'web.dataset-intake',
          splitSeed: 'spyderbyte.web.v1',
        },
      });
      const review = datasetPlanFromAcknowledgement(acknowledgement.result);
      if (review === undefined) throw new Error('The platform returned an invalid dataset plan.');
      setDatasetPlan(review);
      setDatasetResult(undefined);
      setDatasetFile(undefined);
      setLeftTab('Plan');
      setRightTab('Dataset');
      setMessage(
        `CSV staged as ${artifactLabel(review.sourceArtifact)}. Review the typed plan before execution.`,
      );
      await runtime.refresh(['artifact-catalog-lineage']);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setDatasetBusy(false);
    }
  }

  async function runDataset(): Promise<void> {
    if (!datasetPlan || !runtime.client.post) return;
    if (datasetPlan.approval !== undefined && datasetPlan.approval.state !== 'approved') {
      setMessage('Approve the typed plan before running this dataset workflow.');
      return;
    }
    setDatasetBusy(true);
    setMessage(undefined);
    try {
      const response = await runtime.client.post<unknown>(
        `/v1/workflows/${encodeURIComponent(datasetPlan.workflowId)}/run`,
        {},
      );
      const result = datasetResultFromResponse(response);
      if (result === undefined)
        throw new Error('The platform returned an invalid workflow result.');
      setDatasetResult(result);
      setRightTab('Dataset');
      setMessage(
        result.status === 'completed'
          ? 'Dataset validation completed and immutable output artifacts were published.'
          : `Dataset workflow ended with status ${result.status}.`,
      );
      await runtime.refresh([
        'projects',
        'runs',
        'run-timeline',
        'artifact-catalog-lineage',
        'datasets',
      ]);
      await loadPlan();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setDatasetBusy(false);
    }
  }

  async function decideDatasetPlan(decision: 'approve' | 'reject'): Promise<void> {
    const approval = datasetPlan?.approval;
    if (!approval || !runtime.client.post) return;
    setDatasetBusy(true);
    setMessage(undefined);
    try {
      await runtime.client.post(
        `/v1/approvals/${encodeURIComponent(approval.approvalId)}/${decision}`,
        {
          reason: `${decision === 'approve' ? 'Approved' : 'Rejected'} in project plan review`,
        },
      );
      setDatasetPlan((current) =>
        current === undefined
          ? current
          : {
              ...current,
              approval: { ...approval, state: decision === 'approve' ? 'approved' : 'rejected' },
            },
      );
      setMessage(decision === 'approve' ? 'Plan approved and ready to run.' : 'Plan rejected.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setDatasetBusy(false);
    }
  }

  async function cancelConversation(): Promise<void> {
    if (!runtime.client.post || !conversation) return;
    setConversationBusy(true);
    try {
      await runtime.client.post(
        `/v1/conversations/${encodeURIComponent(conversation.conversationId)}/cancel`,
        { reason: 'cancelled by user' },
      );
      await loadConversation();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setConversationBusy(false);
    }
  }

  async function cancelProject(): Promise<void> {
    setCancelBusy(true);
    setMessage(undefined);
    try {
      const acknowledgement = await runtime.command({
        commandType: 'CancelProject',
        payload: {
          projectId,
          ...(cancelReason.trim() ? { reason: cancelReason.trim() } : {}),
        },
      });
      setCancelDialogOpen(false);
      setCancelReason('');
      setProjectCancellation('requested');
      const result = acknowledgement.result;
      const resultStatus =
        result !== null && typeof result === 'object' && !Array.isArray(result)
          ? result.status
          : undefined;
      setMessage(
        resultStatus === 'already_terminal'
          ? 'All project work is already complete.'
          : 'Cancellation requested.',
      );
      await runtime.refresh(['projects', 'runs', 'run-timeline']);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setCancelBusy(false);
    }
  }

  if (state === 'booting' && !projectData)
    return (
      <div className="page-scroll">
        <div className="page page-narrow">
          <EmptyState
            icon="projects"
            title="Loading project…"
            description="Waiting for project data."
          />
        </div>
      </div>
    );

  return (
    <div className="page-scroll project-detail-shell">
      <RuntimeStateNotice state={runtimeSnapshot.connection} onRetry={() => void runtime.retry()} />
      <div className="project-breadcrumb">
        <button type="button" onClick={onBack}>
          <Icon name="arrow-left" size={16} tone="secondary" aria-hidden="true" />
          Projects
        </button>
        <span>/</span>
        <strong>{projectName}</strong>
        <Badge color={statusColor[displayStatus] ?? 'gray'}>{displayStatus}</Badge>
        <span className="project-header-spacer" />
        <Button
          variant="destructive"
          disabled={
            cancelBusy || projectCancellation === 'requested' || projectData?.status === 'archived'
          }
          onClick={() => setCancelDialogOpen(true)}
        >
          Cancel project
        </Button>
      </div>
      {message && (
        <div className="home-error" role="status">
          {message}
        </div>
      )}
      <div className="project-detail-layout">
        <aside className="project-left-pane">
          <Tabs
            label="Project detail sections"
            value={leftTab}
            onChange={(value) => setLeftTab(value as LeftTab)}
            items={['Conversation', 'Plan', 'Activity'].map((value) => ({ value, label: value }))}
          />
          <div className="project-pane-scroll">
            {leftTab === 'Conversation' && (
              <div className="project-conversation">
                {conversationLoading && messages.length === 0 && (
                  <div className="panel-empty">Loading the project conversation…</div>
                )}
                {!conversationLoading && messages.length === 0 && (
                  <EmptyState
                    icon="info"
                    title="Ask the project agent"
                    description="Describe the next analysis, data connection, or workflow change you need."
                  />
                )}
                {messages.map((item) => (
                  <div
                    className={`project-message project-message-${item.role}`}
                    data-state={item.state}
                    key={item.messageId}
                  >
                    {item.toolName ? (
                      <small>
                        {item.toolName} · {item.toolOperation ?? 'activity'}
                      </small>
                    ) : null}
                    {item.text}
                  </div>
                ))}
                {conversation?.generating && (
                  <Card className="project-agent-streaming">
                    <StatusDot color="blue" /> Agent is working on the next response…
                  </Card>
                )}
                <Card className="project-composer">
                  <Textarea
                    value={composerText}
                    onChange={(event) => setComposerText(event.target.value)}
                    onKeyDown={(event) => {
                      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                        event.preventDefault();
                        void sendMessage();
                      }
                    }}
                    placeholder="Ask the project agent…"
                    rows={4}
                    disabled={conversationBusy}
                  />
                  <div className="project-composer-actions">
                    <PushToTalkButton
                      onText={(text) =>
                        setComposerText((current) => `${current}${current ? ' ' : ''}${text}`)
                      }
                    />
                    <span className="home-card-subtitle">Ctrl/⌘ + Enter to send</span>
                    <span className="project-header-spacer" />
                    {conversation?.generating && (
                      <Button variant="secondary" onClick={() => void cancelConversation()}>
                        Stop agent
                      </Button>
                    )}
                    <Button loading={conversationBusy} onClick={() => void sendMessage()}>
                      Send
                    </Button>
                  </div>
                </Card>
              </div>
            )}
            {leftTab === 'Plan' && (
              <div className="project-plan-list">
                {datasetPlan && (
                  <Card className="project-plan-review" aria-live="polite">
                    <SectionLabel>Typed dataset plan</SectionLabel>
                    <h2>Review before execution</h2>
                    <div className="config-list">
                      <div>
                        <span>Source artifact</span>
                        <strong>{artifactLabel(datasetPlan.sourceArtifact)}</strong>
                      </div>
                      <div>
                        <span>Workflow</span>
                        <strong>{datasetPlan.workflowId}</strong>
                      </div>
                      <div>
                        <span>Governed steps</span>
                        <strong>{datasetPlan.plan.steps.length}</strong>
                      </div>
                      <div>
                        <span>Approval</span>
                        <strong>{datasetPlan.approval?.state ?? 'Not required'}</strong>
                      </div>
                    </div>
                    {datasetPlan.approval?.state === 'pending' && (
                      <div className="project-composer-actions">
                        <Button
                          variant="secondary"
                          loading={datasetBusy}
                          onClick={() => void decideDatasetPlan('approve')}
                        >
                          Approve plan
                        </Button>
                        <Button
                          variant="tertiary"
                          disabled={datasetBusy}
                          onClick={() => void decideDatasetPlan('reject')}
                        >
                          Reject plan
                        </Button>
                      </div>
                    )}
                    {datasetPlan.approval?.state === 'rejected' && (
                      <Notice tone="warning">This plan was rejected and cannot be run.</Notice>
                    )}
                    <Button
                      loading={datasetBusy}
                      disabled={datasetPlan.approval?.state === 'rejected'}
                      onClick={() => void runDataset()}
                    >
                      Run reviewed plan
                    </Button>
                    <small className="ds-field-hint">
                      The plan is immutable for this workflow. Review the governed steps below
                      before execution.
                    </small>
                  </Card>
                )}
                {planLoading && <div className="panel-empty">Loading the agent plan…</div>}
                {!planLoading &&
                  conversation?.generating &&
                  planSteps.length === 0 &&
                  !datasetPlan && (
                    <Card className="project-agent-streaming">
                      <StatusDot color="blue" /> Agent is preparing the plan…
                    </Card>
                  )}
                {!planLoading &&
                  !conversation?.generating &&
                  planSteps.length === 0 &&
                  !datasetPlan && (
                    <EmptyState
                      icon="info"
                      title="The agent has not produced a plan yet"
                      description="Use Conversation to describe the work. The platform will show the live plan here when it is ready."
                    />
                  )}
                {planSteps.map((planStep, index) => {
                  const invocation = invocations.find(
                    (candidate) =>
                      (candidate.value?.planStepId ?? candidate.planStepId) === planStep.stepId,
                  );
                  const stateValue = invocationState(invocation);
                  const done =
                    stateValue === 'completed' ||
                    (currentStep !== undefined && index < currentStep - 1);
                  const current =
                    stateValue === 'executing' ||
                    (currentStep !== undefined && index === currentStep - 1);
                  const failed = stateValue === 'failed' || stateValue === 'blocked';
                  const status = failed
                    ? 'Failed'
                    : done
                      ? 'Done'
                      : current
                        ? 'Running'
                        : 'Pending';
                  return (
                    <Card
                      className="project-plan-item"
                      data-current={current}
                      key={planStep.stepId}
                    >
                      <div className="project-plan-heading">
                        <span className="project-plan-number">{index + 1}</span>
                        <strong>{planStep.title ?? `Step ${index + 1}`}</strong>
                        <Badge color={failed ? 'red' : done ? 'green' : current ? 'blue' : 'gray'}>
                          {status}
                        </Badge>
                      </div>
                      <p>
                        {planStep.description ??
                          (planStep.acceptanceCriteria.join(' · ') ||
                            'The agent has not added a description for this step.')}
                      </p>
                      <div className="project-plan-meta">
                        <span>Tier {planStep.tier}</span>
                        {planStep.expectedOutputs?.map((output) => (
                          <span key={output}>Out: {output}</span>
                        ))}
                        {planStep.approvalRequired && <span>Approval required</span>}
                      </div>
                    </Card>
                  );
                })}
              </div>
            )}
            {leftTab === 'Activity' && (
              <div className="project-activity">
                {activityItems.length === 0 ? (
                  <EmptyState icon="clock" title="No activity yet" />
                ) : (
                  activityItems.map((item, index) => (
                    <div className="project-activity-item" key={`${item.text}-${index}`}>
                      <Icon name="clock" size={16} tone="tertiary" aria-hidden="true" />
                      <div>
                        <div>{item.text}</div>
                        <small>{item.time}</small>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </aside>

        <main className="project-right-pane">
          <Tabs
            label="Project output sections"
            value={rightTab}
            onChange={(value) => setRightTab(value as RightTab)}
            items={['Report', 'Dataset', 'Code', 'Configuration', 'Logs'].map((value) => ({
              value,
              label: value,
            }))}
          />
          <div className="project-pane-scroll project-output">
            {rightTab === 'Report' && (
              <div className="stack">
                <div className="project-report-grid">
                  <Card>
                    <SectionLabel>Status</SectionLabel>
                    <div className="project-metric-value">
                      <StatusDot color={statusColor[displayStatus] ?? 'gray'} />
                      {displayStatus}
                    </div>
                    <div className="project-metric-subtitle">Authoritative project state</div>
                  </Card>
                  <Card>
                    <SectionLabel>Latest metric</SectionLabel>
                    <div className="project-metric-value">
                      {currentMetric === undefined ? '—' : currentMetric.toFixed(3)}
                    </div>
                    <div className="project-metric-subtitle">Backend observation</div>
                  </Card>
                  <Card>
                    <SectionLabel>Progress</SectionLabel>
                    <div className="project-metric-value">
                      {activeRun ? `${Math.round(progress)}%` : '—'}
                    </div>
                    <div className="project-metric-subtitle">Backend progress event</div>
                  </Card>
                  <Card>
                    <SectionLabel>Elapsed</SectionLabel>
                    <div className="project-metric-value">
                      {activeRun ? formatElapsed(elapsedSeconds) : '—'}
                    </div>
                    <div className="project-metric-subtitle">Derived from run start</div>
                  </Card>
                </div>
                {activeRun && planSteps.length > 0 && (
                  <Card>
                    <SectionLabel>Agent plan progress</SectionLabel>
                    <ProgressBar
                      value={progress}
                      tone={liveStatus === 'failed' ? 'danger' : 'info'}
                    />
                    <div className="project-run-status-meta">
                      <span>
                        Step {currentStep ?? 0} of {planSteps.length}
                      </span>
                      <span>{Math.round(progress)} / 100 progress units</span>
                    </div>
                  </Card>
                )}
                <Card>
                  <SectionLabel>Observed metric trend</SectionLabel>
                  {metricValues.length === 0 ? (
                    <div className="panel-empty">No metric observations have been emitted.</div>
                  ) : (
                    <div className="metric-bars">
                      {metricValues.slice(-12).map((value, index) => (
                        <span
                          key={`${value}-${index}`}
                          style={
                            {
                              '--bar-height': `${Math.max(12, Math.min(100, value * 10))}%`,
                            } as CSSProperties
                          }
                          title={String(value)}
                        />
                      ))}
                    </div>
                  )}
                </Card>
                <Card>
                  <SectionLabel>Runs in this project</SectionLabel>
                  {projectRuns.length === 0 ? (
                    <div className="panel-empty">No runs have been created.</div>
                  ) : (
                    <div className="project-run-list">
                      {projectRuns.slice(0, 6).map((item) => (
                        <button type="button" key={item.id} onClick={() => onSelectRun(item.id)}>
                          <span>
                            <StatusDot color={statusColor[item.status] ?? 'gray'} />
                            {item.name}
                          </span>
                          <Badge color={statusColor[item.status] ?? 'gray'}>{item.status}</Badge>
                        </button>
                      ))}
                    </div>
                  )}
                </Card>
              </div>
            )}
            {rightTab === 'Dataset' && (
              <div className="stack">
                <Card className="project-dataset-intake">
                  <SectionLabel>Local-first dataset intake</SectionLabel>
                  <h2>Analyze a CSV in this project</h2>
                  <p>
                    The file is staged and published as an immutable local artifact. Spyderbyte then
                    creates a typed validation plan for review before any workflow runs.
                  </p>
                  <Field
                    label="CSV dataset"
                    hint="CSV files are processed through the local API boundary."
                  >
                    <Input
                      type="file"
                      accept=".csv,text/csv"
                      onChange={(event) => setDatasetFile(event.target.files?.[0])}
                      disabled={datasetBusy}
                    />
                  </Field>
                  {datasetFile && <div className="ds-field-hint">Selected: {datasetFile.name}</div>}
                  <div className="project-composer-actions">
                    <Button
                      loading={datasetBusy}
                      disabled={!datasetFile}
                      onClick={() => void planDataset()}
                    >
                      Stage and create plan
                    </Button>
                    {datasetPlan && (
                      <Button variant="tertiary" onClick={() => setLeftTab('Plan')}>
                        Review plan
                      </Button>
                    )}
                  </div>
                  <Notice tone="info">
                    No provider key is stored in the browser. Execution remains governed by the
                    configured local or BYOK runtime.
                  </Notice>
                </Card>
                {datasetPlan && (
                  <Card>
                    <SectionLabel>Source artifact</SectionLabel>
                    <div className="project-dataset-artifact">
                      <strong>{artifactLabel(datasetPlan.sourceArtifact)}</strong>
                      <span>Immutable input for workflow {datasetPlan.workflowId}</span>
                    </div>
                  </Card>
                )}
                {datasetResult && (
                  <Card aria-live="polite">
                    <SectionLabel>Workflow outputs</SectionLabel>
                    <div className="project-dataset-artifact-list">
                      {(
                        [
                          ['Source', datasetResult.sourceArtifact],
                          ['Governance decision', datasetResult.governanceDecisionArtifact],
                          ['Quality report', datasetResult.dataQualityReportArtifact],
                          ['Validated dataset', datasetResult.validatedDatasetArtifact],
                        ] as const
                      ).map(([label, reference]) =>
                        reference ? (
                          <div className="project-dataset-artifact" key={label}>
                            <strong>{label}</strong>
                            <span>{artifactLabel(reference)}</span>
                          </div>
                        ) : null,
                      )}
                    </div>
                    {datasetResult.reasonCodes.length > 0 && (
                      <Notice tone={datasetResult.status === 'completed' ? 'info' : 'warning'}>
                        {datasetResult.reasonCodes.join(' · ')}
                      </Notice>
                    )}
                    <Button variant="tertiary" onClick={() => onNavigate('assets')}>
                      Inspect artifact lineage
                    </Button>
                  </Card>
                )}
              </div>
            )}
            {rightTab === 'Code' && (
              <EmptyState
                icon="code"
                title="Code workspace is not attached"
                description="Connect a repository to make project code available here."
              />
            )}
            {rightTab === 'Configuration' && (
              <Card>
                <SectionLabel>Project configuration</SectionLabel>
                <div className="config-list">
                  <div>
                    <span>Project</span>
                    <strong>{projectName}</strong>
                  </div>
                  <div>
                    <span>Objective</span>
                    <strong>{objective}</strong>
                  </div>
                  <div>
                    <span>Workflow state</span>
                    <strong>{displayStatus}</strong>
                  </div>
                  <div>
                    <span>Plan version</span>
                    <strong>{reviewPlan?.version ?? 'Not produced'}</strong>
                  </div>
                </div>
              </Card>
            )}
            {rightTab === 'Logs' && (
              <Card>
                <SectionLabel>Live logs</SectionLabel>
                {logLines.length === 0 ? (
                  <div className="panel-empty">No log events have been emitted.</div>
                ) : (
                  <pre className="project-log-content">{logLines.join('\n')}</pre>
                )}
              </Card>
            )}
          </div>
        </main>
      </div>
      <Dialog
        open={cancelDialogOpen}
        title="Cancel project work?"
        onClose={() => !cancelBusy && setCancelDialogOpen(false)}
        actions={
          <>
            <Button
              variant="tertiary"
              disabled={cancelBusy}
              onClick={() => setCancelDialogOpen(false)}
            >
              Keep running
            </Button>
            <Button variant="destructive" loading={cancelBusy} onClick={() => void cancelProject()}>
              Cancel project
            </Button>
          </>
        }
      >
        <p>
          This stops active workflows for this project. The project and its recorded outputs remain
          available.
        </p>
        <Field label="Cancellation reason">
          <Textarea
            value={cancelReason}
            onChange={(event) => setCancelReason(event.target.value)}
            placeholder="Optional reason"
            rows={3}
          />
        </Field>
      </Dialog>
    </div>
  );
}
