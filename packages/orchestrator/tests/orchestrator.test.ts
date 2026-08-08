import { describe, expect, it } from 'vitest';
import { ContentAddressedArtifactRegistry } from '@agentic-platform/artifact-registry';
import { createLocalDatasetRegistry } from '@agentic-platform/agent-registry';
import { ApprovalService, AuthorityService, InMemoryApprovalStore } from '@agentic-platform/policy';
import {
  newSortableId,
  type Id,
  type RuntimeCommand,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import { InMemoryStateStore } from '@agentic-platform/state';
import {
  LocalDatasetWorkflowOrchestrator,
  type LocalDatasetOrchestratorOptions,
} from '../src/index.js';
import type { Actor } from '@agentic-platform/runtime-contracts';

const tenant: TenantRef = {
  tenantId: '018f0c4b-4e70-7abc-8def-0123456789ab' as Id,
  workspaceId: '018f0c4b-4e71-7abc-8def-0123456789ab' as Id,
};
const actor: Actor = {
  actorId: '018f0c4b-4e72-7abc-8def-0123456789ab' as Id,
  type: 'human',
  displayName: 'Local dataset tester',
};
const now = '2026-08-02T00:00:00.000Z';

async function fixture(
  content: string,
  beforePublish?: LocalDatasetOrchestratorOptions['beforePublish'],
) {
  const state = new InMemoryStateStore();
  const artifacts = new ContentAddressedArtifactRegistry(state);
  const sourceArtifactId = newSortableId();
  const staged = await artifacts.stageUpload(tenant, content, 'text/csv', now);
  await artifacts.publish({
    tenant,
    artifactId: sourceArtifactId,
    stagedUploadId: staged.stagedUploadId,
    mediaType: 'text/csv',
    createdBy: actor,
    now,
  });
  const orchestrator = new LocalDatasetWorkflowOrchestrator({
    state,
    artifacts,
    agents: createLocalDatasetRegistry(),
    authority: new AuthorityService({ clock: () => now }),
    clock: () => now,
    ...(beforePublish !== undefined ? { beforePublish } : {}),
  });
  return { orchestrator, artifacts, sourceArtifactId };
}

function command(
  sourceArtifactId: Id,
  workflowId: Id,
  accessScopes = ['dataset.read'],
): RuntimeCommand {
  return {
    schemaVersion: 1,
    commandId: newSortableId(),
    commandType: 'ValidateDataset',
    tenant,
    actor,
    issuedAt: now,
    idempotencyKey: `validate-${workflowId}`,
    correlationId: workflowId,
    payload: {
      sourceArtifactId,
      sourceArtifactVersion: 1,
      intendedUse: 'local quality validation',
      requestedAccessScopes: accessScopes,
      retentionDays: 30,
      requiredColumns: ['id', 'value'],
      expectedTypes: { id: 'number' },
      leakageThreshold: 0,
      splitSeed: 'orchestrator-fixture',
    },
  };
}

describe('local dataset workflow', () => {
  it('plans, invokes both specialists, publishes immutable outputs, and replays idempotently', async () => {
    const { orchestrator, sourceArtifactId } = await fixture('id,value\n1,10\n2,20\n');
    const workflowId = newSortableId();
    const request = command(sourceArtifactId, workflowId);
    const result = await orchestrator.submit(request);

    expect(result.status).toBe('completed');
    expect(result.governanceDecisionArtifact).toBeDefined();
    expect(result.dataQualityReportArtifact).toBeDefined();
    expect(result.validatedDatasetArtifact).toBeDefined();
    const events = await orchestrator.listEvents(tenant, workflowId);
    expect(events.some((event) => event.eventName === 'workflow.planned.v1')).toBe(true);
    expect(events.filter((event) => event.eventName === 'invocation.created.v1')).toHaveLength(3);

    const replay = await orchestrator.submit(request);
    expect(replay.workflowId).toBe(result.workflowId);
    expect(replay.status).toBe('completed');
    expect(replay.validatedDatasetArtifact?.artifactId).toBe(
      result.validatedDatasetArtifact?.artifactId,
    );
  });

  it('holds a typed plan for approval and executes only after an authorized decision', async () => {
    const state = new InMemoryStateStore();
    const artifacts = new ContentAddressedArtifactRegistry(state);
    const authority = new AuthorityService({ clock: () => now });
    const approvals = new ApprovalService({
      authority,
      store: new InMemoryApprovalStore(),
      clock: () => now,
    });
    const staged = await artifacts.stageUpload(tenant, 'id,value\n1,10\n2,20\n', 'text/csv', now);
    const sourceArtifactId = newSortableId();
    await artifacts.publish({
      tenant,
      artifactId: sourceArtifactId,
      stagedUploadId: staged.stagedUploadId,
      mediaType: 'text/csv',
      createdBy: actor,
      now,
    });
    const orchestrator = new LocalDatasetWorkflowOrchestrator({
      state,
      artifacts,
      agents: createLocalDatasetRegistry(),
      authority,
      approvals,
      clock: () => now,
    });
    const workflowId = newSortableId();
    const plan = await orchestrator.plan(command(sourceArtifactId, workflowId));

    expect(plan.plan.steps.every((step) => step.approvalRequired)).toBe(true);
    expect(plan.approval?.state).toBe('pending');
    const pending = await orchestrator.runPlanned(tenant, workflowId);
    expect(pending.status).toBe('awaiting_approval');
    expect((await orchestrator.getWorkflow(tenant, workflowId))?.value.state).toBe(
      'awaiting_approval',
    );

    const approver: Actor = { actorId: newSortableId(), type: 'human', displayName: 'Reviewer' };
    const approval = plan.approval;
    if (approval?.workflowId === undefined || approval.invocationId === undefined) {
      throw new Error('Approval was not bound to the planned workflow');
    }
    const approverAuthority = authority.issue({
      tenant,
      workflowId: approval.workflowId,
      invocationId: approval.invocationId,
      issuer: approver,
      subjectAgentId: approver.actorId,
      tier: 0,
      harnessVersion: 'orchestrator.test.v1',
      permittedActions: ['approval.decide'],
      capabilities: [],
      resourceScopes: approval.resources,
      allowedArtifactReads: [],
      allowedArtifactWrites: [],
      allowedChildAgentTypes: [],
      maxChildCount: 0,
      toolOperations: [],
      issuedAt: now,
      expiresAt: '2026-08-02T01:00:00.000Z',
    });
    const decided = approvals.decide(
      tenant,
      approval.approvalId,
      'approved',
      approver,
      approverAuthority,
      now,
      'Reviewed locally',
    );
    expect(decided.request.state).toBe('approved');
    const result = await orchestrator.runPlanned(tenant, workflowId);
    expect(result.status).toBe('completed');
    expect(result.validatedDatasetArtifact).toBeDefined();
  });

  it('exposes a typed plan before execution and runs the reviewed workflow', async () => {
    const { orchestrator, sourceArtifactId } = await fixture('id,value\n1,10\n2,20\n');
    const workflowId = newSortableId();
    const planned = await orchestrator.plan({
      ...command(sourceArtifactId, workflowId),
      commandType: 'PlanRun',
    });

    expect(planned.workflowId).toBe(workflowId);
    expect(planned.planVersion).toBe(1);
    expect(planned.plan.steps).toHaveLength(2);
    expect(planned.sourceArtifact.artifactId).toBe(sourceArtifactId);

    const beforeRun = await orchestrator.getWorkflow(tenant, workflowId);
    expect(beforeRun?.value.state).toBe('planning');

    const result = await orchestrator.runPlanned(tenant, workflowId);
    expect(result.status).toBe('completed');
    expect(result.workflowId).toBe(workflowId);
  });

  it('blocks on Governance denial and never invokes the Data Engineer', async () => {
    const { orchestrator, sourceArtifactId } = await fixture('id,email\n1,a@example.com\n');
    const result = await orchestrator.submit(command(sourceArtifactId, newSortableId()));

    expect(result.status).toBe('blocked');
    expect(result.reasonCodes).toContain('PII_SCOPE_NOT_REQUESTED');
    const events = await orchestrator.listEvents(tenant, result.workflowId);
    expect(events.filter((event) => event.eventName === 'invocation.created.v1')).toHaveLength(2);
    expect(result.dataQualityReportArtifact).toBeUndefined();
  });

  it('fails publication when a human edits the source during validation', async () => {
    const hookState: {
      artifacts?: ContentAddressedArtifactRegistry;
      sourceArtifactId?: Id;
      edited: boolean;
    } = { edited: false };
    const beforePublish = async ({ stage }: { stage: string }) => {
      if (
        stage !== 'quality-report' ||
        hookState.edited ||
        !hookState.artifacts ||
        !hookState.sourceArtifactId
      )
        return;
      hookState.edited = true;
      const staged = await hookState.artifacts.stageUpload(
        tenant,
        'id,value\n1,99\n',
        'text/csv',
        now,
      );
      await hookState.artifacts.publish({
        tenant,
        artifactId: hookState.sourceArtifactId,
        stagedUploadId: staged.stagedUploadId,
        mediaType: 'text/csv',
        createdBy: actor,
        expectedParentVersion: 1,
        now,
      });
    };
    const fixtureValue = await fixture('id,value\n1,10\n2,20\n', beforePublish);
    hookState.artifacts = fixtureValue.artifacts;
    hookState.sourceArtifactId = fixtureValue.sourceArtifactId;
    const result = await fixtureValue.orchestrator.submit(
      command(fixtureValue.sourceArtifactId, newSortableId()),
    );

    expect(result.status).toBe('failed');
    expect(result.reasonCodes.some((reason) => reason.includes('Source artifact changed'))).toBe(
      true,
    );
  });

  it('rejects mechanically invalid schema in Data Engineer without publishing a validated dataset', async () => {
    const { orchestrator, sourceArtifactId } = await fixture('id,value\nnot-a-number,10\n');
    const request = command(sourceArtifactId, newSortableId());
    (request.payload as Record<string, unknown>)['expectedTypes'] = { id: 'number' };
    const result = await orchestrator.submit(request);
    expect(result.status).toBe('failed');
    expect(result.reasonCodes).toContain('SCHEMA_INVALID');
    expect(result.validatedDatasetArtifact).toBeUndefined();
  });

  it('blocks split leakage as a domain decision rather than reporting false success', async () => {
    const rows = ['id,value'];
    for (let index = 0; index < 120; index += 1) rows.push('1,duplicate');
    const { orchestrator, sourceArtifactId } = await fixture(`${rows.join('\n')}\n`);
    const request = command(sourceArtifactId, newSortableId());
    (request.payload as Record<string, unknown>)['leakageThreshold'] = 0;
    const result = await orchestrator.submit(request);
    expect(result.status).toBe('blocked');
    expect(result.reasonCodes).toContain('LEAKAGE_THRESHOLD_EXCEEDED');
    expect(result.validatedDatasetArtifact).toBeUndefined();
  });

  it('cancels the active child and records a terminal cancellation state', async () => {
    const controller = new AbortController();
    const hookState: { controller?: AbortController; fired: boolean } = { fired: false };
    const fixtureValue = await fixture('id,value\n1,10\n', ({ stage }) => {
      if (stage === 'governance-decision' && !hookState.fired) {
        hookState.fired = true;
        hookState.controller?.abort();
      }
    });
    hookState.controller = controller;
    const result = await fixtureValue.orchestrator.submit(
      command(fixtureValue.sourceArtifactId, newSortableId()),
      controller.signal,
    );
    expect(result.status).toBe('cancelled');
    const events = await fixtureValue.orchestrator.listEvents(tenant, result.workflowId);
    expect(
      events.some(
        (event) =>
          event.eventName === 'workflow.state-changed.v1' && event.payload['to'] === 'cancelled',
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.eventName === 'invocation.state-changed.v1' && event.payload['to'] === 'cancelled',
      ),
    ).toBe(true);
  });
});
