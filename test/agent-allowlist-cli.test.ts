import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { LINEAR_AGENT_TOOL_SURFACE } from '../scripts/linear-agent-contract';
import { linearApiTool } from '../extensions/api';
import { exceptionalToolDefinitions } from '../extensions/exceptional-tools';
import { typedLinearTools } from '../extensions/typed-tools';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Sync uses Pi's default tool mode so every Linear tool can register without an explicit
// 53-name list. These tools stay unavailable to the bound Linear agent.
const expectedDeniedTools = ['bash', 'edit', 'grep', 'find', 'ls', 'image_gen'].join(', ');
const expectShortToolPolicy = (source: string) => {
  expect(source).not.toMatch(/^tools:/m);
  expect(source).toContain(`deny-tools: ${expectedDeniedTools}`);
};
const staleAgent = (name: string) =>
  `---\nname: ${name}\ntools: all, read, bash, linear_old\nmode: background\nmodel: fixture/provider-model\nskills: none\ninherit-append-system: false\ncustom: preserve-${name}\n---\n\nIntro for ${name}.\n\n## Tool surface\n\nLegacy tool note for ${name}.\n\n## Query discipline\n\nLegacy query note for ${name}.\n\n## Job 1 — Execute a Linear task\n\nPreserve job instructions for ${name}.\n\nSafety fixture: exact targets, authorization, and readback stay required.\n\nDECISION NEEDED\nQ1: Preserve this hand-authored decision contract?\n`;

type SchemaProperty = { type?: string; description?: string };
type ObjectSchema = { properties?: Record<string, SchemaProperty>; required?: string[] };

// The shipped schemas, not the sentence, are the authority for what each tool accepts.
const publishedSchemas = new Map<string, ObjectSchema>([
  ['linear', linearApiTool().parameters as ObjectSchema],
  ...exceptionalToolDefinitions.map(({ name, parameters }) => [name, parameters as ObjectSchema] as const),
  ...typedLinearTools().map(({ name, parameters }) => [name, parameters as ObjectSchema] as const),
]);
const batchEntrySchema = (publishedSchemas.get('linear_batch')!.properties!.operations as {
  items: ObjectSchema;
}).items;
const LOADER_FIELDS = ['operation', 'query', 'variables'];

const fieldNames = (schema: ObjectSchema | undefined): string[] => Object.keys(schema?.properties ?? {});
const backticked = (text: string): string[] => [...text.matchAll(/`([\w:]+)`/g)].map((match) => match[1]!);
const toolsDeclaring = (field: string): string[] =>
  [...publishedSchemas].filter(([, schema]) => fieldNames(schema).includes(field)).map(([name]) => name);

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

  /**
   * Regression: the owned instructions once said `query` and `variables` belong only to
   * `linear`. That sentence made `linear_graphql` uncallable, and a verbatim assertion on
   * the sentence could not see the conflict. Assert against the published schemas instead.
   */
  it('states loader field ownership that the published direct schemas support', () => {
    expect(fieldNames(publishedSchemas.get('linear'))).toEqual(['operation', 'variables']);
    expect(toolsDeclaring('query')).toContain('linear_graphql');
    expect(toolsDeclaring('query')).not.toContain('linear');
    expect(toolsDeclaring('variables')).toEqual(expect.arrayContaining(['linear', 'linear_graphql']));
    expect(toolsDeclaring('operation')).toEqual(['linear']);
    expect(batchEntrySchema.required).toEqual(['operation']);

    const sentences = LINEAR_AGENT_TOOL_SURFACE.split('\n')
      .filter((line) => line.startsWith('- '))
      .flatMap((line) => line.split(/\.\s+/));
    for (const sentence of sentences) {
      const named = backticked(sentence);
      const tools = named.filter((name) => publishedSchemas.has(name));
      const fields = named.filter((name) => LOADER_FIELDS.includes(name));
      if (tools.length !== 1 || !fields.length) continue;
      const declared = tools[0] === 'linear_batch' && /entry/.test(sentence)
        ? fieldNames(batchEntrySchema)
        : fieldNames(publishedSchemas.get(tools[0]!));
      for (const field of fields) {
        expect({ sentence, tool: tools[0], field, declared: declared.includes(field) })
          .toMatchObject({ declared: true });
      }
    }

    // Every required loader-shaped field is named next to the tool that requires it.
    const requiredPairs: Array<[string, string]> = [
      ['linear', 'operation'],
      ['linear_graphql', 'query'],
      ['linear_batch', 'operation'],
    ];
    for (const [tool, field] of requiredPairs) {
      const paired = LINEAR_AGENT_TOOL_SURFACE.split(/\.\s+|\n/)
        .some((sentence) => backticked(sentence).includes(tool) && backticked(sentence).includes(field));
      expect({ tool, field, paired }).toMatchObject({ paired: true });
    }
  });

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
    expectShortToolPolicy(synced);
    expect(synced).toContain('model: fixture/provider-model');
    expect(synced).toContain('skills: none');
    expect(synced).toContain('inherit-append-system: false');
    expect(synced).toContain('custom: preserve-linear');
    expect(synced).toContain('Intro for linear.');
    expect(synced).toContain('Preserve job instructions for linear.');
    expect(synced).toContain('Safety fixture: exact targets, authorization, and readback stay required.');
    expect(synced).toContain('DECISION NEEDED\nQ1: Preserve this hand-authored decision contract?');
    expect(synced).toContain('Legacy tool note for linear.');
    expect(synced).toContain('Legacy query note for linear.');
    expect(synced).toContain('Use the matching typed tool and its visible schema as the parameter authority.');
    expect(synced).toContain('If that tool is unavailable in this session, request exact help');
    expect(synced).toContain('Exact help is local and makes no Linear network request.');
    expect(synced).toContain('Then call the activated tool with its declared direct fields.');
    expect(synced).toContain('Send `operation` with help `variables` to `linear` only.');
    expect(synced).toContain('Send `query` with optional `variables` to `linear_graphql`.');
    expect(synced).toContain('Give every `linear_batch` entry an `operation` with optional `variables`.');
    expect(synced).toContain('Then call `linear_batch` directly');
    expect(synced).toContain('Use explicit `reads` and `mutations` phases only when mutations exist.');
    expect(synced).toContain('Do not invent keys; the runtime assigns stable keys when absent.');
    expect(synced).toContain('Ordinary batch mutations run in order after all entries pass preflight.');
    expect(synced).toContain("Keep entries independent. Do not reference another entry's result.");
    expect(synced).toContain('Do not retry an unknown write outcome before checking its target.');
    expect(synced).toContain('Mutation replies default to a short acknowledgement.');
    expect(synced).toContain('After each write, read the target independently and verify the requested fields.');
    expect(synced).toContain('A full mutation reply does not replace this readback.');
    expect(synced).not.toContain('unfamiliar named operation');
    expect(synced).not.toContain('Do not guess parameter names or nested `input` shapes.');
    expect(synced).toContain('Use `linear_get_result` for lossless recovery');
    expect(synced).toContain('Pass `{ "handle": "..." }` directly');
    expect(synced).toContain('Use `linear` only for discovery.');
    expect(synced).toContain('never executes Linear work');
    expect(synced).toContain('call `linear_graphql` directly');
    expect(synced).toContain('Use raw GraphQL only when no named operation supports the required capability or filter.');
    expect(synced).toContain('Keep raw reads bounded. Send raw mutations only when the job explicitly authorizes them.');
    expect(synced).toContain('Continue through pages only until the requested result is complete.');
    expect(npm('check:linear-agent-allowlists', home).status).toBe(0);
    expect(npm('generate:check', home).status).toBe(0);
  }, 180_000);

  it('detects owned instruction drift and sync repairs only the owned section', async () => {
    const before = await readFile(linear, 'utf8');
    const drifted = before.replace('Exact help is local and makes no Linear network request.', 'Exact help might use the network.');
    await writeFile(linear, drifted);
    expect(npm('check:linear-agent-allowlists', home).status).toBe(1);
    expect(npm('sync:linear-agent-allowlists', home).status).toBe(0);
    expect(await readFile(linear, 'utf8')).toBe(before);
  }, 120_000);

  it('does not require the retired linear-auditor deployment file', async () => {
    expectShortToolPolicy(await readFile(linear, 'utf8'));
    expect(npm('check:linear-agent-allowlists', home).status).toBe(0);
  }, 120_000);

  it('replaces a stale exact allowlist with the short deny-list policy', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'linear-allowlist-owned-'));
    await mkdir(join(directory, '.pi/agent/agents'), { recursive: true });
    const agent = join(directory, '.pi/agent/agents/linear.md');
    await writeFile(agent, staleAgent('linear').replace('tools: all, read, bash, linear_old', 'tools: read, write, linear_retired_tool'));

    expect(npm('sync:linear-agent-allowlists', directory).status).toBe(0);
    const source = await readFile(agent, 'utf8');
    expectShortToolPolicy(source);
    expect(source).not.toContain('linear_retired_tool');
    expect(npm('check:linear-agent-allowlists', directory).status).toBe(0);
  }, 180_000);


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
      expectShortToolPolicy(source);
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
