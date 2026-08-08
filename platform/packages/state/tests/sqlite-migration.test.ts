import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ensureSqliteOutboxClaimColumns, type SqliteDatabase } from '../src/index.js';

const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as {
  DatabaseSync: new (
    location: string,
    options?: { enableForeignKeyConstraints?: boolean },
  ) => SqliteDatabase & { close(): void };
};

describe('SQLite authoritative migrations', () => {
  it('applies the shared schema and enforces immutable artifact versions', async () => {
    const database = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
    try {
      const migration = await readFile(
        new URL('../migrations/0001_authoritative_state.sql', import.meta.url),
        'utf8',
      );
      const projectsMigration = await readFile(
        new URL('../migrations/0002_projects.sql', import.meta.url),
        'utf8',
      );
      const appendOnlyGuard = await readFile(
        new URL('../migrations/0001_append_only.sqlite.sql', import.meta.url),
        'utf8',
      );
      database.exec(migration);
      database.exec(projectsMigration);
      database.exec(appendOnlyGuard);

      const outboxColumns = database
        .prepare('PRAGMA table_info(transactional_outbox)')
        .all() as Array<{ name: string }>;
      expect(outboxColumns.map((column) => column.name)).toEqual(
        expect.arrayContaining(['claimed_by', 'claim_expires_at']),
      );

      database
        .prepare(
          `INSERT INTO artifact_content_objects
            (tenant_id, workspace_id, content_hash, object_key, media_type, size_bytes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('tenant', 'workspace', 'hash', 'sha256/hash', 'text/plain', 1, '2026-08-02T00:00:00Z');
      database
        .prepare(
          `INSERT INTO artifact_versions
            (tenant_id, workspace_id, artifact_id, version, content_hash, object_key, media_type,
             size_bytes, creator_json, state, published_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'tenant',
          'workspace',
          'artifact',
          1,
          'hash',
          'sha256/hash',
          'text/plain',
          1,
          '{}',
          'valid',
          '2026-08-02T00:00:00Z',
        );

      expect(() =>
        database
          .prepare(
            `UPDATE artifact_versions SET state = ?
             WHERE tenant_id = ? AND workspace_id = ? AND artifact_id = ? AND version = ?`,
          )
          .run('stale', 'tenant', 'workspace', 'artifact', 1),
      ).toThrow('append-only');
      expect(() =>
        database
          .prepare(
            `DELETE FROM artifact_versions
             WHERE tenant_id = ? AND workspace_id = ? AND artifact_id = ? AND version = ?`,
          )
          .run('tenant', 'workspace', 'artifact', 1),
      ).toThrow('append-only');
    } finally {
      database.close();
    }
  });

  it('adds outbox claim columns when opening a legacy SQLite database', () => {
    const database = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
    try {
      database.exec(`
        CREATE TABLE transactional_outbox (
          tenant_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          outbox_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          topic TEXT NOT NULL,
          event_json TEXT NOT NULL,
          available_at TEXT NOT NULL,
          published_at TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (tenant_id, workspace_id, outbox_id)
        )
      `);
      ensureSqliteOutboxClaimColumns(database);
      ensureSqliteOutboxClaimColumns(database);
      const columns = database.prepare('PRAGMA table_info(transactional_outbox)').all() as Array<{
        name: string;
      }>;
      expect(columns.map((column) => column.name)).toEqual(
        expect.arrayContaining(['claimed_by', 'claim_expires_at']),
      );
    } finally {
      database.close();
    }
  });
});
