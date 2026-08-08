import { describe, expect, it } from 'vitest';
import {
  isContract,
  parseContract,
  serializeContract,
  validateContract,
  type ContractName,
} from '../src/schema.js';
import { isId, newSortableId } from '../src/ids.js';
import { isUtcInstant, toUtcInstant } from '../src/time.js';
import { id, otherId, samples, time, tenant, actor, resource } from './fixtures.js';

describe('runtime contract validators', () => {
  it.each(Object.keys(samples))('accepts the valid %s fixture', (name) => {
    const result = validateContract(name as ContractName, samples[name]);
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
    expect(isContract(name as ContractName, samples[name])).toBe(true);
  });

  it.each(Object.keys(samples))('round-trips the %s fixture', (name) => {
    const encoded = serializeContract(name as ContractName, samples[name] as never);
    expect(parseContract(name as ContractName, JSON.parse(encoded))).toEqual(samples[name]);
  });

  it('rejects missing tenant identity and malformed authority tier', () => {
    const command = structuredClone(samples.RuntimeCommand) as Record<string, unknown>;
    delete command.tenant;
    expect(validateContract('RuntimeCommand', command).valid).toBe(false);

    const authority = structuredClone(samples.AuthorityEnvelope) as Record<string, unknown>;
    authority.tier = 3;
    expect(validateContract('AuthorityEnvelope', authority).valid).toBe(false);
  });

  it('rejects negative budgets, unsupported currencies, and malformed resource scopes', () => {
    const budget = structuredClone(samples.BudgetEnvelope) as Record<string, unknown>;
    budget.limit = -1;
    expect(validateContract('BudgetEnvelope', budget).valid).toBe(false);

    const cost = structuredClone(samples.CostObservation) as Record<string, unknown>;
    cost.amount = { amountMinor: 1, currency: 'US' };
    expect(validateContract('CostObservation', cost).valid).toBe(false);

    const grant = structuredClone(samples.ToolGrant) as Record<string, unknown>;
    grant.resourceScopes = [{ kind: 'dataset' }];
    expect(validateContract('ToolGrant', grant).valid).toBe(false);
  });

  it('uses canonical UTC instants and UUIDv7 identifiers', () => {
    const id = newSortableId(new Date(time));
    expect(isId(id)).toBe(true);
    expect(toUtcInstant(time)).toBe(time);
    expect(isUtcInstant(time)).toBe(true);
    expect(isUtcInstant('2026-08-02T00:00:00Z')).toBe(false);
  });

  it('validates the durable AgentSession request, event, permission, and response contracts', () => {
    const context = {
      workspaceId: tenant.workspaceId,
      projectId: id,
      sourceInterface: 'cli',
      mode: 'conversation',
      resources: [resource],
    };
    const session = {
      schemaVersion: 1,
      sessionId: id,
      tenant,
      workspaceId: tenant.workspaceId,
      projectId: id,
      user: actor,
      sourceInterface: 'cli',
      context,
      mode: 'conversation',
      state: 'active',
      requestIds: [otherId],
      createdAt: time,
      updatedAt: time,
    };
    const request = {
      schemaVersion: 1,
      requestId: otherId,
      sessionId: id,
      tenant,
      workspaceId: tenant.workspaceId,
      projectId: id,
      actor,
      sourceInterface: 'cli',
      mode: 'conversation',
      context,
      text: 'Inspect this project',
      createdAt: time,
      correlationId: otherId,
    };
    const event = {
      schemaVersion: 1,
      eventId: id,
      sessionId: id,
      requestId: otherId,
      tenant,
      sequence: 1,
      kind: 'recommendation_created',
      payload: { summary: 'Inspect project context' },
      occurredAt: time,
      correlationId: otherId,
    };
    const permission = {
      schemaVersion: 1,
      permissionRequestId: id,
      sessionId: id,
      requestId: otherId,
      tenant,
      kind: 'approval',
      action: 'deployment.execute',
      reason: 'Deployment changes require review',
      resources: [resource],
      state: 'pending',
      requestedAt: time,
    };
    const response = {
      schemaVersion: 1,
      responseId: id,
      sessionId: id,
      requestId: otherId,
      tenant,
      state: 'accepted',
      recommendation: {
        summary: 'Inspect project context',
        actions: ['inspect'],
        rationale: ['The request asks for project analysis.'],
        confidence: 0.8,
      },
      plan: samples.ExecutionPlan,
      estimate: {
        estimatedCost: { amountMinor: 0, currency: 'USD' },
        estimatedDurationMs: 1000,
        resourceClass: 'local-agent',
      },
      artifacts: [],
      createdAt: time,
    };
    expect(validateContract('AgentSessionContext', context).valid).toBe(true);
    expect(validateContract('AgentSession', session).valid).toBe(true);
    expect(validateContract('AgentRequest', request).valid).toBe(true);
    expect(validateContract('AgentEvent', event).valid).toBe(true);
    expect(validateContract('AgentPermissionRequest', permission).valid).toBe(true);
    expect(
      validateContract('AgentResponse', response).valid,
      JSON.stringify(validateContract('AgentResponse', response).errors),
    ).toBe(true);
    expect(validateContract('AgentEvent', { ...event, kind: 'not-a-kind' }).valid).toBe(false);
    expect(
      validateContract('AgentSession', {
        ...session,
        context: { ...context, workspaceId: 'not-an-id' },
      }).valid,
    ).toBe(false);
  });
});
