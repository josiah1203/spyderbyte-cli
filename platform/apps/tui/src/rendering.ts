import type { RuntimeEvent, Run, RunAttempt } from '@agentic-platform/runtime-contracts';
import type { RunLog } from '@agentic-platform/client-sdk';

export interface ShellRunRecord {
  readonly run: Run;
  readonly attempts: readonly RunAttempt[];
  readonly logs: readonly RunLog[];
}

export function renderSpyderbyteRecord(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? 'null';
}

export function renderSpyderbyteEvent(event: RuntimeEvent): string {
  return renderSpyderbyteRecord(event);
}

export function renderSpyderbyteRun(record: ShellRunRecord): string {
  return renderSpyderbyteRecord(record);
}
