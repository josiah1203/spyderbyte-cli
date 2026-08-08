import { describe, expect, it } from 'vitest';
import {
  newSortableId,
  type TenantRef,
  type WorkspaceContext,
} from '@agentic-platform/runtime-contracts';
import { handleLocalApiRequest, type LocalApiOptions } from '../src/index.js';

describe('Phase 11 release and operations controls', () => {
  it('returns a redacted support bundle without forwarding workspace secrets', async () => {
    const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
    const workspaceContext = {
      ...tenant,
      mode: 'personal_local',
      apiKey: 'support-bundle-secret',
    } as unknown as WorkspaceContext;
    const api: LocalApiOptions = {
      orchestrator: {} as LocalApiOptions['orchestrator'],
      tenant,
      workspaceContext,
      clock: () => '2026-08-07T00:00:00.000Z',
    };

    const response = await handleLocalApiRequest(
      { method: 'POST', path: '/v1/diagnostics/support-bundle', body: {} },
      api,
    );
    const serialized = JSON.stringify(response.body);

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      schemaVersion: 1,
      bundleType: 'spyderbyte-support',
      generatedAt: '2026-08-07T00:00:00.000Z',
    });
    expect(serialized).not.toContain('support-bundle-secret');
    expect(serialized).toContain('[REDACTED]');
  });
});
