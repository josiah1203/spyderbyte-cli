import type { JsonValue, RuntimeEvent } from '@agentic-platform/runtime-contracts';
import type { ProjectionDefinition } from './engine.js';

type JsonRecord = { [key: string]: JsonValue };

function payloadRecord(event: RuntimeEvent): JsonRecord {
  const payload = event.payload;
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
}

function stringField(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(record: JsonRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}

function stateField(record: JsonRecord): string | undefined {
  return stringField(record, 'state') ?? stringField(record, 'to');
}

function arrayField(record: JsonRecord, key: string): JsonValue[] | undefined {
  const value = record[key];
  return Array.isArray(value) ? value : undefined;
}

function objectField(value: JsonValue | undefined): JsonRecord | undefined {
  return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : undefined;
}

function actorIdFrom(value: JsonValue | undefined): string | undefined {
  return stringField(objectField(value) ?? {}, 'actorId');
}

export interface WorkflowView {
  workflowId: string;
  state: string;
  version: number;
  objective?: string;
  projectId?: string;
  displayName?: string;
  trigger?: string;
  lastEventAt: string;
}

export interface WorkflowProjectionState {
  workflows: Record<string, WorkflowView>;
}

export const workflowProjection: ProjectionDefinition<WorkflowProjectionState> = {
  name: 'workflow-summary',
  initialState: () => ({ workflows: {} }),
  apply: (state, event) => {
    if (!event.eventName.startsWith('workflow.')) return state;
    const payload = payloadRecord(event);
    const workflowId = event.aggregateId;
    const existing = state.workflows[workflowId];
    const objective = stringField(payload, 'objective');
    const projectId = stringField(payload, 'projectId');
    const displayName = stringField(payload, 'displayName');
    const trigger = stringField(payload, 'trigger');
    const view: WorkflowView = {
      ...existing,
      workflowId,
      state: stateField(payload) ?? existing?.state ?? 'unknown',
      version: Math.max(existing?.version ?? 0, event.aggregateVersion),
      lastEventAt: event.occurredAt,
      ...(objective !== undefined ? { objective } : {}),
      ...(projectId !== undefined ? { projectId } : {}),
      ...(displayName !== undefined ? { displayName } : {}),
      ...(trigger !== undefined ? { trigger } : {}),
    };
    return { workflows: { ...state.workflows, [workflowId]: view } };
  },
};

export interface InvocationView {
  invocationId: string;
  state: string;
  version: number;
  attempt?: number;
  agentType?: string;
  lastEventAt: string;
}

export interface InvocationProjectionState {
  jobs: Record<string, InvocationView>;
}

export const invocationProjection: ProjectionDefinition<InvocationProjectionState> = {
  name: 'invocation-jobs',
  initialState: () => ({ jobs: {} }),
  apply: (state, event) => {
    if (!event.eventName.startsWith('invocation.') && !event.eventName.startsWith('job.')) {
      return state;
    }
    const payload = payloadRecord(event);
    const invocationId = event.aggregateId;
    const existing = state.jobs[invocationId];
    const attempt = numberField(payload, 'attempt');
    const agentType = stringField(payload, 'agentType');
    const view: InvocationView = {
      ...existing,
      invocationId,
      state: stateField(payload) ?? existing?.state ?? 'unknown',
      version: Math.max(existing?.version ?? 0, event.aggregateVersion),
      lastEventAt: event.occurredAt,
      ...(attempt !== undefined ? { attempt } : {}),
      ...(agentType !== undefined ? { agentType } : {}),
    };
    return { jobs: { ...state.jobs, [invocationId]: view } };
  },
};

export interface ArtifactVersionView {
  version: number;
  state: string;
  lineage: JsonValue[];
  contentHash?: string;
  lastEventAt: string;
}

export interface ArtifactView {
  artifactId: string;
  currentVersion: number;
  state: string;
  lineage: JsonValue[];
  versions: Record<string, ArtifactVersionView>;
  lastEventAt: string;
}

export interface ArtifactProjectionState {
  artifacts: Record<string, ArtifactView>;
}

function markArtifactStale(
  state: ArtifactProjectionState,
  artifactId: string,
  version: number,
  occurredAt: string,
): ArtifactProjectionState {
  const existing = state.artifacts[artifactId];
  const existingVersion = existing?.versions[String(version)];
  const staleVersion: ArtifactVersionView = {
    ...existingVersion,
    version,
    state: 'stale',
    lineage: existingVersion?.lineage ?? [],
    lastEventAt: occurredAt,
  };
  const artifact: ArtifactView = {
    ...existing,
    artifactId,
    currentVersion: existing?.currentVersion ?? version,
    state: existing?.currentVersion === version ? 'stale' : (existing?.state ?? 'stale'),
    lineage: existing?.lineage ?? [],
    versions: {
      ...existing?.versions,
      [String(version)]: staleVersion,
    },
    lastEventAt: occurredAt,
  };
  return { artifacts: { ...state.artifacts, [artifactId]: artifact } };
}

export const artifactProjection: ProjectionDefinition<ArtifactProjectionState> = {
  name: 'artifact-catalog-lineage',
  initialState: () => ({ artifacts: {} }),
  apply: (state, event) => {
    if (event.eventName === 'artifact.descendants-marked-stale.v1') {
      const payload = payloadRecord(event);
      const descendants = arrayField(payload, 'descendants') ?? [];
      return descendants.reduce((nextState, descendant) => {
        const reference = objectField(descendant);
        const artifactId = stringField(reference ?? {}, 'artifactId');
        const version = numberField(reference ?? {}, 'version');
        return artifactId !== undefined && version !== undefined
          ? markArtifactStale(nextState, artifactId, version, event.occurredAt)
          : nextState;
      }, state);
    }
    if (event.eventName !== 'artifact.published.v1') return state;

    const payload = payloadRecord(event);
    const artifactId = event.aggregateId;
    const existing = state.artifacts[artifactId];
    const version = numberField(payload, 'version') ?? event.aggregateVersion;
    const lineage = arrayField(payload, 'lineage') ?? [];
    const contentHash = stringField(payload, 'contentHash');
    const versionView: ArtifactVersionView = {
      version,
      state: 'valid',
      lineage,
      lastEventAt: event.occurredAt,
      ...(contentHash !== undefined ? { contentHash } : {}),
    };
    const artifact: ArtifactView = {
      ...existing,
      artifactId,
      currentVersion: Math.max(existing?.currentVersion ?? 0, version),
      state: 'valid',
      lineage,
      versions: {
        ...existing?.versions,
        [String(version)]: versionView,
      },
      lastEventAt: event.occurredAt,
    };
    return { artifacts: { ...state.artifacts, [artifactId]: artifact } };
  },
};

export interface ApprovalView {
  approvalId: string;
  state: string;
  requestedBy?: string;
  lastEventAt: string;
}

export interface ApprovalProjectionState {
  queue: Record<string, ApprovalView>;
}

export const approvalProjection: ProjectionDefinition<ApprovalProjectionState> = {
  name: 'approval-queue',
  initialState: () => ({ queue: {} }),
  apply: (state, event) => {
    if (!event.eventName.startsWith('approval.')) return state;
    const payload = payloadRecord(event);
    const approvalId = stringField(payload, 'approvalId') ?? event.aggregateId;
    const requestedBy = actorIdFrom(payload['requestedBy']);
    const existing = state.queue[approvalId];
    const view: ApprovalView = {
      ...existing,
      approvalId,
      state: stringField(payload, 'state') ?? existing?.state ?? 'unknown',
      lastEventAt: event.occurredAt,
      ...(requestedBy !== undefined ? { requestedBy } : {}),
    };
    return { queue: { ...state.queue, [approvalId]: view } };
  },
};

export interface BudgetReservationView {
  reservationId: string;
  state: string;
  amountMinor: number;
  currency: string;
  lastEventAt: string;
}

export interface BudgetCostObservation {
  eventId: string;
  amountMinor: number;
  currency: string;
  source: string;
  occurredAt: string;
}

export interface BudgetCostProjectionState {
  totalsByCurrency: Record<string, number>;
  reservations: Record<string, BudgetReservationView>;
  observations: BudgetCostObservation[];
}

function amountFromPayload(payload: JsonRecord): { amountMinor: number; currency: string } {
  const nestedAmount = objectField(payload['amount']);
  return {
    amountMinor:
      numberField(payload, 'amountMinor') ?? numberField(nestedAmount ?? {}, 'amountMinor') ?? 0,
    currency:
      stringField(payload, 'currency') ?? stringField(nestedAmount ?? {}, 'currency') ?? 'UNKNOWN',
  };
}

export const budgetCostProjection: ProjectionDefinition<BudgetCostProjectionState> = {
  name: 'budget-cost',
  initialState: () => ({ totalsByCurrency: {}, reservations: {}, observations: [] }),
  apply: (state, event) => {
    if (
      !event.eventName.startsWith('budget.') &&
      !event.eventName.startsWith('usage.') &&
      !event.eventName.startsWith('cost.')
    ) {
      return state;
    }

    const payload = payloadRecord(event);
    const amount = amountFromPayload(payload);
    const reservationId = stringField(payload, 'reservationId') ?? event.aggregateId;
    const reservationState = stringField(payload, 'state');
    const reservation =
      reservationState !== undefined
        ? {
            reservationId,
            state: reservationState,
            amountMinor: amount.amountMinor,
            currency: amount.currency,
            lastEventAt: event.occurredAt,
          }
        : undefined;
    const isObservation =
      event.eventName.startsWith('usage.') ||
      event.eventName.startsWith('cost.') ||
      event.eventName.includes('.cost.');
    const observations = isObservation
      ? [
          ...state.observations,
          {
            eventId: event.eventId,
            amountMinor: amount.amountMinor,
            currency: amount.currency,
            source: stringField(payload, 'source') ?? event.eventName,
            occurredAt: event.occurredAt,
          },
        ]
      : state.observations;
    const totalsByCurrency = isObservation
      ? {
          ...state.totalsByCurrency,
          [amount.currency]: (state.totalsByCurrency[amount.currency] ?? 0) + amount.amountMinor,
        }
      : state.totalsByCurrency;
    return {
      totalsByCurrency,
      reservations:
        reservation === undefined
          ? state.reservations
          : { ...state.reservations, [reservationId]: reservation },
      observations,
    };
  },
};

export interface AuditEntry {
  eventId: string;
  eventName: string;
  aggregateType: string;
  aggregateId: string;
  actorId: string;
  occurredAt: string;
  payload: JsonValue;
}

export interface AuditProjectionState {
  entries: AuditEntry[];
}

export const auditProjection: ProjectionDefinition<AuditProjectionState> = {
  name: 'audit-timeline',
  initialState: () => ({ entries: [] }),
  apply: (state, event) => ({
    entries: [
      ...state.entries,
      {
        eventId: event.eventId,
        eventName: event.eventName,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        actorId: event.actor.actorId,
        occurredAt: event.occurredAt,
        payload: event.payload,
      },
    ],
  }),
};

export interface CatalogProjectionState {
  datasets: Record<string, JsonValue>;
}

export interface ModelProjectionState {
  models: Record<string, JsonValue>;
}

export interface DeploymentProjectionState {
  deployments: Record<string, JsonValue>;
}

export interface ConnectorProjectionState {
  connectors: Record<string, JsonValue>;
}

export interface ChatProjectionState {
  sessions: Record<string, JsonValue>;
}

function genericLifecycleView(existing: JsonRecord | undefined, event: RuntimeEvent): JsonRecord {
  const payload = payloadRecord(event);
  return {
    ...(existing ?? {}),
    ...payload,
    entityId: event.aggregateId,
    state: stateField(payload) ?? stringField(existing ?? {}, 'state') ?? 'unknown',
    version: Math.max(numberField(existing ?? {}, 'version') ?? 0, event.aggregateVersion),
    lastEventAt: event.occurredAt,
  };
}

function lifecycleProjection<
  K extends string,
  TState extends Record<K, Record<string, JsonValue>>,
>(options: {
  name: string;
  collection: K;
  eventPrefixes: readonly string[];
}): ProjectionDefinition<TState> {
  return {
    name: options.name,
    initialState: () => ({ [options.collection]: {} }) as TState,
    apply: (state, event) => {
      if (!options.eventPrefixes.some((prefix) => event.eventName.startsWith(prefix))) {
        return state;
      }
      const collection = state[options.collection];
      return {
        ...state,
        [options.collection]: {
          ...collection,
          [event.aggregateId]: genericLifecycleView(
            objectField(collection[event.aggregateId]),
            event,
          ),
        },
      } as TState;
    },
  };
}

export const catalogProjection = lifecycleProjection<'datasets', CatalogProjectionState>({
  name: 'catalog-datasets',
  collection: 'datasets',
  eventPrefixes: ['dataset.', 'catalog.'],
});

export const modelProjection = lifecycleProjection<'models', ModelProjectionState>({
  name: 'model-lifecycle',
  collection: 'models',
  eventPrefixes: ['model.'],
});

export const deploymentProjection = lifecycleProjection<'deployments', DeploymentProjectionState>({
  name: 'deployment-traffic',
  collection: 'deployments',
  eventPrefixes: ['deployment.'],
});

export const connectorProjection = lifecycleProjection<'connectors', ConnectorProjectionState>({
  name: 'connector-governance',
  collection: 'connectors',
  eventPrefixes: ['connector.', 'governance.'],
});

export const chatProjection = lifecycleProjection<'sessions', ChatProjectionState>({
  name: 'chat-sessions',
  collection: 'sessions',
  eventPrefixes: ['chat.', 'session.'],
});

export const builtinProjections = [
  workflowProjection,
  invocationProjection,
  artifactProjection,
  approvalProjection,
  budgetCostProjection,
  auditProjection,
  catalogProjection,
  modelProjection,
  deploymentProjection,
  connectorProjection,
  chatProjection,
] as const;
