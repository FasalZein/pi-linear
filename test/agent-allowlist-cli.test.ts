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
  `---\nname: ${name}\ntools: all, read, bash, linear_old\nmode: background\ncustom: preserve-${name}\n---\n\nIntro for ${name}.\n\n## Tool surface\n\nOld tool rules.\n\n## Query discipline\n\nAlways use first: 10. Never paginate to exhaustion.\n\n## Job 1 — Execute a Linear task\n\nPreserve job instructions for ${name}.\n`;

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

  it('synchronizes owned dispatch rules while preserving unrelated frontmatter and job instructions', async () => {
    expect(npm('sync:linear-agent-allowlists', home).status).toBe(0);
    const synced = await readFile(linear, 'utf8');
    expect(synced).toContain(`tools: ${expectedTools}`);
    expect(synced).toContain('custom: preserve-linear');
    expect(synced).toContain('Intro for linear.');
    expect(synced).toContain('Preserve job instructions for linear.');
    expect(synced).toContain('Before the first use of an unfamiliar named operation, call loader help');
    expect(synced).toContain('Help is local and makes no Linear network request.');
    expect(synced).toContain('call that typed tool with only its declared direct parameters');
    expect(synced).toContain('Never send loader fields');
    expect(synced).toContain('A batch entry is exactly `{ key, operation, variables }`');
    expect(synced).toContain('Do not guess parameter names or nested `input` shapes.');
    expect(synced).toContain('Use `get_result` through the loader for lossless recovery');
    expect(synced).toContain('Continue through pages only until the requested result is complete.');
    expect(synced).not.toContain('first: 10');
    expect(synced).not.toContain('Never paginate to exhaustion');
    expect(npm('check:linear-agent-allowlists', home).status).toBe(0);
    expect(npm('generate:check', home).status).toBe(0);
  }, 180_000);

  it('detects owned instruction drift and sync repairs only the owned section', async () => {
    const before = await readFile(linear, 'utf8');
    const drifted = before.replace('Help is local and makes no Linear network request.', 'Help might use the network.');
    await writeFile(linear, drifted);
    expect(npm('check:linear-agent-allowlists', home).status).toBe(1);
    expect(npm('sync:linear-agent-allowlists', home).status).toBe(0);
    expect(await readFile(linear, 'utf8')).toBe(before);
  }, 120_000);

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
      const synced = await readFile(path, 'utf8');
      expect(synced).toContain(`name: custom-${index + 1}`);
      expect(synced).toContain(`tools: ${expectedTools}`);
      expect(synced).toContain(`custom: preserve-custom-${index + 1}`);
      expect(synced).toContain(`Preserve job instructions for custom-${index + 1}.`);
      expect(synced).toContain('<!-- pi-linear:tool-surface:start -->');
      expect(synced).toContain('<!-- pi-linear:query-discipline:start -->');
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
