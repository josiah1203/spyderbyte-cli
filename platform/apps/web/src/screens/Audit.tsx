import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
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

type AuditRecord = Record<string, unknown>;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function list(value: unknown): AuditRecord[] {
  const records = record(value).records;
  return Array.isArray(records) ? records.map(record) : [];
}

function decisionColor(value: string): 'green' | 'amber' | 'red' | 'gray' {
  if (value === 'executed' || value === 'allowed') return 'green';
  if (value === 'approval_required') return 'amber';
  if (value === 'blocked' || value === 'denied') return 'red';
  return 'gray';
}

export default function Audit(): ReactElement {
  const runtime = useRuntime();
  const snapshot = useRuntimeStore(runtime);
  const [records, setRecords] = useState<AuditRecord[]>([]);
  const [valid, setValid] = useState<boolean>();
  const [message, setMessage] = useState<string>();
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (): Promise<void> => {
    if (runtime.client.get === undefined) return;
    setLoading(true);
    setMessage(undefined);
    try {
      const organizations = await runtime.client.get<{ organizations?: AuditRecord[] }>(
        '/v1/governance/organizations',
      );
      const organizationId = String(organizations.organizations?.[0]?.organizationId ?? '');
      if (!organizationId) {
        setRecords([]);
        setValid(undefined);
        return;
      }
      const prefix = `/v1/governance/organizations/${encodeURIComponent(organizationId)}`;
      const [audit, verification] = await Promise.all([
        runtime.client.get<unknown>(`${prefix}/audit`),
        runtime.client.get<{ valid?: boolean }>(`${prefix}/audit/verify`),
      ]);
      setRecords(list(audit));
      setValid(verification.valid);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [runtime]);

  useEffect(() => {
    void load();
  }, [load, snapshot.cursor]);

  const columns: DataTableColumn<AuditRecord>[] = useMemo(
    () => [
      {
        key: 'decision',
        header: 'Decision',
        render: (item) => (
          <Badge color={decisionColor(String(item.decision ?? 'observed'))}>
            {String(item.decision ?? 'observed')}
          </Badge>
        ),
      },
      { key: 'action', header: 'Action', render: (item) => String(item.action ?? '—') },
      {
        key: 'actor',
        header: 'Actor',
        render: (item) =>
          String(record(item.actor).displayName ?? record(item.actor).actorId ?? '—'),
      },
      {
        key: 'interface',
        header: 'Interface',
        render: (item) => String(item.interfaceName ?? '—'),
      },
      { key: 'run', header: 'Run', render: (item) => String(item.runId ?? '—') },
      { key: 'occurred', header: 'Occurred', render: (item) => String(item.occurredAt ?? '—') },
      {
        key: 'digest',
        header: 'Digest',
        render: (item) => String(item.digest ?? '—').slice(0, 16),
      },
    ],
    [],
  );

  return (
    <CapabilityGate page="audit">
      <div className="page-scroll">
        <div className="page stack">
          <div className="page-heading">
            <div>
              <SectionLabel>Immutable evidence</SectionLabel>
              <h1>Audit</h1>
              <p className="page-subtitle">
                Review actor, action, target, policy decision, approval context, run, and interface
                evidence.
              </p>
            </div>
            <div className="inline-actions">
              {valid !== undefined && (
                <Badge color={valid ? 'green' : 'red'}>
                  {valid ? 'Chain verified' : 'Chain invalid'}
                </Badge>
              )}
              <Button variant="secondary" onClick={() => void load()}>
                Refresh
              </Button>
            </div>
          </div>
          {message && (
            <div className="home-error" role="status">
              {message}
            </div>
          )}
          <RuntimeStateNotice state={snapshot.connection} onRetry={() => void runtime.retry()} />
          {loading ? (
            <Card>
              <div className="panel-empty">Loading audit evidence…</div>
            </Card>
          ) : records.length === 0 ? (
            <EmptyState
              icon="document"
              title="No governance audit records"
              description="Execution decisions and commits will appear here after an organization workspace is active."
            />
          ) : (
            <Card>
              <DataTable
                columns={columns}
                rows={records}
                getRowKey={(item, index) => String(item.auditId ?? index)}
              />
            </Card>
          )}
        </div>
      </div>
    </CapabilityGate>
  );
}
