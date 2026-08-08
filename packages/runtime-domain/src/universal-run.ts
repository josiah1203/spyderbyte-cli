import { createHash } from 'node:crypto';
import {
  isJsonValue,
  newSortableId,
  runtimeError,
  type Actor,
  type AgentInterface,
  type ArtifactReference,
  type EnvironmentRevision,
  type ExecutionPlan,
  type ExecutionReplay,
  type ExecutionRequest,
  type FailureRecord,
  type Id,
  type JsonValue,
  type NetworkPolicy,
  type Run,
  type RunAttempt,
  type RunState,
  type RuntimeEvent,
  type RuntimeProfile,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import type { StateStore, StoredEvent } from '@agentic-platform/state';

export interface ExecutionEnvelopeInput {
  readonly runId?: Id;
  readonly tenant: TenantRef;
  readonly actor: Actor;
  readonly projectId?: Id;
  readonly sourceInterface: AgentInterface;
  readonly action: string;
  readonly inputReferences?: readonly ArtifactReference[];
  readonly idempotencyKey?: string;
  readonly runtime?: RuntimeProfile;
  readonly environment?: EnvironmentRevision;
  readonly replay?: ExecutionReplay;
  readonly clock?: () => string;
}

export interface UniversalRunOperationResult {
  readonly statusCode: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  /** A runtime-specific child identifier is metadata only; the universal Run remains authoritative. */
  readonly operationRunId?: string;
  /** An adapter may provide a precise lifecycle state when the response is asynchronous. */
  readonly state?: RunState;
  readonly outputReferences?: readonly ArtifactReference[];
  readonly resourceUsage?: JsonValue;
  readonly error?: FailureRecord;
}

export interface UniversalRunExecutionContext {
  readonly runId: Id;
  readonly attemptId: Id;
  readonly request: ExecutionRequest;
  readonly attemptNumber: number;
  readonly signal: AbortSignal;
}

export interface UniversalRunLog {
  readonly eventId: Id;
  readonly runId: Id;
  readonly eventName: string;
  readonly occurredAt: string;
  readonly message: string;
  readonly level: 'info' | 'error' | 'output';
}

export interface UniversalRunDetail {
  readonly run: Run;
  readonly attempts: readonly RunAttempt[];
  readonly logs: readonly UniversalRunLog[];
}

export interface UniversalRunCancellation {
  readonly runId: Id;
  readonly state: 'cancelled' | RunState;
  readonly cancelled: boolean;
  readonly status: 'cancel_requested' | 'already_terminal';
}

const TERMINAL_STATES: readonly RunState[] = [
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'partially_succeeded',
];

const RUN_STATES: readonly RunState[] = [
  'draft',
  'validating',
  'awaiting_configuration',
  'awaiting_approval',
  'queued',
  'provisioning',
  'running',
  'finalizing',
  ...TERMINAL_STATES,
];

const DEFAULT_NETWORK_POLICY: NetworkPolicy = {
  mode: 'offline',
  allowlist: [],
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function jsonValue(value: unknown): JsonValue {
  return isJsonValue(value) ? value : null;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
    .join(',')}}`;
}

function digest(value: JsonValue): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function defaultRuntime(tenant: TenantRef, now: string): RuntimeProfile {
  const runtimeProfileId = newSortableId();
  return {
    schemaVersion: 1,
    runtimeProfileId,
    tenant,
    runtimeType: 'local-host',
    displayName: 'Local execution runtime',
    state: 'ready',
    createdAt: now,
    updatedAt: now,
  };
}

function defaultEnvironment(
  tenant: TenantRef,
  runtime: RuntimeProfile,
  now: string,
): EnvironmentRevision {
  return {
    schemaVersion: 1,
    environmentId: newSortableId(),
    tenant,
    name: 'local-default',
    revision: 1,
    runtimeProfileId: runtime.runtimeProfileId,
    state: 'ready',
    createdAt: now,
  };
}

export function createExecutionRequest(input: ExecutionEnvelopeInput): ExecutionRequest {
  const now = input.clock?.() ?? new Date().toISOString();
  const runId = input.runId ?? newSortableId();
  const runtime = input.runtime ?? defaultRuntime(input.tenant, now);
  const environment = input.environment ?? defaultEnvironment(input.tenant, runtime, now);
  const networkPolicyMode: NetworkPolicy['mode'] =
    runtime.networkPolicy === 'allowlist' || runtime.networkPolicy === 'unrestricted'
      ? runtime.networkPolicy
      : 'offline';
  return {
    schemaVersion: 1,
    executionRequestId: newSortableId(),
    runId,
    tenant: input.tenant,
    actor: input.actor,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    sourceInterface: input.sourceInterface,
    action: input.action,
    inputReferences: [...(input.inputReferences ?? [])],
    environment,
    runtime,
    computeRequirements: {
      ...(runtime.cpuMillicores === undefined ? {} : { cpuMillicores: runtime.cpuMillicores }),
      ...(runtime.memoryBytes === undefined ? {} : { memoryBytes: runtime.memoryBytes }),
      ...(runtime.gpuCount === undefined ? {} : { gpuCount: runtime.gpuCount }),
      ...(runtime.gpuType === undefined ? {} : { gpuType: runtime.gpuType }),
    },
    networkPolicy: {
      ...DEFAULT_NETWORK_POLICY,
      mode: networkPolicyMode,
    },
    secrets: [],
    limits: {
      wallTimeMs: 120_000,
      outputBytes: 10 * 1024 * 1024,
      storageBytes: 512 * 1024 * 1024,
      processCount: 16,
    },
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    ...(input.replay === undefined ? {} : { replay: input.replay }),
    createdAt: now,
  };
}

export function createExecutionPlan(request: ExecutionRequest): ExecutionPlan {
  const planId = newSortableId();
  const stepId = newSortableId();
  const planWithoutDigest: Omit<ExecutionPlan, 'digest'> = {
    schemaVersion: 1,
    planId,
    // A standalone execution has no workflow aggregate. The Run is its durable parent.
    workflowId: request.runId,
    executionRequestId: request.executionRequestId,
    version: 1,
    steps: [
      {
        stepId,
        tier: 0,
        agentType: 'spyderbyte-execution',
        title: request.action,
        description: `Execute ${request.action} under the selected runtime and policy envelope.`,
        dependsOn: [],
        inputArtifactIds: request.inputReferences.map((reference) => reference.artifactId),
        requiredCapabilities: [`execution:${request.action}`],
        approvalRequired: false,
        acceptanceCriteria: [
          'The authoritative Run records the result, artifacts, usage, and audit linkage.',
        ],
      },
    ],
    createdAt: request.createdAt,
  };
  return {
    ...planWithoutDigest,
    digest: digest(planWithoutDigest as unknown as JsonValue) as ExecutionPlan['digest'],
  };
}

function failure(error: unknown, occurredAt: string): FailureRecord {
  const candidate = error as { code?: unknown };
  return {
    failureId: newSortableId(),
    code: typeof candidate?.code === 'string' ? candidate.code : 'RUN_FAILED',
    message: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
    retryable: true,
    occurredAt,
  };
}

function runState(value: unknown): RunState | undefined {
  if (RUN_STATES.includes(value as RunState)) return value as RunState;
  if (
    value === 'completed' ||
    value === 'complete' ||
    value === 'success' ||
    value === 'succeeded'
  ) {
    return 'succeeded';
  }
  if (value === 'error' || value === 'failure' || value === 'failed') return 'failed';
  return undefined;
}

function findState(value: unknown): RunState | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findState(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value === null || typeof value !== 'object') return undefined;
  const candidate = record(value);
  for (const key of ['state', 'status']) {
    const found = runState(candidate[key]);
    if (found !== undefined) return found;
  }
  for (const child of Object.values(candidate)) {
    const found = findState(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findRunId(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRunId(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value === null || typeof value !== 'object') return undefined;
  const candidate = record(value);
  if (typeof candidate['runId'] === 'string') return candidate['runId'];
  for (const child of Object.values(candidate)) {
    const found = findRunId(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

function terminal(state: RunState): boolean {
  return TERMINAL_STATES.includes(state);
}

function latestVersion(events: readonly StoredEvent[], runId: Id): number {
  return events.reduce(
    (version, stored) =>
      stored.event.aggregateType === 'run' && stored.event.aggregateId === runId
        ? Math.max(version, stored.event.aggregateVersion)
        : version,
    0,
  );
}

function event(
  tenant: TenantRef,
  actor: Actor,
  runId: Id,
  eventName: string,
  payload: JsonValue,
  occurredAt: string,
): RuntimeEvent {
  return {
    schemaVersion: 1,
    eventId: newSortableId(),
    eventName,
    tenant,
    aggregateType: 'run',
    aggregateId: runId,
    aggregateVersion: 1,
    occurredAt,
    actor,
    correlationId: runId,
    payload,
  };
}

async function appendRunEvents(
  state: StateStore,
  tenant: TenantRef,
  actor: Actor,
  runId: Id,
  events: readonly { readonly name: string; readonly payload: JsonValue; readonly at: string }[],
): Promise<void> {
  await state.transaction(async (transaction) => {
    const existing = await transaction.events.list(tenant, 0);
    let version = latestVersion(existing, runId);
    for (const item of events) {
      const stored = await transaction.events.append(
        event(tenant, actor, runId, item.name, item.payload, item.at),
        version,
      );
      version = stored.event.aggregateVersion;
      await transaction.outbox.enqueue(stored.event, 'runtime.events', item.at);
    }
  });
}

function messageFromPayload(payload: unknown, fallback: string): string {
  const candidate = record(payload);
  const message = candidate['message'] ?? candidate['line'] ?? candidate['output'];
  if (typeof message === 'string') return message;
  return message === undefined ? fallback : JSON.stringify(message);
}

function projectDetail(events: readonly StoredEvent[], runId: Id): UniversalRunDetail | undefined {
  const runEvents = events.filter(
    (stored) => stored.event.aggregateType === 'run' && stored.event.aggregateId === runId,
  );
  let run: Run | undefined;
  const attempts = new Map<string, RunAttempt>();
  const logs: UniversalRunLog[] = [];
  for (const stored of runEvents) {
    const payload = record(stored.event.payload);
    if (stored.event.eventName === 'run.created.v1') {
      const candidate = record(payload['run']);
      if (typeof candidate['runId'] === 'string') run = candidate as unknown as Run;
    }
    if (stored.event.eventName === 'execution.requested.v1') {
      const request = payload['request'];
      if (run !== undefined && request !== undefined) {
        run = { ...run, executionRequest: request as ExecutionRequest };
      }
    }
    if (stored.event.eventName === 'run.plan-created.v1' && run !== undefined) {
      const plan = payload['plan'];
      if (plan !== undefined) run = { ...run, executionPlan: plan as ExecutionPlan };
    }
    if (stored.event.eventName === 'run.status-changed.v1' && run !== undefined) {
      const nextState = runState(payload['state'] ?? payload['to']) ?? run.state;
      run = {
        ...run,
        state: nextState,
        updatedAt: stored.event.occurredAt,
        ...(typeof payload['startedAt'] === 'string'
          ? { startedAt: payload['startedAt'] }
          : nextState === 'running' || nextState === 'provisioning' || nextState === 'finalizing'
            ? { startedAt: stored.event.occurredAt }
            : {}),
        ...(typeof payload['completedAt'] === 'string'
          ? { completedAt: payload['completedAt'] }
          : {}),
        ...(payload['error'] === undefined
          ? {}
          : { error: payload['error'] as NonNullable<Run['error']> }),
      };
      if (!terminal(nextState)) {
        const reopened = { ...run };
        delete reopened.completedAt;
        delete reopened.error;
        run = reopened;
      }
    }
    if (stored.event.eventName === 'run.attempt-created.v1') {
      const candidate = record(payload['attempt']);
      if (typeof candidate['attemptId'] === 'string') {
        attempts.set(candidate['attemptId'], candidate as unknown as RunAttempt);
        if (run !== undefined && !run.attemptIds.includes(candidate['attemptId'] as Id)) {
          run = {
            ...run,
            attemptIds: [...run.attemptIds, candidate['attemptId'] as Id],
            updatedAt: stored.event.occurredAt,
          };
        }
      }
    }
    if (
      stored.event.eventName === 'run.attempt-state-changed.v1' ||
      stored.event.eventName === 'run.attempt-started.v1' ||
      stored.event.eventName === 'run.attempt-completed.v1'
    ) {
      const attemptId = typeof payload['attemptId'] === 'string' ? payload['attemptId'] : undefined;
      if (attemptId !== undefined) {
        const current = attempts.get(attemptId);
        const next: RunAttempt = {
          ...(current ?? {
            schemaVersion: 1,
            attemptId,
            runId,
            tenant: run?.tenant ?? runEvents[0]?.event.tenant,
            attemptNumber: 1,
            outputReferences: [],
          }),
          state: runState(payload['state']) ?? current?.state ?? 'queued',
          ...(typeof payload['startedAt'] === 'string' ? { startedAt: payload['startedAt'] } : {}),
          ...(typeof payload['completedAt'] === 'string'
            ? { completedAt: payload['completedAt'] }
            : {}),
          ...(payload['error'] === undefined
            ? {}
            : { error: payload['error'] as NonNullable<RunAttempt['error']> }),
          ...(payload['resourceUsage'] === undefined
            ? {}
            : { resourceUsage: payload['resourceUsage'] as JsonValue }),
          ...(payload['outputReferences'] === undefined
            ? {}
            : { outputReferences: payload['outputReferences'] as ArtifactReference[] }),
        } as RunAttempt;
        attempts.set(attemptId, next);
      }
    }
    if (
      stored.event.eventName.startsWith('run.log.') ||
      stored.event.eventName === 'run.progress.v1' ||
      stored.event.eventName === 'run.action-linked.v1'
    ) {
      const level = payload['level'];
      logs.push({
        eventId: stored.event.eventId,
        runId,
        eventName: stored.event.eventName,
        occurredAt: stored.event.occurredAt,
        message: messageFromPayload(payload, stored.event.eventName),
        level: level === 'error' || level === 'output' ? level : 'info',
      });
    }
  }
  if (run === undefined) return undefined;
  return {
    run,
    attempts: [...attempts.values()].sort(
      (left, right) => left.attemptNumber - right.attemptNumber,
    ),
    logs,
  };
}

function resultWithRunId(
  result: UniversalRunOperationResult,
  runId: Id,
): UniversalRunOperationResult & { readonly runId: Id } {
  return {
    ...result,
    runId,
    headers: {
      ...(result.headers ?? {}),
      'x-spyderbyte-run-id': runId,
    },
  };
}

function recordedResult(
  events: readonly StoredEvent[],
  runId: Id,
): (UniversalRunOperationResult & { readonly runId: Id }) | undefined {
  const stored = events
    .filter(
      (candidate) =>
        candidate.event.aggregateType === 'run' &&
        candidate.event.aggregateId === runId &&
        candidate.event.eventName === 'run.result-recorded.v1',
    )
    .at(-1);
  if (stored === undefined) return undefined;
  const payload = record(stored.event.payload);
  const result = record(payload['result']);
  if (typeof result['statusCode'] !== 'number') return undefined;
  const state = runState(result['state']);
  return {
    statusCode: result['statusCode'],
    body: result['body'] ?? null,
    ...(result['headers'] === undefined
      ? {}
      : { headers: result['headers'] as Record<string, string> }),
    ...(typeof result['operationRunId'] === 'string'
      ? { operationRunId: result['operationRunId'] }
      : {}),
    ...(state === undefined ? {} : { state }),
    runId,
  };
}

export class UniversalRunCoordinator {
  private readonly controllers = new Map<string, AbortController>();
  private readonly cancelRequested = new Set<string>();
  private readonly replayers = new Map<
    Id,
    (context: UniversalRunExecutionContext) => Promise<UniversalRunOperationResult>
  >();

  constructor(
    private readonly state: StateStore,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  private async tenantEvents(tenant: TenantRef): Promise<readonly StoredEvent[]> {
    return this.state.transaction((transaction) => transaction.events.list(tenant, 0));
  }

  private async findIdempotentRun(
    tenant: TenantRef,
    idempotencyKey: string,
  ): Promise<Id | undefined> {
    const events = await this.tenantEvents(tenant);
    for (const stored of events) {
      if (
        stored.event.aggregateType !== 'run' ||
        stored.event.eventName !== 'execution.requested.v1'
      ) {
        continue;
      }
      const request = record(record(stored.event.payload)['request']);
      if (request['idempotencyKey'] === idempotencyKey) return stored.event.aggregateId;
    }
    return undefined;
  }

  async execute(
    input: ExecutionEnvelopeInput,
    operation: (context: UniversalRunExecutionContext) => Promise<UniversalRunOperationResult>,
  ): Promise<UniversalRunOperationResult & { readonly runId: Id }> {
    if (input.idempotencyKey !== undefined) {
      const existingRunId = await this.findIdempotentRun(input.tenant, input.idempotencyKey);
      if (existingRunId !== undefined) {
        const existing = recordedResult(await this.tenantEvents(input.tenant), existingRunId);
        if (existing !== undefined) return resultWithRunId(existing, existingRunId);
        const detail = await this.read(input.tenant, existingRunId);
        return resultWithRunId(
          {
            statusCode: 202,
            state: detail.run.state,
            body: { runId: existingRunId, state: detail.run.state },
          },
          existingRunId,
        );
      }
    }
    const runId = input.runId ?? newSortableId();
    const request = createExecutionRequest({ ...input, runId, clock: this.clock });
    const plan = createExecutionPlan(request);
    const attemptId = newSortableId();
    const run: Run = {
      schemaVersion: 1,
      runId,
      tenant: input.tenant,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      requestedAction: input.action,
      initiatingPrincipal: input.actor,
      sourceInterface: input.sourceInterface,
      inputReferences: [...request.inputReferences],
      executionRequest: request,
      executionPlan: plan,
      state: 'draft',
      attemptIds: [attemptId],
      createdAt: request.createdAt,
      updatedAt: request.createdAt,
    };
    const attempt: RunAttempt = {
      schemaVersion: 1,
      attemptId,
      runId,
      tenant: input.tenant,
      attemptNumber: 1,
      executionRequestId: request.executionRequestId,
      state: 'queued',
      outputReferences: [],
    };
    await appendRunEvents(this.state, input.tenant, input.actor, runId, [
      {
        name: 'execution.requested.v1',
        payload: { request } as unknown as JsonValue,
        at: request.createdAt,
      },
      { name: 'run.created.v1', payload: { run } as unknown as JsonValue, at: request.createdAt },
      {
        name: 'run.plan-created.v1',
        payload: { plan } as unknown as JsonValue,
        at: request.createdAt,
      },
      {
        name: 'run.attempt-created.v1',
        payload: { attempt } as unknown as JsonValue,
        at: request.createdAt,
      },
      {
        name: 'run.status-changed.v1',
        payload: { runId, state: 'queued' } as unknown as JsonValue,
        at: request.createdAt,
      },
      {
        name: 'run.progress.v1',
        payload: { runId, phase: 'accepted', message: 'Execution request accepted.' },
        at: request.createdAt,
      },
    ]);
    const controller = new AbortController();
    this.controllers.set(String(runId), controller);
    this.replayers.set(runId, operation);
    try {
      const result = await operation({
        runId,
        attemptId,
        request,
        attemptNumber: attempt.attemptNumber,
        signal: controller.signal,
      });
      const operationRunId = result.operationRunId ?? findRunId(result.body);
      const inferred = result.state ?? findState(result.body);
      if (this.cancelRequested.has(String(runId))) {
        return resultWithRunId(
          { statusCode: 202, state: 'cancelled', body: { runId, state: 'cancelled' } },
          runId,
        );
      }
      const current = await this.read(input.tenant, runId);
      const inferredState =
        result.statusCode >= 400
          ? 'failed'
          : (inferred ??
            (result.statusCode === 202 || operationRunId !== undefined ? 'queued' : 'succeeded'));
      const state =
        this.cancelRequested.has(String(runId)) || current.run.state === 'cancelled'
          ? 'cancelled'
          : inferredState;
      const at = this.clock();
      const terminalState = terminal(state);
      const common = {
        runId,
        state,
        ...(operationRunId === undefined ? {} : { operationRunId }),
      };
      const events: { readonly name: string; readonly payload: JsonValue; readonly at: string }[] =
        [
          {
            name: 'run.status-changed.v1',
            payload: {
              ...common,
              ...(terminalState ? { completedAt: at } : {}),
              ...(result.error === undefined ? {} : { error: result.error }),
            } as unknown as JsonValue,
            at,
          },
          {
            name: 'run.progress.v1',
            payload: {
              runId,
              phase: terminalState ? 'finalized' : 'delegated',
              message: terminalState
                ? `Execution ${state}.`
                : 'Execution delegated to a durable runtime operation.',
            } as JsonValue,
            at,
          },
        ];
      if (operationRunId !== undefined) {
        events.push({
          name: 'run.action-linked.v1',
          payload: { runId, operationRunId, action: input.action },
          at,
        });
      }
      if (terminalState) {
        events.push({
          name: 'run.attempt-completed.v1',
          payload: {
            attemptId,
            runId,
            state,
            completedAt: at,
            ...(result.outputReferences === undefined
              ? {}
              : { outputReferences: result.outputReferences }),
            ...(result.resourceUsage === undefined ? {} : { resourceUsage: result.resourceUsage }),
            ...(result.error === undefined ? {} : { error: result.error }),
          } as unknown as JsonValue,
          at,
        });
        events.push({
          name:
            state === 'failed'
              ? 'run.failed.v1'
              : state === 'cancelled'
                ? 'run.cancelled.v1'
                : 'execution.completed.v1',
          payload: { runId, state } as JsonValue,
          at,
        });
      } else {
        events.push({
          name: 'run.attempt-state-changed.v1',
          payload: { attemptId, runId, state } as JsonValue,
          at,
        });
      }
      events.push({
        name: 'run.result-recorded.v1',
        payload: {
          runId,
          result: {
            statusCode: result.statusCode,
            body: jsonValue(result.body),
            ...(result.headers === undefined ? {} : { headers: result.headers as JsonValue }),
            ...(operationRunId === undefined ? {} : { operationRunId }),
            state,
          },
        },
        at,
      });
      await appendRunEvents(this.state, input.tenant, input.actor, runId, events);
      return {
        ...result,
        state,
        runId,
        headers: {
          ...(result.headers ?? {}),
          'x-spyderbyte-run-id': runId,
        },
      };
    } catch (error) {
      if (this.cancelRequested.has(String(runId))) {
        return resultWithRunId(
          {
            statusCode: 202,
            state: 'cancelled',
            body: { runId, state: 'cancelled' },
          },
          runId,
        );
      }
      const at = this.clock();
      const failureRecord = failure(error, at);
      try {
        await appendRunEvents(this.state, input.tenant, input.actor, runId, [
          {
            name: 'run.status-changed.v1',
            payload: {
              runId,
              state: 'failed',
              completedAt: at,
              error: failureRecord,
            } as unknown as JsonValue,
            at,
          },
          {
            name: 'run.attempt-completed.v1',
            payload: {
              attemptId,
              runId,
              state: 'failed',
              completedAt: at,
              error: failureRecord,
            } as unknown as JsonValue,
            at,
          },
          { name: 'run.failed.v1', payload: { runId, state: 'failed' }, at },
          {
            name: 'run.result-recorded.v1',
            payload: {
              runId,
              result: {
                statusCode: 500,
                body: { error: failureRecord.message, runId },
                state: 'failed',
              },
            },
            at,
          },
        ]);
      } catch {
        // Preserve the original operation error; state stores expose their own diagnostics.
      }
      throw error;
    } finally {
      this.controllers.delete(String(runId));
      this.cancelRequested.delete(String(runId));
    }
  }

  /** Replays a terminal Run with a new attempt while retaining the original Run aggregate. */
  async retry(
    tenant: TenantRef,
    runId: Id,
    actor: Actor,
    operation?: (context: UniversalRunExecutionContext) => Promise<UniversalRunOperationResult>,
  ): Promise<UniversalRunOperationResult & { readonly runId: Id }> {
    const detail = await this.read(tenant, runId);
    if (!terminal(detail.run.state)) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Only terminal Runs can be retried');
    }
    const request = detail.run.executionRequest;
    if (request === undefined) {
      throw runtimeError('RETRY_EXHAUSTED', 'The original execution request is unavailable');
    }
    const replay = operation ?? this.replayers.get(runId);
    if (replay === undefined) {
      throw runtimeError('RETRY_EXHAUSTED', 'No replay executor is registered for this Run');
    }
    const attemptNumber =
      Math.max(0, ...detail.attempts.map((attempt) => attempt.attemptNumber)) + 1;
    const attemptId = newSortableId();
    const at = this.clock();
    const attempt: RunAttempt = {
      schemaVersion: 1,
      attemptId,
      runId,
      tenant,
      attemptNumber,
      executionRequestId: request.executionRequestId,
      state: 'queued',
      outputReferences: [],
    };
    await appendRunEvents(this.state, tenant, actor, runId, [
      {
        name: 'run.attempt-created.v1',
        payload: { attempt } as unknown as JsonValue,
        at,
      },
      {
        name: 'run.status-changed.v1',
        payload: { runId, state: 'queued' } as unknown as JsonValue,
        at,
      },
      {
        name: 'run.progress.v1',
        payload: {
          runId,
          phase: 'retrying',
          message: `Retry attempt ${attemptNumber} accepted.`,
        },
        at,
      },
    ]);
    const controller = new AbortController();
    this.controllers.set(String(runId), controller);
    this.cancelRequested.delete(String(runId));
    this.replayers.set(runId, replay);
    try {
      const result = await replay({
        runId,
        attemptId,
        attemptNumber,
        request,
        signal: controller.signal,
      });
      const operationRunId = result.operationRunId ?? findRunId(result.body);
      const inferred = result.state ?? findState(result.body);
      if (this.cancelRequested.has(String(runId))) {
        return resultWithRunId(
          { statusCode: 202, state: 'cancelled', body: { runId, state: 'cancelled' } },
          runId,
        );
      }
      const current = await this.read(tenant, runId);
      const requestedState =
        result.statusCode >= 400
          ? 'failed'
          : (inferred ??
            (result.statusCode === 202 || operationRunId !== undefined ? 'queued' : 'succeeded'));
      const state: RunState =
        this.cancelRequested.has(String(runId)) || current.run.state === 'cancelled'
          ? 'cancelled'
          : requestedState;
      const completedAt = this.clock();
      const events: { readonly name: string; readonly payload: JsonValue; readonly at: string }[] =
        [
          {
            name: 'run.status-changed.v1',
            payload: {
              runId,
              state,
              ...(terminal(state) ? { completedAt } : {}),
              ...(result.error === undefined ? {} : { error: result.error }),
            } as unknown as JsonValue,
            at: completedAt,
          },
          {
            name: 'run.progress.v1',
            payload: {
              runId,
              phase: terminal(state) ? 'finalized' : 'delegated',
              message: terminal(state)
                ? `Execution ${state}.`
                : 'Execution delegated to a durable runtime operation.',
            },
            at: completedAt,
          },
        ];
      if (operationRunId !== undefined) {
        events.push({
          name: 'run.action-linked.v1',
          payload: { runId, operationRunId, action: request.action },
          at: completedAt,
        });
      }
      if (terminal(state)) {
        events.push({
          name: 'run.attempt-completed.v1',
          payload: {
            attemptId,
            runId,
            state,
            completedAt,
            ...(result.outputReferences === undefined
              ? {}
              : { outputReferences: result.outputReferences }),
            ...(result.resourceUsage === undefined ? {} : { resourceUsage: result.resourceUsage }),
            ...(result.error === undefined ? {} : { error: result.error }),
          } as unknown as JsonValue,
          at: completedAt,
        });
        events.push({
          name:
            state === 'failed'
              ? 'run.failed.v1'
              : state === 'cancelled'
                ? 'run.cancelled.v1'
                : 'execution.completed.v1',
          payload: { runId, state } as JsonValue,
          at: completedAt,
        });
      } else {
        events.push({
          name: 'run.attempt-state-changed.v1',
          payload: { attemptId, runId, state } as JsonValue,
          at: completedAt,
        });
      }
      events.push({
        name: 'run.result-recorded.v1',
        payload: {
          runId,
          result: {
            statusCode: result.statusCode,
            body: jsonValue(result.body),
            ...(result.headers === undefined ? {} : { headers: result.headers as JsonValue }),
            ...(operationRunId === undefined ? {} : { operationRunId }),
            state,
          },
        },
        at: completedAt,
      });
      await appendRunEvents(this.state, tenant, actor, runId, events);
      return resultWithRunId(
        {
          ...result,
          state,
          ...(operationRunId === undefined ? {} : { operationRunId }),
        },
        runId,
      );
    } catch (error) {
      if (this.cancelRequested.has(String(runId))) {
        return resultWithRunId(
          { statusCode: 202, state: 'cancelled', body: { runId, state: 'cancelled' } },
          runId,
        );
      }
      const failureRecord = failure(error, this.clock());
      try {
        await appendRunEvents(this.state, tenant, actor, runId, [
          {
            name: 'run.status-changed.v1',
            payload: {
              runId,
              state: 'failed',
              completedAt: failureRecord.occurredAt,
              error: failureRecord,
            } as unknown as JsonValue,
            at: failureRecord.occurredAt,
          },
          {
            name: 'run.attempt-completed.v1',
            payload: {
              attemptId,
              runId,
              state: 'failed',
              completedAt: failureRecord.occurredAt,
              error: failureRecord,
            } as unknown as JsonValue,
            at: failureRecord.occurredAt,
          },
          {
            name: 'run.failed.v1',
            payload: { runId, state: 'failed' },
            at: failureRecord.occurredAt,
          },
        ]);
      } catch {
        // Preserve the original operation error; state stores expose their own diagnostics.
      }
      throw error;
    } finally {
      this.controllers.delete(String(runId));
      this.cancelRequested.delete(String(runId));
    }
  }

  async list(tenant: TenantRef): Promise<readonly Run[]> {
    const events = await this.state.transaction((transaction) =>
      transaction.events.list(tenant, 0),
    );
    const runIds = new Set<Id>();
    for (const stored of events) {
      if (stored.event.aggregateType !== 'run' || stored.event.eventName !== 'run.created.v1')
        continue;
      if (typeof record(stored.event.payload)['run'] === 'object') {
        const runId = record(record(stored.event.payload)['run'])['runId'];
        if (typeof runId === 'string') runIds.add(runId as Id);
      }
    }
    const details = [...runIds]
      .map((runId) => projectDetail(events, runId))
      .filter((detail): detail is UniversalRunDetail => detail !== undefined);
    return details
      .map(({ run }) => run)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async read(tenant: TenantRef, runId: Id): Promise<UniversalRunDetail> {
    const events = await this.state.transaction((transaction) =>
      transaction.events.list(tenant, 0),
    );
    const detail = projectDetail(events, runId);
    if (detail === undefined) throw runtimeError('ARTIFACT_NOT_FOUND', 'Run was not found');
    return detail;
  }

  async cancel(
    tenant: TenantRef,
    runId: Id,
    actor: Actor,
    reason = 'cancelled by user',
  ): Promise<UniversalRunCancellation> {
    const detail = await this.read(tenant, runId);
    if (terminal(detail.run.state)) {
      return { runId, state: detail.run.state, cancelled: false, status: 'already_terminal' };
    }
    if (this.controllers.has(String(runId))) this.cancelRequested.add(String(runId));
    this.controllers.get(String(runId))?.abort(reason);
    const at = this.clock();
    const cancellationError = failure(new Error(reason), at);
    const attempt = detail.attempts.at(-1);
    await appendRunEvents(this.state, tenant, actor, runId, [
      {
        name: 'run.status-changed.v1',
        payload: {
          runId,
          state: 'cancelled',
          completedAt: at,
          error: cancellationError,
        } as unknown as JsonValue,
        at,
      },
      ...(attempt === undefined
        ? []
        : [
            {
              name: 'run.attempt-completed.v1',
              payload: {
                attemptId: attempt.attemptId,
                runId,
                state: 'cancelled',
                completedAt: at,
                error: cancellationError,
              } as unknown as JsonValue,
              at,
            },
          ]),
      { name: 'run.cancelled.v1', payload: { runId, state: 'cancelled', reason }, at },
    ]);
    return { runId, state: 'cancelled', cancelled: true, status: 'cancel_requested' };
  }
}
