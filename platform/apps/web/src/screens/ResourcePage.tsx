import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
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
  Pagination,
  SearchInput,
  SectionLabel,
  StatusDot,
  Textarea,
  type DataTableColumn,
} from '../components/primitives';
import Icon, { type IconName } from '../components/icons';
import type { Page } from '../data/profiles';
import { useRuntime } from '../runtime/RuntimeProvider';
import { useProjection, useRuntimeStore } from '../runtime/store';
import type { JsonValue } from '../runtime/contracts';

export interface ResourcePageConfig {
  readonly page: Page;
  readonly title: string;
  readonly eyebrow: string;
  readonly projection: string;
  readonly collectionKeys: readonly string[];
  readonly resourceKey: string;
  readonly icon: IconName;
  readonly createCommand?: string;
  readonly updateCommand?: string;
  readonly archiveCommand?: string;
  readonly archiveLabel?: string;
  readonly actions?: readonly ResourcePageAction[];
  readonly editorLabel?: string;
  readonly editorPlaceholder?: string;
  readonly editorRows?: number;
  readonly editorField?: string;
  readonly createLabel?: string;
  readonly description: string;
  readonly emptyDescription: string;
  readonly upload?: {
    readonly accept?: string;
    readonly mediaType: string;
    readonly label?: string;
  };
}

export interface ResourcePageAction {
  readonly command: string;
  readonly label: string;
  readonly visibleWhen?: readonly string[];
  readonly payload?: Record<string, JsonValue>;
  readonly payloadFrom?: Readonly<Record<string, string>>;
}

type ResourceRecord = Record<string, unknown>;

function record(value: unknown): ResourceRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ResourceRecord)
    : {};
}

function idFor(item: ResourceRecord, resourceKey: string, index: number): string {
  const candidates = [
    'id',
    `${resourceKey}Id`,
    'projectId',
    'workflowId',
    'runId',
    'artifactId',
    'approvalId',
    'connectionId',
    'repositoryId',
    'deploymentId',
    'eventId',
  ];
  for (const key of candidates) if (typeof item[key] === 'string') return item[key] as string;
  return `${resourceKey}-${index + 1}`;
}

function labelFor(item: ResourceRecord, resourceKey: string, index: number): string {
  const candidates = ['name', 'displayName', 'title', 'objective', `${resourceKey}Id`, 'id'];
  for (const key of candidates) {
    if (typeof item[key] === 'string' && item[key].trim()) return item[key] as string;
  }
  return `${resourceKey} ${index + 1}`;
}

function statusFor(item: ResourceRecord): string {
  for (const key of ['status', 'state', 'phase']) {
    if (typeof item[key] === 'string') return item[key] as string;
  }
  return 'observed';
}

function colorFor(status: string): 'green' | 'amber' | 'red' | 'gray' | 'blue' {
  if (['active', 'ready', 'completed', 'succeeded', 'healthy', 'running'].includes(status))
    return 'green';
  if (['failed', 'error', 'rejected', 'archived'].includes(status)) return 'red';
  if (['pending', 'planning', 'blocked', 'paused', 'awaiting_approval'].includes(status))
    return 'amber';
  if (['executing', 'queued'].includes(status)) return 'blue';
  return 'gray';
}

function collectionFrom(data: unknown, keys: readonly string[]): ResourceRecord[] {
  const root = record(data);
  for (const key of keys) {
    const value = root[key];
    if (Array.isArray(value))
      return value.map(record).filter((item) => Object.keys(item).length > 0);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return Object.values(value)
        .map(record)
        .filter((item) => Object.keys(item).length > 0);
    }
  }
  const values = Object.values(root).filter(
    (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  );
  return values.map(record).filter((item) => Object.keys(item).length > 0);
}

function sortableId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues(bytes);
  let timestamp = Date.now();
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp & 0xff;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function uploadMediaType(file: File, configured: string): string {
  if (configured !== 'auto') return configured;
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.json') || lower.endsWith('.jsonl')) return 'application/json';
  if (lower.endsWith('.tsv')) return 'text/tab-separated-values';
  return file.type || 'text/csv';
}

export default function ResourcePage({ config }: { config: ResourcePageConfig }): ReactElement {
  const runtime = useRuntime();
  const runtimeSnapshot = useRuntimeStore(runtime);
  const navigate = useNavigate();
  const { data, envelope, state, refresh } = useProjection<unknown>(runtime, config.projection);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ResourceRecord>();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selectedFile, setSelectedFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [publishedArtifactId, setPublishedArtifactId] = useState<string>();

  useEffect(() => {
    void refresh().catch((error) =>
      setMessage(error instanceof Error ? error.message : String(error)),
    );
  }, [config.projection, refresh]);

  const rows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return collectionFrom(data, config.collectionKeys).filter((item, index) => {
      if (!normalizedQuery) return true;
      return [
        idFor(item, config.resourceKey, index),
        labelFor(item, config.resourceKey, index),
        statusFor(item),
      ]
        .join(' ')
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }, [config.collectionKeys, config.resourceKey, data, query]);
  const pageSize = 20;
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const visibleRows = rows.slice((page - 1) * pageSize, page * pageSize);

  useEffect(() => {
    setPage(1);
  }, [config.projection, query]);

  useEffect(() => {
    setPage((current) => Math.min(current, pageCount));
  }, [pageCount]);

  function openCreate(): void {
    setEditing(undefined);
    setName('');
    setDescription('');
    setMessage(undefined);
    setCreateOpen(true);
  }

  function openEdit(item: ResourceRecord, index: number): void {
    setEditing({ ...item, __resourceId: idFor(item, config.resourceKey, index) });
    setName(String(item.name ?? item.displayName ?? item.title ?? ''));
    setDescription(String(item.description ?? item.objective ?? ''));
    setMessage(undefined);
    setCreateOpen(true);
  }

  async function submitForm(): Promise<void> {
    const commandType = editing ? config.updateCommand : config.createCommand;
    if (!runtime.client.post && !commandType) return;
    if (!commandType || !name.trim()) {
      setMessage('A name is required for this resource.');
      return;
    }
    setBusy(true);
    setMessage(undefined);
    try {
      const payload: Record<string, JsonValue> = {
        name: name.trim(),
        ...(description.trim()
          ? { description: description.trim(), objective: description.trim() }
          : {}),
        ...(typeof editing?.__resourceId === 'string'
          ? { [`${config.resourceKey}Id`]: editing.__resourceId }
          : {}),
        ...(config.editorField && description.trim()
          ? { [config.editorField]: description.trim() }
          : {}),
      };
      await runtime.command({ commandType, payload });
      setCreateOpen(false);
      setMessage(editing ? 'Resource updated.' : 'Resource created.');
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function archive(item: ResourceRecord, index: number): Promise<void> {
    if (!config.archiveCommand) return;
    setBusy(true);
    setMessage(undefined);
    try {
      await runtime.command({
        commandType: config.archiveCommand,
        payload: { [`${config.resourceKey}Id`]: idFor(item, config.resourceKey, index) },
      });
      setMessage('Resource archived.');
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function runAction(
    item: ResourceRecord,
    index: number,
    action: ResourcePageAction,
  ): Promise<void> {
    setBusy(true);
    setMessage(undefined);
    try {
      await runtime.command({
        commandType: action.command,
        payload: {
          [`${config.resourceKey}Id`]: idFor(item, config.resourceKey, index),
          ...(action.payload ?? {}),
          ...Object.fromEntries(
            Object.entries(action.payloadFrom ?? {})
              .map(([target, source]) => [target, item[source]] as const)
              .filter(([, value]) => value !== undefined)
              .map(([target, value]) => [target, value as JsonValue]),
          ),
        },
      });
      setMessage(`${action.label} completed.`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function uploadFile(): Promise<void> {
    if (!config.upload || !selectedFile || !runtime.client.post) {
      setMessage('Choose a file before importing.');
      return;
    }
    const actor = runtimeSnapshot.session?.actor;
    if (!actor) {
      setMessage('The platform session is not ready to publish this artifact.');
      return;
    }
    setBusy(true);
    setMessage(undefined);
    try {
      const mediaType = uploadMediaType(selectedFile, config.upload.mediaType);
      const staged = await runtime.client.post<{ stagedUploadId: string }>(
        '/v1/artifacts/uploads',
        { content: await selectedFile.text(), mediaType },
      );
      const artifactId = sortableId();
      await runtime.client.post(`/v1/artifacts/${artifactId}/versions`, {
        stagedUploadId: staged.stagedUploadId,
        mediaType,
        createdBy: { ...actor } as unknown as JsonValue,
      });
      if (config.createCommand) {
        await runtime.command({
          commandType: config.createCommand,
          payload: {
            name: selectedFile.name,
            mediaType: config.upload.mediaType,
            sourceArtifactId: artifactId,
            sourceArtifactVersion: 1,
          },
        });
      }
      setSelectedFile(undefined);
      setPublishedArtifactId(artifactId);
      setMessage(`${selectedFile.name} was staged and published as an immutable artifact.`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const columns: DataTableColumn<ResourceRecord>[] = [
    {
      key: 'name',
      header: config.resourceKey,
      render: (item, index) => (
        <span className="table-primary-value">
          <StatusDot color={colorFor(statusFor(item))} />
          {labelFor(item, config.resourceKey, index)}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (item) => <Badge color={colorFor(statusFor(item))}>{statusFor(item)}</Badge>,
    },
    {
      key: 'updated',
      header: 'Updated',
      render: (item) => String(item.updatedAt ?? item.lastEventAt ?? item.createdAt ?? '—'),
    },
    {
      key: 'actions',
      header: '',
      render: (item, index) => (
        <span className="resource-actions">
          {config.actions?.map((action) => {
            const visible =
              action.visibleWhen === undefined ||
              action.visibleWhen.includes(statusFor(item).toLowerCase());
            return visible ? (
              <Button
                key={action.command}
                variant="tertiary"
                disabled={busy}
                onClick={() => void runAction(item, index, action)}
              >
                {action.label}
              </Button>
            ) : null;
          })}
          {config.updateCommand && (
            <Button variant="tertiary" onClick={() => openEdit(item, index)}>
              Edit
            </Button>
          )}
          {config.archiveCommand && (
            <Button variant="tertiary" disabled={busy} onClick={() => void archive(item, index)}>
              {config.archiveLabel ?? 'Archive'}
            </Button>
          )}
        </span>
      ),
    },
  ];

  return (
    <CapabilityGate page={config.page}>
      <div className="page-scroll">
        <div className="page stack">
          <div className="page-heading">
            <div>
              <SectionLabel>{config.eyebrow}</SectionLabel>
              <h1>{config.title}</h1>
              <p className="page-subtitle">{config.description}</p>
            </div>
            {config.createCommand && (
              <Button onClick={openCreate}>
                <Icon name="plus" size={14} aria-hidden="true" />
                {config.createLabel ?? `New ${config.resourceKey}`}
              </Button>
            )}
          </div>
          {message && (
            <div className="home-error" role="status">
              {message}
            </div>
          )}
          <RuntimeStateNotice
            state={envelope?.freshness === 'stale' ? 'stale' : state}
            onRetry={() => void runtime.retry()}
          />
          {createOpen && (
            <Card className="resource-editor">
              <div className="card-heading">
                <div>
                  <h2>{editing ? `Edit ${config.resourceKey}` : `Create ${config.resourceKey}`}</h2>
                  <p>
                    Changes are validated by the platform service and reflected here when workspace
                    state is refreshed.
                  </p>
                </div>
                <Button variant="tertiary" onClick={() => setCreateOpen(false)}>
                  Close
                </Button>
              </div>
              <div className="resource-editor-grid">
                <Field label="Name" required>
                  <Input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
                </Field>
                <Field label={config.editorLabel ?? 'Description'}>
                  <Textarea
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder={config.editorPlaceholder}
                    rows={config.editorRows ?? 3}
                    spellCheck={config.editorField ? false : undefined}
                  />
                </Field>
              </div>
              <div className="resource-editor-actions">
                <Button variant="secondary" onClick={() => setCreateOpen(false)}>
                  Cancel
                </Button>
                <Button loading={busy} onClick={() => void submitForm()}>
                  {editing ? 'Save changes' : 'Create'}
                </Button>
              </div>
            </Card>
          )}
          {config.upload && (
            <Card className="resource-upload-card">
              <div className="card-heading">
                <div>
                  <h2>{config.upload.label ?? 'Import a file'}</h2>
                  <p>
                    Content is staged locally, published immutably, and then registered in the
                    platform catalog.
                  </p>
                </div>
              </div>
              <div className="resource-upload-actions">
                <Field label="File to import">
                  <Input
                    type="file"
                    accept={config.upload.accept}
                    onChange={(event) => setSelectedFile(event.target.files?.[0])}
                  />
                </Field>
                <Button loading={busy} disabled={!selectedFile} onClick={() => void uploadFile()}>
                  Stage and import
                </Button>
              </div>
              {publishedArtifactId !== undefined && (
                <div className="resource-upload-success" role="status">
                  <span>
                    Source artifact <code>{publishedArtifactId}</code> is immutable and ready for
                    lineage inspection.
                  </span>
                  <Button
                    variant="tertiary"
                    onClick={() =>
                      navigate(`/assets?artifact=${encodeURIComponent(publishedArtifactId)}`)
                    }
                  >
                    Inspect lineage
                  </Button>
                </div>
              )}
            </Card>
          )}
          <div className="toolbar">
            <SearchInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${config.title.toLowerCase()}…`}
            />
            <span className="toolbar-fill" />
            <Button variant="secondary" onClick={() => void refresh()}>
              <Icon name="refresh" size={14} aria-hidden="true" /> Refresh
            </Button>
          </div>
          <DataTable
            columns={columns}
            rows={visibleRows}
            getRowKey={(item, index) =>
              idFor(item, config.resourceKey, index + (page - 1) * pageSize)
            }
            loading={state === 'booting'}
            unavailable={
              state === 'unavailable' || state === 'error'
                ? 'This resource is unavailable until the platform reconnects.'
                : undefined
            }
            empty={
              <EmptyState
                icon={config.icon}
                title={`No ${config.title.toLowerCase()} yet`}
                description={config.emptyDescription}
                action={
                  config.createCommand ? (
                    <Button onClick={openCreate}>Create one</Button>
                  ) : undefined
                }
              />
            }
          />
          {pageCount > 1 && <Pagination current={page} total={pageCount} onChange={setPage} />}
          <div className="screen-meta">
            {rows.length} {config.title.toLowerCase()} · page {page} of {pageCount}
          </div>
        </div>
      </div>
    </CapabilityGate>
  );
}
