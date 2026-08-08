import type { JsonValue, RuntimeEvent } from '@agentic-platform/runtime-contracts';
import type { ProjectionDefinition } from './engine.js';

type JsonRecord = { [key: string]: JsonValue };

function payloadRecord(event: RuntimeEvent): JsonRecord {
  return event.payload !== null &&
    typeof event.payload === 'object' &&
    !Array.isArray(event.payload)
    ? event.payload
    : {};
}

function stringField(record: JsonRecord, key: string): string | undefined {
  return typeof record[key] === 'string' ? (record[key] as string) : undefined;
}

function numberField(record: JsonRecord, key: string): number | undefined {
  return typeof record[key] === 'number' ? (record[key] as number) : undefined;
}

export interface ProductProjectView {
  projectId: string;
  name: string;
  objective?: string;
  status: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  lastEventAt: string;
}

export interface ProductProjectsState {
  projects: Record<string, ProductProjectView>;
}

export const projectsProjection: ProjectionDefinition<ProductProjectsState> = {
  name: 'projects',
  initialState: () => ({ projects: {} }),
  apply: (state, event) => {
    if (!event.eventName.startsWith('project.')) return state;
    const payload = payloadRecord(event);
    const existing = state.projects[event.aggregateId];
    const objective = stringField(payload, 'objective') ?? existing?.objective;
    const view: ProductProjectView = {
      projectId: event.aggregateId,
      name: stringField(payload, 'name') ?? existing?.name ?? 'Untitled project',
      ...(objective === undefined ? {} : { objective }),
      status: stringField(payload, 'status') ?? existing?.status ?? 'active',
      version: event.aggregateVersion,
      createdAt: existing?.createdAt ?? event.occurredAt,
      updatedAt: event.occurredAt,
      lastEventAt: event.occurredAt,
    };
    return { projects: { ...state.projects, [event.aggregateId]: view } };
  },
};

export interface ProductRunView {
  runId: string;
  workflowId: string;
  projectId?: string;
  name?: string;
  objective?: string;
  status: string;
  version: number;
  startedAt?: string;
  updatedAt: string;
  progress?: number;
  trigger?: string;
}

export interface ProductRunsState {
  runs: Record<string, ProductRunView>;
}

function runState(payload: JsonRecord, existing?: ProductRunView): string {
  return (
    stringField(payload, 'to') ?? stringField(payload, 'state') ?? existing?.status ?? 'unknown'
  );
}

export const runsProjection: ProjectionDefinition<ProductRunsState> = {
  name: 'runs',
  initialState: () => ({ runs: {} }),
  apply: (state, event) => {
    if (!event.eventName.startsWith('workflow.') && !event.eventName.startsWith('run.'))
      return state;
    const payload = payloadRecord(event);
    const existing = state.runs[event.aggregateId];
    const progress = numberField(payload, 'progress');
    const projectId = stringField(payload, 'projectId') ?? existing?.projectId;
    const name = stringField(payload, 'displayName') ?? existing?.name;
    const objective = stringField(payload, 'objective') ?? existing?.objective;
    const startedAt =
      existing?.startedAt ??
      (event.eventName === 'workflow.state-changed.v1' ? event.occurredAt : undefined);
    const trigger = stringField(payload, 'trigger') ?? existing?.trigger;
    const view: ProductRunView = {
      runId: event.aggregateId,
      workflowId: event.aggregateId,
      ...(projectId === undefined ? {} : { projectId }),
      ...(name === undefined ? {} : { name }),
      ...(objective === undefined ? {} : { objective }),
      status: runState(payload, existing),
      version: Math.max(existing?.version ?? 0, event.aggregateVersion),
      ...(startedAt === undefined ? {} : { startedAt }),
      updatedAt: event.occurredAt,
      ...(progress === undefined ? {} : { progress }),
      ...(trigger === undefined ? {} : { trigger }),
    };
    return { runs: { ...state.runs, [event.aggregateId]: view } };
  },
};

export interface RunTimelineState {
  events: Record<string, JsonValue>;
}

export const runTimelineProjection: ProjectionDefinition<RunTimelineState> = {
  name: 'run-timeline',
  initialState: () => ({ events: {} }),
  apply: (state, event) => {
    const relevant =
      event.aggregateType === 'workflow' ||
      event.aggregateType === 'invocation' ||
      event.eventName.startsWith('run.') ||
      event.eventName.startsWith('approval.') ||
      event.eventName.startsWith('artifact.');
    if (!relevant) return state;
    return {
      events: {
        ...state.events,
        [event.eventId]: {
          eventId: event.eventId,
          eventName: event.eventName,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          aggregateVersion: event.aggregateVersion,
          occurredAt: event.occurredAt,
          correlationId: event.correlationId,
          payload: event.payload,
        },
      },
    };
  },
};

export interface RunMetricsState {
  observations: Record<string, JsonValue>;
}

export const runMetricsProjection: ProjectionDefinition<RunMetricsState> = {
  name: 'run-metrics',
  initialState: () => ({ observations: {} }),
  apply: (state, event) => {
    if (!event.eventName.startsWith('run.metric.') && !event.eventName.startsWith('metric.'))
      return state;
    return {
      observations: {
        ...state.observations,
        [event.eventId]: {
          ...payloadRecord(event),
          eventId: event.eventId,
          runId: event.aggregateId,
          occurredAt: event.occurredAt,
        },
      },
    };
  },
};

export interface RunLogsState {
  lines: Record<string, JsonValue>;
}

export const runLogsProjection: ProjectionDefinition<RunLogsState> = {
  name: 'run-logs',
  initialState: () => ({ lines: {} }),
  apply: (state, event) => {
    if (!event.eventName.startsWith('run.log.') && !event.eventName.startsWith('log.'))
      return state;
    return {
      lines: {
        ...state.lines,
        [event.eventId]: {
          ...payloadRecord(event),
          eventId: event.eventId,
          runId: event.aggregateId,
          occurredAt: event.occurredAt,
        },
      },
    };
  },
};

export interface MachineState {
  observations: Record<string, JsonValue>;
}

export const machineProjection: ProjectionDefinition<MachineState> = {
  name: 'machine-state',
  initialState: () => ({ observations: {} }),
  apply: (state, event) => {
    if (!event.eventName.startsWith('machine.')) return state;
    return {
      observations: {
        ...state.observations,
        latest: { ...payloadRecord(event), occurredAt: event.occurredAt },
      },
    };
  },
};

export interface ResourceProjectionState {
  items: Record<string, JsonValue>;
}

/**
 * Generic event-backed resource projection used by the local-first parity pages.
 * The resource command service emits `<resource>.*` events, so this projection
 * keeps the frontend useful without inventing a second persistence model for
 * every page-specific resource before its hosted implementation is available.
 */
export function resourceProjection(
  name: string,
  resourceType: string,
): ProjectionDefinition<ResourceProjectionState> {
  const prefix = `${resourceType}.`;
  return {
    name,
    initialState: () => ({ items: {} }),
    apply: (state, event) => {
      if (!event.eventName.startsWith(prefix)) return state;
      const payload = payloadRecord(event);
      const previous = state.items[event.aggregateId];
      const previousRecord =
        previous !== null && typeof previous === 'object' && !Array.isArray(previous)
          ? (previous as JsonRecord)
          : {};
      const next: JsonRecord = {
        ...previousRecord,
        ...payload,
        id: event.aggregateId,
        [`${resourceType}Id`]: event.aggregateId,
        state: stringField(payload, 'state') ?? stringField(previousRecord, 'state') ?? 'active',
        status: stringField(payload, 'status') ?? stringField(previousRecord, 'status') ?? 'active',
        version: Math.max(numberField(previousRecord, 'version') ?? 0, event.aggregateVersion),
        createdAt: stringField(previousRecord, 'createdAt') ?? event.occurredAt,
        updatedAt: event.occurredAt,
        lastEventAt: event.occurredAt,
      };
      return { items: { ...state.items, [event.aggregateId]: next } };
    },
  };
}

export const resourceProjectionDefinitions: Readonly<
  Record<string, ProjectionDefinition<ResourceProjectionState>>
> = Object.fromEntries(
  (
    [
      ['datasets', 'dataset'],
      ['queries', 'query'],
      ['visualizations', 'visualization'],
      ['automations', 'automation'],
      ['connections', 'connection'],
      ['environments', 'environment'],
      ['settings', 'setting'],
      ['profiles', 'profile'],
      ['notifications', 'notification'],
      ['governance', 'policy'],
      ['repositories', 'repository'],
      ['worktrees', 'worktree'],
      ['notebooks', 'notebook'],
      ['experiments', 'experiment'],
      ['incidents', 'incident'],
      ['pipelines', 'pipeline'],
      ['resources', 'resource'],
      ['assets', 'asset'],
    ] as const
  ).map(([name, resourceType]) => [name, resourceProjection(name, resourceType)]),
) as Readonly<Record<string, ProjectionDefinition<ResourceProjectionState>>>;
