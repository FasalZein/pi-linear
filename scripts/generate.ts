import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMAINS, operationDefinitions, projectCompatibilityOperation } from '../extensions/operations';
import { buildTypedToolMetadata } from '../extensions/typed-tool-metadata';
import { exceptionalToolDefinitions } from '../extensions/exceptional-tools';
import {
  LINEAR_AGENT_QUERY_DISCIPLINE,
  LINEAR_AGENT_QUERY_DISCIPLINE_END,
  LINEAR_AGENT_QUERY_DISCIPLINE_START,
  LINEAR_AGENT_TOOL_SURFACE,
  LINEAR_AGENT_TOOL_SURFACE_END,
  LINEAR_AGENT_TOOL_SURFACE_START,
} from './linear-agent-contract';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const generated = resolve(root, 'extensions/generated');
const manifestPath = resolve(generated, 'linear-tools.manifest.json');
const contractsPath = resolve(generated, 'operation-contracts.json');
const catalogPath = resolve(generated, 'operation-catalog.ts');
const readmePath = resolve(root, 'README.md');
const referencePath = resolve(root, 'REFERENCE.md');
const START = '<!-- BEGIN GENERATED LINEAR OPERATIONS -->';
const END = '<!-- END GENERATED LINEAR OPERATIONS -->';
const LINEAR_TOOL_USAGE = 'Discovery help only. Exact help loads linear_<name>; linear_get_result is active.';

export const generatedFiles = [manifestPath, contractsPath, catalogPath, readmePath, referencePath] as const;

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function manifest() {
  const lazyTools = operationDefinitions.map(({ toolName: name, name: operation, domain }) => ({ name, operation, domain }));
  const exceptionalTools = exceptionalToolDefinitions.map(({
    name, helpName, purpose, initialActive, deferred, schemaSource, renderer,
  }) => ({ name, helpName, purpose, initialActive, deferred, schemaSource, renderer }));
  return {
    schemaVersion: 2,
    package: '@tothemoon/pi-linear-lite',
    discoveryTool: { name: 'linear', requiredOperation: 'help', variableForms: ['domain', 'operation'] },
    initialActiveTools: ['linear', ...exceptionalTools.filter(({ initialActive }) => initialActive).map(({ name }) => name)],
    lazyTools,
    exceptionalTools,
    allowedTools: ['linear', ...exceptionalTools.map(({ name }) => name), ...lazyTools.map(({ name }) => name)],
  };
}

export function contractProjection(definition: (typeof operationDefinitions)[number]) {
  const signature = `${definition.name}(${definition.canonical.fields
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
      example: { operation: definition.name, variables: definition.canonical.example },
      callFields: definition.canonical.fields.map(({ name }) => name),
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
    ...DOMAINS.map((domain) => ({
      domain,
      names: operationDefinitions.filter((definition) => definition.domain === domain).map(({ name }) => name),
    })).filter(({ names }) => names.length).map(({ domain, names }) => `${domain}: ${names.join(', ')}`),
    'special: graphql, batch, get_result',
  ].join('\n');
}

function modelOperationCatalogText(): string {
  return [
    `operations:${operationDefinitions.map(({ name }) => name).join(',')}`,
    'special:graphql,batch,get_result',
  ].join('\n');
}

export function linearToolDescription(): string {
  return `${LINEAR_TOOL_USAGE}\n${modelOperationCatalogText()}`;
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
  const product = manifest();
  const names = product.allowedTools.map((name) => `\`${name}\``).join(', ');
  return `## Generated tool inventory\n\nThe package registers ${product.allowedTools.length} tools. \`linear\` and \`linear_get_result\` start active. \`linear_graphql\`, \`linear_batch\`, and typed tools load on demand.\n\n${names}`;
}

function referenceCatalog(): string {
  const rows = operationDefinitions.map((definition) => {
    const required = definition.canonical.fields.filter(({ required }) => required).map(({ name }) => name).join(', ') || 'none';
    const example = `\`${JSON.stringify(definition.canonical.example)}\``;
    return `| \`${definition.name}\` | \`${definition.toolName}\` | ${definition.domain} | ${required} | ${definition.purpose} | ${example} |`;
  });
  return [
    '## Generated operation catalog',
    '',
    'Use exact loader help to activate an ordinary operation. Then call its typed tool with the direct arguments in the table.',
    '',
    '| Operation | Typed tool | Domain | Always required | Purpose | Typed arguments |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    '### Exact help and typed call',
    '',
    '```json',
    '{ "operation": "help", "variables": { "operation": "get_issue" } }',
    '```',
    '',
    'Then call `linear_get_issue`:',
    '',
    '```json',
    '{ "issue": "AEO-258" }',
    '```',
    '',
    '### Discovery and direct exceptional tools',
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
    '{ "operation": "help", "variables": { "operation": "graphql" } }',
    '```',
    '',
    'Then call `linear_graphql` with direct arguments:',
    '',
    '```json',
    '{ "query": "query { viewer { id } }", "variables": {} }',
    '```',
    '',
    '```json',
    '{ "operation": "help", "variables": { "operation": "batch" } }',
    '```',
    '',
    'Then call `linear_batch` with direct arguments:',
    '',
    '```json',
    '{ "operations": [{ "key": "issue", "operation": "get_issue", "variables": { "issue": "AEO-258" } }] }',
    '```',
    '',
    '```json',
    '{ "reads": [{ "key": "issue", "operation": "get_issue", "variables": { "issue": "AEO-258" } }], "mutations": [{ "key": "delete", "operation": "delete_issue_relation", "variables": { "relationId": "33333333-3333-4333-8333-333333333333", "issueId": "11111111-1111-4111-8111-111111111111", "relatedIssueId": "22222222-2222-4222-8222-222222222222", "type": "related" } }] }',
    '```',
    '',
    '```json',
    '{ "operation": "help", "variables": { "operation": "get_result" } }',
    '```',
    '',
    'This returns the direct parameter card without activation. Call the already-active `linear_get_result` tool:',
    '',
    '```json',
    '{ "handle": "linear-result:v1:550e8400-e29b-41d4-a716-446655440000", "path": "", "offset": 0 }',
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

function replaceOrInsertMarkerBlock(
  source: string,
  heading: string,
  startMarker: string,
  endMarker: string,
  content: string,
): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  if ((start < 0) !== (end < 0) || (start >= 0 && end < start)) {
    throw new Error(`External Linear agent has an incomplete generated block: ${startMarker}.`);
  }
  if (start >= 0) {
    if (source.indexOf(startMarker, start + startMarker.length) >= 0 || source.indexOf(endMarker, end + endMarker.length) >= 0) {
      throw new Error(`External Linear agent has duplicate generated markers: ${startMarker}.`);
    }
    return `${source.slice(0, start)}${content}${source.slice(end + endMarker.length)}`;
  }

  const headingLine = `${heading}\n`;
  const headingStart = source.indexOf(headingLine);
  if (headingStart >= 0) {
    const insertAt = headingStart + headingLine.length;
    return `${source.slice(0, insertAt)}\n${content}\n${source.slice(insertAt)}`;
  }
  const separator = source.endsWith('\n') ? '\n' : '\n\n';
  return `${source}${separator}${heading}\n\n${content}\n`;
}

function replaceOwnedAgentContract(source: string): string {
  const withTools = replaceOrInsertMarkerBlock(
    source,
    '## Tool surface',
    LINEAR_AGENT_TOOL_SURFACE_START,
    LINEAR_AGENT_TOOL_SURFACE_END,
    LINEAR_AGENT_TOOL_SURFACE,
  );
  return replaceOrInsertMarkerBlock(
    withTools,
    '## Query discipline',
    LINEAR_AGENT_QUERY_DISCIPLINE_START,
    LINEAR_AGENT_QUERY_DISCIPLINE_END,
    LINEAR_AGENT_QUERY_DISCIPLINE,
  );
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
  const next = replaceOwnedAgentContract(replaceToolsLine(source, manifest().allowedTools));
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
