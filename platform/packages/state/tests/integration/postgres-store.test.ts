import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newSortableId } from '@agentic-platform/runtime-contracts';
import { applyPostgresMigrations, PostgresStateStore } from '../../src/index.js';
import { registerStateContractSuite } from '../state-contract-suite.js';

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase('PostgresStateStore', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const store = new PostgresStateStore(pool);

  beforeAll(async () => {
    const migration = await readFile(
      new URL('../../migrations/0001_authoritative_state.sql', import.meta.url),
      'utf8',
    );
    const projectsMigration = await readFile(
      new URL('../../migrations/0002_projects.sql', import.meta.url),
      'utf8',
    );
    const appendOnlyGuard = await readFile(
      new URL('../../migrations/0001_append_only.postgres.sql', import.meta.url),
      'utf8',
    );
    await applyPostgresMigrations(pool, `${migration}\n${projectsMigration}`, appendOnlyGuard);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('enforces append-only artifact versions in PostgreSQL', async () => {
    const tenantId = newSortableId();
    const workspaceId = newSortableId();
    const artifactId = newSortableId();
    const contentHash = `hash-${newSortableId()}`;
    const objectKey = `sha256/${contentHash}`;
    const publishedAt = '2026-08-02T00:00:00.000Z';

    await pool.query(
      `INSERT INTO artifact_content_objects
        (tenant_id, workspace_id, content_hash, object_key, media_type, size_bytes, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tenantId, workspaceId, contentHash, objectKey, 'text/plain', 1, publishedAt],
    );
    await pool.query(
      `INSERT INTO artifact_versions
        (tenant_id, workspace_id, artifact_id, version, content_hash, object_key, media_type,
         size_bytes, creator_json, state, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        tenantId,
        workspaceId,
        artifactId,
        1,
        contentHash,
        objectKey,
        'text/plain',
        1,
        '{}',
        'published',
        publishedAt,
      ],
    );

    await expect(
      pool.query(
        `UPDATE artifact_versions SET state = $1
         WHERE tenant_id = $2 AND workspace_id = $3 AND artifact_id = $4 AND version = $5`,
        ['superseded', tenantId, workspaceId, artifactId, 1],
      ),
    ).rejects.toThrow('append-only');
    await expect(
      pool.query(
        `DELETE FROM artifact_versions
         WHERE tenant_id = $1 AND workspace_id = $2 AND artifact_id = $3 AND version = $4`,
        [tenantId, workspaceId, artifactId, 1],
      ),
    ).rejects.toThrow('append-only');
  });

  registerStateContractSuite('shared state contract', () => store);
});
