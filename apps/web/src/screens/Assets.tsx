import { useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  SearchInput,
  SectionLabel,
} from '../components/primitives';
import RuntimeStateNotice from '../components/RuntimeStateNotice';
import { useRuntime } from '../runtime/RuntimeProvider';
import { useRuntimeStore } from '../runtime/store';

type Filter = 'All' | 'Valid' | 'Stale' | 'Archived';

type JsonRecord = Record<string, unknown>;

interface ArtifactDetails {
  readonly current: JsonRecord;
  readonly versions: readonly JsonRecord[];
  readonly lineage: readonly JsonRecord[];
}

interface ArtifactContent {
  readonly artifactId: string;
  readonly version: number;
  readonly mediaType: string;
  readonly contentHash: string;
  readonly contentBase64: string;
}

interface ArtifactDiff {
  readonly artifactId: string;
  readonly fromVersion?: number;
  readonly toVersion: number;
  readonly mediaType: string;
  readonly format: string;
  readonly changed: boolean;
  readonly summary: JsonRecord;
  readonly changes: readonly JsonRecord[];
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function records(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  return value.map(asRecord).filter((item): item is JsonRecord => item !== undefined);
}

function reference(value: unknown): JsonRecord | undefined {
  return asRecord(value);
}

function referenceLabel(value: unknown): string {
  const item = reference(value);
  if (item === undefined) return 'Unknown artifact reference';
  const artifactId = typeof item.artifactId === 'string' ? item.artifactId : 'Unknown artifact';
  const version = typeof item.version === 'number' ? ` · v${item.version}` : '';
  const mediaType = typeof item.mediaType === 'string' ? ` · ${item.mediaType}` : '';
  return `${artifactId}${version}${mediaType}`;
}

function actorLabel(value: unknown): string {
  const actor = asRecord(value);
  if (typeof actor?.displayName === 'string') return actor.displayName;
  if (typeof actor?.actorId === 'string') return actor.actorId;
  return 'Unknown actor';
}

function artifactContent(value: unknown): ArtifactContent {
  const item = asRecord(value);
  if (
    item === undefined ||
    typeof item.artifactId !== 'string' ||
    typeof item.version !== 'number' ||
    !Number.isSafeInteger(item.version) ||
    item.version < 1 ||
    typeof item.mediaType !== 'string' ||
    typeof item.contentHash !== 'string' ||
    typeof item.contentBase64 !== 'string'
  ) {
    throw new Error('Artifact content returned an invalid record.');
  }
  return {
    artifactId: item.artifactId,
    version: item.version,
    mediaType: item.mediaType,
    contentHash: item.contentHash,
    contentBase64: item.contentBase64,
  };
}

function artifactDiff(value: unknown): ArtifactDiff {
  const item = asRecord(value);
  if (
    item === undefined ||
    typeof item.artifactId !== 'string' ||
    typeof item.toVersion !== 'number' ||
    !Number.isSafeInteger(item.toVersion) ||
    typeof item.mediaType !== 'string' ||
    typeof item.format !== 'string' ||
    typeof item.changed !== 'boolean' ||
    asRecord(item.summary) === undefined ||
    !Array.isArray(item.changes)
  ) {
    throw new Error('Artifact diff returned an invalid record.');
  }
  return {
    artifactId: item.artifactId,
    ...(typeof item.fromVersion === 'number' ? { fromVersion: item.fromVersion } : {}),
    toVersion: item.toVersion,
    mediaType: item.mediaType,
    format: item.format,
    changed: item.changed,
    summary: asRecord(item.summary) ?? {},
    changes: records(item.changes),
  };
}

function decodeBase64(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function previewText(content: ArtifactContent): string | undefined {
  const normalizedMediaType = content.mediaType.toLowerCase();
  const isText =
    normalizedMediaType.startsWith('text/') ||
    /(?:csv|tsv|json|sql|javascript|typescript|python|yaml|xml)/.test(normalizedMediaType);
  if (!isText) return undefined;
  return new TextDecoder().decode(decodeBase64(content.contentBase64));
}

function fileExtension(mediaType: string): string {
  const normalizedMediaType = mediaType.toLowerCase();
  if (normalizedMediaType.includes('json')) return 'json';
  if (normalizedMediaType.includes('csv')) return 'csv';
  if (normalizedMediaType.includes('sql')) return 'sql';
  if (normalizedMediaType.startsWith('text/')) return 'txt';
  return 'bin';
}

function artifactFilename(content: ArtifactContent): string {
  const safeId = content.artifactId.replace(/[^a-zA-Z0-9._-]+/g, '_');
  return `${safeId}.v${content.version}.${fileExtension(content.mediaType)}`;
}

function downloadArtifact(content: ArtifactContent): void {
  const createObjectUrl = globalThis.URL?.createObjectURL;
  const revokeObjectUrl = globalThis.URL?.revokeObjectURL;
  if (typeof createObjectUrl !== 'function' || typeof revokeObjectUrl !== 'function') {
    throw new Error('Artifact export is unavailable in this runtime.');
  }
  const bytes = decodeBase64(content.contentBase64);
  const blob = new Blob([bytes.buffer], { type: content.mediaType });
  const url = createObjectUrl.call(globalThis.URL, blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = artifactFilename(content);
  anchor.click();
  revokeObjectUrl.call(globalThis.URL, url);
}

function displayValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '—';
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

function artifactFromLocation(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const value = new URLSearchParams(window.location.search).get('artifact');
  return value === null || value.length === 0 ? undefined : value;
}

export default function Assets() {
  const runtime = useRuntime();
  const snapshot = useRuntimeStore(runtime);
  const [filter, setFilter] = useState<Filter>('All');
  const [search, setSearch] = useState('');
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | undefined>(
    artifactFromLocation,
  );
  const [details, setDetails] = useState<ArtifactDetails>();
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsMessage, setDetailsMessage] = useState<string>();
  const [content, setContent] = useState<ArtifactContent>();
  const [contentLoading, setContentLoading] = useState(false);
  const [contentMessage, setContentMessage] = useState<string>();
  const [diff, setDiff] = useState<ArtifactDiff>();
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffMessage, setDiffMessage] = useState<string>();
  const value =
    snapshot.projections['artifact-catalog-lineage']?.data ??
    snapshot.projections['artifact-catalog-lineage']?.state;
  const artifacts =
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'artifacts' in value &&
    value.artifacts !== null &&
    typeof value.artifacts === 'object' &&
    !Array.isArray(value.artifacts)
      ? Object.values(value.artifacts as Record<string, unknown>)
      : [];
  const filtered = artifacts.filter((candidate) => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate))
      return false;
    const artifact = candidate as Record<string, unknown>;
    const state = typeof artifact.state === 'string' ? artifact.state : 'unknown';
    return (
      (filter === 'All' || state.toLowerCase() === filter.toLowerCase()) &&
      String(artifact.artifactId ?? '')
        .toLowerCase()
        .includes(search.toLowerCase())
    );
  }) as Record<string, unknown>[];

  useEffect(() => {
    if (selectedArtifactId === undefined) {
      setDetails(undefined);
      setDetailsMessage(undefined);
      return undefined;
    }
    if (snapshot.connection === 'booting') return undefined;
    if (runtime.client.get === undefined) {
      setDetails(undefined);
      setDetailsMessage('Artifact detail loading is unavailable in this runtime.');
      return undefined;
    }
    const controller = new AbortController();
    const encodedId = encodeURIComponent(selectedArtifactId);
    setDetails(undefined);
    setDetailsMessage(undefined);
    setDetailsLoading(true);
    void Promise.all([
      runtime.client.get<unknown>(`/v1/artifacts/${encodedId}`, { signal: controller.signal }),
      runtime.client.get<unknown>(`/v1/artifacts/${encodedId}/versions`, {
        signal: controller.signal,
      }),
      runtime.client.get<unknown>(`/v1/artifacts/${encodedId}/lineage`, {
        signal: controller.signal,
      }),
    ])
      .then(([current, versions, lineage]) => {
        if (controller.signal.aborted) return;
        const currentRecord = asRecord(current);
        if (currentRecord === undefined)
          throw new Error('Artifact detail returned an invalid record.');
        setDetails({
          current: currentRecord,
          versions: records(versions),
          lineage: records(lineage),
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setDetailsMessage(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailsLoading(false);
      });
    return () => controller.abort();
  }, [runtime, selectedArtifactId, snapshot.connection, snapshot.cursor]);

  useEffect(() => {
    setContent(undefined);
    setContentMessage(undefined);
    setDiff(undefined);
    setDiffMessage(undefined);
  }, [selectedArtifactId]);

  async function readArtifactVersion(version: number): Promise<ArtifactContent> {
    if (runtime.client.get === undefined) {
      throw new Error('Artifact content loading is unavailable in this runtime.');
    }
    const value = await runtime.client.get<unknown>(
      `/v1/artifacts/${encodeURIComponent(selectedArtifactId ?? '')}/versions/${version}/content`,
    );
    return artifactContent(value);
  }

  async function openArtifactVersion(version: number): Promise<void> {
    setContentLoading(true);
    setContentMessage(undefined);
    try {
      const value = await readArtifactVersion(version);
      setContent(value);
      setContentMessage(`Opened immutable artifact v${value.version}.`);
    } catch (error) {
      setContentMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setContentLoading(false);
    }
  }

  async function exportArtifactVersion(version: number): Promise<void> {
    setContentLoading(true);
    setContentMessage(undefined);
    try {
      const value = await readArtifactVersion(version);
      downloadArtifact(value);
      setContentMessage(`Exported immutable artifact v${value.version}.`);
    } catch (error) {
      setContentMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setContentLoading(false);
    }
  }

  async function compareArtifactVersions(): Promise<void> {
    if (currentVersion === undefined || currentVersion < 2 || runtime.client.get === undefined) {
      setDiffMessage('A current artifact version and an older version are required for a diff.');
      return;
    }
    setDiffLoading(true);
    setDiffMessage(undefined);
    try {
      const value = await runtime.client.get<unknown>(
        `/v1/artifacts/${encodeURIComponent(selectedArtifactId ?? '')}/diff?fromVersion=${currentVersion - 1}&toVersion=${currentVersion}`,
      );
      setDiff(artifactDiff(value));
    } catch (error) {
      setDiffMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setDiffLoading(false);
    }
  }

  const currentReference = reference(details?.current.reference);
  const currentVersion =
    (typeof details?.current.currentVersion === 'number'
      ? details.current.currentVersion
      : undefined) ??
    (typeof currentReference?.version === 'number' ? currentReference.version : undefined);
  const currentHash =
    (typeof details?.current.contentHash === 'string' ? details.current.contentHash : undefined) ??
    (typeof currentReference?.contentHash === 'string' ? currentReference.contentHash : undefined);
  const currentMediaType =
    (typeof details?.current.mediaType === 'string' ? details.current.mediaType : undefined) ??
    (typeof currentReference?.mediaType === 'string' ? currentReference.mediaType : undefined);

  return (
    <div className="page-scroll">
      <div className="page">
        <div className="toolbar">
          <SearchInput
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search artifact IDs…"
            aria-label="Search artifact IDs"
          />
          <div className="filter-group" role="group" aria-label="Artifact filters">
            {(['All', 'Valid', 'Stale', 'Archived'] as Filter[]).map((value) => (
              <Button
                key={value}
                variant={filter === value ? 'primary' : 'secondary'}
                onClick={() => setFilter(value)}
              >
                {value}
              </Button>
            ))}
          </div>
        </div>
        <RuntimeStateNotice state={snapshot.connection} onRetry={() => void runtime.retry()} />
        {snapshot.connection === 'booting' ? (
          <div className="home-state">Loading authoritative artifacts…</div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon="box"
            title="No published artifacts"
            description="Published artifacts will appear here when the platform publishes them."
          />
        ) : (
          <div className="asset-grid">
            {filtered.map((artifact) => (
              <Card className="asset-card" key={String(artifact.artifactId)}>
                <div className="asset-id">{String(artifact.artifactId)}</div>
                <div className="asset-meta">
                  <Badge color={artifact.state === 'valid' ? 'green' : 'gray'}>
                    {String(artifact.state ?? 'unknown')}
                  </Badge>
                  <span>v{String(artifact.currentVersion ?? '—')}</span>
                </div>
                <div className="asset-updated">Updated {String(artifact.lastEventAt ?? '—')}</div>
                <Button
                  variant="tertiary"
                  onClick={() => setSelectedArtifactId(String(artifact.artifactId))}
                >
                  Inspect versions and lineage
                </Button>
              </Card>
            ))}
          </div>
        )}
        {selectedArtifactId !== undefined && (
          <Card className="asset-detail-card" aria-live="polite">
            <div className="card-heading">
              <div>
                <SectionLabel>Artifact detail</SectionLabel>
                <h2>{selectedArtifactId}</h2>
              </div>
              <Button variant="tertiary" onClick={() => setSelectedArtifactId(undefined)}>
                Close
              </Button>
            </div>
            {detailsLoading && <div className="home-state">Loading immutable detail…</div>}
            {detailsMessage && (
              <div className="home-error" role="status">
                {detailsMessage}
              </div>
            )}
            {details && (
              <div className="asset-detail-body">
                <dl className="asset-detail-meta">
                  <div>
                    <dt>State</dt>
                    <dd>{String(details.current.state ?? 'unknown')}</dd>
                  </div>
                  <div>
                    <dt>Current version</dt>
                    <dd>{currentVersion === undefined ? '—' : `v${currentVersion}`}</dd>
                  </div>
                  <div>
                    <dt>Media type</dt>
                    <dd>{currentMediaType ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>Content hash</dt>
                    <dd className="asset-content-hash">{currentHash ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>Created by</dt>
                    <dd>{actorLabel(details.current.createdBy)}</dd>
                  </div>
                  <div>
                    <dt>Published</dt>
                    <dd>{String(details.current.publishedAt ?? '—')}</dd>
                  </div>
                </dl>
                <section>
                  <SectionLabel>Content</SectionLabel>
                  <p className="asset-content-help">
                    Read immutable bytes from the local authority, preview text, or export the exact
                    selected version.
                  </p>
                  <div className="asset-content-actions">
                    {currentVersion !== undefined && (
                      <>
                        <Button
                          variant="secondary"
                          loading={contentLoading}
                          onClick={() => void openArtifactVersion(currentVersion)}
                        >
                          Open current artifact
                        </Button>
                        <Button
                          variant="tertiary"
                          loading={contentLoading}
                          onClick={() => void exportArtifactVersion(currentVersion)}
                        >
                          Export current artifact
                        </Button>
                      </>
                    )}
                    {currentVersion !== undefined && (
                      <>
                        {currentVersion > 1 && (
                          <Button
                            variant="tertiary"
                            loading={diffLoading}
                            onClick={() => void compareArtifactVersions()}
                          >
                            Compare v{currentVersion - 1} → v{currentVersion}
                          </Button>
                        )}
                        <a
                          className="ds-button"
                          data-variant="tertiary"
                          href={`/notebooks?artifact=${encodeURIComponent(selectedArtifactId)}&version=${currentVersion}`}
                        >
                          Continue in notebook
                        </a>
                      </>
                    )}
                  </div>
                  {contentMessage && (
                    <div className="home-error" role="status">
                      {contentMessage}
                    </div>
                  )}
                  {content && (
                    <div className="asset-content-preview-card">
                      <div className="asset-content-preview-heading">
                        <strong>
                          v{content.version} · {content.mediaType}
                        </strong>
                        <span>{content.contentHash}</span>
                      </div>
                      {previewText(content) === undefined ? (
                        <div className="panel-empty">
                          Binary content loaded ({decodeBase64(content.contentBase64).byteLength}{' '}
                          bytes). Export it to inspect the original bytes.
                        </div>
                      ) : (
                        <pre className="asset-content-preview">{previewText(content)}</pre>
                      )}
                    </div>
                  )}
                </section>
                <section>
                  <SectionLabel>Structured diff</SectionLabel>
                  {diffMessage && (
                    <div className="home-error" role="status">
                      {diffMessage}
                    </div>
                  )}
                  {diff && (
                    <div className="asset-diff-card">
                      <div className="asset-diff-summary">
                        <span>{diff.changed ? 'Changed' : 'Unchanged'}</span>
                        <span>{diff.format}</span>
                        <span>
                          +{String(diff.summary.added ?? 0)} / -{String(diff.summary.removed ?? 0)}
                          {' · '}
                          {String(diff.summary.changed ?? 0)} changed
                        </span>
                      </div>
                      {diff.changes.length === 0 ? (
                        <div className="panel-empty">No structured changes between versions.</div>
                      ) : (
                        <ul className="asset-diff-list">
                          {diff.changes.map((change, index) => (
                            <li key={`${String(change.path)}-${index}`}>
                              <strong>{String(change.kind ?? 'changed')}</strong>
                              <code>{String(change.path ?? '—')}</code>
                              <span>
                                {displayValue(change.before)} → {displayValue(change.after)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </section>
                <section>
                  <SectionLabel>Lineage</SectionLabel>
                  {details.lineage.length === 0 ? (
                    <div className="panel-empty">No upstream artifact references.</div>
                  ) : (
                    <ul className="asset-lineage-list">
                      {details.lineage.map((item, index) => (
                        <li key={`${referenceLabel(item)}-${index}`}>{referenceLabel(item)}</li>
                      ))}
                    </ul>
                  )}
                </section>
                <section>
                  <SectionLabel>Immutable versions</SectionLabel>
                  {details.versions.length === 0 ? (
                    <div className="panel-empty">No version records returned.</div>
                  ) : (
                    <ul className="asset-version-list">
                      {details.versions.map((item, index) => {
                        const itemReference = reference(item.reference) ?? item;
                        const version =
                          typeof itemReference.version === 'number'
                            ? itemReference.version
                            : undefined;
                        return (
                          <li key={`${referenceLabel(itemReference)}-${index}`}>
                            <div>
                              <strong>{referenceLabel(itemReference)}</strong>
                              <span>{String(item.publishedAt ?? item.createdAt ?? '—')}</span>
                            </div>
                            {version !== undefined && (
                              <div className="asset-version-actions">
                                <Button
                                  variant="tertiary"
                                  loading={contentLoading}
                                  onClick={() => void openArtifactVersion(version)}
                                >
                                  Open v{version}
                                </Button>
                                <Button
                                  variant="tertiary"
                                  loading={contentLoading}
                                  onClick={() => void exportArtifactVersion(version)}
                                >
                                  Export v{version}
                                </Button>
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              </div>
            )}
          </Card>
        )}
        <div className="screen-meta">
          <SectionLabel>
            {filtered.length} artifact{filtered.length === 1 ? '' : 's'}
          </SectionLabel>
        </div>
      </div>
    </div>
  );
}
