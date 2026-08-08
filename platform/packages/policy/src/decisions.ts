import {
  newSortableId,
  runtimeError,
  type Actor,
  type AuthorityEnvelope,
  type HashSha256,
  type Id,
  type LocalSafetySettings,
  type Money,
  type ResourceSelector,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import { canonicalJson, sha256Digest } from './canonical.js';
import type { AuthorityService } from './authority.js';
import type { LocalConfirmationService } from './local-confirmations.js';

export type PolicyActionKind =
  | 'data_access'
  | 'pii_handling'
  | 'compute_allocation'
  | 'secret_capability'
  | 'connector_scope'
  | 'model_promotion'
  | 'deployment'
  | 'artifact_retention'
  | 'external_network'
  | 'tool_use';

export interface PolicyInputBase {
  action: PolicyActionKind;
  tenant: TenantRef;
  workflowId: Id;
  invocationId: Id;
  actor: Actor;
  authority: AuthorityEnvelope;
  resources: ResourceSelector[];
  evaluatedAt: string;
}

export interface DataAccessPolicyInput extends PolicyInputBase {
  action: 'data_access';
  access: 'read' | 'write';
  classification: 'public' | 'internal' | 'confidential' | 'pii';
}

export interface PiiHandlingPolicyInput extends PolicyInputBase {
  action: 'pii_handling';
  operation: 'read' | 'transform' | 'export' | 'delete';
  purpose: string;
}

export interface ComputeAllocationPolicyInput extends PolicyInputBase {
  action: 'compute_allocation';
  resourceClass: string;
  estimatedCost: Money;
  requiresApproval?: boolean;
}

export interface SecretCapabilityPolicyInput extends PolicyInputBase {
  action: 'secret_capability';
  secretScope: string;
  requiresApproval?: boolean;
}

export interface ConnectorScopePolicyInput extends PolicyInputBase {
  action: 'connector_scope';
  connectorId: string;
  operation: string;
  external: boolean;
  requiresApproval?: boolean;
}

export interface ModelPromotionPolicyInput extends PolicyInputBase {
  action: 'model_promotion';
  modelId: Id;
  target: string;
  requiresApproval?: boolean;
}

export interface DeploymentPolicyInput extends PolicyInputBase {
  action: 'deployment';
  target: string;
  trafficPercentage: number;
  requiresApproval?: boolean;
}

export interface ArtifactRetentionPolicyInput extends PolicyInputBase {
  action: 'artifact_retention';
  retentionUntil: string;
  requiresApproval?: boolean;
}

export interface ExternalNetworkPolicyInput extends PolicyInputBase {
  action: 'external_network';
  host: string;
  method: string;
  requiresApproval?: boolean;
}

export interface ToolUsePolicyInput extends PolicyInputBase {
  action: 'tool_use';
  toolName: string;
  operation: string;
  requiresApproval?: boolean;
}

export type PolicyInput =
  | DataAccessPolicyInput
  | PiiHandlingPolicyInput
  | ComputeAllocationPolicyInput
  | SecretCapabilityPolicyInput
  | ConnectorScopePolicyInput
  | ModelPromotionPolicyInput
  | DeploymentPolicyInput
  | ArtifactRetentionPolicyInput
  | ExternalNetworkPolicyInput
  | ToolUsePolicyInput;

export type PolicyOutcome = 'allow' | 'deny' | 'approval_required' | 'confirmation_required';

export type PolicyEnforcementMode = 'personal_local' | 'organization';

export interface PolicyDecision {
  decisionId: Id;
  policyVersion: string;
  inputDigest: HashSha256;
  outcome: PolicyOutcome;
  obligations: string[];
  reasonCodes: string[];
  decidedAt: string;
  confirmationId?: Id;
}

export interface StoredPolicyDecision {
  decision: PolicyDecision;
  input: PolicyInput;
}

export interface PolicyDecisionStore {
  save(record: StoredPolicyDecision): void;
  get(decisionId: Id): StoredPolicyDecision | undefined;
}

export class InMemoryPolicyDecisionStore implements PolicyDecisionStore {
  private readonly records = new Map<Id, StoredPolicyDecision>();

  save(record: StoredPolicyDecision): void {
    this.records.set(record.decision.decisionId, structuredClone(record));
  }

  get(decisionId: Id): StoredPolicyDecision | undefined {
    const record = this.records.get(decisionId);
    return record ? structuredClone(record) : undefined;
  }

  list(): StoredPolicyDecision[] {
    return structuredClone([...this.records.values()]);
  }
}

export interface PolicyDecisionServiceOptions {
  policyVersion?: string;
  authority: Pick<AuthorityService, 'assertAuthorized'>;
  store?: PolicyDecisionStore;
  /** Injected by trusted daemon/host composition; never taken from a browser payload. */
  enforcementMode?: PolicyEnforcementMode;
  localSafety?: Partial<LocalSafetySettings>;
  localConfirmations?: LocalConfirmationService;
}

function requiredAction(input: PolicyInput): string {
  switch (input.action) {
    case 'data_access':
      return `data.${input.access}`;
    case 'pii_handling':
      return `data.pii.${input.operation}`;
    case 'compute_allocation':
      return 'compute.allocate';
    case 'secret_capability':
      return 'secret.issue';
    case 'connector_scope':
      return `connector.${input.operation}`;
    case 'model_promotion':
      return 'model.promote';
    case 'deployment':
      return 'deployment.execute';
    case 'artifact_retention':
      return 'artifact.retention';
    case 'external_network':
      return 'network.external';
    case 'tool_use':
      return 'tool.use';
  }
}

function authorityHasCapability(authority: AuthorityEnvelope, capability: string): boolean {
  return authority.capabilities.includes(capability);
}

function decision(
  input: PolicyInput,
  policyVersion: string,
  outcome: PolicyOutcome,
  obligations: string[],
  reasonCodes: string[],
  confirmationId?: Id,
): PolicyDecision {
  return {
    decisionId: newSortableId(),
    policyVersion,
    inputDigest: sha256Digest(input),
    outcome,
    obligations,
    reasonCodes,
    decidedAt: input.evaluatedAt,
    ...(confirmationId === undefined ? {} : { confirmationId }),
  };
}

export class PolicyDecisionService {
  private readonly policyVersion: string;
  private readonly authority: Pick<AuthorityService, 'assertAuthorized'>;
  private readonly store: PolicyDecisionStore;
  private readonly enforcementMode: PolicyEnforcementMode;
  private readonly localSafety: LocalSafetySettings;
  private readonly localConfirmations: LocalConfirmationService | undefined;

  constructor(options: PolicyDecisionServiceOptions) {
    this.policyVersion = options.policyVersion ?? 'policy.v1';
    this.authority = options.authority;
    this.store = options.store ?? new InMemoryPolicyDecisionStore();
    this.enforcementMode = options.enforcementMode ?? 'organization';
    this.localSafety = {
      confirmExternalNetwork: options.localSafety?.confirmExternalNetwork ?? false,
      confirmExternalWrites: options.localSafety?.confirmExternalWrites ?? false,
      confirmDestructiveActions: options.localSafety?.confirmDestructiveActions ?? false,
      confirmSecretUse: options.localSafety?.confirmSecretUse ?? false,
    };
    this.localConfirmations = options.localConfirmations;
  }

  decide(input: PolicyInput): PolicyDecision {
    const reasons: string[] = [];
    try {
      if (input.authority.policyVersion !== this.policyVersion) {
        reasons.push('policy_version_mismatch');
      }
      this.authority.assertAuthorized(input.authority, {
        tenant: input.tenant,
        workflowId: input.workflowId,
        invocationId: input.invocationId,
        actorId: input.actor.actorId,
        action: requiredAction(input),
        resources: input.resources,
        now: input.evaluatedAt,
      });
    } catch {
      reasons.push('authority_denied');
    }

    if (reasons.length > 0) {
      return this.persist(input, decision(input, this.policyVersion, 'deny', [], reasons));
    }

    let outcome: PolicyOutcome = 'allow';
    const obligations: string[] = [];
    let confirmationId: Id | undefined;

    const requireLocalConfirmation = (reason: string): void => {
      if (outcome === 'deny' || outcome === 'approval_required') return;
      outcome = 'confirmation_required';
      confirmationId ??=
        this.localConfirmations?.issue(input, input.evaluatedAt).challengeId ?? newSortableId();
      reasons.push(reason);
    };

    if (this.enforcementMode === 'personal_local') {
      // Personal workspaces retain authority, resource, secret, budget, and technical checks,
      // but do not inherit organization workflow gates. Optional device confirmations are a
      // separate, action-bound UX and are never represented as POLICY_DENIED or APPROVAL_REQUIRED.
      switch (input.action) {
        case 'data_access':
          if (input.access === 'write') obligations.push('record_artifact_lineage');
          if (input.classification === 'pii') obligations.push('redact_pii_in_audit');
          break;
        case 'pii_handling':
          obligations.push('redact_pii_in_audit');
          break;
        case 'compute_allocation':
          obligations.push('meter_compute_usage');
          break;
        case 'secret_capability':
          obligations.push('redact_secret_shaped_output');
          if (this.localSafety.confirmSecretUse) requireLocalConfirmation('secret_confirmation');
          break;
        case 'connector_scope':
          obligations.push('audit_connector_operation');
          if (input.external && this.localSafety.confirmExternalNetwork) {
            requireLocalConfirmation('connector_external_confirmation');
          } else if (input.operation !== 'read' && this.localSafety.confirmExternalWrites) {
            requireLocalConfirmation('connector_write_confirmation');
          }
          break;
        case 'model_promotion':
          obligations.push('record_model_lineage');
          if (
            this.localSafety.confirmExternalWrites ||
            this.localSafety.confirmDestructiveActions
          ) {
            requireLocalConfirmation('model_promotion_confirmation');
          }
          break;
        case 'deployment':
          obligations.push('smoke_test_before_traffic');
          if (
            this.localSafety.confirmExternalWrites ||
            this.localSafety.confirmDestructiveActions
          ) {
            requireLocalConfirmation('deployment_confirmation');
          }
          break;
        case 'artifact_retention':
          obligations.push('record_retention_policy');
          break;
        case 'external_network':
          obligations.push('audit_external_request');
          if (this.localSafety.confirmExternalNetwork)
            requireLocalConfirmation('external_network_confirmation');
          break;
        case 'tool_use':
          obligations.push('audit_tool_operation');
          if (this.localSafety.confirmDestructiveActions)
            requireLocalConfirmation('tool_confirmation');
          break;
      }
      if (reasons.length === 0) reasons.push('personal_local_allowed');
      return this.persist(
        input,
        decision(input, this.policyVersion, outcome, obligations, reasons, confirmationId),
      );
    }

    switch (input.action) {
      case 'data_access':
        if (
          input.classification === 'pii' &&
          !authorityHasCapability(input.authority, `data.pii.${input.access}`)
        ) {
          outcome = 'deny';
          reasons.push('pii_capability_missing');
        }
        if (input.access === 'write') obligations.push('record_artifact_lineage');
        break;
      case 'pii_handling':
        if (!authorityHasCapability(input.authority, `data.pii.${input.operation}`)) {
          outcome = 'deny';
          reasons.push('pii_capability_missing');
        } else {
          obligations.push('redact_pii_in_audit');
        }
        break;
      case 'compute_allocation':
        obligations.push('meter_compute_usage');
        if (input.requiresApproval) {
          outcome = 'approval_required';
          reasons.push('compute_approval_required');
        }
        break;
      case 'secret_capability':
        obligations.push('redact_secret_shaped_output');
        if (
          !authorityHasCapability(input.authority, 'secret.autonomous') ||
          input.requiresApproval !== false
        ) {
          outcome = 'approval_required';
          reasons.push('secret_approval_required');
        }
        break;
      case 'connector_scope':
        obligations.push('audit_connector_operation');
        if (input.external || input.requiresApproval) {
          outcome = 'approval_required';
          reasons.push('connector_approval_required');
        }
        break;
      case 'model_promotion':
        outcome = 'approval_required';
        reasons.push('model_promotion_requires_approval');
        obligations.push('record_model_lineage');
        break;
      case 'deployment':
        outcome = 'approval_required';
        reasons.push('deployment_requires_approval');
        obligations.push('smoke_test_before_traffic');
        break;
      case 'artifact_retention':
        obligations.push('record_retention_policy');
        if (input.requiresApproval) {
          outcome = 'approval_required';
          reasons.push('retention_approval_required');
        }
        break;
      case 'external_network':
        outcome = 'approval_required';
        reasons.push('external_network_requires_approval');
        obligations.push('audit_external_request');
        break;
      case 'tool_use':
        obligations.push('audit_tool_operation');
        if (input.requiresApproval) {
          outcome = 'approval_required';
          reasons.push('tool_approval_required');
        }
        break;
    }

    if (reasons.length === 0) reasons.push('policy_allowed');
    return this.persist(input, decision(input, this.policyVersion, outcome, obligations, reasons));
  }

  private persist(input: PolicyInput, record: PolicyDecision): PolicyDecision {
    this.store.save({ decision: record, input: structuredClone(input) });
    return structuredClone(record);
  }

  get(decisionId: Id): StoredPolicyDecision | undefined {
    return this.store.get(decisionId);
  }

  assertAllowed(record: PolicyDecision): void {
    if (record.outcome === 'deny') {
      throw runtimeError(
        record.reasonCodes.includes('authority_denied')
          ? 'AUTHORITY_SCOPE_VIOLATION'
          : 'POLICY_DENIED',
        record.reasonCodes.join(', '),
        [record.decisionId],
      );
    }
    if (record.outcome === 'approval_required') {
      throw runtimeError('APPROVAL_REQUIRED', record.reasonCodes.join(', '), [record.decisionId]);
    }
    if (record.outcome === 'confirmation_required') {
      throw runtimeError('LOCAL_CONFIRMATION_REQUIRED', record.reasonCodes.join(', '), [
        record.decisionId,
        ...(record.confirmationId === undefined ? [] : [record.confirmationId]),
      ]);
    }
  }

  replay(input: PolicyInput, recorded: PolicyDecision): PolicyDecision {
    if (
      recorded.policyVersion !== this.policyVersion ||
      recorded.inputDigest !== sha256Digest(input)
    ) {
      throw runtimeError('POLICY_DENIED', 'Policy decision cannot be replayed for modified input');
    }
    const replayed = this.decide(input);
    if (
      replayed.policyVersion !== recorded.policyVersion ||
      replayed.inputDigest !== recorded.inputDigest ||
      replayed.outcome !== recorded.outcome ||
      canonicalJson(replayed.obligations) !== canonicalJson(recorded.obligations) ||
      canonicalJson(replayed.reasonCodes) !== canonicalJson(recorded.reasonCodes)
    ) {
      throw runtimeError('POLICY_DENIED', 'Policy decision replay produced a different result');
    }
    return replayed;
  }
}
