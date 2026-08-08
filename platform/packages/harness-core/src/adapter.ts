import type {
  AgentInvocation,
  JsonValue,
  ToolGrant,
  UsageObservation,
} from '@agentic-platform/runtime-contracts';
import type { ResolvedModel } from './model.js';

export interface ClineToolRegistration {
  grant: ToolGrant;
  execute(input: JsonValue): Promise<JsonValue>;
}

export type ClineStreamEvent =
  | { type: 'output'; value: JsonValue }
  | { type: 'tool_call'; toolName: string; operation: string; input: JsonValue }
  | { type: 'usage'; usage: UsageObservation }
  | { type: 'completed' }
  | { type: 'failed'; error: unknown };

export interface NormalizedClineError {
  code: string;
  message: string;
  retryable: boolean;
}

export function normalizeClineError(error: unknown): NormalizedClineError {
  const candidate =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : undefined;
  const candidateCode = typeof candidate?.['code'] === 'string' ? candidate['code'] : undefined;
  const candidateName = typeof candidate?.['name'] === 'string' ? candidate['name'] : undefined;
  const code =
    candidateCode ??
    (candidateName === 'AbortError' ? 'COMPUTE_RESOURCE_UNAVAILABLE' : 'ADAPTER_EXECUTION_FAILED');
  const nonRetryable = new Set([
    'AUTHORITY_MISSING',
    'POLICY_DENIED',
    'HARNESS_OUTPUT_INVALID',
    'VALIDATION_INVALID_INPUT',
    'VALIDATION_SCHEMA_MISMATCH',
  ]);
  return {
    code,
    message: error instanceof Error ? error.message : 'Cline adapter execution failed',
    retryable: !nonRetryable.has(code),
  };
}

export interface ClineRuntime<TInput extends JsonValue = JsonValue> {
  readonly runtimeId: string;
  executeStructured(input: TInput, signal?: AbortSignal): AsyncIterable<JsonValue>;
  streamEvents(input: TInput, signal?: AbortSignal): AsyncIterable<ClineStreamEvent>;
  registerTool(tool: ClineToolRegistration): void;
  cancel(reason?: string): Promise<void>;
  usage(): Promise<UsageObservation[]>;
  dispose(): Promise<void>;
}

export interface ClineRuntimeOptions {
  readonly model?: ResolvedModel;
}

export interface ClineAdapter {
  createRuntime(invocation: AgentInvocation, options?: ClineRuntimeOptions): Promise<ClineRuntime>;
  normalizeError(error: unknown): NormalizedClineError;
}

export interface FakeClineAdapterOptions {
  run(input: JsonValue, signal?: AbortSignal): AsyncIterable<JsonValue>;
  runEvents?(input: JsonValue, signal?: AbortSignal): AsyncIterable<ClineStreamEvent>;
}

export class FakeClineAdapter implements ClineAdapter {
  private nextRuntimeId = 0;

  constructor(private readonly options: FakeClineAdapterOptions) {}

  async createRuntime(): Promise<ClineRuntime> {
    const runtimeId = `fake-runtime-${++this.nextRuntimeId}`;
    let cancelled = false;
    const tools = new Map<string, ClineToolRegistration>();
    const usages: UsageObservation[] = [];
    const activeControllers = new Set<AbortController>();
    const runEvents = this.options.runEvents;
    const run = this.options.run;
    const iterateEvents = async function* (
      input: JsonValue,
      signal?: AbortSignal,
    ): AsyncIterable<ClineStreamEvent> {
      if (cancelled || signal?.aborted) return;
      const controller = new AbortController();
      const abortFromCaller = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', abortFromCaller, { once: true });
      activeControllers.add(controller);
      try {
        const source = runEvents
          ? runEvents(input, controller.signal)
          : (async function* (): AsyncIterable<ClineStreamEvent> {
              for await (const value of run(input, controller.signal))
                yield { type: 'output', value };
              yield { type: 'completed' };
            })();
        for await (const event of source) {
          if (cancelled || controller.signal.aborted) return;
          if (event.type === 'usage') usages.push(structuredClone(event.usage));
          yield event;
        }
      } finally {
        signal?.removeEventListener('abort', abortFromCaller);
        activeControllers.delete(controller);
      }
    };
    return {
      runtimeId,
      async *executeStructured(input, signal) {
        for await (const event of iterateEvents(input, signal)) {
          if (event.type === 'output') yield event.value;
        }
      },
      streamEvents(input, signal) {
        return iterateEvents(input, signal);
      },
      registerTool(tool) {
        tools.set(`${tool.grant.toolName}.${tool.grant.operation}`, tool);
      },
      async cancel() {
        cancelled = true;
        for (const controller of activeControllers) controller.abort('runtime cancellation');
      },
      async usage() {
        return structuredClone(usages);
      },
      async dispose() {
        cancelled = true;
        for (const controller of activeControllers) controller.abort('runtime disposal');
        tools.clear();
      },
    };
  }

  normalizeError(error: unknown): NormalizedClineError {
    return normalizeClineError(error);
  }
}
