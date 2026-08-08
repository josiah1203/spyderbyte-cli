import { useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ProgressBar,
  SectionLabel,
  StatusDot,
} from '../components/primitives';
import Icon from '../components/icons';
import RuntimeStateNotice from '../components/RuntimeStateNotice';
import { useRuntime } from '../runtime/RuntimeProvider';
import { useRun, useRunTimeline, useRuntimeStore } from '../runtime/store';

const STAGES = ['Preparing', 'Governance', 'Validation', 'Artifacts', 'Completed'];
const STATUS_COLOR: Record<string, 'green' | 'amber' | 'red' | 'gray' | 'blue'> = {
  running: 'green',
  executing: 'green',
  completed: 'gray',
  succeeded: 'gray',
  failed: 'red',
  cancelled: 'gray',
  awaiting_approval: 'amber',
  planning: 'blue',
};

function label(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
function elapsed(startedAt: string | undefined): string {
  if (!startedAt) return '—';
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m elapsed` : `${seconds}s elapsed`;
}
function payloadRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

interface RunDetailProps {
  runId: string;
  onBack: () => void;
  onSelectProject: (id: string) => void;
}

export default function RunDetail({ runId, onBack, onSelectProject }: RunDetailProps) {
  const runtime = useRuntime();
  const runtimeSnapshot = useRuntimeStore(runtime);
  const { data: run, state } = useRun(runtime, runId);
  const { data: timeline } = useRunTimeline(runtime, runId);
  const [logsOpen, setLogsOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const ordered = useMemo(
    () =>
      [...timeline].sort((left, right) =>
        String(left.occurredAt ?? '').localeCompare(String(right.occurredAt ?? '')),
      ),
    [timeline],
  );
  const logs = ordered
    .filter((event) => event.eventName.includes('log.'))
    .map((event) => {
      const payload = payloadRecord(event.payload);
      return String(
        payload.message ?? payload.line ?? `${event.eventName} · ${event.occurredAt ?? ''}`,
      );
    });
  const metrics = ordered
    .filter((event) => event.eventName.includes('metric.'))
    .map((event) => payloadRecord(event.payload))
    .filter((metric) => typeof metric.value === 'number');
  const artifacts = ordered.filter((event) => event.eventName.startsWith('artifact.'));
  const progress = Math.max(0, Math.min(100, run?.progress ?? 0));
  const activeStage = Math.min(STAGES.length - 1, Math.floor((progress / 100) * STAGES.length));

  async function cancelRun(): Promise<void> {
    if (
      !run ||
      cancelling ||
      ['completed', 'succeeded', 'failed', 'cancelled'].includes(run.status)
    )
      return;
    setCancelling(true);
    try {
      await runtime.command({
        commandType: 'CancelRun',
        payload: { workflowId: run.workflowId ?? run.runId },
      });
    } finally {
      setCancelling(false);
    }
  }

  if (!run)
    return (
      <div className="page-scroll">
        <div className="page page-narrow">
          <RuntimeStateNotice
            state={runtimeSnapshot.connection}
            onRetry={() => void runtime.retry()}
          />
          <EmptyState
            icon="play"
            title={
              state === 'booting' ? 'Loading the authoritative run…' : 'This run is unavailable'
            }
            description="The platform did not return a current run state."
          />
        </div>
      </div>
    );

  return (
    <div className="page-scroll">
      <div className="page stack">
        <RuntimeStateNotice
          state={runtimeSnapshot.connection}
          onRetry={() => void runtime.retry()}
        />
        <div className="detail-breadcrumb">
          <button type="button" onClick={onBack}>
            <Icon name="arrow-left" size={16} tone="secondary" aria-hidden="true" />
            Runs
          </button>
          <span>/</span>
          <strong>{run.name ?? run.runId}</strong>
          <Badge color={STATUS_COLOR[run.status] ?? 'gray'}>{label(run.status)}</Badge>
          {run.projectId && (
            <button
              className="detail-breadcrumb-project"
              type="button"
              onClick={() => onSelectProject(run.projectId ?? '')}
            >
              Project <Icon name="arrow-right" size={14} tone="secondary" aria-hidden="true" />
            </button>
          )}
        </div>
        <section>
          <SectionLabel>Objective</SectionLabel>
          <h1 className="detail-objective">
            {run.objective ?? 'No objective was recorded for this run.'}
          </h1>
        </section>

        <Card className="run-progress-card">
          <div className="run-stage-row">
            {STAGES.map((stage, index) => {
              const done = index < activeStage || ['completed', 'succeeded'].includes(run.status);
              const active = index === activeStage && !done;
              return (
                <div className="run-stage" key={stage}>
                  <div className="run-stage-node" data-done={done} data-active={active}>
                    {done ? (
                      <Icon name="check" size={16} tone="disabled" aria-hidden="true" />
                    ) : (
                      index + 1
                    )}
                  </div>
                  <span data-active={active} data-done={done}>
                    {stage}
                  </span>
                  {index < STAGES.length - 1 && (
                    <span className="run-stage-line" data-done={done} />
                  )}
                </div>
              );
            })}
          </div>
          <div className="run-status-row">
            <div className="run-status-copy">
              <StatusDot color={STATUS_COLOR[run.status] ?? 'gray'} />
              <strong>
                {label(run.status)} · {Math.round(progress)}% observed
              </strong>
              <span>· {elapsed(run.startedAt)}</span>
            </div>
            {!['completed', 'succeeded', 'failed', 'cancelled'].includes(run.status) && (
              <Button
                variant="outline-danger"
                loading={cancelling}
                onClick={() => void cancelRun()}
              >
                Cancel run
              </Button>
            )}
          </div>
          <ProgressBar value={progress} tone="info" h={6} />
        </Card>

        <Card className="run-routing-card">
          <div className="panel-heading">
            <SectionLabel>Resolved execution</SectionLabel>
          </div>
          <div className="run-routing-grid">
            <div>
              <span>Provider / model</span>
              <strong>
                {run.providerId && run.modelId
                  ? `${run.providerId} · ${run.modelId}`
                  : 'Not reported'}
              </strong>
              {run.routingReason && <small>Routing: {run.routingReason}</small>}
            </div>
            <div>
              <span>Subscription usage</span>
              <strong>{run.usageStatus?.quotaState ?? 'Not reported'}</strong>
              {run.usageStatus?.resetAt && (
                <small>Reset {new Date(run.usageStatus.resetAt).toLocaleString()}</small>
              )}
            </div>
          </div>
          {run.fallbackCandidates && run.fallbackCandidates.length > 0 && (
            <div className="run-fallbacks">
              <span>Declared fallback candidates</span>
              {run.fallbackCandidates.map((candidate) => (
                <Badge color="gray" key={`${candidate.providerId}:${candidate.modelId}`}>
                  {candidate.providerId} · {candidate.modelId}
                </Badge>
              ))}
            </div>
          )}
        </Card>

        <div className="run-grid">
          <Card className="run-panel">
            <div className="panel-heading">
              <SectionLabel>Published artifacts</SectionLabel>
            </div>
            {artifacts.length === 0 ? (
              <div className="panel-empty">No artifact publication has been observed.</div>
            ) : (
              <div className="run-event-list">
                {artifacts.map((event) => (
                  <div className="run-event" key={event.eventId}>
                    <span className="run-event-icon">
                      <Icon name="box" size={16} tone="secondary" aria-hidden="true" />
                    </span>
                    <div>
                      <div className="run-event-title">{event.aggregateId}</div>
                      <div className="run-event-meta">
                        {event.eventName} · {event.occurredAt ?? '—'}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
          <Card className="run-panel">
            <div className="panel-heading">
              <SectionLabel>Observed metrics</SectionLabel>
            </div>
            {metrics.length === 0 ? (
              <div className="panel-empty">No metric observations have been emitted.</div>
            ) : (
              <div className="metric-list">
                {metrics.slice(-8).map((metric, index) => (
                  <div key={`${String(metric.name ?? 'metric')}-${index}`}>
                    <span>{String(metric.name ?? 'metric')}</span>
                    <strong>{String(metric.value)}</strong>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <Card className="run-logs">
          <button
            className="run-logs-trigger"
            type="button"
            aria-expanded={logsOpen}
            onClick={() => setLogsOpen((open) => !open)}
          >
            <SectionLabel>Live logs</SectionLabel>
            <Icon
              name={logsOpen ? 'chevron-up' : 'chevron-down'}
              size={18}
              tone="secondary"
              aria-hidden="true"
            />
          </button>
          {logsOpen && (
            <pre className="run-logs-content">
              {logs.length === 0 ? 'No log append events have been emitted.' : logs.join('\n')}
            </pre>
          )}
        </Card>
      </div>
    </div>
  );
}
