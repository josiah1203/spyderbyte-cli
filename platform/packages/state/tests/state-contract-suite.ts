import { describe, expect, it } from 'vitest';
import {
  newSortableId,
  type Id,
  type HashSha256,
  type JsonValue,
  type Project,
  type RuntimeCommand,
  type RuntimeEvent,
  type TenantRef,
  type Workflow,
} from '@agentic-platform/runtime-contracts';
import type { StateStore } from '../src/ports.js';

const now = '2026-08-02T00:00:00.000Z';

function makeTenant(): TenantRef {
  return { tenantId: newSortableId(), workspaceId: newSortableId() };
}

function makeWorkflow(tenant: TenantRef, workflowId: Id): Workflow {
  return {
    schemaVersion: 1,
    workflowId,
    tenant,
    objective: 'State contract suite workflow',
    state: 'planning',
    planVersion: 0,
    createdAt: now,
    updatedAt: now,
    invocationIds: [],
    completionCriteria: ['contract suite completes'],
  };
}

function makeProject(tenant: TenantRef, projectId: Id): Project {
  return {
    schemaVersion: 1,
    projectId,
    tenant,
    name: 'State contract suite project',
    objective: 'Project persistence is part of the shared state boundary.',
    state: 'active',
    createdAt: now,
    updatedAt: now,
  };
}

function makeEvent(
  tenant: TenantRef,
  aggregateId: Id,
  aggregateVersion: number,
  eventName = 'workflow.created.v1',
  payload: JsonValue = { state: 'planning' },
): RuntimeEvent {
  return {
    schemaVersion: 1,
    eventId: newSortableId(),
    eventName,
    tenant,
    aggregateType: 'workflow',
    aggregateId,
    aggregateVersion,
    occurredAt: now,
    actor: { actorId: newSortableId(), type: 'human', displayName: 'State contract suite' },
    correlationId: aggregateId,
    payload,
  };
}

function makeCommand(tenant: TenantRef, commandId: Id, idempotencyKey: string): RuntimeCommand {
  return {
    schemaVersion: 1,
    commandId,
    commandType: 'StateContractCommand',
    tenant,
    actor: { actorId: newSortableId(), type: 'human', displayName: 'State contract suite' },
    issuedAt: now,
    idempotencyKey,
    correlationId: commandId,
    payload: { ok: true },
  };
}

export function registerStateContractSuite(
  name: string,
  createStore: () => StateStore | Promise<StateStore>,
): void {
  describe(name, () => {
    it('commits aggregates, events, outbox rows, and command results atomically', async () => {
      const store = await createStore();
      const tenant = makeTenant();
      const workflowId = newSortableId();
      const projectId = newSortableId();
      const command = makeCommand(tenant, newSortableId(), `command-${newSortableId()}`);

      await store.transaction(async (transaction) => {
        const project = await transaction.projects.create(
          tenant,
          projectId,
          makeProject(tenant, projectId),
          now,
        );
        expect(project.version).toBe(0);
        const aggregate = await transaction.workflows.create(
          tenant,
          workflowId,
          makeWorkflow(tenant, workflowId),
          now,
        );
        expect(aggregate.version).toBe(0);
        const stored = await transaction.events.append(makeEvent(tenant, workflowId, 1), 0);
        await transaction.outbox.enqueue(stored.event, 'runtime.events', now);
        await transaction.commands.reserve(command, 'digest-1', now);
        await transaction.commands.complete(tenant, command.idempotencyKey, { ok: true }, now);
      });

      await store.transaction(async (transaction) => {
        expect(await transaction.projects.get(tenant, projectId)).toMatchObject({ version: 0 });
        expect(await transaction.workflows.get(tenant, workflowId)).toMatchObject({ version: 0 });
        expect(await transaction.events.list(tenant)).toHaveLength(1);
        expect(await transaction.outbox.pending(tenant, now)).toHaveLength(1);
        expect(await transaction.commands.get(tenant, command.idempotencyKey)).toMatchObject({
          result: { ok: true },
        });
      });
    });

    it('rolls back every authoritative side effect when the transaction callback fails', async () => {
      const store = await createStore();
      const tenant = makeTenant();
      const workflowId = newSortableId();
      const projectId = newSortableId();

      await expect(
        store.transaction(async (transaction) => {
          await transaction.projects.create(tenant, projectId, makeProject(tenant, projectId), now);
          await transaction.workflows.create(
            tenant,
            workflowId,
            makeWorkflow(tenant, workflowId),
            now,
          );
          const stored = await transaction.events.append(makeEvent(tenant, workflowId, 1), 0);
          await transaction.outbox.enqueue(stored.event, 'runtime.events', now);
          throw new Error('state contract rollback');
        }),
      ).rejects.toThrow('state contract rollback');

      await store.transaction(async (transaction) => {
        expect(await transaction.projects.get(tenant, projectId)).toBeUndefined();
        expect(await transaction.workflows.get(tenant, workflowId)).toBeUndefined();
        expect(await transaction.events.list(tenant)).toHaveLength(0);
        expect(await transaction.outbox.pending(tenant, now)).toHaveLength(0);
      });
    });

    it('rejects stale aggregate and event versions deterministically', async () => {
      const store = await createStore();
      const tenant = makeTenant();
      const workflowId = newSortableId();
      const workflow = makeWorkflow(tenant, workflowId);

      await store.transaction(async (transaction) => {
        await transaction.workflows.create(tenant, workflowId, workflow, now);
        await transaction.workflows.update(tenant, workflowId, 0, workflow, now);
        await transaction.events.append(makeEvent(tenant, workflowId, 1), 0);
      });

      await expect(
        store.transaction((transaction) =>
          transaction.workflows.update(tenant, workflowId, 0, workflow, now),
        ),
      ).rejects.toThrow('expected version 0');
      await expect(
        store.transaction((transaction) =>
          transaction.events.append(makeEvent(tenant, workflowId, 1), 0),
        ),
      ).rejects.toThrow('expected event version 0');
    });

    it('deduplicates outbox, commands, checkpoints, and side-effect receipts', async () => {
      const store = await createStore();
      const tenant = makeTenant();
      const workflowId = newSortableId();
      const command = makeCommand(tenant, newSortableId(), `command-${newSortableId()}`);

      await store.transaction(async (transaction) => {
        const stored = await transaction.events.append(makeEvent(tenant, workflowId, 1), 0);
        const first = await transaction.outbox.enqueue(stored.event, 'runtime.events', now);
        const duplicate = await transaction.outbox.enqueue(stored.event, 'runtime.events', now);
        expect(duplicate.outboxId).toBe(first.outboxId);
        await transaction.outbox.incrementAttempt(tenant, first.outboxId);
        await transaction.outbox.markPublished(tenant, first.outboxId, now);
        await transaction.outbox.markPublished(tenant, first.outboxId, now);
        expect(await transaction.outbox.pending(tenant, now)).toHaveLength(0);

        const reserved = await transaction.commands.reserve(command, 'digest-1', now);
        const same = await transaction.commands.reserve(command, 'digest-1', now);
        expect(same.commandId).toBe(reserved.commandId);
        await expect(transaction.commands.reserve(command, 'digest-2', now)).rejects.toThrow(
          'different request digest',
        );

        await transaction.checkpoints.save({
          tenant,
          projectionName: 'state-contract',
          streamSequence: stored.streamSequence,
          updatedAt: now,
        });
        expect(await transaction.checkpoints.get(tenant, 'state-contract')).toMatchObject({
          streamSequence: stored.streamSequence,
        });

        const receipt = {
          tenant,
          receiptId: newSortableId(),
          effectKey: 'state-contract-effect',
          result: { ok: true },
          recordedAt: now,
        };
        await transaction.receipts.record(receipt);
        const duplicateReceipt = await transaction.receipts.record({
          ...receipt,
          receiptId: newSortableId(),
          result: { ok: false },
        });
        expect(duplicateReceipt.result).toEqual({ ok: true });
      });
    });

    it('claims outbox rows durably, isolates owners, and reclaims expired work', async () => {
      const store = await createStore();
      const tenant = makeTenant();
      const workflowId = newSortableId();
      const claimExpiresAt = '2026-08-02T00:00:10.000Z';
      const afterExpiry = '2026-08-02T00:00:11.000Z';
      const replacementExpiry = '2026-08-02T00:00:30.000Z';
      let outboxId: Id | undefined;

      await store.transaction(async (transaction) => {
        const stored = await transaction.events.append(makeEvent(tenant, workflowId, 1), 0);
        const outbox = await transaction.outbox.enqueue(stored.event, 'runtime.events', now);
        outboxId = outbox.outboxId;
      });

      await store.transaction(async (transaction) => {
        const claimed = await transaction.outbox.claimPending(
          tenant,
          now,
          'consumer-a',
          claimExpiresAt,
          1,
        );
        expect(claimed).toHaveLength(1);
        expect(claimed[0]).toMatchObject({
          outboxId,
          claimedBy: 'consumer-a',
          claimExpiresAt,
        });
        expect(
          await transaction.outbox.claimPending(tenant, now, 'consumer-b', claimExpiresAt, 1),
        ).toHaveLength(0);
      });

      await expect(
        store.transaction((transaction) =>
          transaction.outbox.markPublished(
            tenant,
            outboxId as Id,
            afterExpiry,
            'consumer-a',
            afterExpiry,
          ),
        ),
      ).rejects.toThrow('no longer actively claimed');

      await store.transaction(async (transaction) => {
        const reclaimed = await transaction.outbox.claimPending(
          tenant,
          afterExpiry,
          'consumer-b',
          replacementExpiry,
          1,
        );
        expect(reclaimed).toHaveLength(1);
        expect(reclaimed[0]?.claimedBy).toBe('consumer-b');
        await expect(
          transaction.outbox.incrementAttempt(tenant, outboxId as Id, 'consumer-a', afterExpiry),
        ).rejects.toThrow('no longer actively claimed');
        await transaction.outbox.incrementAttempt(
          tenant,
          outboxId as Id,
          'consumer-b',
          afterExpiry,
        );
        await transaction.outbox.markPublished(
          tenant,
          outboxId as Id,
          afterExpiry,
          'consumer-b',
          afterExpiry,
        );
        expect(await transaction.outbox.pending(tenant, afterExpiry)).toHaveLength(0);
      });
    });

    it('persists immutable artifact versions and separate lifecycle status', async () => {
      const store = await createStore();
      const tenant = makeTenant();
      const artifactId = newSortableId();
      const actor = {
        actorId: newSortableId(),
        type: 'human' as const,
        displayName: 'State contract artifact owner',
      };
      const record = {
        reference: {
          schemaVersion: 1 as const,
          tenant,
          artifactId,
          version: 1,
          contentHash: 'a'.repeat(64) as HashSha256,
          mediaType: 'text/plain',
          sizeBytes: 1,
          createdAt: now,
          uri: `sha256/${'a'.repeat(64)}`,
        },
        state: 'valid' as const,
        createdBy: actor,
        lineage: [],
        publishedAt: now,
      };

      await store.transaction(async (transaction) => {
        await transaction.artifactVersions.publish(record, 0);
        expect(await transaction.artifactVersions.current(tenant, artifactId)).toMatchObject({
          reference: { version: 1 },
          state: 'valid',
        });
        await transaction.artifactVersions.markStale(tenant, artifactId, 1, now);
        expect(await transaction.artifactVersions.get(tenant, artifactId, 1)).toMatchObject({
          state: 'stale',
        });
      });

      await expect(
        store.transaction((transaction) =>
          transaction.artifactVersions.publish({ ...record, state: 'valid' }, 0),
        ),
      ).rejects.toThrow('expected parent 0, actual 1');
    });
  });
}
