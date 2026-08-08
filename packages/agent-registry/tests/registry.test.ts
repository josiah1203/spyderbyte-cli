import { describe, expect, it } from 'vitest';
import { newSortableId, type AgentRegistration } from '@agentic-platform/runtime-contracts';
import { InMemoryAgentRegistry } from '../src/index.js';

function registration(
  agentType: string,
  version: string,
  tier: 0 | 1 | 2,
  status: AgentRegistration['status'] = 'draft',
  capabilities: string[] = [],
): AgentRegistration {
  return {
    schemaVersion: 1,
    agentId: newSortableId(),
    agentType,
    version,
    tier,
    supportedContracts: ['AgentInvocation.v1', 'AgentReport.v1'],
    capabilities,
    status,
  };
}

describe('versioned agent registry', () => {
  it('requires exact supported contracts and blocks disabled versions', () => {
    const registry = new InMemoryAgentRegistry();
    registry.register(registration('worker', 'v1', 2));
    registry.setStatus('worker', 'v1', 'active');
    expect(
      registry.assertCompatible({
        agentType: 'worker',
        version: 'v1',
        requiredContracts: ['AgentInvocation.v1', 'AgentReport.v1'],
      }),
    ).toMatchObject({ status: 'active', version: 'v1' });
    registry.disable('worker', 'v1');
    expect(() => registry.requireActive('worker', 'v1')).toThrow('Active registration is required');
  });

  it('enforces the permitted child capability and tier matrix', () => {
    const registry = new InMemoryAgentRegistry();
    registry.register(registration('planner', 'v1', 1, 'active', ['child:worker']));
    expect(() => registry.assertChildAllowed('planner', 'v1', 'worker', 2)).not.toThrow();
    expect(() => registry.assertChildAllowed('planner', 'v1', 'other', 2)).toThrow('cannot invoke');
    expect(() => registry.assertChildAllowed('planner', 'v1', 'worker', 1)).toThrow(
      'cannot invoke tier',
    );
  });
});
