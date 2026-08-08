import { describe, expect, it } from 'vitest';
import {
  type Actor,
  type AuthorityEnvelope,
  type Id,
  type ResourceSelector,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import {
  AuthorityService,
  InMemoryAuditSink,
  PolicyDecisionService,
} from '@agentic-platform/policy';
import { ToolBroker } from '../src/index.js';

const tenant: TenantRef = {
  tenantId: '018f0c4b-4e30-7abc-8def-0123456789ab' as Id,
  workspaceId: '018f0c4b-4e31-7abc-8def-0123456789ab' as Id,
};
const workflowId = '018f0c4b-4e32-7abc-8def-0123456789ab' as Id;
const invocationId = '018f0c4b-4e33-7abc-8def-0123456789ab' as Id;
const agentId = '018f0c4b-4e34-7abc-8def-0123456789ab' as Id;
const correlationId = '018f0c4b-4e35-7abc-8def-0123456789ab' as Id;
const actor: Actor = { actorId: agentId, type: 'agent' };
const resource: ResourceSelector = { kind: 'dataset', id: 'dataset-1' };
const now = '2026-08-02T00:00:00.000Z';

function setup(): {
  authority: AuthorityService;
  envelope: AuthorityEnvelope;
  broker: ToolBroker;
  audit: InMemoryAuditSink;
} {
  const authority = new AuthorityService({ policyVersion: 'policy.v1', clock: () => now });
  const envelope = authority.issue({
    tenant,
    workflowId,
    invocationId,
    issuer: actor,
    subjectAgentId: agentId,
    tier: 1,
    harnessVersion: 'harness.v1',
    permittedActions: ['tool.grant', 'tool.use'],
    capabilities: [],
    resourceScopes: [resource],
    allowedArtifactReads: [],
    allowedArtifactWrites: [],
    allowedChildAgentTypes: [],
    maxChildCount: 0,
    toolOperations: ['catalog.read'],
    issuedAt: now,
    expiresAt: '2026-08-02T01:00:00.000Z',
  });
  const audit = new InMemoryAuditSink();
  const broker = new ToolBroker({
    authority,
    policy: new PolicyDecisionService({ authority, policyVersion: 'policy.v1' }),
    audit,
    clock: () => now,
  });
  broker.register({
    toolName: 'catalog',
    operation: 'read',
    execute: () => ({ value: 'schema', token: 'sk-test-secret-value' }),
  });
  broker.register({
    toolName: 'catalog',
    operation: 'write',
    execute: () => ({ ok: true }),
  });
  return { authority, envelope, broker, audit };
}

describe('tool capability broker', () => {
  it('issues invocation-bound single-use grants and redacts secret-shaped responses', async () => {
    const { broker, envelope, audit } = setup();
    const grant = await broker.issueGrant({
      tenant,
      invocationId,
      authority: envelope,
      toolName: 'catalog',
      operation: 'read',
      resourceScopes: [resource],
      expiresAt: '2026-08-02T00:30:00.000Z',
      maxUses: 1,
      now,
    });
    const result = await broker.execute({
      tenant,
      invocationId,
      grantId: grant.grant.grantId,
      authority: envelope,
      resources: [resource],
      input: { dataset: 'dataset-1' },
      now,
    });
    expect(result.output).toEqual({ value: 'schema', token: '[REDACTED]' });
    expect(result.redacted).toBe(true);
    expect(audit.list().map((entry) => entry.result)).toEqual(['allowed', 'redacted']);
    await expect(
      broker.execute({
        tenant,
        invocationId,
        grantId: grant.grant.grantId,
        authority: envelope,
        resources: [resource],
        input: {},
        now,
      }),
    ).rejects.toThrow('usage limit');
  });

  it('rejects resource escape and authority revocation at execution time', async () => {
    const { authority, envelope, broker } = setup();
    const grant = await broker.issueGrant({
      tenant,
      invocationId,
      authority: envelope,
      toolName: 'catalog',
      operation: 'read',
      resourceScopes: [resource],
      expiresAt: '2026-08-02T00:30:00.000Z',
      now,
    });
    await expect(
      broker.execute({
        tenant,
        invocationId,
        grantId: grant.grant.grantId,
        authority: envelope,
        resources: [{ kind: 'dataset', id: 'dataset-2' }],
        input: {},
        now,
      }),
    ).rejects.toThrow('outside');
    authority.revoke(tenant, agentId);
    await expect(
      broker.execute({
        tenant,
        invocationId,
        grantId: grant.grant.grantId,
        authority: envelope,
        resources: [resource],
        input: {},
        now,
      }),
    ).rejects.toThrow('revoked');
  });

  it('rejects a tool operation that the authority did not declare', async () => {
    const { broker, envelope } = setup();
    await expect(
      broker.issueGrant({
        tenant,
        invocationId,
        authority: envelope,
        toolName: 'catalog',
        operation: 'write',
        resourceScopes: [resource],
        expiresAt: '2026-08-02T00:30:00.000Z',
        now,
      }),
    ).rejects.toThrow('Tool operation is not permitted');
  });

  it('records invocation correlation for each executed tool operation', async () => {
    const { broker, envelope, audit } = setup();
    const grant = await broker.issueGrant({
      tenant,
      invocationId,
      authority: envelope,
      toolName: 'catalog',
      operation: 'read',
      resourceScopes: [resource],
      expiresAt: '2026-08-02T00:30:00.000Z',
      now,
    });
    await broker.execute({
      tenant,
      invocationId,
      correlationId,
      grantId: grant.grant.grantId,
      authority: envelope,
      resources: [resource],
      input: {},
      now,
    });
    expect(audit.list().at(-1)?.evidence).toMatchObject({ invocationId, correlationId });
  });
});
