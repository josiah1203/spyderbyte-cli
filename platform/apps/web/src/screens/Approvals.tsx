import { useCallback, useEffect, useMemo, useState } from 'react';
import CapabilityGate from '../components/CapabilityGate';
import RuntimeStateNotice from '../components/RuntimeStateNotice';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  SearchInput,
  SectionLabel,
} from '../components/primitives';
import { useRuntime } from '../runtime/RuntimeProvider';
import { useRuntimeStore } from '../runtime/store';

interface ApprovalRecord {
  request: {
    approvalId: string;
    state: string;
    actionType: string;
    requestedAt: string;
    expiresAt: string;
    requestedBy?: { actorId: string; displayName?: string };
    workflowId?: string;
    invocationId?: string;
    estimatedCost?: { amountMinor: number; currency: string };
  };
  action?: {
    deploymentTarget?: string;
    credentialScopes?: string[];
    resources?: Array<{ kind: string; id: string }>;
  };
}

function colorFor(state: string): 'green' | 'amber' | 'red' | 'gray' | 'blue' {
  if (state === 'approved') return 'green';
  if (state === 'pending') return 'amber';
  if (state === 'rejected' || state === 'revoked' || state === 'expired') return 'red';
  return 'gray';
}

export default function Approvals() {
  const runtime = useRuntime();
  const runtimeSnapshot = useRuntimeStore(runtime);
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState<string>();
  const [busyId, setBusyId] = useState<string>();
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (): Promise<void> => {
    if (runtime.client.get === undefined) {
      setMessage('Approval records are not available from the connected platform.');
      setLoading(false);
      return;
    }
    try {
      setApprovals(await runtime.client.get<ApprovalRecord[]>('/v1/approvals'));
      setMessage(undefined);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [runtime]);

  useEffect(() => {
    void load();
  }, [load, runtimeSnapshot.cursor]);

  async function decide(
    approvalId: string,
    action: 'approve' | 'reject' | 'revoke',
  ): Promise<void> {
    if (runtime.client.post === undefined) return;
    setBusyId(approvalId);
    setMessage(undefined);
    try {
      await runtime.client.post(`/v1/approvals/${encodeURIComponent(approvalId)}/${action}`, {});
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId(undefined);
    }
  }

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return approvals.filter((approval) => {
      if (!normalized) return true;
      const request = approval.request;
      return [
        request.approvalId,
        request.actionType,
        request.state,
        request.workflowId ?? '',
        request.requestedBy?.displayName ?? '',
      ]
        .join(' ')
        .toLowerCase()
        .includes(normalized);
    });
  }, [approvals, query]);

  return (
    <CapabilityGate page="approvals">
      <div className="page-scroll">
        <div className="page stack">
          <div className="page-heading">
            <div>
              <SectionLabel>Policy decisions</SectionLabel>
              <h1>Approvals</h1>
              <p className="page-subtitle">
                Review authority, resources, and model or deployment actions before they execute.
              </p>
            </div>
          </div>
          {message && (
            <div className="home-error" role="status">
              {message}
            </div>
          )}
          <RuntimeStateNotice
            state={runtimeSnapshot.connection}
            onRetry={() => void runtime.retry()}
          />
          <div className="toolbar">
            <SearchInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search approvals…"
            />
            <span className="toolbar-fill" />
            <Button variant="secondary" onClick={() => void load()}>
              Refresh
            </Button>
          </div>
          {loading ? (
            <Card>
              <div className="panel-empty">Loading approval records…</div>
            </Card>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon="check"
              title="No approvals match"
              description="Pending policy requests will appear here when a workflow requires human authority."
            />
          ) : (
            <div className="approval-list">
              {filtered.map(({ request, action }) => {
                const pending = request.state === 'pending';
                const busy = busyId === request.approvalId;
                return (
                  <Card className="approval-card" key={request.approvalId}>
                    <div className="approval-card-heading">
                      <div>
                        <span className="home-list-title">{request.actionType}</span>
                        <span className="home-list-subtitle">
                          {request.approvalId} · requested{' '}
                          {new Date(request.requestedAt).toLocaleString()}
                        </span>
                      </div>
                      <Badge color={colorFor(request.state)}>{request.state}</Badge>
                    </div>
                    <div className="approval-card-details">
                      <span>
                        Requester:{' '}
                        {request.requestedBy?.displayName ??
                          request.requestedBy?.actorId ??
                          'Unknown'}
                      </span>
                      <span>Workflow: {request.workflowId ?? '—'}</span>
                      <span>Expires: {new Date(request.expiresAt).toLocaleString()}</span>
                      {action?.deploymentTarget && <span>Target: {action.deploymentTarget}</span>}
                      {request.estimatedCost && (
                        <span>
                          Estimated usage: {request.estimatedCost.amountMinor}{' '}
                          {request.estimatedCost.currency}
                        </span>
                      )}
                    </div>
                    {action?.credentialScopes && action.credentialScopes.length > 0 && (
                      <div className="approval-scopes">
                        Scopes: {action.credentialScopes.join(', ')}
                      </div>
                    )}
                    {pending && (
                      <div className="approval-actions">
                        <Button
                          variant="secondary"
                          loading={busy}
                          onClick={() => void decide(request.approvalId, 'reject')}
                        >
                          Reject
                        </Button>
                        <Button
                          loading={busy}
                          onClick={() => void decide(request.approvalId, 'approve')}
                        >
                          Approve
                        </Button>
                      </div>
                    )}
                    {!pending && request.state === 'approved' && (
                      <div className="approval-actions">
                        <Button
                          variant="tertiary"
                          loading={busy}
                          onClick={() => void decide(request.approvalId, 'revoke')}
                        >
                          Revoke
                        </Button>
                      </div>
                    )}
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </CapabilityGate>
  );
}
