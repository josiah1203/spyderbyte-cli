import { useCallback, useEffect, useState, type ReactElement } from 'react';
import CapabilityGate from '../components/CapabilityGate';
import RuntimeStateNotice from '../components/RuntimeStateNotice';
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  SectionLabel,
  type DataTableColumn,
} from '../components/primitives';
import { useRuntime } from '../runtime/RuntimeProvider';
import { useRuntimeStore } from '../runtime/store';

type Value = Record<string, unknown>;

function value(value: unknown): Value {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Value)
    : {};
}

export default function Usage(): ReactElement {
  const runtime = useRuntime();
  const snapshot = useRuntimeStore(runtime);
  const [usage, setUsage] = useState<Value>();
  const [forecast, setForecast] = useState<Value>();
  const [alerts, setAlerts] = useState<Value[]>([]);
  const [message, setMessage] = useState<string>();

  const load = useCallback(async (): Promise<void> => {
    if (runtime.client.get === undefined) return;
    try {
      const organizations = await runtime.client.get<{ organizations?: Value[] }>(
        '/v1/governance/organizations',
      );
      const organizationId = String(organizations.organizations?.[0]?.organizationId ?? '');
      if (!organizationId) {
        setUsage(undefined);
        setForecast(undefined);
        setAlerts([]);
        return;
      }
      const prefix = `/v1/governance/organizations/${encodeURIComponent(organizationId)}`;
      const [usageResponse, forecastResponse, alertResponse] = await Promise.all([
        runtime.client.get<Value>(`${prefix}/usage`),
        runtime.client.get<Value>(`${prefix}/forecast`),
        runtime.client.get<{ alerts?: Value[] }>(`${prefix}/alerts`),
      ]);
      setUsage(usageResponse);
      setForecast(forecastResponse);
      setAlerts(alertResponse.alerts ?? []);
      setMessage(undefined);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [runtime]);

  useEffect(() => {
    void load();
  }, [load, snapshot.cursor]);

  const byCategory = value(usage?.byCategory);
  const rows = Object.entries(byCategory).map(([category, amountMinor]) => ({
    category,
    amountMinor,
  }));
  const columns: DataTableColumn<{ category: string; amountMinor: unknown }>[] = [
    { key: 'category', header: 'Category', render: (item) => item.category },
    {
      key: 'amount',
      header: 'Attributed spend',
      render: (item) => `${String(item.amountMinor)} ${String(usage?.currency ?? 'USD')}`,
    },
  ];
  const thresholdState = String(forecast?.thresholdState ?? 'within_budget');

  return (
    <CapabilityGate page="usage">
      <div className="page-scroll">
        <div className="page stack">
          <div className="page-heading">
            <div>
              <SectionLabel>Spend and capacity</SectionLabel>
              <h1>Usage</h1>
              <p className="page-subtitle">
                Track attributed usage by category, forecast against thresholds, and review blocked
                spend.
              </p>
            </div>
            <Button variant="secondary" onClick={() => void load()}>
              Refresh
            </Button>
          </div>
          {message && (
            <div className="home-error" role="status">
              {message}
            </div>
          )}
          <RuntimeStateNotice state={snapshot.connection} onRetry={() => void runtime.retry()} />
          {!usage ? (
            <EmptyState
              icon="chart"
              title="No organization usage"
              description="Usage appears after an organization workspace records governed execution cost."
            />
          ) : (
            <>
              <div className="detail-grid">
                <Card>
                  <SectionLabel>Consumed</SectionLabel>
                  <h2>
                    {String(usage.consumedMinor ?? 0)} {String(usage.currency ?? 'USD')}
                  </h2>
                  <p className="page-subtitle">Current 30-day period</p>
                </Card>
                <Card>
                  <SectionLabel>Projected</SectionLabel>
                  <h2>
                    {String(forecast?.projectedMinor ?? 0)} {String(usage.currency ?? 'USD')}
                  </h2>
                  <p className="page-subtitle">
                    {String(forecast?.dailyRunRateMinor ?? 0)} daily run rate
                  </p>
                </Card>
                <Card>
                  <SectionLabel>Threshold</SectionLabel>
                  <h2>
                    <Badge
                      color={
                        thresholdState === 'over_limit'
                          ? 'red'
                          : thresholdState === 'approaching_limit'
                            ? 'amber'
                            : 'green'
                      }
                    >
                      {thresholdState}
                    </Badge>
                  </h2>
                  <p className="page-subtitle">Budget-aware forecast</p>
                </Card>
              </div>
              <Card>
                <div className="page-heading compact">
                  <div>
                    <SectionLabel>Attribution</SectionLabel>
                    <h2>Usage by category</h2>
                  </div>
                  <span>{rows.length} categories</span>
                </div>
                <DataTable
                  columns={columns}
                  rows={rows}
                  getRowKey={(item) => item.category}
                  empty="No attributed usage yet."
                />
              </Card>
              <Card>
                <div className="page-heading compact">
                  <div>
                    <SectionLabel>Alerts</SectionLabel>
                    <h2>Threshold events</h2>
                  </div>
                  <Badge color={alerts.length > 0 ? 'amber' : 'green'}>{alerts.length}</Badge>
                </div>
                {alerts.length === 0 ? (
                  <p className="page-subtitle">No budget or forecast alerts.</p>
                ) : (
                  <DataTable
                    columns={[
                      { key: 'kind', header: 'Type', render: (item) => String(item.kind ?? '—') },
                      {
                        key: 'message',
                        header: 'Message',
                        render: (item) => String(item.message ?? '—'),
                      },
                      {
                        key: 'observed',
                        header: 'Observed',
                        render: (item) => String(item.observedMinor ?? '—'),
                      },
                      {
                        key: 'at',
                        header: 'Occurred',
                        render: (item) => String(item.occurredAt ?? '—'),
                      },
                    ]}
                    rows={alerts}
                    getRowKey={(item, index) => String(item.alertId ?? index)}
                  />
                )}
              </Card>
            </>
          )}
        </div>
      </div>
    </CapabilityGate>
  );
}
