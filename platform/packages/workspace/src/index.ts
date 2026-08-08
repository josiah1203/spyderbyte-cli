import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync as statSyncFile,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  cp as cpAsync,
  link as linkAsync,
  mkdir as mkdirAsync,
  rm as rmAsync,
  readdir as readdirAsync,
  readFile as readFileAsync,
  rename as renameAsync,
  stat as statAsync,
  unlink as unlinkAsync,
  writeFile as writeFileAsync,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import {
  isId,
  newSortableId,
  sha256Hash,
  type HashSha256,
  type Id,
  type WorkspaceMode,
} from '@agentic-platform/runtime-contracts';

export const WORKSPACE_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_ARCHIVE_FORMAT = 'agentic.workspace.archive.v1' as const;
const WORKSPACE_ARCHIVE_SCHEMA_VERSION = 1 as const;
const METADATA_DIRECTORY = '.agentic';
const MANIFEST_FILE = 'workspace.json';
const DATABASE_FILE = 'state.sqlite';
const OBJECTS_DIRECTORY = 'objects';
const MAX_ARCHIVE_SERIALIZED_BYTES = 512 * 1024 * 1024;

export interface WorkspaceManifestV1 {
  readonly schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  readonly workspaceId: Id;
  readonly tenantId: Id;
  readonly name: string;
  /** Absent on v1 manifests created before workspace modes were introduced. */
  readonly mode?: WorkspaceMode;
  readonly organizationId?: Id;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly databaseFile: typeof DATABASE_FILE;
  readonly artifactDirectory: typeof OBJECTS_DIRECTORY;
}

export interface WorkspaceHandle {
  readonly rootPath: string;
  readonly metadataPath: string;
  readonly manifestPath: string;
  readonly databasePath: string;
  readonly artifactRoot: string;
  readonly manifest: WorkspaceManifestV1;
}

export interface WorkspaceArchiveFileV1 {
  readonly path: string;
  readonly sizeBytes: number;
  readonly contentHash: HashSha256;
  readonly contentBase64: string;
}

export interface WorkspaceArchiveV1 {
  readonly archiveFormat: typeof WORKSPACE_ARCHIVE_FORMAT;
  readonly schemaVersion: typeof WORKSPACE_ARCHIVE_SCHEMA_VERSION;
  readonly createdAt: string;
  readonly manifest: WorkspaceManifestV1;
  readonly files: readonly WorkspaceArchiveFileV1[];
  readonly totalBytes: number;
  readonly archiveHash: HashSha256;
}

export interface WorkspaceArchiveSummary {
  readonly archiveFormat: typeof WORKSPACE_ARCHIVE_FORMAT;
  readonly archivePath: string;
  readonly archiveHash: HashSha256;
  readonly manifest: WorkspaceManifestV1;
  readonly fileCount: number;
  readonly totalBytes: number;
}

export interface WorkspaceRestorePreview extends WorkspaceArchiveSummary {
  readonly destinationRoot: string;
  readonly destinationExists: boolean;
}

export type WorkspaceErrorCode =
  | 'WORKSPACE_EXISTS'
  | 'WORKSPACE_NOT_FOUND'
  | 'WORKSPACE_INVALID'
  | 'WORKSPACE_DESTINATION_EXISTS'
  | 'WORKSPACE_COPY_FAILED'
  | 'WORKSPACE_ARCHIVE_INVALID'
  | 'WORKSPACE_ARCHIVE_INTEGRITY';

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;

  constructor(code: WorkspaceErrorCode, message: string) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
  }
}

export interface WorkspaceManagerOptions {
  readonly clock?: () => string;
}

export interface CreateWorkspaceOptions {
  readonly name?: string;
  readonly tenantId?: Id;
  readonly workspaceId?: Id;
  readonly mode?: WorkspaceMode;
  readonly organizationId?: Id;
}

function validateWorkspaceMode(mode: WorkspaceMode, organizationId: Id | undefined): void {
  if (
    mode !== 'personal_local' &&
    mode !== 'organization_local' &&
    mode !== 'organization_hosted'
  ) {
    throw new WorkspaceError('WORKSPACE_INVALID', 'Workspace mode is not recognized');
  }
  if (mode === 'personal_local' && organizationId !== undefined) {
    throw new WorkspaceError(
      'WORKSPACE_INVALID',
      'Personal local workspaces cannot carry an organization identifier',
    );
  }
  if (mode !== 'personal_local' && organizationId === undefined) {
    throw new WorkspaceError(
      'WORKSPACE_INVALID',
      'Organization workspaces require an explicit trusted organization identifier',
    );
  }
  if (organizationId !== undefined && !isId(organizationId)) {
    throw new WorkspaceError('WORKSPACE_INVALID', 'Organization identifier must be a UUIDv7 value');
  }
}

function manifestPath(rootPath: string): string {
  return join(rootPath, METADATA_DIRECTORY, MANIFEST_FILE);
}

function handleFromManifest(rootPath: string, manifest: WorkspaceManifestV1): WorkspaceHandle {
  const resolvedRoot = resolve(rootPath);
  const metadataPath = join(resolvedRoot, METADATA_DIRECTORY);
  return {
    rootPath: resolvedRoot,
    metadataPath,
    manifestPath: join(metadataPath, MANIFEST_FILE),
    databasePath: join(metadataPath, manifest.databaseFile),
    artifactRoot: join(metadataPath, manifest.artifactDirectory),
    manifest,
  };
}

function parseManifest(value: unknown): WorkspaceManifestV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorkspaceError('WORKSPACE_INVALID', 'Workspace manifest must be an object');
  }
  const record = value as Record<string, unknown>;
  const keys = new Set([
    'schemaVersion',
    'workspaceId',
    'tenantId',
    'name',
    'mode',
    'organizationId',
    'createdAt',
    'updatedAt',
    'databaseFile',
    'artifactDirectory',
  ]);
  if (Object.keys(record).some((key) => !keys.has(key))) {
    throw new WorkspaceError('WORKSPACE_INVALID', 'Workspace manifest contains unknown fields');
  }
  const mode = record['mode'];
  const organizationId = record['organizationId'];
  if (
    (mode !== undefined &&
      mode !== 'personal_local' &&
      mode !== 'organization_local' &&
      mode !== 'organization_hosted') ||
    (organizationId !== undefined && !isId(organizationId)) ||
    (mode === undefined && organizationId !== undefined) ||
    (mode !== undefined && mode !== 'personal_local' && organizationId === undefined) ||
    (mode === 'personal_local' && organizationId !== undefined) ||
    record['schemaVersion'] !== WORKSPACE_SCHEMA_VERSION ||
    !isId(record['workspaceId']) ||
    !isId(record['tenantId']) ||
    typeof record['name'] !== 'string' ||
    record['name'].trim().length === 0 ||
    typeof record['createdAt'] !== 'string' ||
    typeof record['updatedAt'] !== 'string' ||
    record['databaseFile'] !== DATABASE_FILE ||
    record['artifactDirectory'] !== OBJECTS_DIRECTORY ||
    !Number.isFinite(Date.parse(record['createdAt'])) ||
    !Number.isFinite(Date.parse(record['updatedAt']))
  ) {
    throw new WorkspaceError('WORKSPACE_INVALID', 'Workspace manifest failed schema validation');
  }
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    workspaceId: record['workspaceId'],
    tenantId: record['tenantId'],
    name: record['name'],
    mode: (mode ?? 'personal_local') as WorkspaceMode,
    ...(organizationId === undefined ? {} : { organizationId }),
    createdAt: record['createdAt'],
    updatedAt: record['updatedAt'],
    databaseFile: DATABASE_FILE,
    artifactDirectory: OBJECTS_DIRECTORY,
  };
}

function manifestJson(manifest: WorkspaceManifestV1): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function digestBytes(value: Uint8Array): HashSha256 {
  return sha256Hash(createHash('sha256').update(value).digest('hex'));
}

function digestJson(value: unknown): HashSha256 {
  return digestBytes(Buffer.from(JSON.stringify(value), 'utf8'));
}

function archiveDigestInput(archive: Omit<WorkspaceArchiveV1, 'archiveHash'>): unknown {
  return {
    archiveFormat: archive.archiveFormat,
    schemaVersion: archive.schemaVersion,
    createdAt: archive.createdAt,
    manifest: archive.manifest,
    files: archive.files,
    totalBytes: archive.totalBytes,
  };
}

function archiveDigest(archive: Omit<WorkspaceArchiveV1, 'archiveHash'>): HashSha256 {
  return digestJson(archiveDigestInput(archive));
}

function assertArchivePath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.startsWith('/') ||
    value.includes('\\')
  ) {
    throw new WorkspaceError(
      'WORKSPACE_ARCHIVE_INVALID',
      'Workspace archive paths must be non-empty POSIX-relative paths',
    );
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new WorkspaceError(
      'WORKSPACE_ARCHIVE_INVALID',
      `Workspace archive path is unsafe: ${value}`,
    );
  }
  return value;
}

function archivePathFor(rootPath: string, filePath: string): string {
  const relativePath = relative(rootPath, filePath).split(sep).join('/');
  return assertArchivePath(relativePath);
}

function restorePath(destinationRoot: string, archivePath: string): string {
  const safePath = assertArchivePath(archivePath);
  const destination = resolve(destinationRoot);
  const target = resolve(destination, ...safePath.split('/'));
  if (target !== destination && !target.startsWith(`${destination}${sep}`)) {
    throw new WorkspaceError(
      'WORKSPACE_ARCHIVE_INVALID',
      `Workspace archive path escapes its destination: ${archivePath}`,
    );
  }
  return target;
}

function archiveSummary(archivePath: string, archive: WorkspaceArchiveV1): WorkspaceArchiveSummary {
  return {
    archiveFormat: archive.archiveFormat,
    archivePath: resolve(archivePath),
    archiveHash: archive.archiveHash,
    manifest: archive.manifest,
    fileCount: archive.files.length,
    totalBytes: archive.totalBytes,
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorkspaceError('WORKSPACE_ARCHIVE_INVALID', `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function decodeArchiveContent(value: string, archivePath: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
    throw new WorkspaceError(
      'WORKSPACE_ARCHIVE_INVALID',
      `Workspace archive content is not valid base64: ${archivePath}`,
    );
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new WorkspaceError(
      'WORKSPACE_ARCHIVE_INVALID',
      `Workspace archive content has a non-canonical base64 encoding: ${archivePath}`,
    );
  }
  return decoded;
}

function validateArchive(value: unknown): WorkspaceArchiveV1 {
  const archiveRecord = record(value, 'Workspace archive');
  const allowedArchiveKeys = new Set([
    'archiveFormat',
    'schemaVersion',
    'createdAt',
    'manifest',
    'files',
    'totalBytes',
    'archiveHash',
  ]);
  if (Object.keys(archiveRecord).some((key) => !allowedArchiveKeys.has(key))) {
    throw new WorkspaceError(
      'WORKSPACE_ARCHIVE_INVALID',
      'Workspace archive contains unknown fields',
    );
  }
  if (
    archiveRecord['archiveFormat'] !== WORKSPACE_ARCHIVE_FORMAT ||
    archiveRecord['schemaVersion'] !== WORKSPACE_ARCHIVE_SCHEMA_VERSION ||
    typeof archiveRecord['createdAt'] !== 'string' ||
    !Number.isFinite(Date.parse(archiveRecord['createdAt'])) ||
    typeof archiveRecord['totalBytes'] !== 'number' ||
    !Number.isSafeInteger(archiveRecord['totalBytes']) ||
    archiveRecord['totalBytes'] < 0 ||
    typeof archiveRecord['archiveHash'] !== 'string'
  ) {
    throw new WorkspaceError(
      'WORKSPACE_ARCHIVE_INVALID',
      'Workspace archive failed schema validation',
    );
  }
  const rawManifest = archiveRecord['manifest'];
  const manifest = parseManifest(rawManifest);
  if (!Array.isArray(archiveRecord['files'])) {
    throw new WorkspaceError(
      'WORKSPACE_ARCHIVE_INVALID',
      'Workspace archive files must be an array',
    );
  }
  const files: WorkspaceArchiveFileV1[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const entry of archiveRecord['files']) {
    const fileRecord = record(entry, 'Workspace archive file');
    const allowedFileKeys = new Set(['path', 'sizeBytes', 'contentHash', 'contentBase64']);
    if (Object.keys(fileRecord).some((key) => !allowedFileKeys.has(key))) {
      throw new WorkspaceError(
        'WORKSPACE_ARCHIVE_INVALID',
        'Workspace archive file contains unknown fields',
      );
    }
    const path = assertArchivePath(fileRecord['path']);
    if (seen.has(path)) {
      throw new WorkspaceError(
        'WORKSPACE_ARCHIVE_INVALID',
        `Workspace archive contains duplicate path: ${path}`,
      );
    }
    seen.add(path);
    if (
      typeof fileRecord['sizeBytes'] !== 'number' ||
      !Number.isSafeInteger(fileRecord['sizeBytes']) ||
      fileRecord['sizeBytes'] < 0 ||
      typeof fileRecord['contentHash'] !== 'string' ||
      typeof fileRecord['contentBase64'] !== 'string'
    ) {
      throw new WorkspaceError(
        'WORKSPACE_ARCHIVE_INVALID',
        `Workspace archive file metadata is invalid: ${path}`,
      );
    }
    const content = decodeArchiveContent(fileRecord['contentBase64'], path);
    const contentHash = digestBytes(content);
    if (
      content.byteLength !== fileRecord['sizeBytes'] ||
      contentHash !== fileRecord['contentHash']
    ) {
      throw new WorkspaceError(
        'WORKSPACE_ARCHIVE_INTEGRITY',
        `Workspace archive file failed integrity validation: ${path}`,
      );
    }
    totalBytes += content.byteLength;
    if (!Number.isSafeInteger(totalBytes)) {
      throw new WorkspaceError('WORKSPACE_ARCHIVE_INVALID', 'Workspace archive is too large');
    }
    files.push({
      path,
      sizeBytes: content.byteLength,
      contentHash,
      contentBase64: fileRecord['contentBase64'],
    });
  }
  const manifestEntry = files.find(
    (file) => file.path === `${METADATA_DIRECTORY}/${MANIFEST_FILE}`,
  );
  if (manifestEntry === undefined) {
    throw new WorkspaceError(
      'WORKSPACE_ARCHIVE_INVALID',
      'Workspace archive does not contain its manifest',
    );
  }
  const manifestFromFile = parseManifest(
    JSON.parse(Buffer.from(manifestEntry.contentBase64, 'base64').toString('utf8')) as unknown,
  );
  if (JSON.stringify(manifestFromFile) !== JSON.stringify(manifest)) {
    throw new WorkspaceError(
      'WORKSPACE_ARCHIVE_INTEGRITY',
      'Workspace archive manifest does not match its manifest file',
    );
  }
  if (totalBytes !== archiveRecord['totalBytes']) {
    throw new WorkspaceError(
      'WORKSPACE_ARCHIVE_INTEGRITY',
      'Workspace archive total size does not match its files',
    );
  }
  const unsignedArchive = {
    archiveFormat: WORKSPACE_ARCHIVE_FORMAT,
    schemaVersion: WORKSPACE_ARCHIVE_SCHEMA_VERSION,
    createdAt: archiveRecord['createdAt'],
    manifest,
    files,
    totalBytes,
  } satisfies Omit<WorkspaceArchiveV1, 'archiveHash'>;
  const providedArchiveHash = archiveRecord['archiveHash'] as HashSha256;
  const expectedArchiveHash = archiveDigest(unsignedArchive);
  const legacyArchiveHash =
    typeof rawManifest === 'object' &&
    rawManifest !== null &&
    !Array.isArray(rawManifest) &&
    !Object.prototype.hasOwnProperty.call(rawManifest, 'mode')
      ? archiveDigest({
          ...unsignedArchive,
          manifest: rawManifest as WorkspaceManifestV1,
        })
      : undefined;
  if (expectedArchiveHash !== providedArchiveHash && legacyArchiveHash !== providedArchiveHash) {
    throw new WorkspaceError(
      'WORKSPACE_ARCHIVE_INTEGRITY',
      'Workspace archive digest does not match its contents',
    );
  }
  return { ...unsignedArchive, archiveHash: providedArchiveHash };
}

async function collectArchiveFiles(rootPath: string): Promise<WorkspaceArchiveFileV1[]> {
  const files: WorkspaceArchiveFileV1[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdirAsync(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const filePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(filePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new WorkspaceError(
          'WORKSPACE_ARCHIVE_INVALID',
          `Workspace archive cannot include non-regular file: ${archivePathFor(rootPath, filePath)}`,
        );
      }
      const content = await readFileAsync(filePath);
      files.push({
        path: archivePathFor(rootPath, filePath),
        sizeBytes: content.byteLength,
        contentHash: digestBytes(content),
        contentBase64: content.toString('base64'),
      });
    }
  }
  await visit(rootPath);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function writeArchive(archivePath: string, archive: WorkspaceArchiveV1): Promise<void> {
  const target = resolve(archivePath);
  const serialized = `${JSON.stringify(archive, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_ARCHIVE_SERIALIZED_BYTES) {
    throw new WorkspaceError(
      'WORKSPACE_ARCHIVE_INVALID',
      'Workspace archive exceeds the local size limit',
    );
  }
  if (await pathExists(target)) {
    throw new WorkspaceError(
      'WORKSPACE_DESTINATION_EXISTS',
      `Workspace archive already exists: ${target}`,
    );
  }
  await mkdirAsync(dirname(target), { recursive: true, mode: 0o700 });
  const temporaryPath = temporaryManifestPath(target);
  try {
    await writeFileAsync(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 });
    await linkAsync(temporaryPath, target);
    await unlinkAsync(temporaryPath);
  } catch (error) {
    try {
      await unlinkAsync(temporaryPath);
    } catch {
      // Preserve the original write/rename failure.
    }
    throw error;
  }
}

async function readArchive(archivePath: string): Promise<WorkspaceArchiveV1> {
  const target = resolve(archivePath);
  let size: number;
  try {
    size = (await statAsync(target)).size;
  } catch (error) {
    throw new WorkspaceError(
      'WORKSPACE_NOT_FOUND',
      `Workspace archive not found at ${target}: ${String(error)}`,
    );
  }
  if (size > MAX_ARCHIVE_SERIALIZED_BYTES) {
    throw new WorkspaceError(
      'WORKSPACE_ARCHIVE_INVALID',
      'Workspace archive exceeds the local size limit',
    );
  }
  try {
    return validateArchive(JSON.parse(await readFileAsync(target, 'utf8')) as unknown);
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError(
      'WORKSPACE_ARCHIVE_INVALID',
      `Unable to read workspace archive: ${String(error)}`,
    );
  }
}

async function importArchiveFile(
  archivePath: string,
  destinationRoot: string,
): Promise<WorkspaceHandle> {
  const archive = await readArchive(archivePath);
  const destination = resolve(destinationRoot);
  if (await pathExists(destination)) {
    throw new WorkspaceError(
      'WORKSPACE_DESTINATION_EXISTS',
      `Workspace restore destination already exists: ${destination}`,
    );
  }
  await mkdirAsync(dirname(destination), { recursive: true, mode: 0o700 });
  const staging = temporaryManifestPath(destination);
  try {
    await mkdirAsync(staging, { recursive: true, mode: 0o700 });
    for (const file of archive.files) {
      const target = restorePath(staging, file.path);
      await mkdirAsync(dirname(target), { recursive: true, mode: 0o700 });
      await writeFileAsync(target, decodeArchiveContent(file.contentBase64, file.path), {
        mode: 0o600,
      });
    }
    const restored = await openWorkspace(staging);
    await renameAsync(staging, destination);
    return handleFromManifest(destination, restored.manifest);
  } catch (error) {
    try {
      await rmAsync(staging, { recursive: true, force: true });
    } catch {
      // Preserve the original restore failure.
    }
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError(
      'WORKSPACE_COPY_FAILED',
      `Unable to restore workspace archive: ${String(error)}`,
    );
  }
}

function temporaryManifestPath(target: string): string {
  return `${target}.tmp-${process.pid}-${Date.now()}`;
}

async function writeManifest(path: string, manifest: WorkspaceManifestV1): Promise<void> {
  const temporaryPath = temporaryManifestPath(path);
  try {
    await writeFileAsync(temporaryPath, manifestJson(manifest), { encoding: 'utf8', mode: 0o600 });
    await renameAsync(temporaryPath, path);
  } catch (error) {
    try {
      await unlinkAsync(temporaryPath);
    } catch {
      // Preserve the original write/rename failure.
    }
    throw error;
  }
}

function writeManifestSync(path: string, manifest: WorkspaceManifestV1): void {
  const temporaryPath = temporaryManifestPath(path);
  try {
    writeFileSync(temporaryPath, manifestJson(manifest), { encoding: 'utf8', mode: 0o600 });
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Preserve the original write/rename failure.
    }
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await statAsync(path);
    return true;
  } catch {
    return false;
  }
}

function pathExistsSync(path: string): boolean {
  try {
    statSyncFile(path);
    return true;
  } catch {
    return false;
  }
}

async function copyWorkspace(
  sourceRoot: string,
  destinationRoot: string,
): Promise<WorkspaceHandle> {
  const source = resolve(sourceRoot);
  const destination = resolve(destinationRoot);
  if (source === destination) {
    throw new WorkspaceError(
      'WORKSPACE_COPY_FAILED',
      'Workspace source and destination must differ',
    );
  }
  if (!(await pathExists(source)))
    throw new WorkspaceError('WORKSPACE_NOT_FOUND', `Workspace not found at ${source}`);
  if (await pathExists(destination)) {
    throw new WorkspaceError(
      'WORKSPACE_DESTINATION_EXISTS',
      `Workspace destination already exists: ${destination}`,
    );
  }
  try {
    await cpAsync(source, destination, { recursive: true, force: false, errorOnExist: true });
    return await openWorkspace(destination);
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError('WORKSPACE_COPY_FAILED', `Unable to copy workspace: ${String(error)}`);
  }
}

function copyWorkspaceSync(sourceRoot: string, destinationRoot: string): WorkspaceHandle {
  const source = resolve(sourceRoot);
  const destination = resolve(destinationRoot);
  if (source === destination) {
    throw new WorkspaceError(
      'WORKSPACE_COPY_FAILED',
      'Workspace source and destination must differ',
    );
  }
  if (!pathExistsSync(source))
    throw new WorkspaceError('WORKSPACE_NOT_FOUND', `Workspace not found at ${source}`);
  if (pathExistsSync(destination)) {
    throw new WorkspaceError(
      'WORKSPACE_DESTINATION_EXISTS',
      `Workspace destination already exists: ${destination}`,
    );
  }
  try {
    cpSync(source, destination, { recursive: true, force: false, errorOnExist: true });
    return openWorkspaceSync(destination);
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError('WORKSPACE_COPY_FAILED', `Unable to copy workspace: ${String(error)}`);
  }
}

export class WorkspaceManager {
  private readonly clock: () => string;

  constructor(options: WorkspaceManagerOptions = {}) {
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async create(rootPath: string, options: CreateWorkspaceOptions = {}): Promise<WorkspaceHandle> {
    const root = resolve(rootPath);
    const manifestFile = manifestPath(root);
    if (await pathExists(manifestFile)) {
      throw new WorkspaceError('WORKSPACE_EXISTS', `Workspace already exists at ${root}`);
    }
    const name = options.name?.trim() || basename(root) || 'Local workspace';
    const tenantId = options.tenantId ?? newSortableId();
    const workspaceId = options.workspaceId ?? newSortableId();
    if (!isId(tenantId) || !isId(workspaceId)) {
      throw new WorkspaceError(
        'WORKSPACE_INVALID',
        'Workspace and tenant identifiers must be UUIDv7 values',
      );
    }
    const mode = options.mode ?? 'personal_local';
    validateWorkspaceMode(mode, options.organizationId);
    const now = this.clock();
    if (!Number.isFinite(Date.parse(now)))
      throw new WorkspaceError(
        'WORKSPACE_INVALID',
        'Workspace clock returned an invalid timestamp',
      );
    const manifest: WorkspaceManifestV1 = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      workspaceId,
      tenantId,
      name,
      mode,
      ...(options.organizationId === undefined ? {} : { organizationId: options.organizationId }),
      createdAt: now,
      updatedAt: now,
      databaseFile: DATABASE_FILE,
      artifactDirectory: OBJECTS_DIRECTORY,
    };
    await mkdirAsync(join(root, METADATA_DIRECTORY, OBJECTS_DIRECTORY), {
      recursive: true,
      mode: 0o700,
    });
    await writeManifest(manifestFile, manifest);
    return handleFromManifest(root, manifest);
  }

  createSync(rootPath: string, options: CreateWorkspaceOptions = {}): WorkspaceHandle {
    const root = resolve(rootPath);
    const manifestFile = manifestPath(root);
    if (pathExistsSync(manifestFile)) {
      throw new WorkspaceError('WORKSPACE_EXISTS', `Workspace already exists at ${root}`);
    }
    const name = options.name?.trim() || basename(root) || 'Local workspace';
    const tenantId = options.tenantId ?? newSortableId();
    const workspaceId = options.workspaceId ?? newSortableId();
    if (!isId(tenantId) || !isId(workspaceId)) {
      throw new WorkspaceError(
        'WORKSPACE_INVALID',
        'Workspace and tenant identifiers must be UUIDv7 values',
      );
    }
    const mode = options.mode ?? 'personal_local';
    validateWorkspaceMode(mode, options.organizationId);
    const now = this.clock();
    if (!Number.isFinite(Date.parse(now)))
      throw new WorkspaceError(
        'WORKSPACE_INVALID',
        'Workspace clock returned an invalid timestamp',
      );
    const manifest: WorkspaceManifestV1 = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      workspaceId,
      tenantId,
      name,
      mode,
      ...(options.organizationId === undefined ? {} : { organizationId: options.organizationId }),
      createdAt: now,
      updatedAt: now,
      databaseFile: DATABASE_FILE,
      artifactDirectory: OBJECTS_DIRECTORY,
    };
    mkdirSync(join(root, METADATA_DIRECTORY, OBJECTS_DIRECTORY), { recursive: true, mode: 0o700 });
    writeManifestSync(manifestFile, manifest);
    return handleFromManifest(root, manifest);
  }

  async open(rootPath: string): Promise<WorkspaceHandle> {
    const root = resolve(rootPath);
    let raw: string;
    try {
      raw = await readFileAsync(manifestPath(root), 'utf8');
    } catch (error) {
      throw new WorkspaceError(
        'WORKSPACE_NOT_FOUND',
        `Workspace manifest not found at ${root}: ${String(error)}`,
      );
    }
    try {
      const rawManifest = JSON.parse(raw) as unknown;
      const manifest = parseManifest(rawManifest);
      if (
        typeof rawManifest === 'object' &&
        rawManifest !== null &&
        !Array.isArray(rawManifest) &&
        !Object.prototype.hasOwnProperty.call(rawManifest, 'mode')
      ) {
        await writeManifest(manifestPath(root), manifest);
      }
      return handleFromManifest(root, manifest);
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      throw new WorkspaceError(
        'WORKSPACE_INVALID',
        `Unable to parse workspace manifest: ${String(error)}`,
      );
    }
  }

  openSync(rootPath: string): WorkspaceHandle {
    const root = resolve(rootPath);
    let raw: string;
    try {
      raw = readFileSync(manifestPath(root), 'utf8');
    } catch (error) {
      throw new WorkspaceError(
        'WORKSPACE_NOT_FOUND',
        `Workspace manifest not found at ${root}: ${String(error)}`,
      );
    }
    try {
      const rawManifest = JSON.parse(raw) as unknown;
      const manifest = parseManifest(rawManifest);
      if (
        typeof rawManifest === 'object' &&
        rawManifest !== null &&
        !Array.isArray(rawManifest) &&
        !Object.prototype.hasOwnProperty.call(rawManifest, 'mode')
      ) {
        writeManifestSync(manifestPath(root), manifest);
      }
      return handleFromManifest(root, manifest);
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      throw new WorkspaceError(
        'WORKSPACE_INVALID',
        `Unable to parse workspace manifest: ${String(error)}`,
      );
    }
  }

  async export(sourceRoot: string, destinationRoot: string): Promise<WorkspaceHandle> {
    return copyWorkspace(sourceRoot, destinationRoot);
  }

  exportSync(sourceRoot: string, destinationRoot: string): WorkspaceHandle {
    return copyWorkspaceSync(sourceRoot, destinationRoot);
  }

  async import(sourceRoot: string, destinationRoot: string): Promise<WorkspaceHandle> {
    return copyWorkspace(sourceRoot, destinationRoot);
  }

  importSync(sourceRoot: string, destinationRoot: string): WorkspaceHandle {
    return copyWorkspaceSync(sourceRoot, destinationRoot);
  }

  async exportArchive(sourceRoot: string, archivePath: string): Promise<WorkspaceArchiveSummary> {
    const source = await this.open(sourceRoot);
    const createdAt = this.clock();
    if (!Number.isFinite(Date.parse(createdAt))) {
      throw new WorkspaceError(
        'WORKSPACE_INVALID',
        'Workspace clock returned an invalid timestamp',
      );
    }
    const files = await collectArchiveFiles(source.rootPath);
    const totalBytes = files.reduce((total, file) => total + file.sizeBytes, 0);
    const unsignedArchive = {
      archiveFormat: WORKSPACE_ARCHIVE_FORMAT,
      schemaVersion: WORKSPACE_ARCHIVE_SCHEMA_VERSION,
      createdAt,
      manifest: source.manifest,
      files,
      totalBytes,
    } satisfies Omit<WorkspaceArchiveV1, 'archiveHash'>;
    const archive: WorkspaceArchiveV1 = {
      ...unsignedArchive,
      archiveHash: archiveDigest(unsignedArchive),
    };
    await writeArchive(archivePath, archive);
    return archiveSummary(archivePath, archive);
  }

  async inspectArchive(archivePath: string): Promise<WorkspaceArchiveSummary> {
    return archiveSummary(archivePath, await readArchive(archivePath));
  }

  async previewRestore(
    archivePath: string,
    destinationRoot: string,
  ): Promise<WorkspaceRestorePreview> {
    const archive = await readArchive(archivePath);
    return {
      ...archiveSummary(archivePath, archive),
      destinationRoot: resolve(destinationRoot),
      destinationExists: await pathExists(resolve(destinationRoot)),
    };
  }

  async importArchive(archivePath: string, destinationRoot: string): Promise<WorkspaceHandle> {
    return importArchiveFile(archivePath, destinationRoot);
  }

  async backup(sourceRoot: string, archivePath: string): Promise<WorkspaceArchiveSummary> {
    return this.exportArchive(sourceRoot, archivePath);
  }

  async restore(archivePath: string, destinationRoot: string): Promise<WorkspaceHandle> {
    return this.importArchive(archivePath, destinationRoot);
  }
}

export async function createWorkspace(
  rootPath: string,
  options: CreateWorkspaceOptions & WorkspaceManagerOptions = {},
): Promise<WorkspaceHandle> {
  return new WorkspaceManager(options).create(rootPath, options);
}

export function createWorkspaceSync(
  rootPath: string,
  options: CreateWorkspaceOptions & WorkspaceManagerOptions = {},
): WorkspaceHandle {
  return new WorkspaceManager(options).createSync(rootPath, options);
}

export async function openWorkspace(rootPath: string): Promise<WorkspaceHandle> {
  return new WorkspaceManager().open(rootPath);
}

export function openWorkspaceSync(rootPath: string): WorkspaceHandle {
  return new WorkspaceManager().openSync(rootPath);
}
