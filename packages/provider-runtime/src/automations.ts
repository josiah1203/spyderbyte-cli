import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { runtimeError, type JsonValue } from '@agentic-platform/runtime-contracts';
import type { LocalPipelineRuntime, PipelineInputs, PipelineRunV1 } from './pipelines.js';

export type AutomationTriggerType =
  | 'manual'
  | 'interval'
  | 'cron'
  | 'webhook'
  | 'event'
  | 'data-arrival'
  | 'repository';

export type AutomationTriggerV1 =
  | { readonly type: 'manual' }
  | { readonly type: 'interval'; readonly intervalMs: number }
  | { readonly type: 'cron'; readonly expression: string; readonly timezone: string }
  | { readonly type: 'webhook'; readonly secretId: string }
  | { readonly type: 'event'; readonly topic: string; readonly eventName?: string }
  | { readonly type: 'data-arrival'; readonly sourceRef: string; readonly eventName?: string }
  | {
      readonly type: 'repository';
      readonly repositoryId: string;
      readonly eventName?: string;
      readonly branch?: string;
    };

export type AutomationConcurrencyPolicy = 'reject' | 'queue';

export interface AutomationRetryPolicyV1 {
  readonly maxAttempts: number;
  readonly backoffMs: number;
  readonly maxBackoffMs: number;
}

export type AutomationNotificationEvent = 'retrying' | 'succeeded' | 'failed';

export interface AutomationNotificationConfigV1 {
  readonly notificationId: string;
  readonly event: AutomationNotificationEvent;
  /** A secret-free destination reference resolved by the host notification adapter. */
  readonly targetRef: string;
}

export interface AutomationNotificationRecordV1 {
  readonly notificationId: string;
  readonly automationId: string;
  readonly runId: string;
  readonly event: AutomationNotificationEvent;
  readonly targetRef: string;
  readonly status: 'sent' | 'failed';
  readonly sentAt: string;
  readonly error?: string;
}

export interface AutomationDefinitionV1 {
  readonly schemaVersion: 1;
  readonly automationId: string;
  readonly name: string;
  readonly pipelineId: string;
  readonly trigger: AutomationTriggerV1;
  readonly enabled: boolean;
  readonly timezone?: string;
  readonly concurrencyLimit?: number;
  readonly concurrencyPolicy?: AutomationConcurrencyPolicy;
  readonly retryPolicy?: AutomationRetryPolicyV1;
  readonly notifications?: readonly AutomationNotificationConfigV1[];
  readonly maxBackfillRuns?: number;
  readonly nextRunAt?: string;
  readonly lastRunAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AutomationRunV1 {
  readonly runId: string;
  readonly automationId: string;
  readonly pipelineRunId?: string;
  readonly status: PipelineRunV1['status'] | 'failed';
  readonly startedAt: string;
  readonly queuedAt?: string;
  readonly completedAt?: string;
  readonly triggeredBy?:
    | 'manual'
    | 'schedule'
    | 'webhook'
    | 'event'
    | 'data-arrival'
    | 'repository'
    | 'backfill';
  readonly backfillIndex?: number;
  readonly idempotencyKey?: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly inputs?: PipelineInputs;
  readonly error?: string;
}

export interface AutomationWebhookInput {
  readonly payload: Record<string, unknown>;
  readonly signature?: string;
}

export interface AutomationEventInput {
  readonly topic: string;
  readonly eventName?: string;
  readonly payload?: Record<string, JsonValue>;
}

export interface AutomationDataArrivalInput {
  readonly sourceRef: string;
  readonly eventName?: string;
  readonly payload?: Record<string, JsonValue>;
}

export interface AutomationRepositoryEventInput {
  readonly repositoryId: string;
  readonly eventName?: string;
  readonly branch?: string;
  readonly payload?: Record<string, JsonValue>;
}

export interface AutomationBackfillInput {
  readonly count: number;
}

export interface AutomationRuntime {
  list(): Promise<readonly AutomationDefinitionV1[]>;
  get(automationId: string): Promise<AutomationDefinitionV1 | undefined>;
  create(input: {
    automationId: string;
    name: string;
    pipelineId: string;
    trigger: AutomationTriggerV1;
    timezone?: string;
    concurrencyLimit?: number;
    concurrencyPolicy?: AutomationConcurrencyPolicy;
    retryPolicy?: AutomationRetryPolicyV1;
    notifications?: readonly AutomationNotificationConfigV1[];
    maxBackfillRuns?: number;
  }): Promise<AutomationDefinitionV1>;
  pause(automationId: string): Promise<AutomationDefinitionV1>;
  resume(automationId: string): Promise<AutomationDefinitionV1>;
  trigger(
    automationId: string,
    input?: {
      triggeredBy?: AutomationRunV1['triggeredBy'];
      backfillIndex?: number;
      idempotencyKey?: string;
      inputs?: PipelineInputs;
    },
  ): Promise<AutomationRunV1>;
  receiveWebhook(automationId: string, input: AutomationWebhookInput): Promise<AutomationRunV1>;
  receiveEvent(input: AutomationEventInput): Promise<readonly AutomationRunV1[]>;
  receiveDataArrival(input: AutomationDataArrivalInput): Promise<readonly AutomationRunV1[]>;
  receiveRepositoryEvent(
    input: AutomationRepositoryEventInput,
  ): Promise<readonly AutomationRunV1[]>;
  backfill(
    automationId: string,
    input: AutomationBackfillInput,
  ): Promise<readonly AutomationRunV1[]>;
  listRuns(automationId?: string): Promise<readonly AutomationRunV1[]>;
  listNotifications(automationId?: string): Promise<readonly AutomationNotificationRecordV1[]>;
  start(): void;
  tick(): Promise<void>;
}

interface AutomationState {
  readonly definitions: AutomationDefinitionV1[];
  readonly runs: AutomationRunV1[];
  readonly notifications: AutomationNotificationRecordV1[];
}

export interface LocalAutomationRuntimeOptions {
  readonly rootPath: string;
  readonly pipelines: LocalPipelineRuntime;
  readonly clock?: () => string;
  readonly secretResolver?: (secretId: string) => Promise<string | undefined>;
  readonly notificationSink?: (
    config: AutomationNotificationConfigV1,
    run: AutomationRunV1,
  ) => Promise<void>;
}

const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CONCURRENCY = 32;
const MAX_BACKFILL_RUNS = 100;
const MAX_ATTEMPTS = 10;
const MAX_RETRY_BACKOFF_MS = 60 * 60 * 1000;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function active(status: AutomationRunV1['status']): boolean {
  return status === 'queued' || status === 'running';
}

function canonicalPayload(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

function signaturesEqual(expected: string, provided: string): boolean {
  const normalized = provided.startsWith('sha256=') ? provided.slice('sha256='.length) : provided;
  if (!/^[a-f0-9]{64}$/i.test(normalized)) return false;
  const left = Buffer.from(expected, 'hex');
  const right = Buffer.from(normalized, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

function cronParts(expression: string): string[] {
  return expression.trim().split(/\s+/);
}

function cronFieldMatches(field: string, value: number, minimum: number, maximum: number): boolean {
  if (field === '*') return true;
  return field.split(',').some((part) => {
    const [rangeText, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isSafeInteger(step) || step < 1 || rangeText === undefined) return false;
    if (rangeText === '*') return value % step === 0;
    if (rangeText.includes('-')) {
      const [startText, endText] = rangeText.split('-');
      const start = Number(startText);
      const end = Number(endText);
      return (
        Number.isSafeInteger(start) &&
        Number.isSafeInteger(end) &&
        start >= minimum &&
        end <= maximum &&
        value >= start &&
        value <= end &&
        (value - start) % step === 0
      );
    }
    const exact = Number(rangeText);
    return Number.isSafeInteger(exact) && exact === value;
  });
}

function cronMatches(expression: string, date: Date, timezone: string): boolean {
  const parts = cronParts(expression);
  if (parts.length !== 5) return false;
  const values = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      minute: 'numeric',
      hour: 'numeric',
      day: 'numeric',
      month: 'numeric',
      weekday: 'short',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
    values['weekday'] ?? '',
  );
  const [minuteField, hourField, dayField, monthField, weekdayField] = parts;
  if (
    minuteField === undefined ||
    hourField === undefined ||
    dayField === undefined ||
    monthField === undefined ||
    weekdayField === undefined
  ) {
    return false;
  }
  return (
    cronFieldMatches(minuteField, Number(values['minute']), 0, 59) &&
    cronFieldMatches(hourField, Number(values['hour']), 0, 23) &&
    cronFieldMatches(dayField, Number(values['day']), 1, 31) &&
    cronFieldMatches(monthField, Number(values['month']), 1, 12) &&
    cronFieldMatches(weekdayField, weekday, 0, 6)
  );
}

function nextCronOccurrence(expression: string, after: string, timezone: string): string {
  const start = Date.parse(after);
  if (!Number.isFinite(start)) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Cron schedule base time is invalid');
  }
  for (let offset = 60_000; offset <= 366 * 24 * 60 * 60 * 1000; offset += 60_000) {
    const candidate = new Date(start + offset);
    if (cronMatches(expression, candidate, timezone)) return candidate.toISOString();
  }
  throw runtimeError(
    'VALIDATION_INVALID_INPUT',
    'Cron expression has no occurrence in the next year',
  );
}

/** Durable local triggers over the pipeline runtime. The timer is unref'd so it never blocks exit. */
export class LocalAutomationRuntime implements AutomationRuntime {
  private readonly statePath: string;
  private readonly pipelines: LocalPipelineRuntime;
  private readonly clock: () => string;
  private readonly secretResolver: (secretId: string) => Promise<string | undefined>;
  private readonly notificationSink:
    | ((config: AutomationNotificationConfigV1, run: AutomationRunV1) => Promise<void>)
    | undefined;
  private state: AutomationState | undefined;
  private loading: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly tickInFlight = new Set<string>();
  private readonly triggerLocks = new Map<string, Promise<void>>();

  constructor(options: LocalAutomationRuntimeOptions) {
    this.statePath = join(options.rootPath, '.agentic', 'automations.json');
    this.pipelines = options.pipelines;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.secretResolver =
      options.secretResolver ??
      (async (secretId) => process.env[`SPYDERBYTE_AUTOMATION_SECRET_${secretId}`]);
    this.notificationSink = options.notificationSink;
  }

  async list(): Promise<readonly AutomationDefinitionV1[]> {
    await this.ensureLoaded();
    return clone(this.state?.definitions ?? []);
  }

  async get(automationId: string): Promise<AutomationDefinitionV1 | undefined> {
    await this.ensureLoaded();
    const item = this.state?.definitions.find(
      (definition) => definition.automationId === automationId,
    );
    return item === undefined ? undefined : clone(item);
  }

  async create(input: {
    automationId: string;
    name: string;
    pipelineId: string;
    trigger: AutomationTriggerV1;
    timezone?: string;
    concurrencyLimit?: number;
    concurrencyPolicy?: AutomationConcurrencyPolicy;
    retryPolicy?: AutomationRetryPolicyV1;
    notifications?: readonly AutomationNotificationConfigV1[];
    maxBackfillRuns?: number;
  }): Promise<AutomationDefinitionV1> {
    await this.ensureLoaded();
    if (this.state?.definitions.some((item) => item.automationId === input.automationId)) {
      throw runtimeError(
        'CONCURRENCY_STALE_VERSION',
        `Automation ${input.automationId} already exists`,
      );
    }
    if (!(await this.pipelines.get(input.pipelineId))) {
      throw runtimeError('VALIDATION_INVALID_INPUT', `Pipeline ${input.pipelineId} was not found`);
    }
    const trigger = this.validateTrigger(input.trigger);
    const concurrencyLimit = input.concurrencyLimit ?? 1;
    if (
      !Number.isSafeInteger(concurrencyLimit) ||
      concurrencyLimit < 1 ||
      concurrencyLimit > MAX_CONCURRENCY
    ) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        `concurrencyLimit must be between 1 and ${MAX_CONCURRENCY}`,
      );
    }
    const maxBackfillRuns = input.maxBackfillRuns ?? MAX_BACKFILL_RUNS;
    if (
      !Number.isSafeInteger(maxBackfillRuns) ||
      maxBackfillRuns < 1 ||
      maxBackfillRuns > MAX_BACKFILL_RUNS
    ) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        `maxBackfillRuns must be between 1 and ${MAX_BACKFILL_RUNS}`,
      );
    }
    const retryPolicy = this.validateRetryPolicy(input.retryPolicy);
    const notifications = this.validateNotifications(input.notifications);
    const now = this.clock();
    const intervalMs = trigger.type === 'interval' ? trigger.intervalMs : undefined;
    const timezone = input.timezone ?? (trigger.type === 'cron' ? trigger.timezone : undefined);
    const nextRunAt =
      trigger.type === 'cron'
        ? nextCronOccurrence(trigger.expression, now, trigger.timezone)
        : intervalMs === undefined
          ? undefined
          : new Date(Date.parse(now) + intervalMs).toISOString();
    const definition: AutomationDefinitionV1 = {
      schemaVersion: 1,
      automationId: input.automationId,
      name: input.name.trim() || 'Untitled automation',
      pipelineId: input.pipelineId,
      trigger,
      enabled: true,
      ...(timezone === undefined ? {} : { timezone }),
      concurrencyLimit,
      concurrencyPolicy: input.concurrencyPolicy ?? 'reject',
      ...(retryPolicy === undefined ? {} : { retryPolicy }),
      ...(notifications.length === 0 ? {} : { notifications }),
      maxBackfillRuns,
      ...(nextRunAt === undefined ? {} : { nextRunAt }),
      createdAt: now,
      updatedAt: now,
    };
    this.state?.definitions.push(definition);
    await this.persist();
    return clone(definition);
  }

  async pause(automationId: string): Promise<AutomationDefinitionV1> {
    return this.setEnabled(automationId, false);
  }

  async resume(automationId: string): Promise<AutomationDefinitionV1> {
    const current = await this.getRequired(automationId);
    const now = this.clock();
    const intervalMs = current.trigger.type === 'interval' ? current.trigger.intervalMs : undefined;
    const nextRunAt =
      current.trigger.type === 'cron'
        ? nextCronOccurrence(current.trigger.expression, now, current.trigger.timezone)
        : intervalMs === undefined
          ? current.nextRunAt
          : new Date(Date.parse(now) + intervalMs).toISOString();
    return this.replace({
      ...current,
      enabled: true,
      ...(nextRunAt ? { nextRunAt } : {}),
      updatedAt: now,
    });
  }

  async trigger(
    automationId: string,
    input: {
      triggeredBy?: AutomationRunV1['triggeredBy'];
      backfillIndex?: number;
      idempotencyKey?: string;
      inputs?: PipelineInputs;
    } = {},
  ): Promise<AutomationRunV1> {
    const automation = await this.getRequired(automationId);
    const idempotencyKey = input.idempotencyKey?.trim();
    if (idempotencyKey !== undefined) {
      if (idempotencyKey.length === 0 || idempotencyKey.length > 200) {
        throw runtimeError('VALIDATION_INVALID_INPUT', 'Automation idempotencyKey is invalid');
      }
    }
    const reservation = await this.withTriggerLock(automationId, async () => {
      if (idempotencyKey !== undefined) {
        const existing = (await this.listRuns(automationId)).find(
          (run) => run.idempotencyKey === idempotencyKey,
        );
        if (existing !== undefined) return { created: false, run: existing };
      }
      const startedAt = this.clock();
      const runId = `automation-run-${randomUUID()}`;
      const activeCount = (await this.listRuns(automationId)).filter((run) =>
        active(run.status),
      ).length;
      const limit = automation.concurrencyLimit ?? 1;
      if (activeCount >= limit && (automation.concurrencyPolicy ?? 'reject') === 'reject') {
        throw runtimeError('POLICY_DENIED', `Automation concurrency limit of ${limit} is active`);
      }
      const queued = activeCount >= limit;
      const retryPolicy = automation.retryPolicy ?? {
        maxAttempts: 1,
        backoffMs: 0,
        maxBackoffMs: 0,
      };
      const run: AutomationRunV1 = {
        runId,
        automationId,
        status: queued ? 'queued' : 'running',
        startedAt,
        attempt: 0,
        maxAttempts: retryPolicy.maxAttempts,
        ...(queued ? { queuedAt: startedAt } : {}),
        ...(input.triggeredBy === undefined ? {} : { triggeredBy: input.triggeredBy }),
        ...(input.backfillIndex === undefined ? {} : { backfillIndex: input.backfillIndex }),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        ...(input.inputs === undefined ? {} : { inputs: clone(input.inputs) }),
      };
      await this.saveRun(run);
      return { created: true, run };
    });
    if (!reservation.created) return clone(reservation.run);
    const run = reservation.run;
    if (run.status === 'queued') {
      void this.drainQueue(automationId);
      return clone(run);
    }
    const completed = await this.executeRun(automation, run);
    void this.drainQueue(automationId);
    return completed;
  }

  async receiveWebhook(
    automationId: string,
    input: AutomationWebhookInput,
  ): Promise<AutomationRunV1> {
    const automation = await this.getRequired(automationId);
    if (automation.trigger.type !== 'webhook') {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Automation is not configured for webhooks');
    }
    const secret = await this.secretResolver(automation.trigger.secretId);
    if (secret === undefined || secret.length === 0 || input.signature === undefined) {
      throw runtimeError('POLICY_DENIED', 'A signed webhook secret and signature are required');
    }
    const expected = createHmac('sha256', secret)
      .update(canonicalPayload(input.payload))
      .digest('hex');
    if (!signaturesEqual(expected, input.signature)) {
      throw runtimeError('POLICY_DENIED', 'Webhook signature validation failed');
    }
    return this.trigger(automationId, { triggeredBy: 'webhook' });
  }

  async receiveEvent(input: AutomationEventInput): Promise<readonly AutomationRunV1[]> {
    const definitions = await this.list();
    const runs: AutomationRunV1[] = [];
    for (const automation of definitions) {
      if (!automation.enabled || automation.trigger.type !== 'event') continue;
      if (automation.trigger.topic !== input.topic) continue;
      if (
        automation.trigger.eventName !== undefined &&
        automation.trigger.eventName !== input.eventName
      )
        continue;
      runs.push(
        await this.trigger(automation.automationId, {
          triggeredBy: 'event',
          ...(input.payload === undefined ? {} : { inputs: input.payload }),
          idempotencyKey: `event:${input.topic}:${input.eventName ?? ''}:${canonicalPayload(input.payload ?? {})}`,
        }),
      );
    }
    return runs;
  }

  async receiveDataArrival(input: AutomationDataArrivalInput): Promise<readonly AutomationRunV1[]> {
    const definitions = await this.list();
    const runs: AutomationRunV1[] = [];
    for (const automation of definitions) {
      if (!automation.enabled || automation.trigger.type !== 'data-arrival') continue;
      if (automation.trigger.sourceRef !== input.sourceRef) continue;
      if (
        automation.trigger.eventName !== undefined &&
        automation.trigger.eventName !== input.eventName
      )
        continue;
      runs.push(
        await this.trigger(automation.automationId, {
          triggeredBy: 'data-arrival',
          ...(input.payload === undefined ? {} : { inputs: input.payload }),
          idempotencyKey: `data-arrival:${input.sourceRef}:${input.eventName ?? ''}:${canonicalPayload(input.payload ?? {})}`,
        }),
      );
    }
    return runs;
  }

  async receiveRepositoryEvent(
    input: AutomationRepositoryEventInput,
  ): Promise<readonly AutomationRunV1[]> {
    const definitions = await this.list();
    const runs: AutomationRunV1[] = [];
    for (const automation of definitions) {
      if (!automation.enabled || automation.trigger.type !== 'repository') continue;
      if (automation.trigger.repositoryId !== input.repositoryId) continue;
      if (
        automation.trigger.eventName !== undefined &&
        automation.trigger.eventName !== input.eventName
      )
        continue;
      if (automation.trigger.branch !== undefined && automation.trigger.branch !== input.branch)
        continue;
      runs.push(
        await this.trigger(automation.automationId, {
          triggeredBy: 'repository',
          ...(input.payload === undefined ? {} : { inputs: input.payload }),
          idempotencyKey: `repository:${input.repositoryId}:${input.eventName ?? ''}:${input.branch ?? ''}:${canonicalPayload(input.payload ?? {})}`,
        }),
      );
    }
    return runs;
  }

  async backfill(
    automationId: string,
    input: AutomationBackfillInput,
  ): Promise<readonly AutomationRunV1[]> {
    const automation = await this.getRequired(automationId);
    const max = automation.maxBackfillRuns ?? MAX_BACKFILL_RUNS;
    if (!Number.isSafeInteger(input.count) || input.count < 1 || input.count > max) {
      throw runtimeError('VALIDATION_INVALID_INPUT', `Backfill count must be between 1 and ${max}`);
    }
    const runs: AutomationRunV1[] = [];
    for (let index = 0; index < input.count; index += 1) {
      runs.push(
        await this.trigger(automationId, { triggeredBy: 'backfill', backfillIndex: index + 1 }),
      );
    }
    return runs;
  }

  async listRuns(automationId?: string): Promise<readonly AutomationRunV1[]> {
    await this.ensureLoaded();
    return clone(
      (this.state?.runs ?? []).filter(
        (run) => automationId === undefined || run.automationId === automationId,
      ),
    );
  }

  async listNotifications(
    automationId?: string,
  ): Promise<readonly AutomationNotificationRecordV1[]> {
    await this.ensureLoaded();
    return clone(
      (this.state?.notifications ?? []).filter(
        (notification) => automationId === undefined || notification.automationId === automationId,
      ),
    );
  }

  private async withTriggerLock<T>(automationId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.triggerLocks.get(automationId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolveCurrent) => {
      release = resolveCurrent;
    });
    const chain = previous.then(() => current);
    this.triggerLocks.set(automationId, chain);
    await previous;
    try {
      return await action();
    } finally {
      release?.();
      if (this.triggerLocks.get(automationId) === chain) {
        this.triggerLocks.delete(automationId);
      }
    }
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.tick(), 15_000);
    const candidate = this.timer as unknown as { unref?: () => void };
    candidate.unref?.();
  }

  async tick(): Promise<void> {
    const now = Date.parse(this.clock());
    for (const automation of await this.list()) {
      if (
        !automation.enabled ||
        (automation.trigger.type !== 'interval' && automation.trigger.type !== 'cron') ||
        !automation.nextRunAt
      )
        continue;
      if (this.tickInFlight.has(automation.automationId)) continue;
      if (Date.parse(automation.nextRunAt) <= now) {
        this.tickInFlight.add(automation.automationId);
        try {
          await this.trigger(automation.automationId, {
            triggeredBy: 'schedule',
            idempotencyKey: `schedule:${automation.nextRunAt}`,
          });
        } catch {
          // The next scheduler tick retries after the active run has cleared.
        } finally {
          this.tickInFlight.delete(automation.automationId);
        }
      }
    }
  }

  private async drainQueue(automationId: string): Promise<void> {
    while (true) {
      const reservation = await this.withTriggerLock(automationId, async () => {
        const automation = await this.get(automationId);
        if (automation === undefined) return undefined;
        const limit = automation.concurrencyLimit ?? 1;
        const runs = await this.listRuns(automationId);
        if (runs.filter((run) => active(run.status)).length >= limit) return undefined;
        const next = runs.find((run) => run.status === 'queued');
        if (next === undefined) return undefined;
        const running: AutomationRunV1 = {
          ...next,
          status: 'running',
          startedAt: this.clock(),
        };
        await this.saveRun(running);
        return { automation, running };
      });
      if (reservation === undefined) return;
      await this.executeRun(reservation.automation, reservation.running);
    }
  }

  private async executeRun(
    automation: AutomationDefinitionV1,
    running: AutomationRunV1,
  ): Promise<AutomationRunV1> {
    const retryPolicy = automation.retryPolicy ?? {
      maxAttempts: 1,
      backoffMs: 0,
      maxBackoffMs: 0,
    };
    let current = clone(running);
    for (
      let attempt = Math.max(1, running.attempt + 1);
      attempt <= retryPolicy.maxAttempts;
      attempt += 1
    ) {
      const { completedAt: _completedAt, error: _error, ...activeRun } = current;
      void _completedAt;
      void _error;
      current = { ...activeRun, status: 'running', attempt, maxAttempts: retryPolicy.maxAttempts };
      await this.saveRun(current);
      try {
        const pipelineRun = await this.pipelines.run(automation.pipelineId, {
          ...(current.inputs === undefined ? {} : { inputs: current.inputs }),
          idempotencyKey: `automation:${current.runId}`,
        });
        current = {
          ...current,
          pipelineRunId: pipelineRun.runId,
          status: pipelineRun.status,
          completedAt: this.clock(),
          ...(pipelineRun.error ? { error: pipelineRun.error } : {}),
        };
      } catch (error) {
        current = {
          ...current,
          status: 'failed',
          completedAt: this.clock(),
          error: error instanceof Error ? error.message : String(error),
        };
      }
      const retrying = current.status === 'failed' && attempt < retryPolicy.maxAttempts;
      await this.saveRun(current);
      if (retrying) {
        await this.emitNotifications(automation, current, 'retrying');
        const delay = Math.min(
          retryPolicy.maxBackoffMs,
          retryPolicy.backoffMs * 2 ** Math.max(0, attempt - 1),
        );
        if (delay > 0) await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delay));
        continue;
      }
      const finalEvent: AutomationNotificationEvent =
        current.status === 'completed' ? 'succeeded' : 'failed';
      await this.emitNotifications(automation, current, finalEvent);
      const completedAt = current.completedAt ?? this.clock();
      await this.replace({
        ...automation,
        lastRunAt: completedAt,
        ...(automation.trigger.type === 'interval'
          ? {
              nextRunAt: new Date(
                Date.parse(completedAt) + automation.trigger.intervalMs,
              ).toISOString(),
            }
          : automation.trigger.type === 'cron'
            ? {
                nextRunAt: nextCronOccurrence(
                  automation.trigger.expression,
                  completedAt,
                  automation.trigger.timezone,
                ),
              }
            : {}),
        updatedAt: completedAt,
      });
      return clone(current);
    }
    throw runtimeError('RETRY_EXHAUSTED', 'Automation retry loop ended unexpectedly');
  }

  private validateTrigger(trigger: AutomationTriggerV1): AutomationTriggerV1 {
    if (trigger.type === 'manual') return { type: 'manual' };
    if (trigger.type === 'interval') {
      if (
        !Number.isSafeInteger(trigger.intervalMs) ||
        trigger.intervalMs < MIN_INTERVAL_MS ||
        trigger.intervalMs > MAX_INTERVAL_MS
      ) {
        throw runtimeError(
          'VALIDATION_INVALID_INPUT',
          `Automation interval must be between ${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS} ms`,
        );
      }
      return { type: 'interval', intervalMs: trigger.intervalMs };
    }
    if (trigger.type === 'cron') {
      const expression = trigger.expression.trim();
      if (
        expression.length === 0 ||
        expression.length > 200 ||
        cronParts(expression).length !== 5
      ) {
        throw runtimeError('VALIDATION_INVALID_INPUT', 'Cron expression must contain five fields');
      }
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: trigger.timezone }).format();
      } catch {
        throw runtimeError('VALIDATION_INVALID_INPUT', 'Cron timezone is invalid');
      }
      return { type: 'cron', expression, timezone: trigger.timezone };
    }
    if (trigger.type === 'webhook') {
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(trigger.secretId)) {
        throw runtimeError('VALIDATION_INVALID_INPUT', 'Webhook secretId is invalid');
      }
      return { type: 'webhook', secretId: trigger.secretId };
    }
    if (trigger.type === 'event') {
      if (trigger.topic.trim().length === 0 || trigger.topic.length > 200) {
        throw runtimeError('VALIDATION_INVALID_INPUT', 'Event trigger topic is invalid');
      }
      return {
        type: 'event',
        topic: trigger.topic.trim(),
        ...(trigger.eventName === undefined ? {} : { eventName: trigger.eventName.trim() }),
      };
    }
    if (trigger.type === 'data-arrival') {
      if (trigger.sourceRef.trim().length === 0 || trigger.sourceRef.length > 200) {
        throw runtimeError('VALIDATION_INVALID_INPUT', 'Data arrival sourceRef is invalid');
      }
      return {
        type: 'data-arrival',
        sourceRef: trigger.sourceRef.trim(),
        ...(trigger.eventName === undefined ? {} : { eventName: trigger.eventName.trim() }),
      };
    }
    if (trigger.repositoryId.trim().length === 0 || trigger.repositoryId.length > 200) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Repository trigger repositoryId is invalid');
    }
    return {
      type: 'repository',
      repositoryId: trigger.repositoryId.trim(),
      ...(trigger.eventName === undefined ? {} : { eventName: trigger.eventName.trim() }),
      ...(trigger.branch === undefined ? {} : { branch: trigger.branch.trim() }),
    };
  }

  private validateRetryPolicy(
    policy: AutomationRetryPolicyV1 | undefined,
  ): AutomationRetryPolicyV1 | undefined {
    if (policy === undefined) return undefined;
    if (
      !Number.isSafeInteger(policy.maxAttempts) ||
      policy.maxAttempts < 1 ||
      policy.maxAttempts > MAX_ATTEMPTS
    ) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        `retryPolicy.maxAttempts must be between 1 and ${MAX_ATTEMPTS}`,
      );
    }
    if (
      !Number.isSafeInteger(policy.backoffMs) ||
      policy.backoffMs < 0 ||
      policy.backoffMs > MAX_RETRY_BACKOFF_MS
    ) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'retryPolicy.backoffMs is outside the allowed range',
      );
    }
    if (
      !Number.isSafeInteger(policy.maxBackoffMs) ||
      policy.maxBackoffMs < policy.backoffMs ||
      policy.maxBackoffMs > MAX_RETRY_BACKOFF_MS
    ) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'retryPolicy.maxBackoffMs is invalid');
    }
    return { ...policy };
  }

  private validateNotifications(
    notifications: readonly AutomationNotificationConfigV1[] | undefined,
  ): AutomationNotificationConfigV1[] {
    if (notifications === undefined) return [];
    if (notifications.length > 16) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'An automation may define at most 16 notifications',
      );
    }
    const ids = new Set<string>();
    return notifications.map((notification) => {
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(notification.notificationId)) {
        throw runtimeError('VALIDATION_INVALID_INPUT', 'notificationId is invalid');
      }
      if (ids.has(notification.notificationId)) {
        throw runtimeError('VALIDATION_INVALID_INPUT', 'Notification ids must be unique');
      }
      ids.add(notification.notificationId);
      if (!['retrying', 'succeeded', 'failed'].includes(notification.event)) {
        throw runtimeError('VALIDATION_INVALID_INPUT', 'Notification event is invalid');
      }
      if (!/^[A-Za-z0-9._:/-]{1,200}$/.test(notification.targetRef)) {
        throw runtimeError('VALIDATION_INVALID_INPUT', 'Notification targetRef is invalid');
      }
      return { ...notification };
    });
  }

  private async emitNotifications(
    automation: AutomationDefinitionV1,
    run: AutomationRunV1,
    event: AutomationNotificationEvent,
  ): Promise<void> {
    for (const config of automation.notifications ?? []) {
      if (config.event !== event) continue;
      let status: AutomationNotificationRecordV1['status'] = 'sent';
      let error: string | undefined;
      try {
        if (this.notificationSink === undefined) {
          throw new Error('Notification adapter is not configured');
        }
        await this.notificationSink(config, run);
      } catch (caught) {
        status = 'failed';
        error =
          caught instanceof Error ? caught.message.slice(0, 1000) : String(caught).slice(0, 1000);
      }
      const record: AutomationNotificationRecordV1 = {
        notificationId: config.notificationId,
        automationId: automation.automationId,
        runId: run.runId,
        event,
        targetRef: config.targetRef,
        status,
        sentAt: this.clock(),
        ...(error === undefined ? {} : { error }),
      };
      await this.saveNotification(record);
    }
  }

  private async getRequired(automationId: string): Promise<AutomationDefinitionV1> {
    const automation = await this.get(automationId);
    if (!automation)
      throw runtimeError('VALIDATION_INVALID_INPUT', `Automation ${automationId} was not found`);
    return automation;
  }

  private async setEnabled(
    automationId: string,
    enabled: boolean,
  ): Promise<AutomationDefinitionV1> {
    const current = await this.getRequired(automationId);
    return this.replace({ ...current, enabled, updatedAt: this.clock() });
  }

  private async replace(definition: AutomationDefinitionV1): Promise<AutomationDefinitionV1> {
    await this.ensureLoaded();
    const index =
      this.state?.definitions.findIndex((item) => item.automationId === definition.automationId) ??
      -1;
    if (index < 0)
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        `Automation ${definition.automationId} was not found`,
      );
    if (this.state) this.state.definitions[index] = definition;
    await this.persist();
    return clone(definition);
  }

  private async saveRun(run: AutomationRunV1): Promise<void> {
    await this.ensureLoaded();
    const index = this.state?.runs.findIndex((item) => item.runId === run.runId) ?? -1;
    if (index < 0) this.state?.runs.push(run);
    else if (this.state) this.state.runs[index] = run;
    await this.persist();
  }

  private async saveNotification(record: AutomationNotificationRecordV1): Promise<void> {
    await this.ensureLoaded();
    this.state?.notifications.push(record);
    await this.persist();
  }

  private async ensureLoaded(): Promise<void> {
    if (this.state) return;
    this.loading ??= (async () => {
      try {
        const raw = JSON.parse(await readFile(this.statePath, 'utf8')) as Partial<AutomationState>;
        let recovered = false;
        this.state = {
          definitions: Array.isArray(raw.definitions) ? raw.definitions : [],
          runs: Array.isArray(raw.runs)
            ? raw.runs.map((run) => {
                const migrated = {
                  ...run,
                  attempt: run.attempt ?? 1,
                  maxAttempts: run.maxAttempts ?? 1,
                };
                if (migrated.status !== 'running' && migrated.status !== 'queued') return migrated;
                recovered = true;
                return {
                  ...migrated,
                  status: 'failed' as const,
                  completedAt: this.clock(),
                  error: 'Automation process was interrupted by a daemon restart',
                };
              })
            : [],
          notifications: Array.isArray(raw.notifications) ? raw.notifications : [],
        };
        if (recovered) await this.persist();
      } catch {
        this.state = { definitions: [], runs: [], notifications: [] };
      }
    })();
    await this.loading;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    await writeFile(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
  }
}
