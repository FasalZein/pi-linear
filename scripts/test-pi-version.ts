import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const versions = {
  min: '0.80.7',
  current: '0.84.2',
} as const;



function runCommand(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, CI: '1' } });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

async function run(kind: keyof typeof versions) {
  const version = versions[kind];
  const parent = await mkdtemp(join(tmpdir(), `pi-linear-${kind}-`));
  try {
    const pack = runCommand('npm', ['pack', '--pack-destination', parent, '--json'], root);
    const packed = JSON.parse(pack.stdout) as Array<{ filename: string }>;
    const tarball = join(parent, packed[0]!.filename);
    const isolated = join(parent, 'isolated');
    runCommand('npm', ['init', '-y'], parent);
    runCommand('mkdir', ['-p', isolated], parent);
    runCommand('npm', ['init', '-y'], isolated);
    runCommand('npm', [
      'install',
      tarball,
      `@earendil-works/pi-coding-agent@${version}`,
      `@earendil-works/pi-ai@${version}`,
      `@earendil-works/pi-tui@${version}`,
      'typebox@>=1.1.38',
      'jiti',
    ], isolated);
    const pkg = JSON.parse(await readFile(join(isolated, 'node_modules/@tothemoon/pi-linear-lite/package.json'), 'utf8')) as { name: string };
    if (pkg.name !== '@tothemoon/pi-linear-lite') throw new Error('Packed package did not install.');
    const harness = join(isolated, 'harness.mjs');
    await writeFile(harness, HARNESS);
    const result = spawnSync(process.execPath, [harness], {
      cwd: isolated,
      encoding: 'utf8',
      env: { ...process.env, CI: '1', PI_EXPECTED_VERSION: version },
    });
    if (result.status !== 0) throw new Error(`isolated Pi ${version} failed:\n${result.stdout}\n${result.stderr}`);
    process.stdout.write(result.stdout);
    console.log(`PI ${kind} ${version}: PASS`);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

const HARNESS = `import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJiti } from 'jiti';

const { VERSION, wrapRegisteredTools } = await import('@earendil-works/pi-coding-agent');
const expected = process.env.PI_EXPECTED_VERSION;
if (expected && VERSION !== expected) throw new Error(\`Expected Pi \${expected}, loaded \${VERSION}\`);

const packageRoot = join(process.cwd(), 'node_modules/@tothemoon/pi-linear-lite');
process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), 'pi-linear-isolated-'));
const jiti = createJiti(import.meta.url, { moduleCache: false });
const loaded = await jiti.import(join(packageRoot, 'extensions/index.ts'));
const register = loaded.registerLinearExtension;
if (typeof register !== 'function') throw new Error('Packed extension did not export registerLinearExtension.');

function createPi() {
  const registered = [];
  const commands = new Map();
  const sessionHandlers = [];
  let active = ['read', 'bash'];
  const pi = {
    registerCommand: (name, command) => { commands.set(name, command); },
    registerTool: (tool) => { registered.push(tool); active.push(tool.name); },
    getActiveTools: () => [...active],
    getAllTools: () => registered.map((tool) => ({ name: tool.name, parameters: tool.parameters })),
    setActiveTools: (names) => { active = [...names]; },
    on: (event, handler) => { if (event === 'session_start') sessionHandlers.push(handler); },
  };
  return { pi, registered, commands, sessionHandlers, activeTools: () => active };
}

const harness = createPi();
register(harness.pi);
for (const handler of harness.sessionHandlers) await handler();
const names = harness.registered.map((tool) => tool.name);
if (names.length !== 53) throw new Error(\`Expected 53 tools, registered \${names.length}.\`);
if (!names.includes('linear')) throw new Error('linear was not registered.');
const linearActive = harness.activeTools().filter((name) => name === 'linear' || name.startsWith('linear_'));
if (linearActive.join(',') !== 'linear,linear_get_result') throw new Error(\`Active Linear tools: \${linearActive.join(', ')}\`);
if (!harness.commands.has('linear-auth') || !harness.commands.has('linear-settings')) {
  throw new Error('Expected /linear-auth and /linear-settings.');
}

const api = harness.registered.find((tool) => tool.name === 'linear');
const resultTool = harness.registered.find((tool) => tool.name === 'linear_get_result');
const graphqlTool = harness.registered.find((tool) => tool.name === 'linear_graphql');
const batchTool = harness.registered.find((tool) => tool.name === 'linear_batch');
const typed = harness.registered.find((tool) => tool.name === 'linear_get_issue');
if (api.parameters.properties.operation.const !== 'help' || Object.keys(api.parameters.properties).join(',') !== 'operation,variables') {
  throw new Error('linear schema is not discovery-only.');
}
if (JSON.stringify([api.label, resultTool?.label, graphqlTool?.label, batchTool?.label, typed?.label]) !== JSON.stringify([
  'Linear', 'Linear get result', 'Linear GraphQL', 'Linear batch', 'Linear get issue',
])) throw new Error('Wire names and human labels drifted.');
if (!resultTool || typeof resultTool.renderCall !== 'function' || typeof resultTool.renderResult !== 'function') {
  throw new Error('Direct result tool or its renderers are missing.');
}
if (!graphqlTool || typeof graphqlTool.renderCall !== 'function' || typeof graphqlTool.renderResult !== 'function') {
  throw new Error('Direct GraphQL tool or its renderers are missing.');
}
if (!batchTool || typeof batchTool.renderCall !== 'function' || typeof batchTool.renderResult !== 'function') {
  throw new Error('Direct batch tool or its renderers are missing.');
}
if (typed.promptSnippet || typed.promptGuidelines) throw new Error('Typed tools must omit active-only prompt metadata.');
try {
  await api.execute('removed-route', { operation: 'get_issue', variables: { issue: 'AEO-258' } }, undefined, undefined, { hasUI: false });
  throw new Error('linear accepted removed named execution.');
} catch (error) {
  if (!String(error.message || error).includes('linear_get_issue')) throw error;
}
const help = await api.execute('call-1', { operation: 'help', variables: { operation: 'get_issue' } }, undefined, undefined, { hasUI: false });
if (JSON.stringify(help.details.loadedTools) !== JSON.stringify(['linear_get_issue'])) {
  throw new Error(\`Exact help did not activate linear_get_issue: \${JSON.stringify(help.details.loadedTools)}\`);
}
const after = harness.activeTools();
if (!after.includes('linear') || !after.includes('linear_get_issue') || !after.includes('read')) {
  throw new Error(\`Additive activation failed: \${after.join(', ')}\`);
}
const second = await api.execute('call-2', { operation: 'help', variables: { operation: 'get_issue' } }, undefined, undefined, { hasUI: false });
if ((second.details.loadedTools ?? []).length !== 0) throw new Error('Already active tools were re-reported.');

const runner = { getActiveTools: () => harness.activeTools(), createContext: () => ({ hasUI: false }) };
const [wrapped] = wrapRegisteredTools([{ definition: api, sourceInfo: { path: 'linear', source: 'extension' } }], runner);
const wrappedHelp = await wrapped.execute('call-3', { operation: 'help', variables: { operation: 'list_issues' } });
if (!wrappedHelp.addedToolNames?.includes('linear_list_issues')) {
  throw new Error(\`Wrapper did not record added tools: \${JSON.stringify(wrappedHelp.addedToolNames)}\`);
}

try {
  typed.prepareArguments({ issue: 123 });
  throw new Error('Typed prepareArguments accepted a coerced issue value.');
} catch (error) {
  if (!String(error.message || error).includes('Invalid arguments for "linear_get_issue"')) throw error;
}

if (typeof typed.renderCall !== 'function' || typeof typed.renderResult !== 'function') {
  throw new Error('Renderer functions are missing; fallback would hide the typed result contract.');
}

const readonlyHarness = createPi();
register(readonlyHarness.pi, 'readonly');
for (const handler of readonlyHarness.sessionHandlers) await handler();
const readonlyTyped = readonlyHarness.registered.find((tool) => tool.name === 'linear_create_issue');
try {
  await readonlyTyped.execute('call-4', {
    title: 'blocked', team: 'AEO',
  }, undefined, undefined, { hasUI: false });
  throw new Error('Read-only mutation was not rejected.');
} catch (error) {
  if (!String(error.message || error).includes('read-only') && !String(error.message || error).includes('Read-only')) {
    throw error;
  }
}

console.log(\`isolated Pi \${VERSION} registered \${names.length} tools\`);
`;

const requested = process.argv[2] === 'min' || process.argv[2] === 'current' ? process.argv[2] : undefined;
if (!requested) {
  console.error('Usage: vite-node scripts/test-pi-version.ts <min|current>');
  process.exitCode = 2;
} else {
  await run(requested);
}
