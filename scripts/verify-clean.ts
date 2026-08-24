import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from './generate';
import { operationDefinitions } from '../extensions/operations';
import { exceptionalToolDefinitions } from '../extensions/exceptional-tools';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CI: '1' },
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

await generate(true);
run('npm', ['run', 'test:schema-bytes']);

const manifest = JSON.parse(await readFile(join(root, 'extensions/generated/linear-tools.manifest.json'), 'utf8')) as {
  initialActiveTools: string[];
  schemaVersion: number;
  lazyTools: Array<{ name: string }>;
  exceptionalTools: Array<{ name: string; initialActive: boolean }>;
  allowedTools: string[];
};
const lazyNames = operationDefinitions.map(({ toolName }) => toolName);
if (manifest.schemaVersion !== 2) throw new Error('Manifest schemaVersion must be 2.');
if (manifest.initialActiveTools.join(',') !== 'linear,linear_get_result') {
  throw new Error('Manifest initialActiveTools must be exactly linear and linear_get_result.');
}
if (manifest.lazyTools.map(({ name }) => name).join(',') !== lazyNames.join(',')) {
  throw new Error('Manifest lazyTools drifted from operation definitions.');
}
const exceptionalNames = exceptionalToolDefinitions.map(({ name }) => name);
if (manifest.exceptionalTools.map(({ name }) => name).join(',') !== exceptionalNames.join(',')) {
  throw new Error('Manifest exceptionalTools drifted from exceptional tool definitions.');
}
if (manifest.allowedTools.join(',') !== ['linear', ...exceptionalNames, ...lazyNames].join(',')) {
  throw new Error('Manifest allowedTools drifted from the generated allowlist.');
}

const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
if (status.status !== 0) throw new Error(status.stderr || 'git status failed');
if (status.stdout.trim()) {
  throw new Error(`Repository is not clean:\n${status.stdout}`);
}

console.log('verify:clean PASS');
