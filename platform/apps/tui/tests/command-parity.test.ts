import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SpyderbyteClient } from '@agentic-platform/client-sdk';
import { newSortableId } from '@agentic-platform/runtime-contracts';
import { execute, HELP, interactiveCommand } from '../src/index.js';

function fakeClient(overrides: Record<string, unknown> = {}): SpyderbyteClient {
  return {
    localRepositories: vi.fn(async () => ({ repositories: [{ repositoryId: 'repo-1' }] })),
    runRepositoryTest: vi.fn(async () => ({ status: 'passed' })),
    runDataQuery: vi.fn(async () => ({ status: 'completed' })),
    artifacts: vi.fn(async () => ({ artifacts: [] })),
    artifact: vi.fn(async () => ({ reference: { version: 1 } })),
    artifactVersions: vi.fn(async () => []),
    artifactLineage: vi.fn(async () => []),
    artifactContent: vi.fn(async () => ({ contentBase64: 'QUJD' })),
    stageArtifactUpload: vi.fn(async () => ({ stagedUploadId: 'upload-1' })),
    publishArtifactVersion: vi.fn(async () => ({ artifactId: 'artifact-1', version: 2 })),
    session: vi.fn(async () => ({ actor: { actorId: 'actor-1', type: 'human' } })),
    artifactDiff: vi.fn(async () => ({ changed: false, changes: [] })),
    repositoryFiles: vi.fn(async () => ({ files: [] })),
    repositoryStatus: vi.fn(async () => ({ status: 'clean' })),
    repositoryDiff: vi.fn(async () => ({ files: [] })),
    repositoryFile: vi.fn(async () => ({ path: 'README.md', content: 'readme' })),
    writeRepositoryFile: vi.fn(async () => ({ path: 'README.md', version: 2 })),
    chooseVisualization: vi.fn(async () => ({ type: 'table', source: 'automatic' })),
    validateVisualization: vi.fn(async () => ({ valid: true })),
    renderVisualization: vi.fn(async () => ({ status: 'rendered' })),
    workspaceContext: vi.fn(async () => ({ schemaVersion: 1 })),
    workspaceIntake: vi.fn(async () => ({ schemaVersion: 1 })),
    workspaceInbox: vi.fn(async () => []),
    workspaceWatch: vi.fn(async () => []),
    workspaceRecommendations: vi.fn(async () => []),
    updateStatus: vi.fn(async () => ({ state: 'unconfigured' })),
    checkForUpdates: vi.fn(async () => ({ state: 'unconfigured' })),
    downloadUpdate: vi.fn(async () => ({ state: 'unconfigured' })),
    installUpdate: vi.fn(async () => ({ state: 'unconfigured' })),
    rollbackUpdate: vi.fn(async () => ({ state: 'rollback-requested' })),
    projects: vi.fn(async () => ({ projects: [] })),
    projectConversation: vi.fn(async () => ({ projectId: 'project-1', messages: [] })),
    startTraining: vi.fn(async () => ({ status: 'queued' })),
    exportNotebook: vi.fn(async () => ({ notebookId: 'notebook-1', format: 'ipynb' })),
    serveLocalDeployment: vi.fn(async () => ({ status: 'queued' })),
    ...overrides,
  } as unknown as SpyderbyteClient;
}

describe('TUI/CLI parity command surface', () => {
  it('documents the required shared-service command families', () => {
    expect(HELP).toContain('spyderbyte run script <file>');
    expect(HELP).toContain('spyderbyte query <file>');
    expect(HELP).toContain('spyderbyte notebooks export <notebookId>');
    expect(HELP).toContain('spyderbyte train <config.json>');
    expect(HELP).toContain('spyderbyte deploy <model-or-artifact>');
    expect(HELP).toContain('spyderbyte updates status|check|download|install|rollback');
    expect(interactiveCommand('/sql')).toEqual(['query', 'list']);
    expect(interactiveCommand('/project open project-1')).toEqual(['project', 'open', 'project-1']);
  });

  it('routes file-backed query, script, training, notebook export, and deploy commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spyderbyte-tui-parity-'));
    const sqlPath = join(root, 'query.sql');
    const scriptPath = join(root, 'train.py');
    const configPath = join(root, 'train.json');
    const artifactOutputPath = join(root, 'artifact.txt');
    const artifactInputPath = join(root, 'artifact-next.txt');
    await writeFile(sqlPath, 'SELECT 1');
    await writeFile(scriptPath, 'print("ok")');
    await writeFile(configPath, JSON.stringify({ epochs: 1 }));
    await writeFile(artifactInputPath, 'next artifact');

    const client = fakeClient();
    await execute(client, ['query', sqlPath]);
    await execute(client, ['run', 'script', scriptPath, '--repository', 'repo-1']);
    await execute(client, ['train', configPath]);
    await execute(client, ['notebooks', 'export', 'notebook-1']);
    await execute(client, ['deploy', 'model-1']);
    await execute(client, ['artifacts', 'list']);
    await execute(client, ['artifacts', 'inspect', 'artifact-1']);
    await execute(client, ['artifacts', 'open', 'artifact-1']);
    await execute(client, ['artifacts', 'export', 'artifact-1', '--output', artifactOutputPath]);
    await execute(client, ['artifacts', 'reuse', 'artifact-1', '--output', artifactOutputPath]);
    await execute(client, ['artifacts', 'save', 'artifact-1', artifactInputPath]);
    await execute(client, ['artifacts', 'preview', 'artifact-1']);
    await execute(client, ['artifacts', 'versions', 'artifact-1']);
    await execute(client, ['artifacts', 'lineage', 'artifact-1']);
    await execute(client, ['artifacts', 'diff', 'artifact-1', '--from', '1']);
    await execute(client, ['visualize', 'choose', 'artifact-1']);
    await execute(client, ['visualize', 'render', 'artifact-1', '--type', 'heatmap']);
    await execute(client, ['files', 'list']);
    await execute(client, ['files', 'list', 'repo-1']);
    await execute(client, ['files', 'context']);
    await execute(client, ['files', 'status', 'repo-1']);
    await execute(client, ['files', 'diff', 'repo-1']);
    await execute(client, ['files', 'open', 'repo-1', 'README.md']);
    await execute(client, [
      'files',
      'save',
      'repo-1',
      'README.md',
      '--content',
      'updated',
      '--artifact',
      'artifact-1',
      '--confirmation',
      'confirm-1',
    ]);
    await execute(client, ['workspace', 'recommendations']);
    await execute(client, ['updates', 'status']);
    await execute(client, ['updates', 'check']);
    const projectId = newSortableId();
    await execute(client, ['project', 'open', projectId]);

    expect(client.runDataQuery).toHaveBeenCalledWith(
      expect.objectContaining({ queryId: expect.any(String), sql: 'SELECT 1' }),
    );
    expect(client.runRepositoryTest).toHaveBeenCalledWith(
      'repo-1',
      expect.objectContaining({ command: 'python3', args: [scriptPath] }),
    );
    expect(client.startTraining).toHaveBeenCalledWith({ configuration: { epochs: 1 } });
    expect(client.exportNotebook).toHaveBeenCalledWith('notebook-1');
    expect(client.serveLocalDeployment).toHaveBeenCalledWith({ modelId: 'model-1' });
    expect(client.artifacts).toHaveBeenCalled();
    expect(client.artifact).toHaveBeenCalledWith('artifact-1');
    expect(client.artifactContent).toHaveBeenCalledWith('artifact-1', 1);
    await expect(readFile(artifactOutputPath, 'utf8')).resolves.toBe('ABC');
    expect(client.stageArtifactUpload).toHaveBeenCalledWith('next artifact', 'text/plain');
    expect(client.publishArtifactVersion).toHaveBeenCalledWith(
      'artifact-1',
      expect.objectContaining({
        stagedUploadId: 'upload-1',
        expectedParentVersion: 1,
      }),
    );
    expect(client.renderVisualization).toHaveBeenCalled();
    expect(client.repositoryFiles).toHaveBeenCalledWith('repo-1', undefined);
    expect(client.repositoryStatus).toHaveBeenCalledWith('repo-1');
    expect(client.repositoryDiff).toHaveBeenCalledWith('repo-1');
    expect(client.repositoryFile).toHaveBeenCalledWith('repo-1', 'README.md');
    expect(client.writeRepositoryFile).toHaveBeenCalledWith(
      'repo-1',
      expect.objectContaining({
        path: 'README.md',
        content: 'updated',
        artifactId: 'artifact-1',
        confirmationId: 'confirm-1',
      }),
    );
    expect(client.updateStatus).toHaveBeenCalled();
    expect(client.checkForUpdates).toHaveBeenCalled();
    expect(client.artifactVersions).toHaveBeenCalledWith('artifact-1');
    expect(client.artifactLineage).toHaveBeenCalledWith('artifact-1');
    expect(client.artifactDiff).toHaveBeenCalledWith('artifact-1', 1, undefined);
    expect(client.chooseVisualization).toHaveBeenCalled();
    expect(client.workspaceRecommendations).toHaveBeenCalled();
    expect(client.projectConversation).toHaveBeenCalledWith(projectId);
  });
});
