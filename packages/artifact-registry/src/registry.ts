import { createHash } from 'node:crypto';
import {
  newSortableId,
  runtimeError,
  type Actor,
  type ArtifactReference,
  type HashSha256,
  type Id,
  type JsonValue,
  type RuntimeEvent,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import type {
  PersistedArtifactVersion,
  StateStore,
  StateTransaction,
} from '@agentic-platform/state';
import { InMemoryArtifactObjectStore, type ArtifactObjectStore } from './object-store.js';

export interface StagedUpload {
  stagedUploadId: Id;
  tenant: TenantRef;
  contentHash: HashSha256;
  sizeBytes: number;
  mediaType: string;
  createdAt: string;
}

export type ArtifactVersionRecord = PersistedArtifactVersion;

export interface PublishArtifactRequest {
  tenant: TenantRef;
  artifactId: Id;
  stagedUploadId: Id;
  mediaType: string;
  createdBy: Actor;
  invocationId?: Id;
  derivedFrom?: ArtifactReference[];
  expectedParentVersion?: number;
  schemaName?: string;
  retentionUntil?: string;
  now: string;
  expectedContentHash?: HashSha256;
  allowAgentRebase?: boolean;
}

export interface PublishArtifactResult {
  record: ArtifactVersionRecord;
  staleDescendants: ArtifactReference[];
  stagedCleanupPending: boolean;
}

export interface ArtifactRegistryOptions {
  cleanupStagedUpload?: (upload: StagedUpload) => Promise<void>;
  contentStore?: ArtifactObjectStore;
}

interface StoredUpload extends StagedUpload {
  content: Uint8Array;
}

interface RegistryState {
  staged: Map<string, StoredUpload>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function tenantKey(tenant: TenantRef): string {
  return `${tenant.tenantId}:${tenant.workspaceId}`;
}

function contentKey(contentHash: HashSha256): string {
  return `sha256/${contentHash}`;
}

function equalReference(left: ArtifactReference, right: ArtifactReference): boolean {
  return (
    left.tenant.tenantId === right.tenant.tenantId &&
    left.tenant.workspaceId === right.tenant.workspaceId &&
    left.artifactId === right.artifactId &&
    left.version === right.version
  );
}

function artifactReferencePayload(reference: ArtifactReference): JsonValue {
  return {
    schemaVersion: reference.schemaVersion,
    tenant: {
      tenantId: reference.tenant.tenantId,
      workspaceId: reference.tenant.workspaceId,
    },
    artifactId: reference.artifactId,
    version: reference.version,
    contentHash: reference.contentHash,
    mediaType: reference.mediaType,
    sizeBytes: reference.sizeBytes,
    createdAt: reference.createdAt,
    ...(reference.uri !== undefined ? { uri: reference.uri } : {}),
  };
}

function bytesFromChunk(chunk: Uint8Array | string): Uint8Array {
  return typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
}

async function collectContent(
  source: Uint8Array | string | AsyncIterable<Uint8Array | string>,
): Promise<{ bytes: Uint8Array; contentHash: HashSha256 }> {
  const hash = createHash('sha256');
  const chunks: Uint8Array[] = [];
  const iterable: AsyncIterable<Uint8Array | string> =
    typeof source === 'string' || source instanceof Uint8Array
      ? (async function* () {
          yield source;
        })()
      : source;

  let sizeBytes = 0;
  for await (const rawChunk of iterable) {
    const chunk = bytesFromChunk(rawChunk);
    hash.update(chunk);
    chunks.push(chunk);
    sizeBytes += chunk.byteLength;
  }

  const bytes = new Uint8Array(sizeBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, contentHash: hash.digest('hex') as HashSha256 };
}

async function appendArtifactEvent(
  transaction: StateTransaction,
  tenant: TenantRef,
  artifactId: Id,
  eventId: Id,
  eventName: string,
  actor: Actor,
  expectedVersion: number,
  payload: JsonValue,
  occurredAt: string,
): Promise<void> {
  const event: RuntimeEvent = {
    schemaVersion: 1,
    eventId,
    eventName,
    tenant,
    aggregateType: 'artifact',
    aggregateId: artifactId,
    aggregateVersion: expectedVersion + 1,
    occurredAt,
    actor,
    correlationId: artifactId,
    payload,
  };
  const stored = await transaction.events.append(event, expectedVersion);
  await transaction.outbox.enqueue(stored.event, 'runtime.events', occurredAt);
}

export class ContentAddressedArtifactRegistry {
  private state: RegistryState = {
    staged: new Map(),
  };
  private readonly contentStore: ArtifactObjectStore;

  constructor(
    private readonly authoritativeState: StateStore,
    private readonly options: ArtifactRegistryOptions = {},
  ) {
    this.contentStore = options.contentStore ?? new InMemoryArtifactObjectStore();
  }

  async stageUpload(
    tenant: TenantRef,
    source: Uint8Array | string | AsyncIterable<Uint8Array | string>,
    mediaType: string,
    createdAt: string,
    expectedContentHash?: HashSha256,
  ): Promise<StagedUpload> {
    const { bytes, contentHash } = await collectContent(source);
    if (expectedContentHash && expectedContentHash !== contentHash) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'Staged content hash does not match the expected hash',
      );
    }
    const upload: StoredUpload = {
      stagedUploadId: newSortableId(),
      tenant,
      contentHash,
      sizeBytes: bytes.byteLength,
      mediaType,
      createdAt,
      content: bytes,
    };
    this.state.staged.set(`${tenantKey(tenant)}:${upload.stagedUploadId}`, upload);
    return clone({
      stagedUploadId: upload.stagedUploadId,
      tenant: upload.tenant,
      contentHash: upload.contentHash,
      sizeBytes: upload.sizeBytes,
      mediaType: upload.mediaType,
      createdAt: upload.createdAt,
    });
  }

  async publish(request: PublishArtifactRequest): Promise<PublishArtifactResult> {
    const stagedKey = `${tenantKey(request.tenant)}:${request.stagedUploadId}`;
    const staged = this.state.staged.get(stagedKey);
    if (!staged) {
      throw runtimeError(
        'ARTIFACT_NOT_FOUND',
        `Staged upload ${request.stagedUploadId} is unavailable`,
      );
    }
    if (request.expectedContentHash && request.expectedContentHash !== staged.contentHash) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'Published content hash does not match the staged content',
      );
    }
    if (request.schemaName !== undefined && request.schemaName.length === 0) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Schema association cannot be empty');
    }

    const objectKey = contentKey(staged.contentHash);
    await this.contentStore.put(objectKey, new Uint8Array(staged.content));

    const publication = await this.authoritativeState.transaction(async (transaction) => {
      const current = await transaction.artifactVersions.current(
        request.tenant,
        request.artifactId,
      );
      const currentVersion = current?.reference.version ?? 0;
      const expectedParentVersion = request.expectedParentVersion ?? 0;
      if (expectedParentVersion !== currentVersion) {
        throw runtimeError(
          'CONCURRENCY_STALE_VERSION',
          `Artifact ${request.artifactId} expected parent ${request.expectedParentVersion ?? 'missing'}, actual ${currentVersion}`,
        );
      }
      if (
        current?.createdBy.type === 'human' &&
        request.createdBy.type === 'agent' &&
        !request.allowAgentRebase
      ) {
        throw runtimeError(
          'APPROVAL_INVALIDATED',
          'Agent publication cannot silently supersede a human artifact version',
        );
      }

      const lineage = [...(request.derivedFrom ?? [])];
      if (
        current &&
        request.createdBy.type === 'human' &&
        !lineage.some((reference) => equalReference(reference, current.reference))
      ) {
        lineage.push(current.reference);
      }
      for (const reference of lineage) {
        if (
          reference.tenant.tenantId !== request.tenant.tenantId ||
          reference.tenant.workspaceId !== request.tenant.workspaceId
        ) {
          throw runtimeError('ARTIFACT_NOT_FOUND', 'Artifact lineage crosses a tenant boundary');
        }
        if (
          !(await transaction.artifactVersions.get(
            request.tenant,
            reference.artifactId,
            reference.version,
          ))
        ) {
          throw runtimeError(
            'ARTIFACT_NOT_FOUND',
            `Lineage artifact ${reference.artifactId}@${reference.version} is unavailable`,
          );
        }
      }

      const nextVersion = currentVersion + 1;
      const reference: ArtifactReference = {
        schemaVersion: 1,
        tenant: request.tenant,
        artifactId: request.artifactId,
        version: nextVersion,
        contentHash: staged.contentHash,
        mediaType: request.mediaType,
        sizeBytes: staged.sizeBytes,
        createdAt: request.now,
        uri: contentKey(staged.contentHash),
      };
      const record: ArtifactVersionRecord = {
        reference,
        state: 'valid',
        createdBy: request.createdBy,
        lineage,
        publishedAt: request.now,
        ...(request.invocationId !== undefined ? { invocationId: request.invocationId } : {}),
        ...(request.schemaName !== undefined ? { schemaName: request.schemaName } : {}),
        ...(request.retentionUntil !== undefined ? { retentionUntil: request.retentionUntil } : {}),
      };

      const allVersions = await transaction.artifactVersions.list(request.tenant);
      const staleDescendants: ArtifactReference[] = [];
      if (request.createdBy.type === 'human' && current) {
        const queue = [current.reference];
        const visited = new Set<string>();
        while (queue.length > 0) {
          const parent = queue.shift();
          if (!parent) continue;
          const parentKey = `${parent.artifactId}:${parent.version}`;
          if (visited.has(parentKey)) continue;
          visited.add(parentKey);
          for (const candidate of allVersions) {
            if (
              equalReference(candidate.reference, reference) ||
              candidate.state === 'archived' ||
              candidate.state === 'stale'
            )
              continue;
            if (
              !candidate.lineage.some((lineageReference) =>
                equalReference(lineageReference, parent),
              )
            )
              continue;
            staleDescendants.push(candidate.reference);
            queue.push(candidate.reference);
          }
        }
      }

      await transaction.artifactVersions.publish(record, currentVersion);
      for (const stale of staleDescendants) {
        await transaction.artifactVersions.markStale(
          request.tenant,
          stale.artifactId,
          stale.version,
          request.now,
        );
      }
      await appendArtifactEvent(
        transaction,
        request.tenant,
        request.artifactId,
        newSortableId(),
        'artifact.published.v1',
        request.createdBy,
        currentVersion,
        {
          artifactId: request.artifactId,
          version: nextVersion,
          contentHash: staged.contentHash,
          actorType: request.createdBy.type,
          lineage: lineage.map(artifactReferencePayload),
        },
        request.now,
      );
      if (staleDescendants.length > 0) {
        await appendArtifactEvent(
          transaction,
          request.tenant,
          request.artifactId,
          newSortableId(),
          'artifact.descendants-marked-stale.v1',
          request.createdBy,
          currentVersion + 1,
          {
            sourceVersion: current?.reference.version ?? 0,
            descendants: staleDescendants.map(artifactReferencePayload),
          },
          request.now,
        );
      }
      return { record, staleDescendants };
    });

    const stagedMetadata: StagedUpload = {
      stagedUploadId: staged.stagedUploadId,
      tenant: staged.tenant,
      contentHash: staged.contentHash,
      sizeBytes: staged.sizeBytes,
      mediaType: staged.mediaType,
      createdAt: staged.createdAt,
    };
    try {
      await this.options.cleanupStagedUpload?.(stagedMetadata);
      this.state.staged.delete(stagedKey);
      return {
        record: clone(publication.record),
        staleDescendants: clone(publication.staleDescendants),
        stagedCleanupPending: false,
      };
    } catch {
      return {
        record: clone(publication.record),
        staleDescendants: clone(publication.staleDescendants),
        stagedCleanupPending: true,
      };
    }
  }

  async cleanupStagedUpload(tenant: TenantRef, stagedUploadId: Id): Promise<boolean> {
    const key = `${tenantKey(tenant)}:${stagedUploadId}`;
    const staged = this.state.staged.get(key);
    if (!staged) return true;
    const metadata: StagedUpload = {
      stagedUploadId: staged.stagedUploadId,
      tenant: staged.tenant,
      contentHash: staged.contentHash,
      sizeBytes: staged.sizeBytes,
      mediaType: staged.mediaType,
      createdAt: staged.createdAt,
    };
    try {
      await this.options.cleanupStagedUpload?.(metadata);
      this.state.staged.delete(key);
      return true;
    } catch {
      return false;
    }
  }

  async getVersion(
    tenant: TenantRef,
    artifactId: Id,
    version: number,
  ): Promise<ArtifactVersionRecord> {
    const record = await this.authoritativeState.transaction((transaction) =>
      transaction.artifactVersions.get(tenant, artifactId, version),
    );
    if (!record)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Artifact ${artifactId}@${version} is unavailable`);
    const bytes = await this.contentStore.get(contentKey(record.reference.contentHash));
    if (!bytes) throw runtimeError('ARTIFACT_NOT_FOUND', 'Artifact content is unavailable');
    const actualHash = createHash('sha256').update(bytes).digest('hex');
    if (actualHash !== record.reference.contentHash) {
      throw runtimeError('ARTIFACT_IMMUTABLE', 'Artifact content integrity verification failed');
    }
    return clone(record);
  }

  async readContent(tenant: TenantRef, artifactId: Id, version: number): Promise<Uint8Array> {
    const record = await this.getVersion(tenant, artifactId, version);
    const bytes = await this.contentStore.get(contentKey(record.reference.contentHash));
    if (!bytes) throw runtimeError('ARTIFACT_NOT_FOUND', 'Artifact content is unavailable');
    return new Uint8Array(bytes);
  }

  async currentVersion(
    tenant: TenantRef,
    artifactId: Id,
  ): Promise<ArtifactVersionRecord | undefined> {
    const record = await this.authoritativeState.transaction((transaction) =>
      transaction.artifactVersions.current(tenant, artifactId),
    );
    if (!record) return undefined;
    const bytes = await this.contentStore.get(contentKey(record.reference.contentHash));
    if (!bytes) throw runtimeError('ARTIFACT_NOT_FOUND', 'Artifact content is unavailable');
    const actualHash = createHash('sha256').update(bytes).digest('hex');
    if (actualHash !== record.reference.contentHash) {
      throw runtimeError('ARTIFACT_IMMUTABLE', 'Artifact content integrity verification failed');
    }
    return clone(record);
  }

  async listVersions(tenant: TenantRef, artifactId: Id): Promise<ArtifactVersionRecord[]> {
    const records = await this.authoritativeState.transaction((transaction) =>
      transaction.artifactVersions.list(tenant, artifactId),
    );
    const verified: ArtifactVersionRecord[] = [];
    for (const record of records) {
      verified.push(await this.getVersion(tenant, artifactId, record.reference.version));
    }
    return verified;
  }

  async listCurrent(tenant: TenantRef): Promise<ArtifactVersionRecord[]> {
    const records = await this.authoritativeState.transaction((transaction) =>
      transaction.artifactVersions.list(tenant),
    );
    const current = new Map<string, ArtifactVersionRecord>();
    for (const record of records) {
      const existing = current.get(record.reference.artifactId);
      if (existing === undefined || record.reference.version > existing.reference.version) {
        current.set(record.reference.artifactId, record);
      }
    }
    const verified: ArtifactVersionRecord[] = [];
    for (const record of current.values()) {
      verified.push(
        await this.getVersion(tenant, record.reference.artifactId, record.reference.version),
      );
    }
    return verified.sort((left, right) =>
      left.reference.artifactId.localeCompare(right.reference.artifactId),
    );
  }

  async stagedCount(tenant: TenantRef): Promise<number> {
    return [...this.state.staged.values()].filter(
      (upload) =>
        upload.tenant.tenantId === tenant.tenantId &&
        upload.tenant.workspaceId === tenant.workspaceId,
    ).length;
  }
}
