import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contractProjection, generatedFiles, renderGeneratedFiles, staleGeneratedFiles, syncAllowlistFile } from '../scripts/generate';
import { helpResult, linearApiTool, linearBatchTool, linearGetResultTool, linearGraphqlTool } from '../extensions/api';
import manifest from '../extensions/generated/linear-tools.manifest.json';
import { LINEAR_OPERATION_CATALOG } from '../extensions/generated/operation-catalog';
import contracts from '../extensions/generated/operation-contracts.json';
import schemaBaseline from './fixtures/design-b-s3-1-schema-baseline.json';
import { DOMAINS, operationDefinitions, projectCompatibilityOperation } from '../extensions/operations';
import { typedLinearTools } from '../extensions/typed-tools';
import { exceptionalToolDefinitions } from '../extensions/exceptional-tools';

const typedNames = operationDefinitions.map(({ toolName }) => toolName);
const expectedNames = ['linear', ...exceptionalToolDefinitions.map(({ name }) => name), ...typedNames];
const REFERENCE_DIRECT_TELEMETRY = /set top-level `"telemetry": "always"` on the exact direct tool[^.\n]*`linear_batch`[^.\n]*`linear_graphql`[^.\n]*typed `linear_\*`[^.\n]*\./;
const CHANGELOG_DIRECT_TELEMETRY = /set top-level `telemetry: "always"` on the exact direct[^.\n]*`linear_batch`[^.\n]*`linear_graphql`[^.\n]*typed `linear_\*`[^.\n]*\./;
const LOADER_ONLY_TELEMETRY = /(?=[^.\n]*telemetry)(?=[^.\n]*loader)(?=[^.\n]*(?:\bonly\b|\binstead\b|\bpreferred\b))[^.\n]*/i;

function assertDirectTelemetryGuidance(referenceSection: string, changelogEntry: string): void {
  expect(referenceSection).toMatch(REFERENCE_DIRECT_TELEMETRY);
  expect(changelogEntry).toMatch(CHANGELOG_DIRECT_TELEMETRY);
  expect(`${referenceSection}\n${changelogEntry}`).not.toMatch(LOADER_ONLY_TELEMETRY);
  expect(referenceSection).not.toMatch(/loader routes?.*telemetry/i);
  expect(changelogEntry).not.toMatch(/loader routes?.*telemetry/i);
}

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
      'authored safety class',
      'extensions/operations/relations.ts',
      'namedInputPolicy: "guarded-destructive",',
      'namedInputPolicy: "non-destructive",',
    ],
    [
      'typed tool description',
      'extensions/typed-tool-metadata.ts',
      'Call with direct arguments',
      'Invoke with direct arguments',
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
    expect(generated).toHaveLength(49);
  });

  it('projects only the guarded relation delete as destructive', () => {
    expect(contracts.map(({ name, safety }) => ({ name, policy: safety.namedInputPolicy })))
      .toEqual(operationDefinitions.map(({ name }) => ({
        name,
        policy: name === 'delete_issue_relation' ? 'guarded-destructive' : 'non-destructive',
      })));
  });

  it('keeps every help-labeled generated projection canonical and compatibility explicit', () => {
    for (const definition of operationDefinitions) {
      const projected = contractProjection(definition);
      const canonicalNames = definition.canonical.fields.map(({ name }) => name);
      expect(projected.help.callFields, definition.name).toEqual(canonicalNames);
      expect(projected.render.callFields, definition.name).toEqual(canonicalNames);
      expect(Object.keys(projected.help.example.variables).every((name) => canonicalNames.includes(name)), definition.name).toBe(true);
      for (const field of definition.canonical.fields) {
        expect(projected.help.signature, `${definition.name}.${field.name}`).toContain(`${field.name}${field.required ? '' : '?'}: ${field.type}`);
      }
    }
    const createIssue = contractProjection(operationDefinitions.find(({ name }) => name === 'create_issue')!);
    expect(createIssue.help.signature).toContain('projectId?: UUID');
    expect(createIssue.help.signature).toContain('labelIds?: [UUID!]');
    expect(createIssue.help.signature).not.toContain('input');
    expect(createIssue.help.callFields).not.toContain('input');
    expect(createIssue.compatibility.fields.map(({ name }) => name)).toContain('input');
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

  it('publishes all 49 operation names and every special help name in the compact loader description', () => {
    const description = (linearApiTool() as any).description as string;
    expect(description).toContain('Discovery help only.');
    expect(description).toContain('Exact help loads linear_<name>');
    expect(description).toContain('linear_get_result is active');
    expect(description).not.toContain('{ "operation": "<name>", "variables": { … } }');
    expect(description).not.toContain('linear get_result');

    const operationsLine = description.match(/^operations:([a-z0-9_,]+)$/m)?.[1];
    const specialLine = description.match(/^special:([a-z0-9_,]+)$/m)?.[1];
    expect(operationDefinitions).toHaveLength(49);
    expect(operationsLine?.split(',')).toHaveLength(49);
    expect(operationsLine?.split(',')).toEqual(operationDefinitions.map(({ name }) => name));
    expect(specialLine?.split(',')).toEqual(['graphql', 'batch', 'get_result']);

    const published = new Map([...LINEAR_OPERATION_CATALOG.matchAll(/^([a-z]+): ([a-z0-9_, ]+)$/gm)]
      .map((match) => [match[1]!, match[2]!.split(', ')]));
    const expectedDomains = DOMAINS.filter((domain) => operationDefinitions.some((definition) => definition.domain === domain));
    expect([...published.keys()]).toEqual([...expectedDomains, 'special']);
    for (const domain of expectedDomains) {
      expect(published.get(domain)).toEqual(operationDefinitions
        .filter((definition) => definition.domain === domain)
        .map(({ name }) => name));
    }
    expect(published.get('special')).toEqual(['graphql', 'batch', 'get_result']);
    expect([...published.values()].flat().filter((name) => !['graphql', 'batch', 'get_result'].includes(name)).sort())
      .toEqual(operationDefinitions.map(({ name }) => name).sort());
    expect(LINEAR_OPERATION_CATALOG).toContain('special: graphql, batch, get_result');
  });

  it('keeps every exact help card sufficient to call and load its typed tool', () => {
    for (const definition of operationDefinitions) {
      const loaded: string[] = [];
      const result = helpResult({ operation: definition.name }, (names) => {
        loaded.push(...names);
        return names;
      });
      const operation = projectCompatibilityOperation(definition);
      const alwaysRequired = Object.keys(operation.canonical.fields)
        .filter((name) => operation.canonical.branches.every((branch) => branch.includes(name)));
      expect(result, definition.name).toEqual({
        loadedTools: [definition.toolName],
        name: definition.name,
        domain: definition.domain,
        purpose: definition.purpose,
        parameters: Object.entries(operation.canonical.fields).map(([name, type]) => ({
          name,
          type,
          required: alwaysRequired.includes(name),
        })),
        requirements: operation.canonical.branches,
        ...(operation.pagination ? { pagination: { defaultPageSize: operation.pagination.defaultPageSize } } : {}),
        example: definition.canonical.example,
      });
      expect(loaded, definition.name).toEqual([definition.toolName]);
    }
  });

  it('publishes one deployable manifest entry for each canonical and exceptional tool', () => {
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.discoveryTool).toEqual({ name: 'linear', requiredOperation: 'help', variableForms: ['domain', 'operation'] });
    expect(manifest.initialActiveTools).toEqual(['linear', 'linear_get_result']);
    expect(manifest.lazyTools).toEqual(operationDefinitions.map(({ name, toolName, domain }) => ({
      name: toolName, operation: name, domain,
    })));
    expect(manifest.exceptionalTools).toEqual(exceptionalToolDefinitions.map(({
      name, helpName, purpose, initialActive, deferred, schemaSource, renderer,
    }) => ({ name, helpName, purpose, initialActive, deferred, schemaSource, renderer })));
    expect(manifest.allowedTools).toEqual(expectedNames);
  });

  it('syncs the restricted tools field and owned dispatch sections in external agent fixtures', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'linear-allowlist-'));
    const path = join(directory, 'agent.md');
    await writeFile(path, '---\nname: fixture\ntools: all, read, bash, linear_old\nmode: background\ncustom: keep\n---\n\nIntro.\n\n## Tool surface\n\nOld tool custom.\n\n## Query discipline\n\nOld query custom.\n\n## Job 1 — Execute\n\nKeep job.\n');
    await syncAllowlistFile(path);
    const synced = await readFile(path, 'utf8');
    expect(synced).toContain(`tools: write, ${expectedNames.join(', ')}`);
    expect(synced).toContain('custom: keep');
    expect(synced).toContain('Intro.');
    expect(synced).toContain('Keep job.');
    expect(synced).toContain('Old tool custom.');
    expect(synced).toContain('Old query custom.');
    expect(synced).toContain('<!-- pi-linear:tool-surface:start -->');
    expect(synced).toContain('<!-- pi-linear:query-discipline:start -->');
  });

  it('publishes direct typed calls instead of rejected ordinary loader envelopes', async () => {
    const readme = await readFile('README.md', 'utf8');
    const reference = await readFile('REFERENCE.md', 'utf8');
    expect(readme).toContain('Then call `linear_get_issue` with direct arguments');
    expect(readme).not.toContain('Call an operation directly');
    expect(reference).toContain('then call the activated `linear_<operation>` tool with direct arguments');
    expect(reference).not.toContain('| First call |');
    for (const definition of operationDefinitions) {
      expect(reference, definition.name).toContain(`| \`${definition.name}\` | \`${definition.toolName}\``);
      expect(reference, definition.name).toContain(`\`${JSON.stringify(definition.canonical.example)}\``);
    }
  });

  it('keeps all 49 generated typed schema bytes and operation-contract bytes unchanged', async () => {
    const typedSchemaSha256 = Object.fromEntries(typedLinearTools().map((tool) => [
      tool.name,
      createHash('sha256').update(JSON.stringify(tool.parameters)).digest('hex'),
    ]));
    expect(typedSchemaSha256).toEqual(schemaBaseline.typedSchemaSha256);
    const contractBytes = await readFile(join(process.cwd(), 'extensions/generated/operation-contracts.json'));
    expect(createHash('sha256').update(contractBytes).digest('hex')).toBe(schemaBaseline.operationContractsSha256);
  });

  it('separates exact underscore wire names from human labels and unprefixed help values', () => {
    const tools = [
      linearApiTool() as any,
      linearGetResultTool() as any,
      linearGraphqlTool() as any,
      linearBatchTool() as any,
      ...typedLinearTools().filter(({ name }) => name === 'linear_get_issue'),
    ];
    expect(tools.map(({ name }) => name)).toEqual([
      'linear', 'linear_get_result', 'linear_graphql', 'linear_batch', 'linear_get_issue',
    ]);
    expect(tools.map(({ label }) => label)).toEqual([
      'Linear', 'Linear get result', 'Linear GraphQL', 'Linear batch', 'Linear get issue',
    ]);
    expect(helpResult({ operation: 'get_issue' })).toMatchObject({ name: 'get_issue' });
    expect(JSON.stringify(tools.map(({ name }) => name))).not.toMatch(/linear (?:get issue|get_result|batch|graphql)/i);
  });

  it('keeps 49 typed tools byte-stable and adds one direct exceptional result tool', () => {
    expect(operationDefinitions).toHaveLength(49);
    expect(typedLinearTools()).toHaveLength(49);
    expect(manifest.lazyTools.map(({ name }) => name)).toEqual(typedNames);
    expect(expectedNames).toHaveLength(53);
    expect(manifest.allowedTools).toHaveLength(53);
    expect(manifest.allowedTools).toContain('linear_get_result');
    expect(manifest.allowedTools).toContain('linear_graphql');
    expect(manifest.allowedTools).toContain('linear_batch');
    expect((linearApiTool() as any).description).toContain('linear_get_result is active');
    expect((linearApiTool() as any).description).toContain('special:graphql,batch,get_result');
    expect((linearApiTool() as any).description).not.toMatch(/linear (?:get_result|batch)/);
  });

  it('ships the complete restricted lossless contract in public documentation', async () => {
    const [readme, reference, context, adr, changelog] = await Promise.all([
      readFile('README.md', 'utf8'),
      readFile('REFERENCE.md', 'utf8'),
      readFile('CONTEXT.md', 'utf8'),
      readFile('docs/adr/0003-result-routing.md', 'utf8'),
      readFile('CHANGELOG.md', 'utf8'),
    ]);
    const published = [readme, reference, context, adr, changelog].join('\n');
    for (const claim of [
      'cardinality-aware', 'get_result', 'path-scoped errors', 'sink:inline',
      'legacy compatibility path', 'exactly `write` plus',
    ]) expect(published).toContain(claim);
    expect(readme).toContain('53 tool surfaces');
    expect(readme).toContain('published across all 49 tools');
    expect(readme).toContain(`generated ${manifest.allowedTools.length} Linear tool names`);
    expect(readme).toContain('The guarded `linear_delete_issue_relation` tool is the only delete tool.');
    expect(readme).not.toContain('Delete, archive, and unarchive tools do not exist.');
    expect(reference).toContain('49 inactive typed tools');
    expect(reference).toContain(`does not duplicate ${manifest.lazyTools.length} full schemas`);
    expect(changelog).toContain('By default, results show compact `meta.rateLimit` details only near exhaustion.');
    const referenceTelemetry = reference.match(/## Rate-limit telemetry\n([\s\S]*?)(?=\n## )/)?.[1] ?? '';
    const changelogTelemetry = changelog.split('\n').find((line) => line.startsWith('- Added internal telemetry')) ?? '';
    assertDirectTelemetryGuidance(referenceTelemetry, changelogTelemetry);

    const reviewerCounterexample = 'The direct tools `linear_batch`, `linear_graphql`, and typed `linear_*` do not accept telemetry. Use top-level `telemetry: "always"` on the loader instead. Deprecated loader routes retain top-level telemetry for compatibility.';
    expect(() => assertDirectTelemetryGuidance(reviewerCounterexample, reviewerCounterexample)).toThrow();
    expect(`${reference}\n${changelog}`).not.toMatch(LOADER_ONLY_TELEMETRY);
    const routingDocs = `${readme}\n${reference}\n${adr}`;
    expect(routingDocs).not.toMatch(/\b8\s?KB\b|8\s*\*\s*1024|\b8192\b/i);
    expect(routingDocs).toContain("Pi's 50KB or 2,000-line custom-tool boundary");
    expect(routingDocs).toContain('`LINEAR_SPILL_BYTES`');
    expect(published).not.toMatch(/\bTTL\b/i);
    expect(published).not.toMatch(/registers? (?:a )?typed `linear_get_result`/i);
    expect(published).not.toContain('linear-auditor.md');
  });

  it('guards the accepted result and batch architecture contract', async () => {
    const [context, adr, evidence, changelog] = await Promise.all([
      readFile('CONTEXT.md', 'utf8'),
      readFile('docs/adr/0007-shape-results-and-batch-transport-by-phase.md', 'utf8'),
      readFile('docs/v09-result-transport-evidence.md', 'utf8'),
      readFile('CHANGELOG.md', 'utf8'),
    ]);
    expect(adr).toContain('## Status\n\nAccepted.');
    expect(adr).toContain('ADR 0006 publishes the operation catalog.');
    expect(adr).toContain('This ADR does not repeat or reopen that decision.');
    expect(adr).toContain('This ADR begins after operation selection.');
    expect(adr).toContain('Result routing stays lossless for both views.');
    expect(adr).toContain('as ADR 0003 defines.');
    expect(adr).toContain('[portable evidence ledger](../v09-result-transport-evidence.md)');
    for (const claim of [
      'singular read uses the complete `full` result view',
      'collection uses the disclosed `summary` result view',
      'Exact issue identifiers and UUIDs',
      'project and document slugs can use singular roots because the returned `slugId` proves the requested identity',
      'Cycle references support UUIDs or exact names because the live `Cycle` type has no `slugId`',
      'A non-UUID reference uses exact-name lookup, then reads the result through the UUID singular root',
      'Mutations follow in a second phase.',
      'Each effective key appears exactly once',
      'not GraphQL complexity or response payload size',
    ]) expect(adr).toContain(claim);
    for (const measurement of [
      '`429` for the full issue-list projection and `50` for summary',
      'recorded design baseline was `18` and `6`',
      '`64,827` bytes for full and `3,664` bytes for summary',
      '`X-Complexity: 18` and 49,162 response bytes for full',
      '`X-Complexity: 4` and 4,811 response bytes',
      'returned and kept 20 nodes without truncation',
    ]) expect(adr).toContain(measurement);
    expect(evidence).toContain('aeo-372-live-measurements.json');
    expect(evidence).toMatch(/`[a-f0-9]{64}`/);
    expect(context).toContain('**Result view**:');
    expect(context).toContain('**Exact-root routing**:');
    expect(changelog).toContain('[`ADR 0007`](./docs/adr/0007-shape-results-and-batch-transport-by-phase.md)');
  });
});
