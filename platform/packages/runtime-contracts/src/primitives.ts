import type { ActorType } from './contracts.js';
import type { Id } from './ids.js';

export interface TenantRef {
  tenantId: Id;
  workspaceId: Id;
}

/**
 * Trusted composition mode for a workspace. This is deliberately separate from UI layout
 * preferences: a browser can choose a layout, but it cannot elevate a workspace into an
 * organization context.
 */
export type WorkspaceMode = 'personal_local' | 'organization_local' | 'organization_hosted';

export interface WorkspaceContext extends TenantRef {
  mode: WorkspaceMode;
  organizationId?: Id;
}

export interface LocalSafetySettings {
  confirmExternalNetwork: boolean;
  confirmExternalWrites: boolean;
  confirmDestructiveActions: boolean;
  confirmSecretUse: boolean;
}

export interface Actor {
  actorId: Id;
  type: ActorType;
  displayName?: string;
}

export type Currency = string & { readonly __brand: 'Currency' };

export interface Money {
  amountMinor: number;
  currency: Currency;
}

export type QuantityUnit =
  | 'bytes'
  | 'tokens'
  | 'milliseconds'
  | 'seconds'
  | 'cpuMillicores'
  | 'memoryBytes'
  | 'storageBytes'
  | 'requests'
  | 'items';

export interface Quantity {
  value: number;
  unit: QuantityUnit;
}

export type ResourceKind =
  | 'workspace'
  | 'dataset'
  | 'artifact'
  | 'repository'
  | 'compute'
  | 'model'
  | 'deployment'
  | 'connector'
  | 'secret';

export interface ResourceSelector {
  kind: ResourceKind;
  id: string;
  version?: number;
}

export class ContractValueError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'ContractValueError';
  }
}

export function makeCurrency(value: string): Currency {
  if (!/^[A-Z]{3}$/.test(value)) {
    throw new ContractValueError(`Unsupported currency code: ${value}`);
  }
  return value as Currency;
}

export function makeMoney(amountMinor: number, currency: string): Money {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new ContractValueError('Money amount must be a non-negative safe integer');
  }
  return { amountMinor, currency: makeCurrency(currency) };
}

export function addMoney(left: Money, right: Money): Money {
  if (left.currency !== right.currency) {
    throw new ContractValueError('Cannot add money with different currencies');
  }
  return makeMoney(left.amountMinor + right.amountMinor, left.currency);
}

export function makeQuantity(value: number, unit: QuantityUnit): Quantity {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ContractValueError('Quantity value must be a non-negative safe integer');
  }
  return { value, unit };
}

export function assertTenant(tenant: TenantRef): TenantRef {
  if (!tenant.tenantId || !tenant.workspaceId) {
    throw new ContractValueError('Tenant and workspace identifiers are required');
  }
  return tenant;
}
