import {
  DurableWorkflowEngine,
  type ActivityHandler,
  type ActivityRequest,
  type StartWorkflowRequest,
  type WorkflowEngineState,
  type WorkflowHandle,
} from '@agentic-platform/runtime-domain';
import type { StateStore } from '@agentic-platform/state';

export class DurableWorker {
  readonly engine: DurableWorkflowEngine;
  private running = false;

  constructor(options: { state: StateStore; clock?: () => string }) {
    this.engine = new DurableWorkflowEngine(options);
  }

  registerActivity(name: string, handler: ActivityHandler): void {
    this.engine.registerActivity(name, handler);
  }

  async startWorkflow(request: StartWorkflowRequest): Promise<WorkflowHandle> {
    this.running = true;
    return this.engine.start(request);
  }

  async schedule(handle: WorkflowHandle, activity: ActivityRequest): Promise<void> {
    if (!this.running) throw new Error('Durable worker is stopped');
    await this.engine.scheduleActivity(handle, activity);
  }

  async recover(handle: WorkflowHandle): Promise<WorkflowEngineState> {
    this.running = true;
    return this.engine.resumeAfterRestart(handle);
  }

  stop(): void {
    this.running = false;
  }
}
