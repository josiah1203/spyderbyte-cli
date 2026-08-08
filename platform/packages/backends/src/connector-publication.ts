import { createHash } from 'node:crypto';
import {
  runtimeError,
  type ArtifactReference,
  type HashSha256,
  type Id,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import {
  InMemoryConnectorRegistry,
  type ConnectorPackage,
  type ConnectorPublicationRequest,
} from './connector.js';

export interface ConnectorPublicationMaterial {
  readonly tenant: TenantRef;
  readonly name: string;
  readonly sourceArtifact: ArtifactReference;
  readonly authorAgentId: Id;
  readonly publisherAgentId: Id;
  readonly sourceHash: HashSha256;
  readonly scopeDigest: HashSha256;
  readonly packageDigest: HashSha256;
  readonly verificationDigest: HashSha256;
  readonly scansPassed: boolean;
  readonly contractTestsPassed: boolean;
}

export interface ConnectorPublicationWorkflowRequest {
  readonly material: ConnectorPublicationMaterial;
  readonly authorAgentId: Id;
  readonly publisherAgentId: Id;
  readonly governanceApproved: boolean;
  readonly humanApproved: boolean;
  readonly approvalDigest: HashSha256;
  readonly commitApprovalDigest: HashSha256;
}

export type ConnectorRegistryPublisher = Pick<InMemoryConnectorRegistry, 'publish'>;

/**
 * Provider-neutral publication gate. The action digest covers every package and verification
 * input that can materially change the published connector, so an approval cannot be reused after
 * a source, scope, package, scan, or contract-test change.
 */
export class ConnectorPublicationWorkflow {
  private readonly registry: ConnectorRegistryPublisher;

  constructor(options: { registry?: ConnectorRegistryPublisher } = {}) {
    this.registry = options.registry ?? new InMemoryConnectorRegistry();
  }

  publish(request: ConnectorPublicationWorkflowRequest): ConnectorPackage {
    const material = request.material;
    if (
      material.name.trim().length === 0 ||
      !isSha256(material.sourceHash) ||
      !isSha256(material.scopeDigest) ||
      !isSha256(material.packageDigest) ||
      !isSha256(material.verificationDigest)
    ) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        'Connector publication material is incomplete',
      );
    }
    if (!sameTenant(material.tenant, material.sourceArtifact.tenant)) {
      throw runtimeError(
        'POLICY_DENIED',
        'Connector source artifact crosses the publication tenant boundary',
      );
    }
    if (
      material.authorAgentId !== request.authorAgentId ||
      material.publisherAgentId !== request.publisherAgentId
    ) {
      throw runtimeError(
        'APPROVAL_INVALIDATED',
        'Connector publication approval is bound to different author or publisher identities',
      );
    }
    const expectedDigest = connectorPublicationDigest(material);
    if (
      request.approvalDigest !== expectedDigest ||
      request.commitApprovalDigest !== expectedDigest
    ) {
      throw runtimeError(
        'APPROVAL_INVALIDATED',
        'Connector publication approval no longer matches its material inputs',
      );
    }
    const publication: ConnectorPublicationRequest = {
      tenant: material.tenant,
      name: material.name,
      sourceHash: material.sourceHash,
      scopeDigest: material.scopeDigest,
      authorAgentId: request.authorAgentId,
      publisherAgentId: request.publisherAgentId,
      scansPassed: material.scansPassed,
      contractTestsPassed: material.contractTestsPassed,
      governanceApproved: request.governanceApproved,
      humanApproved: request.humanApproved,
      approvalDigest: expectedDigest,
      commitApprovalDigest: expectedDigest,
    };
    return this.registry.publish(publication);
  }
}

export function connectorPublicationDigest(material: ConnectorPublicationMaterial): HashSha256 {
  const canonical = JSON.stringify([
    material.tenant.tenantId,
    material.tenant.workspaceId,
    material.name,
    material.authorAgentId,
    material.publisherAgentId,
    material.sourceArtifact.artifactId,
    material.sourceArtifact.version,
    material.sourceArtifact.contentHash,
    material.sourceArtifact.schemaVersion,
    material.sourceArtifact.mediaType,
    material.sourceArtifact.sizeBytes,
    material.sourceArtifact.createdAt,
    material.sourceArtifact.uri ?? null,
    material.sourceHash,
    material.scopeDigest,
    material.packageDigest,
    material.verificationDigest,
    material.scansPassed,
    material.contractTestsPassed,
  ]);
  return createHash('sha256').update(canonical).digest('hex') as HashSha256;
}

function sameTenant(left: TenantRef, right: TenantRef): boolean {
  return left.tenantId === right.tenantId && left.workspaceId === right.workspaceId;
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}
