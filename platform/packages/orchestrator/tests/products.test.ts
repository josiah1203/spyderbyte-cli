import { describe, expect, it } from 'vitest';
import {
  newSortableId,
  type Id,
  type JsonValue,
  type RuntimeCommand,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import { InMemoryStateStore } from '@agentic-platform/state';
import { LocalProductCommandService } from '../src/products.js';

const now = '2026-08-05T00:00:00.000Z';

function command(
  tenant: TenantRef,
  commandType: string,
  payload: JsonValue,
  idempotencyKey: string,
): RuntimeCommand {
  const commandId = newSortableId();
  return {
    schemaVersion: 1,
    commandId,
    commandType,
    tenant,
    actor: { actorId: newSortableId(), type: 'human', displayName: 'Product command test' },
    issuedAt: now,
    idempotencyKey,
    correlationId: commandId,
    payload,
  };
}

describe('local product commands', () => {
  it('persists projects, replays idempotent creates, and enforces revisions', async () => {
    const state = new InMemoryStateStore();
    const service = new LocalProductCommandService(state);
    const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
    const create = command(
      tenant,
      'CreateProject',
      { name: 'Wire the runtime', objective: 'Live state' },
      'create-project-test',
    );

    const first = await service.execute(create);
    const replay = await service.execute(create);
    expect(replay).toEqual(first);
    const projectId = (first as { projectId: string }).projectId;

    await service.execute(
      command(
        tenant,
        'UpdateProject',
        { projectId, objective: 'Authoritative live state', expectedRevision: 1 },
        'update-project-test',
      ),
    );
    await expect(
      service.execute(
        command(
          tenant,
          'ArchiveProject',
          { projectId, expectedRevision: 0 },
          'archive-project-stale-test',
        ),
      ),
    ).rejects.toThrow('expected revision 0');

    await state.transaction(async (transaction) => {
      const project = await transaction.projects.get(tenant, projectId as Id);
      expect(project).toMatchObject({
        version: 2,
        value: { name: 'Wire the runtime', objective: 'Authoritative live state', state: 'active' },
      });
      expect(await transaction.events.list(tenant)).toHaveLength(2);
    });
  });

  it('persists page resources through generic lifecycle commands', async () => {
    const state = new InMemoryStateStore();
    const service = new LocalProductCommandService(state);
    const tenant: TenantRef = { tenantId: newSortableId(), workspaceId: newSortableId() };
    const created = await service.execute(
      command(
        tenant,
        'CreateQuery',
        { name: 'Revenue query', description: 'select 1' },
        'create-query-test',
      ),
    );
    const queryId = (created as { queryId: string }).queryId;
    expect(service.supports('UpdateQuery')).toBe(true);
    await service.execute(
      command(
        tenant,
        'UpdateQuery',
        { queryId, name: 'Updated revenue query', expectedRevision: 1 },
        'update-query-test',
      ),
    );

    const events = await state.transaction((transaction) => transaction.events.list(tenant));
    expect(events.map((stored) => stored.event.eventName)).toEqual([
      'query.created.v1',
      'query.updated.v1',
    ]);
  });
});
