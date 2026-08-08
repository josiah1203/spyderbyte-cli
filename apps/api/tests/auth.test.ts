import { describe, expect, it } from 'vitest';
import { createLocalDatasetRegistry } from '@agentic-platform/agent-registry';
import { ContentAddressedArtifactRegistry } from '@agentic-platform/artifact-registry';
import { LocalDatasetWorkflowOrchestrator } from '@agentic-platform/orchestrator';
import { AuthorityService } from '@agentic-platform/policy';
import { newSortableId, type Actor, type TenantRef } from '@agentic-platform/runtime-contracts';
import { InMemoryStateStore } from '@agentic-platform/state';
import {
  handleLocalApiRequest,
  InMemorySessionAuthenticator,
  StaticBearerSessionAuthenticator,
  type LocalApiOptions,
} from '../src/index.js';

const now = '2026-08-03T00:00:00.000Z';
const later = '2026-08-03T00:02:00.000Z';
const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
const actor: Actor = { actorId: newSortableId(), type: 'human' };

function options(authenticator: InMemorySessionAuthenticator): LocalApiOptions {
  const state = new InMemoryStateStore();
  const artifacts = new ContentAddressedArtifactRegistry(state);
  return {
    tenant,
    sessionAuthenticator: authenticator,
    orchestrator: new LocalDatasetWorkflowOrchestrator({
      state,
      artifacts,
      agents: createLocalDatasetRegistry(),
      authority: new AuthorityService({ clock: () => now }),
      clock: () => now,
    }),
    clock: () => now,
  };
}

describe('API session authentication', () => {
  it('authenticates the desktop bearer through authorization and the SSE cookie', () => {
    const token = 'desktop-session-token-0123456789';
    const session = {
      schemaVersion: 1 as const,
      sessionId: newSortableId(),
      actor,
      tenant,
      workspaces: [tenant],
      scopes: ['local'],
      issuedAt: now,
      expiresAt: '9999-12-31T23:59:59.999Z',
    };
    const authenticator = new StaticBearerSessionAuthenticator(token, session);
    expect(authenticator.authenticate({ authorization: `Bearer ${token}` }, now)).toMatchObject({
      sessionId: session.sessionId,
      tenant,
    });
    expect(
      authenticator.authenticate({ cookie: `agentic_local_session=${token}` }, now),
    ).toMatchObject({ sessionId: session.sessionId, tenant });
    expect(() => authenticator.authenticate({ authorization: 'Bearer wrong-token' }, now)).toThrow(
      'Authenticated API session is required',
    );
  });

  it('accepts a valid bearer session without retaining the raw token', async () => {
    const authenticator = new InMemorySessionAuthenticator();
    const issued = authenticator.issue({
      actor,
      tenant,
      scopes: ['workspace.read'],
      issuedAt: now,
      expiresAt: '2026-08-03T01:00:00.000Z',
    });
    const response = await handleLocalApiRequest(
      {
        method: 'GET',
        path: '/v1/agents',
        body: undefined,
        headers: { authorization: `Bearer ${issued.token}` },
      },
      options(authenticator),
    );
    expect(response.statusCode).toBe(200);
    const sessionResponse = await handleLocalApiRequest(
      {
        method: 'GET',
        path: '/v1/session',
        body: undefined,
        headers: { authorization: `Bearer ${issued.token}` },
      },
      options(authenticator),
    );
    expect(sessionResponse).toMatchObject({
      statusCode: 200,
      body: { sessionId: issued.session.sessionId, tenant, workspaces: [tenant] },
    });
  });

  it('fails closed for missing, expired, revoked, and unassigned workspace sessions', async () => {
    const authenticator = new InMemorySessionAuthenticator();
    const apiOptions = options(authenticator);
    const request = {
      method: 'GET',
      path: '/v1/agents',
      body: undefined,
    } as const;
    await expect(handleLocalApiRequest(request, apiOptions)).rejects.toThrow(
      'Authenticated API session is required',
    );

    const expired = authenticator.issue({
      actor,
      tenant,
      issuedAt: now,
      expiresAt: '2026-08-03T00:01:00.000Z',
    });
    await expect(
      handleLocalApiRequest(
        { ...request, headers: { authorization: `Bearer ${expired.token}` } },
        { ...apiOptions, clock: () => later },
      ),
    ).rejects.toThrow('has expired');
    expect(authenticator.revoke(expired.session.sessionId)).toBe(true);

    const otherTenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
    const unassignedWorkspace = authenticator.issue({
      actor,
      tenant,
      issuedAt: now,
      expiresAt: '2026-08-03T01:00:00.000Z',
    });
    await expect(
      handleLocalApiRequest(
        {
          ...request,
          headers: {
            authorization: `Bearer ${unassignedWorkspace.token}`,
            'x-agentic-workspace-id': otherTenant.workspaceId,
          },
        },
        apiOptions,
      ),
    ).rejects.toThrow('not assigned to the session');
  });

  it('accepts the same header contract used by the SSE handler', () => {
    const authenticator = new InMemorySessionAuthenticator();
    const issued = authenticator.issue({
      actor,
      tenant,
      issuedAt: now,
      expiresAt: '2026-08-03T01:00:00.000Z',
    });
    expect(
      authenticator.authenticate({ authorization: `Bearer ${issued.token}` }, now).tenant,
    ).toEqual(tenant);
  });

  it('selects only a workspace assigned to the authenticated session', async () => {
    const authenticator = new InMemorySessionAuthenticator();
    const otherWorkspace: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
    const issued = authenticator.issue({
      actor,
      tenant,
      workspaces: [tenant, otherWorkspace],
      issuedAt: now,
      expiresAt: '2026-08-03T01:00:00.000Z',
    });
    const response = await handleLocalApiRequest(
      {
        method: 'GET',
        path: '/v1/session',
        body: undefined,
        headers: {
          authorization: `Bearer ${issued.token}`,
          'x-agentic-workspace-id': otherWorkspace.workspaceId,
        },
      },
      options(authenticator),
    );
    expect(response).toMatchObject({ statusCode: 200, body: { tenant: otherWorkspace } });
  });
});
