import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { operationDefinitions } from '../extensions/operations';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const generated = resolve(root, 'extensions/generated');
const manifestPath = resolve(generated, 'linear-tools.manifest.json');
const contractsPath = resolve(generated, 'operation-contracts.json');
const readmePath = resolve(root, 'README.md');
const referencePath = resolve(root, 'REFERENCE.md');
const START = '<!-- BEGIN GENERATED LINEAR OPERATIONS -->';
const END = '<!-- END GENERATED LINEAR OPERATIONS -->';

export const generatedFiles = [manifestPath, contractsPath, readmePath, referencePath] as const;

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function manifest() {
  const lazyTools = operationDefinitions.map(({ toolName: name, name: operation, domain }) => ({ name, operation, domain }));
  return {
    schemaVersion: 1,
    package: '@tothemoon/pi-linear-lite',
    initialActiveTools: ['linear_api'],
    lazyTools,
    allowedTools: ['linear_api', ...lazyTools.map(({ name }) => name)],
  };
}

export function contractProjection(definition: (typeof operationDefinitions)[number]) {
  const signature = `${definition.name}(${definition.compatibility.fields
    .map(({ name, type, required }) => `${name}${required ? '' : '?'}: ${type}`).join(', ')})`;
  const compatibility = definition.compatibility;
  return {
    name: definition.name,
    tool: {
      name: definition.toolName,
      label: `Linear ${definition.name.replace(/_/g, ' ')}`,
      description: definition.purpose,
    },
    domain: definition.domain,
    purpose: definition.purpose,
    kind: definition.kind,
    help: {
      signature,
      exact: definition.discovery.exactHelp,
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
    discovery: definition.discovery,
    result: definition.result,
    render: definition.render,
  };
}

function contracts() {
  return operationDefinitions.map(contractProjection);
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
    '{ "operation": "help", "variables": { "query": "list comments on AEO-258" } }',
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
  const match = source.match(/^tools:\s*(.*)$/m);
  if (!match) throw new Error('Agent allowlist has no tools frontmatter field.');
  const existing = match[1]!.split(',').map((value) => value.trim()).filter(Boolean);
  const retained = existing.filter((name) => !name.startsWith('linear_'));
  return source.replace(/^tools:.*$/m, `tools: ${[...retained, ...allowedTools].join(', ')}`);
}

export async function syncAllowlistFile(path: string, check = false): Promise<boolean> {
  const source = await readFile(path, 'utf8');
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
    if (paths.length !== 2) throw new Error('Pass exactly two external Linear agent allowlist paths.');
    for (const path of paths) await syncAllowlistFile(resolve(path), command === '--allowlists-check');
    return;
  }
  await generate(false);
}
