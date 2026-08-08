import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GovernanceStateStore, GovernanceStateV1 } from '@agentic-platform/policy';

/** File-backed local governance state; secret values never belong in this file. */
export class FileGovernanceStateStore implements GovernanceStateStore {
  constructor(private readonly path: string) {}

  load(): GovernanceStateV1 | undefined {
    try {
      const value = JSON.parse(readFileSync(this.path, 'utf8')) as GovernanceStateV1;
      return value?.schemaVersion === 1 ? structuredClone(value) : undefined;
    } catch {
      return undefined;
    }
  }

  save(state: GovernanceStateV1): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp-${process.pid}`;
    writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}
