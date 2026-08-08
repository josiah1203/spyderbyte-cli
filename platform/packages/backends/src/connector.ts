import {
  newSortableId,
  runtimeError,
  type Id,
  type JsonValue,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import type { SecretHandle } from './secret-broker.js';
import { InMemoryLifecycleAuditLog, type LifecycleAuditRecord } from './lifecycle.js';

export interface ConnectorPackage {
  readonly connectorId: Id;
  readonly tenant: TenantRef;
  readonly name: string;
  readonly sourceHash: string;
  readonly scopeDigest: string;
  readonly authorAgentId: Id;
  readonly packageArtifactId: Id;
  readonly state: 'published' | 'revoked';
  readonly approvalDigest: string;
}

export interface ConnectorPublicationRequest {
  readonly tenant: TenantRef;
  readonly name: string;
  readonly sourceHash: string;
  readonly scopeDigest: string;
  readonly authorAgentId: Id;
  readonly publisherAgentId: Id;
  readonly scansPassed: boolean;
  readonly contractTestsPassed: boolean;
  readonly governanceApproved: boolean;
  readonly humanApproved: boolean;
  readonly approvalDigest: string;
  readonly commitApprovalDigest: string;
}

export interface ReferenceConnectorPage {
  readonly items: readonly JsonValue[];
  readonly nextCursor?: string;
}

export interface ReferenceConnectorClient {
  list(request: {
    readonly tenant: TenantRef;
    readonly credentialHandle: SecretHandle;
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<ReferenceConnectorPage>;
}

export interface ReferenceConnectorAuditRecord {
  readonly connectorName: string;
  readonly tenant: TenantRef;
  readonly cursor?: string;
  readonly itemCount: number;
  readonly at: string;
  readonly outcome: 'succeeded' | 'retrying' | 'failed';
}

interface RetryableConnectorError extends Error {
  retryable?: boolean;
}

export class ReferenceReadOnlyConnector {
  private readonly client: ReferenceConnectorClient;
  private readonly connectorName: string;
  private readonly redact: (value: string) => Promise<string> | string;
  private readonly clock: () => string;
  private readonly maxPageSize: number;
  private readonly maxAttempts: number;
  private readonly audit: ReferenceConnectorAuditRecord[] = [];

  constructor(options: {
    client: ReferenceConnectorClient;
    connectorName: string;
    redact: (value: string) => Promise<string> | string;
    clock?: () => string;
    maxPageSize?: number;
    maxAttempts?: number;
  }) {
    if (options.connectorName.trim().length === 0)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Connector name is required');
    if ((options.maxPageSize ?? 100) < 1 || (options.maxAttempts ?? 3) < 1)
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Connector limits must be positive');
    this.client = options.client;
    this.connectorName = options.connectorName;
    this.redact = options.redact;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.maxPageSize = options.maxPageSize ?? 100;
    this.maxAttempts = options.maxAttempts ?? 3;
  }

  async list(
    tenant: TenantRef,
    credentialHandle: SecretHandle,
    options: { readonly cursor?: string; readonly limit?: number } = {},
  ): Promise<ReferenceConnectorPage> {
    if (
      credentialHandle.tenant.tenantId !== tenant.tenantId ||
      credentialHandle.tenant.workspaceId !== tenant.workspaceId
    ) {
      throw runtimeError('POLICY_DENIED', 'Connector credential handle crosses a tenant boundary');
    }
    if (credentialHandle.operation !== 'connector.read') {
      throw runtimeError('POLICY_DENIED', 'Reference connector is read-only');
    }
    const now = Date.parse(this.clock());
    const expiresAt = Date.parse(credentialHandle.expiresAt);
    if (!Number.isFinite(now) || !Number.isFinite(expiresAt) || expiresAt <= now) {
      throw runtimeError('AUTHORITY_EXPIRED', 'Reference connector credential handle has expired');
    }
    const limit = options.limit ?? this.maxPageSize;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.maxPageSize) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'Connector page size is outside the allowed range',
      );
    }
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const page = await this.client.list({
          tenant,
          credentialHandle,
          ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
          limit,
        });
        const redactedItems = await this.redactItems(page.items);
        this.audit.push({
          connectorName: this.connectorName,
          tenant,
          ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
          itemCount: redactedItems.length,
          at: this.clock(),
          outcome: 'succeeded',
        });
        return {
          items: redactedItems,
          ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
        };
      } catch (error) {
        const retryable = isRetryableConnectorError(error);
        if (!retryable || attempt === this.maxAttempts) {
          this.audit.push({
            connectorName: this.connectorName,
            tenant,
            ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
            itemCount: 0,
            at: this.clock(),
            outcome: 'failed',
          });
          throw error;
        }
        this.audit.push({
          connectorName: this.connectorName,
          tenant,
          ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
          itemCount: 0,
          at: this.clock(),
          outcome: 'retrying',
        });
      }
    }
    throw runtimeError('RETRY_EXHAUSTED', 'Connector retry loop ended unexpectedly');
  }

  auditRecords(): ReferenceConnectorAuditRecord[] {
    return structuredClone(this.audit);
  }

  private async redactItems(items: readonly JsonValue[]): Promise<JsonValue[]> {
    const serialized = JSON.stringify(items);
    const redacted = await this.redact(serialized);
    try {
      const parsed: unknown = JSON.parse(redacted);
      if (!Array.isArray(parsed)) throw new Error('redactor changed connector item shape');
      return parsed as JsonValue[];
    } catch (error) {
      throw runtimeError(
        'VALIDATION_SCHEMA_MISMATCH',
        error instanceof Error ? error.message : 'Connector redaction returned invalid JSON',
      );
    }
  }
}

function isRetryableConnectorError(error: unknown): boolean {
  return error instanceof Error && (error as RetryableConnectorError).retryable === true;
}

export class InMemoryConnectorRegistry {
  private readonly connectors = new Map<Id, ConnectorPackage>();
  private readonly audit: InMemoryLifecycleAuditLog;

  constructor(options: { audit?: InMemoryLifecycleAuditLog; clock?: () => string } = {}) {
    this.audit = options.audit ?? new InMemoryLifecycleAuditLog(options.clock);
  }

  publish(request: ConnectorPublicationRequest): ConnectorPackage {
    if (request.authorAgentId === request.publisherAgentId) {
      this.audit.append({
        tenant: request.tenant,
        action: 'connector.publish',
        target: request.name,
        outcome: 'denied',
        details: { reason: 'author_cannot_publish' },
      });
      throw runtimeError('AUTHORITY_MISSING', 'Connector author cannot publish its own package');
    }
    if (!request.scansPassed || !request.contractTestsPassed) {
      this.audit.append({
        tenant: request.tenant,
        action: 'connector.publish',
        target: request.name,
        outcome: 'denied',
        details: { reason: 'verification_incomplete' },
      });
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'Connector scans and sandbox contract tests are required',
      );
    }
    if (!request.governanceApproved || !request.humanApproved) {
      this.audit.append({
        tenant: request.tenant,
        action: 'connector.publish',
        target: request.name,
        outcome: 'denied',
        details: { reason: 'approval_required' },
      });
      throw runtimeError(
        'APPROVAL_REQUIRED',
        'Governance and human approval are required for publication',
      );
    }
    if (request.approvalDigest !== request.commitApprovalDigest) {
      this.audit.append({
        tenant: request.tenant,
        action: 'connector.publish',
        target: request.name,
        outcome: 'denied',
        details: { reason: 'approval_invalidated' },
      });
      throw runtimeError(
        'APPROVAL_INVALIDATED',
        'Connector publication approval no longer matches the package',
      );
    }
    const connector: ConnectorPackage = {
      connectorId: newSortableId(),
      tenant: request.tenant,
      name: request.name,
      sourceHash: request.sourceHash,
      scopeDigest: request.scopeDigest,
      authorAgentId: request.authorAgentId,
      packageArtifactId: newSortableId(),
      state: 'published',
      approvalDigest: request.commitApprovalDigest,
    };
    this.connectors.set(connector.connectorId, connector);
    this.audit.append({
      tenant: request.tenant,
      action: 'connector.published',
      target: connector.connectorId,
      outcome: 'completed',
      details: { name: connector.name, packageArtifactId: connector.packageArtifactId },
    });
    return structuredClone(connector);
  }

  revoke(tenant: TenantRef, connectorId: Id): ConnectorPackage {
    const current = this.connectors.get(connectorId);
    if (current === undefined)
      throw runtimeError('ARTIFACT_NOT_FOUND', `Connector ${connectorId} was not found`);
    if (
      current.tenant.tenantId !== tenant.tenantId ||
      current.tenant.workspaceId !== tenant.workspaceId
    ) {
      throw runtimeError('POLICY_DENIED', 'Connector mutation crosses a tenant boundary');
    }
    const next = { ...current, state: 'revoked' as const };
    this.connectors.set(connectorId, next);
    this.audit.append({
      tenant: current.tenant,
      action: 'connector.revoked',
      target: connectorId,
      outcome: 'completed',
      details: { name: current.name },
    });
    return structuredClone(next);
  }

  auditRecords(): LifecycleAuditRecord[] {
    return this.audit.list();
  }
}
