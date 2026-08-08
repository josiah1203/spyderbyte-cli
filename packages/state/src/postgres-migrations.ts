import type { Pool } from 'pg';

const MIGRATION_LOCK_KEY = 'agentic_platform_authoritative_state_v1';

const OUTBOX_CLAIMS_MIGRATION = `
ALTER TABLE transactional_outbox ADD COLUMN IF NOT EXISTS claimed_by TEXT;
ALTER TABLE transactional_outbox ADD COLUMN IF NOT EXISTS claim_expires_at TEXT;
`;

/**
 * Apply the shared schema and PostgreSQL guard as one serialized operation.
 *
 * Integration workers and deployment processes may start concurrently. The
 * transaction-scoped advisory lock prevents PostgreSQL's concurrent
 * CREATE TABLE IF NOT EXISTS operations from racing in the system catalogs.
 */
export async function applyPostgresMigrations(
  pool: Pool,
  schemaSql: string,
  appendOnlyGuardSql: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [MIGRATION_LOCK_KEY]);
    await client.query(schemaSql);
    await client.query(OUTBOX_CLAIMS_MIGRATION);
    await client.query(appendOnlyGuardSql);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
