import {
  isJsonValue,
  newSortableId,
  runtimeError,
  type AuthorityEnvelope,
  type Id,
  type JsonValue,
  type Money,
  type AgentTier,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import { BudgetLedger } from '@agentic-platform/budget';
import { AuthorityService, PolicyDecisionService } from '@agentic-platform/policy';

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: Money;
  providerRequestId?: string;
}

export interface ModelUsageObservation {
  readonly requestId: Id;
  readonly tenant: TenantRef;
  readonly invocationId: Id;
  readonly correlationId: Id;
  readonly budgetId: Id;
  readonly reservationId: Id;
  readonly providerId: string;
  readonly model: string;
  readonly usage: ModelUsage;
  readonly policyVersion: string;
  readonly observedAt: string;
}

export interface ModelUsageSink {
  record(observation: ModelUsageObservation): void | Promise<void>;
}

export class InMemoryModelUsageSink implements ModelUsageSink {
  private readonly observations: ModelUsageObservation[] = [];

  record(observation: ModelUsageObservation): void {
    this.observations.push(structuredClone(observation));
  }

  list(): ModelUsageObservation[] {
    return structuredClone(this.observations);
  }
}

export type ModelDataClass = 'public' | 'internal' | 'confidential' | 'restricted';

export type ModelBillingMode = 'subscription' | 'metered' | 'local' | 'unknown';

export type ModelProviderState = 'ready' | 'unconfigured' | 'unavailable' | 'degraded';

export type ModelAuthenticationState = 'authenticated' | 'required' | 'expired' | 'not_applicable';

export interface ModelProviderUsageStatus {
  readonly quotaState: 'unknown' | 'available' | 'exhausted';
  readonly usedUnits?: number;
  readonly limitUnits?: number;
  readonly resetAt?: string;
}

export interface ModelRef {
  providerId: string;
  modelId: string;
}

export interface ModelProviderMetadata {
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName?: string;
  readonly capabilities: readonly string[];
  readonly dataClasses: readonly ModelDataClass[];
  readonly billingMode: ModelBillingMode;
  readonly state: ModelProviderState;
  readonly authenticationState?: ModelAuthenticationState;
  readonly usageStatus?: ModelProviderUsageStatus;
  readonly local: boolean;
  readonly runtimeRequirements?: readonly string[];
  readonly connectionId?: string;
  readonly contextWindow?: number;
}

export interface ModelProviderRequest {
  requestId: Id;
  model: string;
  input: JsonValue;
  maxTokens: number;
  signal?: AbortSignal;
}

export type ModelStreamEvent =
  | { readonly type: 'delta'; readonly value: JsonValue }
  | { readonly type: 'usage'; readonly usage: ModelUsage }
  | { readonly type: 'completed'; readonly output?: JsonValue };

export interface ModelProviderResponse {
  output: JsonValue;
  usage: ModelUsage;
}

export interface ModelProvider {
  providerId: string;
  model: string;
  metadata?: ModelProviderMetadata;
  complete(request: ModelProviderRequest): Promise<ModelProviderResponse>;
  stream?(
    request: ModelProviderRequest,
  ): AsyncIterable<ModelStreamEvent> | Promise<AsyncIterable<ModelStreamEvent>>;
  cancel?(requestId: Id): Promise<void>;
}

function assertModelUsage(usage: ModelUsage): void {
  if (
    !Number.isSafeInteger(usage.inputTokens) ||
    !Number.isSafeInteger(usage.outputTokens) ||
    !Number.isSafeInteger(usage.totalTokens) ||
    usage.inputTokens < 0 ||
    usage.outputTokens < 0 ||
    usage.totalTokens < 0 ||
    usage.totalTokens < usage.inputTokens + usage.outputTokens ||
    !Number.isSafeInteger(usage.cost.amountMinor) ||
    usage.cost.amountMinor < 0 ||
    usage.cost.currency.trim().length === 0
  ) {
    throw runtimeError('HARNESS_OUTPUT_INVALID', 'Provider returned invalid model usage');
  }
}

export interface ModelRoute {
  taskShape: string;
  tier: AgentTier;
  providers: string[];
  maxTokens: number;
}

export interface ModelSelectionRequest {
  tier: AgentTier;
  taskShape: string;
  allowedModels: readonly string[];
  allowedProviders?: readonly string[];
  requiredCapabilities?: readonly string[];
  dataClass?: ModelDataClass;
  allowExternalModels?: boolean;
  providerPriority?: readonly string[];
  override?: ModelRef;
  allowProviderFallback?: boolean;
  /** Explicit precedence for a run/resource/project/workspace policy choice. */
  hierarchy?: ModelSelectionHierarchy;
}

export interface ModelSelectionHierarchy {
  readonly explicit?: ModelRef;
  readonly resource?: ModelRef;
  readonly project?: ModelRef;
  readonly workspace?: ModelRef;
  readonly routingPolicy?: ModelRef;
  readonly fallback?: readonly ModelRef[];
}

export interface ResolvedModel {
  selected: ModelRef;
  providers: ModelProvider[];
  fallback: ModelRef[];
  reason:
    | 'override'
    | 'explicit'
    | 'resource'
    | 'project'
    | 'workspace'
    | 'routing-policy'
    | 'fallback'
    | 'priority'
    | 'route-order';
}

export class ModelRouter {
  private readonly providers = new Map<string, ModelProvider>();
  private readonly routes = new Map<string, ModelRoute>();

  registerProvider(provider: ModelProvider): void {
    const key = `${provider.providerId}:${provider.model}`;
    if (this.providers.has(key))
      throw runtimeError('VALIDATION_INVALID_INPUT', `Model provider already registered: ${key}`);
    if (
      provider.metadata !== undefined &&
      (provider.metadata.providerId !== provider.providerId ||
        provider.metadata.modelId !== provider.model)
    ) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Provider metadata does not match provider');
    }
    this.providers.set(key, provider);
  }

  registerRoute(route: ModelRoute): void {
    if (
      !Number.isSafeInteger(route.maxTokens) ||
      route.maxTokens < 1 ||
      route.providers.length === 0 ||
      route.taskShape.trim().length === 0 ||
      new Set(route.providers).size !== route.providers.length
    ) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'Model route requires providers and a positive token limit',
      );
    }
    const key = `${route.tier}:${route.taskShape}`;
    if (this.routes.has(key))
      throw runtimeError('VALIDATION_INVALID_INPUT', `Model route already registered: ${key}`);
    this.routes.set(key, structuredClone(route));
  }

  addProviderToRoutes(providerKey: string): void {
    for (const [key, route] of this.routes.entries()) {
      if (!route.providers.includes(providerKey)) {
        this.routes.set(key, { ...route, providers: [...route.providers, providerKey] });
      }
    }
  }

  removeProvider(providerKey: string): void {
    this.providers.delete(providerKey);
    for (const [key, route] of this.routes.entries()) {
      this.routes.set(key, {
        ...route,
        providers: route.providers.filter((candidate) => candidate !== providerKey),
      });
    }
  }

  resolve(
    tier: AgentTier,
    taskShape: string,
    allowedModels: readonly string[],
  ): { route: ModelRoute; providers: ModelProvider[] } {
    const resolved = this.resolveSelection({ tier, taskShape, allowedModels });
    return {
      route: structuredClone(this.routes.get(`${tier}:${taskShape}`) as ModelRoute),
      providers: resolved.resolved.providers,
    };
  }

  resolveSelection(request: ModelSelectionRequest): { route: ModelRoute; resolved: ResolvedModel } {
    const route = this.routes.get(`${request.tier}:${request.taskShape}`);
    if (!route) {
      throw runtimeError(
        'COMPUTE_RESOURCE_UNAVAILABLE',
        `No model route for ${request.tier}:${request.taskShape}`,
      );
    }

    const candidates = route.providers
      .map((providerKey) => this.providers.get(providerKey))
      .filter((provider): provider is ModelProvider => provider !== undefined)
      .filter((provider) => request.allowedModels.includes(provider.model))
      .filter(
        (provider) =>
          request.allowedProviders === undefined ||
          request.allowedProviders.includes(provider.providerId),
      )
      .filter((provider) => {
        const metadata = provider.metadata;
        if (metadata === undefined) return true;
        if (metadata.state !== 'ready') return false;
        if (metadata.usageStatus?.quotaState === 'exhausted') return false;
        if (
          request.requiredCapabilities?.some(
            (capability) => !metadata.capabilities.includes(capability),
          )
        ) {
          return false;
        }
        if (request.dataClass !== undefined && !metadata.dataClasses.includes(request.dataClass)) {
          return false;
        }
        if (request.allowExternalModels === false && !metadata.local) return false;
        return true;
      });

    const providerFor = (ref: ModelRef): ModelProvider | undefined =>
      candidates.find(
        (provider) => provider.providerId === ref.providerId && provider.model === ref.modelId,
      );

    const hierarchy = request.hierarchy;
    const hierarchyCandidates: readonly [
      keyof Omit<ModelSelectionHierarchy, 'fallback'>,
      ModelRef | undefined,
    ][] = [
      ['explicit', hierarchy?.explicit ?? request.override],
      ['resource', hierarchy?.resource],
      ['project', hierarchy?.project],
      ['workspace', hierarchy?.workspace],
      ['routingPolicy', hierarchy?.routingPolicy],
    ];
    for (const [source, ref] of hierarchyCandidates) {
      if (ref === undefined) continue;
      const provider = providerFor(ref);
      if (provider === undefined) {
        if (source === 'explicit') {
          throw runtimeError(
            'COMPUTE_RESOURCE_UNAVAILABLE',
            `Requested model ${ref.providerId}:${ref.modelId} is not available for this harness`,
          );
        }
        continue;
      }
      return {
        route: structuredClone(route),
        resolved: {
          selected: { ...ref },
          providers:
            request.allowProviderFallback === false
              ? [provider]
              : [provider, ...candidates.filter((candidate) => candidate !== provider)],
          fallback:
            request.allowProviderFallback === false
              ? []
              : candidates
                  .filter((candidate) => candidate !== provider)
                  .map((candidate) => ({
                    providerId: candidate.providerId,
                    modelId: candidate.model,
                  })),
          reason:
            source === 'explicit' && request.override !== undefined
              ? 'override'
              : source === 'routingPolicy'
                ? 'routing-policy'
                : source,
        },
      };
    }

    for (const ref of hierarchy?.fallback ?? []) {
      const provider = providerFor(ref);
      if (provider === undefined) continue;
      return {
        route: structuredClone(route),
        resolved: {
          selected: { ...ref },
          providers:
            request.allowProviderFallback === false
              ? [provider]
              : [provider, ...candidates.filter((candidate) => candidate !== provider)],
          fallback:
            request.allowProviderFallback === false
              ? []
              : candidates
                  .filter((candidate) => candidate !== provider)
                  .map((candidate) => ({
                    providerId: candidate.providerId,
                    modelId: candidate.model,
                  })),
          reason: 'fallback',
        },
      };
    }

    const priority = request.providerPriority ?? [];
    const ranked = [...candidates].sort((left, right) => {
      const leftRank = priority.indexOf(left.providerId);
      const rightRank = priority.indexOf(right.providerId);
      const normalizedLeft = leftRank < 0 ? Number.MAX_SAFE_INTEGER : leftRank;
      const normalizedRight = rightRank < 0 ? Number.MAX_SAFE_INTEGER : rightRank;
      return normalizedLeft - normalizedRight;
    });
    const selected = ranked[0];
    if (selected === undefined) {
      throw runtimeError('COMPUTE_RESOURCE_UNAVAILABLE', 'No allowed model provider is available');
    }
    const providers = request.allowProviderFallback === false ? [selected] : ranked;
    return {
      route: structuredClone(route),
      resolved: {
        selected: { providerId: selected.providerId, modelId: selected.model },
        providers,
        fallback: providers.slice(1).map((provider) => ({
          providerId: provider.providerId,
          modelId: provider.model,
        })),
        reason: priority.length > 0 ? 'priority' : 'route-order',
      },
    };
  }
}

export interface ModelTelemetryEvent {
  type: 'start' | 'completion' | 'failure';
  requestId: Id;
  tenant: TenantRef;
  invocationId: Id;
  correlationId: Id;
  providerId: string;
  model: string;
  policyVersion: string;
  usage?: ModelUsage;
  errorCode?: string;
  selectionReason?: ResolvedModel['reason'];
  selectedModel?: ModelRef;
  fallbackCandidates?: ModelRef[];
}

export interface ModelTelemetrySink {
  emit(event: ModelTelemetryEvent): void;
}

export type ModelAuditEvent =
  | {
      type: 'selection';
      tenant: TenantRef;
      invocationId: Id;
      correlationId: Id;
      selected: ModelRef;
      fallback: ModelRef[];
      reason: ResolvedModel['reason'];
      policyVersion: string;
    }
  | {
      type: 'fallback';
      tenant: TenantRef;
      invocationId: Id;
      correlationId: Id;
      from: ModelRef;
      to: ModelRef;
      policyVersion: string;
    }
  | {
      type: 'attempt' | 'completed' | 'failed';
      tenant: TenantRef;
      invocationId: Id;
      correlationId: Id;
      requestId: Id;
      providerId: string;
      model: string;
      policyVersion: string;
      usage?: ModelUsage;
      errorCode?: string;
    };

export interface ModelAuditSink {
  record(event: ModelAuditEvent): void;
}

export class InMemoryModelAuditSink implements ModelAuditSink {
  private readonly events: ModelAuditEvent[] = [];

  record(event: ModelAuditEvent): void {
    this.events.push(structuredClone(event));
  }

  list(): ModelAuditEvent[] {
    return structuredClone(this.events);
  }
}

export class InMemoryModelTelemetrySink implements ModelTelemetrySink {
  private readonly events: ModelTelemetryEvent[] = [];

  emit(event: ModelTelemetryEvent): void {
    this.events.push(structuredClone(event));
  }

  list(): ModelTelemetryEvent[] {
    return structuredClone(this.events);
  }
}

export interface MeteredModelRequest {
  tenant: TenantRef;
  invocationId: Id;
  correlationId: Id;
  authority: AuthorityEnvelope;
  budgetId: Id;
  taskShape: string;
  tier: AgentTier;
  input: JsonValue;
  allowedModels: string[];
  maxTokens: number;
  estimatedCost: Money;
  allowedProviders?: string[];
  requiredCapabilities?: string[];
  dataClass?: ModelDataClass;
  allowExternalModels?: boolean;
  providerPriority?: string[];
  modelOverride?: ModelRef;
  allowProviderFallback?: boolean;
  requiresApproval?: boolean;
  now?: string;
  deadlineAt?: string;
  signal?: AbortSignal;
}

export interface MeteredModelResponse {
  output: JsonValue;
  usage: ModelUsage;
  providerId: string;
  model: string;
  policyVersion: string;
  decisionId: Id;
}

export interface MeteredModelClientOptions {
  authority: Pick<AuthorityService, 'assertAuthorized'>;
  policy: PolicyDecisionService;
  budget: BudgetLedger;
  router: ModelRouter;
  telemetry?: ModelTelemetrySink;
  audit?: ModelAuditSink;
  usage?: ModelUsageSink;
  clock?: () => string;
}

function abortError(): Error {
  return runtimeError(
    'COMPUTE_RESOURCE_UNAVAILABLE',
    'Model call was cancelled or exceeded its deadline',
  );
}

async function withCancellation<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
  deadlineAt: string | undefined,
): Promise<T> {
  if (signal?.aborted) throw abortError();
  const deadline = deadlineAt === undefined ? undefined : Date.parse(deadlineAt);
  if (deadline !== undefined && (!Number.isFinite(deadline) || deadline <= Date.now()))
    throw abortError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const cancellation = new Promise<never>((_, reject) => {
    const cancel = () => reject(abortError());
    abortListener = cancel;
    signal?.addEventListener('abort', cancel, { once: true });
    if (deadline !== undefined) timer = setTimeout(cancel, Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([work, cancellation]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abortListener !== undefined) signal?.removeEventListener('abort', abortListener);
  }
}

export class MeteredModelClient {
  private readonly authority: MeteredModelClientOptions['authority'];
  private readonly policy: PolicyDecisionService;
  private readonly budget: BudgetLedger;
  private readonly router: ModelRouter;
  private readonly telemetry: ModelTelemetrySink | undefined;
  private readonly audit: ModelAuditSink | undefined;
  private readonly usage: ModelUsageSink | undefined;
  private readonly clock: () => string;

  constructor(options: MeteredModelClientOptions) {
    this.authority = options.authority;
    this.policy = options.policy;
    this.budget = options.budget;
    this.router = options.router;
    this.telemetry = options.telemetry;
    this.audit = options.audit;
    this.usage = options.usage;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async complete(request: MeteredModelRequest): Promise<MeteredModelResponse> {
    const now = request.now ?? this.clock();
    if (!Number.isSafeInteger(request.maxTokens) || request.maxTokens < 1) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Model token limit must be positive');
    }
    this.authority.assertAuthorized(request.authority, {
      tenant: request.tenant,
      workflowId: request.authority.workflowId,
      invocationId: request.invocationId,
      actorId: request.authority.subjectAgentId,
      action: 'model.call',
      now,
    });
    const decision = this.policy.decide({
      action: 'compute_allocation',
      tenant: request.tenant,
      workflowId: request.authority.workflowId,
      invocationId: request.invocationId,
      actor: { actorId: request.authority.subjectAgentId, type: 'agent' },
      authority: request.authority,
      resources: [],
      evaluatedAt: now,
      resourceClass: 'model',
      estimatedCost: request.estimatedCost,
      ...(request.requiresApproval !== undefined
        ? { requiresApproval: request.requiresApproval }
        : {}),
    });
    this.policy.assertAllowed(decision);
    const resolved = this.router.resolveSelection({
      tier: request.tier,
      taskShape: request.taskShape,
      allowedModels: request.allowedModels,
      ...(request.allowedProviders === undefined
        ? {}
        : { allowedProviders: request.allowedProviders }),
      ...(request.requiredCapabilities === undefined
        ? {}
        : { requiredCapabilities: request.requiredCapabilities }),
      ...(request.dataClass === undefined ? {} : { dataClass: request.dataClass }),
      ...(request.allowExternalModels === undefined
        ? {}
        : { allowExternalModels: request.allowExternalModels }),
      ...(request.providerPriority === undefined
        ? {}
        : { providerPriority: request.providerPriority }),
      ...(request.modelOverride === undefined ? {} : { override: request.modelOverride }),
      ...(request.allowProviderFallback === undefined
        ? {}
        : { allowProviderFallback: request.allowProviderFallback }),
    });
    const tokenLimit = Math.min(request.maxTokens, resolved.route.maxTokens);
    if (tokenLimit < 1)
      throw runtimeError('COMPUTE_RESOURCE_UNAVAILABLE', 'Model token limit is invalid');
    this.audit?.record({
      type: 'selection',
      tenant: request.tenant,
      invocationId: request.invocationId,
      correlationId: request.correlationId,
      selected: resolved.resolved.selected,
      fallback: resolved.resolved.fallback,
      reason: resolved.resolved.reason,
      policyVersion: decision.policyVersion,
    });
    const reservation = await this.budget.reserve({
      budgetId: request.budgetId,
      tenant: request.tenant,
      invocationId: request.invocationId,
      category: 'llm',
      amount: request.estimatedCost,
      authority: request.authority,
      now,
    });
    let lastError: unknown;
    let reservationFinalized = false;
    const deadline = request.deadlineAt === undefined ? undefined : Date.parse(request.deadlineAt);
    for (const [providerIndex, provider] of resolved.resolved.providers.entries()) {
      const requestId = providerRequestId();
      if (providerIndex > 0) {
        const previous = resolved.resolved.providers[providerIndex - 1];
        if (previous !== undefined) {
          this.audit?.record({
            type: 'fallback',
            tenant: request.tenant,
            invocationId: request.invocationId,
            correlationId: request.correlationId,
            from: { providerId: previous.providerId, modelId: previous.model },
            to: { providerId: provider.providerId, modelId: provider.model },
            policyVersion: decision.policyVersion,
          });
        }
      }
      this.telemetry?.emit({
        type: 'start',
        requestId,
        tenant: request.tenant,
        invocationId: request.invocationId,
        correlationId: request.correlationId,
        providerId: provider.providerId,
        model: provider.model,
        policyVersion: decision.policyVersion,
        selectionReason: resolved.resolved.reason,
        selectedModel: resolved.resolved.selected,
        fallbackCandidates: resolved.resolved.fallback,
      });
      this.audit?.record({
        type: 'attempt',
        tenant: request.tenant,
        invocationId: request.invocationId,
        correlationId: request.correlationId,
        requestId,
        providerId: provider.providerId,
        model: provider.model,
        policyVersion: decision.policyVersion,
      });
      try {
        const providerResponse = await withCancellation(
          provider.complete({
            requestId,
            model: provider.model,
            input: request.input,
            maxTokens: tokenLimit,
            ...(request.signal !== undefined ? { signal: request.signal } : {}),
          }),
          request.signal,
          request.deadlineAt,
        );
        assertModelUsage(providerResponse.usage);
        if (providerResponse.usage.totalTokens > tokenLimit) {
          throw runtimeError(
            'COMPUTE_RESOURCE_UNAVAILABLE',
            'Provider exceeded the model token limit',
          );
        }
        if (!isJsonValue(providerResponse.output)) {
          throw runtimeError('HARNESS_OUTPUT_INVALID', 'Model provider returned a non-JSON output');
        }
        if (
          !Number.isSafeInteger(providerResponse.usage.totalTokens) ||
          providerResponse.usage.totalTokens < 0
        ) {
          throw runtimeError(
            'HARNESS_OUTPUT_INVALID',
            'Model provider returned invalid token usage',
          );
        }
        await this.budget.reconcile({
          tenant: request.tenant,
          invocationId: request.invocationId,
          reservationId: reservation.reservation.reservationId,
          actual: providerResponse.usage.cost,
          authority: request.authority,
          now,
        });
        reservationFinalized = true;
        await this.usage?.record({
          requestId,
          tenant: request.tenant,
          invocationId: request.invocationId,
          correlationId: request.correlationId,
          budgetId: request.budgetId,
          reservationId: reservation.reservation.reservationId,
          providerId: provider.providerId,
          model: provider.model,
          usage: structuredClone(providerResponse.usage),
          policyVersion: decision.policyVersion,
          observedAt: now,
        });
        this.audit?.record({
          type: 'completed',
          tenant: request.tenant,
          invocationId: request.invocationId,
          correlationId: request.correlationId,
          requestId,
          providerId: provider.providerId,
          model: provider.model,
          policyVersion: decision.policyVersion,
          usage: structuredClone(providerResponse.usage),
        });
        this.telemetry?.emit({
          type: 'completion',
          requestId,
          tenant: request.tenant,
          invocationId: request.invocationId,
          correlationId: request.correlationId,
          providerId: provider.providerId,
          model: provider.model,
          policyVersion: decision.policyVersion,
          usage: providerResponse.usage,
        });
        return {
          output: providerResponse.output,
          usage: providerResponse.usage,
          providerId: provider.providerId,
          model: provider.model,
          policyVersion: decision.policyVersion,
          decisionId: decision.decisionId,
        };
      } catch (error) {
        lastError = error;
        const errorCode =
          error instanceof Error && 'code' in error ? String(error.code) : 'MODEL_PROVIDER_FAILURE';
        this.telemetry?.emit({
          type: 'failure',
          requestId,
          tenant: request.tenant,
          invocationId: request.invocationId,
          correlationId: request.correlationId,
          providerId: provider.providerId,
          model: provider.model,
          policyVersion: decision.policyVersion,
          errorCode,
        });
        this.audit?.record({
          type: 'failed',
          tenant: request.tenant,
          invocationId: request.invocationId,
          correlationId: request.correlationId,
          requestId,
          providerId: provider.providerId,
          model: provider.model,
          policyVersion: decision.policyVersion,
          errorCode,
        });
        if (reservationFinalized) throw error;
        if (errorCode === 'COMPUTE_RESOURCE_UNAVAILABLE' || request.signal?.aborted) {
          try {
            await provider.cancel?.(requestId);
          } catch {
            // Cancellation cleanup must not mask the original provider/deadline failure.
          }
        }
        if (
          request.signal?.aborted ||
          (deadline !== undefined && (!Number.isFinite(deadline) || deadline <= Date.now())) ||
          errorCode === 'AUTHORITY_MISSING' ||
          errorCode === 'POLICY_DENIED' ||
          errorCode === 'HARNESS_OUTPUT_INVALID' ||
          errorCode === 'VALIDATION_INVALID_INPUT' ||
          errorCode === 'VALIDATION_SCHEMA_MISMATCH'
        ) {
          break;
        }
      }
    }
    if (!reservationFinalized) {
      await this.budget.release({
        tenant: request.tenant,
        invocationId: request.invocationId,
        reservationId: reservation.reservation.reservationId,
        authority: request.authority,
        now,
      });
    }
    if (lastError instanceof Error) throw lastError;
    throw runtimeError('EXTERNAL_DEPENDENCY_UNAVAILABLE', 'All model providers failed');
  }
}

function providerRequestId(): Id {
  return newSortableId();
}
