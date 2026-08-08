import { describe, expect, it } from 'vitest';
import {
  assertSameTenant,
  assertTierParentChild,
  transitionApproval,
  transitionArtifact,
  transitionBudgetReservation,
  transitionDeployment,
  transitionInvocation,
  transitionWorkflow,
} from '../src/state-machines.js';
import { RuntimeError } from '../src/errors.js';
import { id, otherId } from './fixtures.js';

describe('pure runtime state machines', () => {
  it('enforces the workflow lifecycle and emits versioned events', () => {
    const waiting = transitionWorkflow('planning', 'requestApproval', 2);
    expect(waiting.state).toBe('awaiting_approval');
    expect(waiting.event.eventName).toBe('workflow.state-changed.v1');
    expect(waiting.event.aggregateVersion).toBe(2);
    expect(transitionWorkflow(waiting.state, 'approve').state).toBe('executing');
    expect(transitionWorkflow('executing', 'complete').state).toBe('completed');
  });

  it('enforces invocation, artifact, approval, deployment, and budget paths', () => {
    expect(transitionInvocation('created', 'prepare').state).toBe('preparing');
    expect(transitionInvocation('running', 'validateReport').state).toBe('validating_report');
    expect(transitionArtifact('draft', 'validate').state).toBe('valid');
    expect(transitionArtifact('valid', 'markStale').state).toBe('stale');
    expect(transitionApproval('pending', 'approve').state).toBe('approved');
    expect(transitionDeployment('requested', 'provision').state).toBe('provisioning');
    expect(transitionBudgetReservation('requested', 'reserve').state).toBe('reserved');
  });

  it('rejects illegal transitions and hierarchy escalation', () => {
    expect(() => transitionWorkflow('completed', 'beginExecution')).toThrow(RuntimeError);
    expect(() => transitionArtifact('archived', 'validate')).toThrow(RuntimeError);
    expect(() => assertTierParentChild(0, 2)).toThrow('Tier 0 may invoke only Tier 1');
    expect(() => assertTierParentChild(2, 2)).toThrow('Tier 2 may not invoke agents');
    expect(() => assertSameTenant(id, otherId)).toThrow(RuntimeError);
  });
});
