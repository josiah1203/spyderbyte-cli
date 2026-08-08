import { describe, expect, it } from 'vitest';
import {
  makeMoney,
  type Actor,
  type AuthorityEnvelope,
  type Id,
  type ResourceSelector,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import {
  ApprovalService,
  AuthorityService,
  InMemoryAuditSink,
  InMemoryApprovalStore,
  InMemoryPolicyDecisionStore,
  LocalConfirmationService,
  PolicyDecisionService,
  type ApprovalAction,
} from '../src/index.js';

const tenant: TenantRef = {
  tenantId: '018f0c4b-4e10-7abc-8def-0123456789ab' as Id,
  workspaceId: '018f0c4b-4e11-7abc-8def-0123456789ab' as Id,
};
const workflowId = '018f0c4b-4e12-7abc-8def-0123456789ab' as Id;
const invocationId = '018f0c4b-4e13-7abc-8def-0123456789ab' as Id;
const agentId = '018f0c4b-4e14-7abc-8def-0123456789ab' as Id;
const approverId = '018f0c4b-4e15-7abc-8def-0123456789ab' as Id;
const dataset: ResourceSelector = { kind: 'dataset', id: 'dataset-1' };
const artifactV1: ResourceSelector = { kind: 'artifact', id: 'artifact-1', version: 1 };
const artifactV2: ResourceSelector = { kind: 'artifact', id: 'artifact-1', version: 2 };
const now = '2026-08-02T00:00:00.000Z';

const agentActor: Actor = { actorId: agentId, type: 'agent', displayName: 'Worker' };
const approverActor: Actor = { actorId: approverId, type: 'human', displayName: 'Reviewer' };

function authorityService(): AuthorityService {
  return new AuthorityService({ policyVersion: 'policy.v1', clock: () => now });
}

function issue(
  service: AuthorityService,
  subjectAgentId: Id,
  issuer: Actor,
  actions: string[],
  toolOperations: string[] = [],
  capabilities: string[] = ['data.read', 'data.pii.read'],
): AuthorityEnvelope {
  return service.issue({
    tenant,
    workflowId,
    invocationId,
    issuer,
    subjectAgentId,
    tier: 1,
    harnessVersion: 'harness.v1',
    permittedActions: actions,
    capabilities,
    resourceScopes: [dataset, artifactV1, artifactV2],
    allowedArtifactReads: [artifactV1, artifactV2],
    allowedArtifactWrites: [artifactV1, artifactV2],
    allowedChildAgentTypes: [],
    maxChildCount: 0,
    toolOperations,
    issuedAt: now,
    expiresAt: '2026-08-02T01:00:00.000Z',
  });
}

describe('authority and policy boundaries', () => {
  it('binds an envelope to integrity, time, invocation, resources, and revocation epoch', () => {
    const service = authorityService();
    const envelope = issue(service, agentId, agentActor, ['data.read']);
    expect(() =>
      service.assertAuthorized(envelope, {
        tenant,
        workflowId,
        invocationId,
        actorId: agentId,
        action: 'data.read',
        resources: [dataset],
        now,
      }),
    ).not.toThrow();

    const tampered = { ...envelope, permittedActions: ['deployment.execute'] };
    expect(() => service.verify(tampered, now)).toThrow('integrity proof');
    expect(() => service.verify(envelope, '2026-08-02T01:00:00.000Z')).toThrow('expired');
    expect(() =>
      service.assertAuthorized(envelope, {
        tenant,
        workflowId,
        invocationId: '018f0c4b-4e99-7abc-8def-0123456789ab' as Id,
        action: 'data.read',
        now,
      }),
    ).toThrow('different invocation');
    expect(() =>
      service.assertAuthorized(envelope, {
        tenant,
        workflowId,
        invocationId,
        actorId: agentId,
        action: 'data.read',
        resources: [{ kind: 'dataset', id: 'dataset-10' }],
        now,
      }),
    ).toThrow('outside the authority scope');
    expect(() =>
      service.assertAuthorized(envelope, {
        tenant,
        workflowId,
        invocationId,
        actorId: agentId,
        action: 'data.read',
        resources: [{ kind: 'dataset', id: 'dataset-1/../dataset-1' }],
        now,
      }),
    ).toThrow('outside the authority scope');

    service.revoke(tenant, agentId);
    expect(() => service.verify(envelope, now)).toThrow('revoked');
  });

  it('records versioned deterministic policy decisions and rejects modified replay input', () => {
    const authority = authorityService();
    const envelope = issue(authority, agentId, agentActor, ['data.read']);
    const store = new InMemoryPolicyDecisionStore();
    const policy = new PolicyDecisionService({ authority, store, policyVersion: 'policy.v1' });
    const input = {
      action: 'data_access' as const,
      tenant,
      workflowId,
      invocationId,
      actor: agentActor,
      authority: envelope,
      resources: [dataset],
      evaluatedAt: now,
      access: 'read' as const,
      classification: 'internal' as const,
    };
    const decision = policy.decide(input);
    expect(decision.outcome).toBe('allow');
    expect(decision.policyVersion).toBe('policy.v1');
    expect(store.get(decision.decisionId)?.input).toEqual(input);
    expect(() => policy.replay(input, decision)).not.toThrow();
    expect(() =>
      policy.replay({ ...input, resources: [{ kind: 'dataset', id: 'other' }] }, decision),
    ).toThrow('modified input');

    const piiInput = { ...input, classification: 'pii' as const };
    expect(policy.decide(piiInput).outcome).toBe('allow');
    const noPiiAuthority = issue(authority, agentId, agentActor, ['data.read'], [], ['data.read']);
    const noPiiDecision = policy.decide({ ...piiInput, authority: noPiiAuthority });
    expect(noPiiDecision.outcome).toBe('deny');
    expect(noPiiDecision.reasonCodes).toContain('pii_capability_missing');
  });

  it('requires an independent human approval and invalidates changed action digests', () => {
    const authority = authorityService();
    const requester = issue(authority, agentId, agentActor, ['approval.request']);
    const approver = issue(authority, approverId, approverActor, [
      'approval.decide',
      'approval.revoke',
    ]);
    const approvals = new ApprovalService({
      authority,
      policyVersion: 'policy.v1',
      store: new InMemoryApprovalStore(),
    });
    const action: ApprovalAction = {
      actionType: 'artifact.publish',
      tenant,
      workflowId,
      invocationId,
      actor: agentActor,
      artifactVersions: [artifactV1],
      resources: [dataset],
      credentialScopes: ['catalog.read'],
      estimatedCost: makeMoney(125, 'USD'),
      policyVersion: 'policy.v1',
      revocationEpoch: requester.revocationEpoch,
    };
    const pending = approvals.request({
      action,
      authority: requester,
      expiresAt: '2026-08-02T00:30:00.000Z',
      now,
    });
    expect(pending.request.state).toBe('pending');
    expect(approvals.list(tenant)).toHaveLength(1);
    const approved = approvals.decide(
      tenant,
      pending.request.approvalId,
      'approved',
      approverActor,
      approver,
      now,
    );
    expect(approved.request.state).toBe('approved');
    expect(
      approvals.assertValid(tenant, pending.request.approvalId, action, requester, now).request
        .state,
    ).toBe('approved');
    expect(() =>
      approvals.assertValid(
        tenant,
        pending.request.approvalId,
        { ...action, artifactVersions: [artifactV2] },
        requester,
        now,
      ),
    ).toThrow('digest');
    expect(() =>
      approvals.assertValid(
        tenant,
        pending.request.approvalId,
        { ...action, estimatedCost: makeMoney(126, 'USD') },
        requester,
        now,
      ),
    ).toThrow('digest');

    approvals.revoke(tenant, pending.request.approvalId, approver, now);
    expect(() =>
      approvals.assertValid(tenant, pending.request.approvalId, action, requester, now),
    ).toThrow('revoked');

    authority.revoke(tenant, agentId);
    expect(() =>
      approvals.assertValid(tenant, pending.request.approvalId, action, requester, now),
    ).toThrow('revoked');
  });

  it('records audit entries through an independent sink', () => {
    const sink = new InMemoryAuditSink();
    sink.record({
      auditId: '018f0c4b-4e16-7abc-8def-0123456789ab' as Id,
      tenant,
      actor: agentActor,
      action: 'policy.evaluate',
      target: [dataset],
      result: 'allowed',
      evidence: { policyVersion: 'policy.v1' },
      occurredAt: now,
    });
    expect(sink.list()).toHaveLength(1);
  });

  it('treats personal-local governance actions as allowed or device-confirmed, never organization approval', () => {
    const authority = authorityService();
    const localPolicy = new PolicyDecisionService({
      authority,
      enforcementMode: 'personal_local',
    });
    const localActions = [
      {
        action: 'model_promotion' as const,
        modelId: agentId,
        target: 'local-runtime',
        requiresApproval: true,
      },
      {
        action: 'connector_scope' as const,
        connectorId: 'local-files',
        operation: 'write',
        external: false,
        requiresApproval: true,
      },
      {
        action: 'deployment' as const,
        target: 'loopback',
        trafficPercentage: 100,
      },
      {
        action: 'tool_use' as const,
        toolName: 'local-shell',
        operation: 'read',
        requiresApproval: true,
      },
    ];
    const outcomes = localActions.map((specific) => {
      const required =
        specific.action === 'model_promotion'
          ? 'model.promote'
          : specific.action === 'connector_scope'
            ? 'connector.write'
            : specific.action === 'deployment'
              ? 'deployment.execute'
              : 'tool.use';
      const envelope = issue(authority, agentId, agentActor, [required]);
      return localPolicy.decide({
        ...specific,
        tenant,
        workflowId,
        invocationId,
        actor: agentActor,
        authority: envelope,
        resources: [dataset],
        evaluatedAt: now,
      }).outcome;
    });
    expect(outcomes).not.toContain('approval_required');
    expect(outcomes).toEqual(['allow', 'allow', 'allow', 'allow']);

    const confirmations = new LocalConfirmationService({ clock: () => now });
    const confirmationPolicy = new PolicyDecisionService({
      authority,
      enforcementMode: 'personal_local',
      localSafety: { confirmExternalNetwork: true },
      localConfirmations: confirmations,
    });
    const networkInput = {
      action: 'external_network' as const,
      tenant,
      workflowId,
      invocationId,
      actor: agentActor,
      authority: issue(authority, agentId, agentActor, ['network.external']),
      resources: [dataset],
      evaluatedAt: now,
      host: 'example.test',
      method: 'GET',
    };
    const decision = confirmationPolicy.decide(networkInput);
    expect(decision.outcome).toBe('confirmation_required');
    expect(decision.confirmationId).toBeDefined();
    expect(() => confirmationPolicy.assertAllowed(decision)).toThrow(
      'A local safety confirmation was required',
    );
    if (decision.confirmationId === undefined) throw new Error('confirmation id missing');
    const confirmationId = decision.confirmationId;
    expect(confirmations.confirm(confirmationId, networkInput, now)).toMatchObject({
      challengeId: confirmationId,
    });
    expect(() => confirmations.confirm(confirmationId, networkInput, now)).toThrow(
      'unknown or already used',
    );
  });
});
