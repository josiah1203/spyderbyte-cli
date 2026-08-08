import { useEffect, useState } from 'react';
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  Pagination,
  SearchInput,
  StatusDot,
} from '../components/primitives';
import type { DataTableColumn } from '../components/primitives';
import RuntimeStateNotice from '../components/RuntimeStateNotice';
import { useRuntime } from '../runtime/RuntimeProvider';
import { useRuns, useRuntimeStore } from '../runtime/store';

type Filter = 'All' | 'Running' | 'Completed' | 'Failed' | 'Cancelled';

const STATUS_COLOR: Record<string, 'green' | 'amber' | 'red' | 'gray' | 'blue'> = {
  running: 'green',
  executing: 'green',
  completed: 'gray',
  succeeded: 'gray',
  failed: 'red',
  cancelled: 'gray',
  paused: 'amber',
  awaiting_approval: 'amber',
};

function statusLabel(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export default function Runs({ onSelectRun }: { onSelectRun: (id: string) => void }) {
  const [filter, setFilter] = useState<Filter>('All');
  const [search, setSearch] = useState('');
  const runtime = useRuntime();
  const { data: runs, state } = useRuns(runtime);
  const runtimeSnapshot = useRuntimeStore(runtime);
  const filtered = runs.filter((run) => {
    const label = statusLabel(run.status);
    const query = search.toLowerCase();
    return (
      (filter === 'All' || label === filter || run.status.toLowerCase() === filter.toLowerCase()) &&
      (String(run.name ?? run.runId)
        .toLowerCase()
        .includes(query) ||
        String(run.objective ?? '')
          .toLowerCase()
          .includes(query))
    );
  });
  const pageSize = 20;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const [page, setPage] = useState(1);
  const visibleRuns = filtered.slice((page - 1) * pageSize, page * pageSize);

  useEffect(() => setPage(1), [filter, search]);
  useEffect(() => setPage((current) => Math.min(current, pageCount)), [pageCount]);

  const columns: DataTableColumn<(typeof filtered)[number]>[] = [
    {
      key: 'name',
      header: 'Run',
      render: (run) => (
        <span className="table-primary-value">
          <StatusDot color={STATUS_COLOR[run.status] ?? 'gray'} />
          {run.name ?? run.runId}
        </span>
      ),
    },
    {
      key: 'projectId',
      header: 'Project',
      render: (run) => <span className="table-truncate">{run.projectId ?? 'Unassigned'}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      render: (run) => (
        <Badge color={STATUS_COLOR[run.status] ?? 'gray'}>{statusLabel(run.status)}</Badge>
      ),
    },
    {
      key: 'updatedAt',
      header: 'Updated',
      render: (run) => (run.updatedAt ? new Date(run.updatedAt).toLocaleString() : '—'),
    },
    {
      key: 'objective',
      header: 'Objective',
      render: (run) => <span className="table-truncate">{run.objective ?? '—'}</span>,
    },
    {
      key: 'open',
      header: '',
      render: () => <span className="table-action">View →</span>,
    },
  ];

  return (
    <div className="page-scroll">
      <div className="page">
        <div className="page-heading">
          <div>
            <span className="section-label">Execution</span>
            <h1>Runs</h1>
            <p className="page-subtitle">
              Monitor platform workflow execution, routing, approvals, and outputs.
            </p>
          </div>
        </div>
        <RuntimeStateNotice
          state={runtimeSnapshot.connection}
          onRetry={() => void runtime.retry()}
        />
        <div className="toolbar">
          <SearchInput
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search runs…"
            aria-label="Search runs"
          />
          <div className="filter-group" role="group" aria-label="Run filters">
            {(['All', 'Running', 'Completed', 'Failed', 'Cancelled'] as Filter[]).map((value) => (
              <Button
                key={value}
                variant={filter === value ? 'primary' : 'secondary'}
                onClick={() => setFilter(value)}
              >
                {value !== 'All' && (
                  <StatusDot color={STATUS_COLOR[value.toLowerCase()] ?? 'gray'} />
                )}
                {value}
              </Button>
            ))}
          </div>
        </div>
        <DataTable
          columns={columns}
          rows={visibleRuns}
          getRowKey={(run) => run.runId}
          onRowClick={(run) => onSelectRun(run.runId)}
          loading={state === 'booting'}
          unavailable={
            state === 'unavailable' || state === 'error'
              ? 'Runs are unavailable until the platform reconnects.'
              : undefined
          }
          empty={
            <EmptyState
              icon="play"
              title="No runs match"
              description="Clear filters or start a project workflow."
            />
          }
        />
        {pageCount > 1 && <Pagination current={page} total={pageCount} onChange={setPage} />}
        <div className="screen-meta">
          {filtered.length} run{filtered.length === 1 ? '' : 's'} · page {page} of {pageCount}
        </div>
      </div>
    </div>
  );
}
