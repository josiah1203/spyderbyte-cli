import { useEffect, useState } from 'react';
import {
  Badge,
  Button,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  Input,
  Notice,
  Pagination,
  SearchInput,
  StatusDot,
  Textarea,
} from '../components/primitives';
import type { DataTableColumn } from '../components/primitives';
import RuntimeStateNotice from '../components/RuntimeStateNotice';
import { useRuntime } from '../runtime/RuntimeProvider';
import { useProjects, useRuntimeStore } from '../runtime/store';

const STATUS_COLOR: Record<string, 'green' | 'amber' | 'red' | 'gray' | 'blue'> = {
  active: 'green',
  running: 'blue',
  completed: 'gray',
  failed: 'red',
  archived: 'gray',
  awaiting_approval: 'amber',
};

type Filter = 'All' | 'Active' | 'Completed' | 'Failed';

interface ProjectsProps {
  onSelectProject: (id: string) => void;
}

export default function Projects({ onSelectProject }: ProjectsProps) {
  const [filter, setFilter] = useState<Filter>('All');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newObjective, setNewObjective] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [createError, setCreateError] = useState<string>();
  const runtime = useRuntime();
  const { data: projects, state } = useProjects(runtime);
  const runtimeSnapshot = useRuntimeStore(runtime);

  async function createProject(): Promise<void> {
    const name = newName.trim();
    if (!name) {
      setCreateError('Project name is required.');
      return;
    }
    setCreating(true);
    setCreateError(undefined);
    try {
      const acknowledgement = await runtime.command({
        commandType: 'CreateProject',
        payload: {
          name,
          objective: newObjective.trim() || name,
          ...(newDescription.trim() ? { description: newDescription.trim() } : {}),
        },
      });
      await runtime.refresh(['projects']);
      const result = acknowledgement.result;
      const projectId =
        result !== null &&
        typeof result === 'object' &&
        !Array.isArray(result) &&
        typeof result.projectId === 'string'
          ? result.projectId
          : undefined;
      if (projectId) onSelectProject(projectId);
      setCreateOpen(false);
      setNewName('');
      setNewObjective('');
      setNewDescription('');
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreating(false);
    }
  }

  const filtered = projects.filter((project) => {
    const status = project.status ?? 'unknown';
    const matchesFilter =
      filter === 'All' ||
      (filter === 'Active' && ['active', 'running', 'awaiting_approval'].includes(status)) ||
      (filter === 'Completed' && status === 'completed') ||
      (filter === 'Failed' && status === 'failed');
    const query = search.toLowerCase();
    return (
      matchesFilter &&
      (project.name.toLowerCase().includes(query) ||
        (project.objective ?? '').toLowerCase().includes(query))
    );
  });
  const pageSize = 20;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const [page, setPage] = useState(1);
  const visibleProjects = filtered.slice((page - 1) * pageSize, page * pageSize);

  useEffect(() => setPage(1), [filter, search]);
  useEffect(() => setPage((current) => Math.min(current, pageCount)), [pageCount]);

  const columns: DataTableColumn<(typeof filtered)[number]>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (project) => (
        <span className="table-primary-value">
          <StatusDot color={STATUS_COLOR[project.status ?? ''] ?? 'gray'} />
          {project.name}
        </span>
      ),
    },
    {
      key: 'objective',
      header: 'Objective',
      render: (project) => <span className="table-truncate">{project.objective ?? '—'}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      render: (project) => (
        <Badge color={STATUS_COLOR[project.status ?? ''] ?? 'gray'}>
          {project.status ?? 'unknown'}
        </Badge>
      ),
    },
    {
      key: 'updatedAt',
      header: 'Last run',
      render: (project) => (project.updatedAt ? new Date(project.updatedAt).toLocaleString() : '—'),
    },
    {
      key: 'assetCount',
      header: 'Assets',
      render: (project) => project.assetCount ?? '—',
    },
    {
      key: 'runCount',
      header: 'Runs',
      render: (project) => project.runCount ?? '—',
    },
    {
      key: 'open',
      header: '',
      render: () => <span className="table-action">Open →</span>,
    },
  ];

  return (
    <div className="page-scroll">
      <div className="page">
        <div className="toolbar">
          <SearchInput
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search projects…"
            aria-label="Search projects"
          />
          <div className="filter-group" role="group" aria-label="Project filters">
            {(['All', 'Active', 'Completed', 'Failed'] as Filter[]).map((value) => (
              <Button
                key={value}
                variant={filter === value ? 'primary' : 'secondary'}
                onClick={() => setFilter(value)}
              >
                {value}
              </Button>
            ))}
          </div>
          <Button
            loading={creating}
            onClick={() => {
              setCreateOpen(true);
              setCreateError(undefined);
            }}
          >
            <span>New project</span>
          </Button>
        </div>
        <RuntimeStateNotice
          state={runtimeSnapshot.connection}
          onRetry={() => void runtime.retry()}
        />
        {createError && (
          <Notice tone="danger" icon="danger">
            {createError}
          </Notice>
        )}
        <DataTable
          columns={columns}
          rows={visibleProjects}
          getRowKey={(project) => project.projectId}
          onRowClick={(project) => onSelectProject(project.projectId)}
          loading={state === 'booting'}
          unavailable={
            state === 'unavailable' || state === 'error'
              ? 'Projects are unavailable until the platform reconnects.'
              : undefined
          }
          empty={
            <EmptyState
              icon="projects"
              title="No projects match"
              description="Clear the filters or create a new project."
              action={
                <Button
                  onClick={() => {
                    setCreateOpen(true);
                    setCreateError(undefined);
                  }}
                >
                  Create project
                </Button>
              }
            />
          }
        />
        {pageCount > 1 && <Pagination current={page} total={pageCount} onChange={setPage} />}
        <div className="screen-meta">
          {filtered.length} project{filtered.length === 1 ? '' : 's'} · page {page} of {pageCount}
        </div>
      </div>
      <Dialog
        open={createOpen}
        title="Create project"
        onClose={() => setCreateOpen(false)}
        actions={
          <>
            <Button variant="tertiary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button loading={creating} onClick={() => void createProject()}>
              Create project
            </Button>
          </>
        }
      >
        <div className="stack">
          <Field label="Project name" required>
            <Input
              id="new-project-name"
              autoFocus
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="A clear project name"
            />
          </Field>
          <Field label="Objective" hint="What should this project help you accomplish?">
            <Input
              id="new-project-objective"
              value={newObjective}
              onChange={(event) => setNewObjective(event.target.value)}
              placeholder="Analyze, build, or explore…"
            />
          </Field>
          <Field label="Description" hint="Optional context for you and future collaborators.">
            <Textarea
              id="new-project-description"
              value={newDescription}
              onChange={(event) => setNewDescription(event.target.value)}
              placeholder="Add a little more context…"
            />
          </Field>
        </div>
      </Dialog>
    </div>
  );
}
