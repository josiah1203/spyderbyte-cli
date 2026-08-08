import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import type { Id } from '@agentic-platform/runtime-contracts';

export interface ClientPreferences {
  readonly schemaVersion: 1;
  readonly activeWorkspacePath?: string;
  readonly activeProjectId?: Id;
  readonly selectedModel?: { readonly providerId: string; readonly modelId: string };
  readonly selectedRuntime?: string;
  readonly paneLayout: 'wide' | 'narrow';
  readonly activePane: 'command' | 'inspector' | 'logs';
  readonly recentCommands: readonly string[];
  readonly draftInput: string;
}

export interface ClientPreferencesStore {
  load(): ClientPreferences;
  save(value: ClientPreferences): void;
  update(patch: Partial<Omit<ClientPreferences, 'schemaVersion'>>): ClientPreferences;
}

export const DEFAULT_CLIENT_PREFERENCES: ClientPreferences = {
  schemaVersion: 1,
  paneLayout: 'wide',
  activePane: 'command',
  recentCommands: [],
  draftInput: '',
};

function clone(value: ClientPreferences): ClientPreferences {
  return structuredClone(value);
}

function validPreferences(value: unknown): value is ClientPreferences {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const model = record['selectedModel'];
  return (
    record['schemaVersion'] === 1 &&
    (record['activeWorkspacePath'] === undefined ||
      typeof record['activeWorkspacePath'] === 'string') &&
    (record['activeProjectId'] === undefined || typeof record['activeProjectId'] === 'string') &&
    (model === undefined ||
      (model !== null &&
        typeof model === 'object' &&
        !Array.isArray(model) &&
        typeof (model as Record<string, unknown>)['providerId'] === 'string' &&
        typeof (model as Record<string, unknown>)['modelId'] === 'string')) &&
    (record['selectedRuntime'] === undefined || typeof record['selectedRuntime'] === 'string') &&
    (record['paneLayout'] === 'wide' || record['paneLayout'] === 'narrow') &&
    (record['activePane'] === 'command' ||
      record['activePane'] === 'inspector' ||
      record['activePane'] === 'logs') &&
    Array.isArray(record['recentCommands']) &&
    record['recentCommands'].every((entry) => typeof entry === 'string') &&
    typeof record['draftInput'] === 'string'
  );
}

export function defaultPreferencesPath(): string {
  const configRoot = process.env['XDG_CONFIG_HOME'];
  if (configRoot !== undefined && configRoot.trim().length > 0) {
    return join(configRoot, 'spyderbyte', 'preferences.json');
  }
  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Spyderbyte', 'preferences.json');
  }
  return join(homedir(), '.config', 'spyderbyte', 'preferences.json');
}

export class FileClientPreferencesStore implements ClientPreferencesStore {
  private value: ClientPreferences;

  constructor(private readonly filePath = defaultPreferencesPath()) {
    this.value = this.read();
  }

  load(): ClientPreferences {
    return clone(this.value);
  }

  save(value: ClientPreferences): void {
    this.value = clone({ ...DEFAULT_CLIENT_PREFERENCES, ...value, schemaVersion: 1 });
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(this.value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.filePath);
  }

  update(patch: Partial<Omit<ClientPreferences, 'schemaVersion'>>): ClientPreferences {
    const next = {
      ...this.value,
      ...patch,
      schemaVersion: 1 as const,
      recentCommands: [...(patch.recentCommands ?? this.value.recentCommands)].slice(-20),
    };
    this.save(next);
    return this.load();
  }

  private read(): ClientPreferences {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      return validPreferences(parsed) ? clone(parsed) : clone(DEFAULT_CLIENT_PREFERENCES);
    } catch {
      return clone(DEFAULT_CLIENT_PREFERENCES);
    }
  }
}

export class MemoryClientPreferencesStore implements ClientPreferencesStore {
  private value = clone(DEFAULT_CLIENT_PREFERENCES);

  load(): ClientPreferences {
    return clone(this.value);
  }

  save(value: ClientPreferences): void {
    this.value = clone({ ...DEFAULT_CLIENT_PREFERENCES, ...value, schemaVersion: 1 });
  }

  update(patch: Partial<Omit<ClientPreferences, 'schemaVersion'>>): ClientPreferences {
    this.save({
      ...this.value,
      ...patch,
      schemaVersion: 1,
      recentCommands: [...(patch.recentCommands ?? this.value.recentCommands)].slice(-20),
    });
    return this.load();
  }
}
