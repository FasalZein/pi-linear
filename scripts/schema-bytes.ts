import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { registerLinearExtension } from '../extensions/index';

type Tool = { name: string; description: string; parameters: unknown };
type Baseline = { baseline: number; current: number };

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
} as any;

registerLinearExtension(pi);
sessionHandlers.forEach((handler) => handler());

const fixture = JSON.parse(await readFile(resolve('scripts/fixtures/schema-bytes.json'), 'utf8')) as Record<string, Baseline>;
const scenarios: Array<[string, string[]]> = [
  ['initial', []],
  ['oneTool', ['linear_get_issue']],
  ['fiveTools', ['linear_get_issue', 'linear_list_issues', 'linear_create_comment', 'linear_create_issue', 'linear_update_issue']],
  ['allTools', tools.filter(({ name }) => name.startsWith('linear_') && name !== 'linear_api').map(({ name }) => name)],
];

function schemaBytes(names: readonly string[]): number {
  const selected = new Set(names);
  return tools.filter(({ name }) => selected.has(name)).reduce((sum, { name, description, parameters }) =>
    sum + Buffer.byteLength(JSON.stringify({ name, description, parameters }), 'utf8'), 0);
}

let failed = false;
for (const [name, additions] of scenarios) {
  active = [...new Set(['linear_api', ...additions])];
  const current = schemaBytes(active);
  const expected = fixture[name];
  if (!expected) throw new Error(`Missing schema-byte fixture for ${name}.`);
  console.log(`${name}: v0.5 baseline ${expected.baseline} bytes; v0.6 current ${current} bytes`);
  if (current !== expected.current) {
    console.error(`${name}: expected current ${expected.current} bytes`);
    failed = true;
  }
}
if (failed) process.exitCode = 1;
