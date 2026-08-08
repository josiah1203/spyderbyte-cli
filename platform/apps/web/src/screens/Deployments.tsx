import { useEffect, useState, type ReactElement } from 'react';
import type { JsonValue } from '@agentic-platform/runtime-contracts';
import CapabilityGate from '../components/CapabilityGate';
import RuntimeStateNotice from '../components/RuntimeStateNotice';
import { Badge, Button, Card, Field, Input, SectionLabel } from '../components/primitives';
import { useRuntime } from '../runtime/RuntimeProvider';
import { useRuntimeStore } from '../runtime/store';

interface Deployment {
  deploymentId: string;
  modelId: string;
  modelArtifactId?: string;
  modelVersionId?: string;
  endpointId?: string;
  revisionId?: string;
  servingRuntime?: string;
  region?: string;
  state: string;
  trafficPercent: number;
  port?: number;
  healthUrl?: string;
  healthCheckedAt?: string;
  healthEvidence?: { adapter?: string; statusCode?: number; responseMs?: number };
  metrics?: {
    requests: number;
    successes: number;
    errors: number;
    averageLatencyMs: number;
    healthChecks: number;
    healthFailures: number;
  };
  utilization?: { replicas?: number; cpuMillicores?: number; memoryBytes?: number };
  cost?: { currency: string; estimatedMinor: number; actualMinor: number };
  logs?: Array<{ sequence: number; stream: string; message: string; at: string }>;
  revisionHistory?: Array<{
    revisionId: string;
    modelVersionId?: string;
    state: string;
    trafficPercent: number;
  }>;
  approvalRequired?: boolean;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

interface DeploymentResponse {
  available: boolean;
  deployments: Deployment[];
  endpoints?: Array<{
    endpointId: string;
    name: string;
    state: string;
    activeDeploymentId?: string;
  }>;
}

function color(state: string): 'green' | 'amber' | 'red' | 'gray' {
  if (['active', 'healthy'].includes(state)) return 'green';
  if (
    ['starting', 'unhealthy', 'degraded', 'provisioning', 'deploying', 'updating'].includes(state)
  )
    return 'amber';
  if (state === 'failed') return 'red';
  return 'gray';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function Deployments(): ReactElement {
  const runtime = useRuntime();
  const snapshot = useRuntimeStore(runtime);
  const [data, setData] = useState<DeploymentResponse>();
  const [modelId, setModelId] = useState('local-model');
  const [modelArtifactId, setModelArtifactId] = useState('');
  const [modelVersionId, setModelVersionId] = useState('');
  const [servingRuntime, setServingRuntime] = useState('');
  const [region, setRegion] = useState('local');
  const [cpuMillicores, setCpuMillicores] = useState('500');
  const [gpuCount, setGpuCount] = useState('0');
  const [minReplicas, setMinReplicas] = useState('1');
  const [maxReplicas, setMaxReplicas] = useState('2');
  const [environmentJson, setEnvironmentJson] = useState('{}');
  const [secretRefs, setSecretRefs] = useState('');
  const [networkVisibility, setNetworkVisibility] = useState('loopback');
  const [authMode, setAuthMode] = useState('workspace');
  const [port, setPort] = useState('8000');
  const [healthUrl, setHealthUrl] = useState('http://127.0.0.1:8000/health');
  const [invokeUrl, setInvokeUrl] = useState('http://127.0.0.1:8000');
  const [canaryPercent, setCanaryPercent] = useState('10');
  const [approvalJson, setApprovalJson] = useState('');
  const [invokePayload, setInvokePayload] = useState('{"prompt":"hello"}');
  const [telemetry, setTelemetry] = useState<Record<string, unknown>>({});
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function load(): Promise<void> {
    if (!runtime.client.get) return;
    try {
      setData(await runtime.client.get<DeploymentResponse>('/v1/deployments/local'));
    } catch (error) {
      setMessage(errorText(error));
    }
  }

  useEffect(() => {
    void load();
  }, [runtime]);

  async function serve(): Promise<void> {
    if (!runtime.client.post) return;
    setBusy(true);
    try {
      await runtime.client.post('/v1/deployments/local/serve', {
        modelId: modelId.trim(),
        ...(modelArtifactId.trim() ? { modelArtifactId: modelArtifactId.trim() } : {}),
        ...(modelVersionId.trim() ? { modelVersionId: modelVersionId.trim() } : {}),
        ...(servingRuntime.trim() ? { servingRuntime: servingRuntime.trim() } : {}),
        ...(region.trim() ? { region: region.trim() } : {}),
        resources: { cpuMillicores: Number(cpuMillicores), gpuCount: Number(gpuCount) },
        scaling: { minReplicas: Number(minReplicas), maxReplicas: Number(maxReplicas) },
        environment: JSON.parse(environmentJson) as JsonValue,
        networkVisibility,
        auth: { mode: authMode },
        ...(secretRefs.trim()
          ? {
              secretRefs: secretRefs
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean),
            }
          : {}),
        ...(port.trim() ? { port: Number(port) } : {}),
        ...(healthUrl.trim() ? { healthUrl: healthUrl.trim() } : {}),
        ...(invokeUrl.trim() ? { invokeUrl: invokeUrl.trim() } : {}),
      });
      setMessage('Serving process started. Observe health before granting traffic.');
      await load();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function action(
    deploymentId: string,
    operation:
      | 'observe'
      | 'promote'
      | 'rollback'
      | 'canary'
      | 'update'
      | 'stop'
      | 'archive'
      | 'restart'
      | 'scale'
      | 'invoke'
      | 'smoke-test',
  ): Promise<void> {
    if (!runtime.client.post) return;
    setBusy(true);
    try {
      const approval = approvalJson.trim() ? (JSON.parse(approvalJson) as unknown) : undefined;
      const payload = (operation === 'canary'
        ? { trafficPercent: Number(canaryPercent), ...(approval === undefined ? {} : { approval }) }
        : operation === 'promote' || operation === 'rollback'
          ? approval === undefined
            ? {}
            : { approval }
          : operation === 'scale'
            ? { scaling: { minReplicas: Number(minReplicas), maxReplicas: Number(maxReplicas) } }
            : operation === 'invoke'
              ? { payload: JSON.parse(invokePayload) as unknown }
              : operation === 'update'
                ? {
                    ...(modelArtifactId.trim() ? { modelArtifactId: modelArtifactId.trim() } : {}),
                    ...(modelVersionId.trim() ? { modelVersionId: modelVersionId.trim() } : {}),
                  }
                : {}) as unknown as JsonValue;
      await runtime.client.post(
        `/v1/deployments/local/${encodeURIComponent(deploymentId)}/${operation}`,
        payload,
      );
      setMessage(`Deployment ${operation} completed.`);
      await load();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function loadTelemetry(
    deploymentId: string,
    kind: 'metrics' | 'logs' | 'revisions',
  ): Promise<void> {
    if (!runtime.client.get) return;
    try {
      const value = await runtime.client.get(
        `/v1/deployments/local/${encodeURIComponent(deploymentId)}/${kind}`,
      );
      setTelemetry((current) => ({ ...current, [`${deploymentId}:${kind}`]: value }));
    } catch (error) {
      setMessage(errorText(error));
    }
  }

  return (
    <CapabilityGate page="deployments">
      <div className="page-scroll">
        <div className="page stack">
          <div className="page-heading">
            <div>
              <SectionLabel>Model serving and delivery</SectionLabel>
              <h1>Deployments</h1>
              <p className="page-subtitle">
                Start the configured local serving command, observe a loopback health endpoint,
                grant canary traffic, promote, or roll back.
              </p>
            </div>
            <Badge color={data?.available ? 'green' : 'amber'}>
              {data?.available ? 'Runtime ready' : 'Runtime setup required'}
            </Badge>
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
                <h2>Start a deployment</h2>
                <p>The daemon runs only the executable configured by SPYDERBYTE_SERVE_COMMAND.</p>
              </div>
              <Button loading={busy} disabled={!data?.available} onClick={() => void serve()}>
                {data?.available ? 'Start serving' : 'Configure serving runtime'}
              </Button>
            </div>
            <div className="resource-editor-grid">
              <Field label="Model ID">
                <Input value={modelId} onChange={(event) => setModelId(event.target.value)} />
              </Field>
              <Field label="Model artifact ID" hint="Optional immutable model artifact reference.">
                <Input
                  value={modelArtifactId}
                  onChange={(event) => setModelArtifactId(event.target.value)}
                />
              </Field>
              <Field
                label="Promoted model version ID"
                hint="Required when deploying a registered production model."
              >
                <Input
                  value={modelVersionId}
                  onChange={(event) => setModelVersionId(event.target.value)}
                />
              </Field>
              <Field label="Serving runtime">
                <Input
                  placeholder="node, vllm, llama.cpp…"
                  value={servingRuntime}
                  onChange={(event) => setServingRuntime(event.target.value)}
                />
              </Field>
              <Field label="Region">
                <Input value={region} onChange={(event) => setRegion(event.target.value)} />
              </Field>
              <Field label="CPU (millicores)">
                <Input
                  type="number"
                  min="1"
                  value={cpuMillicores}
                  onChange={(event) => setCpuMillicores(event.target.value)}
                />
              </Field>
              <Field label="GPU count">
                <Input
                  type="number"
                  min="0"
                  value={gpuCount}
                  onChange={(event) => setGpuCount(event.target.value)}
                />
              </Field>
              <Field label="Scale min / max">
                <div className="inline-form">
                  <Input
                    type="number"
                    min="1"
                    value={minReplicas}
                    onChange={(event) => setMinReplicas(event.target.value)}
                  />
                  <Input
                    type="number"
                    min="1"
                    value={maxReplicas}
                    onChange={(event) => setMaxReplicas(event.target.value)}
                  />
                </div>
              </Field>
              <Field label="Environment JSON">
                <Input
                  value={environmentJson}
                  onChange={(event) => setEnvironmentJson(event.target.value)}
                />
              </Field>
              <Field
                label="Secret references"
                hint="Comma-separated references only; values never leave the device."
              >
                <Input value={secretRefs} onChange={(event) => setSecretRefs(event.target.value)} />
              </Field>
              <Field label="Network visibility">
                <Input
                  value={networkVisibility}
                  onChange={(event) => setNetworkVisibility(event.target.value)}
                />
              </Field>
              <Field label="Auth mode">
                <Input value={authMode} onChange={(event) => setAuthMode(event.target.value)} />
              </Field>
              <Field label="Port">
                <Input
                  type="number"
                  min="1024"
                  max="65535"
                  value={port}
                  onChange={(event) => setPort(event.target.value)}
                />
              </Field>
              <Field label="Loopback health URL">
                <Input value={healthUrl} onChange={(event) => setHealthUrl(event.target.value)} />
              </Field>
              <Field label="Loopback invoke URL">
                <Input value={invokeUrl} onChange={(event) => setInvokeUrl(event.target.value)} />
              </Field>
              <Field
                label="Approval JSON"
                hint="Required for canary, promote, and rollback on rich deployments."
              >
                <Input
                  value={approvalJson}
                  onChange={(event) => setApprovalJson(event.target.value)}
                />
              </Field>
              <Field label="Invocation payload">
                <Input
                  value={invokePayload}
                  onChange={(event) => setInvokePayload(event.target.value)}
                />
              </Field>
            </div>
          </Card>
          <div className="stack">
            {(data?.deployments ?? []).map((deployment) => (
              <Card className="stack" key={deployment.deploymentId}>
                <div className="card-heading">
                  <div>
                    <h2>{deployment.modelId}</h2>
                    <p>{deployment.deploymentId}</p>
                  </div>
                  <Badge color={color(deployment.state)}>{deployment.state}</Badge>
                </div>
                <div className="settings-definition-list">
                  <div>
                    <dt>Traffic</dt>
                    <dd>{deployment.trafficPercent}%</dd>
                  </div>
                  <div>
                    <dt>Model version</dt>
                    <dd>{deployment.modelVersionId ?? deployment.modelArtifactId ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>Endpoint / revision</dt>
                    <dd>
                      {deployment.endpointId ?? '—'} / {deployment.revisionId ?? '—'}
                    </dd>
                  </div>
                  <div>
                    <dt>Port</dt>
                    <dd>{deployment.port ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>Health checked</dt>
                    <dd>{deployment.healthCheckedAt ?? 'Not checked'}</dd>
                  </div>
                  <div>
                    <dt>Updated</dt>
                    <dd>{deployment.updatedAt}</dd>
                  </div>
                </div>
                {deployment.metrics && (
                  <div className="settings-definition-list">
                    <div>
                      <dt>Requests</dt>
                      <dd>
                        {deployment.metrics.requests} ({deployment.metrics.errors} errors)
                      </dd>
                    </div>
                    <div>
                      <dt>Avg latency</dt>
                      <dd>{Math.round(deployment.metrics.averageLatencyMs)} ms</dd>
                    </div>
                    <div>
                      <dt>Health evidence</dt>
                      <dd>
                        {deployment.healthEvidence
                          ? `${deployment.healthEvidence.adapter} / ${deployment.healthEvidence.statusCode}`
                          : 'Not established'}
                      </dd>
                    </div>
                    <div>
                      <dt>Cost</dt>
                      <dd>
                        {deployment.cost
                          ? `${deployment.cost.currency} ${deployment.cost.actualMinor}`
                          : '—'}
                      </dd>
                    </div>
                  </div>
                )}
                {deployment.error && (
                  <div className="home-error" data-tone="danger">
                    {deployment.error}
                  </div>
                )}
                <div className="resource-editor-actions">
                  <Button
                    variant="secondary"
                    loading={busy}
                    onClick={() => void action(deployment.deploymentId, 'observe')}
                  >
                    Observe health
                  </Button>
                  <Field label="Canary %">
                    <Input
                      type="number"
                      min="1"
                      max="99"
                      value={canaryPercent}
                      onChange={(event) => setCanaryPercent(event.target.value)}
                    />
                  </Field>
                  <Button
                    variant="tertiary"
                    loading={busy}
                    onClick={() => void action(deployment.deploymentId, 'canary')}
                  >
                    Grant canary
                  </Button>
                  <Button
                    variant="tertiary"
                    loading={busy}
                    onClick={() => void action(deployment.deploymentId, 'promote')}
                  >
                    Promote 100%
                  </Button>
                  <Button
                    variant="tertiary"
                    loading={busy}
                    onClick={() => void action(deployment.deploymentId, 'rollback')}
                  >
                    Rollback
                  </Button>
                  <Button
                    variant="tertiary"
                    loading={busy}
                    onClick={() => void action(deployment.deploymentId, 'update')}
                  >
                    Rolling update
                  </Button>
                  <Button
                    variant="tertiary"
                    loading={busy}
                    onClick={() => void action(deployment.deploymentId, 'invoke')}
                  >
                    Invoke
                  </Button>
                  <Button
                    variant="tertiary"
                    loading={busy}
                    onClick={() => void action(deployment.deploymentId, 'smoke-test')}
                  >
                    Smoke test
                  </Button>
                  <Button
                    variant="tertiary"
                    loading={busy}
                    onClick={() => void action(deployment.deploymentId, 'stop')}
                  >
                    Stop
                  </Button>
                  <Button
                    variant="tertiary"
                    loading={busy}
                    onClick={() => void action(deployment.deploymentId, 'archive')}
                  >
                    Archive
                  </Button>
                  <Button
                    variant="tertiary"
                    loading={busy}
                    onClick={() => void action(deployment.deploymentId, 'restart')}
                  >
                    Restart
                  </Button>
                  <Button
                    variant="tertiary"
                    loading={busy}
                    onClick={() => void action(deployment.deploymentId, 'scale')}
                  >
                    Scale 1–2
                  </Button>
                  <Button
                    variant="secondary"
                    loading={busy}
                    onClick={() => void loadTelemetry(deployment.deploymentId, 'metrics')}
                  >
                    Metrics
                  </Button>
                  <Button
                    variant="secondary"
                    loading={busy}
                    onClick={() => void loadTelemetry(deployment.deploymentId, 'logs')}
                  >
                    Logs
                  </Button>
                  <Button
                    variant="secondary"
                    loading={busy}
                    onClick={() => void loadTelemetry(deployment.deploymentId, 'revisions')}
                  >
                    Revisions
                  </Button>
                </div>
                {(['metrics', 'logs', 'revisions'] as const).map((kind) => {
                  const value = telemetry[`${deployment.deploymentId}:${kind}`];
                  return value === undefined ? null : (
                    <pre key={kind} className="code-block">
                      {JSON.stringify(value, null, 2)}
                    </pre>
                  );
                })}
              </Card>
            ))}
            {(data?.deployments ?? []).length === 0 && (
              <div className="home-state">No local deployments yet.</div>
            )}
          </div>
        </div>
      </div>
    </CapabilityGate>
  );
}
