import {
  applyPostgresMigrations,
  PostgresStateStore,
  type StateStore,
  type StateTransaction,
} from '@agentic-platform/state';
import type { Pool } from 'pg';

/** The hosted state composition keeps the local and hosted transaction ports identical. */
export class HostedPostgresStateStore implements StateStore {
  private readonly delegate: PostgresStateStore;

  constructor(pool: Pick<Pool, 'connect'>) {
    this.delegate = new PostgresStateStore(pool);
  }

  transaction<T>(work: (transaction: StateTransaction) => Promise<T>): Promise<T> {
    return this.delegate.transaction(work);
  }
}

export interface HostedPostgresMigrationInput {
  readonly pool: Pool;
  readonly schemaSql: string;
  readonly appendOnlyGuardSql: string;
}

export function applyHostedPostgresMigrations(input: HostedPostgresMigrationInput): Promise<void> {
  return applyPostgresMigrations(input.pool, input.schemaSql, input.appendOnlyGuardSql);
}
