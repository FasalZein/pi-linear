import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generatedFiles, renderGeneratedFiles, staleGeneratedFiles, syncAllowlistFile } from '../scripts/generate';
import manifest from '../extensions/generated/linear-tools.manifest.json';
import { operationDefinitions } from '../extensions/operations';

const expectedNames = ['linear_api', ...operationDefinitions.map(({ toolName }) => toolName)];

describe('generated products', () => {
  it('keeps every generated file current and deterministic', async () => {
    const first = await renderGeneratedFiles();
    const second = await renderGeneratedFiles();
    expect(second).toEqual(first);
    for (const [path, content] of Object.entries(first)) {
      expect(await readFile(path, 'utf8'), path).toBe(content);
    }
    expect(Object.keys(first).sort()).toEqual([...generatedFiles].sort());
  });

  it('detects stale output without writing it', async () => {
    const writes: string[] = [];
    const stale = await staleGeneratedFiles(
      { '/tmp/generated-a': 'new', '/tmp/generated-b': 'same' },
      async (path) => path.endsWith('a') ? 'old' : 'same',
    );
    expect(stale).toEqual(['/tmp/generated-a']);
    expect(writes).toEqual([]);
  });

  it('publishes one deployable manifest entry for each canonical operation', () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.initialActiveTools).toEqual(['linear_api']);
    expect(manifest.lazyTools).toEqual(operationDefinitions.map(({ name, toolName, domain }) => ({
      name: toolName, operation: name, domain,
    })));
    expect(manifest.allowedTools).toEqual(expectedNames);
  });

  it('syncs only the tools frontmatter field in external agent fixtures', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'linear-allowlist-'));
    const path = join(directory, 'agent.md');
    await writeFile(path, '---\nname: fixture\ntools: read, bash, linear_old\nmode: background\n---\n\nBody.\n');
    await syncAllowlistFile(path);
    expect(await readFile(path, 'utf8')).toBe(
      `---\nname: fixture\ntools: read, bash, ${expectedNames.join(', ')}\nmode: background\n---\n\nBody.\n`,
    );
  });
});
