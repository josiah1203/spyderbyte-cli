import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe } from 'vitest';
import { SqliteStateStore, type SqliteDatabase } from '../src/index.js';
import { registerStateContractSuite } from './state-contract-suite.js';

const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as {
  DatabaseSync: new (
    location: string,
    options?: { enableForeignKeyConstraints?: boolean },
  ) => SqliteDatabase & { close(): void };
};

describe('SqliteStateStore', () => {
  const database = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  const store = new SqliteStateStore(database);

  beforeAll(async () => {
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
  });

  afterAll(() => {
    database.close();
  });

  registerStateContractSuite('shared state contract', () => store);
});
