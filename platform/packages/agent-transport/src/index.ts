import {
  agent,
  methods,
  ndJsonStream,
  type AgentApp,
  type AgentConnection,
  type AgentContext,
  type AgentRequestContext,
  type AgentNotificationContext,
  type ContentBlock,
  type PlanEntry,
  type PromptRequest,
  type SessionId,
  type Stream,
} from '@agentclientprotocol/sdk';
import type { Readable, Writable } from 'node:stream';
import { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream';
import process from 'node:process';
import type { AgentInterface, Id, JsonValue } from '@agentic-platform/runtime-contracts';
import type { RunDetail, SpyderbyteClient } from '@agentic-platform/client-sdk';

const ACP_PROTOCOL_VERSION = 1;
const DEFAULT_AGENT_VERSION = '0.0.0';

export type AcpAgentClient = Pick<
  SpyderbyteClient,
  | 'agentSession'
  | 'cancelRun'
  | 'createProject'
  | 'followRun'
  | 'projectAgentSession'
  | 'projectConversation'
  | 'projects'
  | 'sendMessage'
>;

export interface AcpAgentTransportOptions {
  readonly client: AcpAgentClient;
  readonly projectId?: Id;
  readonly agentVersion?: string;
  readonly defaultProjectName?: string;
  readonly input?: Readable;
  readonly output?: Writable;
}

interface AcpSessionBinding {
  readonly sessionId: SessionId;
  readonly projectId: Id;
  readonly cwd: string;
  readonly workspaceId?: Id;
  client?: AgentContext;
  active?: {
    readonly runId: Id;
    readonly assistantMessageId: string;
    readonly controller: AbortController;
  };
}

interface AcceptedTurn {
  readonly sessionId: SessionId;
  readonly projectId: Id;
  readonly runId: Id;
  readonly userMessageId?: string;
  readonly assistantMessageId?: string;
  readonly response?: Record<string, unknown>;
}

interface SessionSnapshotRecord {
  readonly sessionId: SessionId;
  readonly projectId?: Id;
  readonly workspaceId?: Id;
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function idValue(value: unknown, label: string): Id {
  const candidate = stringValue(value);
  if (candidate === undefined) throw new Error(`${label} was not returned by the local API`);
  return candidate as Id;
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function nestedMetaValue(meta: unknown, key: string): unknown {
  const root = record(meta);
  const spyderbyte = record(root?.['spyderbyte']);
  return spyderbyte?.[key] ?? root?.[key];
}

function sessionFromResponse(value: JsonValue, fallbackProjectId?: Id): SessionSnapshotRecord {
  const root = record(value);
  const session = record(root?.['session']);
  if (session === undefined) throw new Error('The local API did not return an agent session');
  return {
    sessionId: idValue(session['sessionId'], 'Agent session id'),
    ...(session['projectId'] === undefined && fallbackProjectId === undefined
      ? {}
      : { projectId: idValue(session['projectId'] ?? fallbackProjectId, 'Project id') }),
    ...(session['workspaceId'] === undefined
      ? {}
      : { workspaceId: idValue(session['workspaceId'], 'Workspace id') }),
  };
}

function acceptedTurnFromResponse(value: JsonValue): AcceptedTurn {
  const root = record(value);
  if (root === undefined) throw new Error('The local API returned an invalid agent response');
  const response = record(root['response']);
  const userMessageId = stringValue(root['userMessageId']);
  const assistantMessageId = stringValue(root['assistantMessageId']);
  return {
    sessionId: stringValue(root['sessionId']) ?? idValue(root['conversationId'], 'Session id'),
    projectId: idValue(root['projectId'], 'Project id'),
    runId: idValue(root['runId'], 'Run id'),
    ...(userMessageId === undefined ? {} : { userMessageId }),
    ...(assistantMessageId === undefined ? {} : { assistantMessageId }),
    ...(response === undefined ? {} : { response }),
  };
}

function promptText(prompt: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of prompt) {
    if (block.type === 'text') {
      if (block.text.trim().length > 0) parts.push(block.text.trim());
      continue;
    }
    if (block.type === 'resource_link') {
      parts.push(`[resource: ${block.uri}]`);
      continue;
    }
    if (block.type === 'resource') {
      if ('text' in block.resource && typeof block.resource.text === 'string') {
        parts.push(block.resource.text);
      } else {
        parts.push(`[resource: ${block.resource.uri}]`);
      }
      continue;
    }
    throw new Error(`ACP content type ${block.type} is not supported by Spyderbyte yet`);
  }
  const text = parts.join('\n\n').trim();
  if (text.length === 0) throw new Error('ACP prompt must contain text or a readable resource');
  return text;
}

function planEntries(response: Record<string, unknown> | undefined): PlanEntry[] {
  const plan = record(response?.['plan']);
  const steps = arrayValue(plan?.['steps']);
  const entries = steps.flatMap((value, index): PlanEntry[] => {
    const step = record(value);
    if (step === undefined) return [];
    const title = stringValue(step['title']) ?? stringValue(step['description']);
    if (title === undefined) return [];
    const tier = typeof step['tier'] === 'number' ? step['tier'] : index === 0 ? 0 : 1;
    return [
      {
        content: title,
        priority: tier === 0 ? 'high' : tier === 1 ? 'medium' : 'low',
        status: index === 0 ? 'in_progress' : 'pending',
      },
    ];
  });
  return entries.length > 0
    ? entries
    : [
        {
          content: 'Process the request through the Spyderbyte Run pipeline.',
          priority: 'high',
          status: 'in_progress',
        },
      ];
}

function completedPlan(entries: readonly PlanEntry[]): PlanEntry[] {
  return entries.map((entry) => ({ ...entry, status: 'completed' }));
}

function runState(detail: RunDetail): string {
  return String(detail.run.state);
}

function terminalRunState(state: string): boolean {
  return ['succeeded', 'failed', 'cancelled', 'timed_out', 'partially_succeeded'].includes(state);
}

function permissionFromSnapshot(value: unknown): Record<string, unknown> | undefined {
  const permission = record(value);
  return permission === undefined || stringValue(permission['permissionRequestId']) === undefined
    ? undefined
    : permission;
}

function pendingPermission(value: JsonValue): Record<string, unknown> | undefined {
  const root = record(value);
  return arrayValue(root?.['permissions'])
    .map(permissionFromSnapshot)
    .filter(
      (permission): permission is Record<string, unknown> => permission?.['state'] === 'pending',
    )
    .at(-1);
}

export class AcpAgentTransport {
  readonly app: AgentApp;

  private readonly sessions = new Map<SessionId, AcpSessionBinding>();
  private readonly client: AcpAgentClient;
  private readonly defaultProjectId: Id | undefined;
  private readonly agentVersion: string;
  private readonly defaultProjectName: string;

  constructor(options: AcpAgentTransportOptions) {
    this.client = options.client;
    this.defaultProjectId = options.projectId;
    this.agentVersion = options.agentVersion ?? DEFAULT_AGENT_VERSION;
    this.defaultProjectName = options.defaultProjectName ?? 'Spyderbyte ACP project';
    this.app = agent({ name: 'spyderbyte-acp' })
      .onRequest(methods.agent.initialize, () => this.initialize())
      .onRequest(methods.agent.session.new, (context) => this.newSession(context))
      .onRequest(methods.agent.session.load, (context) => this.loadSession(context))
      .onRequest(methods.agent.session.prompt, (context) => this.prompt(context))
      .onRequest(methods.agent.session.close, (context) => this.closeSession(context))
      .onNotification(methods.agent.session.cancel, (context) => this.cancel(context));
  }

  connect(stream: Stream): AgentConnection {
    return this.app.connect(stream);
  }

  async serveStdio(
    input: Readable = process.stdin as unknown as Readable,
    output: Writable = process.stdout as unknown as Writable,
  ): Promise<void> {
    const stream = ndJsonStream(
      NodeWritable.toWeb(output) as unknown as WritableStream<Uint8Array>,
      NodeReadable.toWeb(input) as unknown as ReadableStream<Uint8Array>,
    );
    const connection = this.connect(stream);
    await connection.closed;
  }

  private initialize() {
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { embeddedContext: true },
      },
      authMethods: [],
      agentInfo: {
        name: 'spyderbyte',
        title: 'Spyderbyte Agent',
        version: this.agentVersion,
      },
      _meta: {
        spyderbyte: {
          transport: 'acp-v1',
          execution: 'shared-run-pipeline',
          sourceInterface: 'acp' satisfies AgentInterface,
        },
      },
    };
  }

  private async resolveProjectId(meta: unknown): Promise<Id> {
    const requested = nestedMetaValue(meta, 'projectId');
    if (requested !== undefined) return idValue(requested, 'ACP project id');
    if (this.defaultProjectId !== undefined) return this.defaultProjectId;

    const projects = await this.client.projects();
    const root = record(projects);
    const values = Array.isArray(projects) ? projects : arrayValue(root?.['projects']);
    for (const value of values) {
      const project = record(value);
      const candidate = project?.['projectId'] ?? project?.['id'];
      if (candidate !== undefined) return idValue(candidate, 'Project id');
    }

    const created = await this.client.createProject(
      this.defaultProjectName,
      'Project context for an ACP-connected Spyderbyte session.',
    );
    const createdRecord = record(created);
    const createdProject = record(createdRecord?.['project']);
    return idValue(
      createdProject?.['projectId'] ?? createdRecord?.['projectId'] ?? createdRecord?.['id'],
      'Created ACP project id',
    );
  }

  private async bindSession(
    sessionId: SessionId,
    projectId: Id,
    cwd: string,
    clientContext: AgentContext,
  ): Promise<AcpSessionBinding> {
    const snapshot = sessionFromResponse(
      await this.client.projectAgentSession(projectId),
      projectId,
    );
    if (snapshot.sessionId !== sessionId && sessionId !== '') {
      sessionId = snapshot.sessionId;
    }
    const binding: AcpSessionBinding = {
      sessionId,
      projectId: snapshot.projectId ?? projectId,
      cwd,
      ...(snapshot.workspaceId === undefined ? {} : { workspaceId: snapshot.workspaceId }),
      client: clientContext,
    };
    this.sessions.set(sessionId, binding);
    return binding;
  }

  private async newSession(
    context: AgentRequestContext<import('@agentclientprotocol/sdk').NewSessionRequest>,
  ) {
    const projectId = await this.resolveProjectId(context.params._meta);
    const snapshot = sessionFromResponse(
      await this.client.projectAgentSession(projectId),
      projectId,
    );
    const binding: AcpSessionBinding = {
      sessionId: snapshot.sessionId,
      projectId: snapshot.projectId ?? projectId,
      cwd: context.params.cwd,
      ...(snapshot.workspaceId === undefined ? {} : { workspaceId: snapshot.workspaceId }),
      client: context.client,
    };
    this.sessions.set(binding.sessionId, binding);
    return {
      sessionId: binding.sessionId,
      _meta: {
        spyderbyte: {
          projectId: binding.projectId,
          workspaceId: binding.workspaceId,
          cwd: binding.cwd,
        },
      },
    };
  }

  private async loadSession(
    context: AgentRequestContext<import('@agentclientprotocol/sdk').LoadSessionRequest>,
  ) {
    let binding = this.sessions.get(context.params.sessionId);
    if (binding === undefined) {
      const snapshot = sessionFromResponse(
        await this.client.agentSession(context.params.sessionId as Id),
      );
      if (snapshot.projectId === undefined) {
        throw new Error('The persisted ACP session is not associated with a project');
      }
      binding = await this.bindSession(
        snapshot.sessionId,
        snapshot.projectId,
        context.params.cwd,
        context.client,
      );
    } else {
      binding = { ...binding, client: context.client, cwd: context.params.cwd };
      this.sessions.set(binding.sessionId, binding);
    }
    await this.replayConversation(binding, context.client);
    return {
      _meta: { spyderbyte: { projectId: binding.projectId, workspaceId: binding.workspaceId } },
    };
  }

  private async replayConversation(binding: AcpSessionBinding, clientContext: AgentContext) {
    const conversation = record(await this.client.projectConversation(binding.projectId));
    for (const value of arrayValue(conversation?.['messages'])) {
      const message = record(value);
      const messageId = stringValue(message?.['messageId']);
      const text = stringValue(message?.['text']);
      const role = message?.['role'];
      if (messageId === undefined || text === undefined) continue;
      if (role !== 'user' && role !== 'assistant') continue;
      await clientContext.notify(methods.client.session.update, {
        sessionId: binding.sessionId,
        update: {
          sessionUpdate: role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
          messageId,
          content: { type: 'text', text },
        },
      });
    }
  }

  private async prompt(context: AgentRequestContext<PromptRequest>) {
    const binding = this.sessions.get(context.params.sessionId);
    if (binding === undefined) throw new Error('ACP session was not found');
    if (context.signal.aborted) return { stopReason: 'cancelled' as const };
    if (binding.active !== undefined) throw new Error('The ACP session already has an active Run');

    const text = promptText(context.params.prompt);
    const accepted = acceptedTurnFromResponse(
      await this.client.sendMessage(binding.projectId, text, undefined, 'acp'),
    );
    const runId = accepted.runId;
    const assistantMessageId = accepted.assistantMessageId ?? `${runId}:assistant`;
    const controller = new AbortController();
    binding.active = { runId, assistantMessageId, controller };
    binding.client = context.client;

    const abort = (): void => {
      controller.abort();
      void this.client.cancelRun(runId, 'ACP prompt cancelled').catch(() => undefined);
    };
    context.signal.addEventListener('abort', abort, { once: true });
    const entries = planEntries(accepted.response);
    const seenLogs = new Set<string>();
    try {
      await context.client.notify(methods.client.session.update, {
        sessionId: binding.sessionId,
        update: {
          sessionUpdate: 'user_message_chunk',
          ...(accepted.userMessageId === undefined ? {} : { messageId: accepted.userMessageId }),
          content: { type: 'text', text },
        },
      });
      await this.sendPlan(context.client, binding.sessionId, entries);

      for await (const detail of this.client.followRun(runId, {
        signal: controller.signal,
        maxReconnects: 3,
      })) {
        await this.emitRunLogs(context.client, binding, detail, seenLogs, assistantMessageId);
        const state = runState(detail);
        if (state === 'awaiting_approval') {
          return await this.permissionStop(context, binding, detail);
        }
        if (!terminalRunState(state)) continue;
        if (state === 'succeeded') {
          await this.sendPlan(context.client, binding.sessionId, completedPlan(entries));
          return { stopReason: 'end_turn' as const };
        }
        await this.sendPlan(context.client, binding.sessionId, completedPlan(entries));
        return {
          stopReason: state === 'cancelled' ? ('cancelled' as const) : ('refusal' as const),
          _meta: { spyderbyte: { runId, runState: state } },
        };
      }
      if (controller.signal.aborted) return { stopReason: 'cancelled' as const };
      return {
        stopReason: 'refusal' as const,
        _meta: { spyderbyte: { runId, reason: 'Run event stream ended before a terminal status' } },
      };
    } catch (error) {
      if (controller.signal.aborted || context.signal.aborted)
        return { stopReason: 'cancelled' as const };
      throw error;
    } finally {
      context.signal.removeEventListener('abort', abort);
      if (binding.active?.runId === runId) delete binding.active;
    }
  }

  private async sendPlan(
    clientContext: AgentContext,
    sessionId: SessionId,
    entries: readonly PlanEntry[],
  ): Promise<void> {
    await clientContext.notify(methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: 'plan', entries: [...entries] },
    });
  }

  private async emitRunLogs(
    clientContext: AgentContext,
    binding: AcpSessionBinding,
    detail: RunDetail,
    seenLogs: Set<string>,
    assistantMessageId: string,
  ): Promise<void> {
    for (const log of detail.logs) {
      if (seenLogs.has(String(log.eventId))) continue;
      seenLogs.add(String(log.eventId));
      if (log.level === 'output') {
        await clientContext.notify(methods.client.session.update, {
          sessionId: binding.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: assistantMessageId,
            content: { type: 'text', text: log.message },
            _meta: { spyderbyte: { runId: binding.active?.runId, eventId: log.eventId } },
          },
        });
        continue;
      }
      await clientContext.notify(methods.client.session.update, {
        sessionId: binding.sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: String(log.eventId),
          title: log.message,
          kind: String(log.eventName).includes('terminal') ? 'execute' : 'other',
          status: log.level === 'error' ? 'failed' : 'completed',
          content: [
            {
              type: 'content',
              content: { type: 'text', text: log.message },
            },
          ],
          _meta: {
            spyderbyte: {
              runId: binding.active?.runId,
              eventId: log.eventId,
              eventName: log.eventName,
              level: log.level,
            },
          },
        },
      });
    }
  }

  private async permissionStop(
    context: AgentRequestContext<PromptRequest>,
    binding: AcpSessionBinding,
    detail: RunDetail,
  ) {
    const snapshot = await this.client.agentSession(binding.sessionId as Id);
    const permission = pendingPermission(snapshot);
    if (permission === undefined) {
      return {
        stopReason: 'refusal' as const,
        _meta: { spyderbyte: { runId: detail.run.runId, runState: 'awaiting_approval' } },
      };
    }
    const permissionId = stringValue(permission['permissionRequestId']) as string;
    const response = await context.client.request(methods.client.session.requestPermission, {
      sessionId: binding.sessionId,
      toolCall: {
        toolCallId: permissionId,
        title: stringValue(permission['action']) ?? 'Spyderbyte action requires approval',
        kind: 'other',
        status: 'pending',
        rawInput: {
          reason: stringValue(permission['reason']) ?? 'Spyderbyte policy requires approval.',
          resources: permission['resources'],
        },
      },
      options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
      ],
    });
    return {
      stopReason: 'refusal' as const,
      _meta: {
        spyderbyte: {
          runId: detail.run.runId,
          permissionRequestId: permissionId,
          policyState: 'awaiting_approval',
          clientOutcome: response.outcome,
          note: 'Spyderbyte policy remains authoritative; client presentation does not grant access.',
        },
      },
    };
  }

  private async closeSession(
    context: AgentRequestContext<import('@agentclientprotocol/sdk').CloseSessionRequest>,
  ) {
    const binding = this.sessions.get(context.params.sessionId);
    if (binding?.active !== undefined) {
      binding.active.controller.abort();
      await this.client.cancelRun(binding.active.runId, 'ACP session closed');
    }
    this.sessions.delete(context.params.sessionId);
    return { _meta: { spyderbyte: { closed: true } } };
  }

  private async cancel(
    context: AgentNotificationContext<import('@agentclientprotocol/sdk').CancelNotification>,
  ): Promise<void> {
    const binding = this.sessions.get(context.params.sessionId);
    const active = binding?.active;
    if (active === undefined) return;
    active.controller.abort();
    await this.client.cancelRun(active.runId, 'ACP session cancelled');
  }
}

export async function runAcpStdio(options: AcpAgentTransportOptions): Promise<void> {
  const transport = new AcpAgentTransport(options);
  if (options.input === undefined && options.output === undefined) {
    await transport.serveStdio();
    return;
  }
  await transport.serveStdio(options.input ?? process.stdin, options.output ?? process.stdout);
}
