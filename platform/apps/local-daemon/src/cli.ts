import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { newSortableId, type Id, type TenantRef } from '@agentic-platform/runtime-contracts';
import { WorkspaceError, WorkspaceManager } from '@agentic-platform/workspace';
import { createSqliteLocalDaemon, createWorkspaceLocalDaemon, runFixtureDataset } from './index.js';

export async function runLocalDatasetCli(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const sourcePath = args[0];
  if (!sourcePath) {
    throw new Error(
      'Usage: pnpm --filter @agentic-platform/local-daemon local:dataset <dataset.csv>',
    );
  }
  const workspacePath = process.env['AGENTIC_WORKSPACE'];
  const workspaceManager = new WorkspaceManager();
  let workspace;
  if (workspacePath !== undefined) {
    try {
      workspace = workspaceManager.openSync(resolve(workspacePath));
    } catch (error) {
      if (!(error instanceof WorkspaceError) || error.code !== 'WORKSPACE_NOT_FOUND') throw error;
      workspace = workspaceManager.createSync(resolve(workspacePath), {
        ...(process.env['AGENTIC_WORKSPACE_NAME'] === undefined
          ? {}
          : { name: process.env['AGENTIC_WORKSPACE_NAME'] }),
      });
    }
  }
  const tenant: TenantRef = {
    tenantId: (process.env['AGENTIC_TENANT_ID'] ??
      workspace?.manifest.tenantId ??
      newSortableId()) as Id,
    workspaceId: (process.env['AGENTIC_WORKSPACE_ID'] ??
      workspace?.manifest.workspaceId ??
      newSortableId()) as Id,
  };
  const licenseFilePath = process.env['AGENTIC_LICENSE_FILE'];
  const licenseKey = process.env['AGENTIC_LICENSE_PUBLIC_KEY'];
  const licenseKeyId = process.env['AGENTIC_LICENSE_KEY_ID'] ?? 'default';
  const licenseOptions = {
    ...(licenseFilePath === undefined ? {} : { licenseFilePath }),
    ...(licenseKey === undefined ? {} : { licensePublicKeys: { [licenseKeyId]: licenseKey } }),
  };
  const daemon =
    workspace === undefined
      ? createSqliteLocalDaemon(
          process.env['AGENTIC_LOCAL_DB'] ?? resolve(process.cwd(), 'agentic-local.sqlite'),
          licenseOptions,
        )
      : createWorkspaceLocalDaemon(workspace, licenseOptions);
  try {
    const result = await runFixtureDataset(
      daemon,
      tenant,
      await readFile(resolve(sourcePath), 'utf8'),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    daemon.close();
  }
}

if (process.argv[1]?.endsWith('/cli.js')) {
  runLocalDatasetCli().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
