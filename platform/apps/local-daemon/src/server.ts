import {
  createLocalApiServer,
  StaticBearerSessionAuthenticator,
  type ApiSession,
  type ProductionScaleOperations,
} from '@agentic-platform/local-api';
import {
  createLicenseGate,
  type LicensePublicKeys,
  writeSignedEntitlementFileSync,
} from '@agentic-platform/license';
import {
  newSortableId,
  runtimeError,
  type Actor,
  type Id,
  type JsonValue,
  type TenantRef,
  type WorkspaceContext,
} from '@agentic-platform/runtime-contracts';
import {
  WorkspaceError,
  WorkspaceManager,
  type WorkspaceHandle,
} from '@agentic-platform/workspace';
import { statfsSync } from 'node:fs';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import process from 'node:process';
import type { Server } from 'node:http';
import { createWorkspaceLocalDaemon, type LocalDaemon } from './index.js';
import { FileLocalIdentityStore } from './identity-store.js';
import { FileSettingsStore } from './settings-store.js';
import type { ConversationAgentAdapter } from './conversation.js';
import type { ProviderRuntimeServices } from '@agentic-platform/provider-runtime';

export interface LocalDaemonServerOptions {
  readonly workspacePath?: string;
  readonly workspaceName?: string;
  readonly licenseFilePath?: string;
  readonly licensePublicKeys?: LicensePublicKeys;
  readonly authToken?: string;
  readonly requireAuthentication?: boolean;
  readonly host?: string;
  readonly port?: number;
  readonly corsOrigins?: readonly string[];
  readonly clock?: () => string;
  readonly providerRuntime?: ProviderRuntimeServices;
  readonly conversationAgentAdapter?: ConversationAgentAdapter;
  readonly productionScale?: ProductionScaleOperations;
}

export interface LocalDaemonServer {
  readonly daemon: LocalDaemon;
  readonly server: Server;
  readonly workspace: WorkspaceHandle;
  readonly tenant: TenantRef;
  readonly workspaceContext: WorkspaceContext;
  readonly address: string;
  readonly port: number;
  readonly authToken?: string;
  close(): Promise<void>;
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function positivePort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError(`${value} is not a valid local API port`);
  }
  return port;
}

function origins(value: string | undefined): readonly string[] {
  return (
    value ??
    'tauri://localhost,http://tauri.localhost,https://tauri.localhost,http://localhost:4173,http://127.0.0.1:4173'
  )
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

function publicKeysFromEnvironment(): LicensePublicKeys | undefined {
  const key = env('AGENTIC_LICENSE_PUBLIC_KEY');
  if (key === undefined) return undefined;
  return { [env('AGENTIC_LICENSE_KEY_ID') ?? 'default']: key };
}

function workspaceForPath(
  path: string,
  name: string | undefined,
  clock?: () => string,
): WorkspaceHandle {
  const manager = new WorkspaceManager(clock === undefined ? {} : { clock });
  try {
    return manager.openSync(path);
  } catch (error) {
    if (!(error instanceof WorkspaceError) || error.code !== 'WORKSPACE_NOT_FOUND') throw error;
    return manager.createSync(path, name === undefined ? {} : { name });
  }
}

function localSession(
  tenant: TenantRef,
  now: string,
  workspaceContext: WorkspaceContext,
  actor: Actor,
): ApiSession {
  return {
    schemaVersion: 1,
    sessionId: newSortableId(),
    actor,
    tenant,
    workspaces: [tenant],
    workspaceContext,
    workspaceContexts: [workspaceContext],
    scopes: ['local'],
    issuedAt: now,
    expiresAt: '9999-12-31T23:59:59.999Z',
  };
}

function localActor(
  identityStore: FileLocalIdentityStore,
  displayName: string,
): { readonly actor: Actor; readonly created: boolean } {
  const actorId = identityStore.load();
  if (actorId !== undefined)
    return { actor: { actorId, type: 'human', displayName }, created: false };
  return {
    actor: { actorId: identityStore.create(), type: 'human', displayName },
    created: true,
  };
}

function profileDisplayName(settings: FileSettingsStore, tenant: TenantRef): string {
  const values = settings.get(tenant, 'user')?.values['profile'];
  if (values !== null && typeof values === 'object' && !Array.isArray(values)) {
    const displayName = values['displayName'];
    if (typeof displayName === 'string' && displayName.trim().length > 0) return displayName.trim();
  }
  return 'Local user';
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Local API did not expose a TCP address'));
        return;
      }
      resolvePort(address.port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function machineProjection(tenant: TenantRef, rootPath: string, now: string): JsonValue {
  const cpuCount = Math.max(1, cpus().length);
  const load = loadavg()[0] ?? 0;
  const total = totalmem();
  const free = freemem();
  const memoryPercent =
    total > 0 ? Math.max(0, Math.min(100, ((total - free) / total) * 100)) : undefined;
  let storagePercent: number | undefined;
  try {
    const filesystem = statfsSync(rootPath);
    const totalBlocks = Number(filesystem.blocks);
    const availableBlocks = Number(filesystem.bavail);
    if (Number.isFinite(totalBlocks) && totalBlocks > 0 && Number.isFinite(availableBlocks)) {
      storagePercent = Math.max(
        0,
        Math.min(100, ((totalBlocks - availableBlocks) / totalBlocks) * 100),
      );
    }
  } catch {
    storagePercent = undefined;
  }
  return {
    projectionName: 'machine-state',
    projectionVersion: 1,
    tenant,
    state: {
      observations: {
        latest: {
          cpuPercent: Math.max(0, Math.min(100, (load / cpuCount) * 100)),
          ...(memoryPercent === undefined ? {} : { memoryPercent }),
          ...(storagePercent === undefined ? {} : { storagePercent }),
          gpuAvailable: null,
          gpuActive: null,
          platform: process.platform,
          cpuCount,
          observedAt: now,
        },
      },
    },
    cursor: 0,
    streamHead: 0,
    lag: 0,
    stale: false,
    freshness: 'fresh',
    generatedAt: now,
    permissions: ['machine.read'],
  } as unknown as JsonValue;
}

export async function createLocalDaemonServer(
  options: LocalDaemonServerOptions = {},
): Promise<LocalDaemonServer> {
  const clock = options.clock ?? (() => new Date().toISOString());
  const workspacePath = resolve(
    options.workspacePath ?? env('AGENTIC_WORKSPACE') ?? '.agentic-workspace',
  );
  const workspace = workspaceForPath(
    workspacePath,
    options.workspaceName ?? env('AGENTIC_WORKSPACE_NAME'),
    clock,
  );
  const workspaceManager = new WorkspaceManager({ clock });
  const licenseFilePath = options.licenseFilePath ?? env('AGENTIC_LICENSE_FILE');
  const licensePublicKeys = options.licensePublicKeys ?? publicKeysFromEnvironment();
  const daemon = createWorkspaceLocalDaemon(workspace, {
    ...(licenseFilePath === undefined ? {} : { licenseFilePath }),
    ...(licensePublicKeys === undefined ? {} : { licensePublicKeys }),
    clock,
    ...(options.providerRuntime === undefined ? {} : { providerRuntime: options.providerRuntime }),
    ...(options.conversationAgentAdapter === undefined
      ? {}
      : { conversationAgentAdapter: options.conversationAgentAdapter }),
  });
  const tenant: TenantRef = {
    tenantId: workspace.manifest.tenantId as Id,
    workspaceId: workspace.manifest.workspaceId as Id,
  };
  const workspaceContext =
    daemon.workspaceContext ??
    ({
      ...tenant,
      mode: workspace.manifest.mode ?? 'personal_local',
      ...(workspace.manifest.organizationId === undefined
        ? {}
        : { organizationId: workspace.manifest.organizationId }),
    } satisfies WorkspaceContext);
  const settings = new FileSettingsStore(join(workspace.metadataPath, 'settings.json'));
  const identityStore = new FileLocalIdentityStore(join(workspace.metadataPath, 'identity.json'));
  const identity = localActor(identityStore, profileDisplayName(settings, tenant));
  const session = localSession(tenant, clock(), workspaceContext, identity.actor);
  if (
    workspaceContext.organizationId !== undefined &&
    daemon.governance.listOrganizations(tenant).length === 0
  ) {
    daemon.governance.createOrganization({
      tenant,
      organizationId: workspaceContext.organizationId,
      name: workspace.manifest.name,
      actor: session.actor,
      now: clock(),
    });
  } else if (
    identity.created &&
    workspaceContext.organizationId !== undefined &&
    daemon.governance
      .listMemberships(tenant, workspaceContext.organizationId)
      .every((membership) => membership.actorId !== identity.actor.actorId)
  ) {
    // Migrate a pre-identity local workspace once; subsequent restarts reuse the persisted actor.
    daemon.governance.upsertMembership({
      tenant,
      organizationId: workspaceContext.organizationId,
      actorId: identity.actor.actorId,
      role: 'owner',
      scopes: [{ organizationId: workspaceContext.organizationId }],
      now: clock(),
    });
  }
  const requireAuthentication =
    options.requireAuthentication ?? env('AGENTIC_LOCAL_API_AUTH_REQUIRED') === 'true';
  const authToken =
    options.authToken ??
    env('AGENTIC_LOCAL_API_TOKEN') ??
    (requireAuthentication ? randomBytes(32).toString('base64url') : undefined);
  const server = createLocalApiServer({
    orchestrator: daemon.orchestrator,
    state: daemon.state,
    artifacts: daemon.artifacts,
    workspace: {
      rootPath: workspace.rootPath,
      manifest: workspace.manifest as unknown as JsonValue,
      exportArchive: async (archivePath) =>
        (await workspaceManager.exportArchive(
          workspace.rootPath,
          archivePath,
        )) as unknown as JsonValue,
      backupArchive: async (archivePath) =>
        (await workspaceManager.backup(workspace.rootPath, archivePath)) as unknown as JsonValue,
      previewRestore: async (archivePath, destinationRoot) =>
        (await workspaceManager.previewRestore(
          archivePath,
          destinationRoot,
        )) as unknown as JsonValue,
      importArchive: async (archivePath, destinationRoot) => {
        const imported = await workspaceManager.importArchive(archivePath, destinationRoot);
        return {
          workspaceRoot: imported.rootPath,
          manifest: imported.manifest as unknown as JsonValue,
        } as unknown as JsonValue;
      },
    },
    projections: {
      read: async (scopedTenant, projectionName) =>
        projectionName === 'machine-state'
          ? machineProjection(scopedTenant, workspace.rootPath, clock())
          : daemon.projections.read(scopedTenant, projectionName),
    },
    productCommands: daemon.productCommands,
    providerRuntime: daemon.providerRuntime,
    conversation: daemon.conversation,
    productionScale: {
      ...(options.productionScale ?? {}),
      providerRuntime: options.productionScale?.providerRuntime ?? daemon.providerRuntime,
      governance: options.productionScale?.governance ?? daemon.governance,
      identity: options.productionScale?.identity ?? daemon.identity,
      secrets: options.productionScale?.secrets ?? daemon.secrets,
      ...(options.productionScale?.hostedExecution === undefined
        ? daemon.hostedExecution === undefined
          ? {}
          : { hostedExecution: daemon.hostedExecution }
        : { hostedExecution: options.productionScale.hostedExecution }),
    },
    license: daemon.license,
    workspaceContext,
    settings,
    confirmations: daemon.confirmations,
    sessionTransform: (current) => ({
      ...current,
      actor: {
        ...current.actor,
        displayName: profileDisplayName(settings, current.tenant),
      },
    }),
    tenant,
    approvals: {
      service: daemon.approvals,
      actor: session.actor,
      authorityFor: ({ approval, actor, action, now }) =>
        daemon.authority.issue({
          tenant,
          workflowId: approval.action.workflowId,
          invocationId: approval.action.invocationId,
          issuer: actor,
          subjectAgentId: actor.actorId,
          tier: 0,
          harnessVersion: 'local-ui.approval.v1',
          permittedActions: [action === 'revoke' ? 'approval.revoke' : 'approval.decide'],
          capabilities: [],
          resourceScopes: approval.request.resources,
          allowedArtifactReads: approval.action.artifactVersions,
          allowedArtifactWrites: [],
          allowedChildAgentTypes: [],
          maxChildCount: 0,
          toolOperations: [],
          issuedAt: now,
          expiresAt: new Date(Date.parse(now) + 15 * 60 * 1000).toISOString(),
        }),
      clock,
    },
    ...(authToken === undefined
      ? { localSession: session }
      : {
          sessionAuthenticator: new StaticBearerSessionAuthenticator(authToken, session),
          sessionCookie: { value: authToken },
        }),
    ...(licenseFilePath === undefined
      ? {}
      : {
          licenseImport: (candidate: unknown): void => {
            if (licensePublicKeys !== undefined && Object.keys(licensePublicKeys).length > 0) {
              const importedStatus = createLicenseGate({
                entitlement: candidate,
                publicKeys: licensePublicKeys,
                clock,
              }).status();
              if (importedStatus.status !== 'valid') {
                throw runtimeError(
                  'POLICY_DENIED',
                  `Imported license is not valid (${importedStatus.reason})`,
                );
              }
            }
            writeSignedEntitlementFileSync(licenseFilePath, candidate);
          },
        }),
    corsOrigins: options.corsOrigins ?? origins(env('AGENTIC_LOCAL_API_ORIGINS')),
    clock,
  });
  const host = options.host ?? env('AGENTIC_LOCAL_API_HOST') ?? '127.0.0.1';
  const port = options.port ?? positivePort(env('AGENTIC_LOCAL_API_PORT'), 8787);
  try {
    const actualPort = await listen(server, host, port);
    const address = `http://${host}:${actualPort}`;
    return {
      daemon,
      server,
      workspace,
      tenant,
      workspaceContext,
      address,
      port: actualPort,
      ...(authToken === undefined ? {} : { authToken }),
      close: async () => {
        daemon.close();
        if (!server.listening) return;
        await new Promise<void>((resolveClose, reject) => {
          server.close((error) => (error === undefined ? resolveClose() : reject(error)));
        });
      },
    };
  } catch (error) {
    daemon.close();
    server.close();
    throw error;
  }
}

export async function runLocalDaemonServer(): Promise<void> {
  const runtime = await createLocalDaemonServer();
  const shutdown = (): void => {
    void runtime.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.stdout.write(
    `${JSON.stringify({
      ready: true,
      address: runtime.address,
      port: runtime.port,
      workspace: runtime.workspace.rootPath,
      tenant: runtime.tenant,
      ...(runtime.authToken === undefined ? {} : { authToken: runtime.authToken }),
    })}\n`,
  );
}

if (process.argv[1]?.endsWith('/server.js')) {
  runLocalDaemonServer().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
