import {
  runtimeError,
  type RuntimeEvent,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import type { StateStore } from '@agentic-platform/state';

export interface SubscriptionRequest {
  readonly tenant: TenantRef;
  readonly afterCursor?: number;
  readonly topics?: readonly string[];
  readonly maxEvents?: number;
}

export interface SubscriptionPage {
  readonly cursor: number;
  readonly events: readonly RuntimeEvent[];
  readonly gapDetected: boolean;
  readonly refreshRequired: boolean;
}

export interface SubscriptionAuthorizer {
  authorize(request: SubscriptionRequest): Promise<void> | void;
}

export class AllowAllSubscriptionAuthorizer implements SubscriptionAuthorizer {
  authorize(): void {
    return undefined;
  }
}

export class EventSubscriptionGateway {
  private readonly state: StateStore;
  private readonly authorizer: SubscriptionAuthorizer;
  private readonly maxBuffer: number;
  private retentionFloor = new Map<string, number>();

  constructor(options: {
    state: StateStore;
    authorizer?: SubscriptionAuthorizer;
    maxBuffer?: number;
  }) {
    this.state = options.state;
    this.authorizer = options.authorizer ?? new AllowAllSubscriptionAuthorizer();
    this.maxBuffer = options.maxBuffer ?? 100;
    if (!Number.isSafeInteger(this.maxBuffer) || this.maxBuffer < 1) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Subscription buffer must be positive');
    }
  }

  setRetentionFloor(tenant: TenantRef, cursor: number): void {
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Retention cursor must be non-negative');
    }
    this.retentionFloor.set(`${tenant.tenantId}:${tenant.workspaceId}`, cursor);
  }

  async replay(request: SubscriptionRequest): Promise<SubscriptionPage> {
    await this.authorizer.authorize(request);
    const afterCursor = request.afterCursor ?? 0;
    const floor =
      this.retentionFloor.get(`${request.tenant.tenantId}:${request.tenant.workspaceId}`) ?? 0;
    const gapDetected = afterCursor < floor;
    const events = await this.state.transaction((transaction) =>
      transaction.events.list(request.tenant, gapDetected ? floor : afterCursor),
    );
    const maxEvents = Math.min(request.maxEvents ?? this.maxBuffer, this.maxBuffer);
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) {
      throw runtimeError('VALIDATION_INVALID_INPUT', 'Subscription maxEvents must be positive');
    }
    const filtered: typeof events = [];
    let cursor = gapDetected ? floor : afterCursor;
    for (const stored of events) {
      if (filtered.length >= maxEvents) break;
      cursor = stored.streamSequence;
      if (
        request.topics === undefined ||
        request.topics.length === 0 ||
        request.topics.includes(stored.event.eventName.split('.')[0] ?? stored.event.eventName)
      ) {
        filtered.push(stored);
      }
    }
    return {
      cursor,
      events: filtered.map(({ event }) => structuredClone(event)),
      gapDetected,
      refreshRequired: gapDetected,
    };
  }

  async *subscribe(
    request: SubscriptionRequest,
    signal?: AbortSignal,
  ): AsyncIterable<SubscriptionPage> {
    let cursor = request.afterCursor ?? 0;
    while (!signal?.aborted) {
      const page = await this.replay({ ...request, afterCursor: cursor });
      if (page.gapDetected || page.events.length > 0) {
        yield page;
        cursor = page.cursor;
      } else {
        cursor = Math.max(cursor, page.cursor);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  }
}

export function assertSubscriptionTenant(request: SubscriptionRequest, tenant: TenantRef): void {
  if (
    request.tenant.tenantId !== tenant.tenantId ||
    request.tenant.workspaceId !== tenant.workspaceId
  ) {
    throw runtimeError('POLICY_DENIED', 'Subscription tenant does not match the authorized tenant');
  }
}
