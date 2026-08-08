import {
  isId,
  newSortableId,
  runtimeError,
  type Id,
  type JsonValue,
  type Project,
  type RuntimeCommand,
  type RuntimeEvent,
} from '@agentic-platform/runtime-contracts';
import { CommandDispatcher } from '@agentic-platform/runtime-domain';
import type { StateStore, StateTransaction } from '@agentic-platform/state';

export interface ProductCommandService {
  supports(commandType: string): boolean;
  execute(command: RuntimeCommand): Promise<JsonValue>;
}

type JsonRecord = { [key: string]: JsonValue };

function payloadRecord(command: RuntimeCommand): JsonRecord {
  if (
    command.payload === null ||
    typeof command.payload !== 'object' ||
    Array.isArray(command.payload)
  ) {
    throw runtimeError(
      'VALIDATION_SCHEMA_MISMATCH',
      `${command.commandType} payload must be an object`,
    );
  }
  return command.payload;
}

function requiredString(payload: JsonRecord, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${key} is required`);
  }
  return value.trim();
}

function optionalString(payload: JsonRecord, key: string): string | undefined {
  const value = payload[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw runtimeError('VALIDATION_INVALID_INPUT', `${key} must be a non-empty string`);
  }
  return value.trim();
}

function optionalRevision(payload: JsonRecord): number | undefined {
  const value = payload['expectedRevision'];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw runtimeError(
      'VALIDATION_SCHEMA_MISMATCH',
      'expectedRevision must be a non-negative integer',
    );
  }
  return value;
}

function productEvent(
  command: RuntimeCommand,
  aggregateId: Id,
  aggregateVersion: number,
  eventName: string,
  payload: JsonRecord,
): RuntimeEvent {
  return {
    schemaVersion: 1,
    eventId: newSortableId(),
    eventName,
    tenant: command.tenant,
    aggregateType: 'project',
    aggregateId,
    aggregateVersion,
    occurredAt: command.issuedAt,
    actor: command.actor,
    correlationId: command.correlationId,
    ...(command.causationId === undefined ? {} : { causationId: command.causationId }),
    payload,
  };
}

type GenericResourceOperation = 'create' | 'update' | 'archive';

interface GenericResourceCommandDefinition {
  readonly resourceType: string;
  readonly operation: GenericResourceOperation;
  readonly terminalState?: string;
}

const GENERIC_RESOURCE_COMMANDS: Readonly<Record<string, GenericResourceCommandDefinition>> = {
  CreateDataset: { resourceType: 'dataset', operation: 'create' },
  UpdateDataset: { resourceType: 'dataset', operation: 'update' },
  ArchiveDataset: { resourceType: 'dataset', operation: 'archive', terminalState: 'archived' },
  CreateQuery: { resourceType: 'query', operation: 'create' },
  UpdateQuery: { resourceType: 'query', operation: 'update' },
  ArchiveQuery: { resourceType: 'query', operation: 'archive', terminalState: 'archived' },
  RunQuery: { resourceType: 'query', operation: 'archive', terminalState: 'completed' },
  CancelQuery: { resourceType: 'query', operation: 'archive', terminalState: 'cancelled' },
  CreateVisualization: { resourceType: 'visualization', operation: 'create' },
  UpdateVisualization: { resourceType: 'visualization', operation: 'update' },
  ArchiveVisualization: {
    resourceType: 'visualization',
    operation: 'archive',
    terminalState: 'archived',
  },
  RefreshVisualization: {
    resourceType: 'visualization',
    operation: 'archive',
    terminalState: 'refreshing',
  },
  CreateAutomation: { resourceType: 'automation', operation: 'create' },
  UpdateAutomation: { resourceType: 'automation', operation: 'update' },
  PauseAutomation: { resourceType: 'automation', operation: 'archive', terminalState: 'paused' },
  ResumeAutomation: { resourceType: 'automation', operation: 'archive', terminalState: 'active' },
  CreateNotebook: { resourceType: 'notebook', operation: 'create' },
  UpdateNotebook: { resourceType: 'notebook', operation: 'update' },
  ArchiveNotebook: { resourceType: 'notebook', operation: 'archive', terminalState: 'archived' },
  RunNotebook: { resourceType: 'notebook', operation: 'archive', terminalState: 'completed' },
  CreateRepository: { resourceType: 'repository', operation: 'create' },
  UpdateRepository: { resourceType: 'repository', operation: 'update' },
  ArchiveRepository: {
    resourceType: 'repository',
    operation: 'archive',
    terminalState: 'archived',
  },
  SyncRepository: { resourceType: 'repository', operation: 'archive', terminalState: 'syncing' },
  CreateWorktree: { resourceType: 'worktree', operation: 'create' },
  UpdateWorktree: { resourceType: 'worktree', operation: 'update' },
  DeleteWorktree: { resourceType: 'worktree', operation: 'archive', terminalState: 'deleted' },
  CreateExperiment: { resourceType: 'experiment', operation: 'create' },
  UpdateExperiment: { resourceType: 'experiment', operation: 'update' },
  ArchiveExperiment: {
    resourceType: 'experiment',
    operation: 'archive',
    terminalState: 'archived',
  },
  CreateDeployment: { resourceType: 'deployment', operation: 'create' },
  UpdateDeployment: { resourceType: 'deployment', operation: 'update' },
  PromoteDeployment: { resourceType: 'deployment', operation: 'archive', terminalState: 'active' },
  RollbackDeployment: {
    resourceType: 'deployment',
    operation: 'archive',
    terminalState: 'rolled_back',
  },
  CreatePipeline: { resourceType: 'pipeline', operation: 'create' },
  UpdatePipeline: { resourceType: 'pipeline', operation: 'update' },
  RunPipeline: { resourceType: 'pipeline', operation: 'archive', terminalState: 'running' },
  CancelPipeline: { resourceType: 'pipeline', operation: 'archive', terminalState: 'cancelled' },
  CreateEnvironment: { resourceType: 'environment', operation: 'create' },
  UpdateEnvironment: { resourceType: 'environment', operation: 'update' },
  DeleteEnvironment: {
    resourceType: 'environment',
    operation: 'archive',
    terminalState: 'deleted',
  },
  CreateResource: { resourceType: 'resource', operation: 'create' },
  UpdateResource: { resourceType: 'resource', operation: 'update' },
  ReleaseResource: { resourceType: 'resource', operation: 'archive', terminalState: 'released' },
  CreateIncident: { resourceType: 'incident', operation: 'create' },
  UpdateIncident: { resourceType: 'incident', operation: 'update' },
  AcknowledgeIncident: {
    resourceType: 'incident',
    operation: 'archive',
    terminalState: 'acknowledged',
  },
  ResolveIncident: { resourceType: 'incident', operation: 'archive', terminalState: 'resolved' },
  CreateGovernancePolicy: { resourceType: 'policy', operation: 'create' },
  UpdateGovernancePolicy: { resourceType: 'policy', operation: 'update' },
  ArchiveGovernancePolicy: {
    resourceType: 'policy',
    operation: 'archive',
    terminalState: 'archived',
  },
};

function resourceEvent(
  command: RuntimeCommand,
  resourceType: string,
  resourceId: Id,
  aggregateVersion: number,
  action: GenericResourceOperation,
  payload: JsonRecord,
): RuntimeEvent {
  const eventAction =
    action === 'create' ? 'created' : action === 'update' ? 'updated' : 'state-changed';
  return {
    schemaVersion: 1,
    eventId: newSortableId(),
    eventName: `${resourceType}.${eventAction}.v1`,
    tenant: command.tenant,
    aggregateType: 'resource',
    aggregateId: resourceId,
    aggregateVersion,
    occurredAt: command.issuedAt,
    actor: command.actor,
    correlationId: command.correlationId,
    ...(command.causationId === undefined ? {} : { causationId: command.causationId }),
    payload,
  };
}

async function resourceVersion(
  transaction: StateTransaction,
  command: RuntimeCommand,
  definition: GenericResourceCommandDefinition,
  resourceId: Id,
): Promise<number> {
  const events = await transaction.events.list(command.tenant);
  return Math.max(
    0,
    ...events
      .filter(
        (stored) =>
          stored.event.aggregateId === resourceId &&
          stored.event.eventName.startsWith(`${definition.resourceType}.`),
      )
      .map((stored) => stored.event.aggregateVersion),
  );
}

function withoutRevision(payload: JsonRecord): JsonRecord {
  const clean: JsonRecord = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key !== 'expectedRevision') clean[key] = value;
  }
  return clean;
}

export class LocalProductCommandService implements ProductCommandService {
  private readonly dispatcher: CommandDispatcher;
  private readonly genericCommands = new Set(Object.keys(GENERIC_RESOURCE_COMMANDS));

  constructor(private readonly state: StateStore) {
    this.dispatcher = new CommandDispatcher(state);
    this.dispatcher.register({
      commandType: 'CreateProject',
      handle: ({ command, transaction }) => this.createProject(command, transaction),
    });
    this.dispatcher.register({
      commandType: 'UpdateProject',
      handle: ({ command, transaction }) => this.updateProject(command, transaction),
    });
    this.dispatcher.register({
      commandType: 'ArchiveProject',
      handle: ({ command, transaction }) =>
        this.changeProjectState(command, transaction, 'archived'),
    });
    this.dispatcher.register({
      commandType: 'RestoreProject',
      handle: ({ command, transaction }) => this.changeProjectState(command, transaction, 'active'),
    });
    for (const [commandType, definition] of Object.entries(GENERIC_RESOURCE_COMMANDS)) {
      this.dispatcher.register({
        commandType,
        handle: ({ command, transaction }) =>
          this.handleGenericResource(command, transaction, definition),
      });
    }
  }

  supports(commandType: string): boolean {
    return (
      ['CreateProject', 'UpdateProject', 'ArchiveProject', 'RestoreProject'].includes(
        commandType,
      ) || this.genericCommands.has(commandType)
    );
  }

  async execute(command: RuntimeCommand): Promise<JsonValue> {
    return (await this.dispatcher.dispatch(command)).result;
  }

  private async createProject(command: RuntimeCommand, transaction: StateTransaction) {
    const payload = payloadRecord(command);
    const projectId = (optionalString(payload, 'projectId') as Id | undefined) ?? newSortableId();
    if (!isId(projectId))
      throw runtimeError('VALIDATION_INVALID_INPUT', 'projectId must be a UUIDv7 id');
    const name = requiredString(payload, 'name');
    const objective = optionalString(payload, 'objective');
    const description = optionalString(payload, 'description');
    const project: Project = {
      schemaVersion: 1,
      projectId,
      tenant: command.tenant,
      name,
      ...(objective === undefined ? {} : { objective }),
      ...(description === undefined ? {} : { description }),
      state: 'active',
      createdAt: command.issuedAt,
      updatedAt: command.issuedAt,
    };
    await transaction.projects.create(command.tenant, projectId, project, command.issuedAt);
    await transaction.projects.update(command.tenant, projectId, 0, project, command.issuedAt);
    const event = productEvent(command, projectId, 1, 'project.created.v1', {
      projectId,
      name,
      ...(objective === undefined ? {} : { objective }),
      ...(description === undefined ? {} : { description }),
      status: 'active',
    });
    return {
      result: {
        projectId,
        name,
        ...(objective === undefined ? {} : { objective }),
        ...(description === undefined ? {} : { description }),
        status: 'active',
      },
      events: [event],
    };
  }

  private async updateProject(command: RuntimeCommand, transaction: StateTransaction) {
    const payload = payloadRecord(command);
    const projectId = optionalString(payload, 'projectId') as Id | undefined;
    if (!projectId || !isId(projectId))
      throw runtimeError('VALIDATION_INVALID_INPUT', 'projectId must be a UUIDv7 id');
    const current = await transaction.projects.get(command.tenant, projectId);
    if (!current)
      throw runtimeError('VALIDATION_INVALID_INPUT', `Project ${projectId} was not found`);
    const currentVersion = current.version;
    const expectedRevision = optionalRevision(payload);
    if (expectedRevision !== undefined && expectedRevision !== currentVersion) {
      throw runtimeError(
        'CONCURRENCY_STALE_VERSION',
        `Project ${projectId} expected revision ${expectedRevision}, actual ${currentVersion}`,
      );
    }
    const name = optionalString(payload, 'name');
    const objective = optionalString(payload, 'objective');
    const description = optionalString(payload, 'description');
    if (name === undefined && objective === undefined && description === undefined) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'At least one project field must be updated');
    }
    await transaction.projects.update(
      command.tenant,
      projectId,
      currentVersion,
      {
        ...current.value,
        ...(name === undefined ? {} : { name }),
        ...(objective === undefined ? {} : { objective }),
        ...(description === undefined ? {} : { description }),
        updatedAt: command.issuedAt,
      },
      command.issuedAt,
    );
    const event = productEvent(command, projectId, currentVersion + 1, 'project.updated.v1', {
      projectId,
      ...(name === undefined ? {} : { name }),
      ...(objective === undefined ? {} : { objective }),
      ...(description === undefined ? {} : { description }),
    });
    return { result: { projectId, revision: currentVersion + 1 }, events: [event] };
  }

  private async changeProjectState(
    command: RuntimeCommand,
    transaction: StateTransaction,
    status: 'active' | 'archived',
  ) {
    const payload = payloadRecord(command);
    const projectId = optionalString(payload, 'projectId') as Id | undefined;
    if (!projectId || !isId(projectId))
      throw runtimeError('VALIDATION_INVALID_INPUT', 'projectId must be a UUIDv7 id');
    const current = await transaction.projects.get(command.tenant, projectId);
    if (!current)
      throw runtimeError('VALIDATION_INVALID_INPUT', `Project ${projectId} was not found`);
    const currentVersion = current.version;
    const expectedRevision = optionalRevision(payload);
    if (expectedRevision !== undefined && expectedRevision !== currentVersion) {
      throw runtimeError(
        'CONCURRENCY_STALE_VERSION',
        `Project ${projectId} expected revision ${expectedRevision}, actual ${currentVersion}`,
      );
    }
    await transaction.projects.update(
      command.tenant,
      projectId,
      currentVersion,
      { ...current.value, state: status, updatedAt: command.issuedAt },
      command.issuedAt,
    );
    const eventName = status === 'archived' ? 'project.archived.v1' : 'project.restored.v1';
    const event = productEvent(command, projectId, currentVersion + 1, eventName, {
      projectId,
      status,
    });
    return { result: { projectId, status, revision: currentVersion + 1 }, events: [event] };
  }

  private async handleGenericResource(
    command: RuntimeCommand,
    transaction: StateTransaction,
    definition: GenericResourceCommandDefinition,
  ) {
    const payload = payloadRecord(command);
    const idField = `${definition.resourceType}Id`;
    const suppliedId = optionalString(payload, idField) ?? optionalString(payload, 'id');
    const resourceId = (suppliedId as Id | undefined) ?? newSortableId();
    if (!isId(resourceId)) {
      throw runtimeError('VALIDATION_INVALID_INPUT', `${idField} must be a UUIDv7 id`);
    }
    const currentVersion = await resourceVersion(transaction, command, definition, resourceId);
    const expectedRevision = optionalRevision(payload);
    if (expectedRevision !== undefined && expectedRevision !== currentVersion) {
      throw runtimeError(
        'CONCURRENCY_STALE_VERSION',
        `${definition.resourceType} ${resourceId} expected revision ${expectedRevision}, actual ${currentVersion}`,
      );
    }
    if (definition.operation === 'create' && currentVersion > 0) {
      throw runtimeError(
        'CONCURRENCY_STALE_VERSION',
        `${definition.resourceType} ${resourceId} already exists`,
      );
    }
    if (definition.operation !== 'create' && currentVersion === 0) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        `${definition.resourceType} ${resourceId} was not found`,
      );
    }
    const name =
      definition.operation === 'create'
        ? requiredString(payload, 'name')
        : optionalString(payload, 'name');
    const nextState =
      definition.operation === 'archive' ? (definition.terminalState ?? 'archived') : 'active';
    const eventPayload: JsonRecord = {
      ...withoutRevision(payload),
      [idField]: resourceId,
      ...(name === undefined ? {} : { name }),
      ...(definition.operation === 'create'
        ? { state: 'active', status: 'active', createdAt: command.issuedAt }
        : { state: nextState, status: nextState }),
      updatedAt: command.issuedAt,
    };
    const aggregateVersion = currentVersion + 1;
    const event = resourceEvent(
      command,
      definition.resourceType,
      resourceId,
      aggregateVersion,
      definition.operation,
      eventPayload,
    );
    return {
      result: {
        [idField]: resourceId,
        state: nextState,
        status: nextState,
        revision: aggregateVersion,
      },
      events: [event],
    };
  }
}
