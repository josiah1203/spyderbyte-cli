import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  newSortableId,
  type ArtifactReference,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import { runCodingTask, runSandboxed, type CodingArtifactPublicationInput } from '../src/index.js';

const limits = {
  cpuMillicores: 100,
  memoryBytes: 1024 * 1024,
  wallTimeMs: 1_000,
  outputBytes: 1_000,
  storageBytes: 1024 * 1024,
  processCount: 1,
};

const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
const createdAt = '2026-08-02T00:00:00.000Z';

function patchPublisher(captured: CodingArtifactPublicationInput[] = []) {
  return {
    captured,
    publish(input: CodingArtifactPublicationInput): Promise<ArtifactReference> {
      captured.push(input);
      return Promise.resolve({
        schemaVersion: 1,
        tenant: input.tenant,
        artifactId: newSortableId(),
        version: 1,
        contentHash: input.contentHash,
        mediaType: input.mediaType,
        sizeBytes: Buffer.byteLength(input.content),
        createdAt: input.createdAt,
      });
    },
  };
}

describe('sandbox runner', () => {
  it('runs in an invocation-specific workspace and cleans it after completion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentic-sandbox-test-'));
    const source = join(root, 'source.txt');
    await writeFile(source, 'read-only fixture');
    const result = await runSandboxed({
      invocationId: newSortableId(),
      command: process.execPath,
      args: ['-e', 'process.stdout.write(require("fs").readFileSync("fixture.txt", "utf8"))'],
      limits,
      workingRoot: root,
      mounts: [{ sourcePath: source, targetPath: 'fixture.txt' }],
      networkAllowlist: [],
    });
    expect(result.status).toBe('succeeded');
    expect(result.stdout).toBe('read-only fixture');
    await expect(readFile(result.workspacePath)).rejects.toThrow();
  });

  it('propagates cancellation and bounds output', async () => {
    const controller = new AbortController();
    const cancelled = runSandboxed(
      {
        invocationId: newSortableId(),
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 1000)'],
        limits,
        networkAllowlist: [],
      },
      controller.signal,
    );
    controller.abort();
    await expect(cancelled).resolves.toMatchObject({ status: 'cancelled' });
    await expect(
      runSandboxed({
        invocationId: newSortableId(),
        command: process.execPath,
        args: ['-e', 'process.stdout.write("x".repeat(1000))'],
        limits: { ...limits, outputBytes: 10 },
        networkAllowlist: [],
      }),
    ).resolves.toMatchObject({ status: 'output_limited', outputTruncated: true });
  });

  it('captures a coding diff, runs required checks, and enforces the path allowlist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentic-coding-test-'));
    const repository = join(root, 'repository');
    await mkdir(join(repository, 'src'), { recursive: true });
    await writeFile(join(repository, 'src', 'input.txt'), 'fixture');
    const publisher = patchPublisher();
    const result = await runCodingTask({
      invocationId: newSortableId(),
      tenant,
      repositoryPath: repository,
      command: process.execPath,
      args: ['-e', 'require("fs").writeFileSync("src/output.txt", "generated")'],
      allowedPaths: ['src'],
      requiredChecks: [
        {
          name: 'generated-file',
          command: process.execPath,
          args: [
            '-e',
            'if (require("fs").readFileSync("src/output.txt", "utf8") !== "generated") process.exit(1)',
          ],
        },
      ],
      limits,
      workingRoot: root,
      networkAllowlist: [],
      artifactPublisher: publisher,
      createdAt,
    });
    expect(result.status).toBe('succeeded');
    expect(result.changedPaths).toEqual(['src/output.txt']);
    expect(result.diff).toContain('A src/output.txt');
    expect(result.findings).toEqual([]);
    expect(result.patchArtifact).toMatchObject({
      tenant,
      mediaType: 'text/x-diff',
      version: 1,
    });
    expect(publisher.captured).toHaveLength(1);
    expect(publisher.captured[0]?.invocationId).toBe(result.invocationId);
    await expect(readFile(result.workspacePath)).rejects.toThrow();
  });

  it('rejects forbidden paths and secret-like changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentic-coding-policy-test-'));
    const repository = join(root, 'repository');
    await mkdir(repository, { recursive: true });
    const publisher = patchPublisher();
    const result = await runCodingTask({
      invocationId: newSortableId(),
      tenant,
      repositoryPath: repository,
      command: process.execPath,
      args: [
        '-e',
        'const fs=require("fs"); fs.writeFileSync("credentials.txt", "password="+String.fromCharCode(34)+"super-secret-value"+String.fromCharCode(34))',
      ],
      allowedPaths: ['src'],
      limits,
      workingRoot: root,
      networkAllowlist: [],
      artifactPublisher: publisher,
      createdAt,
    });
    expect(result.status).toBe('policy_denied');
    expect(result.findings).toEqual(
      expect.arrayContaining([
        'PATH_OUTSIDE_ALLOWLIST:credentials.txt',
        'SECRET_PATTERN:credentials.txt',
      ]),
    );
    expect(publisher.captured).toHaveLength(0);
  });
});
