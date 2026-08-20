import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contractProjection, generatedFiles, renderGeneratedFiles, staleGeneratedFiles, syncAllowlistFile } from '../scripts/generate';
import { linearApiTool } from '../extensions/api';
import manifest from '../extensions/generated/linear-tools.manifest.json';
import contracts from '../extensions/generated/operation-contracts.json';
import { operationDefinitions } from '../extensions/operations';
import { typedLinearTools } from '../extensions/typed-tools';

const expectedNames = ['linear', ...operationDefinitions.map(({ toolName }) => toolName)];

async function treeDigest(root: string): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      if (name === 'node_modules') continue;
      const path = join(directory, name);
      const metadata = await stat(path);
      if (metadata.isDirectory()) await walk(path);
      else hash.update(path.slice(root.length)).update(await readFile(path));
    }
  };
  await walk(root);
  return hash.digest('hex');
}

async function staleSourceProbe(relativePath: string, oldText: string, newText: string): Promise<void> {
  const parent = await mkdtemp(join(tmpdir(), 'linear-generation-probe-'));
  const copy = join(parent, basename(process.cwd()));
  try {
    await cp(process.cwd(), copy, {
      recursive: true,
      filter: (source) => !source.endsWith('/.git') && !source.endsWith('/node_modules'),
    });
    await symlink(join(process.cwd(), 'node_modules'), join(copy, 'node_modules'), 'dir');
    const path = join(copy, relativePath);
    const source = await readFile(path, 'utf8');
    expect(source.split(oldText)).toHaveLength(2);
    await writeFile(path, source.replace(oldText, newText));
    const before = await treeDigest(copy);
    const result = spawnSync('npm', ['run', 'generate:check'], {
      cwd: copy,
      encoding: 'utf8',
      env: { ...process.env, CI: '1' },
      timeout: 30_000,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/Generated files are stale/);
    expect(await treeDigest(copy)).toBe(before);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

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

  it.each([
    [
      'operation purpose',
      'extensions/operations/comments.ts',
      'purpose: "List comments, optionally for one exact issue."',
      'purpose: "List comments for one exact issue only."',
    ],
    [
      'compatibility branch',
      'extensions/operations/comments.ts',
      'name: "list_comments",\n\t\tcompatibilityBranches: [\n\t\t\t{\n\t\t\t\t"all": []',
      'name: "list_comments",\n\t\tcompatibilityBranches: [\n\t\t\t{\n\t\t\t\t"all": ["issue"]',
    ],
    [
      'mutation root',
      'extensions/operations/comments.ts',
      'root: "commentCreate",',
      'root: "commentCreateChanged",',
    ],
    [
      'mutation result expectation',
      'extensions/operations/shared.ts',
      'successPath: "success",',
      'successPath: "changedSuccess",',
    ],
    [
      'canonical field type',
      'extensions/operations/comments.ts',
      '\t\tcanonical: {\n\t\t\t"fields": {\n\t\t\t\t"issue": "IssueReference",\n\t\t\t\t"after": "String",\n\t\t\t\t"before": "String",\n\t\t\t\t"first": "Int",\n\t\t\t\t"last": "Int",\n\t\t\t\t"includeArchived": "Boolean",\n\t\t\t\t"orderBy": "PaginationOrderBy",\n\t\t\t\t"filter": "Filter"',
      '\t\tcanonical: {\n\t\t\t"fields": {\n\t\t\t\t"issue": "Float",\n\t\t\t\t"after": "String",\n\t\t\t\t"before": "String",\n\t\t\t\t"first": "Int",\n\t\t\t\t"last": "Int",\n\t\t\t\t"includeArchived": "Boolean",\n\t\t\t\t"orderBy": "PaginationOrderBy",\n\t\t\t\t"filter": "Filter"',
    ],
    [
      'renderer kind',
      'extensions/operations/issues.ts',
      'renderKind: "issue",',
      'renderKind: "project",',
    ],
    [
      'manifest name',
      'extensions/operation-definition.ts',
      'toolName: `linear_${operation.name}`',
      'toolName: `linear_drift_${operation.name}`',
    ],
    [
      'typed tool description',
      'extensions/typed-tool-metadata.ts',
      'Equivalent to linear',
      'Same as linear',
    ],
    [
      'typed tool schema field',
      'extensions/typed-tool-metadata.ts',
      'Issue identifier such as ABC-123, or an issue UUID.',
      'Issue UUID or identifier such as ABC-123.',
    ],
    [
      'typed tool schema branches',
      'extensions/typed-tool-metadata.ts',
      "options[exclusive ? 'oneOf' : 'anyOf']",
      "options[exclusive ? 'anyOf' : 'oneOf']",
    ],
    [
      'typed tool label',
      'extensions/typed-tool-metadata.ts',
      'label: `Linear ${operation.name.replace',
      'label: `Linear operation ${operation.name.replace',
    ],
    [
      'typed tool optional metadata',
      'extensions/typed-tool-metadata.ts',
      'constrainedSampling: false as const',
      'constrainedSampling: true as const',
    ],
  ])('fails read-only generation checks for %s drift', async (_name, path, oldText, newText) => {
    await staleSourceProbe(path, oldText, newText);
  }, 60_000);

  it('keeps exact runtime typed-tool metadata in every generated contract', () => {
    const generated = new Map(contracts.map(({ name, tool }) => [name, tool]));
    for (const runtime of typedLinearTools()) {
      const operationName = runtime.name.slice('linear_'.length);
      const metadata = {
        name: runtime.name,
        label: runtime.label,
        description: runtime.description,
        parameters: runtime.parameters,
        ...('constrainedSampling' in runtime
          ? { constrainedSampling: runtime.constrainedSampling }
          : {}),
      };
      expect(generated.get(operationName), runtime.name).toEqual(metadata);
    }
    expect(generated).toHaveLength(48);
  });

  it('serializes exhaustive compatibility and GraphQL products', () => {
    const createComment = contractProjection(operationDefinitions.find(({ name }) => name === 'create_comment')!);
    expect(createComment.compatibility).toMatchObject({
      operationAliases: ['add_comment'],
      fields: expect.any(Array),
      branches: expect.any(Array),
      acceptedFields: expect.any(Array),
      legacyBranches: expect.any(Array),
      aliasFields: expect.any(Object),
      example: { operation: 'create_comment' },
      resolverPaths: { issue: 'resolveIssueReference', issueId: 'resolveIssueReference' },
      semanticException: 'comment-value-types',
    });
    expect(createComment.graphql?.documents[0]).toMatchObject({
      kind: 'mutation',
      root: 'commentCreate',
      document: expect.stringContaining('commentCreate'),
      mutationResult: {
        successPath: 'success',
        successValue: true,
        requiredEntityPaths: ['comment'],
      },
    });
    const listComments = contractProjection(operationDefinitions.find(({ name }) => name === 'list_comments')!);
    expect(listComments.compatibility).toMatchObject({
      branches: [{ all: [] }],
      pagination: { defaultPageSize: 20, filterType: 'CommentFilter' },
      resolverPaths: { issue: 'resolveIssueReference' },
    });
    expect(listComments.graphql?.documents[0]).toMatchObject({
      kind: 'query', root: 'comments', document: expect.stringContaining('query ListComments'),
    });
  });

  it('publishes every catalog operation in the linear tool description and no others', () => {
    const description = (linearApiTool() as any).description as string;
    expect(description).toContain('{ "operation": "<name>", "variables": { … } }');
    expect(description).toContain('{ "operation": "help", "variables": { "operation": "<name>" } }');
    const expected = operationDefinitions.map(({ name, purpose }) => ({ name, purpose }));
    for (const { name, purpose } of expected) {
      expect(description).toContain(`${name}: ${purpose}`);
    }
    const published = [...description.matchAll(/^([a-z][a-z0-9_]*): (.*)$/gm)].map((match) => ({
      name: match[1]!,
      purpose: match[2]!,
    }));
    expect(published.filter(({ name }) => name !== 'batch')).toEqual(expected);
    expect(published).toContainEqual({
      name: 'batch',
      purpose: 'Carry several independent named reads in one GraphQL request.',
    });
  });

  it('publishes grammatical save purposes in the generated catalog', () => {
    const description = (linearApiTool() as any).description as string;
    expect(description).toContain('save_initiative: Create or update an initiative.');
    expect(description).toContain('save_milestone: Create or update a milestone.');
    expect(description).toContain('save_project: Create or update a project.');
  });

  it('publishes one deployable manifest entry for each canonical operation', () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.initialActiveTools).toEqual(['linear']);
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
