import { describe, expect, it, vi } from 'vitest';
import {
  LocalConfirmationService,
  type LocalConfirmationChallenge,
} from '@agentic-platform/policy';
import {
  handleLocalApiRequest,
  InMemorySettingsStore,
  type ApiSession,
  type LocalApiOptions,
} from '../src/index.js';
import {
  type Actor,
  type Id,
  type TenantRef,
  type WorkspaceContext,
} from '@agentic-platform/runtime-contracts';

const tenant: TenantRef = {
  tenantId: '018f0c4b-4e90-7abc-8def-0123456789ab' as Id,
  workspaceId: '018f0c4b-4e91-7abc-8def-0123456789ab' as Id,
};
const organizationId = '018f0c4b-4e92-7abc-8def-0123456789ab' as Id;
const now = '2026-08-02T00:00:00.000Z';
const actor: Actor = {
  actorId: '018f0c4b-4e93-7abc-8def-0123456789ab' as Id,
  type: 'human',
  displayName: 'Initial user',
};

function session(context: WorkspaceContext): ApiSession {
  return {
    schemaVersion: 1,
    sessionId: '018f0c4b-4e94-7abc-8def-0123456789ab' as Id,
    actor,
    tenant,
    workspaces: [tenant],
    workspaceContext: context,
    workspaceContexts: [context],
    scopes: ['local'],
    issuedAt: now,
    expiresAt: '2026-08-02T01:00:00.000Z',
  };
}

function options(
  context: WorkspaceContext = { ...tenant, mode: 'personal_local' },
): LocalApiOptions {
  return {
    orchestrator: {} as LocalApiOptions['orchestrator'],
    tenant,
    localSession: session(context),
    workspaceContext: context,
    settings: new InMemorySettingsStore(),
    confirmations: new LocalConfirmationService({ clock: () => now }),
    clock: () => now,
  };
}

describe('local settings and workspace context boundaries', () => {
  it('persists profile and scoped settings with revision protection', async () => {
    const api = options();
    const profile = await handleLocalApiRequest(
      {
        method: 'PUT',
        path: '/v1/profile',
        body: { displayName: 'Ada', onboardingComplete: true, expectedRevision: 0 },
      },
      api,
    );
    expect(profile.statusCode).toBe(200);
    expect(profile.body).toMatchObject({
      profile: { displayName: 'Ada', onboardingComplete: true },
    });

    const userSettings = await handleLocalApiRequest(
      {
        method: 'PUT',
        path: '/v1/settings',
        body: {
          scope: 'user',
          expectedRevision: 1,
          patch: { layout: { defaultLandingPage: 'projects' } },
        },
      },
      api,
    );
    expect(userSettings.body).toMatchObject({
      revision: 2,
      values: { layout: { defaultLandingPage: 'projects' } },
    });
    await expect(
      handleLocalApiRequest(
        {
          method: 'PUT',
          path: '/v1/settings',
          body: { scope: 'user', expectedRevision: 1, patch: { density: 'compact' } },
        },
        api,
      ),
    ).rejects.toMatchObject({ code: 'CONCURRENCY_STALE_VERSION' });
  });

  it('exposes local confirmations separately from organization approvals', async () => {
    const api = options();
    const challengeResponse = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/confirmations/challenge',
        body: { action: { kind: 'external_network', host: 'example.test' } },
      },
      api,
    );
    expect(challengeResponse.statusCode).toBe(201);
    const challenge = challengeResponse.body as LocalConfirmationChallenge;

    const confirmed = await handleLocalApiRequest(
      {
        method: 'POST',
        path: `/v1/confirmations/${challenge.challengeId}/confirm`,
        body: { action: { kind: 'external_network', host: 'example.test' } },
      },
      api,
    );
    expect(confirmed.statusCode).toBe(200);
    await expect(
      handleLocalApiRequest(
        {
          method: 'POST',
          path: `/v1/confirmations/${challenge.challengeId}/confirm`,
          body: { action: { kind: 'external_network', host: 'example.test' } },
        },
        api,
      ),
    ).rejects.toMatchObject({ code: 'LOCAL_CONFIRMATION_REQUIRED' });

    const approvals = await handleLocalApiRequest(
      { method: 'GET', path: '/v1/approvals', body: undefined },
      api,
    );
    expect(approvals.statusCode).toBe(404);
  });

  it('keeps approval capabilities available only in a trusted organization context', async () => {
    const personal = await handleLocalApiRequest(
      { method: 'GET', path: '/v1/capabilities', body: undefined },
      options(),
    );
    expect(personal.body).toMatchObject({
      workspaceMode: 'personal_local',
      policyEnforcement: 'local',
      capabilities: {
        'approval-queue': { enabled: false },
        governance: { enabled: false },
      },
    });

    const organizationContext: WorkspaceContext = {
      ...tenant,
      mode: 'organization_local',
      organizationId,
    };
    const organization = await handleLocalApiRequest(
      { method: 'GET', path: '/v1/capabilities', body: undefined },
      options(organizationContext),
    );
    expect(organization.body).toMatchObject({
      workspaceMode: 'organization_local',
      policyEnforcement: 'organization',
      capabilities: { 'approval-queue': { enabled: true } },
    });
  });

  it('holds effectful Jupyter launch behind an action-bound local confirmation', async () => {
    const launch = vi.fn(async () => ({
      session: { sessionId: 'session-1', state: 'ready' },
      token: 'ephemeral-token',
      accessUrl: 'http://127.0.0.1:8888/lab?token=ephemeral-token',
    }));
    const api = options();
    api.providerRuntime = {
      jupyter: { launch },
    } as LocalApiOptions['providerRuntime'];
    const body = { notebookId: 'notebook-main' };
    let challengeId = '';
    try {
      await handleLocalApiRequest({ method: 'POST', path: '/v1/jupyter/sessions', body }, api);
    } catch (error) {
      expect(error).toMatchObject({ code: 'LOCAL_CONFIRMATION_REQUIRED' });
      challengeId = (error as { evidence: readonly string[] }).evidence[0] ?? '';
    }
    expect(challengeId).toBeTruthy();
    await handleLocalApiRequest(
      {
        method: 'POST',
        path: `/v1/confirmations/${challengeId}/confirm`,
        body: { action: { kind: 'jupyter.launch', notebookId: 'notebook-main' } },
      },
      api,
    );
    const launched = await handleLocalApiRequest(
      {
        method: 'POST',
        path: '/v1/jupyter/sessions',
        body: { ...body, confirmationId: challengeId },
      },
      api,
    );
    expect(launched.statusCode).toBe(201);
    expect(launch).toHaveBeenCalledOnce();
  });
});
