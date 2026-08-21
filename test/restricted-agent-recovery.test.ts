import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerLinearExtension } from '../extensions/index';
import manifest from '../extensions/generated/linear-tools.manifest.json';
import { syncAllowlistFile } from '../scripts/generate';

const roots: string[] = [];
const originalArtifactRoot = process.env.PI_ARTIFACT_PROJECT_ROOT;
const originalApiKey = process.env.LINEAR_API_KEY;

function toolsFromAgent(source: string): string[] {
  const tools = source.match(/^tools:\s*(.*)$/m)?.[1];
  if (!tools) throw new Error('Missing tools frontmatter.');
  return tools.split(',').map((name) => name.trim()).filter(Boolean);
}

function policyHarness(allowed: readonly string[]) {
  const policy = new Set(allowed);
  const registered: any[] = [];
  const sessionHandlers: Array<() => void> = [];
  let active = policy.has('write') ? ['write'] : [];
  const pi = {
    registerCommand: () => undefined,
    registerTool: (tool: any) => {
      registered.push(tool);
      if (policy.has(tool.name)) active.push(tool.name);
    },
    getActiveTools: () => [...active],
    getAllTools: () => registered.map((tool) => ({ name: tool.name, parameters: tool.parameters })),
    setActiveTools: (names: string[]) => { active = names.filter((name) => policy.has(name)); },
    on: (event: string, handler: () => void) => {
      if (event === 'session_start') sessionHandlers.push(handler);
    },
  };
  registerLinearExtension(pi as any);
  sessionHandlers.forEach((handler) => handler());
  return {
    registered,
    active: () => [...active],
    tool: (name: string) => registered.find((tool) => tool.name === name),
  };
}

async function execute(tool: any, params: Record<string, unknown>) {
  return tool.execute('call-1', params, undefined, undefined, { hasUI: false });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  if (originalArtifactRoot === undefined) delete process.env.PI_ARTIFACT_PROJECT_ROOT;
  else process.env.PI_ARTIFACT_PROJECT_ROOT = originalArtifactRoot;
  if (originalApiKey === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = originalApiKey;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('restricted Linear agent recovery', () => {
  it('externalizes and recovers a complete result through loader-only get_result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-linear-restricted-'));
    roots.push(root);
    process.env.PI_ARTIFACT_PROJECT_ROOT = root;
    process.env.LINEAR_API_KEY = 'test-key';

    const agentPath = join(root, 'linear.md');
    await writeFile(agentPath, '---\nname: linear\ntools: all, read, bash, exec, linear_old\nmode: background\n---\n\nRestricted agent.\n\n## Tool surface\n\nOld.\n\n## Query discipline\n\nOld.\n\n## Job 1 — Recover\n\nKeep.\n');
    await syncAllowlistFile(agentPath);
    const allowed = toolsFromAgent(await readFile(agentPath, 'utf8'));

    expect(allowed).toEqual(['write', ...manifest.allowedTools]);
    expect(allowed.filter((name) => !name.startsWith('linear'))).toEqual(['write']);
    expect(allowed).not.toEqual(expect.arrayContaining(['all', 'read', 'bash', 'exec']));
    expect(allowed).not.toContain('linear_get_result');

    const rows = Array.from({ length: 80 }, (_, index) => ({
      id: `row-${index}`,
      title: `Issue ${index}`,
      description: `${index}:` + 'x'.repeat(200),
    }));
    const source = { issues: { nodes: rows, pageInfo: { hasNextPage: false, endCursor: 'server-cursor' } } };
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: source }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetch);

    const harness = policyHarness(allowed);
    expect(harness.registered).toHaveLength(50);
    expect(harness.registered.map(({ name }) => name)).not.toContain('linear_get_result');
    expect(harness.active()).toEqual(['write', 'linear']);

    const externalized = await execute(harness.tool('linear'), {
      query: 'query RestrictedRecovery { issues { nodes { id title description } pageInfo { hasNextPage endCursor } } }',
      variables: {},
    });
    expect(externalized.details).toMatchObject({
      handle: expect.stringMatching(/^linear-result:v1:/),
      meta: { routing: { actualSink: 'artifact', reason: 'spill-threshold' } },
    });

    const recovered = await execute(harness.tool('linear'), {
      operation: 'get_result',
      variables: { handle: externalized.details.handle },
    });
    expect(recovered.details.data.value).toEqual(JSON.parse(await readFile(externalized.details.path, 'utf8')));
    expect(recovered.details.data.value.data).toEqual(source);
    expect(fetch).toHaveBeenCalledOnce();
    expect(harness.active()).toEqual(['write', 'linear']);
  });
});
