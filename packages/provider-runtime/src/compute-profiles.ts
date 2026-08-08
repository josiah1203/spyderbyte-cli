import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { availableParallelism, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import {
  newSortableId,
  runtimeError,
  type ComputeRequirements,
  type Id,
  type NetworkPolicyMode,
  type RuntimeProfile,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';

export interface ComputeProfileCreateInput {
  readonly runtimeProfileId?: Id;
  readonly runtimeType: RuntimeProfile['runtimeType'];
  readonly displayName: string;
  readonly state?: RuntimeProfile['state'];
  readonly endpoint?: string;
  readonly cpuMillicores?: number;
  readonly memoryBytes?: number;
  readonly gpuType?: string;
  readonly gpuCount?: number;
  readonly networkPolicy?: NetworkPolicyMode;
}

export interface ComputeProfileSelectionRequest {
  readonly explicitProfileId?: Id;
  readonly preferredProfileIds?: readonly Id[];
  readonly allowedRuntimeTypes?: readonly RuntimeProfile['runtimeType'][];
  readonly requirements?: ComputeRequirements;
  readonly networkPolicy?: NetworkPolicyMode;
}

export interface ComputeProfileSelection {
  readonly selected: RuntimeProfile;
  readonly fallback: readonly RuntimeProfile[];
  readonly reason: 'explicit' | 'preference' | 'local-first' | 'route-order';
}

interface ComputeProfileFile {
  readonly schemaVersion: 1;
  readonly profiles: readonly RuntimeProfile[];
}

const EMPTY_FILE: ComputeProfileFile = { schemaVersion: 1, profiles: [] };
const RUNTIME_PRIORITY: readonly RuntimeProfile['runtimeType'][] = [
  'local-host',
  'local-docker',
  'remote-ssh',
  'customer-cloud',
  'managed-worker',
];

function sameTenant(left: TenantRef, right: TenantRef): boolean {
  return left.tenantId === right.tenantId && left.workspaceId === right.workspaceId;
}

function finiteNonNegative(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} must be a non-negative number`);
  }
  return value;
}

function runtimeType(value: string): RuntimeProfile['runtimeType'] {
  if (!RUNTIME_PRIORITY.includes(value as RuntimeProfile['runtimeType'])) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'runtimeType is invalid');
  }
  return value as RuntimeProfile['runtimeType'];
}

function networkPolicy(value: string | undefined): NetworkPolicyMode | undefined {
  if (value === undefined) return undefined;
  if (!['offline', 'allowlist', 'unrestricted'].includes(value)) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'networkPolicy is invalid');
  }
  return value as NetworkPolicyMode;
}

function clone(value: RuntimeProfile): RuntimeProfile {
  return structuredClone(value);
}

function satisfies(profile: RuntimeProfile, request: ComputeProfileSelectionRequest): boolean {
  if (profile.state !== 'ready') return false;
  if (
    request.allowedRuntimeTypes !== undefined &&
    !request.allowedRuntimeTypes.includes(profile.runtimeType)
  ) {
    return false;
  }
  const requirements = request.requirements;
  if (requirements?.cpuMillicores !== undefined) {
    if (profile.cpuMillicores === undefined || profile.cpuMillicores < requirements.cpuMillicores) {
      return false;
    }
  }
  if (requirements?.memoryBytes !== undefined) {
    if (profile.memoryBytes === undefined || profile.memoryBytes < requirements.memoryBytes) {
      return false;
    }
  }
  if (requirements?.gpuCount !== undefined) {
    if (profile.gpuCount === undefined || profile.gpuCount < requirements.gpuCount) return false;
  }
  if (requirements?.gpuType !== undefined && profile.gpuType !== requirements.gpuType) {
    return false;
  }
  if (request.networkPolicy === 'offline' && profile.networkPolicy !== 'offline') {
    return false;
  }
  if (request.networkPolicy === 'allowlist' && profile.networkPolicy === 'unrestricted') {
    return false;
  }
  return true;
}

export interface ComputeProfileRegistry {
  list(): readonly RuntimeProfile[];
  get(runtimeProfileId: Id): RuntimeProfile | undefined;
  create(input: ComputeProfileCreateInput): Promise<RuntimeProfile>;
  select(request: ComputeProfileSelectionRequest): ComputeProfileSelection;
}

export class FileComputeProfileRegistry implements ComputeProfileRegistry {
  private readonly statePath: string;
  private state: ComputeProfileFile | undefined;
  private loading: Promise<void> | undefined;

  constructor(
    rootPath: string,
    private readonly tenant: TenantRef,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {
    this.statePath = join(rootPath, '.agentic', 'compute-profiles.json');
  }

  list(): readonly RuntimeProfile[] {
    this.ensureLoadedSync();
    return (
      this.state?.profiles
        .filter((profile) => sameTenant(profile.tenant, this.tenant))
        .map(clone) ?? []
    );
  }

  get(runtimeProfileId: Id): RuntimeProfile | undefined {
    return this.list().find((profile) => profile.runtimeProfileId === runtimeProfileId);
  }

  async create(input: ComputeProfileCreateInput): Promise<RuntimeProfile> {
    await this.ensureLoaded();
    const displayName = input.displayName.trim();
    if (displayName.length === 0 || displayName.length > 200) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'displayName must contain 1–200 characters');
    }
    const runtimeProfileId = input.runtimeProfileId ?? newSortableId();
    if (this.get(runtimeProfileId) !== undefined) {
      throw runtimeError('CONCURRENCY_STALE_VERSION', 'runtimeProfileId already exists');
    }
    const timestamp = this.clock();
    const normalizedEndpoint = input.endpoint?.trim();
    const cpuMillicores = finiteNonNegative(input.cpuMillicores, 'cpuMillicores');
    const memoryBytes = finiteNonNegative(input.memoryBytes, 'memoryBytes');
    const gpuCount = finiteNonNegative(input.gpuCount, 'gpuCount');
    const normalizedNetworkPolicy = networkPolicy(input.networkPolicy);
    const profile: RuntimeProfile = {
      schemaVersion: 1,
      runtimeProfileId,
      tenant: this.tenant,
      runtimeType: runtimeType(input.runtimeType),
      displayName,
      state: input.state ?? 'configured',
      ...(normalizedEndpoint ? { endpoint: normalizedEndpoint } : {}),
      ...(cpuMillicores === undefined ? {} : { cpuMillicores }),
      ...(memoryBytes === undefined ? {} : { memoryBytes }),
      ...(input.gpuType?.trim() ? { gpuType: input.gpuType.trim() } : {}),
      ...(gpuCount === undefined ? {} : { gpuCount }),
      ...(normalizedNetworkPolicy === undefined ? {} : { networkPolicy: normalizedNetworkPolicy }),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.state = {
      schemaVersion: 1,
      profiles: [...(this.state?.profiles ?? []), profile],
    };
    await this.persist();
    return clone(profile);
  }

  select(request: ComputeProfileSelectionRequest): ComputeProfileSelection {
    const candidates = this.list().filter((profile) => satisfies(profile, request));
    if (request.explicitProfileId !== undefined) {
      const explicit = candidates.find(
        (profile) => profile.runtimeProfileId === request.explicitProfileId,
      );
      if (explicit === undefined) {
        throw runtimeError(
          'COMPUTE_RESOURCE_UNAVAILABLE',
          `Requested runtime profile ${request.explicitProfileId} is not ready or does not satisfy requirements`,
        );
      }
      return {
        selected: clone(explicit),
        fallback: candidates.filter((profile) => profile !== explicit).map(clone),
        reason: 'explicit',
      };
    }
    const preferred = request.preferredProfileIds ?? [];
    const ranked = [...candidates].sort((left, right) => {
      const leftPreference = preferred.indexOf(left.runtimeProfileId);
      const rightPreference = preferred.indexOf(right.runtimeProfileId);
      if (leftPreference !== rightPreference) {
        return (
          (leftPreference < 0 ? Number.MAX_SAFE_INTEGER : leftPreference) -
          (rightPreference < 0 ? Number.MAX_SAFE_INTEGER : rightPreference)
        );
      }
      return (
        RUNTIME_PRIORITY.indexOf(left.runtimeType) - RUNTIME_PRIORITY.indexOf(right.runtimeType)
      );
    });
    const selected = ranked[0];
    if (selected === undefined) {
      throw runtimeError(
        'COMPUTE_RESOURCE_UNAVAILABLE',
        'No runtime profile satisfies the request',
      );
    }
    return {
      selected: clone(selected),
      fallback: ranked.slice(1).map(clone),
      reason: preferred.includes(selected.runtimeProfileId)
        ? 'preference'
        : selected.runtimeType === 'local-host' || selected.runtimeType === 'local-docker'
          ? 'local-first'
          : 'route-order',
    };
  }

  private ensureLoadedSync(): void {
    if (this.state !== undefined) return;
    try {
      // The registry is only read synchronously by selectors. Loading is
      // deliberately conservative: a malformed or absent file is a clean install.
      const raw = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<ComputeProfileFile>;
      this.state = {
        schemaVersion: 1,
        profiles: Array.isArray(raw.profiles) ? raw.profiles : [],
      };
    } catch {
      this.state = { ...EMPTY_FILE };
    }
    const wasEmpty = this.state.profiles.length === 0;
    this.seedIfEmpty();
    if (wasEmpty) this.persistSync();
  }

  private async ensureLoaded(): Promise<void> {
    if (this.state !== undefined) return;
    this.loading ??= (async () => {
      try {
        const raw = JSON.parse(
          await readFile(this.statePath, 'utf8'),
        ) as Partial<ComputeProfileFile>;
        this.state = {
          schemaVersion: 1,
          profiles: Array.isArray(raw.profiles) ? raw.profiles : [],
        };
      } catch {
        this.state = { ...EMPTY_FILE };
      }
      const wasEmpty = this.state.profiles.length === 0;
      this.seedIfEmpty();
      if (wasEmpty) await this.persist();
    })();
    await this.loading;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(this.state ?? EMPTY_FILE, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, this.statePath);
  }

  private persistSync(): void {
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(this.state ?? EMPTY_FILE, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(temporary, this.statePath);
  }

  private seedIfEmpty(): void {
    if (this.state === undefined || this.state.profiles.length > 0) return;
    const timestamp = this.clock();
    this.state = {
      schemaVersion: 1,
      profiles: [
        {
          schemaVersion: 1,
          runtimeProfileId: newSortableId(),
          tenant: this.tenant,
          runtimeType: 'local-host',
          displayName: 'Local host runtime',
          state: 'ready',
          cpuMillicores: availableParallelism() * 1_000,
          memoryBytes: totalmem(),
          networkPolicy: 'offline',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    };
  }
}
