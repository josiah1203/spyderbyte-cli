import {
  isContract,
  runtimeError,
  type AgentRegistration,
  type AgentTier,
  type JsonValue,
} from '@agentic-platform/runtime-contracts';
import type { Harness } from './definition.js';
import { mayInvoke } from './tiers.js';

export type HarnessRegistrationStatus = 'draft' | 'active' | 'deprecated' | 'disabled';

export interface HarnessRegistrationRecord {
  readonly registration: AgentRegistration;
  readonly harness: Harness<JsonValue, JsonValue>;
  readonly permittedChildAgentTypes: readonly string[];
  readonly compatibleContracts: readonly string[];
  readonly runtimeVersions: readonly string[];
  readonly registeredAt: string;
  readonly disabledAt?: string;
}

export interface HarnessRegistrationInput<TInput extends JsonValue, TOutput extends JsonValue> {
  readonly registration: AgentRegistration;
  readonly harness: Harness<TInput, TOutput>;
  readonly permittedChildAgentTypes?: readonly string[];
  readonly compatibleContracts?: readonly string[];
  readonly runtimeVersions?: readonly string[];
  readonly registeredAt: string;
}

export interface HarnessCompatibilityRequest {
  readonly agentType: string;
  readonly version: string;
  readonly requiredContracts: readonly string[];
  readonly runtimeVersion?: string;
}

function key(agentType: string, version: string): string {
  return `${agentType}:${version}`;
}

function unique(values: readonly string[], label: string): string[] {
  if (values.some((value) => value.trim().length === 0)) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} cannot contain empty values`);
  }
  if (new Set(values).size !== values.length) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} must not contain duplicates`);
  }
  return [...values].sort();
}

function eraseHarness<TInput extends JsonValue, TOutput extends JsonValue>(
  harness: Harness<TInput, TOutput>,
): Harness<JsonValue, JsonValue> {
  return harness as unknown as Harness<JsonValue, JsonValue>;
}

function isActive(status: AgentRegistration['status']): boolean {
  return status === 'active';
}

export class HarnessRegistry {
  private readonly records = new Map<string, HarnessRegistrationRecord>();

  register<TInput extends JsonValue, TOutput extends JsonValue>(
    input: HarnessRegistrationInput<TInput, TOutput>,
  ): HarnessRegistrationRecord {
    const { registration, harness } = input;
    if (!isContract('AgentRegistration', registration)) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Harness registration failed validation');
    }
    if (
      registration.agentType !== harness.definition.identity.agentType ||
      registration.version !== harness.definition.identity.version ||
      registration.tier !== harness.definition.tier
    ) {
      throw runtimeError(
        'INVOCATION_INVALID_PARENT',
        'Harness registration does not match the executable harness identity',
      );
    }
    if (
      !registration.supportedContracts.includes('AgentInvocation.v1') ||
      !registration.supportedContracts.includes('AgentReport.v1')
    ) {
      throw runtimeError(
        'INVOCATION_INVALID_PARENT',
        'Harness registration must support invocation and report contracts',
      );
    }
    const registrationKey = key(registration.agentType, registration.version);
    if (this.records.has(registrationKey)) {
      throw runtimeError(
        'CONCURRENCY_STALE_VERSION',
        `Harness already registered: ${registrationKey}`,
      );
    }
    const pluginCapabilities = harness.definition.plugins.flatMap((plugin) => plugin.capabilities);
    if (pluginCapabilities.some((capability) => !registration.capabilities.includes(capability))) {
      throw runtimeError(
        'AUTHORITY_MISSING',
        'Harness registration does not declare every plugin capability',
      );
    }
    const permittedChildAgentTypes = unique(
      input.permittedChildAgentTypes ?? [],
      'permitted child agent types',
    );
    if (
      harness.definition.authorityPolicy.allowedChildTiers.length > 0 &&
      permittedChildAgentTypes.length === 0
    ) {
      throw runtimeError(
        'AUTHORITY_MISSING',
        'Harness child tiers require an explicit permitted child-agent list',
      );
    }
    const compatibleContracts = unique(
      input.compatibleContracts ?? registration.supportedContracts,
      'compatible contracts',
    );
    if (
      compatibleContracts.some((contract) => !registration.supportedContracts.includes(contract))
    ) {
      throw runtimeError(
        'INVOCATION_INVALID_PARENT',
        'Harness compatibility cannot exceed registered contracts',
      );
    }
    const runtimeVersions = unique(
      input.runtimeVersions ?? ['harness-runtime.v1'],
      'runtime versions',
    );
    const record: HarnessRegistrationRecord = {
      registration: structuredClone(registration),
      harness: eraseHarness(harness),
      permittedChildAgentTypes,
      compatibleContracts,
      runtimeVersions,
      registeredAt: input.registeredAt,
      ...(registration.status === 'disabled' ? { disabledAt: input.registeredAt } : {}),
    };
    this.records.set(registrationKey, record);
    return this.cloneRecord(record);
  }

  get(agentType: string, version: string): HarnessRegistrationRecord | undefined {
    const record = this.records.get(key(agentType, version));
    return record === undefined ? undefined : this.cloneRecord(record);
  }

  requireActive(agentType: string, version: string): HarnessRegistrationRecord {
    const record = this.get(agentType, version);
    if (record === undefined || !isActive(record.registration.status)) {
      throw runtimeError(
        'INVOCATION_INVALID_PARENT',
        `Harness is not active: ${agentType}:${version}`,
      );
    }
    return record;
  }

  assertCompatible(request: HarnessCompatibilityRequest): HarnessRegistrationRecord {
    const record = this.requireActive(request.agentType, request.version);
    for (const contract of request.requiredContracts) {
      if (!record.compatibleContracts.includes(contract)) {
        throw runtimeError(
          'INVOCATION_INVALID_PARENT',
          `Harness ${request.agentType}:${request.version} is incompatible with ${contract}`,
        );
      }
    }
    if (
      request.runtimeVersion !== undefined &&
      !record.runtimeVersions.includes(request.runtimeVersion)
    ) {
      throw runtimeError(
        'INVOCATION_INVALID_PARENT',
        `Harness runtime ${request.runtimeVersion} is incompatible with ${request.agentType}:${request.version}`,
      );
    }
    return record;
  }

  assertChildAllowed(
    parentAgentType: string,
    parentVersion: string,
    childAgentType: string,
    childTier: AgentTier,
  ): void {
    const parent = this.requireActive(parentAgentType, parentVersion);
    if (!parent.permittedChildAgentTypes.includes(childAgentType)) {
      throw runtimeError(
        'POLICY_DENIED',
        `Harness ${parentAgentType}:${parentVersion} cannot invoke ${childAgentType}`,
      );
    }
    if (!mayInvoke(parent.registration.tier, childTier)) {
      throw runtimeError(
        'INVOCATION_TIER_VIOLATION',
        `Tier ${parent.registration.tier} cannot invoke tier ${childTier}`,
      );
    }
    if (!parent.harness.definition.authorityPolicy.allowedChildTiers.includes(childTier)) {
      throw runtimeError(
        'INVOCATION_TIER_VIOLATION',
        `Harness ${parentAgentType}:${parentVersion} does not permit child tier ${childTier}`,
      );
    }
  }

  setStatus(
    agentType: string,
    version: string,
    status: HarnessRegistrationStatus,
    now: string,
  ): HarnessRegistrationRecord {
    const existing = this.records.get(key(agentType, version));
    if (existing === undefined) {
      throw runtimeError('INVOCATION_INVALID_PARENT', `Unknown harness: ${agentType}:${version}`);
    }
    const current = existing.registration.status;
    const allowed =
      (current === 'draft' && (status === 'active' || status === 'disabled')) ||
      (current === 'active' && (status === 'deprecated' || status === 'disabled')) ||
      (current === 'deprecated' && status === 'disabled');
    if (!allowed) {
      throw runtimeError(
        'CONCURRENCY_STALE_VERSION',
        `Invalid harness status transition ${current} -> ${status}`,
      );
    }
    const record: HarnessRegistrationRecord = {
      ...existing,
      registration: { ...existing.registration, status },
      ...(status === 'disabled' ? { disabledAt: now } : {}),
    };
    this.records.set(key(agentType, version), record);
    return this.cloneRecord(record);
  }

  disable(agentType: string, version: string, now: string): HarnessRegistrationRecord {
    return this.setStatus(agentType, version, 'disabled', now);
  }

  list(): HarnessRegistrationRecord[] {
    return [...this.records.values()].map((record) => this.cloneRecord(record));
  }

  private cloneRecord(record: HarnessRegistrationRecord): HarnessRegistrationRecord {
    return {
      ...record,
      registration: structuredClone(record.registration),
      permittedChildAgentTypes: [...record.permittedChildAgentTypes],
      compatibleContracts: [...record.compatibleContracts],
      runtimeVersions: [...record.runtimeVersions],
    };
  }
}

export type HarnessRegistryPort = Pick<
  HarnessRegistry,
  'requireActive' | 'assertCompatible' | 'assertChildAllowed'
>;
