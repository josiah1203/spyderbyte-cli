import {
  runtimeError,
  type AgentInvocation,
  type JsonValue,
} from '@agentic-platform/runtime-contracts';
import {
  HarnessFactory,
  type Harness,
  type HarnessDefinition,
  type PluginReference,
} from './definition.js';

export type Tier2HarnessKind = 'deterministic' | 'plugin' | 'coding';

export interface HarnessSandboxPort {
  run(
    input: JsonValue,
    context: { invocation: AgentInvocation; signal?: AbortSignal },
  ): JsonValue | Promise<JsonValue>;
}

export interface Tier2HarnessExecutionContext {
  readonly invocation: AgentInvocation;
  readonly signal?: AbortSignal;
  readonly sandbox?: HarnessSandboxPort;
  readonly plugins: readonly PluginReference[];
}

export interface Tier2HarnessShellOptions<TInput extends JsonValue, TOutput extends JsonValue> {
  readonly definition: HarnessDefinition<TInput, TOutput>;
  run(input: TInput, context: Tier2HarnessExecutionContext): TOutput | Promise<TOutput>;
  readonly sandbox?: HarnessSandboxPort;
}

export interface Tier2HarnessShell<TInput extends JsonValue, TOutput extends JsonValue> {
  readonly kind: Tier2HarnessKind;
  readonly harness: Harness<TInput, TOutput>;
  run(input: unknown, invocation: AgentInvocation, signal?: AbortSignal): Promise<TOutput>;
}

function assertTier2(definition: HarnessDefinition<JsonValue, JsonValue>): void {
  if (definition.tier !== 2) {
    throw runtimeError(
      'INVOCATION_TIER_VIOLATION',
      'Tier 2 base harnesses require a Tier 2 definition',
    );
  }
}

function assertDeterministic(definition: HarnessDefinition<JsonValue, JsonValue>): void {
  if (
    definition.modelPolicy.allowedModels.length > 0 ||
    definition.modelPolicy.fallbackModels.length > 0 ||
    definition.toolPolicy.allowedOperations.length > 0
  ) {
    throw runtimeError(
      'POLICY_DENIED',
      'Deterministic harnesses cannot declare model or tool operations',
    );
  }
}

function assertPlugin(definition: HarnessDefinition<JsonValue, JsonValue>): void {
  if (definition.plugins.length === 0) {
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Plugin harnesses require at least one plugin');
  }
}

function assertCoding(
  definition: HarnessDefinition<JsonValue, JsonValue>,
  sandbox: HarnessSandboxPort | undefined,
): void {
  if (sandbox === undefined) {
    throw runtimeError('COMPUTE_RESOURCE_UNAVAILABLE', 'Coding harnesses require a sandbox port');
  }
  if (definition.contextPolicy.artifactContent !== 'authorized_content') {
    throw runtimeError(
      'POLICY_DENIED',
      'Coding harnesses must use authorized artifact content policy',
    );
  }
}

class BaseTier2HarnessShell<TInput extends JsonValue, TOutput extends JsonValue>
  implements Tier2HarnessShell<TInput, TOutput>
{
  readonly harness: Harness<TInput, TOutput>;

  constructor(
    readonly kind: Tier2HarnessKind,
    private readonly options: Tier2HarnessShellOptions<TInput, TOutput>,
  ) {
    this.harness = new HarnessFactory().create(options.definition);
  }

  async run(input: unknown, invocation: AgentInvocation, signal?: AbortSignal): Promise<TOutput> {
    if (signal?.aborted) {
      throw runtimeError('COMPUTE_RESOURCE_UNAVAILABLE', 'Harness execution was cancelled');
    }
    if (
      invocation.tier !== 2 ||
      invocation.agentType !== this.harness.definition.identity.agentType ||
      invocation.harnessVersion !== this.harness.definition.identity.version
    ) {
      throw runtimeError(
        'INVOCATION_INVALID_PARENT',
        'Invocation does not match the Tier 2 harness',
      );
    }
    const validatedInput = this.harness.validateInput(input);
    const output = await this.options.run(validatedInput, {
      invocation,
      ...(signal === undefined ? {} : { signal }),
      ...(this.options.sandbox === undefined ? {} : { sandbox: this.options.sandbox }),
      plugins: this.harness.definition.plugins,
    });
    const validatedOutput = this.harness.validateOutput(output);
    await this.harness.definition.acceptancePolicy.validate(validatedOutput, invocation);
    return validatedOutput;
  }
}

export function createDeterministicHarnessShell<
  TInput extends JsonValue,
  TOutput extends JsonValue,
>(options: Tier2HarnessShellOptions<TInput, TOutput>): Tier2HarnessShell<TInput, TOutput> {
  assertTier2(options.definition as HarnessDefinition<JsonValue, JsonValue>);
  assertDeterministic(options.definition as HarnessDefinition<JsonValue, JsonValue>);
  return new BaseTier2HarnessShell('deterministic', options);
}

export function createPluginHarnessShell<TInput extends JsonValue, TOutput extends JsonValue>(
  options: Tier2HarnessShellOptions<TInput, TOutput>,
): Tier2HarnessShell<TInput, TOutput> {
  assertTier2(options.definition as HarnessDefinition<JsonValue, JsonValue>);
  assertPlugin(options.definition as HarnessDefinition<JsonValue, JsonValue>);
  return new BaseTier2HarnessShell('plugin', options);
}

export function createCodingHarnessShell<TInput extends JsonValue, TOutput extends JsonValue>(
  options: Tier2HarnessShellOptions<TInput, TOutput>,
): Tier2HarnessShell<TInput, TOutput> {
  assertTier2(options.definition as HarnessDefinition<JsonValue, JsonValue>);
  assertCoding(options.definition as HarnessDefinition<JsonValue, JsonValue>, options.sandbox);
  return new BaseTier2HarnessShell('coding', options);
}
