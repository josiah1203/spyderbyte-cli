import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContentAddressedArtifactRegistry } from '@agentic-platform/artifact-registry';
import { FileSystemArtifactObjectStore } from '@agentic-platform/artifact-registry';
import { createLocalDatasetRegistry } from '@agentic-platform/agent-registry';
import {
  createMissingLicenseGate,
  createReloadingLicenseGateFromFileSync,
  type LicenseGate,
  type LicensePublicKeys,
} from '@agentic-platform/license';
import {
  ApprovalService,
  AuthorityService,
  LocalConfirmationService,
  type ApprovalStore,
} from '@agentic-platform/policy';
import { BuiltinProjectionReader, ProjectionEngine } from '@agentic-platform/projections';
import {
  newSortableId,
  type Actor,
  type Id,
  type RuntimeCommand,
  type TenantRef,
  type WorkspaceContext,
  type WorkspaceMode,
} from '@agentic-platform/runtime-contracts';
import {
  LocalDatasetWorkflowOrchestrator,
  LocalProductCommandService,
  type ProductCommandService,
} from '@agentic-platform/orchestrator';
import {
  InMemoryStateStore,
  SqliteStateStore,
  type SqliteDatabase,
  type StateStore,
} from '@agentic-platform/state';
import type { WorkspaceHandle } from '@agentic-platform/workspace';
import {
  createProviderRuntime,
  type ProviderRuntimeServices,
} from '@agentic-platform/provider-runtime';
import {
  InMemoryEnterpriseIdentityService,
  InMemoryEnterpriseSecretManager,
  type HostedExecutionAdapter,
  type EnterpriseSecretManagerClient,
} from '@agentic-platform/backends';
import {
  InMemoryGovernanceService,
  type GovernanceService,
  type GovernanceStateStore,
} from '@agentic-platform/policy';
import type { ConversationService } from '@agentic-platform/local-api';
import { LocalFileApprovalStore } from './approval-store.js';
import { LocalProjectConversationService, type ConversationAgentAdapter } from './conversation.js';
import { FileGovernanceStateStore } from './governance-store.js';

export interface LocalDaemon {
  readonly state: StateStore;
  readonly artifacts: ContentAddressedArtifactRegistry;
  readonly orchestrator: LocalDatasetWorkflowOrchestrator;
  readonly productCommands: ProductCommandService;
  readonly authority: AuthorityService;
  readonly approvals: ApprovalService;
  readonly confirmations: LocalConfirmationService;
  readonly governance: GovernanceService;
  readonly identity: InMemoryEnterpriseIdentityService;
  readonly secrets: EnterpriseSecretManagerClient;
  readonly hostedExecution?: HostedExecutionAdapter;
  readonly projections: BuiltinProjectionReader;
  readonly license: LicenseGate;
  readonly providerRuntime: ProviderRuntimeServices;
  readonly conversation: ConversationService;
  readonly workspace?: WorkspaceHandle;
  readonly workspaceMode: WorkspaceMode;
  readonly workspaceContext?: WorkspaceContext;
  readonly close: () => void;
  submit(
    command: RuntimeCommand,
    signal?: AbortSignal,
  ): ReturnType<LocalDatasetWorkflowOrchestrator['submit']>;
}

export interface LocalDaemonOptions {
  state?: StateStore;
  clock?: () => string;
  artifactRoot?: string;
  license?: LicenseGate;
  licenseFilePath?: string;
  licensePublicKeys?: LicensePublicKeys;
  workspace?: WorkspaceHandle;
  /** Trusted by daemon composition; browser requests cannot override this value. */
  workspaceMode?: WorkspaceMode;
  workspaceContext?: WorkspaceContext;
  approvalStore?: ApprovalStore;
  providerRuntime?: ProviderRuntimeServices;
  conversation?: ConversationService;
  conversationAgentAdapter?: ConversationAgentAdapter;
  governance?: GovernanceService;
  governanceStateStore?: GovernanceStateStore;
  identity?: InMemoryEnterpriseIdentityService;
  secrets?: EnterpriseSecretManagerClient;
  hostedExecution?: HostedExecutionAdapter;
}

function resolveLicense(options: LocalDaemonOptions, clock: () => string): LicenseGate {
  if (options.license !== undefined && options.licenseFilePath !== undefined) {
    throw new TypeError('Provide either license or licenseFilePath, not both');
  }
  if (options.license !== undefined) return options.license;
  if (options.licenseFilePath !== undefined) {
    return createReloadingLicenseGateFromFileSync(options.licenseFilePath, {
      clock,
      ...(options.licensePublicKeys === undefined ? {} : { publicKeys: options.licensePublicKeys }),
    });
  }
  return createMissingLicenseGate({ clock });
}

function assertTrustedWorkspaceContext(
  context: WorkspaceContext,
  tenant: TenantRef | undefined,
  mode: WorkspaceMode,
): void {
  if (
    tenant !== undefined &&
    (context.tenantId !== tenant.tenantId || context.workspaceId !== tenant.workspaceId)
  ) {
    throw new TypeError('Workspace context must match the trusted workspace tenant');
  }
  if (context.mode !== mode) throw new TypeError('Workspace context and mode must agree');
  if (mode === 'personal_local' && context.organizationId !== undefined) {
    throw new TypeError('Personal local workspace context cannot include an organization');
  }
}

export function createLocalDaemon(options: LocalDaemonOptions = {}): LocalDaemon {
  const state = options.state ?? new InMemoryStateStore();
  const clock = options.clock ?? (() => new Date().toISOString());
  const license = resolveLicense(options, clock);
  const manifestMode = options.workspace?.manifest.mode ?? 'personal_local';
  const workspaceMode = options.workspaceContext?.mode ?? options.workspaceMode ?? manifestMode;
  const workspaceTenant =
    options.workspace === undefined
      ? undefined
      : {
          tenantId: options.workspace.manifest.tenantId,
          workspaceId: options.workspace.manifest.workspaceId,
        };
  if (
    options.workspaceMode !== undefined &&
    options.workspaceContext !== undefined &&
    options.workspaceMode !== options.workspaceContext.mode
  ) {
    throw new TypeError('Workspace mode and workspace context must agree');
  }
  if (
    options.workspace?.manifest.mode !== undefined &&
    options.workspace.manifest.mode !== workspaceMode
  ) {
    throw new TypeError('Workspace manifest mode and daemon workspace mode must agree');
  }
  if (options.workspaceContext !== undefined) {
    assertTrustedWorkspaceContext(options.workspaceContext, workspaceTenant, workspaceMode);
  }
  const workspaceContext =
    options.workspaceContext ??
    (options.workspace === undefined
      ? undefined
      : {
          tenantId: options.workspace.manifest.tenantId,
          workspaceId: options.workspace.manifest.workspaceId,
          mode: workspaceMode,
          ...(options.workspace.manifest.organizationId === undefined
            ? {}
            : { organizationId: options.workspace.manifest.organizationId }),
        });
  if (workspaceContext !== undefined) {
    assertTrustedWorkspaceContext(workspaceContext, workspaceTenant, workspaceMode);
  }
  const providerRuntime =
    options.providerRuntime ??
    createProviderRuntime({
      rootPath: options.workspace?.rootPath ?? options.artifactRoot ?? process.cwd(),
      ...(workspaceContext === undefined ? {} : { tenant: workspaceContext }),
      ...(clock === undefined ? {} : { clock }),
    });
  const projections = new BuiltinProjectionReader(new ProjectionEngine(state));
  const artifacts = new ContentAddressedArtifactRegistry(
    state,
    options.artifactRoot !== undefined
      ? { contentStore: new FileSystemArtifactObjectStore(options.artifactRoot) }
      : {},
  );
  const governance =
    options.governance ??
    new InMemoryGovernanceService(
      clock,
      options.governanceStateStore ??
        (options.workspace === undefined
          ? undefined
          : new FileGovernanceStateStore(join(options.workspace.metadataPath, 'governance.json'))),
    );
  const authority = new AuthorityService({ clock });
  const conversation =
    options.conversation ??
    new LocalProjectConversationService(
      state,
      providerRuntime,
      clock,
      options.conversationAgentAdapter,
      authority,
      {
        ...(workspaceContext?.organizationId === undefined
          ? {}
          : { organizationId: workspaceContext.organizationId }),
        enforcementMode: workspaceMode === 'personal_local' ? 'personal_local' : 'organization',
        governance,
      },
    );
  const approvals = new ApprovalService({
    authority,
    ...(options.approvalStore === undefined ? {} : { store: options.approvalStore }),
    clock,
  });
  const confirmations = new LocalConfirmationService({ clock });
  const identity = options.identity ?? new InMemoryEnterpriseIdentityService({ clock });
  const secrets = options.secrets ?? new InMemoryEnterpriseSecretManager(clock);
  const orchestrator = new LocalDatasetWorkflowOrchestrator({
    state,
    artifacts,
    agents: createLocalDatasetRegistry(),
    authority,
    approvals,
    workflowApprovalMode: workspaceMode === 'personal_local' ? 'none' : 'organization',
    workspaceMode: workspaceMode === 'personal_local' ? 'personal_local' : 'organization',
    clock,
  });
  const productCommands = new LocalProductCommandService(state);
  return {
    state,
    artifacts,
    orchestrator,
    productCommands,
    authority,
    approvals,
    confirmations,
    governance,
    identity,
    secrets,
    ...(options.hostedExecution === undefined ? {} : { hostedExecution: options.hostedExecution }),
    projections,
    license,
    providerRuntime,
    conversation,
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    workspaceMode,
    ...(workspaceContext === undefined ? {} : { workspaceContext }),
    close: () => undefined,
    submit(command, signal) {
      license.assertFeature();
      return orchestrator.submit(command, signal);
    },
  };
}

interface DatabaseSync extends SqliteDatabase {
  close(): void;
}

function databaseSync(location: string): DatabaseSync {
  const builtin = process.getBuiltinModule('node:sqlite') as {
    DatabaseSync: new (
      databaseLocation: string,
      options?: { enableForeignKeyConstraints?: boolean },
    ) => DatabaseSync;
  };
  return new builtin.DatabaseSync(location, { enableForeignKeyConstraints: true });
}

function migrationPath(fileName: string): string {
  const moduleDirectory =
    typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url));
  return resolve(moduleDirectory, '../../../packages/state/migrations', fileName);
}

function migrate(database: SqliteDatabase): void {
  database.exec(readFileSync(migrationPath('0001_authoritative_state.sql'), 'utf8'));
  database.exec(readFileSync(migrationPath('0002_projects.sql'), 'utf8'));
  database.exec(readFileSync(migrationPath('0001_append_only.sqlite.sql'), 'utf8'));
}

export function createSqliteLocalDaemon(
  databasePath: string,
  options: Omit<LocalDaemonOptions, 'state'> = {},
): LocalDaemon {
  const resolvedDatabasePath = resolve(databasePath);
  mkdirSync(dirname(resolvedDatabasePath), { recursive: true });
  const database = databaseSync(resolvedDatabasePath);
  migrate(database);
  const artifactRoot = options.artifactRoot ?? `${resolvedDatabasePath}.objects`;
  const approvalStore =
    options.approvalStore ?? new LocalFileApprovalStore(`${resolvedDatabasePath}.approvals.json`);
  const daemon = createLocalDaemon({
    ...options,
    state: new SqliteStateStore(database),
    artifactRoot,
    approvalStore,
    governanceStateStore:
      options.governanceStateStore ??
      new FileGovernanceStateStore(`${resolvedDatabasePath}.governance.json`),
  });
  return { ...daemon, close: () => database.close() };
}

export function createWorkspaceLocalDaemon(
  workspace: WorkspaceHandle,
  options: Omit<LocalDaemonOptions, 'state' | 'artifactRoot' | 'workspace'> = {},
): LocalDaemon {
  return createSqliteLocalDaemon(workspace.databasePath, {
    ...options,
    workspace,
    artifactRoot: workspace.artifactRoot,
  });
}

export async function runFixtureDataset(
  daemon: LocalDaemon,
  tenant: TenantRef,
  content: string,
  options: {
    intendedUse?: string;
    requestedAccessScopes?: string[];
    now?: string;
  } = {},
) {
  daemon.license.assertFeature();
  const now = options.now ?? new Date().toISOString();
  const actor: Actor = { actorId: newSortableId(), type: 'human', displayName: 'Local CLI user' };
  const sourceArtifactId = newSortableId();
  const staged = await daemon.artifacts.stageUpload(tenant, content, 'text/csv', now);
  await daemon.artifacts.publish({
    tenant,
    artifactId: sourceArtifactId,
    stagedUploadId: staged.stagedUploadId,
    mediaType: 'text/csv',
    createdBy: actor,
    now,
  });
  const workflowId = newSortableId();
  const command: RuntimeCommand = {
    schemaVersion: 1,
    commandId: newSortableId(),
    commandType: 'ValidateDataset',
    tenant,
    actor,
    issuedAt: now,
    idempotencyKey: `local-cli-${workflowId}`,
    correlationId: workflowId,
    payload: {
      sourceArtifactId,
      sourceArtifactVersion: 1,
      intendedUse: options.intendedUse ?? 'local fixture validation',
      requestedAccessScopes: options.requestedAccessScopes ?? ['dataset.read'],
      retentionDays: 30,
      requiredColumns: ['id', 'value'],
      expectedTypes: { id: 'number' },
      leakageThreshold: 0,
      splitSeed: 'local-cli.v1',
    },
  };
  return daemon.submit(command);
}

export type LocalDaemonTenant = TenantRef;
export type LocalDaemonWorkflowId = Id;
export { LocalProjectConversationService } from './conversation.js';
export type { ConversationAgentAdapter } from './conversation.js';
