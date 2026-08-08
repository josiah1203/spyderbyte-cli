import { createHash, randomBytes } from 'node:crypto';
import {
  isId,
  isJsonValue,
  newSortableId,
  redactJsonValue,
  runtimeError,
  sha256Hash,
  type Actor,
  type HashSha256,
  type Id,
  type JsonValue,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';

export const ENTERPRISE_CONTRACT_VERSION = 1 as const;

export type EnterpriseDeploymentMode =
  | 'hosted'
  | 'private_kubernetes'
  | 'customer_cloud'
  | 'on_premise';

export type EnterpriseComplianceProfile =
  | 'commercial'
  | 'fedramp_moderate'
  | 'fedramp_high'
  | 'government';

export type EnterpriseDataClass = 'public' | 'internal' | 'confidential' | 'restricted';

export type EnterpriseKeyProvider =
  | 'aws_kms'
  | 'azure_key_vault'
  | 'gcp_kms'
  | 'government_hsm'
  | 'customer';

export interface CustomerManagedKeyRefV1 {
  readonly schemaVersion: 1;
  readonly keyId: string;
  readonly provider: EnterpriseKeyProvider;
  readonly keyUri: string;
  readonly region: string;
  readonly rotationVersion: string;
}

export interface EnterpriseResidencyPolicyV1 {
  readonly schemaVersion: 1;
  readonly homeRegion: string;
  readonly allowedRegions: readonly string[];
  readonly blockedRegions: readonly string[];
  readonly noCrossRegionReplication: boolean;
  readonly allowedDataClasses: readonly EnterpriseDataClass[];
  readonly requireCustomerManagedKey: boolean;
  readonly retentionDays: number;
  readonly policyVersion: string;
}

export interface EnterpriseProfileV1 {
  readonly schemaVersion: 1;
  readonly profileId: Id;
  readonly tenant: TenantRef;
  readonly name: string;
  readonly deploymentMode: EnterpriseDeploymentMode;
  readonly allowedDeploymentModes: readonly EnterpriseDeploymentMode[];
  readonly complianceProfile: EnterpriseComplianceProfile;
  readonly residency: EnterpriseResidencyPolicyV1;
  readonly customerManagedKey?: CustomerManagedKeyRefV1;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type EnterpriseRole =
  | 'enterprise_owner'
  | 'security_admin'
  | 'platform_admin'
  | 'operator'
  | 'auditor'
  | 'support'
  | 'viewer';

export type EnterprisePrincipalType = 'human' | 'service_account';

export interface EnterpriseServiceAccountV1 {
  readonly schemaVersion: 1;
  readonly accountId: Id;
  readonly tenant: TenantRef;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly roles: readonly EnterpriseRole[];
  readonly active: boolean;
  readonly createdBy: Actor;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt?: string;
  readonly revokedAt?: string;
}

export interface EnterpriseServiceAccountCredentialV1 {
  readonly serviceAccount: EnterpriseServiceAccountV1;
  /** The bearer credential is returned once; only its digest is retained. */
  readonly accessToken: string;
}

export interface EnterpriseRoleScopeV1 {
  readonly workspaceId?: Id;
  readonly projectId?: Id;
  readonly region?: string;
}

export interface EnterpriseAttributeConditionsV1 {
  readonly groups?: readonly string[];
  readonly environments?: readonly string[];
  readonly regions?: readonly string[];
  readonly dataClasses?: readonly EnterpriseDataClass[];
}

export interface EnterpriseRoleBindingV1 {
  readonly schemaVersion: 1;
  readonly bindingId: Id;
  readonly tenant: TenantRef;
  readonly principalId: Id;
  readonly principalType: EnterprisePrincipalType;
  readonly role: EnterpriseRole;
  readonly scope: EnterpriseRoleScopeV1;
  readonly conditions?: EnterpriseAttributeConditionsV1;
  readonly createdBy: Actor;
  readonly createdAt: string;
}

export interface EnterprisePrincipalV1 {
  readonly principalId: Id;
  readonly principalType: EnterprisePrincipalType;
  readonly groups?: readonly string[];
}

export interface EnterpriseAuthorizationContextV1 {
  readonly region: string;
  readonly dataClassification: EnterpriseDataClass;
  readonly environment: string;
  readonly workspaceId?: Id;
  readonly projectId?: Id;
  readonly network?: 'private' | 'public';
}

export interface EnterpriseAccessRequestV1 {
  readonly tenant: TenantRef;
  readonly principal: EnterprisePrincipalV1;
  readonly action: string;
  readonly resourceKind: string;
  readonly resourceId: string;
  readonly context: EnterpriseAuthorizationContextV1;
}

export interface EnterpriseAccessDecisionV1 {
  readonly schemaVersion: 1;
  readonly decisionId: Id;
  readonly tenant: TenantRef;
  readonly principal: EnterprisePrincipalV1;
  readonly action: string;
  readonly outcome: 'allowed' | 'denied';
  readonly obligations: readonly string[];
  readonly reasonCodes: readonly string[];
  readonly inputDigest: HashSha256;
  readonly decidedAt: string;
}

export type EnterpriseRunnerKind =
  | 'private_kubernetes'
  | 'on_premise'
  | 'customer_cloud'
  | 'hosted_kubernetes'
  | 'slurm';

export interface EnterpriseRunnerV1 {
  readonly schemaVersion: 1;
  readonly runnerId: Id;
  readonly tenant: TenantRef;
  readonly kind: EnterpriseRunnerKind;
  readonly region: string;
  readonly adapterSetId: Id;
  readonly capabilities: readonly string[];
  readonly customerOwned: boolean;
  readonly privateNetwork: boolean;
  readonly enabled: boolean;
  readonly approvalReference?: string;
  readonly createdAt: string;
}

export interface EnterpriseVaultHandleV1 {
  readonly handleId: Id;
  readonly tenant: TenantRef;
  readonly secretName: string;
  readonly operation: string;
  readonly expiresAt: string;
  readonly scopeDigest: string;
}

export interface EnterpriseVaultAdapter {
  readonly adapterId: string;
  issue(input: {
    readonly tenant: TenantRef;
    readonly secretName: string;
    readonly operation: string;
    readonly ttlMs: number;
  }): Promise<EnterpriseVaultHandleV1>;
  resolve(input: {
    readonly handleId: Id;
    readonly tenant: TenantRef;
    readonly operation: string;
  }): Promise<string>;
  revoke?(handleId: Id): Promise<void>;
}

export interface EnterpriseInferenceAdapter {
  readonly adapterId: string;
  complete(input: {
    readonly tenant: TenantRef;
    readonly runId: Id;
    readonly modelId: string;
    readonly prompt: string;
    readonly maxOutputTokens: number;
    readonly credential: string;
  }): Promise<{
    readonly text: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
  }>;
}

export interface EnterpriseComputeReceiptV1 {
  readonly receiptId: Id;
  readonly state: 'succeeded' | 'failed';
  readonly externalExecutionId: string;
  readonly region: string;
}

export interface EnterpriseComputeAdapter {
  readonly adapterId: string;
  execute(input: {
    readonly tenant: TenantRef;
    readonly runId: Id;
    readonly runner: EnterpriseRunnerV1;
    readonly region: string;
    readonly payload: JsonValue;
  }): Promise<EnterpriseComputeReceiptV1>;
}

export interface EnterpriseStorageReceiptV1 {
  readonly objectKey: string;
  readonly contentHash: HashSha256;
  readonly sizeBytes: number;
}

export interface EnterpriseStorageAdapter {
  readonly adapterId: string;
  put(input: {
    readonly tenant: TenantRef;
    readonly region: string;
    readonly objectKey: string;
    readonly content: Uint8Array;
  }): Promise<EnterpriseStorageReceiptV1>;
}

export interface EnterpriseKeyManagementAdapter {
  readonly adapterId: string;
  encrypt(input: {
    readonly tenant: TenantRef;
    readonly key: CustomerManagedKeyRefV1;
    readonly region: string;
    readonly plaintext: Uint8Array;
  }): Promise<{
    readonly ciphertext: Uint8Array;
    readonly keyId: string;
    readonly region: string;
    readonly encryptionContextDigest: HashSha256;
  }>;
}

export type EnterpriseAdapterOwnership = 'hosted' | 'customer_owned';

export interface EnterpriseAdapterSetV1 {
  readonly schemaVersion: 1;
  readonly adapterSetId: Id;
  readonly tenant: TenantRef;
  readonly deploymentMode: EnterpriseDeploymentMode;
  readonly ownership: EnterpriseAdapterOwnership;
  readonly regions: readonly string[];
  readonly approved: boolean;
  readonly approvalReference?: string;
  readonly adapters: {
    readonly inference: string;
    readonly compute: string;
    readonly storage: string;
    readonly vault: string;
    readonly keyManagement?: string;
  };
  readonly registeredAt: string;
}

export interface EnterpriseRunRequestV1 {
  readonly schemaVersion: 1;
  readonly runId: Id;
  readonly tenant: TenantRef;
  readonly actor: Actor;
  readonly requestedAction: string;
  readonly modelId: string;
  readonly prompt: string;
  readonly maxOutputTokens: number;
  readonly outputMediaType: string;
  readonly dataClassification: EnterpriseDataClass;
  readonly environment: string;
  readonly region: string;
  readonly adapterSetId: Id;
  readonly runnerId: Id;
  readonly idempotencyKey: string;
}

export interface EnterpriseArtifactReceiptV1 {
  readonly artifactId: Id;
  readonly objectKey: string;
  readonly contentHash: HashSha256;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly region: string;
}

export interface EnterpriseRunResultV1 {
  readonly schemaVersion: 1;
  readonly runId: Id;
  readonly tenant: TenantRef;
  readonly state: 'succeeded';
  readonly adapterSetId: Id;
  readonly runnerId: Id;
  readonly region: string;
  readonly output: {
    readonly text: string;
    readonly mediaType: string;
  };
  readonly compute: EnterpriseComputeReceiptV1;
  readonly artifact: EnterpriseArtifactReceiptV1;
  readonly vaultHandleId: Id;
  readonly completedAt: string;
}

export type EnterpriseDataBucket =
  | 'authoritative'
  | 'artifacts'
  | 'events'
  | 'outbox'
  | 'projections'
  | 'audit'
  | 'connector_handles'
  | 'backups';

export interface EnterpriseDataInventoryV1 {
  readonly schemaVersion: 1;
  readonly tenant: TenantRef;
  readonly observedAt: string;
  readonly retentionPolicyVersion: string;
  readonly counts: Readonly<Record<EnterpriseDataBucket, number>>;
  readonly totalBytes: number;
  readonly digest: HashSha256;
}

export interface EnterpriseDataLifecyclePort {
  inventory(tenant: TenantRef, now: string): Promise<EnterpriseDataInventoryV1>;
  deleteBatch(input: {
    readonly tenant: TenantRef;
    readonly deletionId: Id;
    readonly cursor: string;
    readonly limit: number;
    readonly inventoryDigest: HashSha256;
  }): Promise<{
    readonly tenant: TenantRef;
    readonly deletionId: Id;
    readonly cursor: string;
    readonly nextCursor?: string;
    readonly deleted: number;
    readonly remaining: number;
  }>;
}

export type EnterpriseDeletionState =
  | 'pending_approval'
  | 'blocked_legal_hold'
  | 'approved'
  | 'executing'
  | 'completed';

export interface EnterpriseDeletionPlanV1 {
  readonly schemaVersion: 1;
  readonly deletionId: Id;
  readonly tenant: TenantRef;
  readonly requestedBy: Actor;
  readonly reason: string;
  readonly policyVersion: string;
  readonly inventory: EnterpriseDataInventoryV1;
  readonly batchSize: number;
  readonly cursor: string;
  readonly deletedCount: number;
  readonly state: EnterpriseDeletionState;
  readonly requestedAt: string;
  readonly approvedBy?: Actor;
  readonly approvedAt?: string;
  readonly completedAt?: string;
  readonly tombstoneId?: Id;
}

export interface EnterpriseLegalHoldV1 {
  readonly schemaVersion: 1;
  readonly holdId: Id;
  readonly tenant: TenantRef;
  readonly matterReference: string;
  readonly reason: string;
  readonly categories: readonly EnterpriseDataBucket[];
  readonly active: boolean;
  readonly createdBy: Actor;
  readonly createdAt: string;
  readonly releasedAt?: string;
}

export interface EnterpriseDeletionTombstoneV1 {
  readonly schemaVersion: 1;
  readonly tombstoneId: Id;
  readonly deletionId: Id;
  readonly tenant: TenantRef;
  readonly inventoryDigest: HashSha256;
  readonly policyVersion: string;
  readonly deletedCount: number;
  readonly completedAt: string;
  readonly evidenceDigest: HashSha256;
}

export type EnterpriseExportCategory = EnterpriseDataBucket | 'identity' | 'governance';

export interface EnterpriseExportPackageV1 {
  readonly schemaVersion: 1;
  readonly exportId: Id;
  readonly tenant: TenantRef;
  readonly generatedAt: string;
  readonly redacted: true;
  readonly categories: readonly EnterpriseExportCategory[];
  readonly categoryDigests: Readonly<Record<string, HashSha256>>;
  readonly contentDigest: HashSha256;
  readonly payload: Readonly<Record<EnterpriseExportCategory, JsonValue>>;
}

export interface EnterpriseSupportBundleV1 {
  readonly schemaVersion: 1;
  readonly bundleId: Id;
  readonly tenant: TenantRef;
  readonly exportId: Id;
  readonly generatedAt: string;
  readonly redacted: true;
  readonly contentDigest: HashSha256;
  readonly payload: JsonValue;
}

export interface GovernmentCommitmentsV1 {
  readonly schemaVersion: 1;
  readonly commitmentId: Id;
  readonly tenant: TenantRef;
  readonly profileId: Id;
  readonly serviceHours: '24x7' | 'business_hours';
  readonly supportResponseMinutes: number;
  readonly incidentNoticeHours: number;
  readonly recoveryPointObjectiveMinutes: number;
  readonly recoveryTimeObjectiveMinutes: number;
  readonly dataResidencyStatement: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProcurementEvidenceV1 {
  readonly schemaVersion: 1;
  readonly evidenceId: Id;
  readonly tenant: TenantRef;
  readonly profileId: Id;
  readonly generatedAt: string;
  readonly controls: readonly {
    readonly controlId: string;
    readonly status: 'available' | 'configured' | 'customer_action_required';
    readonly evidence: string;
  }[];
  readonly evidenceDigest: HashSha256;
}

export interface EnterpriseAuditRecordV1 {
  readonly schemaVersion: 1;
  readonly auditId: Id;
  readonly tenant: TenantRef;
  readonly action: string;
  readonly actorId: Id;
  readonly targetId?: Id;
  readonly outcome: 'allowed' | 'denied' | 'completed' | 'blocked';
  readonly details: JsonValue;
  readonly occurredAt: string;
}

export interface EnterpriseControlPlaneOptions {
  readonly clock?: () => string;
  readonly lifecycle?: EnterpriseDataLifecyclePort;
}

interface StoredServiceAccount {
  readonly account: EnterpriseServiceAccountV1;
  readonly tokenDigest: HashSha256;
}

interface RegisteredAdapterSet {
  readonly record: EnterpriseAdapterSetV1;
  readonly inference: EnterpriseInferenceAdapter;
  readonly compute: EnterpriseComputeAdapter;
  readonly storage: EnterpriseStorageAdapter;
  readonly vault: EnterpriseVaultAdapter;
  readonly keyManagement?: EnterpriseKeyManagementAdapter;
}

interface StoredRun {
  readonly requestDigest: HashSha256;
  readonly result: EnterpriseRunResultV1;
}

const dataClasses: readonly EnterpriseDataClass[] = [
  'public',
  'internal',
  'confidential',
  'restricted',
];

const roles: readonly EnterpriseRole[] = [
  'enterprise_owner',
  'security_admin',
  'platform_admin',
  'operator',
  'auditor',
  'support',
  'viewer',
];

const buckets: readonly EnterpriseDataBucket[] = [
  'authoritative',
  'artifacts',
  'events',
  'outbox',
  'projections',
  'audit',
  'connector_handles',
  'backups',
];

const rolePermissions: Readonly<Record<EnterpriseRole, readonly string[]>> = {
  enterprise_owner: ['*'],
  security_admin: [
    'profile.read',
    'profile.write',
    'identity.*',
    'service_account.*',
    'policy.*',
    'residency.*',
    'key.*',
    'vault.*',
    'audit.read',
    'data.export',
    'data.delete.*',
    'legal_hold.*',
    'support.bundle',
    'procurement.*',
  ],
  platform_admin: [
    'profile.read',
    'runner.*',
    'adapter.*',
    'run.*',
    'data.export',
    'data.delete.request',
    'support.bundle',
    'audit.read',
    'residency.read',
  ],
  operator: ['profile.read', 'run.execute', 'run.read', 'runner.read', 'adapter.read'],
  auditor: [
    'profile.read',
    'audit.read',
    'data.export',
    'procurement.read',
    'support.bundle',
    'residency.read',
  ],
  support: ['profile.read', 'audit.read', 'data.export', 'support.bundle', 'residency.read'],
  viewer: ['profile.read', 'run.read', 'runner.read', 'adapter.read', 'residency.read'],
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function tenantKey(tenant: TenantRef): string {
  return `${tenant.tenantId}:${tenant.workspaceId}`;
}

function sameTenant(left: TenantRef, right: TenantRef): boolean {
  return left.tenantId === right.tenantId && left.workspaceId === right.workspaceId;
}

function assertText(value: string, label: string, max = 320): string {
  if (value.trim().length === 0 || value.length > max) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} is required`);
  }
  return value.trim();
}

function assertTenant(tenant: TenantRef): void {
  if (!isId(tenant.tenantId) || !isId(tenant.workspaceId)) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Enterprise tenant is invalid');
  }
}

function assertHuman(actor: Actor, label: string): void {
  if (actor.type !== 'human' || !isId(actor.actorId)) {
    throw runtimeError('POLICY_DENIED', `${label} must be a human actor`);
  }
}

function digest(value: unknown): HashSha256 {
  return sha256Hash(createHash('sha256').update(JSON.stringify(value)).digest('hex'));
}

function digestBytes(value: Uint8Array): HashSha256 {
  return sha256Hash(createHash('sha256').update(value).digest('hex'));
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} must be positive`);
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} must be non-negative`);
  }
}

function validActionPattern(pattern: string): boolean {
  return /^[a-z][a-z0-9_.]*(?:\*)?$/.test(pattern);
}

function actionMatches(pattern: string, action: string): boolean {
  return (
    pattern === '*' ||
    pattern === action ||
    (pattern.endsWith('*') && action.startsWith(pattern.slice(0, -1)))
  );
}

function roleAllows(role: EnterpriseRole, action: string): boolean {
  return rolePermissions[role].some((pattern) => actionMatches(pattern, action));
}

function runnerDeploymentMode(kind: EnterpriseRunnerKind): EnterpriseDeploymentMode {
  if (kind === 'private_kubernetes') return 'private_kubernetes';
  if (kind === 'customer_cloud') return 'customer_cloud';
  if (kind === 'on_premise' || kind === 'slurm') return 'on_premise';
  return 'hosted';
}

function scopeMatches(
  scope: EnterpriseRoleScopeV1,
  context: EnterpriseAuthorizationContextV1,
): boolean {
  return (
    (scope.workspaceId === undefined || scope.workspaceId === context.workspaceId) &&
    (scope.projectId === undefined || scope.projectId === context.projectId) &&
    (scope.region === undefined || scope.region === context.region)
  );
}

function conditionsMatch(
  conditions: EnterpriseAttributeConditionsV1 | undefined,
  principal: EnterprisePrincipalV1,
  context: EnterpriseAuthorizationContextV1,
): boolean {
  if (conditions === undefined) return true;
  const groups = principal.groups ?? [];
  return (
    (conditions.groups === undefined ||
      conditions.groups.some((group) => groups.includes(group))) &&
    (conditions.environments === undefined ||
      conditions.environments.includes(context.environment)) &&
    (conditions.regions === undefined || conditions.regions.includes(context.region)) &&
    (conditions.dataClasses === undefined ||
      conditions.dataClasses.includes(context.dataClassification))
  );
}

function emptyCounts(): Record<EnterpriseDataBucket, number> {
  return {
    authoritative: 0,
    artifacts: 0,
    events: 0,
    outbox: 0,
    projections: 0,
    audit: 0,
    connector_handles: 0,
    backups: 0,
  };
}

function validateInventory(inventory: EnterpriseDataInventoryV1, tenant: TenantRef): void {
  if (!sameTenant(inventory.tenant, tenant)) {
    throw runtimeError('POLICY_DENIED', 'Enterprise inventory crosses the tenant boundary');
  }
  assertText(inventory.retentionPolicyVersion, 'Retention policy version');
  assertNonNegativeInteger(inventory.totalBytes, 'Inventory totalBytes');
  if (!validateHash(inventory.digest)) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Inventory digest must be SHA-256');
  }
  for (const bucket of buckets)
    assertNonNegativeInteger(inventory.counts[bucket], `Inventory ${bucket}`);
}

function validateHash(value: string): value is HashSha256 {
  return /^[a-f0-9]{64}$/.test(value);
}

function publicProfileKey(tenant: TenantRef): string {
  return tenantKey(tenant);
}

function principalForActor(actor: Actor): EnterprisePrincipalV1 {
  return { principalId: actor.actorId, principalType: 'human' };
}

function publicServiceAccount(account: EnterpriseServiceAccountV1): EnterpriseServiceAccountV1 {
  return clone(account);
}

export class InMemoryEnterpriseControlPlane {
  private readonly profiles = new Map<string, EnterpriseProfileV1>();
  private readonly serviceAccounts = new Map<string, StoredServiceAccount>();
  private readonly tokenDigests = new Map<HashSha256, string>();
  private readonly bindings = new Map<string, EnterpriseRoleBindingV1>();
  private readonly runners = new Map<string, EnterpriseRunnerV1>();
  private readonly adapterSets = new Map<string, RegisteredAdapterSet>();
  private readonly runs = new Map<string, StoredRun>();
  private readonly legalHolds = new Map<string, EnterpriseLegalHoldV1>();
  private readonly deletionPlans = new Map<string, EnterpriseDeletionPlanV1>();
  private readonly tombstones = new Map<string, EnterpriseDeletionTombstoneV1>();
  private readonly exports = new Map<string, EnterpriseExportPackageV1>();
  private readonly supportBundles = new Map<string, EnterpriseSupportBundleV1>();
  private readonly commitments = new Map<string, GovernmentCommitmentsV1>();
  private readonly audits: EnterpriseAuditRecordV1[] = [];
  private readonly clock: () => string;
  private readonly lifecycle: EnterpriseDataLifecyclePort | undefined;

  constructor(options: EnterpriseControlPlaneOptions = {}) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.lifecycle = options.lifecycle;
  }

  registerProfile(input: {
    readonly tenant: TenantRef;
    readonly name: string;
    readonly deploymentMode: EnterpriseDeploymentMode;
    readonly allowedDeploymentModes?: readonly EnterpriseDeploymentMode[];
    readonly complianceProfile: EnterpriseComplianceProfile;
    readonly residency: Omit<EnterpriseResidencyPolicyV1, 'schemaVersion'>;
    readonly customerManagedKey?: Omit<CustomerManagedKeyRefV1, 'schemaVersion'>;
    readonly createdBy: Actor;
    readonly profileId?: Id;
    readonly now?: string;
  }): EnterpriseProfileV1 {
    assertTenant(input.tenant);
    assertHuman(input.createdBy, 'Enterprise profile owner');
    const key = publicProfileKey(input.tenant);
    if (this.profiles.has(key)) {
      this.assertAllowed(
        input.tenant,
        principalForActor(input.createdBy),
        'profile.write',
        {
          region: input.residency.homeRegion,
          dataClassification: 'internal',
          environment: 'control_plane',
        },
        'profile',
        key,
      );
      throw runtimeError('CONCURRENCY_STALE_VERSION', 'Enterprise profile already exists');
    }
    const now = input.now ?? this.clock();
    const profile = this.normalizeProfile(input, now);
    this.profiles.set(key, profile);
    this.bindings.set(`${key}:human:${input.createdBy.actorId}:owner`, {
      schemaVersion: ENTERPRISE_CONTRACT_VERSION,
      bindingId: newSortableId(),
      tenant: clone(input.tenant),
      principalId: input.createdBy.actorId,
      principalType: 'human',
      role: 'enterprise_owner',
      scope: {},
      createdBy: clone(input.createdBy),
      createdAt: now,
    });
    this.record(
      input.tenant,
      'profile.registered',
      input.createdBy.actorId,
      profile.profileId,
      'completed',
      {
        complianceProfile: profile.complianceProfile,
        deploymentMode: profile.deploymentMode,
        homeRegion: profile.residency.homeRegion,
      },
      now,
    );
    return clone(profile);
  }

  getProfile(tenant: TenantRef): EnterpriseProfileV1 | undefined {
    const profile = this.profiles.get(publicProfileKey(tenant));
    return profile === undefined ? undefined : clone(profile);
  }

  issueServiceAccount(input: {
    readonly tenant: TenantRef;
    readonly name: string;
    readonly scopes: readonly string[];
    readonly roles: readonly EnterpriseRole[];
    readonly createdBy: Actor;
    readonly expiresAt?: string;
    readonly now?: string;
  }): EnterpriseServiceAccountCredentialV1 {
    const now = input.now ?? this.clock();
    this.requireProfile(input.tenant);
    this.assertAllowed(
      input.tenant,
      principalForActor(input.createdBy),
      'service_account.issue',
      {
        region: this.requireProfile(input.tenant).residency.homeRegion,
        dataClassification: 'internal',
        environment: 'control_plane',
      },
      'service_account',
      input.name,
    );
    const name = assertText(input.name, 'Service account name');
    const scopes = input.scopes.map((scope) => {
      const normalized = assertText(scope, 'Service account scope', 160);
      if (!validActionPattern(normalized)) {
        throw runtimeError(
          'VALIDATION_INVALID_INPUT',
          `Invalid service account scope ${normalized}`,
        );
      }
      return normalized;
    });
    const serviceRoles = input.roles.map((role) => {
      if (!roles.includes(role))
        throw runtimeError('VALIDATION_INVALID_INPUT', `Invalid enterprise role ${role}`);
      return role;
    });
    if (scopes.length === 0 || serviceRoles.length === 0) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Service accounts require scopes and roles');
    }
    if (input.expiresAt !== undefined && Date.parse(input.expiresAt) <= Date.parse(now)) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'Service account expiry must be in the future',
      );
    }
    const account: EnterpriseServiceAccountV1 = {
      schemaVersion: ENTERPRISE_CONTRACT_VERSION,
      accountId: newSortableId(),
      tenant: clone(input.tenant),
      name,
      scopes,
      roles: serviceRoles,
      active: true,
      createdBy: clone(input.createdBy),
      createdAt: now,
      updatedAt: now,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    };
    const token = randomBytes(32).toString('base64url');
    const tokenDigest = sha256Hash(createHash('sha256').update(token).digest('hex'));
    this.serviceAccounts.set(`${tenantKey(input.tenant)}:${account.accountId}`, {
      account,
      tokenDigest,
    });
    this.tokenDigests.set(tokenDigest, `${tenantKey(input.tenant)}:${account.accountId}`);
    this.record(
      input.tenant,
      'service_account.issued',
      input.createdBy.actorId,
      account.accountId,
      'completed',
      {
        scopes,
        roles: serviceRoles,
      },
      now,
    );
    return { serviceAccount: publicServiceAccount(account), accessToken: token };
  }

  rotateServiceAccount(input: {
    readonly tenant: TenantRef;
    readonly accountId: Id;
    readonly rotatedBy: Actor;
    readonly now?: string;
  }): EnterpriseServiceAccountCredentialV1 {
    const stored = this.requireServiceAccount(input.tenant, input.accountId);
    this.assertAllowed(
      input.tenant,
      principalForActor(input.rotatedBy),
      'service_account.rotate',
      {
        region: this.requireProfile(input.tenant).residency.homeRegion,
        dataClassification: 'internal',
        environment: 'control_plane',
      },
      'service_account',
      input.accountId,
    );
    if (!stored.account.active)
      throw runtimeError('AUTHORITY_EXPIRED', 'Service account is inactive');
    const now = input.now ?? this.clock();
    const token = randomBytes(32).toString('base64url');
    const tokenDigest = sha256Hash(createHash('sha256').update(token).digest('hex'));
    this.tokenDigests.delete(stored.tokenDigest);
    const account = { ...stored.account, updatedAt: now };
    this.serviceAccounts.set(`${tenantKey(input.tenant)}:${account.accountId}`, {
      account,
      tokenDigest,
    });
    this.tokenDigests.set(tokenDigest, `${tenantKey(input.tenant)}:${account.accountId}`);
    this.record(
      input.tenant,
      'service_account.rotated',
      input.rotatedBy.actorId,
      account.accountId,
      'completed',
      {},
      now,
    );
    return { serviceAccount: publicServiceAccount(account), accessToken: token };
  }

  revokeServiceAccount(input: {
    readonly tenant: TenantRef;
    readonly accountId: Id;
    readonly revokedBy: Actor;
    readonly now?: string;
  }): EnterpriseServiceAccountV1 {
    const stored = this.requireServiceAccount(input.tenant, input.accountId);
    this.assertAllowed(
      input.tenant,
      principalForActor(input.revokedBy),
      'service_account.revoke',
      {
        region: this.requireProfile(input.tenant).residency.homeRegion,
        dataClassification: 'internal',
        environment: 'control_plane',
      },
      'service_account',
      input.accountId,
    );
    const now = input.now ?? this.clock();
    const account: EnterpriseServiceAccountV1 = {
      ...stored.account,
      active: false,
      updatedAt: now,
      revokedAt: now,
    };
    this.serviceAccounts.set(`${tenantKey(input.tenant)}:${account.accountId}`, {
      account,
      tokenDigest: stored.tokenDigest,
    });
    this.tokenDigests.delete(stored.tokenDigest);
    this.record(
      input.tenant,
      'service_account.revoked',
      input.revokedBy.actorId,
      account.accountId,
      'completed',
      {},
      now,
    );
    return publicServiceAccount(account);
  }

  authenticateServiceAccount(
    token: string,
    tenant: TenantRef,
    now = this.clock(),
  ): EnterpriseServiceAccountV1 {
    const tokenDigest = sha256Hash(createHash('sha256').update(token).digest('hex'));
    const accountKey = this.tokenDigests.get(tokenDigest);
    const stored = accountKey === undefined ? undefined : this.serviceAccounts.get(accountKey);
    if (
      stored === undefined ||
      !sameTenant(stored.account.tenant, tenant) ||
      !stored.account.active
    ) {
      throw runtimeError('AUTHORITY_MISSING', 'Enterprise service account credential is invalid');
    }
    if (
      stored.account.expiresAt !== undefined &&
      Date.parse(stored.account.expiresAt) <= Date.parse(now)
    ) {
      throw runtimeError('AUTHORITY_EXPIRED', 'Enterprise service account credential expired');
    }
    return publicServiceAccount(stored.account);
  }

  listServiceAccounts(tenant: TenantRef): readonly EnterpriseServiceAccountV1[] {
    return clone(
      [...this.serviceAccounts.values()]
        .filter((stored) => sameTenant(stored.account.tenant, tenant))
        .map((stored) => stored.account),
    );
  }

  bindRole(input: {
    readonly tenant: TenantRef;
    readonly principalId: Id;
    readonly principalType: EnterprisePrincipalType;
    readonly role: EnterpriseRole;
    readonly scope?: EnterpriseRoleScopeV1;
    readonly conditions?: EnterpriseAttributeConditionsV1;
    readonly createdBy: Actor;
    readonly now?: string;
  }): EnterpriseRoleBindingV1 {
    const profile = this.requireProfile(input.tenant);
    this.assertAllowed(
      input.tenant,
      principalForActor(input.createdBy),
      'policy.binding.write',
      {
        region: profile.residency.homeRegion,
        dataClassification: 'internal',
        environment: 'control_plane',
      },
      'policy',
      input.principalId,
    );
    if (!roles.includes(input.role))
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Unknown enterprise role');
    if (input.principalType === 'service_account')
      this.requireServiceAccount(input.tenant, input.principalId);
    const now = input.now ?? this.clock();
    const binding: EnterpriseRoleBindingV1 = {
      schemaVersion: ENTERPRISE_CONTRACT_VERSION,
      bindingId: newSortableId(),
      tenant: clone(input.tenant),
      principalId: input.principalId,
      principalType: input.principalType,
      role: input.role,
      scope: clone(input.scope ?? {}),
      ...(input.conditions === undefined ? {} : { conditions: clone(input.conditions) }),
      createdBy: clone(input.createdBy),
      createdAt: now,
    };
    this.bindings.set(
      `${tenantKey(input.tenant)}:${input.principalType}:${input.principalId}:${binding.bindingId}`,
      binding,
    );
    this.record(
      input.tenant,
      'policy.binding.created',
      input.createdBy.actorId,
      binding.bindingId,
      'completed',
      {
        principalId: input.principalId,
        principalType: input.principalType,
        role: input.role,
      },
      now,
    );
    return clone(binding);
  }

  listRoleBindings(tenant: TenantRef): readonly EnterpriseRoleBindingV1[] {
    return clone(
      [...this.bindings.values()].filter((binding) => sameTenant(binding.tenant, tenant)),
    );
  }

  authorize(input: EnterpriseAccessRequestV1, now = this.clock()): EnterpriseAccessDecisionV1 {
    const profile = this.profiles.get(publicProfileKey(input.tenant));
    const reasons: string[] = [];
    if (profile === undefined) reasons.push('profile_missing');
    if (input.action.trim().length === 0) reasons.push('action_missing');
    if (!isId(input.principal.principalId)) reasons.push('principal_invalid');
    if (profile !== undefined) {
      if (!profile.residency.allowedRegions.includes(input.context.region))
        reasons.push('region_not_allowed');
      if (profile.residency.blockedRegions.includes(input.context.region))
        reasons.push('region_blocked');
      if (!profile.residency.allowedDataClasses.includes(input.context.dataClassification)) {
        reasons.push('data_classification_not_allowed');
      }
    }
    let candidateRoles: EnterpriseRole[] = [];
    let scopedCandidate = false;
    let conditionCandidate = false;
    if (input.principal.principalType === 'service_account') {
      const stored = this.requireServiceAccountForDecision(
        input.tenant,
        input.principal.principalId,
      );
      if (stored === undefined) reasons.push('service_account_missing');
      else {
        if (!stored.account.active) reasons.push('service_account_inactive');
        if (
          stored.account.expiresAt !== undefined &&
          Date.parse(stored.account.expiresAt) <= Date.parse(now)
        ) {
          reasons.push('service_account_expired');
        }
        if (!stored.account.scopes.some((scope) => actionMatches(scope, input.action))) {
          reasons.push('service_account_scope_missing');
        }
        candidateRoles = [...stored.account.roles];
      }
    }
    const matchingBindings = [...this.bindings.values()].filter(
      (binding) =>
        sameTenant(binding.tenant, input.tenant) &&
        binding.principalId === input.principal.principalId &&
        binding.principalType === input.principal.principalType,
    );
    for (const binding of matchingBindings) {
      if (!scopeMatches(binding.scope, input.context)) continue;
      scopedCandidate = true;
      if (!conditionsMatch(binding.conditions, input.principal, input.context)) continue;
      conditionCandidate = true;
      candidateRoles.push(binding.role);
    }
    if (matchingBindings.length === 0 && candidateRoles.length === 0) reasons.push('role_missing');
    else if (!scopedCandidate && matchingBindings.length > 0) reasons.push('scope_mismatch');
    else if (
      !conditionCandidate &&
      matchingBindings.length > 0 &&
      input.principal.principalType === 'human'
    ) {
      reasons.push('attribute_mismatch');
    }
    const allowedByRole = candidateRoles.some((role) => roleAllows(role, input.action));
    if (!allowedByRole && !reasons.includes('role_missing')) reasons.push('permission_missing');
    const outcome = reasons.length === 0 && allowedByRole ? 'allowed' : 'denied';
    const decision: EnterpriseAccessDecisionV1 = {
      schemaVersion: ENTERPRISE_CONTRACT_VERSION,
      decisionId: newSortableId(),
      tenant: clone(input.tenant),
      principal: clone(input.principal),
      action: input.action,
      outcome,
      obligations:
        outcome === 'allowed' ? ['audit.append', 'residency.enforce', 'cmk.enforce'] : [],
      reasonCodes: reasons,
      inputDigest: digest(input),
      decidedAt: now,
    };
    this.record(
      input.tenant,
      `policy.${input.action}`,
      input.principal.principalId,
      decision.decisionId,
      outcome === 'allowed' ? 'allowed' : 'denied',
      { reasonCodes: reasons, resourceKind: input.resourceKind },
      now,
    );
    return decision;
  }

  registerAdapterSet(input: {
    readonly tenant: TenantRef;
    readonly deploymentMode: EnterpriseDeploymentMode;
    readonly ownership: EnterpriseAdapterOwnership;
    readonly regions: readonly string[];
    readonly approved: boolean;
    readonly approvalReference?: string;
    readonly inference: EnterpriseInferenceAdapter;
    readonly compute: EnterpriseComputeAdapter;
    readonly storage: EnterpriseStorageAdapter;
    readonly vault: EnterpriseVaultAdapter;
    readonly keyManagement?: EnterpriseKeyManagementAdapter;
    readonly registeredBy: Actor;
    readonly now?: string;
  }): EnterpriseAdapterSetV1 {
    const profile = this.requireProfile(input.tenant);
    this.assertAllowed(
      input.tenant,
      principalForActor(input.registeredBy),
      'adapter.register',
      {
        region: profile.residency.homeRegion,
        dataClassification: 'internal',
        environment: 'control_plane',
      },
      'adapter',
      input.inference.adapterId,
    );
    if (!profile.allowedDeploymentModes.includes(input.deploymentMode)) {
      throw runtimeError(
        'POLICY_DENIED',
        'Adapter deployment mode is not allowed by the enterprise profile',
      );
    }
    if (
      input.regions.length === 0 ||
      input.regions.some((region) => !profile.residency.allowedRegions.includes(region))
    ) {
      throw runtimeError('POLICY_DENIED', 'Adapter regions violate the residency policy');
    }
    if (
      !input.approved ||
      (input.ownership === 'customer_owned' &&
        (input.approvalReference === undefined || input.approvalReference.trim() === ''))
    ) {
      throw runtimeError(
        'APPROVAL_REQUIRED',
        'Adapter set requires explicit infrastructure approval evidence',
      );
    }
    if (profile.complianceProfile === 'government' && input.ownership !== 'customer_owned') {
      throw runtimeError('POLICY_DENIED', 'Government profiles require customer-owned adapters');
    }
    if (profile.residency.requireCustomerManagedKey && input.keyManagement === undefined) {
      throw runtimeError(
        'CAPABILITY_UNAVAILABLE',
        'Customer-managed key adapter is required by the enterprise profile',
      );
    }
    const now = input.now ?? this.clock();
    const adapterSetId = newSortableId();
    const record: EnterpriseAdapterSetV1 = {
      schemaVersion: ENTERPRISE_CONTRACT_VERSION,
      adapterSetId,
      tenant: clone(input.tenant),
      deploymentMode: input.deploymentMode,
      ownership: input.ownership,
      regions: [...new Set(input.regions)],
      approved: input.approved,
      ...(input.approvalReference === undefined
        ? {}
        : { approvalReference: assertText(input.approvalReference, 'Approval reference') }),
      adapters: {
        inference: assertText(input.inference.adapterId, 'Inference adapter ID', 120),
        compute: assertText(input.compute.adapterId, 'Compute adapter ID', 120),
        storage: assertText(input.storage.adapterId, 'Storage adapter ID', 120),
        vault: assertText(input.vault.adapterId, 'Vault adapter ID', 120),
        ...(input.keyManagement === undefined
          ? {}
          : {
              keyManagement: assertText(
                input.keyManagement.adapterId,
                'Key management adapter ID',
                120,
              ),
            }),
      },
      registeredAt: now,
    };
    this.adapterSets.set(`${tenantKey(input.tenant)}:${adapterSetId}`, {
      record,
      inference: input.inference,
      compute: input.compute,
      storage: input.storage,
      vault: input.vault,
      ...(input.keyManagement === undefined ? {} : { keyManagement: input.keyManagement }),
    });
    this.record(
      input.tenant,
      'adapter.registered',
      input.registeredBy.actorId,
      adapterSetId,
      'completed',
      {
        deploymentMode: input.deploymentMode,
        ownership: input.ownership,
        regions: record.regions,
      },
      now,
    );
    return clone(record);
  }

  listAdapterSets(tenant: TenantRef): readonly EnterpriseAdapterSetV1[] {
    return clone(
      [...this.adapterSets.values()]
        .filter((entry) => sameTenant(entry.record.tenant, tenant))
        .map((entry) => entry.record),
    );
  }

  registerRunner(input: {
    readonly tenant: TenantRef;
    readonly kind: EnterpriseRunnerKind;
    readonly region: string;
    readonly adapterSetId: Id;
    readonly capabilities: readonly string[];
    readonly customerOwned: boolean;
    readonly privateNetwork: boolean;
    readonly enabled?: boolean;
    readonly approvalReference?: string;
    readonly registeredBy: Actor;
    readonly runnerId?: Id;
    readonly now?: string;
  }): EnterpriseRunnerV1 {
    const profile = this.requireProfile(input.tenant);
    this.assertAllowed(
      input.tenant,
      principalForActor(input.registeredBy),
      'runner.register',
      {
        region: input.region,
        dataClassification: 'internal',
        environment: 'control_plane',
      },
      'runner',
      input.adapterSetId,
    );
    const adapterSet = this.requireAdapterSet(input.tenant, input.adapterSetId);
    if (runnerDeploymentMode(input.kind) !== adapterSet.record.deploymentMode) {
      throw runtimeError('POLICY_DENIED', 'Runner kind and adapter deployment mode do not match');
    }
    if (
      !profile.residency.allowedRegions.includes(input.region) ||
      profile.residency.blockedRegions.includes(input.region)
    ) {
      throw runtimeError('POLICY_DENIED', 'Runner region violates the residency policy');
    }
    if (
      profile.complianceProfile === 'government' &&
      (!input.customerOwned || !input.privateNetwork)
    ) {
      throw runtimeError('POLICY_DENIED', 'Government runners must be customer-owned and private');
    }
    if (!input.approvalReference && input.customerOwned) {
      throw runtimeError('APPROVAL_REQUIRED', 'Customer-owned runner requires approval evidence');
    }
    if (input.capabilities.length === 0)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Runner capabilities are required');
    const now = input.now ?? this.clock();
    const runner: EnterpriseRunnerV1 = {
      schemaVersion: ENTERPRISE_CONTRACT_VERSION,
      runnerId: input.runnerId ?? newSortableId(),
      tenant: clone(input.tenant),
      kind: input.kind,
      region: assertText(input.region, 'Runner region', 120),
      adapterSetId: input.adapterSetId,
      capabilities: input.capabilities.map((capability) =>
        assertText(capability, 'Runner capability', 120),
      ),
      customerOwned: input.customerOwned,
      privateNetwork: input.privateNetwork,
      enabled: input.enabled ?? true,
      ...(input.approvalReference === undefined
        ? {}
        : { approvalReference: assertText(input.approvalReference, 'Runner approval reference') }),
      createdAt: now,
    };
    const key = `${tenantKey(input.tenant)}:${runner.runnerId}`;
    if (this.runners.has(key))
      throw runtimeError('CONCURRENCY_STALE_VERSION', 'Runner already exists');
    this.runners.set(key, runner);
    this.record(
      input.tenant,
      'runner.registered',
      input.registeredBy.actorId,
      runner.runnerId,
      'completed',
      {
        kind: runner.kind,
        region: runner.region,
        customerOwned: runner.customerOwned,
      },
      now,
    );
    return clone(runner);
  }

  listRunners(tenant: TenantRef): readonly EnterpriseRunnerV1[] {
    return clone([...this.runners.values()].filter((runner) => sameTenant(runner.tenant, tenant)));
  }

  async run(input: EnterpriseRunRequestV1): Promise<EnterpriseRunResultV1> {
    if (input.schemaVersion !== ENTERPRISE_CONTRACT_VERSION || !isId(input.runId)) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Enterprise run contract is invalid');
    }
    assertTenant(input.tenant);
    assertHuman(input.actor, 'Enterprise run actor');
    assertText(input.requestedAction, 'Run action');
    assertText(input.modelId, 'Run model');
    if (input.prompt.length === 0)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Run prompt is required');
    assertPositiveInteger(input.maxOutputTokens, 'Run maxOutputTokens');
    assertText(input.outputMediaType, 'Run output media type');
    assertText(input.idempotencyKey, 'Run idempotency key');
    const requestDigest = digest(input);
    const idempotencyKey = `${tenantKey(input.tenant)}:${input.idempotencyKey}`;
    const existing = this.runs.get(idempotencyKey);
    if (existing !== undefined) {
      if (existing.requestDigest !== requestDigest) {
        throw runtimeError(
          'VALIDATION_INVALID_INPUT',
          'Enterprise run idempotency key was reused differently',
        );
      }
      return clone(existing.result);
    }
    const profile = this.requireProfile(input.tenant);
    const adapterSet = this.requireAdapterSet(input.tenant, input.adapterSetId);
    const runner = this.requireRunner(input.tenant, input.runnerId);
    if (!runner.enabled)
      throw runtimeError('COMPUTE_RESOURCE_UNAVAILABLE', 'Enterprise runner is disabled');
    if (runner.adapterSetId !== input.adapterSetId || runner.region !== input.region) {
      throw runtimeError(
        'AUTHORITY_SCOPE_VIOLATION',
        'Run runner and adapter set are outside the requested scope',
      );
    }
    if (!adapterSet.record.regions.includes(input.region)) {
      throw runtimeError('POLICY_DENIED', 'Run region is not approved for the adapter set');
    }
    if (
      profile.residency.noCrossRegionReplication &&
      input.region !== profile.residency.homeRegion &&
      adapterSet.record.regions.length > 1
    ) {
      throw runtimeError(
        'POLICY_DENIED',
        'No-cross-region policy does not allow a multi-region adapter set',
      );
    }
    this.assertAllowed(
      input.tenant,
      principalForActor(input.actor),
      'run.execute',
      {
        region: input.region,
        dataClassification: input.dataClassification,
        environment: input.environment,
      },
      'run',
      input.runId,
    );
    let vaultHandle: EnterpriseVaultHandleV1 | undefined;
    try {
      vaultHandle = await adapterSet.vault.issue({
        tenant: input.tenant,
        secretName: 'enterprise-inference',
        operation: 'enterprise.run',
        ttlMs: 60_000,
      });
      this.assertVaultHandle(vaultHandle, input.tenant);
      const credential = await adapterSet.vault.resolve({
        handleId: vaultHandle.handleId,
        tenant: input.tenant,
        operation: 'enterprise.run',
      });
      const inference = await adapterSet.inference.complete({
        tenant: input.tenant,
        runId: input.runId,
        modelId: input.modelId,
        prompt: input.prompt,
        maxOutputTokens: input.maxOutputTokens,
        credential,
      });
      if (typeof inference.text !== 'string' || inference.text.length === 0) {
        throw runtimeError('HARNESS_OUTPUT_INVALID', 'Enterprise inference returned no output');
      }
      if (inference.text.includes(credential)) {
        throw runtimeError(
          'SECRET_EXPOSURE_BLOCKED',
          'Enterprise inference output contains a vault credential',
        );
      }
      const content = new TextEncoder().encode(inference.text);
      const contentHash = digestBytes(content);
      let storedContent = content;
      if (profile.customerManagedKey !== undefined) {
        if (adapterSet.keyManagement === undefined) {
          throw runtimeError(
            'CAPABILITY_UNAVAILABLE',
            'Customer-managed key adapter is not configured',
          );
        }
        const encrypted = await adapterSet.keyManagement.encrypt({
          tenant: input.tenant,
          key: profile.customerManagedKey,
          region: input.region,
          plaintext: content,
        });
        if (
          encrypted.keyId !== profile.customerManagedKey.keyId ||
          encrypted.region !== input.region ||
          encrypted.ciphertext.byteLength === 0 ||
          !validateHash(encrypted.encryptionContextDigest)
        ) {
          throw runtimeError(
            'VALIDATION_SCHEMA_MISMATCH',
            'Customer key adapter returned an invalid encryption receipt',
          );
        }
        storedContent = new Uint8Array(encrypted.ciphertext);
      }
      const storageHash = digestBytes(storedContent);
      const compute = await adapterSet.compute.execute({
        tenant: input.tenant,
        runId: input.runId,
        runner,
        region: input.region,
        payload: {
          modelId: input.modelId,
          requestedAction: input.requestedAction,
          promptDigest: digest(input.prompt),
          outputDigest: contentHash,
          inputTokens: inference.inputTokens,
          outputTokens: inference.outputTokens,
        },
      });
      if (compute.state !== 'succeeded')
        throw runtimeError('COMPUTE_RESOURCE_UNAVAILABLE', 'Enterprise compute adapter failed');
      const objectKey = `sha256/${storageHash}`;
      const stored = await adapterSet.storage.put({
        tenant: input.tenant,
        region: input.region,
        objectKey,
        content: storedContent,
      });
      if (
        stored.objectKey !== objectKey ||
        stored.contentHash !== storageHash ||
        stored.sizeBytes !== storedContent.byteLength
      ) {
        throw runtimeError(
          'VALIDATION_SCHEMA_MISMATCH',
          'Enterprise storage adapter returned an invalid receipt',
        );
      }
      const result: EnterpriseRunResultV1 = {
        schemaVersion: ENTERPRISE_CONTRACT_VERSION,
        runId: input.runId,
        tenant: clone(input.tenant),
        state: 'succeeded',
        adapterSetId: input.adapterSetId,
        runnerId: input.runnerId,
        region: input.region,
        output: { text: inference.text, mediaType: input.outputMediaType },
        compute,
        artifact: {
          artifactId: newSortableId(),
          objectKey: stored.objectKey,
          contentHash: stored.contentHash,
          mediaType: input.outputMediaType,
          sizeBytes: stored.sizeBytes,
          region: input.region,
        },
        vaultHandleId: vaultHandle.handleId,
        completedAt: this.clock(),
      };
      this.runs.set(idempotencyKey, { requestDigest, result });
      this.record(
        input.tenant,
        'run.completed',
        input.actor.actorId,
        input.runId,
        'completed',
        {
          adapterSetId: input.adapterSetId,
          runnerId: input.runnerId,
          region: input.region,
          contentHash,
        },
        result.completedAt,
      );
      return clone(result);
    } finally {
      if (vaultHandle !== undefined && adapterSet.vault.revoke !== undefined) {
        await adapterSet.vault.revoke(vaultHandle.handleId).catch(() => undefined);
      }
    }
  }

  async createLegalHold(input: {
    readonly tenant: TenantRef;
    readonly matterReference: string;
    readonly reason: string;
    readonly categories?: readonly EnterpriseDataBucket[];
    readonly createdBy: Actor;
    readonly now?: string;
  }): Promise<EnterpriseLegalHoldV1> {
    const profile = this.requireProfile(input.tenant);
    this.assertAllowed(
      input.tenant,
      principalForActor(input.createdBy),
      'legal_hold.create',
      {
        region: profile.residency.homeRegion,
        dataClassification: 'restricted',
        environment: 'control_plane',
      },
      'legal_hold',
      input.matterReference,
    );
    const now = input.now ?? this.clock();
    const hold: EnterpriseLegalHoldV1 = {
      schemaVersion: ENTERPRISE_CONTRACT_VERSION,
      holdId: newSortableId(),
      tenant: clone(input.tenant),
      matterReference: assertText(input.matterReference, 'Matter reference'),
      reason: assertText(input.reason, 'Legal hold reason'),
      categories: [...(input.categories ?? buckets)].map((category) => {
        if (!buckets.includes(category))
          throw runtimeError('VALIDATION_INVALID_INPUT', `Unknown legal hold category ${category}`);
        return category;
      }),
      active: true,
      createdBy: clone(input.createdBy),
      createdAt: now,
    };
    this.legalHolds.set(`${tenantKey(input.tenant)}:${hold.holdId}`, hold);
    this.record(
      input.tenant,
      'legal_hold.created',
      input.createdBy.actorId,
      hold.holdId,
      'completed',
      {
        matterReference: hold.matterReference,
        categories: hold.categories,
      },
      now,
    );
    return clone(hold);
  }

  releaseLegalHold(input: {
    readonly tenant: TenantRef;
    readonly holdId: Id;
    readonly releasedBy: Actor;
    readonly now?: string;
  }): EnterpriseLegalHoldV1 {
    const hold = this.requireLegalHold(input.tenant, input.holdId);
    const profile = this.requireProfile(input.tenant);
    this.assertAllowed(
      input.tenant,
      principalForActor(input.releasedBy),
      'legal_hold.release',
      {
        region: profile.residency.homeRegion,
        dataClassification: 'restricted',
        environment: 'control_plane',
      },
      'legal_hold',
      input.holdId,
    );
    const now = input.now ?? this.clock();
    const released = { ...hold, active: false, releasedAt: now };
    this.legalHolds.set(`${tenantKey(input.tenant)}:${hold.holdId}`, released);
    for (const [key, plan] of this.deletionPlans.entries()) {
      if (
        sameTenant(plan.tenant, input.tenant) &&
        plan.state === 'blocked_legal_hold' &&
        !this.hasActiveLegalHold(input.tenant)
      ) {
        this.deletionPlans.set(key, { ...plan, state: 'pending_approval' });
      }
    }
    this.record(
      input.tenant,
      'legal_hold.released',
      input.releasedBy.actorId,
      hold.holdId,
      'completed',
      {},
      now,
    );
    return clone(released);
  }

  listLegalHolds(tenant: TenantRef): readonly EnterpriseLegalHoldV1[] {
    return clone([...this.legalHolds.values()].filter((hold) => sameTenant(hold.tenant, tenant)));
  }

  evaluateRetention(input: {
    readonly tenant: TenantRef;
    readonly lastActivityAt: string;
    readonly now?: string;
  }): {
    readonly policyVersion: string;
    readonly retentionUntil: string;
    readonly decision: 'retain' | 'eligible' | 'blocked_legal_hold';
  } {
    const profile = this.requireProfile(input.tenant);
    const now = input.now ?? this.clock();
    const lastActivity = Date.parse(input.lastActivityAt);
    const nowMs = Date.parse(now);
    if (!Number.isFinite(lastActivity) || !Number.isFinite(nowMs))
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Retention timestamps are invalid');
    const retentionUntil = new Date(
      lastActivity + profile.residency.retentionDays * 86_400_000,
    ).toISOString();
    const decision = this.hasActiveLegalHold(input.tenant)
      ? 'blocked_legal_hold'
      : Date.parse(retentionUntil) <= nowMs
        ? 'eligible'
        : 'retain';
    return { policyVersion: profile.residency.policyVersion, retentionUntil, decision };
  }

  async requestDeletion(input: {
    readonly tenant: TenantRef;
    readonly reason: string;
    readonly batchSize: number;
    readonly requestedBy: Actor;
    readonly now?: string;
  }): Promise<EnterpriseDeletionPlanV1> {
    const profile = this.requireProfile(input.tenant);
    assertHuman(input.requestedBy, 'Deletion requester');
    this.assertAllowed(
      input.tenant,
      principalForActor(input.requestedBy),
      'data.delete.request',
      {
        region: profile.residency.homeRegion,
        dataClassification: 'restricted',
        environment: 'control_plane',
      },
      'tenant',
      input.tenant.workspaceId,
    );
    assertPositiveInteger(input.batchSize, 'Deletion batchSize');
    const now = input.now ?? this.clock();
    const inventory =
      this.lifecycle === undefined
        ? this.zeroInventory(input.tenant, now, profile.residency.policyVersion)
        : await this.lifecycle.inventory(input.tenant, now);
    validateInventory(inventory, input.tenant);
    const plan: EnterpriseDeletionPlanV1 = {
      schemaVersion: ENTERPRISE_CONTRACT_VERSION,
      deletionId: newSortableId(),
      tenant: clone(input.tenant),
      requestedBy: clone(input.requestedBy),
      reason: assertText(input.reason, 'Deletion reason'),
      policyVersion: profile.residency.policyVersion,
      inventory: clone(inventory),
      batchSize: input.batchSize,
      cursor: '',
      deletedCount: 0,
      state: this.hasActiveLegalHold(input.tenant) ? 'blocked_legal_hold' : 'pending_approval',
      requestedAt: now,
    };
    this.deletionPlans.set(`${tenantKey(input.tenant)}:${plan.deletionId}`, plan);
    this.record(
      input.tenant,
      'data.delete.requested',
      input.requestedBy.actorId,
      plan.deletionId,
      plan.state === 'blocked_legal_hold' ? 'blocked' : 'completed',
      { state: plan.state },
      now,
    );
    return clone(plan);
  }

  approveDeletion(input: {
    readonly tenant: TenantRef;
    readonly deletionId: Id;
    readonly approvedBy: Actor;
    readonly now?: string;
  }): EnterpriseDeletionPlanV1 {
    const plan = this.requireDeletionPlan(input.tenant, input.deletionId);
    const profile = this.requireProfile(input.tenant);
    assertHuman(input.approvedBy, 'Deletion approver');
    this.assertAllowed(
      input.tenant,
      principalForActor(input.approvedBy),
      'data.delete.approve',
      {
        region: profile.residency.homeRegion,
        dataClassification: 'restricted',
        environment: 'control_plane',
      },
      'tenant',
      input.tenant.workspaceId,
    );
    if (this.hasActiveLegalHold(input.tenant) || plan.state === 'blocked_legal_hold')
      throw runtimeError('POLICY_DENIED', 'Deletion is blocked by a legal hold');
    if (plan.state !== 'pending_approval')
      throw runtimeError('APPROVAL_INVALIDATED', `Deletion plan is ${plan.state}`);
    if (plan.requestedBy.actorId === input.approvedBy.actorId)
      throw runtimeError('POLICY_DENIED', 'Deletion requester cannot approve its own deletion');
    const now = input.now ?? this.clock();
    const approved = {
      ...plan,
      state: 'approved' as const,
      approvedBy: clone(input.approvedBy),
      approvedAt: now,
    };
    this.deletionPlans.set(`${tenantKey(input.tenant)}:${plan.deletionId}`, approved);
    this.record(
      input.tenant,
      'data.delete.approved',
      input.approvedBy.actorId,
      plan.deletionId,
      'allowed',
      {},
      now,
    );
    return clone(approved);
  }

  async executeDeletion(input: {
    readonly tenant: TenantRef;
    readonly deletionId: Id;
    readonly now?: string;
  }): Promise<EnterpriseDeletionPlanV1> {
    const plan = this.requireDeletionPlan(input.tenant, input.deletionId);
    if (this.hasActiveLegalHold(input.tenant))
      throw runtimeError('POLICY_DENIED', 'Deletion is blocked by a legal hold');
    if (plan.state !== 'approved' && plan.state !== 'executing')
      throw runtimeError('APPROVAL_INVALIDATED', `Deletion plan is ${plan.state}`);
    if (this.lifecycle === undefined)
      throw runtimeError(
        'CAPABILITY_UNAVAILABLE',
        'No durable tenant lifecycle adapter is configured',
      );
    const executing = plan.state === 'approved' ? { ...plan, state: 'executing' as const } : plan;
    this.deletionPlans.set(`${tenantKey(input.tenant)}:${plan.deletionId}`, executing);
    const batch = await this.lifecycle.deleteBatch({
      tenant: input.tenant,
      deletionId: executing.deletionId,
      cursor: executing.cursor,
      limit: executing.batchSize,
      inventoryDigest: executing.inventory.digest,
    });
    if (
      !sameTenant(batch.tenant, input.tenant) ||
      batch.deletionId !== executing.deletionId ||
      batch.cursor !== executing.cursor
    ) {
      throw runtimeError('POLICY_DENIED', 'Deletion adapter crossed its tenant or cursor boundary');
    }
    assertNonNegativeInteger(batch.deleted, 'Deletion batch deleted');
    assertNonNegativeInteger(batch.remaining, 'Deletion batch remaining');
    const deletedCount = executing.deletedCount + batch.deleted;
    const now = input.now ?? this.clock();
    if (batch.remaining > 0 && batch.nextCursor === undefined)
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Deletion batch requires a next cursor');
    if (batch.remaining > 0) {
      const next = { ...executing, cursor: batch.nextCursor ?? executing.cursor, deletedCount };
      this.deletionPlans.set(`${tenantKey(input.tenant)}:${plan.deletionId}`, next);
      return clone(next);
    }
    const tombstoneId = newSortableId();
    const tombstone: EnterpriseDeletionTombstoneV1 = {
      schemaVersion: ENTERPRISE_CONTRACT_VERSION,
      tombstoneId,
      deletionId: executing.deletionId,
      tenant: clone(input.tenant),
      inventoryDigest: executing.inventory.digest,
      policyVersion: executing.policyVersion,
      deletedCount,
      completedAt: now,
      evidenceDigest: digest({
        deletionId: executing.deletionId,
        tenant: input.tenant,
        inventoryDigest: executing.inventory.digest,
        deletedCount,
        completedAt: now,
      }),
    };
    const completed = {
      ...executing,
      state: 'completed' as const,
      cursor: batch.nextCursor ?? executing.cursor,
      deletedCount,
      completedAt: now,
      tombstoneId,
    };
    this.deletionPlans.set(`${tenantKey(input.tenant)}:${plan.deletionId}`, completed);
    this.tombstones.set(`${tenantKey(input.tenant)}:${tombstoneId}`, tombstone);
    this.record(
      input.tenant,
      'data.delete.completed',
      executing.approvedBy?.actorId ?? executing.requestedBy.actorId,
      plan.deletionId,
      'completed',
      { deletedCount, tombstoneId },
      now,
    );
    return clone(completed);
  }

  getDeletionPlan(tenant: TenantRef, deletionId: Id): EnterpriseDeletionPlanV1 | undefined {
    const plan = this.deletionPlans.get(`${tenantKey(tenant)}:${deletionId}`);
    return plan === undefined ? undefined : clone(plan);
  }

  getTombstone(tenant: TenantRef, tombstoneId: Id): EnterpriseDeletionTombstoneV1 | undefined {
    const tombstone = this.tombstones.get(`${tenantKey(tenant)}:${tombstoneId}`);
    return tombstone === undefined ? undefined : clone(tombstone);
  }

  async createExport(input: {
    readonly tenant: TenantRef;
    readonly requestedBy: Actor;
    readonly categories?: readonly EnterpriseExportCategory[];
    readonly records?: Partial<Record<EnterpriseExportCategory, JsonValue>>;
    readonly now?: string;
  }): Promise<EnterpriseExportPackageV1> {
    const profile = this.requireProfile(input.tenant);
    this.assertAllowed(
      input.tenant,
      principalForActor(input.requestedBy),
      'data.export',
      {
        region: profile.residency.homeRegion,
        dataClassification: 'restricted',
        environment: 'control_plane',
      },
      'tenant',
      input.tenant.workspaceId,
    );
    const now = input.now ?? this.clock();
    const selected = [...(input.categories ?? [...buckets, 'identity', 'governance'])];
    const payload = {} as Record<EnterpriseExportCategory, JsonValue>;
    const categoryDigests: Record<string, HashSha256> = {};
    for (const category of selected) {
      if (![...buckets, 'identity', 'governance'].includes(category))
        throw runtimeError('VALIDATION_INVALID_INPUT', `Unknown export category ${category}`);
      const raw = input.records?.[category] ?? [];
      if (!isJsonValue(raw))
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `Export category ${category} is not JSON`);
      const safe = redactJsonValue(raw);
      payload[category] = safe;
      categoryDigests[category] = digest(safe);
    }
    const exportPackage: EnterpriseExportPackageV1 = {
      schemaVersion: ENTERPRISE_CONTRACT_VERSION,
      exportId: newSortableId(),
      tenant: clone(input.tenant),
      generatedAt: now,
      redacted: true,
      categories: selected,
      categoryDigests,
      contentDigest: digest(payload),
      payload,
    };
    this.exports.set(`${tenantKey(input.tenant)}:${exportPackage.exportId}`, exportPackage);
    this.record(
      input.tenant,
      'data.export.created',
      input.requestedBy.actorId,
      exportPackage.exportId,
      'completed',
      {
        categories: selected,
        contentDigest: exportPackage.contentDigest,
      },
      now,
    );
    return clone(exportPackage);
  }

  async createSupportBundle(input: {
    readonly tenant: TenantRef;
    readonly requestedBy: Actor;
    readonly diagnostics: JsonValue;
    readonly now?: string;
  }): Promise<EnterpriseSupportBundleV1> {
    const profile = this.requireProfile(input.tenant);
    this.assertAllowed(
      input.tenant,
      principalForActor(input.requestedBy),
      'support.bundle',
      {
        region: profile.residency.homeRegion,
        dataClassification: 'restricted',
        environment: 'support',
      },
      'support',
      input.tenant.workspaceId,
    );
    const exportPackage = await this.createExport({
      tenant: input.tenant,
      requestedBy: input.requestedBy,
      categories: ['authoritative', 'events', 'audit', 'identity', 'governance'],
      records: { audit: this.auditRecords(input.tenant) as unknown as JsonValue },
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    const now = input.now ?? this.clock();
    const payload = redactJsonValue({
      diagnostics: input.diagnostics,
      export: exportPackage.payload,
      profile: {
        profileId: profile.profileId,
        complianceProfile: profile.complianceProfile,
        deploymentMode: profile.deploymentMode,
        region: profile.residency.homeRegion,
      },
    } as JsonValue);
    const bundle: EnterpriseSupportBundleV1 = {
      schemaVersion: ENTERPRISE_CONTRACT_VERSION,
      bundleId: newSortableId(),
      tenant: clone(input.tenant),
      exportId: exportPackage.exportId,
      generatedAt: now,
      redacted: true,
      contentDigest: digest(payload),
      payload,
    };
    this.supportBundles.set(`${tenantKey(input.tenant)}:${bundle.bundleId}`, bundle);
    this.record(
      input.tenant,
      'support.bundle.created',
      input.requestedBy.actorId,
      bundle.bundleId,
      'completed',
      {
        exportId: bundle.exportId,
        contentDigest: bundle.contentDigest,
      },
      now,
    );
    return clone(bundle);
  }

  setGovernmentCommitments(input: {
    readonly tenant: TenantRef;
    readonly serviceHours: GovernmentCommitmentsV1['serviceHours'];
    readonly supportResponseMinutes: number;
    readonly incidentNoticeHours: number;
    readonly recoveryPointObjectiveMinutes: number;
    readonly recoveryTimeObjectiveMinutes: number;
    readonly dataResidencyStatement: string;
    readonly changedBy: Actor;
    readonly now?: string;
  }): GovernmentCommitmentsV1 {
    const profile = this.requireProfile(input.tenant);
    if (
      profile.complianceProfile !== 'government' &&
      profile.complianceProfile !== 'fedramp_high'
    ) {
      throw runtimeError(
        'POLICY_DENIED',
        'Government commitments require a government compliance profile',
      );
    }
    this.assertAllowed(
      input.tenant,
      principalForActor(input.changedBy),
      'procurement.write',
      {
        region: profile.residency.homeRegion,
        dataClassification: 'restricted',
        environment: 'control_plane',
      },
      'procurement',
      profile.profileId,
    );
    for (const [label, value] of [
      ['supportResponseMinutes', input.supportResponseMinutes],
      ['incidentNoticeHours', input.incidentNoticeHours],
      ['recoveryPointObjectiveMinutes', input.recoveryPointObjectiveMinutes],
      ['recoveryTimeObjectiveMinutes', input.recoveryTimeObjectiveMinutes],
    ] as const)
      assertNonNegativeInteger(value, label);
    const now = input.now ?? this.clock();
    const existing = this.commitments.get(publicProfileKey(input.tenant));
    const commitment: GovernmentCommitmentsV1 = {
      schemaVersion: ENTERPRISE_CONTRACT_VERSION,
      commitmentId: existing?.commitmentId ?? newSortableId(),
      tenant: clone(input.tenant),
      profileId: profile.profileId,
      serviceHours: input.serviceHours,
      supportResponseMinutes: input.supportResponseMinutes,
      incidentNoticeHours: input.incidentNoticeHours,
      recoveryPointObjectiveMinutes: input.recoveryPointObjectiveMinutes,
      recoveryTimeObjectiveMinutes: input.recoveryTimeObjectiveMinutes,
      dataResidencyStatement: assertText(input.dataResidencyStatement, 'Data residency statement'),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.commitments.set(publicProfileKey(input.tenant), commitment);
    this.record(
      input.tenant,
      'procurement.commitments.updated',
      input.changedBy.actorId,
      commitment.commitmentId,
      'completed',
      {},
      now,
    );
    return clone(commitment);
  }

  getGovernmentCommitments(tenant: TenantRef): GovernmentCommitmentsV1 | undefined {
    const commitment = this.commitments.get(publicProfileKey(tenant));
    return commitment === undefined ? undefined : clone(commitment);
  }

  generateProcurementEvidence(input: {
    readonly tenant: TenantRef;
    readonly requestedBy: Actor;
    readonly now?: string;
  }): ProcurementEvidenceV1 {
    const profile = this.requireProfile(input.tenant);
    this.assertAllowed(
      input.tenant,
      principalForActor(input.requestedBy),
      'procurement.read',
      {
        region: profile.residency.homeRegion,
        dataClassification: 'restricted',
        environment: 'control_plane',
      },
      'procurement',
      profile.profileId,
    );
    const now = input.now ?? this.clock();
    const controls: ProcurementEvidenceV1['controls'] = [
      {
        controlId: 'identity.sso_scim',
        status: 'available',
        evidence:
          'OIDC/SAML SSO and SCIM lifecycle contracts are exposed by the enterprise identity backend.',
      },
      {
        controlId: 'identity.service_accounts',
        status: 'available',
        evidence: 'Scoped, expiring, digest-only service-account credentials are supported.',
      },
      {
        controlId: 'policy.rbac_abac',
        status: 'available',
        evidence: 'Default-deny role bindings include resource scope and attribute conditions.',
      },
      {
        controlId: 'runner.private_options',
        status: 'available',
        evidence:
          'Private Kubernetes, on-premise, customer-cloud, hosted Kubernetes, and SLURM runner kinds are modeled.',
      },
      {
        controlId: 'residency.region_lock',
        status: 'configured',
        evidence: `Profile locks data to ${profile.residency.allowedRegions.join(', ')} with home region ${profile.residency.homeRegion}.`,
      },
      {
        controlId: 'key.customer_managed',
        status:
          profile.customerManagedKey === undefined ? 'customer_action_required' : 'configured',
        evidence:
          profile.customerManagedKey === undefined
            ? 'Customer must provide a key reference.'
            : `Key reference ${profile.customerManagedKey.keyId} is recorded without key material.`,
      },
      {
        controlId: 'data.retention_legal_hold',
        status: 'available',
        evidence:
          'Retention evaluation, legal holds, approval-bound deletion, and tombstones are exposed.',
      },
      {
        controlId: 'data.export_support',
        status: 'available',
        evidence:
          'Redacted tenant exports and support bundles include digestable evidence manifests.',
      },
      {
        controlId: 'adapter.customer_substitution',
        status: 'available',
        evidence:
          'Inference, compute, storage, and vault adapters share one versioned enterprise Run contract.',
      },
    ];
    const evidence: ProcurementEvidenceV1 = {
      schemaVersion: ENTERPRISE_CONTRACT_VERSION,
      evidenceId: newSortableId(),
      tenant: clone(input.tenant),
      profileId: profile.profileId,
      generatedAt: now,
      controls,
      evidenceDigest: digest(controls),
    };
    this.record(
      input.tenant,
      'procurement.evidence.generated',
      input.requestedBy.actorId,
      evidence.evidenceId,
      'completed',
      {
        controlCount: controls.length,
        evidenceDigest: evidence.evidenceDigest,
      },
      now,
    );
    return clone(evidence);
  }

  auditRecords(tenant?: TenantRef): readonly EnterpriseAuditRecordV1[] {
    return clone(
      tenant === undefined
        ? this.audits
        : this.audits.filter((record) => sameTenant(record.tenant, tenant)),
    );
  }

  private normalizeProfile(
    input: Parameters<InMemoryEnterpriseControlPlane['registerProfile']>[0],
    now: string,
  ): EnterpriseProfileV1 {
    const allowedDeploymentModes = [
      ...new Set(input.allowedDeploymentModes ?? [input.deploymentMode]),
    ];
    if (!allowedDeploymentModes.includes(input.deploymentMode))
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Primary deployment mode must be allowed');
    const allowedRegions = [
      ...new Set(
        input.residency.allowedRegions.map((region) => assertText(region, 'Allowed region', 120)),
      ),
    ];
    const blockedRegions = [
      ...new Set(
        input.residency.blockedRegions.map((region) => assertText(region, 'Blocked region', 120)),
      ),
    ];
    if (allowedRegions.length === 0 || !allowedRegions.includes(input.residency.homeRegion))
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'Residency requires a home region in allowedRegions',
      );
    if (blockedRegions.some((region) => allowedRegions.includes(region)))
      throw runtimeError('POLICY_DENIED', 'A region cannot be both allowed and blocked');
    if (input.residency.allowedDataClasses.some((dataClass) => !dataClasses.includes(dataClass)))
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Residency contains an unknown data class');
    assertPositiveInteger(input.residency.retentionDays, 'Retention days');
    const requiresCmk =
      input.residency.requireCustomerManagedKey ||
      input.complianceProfile === 'fedramp_high' ||
      input.complianceProfile === 'government';
    if (requiresCmk && input.customerManagedKey === undefined)
      throw runtimeError(
        'POLICY_DENIED',
        'This compliance profile requires a customer-managed key reference',
      );
    if (
      (input.complianceProfile === 'fedramp_high' || input.complianceProfile === 'government') &&
      input.deploymentMode === 'hosted'
    )
      throw runtimeError(
        'POLICY_DENIED',
        'High-assurance government profiles require private deployment',
      );
    if (input.customerManagedKey !== undefined) {
      if (input.customerManagedKey.region !== input.residency.homeRegion)
        throw runtimeError(
          'POLICY_DENIED',
          'Customer-managed key region must match the residency home region',
        );
      assertText(input.customerManagedKey.keyId, 'Customer-managed key ID', 180);
      assertText(input.customerManagedKey.keyUri, 'Customer-managed key URI', 500);
      assertText(
        input.customerManagedKey.rotationVersion,
        'Customer-managed key rotation version',
        80,
      );
    }
    const residency: EnterpriseResidencyPolicyV1 = {
      schemaVersion: ENTERPRISE_CONTRACT_VERSION,
      homeRegion: assertText(input.residency.homeRegion, 'Home region', 120),
      allowedRegions,
      blockedRegions,
      noCrossRegionReplication: input.residency.noCrossRegionReplication,
      allowedDataClasses: [...input.residency.allowedDataClasses],
      requireCustomerManagedKey: requiresCmk,
      retentionDays: input.residency.retentionDays,
      policyVersion: assertText(input.residency.policyVersion, 'Residency policy version', 120),
    };
    return {
      schemaVersion: ENTERPRISE_CONTRACT_VERSION,
      profileId: input.profileId ?? newSortableId(),
      tenant: clone(input.tenant),
      name: assertText(input.name, 'Enterprise profile name'),
      deploymentMode: input.deploymentMode,
      allowedDeploymentModes,
      complianceProfile: input.complianceProfile,
      residency,
      ...(input.customerManagedKey === undefined
        ? {}
        : { customerManagedKey: { schemaVersion: 1 as const, ...input.customerManagedKey } }),
      createdAt: now,
      updatedAt: now,
    };
  }

  private requireProfile(tenant: TenantRef): EnterpriseProfileV1 {
    const profile = this.profiles.get(publicProfileKey(tenant));
    if (profile === undefined)
      throw runtimeError('AUTHORITY_MISSING', 'Enterprise profile is not configured');
    return profile;
  }

  private requireServiceAccount(tenant: TenantRef, accountId: Id): StoredServiceAccount {
    const account = this.serviceAccounts.get(`${tenantKey(tenant)}:${accountId}`);
    if (account === undefined)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Service account ${accountId} was not found`);
    return account;
  }

  private requireServiceAccountForDecision(
    tenant: TenantRef,
    accountId: Id,
  ): StoredServiceAccount | undefined {
    return this.serviceAccounts.get(`${tenantKey(tenant)}:${accountId}`);
  }

  private requireAdapterSet(tenant: TenantRef, adapterSetId: Id): RegisteredAdapterSet {
    const adapterSet = this.adapterSets.get(`${tenantKey(tenant)}:${adapterSetId}`);
    if (adapterSet === undefined)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Adapter set ${adapterSetId} was not found`);
    return adapterSet;
  }

  private requireRunner(tenant: TenantRef, runnerId: Id): EnterpriseRunnerV1 {
    const runner = this.runners.get(`${tenantKey(tenant)}:${runnerId}`);
    if (runner === undefined)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Runner ${runnerId} was not found`);
    return runner;
  }

  private requireLegalHold(tenant: TenantRef, holdId: Id): EnterpriseLegalHoldV1 {
    const hold = this.legalHolds.get(`${tenantKey(tenant)}:${holdId}`);
    if (hold === undefined)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Legal hold ${holdId} was not found`);
    return hold;
  }

  private requireDeletionPlan(tenant: TenantRef, deletionId: Id): EnterpriseDeletionPlanV1 {
    const plan = this.deletionPlans.get(`${tenantKey(tenant)}:${deletionId}`);
    if (plan === undefined)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Deletion plan ${deletionId} was not found`);
    return plan;
  }

  private hasActiveLegalHold(tenant: TenantRef): boolean {
    return [...this.legalHolds.values()].some(
      (hold) => sameTenant(hold.tenant, tenant) && hold.active,
    );
  }

  private zeroInventory(
    tenant: TenantRef,
    now: string,
    policyVersion: string,
  ): EnterpriseDataInventoryV1 {
    const counts = emptyCounts();
    return {
      schemaVersion: ENTERPRISE_CONTRACT_VERSION,
      tenant: clone(tenant),
      observedAt: now,
      retentionPolicyVersion: policyVersion,
      counts,
      totalBytes: 0,
      digest: digest({ tenant, now, policyVersion, counts, totalBytes: 0 }),
    };
  }

  private assertVaultHandle(handle: EnterpriseVaultHandleV1, tenant: TenantRef): void {
    if (
      !sameTenant(handle.tenant, tenant) ||
      !isId(handle.handleId) ||
      handle.operation !== 'enterprise.run' ||
      Date.parse(handle.expiresAt) <= Date.parse(this.clock())
    ) {
      throw runtimeError(
        'VALIDATION_SCHEMA_MISMATCH',
        'Vault adapter returned an invalid or out-of-scope handle',
      );
    }
  }

  private assertAllowed(
    tenant: TenantRef,
    principal: EnterprisePrincipalV1,
    action: string,
    context: EnterpriseAuthorizationContextV1,
    resourceKind: string,
    resourceId: string,
  ): void {
    const decision = this.authorize({
      tenant,
      principal,
      action,
      resourceKind,
      resourceId,
      context,
    });
    if (decision.outcome !== 'allowed')
      throw runtimeError(
        'POLICY_DENIED',
        `Enterprise policy denied ${action}: ${decision.reasonCodes.join(', ')}`,
      );
  }

  private record(
    tenant: TenantRef,
    action: string,
    actorId: Id,
    targetId: Id | undefined,
    outcome: EnterpriseAuditRecordV1['outcome'],
    details: unknown,
    occurredAt = this.clock(),
  ): void {
    this.audits.push({
      schemaVersion: ENTERPRISE_CONTRACT_VERSION,
      auditId: newSortableId(),
      tenant: clone(tenant),
      action,
      actorId,
      ...(targetId === undefined ? {} : { targetId }),
      outcome,
      details: isJsonValue(details) ? clone(details) : {},
      occurredAt,
    });
  }
}

export type EnterpriseControlPlane = InMemoryEnterpriseControlPlane;
