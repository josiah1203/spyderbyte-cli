import {
  isContract,
  isJsonValue,
  runtimeError,
  type AgentInvocation,
  type AgentReport,
  type Id,
  type JsonValue,
  type ResourceSelector,
} from '@agentic-platform/runtime-contracts';
import { ToolBroker } from '@agentic-platform/tool-broker';
import { ContextAssembler, type ContextAssemblyRequest, type ContextDocument } from './context.js';
import type { Harness } from './definition.js';
import { hookMustFailClosed, type HookPayload, type HookRegistration } from './hooks.js';
import { parseStructuredReport, ReportValidator } from './reports.js';
import type { HarnessRegistryPort } from './registry.js';

export interface HarnessToolCall {
  grantId: Id;
  toolName: string;
  operation: string;
  resources: ResourceSelector[];
  input: JsonValue;
}

export interface HarnessModelResult {
  report: unknown;
  toolCalls?: HarnessToolCall[];
  escalated?: boolean;
}

export interface HarnessExecutionRequest<TInput extends JsonValue, TOutput extends JsonValue> {
  harness: Harness<TInput, TOutput>;
  invocation: AgentInvocation<TInput>;
  context: ContextAssemblyRequest;
  modelCall(context: ContextDocument, signal?: AbortSignal): Promise<HarnessModelResult>;
  signal?: AbortSignal;
  artifactVerifier?: Parameters<
    ReportValidator<TInput, TOutput>['validate']
  >[1]['artifactVerifier'];
  costVerifier?: Parameters<ReportValidator<TInput, TOutput>['validate']>[1]['costVerifier'];
  metricVerifier?: Parameters<ReportValidator<TInput, TOutput>['validate']>[1]['metricVerifier'];
  childInvocationVerifier?: Parameters<
    ReportValidator<TInput, TOutput>['validate']
  >[1]['childInvocationVerifier'];
  stateAssertionVerifier?: Parameters<
    ReportValidator<TInput, TOutput>['validate']
  >[1]['stateAssertionVerifier'];
  reportCommitter?: ReportCommitter<TOutput>;
}

export interface HarnessExecutionResult<TOutput extends JsonValue> {
  report: AgentReport<TOutput>;
  context: ContextDocument;
  toolResults: Record<string, JsonValue>;
}

export interface ReportCommitter<TOutput extends JsonValue> {
  commit(report: AgentReport<TOutput>, invocation: AgentInvocation): void | Promise<void>;
}

export interface HarnessExecutorOptions {
  contextAssembler?: ContextAssembler;
  toolBroker?: ToolBroker;
  registry?: HarnessRegistryPort;
  requireRegistry?: boolean;
}

function hookPayload(
  invocation: AgentInvocation,
  context?: ContextDocument,
  extra: Partial<HookPayload> = {},
): HookPayload {
  return {
    invocation,
    ...(context !== undefined ? { context: context as unknown as JsonValue } : {}),
    ...extra,
  };
}

export class HarnessExecutor {
  private readonly contextAssembler: ContextAssembler;
  private readonly toolBroker: ToolBroker | undefined;
  private readonly registry: HarnessRegistryPort | undefined;
  private readonly requireRegistry: boolean;

  constructor(options: HarnessExecutorOptions = {}) {
    this.contextAssembler = options.contextAssembler ?? new ContextAssembler();
    this.toolBroker = options.toolBroker;
    this.registry = options.registry;
    this.requireRegistry = options.requireRegistry ?? false;
  }

  async execute<TInput extends JsonValue, TOutput extends JsonValue>(
    request: HarnessExecutionRequest<TInput, TOutput>,
  ): Promise<HarnessExecutionResult<TOutput>> {
    let context: ContextDocument | undefined;
    try {
      if (this.registry !== undefined) {
        this.registry.assertCompatible({
          agentType: request.harness.definition.identity.agentType,
          version: request.harness.definition.identity.version,
          requiredContracts: ['AgentInvocation.v1', 'AgentReport.v1'],
        });
      } else if (this.requireRegistry) {
        throw runtimeError('INVOCATION_INVALID_PARENT', 'An active harness registry is required');
      }
      await this.runHook(
        request.harness.definition.hooks.beforeInvocation,
        hookPayload(request.invocation),
      );
      if (
        request.invocation.agentType !== request.harness.definition.identity.agentType ||
        request.invocation.harnessVersion !== request.harness.definition.identity.version ||
        request.invocation.tier !== request.harness.definition.tier
      ) {
        throw runtimeError('INVOCATION_INVALID_PARENT', 'Invocation does not match the harness');
      }
      request.harness.validateInput(request.invocation.input);
      if (request.signal?.aborted)
        throw runtimeError('COMPUTE_RESOURCE_UNAVAILABLE', 'Invocation was cancelled');
      context = this.contextAssembler.assemble({
        ...request.context,
        invocation: request.invocation,
        maxContextBytes: request.harness.definition.contextPolicy.maxContextBytes,
        policy: {
          maxPromptBytes: request.harness.definition.promptPolicy.maxPromptBytes,
          artifactContent: request.harness.definition.contextPolicy.artifactContent,
          includeWorkspacePolicy: request.harness.definition.contextPolicy.includeWorkspacePolicy,
          includeChildReports: request.harness.definition.contextPolicy.includeChildReports,
          allowExternalInstructions:
            request.harness.definition.promptPolicy.allowExternalInstructions,
        },
      });
      await this.runHook(
        request.harness.definition.hooks.afterContextAssembly,
        hookPayload(request.invocation, context),
      );
      await this.runHook(
        request.harness.definition.hooks.beforeModelCall,
        hookPayload(request.invocation, context),
      );
      const modelResult = await request.modelCall(context, request.signal);
      if ((modelResult.toolCalls?.length ?? 0) > request.harness.definition.toolPolicy.maxCalls) {
        throw runtimeError(
          'POLICY_DENIED',
          'Model emitted more tool calls than the harness allows',
        );
      }
      const afterModelPayload = hookPayload(request.invocation, context, {
        ...(isContract('AgentReport', modelResult.report)
          ? { report: modelResult.report }
          : isJsonValue(modelResult.report)
            ? { rawModelOutput: modelResult.report }
            : {}),
      });
      await this.runHook(request.harness.definition.hooks.afterModelCall, afterModelPayload);
      let reportForHooks: AgentReport | undefined;
      try {
        const parsed = parseStructuredReport(modelResult.report);
        if (isContract('AgentReport', parsed)) reportForHooks = parsed;
      } catch {
        // Report parsing remains the validator's responsibility; invalid output gets no artifact hooks.
      }
      const toolResults: Record<string, JsonValue> = {};
      for (const [index, call] of (modelResult.toolCalls ?? []).entries()) {
        if (request.signal?.aborted) {
          throw runtimeError('COMPUTE_RESOURCE_UNAVAILABLE', 'Invocation was cancelled');
        }
        if (
          !request.harness.definition.toolPolicy.allowedOperations.includes(
            `${call.toolName}.${call.operation}`,
          )
        ) {
          throw runtimeError(
            'POLICY_DENIED',
            `Tool operation is not allowed by the harness: ${call.toolName}.${call.operation}`,
          );
        }
        if (!this.toolBroker)
          throw runtimeError('AUTHORITY_MISSING', 'Tool broker is required for tool calls');
        const payload = hookPayload(request.invocation, context, {
          toolName: call.toolName,
          operation: call.operation,
          toolInput: call.input,
        });
        await this.runHook(request.harness.definition.hooks.beforeToolCall, payload);
        const toolResult = await this.toolBroker.execute({
          tenant: request.invocation.tenant,
          invocationId: request.invocation.invocationId,
          grantId: call.grantId,
          authority: request.invocation.authority,
          resources: call.resources,
          input: call.input,
          budgetId: request.invocation.budget.budgetId,
          correlationId: request.invocation.correlationId,
        });
        const resultKey = `${call.toolName}.${call.operation}`;
        toolResults[
          index === 0 || toolResults[resultKey] === undefined
            ? resultKey
            : `${resultKey}#${index + 1}`
        ] = toolResult.output;
        await this.runHook(request.harness.definition.hooks.afterToolCall, {
          ...payload,
          toolOutput: toolResult.output,
        });
      }
      if (modelResult.escalated) {
        await this.runHook(
          request.harness.definition.hooks.onEscalation,
          hookPayload(request.invocation, context),
        );
      }
      for (const artifact of reportForHooks?.artifacts ?? []) {
        await this.runHook(
          request.harness.definition.hooks.onArtifactProduced,
          hookPayload(request.invocation, context, { artifactId: artifact.artifactId }),
        );
      }
      const reportValidator = new ReportValidator<TInput, TOutput>();
      const report = await reportValidator.validate(modelResult.report, {
        harness: request.harness,
        invocation: request.invocation,
        ...(request.artifactVerifier !== undefined
          ? { artifactVerifier: request.artifactVerifier }
          : {}),
        ...(request.costVerifier !== undefined ? { costVerifier: request.costVerifier } : {}),
        ...(request.metricVerifier !== undefined ? { metricVerifier: request.metricVerifier } : {}),
        ...(request.childInvocationVerifier !== undefined
          ? { childInvocationVerifier: request.childInvocationVerifier }
          : {}),
        ...(request.stateAssertionVerifier !== undefined
          ? { stateAssertionVerifier: request.stateAssertionVerifier }
          : {}),
      });
      await this.runHook(
        request.harness.definition.hooks.afterInvocation,
        hookPayload(request.invocation, context, { report }),
      );
      if (request.reportCommitter !== undefined) {
        await request.reportCommitter.commit(report, request.invocation);
      }
      return { report, context, toolResults };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.runHook(
        request.harness.definition.hooks.onFailure,
        hookPayload(request.invocation, context, { error: message }),
      );
      throw error;
    }
  }

  private async runHook(hook: HookRegistration | undefined, payload: HookPayload): Promise<void> {
    if (!hook) return;
    try {
      await hook.run(payload);
    } catch (error) {
      if (
        hook.failureMode === 'best_effort' &&
        hook.kind !== undefined &&
        !hookMustFailClosed(hook.kind)
      )
        return;
      throw runtimeError('POLICY_DENIED', `Critical harness hook failed: ${String(error)}`);
    }
  }
}
