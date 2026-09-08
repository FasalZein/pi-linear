#!/usr/bin/env node
/**
 * AEO-831 read-only measurement dump.
 *
 * Usage:
 *   vite-node measure-pi-linear.mts --repo /path/to/pi-linear --out dump.json --label before
 *
 * This script imports the real extension source, runs its session-start and help
 * paths, and asks Pi 0.84.2's OpenAI Responses adapter to serialize deterministic
 * replay requests. It stops in onPayload before network access.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`);
  return process.argv[index + 1];
}

const repo = resolve(argument('--repo'));
const out = resolve(argument('--out'));
const label = argument('--label');

const [{ registerLinearExtension }, { helpResult }, provider, providers] = await Promise.all([
  import(pathToFileURL(join(repo, 'extensions/index.ts')).href),
  import(pathToFileURL(join(repo, 'extensions/api.ts')).href),
  import(pathToFileURL(join(repo, 'node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js')).href),
  import(pathToFileURL(join(repo, 'node_modules/@earendil-works/pi-ai/dist/providers/all.js')).href),
]);

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

type Tool = {
  name: string;
  description?: string;
  parameters?: JsonObject;
  promptGuidelines?: string[];
};

const tools: Tool[] = [];
let active: string[] = [];
const sessionHandlers: Array<() => void> = [];
const pi = {
  registerCommand: () => undefined,
  registerTool: (tool: Tool) => { tools.push(tool); active.push(tool.name); },
  getActiveTools: () => [...active],
  getAllTools: () => tools,
  setActiveTools: (names: string[]) => { active = [...names]; },
  on: (event: string, handler: () => void) => { if (event === 'session_start') sessionHandlers.push(handler); },
};
registerLinearExtension(pi as never, 'readonly');
sessionHandlers.forEach((handler) => handler());

const linearTools = tools.filter(({ name }) => name === 'linear' || name.startsWith('linear_'));
const toolByName = new Map(linearTools.map((tool) => [tool.name, tool]));
const startupNames = active.filter((name) => toolByName.has(name));
const allNames = linearTools.map(({ name }) => name);
const packageJson = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));

function compact(value: JsonValue): string {
  return JSON.stringify(value);
}

function localToolJson(tool: Tool): string {
  return compact({ name: tool.name, description: tool.description ?? '', parameters: tool.parameters ?? {} });
}

function help(variables: { domain?: string; operation?: string }) {
  const details = helpResult(variables, (names: string[]) => names);
  return { variables, details, detailsJson: compact(details), loadedTools: details.loadedTools ?? [] };
}

const domains = ['issues', 'comments', 'users', 'teams', 'projects', 'cycles', 'milestones', 'initiatives', 'documents', 'views', 'labels', 'relations', 'workspace'];
const operationNames = allNames.filter((name) => name !== 'linear').map((name) => name.slice('linear_'.length));
const helpDump = {
  root: help({}),
  domains: Object.fromEntries(domains.map((domain) => [domain, help({ domain })])),
  operations: Object.fromEntries(operationNames.map((operation) => [operation, help({ operation })])),
};

const TASKS = {
  issues: {
    prompt: 'Read AEO-258, list active issues, draft a child issue, update AEO-258, and search issues for benchmark.',
    domain: 'issues',
    operations: [
      ['get_issue', { issue: 'AEO-258' }],
      ['list_issues', { first: 20, stateType: 'started' }],
      ['create_issue', { title: 'Benchmark child', team: 'AEO', parent: 'AEO-258' }],
      ['update_issue', { issue: 'AEO-258', title: 'Benchmark issue' }],
      ['search_issues', { query: 'benchmark', first: 20 }],
    ],
  },
  projects: {
    prompt: 'Read pi-linear, list projects, and prepare one project save.',
    domain: 'projects',
    operations: [
      ['get_project', { project: 'pi-linear' }],
      ['list_projects', { first: 20 }],
      ['save_project', { mode: 'create', name: 'Benchmark project', teams: ['AEO'] }],
    ],
  },
  workspace: {
    prompt: 'List issue statuses and switch to the saved work workspace.',
    domain: 'workspace',
    operations: [
      ['list_issue_statuses', { first: 20 }],
      ['switch_workspace', { workspace: 'work' }],
    ],
  },
} as const;

const emptyUsage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const model = providers.getBuiltinModel('openai', 'gpt-5.4');

function providerTools(names: readonly string[]) {
  const selected = new Set(names);
  return linearTools.filter(({ name }) => selected.has(name)).map(({ name, description, parameters }) => ({ name, description, parameters }));
}

type RequestContext = { systemPrompt: string; tools: Array<Pick<Tool, 'name' | 'description' | 'parameters'>>; messages: JsonValue[] };

async function capturePayload(context: RequestContext): Promise<JsonValue> {
  let payload: JsonValue | undefined;
  const events = provider.stream(model, context, {
    apiKey: 'aeo_831_offline_not_a_key',
    onPayload: (value: JsonValue) => { payload = value; throw new Error('AEO831_STOP_BEFORE_NETWORK'); },
    fetch: async () => { throw new Error('AEO831_NETWORK_FORBIDDEN'); },
  });
  await events.result().catch(() => undefined);
  if (payload === undefined) throw new Error('Pi adapter did not emit a payload.');
  return payload;
}

function assistantToolMessage(id: string, name: string, args: JsonValue, timestamp: number) {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: args }],
    api: 'openai-responses', provider: 'openai', model: model.id,
    usage: emptyUsage, stopReason: 'toolUse', timestamp,
  };
}

function toolResultMessage(id: string, name: string, result: JsonValue, addedToolNames: string[], timestamp: number) {
  return {
    role: 'toolResult', toolCallId: id, toolName: name,
    content: [{ type: 'text', text: compact(result) }],
    addedToolNames, isError: false, timestamp,
  };
}

function deterministicResult(operation: string) {
  if (operation.startsWith('list_') || operation.startsWith('search_')) return { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
  if (operation === 'switch_workspace') return { workspace: 'work', switched: true };
  if (operation === 'save_project') return { id: 'project-benchmark', name: 'Benchmark project', url: 'https://linear.app/benchmark' };
  if (operation === 'create_issue') return { id: 'issue-child', identifier: 'AEO-999', title: 'Benchmark child' };
  return { id: 'issue-benchmark', identifier: 'AEO-258', title: 'Benchmark issue' };
}

type Arm = 'all-exposed' | 'all-deferred' | 'hybrid-discovery';

async function replay(scenario: keyof typeof TASKS, arm: Arm) {
  const task = TASKS[scenario];
  const messages: any[] = [{ role: 'user', content: task.prompt, timestamp: 1 }];
  const currentActive = arm === 'all-exposed' ? [...allNames] : [...startupNames];
  const rows: any[] = [];
  const emissions: any[] = [];
  let call = 0;
  let timestamp = 2;

  async function request(nextAction: string) {
    const payload = await capturePayload({ systemPrompt: 'AEO-831 deterministic read-only replay.', tools: providerTools(currentActive), messages });
    const json = compact(payload);
    rows.push({
      request: rows.length + 1,
      nextAction,
      activeTools: [...currentActive],
      bytes: Buffer.byteLength(json, 'utf8'),
      sha256: createHash('sha256').update(json).digest('hex'),
      payloadJson: json,
    });
  }

  async function emitTool(name: string, args: JsonValue, result: JsonValue, added: string[] = []) {
    await request(`tool:${name}`);
    const id = `call-${scenario}-${arm}-${++call}`;
    const assistant = assistantToolMessage(id, name, args, timestamp++);
    const outputJson = compact(assistant.content);
    emissions.push({ kind: 'tool-call', name, bytes: Buffer.byteLength(outputJson, 'utf8'), json: outputJson });
    messages.push(assistant);
    const toolResult = toolResultMessage(id, name, result, added, timestamp++);
    messages.push(toolResult);
    const resultJson = compact(toolResult.content);
    emissions.push({ kind: 'tool-result', name, bytes: Buffer.byteLength(resultJson, 'utf8'), json: resultJson });
  }

  if (arm === 'hybrid-discovery') {
    await emitTool('linear', { operation: 'help' }, helpDump.root.details);
    await emitTool('linear', { operation: 'help', variables: { domain: task.domain } }, helpDump.domains[task.domain].details);
  }

  for (const [operation, seedArgs] of task.operations) {
    const directName = `linear_${operation}`;
    // Use the source's published canonical example. This keeps each semantic task
    // valid across renamed fields while preserving the same operation sequence.
    const args = helpDump.operations[operation]?.details?.example ?? seedArgs;
    if (arm !== 'all-exposed') {
      const exact = helpDump.operations[operation];
      const added = currentActive.includes(directName) ? [] : [directName];
      if (added.length) currentActive.push(directName);
      await emitTool('linear', { operation: 'help', variables: { operation } }, exact.details, added);
    }
    await emitTool(directName, args, deterministicResult(operation));
  }

  await request('final-text');
  const finalText = `Completed deterministic ${scenario} replay.`;
  emissions.push({ kind: 'final-text', name: 'assistant', bytes: Buffer.byteLength(finalText, 'utf8'), json: compact(finalText) });
  return { scenario, arm, helpCalls: arm === 'all-exposed' ? 0 : task.operations.length + (arm === 'hybrid-discovery' ? 2 : 0), wrongCalls: null, completion: 'not measured: no model was run', requests: rows, emissions };
}

const replays: Record<string, Awaited<ReturnType<typeof replay>>> = {};
for (const scenario of Object.keys(TASKS) as Array<keyof typeof TASKS>) {
  for (const arm of ['all-exposed', 'all-deferred', 'hybrid-discovery'] as const) {
    replays[`${scenario}/${arm}`] = await replay(scenario, arm);
  }
}

const dump = {
  measuredAt: new Date().toISOString(), label, repo,
  source: { packageVersion: packageJson.version, gitCommit: process.env.AEO831_SOURCE_COMMIT ?? null },
  providerSerializer: { package: '@earendil-works/pi-ai', version: '0.84.2', api: 'openai-responses', model: model.id, network: false },
  registration: { registeredCount: allNames.length, registeredNames: allNames, startupActive: startupNames },
  tools: Object.fromEntries(linearTools.map((tool) => [tool.name, {
    localJson: localToolJson(tool),
    bytes: Buffer.byteLength(localToolJson(tool), 'utf8'),
    propertyNames: Object.keys((tool.parameters?.properties as JsonObject | undefined) ?? {}),
  }])),
  help: helpDump,
  fixedTaskSet: Object.fromEntries(Object.entries(TASKS).map(([name, task]) => [name, {
    prompt: task.prompt,
    domain: task.domain,
    operations: task.operations.map(([operation]) => operation),
  }])),
  resolvedDirectArguments: Object.fromEntries(Object.entries(TASKS).map(([name, task]) => [name,
    Object.fromEntries(task.operations.map(([operation, seedArgs]) => [operation,
      helpDump.operations[operation]?.details?.example ?? seedArgs,
    ])),
  ])),
  replays,
};
await writeFile(out, JSON.stringify(dump, null, 2));
console.log(JSON.stringify({ out, label, registered: allNames.length, startup: startupNames, replayCount: Object.keys(replays).length }, null, 2));
