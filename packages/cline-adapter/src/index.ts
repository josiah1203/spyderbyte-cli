import {
  normalizeClineError,
  type ClineAdapter,
  type ClineRuntime,
  type ClineStreamEvent,
  type ClineToolRegistration,
  type NormalizedClineError,
  type ClineRuntimeOptions,
} from '@agentic-platform/harness-core';
import {
  newSortableId,
  type AgentInvocation,
  type JsonValue,
  type UsageObservation,
} from '@agentic-platform/runtime-contracts';

/**
 * This is the narrow surface pinned by the compatibility fixture. The real
 * Cline SDK is loaded by an application-owned adapter in production; business
 * packages only see ClineAdapter/ClineRuntime from harness-core.
 */
export type ClineSdkEvent =
  | { readonly type: 'assistant-text-delta'; readonly text: string }
  | {
      readonly type: 'tool-call';
      readonly toolName: string;
      readonly operation: string;
      readonly input: JsonValue;
    }
  | { readonly type: 'usage'; readonly usage: UsageObservation }
  | { readonly type: 'completed'; readonly output: JsonValue }
  | { readonly type: 'failed'; readonly error: unknown };

export interface ClineSdkRunResult {
  readonly status: 'completed' | 'aborted' | 'failed';
  readonly output: JsonValue;
  readonly usage: readonly UsageObservation[];
  readonly error?: unknown;
}

export interface ClineSdkAgentConfig {
  readonly agentId: string;
  readonly agentRole: string;
  readonly modelId: string;
  readonly providerId?: string;
  readonly model?: unknown;
}

export interface ClineSdkRuntimeLike {
  run(input: JsonValue): Promise<ClineSdkRunResult>;
  abort(reason?: string): void;
  subscribe(listener: (event: ClineSdkEvent) => void): () => void;
  registerTool(tool: {
    readonly name: string;
    execute(input: JsonValue): Promise<JsonValue>;
  }): void;
  snapshot(): JsonValue;
}

export interface ClineSdkFactoryLike {
  createAgent(config: ClineSdkAgentConfig): ClineSdkRuntimeLike;
}

/**
 * Adapter-shaped view of the public @cline/llms gateway. Keeping this type
 * structural means the platform can pin Cline independently while all
 * Cline-specific imports remain inside this package.
 */
export interface ClineGatewayLike {
  createAgentModel(selection: { providerId: string; modelId: string }): unknown;
}

export interface ClineGatewayAgentFactoryLike {
  createAgent(config: ClineSdkAgentConfig & { model: unknown }): ClineSdkRuntimeLike;
}

export class ClineGatewaySdkFactory implements ClineSdkFactoryLike {
  constructor(
    private readonly gateway: ClineGatewayLike,
    private readonly factory: ClineGatewayAgentFactoryLike,
  ) {}

  createAgent(config: ClineSdkAgentConfig): ClineSdkRuntimeLike {
    const model = this.gateway.createAgentModel({
      providerId: config.providerId ?? 'openai-codex',
      modelId: config.modelId,
    });
    return this.factory.createAgent({ ...config, model });
  }
}

class AsyncEventQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) this.waiters.shift()?.({ value: undefined, done: true });
  }

  async next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return { value, done: false };
    if (this.closed) return { value: undefined, done: true };
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

function mapSdkEvent(event: ClineSdkEvent): ClineStreamEvent {
  switch (event.type) {
    case 'assistant-text-delta':
      return { type: 'output', value: event.text };
    case 'tool-call':
      return {
        type: 'tool_call',
        toolName: event.toolName,
        operation: event.operation,
        input: event.input,
      };
    case 'usage':
      return { type: 'usage', usage: event.usage };
    case 'completed':
      return { type: 'output', value: event.output };
    case 'failed':
      return { type: 'failed', error: event.error };
  }
}

export class ClineSdkCompatibilityAdapter implements ClineAdapter {
  private readonly factory: ClineSdkFactoryLike;

  constructor(factory: ClineSdkFactoryLike) {
    this.factory = factory;
  }

  async createRuntime(
    invocation: AgentInvocation,
    options?: ClineRuntimeOptions,
  ): Promise<ClineRuntime> {
    const sdk = this.factory.createAgent({
      agentId: invocation.authority.subjectAgentId,
      agentRole: invocation.agentType,
      modelId: options?.model?.selected.modelId ?? invocation.harnessVersion,
      ...(options?.model?.selected.providerId === undefined
        ? {}
        : { providerId: options.model.selected.providerId }),
    });
    const tools = new Map<string, ClineToolRegistration>();
    const usages: UsageObservation[] = [];
    let disposed = false;
    const stream = (input: JsonValue, signal?: AbortSignal): AsyncIterable<ClineStreamEvent> => {
      return (async function* (): AsyncIterable<ClineStreamEvent> {
        if (disposed || signal?.aborted) return;
        const queue = new AsyncEventQueue<ClineStreamEvent>();
        const unsubscribe = sdk.subscribe((event) => {
          try {
            const mapped = mapSdkEvent(event);
            if (mapped.type === 'usage') usages.push(structuredClone(mapped.usage));
            queue.push(mapped);
          } catch (error) {
            queue.push({ type: 'failed', error });
          }
        });
        const abort = (): void => sdk.abort('platform cancellation');
        signal?.addEventListener('abort', abort, { once: true });
        const runPromise = sdk
          .run(input)
          .then((result) => {
            for (const usage of result.usage) {
              usages.push(structuredClone(usage));
              queue.push({ type: 'usage', usage });
            }
            if (result.status === 'failed') {
              queue.push({
                type: 'failed',
                error: result.error ?? new Error('Cline runtime failed'),
              });
            }
            if (result.status === 'aborted') return;
            if (result.status === 'completed') queue.push({ type: 'completed' });
          })
          .catch((error) => queue.push({ type: 'failed', error }))
          .finally(() => queue.close());
        try {
          for (;;) {
            const next = await queue.next();
            if (next.done) break;
            yield next.value;
          }
          await runPromise;
        } finally {
          signal?.removeEventListener('abort', abort);
          unsubscribe();
        }
      })();
    };
    return {
      runtimeId: `cline-fixture-${newSortableId()}`,
      executeStructured(input, signal) {
        return (async function* (): AsyncIterable<JsonValue> {
          for await (const event of stream(input, signal))
            if (event.type === 'output') yield event.value;
        })();
      },
      streamEvents: stream,
      registerTool(tool) {
        tools.set(`${tool.grant.toolName}.${tool.grant.operation}`, tool);
        sdk.registerTool({
          name: `${tool.grant.toolName}.${tool.grant.operation}`,
          execute: (input) => tool.execute(input),
        });
      },
      async cancel(reason) {
        sdk.abort(reason);
      },
      async usage() {
        return structuredClone(usages);
      },
      async dispose() {
        disposed = true;
        sdk.abort('disposed');
        tools.clear();
      },
    };
  }

  normalizeError(error: unknown): NormalizedClineError {
    return normalizeClineError(error);
  }
}

export interface FixtureClineSdkOptions {
  run(
    input: JsonValue,
    tools: ReadonlyMap<string, (input: JsonValue) => Promise<JsonValue>>,
    signal: AbortSignal,
  ): AsyncIterable<ClineSdkEvent>;
}

export class FixtureClineSdkFactory implements ClineSdkFactoryLike {
  constructor(private readonly options: FixtureClineSdkOptions) {}

  createAgent(config: ClineSdkAgentConfig): ClineSdkRuntimeLike {
    if (
      config.agentId.length === 0 ||
      config.agentRole.length === 0 ||
      config.modelId.length === 0
    ) {
      throw new TypeError('Cline fixture agent identity is required');
    }
    const options = this.options;
    const listeners = new Set<(event: ClineSdkEvent) => void>();
    const tools = new Map<string, (input: JsonValue) => Promise<JsonValue>>();
    const controller = new AbortController();
    let snapshot: JsonValue = { runs: 0 };
    return {
      async run(input) {
        const outputs: JsonValue[] = [];
        const usage: UsageObservation[] = [];
        const emit = (event: ClineSdkEvent): void => {
          if (event.type === 'assistant-text-delta' || event.type === 'completed')
            outputs.push(event.type === 'completed' ? event.output : event.text);
          if (event.type === 'usage') usage.push(event.usage);
          for (const listener of listeners) listener(event);
        };
        snapshot = {
          runs:
            typeof snapshot === 'object' &&
            snapshot !== null &&
            !Array.isArray(snapshot) &&
            typeof snapshot['runs'] === 'number'
              ? snapshot['runs'] + 1
              : 1,
        };
        try {
          for await (const event of options.run(input, tools, controller.signal)) {
            if (controller.signal.aborted) return { status: 'aborted', output: null, usage };
            emit(event);
          }
          if (controller.signal.aborted) return { status: 'aborted', output: null, usage };
          const output = outputs.at(-1) ?? null;
          return { status: 'completed', output, usage };
        } catch (error) {
          emit({ type: 'failed', error });
          return { status: 'failed', output: null, usage, error };
        }
      },
      abort(reason) {
        if (!controller.signal.aborted) controller.abort(reason);
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      registerTool(tool) {
        tools.set(tool.name, tool.execute);
      },
      snapshot() {
        return structuredClone(snapshot);
      },
    };
  }
}
