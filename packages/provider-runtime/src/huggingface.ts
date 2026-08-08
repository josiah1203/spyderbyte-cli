import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { runtimeError } from '@agentic-platform/runtime-contracts';

export interface HuggingFaceModelSummary {
  readonly id: string;
  readonly author?: string;
  readonly pipelineTag?: string;
  readonly downloads?: number;
  readonly likes?: number;
  readonly private?: boolean;
  readonly lastModified?: string;
  readonly license?: string;
}

export interface HuggingFaceRevisionSummary {
  readonly name: string;
  readonly commitHash?: string;
}

export interface HuggingFaceModelDetails extends HuggingFaceModelSummary {
  readonly revisions: readonly HuggingFaceRevisionSummary[];
  readonly files: readonly HuggingFaceFile[];
  readonly supportedFormats: readonly ('gguf' | 'mlx' | 'unknown')[];
  readonly recommendedFiles: readonly string[];
  readonly defaultRevision: string;
}

export interface HuggingFaceFile {
  readonly path: string;
  readonly size?: number;
  readonly sha256?: string;
  readonly lfs?: { readonly sha256?: string; readonly size?: number };
}

export interface HuggingFaceHubClientOptions {
  readonly baseUrl?: string;
  readonly token?: string;
  readonly fetcher?: typeof fetch;
}

function repositoryPath(repoId: string): string {
  const parts = repoId.trim().split('/').filter(Boolean);
  if (parts.length !== 2)
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Hugging Face repoId must be owner/name');
  return parts.map((part) => encodeURIComponent(part)).join('/');
}

function revisionPath(revision: string): string {
  if (!revision || revision.includes('/') || revision.includes('..')) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Hugging Face revision is invalid');
  }
  return encodeURIComponent(revision);
}

function lfsSha256(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
  return /^[a-f0-9]{64}$/i.test(normalized) ? normalized : undefined;
}

function lfsMetadata(value: unknown): HuggingFaceFile['lfs'] | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const sha256 = lfsSha256(record['sha256'] ?? record['oid']);
  const size = typeof record['size'] === 'number' ? record['size'] : undefined;
  if (sha256 === undefined && size === undefined) return undefined;
  return {
    ...(sha256 === undefined ? {} : { sha256 }),
    ...(size === undefined ? {} : { size }),
  };
}

async function jsonResponse(response: Response): Promise<unknown> {
  const payload = await response.json().catch(() => undefined);
  if (!response.ok)
    throw runtimeError(
      'COMPUTE_RESOURCE_UNAVAILABLE',
      `Hugging Face request failed (${response.status})`,
    );
  return payload;
}

export class HuggingFaceHubClient {
  private readonly baseUrl: string;
  private token: string | undefined;
  private readonly fetcher: typeof fetch;

  constructor(options: HuggingFaceHubClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://huggingface.co').replace(/\/$/, '');
    this.token = options.token;
    this.fetcher = options.fetcher ?? fetch;
  }

  setToken(token: string | undefined): void {
    this.token = token?.trim() || undefined;
  }

  hasToken(): boolean {
    return this.token !== undefined;
  }

  private headers(): Record<string, string> {
    return {
      accept: 'application/json',
      ...(this.token === undefined ? {} : { authorization: `Bearer ${this.token}` }),
    };
  }

  async search(query: string, limit = 20): Promise<HuggingFaceModelSummary[]> {
    const url = new URL(`${this.baseUrl}/api/models`);
    if (query.trim()) url.searchParams.set('search', query.trim());
    url.searchParams.set('limit', String(Math.max(1, Math.min(limit, 100))));
    const payload = await jsonResponse(await this.fetcher(url, { headers: this.headers() }));
    if (!Array.isArray(payload)) return [];
    return payload.flatMap((item) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return [];
      const value = item as Record<string, unknown>;
      const cardData =
        value['cardData'] !== null &&
        typeof value['cardData'] === 'object' &&
        !Array.isArray(value['cardData'])
          ? (value['cardData'] as Record<string, unknown>)
          : undefined;
      return typeof value['id'] === 'string'
        ? [
            {
              id: value['id'],
              ...(typeof value['author'] === 'string' ? { author: value['author'] } : {}),
              ...(typeof value['pipeline_tag'] === 'string'
                ? { pipelineTag: value['pipeline_tag'] }
                : {}),
              ...(typeof value['downloads'] === 'number' ? { downloads: value['downloads'] } : {}),
              ...(typeof value['likes'] === 'number' ? { likes: value['likes'] } : {}),
              ...(typeof value['private'] === 'boolean' ? { private: value['private'] } : {}),
              ...(typeof value['lastModified'] === 'string'
                ? { lastModified: value['lastModified'] }
                : {}),
              ...(typeof cardData?.['license'] === 'string'
                ? { license: cardData['license'] }
                : {}),
            },
          ]
        : [];
    });
  }

  async details(repoId: string, revision = 'main'): Promise<HuggingFaceModelDetails> {
    const path = repositoryPath(repoId);
    const selectedRevision = revision.trim() || 'main';
    const url = new URL(`${this.baseUrl}/api/models/${path}`);
    url.searchParams.set('revision', selectedRevision);
    const refsUrl = new URL(`${this.baseUrl}/api/models/${path}/refs`);
    const [payload, refsPayload] = await Promise.all([
      jsonResponse(await this.fetcher(url, { headers: this.headers() })),
      this.fetcher(refsUrl, { headers: this.headers() })
        .then((response) => (response.ok ? response.json() : undefined))
        .catch(() => undefined),
    ]);
    const value =
      payload !== null && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {};
    const cardData =
      value['cardData'] !== null &&
      typeof value['cardData'] === 'object' &&
      !Array.isArray(value['cardData'])
        ? (value['cardData'] as Record<string, unknown>)
        : undefined;
    const rawSiblings = Array.isArray(value['siblings']) ? value['siblings'] : [];
    const files: HuggingFaceFile[] = rawSiblings.flatMap((item) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return [];
      const file = item as Record<string, unknown>;
      const filePath = typeof file['rfilename'] === 'string' ? file['rfilename'] : undefined;
      if (filePath === undefined) return [];
      const lfs = lfsMetadata(file['lfs']);
      return [
        {
          path: filePath,
          ...(typeof file['size'] === 'number' ? { size: file['size'] } : {}),
          ...(typeof file['sha256'] === 'string' ? { sha256: file['sha256'] } : {}),
          ...(lfs === undefined ? {} : { lfs }),
        },
      ];
    });
    const commitHash = typeof value['sha'] === 'string' ? value['sha'] : undefined;
    const formatFor = (filePath: string): 'gguf' | 'mlx' | 'unknown' => {
      const normalized = filePath.toLowerCase();
      if (normalized.endsWith('.gguf')) return 'gguf';
      if (normalized.includes('mlx') || normalized.includes('mlx_model')) return 'mlx';
      return 'unknown';
    };
    const supportedFormats = [...new Set(files.map((file) => formatFor(file.path)))];
    const recommendedFiles = files
      .filter((file) => formatFor(file.path) !== 'unknown')
      .sort((left, right) => (right.size ?? 0) - (left.size ?? 0))
      .map((file) => file.path)
      .slice(0, 8);
    const refsRecord =
      refsPayload !== null && typeof refsPayload === 'object' && !Array.isArray(refsPayload)
        ? (refsPayload as Record<string, unknown>)
        : {};
    const revisions = ['branches', 'tags'].flatMap((kind) => {
      const values = Array.isArray(refsRecord[kind]) ? refsRecord[kind] : [];
      return values.flatMap((item) => {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) return [];
        const ref = item as Record<string, unknown>;
        const name = typeof ref['name'] === 'string' ? ref['name'] : undefined;
        const commit = typeof ref['target_commit'] === 'string' ? ref['target_commit'] : undefined;
        return name === undefined
          ? []
          : [{ name, ...(commit === undefined ? {} : { commitHash: commit }) }];
      });
    });
    const selectedRef = {
      name: selectedRevision,
      ...(commitHash === undefined ? {} : { commitHash }),
    };
    const id = typeof value['id'] === 'string' ? value['id'] : repoId.trim();
    return {
      id,
      ...(typeof value['author'] === 'string' ? { author: value['author'] } : {}),
      ...(typeof value['pipeline_tag'] === 'string' ? { pipelineTag: value['pipeline_tag'] } : {}),
      ...(typeof value['downloads'] === 'number' ? { downloads: value['downloads'] } : {}),
      ...(typeof value['likes'] === 'number' ? { likes: value['likes'] } : {}),
      ...(typeof value['private'] === 'boolean' ? { private: value['private'] } : {}),
      ...(typeof value['lastModified'] === 'string' ? { lastModified: value['lastModified'] } : {}),
      ...(typeof cardData?.['license'] === 'string' ? { license: cardData['license'] } : {}),
      revisions: [selectedRef, ...revisions.filter((item) => item.name !== selectedRevision)],
      files,
      supportedFormats: supportedFormats.length > 0 ? supportedFormats : ['unknown'],
      recommendedFiles,
      defaultRevision: selectedRevision,
    };
  }

  async listFiles(repoId: string, revision = 'main'): Promise<HuggingFaceFile[]> {
    const url = `${this.baseUrl}/api/models/${repositoryPath(repoId)}/tree/${revisionPath(revision)}?recursive=true`;
    const payload = await jsonResponse(await this.fetcher(url, { headers: this.headers() }));
    if (!Array.isArray(payload)) return [];
    return payload.flatMap((item) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return [];
      const value = item as Record<string, unknown>;
      const path = typeof value['path'] === 'string' ? value['path'] : undefined;
      if (path === undefined) return [];
      const lfs = lfsMetadata(value['lfs']);
      return [
        {
          path,
          ...(typeof value['size'] === 'number' ? { size: value['size'] } : {}),
          ...(typeof value['sha256'] === 'string' ? { sha256: value['sha256'] } : {}),
          ...(lfs === undefined ? {} : { lfs }),
        },
      ];
    });
  }

  async download(
    repoId: string,
    revision: string,
    filePath: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const safePath = filePath.replaceAll('\\', '/');
    if (
      !safePath ||
      safePath.startsWith('/') ||
      safePath.split('/').some((part) => part === '..')
    ) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Hugging Face file path is invalid');
    }
    const encodedPath = safePath
      .split('/')
      .map((part) => encodeURIComponent(part))
      .join('/');
    const url = `${this.baseUrl}/${repositoryPath(repoId)}/resolve/${revisionPath(revision)}/${encodedPath}`;
    const response = await this.fetcher(url, {
      headers: this.headers(),
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok)
      throw runtimeError(
        'COMPUTE_RESOURCE_UNAVAILABLE',
        `Hugging Face file download failed (${response.status})`,
      );
    return new Uint8Array(await response.arrayBuffer());
  }

  async downloadResumable(
    repoId: string,
    revision: string,
    filePath: string,
    offset: number,
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; offset: number; totalBytes?: number }> {
    const safePath = filePath.replaceAll('\\', '/');
    if (
      !safePath ||
      safePath.startsWith('/') ||
      safePath.split('/').some((part) => part === '..')
    ) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Hugging Face file path is invalid');
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Hugging Face resume offset is invalid');
    }
    const encodedPath = safePath
      .split('/')
      .map((part) => encodeURIComponent(part))
      .join('/');
    const url = `${this.baseUrl}/${repositoryPath(repoId)}/resolve/${revisionPath(revision)}/${encodedPath}`;
    const headers = this.headers();
    if (offset > 0) headers['range'] = `bytes=${offset}-`;
    let response = await this.fetcher(url, {
      headers,
      ...(signal === undefined ? {} : { signal }),
    });
    let effectiveOffset = offset;
    if (offset > 0 && response.status === 200) {
      // The endpoint did not honor Range; restart safely rather than corrupting the file.
      effectiveOffset = 0;
      response = await this.fetcher(url, {
        headers: this.headers(),
        ...(signal === undefined ? {} : { signal }),
      });
    }
    if (!response.ok) {
      throw runtimeError(
        'COMPUTE_RESOURCE_UNAVAILABLE',
        `Hugging Face file download failed (${response.status})`,
      );
    }
    const contentRange = response.headers.get('content-range');
    const rangeTotal = contentRange === null ? undefined : Number(contentRange.split('/')[1]);
    const contentLength = Number(response.headers.get('content-length') ?? '');
    const totalBytes = Number.isSafeInteger(rangeTotal)
      ? rangeTotal
      : Number.isSafeInteger(contentLength)
        ? effectiveOffset + contentLength
        : undefined;
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      offset: effectiveOffset,
      ...(totalBytes === undefined ? {} : { totalBytes }),
    };
  }
}

export type ModelDownloadState = 'queued' | 'downloading' | 'completed' | 'cancelled' | 'failed';

export interface ModelDownloadJob {
  readonly jobId: string;
  readonly repoId: string;
  readonly revision: string;
  readonly state: ModelDownloadState;
  readonly progress: number;
  readonly installedPath?: string;
  readonly error?: string;
  readonly updatedAt: string;
}

export interface InstalledModel {
  readonly modelId: string;
  readonly repoId: string;
  readonly revision: string;
  readonly format: 'gguf' | 'mlx' | 'unknown';
  readonly path: string;
  readonly files: readonly string[];
  readonly installedAt: string;
}

export interface ModelDownloadManagerOptions {
  readonly rootPath: string;
  readonly hub: HuggingFaceHubClient;
  readonly clock?: () => string;
}

function modelFormat(files: readonly string[]): InstalledModel['format'] {
  if (files.some((file) => file.toLowerCase().endsWith('.gguf'))) return 'gguf';
  if (
    files.some(
      (file) => file.toLowerCase().includes('mlx') || file.toLowerCase().endsWith('.safetensors'),
    )
  )
    return 'mlx';
  return 'unknown';
}

function safeInstallPath(rootPath: string, repoId: string, revision: string): string {
  const folder = repoId.replaceAll('/', '__').replace(/[^a-zA-Z0-9_.-]/g, '_');
  const revisionFolder = revision.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const root = resolve(rootPath);
  const target = resolve(root, folder, revisionFolder);
  if (target !== root && !target.startsWith(`${root}${sep}`))
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Model install path escaped the model cache');
  return target;
}

export class ModelDownloadManager {
  private readonly rootPath: string;
  private readonly hub: HuggingFaceHubClient;
  private readonly clock: () => string;
  private readonly jobs = new Map<string, ModelDownloadJob>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(options: ModelDownloadManagerOptions) {
    this.rootPath = resolve(options.rootPath);
    this.hub = options.hub;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  listJobs(): ModelDownloadJob[] {
    return structuredClone([...this.jobs.values()]);
  }

  async start(repoId: string, revision = 'main'): Promise<ModelDownloadJob> {
    repositoryPath(repoId);
    revisionPath(revision);
    const jobId = randomJobId();
    const job: ModelDownloadJob = {
      jobId,
      repoId,
      revision,
      state: 'queued',
      progress: 0,
      updatedAt: this.clock(),
    };
    this.jobs.set(jobId, job);
    const controller = new AbortController();
    this.controllers.set(jobId, controller);
    void this.run(job, controller.signal)
      .catch((error: unknown) => {
        this.update(jobId, {
          state: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => this.controllers.delete(jobId));
    return structuredClone(job);
  }

  cancel(jobId: string): ModelDownloadJob | undefined {
    this.controllers.get(jobId)?.abort();
    const job = this.jobs.get(jobId);
    if (job !== undefined && (job.state === 'queued' || job.state === 'downloading')) {
      this.update(jobId, { state: 'cancelled' });
      return this.jobs.get(jobId);
    }
    return job === undefined ? undefined : structuredClone(job);
  }

  async listInstalled(): Promise<InstalledModel[]> {
    await mkdir(this.rootPath, { recursive: true });
    const entries = await readdir(this.rootPath, { withFileTypes: true });
    const installed: InstalledModel[] = [];
    for (const owner of entries.filter((entry) => entry.isDirectory())) {
      const revisions = await readdir(join(this.rootPath, owner.name), { withFileTypes: true });
      for (const revision of revisions.filter((entry) => entry.isDirectory())) {
        const target = join(this.rootPath, owner.name, revision.name);
        const manifestPath = join(target, 'agentic-model-manifest.json');
        try {
          const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as InstalledModel;
          installed.push(manifest);
        } catch {
          // Ignore incomplete or manually-created cache entries.
        }
      }
    }
    return installed;
  }

  async remove(model: InstalledModel): Promise<void> {
    const root = resolve(this.rootPath);
    const target = resolve(model.path);
    if (target !== root && !target.startsWith(`${root}${sep}`))
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Model path escaped the cache');
    await rm(target, { recursive: true, force: true });
  }

  async removeById(modelId: string): Promise<boolean> {
    const model = (await this.listInstalled()).find((candidate) => candidate.modelId === modelId);
    if (model === undefined) return false;
    await this.remove(model);
    return true;
  }

  private update(jobId: string, patch: Partial<ModelDownloadJob>): void {
    const current = this.jobs.get(jobId);
    if (current === undefined) return;
    this.jobs.set(jobId, { ...current, ...patch, updatedAt: this.clock() });
  }

  private async run(job: ModelDownloadJob, signal: AbortSignal): Promise<void> {
    this.update(job.jobId, { state: 'downloading' });
    await mkdir(this.rootPath, { recursive: true });
    const files = await this.hub.listFiles(job.repoId, job.revision);
    const selected = files.filter(
      (file) => !file.path.endsWith('/') && !file.path.startsWith('.git/'),
    );
    if (selected.length === 0)
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'Hugging Face repository contains no downloadable files',
      );
    const expectedBytes = selected.reduce(
      (total, file) => total + (file.size ?? file.lfs?.size ?? 0),
      0,
    );
    if (expectedBytes > 0) {
      const filesystem = await statfs(this.rootPath);
      const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
      if (expectedBytes > availableBytes) {
        throw runtimeError(
          'COMPUTE_RESOURCE_UNAVAILABLE',
          'Insufficient disk space for the Hugging Face model',
        );
      }
    }
    const temporary = `${safeInstallPath(this.rootPath, job.repoId, job.revision)}.installing`;
    const target = safeInstallPath(this.rootPath, job.repoId, job.revision);
    await mkdir(temporary, { recursive: true });
    const downloaded: string[] = [];
    try {
      for (const [index, file] of selected.entries()) {
        if (signal.aborted) throw abortError();
        const destination = resolve(temporary, file.path);
        const relativeDestination = relative(temporary, destination);
        if (relativeDestination.startsWith('..') || relativeDestination.includes(`..${sep}`))
          throw runtimeError(
            'VALIDATION_INVALID_INPUT',
            'Model file escaped the install directory',
          );
        await mkdir(dirname(destination), { recursive: true });
        let existing = new Uint8Array();
        try {
          existing = new Uint8Array(await readFile(destination));
        } catch {
          // This file has not been started yet.
        }
        const existingDigest =
          existing.length === 0 ? undefined : createHash('sha256').update(existing).digest('hex');
        const expected = file.sha256 ?? file.lfs?.sha256;
        if (expected !== undefined && existingDigest === expected) {
          downloaded.push(file.path);
          this.update(job.jobId, { progress: (index + 1) / selected.length });
          continue;
        }
        const downloadedPart = await this.hub.downloadResumable(
          job.repoId,
          job.revision,
          file.path,
          existing.length,
          signal,
        );
        const bytes =
          downloadedPart.offset === 0
            ? downloadedPart.bytes
            : new Uint8Array([...existing, ...downloadedPart.bytes]);
        if (
          expected !== undefined &&
          createHash('sha256').update(bytes).digest('hex') !== expected
        ) {
          throw runtimeError('COMPUTE_RESOURCE_UNAVAILABLE', `Checksum failed for ${file.path}`);
        }
        await writeFile(destination, bytes);
        downloaded.push(file.path);
        this.update(job.jobId, { progress: (index + 1) / selected.length });
      }
      const manifest: InstalledModel = {
        modelId: `${job.repoId}@${job.revision}`,
        repoId: job.repoId,
        revision: job.revision,
        format: modelFormat(downloaded),
        path: target,
        files: downloaded,
        installedAt: this.clock(),
      };
      await writeFile(
        join(temporary, 'agentic-model-manifest.json'),
        JSON.stringify(manifest, null, 2),
        { flag: 'wx' },
      );
      const backup = `${target}.previous-${job.jobId}`;
      let previousMoved = false;
      await rm(backup, { recursive: true, force: true });
      try {
        await rename(target, backup);
        previousMoved = true;
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? String(error.code) : undefined;
        if (code !== 'ENOENT') throw error;
      }
      try {
        await rename(temporary, target);
      } catch (error) {
        if (previousMoved) await rename(backup, target).catch(() => undefined);
        throw error;
      }
      if (previousMoved) await rm(backup, { recursive: true, force: true });
      this.update(job.jobId, { state: 'completed', progress: 1, installedPath: target });
    } catch (error) {
      if (!signal.aborted) await rm(temporary, { recursive: true, force: true });
      if (signal.aborted) {
        this.update(job.jobId, { state: 'cancelled' });
        return;
      }
      throw error;
    }
  }
}

function randomJobId(): string {
  return `model-download-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function abortError(): Error {
  return runtimeError('COMPUTE_RESOURCE_UNAVAILABLE', 'Model download was cancelled');
}

export async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size;
}

export async function manifestDigest(model: InstalledModel): Promise<string> {
  return createHash('sha256').update(JSON.stringify(model)).digest('hex');
}

export function fileName(model: InstalledModel): string {
  return basename(model.path);
}
