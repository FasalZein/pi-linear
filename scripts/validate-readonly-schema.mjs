import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

if (process.env.LINEAR_READONLY !== '1') {
  process.stderr.write('READONLY SCHEMA VALIDATION FAIL: LINEAR_READONLY=1 is required before authentication or network access.\n');
  process.exitCode = 2;
} else {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const result = spawnSync(join(root, 'node_modules', '.bin', 'vite-node'), [join(root, 'scripts', 'validate-readonly-schema.ts')], {
    cwd: root, env: process.env, encoding: 'utf8', maxBuffer: 1024 * 1024,
  });
  const line = `${result.stdout || ''}\n${result.stderr || ''}`.split(/\r?\n/).map((entry) => entry.trim())
    .findLast((entry) => entry.startsWith('READONLY SCHEMA VALIDATION '));
  const output = line || 'READONLY SCHEMA VALIDATION FAIL: validator produced no compact summary.';
  (result.status === 0 ? process.stdout : process.stderr).write(`${output}\n`);
  process.exitCode = result.status ?? 1;
}
