#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { resolve } from 'node:path';
import process from 'node:process';
import type { LocalDaemonServer } from '@agentic-platform/local-daemon/server';
import {
  exitCodeForError,
  SpyderbyteClient,
  SpyderbyteClientError,
  type RunDetail,
} from '@agentic-platform/client-sdk';
import { runAcpStdio } from '@agentic-platform/agent-transport';
import { isId, newSortableId, type Id, type JsonValue } from '@agentic-platform/runtime-contracts';
import {
  FileClientPreferencesStore,
  type ClientPreferences,
  type ClientPreferencesStore,
} from './preferences.js';
import { renderSpyderbyteRun } from './rendering.js';

interface ParsedArguments {
  readonly url?: string;
  readonly token?: string;
  readonly workspacePath?: string;
  readonly projectId?: string;
  readonly noStart: boolean;
  readonly command: readonly string[];
}

interface RuntimeHandle {
  readonly client: SpyderbyteClient;
  readonly close: () => Promise<void>;
}

export const HELP = `Spyderbyte terminal

Usage:
  spyderbyte [--project <projectId>] Start the interactive terminal
  spyderbyte acp [--project <projectId>]  Run the Spyderbyte Agent over ACP v1 stdio
  spyderbyte doctor                  Check the local runtime
  spyderbyte onboarding status       Show first-run choices and local context
  spyderbyte onboarding choose <local-model|provider-key|spyderbyte-cloud|configure-later>
  spyderbyte provider list           List safe provider configuration metadata
  spyderbyte provider add --type openai --name OpenAI --api-key <secret>
  spyderbyte provider credential set <providerConfigurationId> --api-key <secret>
  spyderbyte provider credential revoke <providerConfigurationId>
  spyderbyte provider test <providerConfigurationId>
  spyderbyte models list|refresh     List or refresh provider-derived models
  spyderbyte org [list|show]         Show the active organization workspace
  spyderbyte users [organizationId]  List organization members
  spyderbyte policies [organizationId] List organization policies
  spyderbyte budgets [organizationId] List organization budgets and usage
  spyderbyte approvals               List organization approvals
  spyderbyte audit [organizationId]  Verify and read organization audit history
  spyderbyte project list            List projects
  spyderbyte project create <name> [objective]
  spyderbyte project open <projectId> Open a project conversation
  spyderbyte run prompt <projectId> <text>
  spyderbyte run script <file> [--repository <repositoryId>] [--args <JSON>]
  spyderbyte runs list [projectId]
  spyderbyte runs inspect <runId>
  spyderbyte runs logs <runId> [--follow]
  spyderbyte runs cancel <runId> [reason]
  spyderbyte runs retry <runId>
  spyderbyte model select <providerId:modelId>
  spyderbyte runtime select <runtimeId>
  spyderbyte files list|context|status|diff|open|save [repositoryId] [path]
  spyderbyte notebooks list
  spyderbyte notebooks create [title]
  spyderbyte notebooks open <notebookId> [--revision <n>]
  spyderbyte notebooks duplicate <notebookId> [--title <title>]
  spyderbyte notebooks rename|archive|restore|delete <notebookId>
  spyderbyte notebooks versions|executions|usage|runs <notebookId>
  spyderbyte notebooks inspect <notebookId> <runId>
  spyderbyte notebooks run <notebookId> [--revision <n>]
  spyderbyte notebooks export <notebookId>
  spyderbyte data sources|connections
  spyderbyte data add <connectionId> [--kind memory|file|sql|connector] --name <name> [--path <path>]
  spyderbyte data test|schema <connectionId>
  spyderbyte data bind|reauthorize <connectionId> <credentialRef>
  spyderbyte data revoke <connectionId>
  spyderbyte datasets list|lineage|profile|quality <datasetId>
  spyderbyte datasets publish <datasetId> <connectionId> <sourceReference> [name]
  spyderbyte query run <queryId> --sql <read-only SQL> [--dataset <datasetId>]
  spyderbyte query list|inspect|cancel|validate|explain|export|handoff <queryId>
  spyderbyte query save <savedQueryId> <name> --sql <read-only SQL>
  spyderbyte query saved
  spyderbyte query <file> [--dataset <datasetId>] [--connection <connectionId>]
  spyderbyte train <config.json>
  spyderbyte train list|inspect|cancel <runId>
  spyderbyte deploy <model-or-artifact> [--artifact]
  spyderbyte artifacts list|inspect|versions|lineage|preview|open|export|save|reuse|diff <artifactId>
  spyderbyte visualize choose|validate|render <artifactId> [--type <type>]
  spyderbyte workspace context|intake|inbox|watch|recommendations
  spyderbyte jupyter discover|list
  spyderbyte jupyter launch [--notebook <notebookId>] [--project <path>]
  spyderbyte jupyter context <sessionId>
  spyderbyte jupyter stop|restart|interrupt|reconnect <sessionId>
  spyderbyte updates status|check|download|install|rollback
  spyderbyte experiments list|inspect|runs|compare
  spyderbyte model registry
  spyderbyte deployments list|inspect|serve|observe|update|invoke|smoke-test|metrics|logs|revisions
  spyderbyte deployments canary|promote|rollback|stop|restart|scale|archive
  spyderbyte pipelines list|create|inspect|validate|plan|estimate|versions <pipelineId>
  spyderbyte pipelines publish|run|dry-run|runs <pipelineId>
  spyderbyte pipelines retry <runId> <stageId>
  spyderbyte automations list|inspect|pause|resume|trigger|runs|notifications <automationId>
  spyderbyte connectors list|discover|runs|checkpoints|schema-events

Global options:
  --url <url>              Connect to an existing local API
  --token <token>          Bearer token for the local API
  --workspace <path>       Workspace path when starting a local API
  --project <projectId>    Project for the rich shell conversation
  --no-start               Do not start a local API automatically

Interactive panes:
  pane next|previous        Move keyboard focus between command, inspector, and logs
  layout wide|narrow        Override the responsive terminal layout
`;

function parseArguments(args: readonly string[]): ParsedArguments {
  const command: string[] = [];
  let url: string | undefined;
  let token: string | undefined;
  let workspacePath: string | undefined;
  let projectId: string | undefined;
  let noStart = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === undefined) continue;
    if (value === '--no-start') {
      noStart = true;
      continue;
    }
    if (value === '--project' && command.length === 0) {
      const next = args[index + 1];
      if (next === undefined) throw new Error(`${value} requires a value`);
      projectId = next;
      index += 1;
      continue;
    }
    if (value === '--url' || value === '--token' || value === '--workspace') {
      const next = args[index + 1];
      if (next === undefined) throw new Error(`${value} requires a value`);
      if (value === '--url') url = next;
      if (value === '--token') token = next;
      if (value === '--workspace') workspacePath = next;
      index += 1;
      continue;
    }
    command.push(value);
  }
  return {
    ...(url === undefined ? {} : { url }),
    ...(token === undefined ? {} : { token }),
    ...(workspacePath === undefined ? {} : { workspacePath }),
    ...(projectId === undefined ? {} : { projectId }),
    noStart,
    command,
  };
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function required(args: readonly string[], index: number, label: string): string {
  const value = args[index];
  if (value === undefined || value.trim().length === 0) throw new Error(`${label} is required`);
  return value;
}

function id(value: string, label: string): Id {
  if (!isId(value)) throw new Error(`${label} must be a UUIDv7 id`);
  return value;
}

function modelRef(value: string): { readonly providerId: string; readonly modelId: string } {
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error('model must use providerId:modelId');
  }
  return { providerId: value.slice(0, separator), modelId: value.slice(separator + 1) };
}

function json(value: unknown): JsonValue {
  return value as JsonValue;
}

function jsonOption(args: readonly string[], name: string): JsonValue | undefined {
  const value = option(args, name);
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    throw new Error(`${name} must contain valid JSON`);
  }
}

async function jsonFile(path: string, label: string): Promise<Record<string, JsonValue>> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(
      `${label} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    throw new Error(`${label} must contain valid JSON`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return parsed as Record<string, JsonValue>;
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function artifactContentRecord(value: unknown): {
  readonly mediaType: string;
  readonly text: string;
} {
  const record = objectRecord(value, 'Artifact content response');
  if (typeof record['contentBase64'] !== 'string') {
    throw new Error('Artifact response did not include readable content');
  }
  return {
    mediaType: typeof record['mediaType'] === 'string' ? record['mediaType'] : 'text/plain',
    text: Buffer.from(record['contentBase64'], 'base64').toString('utf8'),
  };
}

function tableInput(text: string, mediaType: string, sourceArtifactId: string): JsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    parsed = undefined;
  }
  if (parsed !== undefined) {
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      Array.isArray((parsed as Record<string, unknown>)['columns']) &&
      Array.isArray((parsed as Record<string, unknown>)['rows'])
    ) {
      const record = parsed as Record<string, unknown>;
      return {
        columns: record['columns'] as JsonValue,
        rows: record['rows'] as JsonValue,
        sourceArtifactId,
      };
    }
    if (Array.isArray(parsed)) {
      const objects = parsed.filter(
        (value): value is Record<string, unknown> =>
          value !== null && typeof value === 'object' && !Array.isArray(value),
      );
      if (objects.length === parsed.length && objects.length > 0) {
        const columns = [...new Set(objects.flatMap((value) => Object.keys(value)))];
        return {
          columns,
          rows: objects.map((value) =>
            columns.map((column) => (value[column] as JsonValue) ?? null),
          ),
          sourceArtifactId,
        };
      }
      return {
        columns: ['value'],
        rows: parsed.map((value) => [value as JsonValue]),
        sourceArtifactId,
      };
    }
    if (parsed !== null && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      const columns = Object.keys(record);
      return {
        columns,
        rows: [columns.map((column) => (record[column] as JsonValue) ?? null)],
        sourceArtifactId,
      };
    }
  }
  const delimiter = mediaType.includes('tab') || text.includes('\t') ? '\t' : ',';
  const rows = text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => line.split(delimiter));
  if (rows.length === 0) return { columns: ['value'], rows: [], sourceArtifactId };
  return { columns: rows[0] ?? [], rows: rows.slice(1), sourceArtifactId };
}

function visualizationSpec(input: JsonValue, type: string, rest: readonly string[]): JsonValue {
  const record = objectRecord(input, 'Visualization input');
  const columns = Array.isArray(record['columns']) ? record['columns'] : [];
  const first = typeof columns[0] === 'string' ? columns[0] : undefined;
  const second = typeof columns[1] === 'string' ? columns[1] : first;
  const typeWithoutColumns = ['table', 'pivot'].includes(type);
  return {
    spec: {
      type,
      ...(option(rest, '--title') === undefined ? {} : { title: option(rest, '--title') }),
      ...(typeWithoutColumns || (option(rest, '--x') ?? first) === undefined
        ? {}
        : { xColumn: option(rest, '--x') ?? first }),
      ...(typeWithoutColumns || (option(rest, '--y') ?? second) === undefined
        ? {}
        : { yColumn: option(rest, '--y') ?? second }),
      ...(option(rest, '--series') === undefined ? {} : { seriesColumn: option(rest, '--series') }),
    },
    columns: record['columns'] as JsonValue,
    rows: record['rows'] as JsonValue,
    ...(typeof record['sourceArtifactId'] === 'string'
      ? { sourceArtifactId: record['sourceArtifactId'] }
      : {}),
  } as JsonValue;
}

function scriptCommand(path: string): string {
  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith('.py')) return 'python3';
  if (lowerPath.endsWith('.js') || lowerPath.endsWith('.mjs') || lowerPath.endsWith('.cjs')) {
    return 'node';
  }
  if (lowerPath.endsWith('.sh')) return 'bash';
  throw new Error('script must end in .py, .js, .mjs, .cjs, or .sh');
}

function stringArray(value: JsonValue | undefined, label: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} must be a JSON array of strings`);
  }
  return value as readonly string[];
}

async function defaultRepositoryId(client: SpyderbyteClient, explicit?: string): Promise<string> {
  if (explicit !== undefined) return explicit;
  const value = await client.localRepositories();
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('No repository catalog was returned; pass --repository <repositoryId>');
  }
  const repositories = (value as Record<string, unknown>)['repositories'];
  if (!Array.isArray(repositories) || repositories.length === 0) {
    throw new Error('Register one local repository or pass --repository <repositoryId>');
  }
  if (repositories.length > 1) {
    throw new Error('Multiple repositories are registered; pass --repository <repositoryId>');
  }
  const repositoryId = (repositories[0] as Record<string, unknown> | undefined)?.['repositoryId'];
  if (typeof repositoryId !== 'string' || repositoryId.length === 0) {
    throw new Error('The repository catalog returned an invalid repository id');
  }
  return repositoryId;
}

export function interactiveCommand(line: string): readonly string[] {
  const normalized = line.trim().replace(/^\/+/, '');
  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length !== 1) return parts;
  const aliases: Record<string, readonly string[]> = {
    project: ['project', 'list'],
    files: ['files', 'list'],
    notebooks: ['notebooks', 'list'],
    data: ['data', 'sources'],
    sql: ['query', 'list'],
    runs: ['runs', 'list'],
    artifacts: ['artifacts', 'list'],
    provider: ['provider', 'list'],
    runtime: ['runtime', 'list'],
    environment: ['environment', 'list'],
    usage: ['usage', 'list'],
    org: ['org', 'list'],
    users: ['users'],
    policies: ['policies'],
    budgets: ['budgets'],
    approvals: ['approvals', 'list'],
    audit: ['audit'],
    diagnostics: ['diagnostics'],
    onboarding: ['onboarding', 'status'],
  };
  return aliases[parts[0] ?? ''] ?? parts;
}

function print(value: unknown): void {
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

async function organizationIdForCommand(
  client: SpyderbyteClient,
  explicit: string | undefined,
): Promise<Id> {
  if (explicit !== undefined) return id(explicit, 'organization id');
  const response = await client.governanceOrganizations();
  if (response === null || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('Organization service returned an invalid response');
  }
  const organizations = (response as Record<string, unknown>)['organizations'];
  const organization = Array.isArray(organizations) ? organizations[0] : undefined;
  const organizationId =
    organization !== null && typeof organization === 'object' && !Array.isArray(organization)
      ? (organization as Record<string, unknown>)['organizationId']
      : undefined;
  if (typeof organizationId !== 'string') {
    throw new Error('No organization workspace is assigned to this session');
  }
  return id(organizationId, 'organization id');
}

function printRun(detail: RunDetail): void {
  print(renderSpyderbyteRun(detail));
}

function comparisonSummary(value: JsonValue): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { comparison: value };
  }
  const record = value as Record<string, unknown>;
  const metrics = record['metrics'];
  const artifacts = record['artifacts'];
  return {
    comparisonId: record['comparisonId'],
    runIds: record['runIds'],
    metrics,
    artifactIds:
      Array.isArray(artifacts) &&
      artifacts.every(
        (artifact) => artifact !== null && typeof artifact === 'object' && !Array.isArray(artifact),
      )
        ? artifacts.map((artifact) => (artifact as Record<string, unknown>)['artifactId'])
        : artifacts,
    note: 'Use the web or Jupyter comparison view for curves, distributions, confusion matrices, and explainability.',
  };
}

async function runtime(
  parsed: ParsedArguments,
  preferences: ClientPreferencesStore,
): Promise<RuntimeHandle> {
  const url = parsed.url ?? process.env['SPYDERBYTE_API_URL'];
  if (url !== undefined) {
    return {
      client: new SpyderbyteClient({
        baseUrl: url,
        interface: 'cli',
        ...(parsed.token === undefined ? {} : { token: parsed.token }),
        ...(process.env['SPYDERBYTE_WORKSPACE_ID'] === undefined
          ? {}
          : { workspaceId: process.env['SPYDERBYTE_WORKSPACE_ID'] as Id }),
      }),
      close: async () => undefined,
    };
  }
  if (parsed.noStart || process.env['SPYDERBYTE_AUTO_START'] === 'false') {
    throw new Error(
      'No API URL configured. Start the local daemon or pass --url http://127.0.0.1:8787.',
    );
  }
  let server: LocalDaemonServer | undefined;
  try {
    const { createLocalDaemonServer } = await import('@agentic-platform/local-daemon/server');
    const storedWorkspacePath = preferences.load().activeWorkspacePath;
    server = await createLocalDaemonServer({
      port: 0,
      ...(parsed.workspacePath === undefined
        ? storedWorkspacePath === undefined
          ? {}
          : { workspacePath: storedWorkspacePath }
        : { workspacePath: parsed.workspacePath }),
      ...(parsed.token === undefined ? {} : { authToken: parsed.token }),
    });
    preferences.update({ activeWorkspacePath: server.workspace.rootPath });
    return {
      client: new SpyderbyteClient({
        baseUrl: server.address,
        interface: 'cli',
        ...(server.authToken === undefined ? {} : { token: server.authToken }),
      }),
      close: server.close,
    };
  } catch (error) {
    await server?.close().catch(() => undefined);
    throw error;
  }
}

async function waitForRun(
  client: SpyderbyteClient,
  runId: Id,
  onConnectionStateChange?: (state: string) => void,
): Promise<void> {
  const controller = new AbortController();
  try {
    for await (const detail of client.followRun(runId, {
      signal: controller.signal,
      maxReconnects: 12,
      ...(onConnectionStateChange === undefined ? {} : { onConnectionStateChange }),
    })) {
      printRun(detail);
      if (
        ['succeeded', 'failed', 'cancelled', 'timed_out', 'partially_succeeded'].includes(
          detail.run.state,
        )
      ) {
        return;
      }
    }
  } finally {
    controller.abort();
  }
}

interface RichShellFrame {
  readonly command: string;
  readonly fields: readonly string[];
}

interface RichShellBridge {
  readonly endpoint: string;
  readonly connected: Promise<void>;
  readonly send: (command: string, ...fields: readonly string[]) => void;
  readonly close: () => Promise<void>;
}

export function encodeRichShellFrame(command: string, ...fields: readonly string[]): string {
  return `${command}${fields.map((field) => `\t${Buffer.from(field, 'utf8').toString('hex')}`).join('')}\n`;
}

export function decodeRichShellFrame(line: string): RichShellFrame | undefined {
  const columns = line.trimEnd().split('\t');
  const command = columns.shift();
  if (command === undefined || command.length === 0) return undefined;
  const fields: string[] = [];
  for (const encoded of columns) {
    if (encoded.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(encoded)) return undefined;
    fields.push(Buffer.from(encoded, 'hex').toString('utf8'));
  }
  return { command, fields };
}

async function createRichShellBridge(
  onFrame: (frame: RichShellFrame) => void | Promise<void>,
): Promise<RichShellBridge> {
  const token = randomBytes(24).toString('hex');
  const server: Server = createServer();
  let activeSocket: Socket | undefined;
  let connectedResolve!: () => void;
  const connected = new Promise<void>((resolve) => {
    connectedResolve = resolve;
  });

  server.on('connection', (socket) => {
    let authenticated = false;
    let pending = '';
    socket.setEncoding('utf8');
    socket.on('error', () => undefined);
    socket.on('data', (chunk: string) => {
      pending += chunk;
      while (true) {
        const newline = pending.indexOf('\n');
        if (newline < 0) break;
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        const frame = decodeRichShellFrame(line);
        if (frame === undefined) {
          socket.destroy();
          return;
        }
        if (!authenticated) {
          if (frame.command !== 'HELLO' || frame.fields[0] !== token) {
            socket.destroy();
            return;
          }
          authenticated = true;
          activeSocket?.destroy();
          activeSocket = socket;
          connectedResolve();
          continue;
        }
        void onFrame(frame);
      }
    });
    socket.on('close', () => {
      if (activeSocket === socket) activeSocket = undefined;
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Rich shell bridge did not receive a local port'));
        return;
      }
      resolve(address.port);
    });
  });

  return {
    endpoint: `127.0.0.1:${port}:${token}`,
    connected,
    send: (command, ...fields) => {
      if (activeSocket?.writable === true) {
        activeSocket.write(encodeRichShellFrame(command, ...fields));
      }
    },
    close: async () => {
      activeSocket?.end();
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

function shellContextModel(preferences: ClientPreferences): string {
  return preferences.selectedModel === undefined
    ? 'routing policy'
    : `${preferences.selectedModel.providerId}:${preferences.selectedModel.modelId}`;
}

function sendRunDetailToRichShell(
  bridge: RichShellBridge,
  detail: RunDetail,
  sentLogs: Set<string>,
  sentPlans: Set<string>,
): void {
  const plan = detail.run.executionPlan;
  if (plan !== undefined && !sentPlans.has(plan.planId)) {
    sentPlans.add(plan.planId);
    bridge.send(
      'PLAN',
      detail.run.requestedAction,
      plan.steps.map((step) => step.title).join('\u001f'),
    );
  }
  for (const log of detail.logs) {
    if (sentLogs.has(log.eventId)) continue;
    sentLogs.add(log.eventId);
    if (log.level === 'output') bridge.send('DELTA', log.message);
    else bridge.send('LOG', log.level, log.message);
  }
  bridge.send('STATUS', detail.run.state, detail.run.error?.message ?? '');
}

async function runRichShell(
  args: readonly string[],
  parsed: ParsedArguments,
  client: SpyderbyteClient,
  preferences: ClientPreferencesStore,
): Promise<boolean> {
  const binary = richShellBinary();
  if (binary === undefined) return false;

  let activeRun: Id | undefined;
  let activeController: AbortController | undefined;

  const submit = async (text: string): Promise<void> => {
    if (activeRun !== undefined) {
      bridge.send('LOG', 'error', 'A Run is already streaming; wait for it to finish.');
      return;
    }
    const rawProject =
      parsed.projectId ?? preferences.load().activeProjectId ?? process.env['SPYDERBYTE_PROJECT'];
    if (rawProject === undefined) {
      bridge.send('LOG', 'error', 'No project selected. Launch with --project <projectId>.');
      bridge.send('STATUS', 'failed', 'A project is required before submitting a request.');
      return;
    }
    let projectId: Id;
    try {
      projectId = id(rawProject, 'project id');
    } catch (error) {
      bridge.send('LOG', 'error', error instanceof Error ? error.message : String(error));
      return;
    }
    const selectedModel = preferences.load().selectedModel;
    const controller = new AbortController();
    activeController = controller;
    try {
      bridge.send(
        'STATUS',
        'validating',
        'Submitting through the Spyderbyte AgentSession boundary.',
      );
      const accepted = (await client.sendMessage(
        projectId,
        text,
        undefined,
        'tui',
        selectedModel,
      )) as Record<string, unknown>;
      const acceptedRun = accepted['runId'];
      if (typeof acceptedRun !== 'string') throw new Error('API did not return a durable run id');
      activeRun = id(acceptedRun, 'run id');
      bridge.send('STATUS', 'queued', `Run ${activeRun} accepted.`);
      const sentLogs = new Set<string>();
      const sentPlans = new Set<string>();
      for await (const detail of client.followRun(activeRun, {
        signal: controller.signal,
        maxReconnects: 12,
        onConnectionStateChange: (state) => bridge.send('CONNECTION', state),
      })) {
        sendRunDetailToRichShell(bridge, detail, sentLogs, sentPlans);
        if (
          ['succeeded', 'failed', 'cancelled', 'timed_out', 'partially_succeeded'].includes(
            detail.run.state,
          )
        )
          return;
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        bridge.send('LOG', 'error', error instanceof Error ? error.message : String(error));
        bridge.send('STATUS', 'failed', 'The shared Run stream ended with an error.');
      }
    } finally {
      if (activeController === controller) activeController = undefined;
      activeRun = undefined;
    }
  };

  const bridge = await createRichShellBridge(async (frame) => {
    if (frame.command === 'SUBMIT') {
      const text = frame.fields[0]?.trim();
      if (text !== undefined && text.length > 0) await submit(text);
      return;
    }
    if (frame.command === 'CANCEL' && activeRun !== undefined) {
      try {
        await client.cancelRun(activeRun, 'cancelled from the rich shell');
      } catch (error) {
        bridge.send('LOG', 'error', error instanceof Error ? error.message : String(error));
      }
      activeController?.abort();
      return;
    }
    if (frame.command === 'QUIT') activeController?.abort();
  });

  void bridge.connected.then(() => {
    const current = preferences.load();
    const project =
      parsed.projectId ??
      current.activeProjectId ??
      process.env['SPYDERBYTE_PROJECT'] ??
      'no project selected';
    bridge.send(
      'CONTEXT',
      current.activeWorkspacePath ?? parsed.workspacePath ?? 'current workspace',
      project,
      shellContextModel(current),
    );
    bridge.send('CONNECTION', 'connected');
  });

  try {
    const child = spawn(binary, [...args], {
      stdio: 'inherit',
      env: {
        ...process.env,
        SPYDERBYTE_RICH_SHELL: '1',
        SPYDERBYTE_SHELL_BRIDGE: bridge.endpoint,
      },
    });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', () => resolve());
    });
  } finally {
    activeController?.abort();
    await bridge.close();
  }
  return true;
}

export async function execute(
  client: SpyderbyteClient,
  args: readonly string[],
  preferences?: ClientPreferencesStore,
  onConnectionStateChange?: (state: string) => void,
): Promise<void> {
  const [domain, action, ...rest] = args;
  if (domain === undefined || domain === 'help' || domain === '--help' || domain === '-h') {
    print(HELP);
    return;
  }
  if (domain === 'acp') {
    const requestedProjectId = option(rest, '--project');
    await runAcpStdio({
      client,
      ...(requestedProjectId === undefined
        ? {}
        : { projectId: id(requestedProjectId, 'ACP project id') }),
    });
    return;
  }
  if (domain === 'doctor') {
    const [health, providers, models, diagnostics] = await Promise.all([
      client.health(),
      client.providers(),
      client.models(),
      client.diagnostics(),
    ]);
    print({
      health,
      providerCount: providers.providers.length,
      configuredModelCount: models.models.length,
      readyModelCount: models.models.filter((model) => model.state === 'ready').length,
      diagnostics,
    });
    return;
  }
  if (domain === 'provider' && action === 'list') {
    print(await client.providers());
    return;
  }
  if (domain === 'provider' && action === 'add') {
    const providerType = option(rest, '--type') ?? required(rest, 0, 'provider type');
    const displayName = option(rest, '--name') ?? required(rest, 1, 'provider name');
    const endpoint = option(rest, '--endpoint');
    const apiKey = option(rest, '--api-key');
    const defaultModelId = option(rest, '--model');
    print(
      await client.addProvider(
        json({
          providerType,
          displayName,
          ...(endpoint === undefined ? {} : { endpoint }),
          ...(apiKey === undefined ? {} : { apiKey }),
          ...(defaultModelId === undefined ? {} : { defaultModelId, modelIds: [defaultModelId] }),
        }),
      ),
    );
    return;
  }
  if (domain === 'provider' && action === 'test') {
    print(
      await client.testProvider(
        id(required(rest, 0, 'provider configuration id'), 'provider configuration id'),
      ),
    );
    return;
  }
  if (domain === 'provider' && action === 'credential') {
    const credentialAction = rest[0];
    const providerConfigurationId = id(
      required(rest, 1, 'provider configuration id'),
      'provider configuration id',
    );
    if (credentialAction === 'set') {
      const secret = option(rest.slice(1), '--api-key');
      if (secret === undefined || secret.trim().length === 0) {
        throw new Error('provider credential set requires --api-key');
      }
      print(await client.setProviderCredential(providerConfigurationId, secret));
      return;
    }
    if (credentialAction === 'revoke') {
      print(await client.revokeProviderCredential(providerConfigurationId));
      return;
    }
  }
  if (domain === 'org' || domain === 'organization') {
    const organizationId =
      action === 'show' ? await organizationIdForCommand(client, rest[0]) : undefined;
    print(
      organizationId === undefined
        ? await client.governanceOrganizations()
        : await client.governanceOverview(organizationId),
    );
    return;
  }
  if (domain === 'users' || domain === 'members') {
    print(await client.governanceMembers(await organizationIdForCommand(client, action)));
    return;
  }
  if (domain === 'policies') {
    print(await client.governancePolicies(await organizationIdForCommand(client, action)));
    return;
  }
  if (domain === 'budgets') {
    const organizationId = await organizationIdForCommand(client, action);
    print({
      budgets: await client.governanceBudgets(organizationId),
      usage: await client.governanceUsage(organizationId),
    });
    return;
  }
  if (domain === 'approvals' && (action === undefined || action === 'list')) {
    print(await client.approvals());
    return;
  }
  if (domain === 'audit') {
    const organizationId = await organizationIdForCommand(client, action);
    print({
      audit: await client.governanceAudit(organizationId),
      verification: await client.verifyGovernanceAudit(organizationId),
    });
    return;
  }
  if ((domain === 'model' || domain === 'models') && action === 'list') {
    print(await client.models());
    return;
  }
  if ((domain === 'model' || domain === 'models') && action === 'refresh') {
    print(await client.refreshModels());
    return;
  }
  if (domain === 'files' && (action === 'list' || action === undefined)) {
    const repositoryId = rest[0] ?? option(rest, '--repository');
    print(
      repositoryId === undefined
        ? await client.localRepositories()
        : await client.repositoryFiles(repositoryId, option(rest, '--prefix')),
    );
    return;
  }
  if (domain === 'files' && action === 'context') {
    print(await client.workspaceContext());
    return;
  }
  if (domain === 'files' && (action === 'status' || action === 'diff')) {
    const repositoryId = required(rest, 0, 'repository id');
    print(
      action === 'status'
        ? await client.repositoryStatus(repositoryId)
        : await client.repositoryDiff(repositoryId),
    );
    return;
  }
  if (domain === 'files' && action === 'open') {
    print(
      await client.repositoryFile(
        required(rest, 0, 'repository id'),
        required(rest, 1, 'file path'),
      ),
    );
    return;
  }
  if (domain === 'files' && action === 'save') {
    const repositoryId = required(rest, 0, 'repository id');
    const filePath = required(rest, 1, 'file path');
    const sourcePath = option(rest, '--from');
    const content =
      option(rest, '--content') ??
      (sourcePath === undefined ? undefined : await readFile(sourcePath, 'utf8'));
    if (content === undefined) throw new Error('files save requires --content or --from');
    print(
      await client.writeRepositoryFile(
        repositoryId,
        json({
          path: filePath,
          content,
          origin: option(rest, '--origin') ?? 'manual',
          ...(option(rest, '--artifact') === undefined
            ? {}
            : { artifactId: option(rest, '--artifact') }),
          ...(option(rest, '--confirmation') === undefined
            ? {}
            : { confirmationId: option(rest, '--confirmation') }),
        }),
      ),
    );
    return;
  }
  if (domain === 'runtime' && action === 'list') {
    print(await client.runtimeProfiles());
    return;
  }
  if (domain === 'environment' && action === 'list') {
    print(await client.runtimeProfiles());
    return;
  }
  if (domain === 'usage' && action === 'list') {
    print({ diagnostics: await client.diagnostics(), providers: await client.providers() });
    return;
  }
  if (domain === 'diagnostics' && action === undefined) {
    print(await client.diagnostics());
    return;
  }
  if (domain === 'update' || domain === 'updates') {
    if (action === undefined || action === 'status') print(await client.updateStatus());
    else if (action === 'check') print(await client.checkForUpdates());
    else if (action === 'download') print(await client.downloadUpdate());
    else if (action === 'install') print(await client.installUpdate());
    else if (action === 'rollback') print(await client.rollbackUpdate());
    else throw new Error('updates expects status, check, download, install, or rollback');
    return;
  }
  if (domain === 'onboarding' && (action === undefined || action === 'status')) {
    print(await client.onboarding());
    return;
  }
  if (domain === 'onboarding' && action === 'choose') {
    const choice = required(rest, 0, 'onboarding choice');
    const modelId = option(rest, '--model');
    print(
      await client.completeOnboarding(
        json({ choice, ...(modelId === undefined ? {} : { modelId }) }),
      ),
    );
    return;
  }
  if (domain === 'train' && action === 'list') {
    print(await client.trainingRuns());
    return;
  }
  if (domain === 'train' && action === 'inspect') {
    print(await client.trainingRun(required(rest, 0, 'training run id')));
    return;
  }
  if (domain === 'train' && action === 'cancel') {
    print(await client.cancelTraining(required(rest, 0, 'training run id')));
    return;
  }
  if (domain === 'train') {
    const configPath = action ?? required(rest, 0, 'training config path');
    const configuration = await jsonFile(configPath, 'Training config');
    const input = configuration['configuration'] !== undefined ? configuration : { configuration };
    print(await client.startTraining(input as JsonValue));
    return;
  }
  if (domain === 'deploy') {
    const target = action === '--artifact' ? required(rest, 0, 'model or artifact id') : action;
    if (target === undefined) throw new Error('model or artifact id is required');
    const artifactMode = action === '--artifact' || rest.includes('--artifact');
    const modelId = option(rest, '--model') ?? target;
    print(
      await client.serveLocalDeployment(
        json({
          modelId,
          ...(artifactMode ? { modelArtifactId: target } : {}),
          ...(option(rest, '--version') === undefined
            ? {}
            : { modelVersionId: option(rest, '--version') }),
          ...(option(rest, '--endpoint') === undefined
            ? {}
            : { endpointId: option(rest, '--endpoint') }),
          ...(option(rest, '--runtime') === undefined
            ? {}
            : { servingRuntime: option(rest, '--runtime') }),
        }),
      ),
    );
    return;
  }
  if ((domain === 'artifact' || domain === 'artifacts') && action === 'list') {
    print(await client.artifacts());
    return;
  }
  if ((domain === 'artifact' || domain === 'artifacts') && action === 'versions') {
    print(await client.artifactVersions(required(rest, 0, 'artifact id')));
    return;
  }
  if ((domain === 'artifact' || domain === 'artifacts') && action === 'lineage') {
    print(await client.artifactLineage(required(rest, 0, 'artifact id')));
    return;
  }
  if ((domain === 'artifact' || domain === 'artifacts') && action === 'diff') {
    const artifactId = required(rest, 0, 'artifact id');
    const fromVersion = option(rest, '--from');
    const toVersion = option(rest, '--to');
    print(
      await client.artifactDiff(
        artifactId,
        fromVersion === undefined ? undefined : Number(fromVersion),
        toVersion === undefined ? undefined : Number(toVersion),
      ),
    );
    return;
  }
  if ((domain === 'artifact' || domain === 'artifacts') && action === 'save') {
    const artifactId = required(rest, 0, 'artifact id');
    const inputPath = required(rest, 1, 'artifact input path');
    const content = await readFile(inputPath, 'utf8');
    const artifact = await client.artifact(artifactId);
    const artifactRecord = objectRecord(artifact, 'Artifact response');
    const reference = objectRecord(artifactRecord['reference'], 'Artifact reference');
    const currentVersion = Number(reference['version']);
    if (!Number.isSafeInteger(currentVersion) || currentVersion < 1) {
      throw new Error('Artifact response did not include a valid current version');
    }
    const mediaType =
      option(rest, '--media-type') ??
      (typeof reference['mediaType'] === 'string' ? reference['mediaType'] : 'text/plain');
    const staged = objectRecord(
      await client.stageArtifactUpload(content, mediaType),
      'Staged upload',
    );
    const publication = await client.publishArtifactVersion(
      artifactId,
      json({
        stagedUploadId: staged['stagedUploadId'],
        mediaType,
        createdBy: (await client.session()).actor,
        expectedParentVersion: currentVersion,
        ...(option(rest, '--schema') === undefined ? {} : { schemaName: option(rest, '--schema') }),
      }),
    );
    print({ publication, diff: await client.artifactDiff(artifactId, currentVersion) });
    return;
  }
  if (
    (domain === 'artifact' || domain === 'artifacts') &&
    (action === 'inspect' ||
      action === 'open' ||
      action === 'preview' ||
      action === 'export' ||
      action === 'reuse')
  ) {
    const artifactId = required(rest, 0, 'artifact id');
    const artifact = await client.artifact(artifactId);
    if (action === 'inspect') {
      print(artifact);
      return;
    }
    const artifactRecord = objectRecord(artifact, 'Artifact response');
    const reference = objectRecord(artifactRecord['reference'], 'Artifact reference');
    const version = Number(option(rest, '--version') ?? reference['version']);
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new Error('Artifact response did not include a valid version');
    }
    const contentResponse = await client.artifactContent(artifactId, version);
    const content = artifactContentRecord(contentResponse);
    if (action === 'open') {
      print({ artifact, content: contentResponse });
      return;
    }
    if (action === 'preview') {
      const input = tableInput(content.text, content.mediaType, artifactId);
      const choice = await client.chooseVisualization(input, option(rest, '--type') as never);
      const choiceRecord = objectRecord(choice, 'Visualization choice');
      const type = choiceRecord['type'];
      if (typeof type !== 'string') throw new Error('Visualization choice did not include a type');
      print({
        artifactId,
        version,
        content: input,
        choice,
        preview: await client.renderVisualization(visualizationSpec(input, type, rest)),
      });
      return;
    }
    const output = option(rest, '--output') ?? `artifact-${artifactId}-v${version}`;
    await writeFile(output, Buffer.from(content.text, 'utf8'));
    print({ artifactId, version, output, reused: action === 'reuse' });
    return;
  }
  if (domain === 'visualize' || domain === 'visualizations') {
    const namedAction = action === 'choose' || action === 'validate' || action === 'render';
    const visualizeAction = namedAction ? action : 'render';
    const artifactId = namedAction
      ? required(rest, 0, 'artifact id')
      : required([action ?? '', ...rest], 0, 'artifact id');
    const visualizeArgs = namedAction ? rest.slice(1) : rest;
    const artifact = objectRecord(await client.artifact(artifactId), 'Artifact response');
    const reference = objectRecord(artifact['reference'], 'Artifact reference');
    const version = Number(option(visualizeArgs, '--version') ?? reference['version']);
    if (!Number.isSafeInteger(version) || version < 1)
      throw new Error('Artifact version is invalid');
    const content = artifactContentRecord(await client.artifactContent(artifactId, version));
    const input = tableInput(content.text, content.mediaType, artifactId);
    const override = option(visualizeArgs, '--type');
    const choice = objectRecord(
      await client.chooseVisualization(input, override as never),
      'Visualization choice',
    );
    if (visualizeAction === 'choose') {
      print(choice);
      return;
    }
    const type = choice['type'];
    if (typeof type !== 'string') throw new Error('Visualization choice did not include a type');
    const request = visualizationSpec(input, type, visualizeArgs);
    print(
      visualizeAction === 'validate'
        ? await client.validateVisualization(request)
        : {
            choice,
            render: await client.renderVisualization(request),
            externalAction: {
              kind: 'rich-visualization',
              artifactId,
              version,
              target: option(visualizeArgs, '--target') ?? 'jupyter',
            },
          },
    );
    return;
  }
  if (domain === 'workspace') {
    if (action === 'context') print(await client.workspaceContext());
    else if (action === 'intake') print(await client.workspaceIntake());
    else if (action === 'inbox') print(await client.workspaceInbox());
    else if (action === 'watch') print(await client.workspaceWatch());
    else if (action === 'recommendations' || action === 'recommend') {
      print(await client.workspaceRecommendations());
    } else throw new Error('workspace expects context, intake, inbox, watch, or recommendations');
    return;
  }
  if ((domain === 'experiment' || domain === 'experiments') && action === 'list') {
    print(await client.localExperiments());
    return;
  }
  if ((domain === 'experiment' || domain === 'experiments') && action === 'inspect') {
    print(await client.localExperiment(required(rest, 0, 'experiment id')));
    return;
  }
  if ((domain === 'experiment' || domain === 'experiments') && action === 'runs') {
    print(await client.localExperimentRuns(rest[0]));
    return;
  }
  if ((domain === 'experiment' || domain === 'experiments') && action === 'compare') {
    const runIds = rest.map((value) => id(value, 'run id'));
    if (runIds.length < 2) throw new Error('experiment compare requires at least two run ids');
    print(comparisonSummary(await client.compareLocalExperiments(runIds)));
    return;
  }
  if ((domain === 'deployment' || domain === 'deployments') && action === 'list') {
    print(await client.localDeployments());
    return;
  }
  if ((domain === 'deployment' || domain === 'deployments') && action === 'inspect') {
    print(await client.localDeployment(required(rest, 0, 'deployment id')));
    return;
  }
  if ((domain === 'deployment' || domain === 'deployments') && action === 'serve') {
    const modelId = required(rest, 0, 'model id');
    const artifactId = option(rest, '--artifact');
    const modelVersionId = option(rest, '--version');
    const endpointId = option(rest, '--endpoint');
    const portText = option(rest, '--port');
    const port = portText === undefined ? undefined : Number(portText);
    if (port !== undefined && !Number.isSafeInteger(port))
      throw new Error('port must be an integer');
    print(
      await client.serveLocalDeployment(
        json({
          modelId,
          ...(artifactId === undefined ? {} : { modelArtifactId: artifactId }),
          ...(modelVersionId === undefined ? {} : { modelVersionId }),
          ...(endpointId === undefined ? {} : { endpointId }),
          ...(port === undefined ? {} : { port }),
          ...(option(rest, '--health-url') === undefined
            ? {}
            : { healthUrl: option(rest, '--health-url') }),
          ...(option(rest, '--invoke-url') === undefined
            ? {}
            : { invokeUrl: option(rest, '--invoke-url') }),
          ...(option(rest, '--runtime') === undefined
            ? {}
            : { servingRuntime: option(rest, '--runtime') }),
          ...(option(rest, '--region') === undefined ? {} : { region: option(rest, '--region') }),
        }),
      ),
    );
    return;
  }
  if ((domain === 'deployment' || domain === 'deployments') && action !== undefined) {
    const deploymentId = required(rest, 0, 'deployment id');
    if (action === 'metrics') {
      print(await client.localDeploymentMetrics(deploymentId));
      return;
    }
    if (action === 'logs') {
      print(await client.localDeploymentLogs(deploymentId));
      return;
    }
    if (action === 'revisions') {
      print(await client.localDeploymentRevisions(deploymentId));
      return;
    }
    if (action === 'observe') {
      print(await client.observeLocalDeployment(deploymentId));
      return;
    }
    if (action === 'update') {
      const input = json({
        ...(option(rest, '--model') === undefined ? {} : { modelId: option(rest, '--model') }),
        ...(option(rest, '--artifact') === undefined
          ? {}
          : { modelArtifactId: option(rest, '--artifact') }),
        ...(option(rest, '--version') === undefined
          ? {}
          : { modelVersionId: option(rest, '--version') }),
        ...(option(rest, '--health-url') === undefined
          ? {}
          : { healthUrl: option(rest, '--health-url') }),
        ...(option(rest, '--invoke-url') === undefined
          ? {}
          : { invokeUrl: option(rest, '--invoke-url') }),
      });
      print(await client.updateLocalDeployment(deploymentId, input));
      return;
    }
    if (action === 'invoke') {
      const payload = jsonOption(rest, '--payload');
      print(
        await client.invokeLocalDeployment(deploymentId, payload === undefined ? {} : { payload }),
      );
      return;
    }
    if (action === 'smoke-test') {
      print(await client.smokeTestLocalDeployment(deploymentId));
      return;
    }
    const approval = jsonOption(rest, '--approval');
    if (action === 'canary') {
      const trafficPercent = Number(required(rest, 1, 'canary traffic percent'));
      if (!Number.isSafeInteger(trafficPercent))
        throw new Error('canary traffic percent must be an integer');
      print(await client.canaryLocalDeployment(deploymentId, trafficPercent, approval));
      return;
    }
    if (action === 'promote') {
      print(await client.promoteLocalDeployment(deploymentId, approval));
      return;
    }
    if (action === 'rollback') {
      print(await client.rollbackLocalDeployment(deploymentId, approval));
      return;
    }
    if (action === 'stop') {
      print(await client.stopLocalDeployment(deploymentId));
      return;
    }
    if (action === 'archive') {
      print(await client.archiveLocalDeployment(deploymentId));
      return;
    }
    if (action === 'restart') {
      print(await client.restartLocalDeployment(deploymentId));
      return;
    }
    if (action === 'scale') {
      const minReplicas = Number(required(rest, 1, 'minimum replicas'));
      const maxReplicas = Number(required(rest, 2, 'maximum replicas'));
      if (!Number.isSafeInteger(minReplicas) || !Number.isSafeInteger(maxReplicas)) {
        throw new Error('replica counts must be integers');
      }
      print(await client.scaleLocalDeployment(deploymentId, { minReplicas, maxReplicas }));
      return;
    }
  }
  if (domain === 'project' && action === 'list') {
    print(await client.projects());
    return;
  }
  if (domain === 'project' && action === 'create') {
    const name = required(rest, 0, 'project name');
    print(await client.createProject(name, rest.slice(1).join(' ') || undefined));
    return;
  }
  if (domain === 'project' && action === 'open') {
    const projectId = id(required(rest, 0, 'project id'), 'project id');
    preferences?.update({ activeProjectId: projectId });
    print(await client.projectConversation(projectId));
    return;
  }
  if ((domain === 'run' || domain === 'runs') && (action === 'prompt' || action === undefined)) {
    const projectId = id(required(rest, 0, 'project id'), 'project id');
    const selectedModel = option(rest, '--model');
    const effectiveModel =
      selectedModel === undefined ? preferences?.load().selectedModel : modelRef(selectedModel);
    const textParts = rest
      .slice(1)
      .filter(
        (value, index, values) =>
          value !== '--follow' && value !== '--model' && values[index - 1] !== '--model',
      );
    const text = textParts.join(' ').trim();
    if (text.length === 0) throw new Error('run prompt text is required');
    preferences?.update({
      activeProjectId: projectId,
      draftInput: '',
      ...(effectiveModel === undefined ? {} : { selectedModel: effectiveModel }),
    });
    const accepted = json(
      await client.sendMessage(projectId, text, undefined, 'tui', effectiveModel),
    ) as Record<string, unknown>;
    const runId = accepted['runId'];
    if (typeof runId !== 'string') throw new Error('API did not return a durable run id');
    print(accepted);
    await waitForRun(client, id(runId, 'run id'), onConnectionStateChange);
    return;
  }
  if ((domain === 'run' || domain === 'runs') && action === 'list') {
    const projectId = rest[0] === undefined ? undefined : id(rest[0], 'project id');
    print(await client.runs(projectId));
    return;
  }
  if ((domain === 'run' || domain === 'runs') && (action === 'show' || action === 'inspect')) {
    printRun(await client.run(id(required(rest, 0, 'run id'), 'run id')));
    return;
  }
  if ((domain === 'run' || domain === 'runs') && action === 'logs') {
    const runId = id(required(rest, 0, 'run id'), 'run id');
    if (rest.includes('--follow')) {
      await waitForRun(client, runId, onConnectionStateChange);
      return;
    }
    print(await client.runLogs(runId));
    return;
  }
  if ((domain === 'run' || domain === 'runs') && action === 'cancel') {
    print(
      await client.cancelRun(
        id(required(rest, 0, 'run id'), 'run id'),
        rest.slice(1).join(' ') || undefined,
      ),
    );
    return;
  }
  if ((domain === 'run' || domain === 'runs') && action === 'retry') {
    print(await client.retryRun(id(required(rest, 0, 'run id'), 'run id')));
    return;
  }
  if (domain === 'run' && action === 'script') {
    const scriptPath = required(rest, 0, 'script path');
    const repositoryId = await defaultRepositoryId(client, option(rest, '--repository'));
    const argsValue = stringArray(jsonOption(rest, '--args'), 'script args');
    const timeoutValue = option(rest, '--timeout-ms');
    const timeoutMs = timeoutValue === undefined ? undefined : Number(timeoutValue);
    if (timeoutMs !== undefined && !Number.isSafeInteger(timeoutMs)) {
      throw new Error('timeout must be an integer');
    }
    print(
      await client.runRepositoryTest(
        repositoryId,
        json({
          command: scriptCommand(scriptPath),
          args: [scriptPath, ...(argsValue ?? [])],
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          ...(option(rest, '--confirmation-id') === undefined
            ? {}
            : { confirmationId: option(rest, '--confirmation-id') }),
        }),
      ),
    );
    return;
  }
  if (domain === 'model' && action === 'select') {
    if (preferences === undefined) throw new Error('model preferences are unavailable');
    const selectedModel = modelRef(required(rest, 0, 'providerId:modelId'));
    const available = await client.models();
    if (
      !available.models.some(
        (model) =>
          model.providerId === selectedModel.providerId && model.modelId === selectedModel.modelId,
      )
    ) {
      throw new Error(
        `${selectedModel.providerId}:${selectedModel.modelId} is not a discovered model`,
      );
    }
    preferences.update({ selectedModel });
    print({ selectedModel, persisted: true });
    return;
  }
  if ((domain === 'model' || domain === 'models') && action === 'registry') {
    print(await client.localModelRegistry());
    return;
  }
  if (domain === 'runtime' && action === 'select') {
    if (preferences === undefined) throw new Error('runtime preferences are unavailable');
    const selectedRuntime = required(rest, 0, 'runtime id');
    preferences.update({ selectedRuntime });
    print({ selectedRuntime, persisted: true });
    return;
  }
  if ((domain === 'notebook' || domain === 'notebooks') && action === 'list') {
    print(await client.listNotebooks());
    return;
  }
  if ((domain === 'notebook' || domain === 'notebooks') && action === 'create') {
    const notebookTitle = rest.filter((value) => value !== '--title')[0] ?? option(rest, '--title');
    print(await client.createNotebook(notebookTitle === undefined ? {} : { title: notebookTitle }));
    return;
  }
  if ((domain === 'notebook' || domain === 'notebooks') && action === 'open') {
    const notebookId = required(rest, 0, 'notebook id');
    const revisionText = option(rest, '--revision');
    const revision = revisionText === undefined ? undefined : Number(revisionText);
    if (revision !== undefined && !Number.isSafeInteger(revision))
      throw new Error('revision must be an integer');
    print(await client.openNotebook(notebookId, revision));
    return;
  }
  if ((domain === 'notebook' || domain === 'notebooks') && action === 'duplicate') {
    const notebookId = required(rest, 0, 'notebook id');
    const title = option(rest, '--title');
    print(await client.duplicateNotebook(notebookId, title === undefined ? {} : { title }));
    return;
  }
  if ((domain === 'notebook' || domain === 'notebooks') && action === 'rename') {
    print(
      await client.renameNotebook(
        required(rest, 0, 'notebook id'),
        required(rest, 1, 'notebook title'),
      ),
    );
    return;
  }
  if ((domain === 'notebook' || domain === 'notebooks') && action === 'archive') {
    print(await client.archiveNotebook(required(rest, 0, 'notebook id')));
    return;
  }
  if ((domain === 'notebook' || domain === 'notebooks') && action === 'restore') {
    print(await client.restoreNotebook(required(rest, 0, 'notebook id')));
    return;
  }
  if ((domain === 'notebook' || domain === 'notebooks') && action === 'delete') {
    print(await client.deleteNotebook(required(rest, 0, 'notebook id')));
    return;
  }
  if ((domain === 'notebook' || domain === 'notebooks') && action === 'versions') {
    print(await client.notebookVersions(required(rest, 0, 'notebook id')));
    return;
  }
  if ((domain === 'notebook' || domain === 'notebooks') && action === 'executions') {
    print(await client.notebookExecutions(required(rest, 0, 'notebook id')));
    return;
  }
  if ((domain === 'notebook' || domain === 'notebooks') && action === 'usage') {
    print(await client.notebookUsage(required(rest, 0, 'notebook id')));
    return;
  }
  if ((domain === 'notebook' || domain === 'notebooks') && action === 'runs') {
    print(await client.notebookRuns(required(rest, 0, 'notebook id')));
    return;
  }
  if ((domain === 'notebook' || domain === 'notebooks') && action === 'inspect') {
    print(await client.notebookRun(required(rest, 0, 'notebook id'), required(rest, 1, 'run id')));
    return;
  }
  if ((domain === 'notebook' || domain === 'notebooks') && action === 'run') {
    const notebookId = required(rest, 0, 'notebook id');
    const revisionText = option(rest, '--revision');
    const revision = revisionText === undefined ? undefined : Number(revisionText);
    if (revision !== undefined && !Number.isSafeInteger(revision))
      throw new Error('revision must be an integer');
    print(await client.runNotebook(notebookId, revision === undefined ? {} : { revision }));
    return;
  }
  if ((domain === 'notebook' || domain === 'notebooks') && action === 'export') {
    print(await client.exportNotebook(required(rest, 0, 'notebook id')));
    return;
  }
  if (domain === 'data' && (action === 'sources' || action === 'connections')) {
    print(action === 'sources' ? await client.dataSources() : await client.dataConnections());
    return;
  }
  if (domain === 'data' && action === 'add') {
    const connectionId = required(rest, 0, 'connection id');
    const kind = option(rest, '--kind') ?? 'file';
    if (!['memory', 'file', 'sql', 'connector'].includes(kind)) {
      throw new Error('data connection kind must be memory, file, sql, or connector');
    }
    const name = option(rest, '--name') ?? connectionId;
    const path = option(rest, '--path');
    print(
      await client.createDataConnection(
        json({
          connectionId,
          name,
          kind,
          ...(path === undefined ? {} : { path }),
          ...(option(rest, '--source-reference') === undefined
            ? {}
            : { sourceReference: option(rest, '--source-reference') }),
        }),
      ),
    );
    return;
  }
  if (domain === 'data' && (action === 'test' || action === 'schema')) {
    const connectionId = required(rest, 0, 'connection id');
    print(
      action === 'test'
        ? await client.testDataConnection(connectionId)
        : await client.dataSchema(connectionId),
    );
    return;
  }
  if (domain === 'data' && (action === 'bind' || action === 'reauthorize')) {
    const connectionId = required(rest, 0, 'connection id');
    const credentialRef = required(rest, 1, 'credential reference');
    print(
      action === 'bind'
        ? await client.bindDataCredential(connectionId, credentialRef)
        : await client.reauthorizeDataCredential(connectionId, credentialRef),
    );
    return;
  }
  if (domain === 'data' && action === 'revoke') {
    print(await client.revokeDataCredential(required(rest, 0, 'connection id')));
    return;
  }
  if ((domain === 'dataset' || domain === 'datasets') && action === 'list') {
    print(await client.localDatasets());
    return;
  }
  if ((domain === 'dataset' || domain === 'datasets') && action === 'publish') {
    const datasetId = required(rest, 0, 'dataset id');
    const connectionId = required(rest, 1, 'connection id');
    const sourceReference = required(rest, 2, 'source reference');
    print(
      await client.publishLocalDatasetVersion(
        json({
          datasetId,
          connectionId,
          sourceReference,
          name: rest[3] ?? datasetId,
        }),
      ),
    );
    return;
  }
  if (
    (domain === 'dataset' || domain === 'datasets') &&
    (action === 'lineage' || action === 'profile' || action === 'quality')
  ) {
    const datasetId = required(rest, 0, 'dataset id');
    const versionText = option(rest, '--version');
    const version = versionText === undefined ? undefined : Number(versionText);
    if (version !== undefined && !Number.isSafeInteger(version)) {
      throw new Error('dataset version must be an integer');
    }
    if (action === 'lineage') print(await client.localDatasetLineage(datasetId, version));
    else if (action === 'profile') print(await client.profileLocalDataset(datasetId, version));
    else {
      print(
        await client.qualityLocalDataset(
          datasetId,
          json({
            ...(version === undefined ? {} : { version }),
            ...(option(rest, '--max-null-fraction') === undefined
              ? {}
              : { maxNullFraction: Number(option(rest, '--max-null-fraction')) }),
          }),
        ),
      );
    }
    return;
  }
  if (domain === 'query' || domain === 'queries') {
    const queryActions = new Set([
      'run',
      'list',
      'saved',
      'save',
      'inspect',
      'cancel',
      'validate',
      'explain',
      'export',
      'handoff',
    ]);
    const filePath = action === '--file' ? required(rest, 0, 'query file') : action;
    if (filePath !== undefined && !queryActions.has(filePath)) {
      const sql = await readFile(filePath, 'utf8');
      print(
        await client.runDataQuery(
          json({
            queryId: newSortableId(),
            sql,
            ...(option(rest, '--connection') === undefined
              ? {}
              : { connectionId: option(rest, '--connection') }),
            ...(option(rest, '--dataset') === undefined
              ? {}
              : { datasetId: option(rest, '--dataset') }),
            ...(option(rest, '--max-rows') === undefined
              ? {}
              : { maxRows: Number(option(rest, '--max-rows')) }),
            ...(option(rest, '--cost-limit') === undefined
              ? {}
              : { costLimit: Number(option(rest, '--cost-limit')) }),
          }),
        ),
      );
      return;
    }
  }
  if ((domain === 'query' || domain === 'queries') && action === 'list') {
    print(await client.dataQueries());
    return;
  }
  if ((domain === 'query' || domain === 'queries') && action === 'saved') {
    print(await client.savedDataQueries());
    return;
  }
  if ((domain === 'query' || domain === 'queries') && action === 'run') {
    const queryId = required(rest, 0, 'query id');
    const sql = option(rest, '--sql') ?? rest.slice(1).join(' ');
    if (sql.trim().length === 0) throw new Error('query SQL is required');
    const maxRowsText = option(rest, '--max-rows');
    const costLimitText = option(rest, '--cost-limit');
    print(
      await client.runDataQuery(
        json({
          queryId,
          sql,
          ...(option(rest, '--connection') === undefined
            ? {}
            : { connectionId: option(rest, '--connection') }),
          ...(option(rest, '--dataset') === undefined
            ? {}
            : { datasetId: option(rest, '--dataset') }),
          ...(maxRowsText === undefined ? {} : { maxRows: Number(maxRowsText) }),
          ...(costLimitText === undefined ? {} : { costLimit: Number(costLimitText) }),
        }),
      ),
    );
    return;
  }
  if ((domain === 'query' || domain === 'queries') && action === 'save') {
    const savedQueryId = required(rest, 0, 'saved query id');
    const name = required(rest, 1, 'saved query name');
    const sql = option(rest, '--sql') ?? rest.slice(2).join(' ');
    if (sql.trim().length === 0) throw new Error('saved query SQL is required');
    print(await client.saveDataQuery(json({ savedQueryId, name, sql })));
    return;
  }
  if (
    (domain === 'query' || domain === 'queries') &&
    (action === 'inspect' ||
      action === 'cancel' ||
      action === 'validate' ||
      action === 'explain' ||
      action === 'export' ||
      action === 'handoff')
  ) {
    const queryId = required(rest, 0, 'query id');
    if (action === 'inspect') print(await client.dataQuery(queryId));
    else if (action === 'cancel') print(await client.cancelDataQuery(queryId));
    else if (action === 'validate') {
      const sql = option(rest, '--sql');
      if (sql === undefined) throw new Error('query validate requires --sql');
      print(await client.validateDataQuery(queryId, sql));
    } else if (action === 'explain') {
      const sql = option(rest, '--sql');
      if (sql === undefined) throw new Error('query explain requires --sql');
      print(
        await client.explainDataQuery(
          queryId,
          json({
            sql,
            ...(option(rest, '--dataset') === undefined
              ? {}
              : { datasetId: option(rest, '--dataset') }),
          }),
        ),
      );
    } else if (action === 'export') {
      print(
        await client.exportDataQuery(queryId, json({ format: option(rest, '--format') ?? 'json' })),
      );
    } else {
      print(
        await client.handoffDataQuery(
          queryId,
          option(rest, '--target') === 'jupyter' ? 'jupyter' : 'browser',
        ),
      );
    }
    return;
  }
  if (domain === 'jupyter' && action === 'discover') {
    print(await client.jupyterDiscovery());
    return;
  }
  if (domain === 'jupyter' && action === 'list') {
    print(await client.jupyterSessions());
    return;
  }
  if (domain === 'jupyter' && action === 'launch') {
    const notebookId = option(rest, '--notebook');
    const projectPath = option(rest, '--project');
    const profileId = option(rest, '--profile');
    print(
      await client.launchJupyterSession({
        ...(notebookId === undefined ? {} : { notebookId }),
        ...(projectPath === undefined ? {} : { projectPath }),
        ...(profileId === undefined ? {} : { profileId }),
      }),
    );
    return;
  }
  if (domain === 'jupyter' && action === 'context') {
    print(await client.jupyterSession(required(rest, 0, 'session id')));
    return;
  }
  if ((domain === 'pipeline' || domain === 'pipelines') && action === 'list') {
    print(await client.pipelines());
    return;
  }
  if ((domain === 'pipeline' || domain === 'pipelines') && action === 'create') {
    const pipelineId = required(rest, 0, 'pipeline id');
    const name = rest.slice(1).join(' ') || option(rest, '--name');
    print(
      await client.createPipeline(json({ pipelineId, ...(name === undefined ? {} : { name }) })),
    );
    return;
  }
  if ((domain === 'pipeline' || domain === 'pipelines') && action === 'inspect') {
    print(await client.pipeline(required(rest, 0, 'pipeline id')));
    return;
  }
  if ((domain === 'pipeline' || domain === 'pipelines') && action === 'validate') {
    print(await client.validatePipeline(required(rest, 0, 'pipeline id')));
    return;
  }
  if ((domain === 'pipeline' || domain === 'pipelines') && action === 'plan') {
    print(await client.planPipeline(required(rest, 0, 'pipeline id')));
    return;
  }
  if ((domain === 'pipeline' || domain === 'pipelines') && action === 'estimate') {
    print(await client.estimatePipeline(required(rest, 0, 'pipeline id')));
    return;
  }
  if ((domain === 'pipeline' || domain === 'pipelines') && action === 'versions') {
    print(await client.pipelineVersions(required(rest, 0, 'pipeline id')));
    return;
  }
  if ((domain === 'pipeline' || domain === 'pipelines') && action === 'publish') {
    const pipelineId = required(rest, 0, 'pipeline id');
    const versionText = option(rest, '--version');
    const version = versionText === undefined ? undefined : Number(versionText);
    if (version !== undefined && !Number.isSafeInteger(version))
      throw new Error('version must be an integer');
    print(await client.publishPipeline(pipelineId, version));
    return;
  }
  if (
    (domain === 'pipeline' || domain === 'pipelines') &&
    (action === 'run' || action === 'dry-run')
  ) {
    const pipelineId = required(rest, 0, 'pipeline id');
    const key = option(rest, '--idempotency-key');
    const input = json(key === undefined ? {} : { idempotencyKey: key });
    print(
      action === 'run'
        ? await client.runPipeline(pipelineId, input)
        : await client.dryRunPipeline(pipelineId, input),
    );
    return;
  }
  if ((domain === 'pipeline' || domain === 'pipelines') && action === 'runs') {
    print(await client.pipelineRuns(required(rest, 0, 'pipeline id')));
    return;
  }
  if ((domain === 'pipeline' || domain === 'pipelines') && action === 'retry') {
    print(
      await client.retryPipelineStage(required(rest, 0, 'run id'), required(rest, 1, 'stage id')),
    );
    return;
  }
  if ((domain === 'automation' || domain === 'automations') && action === 'list') {
    print(await client.automations());
    return;
  }
  if ((domain === 'automation' || domain === 'automations') && action === 'inspect') {
    print(await client.automation(required(rest, 0, 'automation id')));
    return;
  }
  if (
    (domain === 'automation' || domain === 'automations') &&
    (action === 'pause' || action === 'resume')
  ) {
    const automationId = required(rest, 0, 'automation id');
    print(
      action === 'pause'
        ? await client.pauseAutomation(automationId)
        : await client.resumeAutomation(automationId),
    );
    return;
  }
  if ((domain === 'automation' || domain === 'automations') && action === 'trigger') {
    const automationId = required(rest, 0, 'automation id');
    const key = option(rest, '--idempotency-key');
    print(
      await client.triggerAutomation(
        automationId,
        json(key === undefined ? {} : { idempotencyKey: key }),
      ),
    );
    return;
  }
  if ((domain === 'automation' || domain === 'automations') && action === 'runs') {
    print(await client.automationRuns(required(rest, 0, 'automation id')));
    return;
  }
  if ((domain === 'automation' || domain === 'automations') && action === 'notifications') {
    print(await client.automationNotifications(required(rest, 0, 'automation id')));
    return;
  }
  if ((domain === 'connector' || domain === 'connectors') && action === 'list') {
    print(await client.connectorCatalog());
    return;
  }
  if ((domain === 'connector' || domain === 'connectors') && action === 'discover') {
    print(
      await client.discoverConnector(
        required(rest, 0, 'connector id'),
        json({ connectionId: required(rest, 1, 'connection id') }),
      ),
    );
    return;
  }
  if ((domain === 'connector' || domain === 'connectors') && action === 'runs') {
    print(await client.connectorRuns());
    return;
  }
  if ((domain === 'connector' || domain === 'connectors') && action === 'checkpoints') {
    print(await client.connectorCheckpoints());
    return;
  }
  if ((domain === 'connector' || domain === 'connectors') && action === 'schema-events') {
    print(await client.connectorSchemaEvents());
    return;
  }
  if (
    domain === 'jupyter' &&
    (action === 'stop' || action === 'restart' || action === 'interrupt' || action === 'reconnect')
  ) {
    const sessionId = required(rest, 0, 'session id');
    if (action === 'stop') print(await client.stopJupyterSession(sessionId));
    else print(await client.jupyterSessionAction(sessionId, action));
    return;
  }
  if (domain === 'pane' && (action === 'next' || action === 'previous')) {
    if (preferences === undefined) throw new Error('pane preferences are unavailable');
    const panes = ['command', 'inspector', 'logs'] as const;
    const current = preferences.load().activePane;
    const offset = action === 'next' ? 1 : -1;
    const index = (panes.indexOf(current) + offset + panes.length) % panes.length;
    const nextPane = panes[index];
    if (nextPane === undefined) throw new Error('Unable to select a terminal pane');
    preferences.update({ activePane: nextPane });
    print({ activePane: nextPane });
    return;
  }
  if (domain === 'layout' && (action === 'wide' || action === 'narrow')) {
    preferences?.update({ paneLayout: action });
    print({ paneLayout: action });
    return;
  }
  throw new Error(`Unknown command: ${args.join(' ')}`);
}

function shellFrame(preferences: ClientPreferences, connection = 'connected'): string {
  const workspace = preferences.activeWorkspacePath ?? 'current workspace';
  const project = preferences.activeProjectId ?? 'no project selected';
  const model =
    preferences.selectedModel === undefined
      ? 'routing policy'
      : `${preferences.selectedModel.providerId}:${preferences.selectedModel.modelId}`;
  const narrow = preferences.paneLayout === 'narrow' || (process.stdout.columns ?? 80) < 100;
  if (narrow) {
    return `workspace=${workspace} project=${project} model=${model} connection=${connection}`;
  }
  return [
    '┌─ Spyderbyte ───────────────────────────────────────────────────────────────┐',
    `│ workspace: ${workspace}  project: ${project}  model: ${model}`,
    `│ pane: ${preferences.activePane}  connection: ${connection}`,
    '├─ command ─────────────────────── inspector ─────────────── logs/events ────┤',
    '│ type help for commands; ↑/↓ navigates command history; pane next changes focus │',
    '└─────────────────────────────────────────────────────────────────────────────┘',
  ].join('\n');
}

async function interactive(
  client: SpyderbyteClient,
  preferences: ClientPreferencesStore,
): Promise<void> {
  print('Spyderbyte terminal — type help for commands, exit to quit.');
  let connectionState = 'connected';
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      print(shellFrame(preferences.load(), connectionState));
      const line = (await readline.question('spyderbyte> ')).trim();
      if (line === 'exit' || line === 'quit') return;
      if (line.length === 0) continue;
      const recentCommands = [
        ...preferences.load().recentCommands.filter((command) => command !== line),
        line,
      ].slice(-20);
      preferences.update({ recentCommands, draftInput: line });
      try {
        await execute(client, interactiveCommand(line), preferences, (state) => {
          connectionState = state;
          if (state !== 'connected') print(`[connection] ${state}`);
        });
      } catch (error) {
        print(
          error instanceof SpyderbyteClientError
            ? { error: error.message, status: error.status }
            : error instanceof Error
              ? error.message
              : String(error),
        );
      }
    }
  } finally {
    readline.close();
  }
}

function richShellBinary(): string | undefined {
  if (process.env['SPYDERBYTE_SHELL_PLAIN'] === '1') return undefined;
  const explicit = process.env['SPYDERBYTE_SHELL_BIN'];
  const candidates = [
    ...(explicit === undefined ? [] : [explicit]),
    resolve(process.cwd(), 'apps/spyderbyte-shell/target/debug/spyderbyte'),
    resolve(process.cwd(), 'apps/spyderbyte-shell/target/release/spyderbyte'),
    resolve(process.cwd(), '../spyderbyte-shell/target/debug/spyderbyte'),
    resolve(process.cwd(), '../../apps/spyderbyte-shell/target/debug/spyderbyte'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const parsed = parseArguments(args);
  const preferences = new FileClientPreferencesStore();
  if (parsed.workspacePath !== undefined) {
    preferences.update({ activeWorkspacePath: parsed.workspacePath });
  }
  if (parsed.projectId !== undefined) {
    preferences.update({ activeProjectId: id(parsed.projectId, 'project id') });
  }
  if (
    parsed.command.length > 0 &&
    (parsed.command[0] === 'help' || parsed.command[0] === '--help' || parsed.command[0] === '-h')
  ) {
    print(HELP);
    return;
  }
  const handle = await runtime(parsed, preferences);
  try {
    if (
      parsed.command.length === 0 &&
      (await runRichShell(args, parsed, handle.client, preferences))
    ) {
      return;
    }
    if (parsed.command.length === 0) await interactive(handle.client, preferences);
    else await execute(handle.client, parsed.command, preferences);
  } finally {
    await handle.close();
  }
}

if (process.argv[1]?.endsWith('/index.js')) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = exitCodeForError(error);
  });
}
