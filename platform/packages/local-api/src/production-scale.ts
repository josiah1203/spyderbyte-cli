import {
  isId,
  isJsonValue,
  makeMoney,
  newSortableId,
  runtimeError,
  type Actor,
  type BudgetCategory,
  type DeploymentAction,
  type Id,
  type JsonValue,
  type ResourceSelector,
  type TenantRef,
  type WorkspaceMode,
} from '@agentic-platform/runtime-contracts';
import type {
  AgentRoutingService,
  AgentDefinitionV1,
  AgentRoutingRequest,
} from '@agentic-platform/agent-registry';
import type {
  ServingEndpointManager,
  ServingHealthObservation,
  ServingTrafficApproval,
  HostedExecutionAdapter,
  HostedExecutionTargetKind,
  HostedSandboxPolicyV1,
  InMemoryEnterpriseIdentityService,
  EnterpriseSecretManagerClient,
} from '@agentic-platform/backends';
import type {
  DataClassificationV1,
  GovernanceApprovalContextV1,
  GovernanceRole,
  GovernanceScopeV1,
  GovernanceService,
  GovernanceUsageCategory,
} from '@agentic-platform/policy';
import { governanceMembershipForActor, governanceRoleAllows } from '@agentic-platform/policy';
import type { ProviderRuntimeServices } from '@agentic-platform/provider-runtime';
import type {
  CostPolicy,
  ModelCostEstimateInput,
  ScopedBudgetService,
  ScopedBudgetDefinition,
  ScopedReservationRecord,
} from '@agentic-platform/budget';
import type {
  CollaborationService,
  CollaborationWriteResult,
} from '@agentic-platform/runtime-domain';
import type { DisasterRecoveryService, RetentionPolicyV1 } from '@agentic-platform/state';

export interface ProductionScaleOperations {
  readonly serving?: ServingEndpointManager;
  readonly budgets?: ScopedBudgetService;
  readonly agents?: AgentRoutingService;
  readonly recovery?: DisasterRecoveryService;
  readonly collaboration?: CollaborationService;
  readonly governance?: GovernanceService;
  /** Shared provider catalog; credential values remain behind the provider vault boundary. */
  readonly providerRuntime?: ProviderRuntimeServices;
  readonly identity?: InMemoryEnterpriseIdentityService;
  readonly secrets?: EnterpriseSecretManagerClient;
  readonly hostedExecution?: HostedExecutionAdapter;
}

export interface ProductionScaleApiResponse {
  readonly statusCode: number;
  readonly body: unknown;
}

export interface ProductionScaleRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly tenant: TenantRef;
  readonly actor?: Actor | undefined;
  readonly workspaceMode?: WorkspaceMode;
  readonly now: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${key} is required`);
  }
  return value.trim();
}

function requiredId(input: Record<string, unknown>, key: string): Id {
  const value = requiredString(input, key);
  if (!isId(value)) throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${key} must be a UUIDv7 id`);
  return value;
}

function pathId(value: string, label: string): Id {
  const decoded = decodeURIComponent(value);
  if (!isId(decoded))
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} must be a UUIDv7 id`);
  return decoded;
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${key} must be a string`);
  }
  return value;
}

function optionalId(input: Record<string, unknown>, key: string): Id | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !isId(value)) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${key} must be a UUIDv7 id`);
  }
  return value;
}

function integer(input: Record<string, unknown>, key: string, positive = false): number {
  const value = input[key];
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    (positive && value === 0)
  ) {
    throw runtimeError(
      'VALIDATION_SCHEMA_MISMATCH',
      `${key} must be a ${positive ? 'positive' : 'non-negative'} integer`,
    );
  }
  return value;
}

function optionalInteger(
  input: Record<string, unknown>,
  key: string,
  positive = false,
): number | undefined {
  if (input[key] === undefined) return undefined;
  return integer(input, key, positive);
}

function boolean(input: Record<string, unknown>, key: string): boolean {
  const value = input[key];
  if (typeof value !== 'boolean') {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${key} must be a boolean`);
  }
  return value;
}

function optionalBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
  if (input[key] === undefined) return undefined;
  return boolean(input, key);
}

function jsonValue(input: Record<string, unknown>, key: string): JsonValue {
  const value = input[key];
  if (!isJsonValue(value)) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${key} must be a JSON value`);
  }
  return value;
}

function stringArray(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${key} must be an array of strings`);
  }
  return value as string[];
}

function optionalStringArray(input: Record<string, unknown>, key: string): string[] | undefined {
  if (input[key] === undefined) return undefined;
  return stringArray(input, key);
}

function governanceRole(value: unknown): GovernanceRole {
  if (!['owner', 'admin', 'operator', 'editor', 'analyst', 'viewer'].includes(String(value))) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'role is invalid');
  }
  return value as GovernanceRole;
}

function dataClassification(value: unknown): DataClassificationV1 {
  if (!['public', 'internal', 'confidential', 'restricted'].includes(String(value))) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'dataClassification is invalid');
  }
  return value as DataClassificationV1;
}

function usageCategory(value: unknown): GovernanceUsageCategory {
  if (!['llm', 'compute', 'storage', 'external_api', 'retry', 'other'].includes(String(value))) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'category is invalid');
  }
  return value as GovernanceUsageCategory;
}

function governanceScope(input: Record<string, unknown>, organizationId: Id): GovernanceScopeV1 {
  const scope = record(input['scope'], 'scope');
  const scopeOrganizationId = optionalId(scope, 'organizationId');
  const workspaceId = optionalId(scope, 'workspaceId');
  const projectId = optionalId(scope, 'projectId');
  if (scopeOrganizationId !== undefined && scopeOrganizationId !== organizationId) {
    throw runtimeError('AUTHORITY_SCOPE_VIOLATION', 'scope organizationId does not match the path');
  }
  return {
    organizationId,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(projectId === undefined ? {} : { projectId }),
  };
}

function resourceSelectors(input: Record<string, unknown>, key: string): ResourceSelector[] {
  const value = input[key];
  if (!Array.isArray(value)) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${key} must be an array`);
  }
  return value.map((entry) => {
    const resource = record(entry, `${key} entry`);
    const kind = requiredString(resource, 'kind');
    if (
      ![
        'workspace',
        'dataset',
        'artifact',
        'repository',
        'compute',
        'model',
        'deployment',
        'connector',
        'secret',
      ].includes(kind)
    ) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'resource kind is invalid');
    }
    const version = optionalInteger(resource, 'version', true);
    return {
      kind: kind as ResourceSelector['kind'],
      id: requiredString(resource, 'id'),
      ...(version === undefined ? {} : { version }),
    };
  });
}

function numericRecord(input: unknown, label: string): Record<string, number> {
  const value = record(input, label);
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0) {
      throw runtimeError(
        'VALIDATION_SCHEMA_MISMATCH',
        `${label}.${key} must be a non-negative number`,
      );
    }
  }
  return value as Record<string, number>;
}

function hostedTargetKind(value: unknown): HostedExecutionTargetKind {
  if (!['kubernetes', 'slurm', 'customer_cloud'].includes(String(value))) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Hosted execution target kind is invalid');
  }
  return value as HostedExecutionTargetKind;
}

function hostedSandbox(input: Record<string, unknown>): HostedSandboxPolicyV1 {
  return {
    networkAllowlist: stringArray(input, 'networkAllowlist'),
    readOnlyArtifactMounts:
      input['readOnlyArtifactMounts'] === undefined
        ? true
        : boolean(input, 'readOnlyArtifactMounts'),
    ephemeralFilesystem:
      input['ephemeralFilesystem'] === undefined ? true : boolean(input, 'ephemeralFilesystem'),
    maxOutputBytes: integer(input, 'maxOutputBytes', true),
    maxWallTimeMs: integer(input, 'maxWallTimeMs', true),
    maxProcessCount: integer(input, 'maxProcessCount', true),
  };
}

function money(input: Record<string, unknown>, key: string) {
  const value = record(input[key], key);
  return makeMoney(integer(value, 'amountMinor'), requiredString(value, 'currency'));
}

function budgetCategory(value: unknown): BudgetCategory {
  if (!['llm', 'compute', 'storage', 'external_api', 'retry'].includes(String(value))) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'category is invalid');
  }
  return value as BudgetCategory;
}

function approval(value: unknown): ServingTrafficApproval {
  const input = record(value, 'approval');
  return {
    approved: boolean(input, 'approved'),
    actionDigest: requiredString(input, 'actionDigest'),
    commitDigest: requiredString(input, 'commitDigest'),
    expiresAt: requiredString(input, 'expiresAt'),
    now: requiredString(input, 'now'),
  };
}

function action(value: unknown): DeploymentAction {
  const allowed: readonly DeploymentAction[] = [
    'provision',
    'smokePass',
    'startCanary',
    'ramp',
    'activate',
    'rollback',
    'fail',
  ];
  if (!allowed.includes(value as DeploymentAction)) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'deployment action is invalid');
  }
  return value as DeploymentAction;
}

function requireActor(actor: Actor | undefined): Actor {
  if (actor === undefined)
    throw runtimeError('AUTHORITY_MISSING', 'An authenticated actor is required');
  return actor;
}

function requireOrganizationMember(
  governance: GovernanceService,
  tenant: TenantRef,
  organizationId: Id,
  actor: Actor | undefined,
  minimumRole: GovernanceRole = 'viewer',
  projectId?: Id,
) {
  const member = governanceMembershipForActor(
    governance.listMemberships(tenant, organizationId),
    requireActor(actor).actorId,
    tenant.workspaceId,
    projectId,
  );
  if (member === undefined)
    throw runtimeError(
      'AUTHORITY_SCOPE_VIOLATION',
      'Actor is not an active member of this workspace',
    );
  if (!governanceRoleAllows(member.role, minimumRole))
    throw runtimeError('POLICY_DENIED', `The ${minimumRole} role is required for this operation`);
  return member;
}

function unavailable(name: string): ProductionScaleApiResponse {
  return { statusCode: 501, body: { error: `${name}_not_configured` } };
}

function requestBudgetDefinition(
  input: Record<string, unknown>,
  tenant: TenantRef,
  now: string,
): ScopedBudgetDefinition {
  const categorySoftLimits = input['categorySoftLimits'];
  const definition: ScopedBudgetDefinition = {
    budgetId: requiredId(input, 'budgetId'),
    tenant,
    scope: record(input['scope'], 'scope') as unknown as ScopedBudgetDefinition['scope'],
    currency: requiredString(input, 'currency') as ScopedBudgetDefinition['currency'],
    hardLimitMinor: integer(input, 'hardLimitMinor'),
    softLimitMinor: integer(input, 'softLimitMinor'),
    categoryHardLimits: record(
      input['categoryHardLimits'],
      'categoryHardLimits',
    ) as ScopedBudgetDefinition['categoryHardLimits'],
    policyVersion: requiredString(input, 'policyVersion'),
    createdAt: optionalString(input, 'createdAt') ?? now,
  };
  if (categorySoftLimits === undefined) return definition;
  return {
    ...definition,
    categorySoftLimits: record(categorySoftLimits, 'categorySoftLimits') as NonNullable<
      ScopedBudgetDefinition['categorySoftLimits']
    >,
  };
}

function requestCostPolicy(input: Record<string, unknown>, tenant: TenantRef): CostPolicy {
  const allowedProviders = input['allowedProviders'];
  const allowedModels = input['allowedModels'];
  const rates = input['rates'];
  if (!Array.isArray(rates)) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'rates must be an array');
  }
  return {
    policyId: requiredId(input, 'policyId'),
    tenant,
    scope: record(input['scope'], 'scope') as unknown as CostPolicy['scope'],
    policyVersion: requiredString(input, 'policyVersion'),
    rates: rates as CostPolicy['rates'],
    ...(allowedProviders === undefined
      ? {}
      : { allowedProviders: stringArray(input, 'allowedProviders') }),
    ...(allowedModels === undefined ? {} : { allowedModels: stringArray(input, 'allowedModels') }),
    ...(input['maxInvocationCostMinor'] === undefined
      ? {}
      : { maxInvocationCostMinor: integer(input, 'maxInvocationCostMinor') }),
    ...(input['maxRetryAttempts'] === undefined
      ? {}
      : { maxRetryAttempts: integer(input, 'maxRetryAttempts', true) }),
  };
}

export async function handleProductionScaleRequest(
  input: ProductionScaleRequest,
  operations: ProductionScaleOperations | undefined,
): Promise<ProductionScaleApiResponse | undefined> {
  const { method, path, body, tenant, actor, workspaceMode, now } = input;
  const serving = operations?.serving;
  const budgets = operations?.budgets;
  const agents = operations?.agents;
  const recovery = operations?.recovery;
  const collaboration = operations?.collaboration;
  const governance = operations?.governance;
  const providerRuntime = operations?.providerRuntime;
  const identity = operations?.identity;
  const secrets = operations?.secrets;
  const hostedExecution = operations?.hostedExecution;

  if (
    workspaceMode === 'personal_local' &&
    (path.startsWith('/v1/governance') || path.startsWith('/v1/enterprise'))
  ) {
    return { statusCode: 404, body: { error: 'organization_surface_not_available' } };
  }

  if (path === '/v1/governance/organizations') {
    if (governance === undefined) return unavailable('governance');
    if (method === 'GET') {
      const actorId = requireActor(actor).actorId;
      const organizations = governance
        .listOrganizations(tenant)
        .filter(
          (organization) =>
            governanceMembershipForActor(
              governance.listMemberships(tenant, organization.organizationId),
              actorId,
              tenant.workspaceId,
            ) !== undefined,
        );
      return { statusCode: 200, body: { organizations } };
    }
    if (method === 'POST') {
      const inputRecord = record(body, 'organization');
      const organizationId = optionalId(inputRecord, 'organizationId');
      return {
        statusCode: 201,
        body: governance.createOrganization({
          tenant,
          name: requiredString(inputRecord, 'name'),
          actor: requireActor(actor),
          ...(organizationId === undefined ? {} : { organizationId }),
          now,
        }),
      };
    }
  }

  const organizationMatch = /^\/v1\/governance\/organizations\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (organizationMatch?.[1] !== undefined) {
    if (governance === undefined) return unavailable('governance');
    const organizationId = pathId(organizationMatch[1], 'organizationId');
    const suffix = organizationMatch[2] ?? '';
    if (suffix === '' && method === 'GET') {
      requireOrganizationMember(governance, tenant, organizationId, actor);
      const organization = governance.getOrganization(tenant, organizationId);
      return {
        statusCode: organization === undefined ? 404 : 200,
        body: organization ?? { error: 'organization_not_found' },
      };
    }
    if (suffix === 'members') {
      requireOrganizationMember(governance, tenant, organizationId, actor);
      if (method === 'GET')
        return {
          statusCode: 200,
          body: { members: governance.listMemberships(tenant, organizationId) },
        };
      if (method === 'POST') {
        const inputRecord = record(body, 'governance membership');
        const scopes = inputRecord['scopes'];
        const displayName = optionalString(inputRecord, 'displayName');
        const email = optionalString(inputRecord, 'email');
        const status = optionalString(inputRecord, 'status');
        const parsedScopes =
          scopes === undefined
            ? undefined
            : Array.isArray(scopes)
              ? scopes.map((entry) =>
                  governanceScope(record(entry, 'membership scope'), organizationId),
                )
              : (() => {
                  throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'scopes must be an array');
                })();
        return {
          statusCode: 201,
          body: governance.upsertMembership({
            tenant,
            organizationId,
            actorId: requiredId(inputRecord, 'actorId'),
            role: governanceRole(inputRecord['role']),
            ...(parsedScopes === undefined ? {} : { scopes: parsedScopes }),
            ...(displayName === undefined ? {} : { displayName }),
            ...(email === undefined ? {} : { email }),
            ...(status === undefined
              ? {}
              : { status: status as 'active' | 'suspended' | 'removed' }),
            changedBy: requireActor(actor),
            now,
          }),
        };
      }
    }
    if (suffix === 'policies') {
      requireOrganizationMember(governance, tenant, organizationId, actor);
      if (method === 'GET')
        return {
          statusCode: 200,
          body: { policies: governance.listPolicies(tenant, organizationId) },
        };
      if (method === 'POST') {
        const inputRecord = record(body, 'governance policy');
        const approvalCostThresholdMinor = optionalInteger(
          inputRecord,
          'approvalCostThresholdMinor',
        );
        const maxExecutionCostMinor = optionalInteger(inputRecord, 'maxExecutionCostMinor');
        const retentionDays = optionalInteger(inputRecord, 'retentionDays', true);
        const allowedInterfaces = optionalStringArray(inputRecord, 'allowedInterfaces');
        const allowedProviders = optionalStringArray(inputRecord, 'allowedProviders');
        const allowedRuntimes = optionalStringArray(inputRecord, 'allowedRuntimes');
        return {
          statusCode: 201,
          body: governance.putPolicy({
            tenant,
            organizationId,
            version: requiredString(inputRecord, 'version'),
            scope: governanceScope(inputRecord, organizationId),
            ...(inputRecord['allowedDataClasses'] === undefined
              ? {}
              : {
                  allowedDataClasses: stringArray(inputRecord, 'allowedDataClasses').map(
                    dataClassification,
                  ),
                }),
            ...(inputRecord['blockedActions'] === undefined
              ? {}
              : { blockedActions: stringArray(inputRecord, 'blockedActions') }),
            ...(inputRecord['approvalActions'] === undefined
              ? {}
              : { approvalActions: stringArray(inputRecord, 'approvalActions') }),
            ...(approvalCostThresholdMinor === undefined ? {} : { approvalCostThresholdMinor }),
            ...(maxExecutionCostMinor === undefined ? {} : { maxExecutionCostMinor }),
            ...(allowedInterfaces === undefined ? {} : { allowedInterfaces }),
            ...(allowedProviders === undefined ? {} : { allowedProviders }),
            ...(allowedRuntimes === undefined ? {} : { allowedRuntimes }),
            ...(retentionDays === undefined ? {} : { retentionDays }),
            changedBy: requireActor(actor),
            now,
          }),
        };
      }
    }
    if (suffix === 'budgets') {
      requireOrganizationMember(governance, tenant, organizationId, actor);
      if (method === 'GET')
        return {
          statusCode: 200,
          body: { budgets: governance.listBudgets(tenant, organizationId) },
        };
      if (method === 'POST') {
        const inputRecord = record(body, 'governance budget');
        const budgetId = optionalId(inputRecord, 'budgetId');
        const thresholds = inputRecord['alertThresholds'];
        const alertThresholds =
          thresholds === undefined
            ? undefined
            : Array.isArray(thresholds) && thresholds.every((entry) => typeof entry === 'number')
              ? (thresholds as number[])
              : (() => {
                  throw runtimeError(
                    'VALIDATION_SCHEMA_MISMATCH',
                    'alertThresholds must be numeric',
                  );
                })();
        return {
          statusCode: 201,
          body: governance.setBudget({
            tenant,
            organizationId,
            scope: governanceScope(inputRecord, organizationId),
            currency: requiredString(inputRecord, 'currency'),
            hardLimitMinor: integer(inputRecord, 'hardLimitMinor'),
            softLimitMinor: integer(inputRecord, 'softLimitMinor'),
            ...(alertThresholds === undefined ? {} : { alertThresholds }),
            ...(inputRecord['blockedActions'] === undefined
              ? {}
              : { blockedActions: stringArray(inputRecord, 'blockedActions') }),
            ...(budgetId === undefined ? {} : { budgetId }),
            changedBy: requireActor(actor),
            now,
          }),
        };
      }
    }
    if (suffix === 'overview' && method === 'GET') {
      const membership = requireOrganizationMember(governance, tenant, organizationId, actor);
      const organization = governance.getOrganization(tenant, organizationId);
      if (organization === undefined)
        return { statusCode: 404, body: { error: 'organization_not_found' } };
      const policies = governance.listPolicies(tenant, organizationId);
      const allowedProviders = [
        ...new Set(policies.flatMap((policy) => policy.allowedProviders ?? [])),
      ];
      const allowedRuntimes = [
        ...new Set(policies.flatMap((policy) => policy.allowedRuntimes ?? [])),
      ];
      return {
        statusCode: 200,
        body: {
          organization,
          workspace: tenant,
          membership,
          policies,
          budgets: governance.listBudgets(tenant, organizationId),
          allowedProviders,
          allowedRuntimes,
          ...(providerRuntime === undefined
            ? {}
            : {
                providers: providerRuntime.providers.list(),
                runtimes: providerRuntime.runtimes.list(),
              }),
        },
      };
    }
    if (suffix === 'providers' && method === 'GET') {
      requireOrganizationMember(governance, tenant, organizationId, actor);
      if (providerRuntime === undefined) return unavailable('provider_runtime');
      return {
        statusCode: 200,
        body: {
          providers: providerRuntime.providers.list(),
          runtimes: providerRuntime.runtimes.list(),
        },
      };
    }
    if (suffix === 'usage' && method === 'GET') {
      requireOrganizationMember(governance, tenant, organizationId, actor);
      const end = Date.parse(now);
      return {
        statusCode: 200,
        body: governance.usageSummary({
          tenant,
          organizationId,
          periodStart: new Date(end - 30 * 24 * 60 * 60 * 1000).toISOString(),
          periodEnd: now,
          workspaceId: tenant.workspaceId,
        }),
      };
    }
    if (suffix === 'usage/record' && method === 'POST') {
      requireOrganizationMember(governance, tenant, organizationId, actor, 'operator');
      const inputRecord = record(body, 'governance usage');
      const quantity = inputRecord['quantity'];
      const workspaceId = optionalId(inputRecord, 'workspaceId') ?? tenant.workspaceId;
      const projectId = optionalId(inputRecord, 'projectId');
      const runId = optionalId(inputRecord, 'runId');
      const target =
        inputRecord['target'] === undefined
          ? undefined
          : resourceSelectors({ target: [inputRecord['target']] }, 'target')[0];
      if (
        quantity !== undefined &&
        (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity < 0)
      )
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'quantity must be a non-negative number');
      return {
        statusCode: 201,
        body: governance.recordUsage({
          tenant,
          organizationId,
          workspaceId,
          ...(projectId === undefined ? {} : { projectId }),
          actorId: requireActor(actor).actorId,
          ...(runId === undefined ? {} : { runId }),
          category: usageCategory(inputRecord['category']),
          amount: money(inputRecord, 'amount'),
          ...(quantity === undefined ? {} : { quantity }),
          ...(target === undefined ? {} : { target }),
          interfaceName: requiredString(inputRecord, 'interfaceName'),
          occurredAt: optionalString(inputRecord, 'occurredAt') ?? now,
        }),
      };
    }
    if (suffix === 'forecast' && method === 'GET') {
      requireOrganizationMember(governance, tenant, organizationId, actor);
      return { statusCode: 200, body: governance.forecast({ tenant, organizationId, asOf: now }) };
    }
    if (suffix === 'alerts' && method === 'GET') {
      requireOrganizationMember(governance, tenant, organizationId, actor);
      return { statusCode: 200, body: { alerts: governance.alerts(tenant, organizationId) } };
    }
    if (suffix === 'audit' && method === 'GET') {
      requireOrganizationMember(governance, tenant, organizationId, actor);
      return {
        statusCode: 200,
        body: { records: governance.auditRecords(tenant, organizationId) },
      };
    }
    if (suffix === 'audit/verify' && (method === 'GET' || method === 'POST')) {
      requireOrganizationMember(governance, tenant, organizationId, actor);
      return { statusCode: 200, body: { valid: governance.verifyAudit(tenant, organizationId) } };
    }
  }

  if (path === '/v1/governance/evaluate' && method === 'POST') {
    if (governance === undefined) return unavailable('governance');
    const inputRecord = record(body, 'governance evaluation');
    const organizationId = requiredId(inputRecord, 'organizationId');
    const estimatedCost = inputRecord['estimatedCost'];
    const workspaceId = optionalId(inputRecord, 'workspaceId') ?? tenant.workspaceId;
    const projectId = optionalId(inputRecord, 'projectId');
    const runId = optionalId(inputRecord, 'runId');
    const providerId = optionalString(inputRecord, 'providerId');
    const runtimeName = optionalString(inputRecord, 'runtimeName');
    return {
      statusCode: 200,
      body: governance.evaluate({
        tenant,
        organizationId,
        workspaceId,
        ...(projectId === undefined ? {} : { projectId }),
        actor: requireActor(actor),
        action: requiredString(inputRecord, 'action'),
        target: resourceSelectors(inputRecord, 'target'),
        ...(inputRecord['dataClassification'] === undefined
          ? {}
          : { dataClassification: dataClassification(inputRecord['dataClassification']) }),
        ...(estimatedCost === undefined
          ? {}
          : { estimatedCost: money(inputRecord, 'estimatedCost') }),
        ...(runId === undefined ? {} : { runId }),
        interfaceName: requiredString(inputRecord, 'interfaceName'),
        ...(providerId === undefined ? {} : { providerId }),
        ...(runtimeName === undefined ? {} : { runtimeName }),
        now,
      }),
    };
  }

  if (path === '/v1/governance/commit' && method === 'POST') {
    if (governance === undefined) return unavailable('governance');
    const inputRecord = record(body, 'governance commit');
    const organizationId = requiredId(inputRecord, 'organizationId');
    const estimatedCost = inputRecord['estimatedCost'];
    const approvalValue = inputRecord['approvalContext'];
    const usageValue = inputRecord['usage'];
    const workspaceId = optionalId(inputRecord, 'workspaceId') ?? tenant.workspaceId;
    const projectId = optionalId(inputRecord, 'projectId');
    const runId = optionalId(inputRecord, 'runId');
    const providerId = optionalString(inputRecord, 'providerId');
    const runtimeName = optionalString(inputRecord, 'runtimeName');
    const approvalContext =
      approvalValue === undefined
        ? undefined
        : (record(approvalValue, 'approvalContext') as unknown as GovernanceApprovalContextV1);
    const usage =
      usageValue === undefined
        ? undefined
        : (() => {
            const usageRecord = record(usageValue, 'usage');
            const quantity = usageRecord['quantity'];
            return {
              category: usageCategory(usageRecord['category']),
              amount: money(usageRecord, 'amount'),
              ...(quantity === undefined ? {} : { quantity: Number(quantity) }),
            };
          })();
    return {
      statusCode: 200,
      body: governance.commit({
        tenant,
        organizationId,
        workspaceId,
        ...(projectId === undefined ? {} : { projectId }),
        actor: requireActor(actor),
        action: requiredString(inputRecord, 'action'),
        target: resourceSelectors(inputRecord, 'target'),
        ...(inputRecord['dataClassification'] === undefined
          ? {}
          : { dataClassification: dataClassification(inputRecord['dataClassification']) }),
        ...(estimatedCost === undefined
          ? {}
          : { estimatedCost: money(inputRecord, 'estimatedCost') }),
        ...(runId === undefined ? {} : { runId }),
        interfaceName: requiredString(inputRecord, 'interfaceName'),
        ...(providerId === undefined ? {} : { providerId }),
        ...(runtimeName === undefined ? {} : { runtimeName }),
        ...(approvalContext === undefined ? {} : { approvalContext }),
        ...(inputRecord['before'] === undefined
          ? {}
          : { before: jsonValue(inputRecord, 'before') }),
        ...(inputRecord['after'] === undefined ? {} : { after: jsonValue(inputRecord, 'after') }),
        ...(usage === undefined ? {} : { usage }),
        now,
      }),
    };
  }

  if (path === '/v1/enterprise/sso/providers') {
    if (identity === undefined) return unavailable('enterprise_identity');
    if (method === 'GET')
      return { statusCode: 200, body: { providers: identity.providersFor(tenant) } };
    if (method === 'POST') {
      const inputRecord = record(body, 'SSO provider');
      const protocol = requiredString(inputRecord, 'protocol');
      const scopes = optionalStringArray(inputRecord, 'scopes');
      if (protocol !== 'oidc' && protocol !== 'saml')
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'protocol must be oidc or saml');
      return {
        statusCode: 201,
        body: identity.registerProvider({
          tenant,
          displayName: requiredString(inputRecord, 'displayName'),
          protocol,
          issuerUrl: requiredString(inputRecord, 'issuerUrl'),
          clientId: requiredString(inputRecord, 'clientId'),
          redirectUris: stringArray(inputRecord, 'redirectUris'),
          ...(scopes === undefined ? {} : { scopes }),
          now,
        }),
      };
    }
  }

  if (path === '/v1/enterprise/sso/login/start' && method === 'POST') {
    if (identity === undefined) return unavailable('enterprise_identity');
    const inputRecord = record(body, 'SSO login');
    return {
      statusCode: 200,
      body: identity.beginLogin({
        tenant,
        providerId: requiredId(inputRecord, 'providerId'),
        redirectUri: requiredString(inputRecord, 'redirectUri'),
        now,
      }),
    };
  }

  if (path === '/v1/enterprise/sso/login/complete' && method === 'POST') {
    if (identity === undefined) return unavailable('enterprise_identity');
    const inputRecord = record(body, 'SSO login completion');
    const claims = record(inputRecord['claims'], 'claims');
    const groups = optionalStringArray(claims, 'groups');
    const displayName = optionalString(claims, 'displayName');
    return {
      statusCode: 200,
      body: identity.completeLogin({
        tenant,
        providerId: requiredId(inputRecord, 'providerId'),
        state: requiredString(inputRecord, 'state'),
        claims: {
          subject: requiredString(claims, 'subject'),
          email: requiredString(claims, 'email'),
          ...(displayName === undefined ? {} : { displayName }),
          ...(groups === undefined ? {} : { groups }),
          issuer: requiredString(claims, 'issuer'),
          issuedAt: requiredString(claims, 'issuedAt'),
          expiresAt: requiredString(claims, 'expiresAt'),
        },
        now,
      }),
    };
  }

  const sessionRevokeMatch = /^\/v1\/enterprise\/sessions\/([^/]+)\/revoke$/.exec(path);
  if (sessionRevokeMatch?.[1] !== undefined && method === 'POST') {
    if (identity === undefined) return unavailable('enterprise_identity');
    identity.revokeSession(tenant, pathId(sessionRevokeMatch[1], 'sessionId'), now);
    return { statusCode: 204, body: undefined };
  }

  if (path === '/v1/enterprise/scim/users') {
    if (identity === undefined) return unavailable('enterprise_identity');
    if (method === 'GET')
      return { statusCode: 200, body: { users: identity.listScimUsers(tenant) } };
    if (method === 'POST') {
      const inputRecord = record(body, 'SCIM user');
      const groups = optionalStringArray(inputRecord, 'groups');
      const active = optionalBoolean(inputRecord, 'active');
      const displayName = optionalString(inputRecord, 'displayName');
      return {
        statusCode: 200,
        body: identity.upsertScimUser({
          tenant,
          externalId: requiredString(inputRecord, 'externalId'),
          userName: requiredString(inputRecord, 'userName'),
          email: requiredString(inputRecord, 'email'),
          ...(displayName === undefined ? {} : { displayName }),
          ...(active === undefined ? {} : { active }),
          ...(groups === undefined ? {} : { groups }),
          now,
        }),
      };
    }
  }

  const scimDeprovisionMatch = /^\/v1\/enterprise\/scim\/users\/([^/]+)\/deprovision$/.exec(path);
  if (scimDeprovisionMatch?.[1] !== undefined && method === 'POST') {
    if (identity === undefined) return unavailable('enterprise_identity');
    return {
      statusCode: 200,
      body: identity.deprovisionScimUser(tenant, pathId(scimDeprovisionMatch[1], 'userId'), now),
    };
  }

  if (path === '/v1/enterprise/identity/audit' && method === 'GET') {
    if (identity === undefined) return unavailable('enterprise_identity');
    return { statusCode: 200, body: { records: identity.auditRecords(tenant) } };
  }

  if (path === '/v1/enterprise/secrets/handles' && method === 'POST') {
    if (secrets === undefined) return unavailable('enterprise_secrets');
    const inputRecord = record(body, 'secret handle');
    return {
      statusCode: 201,
      body: await secrets.issue({
        tenant,
        secretName: requiredString(inputRecord, 'secretName'),
        operation: requiredString(inputRecord, 'operation'),
        ttlMs: integer(inputRecord, 'ttlMs', true),
      }),
    };
  }

  const secretHandleMatch = /^\/v1\/enterprise\/secrets\/handles\/([^/]+)\/(rotate|revoke)$/.exec(
    path,
  );
  if (
    secretHandleMatch?.[1] !== undefined &&
    secretHandleMatch[2] !== undefined &&
    method === 'POST'
  ) {
    if (secrets === undefined) return unavailable('enterprise_secrets');
    const handleId = pathId(secretHandleMatch[1], 'handleId');
    const inputRecord = record(body, 'secret handle action');
    if (secretHandleMatch[2] === 'revoke') {
      await secrets.revoke(handleId);
      return { statusCode: 204, body: undefined };
    }
    return {
      statusCode: 200,
      body: await secrets.rotate({
        handleId,
        tenant,
        operation: requiredString(inputRecord, 'operation'),
        ttlMs: integer(inputRecord, 'ttlMs', true),
      }),
    };
  }

  if (path === '/v1/enterprise/runners') {
    if (hostedExecution === undefined) return unavailable('hosted_execution');
    if (method === 'GET')
      return { statusCode: 200, body: { targets: hostedExecution.listTargets(tenant) } };
    if (method === 'POST') {
      const inputRecord = record(body, 'hosted execution target');
      const targetId = optionalId(inputRecord, 'targetId') ?? newSortableId();
      const enabled = optionalBoolean(inputRecord, 'enabled');
      return {
        statusCode: 201,
        body: hostedExecution.registerTarget({
          targetId,
          tenant,
          kind: hostedTargetKind(inputRecord['kind']),
          region: requiredString(inputRecord, 'region'),
          capabilities: stringArray(inputRecord, 'capabilities'),
          enabled: enabled ?? true,
        }),
      };
    }
  }

  if (path === '/v1/enterprise/executions' && method === 'GET') {
    if (hostedExecution === undefined) return unavailable('hosted_execution');
    return { statusCode: 200, body: { executions: hostedExecution.list(tenant) } };
  }

  if (path === '/v1/enterprise/executions' && method === 'POST') {
    if (hostedExecution === undefined) return unavailable('hosted_execution');
    const inputRecord = record(body, 'hosted execution');
    const executionId = optionalId(inputRecord, 'executionId');
    const args = inputRecord['args'];
    if (
      args !== undefined &&
      (!Array.isArray(args) || args.some((entry) => typeof entry !== 'string'))
    )
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'args must be an array of strings');
    const payload = inputRecord['payload'];
    return {
      statusCode: 202,
      body: await hostedExecution.submit({
        ...(executionId === undefined ? {} : { executionId }),
        tenant,
        targetId: requiredId(inputRecord, 'targetId'),
        command: requiredString(inputRecord, 'command'),
        args: (args ?? []) as string[],
        resources: numericRecord(inputRecord['resources'] ?? {}, 'resources'),
        sandbox: hostedSandbox(record(inputRecord['sandbox'], 'sandbox')),
        ...(payload === undefined ? {} : { payload: jsonValue(inputRecord, 'payload') }),
      }),
    };
  }

  const executionMatch = /^\/v1\/enterprise\/executions\/([^/]+)(?:\/(terminate|observe))?$/.exec(
    path,
  );
  if (executionMatch?.[1] !== undefined) {
    if (hostedExecution === undefined) return unavailable('hosted_execution');
    const executionId = pathId(executionMatch[1], 'executionId');
    if ((executionMatch[2] === undefined || executionMatch[2] === 'observe') && method === 'GET') {
      if (executionMatch[2] === 'observe')
        return { statusCode: 200, body: await hostedExecution.observe(tenant, executionId) };
      const execution = hostedExecution.get(tenant, executionId);
      return {
        statusCode: execution === undefined ? 404 : 200,
        body: execution ?? { error: 'execution_not_found' },
      };
    }
    if (executionMatch[2] === 'terminate' && method === 'POST') {
      await hostedExecution.terminate(tenant, executionId);
      return { statusCode: 204, body: undefined };
    }
  }

  if (path === '/v1/serving/endpoints') {
    if (serving === undefined) return unavailable('serving');
    if (method === 'GET')
      return { statusCode: 200, body: { endpoints: serving.listEndpoints(tenant) } };
    if (method === 'POST') {
      const inputRecord = record(body, 'serving endpoint');
      const protocol = optionalString(inputRecord, 'protocol');
      if (protocol !== undefined && protocol !== 'http' && protocol !== 'grpc') {
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'protocol must be http or grpc');
      }
      return {
        statusCode: 201,
        body: serving.createEndpoint({
          tenant,
          name: requiredString(inputRecord, 'name'),
          modelName: requiredString(inputRecord, 'modelName'),
          ...(protocol === undefined ? {} : { protocol }),
          now,
        }),
      };
    }
  }

  const endpointMatch = /^\/v1\/serving\/endpoints\/([^/]+)$/.exec(path);
  if (endpointMatch?.[1] !== undefined) {
    if (serving === undefined) return unavailable('serving');
    if (method === 'GET') {
      const endpoint = serving.getEndpoint(tenant, pathId(endpointMatch[1], 'endpointId'));
      return {
        statusCode: endpoint === undefined ? 404 : 200,
        body: endpoint ?? { error: 'endpoint_not_found' },
      };
    }
  }

  const endpointDeploymentsMatch = /^\/v1\/serving\/endpoints\/([^/]+)\/deployments$/.exec(path);
  if (endpointDeploymentsMatch?.[1] !== undefined) {
    if (serving === undefined) return unavailable('serving');
    const endpointId = pathId(endpointDeploymentsMatch[1], 'endpointId');
    if (method === 'GET')
      return { statusCode: 200, body: { deployments: serving.listRevisions(tenant, endpointId) } };
    if (method === 'POST') {
      const inputRecord = record(body, 'serving deployment');
      return {
        statusCode: 202,
        body: serving.requestDeployment({
          tenant,
          endpointId,
          modelVersionId: requiredId(inputRecord, 'modelVersionId'),
          manifest: jsonValue(inputRecord, 'manifest'),
          now,
        }),
      };
    }
  }

  const deploymentMatch = /^\/v1\/serving\/deployments\/([^/]+)$/.exec(path);
  if (deploymentMatch?.[1] !== undefined && method === 'GET') {
    if (serving === undefined) return unavailable('serving');
    const deployment = serving.getRevision(tenant, pathId(deploymentMatch[1], 'deploymentId'));
    return {
      statusCode: deployment === undefined ? 404 : 200,
      body: deployment ?? { error: 'deployment_not_found' },
    };
  }

  const deploymentActionMatch = /^\/v1\/serving\/deployments\/([^/]+)\/actions$/.exec(path);
  if (deploymentActionMatch?.[1] !== undefined && method === 'POST') {
    if (serving === undefined) return unavailable('serving');
    const inputRecord = record(body, 'deployment action');
    const approvalValue = inputRecord['approval'];
    return {
      statusCode: 200,
      body: serving.advance(
        tenant,
        pathId(deploymentActionMatch[1], 'deploymentId'),
        action(inputRecord['action']),
        approvalValue === undefined ? undefined : approval(approvalValue),
      ),
    };
  }

  const deploymentHealthMatch = /^\/v1\/serving\/deployments\/([^/]+)\/health$/.exec(path);
  if (deploymentHealthMatch?.[1] !== undefined && method === 'POST') {
    if (serving === undefined) return unavailable('serving');
    const inputRecord = record(body, 'deployment health');
    const observedAt = optionalString(inputRecord, 'observedAt');
    const error = optionalString(inputRecord, 'error');
    const observation: ServingHealthObservation = {
      healthy: boolean(inputRecord, 'healthy'),
      ...(observedAt === undefined ? {} : { observedAt }),
      ...(error === undefined ? {} : { error }),
    };
    return {
      statusCode: 200,
      body: serving.observeHealth(
        tenant,
        pathId(deploymentHealthMatch[1], 'deploymentId'),
        observation,
      ),
    };
  }

  const deploymentRollbackMatch =
    /^\/v1\/serving\/deployments\/([^/]+)\/rollback-if-unhealthy$/.exec(path);
  if (deploymentRollbackMatch?.[1] !== undefined && method === 'POST') {
    if (serving === undefined) return unavailable('serving');
    const inputRecord = record(body, 'deployment rollback');
    return {
      statusCode: 200,
      body: serving.automaticRollbackIfUnhealthy(
        tenant,
        pathId(deploymentRollbackMatch[1], 'deploymentId'),
        approval(inputRecord['approval']),
      ),
    };
  }

  if (path === '/v1/scoped-budgets') {
    if (budgets === undefined) return unavailable('scoped_budget');
    if (method === 'GET')
      return { statusCode: 200, body: { budgets: budgets.listBudgets(tenant) } };
    if (method === 'POST') {
      return {
        statusCode: 201,
        body: budgets.createBudget(requestBudgetDefinition(record(body, 'budget'), tenant, now)),
      };
    }
  }

  if (path === '/v1/scoped-budgets/alerts' && method === 'GET') {
    if (budgets === undefined) return unavailable('scoped_budget');
    return { statusCode: 200, body: { alerts: budgets.alerts(tenant) } };
  }

  if (path === '/v1/scoped-budgets/policies' && method === 'POST') {
    if (budgets === undefined) return unavailable('scoped_budget');
    return {
      statusCode: 201,
      body: budgets.setPolicy(requestCostPolicy(record(body, 'cost policy'), tenant)),
    };
  }

  const budgetMatch = /^\/v1\/scoped-budgets\/([^/]+)$/.exec(path);
  if (budgetMatch?.[1] !== undefined && method === 'GET') {
    if (budgets === undefined) return unavailable('scoped_budget');
    const budgetId = pathId(budgetMatch[1], 'budgetId');
    return { statusCode: 200, body: budgets.snapshot(tenant, budgetId) };
  }

  const budgetReservationMatch = /^\/v1\/scoped-budgets\/([^/]+)\/reservations$/.exec(path);
  if (budgetReservationMatch?.[1] !== undefined && method === 'POST') {
    if (budgets === undefined) return unavailable('scoped_budget');
    const inputRecord = record(body, 'budget reservation');
    const amount = money(inputRecord, 'amount');
    const reservationId = optionalId(inputRecord, 'reservationId');
    return {
      statusCode: 201,
      body: await budgets.reserve({
        tenant,
        budgetId: pathId(budgetReservationMatch[1], 'budgetId'),
        invocationId: requiredId(inputRecord, 'invocationId'),
        category: budgetCategory(inputRecord['category']),
        amount,
        ...(reservationId === undefined ? {} : { reservationId }),
        now,
      }),
    };
  }

  const reservationActionMatch =
    /^\/v1\/scoped-reservations\/([^/]+)\/(consume|reconcile|release)$/.exec(path);
  if (
    reservationActionMatch?.[1] !== undefined &&
    reservationActionMatch[2] !== undefined &&
    method === 'POST'
  ) {
    if (budgets === undefined) return unavailable('scoped_budget');
    const inputRecord = record(body, 'reservation action');
    const reservationId = pathId(reservationActionMatch[1], 'reservationId');
    if (reservationActionMatch[2] === 'release') {
      return { statusCode: 200, body: await budgets.release({ tenant, reservationId, now }) };
    }
    const amount = money(
      inputRecord,
      reservationActionMatch[2] === 'consume' ? 'amount' : 'actual',
    );
    const result: Promise<ScopedReservationRecord> =
      reservationActionMatch[2] === 'consume'
        ? budgets.consume({ tenant, reservationId, amount, now })
        : budgets.reconcile({ tenant, reservationId, actual: amount, now });
    return { statusCode: 200, body: await result };
  }

  if (path === '/v1/cost/estimate' && method === 'POST') {
    if (budgets === undefined) return unavailable('scoped_budget');
    const inputRecord = record(body, 'cost estimate');
    const requests = optionalInteger(inputRecord, 'requests', true);
    const request: ModelCostEstimateInput = {
      tenant,
      providerId: requiredString(inputRecord, 'providerId'),
      modelId: requiredString(inputRecord, 'modelId'),
      inputTokens: integer(inputRecord, 'inputTokens'),
      outputTokens: integer(inputRecord, 'outputTokens'),
      ...(requests === undefined ? {} : { requests }),
      currency: requiredString(inputRecord, 'currency') as ModelCostEstimateInput['currency'],
    };
    return { statusCode: 200, body: budgets.estimateModelCost(request) };
  }

  if (path === '/v1/cost/policy-check' && method === 'POST') {
    if (budgets === undefined) return unavailable('scoped_budget');
    const inputRecord = record(body, 'cost policy check');
    const retryAttempts = optionalInteger(inputRecord, 'retryAttempts');
    return {
      statusCode: 200,
      body: budgets.checkModelPolicy({
        tenant,
        providerId: requiredString(inputRecord, 'providerId'),
        modelId: requiredString(inputRecord, 'modelId'),
        estimatedCost: money(inputRecord, 'estimatedCost'),
        ...(retryAttempts === undefined ? {} : { retryAttempts }),
      }),
    };
  }

  if (path === '/v1/agent-definitions' && method === 'GET') {
    if (agents === undefined) return unavailable('agent_router');
    return { statusCode: 200, body: { definitions: agents.list() } };
  }

  if (path === '/v1/agent-definitions/resolve' && method === 'POST') {
    if (agents === undefined) return unavailable('agent_router');
    const inputRecord = record(body, 'agent routing request');
    const dataClass = optionalString(inputRecord, 'dataClass');
    const modelProvider = optionalString(inputRecord, 'modelProvider');
    const preferredAgentType = optionalString(inputRecord, 'preferredAgentType');
    const includeShadow = optionalBoolean(inputRecord, 'includeShadow');
    const request: AgentRoutingRequest = {
      ...(inputRecord as unknown as AgentRoutingRequest),
      tenant,
      taskShape: requiredString(inputRecord, 'taskShape'),
      tier: integer(inputRecord, 'tier') as AgentRoutingRequest['tier'],
      cohortKey: requiredString(inputRecord, 'cohortKey'),
      ...(inputRecord['requiredCapabilities'] === undefined
        ? {}
        : { requiredCapabilities: stringArray(inputRecord, 'requiredCapabilities') }),
      ...(dataClass === undefined ? {} : { dataClass }),
      ...(modelProvider === undefined ? {} : { modelProvider }),
      ...(preferredAgentType === undefined ? {} : { preferredAgentType }),
      ...(includeShadow === undefined ? {} : { includeShadow }),
    };
    return { statusCode: 200, body: agents.resolve(request) };
  }

  const agentRolloutMatch = /^\/v1\/agent-definitions\/([^/]+)\/([^/]+)\/(rollout|rollback)$/.exec(
    path,
  );
  if (
    agentRolloutMatch?.[1] !== undefined &&
    agentRolloutMatch[2] !== undefined &&
    method === 'POST'
  ) {
    if (agents === undefined) return unavailable('agent_router');
    const agentType = decodeURIComponent(agentRolloutMatch[1]);
    const version = decodeURIComponent(agentRolloutMatch[2]);
    if (agentRolloutMatch[3] === 'rollback') {
      return { statusCode: 200, body: agents.rollback(agentType, version) };
    }
    const inputRecord = record(body, 'agent rollout');
    return {
      statusCode: 200,
      body: agents.updateRollout(agentType, version, {
        stage: requiredString(inputRecord, 'stage') as AgentDefinitionV1['rollout']['stage'],
        percentage: integer(inputRecord, 'percentage'),
        cohortSalt: requiredString(inputRecord, 'cohortSalt'),
      }),
    };
  }

  if (path === '/v1/agent-invocations' && method === 'POST') {
    if (agents === undefined) return unavailable('agent_router');
    const inputRecord = record(body, 'agent invocation');
    return {
      statusCode: 201,
      body: agents.begin(tenant, {
        agentType: requiredString(inputRecord, 'agentType'),
        version: requiredString(inputRecord, 'version'),
      }),
    };
  }

  const agentLeaseMatch = /^\/v1\/agent-invocations\/([^/]+)\/finish$/.exec(path);
  if (agentLeaseMatch?.[1] !== undefined && method === 'POST') {
    if (agents === undefined) return unavailable('agent_router');
    agents.finish(pathId(agentLeaseMatch[1], 'leaseId'), now);
    return { statusCode: 204, body: undefined };
  }

  if (path === '/v1/recovery/backups') {
    if (recovery === undefined) return unavailable('recovery');
    if (method === 'GET') return { statusCode: 200, body: { backups: recovery.list(tenant) } };
    if (method === 'POST') {
      const inputRecord = record(body, 'backup');
      return {
        statusCode: 201,
        body: recovery.createBackup({
          tenant,
          snapshot: jsonValue(inputRecord, 'snapshot'),
          schemaVersion: requiredString(inputRecord, 'schemaVersion'),
          eventCursor: integer(inputRecord, 'eventCursor'),
          encryptionKeyId: requiredString(inputRecord, 'encryptionKeyId'),
          retentionUntil: requiredString(inputRecord, 'retentionUntil'),
          now,
        }),
      };
    }
  }

  const backupMatch = /^\/v1\/recovery\/backups\/([^/]+)$/.exec(path);
  if (backupMatch?.[1] !== undefined && method === 'GET') {
    if (recovery === undefined) return unavailable('recovery');
    const backupId = pathId(backupMatch[1], 'backupId');
    const backup = recovery.get(tenant, backupId);
    return {
      statusCode: backup === undefined ? 404 : 200,
      body: backup ?? { error: 'backup_not_found' },
    };
  }

  const backupActionMatch =
    /^\/v1\/recovery\/backups\/([^/]+)\/(verify|preview|restore|exercise)$/.exec(path);
  if (
    backupActionMatch?.[1] !== undefined &&
    backupActionMatch[2] !== undefined &&
    method === 'POST'
  ) {
    if (recovery === undefined) return unavailable('recovery');
    const backupId = pathId(backupActionMatch[1], 'backupId');
    const inputRecord = record(body, 'backup action');
    if (backupActionMatch[2] === 'verify')
      return { statusCode: 200, body: recovery.verify(tenant, backupId, now) };
    if (backupActionMatch[2] === 'preview') {
      return { statusCode: 200, body: recovery.previewRestore({ tenant, backupId, now }) };
    }
    if (backupActionMatch[2] === 'exercise') {
      return { statusCode: 200, body: recovery.runExercise({ tenant, backupId, now }) };
    }
    const allowOverwrite = optionalBoolean(inputRecord, 'allowOverwrite');
    return {
      statusCode: 200,
      body: recovery.restore({
        tenant,
        backupId,
        approvalDigest: requiredString(inputRecord, 'approvalDigest'),
        ...(allowOverwrite === undefined ? {} : { allowOverwrite }),
        now,
      }),
    };
  }

  if (path === '/v1/recovery/audit' && method === 'GET') {
    if (recovery === undefined) return unavailable('recovery');
    return {
      statusCode: recovery.auditRecords === undefined ? 501 : 200,
      body:
        recovery.auditRecords === undefined
          ? { error: 'recovery_audit_not_configured' }
          : { records: recovery.auditRecords(tenant) },
    };
  }

  if (path === '/v1/recovery/retention/evaluate' && method === 'POST') {
    if (recovery === undefined) return unavailable('recovery');
    if (recovery.evaluateRetention === undefined) return unavailable('retention');
    const inputRecord = record(body, 'retention evaluation');
    const backupId = requiredId(inputRecord, 'backupId');
    const backup = recovery.get(tenant, backupId);
    if (backup === undefined) return { statusCode: 404, body: { error: 'backup_not_found' } };
    const policy: RetentionPolicyV1 = {
      policyId: requiredId(inputRecord, 'policyId'),
      tenant,
      version: requiredString(inputRecord, 'version'),
      retentionDays: integer(inputRecord, 'retentionDays', true),
      legalHold: boolean(inputRecord, 'legalHold'),
      createdAt: optionalString(inputRecord, 'createdAt') ?? now,
    };
    return {
      statusCode: 200,
      body: { decision: recovery.evaluateRetention(policy, backup, now), policy, backupId },
    };
  }

  if (path === '/v1/collaboration/documents' && method === 'POST') {
    if (collaboration === undefined) return unavailable('collaboration');
    const inputRecord = record(body, 'collaboration document');
    return {
      statusCode: 201,
      body: collaboration.open({
        tenant,
        resourceType: requiredString(inputRecord, 'resourceType'),
        resourceId: requiredId(inputRecord, 'resourceId'),
        ...(inputRecord['initialValue'] === undefined
          ? {}
          : { initialValue: jsonValue(inputRecord, 'initialValue') }),
        actor: requireActor(actor),
        now,
      }),
    };
  }

  const collaborationDocumentMatch = /^\/v1\/collaboration\/documents\/([^/]+)$/.exec(path);
  if (collaborationDocumentMatch?.[1] !== undefined) {
    if (collaboration === undefined) return unavailable('collaboration');
    const documentId = pathId(collaborationDocumentMatch[1], 'documentId');
    if (method === 'GET') return { statusCode: 200, body: collaboration.read(tenant, documentId) };
    if (method === 'PUT') {
      const inputRecord = record(body, 'collaboration document update');
      const result: CollaborationWriteResult = collaboration.write({
        tenant,
        documentId,
        expectedVersion: integer(inputRecord, 'expectedVersion'),
        value: jsonValue(inputRecord, 'value'),
        actor: requireActor(actor),
        now,
      });
      return { statusCode: result.status === 'conflict' ? 409 : 200, body: result };
    }
  }

  const presenceMatch = /^\/v1\/collaboration\/documents\/([^/]+)\/presence$/.exec(path);
  if (presenceMatch?.[1] !== undefined) {
    if (collaboration === undefined) return unavailable('collaboration');
    const documentId = pathId(presenceMatch[1], 'documentId');
    if (method === 'GET')
      return {
        statusCode: 200,
        body: { presence: collaboration.listPresence(tenant, documentId, now) },
      };
    if (method === 'POST') {
      const inputRecord = record(body, 'collaboration presence');
      const state = requiredString(inputRecord, 'state');
      if (state !== 'active' && state !== 'idle') {
        throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'state must be active or idle');
      }
      const ttlMs = optionalInteger(inputRecord, 'ttlMs', true);
      return {
        statusCode: 200,
        body: collaboration.updatePresence({
          tenant,
          documentId,
          actor: requireActor(actor),
          state,
          ...(inputRecord['cursor'] === undefined
            ? {}
            : { cursor: jsonValue(inputRecord, 'cursor') }),
          ...(ttlMs === undefined ? {} : { ttlMs }),
          now,
        }),
      };
    }
  }

  const conflictsMatch = /^\/v1\/collaboration\/documents\/([^/]+)\/conflicts$/.exec(path);
  if (conflictsMatch?.[1] !== undefined && method === 'GET') {
    if (collaboration === undefined) return unavailable('collaboration');
    return {
      statusCode: 200,
      body: {
        conflicts: collaboration.conflicts(tenant, pathId(conflictsMatch[1], 'documentId')),
      },
    };
  }

  return undefined;
}
