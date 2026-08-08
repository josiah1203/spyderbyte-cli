import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { LocalRepositoryRuntime } from '../src/index.js';

const execFileAsync = promisify(execFile);

async function gitRepository(root: string): Promise<string> {
  const repositoryPath = join(root, 'repo');
  await mkdir(repositoryPath, { recursive: true });
  await execFileAsync('git', ['init', repositoryPath]);
  await execFileAsync('git', [
    '-C',
    repositoryPath,
    'config',
    'user.email',
    'phase2@spyderbyte.local',
  ]);
  await execFileAsync('git', ['-C', repositoryPath, 'config', 'user.name', 'Spyderbyte Phase 2']);
  await writeFile(join(repositoryPath, 'README.md'), 'before\n');
  await writeFile(join(repositoryPath, 'package.json'), '{"name":"phase2"}\n');
  await execFileAsync('git', ['-C', repositoryPath, 'add', '--all']);
  await execFileAsync('git', ['-C', repositoryPath, 'commit', '-m', 'initial']);
  return repositoryPath;
}

describe('Phase 2 project filesystem and execution loop', () => {
  it('supports directory projects, bounded search, safe file operations, and local history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-phase2-directory-'));
    const projectPath = join(root, 'project');
    await mkdir(join(projectPath, 'src'), { recursive: true });
    await writeFile(join(projectPath, 'src', 'main.py'), 'print("phase2")\n');

    const runtime = new LocalRepositoryRuntime({
      rootPath: root,
      clock: () => '2026-08-06T00:00:00.000Z',
    });
    const project = await runtime.register({ path: projectPath, kind: 'directory' });
    expect(project.kind).toBe('directory');
    expect(await runtime.listFiles(project.repositoryId)).toEqual(
      expect.arrayContaining([
        { path: 'src', kind: 'directory' },
        { path: 'src/main.py', kind: 'file' },
      ]),
    );
    await expect(runtime.search(project.repositoryId, 'phase2')).resolves.toEqual([
      expect.objectContaining({ path: 'src/main.py', line: 1, column: 8 }),
    ]);

    const written = await runtime.writeFile({
      repositoryId: project.repositoryId,
      path: 'generated/result.json',
      content: '{"ok":true}\n',
      origin: 'generated',
      artifactId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(written).toMatchObject({
      operation: 'created',
      origin: 'generated',
      changeSetId: expect.any(String),
    });
    await runtime.moveFile({
      repositoryId: project.repositoryId,
      from: 'generated/result.json',
      to: 'generated/final.json',
    });
    await expect(
      runtime.deleteFile({ repositoryId: project.repositoryId, path: 'generated/final.json' }),
    ).resolves.toMatchObject({
      path: 'generated/final.json',
    });
    await expect(runtime.readFile(project.repositoryId, '../outside.txt')).rejects.toThrow();
    await expect(runtime.history(project.repositoryId, 'generated/final.json')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'file-operation',
          subject: expect.stringContaining('Deleted'),
        }),
      ]),
    );
    await expect(readFile(join(projectPath, 'src', 'main.py'), 'utf8')).resolves.toContain(
      'phase2',
    );
  });

  it('classifies dependency changes, refreshes manual reviews, and persists execution evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-phase2-git-'));
    const repositoryPath = await gitRepository(root);
    const runtime = new LocalRepositoryRuntime({ rootPath: root });
    const repository = await runtime.register({ path: repositoryPath });
    await writeFile(join(repositoryPath, 'README.md'), 'after\n');
    await writeFile(
      join(repositoryPath, 'package.json'),
      '{"name":"phase2","scripts":{"test":"node"}}\n',
    );
    await runtime.writeFile({
      repositoryId: repository.repositoryId,
      path: 'generated/output.txt',
      content: 'generated\n',
      origin: 'artifact-derived',
    });

    const changeSet = await runtime.createChangeSet(repository.repositoryId);
    expect(changeSet.changes).toEqual(
      expect.arrayContaining([
        { path: 'README.md', status: 'modified' },
        { path: 'package.json', status: 'dependency', dependencyKind: 'manifest' },
        { path: 'generated/output.txt', status: 'created' },
      ]),
    );
    await runtime.writeFile({
      repositoryId: repository.repositoryId,
      path: 'README.md',
      content: 'manually edited\n',
      origin: 'manual',
    });
    await expect(runtime.refreshChangeSet(changeSet.changeSetId)).resolves.toMatchObject({
      state: 'draft',
      acceptedHunkIds: [],
      changes: expect.arrayContaining([
        expect.objectContaining({ path: 'README.md', status: 'modified' }),
      ]),
    });

    const result = await runtime.runTest({
      repositoryId: repository.repositoryId,
      command: 'node',
      args: ['-e', 'process.stdout.write("run-evidence")'],
    });
    expect(result).toMatchObject({
      status: 'passed',
      output: 'run-evidence',
      runtime: 'local-command',
      runId: expect.any(String),
      codeRevision: expect.stringContaining('sha256:'),
      metrics: { durationMs: expect.any(Number) },
      artifacts: [],
    });
    await expect(runtime.getRun(result.runId)).resolves.toMatchObject({
      status: 'passed',
      inputs: { command: 'node', args: ['-e', 'process.stdout.write("run-evidence")'] },
      logs: { output: 'run-evidence', truncated: false },
      outputs: [{ kind: 'command', status: 'passed' }],
    });
    const restarted = new LocalRepositoryRuntime({ rootPath: root });
    await expect(restarted.listRuns(repository.repositoryId)).resolves.toEqual([
      expect.objectContaining({ runId: result.runId, status: 'passed' }),
    ]);
  });
});
