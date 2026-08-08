import {
  newSortableId,
  runtimeError,
  type AgentTier,
  type Id,
  type JsonValue,
  type RuntimeEvent,
  type TenantRef,
  type Workflow,
} from '@agentic-platform/runtime-contracts';
import type { StateStore } from '@agentic-platform/state';

export interface StartWorkflowRequest {
  readonly tenant: TenantRef;
  readonly workflowId: Id;
  readonly definitionVersion: string;
  readonly now: string;
  readonly correlationId?: Id;
}

export interface WorkflowHandle {
  readonly engine: 'internal' | 'external';
  readonly engineWorkflowId: string;
  readonly workflowId: Id;
  readonly tenant: TenantRef;
  readonly definitionVersion: string;
}

/**
 * An explicitly registered, compatible workflow-code migration.
 *
 * The engine never infers compatibility from version strings. A deployment
 * must register the exact migration pair before an in-flight workflow can be
 * moved to the new definition.
 */
export interface WorkflowDefinitionUpgrade {
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly migrationId: string;
}

export interface WorkflowDefinitionUpgradeRequest extends WorkflowDefinitionUpgrade {
  readonly now: string;
}

export type WorkflowSignal =
  | {
      readonly type: 'approval';
      readonly approvalId: Id;
      readonly outcome: 'approved' | 'rejected' | 'expired' | 'revoked';
    }
  | {
      readonly type: 'activity';
      readonly activityId: string;
      readonly attempt?: number;
      readonly outcome: 'completed' | 'failed';
      readonly result?: JsonValue;
      readonly failureCode?: string;
    }
  | { readonly type: 'external'; readonly name: string; readonly payload: JsonValue };

export interface ActivityRequest {
  readonly activityId: string;
  readonly name: string;
  readonly input: JsonValue;
  readonly ownerTier: AgentTier;
  readonly maxAttempts: number;
  readonly retryableFailureCodes: readonly string[];
}

export type ActivityHandler = (
  input: JsonValue,
  attempt: number,
  signal: AbortSignal,
) => Promise<JsonValue>;

export interface ActivityRecord extends ActivityRequest {
  readonly status: 'scheduled' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  readonly attempt: number;
  readonly attempts: readonly RetryRecord[];
  readonly result?: JsonValue;
  readonly failureCode?: string;
}

export interface RetryRecord {
  readonly attempt: number;
  readonly failureCode?: string;
  readonly ownerTier: AgentTier | 'control-plane';
  readonly contextFreshness: 'fresh' | 'reused';
  readonly costMinor: number;
  readonly outcome: 'retrying' | 'failed' | 'succeeded';
}

export interface WorkflowEngineState {
  readonly workflowId: Id;
  readonly engineWorkflowId: string;
  readonly definitionVersion: string;
  readonly status:
    | 'running'
    | 'waiting_for_approval'
    | 'waiting_for_activity'
    | 'completed'
    | 'failed'
    | 'cancelled';
  readonly activity?: ActivityRecord;
  readonly approvalId?: Id;
  readonly lastSignal?: WorkflowSignal;
}

export interface WorkflowEngine {
  start(request: StartWorkflowRequest): Promise<WorkflowHandle>;
  upgradeDefinition(
    handle: WorkflowHandle,
    request: WorkflowDefinitionUpgradeRequest,
  ): Promise<WorkflowHandle>;
  signal(handle: WorkflowHandle, signal: WorkflowSignal): Promise<void>;
  query(handle: WorkflowHandle): Promise<WorkflowEngineState>;
  scheduleActivity(handle: WorkflowHandle, request: ActivityRequest): Promise<ActivityRecord>;
  waitForApproval(handle: WorkflowHandle, approvalId: Id): Promise<void>;
  cancel(handle: WorkflowHandle, reason: string): Promise<void>;
  resumeAfterRestart(handle: WorkflowHandle): Promise<WorkflowEngineState>;
}

export interface ExternalWorkflowClient {
  start(request: StartWorkflowRequest): Promise<WorkflowHandle>;
  upgradeDefinition(
    handle: WorkflowHandle,
    request: WorkflowDefinitionUpgradeRequest,
  ): Promise<WorkflowHandle>;
  signal(handle: WorkflowHandle, signal: WorkflowSignal): Promise<void>;
  query(handle: WorkflowHandle): Promise<WorkflowEngineState>;
  scheduleActivity(handle: WorkflowHandle, request: ActivityRequest): Promise<ActivityRecord>;
  waitForApproval(handle: WorkflowHandle, approvalId: Id): Promise<void>;
  cancel(handle: WorkflowHandle, reason: string): Promise<void>;
  resumeAfterRestart(handle: WorkflowHandle): Promise<WorkflowEngineState>;
}

export class ExternalWorkflowEngine implements WorkflowEngine {
  private readonly client: ExternalWorkflowClient;

  constructor(client: ExternalWorkflowClient) {
    this.client = client;
  }

  async start(request: StartWorkflowRequest): Promise<WorkflowHandle> {
    return this.assertExternalHandle(await this.client.start(request));
  }

  upgradeDefinition(
    handle: WorkflowHandle,
    request: WorkflowDefinitionUpgradeRequest,
  ): Promise<WorkflowHandle> {
    return this.client
      .upgradeDefinition(this.assertExternalHandle(handle), request)
      .then((next) => this.assertExternalHandle(next));
  }

  signal(handle: WorkflowHandle, signal: WorkflowSignal): Promise<void> {
    return this.client.signal(this.assertExternalHandle(handle), signal);
  }

  query(handle: WorkflowHandle): Promise<WorkflowEngineState> {
    return this.client.query(this.assertExternalHandle(handle));
  }

  scheduleActivity(handle: WorkflowHandle, request: ActivityRequest): Promise<ActivityRecord> {
    return this.client.scheduleActivity(this.assertExternalHandle(handle), request);
  }

  waitForApproval(handle: WorkflowHandle, approvalId: Id): Promise<void> {
    return this.client.waitForApproval(this.assertExternalHandle(handle), approvalId);
  }

  cancel(handle: WorkflowHandle, reason: string): Promise<void> {
    return this.client.cancel(this.assertExternalHandle(handle), reason);
  }

  resumeAfterRestart(handle: WorkflowHandle): Promise<WorkflowEngineState> {
    return this.client.resumeAfterRestart(this.assertExternalHandle(handle));
  }

  private assertExternalHandle(handle: WorkflowHandle): WorkflowHandle {
    if (handle.engine !== 'external')
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Workflow handle belongs to another engine');
    return structuredClone(handle);
  }
}

type PersistedEngineState = {
  engineWorkflowId: string;
  definitionVersion: string;
  status: WorkflowEngineState['status'];
  activity?: ActivityRecord;
  approvalId?: Id;
  lastSignal?: WorkflowSignal;
};

function upgradeKey(fromVersion: string, toVersion: string): string {
  return `${fromVersion}\u0000${toVersion}`;
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readState(workflow: Workflow): PersistedEngineState | undefined {
  const raw = workflow.constraints?.['__workflowEngine'];
  if (
    !isRecord(raw) ||
    typeof raw['engineWorkflowId'] !== 'string' ||
    typeof raw['definitionVersion'] !== 'string'
  ) {
    return undefined;
  }
  return raw as unknown as PersistedEngineState;
}

function asJson(value: PersistedEngineState): JsonValue {
  return value as unknown as JsonValue;
}

function engineId(workflowId: Id): string {
  return `internal:${workflowId}`;
}

function systemEvent(
  tenant: TenantRef,
  workflowId: Id,
  name: string,
  payload: JsonValue,
  now: string,
  version: number,
): RuntimeEvent {
  return {
    schemaVersion: 1,
    eventId: newSortableId(),
    eventName: name,
    tenant,
    aggregateType: 'workflow-engine',
    aggregateId: workflowId,
    aggregateVersion: version,
    occurredAt: now,
    actor: { actorId: newSortableId(), type: 'system' },
    correlationId: workflowId,
    payload,
  };
}

function updateWorkflow(
  workflow: Workflow,
  state: PersistedEngineState,
  updatedAt: string,
): Workflow {
  return {
    ...workflow,
    constraints: {
      ...(workflow.constraints ?? {}),
      __workflowEngine: asJson(state),
    },
    updatedAt,
  };
}

export class DurableWorkflowEngine implements WorkflowEngine {
  private readonly state: StateStore;
  private readonly activityHandlers = new Map<string, ActivityHandler>();
  private readonly activeActivities = new Map<
    string,
    { readonly attempt: number; readonly controller: AbortController }
  >();
  private readonly definitionUpgrades = new Map<string, WorkflowDefinitionUpgrade>();
  private readonly clock: () => string;

  constructor(options: {
    state: StateStore;
    clock?: () => string;
    definitionUpgrades?: readonly WorkflowDefinitionUpgrade[];
  }) {
    this.state = options.state;
    this.clock = options.clock ?? (() => new Date().toISOString());
    for (const upgrade of options.definitionUpgrades ?? []) {
      if (
        upgrade.fromVersion.length === 0 ||
        upgrade.toVersion.length === 0 ||
        upgrade.migrationId.length === 0 ||
        upgrade.fromVersion === upgrade.toVersion
      ) {
        throw runtimeError('VALIDATION_INVALID_INPUT', 'Workflow definition upgrade is invalid');
      }
      const key = upgradeKey(upgrade.fromVersion, upgrade.toVersion);
      if (this.definitionUpgrades.has(key)) {
        throw runtimeError(
          'VALIDATION_INVALID_INPUT',
          `Workflow definition upgrade ${upgrade.fromVersion} -> ${upgrade.toVersion} is duplicated`,
        );
      }
      this.definitionUpgrades.set(key, structuredClone(upgrade));
    }
  }

  registerActivity(name: string, handler: ActivityHandler): void {
    if (this.activityHandlers.has(name))
      throw runtimeError('VALIDATION_INVALID_INPUT', `Activity ${name} is already registered`);
    this.activityHandlers.set(name, handler);
  }

  async start(request: StartWorkflowRequest): Promise<WorkflowHandle> {
    return this.state.transaction(async (transaction) => {
      const existing = await transaction.workflows.get(request.tenant, request.workflowId);
      if (existing === undefined)
        throw runtimeError('ARTIFACT_NOT_FOUND', `Workflow ${request.workflowId} was not found`);
      const previous = readState(existing.value);
      if (previous !== undefined) {
        if (previous.definitionVersion !== request.definitionVersion) {
          throw runtimeError(
            'CONCURRENCY_STALE_VERSION',
            'In-flight workflow is pinned to another definition version',
          );
        }
        return this.handle(request.tenant, request.workflowId, previous);
      }
      const persisted: PersistedEngineState = {
        engineWorkflowId: engineId(request.workflowId),
        definitionVersion: request.definitionVersion,
        status: 'running',
      };
      await transaction.workflows.update(
        request.tenant,
        request.workflowId,
        existing.version,
        updateWorkflow(existing.value, persisted, request.now),
        request.now,
      );
      await this.appendEngineEvent(
        transaction,
        request.tenant,
        request.workflowId,
        'workflow-engine.started.v1',
        {
          definitionVersion: request.definitionVersion,
        },
        request.now,
      );
      return this.handle(request.tenant, request.workflowId, persisted);
    });
  }

  async upgradeDefinition(
    handle: WorkflowHandle,
    request: WorkflowDefinitionUpgradeRequest,
  ): Promise<WorkflowHandle> {
    if (handle.engine !== 'internal')
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Workflow handle belongs to another engine');
    const registered = this.definitionUpgrades.get(
      upgradeKey(request.fromVersion, request.toVersion),
    );
    if (registered?.migrationId !== request.migrationId) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'Workflow definition upgrade is not registered as compatible',
      );
    }
    return this.state.transaction(async (transaction) => {
      const existing = await transaction.workflows.get(handle.tenant, handle.workflowId);
      if (existing === undefined)
        throw runtimeError('ARTIFACT_NOT_FOUND', `Workflow ${handle.workflowId} was not found`);
      const current = readState(existing.value);
      if (
        current === undefined ||
        current.engineWorkflowId !== handle.engineWorkflowId ||
        current.definitionVersion !== handle.definitionVersion ||
        current.definitionVersion !== request.fromVersion
      ) {
        throw runtimeError(
          'VALIDATION_INVALID_INPUT',
          'Unknown or incompatible workflow engine handle',
        );
      }
      if (['completed', 'failed', 'cancelled'].includes(current.status)) {
        throw runtimeError(
          'VALIDATION_INVALID_INPUT',
          'Terminal workflows cannot receive a definition upgrade',
        );
      }
      const next = { ...current, definitionVersion: request.toVersion };
      await transaction.workflows.update(
        handle.tenant,
        handle.workflowId,
        existing.version,
        updateWorkflow(existing.value, next, request.now),
        request.now,
      );
      await this.appendEngineEvent(
        transaction,
        handle.tenant,
        handle.workflowId,
        'workflow-engine.definition-upgraded.v1',
        {
          fromVersion: request.fromVersion,
          toVersion: request.toVersion,
          migrationId: request.migrationId,
        },
        request.now,
      );
      return this.handle(handle.tenant, handle.workflowId, next);
    });
  }

  async signal(handle: WorkflowHandle, signal: WorkflowSignal): Promise<void> {
    await this.mutate(
      handle,
      (current) => {
        if (
          current.status === 'cancelled' ||
          current.status === 'failed' ||
          current.status === 'completed'
        )
          return current;
        let next: PersistedEngineState = { ...current, lastSignal: structuredClone(signal) };
        if (signal.type === 'approval') {
          if (current.approvalId !== signal.approvalId)
            throw runtimeError(
              'APPROVAL_INVALIDATED',
              'Approval signal is not bound to the waiting workflow',
            );
          next = {
            ...next,
            status:
              signal.outcome === 'approved'
                ? 'running'
                : signal.outcome === 'revoked'
                  ? 'cancelled'
                  : 'failed',
          };
          if (signal.outcome === 'approved') {
            const withoutApproval = { ...next };
            delete withoutApproval.approvalId;
            next = withoutApproval;
          }
        }
        if (signal.type === 'activity') {
          if (current.activity?.activityId !== signal.activityId)
            throw runtimeError(
              'VALIDATION_INVALID_INPUT',
              'Activity signal is not bound to the workflow',
            );
          if (signal.attempt !== undefined && current.activity.attempt !== signal.attempt)
            return current;
          if (current.activity.status === 'succeeded' || current.activity.status === 'failed')
            return current;
          next = {
            ...next,
            status: signal.outcome === 'completed' ? 'running' : 'failed',
            activity: {
              ...current.activity,
              status: signal.outcome === 'completed' ? 'succeeded' : 'failed',
              ...(signal.outcome === 'completed'
                ? {
                    attempts: [
                      ...current.activity.attempts,
                      {
                        attempt: current.activity.attempt,
                        ownerTier: current.activity.ownerTier,
                        contextFreshness: 'fresh' as const,
                        costMinor: 0,
                        outcome: 'succeeded' as const,
                      },
                    ],
                  }
                : {}),
              ...(signal.result !== undefined ? { result: signal.result } : {}),
              ...(signal.failureCode !== undefined ? { failureCode: signal.failureCode } : {}),
            },
          };
        }
        return next;
      },
      'workflow-engine.signaled.v1',
      { signal },
    );
  }

  async query(handle: WorkflowHandle): Promise<WorkflowEngineState> {
    const workflow = await this.state.transaction((transaction) =>
      transaction.workflows.get(handle.tenant, handle.workflowId),
    );
    if (workflow === undefined)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Workflow ${handle.workflowId} was not found`);
    const current = readState(workflow.value);
    if (
      current === undefined ||
      current.engineWorkflowId !== handle.engineWorkflowId ||
      current.definitionVersion !== handle.definitionVersion
    )
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Unknown workflow engine handle');
    return this.publicState(workflow.value.workflowId, current);
  }

  async scheduleActivity(
    handle: WorkflowHandle,
    request: ActivityRequest,
  ): Promise<ActivityRecord> {
    if (!Number.isSafeInteger(request.maxAttempts) || request.maxAttempts < 1)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Activity maxAttempts must be positive');
    let scheduled!: ActivityRecord;
    await this.mutate(
      handle,
      (current) => {
        if (current.activity?.activityId === request.activityId) {
          scheduled = current.activity;
          return current;
        }
        if (
          current.status === 'cancelled' ||
          current.status === 'failed' ||
          current.status === 'completed'
        )
          throw runtimeError(
            'VALIDATION_INVALID_INPUT',
            'Cannot schedule activity on a terminal workflow',
          );
        scheduled = { ...request, status: 'scheduled', attempt: 0, attempts: [] };
        return { ...current, status: 'waiting_for_activity', activity: scheduled };
      },
      'workflow-engine.activity-scheduled.v1',
      { activityId: request.activityId, name: request.name },
    );
    return structuredClone(scheduled);
  }

  async waitForApproval(handle: WorkflowHandle, approvalId: Id): Promise<void> {
    await this.mutate(
      handle,
      (current) =>
        current.status === 'cancelled' ||
        current.status === 'failed' ||
        current.status === 'completed'
          ? current
          : { ...current, status: 'waiting_for_approval', approvalId },
      'workflow-engine.approval-waiting.v1',
      { approvalId },
    );
  }

  async cancel(handle: WorkflowHandle, reason: string): Promise<void> {
    await this.mutate(
      handle,
      (current) =>
        current.status === 'completed' || current.status === 'cancelled'
          ? current
          : { ...current, status: 'cancelled' },
      'workflow-engine.cancelled.v1',
      { reason },
    );
    this.activeActivities.get(this.activityKey(handle))?.controller.abort();
  }

  async resumeAfterRestart(handle: WorkflowHandle): Promise<WorkflowEngineState> {
    const current = await this.query(handle);
    if (
      current.status !== 'waiting_for_activity' ||
      current.activity?.status === 'succeeded' ||
      current.activity?.status === 'failed' ||
      current.activity === undefined
    )
      return current;
    const activity = current.activity;
    const handler = this.activityHandlers.get(activity.name);
    if (handler === undefined) return current;
    const attempt = activity.attempt + 1;
    const controller = new AbortController();
    const activityKey = this.activityKey(handle);
    this.activeActivities.set(activityKey, { attempt, controller });
    await this.mutate(
      handle,
      (state) => ({
        ...state,
        activity: { ...activity, status: 'running', attempt },
      }),
      'workflow-engine.activity-started.v1',
      { activityId: activity.activityId, attempt },
    );
    try {
      const result = await handler(activity.input, attempt, controller.signal);
      await this.signal(handle, {
        type: 'activity',
        activityId: activity.activityId,
        attempt,
        outcome: 'completed',
        result,
      });
    } catch (error) {
      const failureCode =
        error instanceof Error && 'code' in error && typeof error.code === 'string'
          ? error.code
          : 'UNKNOWN';
      const ownerTier = retryOwner(activity.ownerTier, failureCode);
      const retry: RetryRecord = {
        attempt,
        failureCode,
        ownerTier,
        contextFreshness: 'fresh',
        costMinor: 0,
        outcome:
          attempt < activity.maxAttempts && activity.retryableFailureCodes.includes(failureCode)
            ? 'retrying'
            : 'failed',
      };
      await this.mutate(
        handle,
        (state) => {
          if (
            state.status === 'cancelled' ||
            state.status === 'failed' ||
            state.status === 'completed' ||
            state.activity?.attempt !== attempt ||
            state.activity.status !== 'running'
          )
            return state;
          return {
            ...state,
            status: retry.outcome === 'retrying' ? 'waiting_for_activity' : 'failed',
            activity: {
              ...activity,
              status: retry.outcome === 'retrying' ? 'scheduled' : 'failed',
              attempt,
              attempts: [...activity.attempts, retry],
              failureCode,
            },
          };
        },
        'workflow-engine.activity-failed.v1',
        { activityId: activity.activityId, attempt, failureCode, ownerTier },
      );
    } finally {
      if (this.activeActivities.get(activityKey)?.attempt === attempt) {
        this.activeActivities.delete(activityKey);
      }
    }
    return this.query(handle);
  }

  private activityKey(handle: WorkflowHandle): string {
    return `${handle.tenant.tenantId}:${handle.tenant.workspaceId}:${handle.workflowId}:${handle.engineWorkflowId}`;
  }

  private handle(tenant: TenantRef, workflowId: Id, state: PersistedEngineState): WorkflowHandle {
    return {
      engine: 'internal',
      engineWorkflowId: state.engineWorkflowId,
      workflowId,
      tenant,
      definitionVersion: state.definitionVersion,
    };
  }

  private publicState(workflowId: Id, state: PersistedEngineState): WorkflowEngineState {
    return {
      workflowId,
      engineWorkflowId: state.engineWorkflowId,
      definitionVersion: state.definitionVersion,
      status: state.status,
      ...(state.activity !== undefined ? { activity: structuredClone(state.activity) } : {}),
      ...(state.approvalId !== undefined ? { approvalId: state.approvalId } : {}),
      ...(state.lastSignal !== undefined ? { lastSignal: structuredClone(state.lastSignal) } : {}),
    };
  }

  private async mutate(
    handle: WorkflowHandle,
    update: (state: PersistedEngineState) => PersistedEngineState,
    eventName: string,
    payload: JsonValue,
  ): Promise<void> {
    await this.state.transaction(async (transaction) => {
      const existing = await transaction.workflows.get(handle.tenant, handle.workflowId);
      if (existing === undefined)
        throw runtimeError('ARTIFACT_NOT_FOUND', `Workflow ${handle.workflowId} was not found`);
      const current = readState(existing.value);
      if (
        current === undefined ||
        current.engineWorkflowId !== handle.engineWorkflowId ||
        current.definitionVersion !== handle.definitionVersion
      ) {
        throw runtimeError(
          'VALIDATION_INVALID_INPUT',
          'Unknown or incompatible workflow engine handle',
        );
      }
      const next = update(current);
      if (JSON.stringify(next) === JSON.stringify(current)) return;
      const now = this.clock();
      await transaction.workflows.update(
        handle.tenant,
        handle.workflowId,
        existing.version,
        updateWorkflow(existing.value, next, now),
        now,
      );
      await this.appendEngineEvent(
        transaction,
        handle.tenant,
        handle.workflowId,
        eventName,
        payload,
        now,
      );
    });
  }

  private async appendEngineEvent(
    transaction: Parameters<Parameters<StateStore['transaction']>[0]>[0],
    tenant: TenantRef,
    workflowId: Id,
    eventName: string,
    payload: JsonValue,
    now: string,
  ): Promise<void> {
    const events = await transaction.events.list(tenant);
    const version =
      events
        .filter(
          ({ event }) =>
            event.aggregateType === 'workflow-engine' && event.aggregateId === workflowId,
        )
        .at(-1)?.event.aggregateVersion ?? 0;
    const stored = await transaction.events.append(
      systemEvent(tenant, workflowId, eventName, payload, now, version + 1),
      version,
    );
    await transaction.outbox.enqueue(stored.event, 'runtime.events', now);
  }
}

export function retryOwner(tier: AgentTier, failureCode: string): AgentTier | 'control-plane' {
  if (tier === 2) return 'control-plane';
  if (tier === 1 && ['CAPACITY_UNAVAILABLE', 'NODE_FAILURE', 'NETWORK'].includes(failureCode))
    return 1;
  return 0;
}
