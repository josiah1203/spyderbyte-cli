import {
  isId,
  isJsonValue,
  runtimeError,
  type Actor,
  type Id,
  type JsonValue,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import type {
  EnterpriseAccessRequestV1,
  EnterpriseAttributeConditionsV1,
  EnterpriseComplianceProfile,
  EnterpriseControlPlane,
  EnterpriseDataBucket,
  EnterpriseDeploymentMode,
  EnterpriseExportCategory,
  EnterprisePrincipalType,
  EnterpriseRole,
  EnterpriseRoleScopeV1,
  EnterpriseRunnerKind,
} from '@agentic-platform/backends';

export interface EnterpriseApiRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly tenant: TenantRef;
  readonly actor?: Actor;
  readonly now: string;
}

export interface EnterpriseApiResponse {
  readonly statusCode: number;
  readonly body: unknown;
}

type EnterpriseProfileRequest = Omit<
  Parameters<EnterpriseControlPlane['registerProfile']>[0],
  'tenant' | 'createdBy'
>;

const CONTROL_PLANE_PREFIX = '/v1/enterprise/control-plane';

function record(value: unknown, label: string): Record<string, unknown> {
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

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${key} must be a non-empty string`);
  }
  return value.trim();
}

function requiredId(input: Record<string, unknown>, key: string): Id {
  const value = requiredString(input, key);
  if (!isId(value)) throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${key} must be a UUIDv7 id`);
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

function requiredBoolean(input: Record<string, unknown>, key: string): boolean {
  const value = input[key];
  if (typeof value !== 'boolean')
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${key} must be a boolean`);
  return value;
}

function optionalBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean')
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${key} must be a boolean`);
  return value;
}

function requiredInteger(input: Record<string, unknown>, key: string, positive = false): number {
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

function stringArray(
  input: Record<string, unknown>,
  key: string,
  optional = false,
): string[] | undefined {
  const value = input[key];
  if (value === undefined && optional) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)
  ) {
    throw runtimeError(
      'VALIDATION_SCHEMA_MISMATCH',
      `${key} must be an array of non-empty strings`,
    );
  }
  return value.map((entry) => String(entry).trim());
}

function jsonValue(input: Record<string, unknown>, key: string): JsonValue {
  const value = input[key];
  if (!isJsonValue(value)) throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${key} must be JSON`);
  return value;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', `${label} is invalid`);
  }
  return value as T;
}

function actorRequired(actor: Actor | undefined): Actor {
  if (actor === undefined)
    throw runtimeError('AUTHORITY_MISSING', 'Enterprise API requires an authenticated actor');
  return actor;
}

function profileInput(input: Record<string, unknown>): EnterpriseProfileRequest {
  const residency = record(input['residency'], 'residency');
  const keyValue = input['customerManagedKey'];
  const key = keyValue === undefined ? undefined : record(keyValue, 'customerManagedKey');
  const allowedDeploymentModes = stringArray(input, 'allowedDeploymentModes', true)?.map((value) =>
    enumValue(
      value,
      ['hosted', 'private_kubernetes', 'customer_cloud', 'on_premise'] as const,
      'allowedDeploymentModes',
    ),
  );
  const allowedDataClasses =
    stringArray(residency, 'allowedDataClasses')?.map((value) =>
      enumValue(
        value,
        ['public', 'internal', 'confidential', 'restricted'] as const,
        'allowedDataClasses',
      ),
    ) ?? [];
  return {
    name: requiredString(input, 'name'),
    deploymentMode: enumValue(
      input['deploymentMode'],
      ['hosted', 'private_kubernetes', 'customer_cloud', 'on_premise'] as const,
      'deploymentMode',
    ),
    ...(allowedDeploymentModes === undefined ? {} : { allowedDeploymentModes }),
    complianceProfile: enumValue(
      input['complianceProfile'],
      ['commercial', 'fedramp_moderate', 'fedramp_high', 'government'] as const,
      'complianceProfile',
    ),
    residency: {
      homeRegion: requiredString(residency, 'homeRegion'),
      allowedRegions: stringArray(residency, 'allowedRegions') ?? [],
      blockedRegions: stringArray(residency, 'blockedRegions') ?? [],
      noCrossRegionReplication: requiredBoolean(residency, 'noCrossRegionReplication'),
      allowedDataClasses,
      requireCustomerManagedKey: requiredBoolean(residency, 'requireCustomerManagedKey'),
      retentionDays: requiredInteger(residency, 'retentionDays', true),
      policyVersion: requiredString(residency, 'policyVersion'),
    },
    ...(key === undefined
      ? {}
      : {
          customerManagedKey: {
            keyId: requiredString(key, 'keyId'),
            provider: enumValue(
              key['provider'],
              ['aws_kms', 'azure_key_vault', 'gcp_kms', 'government_hsm', 'customer'] as const,
              'customerManagedKey.provider',
            ),
            keyUri: requiredString(key, 'keyUri'),
            region: requiredString(key, 'region'),
            rotationVersion: requiredString(key, 'rotationVersion'),
          },
        }),
  };
}

function roleScope(input: Record<string, unknown>): EnterpriseRoleScopeV1 {
  const workspaceId = optionalId(input, 'workspaceId');
  const projectId = optionalId(input, 'projectId');
  const region = optionalString(input, 'region');
  return {
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(region === undefined ? {} : { region }),
  };
}

function conditions(input: unknown): EnterpriseAttributeConditionsV1 | undefined {
  if (input === undefined) return undefined;
  const value = record(input, 'conditions');
  const groups = stringArray(value, 'groups', true);
  const environments = stringArray(value, 'environments', true);
  const regions = stringArray(value, 'regions', true);
  const dataClasses = stringArray(value, 'dataClasses', true)?.map((entry) =>
    enumValue(
      entry,
      ['public', 'internal', 'confidential', 'restricted'] as const,
      'conditions.dataClasses',
    ),
  );
  return {
    ...(groups === undefined ? {} : { groups }),
    ...(environments === undefined ? {} : { environments }),
    ...(regions === undefined ? {} : { regions }),
    ...(dataClasses === undefined ? {} : { dataClasses }),
  };
}

function categoryArray(
  input: Record<string, unknown>,
  key: string,
): EnterpriseDataBucket[] | undefined {
  return stringArray(input, key, true)?.map((entry) =>
    enumValue(
      entry,
      [
        'authoritative',
        'artifacts',
        'events',
        'outbox',
        'projections',
        'audit',
        'connector_handles',
        'backups',
      ] as const,
      key,
    ),
  );
}

function exportCategories(input: Record<string, unknown>): EnterpriseExportCategory[] | undefined {
  return stringArray(input, 'categories', true)?.map((entry) =>
    enumValue(
      entry,
      [
        'authoritative',
        'artifacts',
        'events',
        'outbox',
        'projections',
        'audit',
        'connector_handles',
        'backups',
        'identity',
        'governance',
      ] as const,
      'categories',
    ),
  );
}

export async function handleEnterpriseRequest(
  input: EnterpriseApiRequest,
  controlPlane: EnterpriseControlPlane | undefined,
): Promise<EnterpriseApiResponse | undefined> {
  if (!input.path.startsWith(CONTROL_PLANE_PREFIX)) return undefined;
  if (controlPlane === undefined)
    return { statusCode: 501, body: { error: 'enterprise_control_plane_not_configured' } };
  const actor = actorRequired(input.actor);
  const method = input.method.toUpperCase();
  const path = input.path;

  if (path === `${CONTROL_PLANE_PREFIX}/profile`) {
    if (method === 'GET')
      return {
        statusCode: 200,
        body: controlPlane.getProfile(input.tenant) ?? { error: 'enterprise_profile_not_found' },
      };
    if (method === 'POST') {
      const body = profileInput(record(input.body, 'enterprise profile'));
      return {
        statusCode: 201,
        body: controlPlane.registerProfile({
          ...body,
          tenant: input.tenant,
          createdBy: actor,
          now: input.now,
        }),
      };
    }
  }

  if (path === `${CONTROL_PLANE_PREFIX}/service-accounts`) {
    if (method === 'GET')
      return {
        statusCode: 200,
        body: { serviceAccounts: controlPlane.listServiceAccounts(input.tenant) },
      };
    if (method === 'POST') {
      const body = record(input.body, 'service account');
      const scopes = stringArray(body, 'scopes') ?? [];
      const serviceRoles = (stringArray(body, 'roles') ?? []).map((entry) =>
        enumValue(
          entry,
          [
            'enterprise_owner',
            'security_admin',
            'platform_admin',
            'operator',
            'auditor',
            'support',
            'viewer',
          ] as const,
          'roles',
        ),
      );
      const expiresAt = optionalString(body, 'expiresAt');
      return {
        statusCode: 201,
        body: controlPlane.issueServiceAccount({
          tenant: input.tenant,
          name: requiredString(body, 'name'),
          scopes,
          roles: serviceRoles,
          createdBy: actor,
          ...(expiresAt === undefined ? {} : { expiresAt }),
          now: input.now,
        }),
      };
    }
  }

  const serviceAccountAction = new RegExp(
    `^${CONTROL_PLANE_PREFIX}/service-accounts/([^/]+)/(rotate|revoke)$`,
  ).exec(path);
  if (
    serviceAccountAction?.[1] !== undefined &&
    serviceAccountAction[2] !== undefined &&
    method === 'POST'
  ) {
    if (!isId(serviceAccountAction[1]))
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'accountId must be a UUIDv7 id');
    if (serviceAccountAction[2] === 'rotate') {
      return {
        statusCode: 200,
        body: controlPlane.rotateServiceAccount({
          tenant: input.tenant,
          accountId: serviceAccountAction[1],
          rotatedBy: actor,
          now: input.now,
        }),
      };
    }
    return {
      statusCode: 200,
      body: controlPlane.revokeServiceAccount({
        tenant: input.tenant,
        accountId: serviceAccountAction[1],
        revokedBy: actor,
        now: input.now,
      }),
    };
  }

  if (path === `${CONTROL_PLANE_PREFIX}/policy/bindings`) {
    if (method === 'GET')
      return { statusCode: 200, body: { bindings: controlPlane.listRoleBindings(input.tenant) } };
    if (method === 'POST') {
      const body = record(input.body, 'enterprise role binding');
      const scopeValue = body['scope'];
      const scope = scopeValue === undefined ? undefined : roleScope(record(scopeValue, 'scope'));
      const parsedConditions = conditions(body['conditions']);
      return {
        statusCode: 201,
        body: controlPlane.bindRole({
          tenant: input.tenant,
          principalId: requiredId(body, 'principalId'),
          principalType: enumValue(
            body['principalType'],
            ['human', 'service_account'] as const,
            'principalType',
          ),
          role: enumValue(
            body['role'],
            [
              'enterprise_owner',
              'security_admin',
              'platform_admin',
              'operator',
              'auditor',
              'support',
              'viewer',
            ] as const,
            'role',
          ),
          ...(scope === undefined ? {} : { scope }),
          ...(parsedConditions === undefined ? {} : { conditions: parsedConditions }),
          createdBy: actor,
          now: input.now,
        }),
      };
    }
  }

  if (path === `${CONTROL_PLANE_PREFIX}/policy/evaluate` && method === 'POST') {
    const body = record(input.body, 'enterprise policy evaluation');
    const context = record(body['context'], 'context');
    const principal = record(body['principal'], 'principal');
    const groups = stringArray(principal, 'groups', true);
    const workspaceId = optionalId(context, 'workspaceId');
    const projectId = optionalId(context, 'projectId');
    const network = optionalString(context, 'network');
    const accessRequest: EnterpriseAccessRequestV1 = {
      tenant: input.tenant,
      principal: {
        principalId: requiredId(principal, 'principalId'),
        principalType: enumValue(
          principal['principalType'],
          ['human', 'service_account'] as const,
          'principalType',
        ),
        ...(groups === undefined ? {} : { groups }),
      },
      action: requiredString(body, 'action'),
      resourceKind: requiredString(body, 'resourceKind'),
      resourceId: requiredString(body, 'resourceId'),
      context: {
        region: requiredString(context, 'region'),
        dataClassification: enumValue(
          context['dataClassification'],
          ['public', 'internal', 'confidential', 'restricted'] as const,
          'dataClassification',
        ),
        environment: requiredString(context, 'environment'),
        ...(workspaceId === undefined ? {} : { workspaceId }),
        ...(projectId === undefined ? {} : { projectId }),
        ...(network === undefined
          ? {}
          : { network: enumValue(network, ['private', 'public'] as const, 'network') }),
      },
    };
    return { statusCode: 200, body: controlPlane.authorize(accessRequest, input.now) };
  }

  if (path === `${CONTROL_PLANE_PREFIX}/runners`) {
    if (method === 'GET')
      return { statusCode: 200, body: { runners: controlPlane.listRunners(input.tenant) } };
    if (method === 'POST') {
      const body = record(input.body, 'enterprise runner');
      const enabled = optionalBoolean(body, 'enabled');
      const customerOwned = requiredBoolean(body, 'customerOwned');
      const privateNetwork = requiredBoolean(body, 'privateNetwork');
      const approvalReference = optionalString(body, 'approvalReference');
      const runnerId = optionalId(body, 'runnerId');
      return {
        statusCode: 201,
        body: controlPlane.registerRunner({
          tenant: input.tenant,
          kind: enumValue(
            body['kind'],
            [
              'private_kubernetes',
              'on_premise',
              'customer_cloud',
              'hosted_kubernetes',
              'slurm',
            ] as const,
            'kind',
          ),
          region: requiredString(body, 'region'),
          adapterSetId: requiredId(body, 'adapterSetId'),
          capabilities: stringArray(body, 'capabilities') ?? [],
          customerOwned,
          privateNetwork,
          ...(enabled === undefined ? {} : { enabled }),
          ...(approvalReference === undefined ? {} : { approvalReference }),
          registeredBy: actor,
          ...(runnerId === undefined ? {} : { runnerId }),
          now: input.now,
        }),
      };
    }
  }

  if (path === `${CONTROL_PLANE_PREFIX}/adapters` && method === 'GET') {
    return { statusCode: 200, body: { adapters: controlPlane.listAdapterSets(input.tenant) } };
  }

  if (path === `${CONTROL_PLANE_PREFIX}/runs` && method === 'POST') {
    const body = record(input.body, 'enterprise run');
    return {
      statusCode: 200,
      body: await controlPlane.run({
        schemaVersion: 1,
        runId: requiredId(body, 'runId'),
        tenant: input.tenant,
        actor,
        requestedAction: requiredString(body, 'requestedAction'),
        modelId: requiredString(body, 'modelId'),
        prompt: requiredString(body, 'prompt'),
        maxOutputTokens: requiredInteger(body, 'maxOutputTokens', true),
        outputMediaType: requiredString(body, 'outputMediaType'),
        dataClassification: enumValue(
          body['dataClassification'],
          ['public', 'internal', 'confidential', 'restricted'] as const,
          'dataClassification',
        ),
        environment: requiredString(body, 'environment'),
        region: requiredString(body, 'region'),
        adapterSetId: requiredId(body, 'adapterSetId'),
        runnerId: requiredId(body, 'runnerId'),
        idempotencyKey: requiredString(body, 'idempotencyKey'),
      }),
    };
  }

  if (path === `${CONTROL_PLANE_PREFIX}/legal-holds` && method === 'POST') {
    const body = record(input.body, 'legal hold');
    const categories = categoryArray(body, 'categories');
    return {
      statusCode: 201,
      body: await controlPlane.createLegalHold({
        tenant: input.tenant,
        matterReference: requiredString(body, 'matterReference'),
        reason: requiredString(body, 'reason'),
        ...(categories === undefined ? {} : { categories }),
        createdBy: actor,
        now: input.now,
      }),
    };
  }

  if (path === `${CONTROL_PLANE_PREFIX}/legal-holds` && method === 'GET')
    return { statusCode: 200, body: { holds: controlPlane.listLegalHolds(input.tenant) } };
  const releaseHold = new RegExp(`^${CONTROL_PLANE_PREFIX}/legal-holds/([^/]+)/release$`).exec(
    path,
  );
  if (releaseHold?.[1] !== undefined && method === 'POST')
    return {
      statusCode: 200,
      body: controlPlane.releaseLegalHold({
        tenant: input.tenant,
        holdId: releaseHold[1] as Id,
        releasedBy: actor,
        now: input.now,
      }),
    };

  if (path === `${CONTROL_PLANE_PREFIX}/deletions` && method === 'POST') {
    const body = record(input.body, 'deletion request');
    return {
      statusCode: 202,
      body: await controlPlane.requestDeletion({
        tenant: input.tenant,
        reason: requiredString(body, 'reason'),
        batchSize: requiredInteger(body, 'batchSize', true),
        requestedBy: actor,
        now: input.now,
      }),
    };
  }
  const deletionAction = new RegExp(
    `^${CONTROL_PLANE_PREFIX}/deletions/([^/]+)/(approve|execute)$`,
  ).exec(path);
  if (
    deletionAction?.[1] !== undefined &&
    deletionAction[2] !== undefined &&
    isId(deletionAction[1]) &&
    method === 'POST'
  ) {
    if (deletionAction[2] === 'approve')
      return {
        statusCode: 200,
        body: controlPlane.approveDeletion({
          tenant: input.tenant,
          deletionId: deletionAction[1],
          approvedBy: actor,
          now: input.now,
        }),
      };
    return {
      statusCode: 200,
      body: await controlPlane.executeDeletion({
        tenant: input.tenant,
        deletionId: deletionAction[1],
        now: input.now,
      }),
    };
  }

  if (path === `${CONTROL_PLANE_PREFIX}/exports` && method === 'POST') {
    const body = record(input.body, 'enterprise export');
    const categories = exportCategories(body);
    const rawRecords = body['records'];
    const recordsValue = rawRecords === undefined ? undefined : record(rawRecords, 'records');
    const records =
      recordsValue === undefined
        ? undefined
        : (Object.fromEntries(
            Object.entries(recordsValue).map(([key, value]) => {
              if (!isJsonValue(value))
                throw runtimeError(
                  'VALIDATION_SCHEMA_MISMATCH',
                  `Export record ${key} must be JSON`,
                );
              return [key, value];
            }),
          ) as Partial<Record<EnterpriseExportCategory, JsonValue>>);
    return {
      statusCode: 201,
      body: await controlPlane.createExport({
        tenant: input.tenant,
        requestedBy: actor,
        ...(categories === undefined ? {} : { categories }),
        ...(records === undefined ? {} : { records }),
        now: input.now,
      }),
    };
  }

  if (path === `${CONTROL_PLANE_PREFIX}/support-bundles` && method === 'POST') {
    const body = record(input.body, 'support bundle');
    return {
      statusCode: 201,
      body: await controlPlane.createSupportBundle({
        tenant: input.tenant,
        requestedBy: actor,
        diagnostics: jsonValue(body, 'diagnostics'),
        now: input.now,
      }),
    };
  }

  if (path === `${CONTROL_PLANE_PREFIX}/government/commitments`) {
    if (method === 'GET')
      return {
        statusCode: 200,
        body: controlPlane.getGovernmentCommitments(input.tenant) ?? {
          error: 'government_commitments_not_found',
        },
      };
    if (method === 'POST') {
      const body = record(input.body, 'government commitments');
      return {
        statusCode: 200,
        body: controlPlane.setGovernmentCommitments({
          tenant: input.tenant,
          serviceHours: enumValue(
            body['serviceHours'],
            ['24x7', 'business_hours'] as const,
            'serviceHours',
          ),
          supportResponseMinutes: requiredInteger(body, 'supportResponseMinutes'),
          incidentNoticeHours: requiredInteger(body, 'incidentNoticeHours'),
          recoveryPointObjectiveMinutes: requiredInteger(body, 'recoveryPointObjectiveMinutes'),
          recoveryTimeObjectiveMinutes: requiredInteger(body, 'recoveryTimeObjectiveMinutes'),
          dataResidencyStatement: requiredString(body, 'dataResidencyStatement'),
          changedBy: actor,
          now: input.now,
        }),
      };
    }
  }

  if (path === `${CONTROL_PLANE_PREFIX}/procurement/evidence` && method === 'GET') {
    return {
      statusCode: 200,
      body: controlPlane.generateProcurementEvidence({
        tenant: input.tenant,
        requestedBy: actor,
        now: input.now,
      }),
    };
  }

  if (path === `${CONTROL_PLANE_PREFIX}/audit` && method === 'GET') {
    return { statusCode: 200, body: { records: controlPlane.auditRecords(input.tenant) } };
  }

  return undefined;
}

export type {
  EnterpriseComplianceProfile,
  EnterpriseDeploymentMode,
  EnterprisePrincipalType,
  EnterpriseRole,
  EnterpriseRunnerKind,
};
