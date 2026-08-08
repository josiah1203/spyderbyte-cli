import { describe, expect, it } from 'vitest';
import { newSortableId, type TenantRef } from '@agentic-platform/runtime-contracts';
import type { AgentDefinitionV1 } from '../src/index.js';
import { AdvancedAgentRouter } from '../src/index.js';

const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
const now = '2026-08-06T00:00:00.000Z';

function definition(
  version: string,
  stage: AgentDefinitionV1['rollout']['stage'],
  percentage = 100,
): AgentDefinitionV1 {
  return {
    agentId: newSortableId(),
    agentType: 'data-engineer',
    version,
    tier: 1,
    status: 'active',
    taskShapes: ['dataset.profile'],
    capabilities: ['schema.profile'],
    dataClasses: ['internal'],
    requiredModelProviders: ['deterministic'],
    maxConcurrent: 1,
    rollout: { stage, percentage, cohortSalt: `salt-${version}` },
    createdAt: now,
  };
}

describe('advanced agent routing', () => {
  it('filters by task/capability/data class and rolls an agent type back to a known version', () => {
    const router = new AdvancedAgentRouter({ clock: () => now });
    router.register(definition('v1', 'general'));
    router.register(definition('v2', 'canary'));
    router.register({
      ...definition('shadow', 'shadow'),
      version: 'shadow',
      maxConcurrent: 2,
    });
    const decision = router.resolve({
      tenant,
      taskShape: 'dataset.profile',
      tier: 1,
      requiredCapabilities: ['schema.profile'],
      dataClass: 'internal',
      modelProvider: 'deterministic',
      cohortKey: 'workflow-1',
      includeShadow: true,
    });
    expect(decision.selected?.agentType).toBe('data-engineer');
    expect(decision.shadow).toHaveLength(1);
    expect(
      router.resolve({ ...decisionRequest(), dataClass: 'restricted' }).selected,
    ).toBeUndefined();
    const rolledBack = router.rollbackAgentType('data-engineer', 'v1');
    expect(rolledBack.find((item) => item.version === 'v1')?.rollout).toMatchObject({
      stage: 'general',
      percentage: 100,
    });
    expect(rolledBack.find((item) => item.version === 'v2')?.rollout.stage).toBe('disabled');
  });

  it('enforces per-definition concurrency leases and supports rollout rollback', () => {
    const router = new AdvancedAgentRouter({ clock: () => now, leaseTtlMs: 1000 });
    router.register(definition('v1', 'general'));
    const changed = router.updateRollout('data-engineer', 'v1', {
      stage: 'canary',
      percentage: 50,
      cohortSalt: 'changed',
    });
    expect(changed.rollout.stage).toBe('canary');
    expect(router.rollback('data-engineer', 'v1').rollout.stage).toBe('general');
    const lease = router.begin(tenant, { agentType: 'data-engineer', version: 'v1' });
    expect(() => router.begin(tenant, { agentType: 'data-engineer', version: 'v1' })).toThrow(
      'concurrency',
    );
    expect(router.resolve(decisionRequest()).selected).toBeUndefined();
    router.finish(lease.leaseId, now);
    expect(router.resolve(decisionRequest()).selected?.version).toBe('v1');
  });
});

function decisionRequest() {
  return {
    tenant,
    taskShape: 'dataset.profile',
    tier: 1 as const,
    requiredCapabilities: ['schema.profile'],
    dataClass: 'internal',
    modelProvider: 'deterministic',
    cohortKey: 'workflow-1',
  };
}
