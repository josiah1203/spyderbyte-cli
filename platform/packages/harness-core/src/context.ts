import {
  isJsonValue,
  type AgentInvocation,
  type ArtifactReference,
  type HashSha256,
  type JsonValue,
  type ResourceSelector,
} from '@agentic-platform/runtime-contracts';
import { selectorAllows, sha256Digest } from '@agentic-platform/policy';

export interface ContextAssemblyPolicy {
  readonly maxPromptBytes?: number;
  readonly artifactContent?: 'summary' | 'authorized_content';
  readonly includeWorkspacePolicy?: boolean;
  readonly includeChildReports?: boolean;
  readonly allowExternalInstructions?: boolean;
}

export type TrustClass =
  | 'system_policy'
  | 'trusted_workspace_policy'
  | 'invocation_objective'
  | 'artifact_summary'
  | 'artifact_content'
  | 'explicit_constraint'
  | 'authority_envelope'
  | 'budget_envelope'
  | 'resource_envelope'
  | 'retry_envelope'
  | 'child_report'
  | 'untrusted_external'
  | 'mounted_working_file';

export interface ContextArtifactInput {
  reference: ArtifactReference;
  summary: JsonValue;
  content?: JsonValue;
  source: string;
  reason: string;
}

export interface MountedWorkingFile {
  path: string;
  content: JsonValue;
  version?: string;
  reason: string;
}

export interface ContextAssemblyRequest {
  invocation: AgentInvocation;
  maxContextBytes?: number;
  systemPolicy: JsonValue;
  workspacePolicy?: JsonValue;
  objective: string;
  exactTaskInput?: JsonValue;
  artifacts: ContextArtifactInput[];
  constraints: JsonValue;
  priorChildReports: JsonValue[];
  externalContent: JsonValue[];
  mountedWorkingFiles: MountedWorkingFile[];
  policy?: ContextAssemblyPolicy;
}

export interface ContextSection {
  key: string;
  trustClass: TrustClass;
  source: string;
  version?: string;
  content: JsonValue;
  reason: string;
}

export interface ContextManifestEntry {
  key: string;
  trustClass: TrustClass;
  source: string;
  version?: string;
  sizeBytes: number;
  reason: string;
}

export interface ContextDocument {
  sections: ContextSection[];
  manifest: ContextManifestEntry[];
  digest: HashSha256;
}

function sizeBytes(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function isAllowed(scopes: readonly ResourceSelector[], reference: ResourceSelector): boolean {
  return scopes.some((scope) => selectorAllows(scope, reference));
}

export class ContextAssembler {
  assemble(request: ContextAssemblyRequest): ContextDocument {
    const policy = request.policy ?? {};
    const promptValue = request.invocation.tier === 2 ? request.exactTaskInput : request.objective;
    if (policy.maxPromptBytes !== undefined && promptValue !== undefined) {
      const promptBytes = sizeBytes(promptValue);
      if (promptBytes > policy.maxPromptBytes) {
        throw new TypeError('Prompt exceeds the harness prompt policy limit');
      }
    }
    const sections: ContextSection[] = [];
    const add = (
      key: string,
      trustClass: TrustClass,
      source: string,
      content: JsonValue,
      reason: string,
      version?: string,
    ): void => {
      if (!isJsonValue(content))
        throw new TypeError(`Context section ${key} is not JSON serializable`);
      sections.push({
        key,
        trustClass,
        source,
        content,
        reason,
        ...(version !== undefined ? { version } : {}),
      });
    };

    add(
      'system-policy',
      'system_policy',
      'control-plane',
      request.systemPolicy,
      'Mandatory runtime policy',
    );
    if (
      request.invocation.tier !== 2 &&
      policy.includeWorkspacePolicy !== false &&
      request.workspacePolicy !== undefined
    ) {
      add(
        'workspace-policy',
        'trusted_workspace_policy',
        'workspace',
        request.workspacePolicy,
        'Trusted policy applicable to this tier',
      );
    }
    if (request.invocation.tier !== 2) {
      add(
        'objective',
        'invocation_objective',
        'workflow',
        request.objective,
        'Invocation objective',
      );
    } else if (request.exactTaskInput !== undefined) {
      add(
        'exact-task-input',
        'invocation_objective',
        'invocation',
        request.exactTaskInput,
        'Exact Tier 2 task input',
      );
    }
    add(
      'constraints',
      'explicit_constraint',
      'workflow',
      request.constraints,
      'Explicit execution constraints',
    );
    add(
      'authority',
      'authority_envelope',
      'control-plane',
      request.invocation.authority as unknown as JsonValue,
      'Server-issued authority boundary',
    );
    add(
      'budget',
      'budget_envelope',
      'control-plane',
      request.invocation.budget as unknown as JsonValue,
      'Server-issued budget boundary',
    );
    add(
      'resources',
      'resource_envelope',
      'control-plane',
      request.invocation.resource as unknown as JsonValue,
      'Server-issued resource boundary',
    );
    add(
      'retry',
      'retry_envelope',
      'control-plane',
      request.invocation.retry as unknown as JsonValue,
      'Server-issued retry boundary',
    );

    for (const artifact of request.artifacts) {
      if (
        artifact.reference.tenant.tenantId !== request.invocation.tenant.tenantId ||
        artifact.reference.tenant.workspaceId !== request.invocation.tenant.workspaceId
      ) {
        throw new TypeError('Context cannot include a cross-tenant artifact reference');
      }
      const referenceSelector: ResourceSelector = {
        kind: 'artifact',
        id: artifact.reference.artifactId,
        version: artifact.reference.version,
      };
      add(
        `artifact-${artifact.reference.artifactId}-${artifact.reference.version}-summary`,
        'artifact_summary',
        artifact.source,
        artifact.summary,
        artifact.reason,
        String(artifact.reference.version),
      );
      const canRead = isAllowed(
        request.invocation.authority.allowedArtifactReads,
        referenceSelector,
      );
      if (
        artifact.content !== undefined &&
        canRead &&
        (request.invocation.tier === 1 || request.invocation.tier === 2) &&
        policy.artifactContent !== 'summary'
      ) {
        add(
          `artifact-${artifact.reference.artifactId}-${artifact.reference.version}-content`,
          'artifact_content',
          artifact.source,
          artifact.content,
          'Content permitted by authority and tier policy',
          String(artifact.reference.version),
        );
      }
    }

    if (request.invocation.tier !== 2 && policy.includeChildReports !== false) {
      for (const [index, report] of request.priorChildReports.entries()) {
        add(
          `child-report-${index}`,
          'child_report',
          'invocation-child',
          report,
          'Prior child report',
        );
      }
    }
    for (const [index, external] of request.externalContent.entries()) {
      add(
        `external-${index}`,
        'untrusted_external',
        'external',
        external,
        'Untrusted external content; never policy',
      );
    }
    if (request.invocation.tier === 2) {
      for (const [index, file] of request.mountedWorkingFiles.entries()) {
        add(
          `working-file-${index}`,
          'mounted_working_file',
          file.path,
          file.content,
          file.reason,
          file.version,
        );
      }
    }

    const manifest = sections.map((section) => ({
      key: section.key,
      trustClass: section.trustClass,
      source: section.source,
      ...(section.version !== undefined ? { version: section.version } : {}),
      sizeBytes: sizeBytes(section.content),
      reason: section.reason,
    }));
    const document = { sections, manifest };
    const totalBytes = sizeBytes(document as unknown as JsonValue);
    if (request.maxContextBytes !== undefined && totalBytes > request.maxContextBytes) {
      throw new TypeError('Assembled context exceeds the harness context policy limit');
    }
    return { ...document, digest: sha256Digest(document) };
  }
}
