import type {
  AgentInvocation,
  JsonValue,
  ToolGrant,
  UsageObservation,
} from '@agentic-platform/runtime-contracts';
import type { ContextDocument } from './context.js';
import type {
  ClineAdapter,
  ClineStreamEvent,
  ClineToolRegistration,
  NormalizedClineError,
} from './adapter.js';
import { normalizeClineError } from './adapter.js';
import type { Harness } from './definition.js';
import type { ModelRef, ModelRouter } from './model.js';

/** The validated, executable harness definition handed to a runtime adapter. */
export type MaterializedHarnessDefinition<
  TInput extends JsonValue,
  TOutput extends JsonValue,
> = Harness<TInput, TOutput>;

export interface AgentContext {
  readonly invocation: AgentInvocation;
  readonly input: JsonValue;
  readonly document: ContextDocument;
  readonly model?: import('./model.js').ResolvedModel;
  readonly modelOverride?: ModelRef;
  readonly dataClass?: import('./model.js').ModelDataClass;
  readonly providerPriority?: readonly string[];
}

export interface BrokeredToolSet {
  readonly tools: readonly ClineToolRegistration[];
}

export type AgentRuntimeEvent<TOutput extends JsonValue = JsonValue> =
  | { readonly type: 'output'; readonly value: TOutput }
  | {
      readonly type: 'tool_call';
      readonly toolName: string;
      readonly operation: string;
      readonly input: JsonValue;
    }
  | { readonly type: 'usage'; readonly usage: UsageObservation }
  | { readonly type: 'completed'; readonly output?: TOutput }
  | { readonly type: 'failed'; readonly error: NormalizedClineError };

export interface AgentRuntimeAdapter {
  run<TInput extends JsonValue, TOutput extends JsonValue>(
    definition: MaterializedHarnessDefinition<TInput, TOutput>,
    context: AgentContext,
    tools: BrokeredToolSet,
    signal: AbortSignal,
  ): AsyncIterable<AgentRuntimeEvent<TOutput>>;
}

function mapEvent<TInput extends JsonValue, TOutput extends JsonValue>(
  definition: MaterializedHarnessDefinition<TInput, TOutput>,
  event: ClineStreamEvent,
): AgentRuntimeEvent<TOutput> {
  switch (event.type) {
    case 'output':
      return { type: 'output', value: definition.validateOutput(event.value) };
    case 'tool_call':
      return event;
    case 'usage':
      return event;
    case 'completed':
      return { type: 'completed' };
    case 'failed':
      return { type: 'failed', error: normalizeAdapterError(event.error) };
  }
}

function normalizeAdapterError(error: unknown): NormalizedClineError {
  return normalizeClineError(error);
}

export class ClineAgentRuntimeAdapter implements AgentRuntimeAdapter {
  constructor(
    private readonly adapter: ClineAdapter,
    private readonly modelRouter?: ModelRouter,
  ) {}

  run<TInput extends JsonValue, TOutput extends JsonValue>(
    definition: MaterializedHarnessDefinition<TInput, TOutput>,
    context: AgentContext,
    tools: BrokeredToolSet,
    signal: AbortSignal,
  ): AsyncIterable<AgentRuntimeEvent<TOutput>> {
    return this.execute(definition, context, tools, signal);
  }

  private async *execute<TInput extends JsonValue, TOutput extends JsonValue>(
    definition: MaterializedHarnessDefinition<TInput, TOutput>,
    context: AgentContext,
    tools: BrokeredToolSet,
    signal: AbortSignal,
  ): AsyncIterable<AgentRuntimeEvent<TOutput>> {
    let runtime: Awaited<ReturnType<ClineAdapter['createRuntime']>> | undefined;
    try {
      const input = definition.validateInput(context.input);
      if (signal.aborted) return;
      const resolvedModel =
        context.model ??
        (this.modelRouter === undefined
          ? undefined
          : this.modelRouter.resolveSelection({
              tier: definition.definition.tier,
              taskShape: definition.definition.identity.agentType,
              allowedModels: [
                ...definition.definition.modelPolicy.allowedModels,
                ...definition.definition.modelPolicy.fallbackModels,
              ],
              ...(definition.definition.modelPolicy.allowedProviders === undefined
                ? {}
                : { allowedProviders: definition.definition.modelPolicy.allowedProviders }),
              ...(definition.definition.modelPolicy.requiredCapabilities === undefined
                ? {}
                : { requiredCapabilities: definition.definition.modelPolicy.requiredCapabilities }),
              ...(context.dataClass === undefined
                ? definition.definition.modelPolicy.dataClass === undefined
                  ? {}
                  : { dataClass: definition.definition.modelPolicy.dataClass }
                : { dataClass: context.dataClass }),
              ...(definition.definition.modelPolicy.allowExternalModels === undefined
                ? {}
                : { allowExternalModels: definition.definition.modelPolicy.allowExternalModels }),
              ...(context.providerPriority === undefined
                ? definition.definition.modelPolicy.providerPriority === undefined
                  ? {}
                  : { providerPriority: definition.definition.modelPolicy.providerPriority }
                : { providerPriority: context.providerPriority }),
              ...(context.modelOverride === undefined ? {} : { override: context.modelOverride }),
              allowProviderFallback: definition.definition.modelPolicy.allowProviderFallback,
            }).resolved);
      runtime = await this.adapter.createRuntime(
        context.invocation,
        resolvedModel === undefined ? undefined : { model: resolvedModel },
      );
      for (const tool of tools.tools) runtime.registerTool(tool);
      for await (const event of runtime.streamEvents(input, signal)) {
        yield mapEvent(definition, event);
      }
    } catch (error) {
      yield { type: 'failed', error: this.adapter.normalizeError(error) };
    } finally {
      await runtime?.dispose();
    }
  }
}

export type BrokeredTool = ClineToolRegistration & { readonly grant: ToolGrant };
