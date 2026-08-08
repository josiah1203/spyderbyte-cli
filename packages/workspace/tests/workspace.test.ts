import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newSortableId } from '@agentic-platform/runtime-contracts';
import { WorkspaceError, WorkspaceManager } from '../src/index.js';

describe('WorkspaceManager', () => {
  it('creates and reopens a portable workspace manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentic-workspace-'));
    try {
      const now = '2026-08-03T00:00:00.000Z';
      const manager = new WorkspaceManager({ clock: () => now });
      const created = await manager.create(join(root, 'project'), { name: 'Project' });
      expect(created.manifest).toMatchObject({
        schemaVersion: 1,
        name: 'Project',
        mode: 'personal_local',
        createdAt: now,
      });
      expect(created.databasePath).toBe(join(created.rootPath, '.agentic', 'state.sqlite'));
      expect((await manager.open(created.rootPath)).manifest.workspaceId).toBe(
        created.manifest.workspaceId,
      );
      expect(await readFile(created.manifestPath, 'utf8')).toContain('"schemaVersion": 1');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('migrates a v1 manifest without a mode to personal local', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentic-workspace-migrate-'));
    try {
      const manager = new WorkspaceManager({ clock: () => '2026-08-03T00:00:00.000Z' });
      const created = await manager.create(join(root, 'project'));
      const legacy = JSON.parse(await readFile(created.manifestPath, 'utf8')) as Record<
        string,
        unknown
      >;
      delete legacy['mode'];
      await writeFile(created.manifestPath, JSON.stringify(legacy));

      const reopened = await manager.open(created.rootPath);
      expect(reopened.manifest.mode).toBe('personal_local');
      expect(JSON.parse(await readFile(created.manifestPath, 'utf8'))).toMatchObject({
        mode: 'personal_local',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('requires an organization identifier for trusted organization workspaces', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentic-workspace-mode-'));
    try {
      const manager = new WorkspaceManager({ clock: () => '2026-08-03T00:00:00.000Z' });
      await expect(
        manager.create(join(root, 'missing-org'), { mode: 'organization_local' }),
      ).rejects.toMatchObject({ code: 'WORKSPACE_INVALID' });
      await expect(
        manager.create(join(root, 'personal-org'), {
          mode: 'personal_local',
          organizationId: newSortableId(),
        }),
      ).rejects.toMatchObject({ code: 'WORKSPACE_INVALID' });
      const organization = await manager.create(join(root, 'organization'), {
        mode: 'organization_local',
        organizationId: newSortableId(),
      });
      expect(organization.manifest.mode).toBe('organization_local');
      expect(organization.manifest.organizationId).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('exports and imports without overwriting a destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentic-workspace-copy-'));
    try {
      const manager = new WorkspaceManager({ clock: () => '2026-08-03T00:00:00.000Z' });
      const source = await manager.create(join(root, 'source'), {
        tenantId: newSortableId(),
        workspaceId: newSortableId(),
      });
      const exported = await manager.export(source.rootPath, join(root, 'exported'));
      expect(exported.manifest.workspaceId).toBe(source.manifest.workspaceId);
      await expect(manager.import(source.rootPath, exported.rootPath)).rejects.toMatchObject({
        code: 'WORKSPACE_DESTINATION_EXISTS',
      });
      await expect(manager.open(join(root, 'missing'))).rejects.toBeInstanceOf(WorkspaceError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('exports a checksummed archive, previews restore, and restores binary files safely', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentic-workspace-archive-'));
    try {
      const manager = new WorkspaceManager({ clock: () => '2026-08-03T00:00:00.000Z' });
      const source = await manager.create(join(root, 'source'), { name: 'Archive source' });
      const objectDirectory = join(source.artifactRoot, 'sha256');
      await mkdir(objectDirectory, { recursive: true });
      const objectPath = join(objectDirectory, 'binary-object');
      await writeFile(objectPath, Buffer.from([0, 1, 2, 127, 255]));

      const archivePath = join(root, 'backups', 'workspace.agentic');
      const exported = await manager.backup(source.rootPath, archivePath);
      expect(exported.archiveFormat).toBe('agentic.workspace.archive.v1');
      expect(exported.fileCount).toBeGreaterThanOrEqual(2);
      expect((await manager.inspectArchive(archivePath)).archiveHash).toBe(exported.archiveHash);

      const destination = join(root, 'restored');
      const preview = await manager.previewRestore(archivePath, destination);
      expect(preview.destinationExists).toBe(false);
      expect(preview.manifest.workspaceId).toBe(source.manifest.workspaceId);
      const restored = await manager.restore(archivePath, destination);
      expect(restored.manifest.workspaceId).toBe(source.manifest.workspaceId);
      expect(await readFile(join(restored.artifactRoot, 'sha256', 'binary-object'))).toEqual(
        Buffer.from([0, 1, 2, 127, 255]),
      );
      await expect(manager.restore(archivePath, destination)).rejects.toMatchObject({
        code: 'WORKSPACE_DESTINATION_EXISTS',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects tampered and traversal archive entries before restore', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentic-workspace-archive-security-'));
    try {
      const manager = new WorkspaceManager({ clock: () => '2026-08-03T00:00:00.000Z' });
      const source = await manager.create(join(root, 'source'));
      const archivePath = join(root, 'workspace.agentic');
      await manager.exportArchive(source.rootPath, archivePath);
      const archive = JSON.parse(await readFile(archivePath, 'utf8')) as {
        files: Array<{ path: string; contentBase64: string }>;
      };
      const firstFile = archive.files[0];
      expect(firstFile).toBeDefined();
      if (firstFile === undefined) throw new Error('Archive fixture did not contain a file');
      firstFile.path = '../escape';
      await writeFile(archivePath, JSON.stringify(archive));
      await expect(manager.inspectArchive(archivePath)).rejects.toMatchObject({
        code: 'WORKSPACE_ARCHIVE_INVALID',
      });

      await rm(archivePath);
      await manager.exportArchive(source.rootPath, archivePath);
      const validArchive = JSON.parse(await readFile(archivePath, 'utf8')) as {
        files: Array<{ contentBase64: string }>;
      };
      const validFirstFile = validArchive.files[0];
      expect(validFirstFile).toBeDefined();
      if (validFirstFile === undefined) throw new Error('Archive fixture did not contain a file');
      validFirstFile.contentBase64 = Buffer.from('tampered', 'utf8').toString('base64');
      await writeFile(archivePath, JSON.stringify(validArchive));
      await expect(manager.inspectArchive(archivePath)).rejects.toMatchObject({
        code: 'WORKSPACE_ARCHIVE_INTEGRITY',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts a v1 archive digest whose manifest predates workspace modes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentic-workspace-legacy-archive-'));
    try {
      const manager = new WorkspaceManager({ clock: () => '2026-08-03T00:00:00.000Z' });
      const source = await manager.create(join(root, 'source'));
      const archivePath = join(root, 'legacy.agentic');
      await manager.exportArchive(source.rootPath, archivePath);

      const archive = JSON.parse(await readFile(archivePath, 'utf8')) as {
        archiveFormat: string;
        schemaVersion: number;
        createdAt: string;
        manifest: Record<string, unknown>;
        files: Array<{
          path: string;
          sizeBytes: number;
          contentHash: string;
          contentBase64: string;
        }>;
        totalBytes: number;
        archiveHash: string;
      };
      delete archive.manifest['mode'];
      const manifestFile = archive.files.find((file) => file.path === '.agentic/workspace.json');
      expect(manifestFile).toBeDefined();
      if (manifestFile === undefined) throw new Error('Archive manifest file is missing');
      const manifestBytes = Buffer.from(`${JSON.stringify(archive.manifest, null, 2)}\n`, 'utf8');
      manifestFile.sizeBytes = manifestBytes.byteLength;
      manifestFile.contentBase64 = manifestBytes.toString('base64');
      manifestFile.contentHash = createHash('sha256').update(manifestBytes).digest('hex');
      archive.totalBytes = archive.files.reduce((total, file) => total + file.sizeBytes, 0);
      const unsigned = {
        archiveFormat: archive.archiveFormat,
        schemaVersion: archive.schemaVersion,
        createdAt: archive.createdAt,
        manifest: archive.manifest,
        files: archive.files,
        totalBytes: archive.totalBytes,
      };
      archive.archiveHash = createHash('sha256')
        .update(JSON.stringify(unsigned), 'utf8')
        .digest('hex');
      await writeFile(archivePath, JSON.stringify(archive));

      expect((await manager.inspectArchive(archivePath)).manifest.mode).toBe('personal_local');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
