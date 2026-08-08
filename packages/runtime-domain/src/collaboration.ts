import {
  newSortableId,
  runtimeError,
  type Actor,
  type Id,
  type JsonValue,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';

export interface CollaborationDocumentV1 {
  readonly documentId: Id;
  readonly tenant: TenantRef;
  readonly resourceType: string;
  readonly resourceId: Id;
  readonly version: number;
  readonly value: JsonValue;
  readonly updatedBy: Actor;
  readonly updatedAt: string;
}

export interface CollaborationPresenceV1 {
  readonly presenceId: Id;
  readonly tenant: TenantRef;
  readonly documentId: Id;
  readonly actor: Actor;
  readonly state: 'active' | 'idle';
  readonly cursor?: JsonValue;
  readonly expiresAt: string;
}

export interface CollaborationConflictV1 {
  readonly conflictId: Id;
  readonly tenant: TenantRef;
  readonly documentId: Id;
  readonly expectedVersion: number;
  readonly actualVersion: number;
  readonly current: CollaborationDocumentV1;
  readonly attemptedValue: JsonValue;
  readonly attemptedBy: Actor;
  readonly occurredAt: string;
}

export type CollaborationWriteResult =
  | { readonly status: 'applied'; readonly document: CollaborationDocumentV1 }
  | { readonly status: 'conflict'; readonly conflict: CollaborationConflictV1 };

export interface CollaborationAuditRecord {
  readonly auditId: Id;
  readonly tenant: TenantRef;
  readonly action:
    | 'document.created'
    | 'document.updated'
    | 'document.conflict'
    | 'presence.updated';
  readonly targetId: Id;
  readonly at: string;
  readonly details: Readonly<Record<string, string | number>>;
}

function tenantKey(tenant: TenantRef): string {
  return `${tenant.tenantId}:${tenant.workspaceId}`;
}

function documentKey(tenant: TenantRef, documentId: Id): string {
  return `${tenantKey(tenant)}:${documentId}`;
}

function sameTenant(left: TenantRef, right: TenantRef): boolean {
  return left.tenantId === right.tenantId && left.workspaceId === right.workspaceId;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertText(value: string, label: string): string {
  if (value.trim().length === 0 || value.length > 160)
    throw runtimeError('VALIDATION_INVALID_INPUT', `${label} is required`);
  return value.trim();
}

function assertVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw runtimeError('VALIDATION_INVALID_INPUT', 'Document version must be non-negative');
}

export class InMemoryCollaborationService {
  private readonly documents = new Map<string, CollaborationDocumentV1>();
  private readonly presence = new Map<string, CollaborationPresenceV1>();
  private readonly audits: CollaborationAuditRecord[] = [];
  private readonly conflictRecords: CollaborationConflictV1[] = [];
  private readonly clock: () => string;

  constructor(clock: () => string = () => new Date().toISOString()) {
    this.clock = clock;
  }

  open(input: {
    readonly tenant: TenantRef;
    readonly resourceType: string;
    readonly resourceId: Id;
    readonly initialValue?: JsonValue;
    readonly actor: Actor;
    readonly now?: string;
  }): CollaborationDocumentV1 {
    const resourceType = assertText(input.resourceType, 'Collaboration resource type');
    const key = documentKey(input.tenant, input.resourceId);
    const existing = this.documents.get(key);
    if (existing !== undefined) {
      if (existing.resourceType !== resourceType)
        throw runtimeError('POLICY_DENIED', 'Collaboration resource type does not match');
      return clone(existing);
    }
    const now = input.now ?? this.clock();
    const document: CollaborationDocumentV1 = {
      documentId: input.resourceId,
      tenant: clone(input.tenant),
      resourceType,
      resourceId: input.resourceId,
      version: 0,
      value: clone(input.initialValue ?? null),
      updatedBy: clone(input.actor),
      updatedAt: now,
    };
    this.documents.set(key, document);
    this.record(input.tenant, 'document.created', document.documentId, { version: 0 });
    return clone(document);
  }

  read(tenant: TenantRef, documentId: Id): CollaborationDocumentV1 {
    const document = this.documents.get(documentKey(tenant, documentId));
    if (document === undefined)
      throw runtimeError(
        'ARTIFACT_NOT_FOUND',
        `Collaboration document ${documentId} was not found`,
      );
    return clone(document);
  }

  write(input: {
    readonly tenant: TenantRef;
    readonly documentId: Id;
    readonly expectedVersion: number;
    readonly value: JsonValue;
    readonly actor: Actor;
    readonly now?: string;
  }): CollaborationWriteResult {
    assertVersion(input.expectedVersion);
    const current = this.read(input.tenant, input.documentId);
    const now = input.now ?? this.clock();
    if (current.version !== input.expectedVersion) {
      const conflict: CollaborationConflictV1 = {
        conflictId: newSortableId(),
        tenant: clone(input.tenant),
        documentId: input.documentId,
        expectedVersion: input.expectedVersion,
        actualVersion: current.version,
        current,
        attemptedValue: clone(input.value),
        attemptedBy: clone(input.actor),
        occurredAt: now,
      };
      this.conflictRecords.push(conflict);
      this.record(input.tenant, 'document.conflict', input.documentId, {
        expectedVersion: input.expectedVersion,
        actualVersion: current.version,
      });
      return { status: 'conflict', conflict: clone(conflict) };
    }
    const next: CollaborationDocumentV1 = {
      ...current,
      version: current.version + 1,
      value: clone(input.value),
      updatedBy: clone(input.actor),
      updatedAt: now,
    };
    this.documents.set(documentKey(input.tenant, input.documentId), next);
    this.record(input.tenant, 'document.updated', input.documentId, { version: next.version });
    return { status: 'applied', document: clone(next) };
  }

  updatePresence(input: {
    readonly tenant: TenantRef;
    readonly documentId: Id;
    readonly actor: Actor;
    readonly state: 'active' | 'idle';
    readonly cursor?: JsonValue;
    readonly ttlMs?: number;
    readonly presenceId?: Id;
    readonly now?: string;
  }): CollaborationPresenceV1 {
    this.read(input.tenant, input.documentId);
    const now = input.now ?? this.clock();
    const ttlMs = input.ttlMs ?? 30_000;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Presence TTL must be positive');
    const presence: CollaborationPresenceV1 = {
      presenceId: input.presenceId ?? newSortableId(),
      tenant: clone(input.tenant),
      documentId: input.documentId,
      actor: clone(input.actor),
      state: input.state,
      ...(input.cursor === undefined ? {} : { cursor: clone(input.cursor) }),
      expiresAt: new Date(Date.parse(now) + ttlMs).toISOString(),
    };
    this.presence.set(
      `${tenantKey(input.tenant)}:${input.documentId}:${input.actor.actorId}`,
      presence,
    );
    this.record(input.tenant, 'presence.updated', input.documentId, { state: input.state });
    return clone(presence);
  }

  listPresence(
    tenant: TenantRef,
    documentId: Id,
    now = this.clock(),
  ): readonly CollaborationPresenceV1[] {
    const nowMs = Date.parse(now);
    return clone(
      [...this.presence.values()].filter(
        (presence) =>
          sameTenant(presence.tenant, tenant) &&
          presence.documentId === documentId &&
          Date.parse(presence.expiresAt) > nowMs,
      ),
    );
  }

  expirePresence(now = this.clock()): number {
    const nowMs = Date.parse(now);
    let expired = 0;
    for (const [key, presence] of this.presence.entries()) {
      if (Date.parse(presence.expiresAt) <= nowMs) {
        this.presence.delete(key);
        expired += 1;
      }
    }
    return expired;
  }

  conflicts(tenant: TenantRef, documentId?: Id): readonly CollaborationConflictV1[] {
    return clone(
      this.conflictRecords.filter(
        (conflict) =>
          sameTenant(conflict.tenant, tenant) &&
          (documentId === undefined || conflict.documentId === documentId),
      ),
    );
  }

  auditRecords(tenant?: TenantRef): readonly CollaborationAuditRecord[] {
    return clone(
      tenant === undefined
        ? this.audits
        : this.audits.filter((record) => sameTenant(record.tenant, tenant)),
    );
  }

  private record(
    tenant: TenantRef,
    action: CollaborationAuditRecord['action'],
    targetId: Id,
    details: Readonly<Record<string, string | number>>,
  ): void {
    this.audits.push({
      auditId: newSortableId(),
      tenant: clone(tenant),
      action,
      targetId,
      at: this.clock(),
      details: { ...details },
    });
  }
}

/** The public port a durable hosted collaboration service must implement. */
export type CollaborationService = Pick<
  InMemoryCollaborationService,
  'open' | 'read' | 'write' | 'updatePresence' | 'listPresence' | 'conflicts'
>;
