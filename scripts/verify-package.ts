import { mkdtemp, readdir, readFile, rm, stat, symlink, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const forbidden = [
  /(^|\/)test\//,
  /(^|\/)reference\//,
  /(^|\/)node_modules\//,
  /credentials/i,
  /\.DS_Store$/,
  /(^|\/)tmp\//,
  /(^|\/)temp\//,
  /\.tgz$/,
  /(^|\/)\.git\//,
];

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, CI: '1' } });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  return result;
}

function assertCleanName(filename: string) {
  if (filename.startsWith('/')) throw new Error(`Package contains an absolute path: ${filename}`);
  for (const pattern of forbidden) {
    if (pattern.test(filename)) throw new Error(`Package must not include ${filename}`);
  }
}

async function walk(directory: string, prefix = ''): Promise<string[]> {
  const names: string[] = [];
  for (const name of await readdir(directory)) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const path = join(directory, name);
    if ((await stat(path)).isDirectory()) names.push(...await walk(path, relative));
    else names.push(relative);
  }
  return names;
}

const dry = run('npm', ['pack', '--dry-run', '--json'], root);
const listing = JSON.parse(dry.stdout) as Array<{ filename: string; files: Array<{ path: string }> }>;
const files = listing[0]?.files.map((file) => file.path) ?? [];
if (!files.length) throw new Error('npm pack --dry-run --json returned no files.');
for (const filename of files) assertCleanName(filename);
for (const required of [
  'package.json',
  'README.md',
  'REFERENCE.md',
  'CHANGELOG.md',
  'extensions/index.ts',
  'extensions/generated/linear-tools.manifest.json',
]) {
  if (!files.includes(required)) throw new Error(`Package is missing ${required}`);
}

const parent = await mkdtemp(join(tmpdir(), 'pi-linear-pack-'));
try {
  const packed = JSON.parse(run('npm', ['pack', '--pack-destination', parent, '--json'], root).stdout) as Array<{ filename: string }>;
  const tarball = join(parent, packed[0]!.filename);
  const extracted = join(parent, 'extracted');
  run('mkdir', ['-p', extracted], parent);
  run('tar', ['-xzf', tarball, '-C', extracted], parent);
  const packageRoot = join(extracted, 'package');
  const extractedFiles = await walk(packageRoot);
  for (const filename of extractedFiles) assertCleanName(filename);
  for (const generator of extractedFiles.filter((filename) => filename.startsWith('scripts/generate'))) {
    await unlink(join(packageRoot, generator));
  }
  await symlink(join(root, 'node_modules'), join(packageRoot, 'node_modules'), 'dir');
  process.env.PI_CODING_AGENT_DIR = join(parent, 'agent');
  const loaded = await import(pathToFileURL(join(packageRoot, 'extensions/index.ts')).href) as {
    registerLinearExtension: (pi: any, mode?: string) => void;
  };
  const registered: any[] = [];
  const commands = new Map<string, unknown>();
  const sessionHandlers: Array<() => void> = [];
  let active: string[] = [];
  const pi = {
    registerCommand: (name: string, command: unknown) => { commands.set(name, command); },
    registerTool: (tool: any) => { registered.push(tool); active.push(tool.name); },
    getActiveTools: () => [...active],
    getAllTools: () => registered.map((tool) => ({ name: tool.name, parameters: tool.parameters })),
    setActiveTools: (names: string[]) => { active = [...names]; },
    on: (event: string, handler: () => void) => { if (event === 'session_start') sessionHandlers.push(handler); },
  };
  loaded.registerLinearExtension(pi);
  for (const handler of sessionHandlers) handler();
  if (registered.length !== 53) throw new Error(`Extracted package registered ${registered.length} tools.`);
  if (!registered.some(({ name }) => name === 'linear_get_result')) throw new Error('Extracted package did not register direct linear_get_result.');
  if (!registered.some(({ name }) => name === 'linear_graphql')) throw new Error('Extracted package did not register direct linear_graphql.');
  if (!registered.some(({ name }) => name === 'linear_batch')) throw new Error('Extracted package did not register direct linear_batch.');
  const manifest = JSON.parse(await readFile(join(packageRoot, 'extensions/generated/linear-tools.manifest.json'), 'utf8')) as { allowedTools: string[] };
  if (manifest.allowedTools.length !== 53 || !manifest.allowedTools.includes('linear_get_result') || !manifest.allowedTools.includes('linear_graphql') || !manifest.allowedTools.includes('linear_batch')) {
    throw new Error('Extracted package manifest does not contain the exact 53-tool surface.');
  }
  const readme = await readFile(join(packageRoot, 'README.md'), 'utf8');
  if (!readme.includes('53 tool surfaces') || readme.includes('linear-auditor.md')) {
    throw new Error('Extracted package documentation does not contain the current restricted-agent contract.');
  }
  const linearActive = active.filter((name) => name === 'linear' || name.startsWith('linear_'));
  if (linearActive.join(',') !== 'linear,linear_get_result') throw new Error(`Active Linear tools: ${linearActive.join(', ')}`);
  if (!commands.has('linear-auth') || !commands.has('linear-settings')) {
    throw new Error('Extracted package did not register /linear-auth and /linear-settings.');
  }
  const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as { version: string; name: string };
  if (pkg.name !== '@tothemoon/pi-linear-lite') throw new Error(`Unexpected package name ${pkg.name}`);
  console.log(`verify:package PASS (${files.length} files, ${registered.length} tools, ${pkg.version})`);
} finally {
  await rm(parent, { recursive: true, force: true });
}
