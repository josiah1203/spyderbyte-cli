import type {
  AgentInvocation,
  AgentReport,
  Id,
  JsonValue,
  RuntimeEvent,
} from '@agentic-platform/runtime-contracts';

export type HookFailureMode = 'fail_closed' | 'best_effort';

/** Hook classes whose failure can change authorization, accounting, or durable state. */
export type HookKind =
  | 'authority'
  | 'policy'
  | 'approval'
  | 'redaction'
  | 'audit'
  | 'budget'
  | 'telemetry'
  | 'lifecycle';

export function hookMustFailClosed(kind: HookKind | undefined): boolean {
  return (
    kind === 'authority' ||
    kind === 'policy' ||
    kind === 'approval' ||
    kind === 'redaction' ||
    kind === 'audit' ||
    kind === 'budget'
  );
}

export interface HookPayload {
  invocation: AgentInvocation;
  context?: JsonValue;
  event?: RuntimeEvent;
  toolName?: string;
  operation?: string;
  toolInput?: JsonValue;
  toolOutput?: JsonValue;
  report?: AgentReport;
  rawModelOutput?: JsonValue;
  artifactId?: Id;
  error?: string;
}

export interface HookRegistration {
  readonly kind?: HookKind;
  failureMode: HookFailureMode;
  run(payload: HookPayload): void | Promise<void>;
}

export interface HarnessHooks {
  beforeInvocation?: HookRegistration;
  afterContextAssembly?: HookRegistration;
  beforeModelCall?: HookRegistration;
  afterModelCall?: HookRegistration;
  beforeToolCall?: HookRegistration;
  afterToolCall?: HookRegistration;
  onArtifactProduced?: HookRegistration;
  onEscalation?: HookRegistration;
  onFailure?: HookRegistration;
  afterInvocation?: HookRegistration;
}
