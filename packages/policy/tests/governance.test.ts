import { describe, expect, it } from 'vitest';
import {
  makeMoney,
  newSortableId,
  type Actor,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import { InMemoryGovernanceService } from '../src/index.js';

const now = '2026-08-07T00:00:00.000Z';
const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
const actor: Actor = { actorId: newSortableId(), type: 'human', displayName: 'Owner' };

describe('organization governance control plane', () => {
  it('enforces organization, workspace, and project policy scopes at execution time', () => {
    const governance = new InMemoryGovernanceService(() => now);
    const organization = governance.createOrganization({ tenant, name: 'Acme', actor, now });
    const workspaceId = newSortableId();
    const projectId = newSortableId();
    governance.putPolicy({
      tenant,
      organizationId: organization.organizationId,
      version: 'governance.v2',
      scope: { organizationId: organization.organizationId, workspaceId, projectId },
      allowedDataClasses: ['internal'],
      blockedActions: ['deployment.*'],
      approvalActions: ['model.promote'],
      approvalCostThresholdMinor: 100,
      changedBy: actor,
      now,
    });

    const blocked = governance.evaluate({
      tenant,
      organizationId: organization.organizationId,
      workspaceId,
      projectId,
      actor,
      action: 'deployment.execute',
      target: [{ kind: 'deployment', id: 'deployment-1' }],
      dataClassification: 'internal',
      interfaceName: 'api',
      now,
    });
    expect(blocked.outcome).toBe('blocked');
    expect(blocked.reasonCodes).toContain('action_blocked');

    const approval = governance.evaluate({
      tenant,
      organizationId: organization.organizationId,
      workspaceId,
      projectId,
      actor,
      action: 'model.promote',
      target: [{ kind: 'model', id: 'model-1' }],
      dataClassification: 'internal',
      estimatedCost: makeMoney(125, 'USD'),
      interfaceName: 'api',
      now,
    });
    expect(approval.outcome).toBe('approval_required');

    const wrongClass = governance.evaluate({
      tenant,
      organizationId: organization.organizationId,
      workspaceId,
      projectId,
      actor,
      action: 'data.read',
      target: [{ kind: 'dataset', id: 'dataset-1' }],
      dataClassification: 'restricted',
      interfaceName: 'api',
      now,
    });
    expect(wrongClass.outcome).toBe('blocked');
    expect(wrongClass.reasonCodes).toContain('data_classification_blocked');
  });

  it('requires a current approval digest and records redacted immutable audit evidence', () => {
    const governance = new InMemoryGovernanceService(() => now);
    const organization = governance.createOrganization({ tenant, name: 'Acme', actor, now });
    governance.putPolicy({
      tenant,
      organizationId: organization.organizationId,
      version: 'governance.v2',
      scope: { organizationId: organization.organizationId },
      approvalActions: ['deployment.execute'],
      changedBy: actor,
      now,
    });
    const base = {
      tenant,
      organizationId: organization.organizationId,
      workspaceId: tenant.workspaceId,
      actor,
      action: 'deployment.execute',
      target: [{ kind: 'deployment' as const, id: 'deployment-1' }],
      interfaceName: 'browser',
      now,
    };
    expect(() => governance.commit(base)).toThrow('approval');
    const decision = governance.evaluate(base);
    const committed = governance.commit({
      ...base,
      approvalContext: { approved: true, actionDigest: decision.inputDigest },
      before: { token: 'should-not-appear', state: 'canary' },
      after: { state: 'active' },
    });
    expect(committed.audit.decision).toBe('executed');
    expect(committed.audit.before).toEqual({ token: '[REDACTED]', state: 'canary' });
    expect(governance.verifyAudit(tenant, organization.organizationId)).toBe(true);
    expect(governance.auditRecords(tenant, organization.organizationId)).toHaveLength(2);
    expect(() =>
      governance.commit({
        ...base,
        approvalContext: {
          approved: true,
          actionDigest: '0'.repeat(64) as typeof decision.inputDigest,
        },
      }),
    ).toThrow('match');
    expect(governance.verifyAudit(tenant, organization.organizationId)).toBe(true);
    expect(governance.auditRecords(tenant, organization.organizationId)).toHaveLength(3);

    const otherTenant: TenantRef = {
      tenantId: newSortableId(),
      workspaceId: newSortableId(),
    };
    const otherActor: Actor = { actorId: newSortableId(), type: 'human', displayName: 'Other' };
    const otherOrganization = governance.createOrganization({
      tenant: otherTenant,
      name: 'Other Acme',
      actor: otherActor,
      now,
    });
    governance.commit({
      tenant: otherTenant,
      organizationId: otherOrganization.organizationId,
      workspaceId: otherTenant.workspaceId,
      actor: otherActor,
      action: 'data.read',
      target: [{ kind: 'dataset', id: 'dataset-2' }],
      interfaceName: 'api',
      now,
    });
    expect(governance.verifyAudit(otherTenant, otherOrganization.organizationId)).toBe(true);
  });

  it('attributes spend, emits threshold alerts, forecasts usage, and blocks over-budget execution', () => {
    const governance = new InMemoryGovernanceService(() => now);
    const organization = governance.createOrganization({ tenant, name: 'Acme', actor, now });
    governance.setBudget({
      tenant,
      organizationId: organization.organizationId,
      scope: { organizationId: organization.organizationId },
      currency: 'USD',
      hardLimitMinor: 100,
      softLimitMinor: 50,
      changedBy: actor,
      now,
    });
    governance.recordUsage({
      tenant,
      organizationId: organization.organizationId,
      workspaceId: tenant.workspaceId,
      actorId: actor.actorId,
      category: 'compute',
      amount: makeMoney(60, 'USD'),
      interfaceName: 'runner',
      occurredAt: now,
    });
    const summary = governance.usageSummary({
      tenant,
      organizationId: organization.organizationId,
      periodStart: '2026-08-01T00:00:00.000Z',
      periodEnd: '2026-08-08T00:00:00.000Z',
    });
    expect(summary.consumedMinor).toBe(60);
    expect(summary.byCategory.compute).toBe(60);
    expect(
      governance
        .alerts(tenant, organization.organizationId)
        .some((alert) => alert.kind === 'soft_limit'),
    ).toBe(true);
    expect(
      governance.forecast({ tenant, organizationId: organization.organizationId, asOf: now })
        .projectedMinor,
    ).toBeGreaterThan(0);
    const decision = governance.evaluate({
      tenant,
      organizationId: organization.organizationId,
      workspaceId: tenant.workspaceId,
      actor,
      action: 'compute.allocate',
      target: [{ kind: 'compute', id: 'runner-1' }],
      estimatedCost: makeMoney(50, 'USD'),
      interfaceName: 'runner',
      now,
    });
    expect(decision.outcome).toBe('blocked');
    expect(decision.reasonCodes).toContain('budget_hard_limit');
    expect(() =>
      governance.recordUsage({
        tenant,
        organizationId: organization.organizationId,
        workspaceId: tenant.workspaceId,
        actorId: actor.actorId,
        category: 'compute',
        amount: makeMoney(50, 'USD'),
        interfaceName: 'runner',
        occurredAt: now,
      }),
    ).toThrow('hard budget');
  });
});
