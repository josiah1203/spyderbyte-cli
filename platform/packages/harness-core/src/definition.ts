import type { AgentTier, JsonValue, RetryPolicy } from '@agentic-platform/runtime-contracts';
import { runtimeError } from '@agentic-platform/runtime-contracts';
import { allowedChildTiers } from './tiers.js';
import { hookMustFailClosed, type HarnessHooks } from './hooks.js';

export interface RuntimeSchema<T> {
  name: string;
  validate(value: unknown): { valid: boolean; value?: T; errors: readonly string[] };
}

export interface PromptPolicy {
  maxPromptBytes: number;
  allowExternalInstructions: boolean;
}

export interface ContextPolicy {
  maxContextBytes: number;
  artifactContent: 'summary' | 'authorized_content';
  includeWorkspacePolicy: boolean;
  includeChildReports: boolean;
}

export interface ToolPolicy {
  requireGrants: boolean;
  allowedOperations: string[];
  maxCalls: number;
}

export interface ModelPolicy {
  allowedModels: string[];
  fallbackModels: string[];
  maxTokens: number;
  allowProviderFallback: boolean;
  allowedProviders?: string[];
  requiredCapabilities?: string[];
  allowExternalModels?: boolean;
  dataClass?: import('./model.js').ModelDataClass;
  providerPriority?: string[];
}

export interface AuthorityPolicy {
  permittedActions: string[];
  allowedChildTiers: AgentTier[];
  maxDepth: number;
  maxChildren: number;
}

export interface BudgetPolicy {
  budgetId: import('@agentic-platform/runtime-contracts').Id;
  currency: string;
  maxMinorUnits: number;
  requireReservation: boolean;
}

export interface ApprovalPolicy {
  requiredActions: string[];
  expiryMs: number;
}

export interface PluginReference {
  name: string;
  version: string;
  capabilities: string[];
}

export interface AcceptancePolicy<TOutput extends JsonValue> {
  validate(
    output: TOutput,
    invocation: import('@agentic-platform/runtime-contracts').AgentInvocation,
  ): void | Promise<void>;
}

export interface HarnessIdentity {
  agentType: string;
  version: string;
}

export interface HarnessDefinition<TInput extends JsonValue, TOutput extends JsonValue> {
  identity: HarnessIdentity;
  tier: AgentTier;
  inputSchema: RuntimeSchema<TInput>;
  outputSchema: RuntimeSchema<TOutput>;
  promptPolicy: PromptPolicy;
  contextPolicy: ContextPolicy;
  toolPolicy: ToolPolicy;
  modelPolicy: ModelPolicy;
  authorityPolicy: AuthorityPolicy;
  budgetPolicy: BudgetPolicy;
  retryPolicy: RetryPolicy;
  approvalPolicy: ApprovalPolicy;
  plugins: PluginReference[];
  hooks: HarnessHooks;
  acceptancePolicy: AcceptancePolicy<TOutput>;
}

export interface Harness<TInput extends JsonValue, TOutput extends JsonValue> {
  readonly definition: HarnessDefinition<TInput, TOutput>;
  validateInput(value: unknown): TInput;
  validateOutput(value: unknown): TOutput;
}

function assertPositive(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} must be a positive safe integer`);
  }
}

function assertNonNegative(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} must be a non-negative safe integer`);
  }
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} must not contain duplicates`);
  }
}

function assertUniqueNumbers(values: readonly number[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} must not contain duplicates`);
  }
}

function assertHookPolicies(hooks: HarnessHooks): void {
  for (const [name, hook] of Object.entries(hooks)) {
    if (
      hook &&
      hook.failureMode === 'best_effort' &&
      (hook.kind === undefined || hookMustFailClosed(hook.kind))
    ) {
      throw runtimeError(
        'POLICY_DENIED',
        `Harness hook ${name} must fail closed; it must declare a noncritical kind before it can be best effort`,
      );
    }
  }
}

export class HarnessFactory {
  create<TInput extends JsonValue, TOutput extends JsonValue>(
    definition: HarnessDefinition<TInput, TOutput>,
  ): Harness<TInput, TOutput> {
    if (definition.tier !== 0 && definition.tier !== 1 && definition.tier !== 2) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Harness tier must be 0, 1, or 2');
    }
    if (
      typeof definition.identity.agentType !== 'string' ||
      definition.identity.agentType.trim().length === 0 ||
      typeof definition.identity.version !== 'string' ||
      definition.identity.version.trim().length === 0
    ) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Harness identity is required');
    }
    if (
      typeof definition.inputSchema.name !== 'string' ||
      definition.inputSchema.name.trim().length === 0 ||
      typeof definition.outputSchema.name !== 'string' ||
      definition.outputSchema.name.trim().length === 0
    ) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Harness schemas must be named');
    }
    assertPositive(definition.promptPolicy.maxPromptBytes, 'maxPromptBytes');
    if (typeof definition.promptPolicy.allowExternalInstructions !== 'boolean') {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'allowExternalInstructions must be boolean');
    }
    assertPositive(definition.contextPolicy.maxContextBytes, 'maxContextBytes');
    assertNonNegative(definition.toolPolicy.maxCalls, 'maxCalls');
    if (
      definition.toolPolicy.allowedOperations.length > 0 &&
      (definition.toolPolicy.maxCalls === 0 || !definition.toolPolicy.requireGrants)
    ) {
      throw runtimeError(
        'AUTHORITY_MISSING',
        'Harness tool operations require grants and a positive call limit',
      );
    }
    assertPositive(definition.modelPolicy.maxTokens, 'maxTokens');
    assertNonNegative(definition.authorityPolicy.maxDepth, 'maxDepth');
    assertNonNegative(definition.authorityPolicy.maxChildren, 'maxChildren');
    assertUniqueNumbers(definition.authorityPolicy.allowedChildTiers, 'allowedChildTiers');
    if (
      definition.authorityPolicy.allowedChildTiers.length > 0 &&
      definition.authorityPolicy.maxChildren === 0
    ) {
      throw runtimeError(
        'AUTHORITY_MISSING',
        'A harness that permits child tiers must have a positive child limit',
      );
    }
    assertPositive(definition.budgetPolicy.maxMinorUnits, 'maxMinorUnits');
    if (definition.budgetPolicy.currency.trim().length === 0) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Budget currency is required');
    }
    assertPositive(definition.approvalPolicy.expiryMs, 'approval expiry');
    assertUnique(definition.toolPolicy.allowedOperations, 'allowedOperations');
    assertUnique(definition.modelPolicy.allowedModels, 'allowedModels');
    if (definition.modelPolicy.allowedProviders !== undefined) {
      assertUnique(definition.modelPolicy.allowedProviders, 'allowedProviders');
    }
    if (definition.modelPolicy.requiredCapabilities !== undefined) {
      assertUnique(definition.modelPolicy.requiredCapabilities, 'requiredCapabilities');
    }
    if (definition.modelPolicy.providerPriority !== undefined) {
      assertUnique(definition.modelPolicy.providerPriority, 'providerPriority');
    }
    assertUnique(definition.modelPolicy.fallbackModels, 'fallbackModels');
    assertUnique(definition.approvalPolicy.requiredActions, 'requiredActions');
    assertUnique(definition.retryPolicy.retryableErrorCodes, 'retryableErrorCodes');
    if (
      !Number.isSafeInteger(definition.retryPolicy.maxAttempts) ||
      !Number.isSafeInteger(definition.retryPolicy.backoffMs) ||
      !Number.isSafeInteger(definition.retryPolicy.maxBackoffMs) ||
      definition.retryPolicy.backoffMs < 0 ||
      definition.retryPolicy.maxBackoffMs < definition.retryPolicy.backoffMs
    ) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Harness retry backoff policy is invalid');
    }
    const pluginNames = definition.plugins.map((plugin) => plugin.name);
    assertUnique(pluginNames, 'plugin names');
    for (const plugin of definition.plugins) {
      if (plugin.name.trim().length === 0 || plugin.version.trim().length === 0) {
        throw runtimeError('VALIDATION_INVALID_INPUT', 'Plugin name and version are required');
      }
      assertUnique(plugin.capabilities, `plugin ${plugin.name} capabilities`);
    }
    assertHookPolicies(definition.hooks);
    const permittedTiers = allowedChildTiers(definition.tier);
    if (
      definition.authorityPolicy.allowedChildTiers.some((tier) => !permittedTiers.includes(tier))
    ) {
      throw runtimeError('INVOCATION_TIER_VIOLATION', 'Harness requests a prohibited child tier');
    }
    if (
      definition.tier === 2 &&
      definition.toolPolicy.allowedOperations.length > 0 &&
      !definition.toolPolicy.requireGrants
    ) {
      throw runtimeError('AUTHORITY_MISSING', 'Tier 2 tools must require capability grants');
    }
    if (!definition.budgetPolicy.requireReservation) {
      throw runtimeError(
        'BUDGET_EXCEEDED',
        'Harness model/tool calls must reserve budget before execution',
      );
    }
    if (definition.retryPolicy.maxAttempts < 1 || definition.retryPolicy.maxAttempts > 20) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'Harness retry policy is outside the supported range',
      );
    }
    return {
      definition,
      validateInput(value: unknown): TInput {
        const result = definition.inputSchema.validate(value);
        if (!result.valid || result.value === undefined) {
          throw runtimeError(
            'VALIDATION_SCHEMA_MISMATCH',
            `${definition.inputSchema.name}: ${result.errors.join('; ')}`,
          );
        }
        return result.value;
      },
      validateOutput(value: unknown): TOutput {
        const result = definition.outputSchema.validate(value);
        if (!result.valid || result.value === undefined) {
          throw runtimeError(
            'HARNESS_OUTPUT_INVALID',
            `${definition.outputSchema.name}: ${result.errors.join('; ')}`,
          );
        }
        return result.value;
      },
    };
  }
}
