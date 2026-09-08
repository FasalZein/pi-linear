import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { registerLinearExtension } from '../extensions/index';

type Tool = { name: string; description: string; parameters: unknown };
type Baseline = { baseline: number; current: number; before?: number };

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
const listFixture = JSON.parse(await readFile(resolve('scripts/fixtures/list-schema-bytes.json'), 'utf8')) as Record<string, number>;
const initialActive = [...active];
const scenarios: Array<[string, string[]]> = [
  ['initial', []],
  ['oneTool', ['linear_get_issue']],
  ['fiveTools', ['linear_get_issue', 'linear_list_issues', 'linear_create_comment', 'linear_create_issue', 'linear_update_issue']],
  ['allTools', tools.filter(({ name }) => name.startsWith('linear_')).map(({ name }) => name)],
];

function schemaBytes(names: readonly string[]): number {
  const selected = new Set(names);
  return tools.filter(({ name }) => selected.has(name)).reduce((sum, { name, description, parameters }) =>
    sum + Buffer.byteLength(JSON.stringify({ name, description, parameters }), 'utf8'), 0);
}

let failed = false;
const listTools = tools
  .filter(({ name }) => name.startsWith('linear_list_') || name === 'linear_search_issues')
  .map(({ name }) => name);
const expectedListTools = Object.keys(listFixture);
if (JSON.stringify([...listTools].sort()) !== JSON.stringify([...expectedListTools].sort())) {
  console.error(`listTools: expected ${expectedListTools.length} fixture entries for ${listTools.length} supported list operations`);
  failed = true;
}
for (const name of listTools) {
  const current = schemaBytes([name]);
  console.log(`${name}: v0.9 current ${current} bytes`);
  if (current !== listFixture[name]) {
    console.error(`${name}: expected current ${listFixture[name] ?? 'missing'} bytes`);
    failed = true;
  }
}
const directResult = schemaBytes(['linear_get_result']);
console.log(`directResult: v0.9 current ${directResult} bytes`);
if (directResult !== fixture.directResult?.current) {
  console.error(`directResult: expected current ${fixture.directResult?.current ?? 'missing'} bytes`);
  failed = true;
}
const directGraphql = schemaBytes(['linear_graphql']);
console.log(`directGraphql: v0.9 current ${directGraphql} bytes`);
if (directGraphql !== fixture.directGraphql?.current) {
  console.error(`directGraphql: expected current ${fixture.directGraphql?.current ?? 'missing'} bytes`);
  failed = true;
}
const directBatch = schemaBytes(['linear_batch']);
console.log(`directBatch: v0.9 current ${directBatch} bytes`);
if (directBatch !== fixture.directBatch?.current) {
  console.error(`directBatch: expected current ${fixture.directBatch?.current ?? 'missing'} bytes`);
  failed = true;
}
for (const [name, additions] of scenarios) {
  active = [...new Set([...initialActive, ...additions])];
  const current = schemaBytes(active);
  const expected = fixture[name];
  if (!expected) throw new Error(`Missing schema-byte fixture for ${name}.`);
  console.log(`${name}: v0.5 baseline ${expected.baseline} bytes; v0.9 current ${current} bytes`);
  if (current !== expected.current) {
    console.error(`${name}: expected current ${expected.current} bytes`);
    failed = true;
  }
  if (expected.before !== undefined && current >= expected.before) {
    console.error(`${name}: must decrease from measured pre-slice value ${expected.before} bytes`);
    failed = true;
  }
}
if (failed) process.exitCode = 1;
