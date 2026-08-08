import type { TenantRef } from '@agentic-platform/runtime-contracts';
import {
  approvalProjection,
  artifactProjection,
  auditProjection,
  budgetCostProjection,
  catalogProjection,
  chatProjection,
  connectorProjection,
  deploymentProjection,
  invocationProjection,
  modelProjection,
  workflowProjection,
} from './builtins.js';
import {
  machineProjection,
  projectsProjection,
  runLogsProjection,
  runMetricsProjection,
  runTimelineProjection,
  runsProjection,
} from './products.js';
import { resourceProjectionDefinitions } from './products.js';
import { ProjectionEngine } from './engine.js';

export type BuiltinProjectionName =
  | 'workflow-summary'
  | 'invocation-jobs'
  | 'artifact-catalog-lineage'
  | 'approval-queue'
  | 'budget-cost'
  | 'audit-timeline'
  | 'catalog-datasets'
  | 'model-lifecycle'
  | 'deployment-traffic'
  | 'connector-governance'
  | 'chat-sessions';

export type ProductProjectionName =
  | 'projects'
  | 'runs'
  | 'run-timeline'
  | 'run-metrics'
  | 'run-logs'
  | 'machine-state';

export interface ProjectionReader {
  read(tenant: TenantRef, projectionName: string): Promise<unknown>;
}

/** Tenant-bound reader used by local and hosted API composition roots. */
export class BuiltinProjectionReader implements ProjectionReader {
  constructor(private readonly engine: ProjectionEngine) {}

  read(tenant: TenantRef, projectionName: string): Promise<unknown> {
    switch (projectionName) {
      case 'workflow-summary':
        return this.engine.project(tenant, workflowProjection);
      case 'invocation-jobs':
        return this.engine.project(tenant, invocationProjection);
      case 'artifact-catalog-lineage':
        return this.engine.project(tenant, artifactProjection);
      case 'approval-queue':
        return this.engine.project(tenant, approvalProjection);
      case 'budget-cost':
        return this.engine.project(tenant, budgetCostProjection);
      case 'audit-timeline':
        return this.engine.project(tenant, auditProjection);
      case 'catalog-datasets':
        return this.engine.project(tenant, catalogProjection);
      case 'model-lifecycle':
        return this.engine.project(tenant, modelProjection);
      case 'deployment-traffic':
        return this.engine.project(tenant, deploymentProjection);
      case 'connector-governance':
        return this.engine.project(tenant, connectorProjection);
      case 'chat-sessions':
        return this.engine.project(tenant, chatProjection);
      case 'projects':
        return this.engine.project(tenant, projectsProjection);
      case 'runs':
        return this.engine.project(tenant, runsProjection);
      case 'run-timeline':
        return this.engine.project(tenant, runTimelineProjection);
      case 'run-metrics':
        return this.engine.project(tenant, runMetricsProjection);
      case 'run-logs':
        return this.engine.project(tenant, runLogsProjection);
      case 'machine-state':
        return this.engine.project(tenant, machineProjection);
      default: {
        const resource = resourceProjectionDefinitions[projectionName];
        return resource === undefined
          ? Promise.reject(new Error(`Unknown projection: ${projectionName}`))
          : this.engine.project(tenant, resource);
      }
    }
  }
}
