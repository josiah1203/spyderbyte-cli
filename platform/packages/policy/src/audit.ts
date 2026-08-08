import type {
  Actor,
  Id,
  JsonValue,
  ResourceSelector,
  TenantRef,
} from '@agentic-platform/runtime-contracts';

export interface AuditRecord {
  auditId: Id;
  tenant: TenantRef;
  actor: Actor;
  action: string;
  target: ResourceSelector[];
  result: 'allowed' | 'denied' | 'approval_required' | 'executed' | 'redacted';
  evidence: JsonValue;
  occurredAt: string;
}

export interface AuditSink {
  record(entry: AuditRecord): void;
}

export class InMemoryAuditSink implements AuditSink {
  private readonly entries: AuditRecord[] = [];

  record(entry: AuditRecord): void {
    this.entries.push(structuredClone(entry));
  }

  list(): AuditRecord[] {
    return structuredClone(this.entries);
  }
}
