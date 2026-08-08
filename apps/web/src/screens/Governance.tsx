import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import CapabilityGate from '../components/CapabilityGate';
import RuntimeStateNotice from '../components/RuntimeStateNotice';
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Input,
  SectionLabel,
  Select,
  type DataTableColumn,
} from '../components/primitives';
import { useRuntime } from '../runtime/RuntimeProvider';
import { useRuntimeStore } from '../runtime/store';

type RecordValue = Record<string, unknown>;

interface Organization extends RecordValue {
  organizationId: string;
  name: string;
  policyVersion: string;
}

function csv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function listText(value: unknown): string {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').join(', ') || 'None'
    : 'None';
}

function listValue(value: unknown): string {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').join(', ')
    : '';
}

export default function Governance(): ReactElement {
  const runtime = useRuntime();
  const snapshot = useRuntimeStore(runtime);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [members, setMembers] = useState<RecordValue[]>([]);
  const [policies, setPolicies] = useState<RecordValue[]>([]);
  const [budgets, setBudgets] = useState<RecordValue[]>([]);
  const [overview, setOverview] = useState<RecordValue>();
  const [usage, setUsage] = useState<RecordValue>();
  const [forecast, setForecast] = useState<RecordValue>();
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [memberActorId, setMemberActorId] = useState('');
  const [memberRole, setMemberRole] = useState('viewer');
  const [policyVersion, setPolicyVersion] = useState('governance.v1');
  const [blockedActions, setBlockedActions] = useState('');
  const [approvalActions, setApprovalActions] = useState('');
  const [allowedProviders, setAllowedProviders] = useState('');
  const [allowedRuntimes, setAllowedRuntimes] = useState('');

  const loadOrganizations = useCallback(async (): Promise<void> => {
    if (runtime.client.get === undefined) return;
    const response = await runtime.client.get<{ organizations?: Organization[] }>(
      '/v1/governance/organizations',
    );
    const next = response.organizations ?? [];
    setOrganizations(next);
    setSelectedId((current) => current || next[0]?.organizationId || '');
  }, [runtime]);

  const loadOrganization = useCallback(async (): Promise<void> => {
    if (!selectedId || runtime.client.get === undefined) return;
    const prefix = `/v1/governance/organizations/${encodeURIComponent(selectedId)}`;
    const [
      overviewResponse,
      memberResponse,
      policyResponse,
      budgetResponse,
      usageResponse,
      forecastResponse,
    ] = await Promise.all([
      runtime.client.get<RecordValue>(`${prefix}/overview`),
      runtime.client.get<{ members?: RecordValue[] }>(`${prefix}/members`),
      runtime.client.get<{ policies?: RecordValue[] }>(`${prefix}/policies`),
      runtime.client.get<{ budgets?: RecordValue[] }>(`${prefix}/budgets`),
      runtime.client.get<RecordValue>(`${prefix}/usage`),
      runtime.client.get<RecordValue>(`${prefix}/forecast`),
    ]);
    setOverview(overviewResponse);
    setMembers(memberResponse.members ?? []);
    setPolicies(policyResponse.policies ?? []);
    const policy = policyResponse.policies?.[0];
    setAllowedProviders(listValue(policy?.allowedProviders));
    setAllowedRuntimes(listValue(policy?.allowedRuntimes));
    setBudgets(budgetResponse.budgets ?? []);
    setUsage(usageResponse);
    setForecast(forecastResponse);
  }, [runtime, selectedId]);

  const load = useCallback(async (): Promise<void> => {
    setMessage(undefined);
    try {
      await loadOrganizations();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [loadOrganizations]);

  useEffect(() => {
    void load();
  }, [load, snapshot.cursor]);

  useEffect(() => {
    void loadOrganization().catch((error) =>
      setMessage(error instanceof Error ? error.message : String(error)),
    );
  }, [loadOrganization]);

  async function addMember(): Promise<void> {
    if (!selectedId || !memberActorId.trim() || runtime.client.post === undefined) return;
    setBusy(true);
    try {
      await runtime.client.post(`/v1/governance/organizations/${selectedId}/members`, {
        actorId: memberActorId.trim(),
        role: memberRole,
      });
      setMemberActorId('');
      setMessage('Membership updated.');
      await loadOrganization();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function savePolicy(): Promise<void> {
    if (!selectedId || runtime.client.post === undefined) return;
    setBusy(true);
    try {
      const providerValues = csv(allowedProviders);
      const runtimeValues = csv(allowedRuntimes);
      await runtime.client.post(`/v1/governance/organizations/${selectedId}/policies`, {
        version: policyVersion.trim() || 'governance.v1',
        scope: {},
        allowedDataClasses: ['public', 'internal', 'confidential', 'restricted'],
        blockedActions: csv(blockedActions),
        approvalActions: csv(approvalActions),
        ...(providerValues.length === 0 ? {} : { allowedProviders: providerValues }),
        ...(runtimeValues.length === 0 ? {} : { allowedRuntimes: runtimeValues }),
      });
      setMessage('Organization policy saved. New executions will be evaluated against it.');
      await loadOrganization();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const memberColumns: DataTableColumn<RecordValue>[] = useMemo(
    () => [
      {
        key: 'actor',
        header: 'Member',
        render: (item) => String(item.displayName ?? item.email ?? item.actorId ?? 'Unknown'),
      },
      { key: 'role', header: 'Role', render: (item) => <Badge>{String(item.role ?? '—')}</Badge> },
      {
        key: 'scope',
        header: 'Scope',
        render: (item) => `${Array.isArray(item.scopes) ? item.scopes.length : 0} scope(s)`,
      },
      { key: 'status', header: 'Status', render: (item) => String(item.status ?? 'active') },
    ],
    [],
  );

  return (
    <CapabilityGate page="governance">
      <div className="page-scroll">
        <div className="page stack">
          <div className="page-heading">
            <div>
              <SectionLabel>Administration · governance · usage</SectionLabel>
              <h1>Governance</h1>
              <p className="page-subtitle">
                Manage organization roles, policy scopes, data classifications, budgets, and runtime
                decisions.
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

          {organizations.length === 0 ? (
            <EmptyState
              icon="shield"
              title="No organization workspace"
              description="Connect an organization workspace to manage roles, policy, spend, and enterprise controls."
            />
          ) : (
            <>
              <Card>
                <div className="page-heading compact">
                  <div>
                    <SectionLabel>Organization context</SectionLabel>
                    <h2>Active control plane</h2>
                  </div>
                  <Field label="Organization">
                    <Select
                      value={selectedId}
                      onChange={(event) => setSelectedId(event.target.value)}
                    >
                      {organizations.map((organization) => (
                        <option
                          key={organization.organizationId}
                          value={organization.organizationId}
                        >
                          {organization.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <p className="page-subtitle">
                  Policy version{' '}
                  {organizations.find((item) => item.organizationId === selectedId)
                    ?.policyVersion ?? '—'}{' '}
                  · decisions are re-evaluated at commit time.
                </p>
                <p className="page-subtitle">
                  Workspace{' '}
                  {String((overview?.workspace as RecordValue | undefined)?.workspaceId ?? '—')}
                  {' · '}
                  Role {String((overview?.membership as RecordValue | undefined)?.role ?? '—')}
                </p>
                <p className="page-subtitle">
                  Allowed providers: {listText(overview?.allowedProviders)} · runtimes:{' '}
                  {listText(overview?.allowedRuntimes)}
                </p>
              </Card>

              <div className="detail-grid">
                <Card>
                  <SectionLabel>Usage</SectionLabel>
                  <h2>{String(usage?.consumedMinor ?? 0)} minor units</h2>
                  <p className="page-subtitle">Current 30-day attributed spend</p>
                  <p>Currency: {String(usage?.currency ?? 'USD')}</p>
                </Card>
                <Card>
                  <SectionLabel>Forecast</SectionLabel>
                  <h2>{String(forecast?.projectedMinor ?? 0)} projected</h2>
                  <p className="page-subtitle">
                    {String(forecast?.thresholdState ?? 'within_budget')}
                  </p>
                  <p>Daily run rate: {String(forecast?.dailyRunRateMinor ?? 0)}</p>
                </Card>
                <Card>
                  <SectionLabel>Budgets</SectionLabel>
                  <h2>{budgets.length}</h2>
                  <p className="page-subtitle">Scoped budget policies</p>
                </Card>
              </div>

              <div className="detail-grid">
                <Card>
                  <SectionLabel>Administration</SectionLabel>
                  <h2>Members and roles</h2>
                  <div className="stack compact-stack">
                    <Field
                      label="Actor ID"
                      hint="Use the actor identifier from the authenticated identity directory."
                    >
                      <Input
                        value={memberActorId}
                        onChange={(event) => setMemberActorId(event.target.value)}
                        placeholder="UUIDv7 actor ID"
                      />
                    </Field>
                    <Field label="Role">
                      <Select
                        value={memberRole}
                        onChange={(event) => setMemberRole(event.target.value)}
                      >
                        {['owner', 'admin', 'operator', 'editor', 'analyst', 'viewer'].map(
                          (role) => (
                            <option key={role}>{role}</option>
                          ),
                        )}
                      </Select>
                    </Field>
                    <Button
                      disabled={busy || !memberActorId.trim()}
                      onClick={() => void addMember()}
                    >
                      Add or update member
                    </Button>
                  </div>
                </Card>
                <Card>
                  <SectionLabel>Policy scope</SectionLabel>
                  <h2>Execution policy</h2>
                  <div className="stack compact-stack">
                    <Field label="Version">
                      <Input
                        value={policyVersion}
                        onChange={(event) => setPolicyVersion(event.target.value)}
                      />
                    </Field>
                    <Field
                      label="Blocked actions"
                      hint="Comma-separated action patterns, for example deployment.*"
                    >
                      <Input
                        value={blockedActions}
                        onChange={(event) => setBlockedActions(event.target.value)}
                        placeholder="deployment.*"
                      />
                    </Field>
                    <Field
                      label="Approval actions"
                      hint="Comma-separated actions that require human approval."
                    >
                      <Input
                        value={approvalActions}
                        onChange={(event) => setApprovalActions(event.target.value)}
                        placeholder="model.promote"
                      />
                    </Field>
                    <Field
                      label="Allowed providers"
                      hint="Comma-separated provider identifiers; leave empty to allow the policy's default set."
                    >
                      <Input
                        value={allowedProviders}
                        onChange={(event) => setAllowedProviders(event.target.value)}
                        placeholder="deterministic, openai"
                      />
                    </Field>
                    <Field
                      label="Allowed runtimes"
                      hint="Comma-separated runtime identifiers enforced at Run commit."
                    >
                      <Input
                        value={allowedRuntimes}
                        onChange={(event) => setAllowedRuntimes(event.target.value)}
                        placeholder="deterministic"
                      />
                    </Field>
                    <Button disabled={busy} onClick={() => void savePolicy()}>
                      Save policy
                    </Button>
                  </div>
                </Card>
              </div>

              <Card>
                <div className="page-heading compact">
                  <div>
                    <SectionLabel>Access control</SectionLabel>
                    <h2>Organization members</h2>
                  </div>
                  <Badge>{members.length} members</Badge>
                </div>
                <DataTable
                  columns={memberColumns}
                  rows={members}
                  getRowKey={(item, index) => String(item.membershipId ?? item.actorId ?? index)}
                  empty="No members are provisioned yet."
                />
              </Card>
              <Card>
                <div className="page-heading compact">
                  <div>
                    <SectionLabel>Policy registry</SectionLabel>
                    <h2>Scoped policies</h2>
                  </div>
                  <Badge>{policies.length} policies</Badge>
                </div>
                <DataTable
                  columns={[
                    {
                      key: 'version',
                      header: 'Version',
                      render: (item) => String(item.version ?? '—'),
                    },
                    {
                      key: 'scope',
                      header: 'Scope',
                      render: (item) => JSON.stringify(item.scope ?? {}),
                    },
                    {
                      key: 'blocked',
                      header: 'Blocked actions',
                      render: (item) =>
                        String(
                          Array.isArray(item.blockedActions)
                            ? item.blockedActions.join(', ') || 'None'
                            : 'None',
                        ),
                    },
                    {
                      key: 'approval',
                      header: 'Approval actions',
                      render: (item) =>
                        String(
                          Array.isArray(item.approvalActions)
                            ? item.approvalActions.join(', ') || 'None'
                            : 'None',
                        ),
                    },
                    {
                      key: 'providers',
                      header: 'Allowed providers',
                      render: (item) => listText(item.allowedProviders),
                    },
                    {
                      key: 'runtimes',
                      header: 'Allowed runtimes',
                      render: (item) => listText(item.allowedRuntimes),
                    },
                  ]}
                  rows={policies}
                  getRowKey={(item, index) => String(item.policyId ?? index)}
                  empty="No policies are configured."
                />
              </Card>
            </>
          )}
        </div>
      </div>
    </CapabilityGate>
  );
}
