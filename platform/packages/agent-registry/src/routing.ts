import { createHash } from 'node:crypto';
import {
  newSortableId,
  runtimeError,
  type AgentTier,
  type Id,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';

export type AgentRolloutStage = 'shadow' | 'canary' | 'limited' | 'general' | 'disabled';

export interface AgentRolloutPolicy {
  readonly stage: AgentRolloutStage;
  readonly percentage: number;
  readonly cohortSalt: string;
}

export interface AgentDefinitionV1 {
  readonly agentId: Id;
  readonly agentType: string;
  readonly version: string;
  readonly tier: AgentTier;
  readonly status: 'draft' | 'active' | 'deprecated' | 'disabled';
  readonly taskShapes: readonly string[];
  readonly capabilities: readonly string[];
  readonly dataClasses: readonly string[];
  readonly requiredModelProviders?: readonly string[];
  readonly maxConcurrent: number;
  readonly maxCostMinor?: number;
  readonly rollout: AgentRolloutPolicy;
  readonly createdAt: string;
}

export interface AgentRoutingRequest {
  readonly tenant: TenantRef;
  readonly taskShape: string;
  readonly tier: AgentTier;
  readonly requiredCapabilities?: readonly string[];
  readonly dataClass?: string;
  readonly modelProvider?: string;
  readonly preferredAgentType?: string;
  readonly cohortKey: string;
  readonly includeShadow?: boolean;
}

export interface AgentRouteCandidate {
  readonly agentType: string;
  readonly version: string;
  readonly stage: AgentRolloutStage;
  readonly eligible: boolean;
  readonly reason: string;
}

export interface AgentRouteDecision {
  readonly decisionId: Id;
  readonly selected?: AgentDefinitionV1;
  readonly shadow: readonly AgentDefinitionV1[];
  readonly candidates: readonly AgentRouteCandidate[];
  readonly reason: 'preferred' | 'rollout' | 'priority' | 'unavailable';
  readonly decidedAt: string;
}

export interface AgentInvocationLease {
  readonly leaseId: Id;
  readonly tenant: TenantRef;
  readonly agentType: string;
  readonly version: string;
  readonly expiresAt: string;
}

export interface AdvancedAgentRouterOptions {
  readonly clock?: () => string;
  readonly leaseTtlMs?: number;
}

function key(agentType: string, version: string): string {
  return `${agentType}:${version}`;
}

function tenantKey(tenant: TenantRef): string {
  return `${tenant.tenantId}:${tenant.workspaceId}`;
}

function assertText(value: string, label: string): string {
  if (value.trim().length === 0 || value.length > 160) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} must be 1–160 characters`);
  }
  return value.trim();
}

function assertPercentage(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100) {
    throw runtimeError(
      'VALIDATION_INVALID_INPUT',
      'Rollout percentage must be an integer from 0 to 100',
    );
  }
}

function assertDefinition(definition: AgentDefinitionV1): AgentDefinitionV1 {
  assertText(definition.agentType, 'Agent type');
  assertText(definition.version, 'Agent version');
  assertText(definition.rollout.cohortSalt, 'Rollout cohort salt');
  assertPercentage(definition.rollout.percentage);
  if (!Number.isSafeInteger(definition.maxConcurrent) || definition.maxConcurrent < 1) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Agent maxConcurrent must be positive');
  }
  if (
    definition.maxCostMinor !== undefined &&
    (!Number.isSafeInteger(definition.maxCostMinor) || definition.maxCostMinor < 0)
  ) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Agent maxCostMinor must be non-negative');
  }
  if (new Set(definition.taskShapes).size !== definition.taskShapes.length) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Agent taskShapes must not contain duplicates');
  }
  return structuredClone(definition);
}

function rolloutBucket(definition: AgentDefinitionV1, request: AgentRoutingRequest): number {
  const digest = createHash('sha256')
    .update(
      `${tenantKey(request.tenant)}:${request.cohortKey}:${definition.agentType}:${definition.version}:${definition.rollout.cohortSalt}`,
    )
    .digest();
  return digest.readUInt32BE(0) % 100;
}

export class AdvancedAgentRouter {
  private readonly definitions = new Map<string, AgentDefinitionV1>();
  private readonly previousRollouts = new Map<string, AgentRolloutPolicy>();
  private readonly activeCounts = new Map<string, number>();
  private readonly leases = new Map<Id, AgentInvocationLease>();
  private readonly clock: () => string;
  private readonly leaseTtlMs: number;

  constructor(options: AdvancedAgentRouterOptions = {}) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.leaseTtlMs = options.leaseTtlMs ?? 60_000;
    if (!Number.isSafeInteger(this.leaseTtlMs) || this.leaseTtlMs < 1) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Agent lease TTL must be positive');
    }
  }

  register(definition: AgentDefinitionV1): AgentDefinitionV1 {
    const normalized = assertDefinition(definition);
    const definitionKey = key(normalized.agentType, normalized.version);
    if (this.definitions.has(definitionKey)) {
      throw runtimeError(
        'CONCURRENCY_STALE_VERSION',
        `Agent definition already exists: ${definitionKey}`,
      );
    }
    this.definitions.set(definitionKey, normalized);
    return structuredClone(normalized);
  }

  updateRollout(
    agentType: string,
    version: string,
    rollout: AgentRolloutPolicy,
  ): AgentDefinitionV1 {
    const definition = this.require(agentType, version);
    assertPercentage(rollout.percentage);
    assertText(rollout.cohortSalt, 'Rollout cohort salt');
    this.previousRollouts.set(key(agentType, version), definition.rollout);
    const updated = { ...definition, rollout: structuredClone(rollout) };
    this.definitions.set(key(agentType, version), updated);
    return structuredClone(updated);
  }

  rollback(agentType: string, version: string): AgentDefinitionV1 {
    const definition = this.require(agentType, version);
    const previous = this.previousRollouts.get(key(agentType, version));
    if (previous === undefined) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        `No rollout history exists for ${agentType}:${version}`,
      );
    }
    const restored = { ...definition, rollout: structuredClone(previous) };
    this.definitions.set(key(agentType, version), restored);
    this.previousRollouts.delete(key(agentType, version));
    return structuredClone(restored);
  }

  rollbackAgentType(agentType: string, targetVersion: string): readonly AgentDefinitionV1[] {
    const target = this.require(agentType, targetVersion);
    const changed: AgentDefinitionV1[] = [];
    for (const definition of this.definitions.values()) {
      if (definition.agentType !== agentType) continue;
      const next =
        definition.version === target.version
          ? {
              ...definition,
              status: 'active' as const,
              rollout: { ...definition.rollout, stage: 'general' as const, percentage: 100 },
            }
          : {
              ...definition,
              status: 'deprecated' as const,
              rollout: { ...definition.rollout, stage: 'disabled' as const, percentage: 0 },
            };
      this.definitions.set(key(definition.agentType, definition.version), next);
      changed.push(next);
    }
    if (changed.length === 0)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Agent type ${target.agentType} was not found`);
    return structuredClone(changed);
  }

  resolve(request: AgentRoutingRequest): AgentRouteDecision {
    assertText(request.taskShape, 'Task shape');
    assertText(request.cohortKey, 'Routing cohort key');
    const definitions = [...this.definitions.values()].filter(
      (definition) => definition.status === 'active' && definition.tier === request.tier,
    );
    const candidates: AgentRouteCandidate[] = [];
    const eligible: AgentDefinitionV1[] = [];
    const shadow: AgentDefinitionV1[] = [];
    for (const definition of definitions) {
      let reason = 'eligible';
      let isEligible = true;
      if (!definition.taskShapes.includes(request.taskShape)) {
        isEligible = false;
        reason = 'task shape mismatch';
      } else if (
        request.preferredAgentType !== undefined &&
        definition.agentType !== request.preferredAgentType
      ) {
        isEligible = false;
        reason = 'preferred type mismatch';
      } else if (
        request.requiredCapabilities?.some(
          (capability) => !definition.capabilities.includes(capability),
        )
      ) {
        isEligible = false;
        reason = 'capability mismatch';
      } else if (
        request.dataClass !== undefined &&
        !definition.dataClasses.includes(request.dataClass)
      ) {
        isEligible = false;
        reason = 'data class mismatch';
      } else if (
        request.modelProvider !== undefined &&
        definition.requiredModelProviders !== undefined &&
        !definition.requiredModelProviders.includes(request.modelProvider)
      ) {
        isEligible = false;
        reason = 'model provider mismatch';
      } else if (definition.rollout.stage === 'disabled') {
        isEligible = false;
        reason = 'rollout disabled';
      } else if (
        definition.rollout.stage !== 'general' &&
        rolloutBucket(definition, request) >= definition.rollout.percentage
      ) {
        isEligible = false;
        reason = 'outside rollout cohort';
      }
      candidates.push({
        agentType: definition.agentType,
        version: definition.version,
        stage: definition.rollout.stage,
        eligible: isEligible,
        reason,
      });
      if (isEligible) {
        if (definition.rollout.stage === 'shadow') shadow.push(definition);
        else eligible.push(definition);
      }
    }
    const selected = eligible.find((definition) => this.available(definition, request.tenant));
    return {
      decisionId: newSortableId(),
      ...(selected === undefined ? {} : { selected: structuredClone(selected) }),
      shadow: request.includeShadow === false ? [] : structuredClone(shadow),
      candidates,
      reason:
        selected === undefined
          ? 'unavailable'
          : request.preferredAgentType !== undefined
            ? 'preferred'
            : selected.rollout.stage === 'general'
              ? 'priority'
              : 'rollout',
      decidedAt: this.clock(),
    };
  }

  begin(
    tenant: TenantRef,
    definition: Pick<AgentDefinitionV1, 'agentType' | 'version'>,
  ): AgentInvocationLease {
    const current = this.require(definition.agentType, definition.version);
    const countKey = key(current.agentType, current.version);
    const count = this.activeCounts.get(countKey) ?? 0;
    if (count >= current.maxConcurrent) {
      throw runtimeError(
        'COMPUTE_RESOURCE_UNAVAILABLE',
        `Agent ${countKey} concurrency limit reached`,
      );
    }
    const now = Date.parse(this.clock());
    const lease: AgentInvocationLease = {
      leaseId: newSortableId(),
      tenant: structuredClone(tenant),
      agentType: current.agentType,
      version: current.version,
      expiresAt: new Date(now + this.leaseTtlMs).toISOString(),
    };
    this.activeCounts.set(countKey, count + 1);
    this.leases.set(lease.leaseId, lease);
    return structuredClone(lease);
  }

  finish(leaseId: Id, now = this.clock()): void {
    const lease = this.leases.get(leaseId);
    if (lease === undefined)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Agent lease ${leaseId} was not found`);
    if (Date.parse(lease.expiresAt) <= Date.parse(now)) {
      this.leases.delete(leaseId);
      throw runtimeError('CONCURRENCY_STALE_VERSION', 'Agent invocation lease has expired');
    }
    const definitionKey = key(lease.agentType, lease.version);
    this.activeCounts.set(
      definitionKey,
      Math.max(0, (this.activeCounts.get(definitionKey) ?? 1) - 1),
    );
    this.leases.delete(leaseId);
  }

  list(): readonly AgentDefinitionV1[] {
    return structuredClone([...this.definitions.values()]);
  }

  private available(definition: AgentDefinitionV1, tenant: TenantRef): boolean {
    return (
      (this.activeCounts.get(key(definition.agentType, definition.version)) ?? 0) <
        definition.maxConcurrent &&
      tenant.tenantId.length > 0 &&
      tenant.workspaceId.length > 0
    );
  }

  private require(agentType: string, version: string): AgentDefinitionV1 {
    const definition = this.definitions.get(key(agentType, version));
    if (definition === undefined)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Agent ${agentType}:${version} was not found`);
    return definition;
  }
}

/** The public port a durable hosted agent registry/router must implement. */
export type AgentRoutingService = Pick<
  AdvancedAgentRouter,
  | 'register'
  | 'updateRollout'
  | 'rollback'
  | 'rollbackAgentType'
  | 'resolve'
  | 'begin'
  | 'finish'
  | 'list'
>;
