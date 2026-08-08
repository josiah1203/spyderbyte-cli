import { createHash } from 'node:crypto';
import {
  isJsonValue,
  newSortableId,
  runtimeError,
  validateContract,
  type HashSha256,
  type JsonValue,
  type RuntimeCommand,
  type RuntimeEvent,
  type TenantRef,
} from '@agentic-platform/runtime-contracts';
import type { StateStore, StateTransaction, StoredEvent } from '@agentic-platform/state';

export interface CommandHandlerContext {
  readonly command: RuntimeCommand;
  readonly transaction: StateTransaction;
}

export interface CommandHandlerResult {
  readonly result: JsonValue;
  readonly events: readonly RuntimeEvent[];
}

export interface CommandHandler {
  readonly commandType: string;
  handle(context: CommandHandlerContext): Promise<CommandHandlerResult>;
}

export type CommandAuthorizer = (command: RuntimeCommand) => Promise<void> | void;

export interface DispatchResult {
  readonly commandId: RuntimeCommand['commandId'];
  readonly idempotencyKey: string;
  readonly replayed: boolean;
  readonly result: JsonValue;
  readonly events: readonly StoredEvent[];
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
    .join(',')}}`;
}

export function commandRequestDigest(command: RuntimeCommand): HashSha256 {
  const digestInput: JsonValue = {
    schemaVersion: command.schemaVersion,
    commandType: command.commandType,
    tenant: {
      tenantId: command.tenant.tenantId,
      workspaceId: command.tenant.workspaceId,
    },
    actor: {
      actorId: command.actor.actorId,
      type: command.actor.type,
      ...(command.actor.displayName !== undefined
        ? { displayName: command.actor.displayName }
        : {}),
    },
    correlationId: command.correlationId,
    ...(command.causationId !== undefined ? { causationId: command.causationId } : {}),
    payload: command.payload,
  };
  return createHash('sha256').update(canonicalJson(digestInput)).digest('hex') as HashSha256;
}

function sameTenant(left: TenantRef, right: TenantRef): boolean {
  return left.tenantId === right.tenantId && left.workspaceId === right.workspaceId;
}

function validationDetails(errors: readonly { instancePath?: string; message?: string }[]): string {
  return errors
    .map((error) => `${error.instancePath ?? '/'} ${error.message ?? 'invalid'}`)
    .join('; ');
}

export class CommandDispatcher {
  private readonly handlers = new Map<string, CommandHandler>();

  constructor(
    private readonly state: StateStore,
    private readonly authorize: CommandAuthorizer = () => undefined,
  ) {}

  register(handler: CommandHandler): void {
    if (this.handlers.has(handler.commandType)) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        `Command handler already registered: ${handler.commandType}`,
      );
    }
    this.handlers.set(handler.commandType, handler);
  }

  async dispatch(command: RuntimeCommand): Promise<DispatchResult> {
    const commandValidation = validateContract('RuntimeCommand', command);
    if (!commandValidation.valid) {
      throw runtimeError('VALIDATION_SCHEMA_MISMATCH', validationDetails(commandValidation.errors));
    }

    const handler = this.handlers.get(command.commandType);
    if (!handler) {
      throw runtimeError(
        'VALIDATION_INVALID_INPUT',
        `No handler registered for ${command.commandType}`,
      );
    }
    await this.authorize(command);

    const requestDigest = commandRequestDigest(command);
    const now = command.issuedAt;
    return this.state.transaction(async (transaction) => {
      const existing = await transaction.commands.get(command.tenant, command.idempotencyKey);
      if (existing?.requestDigest !== undefined && existing.requestDigest !== requestDigest) {
        throw runtimeError(
          'CONCURRENCY_STALE_VERSION',
          `Idempotency key ${command.idempotencyKey} was used with a different request digest`,
        );
      }
      if (existing?.result !== undefined) {
        return {
          commandId: command.commandId,
          idempotencyKey: command.idempotencyKey,
          replayed: true,
          result: existing.result,
          events: [],
        } satisfies DispatchResult;
      }
      if (existing) {
        throw runtimeError(
          'CONCURRENCY_STALE_VERSION',
          `Command ${command.idempotencyKey} is already in progress`,
        );
      }

      await transaction.commands.reserve(command, requestDigest, now);
      const execution = await handler.handle({ command, transaction });
      if (!isJsonValue(execution.result)) {
        throw runtimeError(
          'VALIDATION_SCHEMA_MISMATCH',
          'Command handler returned a non-JSON result',
        );
      }

      const storedEvents: StoredEvent[] = [];
      for (const event of execution.events) {
        const eventValidation = validateContract('RuntimeEvent', event);
        if (!eventValidation.valid) {
          throw runtimeError(
            'VALIDATION_SCHEMA_MISMATCH',
            validationDetails(eventValidation.errors),
          );
        }
        if (!sameTenant(event.tenant, command.tenant)) {
          throw runtimeError('POLICY_DENIED', 'Command handlers cannot emit cross-tenant events');
        }
        if (!Number.isSafeInteger(event.aggregateVersion) || event.aggregateVersion < 1) {
          throw runtimeError(
            'VALIDATION_INVALID_INPUT',
            `Event ${event.eventId} must declare a positive aggregate version`,
          );
        }
        const stored = await transaction.events.append(event, event.aggregateVersion - 1);
        await transaction.outbox.enqueue(stored.event, 'runtime.events', now);
        storedEvents.push(stored);
      }
      await transaction.commands.complete(
        command.tenant,
        command.idempotencyKey,
        execution.result,
        now,
      );
      return {
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        replayed: false,
        result: execution.result,
        events: storedEvents,
      } satisfies DispatchResult;
    });
  }
}

export function createCommandId(): RuntimeCommand['commandId'] {
  return newSortableId();
}
