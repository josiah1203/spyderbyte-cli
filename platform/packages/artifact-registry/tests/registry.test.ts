import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Actor, Id, TenantRef } from '@agentic-platform/runtime-contracts';
import {
  InMemoryStateStore,
  type StateStore,
  type StateTransaction,
} from '@agentic-platform/state';
import {
  ContentAddressedArtifactRegistry,
  FileSystemArtifactObjectStore,
  type PublishArtifactRequest,
} from '../src/index.js';

const tenantId = '018f0c4b-4e10-7abc-8def-0123456789ab' as Id;
const workspaceId = '018f0c4b-4e11-7abc-8def-0123456789ab' as Id;
const otherTenantId = '018f0c4b-4e12-7abc-8def-0123456789ab' as Id;
const otherWorkspaceId = '018f0c4b-4e13-7abc-8def-0123456789ab' as Id;
const rootArtifactId = '018f0c4b-4e14-7abc-8def-0123456789ab' as Id;
const childArtifactId = '018f0c4b-4e15-7abc-8def-0123456789ab' as Id;
const actorId = '018f0c4b-4e16-7abc-8def-0123456789ab' as Id;
const agentId = '018f0c4b-4e17-7abc-8def-0123456789ab' as Id;
const now = '2026-08-02T00:00:00.000Z';
const later = '2026-08-02T00:01:00.000Z';

const tenant: TenantRef = { tenantId, workspaceId };
const otherTenant: TenantRef = { tenantId: otherTenantId, workspaceId: otherWorkspaceId };
const human: Actor = { actorId, type: 'human', displayName: 'Artifact owner' };
const agent: Actor = { actorId: agentId, type: 'agent', displayName: 'Artifact worker' };

async function stageAndPublish(
  registry: ContentAddressedArtifactRegistry,
  artifactId: Id,
  createdBy: Actor = human,
  content = '{"value":1}',
  options: Pick<PublishArtifactRequest, 'derivedFrom' | 'expectedParentVersion'> = {},
) {
  const staged = await registry.stageUpload(tenant, content, 'application/json', now);
  return registry.publish({
    tenant,
    artifactId,
    stagedUploadId: staged.stagedUploadId,
    mediaType: 'application/json',
    createdBy,
    now,
    ...options,
  });
}

describe('ContentAddressedArtifactRegistry', () => {
  it('provides an immutable filesystem-backed CAS object store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'artifact-registry-'));
    const objectKey = `sha256/${'a'.repeat(64)}`;
    const content = new TextEncoder().encode('immutable bytes');
    try {
      const firstStore = new FileSystemArtifactObjectStore(root);
      await firstStore.put(objectKey, content);
      const secondStore = new FileSystemArtifactObjectStore(root);
      expect(await secondStore.get(objectKey)).toEqual(content);
      await expect(secondStore.put(objectKey, new Uint8Array([1, 2, 3]))).rejects.toThrow(
        'different bytes',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('hashes streamed content, publishes immutable CAS versions, and emits an outbox event', async () => {
    const store = new InMemoryStateStore();
    const registry = new ContentAddressedArtifactRegistry(store);
    const chunks = (async function* () {
      yield new Uint8Array([123, 34, 118]);
      yield 'alue":1}';
    })();

    const staged = await registry.stageUpload(tenant, chunks, 'application/json', now);
    expect(staged.sizeBytes).toBe(11);
    expect(staged).not.toHaveProperty('content');

    const published = await registry.publish({
      tenant,
      artifactId: rootArtifactId,
      stagedUploadId: staged.stagedUploadId,
      mediaType: 'application/json',
      createdBy: human,
      now,
      expectedContentHash: staged.contentHash,
    });

    expect(published.record.reference).toMatchObject({
      artifactId: rootArtifactId,
      version: 1,
      contentHash: staged.contentHash,
      uri: `sha256/${staged.contentHash}`,
    });
    expect(await registry.readContent(tenant, rootArtifactId, 1)).toEqual(
      new TextEncoder().encode('{"value":1}'),
    );
    expect(await registry.currentVersion(tenant, rootArtifactId)).toMatchObject({
      reference: { version: 1 },
    });
    expect(await registry.stagedCount(tenant)).toBe(0);

    const snapshot = await store.snapshot();
    expect(snapshot.events.map(({ event }) => event.eventName)).toEqual(['artifact.published.v1']);
    expect(snapshot.outbox).toHaveLength(1);
  });

  it('reopens published metadata and bytes from the state store and filesystem CAS', async () => {
    const root = await mkdtemp(join(tmpdir(), 'artifact-registry-reopen-'));
    try {
      const store = new InMemoryStateStore();
      const registry = new ContentAddressedArtifactRegistry(store, {
        contentStore: new FileSystemArtifactObjectStore(root),
      });
      await stageAndPublish(registry, rootArtifactId, human, '{"value":9}');

      const reopened = new ContentAddressedArtifactRegistry(store, {
        contentStore: new FileSystemArtifactObjectStore(root),
      });
      expect(await reopened.currentVersion(tenant, rootArtifactId)).toMatchObject({
        reference: { version: 1 },
      });
      expect(await reopened.readContent(tenant, rootArtifactId, 1)).toEqual(
        new TextEncoder().encode('{"value":9}'),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects invalid staged content, cross-tenant lineage, and missing staged uploads', async () => {
    const store = new InMemoryStateStore();
    const registry = new ContentAddressedArtifactRegistry(store);
    const wrongHash = '0000000000000000000000000000000000000000000000000000000000000000' as never;

    await expect(
      registry.stageUpload(tenant, 'wrong hash', 'text/plain', now, wrongHash),
    ).rejects.toThrow('does not match the expected hash');
    expect(await registry.stagedCount(tenant)).toBe(0);

    const root = await stageAndPublish(registry, rootArtifactId);
    const otherStaged = await registry.stageUpload(
      otherTenant,
      'other tenant content',
      'text/plain',
      now,
    );
    await expect(
      registry.publish({
        tenant: otherTenant,
        artifactId: childArtifactId,
        stagedUploadId: otherStaged.stagedUploadId,
        mediaType: 'text/plain',
        createdBy: agent,
        derivedFrom: [root.record.reference],
        now,
      }),
    ).rejects.toThrow('crosses a tenant boundary');
    expect(await registry.stagedCount(otherTenant)).toBe(1);

    await expect(
      registry.publish({
        tenant,
        artifactId: childArtifactId,
        stagedUploadId: '018f0c4b-4e18-7abc-8def-0123456789ab' as Id,
        mediaType: 'text/plain',
        createdBy: agent,
        now,
      }),
    ).rejects.toThrow('is unavailable');
  });

  it('enforces optimistic parents and human precedence over agent writes', async () => {
    const store = new InMemoryStateStore();
    const registry = new ContentAddressedArtifactRegistry(store);
    const first = await stageAndPublish(registry, rootArtifactId, human, '{"value":1}');

    const agentStaged = await registry.stageUpload(
      tenant,
      '{"value":2}',
      'application/json',
      later,
    );
    await expect(
      registry.publish({
        tenant,
        artifactId: rootArtifactId,
        stagedUploadId: agentStaged.stagedUploadId,
        mediaType: 'application/json',
        createdBy: agent,
        expectedParentVersion: first.record.reference.version,
        now: later,
      }),
    ).rejects.toThrow('cannot silently supersede a human artifact version');

    const humanStaged = await registry.stageUpload(
      tenant,
      '{"value":3}',
      'application/json',
      later,
    );
    const second = await registry.publish({
      tenant,
      artifactId: rootArtifactId,
      stagedUploadId: humanStaged.stagedUploadId,
      mediaType: 'application/json',
      createdBy: human,
      expectedParentVersion: 1,
      now: later,
    });
    expect(second.record.reference.version).toBe(2);

    const staleStaged = await registry.stageUpload(
      tenant,
      '{"value":4}',
      'application/json',
      later,
    );
    await expect(
      registry.publish({
        tenant,
        artifactId: rootArtifactId,
        stagedUploadId: staleStaged.stagedUploadId,
        mediaType: 'application/json',
        createdBy: human,
        expectedParentVersion: 1,
        now: later,
      }),
    ).rejects.toThrow('expected parent 1, actual 2');
  });

  it('rejects concurrent writers that both target the same parent version', async () => {
    const store = new InMemoryStateStore();
    const registry = new ContentAddressedArtifactRegistry(store);
    await stageAndPublish(registry, rootArtifactId, human, '{"value":1}');
    const first = await registry.stageUpload(tenant, '{"value":2}', 'application/json', later);
    const second = await registry.stageUpload(tenant, '{"value":3}', 'application/json', later);

    const results = await Promise.allSettled([
      registry.publish({
        tenant,
        artifactId: rootArtifactId,
        stagedUploadId: first.stagedUploadId,
        mediaType: 'application/json',
        createdBy: human,
        expectedParentVersion: 1,
        now: later,
      }),
      registry.publish({
        tenant,
        artifactId: rootArtifactId,
        stagedUploadId: second.stagedUploadId,
        mediaType: 'application/json',
        createdBy: human,
        expectedParentVersion: 1,
        now: later,
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' ? rejected.reason.code : undefined).toBe(
      'CONCURRENCY_STALE_VERSION',
    );
    expect((await registry.currentVersion(tenant, rootArtifactId))?.reference.version).toBe(2);
    expect(await registry.stagedCount(tenant)).toBe(1);
  });

  it('marks derived versions stale after a human source edit and records lineage', async () => {
    const store = new InMemoryStateStore();
    const registry = new ContentAddressedArtifactRegistry(store);
    const root = await stageAndPublish(registry, rootArtifactId, human, '{"source":1}');
    const child = await stageAndPublish(registry, childArtifactId, agent, '{"derived":1}', {
      derivedFrom: [root.record.reference],
    });

    const edited = await stageAndPublish(registry, rootArtifactId, human, '{"source":2}', {
      expectedParentVersion: 1,
    });

    expect(edited.record.lineage).toEqual([root.record.reference]);
    expect(edited.staleDescendants).toEqual([child.record.reference]);
    expect((await registry.getVersion(tenant, childArtifactId, 1)).state).toBe('stale');

    const snapshot = await store.snapshot();
    expect(snapshot.events.map(({ event }) => event.eventName)).toEqual([
      'artifact.published.v1',
      'artifact.published.v1',
      'artifact.published.v1',
      'artifact.descendants-marked-stale.v1',
    ]);
  });

  it('does not publish memory state when the authoritative transaction fails', async () => {
    const backingStore = new InMemoryStateStore();
    let shouldFail = true;
    const failingStore: StateStore = {
      transaction<T>(work: (transaction: StateTransaction) => Promise<T>): Promise<T> {
        if (shouldFail) {
          shouldFail = false;
          return Promise.reject(new Error('database commit failed'));
        }
        return backingStore.transaction(work);
      },
    };
    const registry = new ContentAddressedArtifactRegistry(failingStore);
    const staged = await registry.stageUpload(tenant, '{"value":1}', 'application/json', now);

    await expect(
      registry.publish({
        tenant,
        artifactId: rootArtifactId,
        stagedUploadId: staged.stagedUploadId,
        mediaType: 'application/json',
        createdBy: human,
        now,
      }),
    ).rejects.toThrow('database commit failed');
    expect(await registry.currentVersion(tenant, rootArtifactId)).toBeUndefined();
    expect(await registry.stagedCount(tenant)).toBe(1);
  });

  it('keeps a cleanup receipt pending when database commit succeeds but object cleanup fails', async () => {
    const store = new InMemoryStateStore();
    let failCleanup = true;
    const registry = new ContentAddressedArtifactRegistry(store, {
      cleanupStagedUpload: async () => {
        if (failCleanup) {
          failCleanup = false;
          throw new Error('object cleanup unavailable');
        }
      },
    });
    const staged = await registry.stageUpload(tenant, '{"value":1}', 'application/json', now);

    const published = await registry.publish({
      tenant,
      artifactId: rootArtifactId,
      stagedUploadId: staged.stagedUploadId,
      mediaType: 'application/json',
      createdBy: human,
      now,
    });
    expect(published.stagedCleanupPending).toBe(true);
    expect(await registry.currentVersion(tenant, rootArtifactId)).toBeDefined();
    expect(await registry.stagedCount(tenant)).toBe(1);

    expect(await registry.cleanupStagedUpload(tenant, staged.stagedUploadId)).toBe(true);
    expect(await registry.stagedCount(tenant)).toBe(0);
  });
});
