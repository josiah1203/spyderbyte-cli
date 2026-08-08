import { useMemo, useState } from 'react';
import { Badge, Card, ProgressBar, SectionLabel, StatusDot } from '../components/primitives';
import Icon from '../components/icons';
import RuntimeStateNotice from '../components/RuntimeStateNotice';
import { useRuntime } from '../runtime/RuntimeProvider';
import { useMachine, useRuntimeStore } from '../runtime/store';

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export default function Machine() {
  const runtime = useRuntime();
  const snapshot = useRuntimeStore(runtime);
  const { data, state } = useMachine(runtime);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const latest = record(record(data?.observations).latest);
  const telemetry = useMemo(
    () => [
      {
        label: 'CPU',
        key: 'cpuPercent',
        detail: 'Observed CPU utilization for available compute capacity',
        icon: 'cpu' as const,
      },
      {
        label: 'Memory',
        key: 'memoryPercent',
        detail: 'Observed memory utilization for available compute capacity',
        icon: 'memory' as const,
      },
      {
        label: 'Storage',
        key: 'storagePercent',
        detail: 'Observed storage utilization for available compute capacity',
        icon: 'storage' as const,
      },
    ],
    [],
  );

  return (
    <div className="page-scroll">
      <div className="page stack">
        <RuntimeStateNotice state={snapshot.connection} onRetry={() => void runtime.retry()} />
        <Card className="machine-status">
          <StatusDot color={state === 'connected' ? 'green' : 'amber'} />
          <span>
            {state === 'connected'
              ? 'Compute telemetry is sourced from the platform.'
              : 'Compute telemetry is unavailable until the platform reports compute capacity.'}
          </span>
        </Card>
        <section>
          <SectionLabel>Observed hardware</SectionLabel>
          <div className="machine-grid">
            {telemetry.map((item) => {
              const value =
                typeof latest[item.key] === 'number'
                  ? Math.round(latest[item.key] as number)
                  : undefined;
              return (
                <Card key={item.label}>
                  <div className="machine-card-header">
                    <div className="machine-card-label">
                      <Icon name={item.icon} size={20} tone="secondary" />
                      <div>
                        <div className="machine-card-title">{item.label}</div>
                        <div className="machine-card-detail">{item.detail}</div>
                      </div>
                    </div>
                    <strong>{value === undefined ? '—' : `${value}%`}</strong>
                  </div>
                  {value === undefined ? (
                    <div className="machine-card-detail">
                      Unavailable — no sensor observation was emitted.
                    </div>
                  ) : (
                    <ProgressBar value={value} tone="info" />
                  )}
                </Card>
              );
            })}
          </div>
        </section>
        <section>
          <SectionLabel>Platform service</SectionLabel>
          <Card>
            <div className="machine-runtime">
              <div>
                <div className="machine-runtime-title">
                  Platform service{' '}
                  <Badge color={state === 'connected' ? 'green' : 'amber'}>{state}</Badge>
                </div>
                <div className="machine-card-detail">
                  Execution and service identity are reported by the platform deployment.
                </div>
              </div>
              <Icon name="monitor" tone="secondary" />
            </div>
          </Card>
        </section>
        <section>
          <SectionLabel>Model cache</SectionLabel>
          <Card className="machine-unavailable">
            Model cache inventory is unavailable until model management is enabled for this
            platform.
          </Card>
        </section>
        <section>
          <button
            className="disclosure-trigger"
            type="button"
            aria-expanded={diagnosticsOpen}
            onClick={() => setDiagnosticsOpen((open) => !open)}
          >
            <SectionLabel>Diagnostics</SectionLabel>
            <Icon
              name={diagnosticsOpen ? 'chevron-up' : 'chevron-down'}
              size={18}
              tone="secondary"
              aria-hidden="true"
            />
          </button>
          {diagnosticsOpen && (
            <Card className="disclosure-panel">
              Diagnostics are read-only until the platform exposes a diagnostic command. No
              synthetic values are shown.
            </Card>
          )}
        </section>
      </div>
    </div>
  );
}
