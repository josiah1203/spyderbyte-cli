/**
 * Managed execution uses the same tenant-safe worker and workflow ports as
 * local execution. These aliases make the hosted composition explicit at the
 * cloud boundary without introducing a second task protocol.
 */
export { HostedWorkerPool as HostedCloudWorkerPool } from '@agentic-platform/backends';
export { ExternalWorkflowEngine as HostedWorkflowBackend } from '@agentic-platform/runtime-domain';
import type { ArtifactObjectStore } from '@agentic-platform/artifact-registry';
import type { StateStore } from '@agentic-platform/state';
import type { CloudAccountService } from './accounts.js';
import { CloudBillingCoordinator, CloudPricingCatalog, StripeBillingAdapter } from './billing.js';
import type { CloudEventPublisher } from './events.js';
import {
  StateStoreCloudBillingStateStore,
  StateStoreCloudPrepaidBalanceLedger,
  StateStoreCloudRuntimeStore,
  StateStoreCloudUsageLedger,
} from './persistence.js';
import type { CloudComputeProvider, CloudInferenceProvider } from './providers.js';
import { CloudRunContinuityService } from './managed-execution.js';

export interface HostedCloudRuntimeOptions {
  readonly accounts: CloudAccountService;
  readonly inference: CloudInferenceProvider;
  readonly compute: CloudComputeProvider;
  readonly artifacts: ArtifactObjectStore;
  readonly events: CloudEventPublisher;
  readonly pricing: CloudPricingCatalog;
  readonly state: StateStore;
  readonly stripe?: StripeBillingAdapter;
  readonly estimateTtlMs?: number;
  readonly clock?: () => string;
}

/**
 * Compose hosted execution with durable state while leaving identity, object,
 * event, inference, compute, and billing transports injectable.
 */
export function createHostedCloudRuntime(options: HostedCloudRuntimeOptions): {
  readonly service: CloudRunContinuityService;
  readonly billing: CloudBillingCoordinator;
} {
  const billing = new CloudBillingCoordinator({
    usageLedger: new StateStoreCloudUsageLedger(options.state),
    prepaidLedger: new StateStoreCloudPrepaidBalanceLedger(options.state),
    state: new StateStoreCloudBillingStateStore(options.state),
    ...(options.stripe === undefined ? {} : { stripe: options.stripe }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const service = new CloudRunContinuityService({
    accounts: options.accounts,
    inference: options.inference,
    compute: options.compute,
    artifacts: options.artifacts,
    events: options.events,
    pricing: options.pricing,
    billing,
    store: new StateStoreCloudRuntimeStore(options.state),
    ...(options.estimateTtlMs === undefined ? {} : { estimateTtlMs: options.estimateTtlMs }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  return { service, billing };
}
