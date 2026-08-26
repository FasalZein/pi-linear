import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wrapRegisteredTools } from '@earendil-works/pi-coding-agent';
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
  RegisteredCommand,
  SessionStartEvent,
  SourceInfo,
} from '@earendil-works/pi-coding-agent';
import { getBuiltinModel } from '../../node_modules/@earendil-works/pi-ai/dist/providers/all.js';
import { stream as anthropicStream } from '../../node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js';
import { stream as openaiStream } from '../../node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js';
import type {
  AssistantMessageEventStream,
  Context,
  StreamOptions,
  Tool,
} from '../../node_modules/@earendil-works/pi-ai/dist/types.js';
import { registerLinearExtension } from '../../extensions/index';
import { isJsonObject, requireJsonObject, type JsonObject, type JsonValue } from '../../extensions/json';
import { isCompatibilityBoolean, isCompatibilityString } from '../../extensions/operation-types';
import type { MutationMode } from '../../extensions/safety';
import { typedLinearTools } from '../../extensions/typed-tools';

export const NATIVE_ANTHROPIC_MODEL = getBuiltinModel('anthropic', 'claude-sonnet-4-5');
export const NATIVE_OPENAI_MODEL = getBuiltinModel('openai', 'gpt-5.4');

/** A Linear tool exactly as production publishes it to the extension API. */
type LinearTool = ReturnType<typeof typedLinearTools>[number];
/** Every registered Linear tool prepares its own arguments, so the harness exposes that as required. */
type HarnessTool = LinearTool & { prepareArguments: NonNullable<LinearTool['prepareArguments']> };
type ToolArguments = Parameters<LinearTool['execute']>[1];
type HarnessCommand = Omit<RegisteredCommand, 'name' | 'sourceInfo'>;
type SessionStartHandler = ExtensionHandler<SessionStartEvent>;
type ProviderKind = 'Anthropic' | 'OpenAI';

/** The harness runs tools headless: only `hasUI` is read on this path. */
const HEADLESS_CONTEXT = { hasUI: false } as ExtensionContext;
const HARNESS_SOURCE: SourceInfo = {
  path: 'linear',
  source: 'extension',
  scope: 'temporary',
  origin: 'top-level',
};

const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Provider request tool entry, limited to values inspected by provider route tests. */
export type ProviderPayloadTool = {
  name: string;
  defer_loading?: boolean;
  input_schema?: ProviderPayloadSchema;
  parameters?: ProviderPayloadSchema;
};
export type ProviderPayloadSchema = {
  type?: string;
  properties?: {
    operation?: ProviderPayloadProperty;
  };
};
export type ProviderPayloadProperty = {
  description?: string;
};
/** OpenAI Responses input item, including tool-search and additional-tools items. */
export type ProviderPayloadInputItem = {
  type?: string;
  status?: string;
  execution?: string;
  tools?: ProviderPayloadTool[];
};
export type ProviderPayloadContentBlock = {
  type: string;
  tool_name?: string;
  content?: string | ProviderPayloadContentBlock[];
};
export type ProviderPayloadMessage = {
  role: string;
  content: string | ProviderPayloadContentBlock[];
};
/** Parsed provider request payload owned by the route-test harness. */
export type ProviderPayload = {
  tools: ProviderPayloadTool[];
  input: ProviderPayloadInputItem[];
  messages: ProviderPayloadMessage[];
};

export type LinearHarness = ReturnType<typeof createLinearHarness>;

function requiredString(object: JsonObject, key: string, path: string): string {
  const value = object[key];
  if (!isCompatibilityString(value)) throw new Error(`${path}.${key} must be a string.`);
  return value;
}

function optionalString(object: JsonObject, key: string, path: string): string | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (!isCompatibilityString(value)) throw new Error(`${path}.${key} must be a string.`);
  return value;
}

function optionalBoolean(object: JsonObject, key: string, path: string): boolean | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (!isCompatibilityBoolean(value)) throw new Error(`${path}.${key} must be a boolean.`);
  return value;
}

function requiredArray(object: JsonObject, key: string, path: string): readonly JsonValue[] {
  const value = object[key];
  if (!Array.isArray(value)) throw new Error(`${path}.${key} must be an array.`);
  return value;
}

function objectItem(value: JsonValue | undefined, path: string): JsonObject {
  if (!isJsonObject(value)) throw new Error(`${path} must be a JSON object.`);
  return value;
}

function parseProperty(value: JsonValue, path: string): ProviderPayloadProperty {
  const object = objectItem(value, path);
  return { description: optionalString(object, 'description', path) };
}

function parseSchema(value: JsonValue, path: string): ProviderPayloadSchema {
  const object = objectItem(value, path);
  const properties = object.properties === undefined
    ? undefined
    : objectItem(object.properties, `${path}.properties`);
  return {
    type: optionalString(object, 'type', path),
    properties: properties === undefined
      ? undefined
      : {
          operation: properties.operation === undefined
            ? undefined
            : parseProperty(properties.operation, `${path}.properties.operation`),
        },
  };
}

function parseTool(value: JsonValue, path: string): ProviderPayloadTool {
  const object = objectItem(value, path);
  return {
    name: requiredString(object, 'name', path),
    defer_loading: optionalBoolean(object, 'defer_loading', path),
    input_schema: object.input_schema === undefined
      ? undefined
      : parseSchema(object.input_schema, `${path}.input_schema`),
    parameters: object.parameters === undefined
      ? undefined
      : parseSchema(object.parameters, `${path}.parameters`),
  };
}

function parseTools(values: readonly JsonValue[], path: string): ProviderPayloadTool[] {
  return values.map((value, index) => parseTool(value, `${path}[${index}]`));
}

function parseContentBlock(value: JsonValue, path: string): ProviderPayloadContentBlock {
  const object = objectItem(value, path);
  const content = object.content;
  let parsedContent: string | ProviderPayloadContentBlock[] | undefined;
  if (isCompatibilityString(content) || content === undefined) parsedContent = content;
  else if (Array.isArray(content)) {
    parsedContent = content.map((entry, index) => parseContentBlock(entry, `${path}.content[${index}]`));
  } else {
    throw new Error(`${path}.content must be a string or an array.`);
  }
  return {
    type: requiredString(object, 'type', path),
    tool_name: optionalString(object, 'tool_name', path),
    content: parsedContent,
  };
}

function parseMessage(value: JsonValue, path: string): ProviderPayloadMessage {
  const object = objectItem(value, path);
  const content = object.content;
  if (isCompatibilityString(content)) {
    return { role: requiredString(object, 'role', path), content };
  }
  if (!Array.isArray(content)) throw new Error(`${path}.content must be a string or an array.`);
  return {
    role: requiredString(object, 'role', path),
    content: content.map((entry, index) => parseContentBlock(entry, `${path}.content[${index}]`)),
  };
}

function parseInputItem(value: JsonValue, path: string): ProviderPayloadInputItem {
  const object = objectItem(value, path);
  const type = optionalString(object, 'type', path);
  const status = optionalString(object, 'status', path);
  const execution = optionalString(object, 'execution', path);
  const tools = object.tools === undefined ? undefined : parseTools(requiredArray(object, 'tools', path), `${path}.tools`);
  if ((type === 'additional_tools' || type === 'tool_search_output') && tools === undefined) {
    throw new Error(`${path}.tools must be an array.`);
  }
  if ((type === 'tool_search_call' || type === 'tool_search_output') && status === undefined) {
    throw new Error(`${path}.status must be a string.`);
  }
  if (type === 'tool_search_call' && execution === undefined) {
    throw new Error(`${path}.execution must be a string.`);
  }
  return { type, status, execution, tools };
}

/** Decode and validate the provider values consumed by route tests. */
export function parseProviderPayload(cause: unknown, provider: ProviderKind): ProviderPayload {
  const payload = requireJsonObject(cause, `${provider} provider payload`);
  const tools = parseTools(requiredArray(payload, 'tools', `${provider} provider payload`), `${provider} provider payload.tools`);
  if (provider === 'Anthropic') {
    const messages = requiredArray(payload, 'messages', `${provider} provider payload`)
      .map((value, index) => parseMessage(value, `${provider} provider payload.messages[${index}]`));
    return { tools, input: [], messages };
  }
  const input = requiredArray(payload, 'input', `${provider} provider payload`)
    .map((value, index) => parseInputItem(value, `${provider} provider payload.input[${index}]`));
  return { tools, input, messages: [] };
}

export function createLinearHarness(mode: MutationMode = 'allowlist') {
  const registered: LinearTool[] = [];
  const commands = new Map<string, HarnessCommand>();
  const sessionHandlers: SessionStartHandler[] = [];
  let active: string[] = ['read', 'bash'];
  const history: string[][] = [];
  const pi = {
    registerCommand: (name: string, command: HarnessCommand) => { commands.set(name, command); },
    registerTool: (tool: LinearTool) => {
      registered.push(tool);
      active.push(tool.name);
    },
    getActiveTools: () => [...active],
    getAllTools: () => registered.map(({ name, description, parameters, promptGuidelines }) => ({
      name,
      description,
      parameters,
      promptGuidelines,
      sourceInfo: HARNESS_SOURCE,
    })),
    setActiveTools: (names: string[]) => {
      active = [...names];
      history.push([...names]);
    },
    on: (event: string, handler: SessionStartHandler) => {
      if (event === 'session_start') sessionHandlers.push(handler);
    },
  };
  // The extension only uses the members above; the assertion binds this double to the real API.
  registerLinearExtension(pi as ExtensionAPI, mode);
  return {
    registered,
    commands,
    history,
    startSession: () => sessionHandlers.forEach((handler) => handler({ type: 'session_start', reason: 'startup' }, HEADLESS_CONTEXT)),
    activeTools: () => [...active],
    tool: (name: string): HarnessTool => {
      const entry = registered.find((candidate) => candidate.name === name);
      if (!entry?.prepareArguments) throw new Error(`The harness has no registered tool named ${name}.`);
      return { ...entry, prepareArguments: entry.prepareArguments };
    },
    setActive: (names: string[]) => { active = [...names]; },
  };
}

export async function isolateAgentDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-linear-provider-'));
  process.env.PI_CODING_AGENT_DIR = directory;
  return directory;
}

export function execute(tool: HarnessTool, params: ToolArguments) {
  return tool.execute('call-1', params, undefined, undefined, HEADLESS_CONTEXT);
}

export function asProviderTools(tools: readonly LinearTool[]): Tool[] {
  return tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

export async function activateGetIssue(harness: LinearHarness) {
  harness.startSession();
  const result = await execute(harness.tool('linear'), {
    operation: 'help',
    variables: { operation: 'get_issue' },
  });
  return result;
}

export function wrapLoader(harness: LinearHarness) {
  const runner = {
    getActiveTools: () => harness.activeTools(),
    createContext: () => HEADLESS_CONTEXT,
  };
  const [wrapped] = wrapRegisteredTools(
    [{ definition: harness.tool('linear'), sourceInfo: HARNESS_SOURCE }],
    runner as Parameters<typeof wrapRegisteredTools>[1],
  );
  return wrapped;
}

export async function loadIssueThroughWrapper(harness: LinearHarness) {
  harness.startSession();
  const wrapped = wrapLoader(harness);
  const result = await wrapped.execute('call-1', {
    operation: 'help',
    variables: { operation: 'get_issue' },
  }, undefined, undefined);
  return { ...result, addedToolNames: result.addedToolNames ?? [] };
}

export function activationContext(harness: LinearHarness, addedToolNames: string[]): Context {
  const active = harness.activeTools();
  const tools = asProviderTools(harness.registered.filter((tool) => active.includes(tool.name)));
  return {
    systemPrompt: 'linear provider harness',
    tools,
    messages: [
      { role: 'user' as const, content: 'load get_issue', timestamp: 1 },
      {
        role: 'assistant' as const,
        content: [{ type: 'toolCall' as const, id: 'call-1', name: 'linear', arguments: { operation: 'help' } }],
        api: 'anthropic-messages',
        provider: 'anthropic',
        model: NATIVE_ANTHROPIC_MODEL.id,
        usage: emptyUsage,
        stopReason: 'toolUse' as const,
        timestamp: 2,
      },
      {
        role: 'toolResult' as const,
        toolCallId: 'call-1',
        toolName: 'linear',
        content: [{ type: 'text' as const, text: 'loaded linear_get_issue' }],
        addedToolNames,
        isError: false,
        timestamp: 3,
      },
    ],
  };
}

/**
 * Runs a first-party adapter far enough to serialize its request, then stops it before
 * any network access and parses the payload it was about to send.
 */
async function capturePayload(
  provider: ProviderKind,
  send: (options: StreamOptions) => AssistantMessageEventStream,
): Promise<ProviderPayload> {
  let payload: unknown;
  const events = send({
    apiKey: 'lin_harness_not_a_real_key',
    onPayload: (params) => {
      payload = params;
      throw new Error('LINEAR_PROVIDER_HARNESS_STOP');
    },
    fetch: async () => {
      throw new Error('LINEAR_PROVIDER_HARNESS_NO_NETWORK');
    },
  });
  await events.result().catch(() => undefined);
  if (payload === undefined) throw new Error('First-party adapter did not emit a request payload.');
  return parseProviderPayload(payload, provider);
}

export function captureAnthropic(
  model: Parameters<typeof anthropicStream>[0],
  context: Context,
): Promise<ProviderPayload> {
  return capturePayload('Anthropic', (options) => anthropicStream(model, context, options));
}

export function captureOpenAI(
  model: Parameters<typeof openaiStream>[0],
  context: Context,
): Promise<ProviderPayload> {
  return capturePayload('OpenAI', (options) => openaiStream(model, context, options));
}

export function payloadText(payload: ProviderPayload): string {
  return JSON.stringify(payload);
}

export function hasNativeOnlyMarker(payload: ProviderPayload): boolean {
  return /defer_loading|tool_reference|tool_search_call|tool_search_output|"type":"additional_tools"/.test(payloadText(payload));
}
