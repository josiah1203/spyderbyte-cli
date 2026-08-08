export * from './routing.js';

import {
  isContract,
  newSortableId,
  runtimeError,
  type AgentRegistration,
  type AgentTier,
  type Id,
} from '@agentic-platform/runtime-contracts';

export interface AgentCompatibilityRequest {
  readonly agentType: string;
  readonly version: string;
  readonly requiredContracts: readonly string[];
}

export type AgentRegistryStatus = AgentRegistration['status'];

function registrationKey(agentType: string, version: string): string {
  return `${agentType}:${version}`;
}

export class InMemoryAgentRegistry {
  private readonly registrations = new Map<string, AgentRegistration>();

  register(registration: AgentRegistration): AgentRegistration {
    if (!isContract('AgentRegistration', registration)) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Agent registration failed validation');
    }
    const key = registrationKey(registration.agentType, registration.version);
    if (this.registrations.has(key)) {
      throw runtimeError('CONCURRENCY_STALE_VERSION', `Agent registration already exists: ${key}`);
    }
    this.registrations.set(key, structuredClone(registration));
    return structuredClone(registration);
  }

  get(agentType: string, version: string): AgentRegistration | undefined {
    const registration = this.registrations.get(registrationKey(agentType, version));
    return registration ? structuredClone(registration) : undefined;
  }

  requireActive(agentType: string, version: string): AgentRegistration {
    const registration = this.get(agentType, version);
    if (!registration || registration.status !== 'active') {
      throw runtimeError(
        'INVOCATION_INVALID_PARENT',
        `Active registration is required for ${agentType}:${version}`,
      );
    }
    return registration;
  }

  assertCompatible(request: AgentCompatibilityRequest): AgentRegistration {
    const registration = this.requireActive(request.agentType, request.version);
    if (
      request.requiredContracts.some(
        (contract) => !registration.supportedContracts.includes(contract),
      )
    ) {
      throw runtimeError(
        'INVOCATION_INVALID_PARENT',
        `Agent ${request.agentType}:${request.version} does not support the requested contract`,
      );
    }
    return registration;
  }

  assertChildAllowed(
    parentAgentType: string,
    parentVersion: string,
    childAgentType: string,
    childTier: AgentTier,
  ): void {
    const parent = this.requireActive(parentAgentType, parentVersion);
    if (!parent.capabilities.includes(`child:${childAgentType}`)) {
      throw runtimeError(
        'POLICY_DENIED',
        `Agent ${parentAgentType}:${parentVersion} cannot invoke ${childAgentType}`,
      );
    }
    const allowed = parent.tier === 0 ? childTier === 1 : parent.tier === 1 && childTier === 2;
    if (!allowed) {
      throw runtimeError(
        'INVOCATION_TIER_VIOLATION',
        `Tier ${parent.tier} cannot invoke tier ${childTier}`,
      );
    }
  }

  setStatus(agentType: string, version: string, status: AgentRegistryStatus): AgentRegistration {
    const current = this.registrations.get(registrationKey(agentType, version));
    if (current === undefined) {
      throw runtimeError('INVOCATION_INVALID_PARENT', `Unknown agent: ${agentType}:${version}`);
    }
    const allowed =
      (current.status === 'draft' && (status === 'active' || status === 'disabled')) ||
      (current.status === 'active' && (status === 'deprecated' || status === 'disabled')) ||
      (current.status === 'deprecated' && status === 'disabled');
    if (!allowed) {
      throw runtimeError(
        'CONCURRENCY_STALE_VERSION',
        `Invalid agent status transition ${current.status} -> ${status}`,
      );
    }
    const updated = { ...current, status };
    this.registrations.set(registrationKey(agentType, version), updated);
    return structuredClone(updated);
  }

  disable(agentType: string, version: string): AgentRegistration {
    return this.setStatus(agentType, version, 'disabled');
  }

  list(): AgentRegistration[] {
    return structuredClone([...this.registrations.values()]);
  }
}

export function localRegistration(
  agentType: string,
  version: string,
  tier: AgentTier,
  capabilities: string[] = [],
  agentId: Id = newSortableId(),
): AgentRegistration {
  return {
    schemaVersion: 1,
    agentId,
    agentType,
    version,
    tier,
    supportedContracts: ['AgentInvocation.v1', 'AgentReport.v1'],
    capabilities: [...capabilities].sort(),
    status: 'active',
  };
}

export function createLocalDatasetRegistry(): InMemoryAgentRegistry {
  const registry = new InMemoryAgentRegistry();
  registry.register(localRegistration('governance', 'governance.v1', 1, ['dataset.governance']));
  registry.register(
    localRegistration('data-engineer', 'data-engineer.v1', 1, ['dataset.validation']),
  );
  return registry;
}
