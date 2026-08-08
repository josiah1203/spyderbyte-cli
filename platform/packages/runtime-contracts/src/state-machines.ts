import type {
  ApprovalState,
  ArtifactState,
  BudgetReservationState,
  DeploymentState,
  InvocationState,
  WorkflowState,
} from './contracts.js';
import { runtimeError, type RuntimeError } from './errors.js';
import type { Id } from './ids.js';

export interface DomainEvent {
  eventName: string;
  aggregateVersion: number;
  payload: { from: string; to: string; action: string };
}

export interface TransitionResult<State extends string> {
  state: State;
  event: DomainEvent;
}

function transition<State extends string>(
  aggregate: string,
  current: State,
  action: string,
  next: State,
  aggregateVersion: number,
): TransitionResult<State> {
  return {
    state: next,
    event: {
      eventName: `${aggregate}.state-changed.v1`,
      aggregateVersion,
      payload: { from: current, to: next, action },
    },
  };
}

function rejectTransition(aggregate: string, current: string, action: string): never {
  throw runtimeError(
    'VALIDATION_INVALID_INPUT',
    `Illegal ${aggregate} transition ${current} -> ${action}`,
  );
}

export type WorkflowAction =
  | 'requestApproval'
  | 'approve'
  | 'beginExecution'
  | 'block'
  | 'resume'
  | 'complete'
  | 'fail'
  | 'cancel';

export function transitionWorkflow(
  current: WorkflowState,
  action: WorkflowAction,
  aggregateVersion = 1,
): TransitionResult<WorkflowState> {
  const next: Partial<Record<WorkflowState, Partial<Record<WorkflowAction, WorkflowState>>>> = {
    planning: {
      requestApproval: 'awaiting_approval',
      beginExecution: 'executing',
      block: 'blocked',
      fail: 'failed',
      cancel: 'cancelled',
    },
    awaiting_approval: { approve: 'executing', fail: 'failed', cancel: 'cancelled' },
    executing: {
      requestApproval: 'awaiting_approval',
      complete: 'completed',
      block: 'blocked',
      fail: 'failed',
      cancel: 'cancelled',
    },
    blocked: { resume: 'executing', fail: 'failed', cancel: 'cancelled' },
  };
  const nextState = next[current]?.[action];
  if (!nextState) return rejectTransition('workflow', current, action);
  return transition('workflow', current, action, nextState, aggregateVersion);
}

export type InvocationAction =
  | 'prepare'
  | 'start'
  | 'requestApproval'
  | 'approve'
  | 'validateReport'
  | 'succeed'
  | 'partiallySucceed'
  | 'block'
  | 'resume'
  | 'fail'
  | 'cancel';

export function transitionInvocation(
  current: InvocationState,
  action: InvocationAction,
  aggregateVersion = 1,
): TransitionResult<InvocationState> {
  const next: Partial<Record<InvocationState, Partial<Record<InvocationAction, InvocationState>>>> =
    {
      created: { prepare: 'preparing', fail: 'failed', cancel: 'cancelled' },
      preparing: {
        start: 'running',
        requestApproval: 'awaiting_approval',
        fail: 'failed',
        cancel: 'cancelled',
      },
      running: {
        requestApproval: 'awaiting_approval',
        validateReport: 'validating_report',
        block: 'blocked',
        fail: 'failed',
        cancel: 'cancelled',
      },
      awaiting_approval: { approve: 'running', fail: 'failed', cancel: 'cancelled' },
      validating_report: {
        succeed: 'succeeded',
        partiallySucceed: 'partially_succeeded',
        block: 'blocked',
        fail: 'failed',
        cancel: 'cancelled',
      },
      blocked: { resume: 'preparing', fail: 'failed', cancel: 'cancelled' },
    };
  const nextState = next[current]?.[action];
  if (!nextState) return rejectTransition('invocation', current, action);
  return transition('invocation', current, action, nextState, aggregateVersion);
}

export type ArtifactAction =
  | 'validate'
  | 'block'
  | 'unblock'
  | 'markStale'
  | 'supersede'
  | 'archive';

export function transitionArtifact(
  current: ArtifactState,
  action: ArtifactAction,
  aggregateVersion = 1,
): TransitionResult<ArtifactState> {
  const next: Partial<Record<ArtifactState, Partial<Record<ArtifactAction, ArtifactState>>>> = {
    draft: { validate: 'valid', block: 'blocked', archive: 'archived' },
    valid: { markStale: 'stale', supersede: 'superseded', archive: 'archived' },
    blocked: { unblock: 'draft', validate: 'valid', archive: 'archived' },
    stale: { supersede: 'superseded', archive: 'archived' },
    superseded: { archive: 'archived' },
  };
  const nextState = next[current]?.[action];
  if (!nextState) return rejectTransition('artifact', current, action);
  return transition('artifact', current, action, nextState, aggregateVersion);
}

export type ApprovalAction = 'approve' | 'reject' | 'expire' | 'revoke';

export function transitionApproval(
  current: ApprovalState,
  action: ApprovalAction,
  aggregateVersion = 1,
): TransitionResult<ApprovalState> {
  const next: Partial<Record<ApprovalState, Partial<Record<ApprovalAction, ApprovalState>>>> = {
    pending: { approve: 'approved', reject: 'rejected', expire: 'expired', revoke: 'revoked' },
    approved: { revoke: 'revoked' },
  };
  const nextState = next[current]?.[action];
  if (!nextState) return rejectTransition('approval', current, action);
  return transition('approval', current, action, nextState, aggregateVersion);
}

export type DeploymentAction =
  | 'provision'
  | 'smokePass'
  | 'startCanary'
  | 'ramp'
  | 'activate'
  | 'rollback'
  | 'fail';

export function transitionDeployment(
  current: DeploymentState,
  action: DeploymentAction,
  aggregateVersion = 1,
): TransitionResult<DeploymentState> {
  const next: Partial<Record<DeploymentState, Partial<Record<DeploymentAction, DeploymentState>>>> =
    {
      requested: { provision: 'provisioning', fail: 'failed' },
      provisioning: { smokePass: 'smoke_testing', fail: 'failed' },
      smoke_testing: { startCanary: 'canary', fail: 'failed' },
      canary: { ramp: 'ramping', rollback: 'rolled_back', fail: 'failed' },
      ramping: { activate: 'active', rollback: 'rolled_back', fail: 'failed' },
      active: { rollback: 'rolled_back' },
    };
  const nextState = next[current]?.[action];
  if (!nextState) return rejectTransition('deployment', current, action);
  return transition('deployment', current, action, nextState, aggregateVersion);
}

export type BudgetReservationAction = 'reserve' | 'consume' | 'reconcile' | 'release' | 'reject';

export function transitionBudgetReservation(
  current: BudgetReservationState,
  action: BudgetReservationAction,
  aggregateVersion = 1,
): TransitionResult<BudgetReservationState> {
  const next: Partial<
    Record<BudgetReservationState, Partial<Record<BudgetReservationAction, BudgetReservationState>>>
  > = {
    requested: { reserve: 'reserved', reject: 'rejected' },
    reserved: { consume: 'partially_consumed', reconcile: 'reconciled', release: 'released' },
    partially_consumed: { reconcile: 'reconciled', release: 'released' },
  };
  const nextState = next[current]?.[action];
  if (!nextState) return rejectTransition('budget reservation', current, action);
  return transition('budget-reservation', current, action, nextState, aggregateVersion);
}

export function assertTierParentChild(parentTier: number, childTier: number): void {
  if (parentTier === 0 && childTier !== 1)
    throw runtimeError('INVOCATION_TIER_VIOLATION', 'Tier 0 may invoke only Tier 1');
  if (parentTier === 1 && childTier !== 2)
    throw runtimeError('INVOCATION_TIER_VIOLATION', 'Tier 1 may invoke only Tier 2');
  if (parentTier === 2)
    throw runtimeError('INVOCATION_TIER_VIOLATION', 'Tier 2 may not invoke agents');
}

export function assertSameTenant(parentTenantId: Id, childTenantId: Id): void {
  if (parentTenantId !== childTenantId)
    throw runtimeError('INVOCATION_INVALID_PARENT', 'Parent and child tenants differ');
}

export function isTerminalState(state: string): boolean {
  return [
    'completed',
    'failed',
    'cancelled',
    'succeeded',
    'partially_succeeded',
    'archived',
    'approved',
    'rejected',
    'expired',
    'revoked',
    'reconciled',
    'released',
    'rolled_back',
  ].includes(state);
}

export type TransitionFailure = RuntimeError;
