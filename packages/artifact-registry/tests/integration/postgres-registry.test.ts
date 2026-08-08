import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newSortableId, type Actor, type TenantRef } from '@agentic-platform/runtime-contracts';
import { applyPostgresMigrations, PostgresStateStore } from '@agentic-platform/state';
import { ContentAddressedArtifactRegistry } from '../../src/index.js';

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase('ContentAddressedArtifactRegistry with PostgreSQL state', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const store = new PostgresStateStore(pool);

  beforeAll(async () => {
    const migration = await readFile(
      new URL('../../../state/migrations/0001_authoritative_state.sql', import.meta.url),
      'utf8',
    );
    const projectsMigration = await readFile(
      new URL('../../../state/migrations/0002_projects.sql', import.meta.url),
      'utf8',
    );
    const appendOnlyGuard = await readFile(
      new URL('../../../state/migrations/0001_append_only.postgres.sql', import.meta.url),
      'utf8',
    );
    await applyPostgresMigrations(pool, `${migration}\n${projectsMigration}`, appendOnlyGuard);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('persists lineage and stale lifecycle status in one authoritative transaction', async () => {
    const registry = new ContentAddressedArtifactRegistry(store);
    const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
    const human: Actor = {
      actorId: newSortableId(),
      type: 'human',
      displayName: 'Postgres artifact owner',
    };
    const agent: Actor = {
      actorId: newSortableId(),
      type: 'agent',
      displayName: 'Postgres artifact worker',
    };
    const rootArtifactId = newSortableId();
    const childArtifactId = newSortableId();
    const now = '2026-08-02T00:00:00.000Z';
    const later = '2026-08-02T00:01:00.000Z';

    const rootUpload = await registry.stageUpload(tenant, '{"source":1}', 'application/json', now);
    const root = await registry.publish({
      tenant,
      artifactId: rootArtifactId,
      stagedUploadId: rootUpload.stagedUploadId,
      mediaType: 'application/json',
      createdBy: human,
      now,
    });
    const childUpload = await registry.stageUpload(
      tenant,
      '{"derived":1}',
      'application/json',
      now,
    );
    const child = await registry.publish({
      tenant,
      artifactId: childArtifactId,
      stagedUploadId: childUpload.stagedUploadId,
      mediaType: 'application/json',
      createdBy: agent,
      derivedFrom: [root.record.reference],
      now,
    });
    const editUpload = await registry.stageUpload(
      tenant,
      '{"source":2}',
      'application/json',
      later,
    );
    await registry.publish({
      tenant,
      artifactId: rootArtifactId,
      stagedUploadId: editUpload.stagedUploadId,
      mediaType: 'application/json',
      createdBy: human,
      expectedParentVersion: 1,
      now: later,
    });

    await store.transaction(async (transaction) => {
      const persistedChild = await transaction.artifactVersions.get(
        tenant,
        childArtifactId,
        child.record.reference.version,
      );
      expect(persistedChild).toMatchObject({
        state: 'stale',
        lineage: [root.record.reference],
      });
      expect(await transaction.events.list(tenant)).toHaveLength(4);
      expect(await transaction.outbox.pending(tenant, later)).toHaveLength(4);
    });
  });
});
