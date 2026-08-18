import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export function readonlyRefusal(environment = process.env) {
  return environment.LINEAR_READONLY === '1'
    ? undefined
    : 'smoke:readonly requires LINEAR_READONLY=1; no authentication or network request was attempted.';
}

export function runReadonlySmokeCommand(options = {}) {
  const environment = options.environment ?? process.env;
  const refusal = readonlyRefusal(environment);
  if (refusal) return { status: 2, output: `READONLY SMOKE FAIL: ${refusal}` };

  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const temporaryParent = options.temporaryParent ?? environment.LINEAR_SMOKE_TMP_PARENT ?? tmpdir();
  const temporaryRoot = mkdtempSync(join(temporaryParent, 'pi-linear-readonly-'));
  const sourceAgentDirectory = environment.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
  try {
    const result = (options.spawn ?? spawnSync)(
      join(root, 'node_modules', '.bin', 'vite-node'),
      [join(root, 'scripts', 'smoke-readonly.ts')],
      {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        env: {
          ...environment,
          LINEAR_READONLY: '1',
          LINEAR_SMOKE_AUTH_AGENT_DIR: sourceAgentDirectory,
          PI_CODING_AGENT_DIR: join(temporaryRoot, 'agent'),
          PI_ARTIFACT_PROJECT_ROOT: join(temporaryRoot, 'artifacts'),
        },
      },
    );
    const lines = `${result.stdout || ''}\n${result.stderr || ''}`
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('READONLY SMOKE '));
    return {
      status: result.status ?? 1,
      output: lines.at(-1) || 'READONLY SMOKE FAIL: smoke runner produced no compact summary.',
    };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = runReadonlySmokeCommand();
  const stream = result.status === 0 ? process.stdout : process.stderr;
  stream.write(`${result.output}\n`);
  process.exitCode = result.status;
}
