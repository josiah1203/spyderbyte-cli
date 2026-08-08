import { describe, expect, it } from 'vitest';
import { handleLocalApiRequest } from '@agentic-platform/local-api';
import { newSortableId, type Id } from '@agentic-platform/runtime-contracts';
import { createLocalDaemon } from '../src/index.js';
import type { ConversationAgentAdapter } from '../src/conversation.js';

const tenant = {
  tenantId: '018f0c4b-4ea0-7abc-8def-0123456789ab' as Id,
  workspaceId: '018f0c4b-4ea1-7abc-8def-0123456789ab' as Id,
};
const now = '2026-08-07T00:00:00.000Z';

async function createProject(daemon: ReturnType<typeof createLocalDaemon>): Promise<Id> {
  const projectId = newSortableId();
  await daemon.state.transaction(async (transaction) => {
    await transaction.projects.create(
      tenant,
      projectId,
      {
        schemaVersion: 1,
        projectId,
        tenant,
        name: 'AgentSession fixture',
        objective: 'Exercise the durable agent session path',
        state: 'active',
        createdAt: now,
        updatedAt: now,
      },
      now,
    );
  });
  return projectId;
}

describe('Phase 3 AgentSession integration', () => {
  it('persists typed planning events and continues through the shared Run path', async () => {
    const daemon = createLocalDaemon({ clock: () => now });
    const projectId = await createProject(daemon);
    const actor = { actorId: newSortableId(), type: 'human' as const, displayName: 'CLI user' };
    const accepted = await daemon.conversation.send({
      tenant,
      projectId,
      actor,
      sourceInterface: 'acp',
      text: 'Recommend the first inspection step.',
    });
    if (accepted.sessionId === undefined || accepted.requestId === undefined) {
      throw new Error('AgentSession identifiers were not returned');
    }
    expect(accepted.response).toMatchObject({
      sessionId: accepted.sessionId,
      requestId: accepted.requestId,
      state: 'accepted',
      recommendation: { actions: expect.arrayContaining(['inspect context']) },
      plan: { steps: [expect.objectContaining({ agentType: 'spyderbyte-agent' })] },
      estimate: { resourceClass: 'local-agent' },
    });

    let snapshot = await daemon.conversation.readSession(tenant, accepted.sessionId);
    for (
      let attempt = 0;
      attempt < 1000 && snapshot.responses.at(-1)?.state === 'accepted';
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      snapshot = await daemon.conversation.readSession(tenant, accepted.sessionId);
    }
    expect(snapshot.session).toMatchObject({
      sessionId: accepted.sessionId,
      projectId,
      workspaceId: tenant.workspaceId,
      user: actor,
      sourceInterface: 'acp',
      mode: 'conversation',
      state: 'active',
    });
    expect(snapshot.requests).toHaveLength(1);
    expect(snapshot.requests[0]).toMatchObject({
      requestId: accepted.requestId,
      text: 'Recommend the first inspection step.',
      sourceInterface: 'acp',
    });
    expect(snapshot.events.map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        'context_inspected',
        'recommendation_created',
        'plan_created',
        'estimate_created',
        'policy_evaluated',
        'message_delta',
        'explanation_created',
        'next_action_created',
        'completed',
      ]),
    );
    expect(snapshot.responses.at(-1)).toMatchObject({
      state: 'completed',
      runId: accepted.runId,
      explanation: expect.stringContaining('shared Run'),
    });

    const invocation = await daemon.state.transaction((transaction) =>
      transaction.invocations.get(tenant, accepted.runId),
    );
    expect(invocation?.value).toMatchObject({
      agentType: 'spyderbyte-agent',
      harnessVersion: 'spyderbyte-agent.v1',
    });

    const api = {
      orchestrator: daemon.orchestrator,
      tenant,
      providerRuntime: daemon.providerRuntime,
      conversation: daemon.conversation,
      license: daemon.license,
      clock: () => now,
    };
    const response = await handleLocalApiRequest(
      { method: 'GET', path: `/v1/agent-sessions/${accepted.sessionId}`, body: undefined },
      api,
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      session: { sessionId: accepted.sessionId, sourceInterface: 'acp' },
      requests: [expect.objectContaining({ requestId: accepted.requestId })],
      responses: [expect.objectContaining({ state: 'completed' })],
    });
    const projectResponse = await handleLocalApiRequest(
      { method: 'GET', path: `/v1/projects/${projectId}/agent-session`, body: undefined },
      api,
    );
    expect(projectResponse.statusCode).toBe(200);
    expect(projectResponse.body).toMatchObject({
      session: { sessionId: accepted.sessionId, projectId },
    });
  });

  it('pauses a bounded adapter tool call for a durable policy permission request', async () => {
    let adapterToolCalls = 0;
    const adapter: ConversationAgentAdapter = {
      async createRuntime() {
        return {
          async *streamEvents() {
            adapterToolCalls += 1;
            yield {
              type: 'tool_call' as const,
              toolName: 'catalog',
              operation: 'write',
              input: {},
            };
            yield { type: 'output' as const, value: 'must not execute before approval' };
          },
          async dispose() {},
        };
      },
    };
    const daemon = createLocalDaemon({
      clock: () => now,
      workspaceMode: 'organization_local',
      conversationAgentAdapter: adapter,
    });
    const projectId = await createProject(daemon);
    const accepted = await daemon.conversation.send({
      tenant,
      projectId,
      actor: { actorId: newSortableId(), type: 'human', displayName: 'CLI user' },
      sourceInterface: 'cli',
      text: 'Prepare a catalog update.',
    });
    if (accepted.sessionId === undefined)
      throw new Error('AgentSession identifier was not returned');

    let snapshot = await daemon.conversation.readSession(tenant, accepted.sessionId);
    for (
      let attempt = 0;
      attempt < 1000 && snapshot.responses.at(-1)?.state === 'accepted';
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      snapshot = await daemon.conversation.readSession(tenant, accepted.sessionId);
    }
    expect(adapterToolCalls).toBe(1);
    expect(snapshot.session.state).toBe('awaiting_approval');
    expect(snapshot.responses.at(-1)).toMatchObject({
      state: 'awaiting_permission',
      permissionRequestId: expect.any(String),
      nextAction: 'Review and decide the pending permission request.',
    });
    expect(snapshot.permissions).toMatchObject([
      {
        action: 'catalog.write',
        kind: 'approval',
        state: 'pending',
        reason: expect.stringContaining('tool_approval_required'),
      },
    ]);
    expect(snapshot.events.map((event) => event.kind)).toEqual(
      expect.arrayContaining(['policy_evaluated', 'permission_requested']),
    );
    const run = await daemon.conversation.readRun(tenant, accepted.runId);
    expect(run.run.state).toBe('awaiting_approval');
    expect(run.logs.at(-1)?.message).toContain('Permission required');
  });
});
