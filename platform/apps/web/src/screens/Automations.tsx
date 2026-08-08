import { useEffect, useState, type ReactElement } from 'react';
import CapabilityGate from '../components/CapabilityGate';
import RuntimeStateNotice from '../components/RuntimeStateNotice';
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  SectionLabel,
  Select,
  Textarea,
} from '../components/primitives';
import { useRuntime } from '../runtime/RuntimeProvider';
import { useRuntimeStore } from '../runtime/store';
import type { JsonValue } from '../runtime/contracts';

interface Automation {
  automationId: string;
  name: string;
  pipelineId: string;
  trigger:
    | { type: 'manual' }
    | { type: 'interval'; intervalMs: number }
    | { type: 'cron'; expression: string; timezone: string }
    | { type: 'webhook'; secretId: string }
    | { type: 'event'; topic: string; eventName?: string }
    | { type: 'data-arrival'; sourceRef: string; eventName?: string }
    | { type: 'repository'; repositoryId: string; eventName?: string; branch?: string };
  enabled: boolean;
  concurrencyLimit?: number;
  concurrencyPolicy?: 'reject' | 'queue';
  maxBackfillRuns?: number;
  nextRunAt?: string;
  lastRunAt?: string;
}

interface AutomationRun {
  runId: string;
  automationId: string;
  pipelineRunId?: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
}

interface AutomationResponse {
  automations: Automation[];
  runs: AutomationRun[];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function Automations(): ReactElement {
  const runtime = useRuntime();
  const snapshot = useRuntimeStore(runtime);
  const [data, setData] = useState<AutomationResponse>();
  const [name, setName] = useState('Daily analysis');
  const [pipelineId, setPipelineId] = useState('individual-workbench');
  const [triggerType, setTriggerType] = useState<
    'manual' | 'interval' | 'cron' | 'webhook' | 'event' | 'data-arrival' | 'repository'
  >('manual');
  const [intervalMinutes, setIntervalMinutes] = useState('60');
  const [cronExpression, setCronExpression] = useState('0 * * * *');
  const [timezone, setTimezone] = useState('UTC');
  const [secretId, setSecretId] = useState('creator-webhook');
  const [eventTopic, setEventTopic] = useState('runtime.events');
  const [eventName, setEventName] = useState('');
  const [sourceRef, setSourceRef] = useState('dataset://sales');
  const [repositoryId, setRepositoryId] = useState('repository-1');
  const [branch, setBranch] = useState('main');
  const [concurrencyLimit, setConcurrencyLimit] = useState('1');
  const [concurrencyPolicy, setConcurrencyPolicy] = useState<'reject' | 'queue'>('reject');
  const [webhookPayload, setWebhookPayload] = useState('{}');
  const [webhookSignature, setWebhookSignature] = useState('');
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function load(): Promise<void> {
    if (!runtime.client.get) return;
    try {
      setData(await runtime.client.get<AutomationResponse>('/v1/automations/local'));
    } catch (error) {
      setMessage(errorText(error));
    }
  }

  useEffect(() => {
    void load();
  }, [runtime]);

  async function create(): Promise<void> {
    if (!runtime.client.post) return;
    setBusy(true);
    try {
      const automation = await runtime.client.post<Automation>('/v1/automations/local', {
        automationId: `automation-${Date.now()}`,
        name,
        pipelineId,
        trigger:
          triggerType === 'manual'
            ? { type: 'manual' }
            : triggerType === 'interval'
              ? { type: 'interval', intervalMs: Math.max(1, Number(intervalMinutes)) * 60_000 }
              : triggerType === 'cron'
                ? { type: 'cron', expression: cronExpression.trim(), timezone: timezone.trim() }
                : triggerType === 'webhook'
                  ? { type: 'webhook', secretId: secretId.trim() }
                  : triggerType === 'event'
                    ? {
                        type: 'event',
                        topic: eventTopic.trim(),
                        ...(eventName.trim() ? { eventName: eventName.trim() } : {}),
                      }
                    : triggerType === 'data-arrival'
                      ? {
                          type: 'data-arrival',
                          sourceRef: sourceRef.trim(),
                          ...(eventName.trim() ? { eventName: eventName.trim() } : {}),
                        }
                      : {
                          type: 'repository',
                          repositoryId: repositoryId.trim(),
                          ...(eventName.trim() ? { eventName: eventName.trim() } : {}),
                          ...(branch.trim() ? { branch: branch.trim() } : {}),
                        },
        ...(timezone.trim() ? { timezone: timezone.trim() } : {}),
        concurrencyLimit: Math.max(1, Number(concurrencyLimit)),
        concurrencyPolicy,
      });
      setMessage(`${automation.name} is scheduled.`);
      await load();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function action(
    automationId: string,
    operation: 'pause' | 'resume' | 'trigger',
  ): Promise<void> {
    if (!runtime.client.post) return;
    setBusy(true);
    try {
      await runtime.client.post(
        `/v1/automations/local/${encodeURIComponent(automationId)}/${operation}`,
        {},
      );
      setMessage(`Automation ${operation} completed.`);
      await load();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function fireWebhook(automationId: string): Promise<void> {
    if (!runtime.client.post) return;
    let payload: unknown;
    try {
      payload = JSON.parse(webhookPayload);
    } catch {
      setMessage('Webhook payload must be valid JSON.');
      return;
    }
    setBusy(true);
    try {
      await runtime.client.post(
        `/v1/automations/local/${encodeURIComponent(automationId)}/webhook`,
        {
          payload: payload as JsonValue,
          ...(webhookSignature.trim() ? { signature: webhookSignature.trim() } : {}),
        },
      );
      setMessage('Signed webhook accepted.');
      await load();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function backfill(automationId: string): Promise<void> {
    if (!runtime.client.post) return;
    setBusy(true);
    try {
      await runtime.client.post(
        `/v1/automations/local/${encodeURIComponent(automationId)}/backfill`,
        { count: 1 },
      );
      setMessage('Backfill run queued.');
      await load();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <CapabilityGate page="automations">
      <div className="page-scroll">
        <div className="page stack">
          <div className="page-heading">
            <div>
              <SectionLabel>Durable local triggers</SectionLabel>
              <h1>Automations</h1>
              <p className="page-subtitle">
                Schedule, manually trigger, or receive signed webhooks, data-arrival, repository,
                and runtime events for a versioned pipeline. Schedules persist in the workspace and
                are evaluated by the local scheduler.
              </p>
            </div>
          </div>
          <RuntimeStateNotice state={snapshot.connection} onRetry={() => void runtime.retry()} />
          {message && (
            <div className="home-error" role="status">
              {message}
            </div>
          )}
          <Card className="stack">
            <div className="card-heading">
              <div>
                <h2>New automation</h2>
                <p>
                  Triggers require an existing local pipeline definition. Webhooks require a
                  matching HMAC secret in the daemon environment.
                </p>
              </div>
              <Button loading={busy} onClick={() => void create()}>
                Create automation
              </Button>
            </div>
            <div className="resource-editor-grid">
              <Field label="Name">
                <Input value={name} onChange={(event) => setName(event.target.value)} />
              </Field>
              <Field label="Pipeline ID">
                <Input value={pipelineId} onChange={(event) => setPipelineId(event.target.value)} />
              </Field>
              <Field label="Trigger type">
                <Select
                  value={triggerType}
                  onChange={(event) =>
                    setTriggerType(
                      event.target.value as
                        | 'manual'
                        | 'interval'
                        | 'cron'
                        | 'webhook'
                        | 'event'
                        | 'data-arrival'
                        | 'repository',
                    )
                  }
                >
                  <option value="manual">Manual</option>
                  <option value="interval">Interval</option>
                  <option value="cron">Cron</option>
                  <option value="webhook">Signed webhook</option>
                  <option value="event">Runtime event</option>
                  <option value="data-arrival">Data arrival</option>
                  <option value="repository">Repository event</option>
                </Select>
              </Field>
              {triggerType === 'interval' && (
                <Field
                  label="Interval (minutes)"
                  hint="Minimum 60 minutes for durable background scheduling."
                >
                  <Input
                    type="number"
                    min="60"
                    value={intervalMinutes}
                    onChange={(event) => setIntervalMinutes(event.target.value)}
                  />
                </Field>
              )}
              {triggerType === 'cron' && (
                <>
                  <Field label="Cron expression" hint="Five-field cron syntax.">
                    <Input
                      value={cronExpression}
                      onChange={(event) => setCronExpression(event.target.value)}
                    />
                  </Field>
                  <Field label="Timezone">
                    <Input value={timezone} onChange={(event) => setTimezone(event.target.value)} />
                  </Field>
                </>
              )}
              {triggerType === 'webhook' && (
                <Field
                  label="Secret ID"
                  hint="The daemon resolves SPYDERBYTE_AUTOMATION_SECRET_<id>."
                >
                  <Input value={secretId} onChange={(event) => setSecretId(event.target.value)} />
                </Field>
              )}
              {triggerType === 'event' && (
                <>
                  <Field label="Event topic">
                    <Input
                      value={eventTopic}
                      onChange={(event) => setEventTopic(event.target.value)}
                    />
                  </Field>
                  <Field label="Event name" hint="Optional exact event name filter.">
                    <Input
                      value={eventName}
                      onChange={(event) => setEventName(event.target.value)}
                    />
                  </Field>
                </>
              )}
              {triggerType === 'data-arrival' && (
                <>
                  <Field label="Source reference">
                    <Input
                      value={sourceRef}
                      onChange={(event) => setSourceRef(event.target.value)}
                    />
                  </Field>
                  <Field label="Event name" hint="Optional exact event name filter.">
                    <Input
                      value={eventName}
                      onChange={(event) => setEventName(event.target.value)}
                    />
                  </Field>
                </>
              )}
              {triggerType === 'repository' && (
                <>
                  <Field label="Repository ID">
                    <Input
                      value={repositoryId}
                      onChange={(event) => setRepositoryId(event.target.value)}
                    />
                  </Field>
                  <Field label="Branch">
                    <Input value={branch} onChange={(event) => setBranch(event.target.value)} />
                  </Field>
                  <Field label="Event name">
                    <Input
                      value={eventName}
                      onChange={(event) => setEventName(event.target.value)}
                    />
                  </Field>
                </>
              )}
              <Field
                label="Concurrency limit"
                hint="Active and queued runs are bounded per automation."
              >
                <Input
                  type="number"
                  min="1"
                  max="32"
                  value={concurrencyLimit}
                  onChange={(event) => setConcurrencyLimit(event.target.value)}
                />
              </Field>
              <Field label="When busy">
                <Select
                  value={concurrencyPolicy}
                  onChange={(event) =>
                    setConcurrencyPolicy(event.target.value as 'reject' | 'queue')
                  }
                >
                  <option value="reject">Reject new runs</option>
                  <option value="queue">Queue new runs</option>
                </Select>
              </Field>
            </div>
          </Card>
          <div className="stack">
            {(data?.automations ?? []).map((automation) => (
              <Card className="stack" key={automation.automationId}>
                <div className="card-heading">
                  <div>
                    <h2>{automation.name}</h2>
                    <p>
                      {automation.pipelineId} · {automation.trigger.type}
                    </p>
                  </div>
                  <Badge color={automation.enabled ? 'green' : 'gray'}>
                    {automation.enabled ? 'Enabled' : 'Paused'}
                  </Badge>
                </div>
                <div className="settings-definition-list">
                  <div>
                    <dt>Next run</dt>
                    <dd>{automation.nextRunAt ?? 'Manual only'}</dd>
                  </div>
                  <div>
                    <dt>Last run</dt>
                    <dd>{automation.lastRunAt ?? 'Never'}</dd>
                  </div>
                </div>
                <div className="resource-editor-actions">
                  <Button
                    variant="secondary"
                    loading={busy}
                    onClick={() => void action(automation.automationId, 'trigger')}
                  >
                    Run now
                  </Button>
                  <Button
                    variant="tertiary"
                    loading={busy}
                    onClick={() =>
                      void action(automation.automationId, automation.enabled ? 'pause' : 'resume')
                    }
                  >
                    {automation.enabled ? 'Pause' : 'Resume'}
                  </Button>
                  {automation.trigger.type === 'webhook' && (
                    <Button
                      variant="tertiary"
                      loading={busy}
                      onClick={() => void fireWebhook(automation.automationId)}
                    >
                      Test webhook
                    </Button>
                  )}
                  <Button
                    variant="tertiary"
                    loading={busy}
                    onClick={() => void backfill(automation.automationId)}
                  >
                    Backfill one run
                  </Button>
                </div>
                {automation.trigger.type === 'webhook' && (
                  <div className="resource-editor-grid">
                    <Field label="Test payload">
                      <Textarea
                        value={webhookPayload}
                        onChange={(event) => setWebhookPayload(event.target.value)}
                        rows={4}
                      />
                    </Field>
                    <Field label="HMAC signature" hint="sha256=<hex digest>">
                      <Input
                        value={webhookSignature}
                        onChange={(event) => setWebhookSignature(event.target.value)}
                        placeholder="sha256=…"
                      />
                    </Field>
                  </div>
                )}
                {(data?.runs ?? [])
                  .filter((run) => run.automationId === automation.automationId)
                  .slice(-3)
                  .map((run) => (
                    <div className="home-list-button" key={run.runId}>
                      <span>{run.startedAt}</span>
                      <Badge
                        color={
                          run.status === 'completed'
                            ? 'green'
                            : run.status === 'failed'
                              ? 'red'
                              : 'amber'
                        }
                      >
                        {run.status}
                      </Badge>
                    </div>
                  ))}
              </Card>
            ))}
            {(data?.automations ?? []).length === 0 && (
              <div className="home-state">No automations yet.</div>
            )}
          </div>
        </div>
      </div>
    </CapabilityGate>
  );
}
