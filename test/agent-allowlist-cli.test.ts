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
  `---\nname: ${name}\ntools: all, read, bash, linear_old\nmode: background\ncustom: preserve-${name}\n---\n\nIntro for ${name}.\n\n## Tool surface\n\nLegacy tool note for ${name}.\n\n## Query discipline\n\nLegacy query note for ${name}.\n\n## Job 1 — Execute a Linear task\n\nPreserve job instructions for ${name}.\n`;

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
    expect(synced).toContain('Legacy tool note for linear.');
    expect(synced).toContain('Legacy query note for linear.');
    expect(synced).toContain('Before the first use of an unfamiliar named operation, call loader help');
    expect(synced).toContain('Help is local and makes no Linear network request.');
    expect(synced).toContain('call that typed tool with only its declared direct parameters');
    expect(synced).toContain('Never send loader fields');
    expect(synced).toContain('A batch entry is exactly `{ key, operation, variables }`');
    expect(synced).toContain('Do not guess parameter names or nested `input` shapes.');
    expect(synced).toContain('Use `get_result` through the loader for lossless recovery');
    expect(synced).toContain('Continue through pages only until the requested result is complete.');
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

  it('preserves marker-bounded, legacy-heading, minimal-body, and unrelated custom content', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'linear-allowlist-custom-'));
    const paths = ['markers.md', 'headings.md', 'minimal.md', 'inside.md'].map((name) => join(directory, name));
    const frontmatter = (name: string) => `---\nname: ${name}\ntools: all, linear_old\nmode: background\n---\n\n`;
    await Promise.all([
      writeFile(paths[0]!, `${frontmatter('markers')}## Tool surface\n\nBefore tool.\n<!-- pi-linear:tool-surface:start -->\nOLD TOOL\n<!-- pi-linear:tool-surface:end -->\nAfter tool.\n\n## Query discipline\n\nBefore query.\n<!-- pi-linear:query-discipline:start -->\nOLD QUERY\n<!-- pi-linear:query-discipline:end -->\nAfter query.\n`),
      writeFile(paths[1]!, `${frontmatter('headings')}## Tool surface\n\nKeep legacy tool heading text.\n\n## Query discipline\n\nKeep legacy query heading text.\n`),
      writeFile(paths[2]!, `${frontmatter('minimal')}Minimal custom body.\n`),
      writeFile(paths[3]!, `${frontmatter('inside')}## Tool surface\n\nKeep tool prefix.\n<!-- pi-linear:tool-surface:start -->\nSTALE\n<!-- pi-linear:tool-surface:end -->\nKeep tool suffix.\n\n## Query discipline\n\nKeep query prefix.\n<!-- pi-linear:query-discipline:start -->\nSTALE\n<!-- pi-linear:query-discipline:end -->\nKeep query suffix.\n`),
    ]);

    expect(npm('sync:linear-agent-allowlists', home, paths).status).toBe(0);
    const synced = await Promise.all(paths.map((path) => readFile(path, 'utf8')));
    for (const source of synced) {
      expect(source).toContain(`tools: ${expectedTools}`);
      expect(source.match(/pi-linear:tool-surface:start/g)).toHaveLength(1);
      expect(source.match(/pi-linear:query-discipline:start/g)).toHaveLength(1);
      expect(source).not.toMatch(/OLD TOOL|OLD QUERY|STALE/);
    }
    expect(synced[0]).toMatch(/Before tool\.[\s\S]*After tool\./);
    expect(synced[0]).toMatch(/Before query\.[\s\S]*After query\./);
    expect(synced[1]).toContain('Keep legacy tool heading text.');
    expect(synced[1]).toContain('Keep legacy query heading text.');
    expect(synced[2]).toContain('Minimal custom body.');
    expect(synced[3]).toMatch(/Keep tool prefix\.[\s\S]*Keep tool suffix\./);
    expect(synced[3]).toMatch(/Keep query prefix\.[\s\S]*Keep query suffix\./);
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
