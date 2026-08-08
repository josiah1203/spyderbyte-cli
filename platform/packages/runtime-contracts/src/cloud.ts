import type { JsonValue } from './json.js';
import type { HashSha256, Id } from './ids.js';
import type { Actor, Money, Quantity, TenantRef } from './primitives.js';

/** Billing modes supported by the managed execution account boundary. */
export type CloudBillingMode = 'stripe' | 'prepaid';

export type CloudAccountPlan = 'individual_free' | 'team' | 'enterprise';

export type CloudRunState =
  | 'estimated'
  | 'awaiting_approval'
  | 'approved'
  | 'switching'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type CloudBillingState = 'authorized' | 'charged' | 'reconciled' | 'failed';

export interface CloudResourceLimitsV1 {
  readonly maxCpuMillicores: number;
  readonly maxMemoryBytes: number;
  readonly maxGpuCount: number;
  readonly maxWallTimeMs: number;
  readonly maxOutputBytes: number;
  readonly maxProcessCount: number;
}

export interface CloudAccountV1 {
  readonly schemaVersion: 1;
  readonly accountId: Id;
  readonly tenant: TenantRef;
  readonly owner: Actor;
  readonly plan: CloudAccountPlan;
  readonly billingMode: CloudBillingMode;
  readonly currency: Money['currency'];
  readonly resourceLimits: CloudResourceLimitsV1;
  readonly stripeCustomerId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CloudSessionV1 {
  readonly schemaVersion: 1;
  readonly sessionId: Id;
  readonly accountId: Id;
  readonly tenant: TenantRef;
  readonly actor: Actor;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface CloudLoginResultV1 {
  readonly session: CloudSessionV1;
  /** Ephemeral credential; only its digest is retained by the account service. */
  readonly accessToken: string;
}

export interface CloudComputeRequestV1 {
  readonly cpuMillicores: number;
  readonly memoryBytes: number;
  readonly gpuCount: number;
  readonly wallTimeMs: number;
  readonly maxOutputBytes: number;
  readonly maxProcessCount: number;
}

export interface CloudRunRequestV1 {
  readonly schemaVersion: 1;
  readonly runId: Id;
  readonly localAttemptId: Id;
  readonly tenant: TenantRef;
  readonly actor: Actor;
  readonly requestedAction: string;
  readonly provider: 'openrouter';
  readonly modelId: string;
  readonly prompt: string;
  readonly maxOutputTokens: number;
  readonly compute: CloudComputeRequestV1;
  readonly maxCost: Money;
  readonly outputMediaType: string;
  readonly idempotencyKey: string;
}

export interface CloudEstimateV1 {
  readonly schemaVersion: 1;
  readonly estimateId: Id;
  readonly runId: Id;
  readonly tenant: TenantRef;
  readonly actionDigest: HashSha256;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly computeSeconds: number;
  readonly llm: Money;
  readonly compute: Money;
  readonly storage: Money;
  readonly platformFee: Money;
  readonly total: Money;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export interface CloudApprovalV1 {
  readonly schemaVersion: 1;
  readonly approvalId: Id;
  readonly estimateId: Id;
  readonly runId: Id;
  readonly tenant: TenantRef;
  readonly actionDigest: HashSha256;
  readonly approvedBy: Actor;
  readonly approvedAt: string;
  readonly expiresAt: string;
}

export interface CloudRunEventV1 {
  readonly schemaVersion: 1;
  readonly eventId: Id;
  readonly runId: Id;
  readonly cloudAttemptId: Id;
  readonly tenant: TenantRef;
  readonly sequence: number;
  readonly eventName:
    | 'estimate.created'
    | 'approval.required'
    | 'run.switched'
    | 'run.progress'
    | 'run.artifact.created'
    | 'usage.recorded'
    | 'billing.reconciled'
    | 'run.completed'
    | 'run.failed';
  readonly payload: JsonValue;
  readonly occurredAt: string;
}

export interface CloudArtifactReceiptV1 {
  readonly reference: {
    readonly schemaVersion: 1;
    readonly tenant: TenantRef;
    readonly artifactId: Id;
    readonly version: number;
    readonly contentHash: HashSha256;
    readonly mediaType: string;
    readonly sizeBytes: number;
    readonly createdAt: string;
    readonly uri?: string;
  };
  readonly objectKey: string;
}

export interface CloudUsageRecordV1 {
  readonly schemaVersion: 1;
  readonly usageId: Id;
  readonly estimateId: Id;
  readonly runId: Id;
  readonly tenant: TenantRef;
  readonly quantities: readonly Quantity[];
  readonly amount: Money;
  readonly providerRequestId?: string;
  readonly idempotencyKey: string;
  readonly recordedAt: string;
}

export interface CloudBillingRecordV1 {
  readonly schemaVersion: 1;
  readonly billingId: Id;
  readonly runId: Id;
  readonly tenant: TenantRef;
  readonly mode: CloudBillingMode;
  readonly state: CloudBillingState;
  readonly estimated: Money;
  readonly actual: Money;
  readonly providerPaymentId?: string;
  readonly idempotencyKey: string;
  readonly authorizedAt: string;
  readonly reconciledAt?: string;
}

export interface CloudRunContinuityV1 {
  readonly schemaVersion: 1;
  readonly runId: Id;
  readonly localAttemptId: Id;
  readonly cloudAttemptId: Id;
  readonly tenant: TenantRef;
  readonly state: CloudRunState;
  readonly estimate: CloudEstimateV1;
  readonly events: readonly CloudRunEventV1[];
  readonly artifacts: readonly CloudArtifactReceiptV1[];
  readonly usage?: CloudUsageRecordV1;
  readonly billing?: CloudBillingRecordV1;
  readonly startedAt?: string;
  readonly completedAt?: string;
}
