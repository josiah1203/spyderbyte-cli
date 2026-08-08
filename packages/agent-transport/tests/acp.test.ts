import { describe, expect, it } from 'vitest';
import { client, methods, ndJsonStream, type SessionNotification } from '@agentclientprotocol/sdk';
import { PassThrough, Readable, Writable } from 'node:stream';
import type { EventStreamOptions, RunDetail } from '@agentic-platform/client-sdk';
import type { Id, JsonValue, Run } from '@agentic-platform/runtime-contracts';
import { AcpAgentTransport, type AcpAgentClient } from '../src/index.js';

const projectId = '01900000-0000-7000-8000-000000000001' as Id;
const sessionId = '01900000-0000-7000-8000-000000000002' as Id;
const runId = '01900000-0000-7000-8000-000000000003' as Id;
const workspaceId = '01900000-0000-7000-8000-000000000004' as Id;

function json(value: unknown): JsonValue {
  return value as JsonValue;
}

function runDetail(
  state: string,
  logs: readonly {
    eventId: string;
    eventName: string;
    level: 'info' | 'error' | 'output';
    message: string;
  }[],
): RunDetail {
  return {
    run: {
      runId,
      state,
    } as unknown as Run,
    attempts: [],
    logs,
  } as unknown as RunDetail;
}

function fakeClient(fakeOptions: { readonly waitForCancel?: boolean } = {}): {
  readonly client: AcpAgentClient;
  readonly calls: { readonly sourceInterfaces: string[]; cancelled: string[] };
} {
  const calls = { sourceInterfaces: [] as string[], cancelled: [] as string[] };
  const client: AcpAgentClient = {
    async agentSession() {
      return json({ session: { sessionId, projectId, workspaceId }, permissions: [] });
    },
    async cancelRun(id, reason) {
      calls.cancelled.push(`${id}:${reason ?? ''}`);
      return json({ runId: id, cancelled: true });
    },
    async createProject() {
      return json({ projectId });
    },
    async *followRun(_id, streamOptions?: EventStreamOptions) {
      yield runDetail('running', [
        {
          eventId: 'log-info',
          eventName: 'run.log.v1',
          level: 'info',
          message: 'Inspecting project context',
        },
      ]);
      if (streamOptions?.signal !== undefined && fakeOptions.waitForCancel === true) {
        await new Promise<void>((resolve) => {
          if (streamOptions.signal?.aborted) {
            resolve();
            return;
          }
          streamOptions.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        yield runDetail('cancelled', [
          {
            eventId: 'log-cancelled',
            eventName: 'run.log.v1',
            level: 'error',
            message: 'Run cancelled',
          },
        ]);
        return;
      }
      yield runDetail('succeeded', [
        {
          eventId: 'log-info',
          eventName: 'run.log.v1',
          level: 'info',
          message: 'Inspecting project context',
        },
        {
          eventId: 'log-output',
          eventName: 'run.log.v1',
          level: 'output',
          message: 'ACP response from Spyderbyte.',
        },
      ]);
    },
    async projectAgentSession() {
      return json({ session: { sessionId, projectId, workspaceId } });
    },
    async projectConversation() {
      return json({ messages: [] });
    },
    async projects() {
      return json({ projects: [{ projectId }] });
    },
    async sendMessage(_projectId, _text, _options, sourceInterface = 'api') {
      calls.sourceInterfaces.push(sourceInterface);
      return json({
        sessionId,
        projectId,
        runId,
        userMessageId: '01900000-0000-7000-8000-000000000005',
        assistantMessageId: '01900000-0000-7000-8000-000000000006',
        response: {
          plan: {
            steps: [
              {
                title: 'Inspect the project context',
                description: 'Inspect the project context',
                tier: 0,
              },
            ],
          },
        },
      });
    },
  };
  return { client, calls };
}

async function exerciseClient(clientName: string): Promise<SessionNotification[]> {
  const fixture = fakeClient();
  const transport = new AcpAgentTransport({ client: fixture.client });
  const updates: SessionNotification[] = [];
  const clientApp = client().onNotification(methods.client.session.update, ({ params }) => {
    updates.push(params);
  });

  await clientApp.connectWith(transport.app, async (context) => {
    const initialized = await context.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientInfo: { name: clientName, version: 'fixture' },
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    });
    expect(initialized.protocolVersion).toBe(1);
    expect(initialized.agentCapabilities?.loadSession).toBe(true);

    const session = await context.request(methods.agent.session.new, {
      cwd: '/tmp/spyderbyte-fixture',
      mcpServers: [],
      _meta: { spyderbyte: { projectId } },
    });
    expect(session.sessionId).toBe(sessionId);

    const prompt = await context.request(methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: `Hello from ${clientName}` }],
    });
    expect(prompt.stopReason).toBe('end_turn');
    const loaded = await context.request(methods.agent.session.load, {
      sessionId: session.sessionId,
      cwd: '/tmp/spyderbyte-fixture',
      mcpServers: [],
    });
    expect(loaded._meta).toMatchObject({ spyderbyte: { projectId } });
  });
  expect(fixture.calls.sourceInterfaces).toEqual(['acp']);
  return updates;
}

describe('ACP v1 Spyderbyte transport', () => {
  it.each(['zed', 'jetbrains', 'internal-fixture'])(
    'serves the %s client shape through the shared Run pipeline',
    async (clientName) => {
      const updates = await exerciseClient(clientName);
      const kinds = updates.map((notification) => notification.update.sessionUpdate);
      expect(kinds).toEqual(
        expect.arrayContaining([
          'user_message_chunk',
          'plan',
          'tool_call_update',
          'agent_message_chunk',
        ]),
      );
      expect(updates.at(-1)?.update.sessionUpdate).toBe('plan');
    },
  );

  it('cancels the durable Run when an ACP client sends session/cancel', async () => {
    const fixture = fakeClient({ waitForCancel: true });
    const transport = new AcpAgentTransport({ client: fixture.client });
    const clientApp = client();

    await clientApp.connectWith(transport.app, async (context) => {
      await context.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientInfo: { name: 'internal-fixture', version: 'fixture' },
      });
      const session = await context.request(methods.agent.session.new, {
        cwd: '/tmp/spyderbyte-fixture',
        mcpServers: [],
        _meta: { spyderbyte: { projectId } },
      });
      const prompt = context.request(methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'cancel this request' }],
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await context.notify(methods.agent.session.cancel, { sessionId: session.sessionId });
      expect((await prompt).stopReason).toBe('cancelled');
    });
    expect(fixture.calls.cancelled).toHaveLength(1);
  });

  it('uses newline-delimited JSON for the stdio transport', async () => {
    const fixture = fakeClient();
    const transport = new AcpAgentTransport({ client: fixture.client });
    const clientToAgent = new PassThrough();
    const agentToClient = new PassThrough();
    const agentConnection = transport.connect(
      ndJsonStream(
        Writable.toWeb(agentToClient) as unknown as WritableStream<Uint8Array>,
        Readable.toWeb(clientToAgent) as unknown as ReadableStream<Uint8Array>,
      ),
    );
    const clientStream = ndJsonStream(
      Writable.toWeb(clientToAgent) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(agentToClient) as unknown as ReadableStream<Uint8Array>,
    );
    const clientApp = client();
    await clientApp.connectWith(clientStream, async (context) => {
      const initialized = await context.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientInfo: { name: 'internal-stdio-fixture', version: 'fixture' },
      });
      expect(initialized.protocolVersion).toBe(1);
    });
    agentConnection.close();
    await agentConnection.closed;
  });
});
