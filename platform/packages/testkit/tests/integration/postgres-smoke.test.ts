import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase('PostgreSQL integration service', () => {
  const client = new Client({ connectionString: databaseUrl });

  beforeAll(async () => {
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  it('accepts a query from the isolated CI service', async () => {
    const result = await client.query<{ value: number; database: string }>(
      'select 1 as value, current_database() as database',
    );
    expect(result.rows[0]).toEqual({ value: 1, database: 'platform_test' });
  });
});
