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

type StageType =
  | 'query'
  | 'sql'
  | 'python'
  | 'notebook'
  | 'connector'
  | 'inference'
  | 'training'
  | 'evaluation'
  | 'visualization'
  | 'artifact-transformation'
  | 'approval'
  | 'condition'
  | 'notification'
  | 'deployment';

interface PipelineStage {
  stageId: string;
  label: string;
  type: StageType;
  dependsOn: string[];
  config: Record<string, unknown>;
  retryPolicy?: { maxAttempts: number; backoffMs: number; maxBackoffMs: number };
  cache?: boolean;
}

interface PipelineDefinition {
  schemaVersion: 1;
  pipelineId: string;
  name: string;
  version: number;
  stages: PipelineStage[];
  createdAt: string;
  updatedAt: string;
  publishedVersion?: number;
  publishedAt?: string;
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
  executionOrder: string[];
}

interface PipelineRun {
  runId: string;
  pipelineId: string;
  status: string;
  version: number;
  stageResults: Array<{
    stageId: string;
    status: string;
    cacheHit?: boolean;
    output?: unknown;
    error?: string;
  }>;
  artifacts: string[];
  nodeLogs: Array<{ stageId: string; level: string; message: string; occurredAt: string }>;
  usage: { durationMs: number; costMinor: number; resourceUsage: Record<string, number> };
  error?: string;
}

interface PipelineEstimate {
  durationMs: number;
  costMinor: number;
  stages: Array<{ stageId: string; durationMs: number; costMinor: number }>;
}

const PIPELINE_ID = 'individual-workbench';

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function Pipelines(): ReactElement {
  const runtime = useRuntime();
  const snapshot = useRuntimeStore(runtime);
  const [pipeline, setPipeline] = useState<PipelineDefinition>();
  const [validation, setValidation] = useState<ValidationResult>();
  const [run, setRun] = useState<PipelineRun>();
  const [estimate, setEstimate] = useState<PipelineEstimate>();
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function load(): Promise<void> {
    if (!runtime.client.get || !runtime.client.post) return;
    try {
      try {
        setPipeline(
          await runtime.client.get<PipelineDefinition>(`/v1/pipelines/local/${PIPELINE_ID}`),
        );
      } catch {
        setPipeline(
          await runtime.client.post<PipelineDefinition>('/v1/pipelines/local', {
            pipelineId: PIPELINE_ID,
            name: 'Individual workbench pipeline',
          }),
        );
      }
    } catch (error) {
      setMessage(messageFor(error));
    }
  }

  useEffect(() => {
    void load();
  }, [runtime]);

  function updateStage(stageId: string, patch: Partial<PipelineStage>): void {
    setPipeline((current) =>
      current === undefined
        ? current
        : {
            ...current,
            stages: current.stages.map((stage) =>
              stage.stageId === stageId ? { ...stage, ...patch } : stage,
            ),
          },
    );
  }

  function updateStageConfig(stageId: string, key: string, value: string): void {
    setPipeline((current) =>
      current === undefined
        ? current
        : {
            ...current,
            stages: current.stages.map((stage) =>
              stage.stageId === stageId
                ? { ...stage, config: { ...stage.config, [key]: value } }
                : stage,
            ),
          },
    );
  }

  function addStage(type: StageType): void {
    setPipeline((current) => {
      if (current === undefined) return current;
      const stageId = `${type}-${current.stages.length + 1}`;
      const previous = current.stages.at(-1)?.stageId;
      return {
        ...current,
        stages: [
          ...current.stages,
          {
            stageId,
            label: type[0]?.toUpperCase() + type.slice(1),
            type,
            dependsOn: previous ? [previous] : [],
            config:
              type === 'query' || type === 'sql'
                ? { sql: 'SELECT 1 AS ready' }
                : type === 'python'
                  ? { source: 'print("ready")' }
                  : {},
          },
        ],
      };
    });
  }

  async function save(): Promise<void> {
    if (!pipeline || !runtime.client.post) return;
    setBusy(true);
    try {
      const saved = await runtime.client.post<PipelineDefinition>(
        `/v1/pipelines/local/${encodeURIComponent(pipeline.pipelineId)}`,
        { definition: pipeline as unknown as JsonValue },
      );
      setPipeline(saved);
      setMessage('Pipeline saved as a versioned local definition.');
    } catch (error) {
      setMessage(messageFor(error));
    } finally {
      setBusy(false);
    }
  }

  async function validate(): Promise<void> {
    if (!pipeline || !runtime.client.post) return;
    setBusy(true);
    try {
      setValidation(
        await runtime.client.post<ValidationResult>(
          `/v1/pipelines/local/${encodeURIComponent(pipeline.pipelineId)}/validate`,
          {},
        ),
      );
      setMessage('Pipeline validation completed.');
    } catch (error) {
      setMessage(messageFor(error));
    } finally {
      setBusy(false);
    }
  }

  async function execute(): Promise<void> {
    if (!pipeline || !runtime.client.post) return;
    setBusy(true);
    try {
      setRun(
        await runtime.client.post<PipelineRun>(
          `/v1/pipelines/local/${encodeURIComponent(pipeline.pipelineId)}/run`,
          {},
        ),
      );
      setMessage('Pipeline run completed or reached its first approval/runtime boundary.');
    } catch (error) {
      setMessage(messageFor(error));
    } finally {
      setBusy(false);
    }
  }

  async function publish(): Promise<void> {
    if (!pipeline || !runtime.client.post) return;
    setBusy(true);
    try {
      const published = await runtime.client.post<PipelineDefinition>(
        `/v1/pipelines/local/${encodeURIComponent(pipeline.pipelineId)}/publish`,
        {},
      );
      setPipeline(published);
      setMessage(`Published pipeline version ${published.publishedVersion ?? published.version}.`);
    } catch (error) {
      setMessage(messageFor(error));
    } finally {
      setBusy(false);
    }
  }

  async function dryRun(): Promise<void> {
    if (!pipeline || !runtime.client.post) return;
    setBusy(true);
    try {
      setRun(
        await runtime.client.post<PipelineRun>(
          `/v1/pipelines/local/${encodeURIComponent(pipeline.pipelineId)}/dry-run`,
          {},
        ),
      );
      setMessage('Dry-run completed without executing effectful adapters.');
    } catch (error) {
      setMessage(messageFor(error));
    } finally {
      setBusy(false);
    }
  }

  async function calculateEstimate(): Promise<void> {
    if (!pipeline || !runtime.client.get) return;
    setBusy(true);
    try {
      setEstimate(
        await runtime.client.get<PipelineEstimate>(
          `/v1/pipelines/local/${encodeURIComponent(pipeline.pipelineId)}/estimate`,
        ),
      );
      setMessage('Pipeline estimate refreshed.');
    } catch (error) {
      setMessage(messageFor(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <CapabilityGate page="pipelines">
      <div className="page-scroll">
        <div className="page stack">
          <div className="page-heading">
            <div>
              <SectionLabel>Typed workflow builder</SectionLabel>
              <h1>Pipelines</h1>
              <p className="page-subtitle">
                Compose registered connector, SQL, Python, notebook, inference, training,
                evaluation, artifact, approval, notification, and deployment stages into a versioned
                local DAG. Every node exposes dependencies, retries, logs, cache state, artifacts,
                and usage.
              </p>
            </div>
            <div className="resource-editor-actions">
              <Button variant="secondary" loading={busy} onClick={() => void validate()}>
                Validate DAG
              </Button>
              <Button variant="secondary" loading={busy} onClick={() => void calculateEstimate()}>
                Estimate
              </Button>
              <Button variant="tertiary" loading={busy} onClick={() => void dryRun()}>
                Dry run
              </Button>
              <Button variant="tertiary" loading={busy} onClick={() => void publish()}>
                Publish
              </Button>
              <Button loading={busy} onClick={() => void execute()}>
                Run pipeline
              </Button>
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
                <h2>{pipeline?.name ?? 'Loading pipeline…'}</h2>
                <p>Pipeline ID: {pipeline?.pipelineId ?? PIPELINE_ID}</p>
              </div>
              <Button variant="tertiary" loading={busy} onClick={() => void save()}>
                Save version
              </Button>
            </div>
            <div className="resource-editor-actions">
              <Button variant="secondary" onClick={() => addStage('query')}>
                Add query stage
              </Button>
              <Button variant="secondary" onClick={() => addStage('python')}>
                Add Python stage
              </Button>
              <Button variant="secondary" onClick={() => addStage('notebook')}>
                Add notebook stage
              </Button>
              <Button variant="secondary" onClick={() => addStage('connector')}>
                Add connector stage
              </Button>
              <Button variant="secondary" onClick={() => addStage('approval')}>
                Add approval gate
              </Button>
              <Button variant="secondary" onClick={() => addStage('inference')}>
                Add inference stage
              </Button>
            </div>
          </Card>
          {pipeline?.stages.map((stage, index) => (
            <Card className="stack" key={stage.stageId}>
              <div className="card-heading">
                <div>
                  <SectionLabel>Stage {index + 1}</SectionLabel>
                  <h2>{stage.label}</h2>
                </div>
                <Badge color={stage.type === 'approval' ? 'amber' : 'blue'}>{stage.type}</Badge>
              </div>
              <div className="resource-editor-grid">
                <Field label="Stage label">
                  <Input
                    value={stage.label}
                    onChange={(event) => updateStage(stage.stageId, { label: event.target.value })}
                  />
                </Field>
                <Field label="Depends on" hint="Comma-separated stage IDs.">
                  <Input
                    value={stage.dependsOn.join(', ')}
                    onChange={(event) =>
                      updateStage(stage.stageId, {
                        dependsOn: event.target.value
                          .split(',')
                          .map((value) => value.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </Field>
              </div>
              {stage.type === 'query' && (
                <Field label="SQL">
                  <Textarea
                    value={String(stage.config['sql'] ?? '')}
                    onChange={(event) =>
                      updateStageConfig(stage.stageId, 'sql', event.target.value)
                    }
                    rows={5}
                  />
                </Field>
              )}
              {stage.type === 'sql' && (
                <Field label="SQL">
                  <Textarea
                    value={String(stage.config['sql'] ?? '')}
                    onChange={(event) =>
                      updateStageConfig(stage.stageId, 'sql', event.target.value)
                    }
                    rows={5}
                  />
                </Field>
              )}
              {stage.type === 'python' && (
                <Field label="Python source">
                  <Textarea
                    value={String(stage.config['source'] ?? '')}
                    onChange={(event) =>
                      updateStageConfig(stage.stageId, 'source', event.target.value)
                    }
                    rows={5}
                  />
                </Field>
              )}
              {stage.type === 'notebook' && (
                <div className="resource-editor-grid">
                  <Field label="Notebook ID">
                    <Input
                      value={String(stage.config['notebookId'] ?? '')}
                      onChange={(event) =>
                        updateStageConfig(stage.stageId, 'notebookId', event.target.value)
                      }
                    />
                  </Field>
                  <Field label="Cell ID">
                    <Input
                      value={String(stage.config['cellId'] ?? '')}
                      onChange={(event) =>
                        updateStageConfig(stage.stageId, 'cellId', event.target.value)
                      }
                    />
                  </Field>
                  <Field label="Cell type">
                    <Select
                      value={String(stage.config['type'] ?? 'python')}
                      onChange={(event) =>
                        updateStageConfig(stage.stageId, 'type', event.target.value)
                      }
                    >
                      <option value="python">Python</option>
                      <option value="sql">SQL</option>
                      <option value="markdown">Markdown</option>
                    </Select>
                  </Field>
                  <Field label="Source">
                    <Textarea
                      value={String(stage.config['source'] ?? '')}
                      onChange={(event) =>
                        updateStageConfig(stage.stageId, 'source', event.target.value)
                      }
                      rows={5}
                    />
                  </Field>
                </div>
              )}
              {stage.type === 'connector' && (
                <div className="home-error" role="note">
                  Connector stages are contract-ready and will fail closed until the signed Meltano
                  executor and a connection binding are configured.
                </div>
              )}
            </Card>
          ))}
          {validation && (
            <Card className="stack">
              <div className="card-heading">
                <h2>Validation</h2>
                <Badge color={validation.valid ? 'green' : 'red'}>
                  {validation.valid ? 'Valid' : 'Needs changes'}
                </Badge>
              </div>
              <p>{validation.executionOrder.join(' → ') || 'No stages yet.'}</p>
              {validation.errors.map((error) => (
                <div className="home-error" key={error}>
                  {error}
                </div>
              ))}
            </Card>
          )}
          {run && (
            <Card className="stack">
              <div className="card-heading">
                <h2>Latest run</h2>
                <Badge
                  color={
                    run.status === 'completed' ? 'green' : run.status === 'failed' ? 'red' : 'amber'
                  }
                >
                  {run.status}
                </Badge>
              </div>
              {run.stageResults.map((stageResult) => (
                <div className="home-list-button" key={stageResult.stageId}>
                  <span>
                    {stageResult.stageId}
                    {stageResult.cacheHit ? ' · cache hit' : ''}
                  </span>
                  <Badge
                    color={
                      stageResult.status === 'completed'
                        ? 'green'
                        : stageResult.status === 'failed'
                          ? 'red'
                          : 'gray'
                    }
                  >
                    {stageResult.status}
                  </Badge>
                </div>
              ))}
              <p className="settings-copy">
                Duration {run.usage.durationMs} ms · Cost {run.usage.costMinor} minor units ·{' '}
                {run.artifacts.length} artifact(s) · {run.nodeLogs.length} node log(s)
              </p>
              {run.error && <div className="home-error">{run.error}</div>}
            </Card>
          )}
          {estimate && (
            <Card className="stack">
              <div className="card-heading">
                <h2>Execution estimate</h2>
                <Badge color="blue">Version {pipeline?.version ?? '—'}</Badge>
              </div>
              <p className="settings-copy">
                {estimate.durationMs} ms · {estimate.costMinor} minor cost units
              </p>
            </Card>
          )}
        </div>
      </div>
    </CapabilityGate>
  );
}
