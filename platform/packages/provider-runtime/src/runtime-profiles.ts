import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { runtimeError } from '@agentic-platform/runtime-contracts';

const execFileAsync = promisify(execFile);

export type RuntimeProfileKind = 'python' | 'jupyter' | 'node' | 'shell';

export interface RuntimeProfileV1 {
  readonly schemaVersion: 1;
  readonly profileId: string;
  readonly name: string;
  readonly kind: RuntimeProfileKind;
  readonly executable: string;
  readonly workingDirectory?: string;
  /** Names only; values are resolved by the execution boundary and are never persisted. */
  readonly environmentVariableNames: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EnvironmentRevisionV1 {
  readonly schemaVersion: 1;
  readonly revisionId: string;
  readonly profileId: string;
  readonly revision: number;
  readonly lockfileHash?: string;
  readonly packages: readonly string[];
  readonly createdAt: string;
}

export interface RuntimeDiscoveryCandidate {
  readonly kind: RuntimeProfileKind;
  readonly executable: string;
  readonly available: boolean;
  readonly version?: string;
  readonly checkedAt: string;
  readonly error?: string;
}

export interface RuntimeProfileRuntime {
  listProfiles(): Promise<readonly RuntimeProfileV1[]>;
  getProfile(profileId: string): Promise<RuntimeProfileV1 | undefined>;
  createProfile(input: {
    profileId?: string;
    name: string;
    kind: RuntimeProfileKind;
    executable: string;
    workingDirectory?: string;
    environmentVariableNames?: readonly string[];
  }): Promise<RuntimeProfileV1>;
  listRevisions(profileId?: string): Promise<readonly EnvironmentRevisionV1[]>;
  createRevision(input: {
    profileId: string;
    lockfile?: string;
    packages?: readonly string[];
  }): Promise<EnvironmentRevisionV1>;
  discover(): Promise<readonly RuntimeDiscoveryCandidate[]>;
}

interface RuntimeProfileState {
  profiles: RuntimeProfileV1[];
  revisions: EnvironmentRevisionV1[];
}

function now(): string {
  return new Date().toISOString();
}

function validIdentifier(value: string, label: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(trimmed)) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} is invalid`);
  }
  return trimmed;
}

function validProfileKind(value: string): RuntimeProfileKind {
  if (!['python', 'jupyter', 'node', 'shell'].includes(value)) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Runtime profile kind is invalid');
  }
  return value as RuntimeProfileKind;
}

function emptyState(): RuntimeProfileState {
  return { profiles: [], revisions: [] };
}

export class LocalRuntimeProfileRuntime implements RuntimeProfileRuntime {
  private readonly statePath: string;
  private state: RuntimeProfileState | undefined;
  private loading: Promise<void> | undefined;
  private readonly clock: () => string;

  constructor(rootPath: string, clock = now) {
    this.statePath = join(rootPath, '.agentic', 'runtime-profiles.json');
    this.clock = clock;
  }

  async listProfiles(): Promise<readonly RuntimeProfileV1[]> {
    await this.ensureLoaded();
    return structuredClone(this.state?.profiles ?? []);
  }

  async getProfile(profileId: string): Promise<RuntimeProfileV1 | undefined> {
    await this.ensureLoaded();
    const profile = this.state?.profiles.find(
      (item) => item.profileId === validIdentifier(profileId, 'profileId'),
    );
    return profile === undefined ? undefined : structuredClone(profile);
  }

  async createProfile(input: {
    profileId?: string;
    name: string;
    kind: RuntimeProfileKind;
    executable: string;
    workingDirectory?: string;
    environmentVariableNames?: readonly string[];
  }): Promise<RuntimeProfileV1> {
    await this.ensureLoaded();
    const profileId = validIdentifier(input.profileId ?? randomUUID(), 'profileId');
    const name = input.name.trim();
    const executable = input.executable.trim();
    if (!name || name.length > 160)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Profile name is invalid');
    if (!executable || executable.includes('\0')) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Profile executable is invalid');
    }
    const kind = validProfileKind(input.kind);
    if (this.state?.profiles.some((profile) => profile.profileId === profileId)) {
      throw runtimeError(
        'CONCURRENCY_STALE_VERSION',
        `Runtime profile ${profileId} already exists`,
      );
    }
    const timestamp = this.clock();
    const profile: RuntimeProfileV1 = {
      schemaVersion: 1,
      profileId,
      name,
      kind,
      executable,
      ...(input.workingDirectory?.trim()
        ? { workingDirectory: input.workingDirectory.trim() }
        : {}),
      environmentVariableNames: [...new Set(input.environmentVariableNames ?? [])].filter((value) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(value),
      ),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.state?.profiles.push(profile);
    await this.persist();
    return structuredClone(profile);
  }

  async listRevisions(profileId?: string): Promise<readonly EnvironmentRevisionV1[]> {
    await this.ensureLoaded();
    const normalized =
      profileId === undefined ? undefined : validIdentifier(profileId, 'profileId');
    return structuredClone(
      (this.state?.revisions ?? []).filter(
        (revision) => normalized === undefined || revision.profileId === normalized,
      ),
    );
  }

  async createRevision(input: {
    profileId: string;
    lockfile?: string;
    packages?: readonly string[];
  }): Promise<EnvironmentRevisionV1> {
    await this.ensureLoaded();
    const profileId = validIdentifier(input.profileId, 'profileId');
    if (!this.state?.profiles.some((profile) => profile.profileId === profileId)) {
      throw runtimeError('VALIDATION_INVALID_INPUT', `Runtime profile ${profileId} was not found`);
    }
    const existing = (this.state?.revisions ?? []).filter(
      (revision) => revision.profileId === profileId,
    );
    const lockfile = input.lockfile?.trim();
    const packages = [...new Set(input.packages ?? [])]
      .map((value) => value.trim())
      .filter(Boolean);
    const revision: EnvironmentRevisionV1 = {
      schemaVersion: 1,
      revisionId: randomUUID(),
      profileId,
      revision: existing.length + 1,
      ...(lockfile
        ? { lockfileHash: `sha256:${createHash('sha256').update(lockfile).digest('hex')}` }
        : {}),
      packages,
      createdAt: this.clock(),
    };
    this.state?.revisions.push(revision);
    await this.persist();
    return structuredClone(revision);
  }

  async discover(): Promise<readonly RuntimeDiscoveryCandidate[]> {
    const candidates: Array<{ kind: RuntimeProfileKind; executable: string }> = [
      { kind: 'python', executable: 'python3' },
      { kind: 'python', executable: 'python' },
      { kind: 'jupyter', executable: 'jupyter' },
      { kind: 'node', executable: 'node' },
    ];
    const checkedAt = this.clock();
    const results = await Promise.all(
      candidates.map(async (candidate): Promise<RuntimeDiscoveryCandidate> => {
        try {
          const result = await execFileAsync(candidate.executable, ['--version'], {
            timeout: 5_000,
            maxBuffer: 16 * 1024,
          });
          const version = `${result.stdout}${result.stderr}`.trim().split(/\r?\n/)[0];
          return { ...candidate, available: true, ...(version ? { version } : {}), checkedAt };
        } catch (error) {
          return {
            ...candidate,
            available: false,
            checkedAt,
            error: error instanceof Error ? error.message.slice(0, 500) : String(error),
          };
        }
      }),
    );
    return results;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.state) return;
    this.loading ??= (async () => {
      try {
        const raw = JSON.parse(
          await readFile(this.statePath, 'utf8'),
        ) as Partial<RuntimeProfileState>;
        this.state = {
          profiles: Array.isArray(raw.profiles) ? raw.profiles : [],
          revisions: Array.isArray(raw.revisions) ? raw.revisions : [],
        };
      } catch {
        this.state = emptyState();
      }
    })();
    await this.loading;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
    await writeFile(this.statePath, `${JSON.stringify(this.state ?? emptyState(), null, 2)}\n`, {
      mode: 0o600,
    });
  }
}
