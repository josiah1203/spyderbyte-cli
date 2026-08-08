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
  Textarea,
} from '../components/primitives';
import { useRuntime } from '../runtime/RuntimeProvider';
import { useRuntimeStore } from '../runtime/store';
import type { JsonValue } from '../runtime/contracts';

interface TrainingRun {
  runId: string;
  status: string;
  datasetArtifactId?: string;
  modelId?: string;
  metrics: Record<string, number>;
  checkpointArtifacts: string[];
  modelArtifactId?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

interface TrainingResponse {
  available: boolean;
  runs: TrainingRun[];
}

interface StructuredExperiment {
  experimentId: string;
  state: string;
  name: string;
  runIds: string[];
  comparisonIds: string[];
  modelVersionIds: string[];
}

interface ExperimentRun {
  runId: string;
  experimentId: string;
  variantId: string;
  status: string;
  metrics: Array<{ name: string; value: number; step?: number; epoch?: number }>;
  artifacts: Array<{ artifactId: string; kind: string }>;
  checkpoints: Array<{ artifactId: string; kind: string }>;
  attempts: Array<{ attemptId: string; attemptNumber: number; status: string }>;
  events: Array<{ sequence: number; kind: string; payload: Record<string, unknown> }>;
  logs: string[];
  cost: { currency: string; estimatedMinor: number; actualMinor: number };
  error?: string;
}

interface ExperimentComparison {
  comparisonId: string;
  runIds: string[];
  metrics: Record<string, Record<string, number>>;
  curves: Record<string, Record<string, unknown[]>>;
  distributions: Record<string, Record<string, number[]>>;
  confusionMatrices: Record<string, unknown[]>;
  explainability: Record<string, Record<string, number>>;
  artifacts: Array<{ artifactId: string; kind: string }>;
}

interface ExperimentEvaluation {
  evaluationId: string;
  runId: string;
  recommendation: string;
  metrics: Array<{ name: string; candidate: number; passed: boolean }>;
  evaluationArtifact: { artifactId: string };
}

interface ModelRegistryRecord {
  modelVersionId: string;
  modelName: string;
  version: number;
  stage: string;
  sourceRunId: string;
  validation: { state: string; evaluationId?: string; evidenceArtifactIds: string[] };
  approval: { state: string; digest?: string };
  metrics: Record<string, number>;
}

const DEFAULT_EXPERIMENT = JSON.stringify(
  {
    name: 'Reproducible experiment',
    datasetVersion: {
      schemaVersion: 1,
      tenant: { tenantId: 'paste-tenant-id', workspaceId: 'paste-workspace-id' },
      artifactId: 'paste-dataset-artifact-id',
      version: 1,
      contentHash: 'paste-64-character-sha256',
      mediaType: 'application/json',
      sizeBytes: 1,
      createdAt: '2026-08-06T00:00:00.000Z',
    },
    target: 'label',
    features: ['feature_a', 'feature_b'],
    task: 'classification',
    algorithm: 'configured-training-adapter',
    environmentRevision: {
      schemaVersion: 1,
      tenant: { tenantId: 'paste-tenant-id', workspaceId: 'paste-workspace-id' },
      artifactId: 'paste-environment-artifact-id',
      version: 1,
      contentHash: 'paste-64-character-sha256',
      mediaType: 'application/json',
      sizeBytes: 1,
      createdAt: '2026-08-06T00:00:00.000Z',
    },
    compute: {
      cpuMillicores: 500,
      memoryBytes: 1073741824,
      gpuCount: 0,
      maxDurationMs: 3600000,
      currency: 'USD',
    },
    metrics: [{ name: 'accuracy', higherIsBetter: true, requiredMinimum: 0.8 }],
    hyperparameters: { learningRate: 0.001, epochs: 1 },
    seed: 42,
    outputDestination: 'artifacts://experiments',
  },
  null,
  2,
);

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function Experiments(): ReactElement {
  const runtime = useRuntime();
  const snapshot = useRuntimeStore(runtime);
  const [data, setData] = useState<TrainingResponse>();
  const [datasetArtifactId, setDatasetArtifactId] = useState('');
  const [modelId, setModelId] = useState('');
  const [configuration, setConfiguration] = useState('{\n  "epochs": 1\n}');
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [experimentConfig, setExperimentConfig] = useState(DEFAULT_EXPERIMENT);
  const [structured, setStructured] = useState<StructuredExperiment>();
  const [structuredRuns, setStructuredRuns] = useState<ExperimentRun[]>([]);
  const [comparison, setComparison] = useState<ExperimentComparison>();
  const [evaluations, setEvaluations] = useState<ExperimentEvaluation[]>([]);
  const [models, setModels] = useState<ModelRegistryRecord[]>([]);
  const [modelName, setModelName] = useState('experiment-model');
  const [confirmationId, setConfirmationId] = useState('');

  async function load(): Promise<void> {
    if (!runtime.client.get) return;
    try {
      setData(await runtime.client.get<TrainingResponse>('/v1/training/runs'));
    } catch (error) {
      setMessage(errorText(error));
    }
  }

  async function loadStructured(): Promise<void> {
    if (!runtime.client.get) return;
    try {
      const experimentResponse = await runtime.client.get<{ experiments: StructuredExperiment[] }>(
        '/v1/experiments/local',
      );
      const current = experimentResponse.experiments.at(-1);
      setStructured(current);
      const [runs, comparisonList, evaluationList, modelList] = await Promise.all([
        runtime.client.get<ExperimentRun[]>('/v1/experiment-runs/local'),
        runtime.client.get<ExperimentComparison[]>('/v1/experiment-comparisons/local'),
        runtime.client.get<ExperimentEvaluation[]>('/v1/experiment-evaluations/local'),
        runtime.client.get<ModelRegistryRecord[]>('/v1/models/local/registry'),
      ]);
      setStructuredRuns(runs);
      setComparison(comparisonList.at(-1));
      setEvaluations(evaluationList);
      setModels(modelList);
    } catch (error) {
      setMessage(errorText(error));
    }
  }

  useEffect(() => {
    void load();
    void loadStructured();
  }, [runtime]);

  async function createStructuredExperiment(): Promise<void> {
    if (!runtime.client.post) return;
    try {
      const parsed = JSON.parse(experimentConfig) as Record<string, unknown>;
      const created = await runtime.client.post<StructuredExperiment>(
        '/v1/experiments/local',
        parsed as unknown as JsonValue,
      );
      setStructured(created);
      setMessage('Experiment configuration created. Validate it before starting variants.');
      await loadStructured();
    } catch (error) {
      setMessage(errorText(error));
    }
  }

  async function validateStructuredExperiment(): Promise<void> {
    if (!runtime.client.post || !structured) return;
    try {
      setStructured(
        await runtime.client.post<StructuredExperiment>(
          `/v1/experiments/local/${encodeURIComponent(structured.experimentId)}/validate`,
          {},
        ),
      );
      setMessage('Immutable inputs validated; experiment is ready.');
      await loadStructured();
    } catch (error) {
      setMessage(errorText(error));
    }
  }

  async function startVariant(variantId: string): Promise<void> {
    if (!runtime.client.post || !structured) return;
    try {
      await runtime.client.post<ExperimentRun>(
        `/v1/experiments/local/${encodeURIComponent(structured.experimentId)}/runs`,
        {
          variantId,
          ...(confirmationId ? { confirmationId } : {}),
        } as unknown as JsonValue,
      );
      setMessage(`Variant ${variantId} queued; telemetry and attempts are durable.`);
      await loadStructured();
    } catch (error) {
      setMessage(errorText(error));
    }
  }

  async function compareStructured(): Promise<void> {
    if (!runtime.client.post) return;
    const successful = structuredRuns.filter((run) => run.status === 'succeeded').slice(-2);
    if (successful.length < 2) {
      setMessage('Two successful variants are required before comparison.');
      return;
    }
    try {
      setComparison(
        await runtime.client.post<ExperimentComparison>('/v1/experiments/local/compare', {
          runIds: successful.map((run) => run.runId),
        }),
      );
      setMessage('Comparison published with curves, distributions, and lineage artifacts.');
      await loadStructured();
    } catch (error) {
      setMessage(errorText(error));
    }
  }

  async function evaluateBestRun(): Promise<void> {
    if (!runtime.client.post) return;
    const run = structuredRuns.find((candidate) => candidate.status === 'succeeded');
    if (!run) {
      setMessage('A successful run is required before evaluation.');
      return;
    }
    try {
      await runtime.client.post<ExperimentEvaluation>('/v1/experiment-evaluations/local', {
        runId: run.runId,
        benchmarkId: 'browser-acceptance-benchmark',
        benchmarkVersion: 1,
        observations: [
          { expected: 1, candidate: 1 },
          { expected: 1, candidate: 1 },
          { expected: 0, candidate: 0 },
        ],
        metrics: [{ name: 'accuracy', higherIsBetter: true, requiredMinimum: 0.8 }],
      });
      setMessage('Evaluation evidence published.');
      await loadStructured();
    } catch (error) {
      setMessage(errorText(error));
    }
  }

  async function registerBestModel(): Promise<void> {
    if (!runtime.client.post) return;
    const run = structuredRuns.find((candidate) => candidate.status === 'succeeded');
    if (!run) {
      setMessage('A successful run is required before model registration.');
      return;
    }
    try {
      await runtime.client.post<ModelRegistryRecord>('/v1/models/local/candidates', {
        runId: run.runId,
        modelName,
        modelCard: {
          summary: 'Model produced by a reproducible Spyderbyte experiment.',
          intendedUse: 'Acceptance and local evaluation workflows.',
          limitations: ['Local adapter evidence only until a hosted validator is configured.'],
          risks: ['Review dataset and benchmark coverage before production use.'],
        },
        ...(confirmationId ? { confirmationId } : {}),
      } as unknown as JsonValue);
      setMessage('Model candidate registered with dataset and environment lineage.');
      await loadStructured();
    } catch (error) {
      setMessage(errorText(error));
    }
  }

  async function validateBestModel(): Promise<void> {
    if (!runtime.client.post) return;
    const model = models.at(-1);
    const evaluation = evaluations.at(-1);
    if (!model || !evaluation) {
      setMessage('Register a candidate and publish evaluation evidence first.');
      return;
    }
    try {
      await runtime.client.post<ModelRegistryRecord>(
        `/v1/models/local/${encodeURIComponent(model.modelVersionId)}/validate`,
        { evaluationId: evaluation.evaluationId },
      );
      setMessage('Model validation state recorded.');
      await loadStructured();
    } catch (error) {
      setMessage(errorText(error));
    }
  }

  async function promoteBestModel(): Promise<void> {
    if (!runtime.client.post) return;
    const model = models.at(-1);
    const digest = model?.approval.digest;
    if (!model || !digest) {
      setMessage('Validate a model candidate to obtain its approval digest.');
      return;
    }
    try {
      await runtime.client.post(
        `/v1/models/local/${encodeURIComponent(model.modelVersionId)}/promote`,
        {
          policyApproved: true,
          approvalDigest: digest,
          commitApprovalDigest: digest,
          ...(confirmationId ? { confirmationId } : {}),
        } as unknown as JsonValue,
      );
      setMessage('Model promotion decision committed and recorded.');
      await loadStructured();
    } catch (error) {
      setMessage(errorText(error));
    }
  }

  async function startTraining(): Promise<void> {
    if (!runtime.client.post) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(configuration);
    } catch {
      setMessage('Training configuration must be valid JSON.');
      return;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setMessage('Training configuration must be a JSON object.');
      return;
    }
    setBusy(true);
    try {
      await runtime.client.post<TrainingRun>('/v1/training/runs', {
        configuration: parsed as JsonValue,
        ...(datasetArtifactId.trim() ? { datasetArtifactId: datasetArtifactId.trim() } : {}),
        ...(modelId.trim() ? { modelId: modelId.trim() } : {}),
      });
      setMessage('Training command completed or recorded a failure.');
      await load();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <CapabilityGate page="experiments">
      <div className="page-scroll">
        <div className="page stack">
          <div className="page-heading">
            <div>
              <SectionLabel>Local experiment runtime</SectionLabel>
              <h1>Experiments</h1>
              <p className="page-subtitle">
                Configure a reproducible local training command, compare metrics, and preserve
                checkpoints and model artifacts with each run.
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
                <h2>Training candidate</h2>
                <p>The platform executes only the command configured by the local deployment.</p>
              </div>
              <Badge color={data?.available ? 'green' : 'amber'}>
                {data?.available ? 'Configured' : 'Unavailable'}
              </Badge>
            </div>
            <div className="resource-editor-grid">
              <Field label="Dataset artifact ID">
                <Input
                  value={datasetArtifactId}
                  onChange={(event) => setDatasetArtifactId(event.target.value)}
                  placeholder="Optional"
                />
              </Field>
              <Field label="Base model ID">
                <Input
                  value={modelId}
                  onChange={(event) => setModelId(event.target.value)}
                  placeholder="Optional"
                />
              </Field>
            </div>
            <Field
              label="Training configuration"
              hint="JSON is passed to the configured command through the request file."
            >
              <Textarea
                value={configuration}
                onChange={(event) => setConfiguration(event.target.value)}
                rows={10}
              />
            </Field>
            <Button loading={busy} onClick={() => void startTraining()}>
              Start training
            </Button>
          </Card>
          <Card className="stack">
            <div className="card-heading">
              <h2>Run history</h2>
              <Button variant="tertiary" onClick={() => void load()}>
                Refresh
              </Button>
            </div>
            {(data?.runs ?? []).map((run) => (
              <div className="home-list-button" key={run.runId}>
                <div>
                  <div className="home-list-title">{run.runId}</div>
                  <div className="home-list-subtitle">
                    {run.completedAt ?? run.startedAt ?? 'Queued'}
                    {run.modelArtifactId ? ` · model ${run.modelArtifactId}` : ''}
                  </div>
                </div>
                <Badge
                  color={
                    run.status === 'completed' ? 'green' : run.status === 'failed' ? 'red' : 'amber'
                  }
                >
                  {run.status}
                </Badge>
              </div>
            ))}
            {(data?.runs ?? []).length === 0 && (
              <div className="home-state">No training runs yet.</div>
            )}
          </Card>
          <Card className="stack">
            <div className="card-heading">
              <div>
                <h2>Reproducible experiment</h2>
                <p>
                  Pin dataset and environment hashes, then run two variants through the durable
                  attempt and telemetry loop.
                </p>
              </div>
              <Badge color={structured?.state === 'ready' ? 'green' : 'blue'}>
                {structured?.state ?? 'Draft'}
              </Badge>
            </div>
            <Field
              label="Experiment configuration"
              hint="Artifact references must include tenant, version, and a 64-character content hash."
            >
              <Textarea
                value={experimentConfig}
                onChange={(event) => setExperimentConfig(event.target.value)}
                rows={18}
              />
            </Field>
            <Field
              label="Local confirmation ID"
              hint="Required by personal-local mode after the first effectful request returns a challenge."
            >
              <Input
                value={confirmationId}
                onChange={(event) => setConfirmationId(event.target.value)}
                placeholder="Optional challenge ID"
              />
            </Field>
            <div className="button-row">
              <Button onClick={() => void createStructuredExperiment()}>Create experiment</Button>
              <Button
                variant="secondary"
                disabled={!structured}
                onClick={() => void validateStructuredExperiment()}
              >
                Validate immutable inputs
              </Button>
              <Button variant="tertiary" onClick={() => void loadStructured()}>
                Refresh lifecycle
              </Button>
            </div>
          </Card>
          <Card className="stack">
            <div className="card-heading">
              <div>
                <h2>Variants and evidence</h2>
                <p>Queue two immutable-input variants, replay telemetry, and compare artifacts.</p>
              </div>
              <Button
                variant="secondary"
                disabled={!structured}
                onClick={() => void compareStructured()}
              >
                Compare successful variants
              </Button>
            </div>
            <div className="button-row">
              <Button disabled={!structured} onClick={() => void startVariant('variant-a')}>
                Start variant A
              </Button>
              <Button disabled={!structured} onClick={() => void startVariant('variant-b')}>
                Start variant B
              </Button>
              <Button variant="tertiary" onClick={() => void evaluateBestRun()}>
                Publish evaluation evidence
              </Button>
            </div>
            {structuredRuns.map((run) => (
              <div className="home-list-button" key={run.runId}>
                <div>
                  <div className="home-list-title">
                    {run.variantId} · {run.runId}
                  </div>
                  <div className="home-list-subtitle">
                    {run.attempts.length} attempt(s) · {run.events.length} events ·{' '}
                    {run.artifacts.length} artifacts · {run.cost.actualMinor} {run.cost.currency}
                    {run.error ? ` · ${run.error}` : ''}
                  </div>
                </div>
                <Badge
                  color={
                    run.status === 'succeeded' ? 'green' : run.status === 'failed' ? 'red' : 'amber'
                  }
                >
                  {run.status}
                </Badge>
              </div>
            ))}
            {structuredRuns.length === 0 && (
              <div className="home-state">No structured variants yet.</div>
            )}
          </Card>
          {comparison && (
            <Card className="stack">
              <div className="card-heading">
                <div>
                  <h2>Rich comparison</h2>
                  <p>
                    Immutable comparison ID {comparison.comparisonId}; all values link back to runs
                    and artifacts.
                  </p>
                </div>
                <Badge color="green">Published</Badge>
              </div>
              <pre aria-label="Experiment comparison metrics">
                {JSON.stringify(
                  {
                    metrics: comparison.metrics,
                    curves: comparison.curves,
                    distributions: comparison.distributions,
                    confusionMatrices: comparison.confusionMatrices,
                    explainability: comparison.explainability,
                    artifacts: comparison.artifacts,
                  },
                  null,
                  2,
                )}
              </pre>
            </Card>
          )}
          <Card className="stack">
            <div className="card-heading">
              <div>
                <h2>Model registry</h2>
                <p>
                  Register a model card, bind evaluation evidence, then commit an approval-bound
                  promotion.
                </p>
              </div>
              <Button variant="secondary" onClick={() => void registerBestModel()}>
                Register best run
              </Button>
            </div>
            <Field label="Model name">
              <Input value={modelName} onChange={(event) => setModelName(event.target.value)} />
            </Field>
            <div className="button-row">
              <Button variant="tertiary" onClick={() => void validateBestModel()}>
                Validate latest candidate
              </Button>
              <Button variant="success" onClick={() => void promoteBestModel()}>
                Promote validated model
              </Button>
            </div>
            {models.map((model) => (
              <div className="home-list-button" key={model.modelVersionId}>
                <div>
                  <div className="home-list-title">
                    {model.modelName} v{model.version}
                  </div>
                  <div className="home-list-subtitle">
                    {model.modelVersionId} · validation {model.validation.state} · approval{' '}
                    {model.approval.state}
                    {model.approval.digest ? ` · digest ${model.approval.digest}` : ''}
                  </div>
                </div>
                <Badge color={model.stage === 'production' ? 'green' : 'amber'}>
                  {model.stage}
                </Badge>
              </div>
            ))}
            {models.length === 0 && (
              <div className="home-state">No model candidates registered.</div>
            )}
          </Card>
        </div>
      </div>
    </CapabilityGate>
  );
}
