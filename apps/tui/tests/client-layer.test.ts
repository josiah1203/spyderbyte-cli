import { describe, expect, it } from 'vitest';
import { newSortableId, type Run, type RuntimeEvent } from '@agentic-platform/runtime-contracts';
import { SpyderbyteClient, createSpyderbyteClients } from '@agentic-platform/client-sdk';
import { decodeRichShellFrame, encodeRichShellFrame } from '../src/index.js';
import {
  renderSpyderbyteEvent,
  renderSpyderbyteRecord,
  renderSpyderbyteRun,
  type ShellRunRecord,
} from '../src/rendering.js';

describe('shell client boundary', () => {
  it('frames the rich shell bridge without leaking newlines or terminal authority', () => {
    const frame = encodeRichShellFrame('DELTA', 'line one\nline two · ✓');
    expect(frame).toMatch(/^DELTA\t[0-9a-f]+\n$/);
    expect(decodeRichShellFrame(frame)).toEqual({
      command: 'DELTA',
      fields: ['line one\nline two · ✓'],
    });
  });

  it('renders mocked Spyderbyte events and domain records without provider logic', () => {
    const tenant = { tenantId: newSortableId(), workspaceId: newSortableId() };
    const actor = { actorId: newSortableId(), type: 'system' as const, displayName: 'Spyderbyte' };
    const event: RuntimeEvent = {
      schemaVersion: 1,
      eventId: newSortableId(),
      eventName: 'run.status-changed.v1',
      tenant,
      aggregateType: 'run',
      aggregateId: newSortableId(),
      aggregateVersion: 2,
      occurredAt: new Date().toISOString(),
      actor,
      correlationId: newSortableId(),
      payload: { state: 'succeeded' },
    };
    const run = {
      schemaVersion: 1,
      runId: event.aggregateId,
      tenant,
      requestedAction: 'test',
      initiatingPrincipal: actor,
      sourceInterface: 'cli' as const,
      inputReferences: [],
      state: 'succeeded' as const,
      attemptIds: [],
      createdAt: event.occurredAt,
      updatedAt: event.occurredAt,
    } as Run;
    const record: ShellRunRecord = { run, attempts: [], logs: [] };

    expect(renderSpyderbyteEvent(event)).toContain('run.status-changed.v1');
    expect(renderSpyderbyteRecord(record)).toContain(event.aggregateId);
    expect(renderSpyderbyteRun(record)).toContain('succeeded');
  });

  it('exposes the named client bundle as the shell dependency boundary', () => {
    const client = new SpyderbyteClient({
      baseUrl: 'http://127.0.0.1:8787',
      fetcher: async () => new Response(JSON.stringify({}), { status: 200 }),
    });
    const clients = createSpyderbyteClients(client);
    expect(clients.run.run).toBe(client.run);
    expect(clients.artifact.artifacts).toBe(client.artifacts);
    expect(clients.provider.providers).toBe(client.providers);
    expect(clients.runtime.health).toBe(client.health);
    expect(clients.approval.listApprovals).toBe(client.listApprovals);
    expect(clients.usage.notebookUsage).toBe(client.notebookUsage);
  });
});
