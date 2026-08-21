import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import manifest from '../extensions/generated/linear-tools.manifest.json';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const expectedTools = ['write', ...manifest.allowedTools].join(', ');
const staleAgent = (name: string) =>
  `---\nname: ${name}\ntools: all, read, bash, linear_old\nmode: background\n---\n\nBody for ${name}.\n`;

function npm(script: string, home: string, paths: string[] = []) {
  return spawnSync('npm', ['run', script, ...(paths.length ? ['--', ...paths] : [])], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', HOME: home, USERPROFILE: home },
  });
}

describe('bound Linear agent allowlist package scripts', () => {
  let home = '';
  let linear = '';

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'linear-allowlist-home-'));
    const directory = join(home, '.pi/agent/agents');
    await mkdir(directory, { recursive: true });
    linear = join(directory, 'linear.md');
    await writeFile(linear, staleAgent('linear'));
  }, 120_000);

  it('fails the bare check on the stale current deployment without writing it', async () => {
    const before = await readFile(linear, 'utf8');
    const result = npm('check:linear-agent-allowlists', home);
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('External Linear agent allowlist is stale');
    expect(await readFile(linear, 'utf8')).toBe(before);
  }, 120_000);

  it('fails the bound generate:check while the current deployment is stale', () => {
    const result = npm('generate:check', home);
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('External Linear agent allowlist is stale');
  }, 120_000);

  it('writes exactly write plus current Linear tools on the bare sync', async () => {
    expect(npm('sync:linear-agent-allowlists', home).status).toBe(0);
    expect(await readFile(linear, 'utf8')).toBe(
      `---\nname: linear\ntools: ${expectedTools}\nmode: background\n---\n\nBody for linear.\n`,
    );
    expect(npm('check:linear-agent-allowlists', home).status).toBe(0);
    expect(npm('generate:check', home).status).toBe(0);
  }, 180_000);

  it('does not require the retired linear-auditor deployment file', async () => {
    expect(await readFile(linear, 'utf8')).toContain(`tools: ${expectedTools}`);
    expect(npm('check:linear-agent-allowlists', home).status).toBe(0);
  }, 120_000);

  it('preserves explicit custom path targeting for one or many installations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'linear-allowlist-custom-'));
    const paths = [join(directory, 'one.md'), join(directory, 'two.md')];
    await Promise.all(paths.map((path, index) => writeFile(path, staleAgent(`custom-${index + 1}`))));

    expect(npm('sync:linear-agent-allowlists', home, paths).status).toBe(0);
    for (const [index, path] of paths.entries()) {
      expect(await readFile(path, 'utf8')).toBe(
        `---\nname: custom-${index + 1}\ntools: ${expectedTools}\nmode: background\n---\n\nBody for custom-${index + 1}.\n`,
      );
    }
    expect(npm('check:linear-agent-allowlists', home, [paths[0]!]).status).toBe(0);
    expect(npm('check:linear-agent-allowlists', home, paths).status).toBe(0);
  }, 180_000);

  it('reports a missing current deployment default instead of passing', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'linear-allowlist-empty-'));
    const result = npm('check:linear-agent-allowlists', empty);
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('External Linear agent allowlist is missing');
    expect(`${result.stdout}${result.stderr}`).toContain('linear.md');
    expect(`${result.stdout}${result.stderr}`).not.toContain('linear-auditor.md');
  }, 120_000);
});
