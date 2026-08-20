import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { operationDefinitions } from '../extensions/operations';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const expectedTools = ['linear', ...operationDefinitions.map(({ toolName }) => toolName)].join(', ');
const staleAgent = (name: string) =>
  `---\nname: ${name}\ntools: read, bash, linear, linear_stale_tool\nmode: background\n---\n\nBody for ${name}.\n`;

function npm(script: string, home: string) {
  return spawnSync('npm', ['run', script], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', HOME: home, USERPROFILE: home },
  });
}

describe('bound Linear agent allowlist package scripts', () => {
  let home = '';
  let agents: string[] = [];

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'linear-allowlist-home-'));
    const directory = join(home, '.pi/agent/agents');
    await mkdir(directory, { recursive: true });
    agents = [join(directory, 'linear.md'), join(directory, 'linear-auditor.md')];
    for (const path of agents) await writeFile(path, staleAgent(path.endsWith('linear.md') ? 'linear' : 'linear-auditor'));
  }, 120_000);

  it('fails the bare check on stale deployment defaults without writing them', async () => {
    const before = await Promise.all(agents.map((path) => readFile(path, 'utf8')));
    const result = npm('check:linear-agent-allowlists', home);
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('External Linear agent allowlist is stale');
    expect(await Promise.all(agents.map((path) => readFile(path, 'utf8')))).toEqual(before);
  }, 120_000);

  it('fails the bound generate:check while the deployment defaults are stale', () => {
    const result = npm('generate:check', home);
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('External Linear agent allowlist is stale');
  }, 120_000);

  it('writes only the Linear tool entries on the bare sync, then the bare check passes', async () => {
    expect(npm('sync:linear-agent-allowlists', home).status).toBe(0);
    for (const path of agents) {
      const name = path.endsWith('/linear.md') ? 'linear' : 'linear-auditor';
      expect(await readFile(path, 'utf8')).toBe(
        `---\nname: ${name}\ntools: read, bash, ${expectedTools}\nmode: background\n---\n\nBody for ${name}.\n`,
      );
    }
    expect(npm('check:linear-agent-allowlists', home).status).toBe(0);
    expect(npm('generate:check', home).status).toBe(0);
  }, 180_000);

  it('reports a missing deployment default instead of passing', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'linear-allowlist-empty-'));
    const result = npm('check:linear-agent-allowlists', empty);
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('External Linear agent allowlist is missing');
  }, 120_000);
});
