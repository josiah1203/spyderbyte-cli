import type {
  AgentInvocation,
  AgentRegistration,
  ApprovalRequest,
  Artifact,
  ArtifactReference,
  ArtifactState,
  Actor,
  BudgetReservation,
  Project,
  RuntimeCommand,
  RuntimeEvent,
  Workflow,
} from '@agentic-platform/runtime-contracts';
import type { JsonValue, Id, TenantRef } from '@agentic-platform/runtime-contracts';

export interface VersionedAggregate<T> {
  tenant: TenantRef;
  id: Id;
  version: number;
  value: T;
  updatedAt: string;
}

export interface AggregateRepository<T> {
  get(tenant: TenantRef, id: Id): Promise<VersionedAggregate<T> | undefined>;
  create(tenant: TenantRef, id: Id, value: T, updatedAt: string): Promise<VersionedAggregate<T>>;
  update(
    tenant: TenantRef,
    id: Id,
    expectedVersion: number,
    value: T,
    updatedAt: string,
  ): Promise<VersionedAggregate<T>>;
}

export type WorkflowRepository = AggregateRepository<Workflow>;
export type ProjectRepository = AggregateRepository<Project>;
export interface InvocationRepository extends AggregateRepository<AgentInvocation> {
  /** Count children while the surrounding state transaction holds its serialization boundary. */
  countChildren(tenant: TenantRef, parentInvocationId: Id): Promise<number>;
  /** Read and lock the parent lifecycle while a child is being created. */
  getForUpdate(
    tenant: TenantRef,
    invocationId: Id,
  ): Promise<VersionedAggregate<AgentInvocation> | undefined>;
}
export type ArtifactRepository = AggregateRepository<Artifact>;
export type ApprovalRepository = AggregateRepository<ApprovalRequest>;
export type BudgetRepository = AggregateRepository<BudgetReservation>;
export type AgentRegistryRepository = AggregateRepository<AgentRegistration>;

export interface PersistedArtifactVersion {
  reference: ArtifactReference;
  state: ArtifactState;
  createdBy: Actor;
  invocationId?: Id;
  lineage: ArtifactReference[];
  schemaName?: string;
  retentionUntil?: string;
  publishedAt: string;
}

export interface ArtifactVersionRepository {
  get(
    tenant: TenantRef,
    artifactId: Id,
    version: number,
  ): Promise<PersistedArtifactVersion | undefined>;
  current(tenant: TenantRef, artifactId: Id): Promise<PersistedArtifactVersion | undefined>;
  list(tenant: TenantRef, artifactId?: Id): Promise<PersistedArtifactVersion[]>;
  publish(record: PersistedArtifactVersion, expectedCurrentVersion: number): Promise<void>;
  markStale(tenant: TenantRef, artifactId: Id, version: number, updatedAt: string): Promise<void>;
}

export interface StoredEvent<TPayload extends JsonValue = JsonValue> {
  streamSequence: number;
  event: RuntimeEvent<TPayload>;
}

export interface EventStore {
  append<TPayload extends JsonValue>(
    event: RuntimeEvent<TPayload>,
    expectedAggregateVersion: number,
  ): Promise<StoredEvent<TPayload>>;
  list(tenant: TenantRef, afterStreamSequence?: number): Promise<StoredEvent[]>;
  all(): Promise<StoredEvent[]>;
}

export interface OutboxRecord {
  outboxId: Id;
  tenant: TenantRef;
  eventId: Id;
  topic: string;
  event: RuntimeEvent;
  availableAt: string;
  publishedAt?: string;
  attempts: number;
  claimedBy?: string;
  claimExpiresAt?: string;
}

export interface OutboxRepository {
  enqueue(event: RuntimeEvent, topic: string, availableAt: string): Promise<OutboxRecord>;
  pending(tenant: TenantRef, now: string): Promise<OutboxRecord[]>;
  claimPending(
    tenant: TenantRef,
    now: string,
    consumerId: string,
    claimExpiresAt: string,
    limit: number,
  ): Promise<OutboxRecord[]>;
  markPublished(
    tenant: TenantRef,
    outboxId: Id,
    publishedAt: string,
    consumerId?: string,
    now?: string,
  ): Promise<void>;
  incrementAttempt(
    tenant: TenantRef,
    outboxId: Id,
    consumerId?: string,
    now?: string,
  ): Promise<void>;
}

export interface CommandDeduplicationRecord {
  tenant: TenantRef;
  idempotencyKey: string;
  requestDigest: string;
  commandId: Id;
  result?: JsonValue;
  reservedAt: string;
  completedAt?: string;
}

export interface CommandDeduplicationRepository {
  reserve(
    command: RuntimeCommand,
    requestDigest: string,
    reservedAt: string,
  ): Promise<CommandDeduplicationRecord>;
  complete(
    tenant: TenantRef,
    idempotencyKey: string,
    result: JsonValue,
    completedAt: string,
  ): Promise<void>;
  get(tenant: TenantRef, idempotencyKey: string): Promise<CommandDeduplicationRecord | undefined>;
}

export interface ProjectionCheckpoint {
  tenant: TenantRef;
  projectionName: string;
  streamSequence: number;
  updatedAt: string;
}

export interface ProjectionCheckpointRepository {
  get(tenant: TenantRef, projectionName: string): Promise<ProjectionCheckpoint | undefined>;
  save(checkpoint: ProjectionCheckpoint): Promise<void>;
  clear(tenant: TenantRef, projectionName: string): Promise<void>;
}

export interface SideEffectReceipt {
  tenant: TenantRef;
  receiptId: Id;
  effectKey: string;
  result: JsonValue;
  recordedAt: string;
}

export interface SideEffectReceiptRepository {
  get(tenant: TenantRef, effectKey: string): Promise<SideEffectReceipt | undefined>;
  record(receipt: SideEffectReceipt): Promise<SideEffectReceipt>;
}

export interface StateTransaction {
  workflows: WorkflowRepository;
  projects: ProjectRepository;
  invocations: InvocationRepository;
  artifacts: ArtifactRepository;
  approvals: ApprovalRepository;
  budgets: BudgetRepository;
  agents: AgentRegistryRepository;
  artifactVersions: ArtifactVersionRepository;
  events: EventStore;
  outbox: OutboxRepository;
  commands: CommandDeduplicationRepository;
  checkpoints: ProjectionCheckpointRepository;
  receipts: SideEffectReceiptRepository;
}

export interface StateStore {
  transaction<T>(work: (transaction: StateTransaction) => Promise<T>): Promise<T>;
}
