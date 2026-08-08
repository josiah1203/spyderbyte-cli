import { createHash } from 'node:crypto';
import {
  isId,
  newSortableId,
  runtimeError,
  sha256Hash,
  type CloudApprovalV1,
  type CloudArtifactReceiptV1,
  type CloudEstimateV1,
  type CloudRunContinuityV1,
  type CloudRunEventV1,
  type CloudRunRequestV1,
  type Id,
  type JsonValue,
  type RuntimeEvent,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import type { ArtifactObjectStore } from '@agentic-platform/artifact-registry';
import type { CloudAccountService } from './accounts.js';
import { CloudBillingCoordinator, CloudPricingCatalog, type CloudUsageInput } from './billing.js';
import type { CloudEventPublisher } from './events.js';
import type {
  CloudComputeObservation,
  CloudComputeProvider,
  CloudInferenceEvent,
  CloudInferenceProvider,
} from './providers.js';
import {
  InMemoryCloudRuntimeStore,
  type CloudRuntimeStore,
  type StoredCloudEstimate,
} from './persistence.js';

export interface CloudRunServiceOptions {
  readonly accounts: CloudAccountService;
  readonly inference: CloudInferenceProvider;
  readonly compute: CloudComputeProvider;
  readonly artifacts: ArtifactObjectStore;
  readonly events: CloudEventPublisher;
  readonly pricing: CloudPricingCatalog;
  readonly billing: CloudBillingCoordinator;
  /** Defaults to in-memory state for local fixtures; hosted composition must inject a durable store. */
  readonly store?: CloudRuntimeStore;
  readonly estimateTtlMs?: number;
  readonly clock?: () => string;
}

export interface ApproveCloudRunInput {
  readonly accessToken: string;
  readonly estimateId: Id;
  readonly actionDigest: string;
}

export interface ExecuteCloudRunInput {
  readonly accessToken: string;
  readonly estimateId: Id;
  readonly approvalId: Id;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function digest(value: unknown): ReturnType<typeof sha256Hash> {
  return sha256Hash(createHash('sha256').update(JSON.stringify(value)).digest('hex'));
}

function assertTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} is invalid`);
  return parsed;
}

function assertRequest(
  request: CloudRunRequestV1,
  account: Awaited<ReturnType<CloudAccountService['requireAccount']>>,
): void {
  if (request.schemaVersion !== 1 || request.provider !== 'openrouter') {
    throw runtimeError(
      'VALIDATION_SCHEMA_MISMATCH',
      'Cloud run request version or provider is unsupported',
    );
  }
  if (!isId(request.runId) || !isId(request.localAttemptId)) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Cloud run and local attempt IDs are required');
  }
  if (
    request.requestedAction.trim().length === 0 ||
    request.modelId.trim().length === 0 ||
    request.prompt.length === 0
  ) {
    throw runtimeError(
      'VALIDATION_INVALID_INPUT',
      'Cloud run action, model, and prompt are required',
    );
  }
  if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Cloud run output token limit must be positive');
  }
  if (request.outputMediaType.trim().length === 0 || request.idempotencyKey.trim().length < 8) {
    throw runtimeError(
      'VALIDATION_INVALID_INPUT',
      'Cloud run output media type and idempotency key are required',
    );
  }
  if (request.maxCost.currency !== account.currency) {
    throw runtimeError(
      'VALIDATION_INVALID_INPUT',
      'Cloud run currency does not match account currency',
    );
  }
  if (!Number.isSafeInteger(request.maxCost.amountMinor) || request.maxCost.amountMinor < 0) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Cloud run maximum cost must be non-negative');
  }
  const limits = account.resourceLimits;
  const checks: readonly [string, number, number][] = [
    ['cpuMillicores', request.compute.cpuMillicores, limits.maxCpuMillicores],
    ['memoryBytes', request.compute.memoryBytes, limits.maxMemoryBytes],
    ['gpuCount', request.compute.gpuCount, limits.maxGpuCount],
    ['wallTimeMs', request.compute.wallTimeMs, limits.maxWallTimeMs],
    ['maxOutputBytes', request.compute.maxOutputBytes, limits.maxOutputBytes],
    ['maxProcessCount', request.compute.maxProcessCount, limits.maxProcessCount],
  ];
  for (const [label, requested, limit] of checks) {
    if (!Number.isSafeInteger(requested) || requested < 0 || requested > limit) {
      throw runtimeError('POLICY_DENIED', `Cloud ${label} exceeds the account resource limit`);
    }
  }
  if (
    request.compute.cpuMillicores < 1 ||
    request.compute.memoryBytes < 1 ||
    request.compute.wallTimeMs < 1 ||
    request.compute.maxOutputBytes < 1 ||
    request.compute.maxProcessCount < 1
  ) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Cloud compute requirements must be positive');
  }
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.name : 'CloudExecutionError';
}

function terminalCompute(state: CloudComputeObservation['state']): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled';
}

/**
 * Composes local Run continuity with hosted execution: estimate -> approval ->
 * provider streaming -> artifact return -> usage ledger -> billing settlement.
 */
export class CloudRunContinuityService {
  private readonly accounts: CloudAccountService;
  private readonly inference: CloudInferenceProvider;
  private readonly compute: CloudComputeProvider;
  private readonly artifacts: ArtifactObjectStore;
  private readonly events: CloudEventPublisher;
  private readonly pricing: CloudPricingCatalog;
  private readonly billing: CloudBillingCoordinator;
  private readonly store: CloudRuntimeStore;
  private readonly estimateTtlMs: number;
  private readonly clock: () => string;

  constructor(options: CloudRunServiceOptions) {
    this.accounts = options.accounts;
    this.inference = options.inference;
    this.compute = options.compute;
    this.artifacts = options.artifacts;
    this.events = options.events;
    this.pricing = options.pricing;
    this.billing = options.billing;
    this.store = options.store ?? new InMemoryCloudRuntimeStore();
    this.estimateTtlMs = options.estimateTtlMs ?? 5 * 60 * 1_000;
    if (!Number.isSafeInteger(this.estimateTtlMs) || this.estimateTtlMs < 1) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Cloud estimate TTL must be positive');
    }
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async estimate(request: CloudRunRequestV1, accessToken: string): Promise<CloudEstimateV1> {
    assertCloudRequestShape(request);
    const session = await this.accounts.requireSession(accessToken, request.tenant);
    if (session.actor.actorId !== request.actor.actorId) {
      throw runtimeError('AUTHORITY_SCOPE_VIOLATION', 'Cloud run actor does not match the session');
    }
    const account = await this.accounts.requireAccount(request.tenant);
    assertRequest(request, account);
    const existingForRun = await this.store.getResult(request.tenant, request.runId);
    if (existingForRun !== undefined) return clone(existingForRun.estimate);
    const existing = await this.store.getEstimateByIdempotency(
      request.tenant,
      request.idempotencyKey,
    );
    if (existing !== undefined) {
      if (digest(existing.request) !== digest(request)) {
        throw runtimeError(
          'VALIDATION_INVALID_INPUT',
          'Cloud estimate idempotency key was reused differently',
        );
      }
      return clone(existing.estimate);
    }
    await this.compute.estimate({ tenant: request.tenant, compute: request.compute });
    const breakdown = this.pricing.estimate(request);
    if (breakdown.total.amountMinor > request.maxCost.amountMinor) {
      throw runtimeError('BUDGET_EXCEEDED', 'Cloud estimate exceeds the requested maximum cost');
    }
    const now = this.clock();
    const nowMs = assertTimestamp(now, 'Cloud estimate time');
    const estimate: CloudEstimateV1 = {
      schemaVersion: 1,
      estimateId: newSortableId(),
      runId: request.runId,
      tenant: clone(request.tenant),
      actionDigest: digest(request),
      inputTokens: breakdown.inputTokens,
      outputTokens: breakdown.outputTokens,
      computeSeconds: breakdown.computeSeconds,
      llm: clone(breakdown.llm),
      compute: clone(breakdown.compute),
      storage: clone(breakdown.storage),
      platformFee: clone(breakdown.platformFee),
      total: clone(breakdown.total),
      expiresAt: new Date(nowMs + this.estimateTtlMs).toISOString(),
      createdAt: now,
    };
    await this.store.saveEstimate({ request: clone(request), estimate: clone(estimate) });
    await this.emit(request, request.runId, 'estimate.created', {
      estimateId: estimate.estimateId,
      total: estimate.total,
      actionDigest: estimate.actionDigest,
    });
    await this.emit(request, request.runId, 'approval.required', {
      estimateId: estimate.estimateId,
      total: estimate.total,
      expiresAt: estimate.expiresAt,
    });
    return clone(estimate);
  }

  async approve(input: ApproveCloudRunInput): Promise<CloudApprovalV1> {
    const session = await this.accounts.authenticate(input.accessToken);
    const stored = await this.findEstimate(session.tenant, input.estimateId);
    if (stored.estimate.actionDigest !== input.actionDigest) {
      throw runtimeError(
        'APPROVAL_INVALIDATED',
        'Cloud approval digest does not match the estimate',
      );
    }
    if (Date.parse(stored.estimate.expiresAt) <= Date.parse(this.clock())) {
      throw runtimeError('AUTHORITY_EXPIRED', 'Cloud estimate has expired');
    }
    const existing = await this.store.getApproval(session.tenant, input.estimateId);
    if (existing !== undefined) return clone(existing);
    const account = await this.accounts.requireAccount(session.tenant);
    await this.billing.authorize(account, stored.estimate);
    const now = this.clock();
    const approval: CloudApprovalV1 = {
      schemaVersion: 1,
      approvalId: newSortableId(),
      estimateId: stored.estimate.estimateId,
      runId: stored.estimate.runId,
      tenant: clone(session.tenant),
      actionDigest: stored.estimate.actionDigest,
      approvedBy: clone(session.actor),
      approvedAt: now,
      expiresAt: stored.estimate.expiresAt,
    };
    await this.store.saveApproval(approval);
    return clone(approval);
  }

  async execute(input: ExecuteCloudRunInput): Promise<CloudRunContinuityV1> {
    const session = await this.accounts.authenticate(input.accessToken);
    const stored = await this.findEstimate(session.tenant, input.estimateId);
    const existing = await this.store.getResult(session.tenant, stored.estimate.runId);
    if (existing !== undefined) return clone(existing);
    const approval = await this.store.getApproval(session.tenant, input.estimateId);
    if (approval === undefined || approval.approvalId !== input.approvalId) {
      throw runtimeError('APPROVAL_REQUIRED', 'Cloud run approval is required');
    }
    if (Date.parse(approval.expiresAt) <= Date.parse(this.clock())) {
      throw runtimeError('AUTHORITY_EXPIRED', 'Cloud run approval has expired');
    }
    const account = await this.accounts.requireAccount(session.tenant);
    const request = stored.request;
    const cloudAttemptId = newSortableId();
    try {
      await this.emit(request, cloudAttemptId, 'run.switched', {
        localAttemptId: request.localAttemptId,
        cloudAttemptId,
        target: 'spyderbyte_cloud',
      });
      let output = '';
      let inputTokens = stored.estimate.inputTokens;
      let outputTokens = 0;
      let providerRequestId: string | undefined;
      const stream = await this.inference.stream({
        tenant: request.tenant,
        modelId: request.modelId,
        prompt: request.prompt,
        maxOutputTokens: request.maxOutputTokens,
      });
      for await (const event of stream) {
        this.consumeInferenceEvent(
          event,
          (text) => {
            output += text;
          },
          (usage) => {
            inputTokens = usage.inputTokens;
            outputTokens = usage.outputTokens;
            providerRequestId = usage.providerRequestId ?? providerRequestId;
          },
        );
        if (event.type === 'delta') {
          await this.emit(request, cloudAttemptId, 'run.progress', {
            phase: 'inference',
            delta: event.text,
          });
        }
      }
      if (output.length === 0)
        throw runtimeError('HARNESS_OUTPUT_INVALID', 'Cloud provider returned no output');
      if (outputTokens === 0) outputTokens = Math.max(1, Math.ceil(output.length / 4));
      await this.emit(request, cloudAttemptId, 'run.progress', {
        phase: 'compute',
        state: 'submitting',
      });
      const handle = await this.compute.submit({
        runId: request.runId,
        tenant: request.tenant,
        compute: request.compute,
        payload: output,
      });
      let observation = await this.compute.observe(handle);
      for (let attempt = 0; !terminalCompute(observation.state) && attempt < 8; attempt += 1) {
        observation = await this.compute.observe({ ...handle, state: observation.state });
      }
      if (observation.state !== 'succeeded') {
        throw runtimeError(
          'COMPUTE_RESOURCE_UNAVAILABLE',
          `Cloud compute ended in ${observation.state}`,
        );
      }
      const bytes = new TextEncoder().encode(
        observation.stdout.length > 0 ? observation.stdout : output,
      );
      if (bytes.byteLength > request.compute.maxOutputBytes) {
        throw runtimeError('BUDGET_EXCEEDED', 'Cloud output exceeds the approved resource limit');
      }
      const hash = createHash('sha256').update(bytes).digest('hex');
      const objectKey = `sha256/${hash}`;
      await this.artifacts.put(objectKey, bytes);
      const artifact: CloudArtifactReceiptV1 = {
        reference: {
          schemaVersion: 1,
          tenant: clone(request.tenant),
          artifactId: newSortableId(),
          version: 1,
          contentHash: sha256Hash(hash),
          mediaType: request.outputMediaType,
          sizeBytes: bytes.byteLength,
          createdAt: this.clock(),
          uri: `cloud://artifacts/${hash}`,
        },
        objectKey,
      };
      await this.emit(request, cloudAttemptId, 'run.artifact.created', {
        artifactId: artifact.reference.artifactId,
        contentHash: artifact.reference.contentHash,
        sizeBytes: artifact.reference.sizeBytes,
      });
      const usageInput: CloudUsageInput = {
        inputTokens,
        outputTokens,
        computeSeconds: observation.computeSeconds,
        storageBytes: bytes.byteLength,
        ...(providerRequestId === undefined ? {} : { providerRequestId }),
      };
      const actual = this.pricing.cost(usageInput);
      if (actual.total.amountMinor > request.maxCost.amountMinor) {
        throw runtimeError(
          'BUDGET_EXCEEDED',
          'Actual cloud usage exceeds the approved maximum cost',
        );
      }
      const { usage, billing } = await this.billing.reconcile(
        account,
        stored.estimate,
        usageInput,
        actual,
      );
      await this.emit(request, cloudAttemptId, 'usage.recorded', {
        usageId: usage.usageId,
        amount: usage.amount,
        quantities: usage.quantities,
      });
      await this.emit(request, cloudAttemptId, 'billing.reconciled', {
        billingId: billing.billingId,
        state: billing.state,
        actual: billing.actual,
        providerPaymentId: billing.providerPaymentId,
      });
      await this.emit(request, cloudAttemptId, 'run.completed', {
        runId: request.runId,
        cloudAttemptId,
        artifactId: artifact.reference.artifactId,
      });
      const result: CloudRunContinuityV1 = {
        schemaVersion: 1,
        runId: request.runId,
        localAttemptId: request.localAttemptId,
        cloudAttemptId,
        tenant: clone(request.tenant),
        state: 'succeeded',
        estimate: clone(stored.estimate),
        events: await this.store.eventsFor(request.tenant, request.runId),
        artifacts: [clone(artifact)],
        usage: clone(usage),
        billing: clone(billing),
        startedAt: stored.estimate.createdAt,
        completedAt: this.clock(),
      };
      await this.store.saveResult(result);
      return clone(result);
    } catch (error) {
      await this.emit(request, cloudAttemptId, 'run.failed', { code: errorCode(error) }).catch(
        () => undefined,
      );
      throw error;
    }
  }

  eventsFor(tenant: TenantRef, runId: Id): Promise<readonly CloudRunEventV1[]> {
    return this.store.eventsFor(tenant, runId);
  }

  async eventsForSession(accessToken: string, runId: Id): Promise<readonly CloudRunEventV1[]> {
    const session = await this.accounts.authenticate(accessToken);
    if (!isId(runId)) throw runtimeError('VALIDATION_INVALID_INPUT', 'Cloud run ID is invalid');
    return this.eventsFor(session.tenant, runId);
  }

  private async findEstimate(tenant: TenantRef, estimateId: Id): Promise<StoredCloudEstimate> {
    const stored = await this.store.getEstimate(tenant, estimateId);
    if (stored === undefined)
      throw runtimeError('ARTIFACT_NOT_FOUND', 'Cloud estimate was not found');
    return stored;
  }

  private consumeInferenceEvent(
    event: CloudInferenceEvent,
    append: (text: string) => void,
    recordUsage: (usage: {
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly providerRequestId?: string;
    }) => void,
  ): void {
    if (event.type === 'delta') append(event.text);
    if (event.type === 'usage') recordUsage(event);
  }

  private async emit(
    request: CloudRunRequestV1,
    cloudAttemptId: Id,
    eventName: CloudRunEventV1['eventName'],
    payload: unknown,
  ): Promise<CloudRunEventV1> {
    const now = this.clock();
    const eventId = newSortableId();
    const cloudEvent: Omit<CloudRunEventV1, 'sequence'> = {
      schemaVersion: 1,
      eventId,
      runId: request.runId,
      cloudAttemptId,
      tenant: clone(request.tenant),
      eventName,
      payload: JSON.parse(JSON.stringify(payload)) as JsonValue,
      occurredAt: now,
    };
    const runtimeEvent: RuntimeEvent = {
      schemaVersion: 1,
      eventId,
      eventName: `cloud.${eventName}.v1`,
      tenant: clone(request.tenant),
      aggregateType: 'Run',
      aggregateId: request.runId,
      aggregateVersion: 0,
      occurredAt: now,
      actor: clone(request.actor),
      correlationId: request.runId,
      payload: cloudEvent as unknown as JsonValue,
    };
    const stored = await this.store.appendEvent({ cloudEvent, runtimeEvent });
    await this.events.publish(stored.runtimeEvent, 'cloud-runs');
    return clone(stored.cloudEvent);
  }
}

function assertCloudRequestShape(value: unknown): asserts value is CloudRunRequestV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Cloud run request must be an object');
  }
  const record = value as Record<string, unknown>;
  const tenant = record['tenant'];
  const actor = record['actor'];
  const maxCost = record['maxCost'];
  if (
    tenant === null ||
    typeof tenant !== 'object' ||
    Array.isArray(tenant) ||
    actor === null ||
    typeof actor !== 'object' ||
    Array.isArray(actor) ||
    maxCost === null ||
    typeof maxCost !== 'object' ||
    Array.isArray(maxCost)
  ) {
    throw runtimeError('VALIDATION_SCHEMA_MISMATCH', 'Cloud run request has invalid scoped fields');
  }
}
