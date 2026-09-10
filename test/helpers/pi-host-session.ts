import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { IsObject, Type, type TSchema } from 'typebox';
import type { AddressInfo } from 'node:net';
import { vi } from 'vitest';
import {
  InMemoryCredentialStore,
  fauxAssistantMessage,
  fauxProvider,
  type Context,
} from '@earendil-works/pi-ai';
import { validateToolArguments } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import type { JsonObject } from '../../extensions/json';
import manifest from '../../extensions/generated/linear-tools.manifest.json';

const EXTENSION_PATH = resolve('extensions/index.ts');
export const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
export const TEAM_ID = '22222222-2222-4222-8222-222222222222';
export const FIXTURE_KEY = 'linear-e2e-fixture-key-never-send';

const TRACKED_ENV = [
  'LINEAR_API_KEY',
  'LINEAR_READONLY',
  'LINEAR_SMOKE_GRAPHQL_ENDPOINT',
  'LINEAR_MUTATIONS',
  'PI_ARTIFACT_PROJECT_ROOT',
  'PI_CODING_AGENT_DIR',
] as const;
const originalEnv = Object.fromEntries(TRACKED_ENV.map((name) => [name, process.env[name]]));
const sessions: AgentSession[] = [];
const servers: Server[] = [];
const temporaryDirectories: string[] = [];

export type GraphQLRequest = { query: string; variables: JsonObject };
export type ToolResult = {
  content: Array<{ type: string; text?: string }>;
  details?: JsonObject;
  addedToolNames?: string[];
};

export async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

export async function startGraphQLServer(
  respond: (request: GraphQLRequest, index: number) => { status?: number; body: unknown },
): Promise<{ endpoint: string; requests: GraphQLRequest[] }> {
  const requests: GraphQLRequest[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const parsed = JSON.parse(body) as GraphQLRequest;
      requests.push(parsed);
      const result = respond(parsed, requests.length - 1);
      response.writeHead(result.status ?? 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result.body));
    });
  });
  servers.push(server);
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address() as AddressInfo;
  return { endpoint: `http://127.0.0.1:${address.port}/graphql`, requests };
}

export async function createHostSession(options: {
  responses?: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0];
  reason?: 'startup' | 'resume';
  sentinel?: boolean;
  fullLinearAllowlist?: boolean;
  registryRefreshExtension?: boolean;
  hideLinearOnFirstPrompt?: boolean;
} = {}) {
  const cwd = await temporaryDirectory('pi-linear-host-cwd-');
  const agentDir = await temporaryDirectory('pi-linear-host-agent-');
  const artifactRoot = await temporaryDirectory('pi-linear-host-artifacts-');
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_ARTIFACT_PROJECT_ROOT = artifactRoot;

  const extensionPaths = [EXTENSION_PATH];
  if (options.registryRefreshExtension) {
    const extensionDirectory = await temporaryDirectory('pi-linear-registry-refresh-');
    const extensionPath = join(extensionDirectory, 'registry-refresh.mjs');
    await writeFile(extensionPath, `export default function (pi) {
  let registered = false;
  pi.on('agent_end', () => {
    if (registered) return;
    registered = true;
    pi.registerTool({
      name: 'fixture_registry_refresh',
      label: 'Fixture registry refresh',
      description: 'Trigger a supported dynamic tool registry refresh.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
    });
  });
}\n`);
    extensionPaths.unshift(extensionPath);
  }
  if (options.hideLinearOnFirstPrompt) {
    const extensionDirectory = await temporaryDirectory('pi-linear-startup-hide-');
    const extensionPath = join(extensionDirectory, 'startup-hide.mjs');
    await writeFile(extensionPath, `export default function (pi) {
  let hidden = false;
  pi.on('session_start', () => { hidden = false; });
  pi.on('before_agent_start', () => {
    if (hidden) return;
    hidden = true;
    pi.setActiveTools(pi.getActiveTools().filter((name) => name !== 'linear' && name !== 'linear_get_result'));
  });
}\n`);
    extensionPaths.unshift(extensionPath);
  }

  const faux = fauxProvider({ provider: `linear-e2e-faux-${Math.random().toString(36).slice(2)}` });
  faux.setResponses(options.responses ?? [fauxAssistantMessage('done')]);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: extensionPaths,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const created = await createAgentSession({
    cwd,
    agentDir,
    model: faux.getModel(),
    modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    noTools: 'builtin',
    tools: options.fullLinearAllowlist
      ? [...manifest.allowedTools, ...(options.sentinel ? ['host_sentinel'] : [])]
      : undefined,
    customTools: options.sentinel ? [{
      name: 'host_sentinel',
      label: 'Host sentinel',
      description: 'A non-Linear tool that must survive Linear session setup.',
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => ({ content: [{ type: 'text', text: 'sentinel' }], details: {} }),
    }] : undefined,
    sessionStartEvent: options.reason === 'resume'
      ? { type: 'session_start', reason: 'resume', previousSessionFile: '/fixture/previous.jsonl' }
      : { type: 'session_start', reason: 'startup' },
  });
  await created.session.bindExtensions({ mode: 'print', shutdownHandler: () => undefined });
  sessions.push(created.session);
  return { ...created, faux, cwd, artifactRoot };
}

export function activeTool(session: AgentSession, name: string) {
  const tool = session.agent.state.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Expected active tool ${name}.`);
  return tool;
}

export async function executeActiveTool(
  session: AgentSession,
  name: string,
  arguments_: JsonObject,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const tool = activeTool(session, name);
  const prepared = tool.prepareArguments?.(arguments_) ?? arguments_;
  const validated = validateToolArguments(tool, {
    type: 'toolCall',
    id: `call-${name}`,
    name,
    arguments: prepared,
  });
  return tool.execute(`call-${name}`, validated, signal) as Promise<ToolResult>;
}

export function snapshotContext(context: Context): Context {
  return {
    systemPrompt: context.systemPrompt,
    messages: structuredClone(context.messages),
    tools: context.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })),
  };
}

export function toolNames(context: Context): string[] {
  return (context.tools ?? []).map((tool) => tool.name);
}

export function linearToolNames(names: readonly string[]): string[] {
  return names.filter((name) => name === 'linear' || name.startsWith('linear_'));
}

export function schemaPropertyNames(schema: TSchema | undefined): string[] {
  if (!schema || !IsObject(schema)) throw new Error('Expected an object tool schema.');
  return Object.keys(schema.properties);
}

export function toolResultDetails(context: Context, name: string): JsonObject {
  const message = [...context.messages].reverse().find(
    (candidate) => candidate.role === 'toolResult' && candidate.toolName === name,
  );
  if (!message || message.role !== 'toolResult') throw new Error(`Missing ${name} result.`);
  const text = message.content.find((content) => content.type === 'text');
  if (!text || text.type !== 'text') throw new Error(`Missing ${name} result text.`);
  return JSON.parse(text.text) as JsonObject;
}

export function issue(identifier: string, title: string) {
  return {
    id: ISSUE_ID,
    identifier,
    title,
    team: { id: TEAM_ID, key: 'AEO', name: 'Agent Experience' },
    state: { id: 'state-1', name: 'Open', type: 'started' },
  };
}

/** Dispose every host fixture this module created, then restore the tracked environment. */
export async function resetHostFixtures(): Promise<void> {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const session of sessions.splice(0)) session.dispose();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  })));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  for (const name of TRACKED_ENV) {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
