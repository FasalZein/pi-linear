import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BATCH_PURPOSE } from '../extensions/batch';
import { operationDefinitions, projectCompatibilityOperation } from '../extensions/operations';
import { GET_RESULT_PURPOSE } from '../extensions/result-handles';
import { buildTypedToolMetadata } from '../extensions/typed-tool-metadata';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const generated = resolve(root, 'extensions/generated');
const manifestPath = resolve(generated, 'linear-tools.manifest.json');
const contractsPath = resolve(generated, 'operation-contracts.json');
const catalogPath = resolve(generated, 'operation-catalog.ts');
const readmePath = resolve(root, 'README.md');
const referencePath = resolve(root, 'REFERENCE.md');
const START = '<!-- BEGIN GENERATED LINEAR OPERATIONS -->';
const END = '<!-- END GENERATED LINEAR OPERATIONS -->';
const LINEAR_TOOL_USAGE = 'Run a named Linear operation or raw GraphQL. The operation names listed below are callable directly as { "operation": "<name>", "variables": { … } }. { "operation": "help", "variables": { "operation": "<name>" } } returns exact parameters. For canonical named operations, it also loads the strict typed tool. Loader-only batch and get_result do not add typed tools.';

export const generatedFiles = [manifestPath, contractsPath, catalogPath, readmePath, referencePath] as const;

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function manifest() {
  const lazyTools = operationDefinitions.map(({ toolName: name, name: operation, domain }) => ({ name, operation, domain }));
  return {
    schemaVersion: 1,
    package: '@tothemoon/pi-linear-lite',
    initialActiveTools: ['linear'],
    lazyTools,
    allowedTools: ['linear', ...lazyTools.map(({ name }) => name)],
  };
}

export function contractProjection(definition: (typeof operationDefinitions)[number]) {
  const signature = `${definition.name}(${definition.compatibility.fields
    .map(({ name, type, required }) => `${name}${required ? '' : '?'}: ${type}`).join(', ')})`;
  const compatibility = definition.compatibility;
  const tool = buildTypedToolMetadata(projectCompatibilityOperation(definition));
  return {
    name: definition.name,
    tool,
    domain: definition.domain,
    purpose: definition.purpose,
    kind: definition.kind,
    help: {
      signature,
      exact: true,
      example: compatibility.example,
      callFields: definition.render.callFields,
    },
    compatibility: {
      operationAliases: compatibility.operationAliases,
      fields: compatibility.fields,
      branches: compatibility.branches,
      acceptedFields: compatibility.acceptedFields ?? null,
      legacyBranches: compatibility.legacyBranches ?? null,
      aliasFields: compatibility.aliasFields ?? null,
      example: compatibility.example,
      document: compatibility.document,
      pagination: compatibility.pagination ?? null,
      resolverPaths: compatibility.resolverPaths ?? {},
      requiresVariables: compatibility.requiresVariables ?? false,
      semanticException: compatibility.semanticException ?? null,
    },
    graphql: definition.graphql ?? null,
    preparation: { resolverPaths: definition.preparation.resolverPaths },
    safety: definition.safety,
    canonical: definition.canonical,
    result: definition.result,
    render: definition.render,
  };
}

function contracts() {
  return operationDefinitions.map(contractProjection);
}

export function operationCatalogText(): string {
  return [
    ...operationDefinitions.map(({ name, purpose }) => `${name}: ${purpose}`),
    `batch: ${BATCH_PURPOSE}`,
    `get_result: ${GET_RESULT_PURPOSE}`,
  ].join('\n');
}

export function linearToolDescription(): string {
  return `${LINEAR_TOOL_USAGE}\n${operationCatalogText()}`;
}

function catalogModule(): string {
  return `export const LINEAR_OPERATION_CATALOG = ${JSON.stringify(operationCatalogText())};\nexport const LINEAR_TOOL_DESCRIPTION = ${JSON.stringify(linearToolDescription())};\n`;
}

function replaceGeneratedSection(source: string, body: string): string {
  const section = `${START}\n${body.trimEnd()}\n${END}`;
  const pattern = new RegExp(`${START}[\\s\\S]*?${END}`);
  if (pattern.test(source)) return source.replace(pattern, section);
  return `${source.trimEnd()}\n\n${section}\n`;
}

function readmeCatalog(): string {
  const names = manifest().allowedTools.map((name) => `\`${name}\``).join(', ');
  return `## Generated tool inventory\n\nThe package registers ${operationDefinitions.length + 1} tools. The loader starts active. Typed tools load on demand.\n\n${names}`;
}

function referenceCatalog(): string {
  const rows = operationDefinitions.map((definition) => {
    const required = definition.canonical.fields.filter(({ required }) => required).map(({ name }) => name).join(', ') || 'none';
    const example = `\`${JSON.stringify(definition.compatibility.example)}\``;
    return `| \`${definition.name}\` | \`${definition.toolName}\` | ${definition.domain} | ${required} | ${definition.purpose} | ${example} |`;
  });
  return [
    '## Generated operation catalog',
    '',
    '| Operation | Typed tool | Domain | Always required | Purpose | First call |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    '### Loader envelopes',
    '',
    '```json',
    '{ "operation": "help" }',
    '```',
    '',
    '```json',
    '{ "operation": "help", "variables": { "domain": "issues" } }',
    '```',
    '',
    '```json',
    '{ "operation": "help", "variables": { "operation": "get_issue" } }',
    '```',
    '',
    '```json',
    '{ "operation": "batch", "variables": { "reads": [{ "key": "one", "operation": "get_issue", "variables": { "issue": "AEO-258" } }] } }',
    '```',
    '',
    '```json',
    '{ "operation": "get_result", "variables": { "handle": "linear-result:v1:550e8400-e29b-41d4-a716-446655440000", "path": "", "offset": 0 } }',
    '```',
  ].join('\n');
}

export async function renderGeneratedFiles(): Promise<Record<string, string>> {
  const base = {
    readme: await readFile(readmePath, 'utf8'),
    reference: await readFile(referencePath, 'utf8'),
  };
  return {
    [manifestPath]: json(manifest()),
    [contractsPath]: json(contracts()),
    [catalogPath]: catalogModule(),
    [readmePath]: replaceGeneratedSection(base.readme, readmeCatalog()),
    [referencePath]: replaceGeneratedSection(base.reference, referenceCatalog()),
  };
}

export async function staleGeneratedFiles(
  files: Record<string, string>,
  read: (path: string) => Promise<string> = async (path) => readFile(path, 'utf8'),
): Promise<string[]> {
  const stale: string[] = [];
  for (const [path, content] of Object.entries(files)) {
    const current = await read(path).catch(() => '');
    if (current !== content) stale.push(path);
  }
  return stale;
}

export async function generate(check = false): Promise<void> {
  const files = await renderGeneratedFiles();
  if (check) {
    const stale = await staleGeneratedFiles(files);
    if (stale.length) {
      throw new Error(`Generated files are stale: ${stale.map((path) => path.slice(root.length + 1)).join(', ')}. Run npm run generate.`);
    }
    return;
  }
  for (const [path, content] of Object.entries(files)) {
    const current = await readFile(path, 'utf8').catch(() => '');
    if (current === content) continue;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

function replaceToolsLine(source: string, allowedTools: readonly string[]): string {
  if (!/^tools:\s*(.*)$/m.test(source)) throw new Error('Agent allowlist has no tools frontmatter field.');
  return source.replace(/^tools:.*$/m, `tools: ${['write', ...allowedTools].join(', ')}`);
}

export function defaultAllowlistPaths(): string[] {
  return [resolve(homedir(), '.pi/agent/agents/linear.md')];
}

export async function syncAllowlistFile(path: string, check = false): Promise<boolean> {
  const source = await readFile(path, 'utf8').catch(() => {
    throw new Error(`External Linear agent allowlist is missing: ${path}`);
  });
  const next = replaceToolsLine(source, manifest().allowedTools);
  if (next === source) return false;
  if (check) throw new Error(`External Linear agent allowlist is stale: ${path}`);
  await writeFile(path, next);
  return true;
}

export async function runGenerationCommand(args = process.argv.slice(2)): Promise<void> {
  const [command, ...paths] = args;
  if (command === '--check') return generate(true);
  if (command === '--allowlists-check' || command === '--allowlists-sync') {
    const targets = paths.length ? paths.map((path) => resolve(path)) : defaultAllowlistPaths();
    for (const path of targets) await syncAllowlistFile(path, command === '--allowlists-check');
    return;
  }
  await generate(false);
}
