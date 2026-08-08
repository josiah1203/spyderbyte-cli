import { createHash } from 'node:crypto';
import {
  newSortableId,
  redactJsonValue,
  redactSecretText,
  type Actor,
  type Id,
  type JsonValue,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';

export interface CorrelationContext {
  readonly tenant: TenantRef;
  readonly workspaceId: Id;
  readonly correlationId: Id;
  readonly causationId?: Id;
  readonly workflowId?: Id;
  readonly invocationId?: Id;
  readonly parentInvocationId?: Id;
  readonly commandId?: Id;
  readonly actor?: Actor;
}

export function createCorrelationContext(
  input: Omit<CorrelationContext, 'correlationId'> & { correlationId?: Id },
): CorrelationContext {
  return {
    ...input,
    correlationId: input.correlationId ?? newSortableId(),
  };
}

export class SecretRedactor {
  redactText(input: string, knownSecrets: readonly string[] = []): string {
    return redactSecretText(input, knownSecrets);
  }

  redact(value: JsonValue, knownSecrets: readonly string[] = []): JsonValue {
    return redactJsonValue(value, knownSecrets);
  }
}

export interface AuditRecord {
  readonly auditId: Id;
  readonly at: string;
  readonly context: CorrelationContext;
  readonly action: string;
  readonly target: string;
  readonly decision: 'allowed' | 'denied' | 'observed' | 'completed' | 'failed';
  readonly details: JsonValue;
  readonly previousDigest: string;
  readonly digest: string;
}

function canonical(value: JsonValue): string {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key] ?? null)}`)
    .join(',')}}`;
}

export class AppendOnlyAuditLog {
  private readonly records: AuditRecord[] = [];
  private readonly redactor: SecretRedactor;

  constructor(redactor = new SecretRedactor()) {
    this.redactor = redactor;
  }

  append(
    input: Omit<AuditRecord, 'auditId' | 'previousDigest' | 'digest'>,
    knownSecrets: readonly string[] = [],
  ): AuditRecord {
    const previousDigest = this.records.at(-1)?.digest ?? 'GENESIS';
    const recordWithoutDigest = {
      auditId: newSortableId(),
      ...input,
      details: this.redactor.redact(input.details, knownSecrets),
      previousDigest,
    };
    const digest = createHash('sha256')
      .update(canonical(recordWithoutDigest as unknown as JsonValue))
      .digest('hex');
    const record: AuditRecord = { ...recordWithoutDigest, digest };
    this.records.push(record);
    return structuredClone(record);
  }

  list(): AuditRecord[] {
    return structuredClone(this.records);
  }

  verify(): boolean {
    let previousDigest = 'GENESIS';
    for (const record of this.records) {
      if (record.previousDigest !== previousDigest) return false;
      const { digest, ...withoutDigest } = record;
      const expected = createHash('sha256')
        .update(canonical(withoutDigest as unknown as JsonValue))
        .digest('hex');
      if (expected !== digest) return false;
      previousDigest = digest;
    }
    return true;
  }
}

export interface TelemetryPoint {
  readonly name: string;
  readonly value: number;
  readonly at: string;
  readonly context: CorrelationContext;
  readonly labels?: Readonly<Record<string, string>>;
}

export class InMemoryTelemetry {
  private readonly points: TelemetryPoint[] = [];

  observe(point: TelemetryPoint): void {
    if (!Number.isFinite(point.value)) throw new TypeError('Telemetry values must be finite');
    this.points.push(structuredClone(point));
  }

  list(name?: string): TelemetryPoint[] {
    return structuredClone(
      name === undefined ? this.points : this.points.filter((point) => point.name === name),
    );
  }

  summarize(name: string): { count: number; sum: number; min?: number; max?: number } {
    const values = this.points.filter((point) => point.name === name).map((point) => point.value);
    return {
      count: values.length,
      sum: values.reduce((sum, value) => sum + value, 0),
      ...(values.length > 0 ? { min: Math.min(...values), max: Math.max(...values) } : {}),
    };
  }
}

export type TelemetryMode = 'disabled' | 'local' | 'remote';

export type ProductMetricName =
  | 'install.download'
  | 'run.first_success'
  | 'project.created'
  | 'weekly_active_individual'
  | 'runs.per_user'
  | 'artifact.reused'
  | 'run.success'
  | 'managed.conversion'
  | 'organization.created'
  | 'shared_project.adoption'
  | 'revenue.arr'
  | 'revenue.usage'
  | 'provider_runtime.failure'
  | 'approval.bypass'
  | 'artifact.loss'
  | 'run.unrecoverable'
  | 'queue.latency'
  | 'margin.compression';

export const PRODUCT_METRIC_NAMES: readonly ProductMetricName[] = [
  'install.download',
  'run.first_success',
  'project.created',
  'weekly_active_individual',
  'runs.per_user',
  'artifact.reused',
  'run.success',
  'managed.conversion',
  'organization.created',
  'shared_project.adoption',
  'revenue.arr',
  'revenue.usage',
  'provider_runtime.failure',
  'approval.bypass',
  'artifact.loss',
  'run.unrecoverable',
  'queue.latency',
  'margin.compression',
];

export interface TelemetryConfiguration {
  readonly mode: TelemetryMode;
  readonly includeProductMetrics: boolean;
}

export interface ProductMetricInput {
  readonly name: ProductMetricName;
  readonly value: number;
  readonly at: string;
  readonly context: CorrelationContext;
  readonly labels?: Readonly<Record<string, string>>;
}

/**
 * Consent-aware telemetry boundary. Remote export is intentionally represented as a mode rather
 * than implemented here; the owning host can drain the redacted local points through its
 * authenticated transport without changing metric semantics.
 */
export class ConfigurableTelemetry {
  private readonly local = new InMemoryTelemetry();
  private configuration: TelemetryConfiguration;

  constructor(
    configuration: TelemetryConfiguration = { mode: 'disabled', includeProductMetrics: false },
  ) {
    this.configuration = structuredClone(configuration);
  }

  configure(configuration: TelemetryConfiguration): void {
    this.configuration = structuredClone(configuration);
  }

  settings(): TelemetryConfiguration {
    return structuredClone(this.configuration);
  }

  observe(point: TelemetryPoint): void {
    if (this.configuration.mode === 'disabled') return;
    this.local.observe(point);
  }

  productMetric(input: ProductMetricInput): void {
    if (!this.configuration.includeProductMetrics) return;
    this.observe({ ...input });
  }

  list(name?: string): TelemetryPoint[] {
    return this.local.list(name);
  }

  summarize(name: string): { count: number; sum: number; min?: number; max?: number } {
    return this.local.summarize(name);
  }
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface StructuredLogInput {
  readonly at: string;
  readonly level: LogLevel;
  readonly message: string;
  readonly context: CorrelationContext;
  readonly fields?: JsonValue;
}

export interface StructuredLogRecord extends StructuredLogInput {
  readonly logId: Id;
  readonly fields?: JsonValue;
}

/** Local structured-log sink used by diagnostics and deterministic execution tests. */
export class InMemoryStructuredLogger {
  private readonly records: StructuredLogRecord[] = [];
  private readonly redactor: SecretRedactor;

  constructor(redactor = new SecretRedactor()) {
    this.redactor = redactor;
  }

  emit(input: StructuredLogInput, knownSecrets: readonly string[] = []): StructuredLogRecord {
    if (input.at.trim().length === 0) throw new TypeError('Structured log timestamp is required');
    if (input.message.trim().length === 0)
      throw new TypeError('Structured log message is required');
    const record: StructuredLogRecord = {
      logId: newSortableId(),
      at: input.at,
      level: input.level,
      message: this.redactor.redactText(input.message, knownSecrets),
      context: structuredClone(input.context),
      ...(input.fields === undefined
        ? {}
        : { fields: this.redactor.redact(input.fields, knownSecrets) }),
    };
    this.records.push(record);
    return structuredClone(record);
  }

  list(filter?: { readonly correlationId?: Id; readonly level?: LogLevel }): StructuredLogRecord[] {
    return structuredClone(
      this.records.filter(
        (record) =>
          (filter?.correlationId === undefined ||
            record.context.correlationId === filter.correlationId) &&
          (filter?.level === undefined || record.level === filter.level),
      ),
    );
  }
}

export type TraceSpanStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface TraceSpanRecord {
  readonly spanId: Id;
  readonly name: string;
  readonly context: CorrelationContext;
  readonly parentSpanId?: Id;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly status: TraceSpanStatus;
  readonly attributes?: JsonValue;
}

/** In-memory span recorder that keeps trace lifecycle transitions explicit and redacted. */
export class InMemoryTraceRecorder {
  private readonly spans = new Map<Id, TraceSpanRecord>();
  private readonly redactor: SecretRedactor;

  constructor(redactor = new SecretRedactor()) {
    this.redactor = redactor;
  }

  start(
    input: {
      readonly name: string;
      readonly context: CorrelationContext;
      readonly parentSpanId?: Id;
      readonly startedAt: string;
      readonly attributes?: JsonValue;
    },
    knownSecrets: readonly string[] = [],
  ): TraceSpanRecord {
    if (input.name.trim().length === 0) throw new TypeError('Trace span name is required');
    if (input.startedAt.trim().length === 0)
      throw new TypeError('Trace span start timestamp is required');
    const span: TraceSpanRecord = {
      spanId: newSortableId(),
      name: input.name,
      context: structuredClone(input.context),
      ...(input.parentSpanId === undefined ? {} : { parentSpanId: input.parentSpanId }),
      startedAt: input.startedAt,
      status: 'running',
      ...(input.attributes === undefined
        ? {}
        : { attributes: this.redactor.redact(input.attributes, knownSecrets) }),
    };
    this.spans.set(span.spanId, span);
    return structuredClone(span);
  }

  finish(
    spanId: Id,
    input: {
      readonly endedAt: string;
      readonly status: Exclude<TraceSpanStatus, 'running'>;
      readonly attributes?: JsonValue;
    },
    knownSecrets: readonly string[] = [],
  ): TraceSpanRecord {
    const current = this.spans.get(spanId);
    if (current === undefined) throw new TypeError(`Trace span ${spanId} was not found`);
    if (current.status !== 'running')
      throw new TypeError(`Trace span ${spanId} is already terminal`);
    if (input.endedAt.trim().length === 0)
      throw new TypeError('Trace span end timestamp is required');
    const next: TraceSpanRecord = {
      ...current,
      endedAt: input.endedAt,
      status: input.status,
      ...(input.attributes === undefined
        ? {}
        : { attributes: this.redactor.redact(input.attributes, knownSecrets) }),
    };
    this.spans.set(spanId, next);
    return structuredClone(next);
  }

  list(filter?: {
    readonly correlationId?: Id;
    readonly status?: TraceSpanStatus;
  }): TraceSpanRecord[] {
    return structuredClone(
      [...this.spans.values()].filter(
        (span) =>
          (filter?.correlationId === undefined ||
            span.context.correlationId === filter.correlationId) &&
          (filter?.status === undefined || span.status === filter.status),
      ),
    );
  }
}

export * from './release-gates.js';
