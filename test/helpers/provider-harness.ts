import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wrapRegisteredTools } from '@earendil-works/pi-coding-agent';
import { getBuiltinModel } from '../../node_modules/@earendil-works/pi-ai/dist/providers/all.js';
import { stream as anthropicStream } from '../../node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js';
import { stream as openaiStream } from '../../node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js';
import { registerLinearExtension } from '../../extensions/index';

export const NATIVE_ANTHROPIC_MODEL = getBuiltinModel('anthropic', 'claude-sonnet-4-5');
export const NATIVE_OPENAI_MODEL = getBuiltinModel('openai', 'gpt-5.4');

const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export type LinearHarness = ReturnType<typeof createLinearHarness>;

export function createLinearHarness(mode: 'allowlist' | 'readonly' = 'allowlist') {
  const registered: any[] = [];
  const commands = new Map<string, unknown>();
  const sessionHandlers: Array<(event?: unknown, ctx?: unknown) => unknown> = [];
  let active: string[] = ['read', 'bash'];
  const history: string[][] = [];
  const pi = {
    registerCommand: (name: string, command: unknown) => { commands.set(name, command); },
    registerTool: (tool: any) => {
      registered.push(tool);
      active.push(tool.name);
    },
    getActiveTools: () => [...active],
    getAllTools: () => registered.map((tool) => ({ name: tool.name, parameters: tool.parameters })),
    setActiveTools: (names: string[]) => {
      active = [...names];
      history.push([...names]);
    },
    on: (event: string, handler: (event?: unknown, ctx?: unknown) => unknown) => {
      if (event === 'session_start') sessionHandlers.push(handler);
    },
  };
  registerLinearExtension(pi as any, mode);
  return {
    pi: pi as any,
    registered,
    commands,
    history,
    startSession: () => sessionHandlers.forEach((handler) => handler()),
    activeTools: () => [...active],
    tool: (name: string) => registered.find((entry) => entry.name === name),
    setActive: (names: string[]) => { active = [...names]; },
  };
}

export async function isolateAgentDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-linear-provider-'));
  process.env.PI_CODING_AGENT_DIR = directory;
  return directory;
}

export function execute(tool: any, params: Record<string, unknown>) {
  return tool.execute('call-1', params, undefined, undefined, { hasUI: false });
}

export function asProviderTools(tools: readonly any[]) {
  return tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

export async function activateGetIssue(harness: LinearHarness) {
  harness.startSession();
  const result = await execute(harness.tool('linear_api'), {
    operation: 'help',
    variables: { operation: 'get_issue' },
  });
  return result;
}

export function wrapLoader(harness: LinearHarness) {
  const runner = {
    getActiveTools: () => harness.activeTools(),
    createContext: () => ({ hasUI: false }),
  };
  const [wrapped] = wrapRegisteredTools(
    [{ definition: harness.tool('linear_api'), sourceInfo: { path: 'linear', source: 'extension' } as any }],
    runner as any,
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

export function activationContext(harness: LinearHarness, addedToolNames: string[]) {
  const active = harness.activeTools();
  const tools = asProviderTools(harness.registered.filter((tool) => active.includes(tool.name)));
  return {
    systemPrompt: 'linear provider harness',
    tools,
    messages: [
      { role: 'user' as const, content: 'load get_issue', timestamp: 1 },
      {
        role: 'assistant' as const,
        content: [{ type: 'toolCall' as const, id: 'call-1', name: 'linear_api', arguments: { operation: 'help' } }],
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
        toolName: 'linear_api',
        content: [{ type: 'text' as const, text: 'loaded linear_get_issue' }],
        addedToolNames,
        isError: false,
        timestamp: 3,
      },
    ],
  };
}

export async function capturePayload(
  stream: typeof anthropicStream | typeof openaiStream,
  model: any,
  context: any,
): Promise<any> {
  let payload: unknown;
  const events = stream(model, context, {
    apiKey: 'lin_harness_not_a_real_key',
    onPayload: (params: unknown) => {
      payload = params;
      throw new Error('LINEAR_PROVIDER_HARNESS_STOP');
    },
    fetch: async () => {
      throw new Error('LINEAR_PROVIDER_HARNESS_NO_NETWORK');
    },
  } as any);
  await events.result().catch(() => undefined);
  if (!payload) throw new Error('First-party adapter did not emit a request payload.');
  return payload;
}

export function captureAnthropic(model: any, context: any) {
  return capturePayload(anthropicStream, model, context);
}

export function captureOpenAI(model: any, context: any) {
  return capturePayload(openaiStream, model, context);
}

export function payloadText(payload: unknown): string {
  return JSON.stringify(payload);
}

export function hasNativeOnlyMarker(payload: unknown): boolean {
  return /defer_loading|tool_reference|tool_search_call|tool_search_output|"type":"additional_tools"/.test(payloadText(payload));
}
