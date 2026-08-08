import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isId, newSortableId, type Id } from '@agentic-platform/runtime-contracts';

interface LocalIdentityFile {
  readonly schemaVersion: 1;
  readonly actorId: Id;
}

/** Stable local principal identity kept outside user-editable settings. */
export class FileLocalIdentityStore {
  constructor(private readonly path: string) {}

  load(): Id | undefined {
    try {
      const value = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<LocalIdentityFile>;
      return value.schemaVersion === 1 && typeof value.actorId === 'string' && isId(value.actorId)
        ? value.actorId
        : undefined;
    } catch {
      return undefined;
    }
  }

  create(): Id {
    const actorId = newSortableId();
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp-${process.pid}`;
    writeFileSync(
      temporary,
      `${JSON.stringify({ schemaVersion: 1, actorId } satisfies LocalIdentityFile)}\n`,
      { mode: 0o600 },
    );
    renameSync(temporary, this.path);
    return actorId;
  }
}
