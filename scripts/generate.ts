import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { Kind, parse, print, type FieldNode, type OperationDefinitionNode } from 'graphql';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMAINS, operationDefinitions, projectCompatibilityOperation } from '../extensions/operations';
import { buildTypedToolMetadata } from '../extensions/typed-tool-metadata';
import { exceptionalToolDefinitions } from '../extensions/exceptional-tools';
import { PACKAGE_DOCUMENT_EXCLUSIONS, runtimePackageDocuments } from '../extensions/package-documents';
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
const packageDocumentsPath = resolve(root, 'scripts/fixtures/package-graphql-documents.json');
const introspectionPath = resolve(root, 'scripts/fixtures/readonly-introspection.graphql');
const START = '<!-- BEGIN GENERATED LINEAR OPERATIONS -->';
const END = '<!-- END GENERATED LINEAR OPERATIONS -->';
const LINEAR_TOOL_USAGE = 'Discovery help only. Exact help loads linear_<name>; linear_get_result is active.';

export const generatedFiles = [manifestPath, contractsPath, catalogPath, packageDocumentsPath, readmePath, referencePath] as const;

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
  const rows = DOMAINS.map((domain) => ({
    domain,
    names: operationDefinitions
      .filter((definition) => definition.domain === domain)
      .map(({ toolName }) => `\`${toolName}\``),
  })).filter(({ names }) => names.length)
    .map(({ domain, names }) => `| ${domain} | ${names.join(', ')} |`);
  return [
    '## Generated tool inventory',
    '',
    `The package registers ${product.allowedTools.length} tools. \`linear\` and \`linear_get_result\` start active. The other tools load on demand.`,
    '',
    '| Group | Tools |',
    '| --- | --- |',
    '| Control | `linear`, `linear_get_result`, `linear_graphql`, `linear_batch` |',
    ...rows,
    '',
    'See [`REFERENCE.md`](./REFERENCE.md) for every common field, advanced field, valid form, mode, result, and example.',
  ].join('\n');
}

function fieldRequirement(
  definition: (typeof operationDefinitions)[number],
  name: string,
): string {
  if (definition.canonical.fields.find((field) => field.name === name)?.required) return 'required';
  if (definition.canonical.branches.some((branch) => branch.all.includes(name))) return 'required in some forms';
  return 'optional';
}

function fieldModes(
  definition: (typeof operationDefinitions)[number],
  name: string,
): string {
  const variants = definition.canonical.variants;
  if (!variants) return 'all calls';
  const create = variants[0]?.fields.includes(name) ?? false;
  const update = variants[1]?.fields.includes(name) ?? false;
  if (create && update) return 'create and update';
  if (create) return 'create only';
  if (update) return 'update only';
  return 'result control';
}

function parameterTable(
  definition: (typeof operationDefinitions)[number],
  fields: readonly { name: string; type: string }[],
): string[] {
  if (!fields.length) return ['None.'];
  return [
    '| Field | Type | Requirement | Mode |',
    '| --- | --- | --- | --- |',
    ...fields.map(({ name, type }) =>
      `| \`${name}\` | \`${type}\` | ${fieldRequirement(definition, name)} | ${fieldModes(definition, name)} |`),
  ];
}

function validForms(definition: (typeof operationDefinitions)[number]): string[] {
  const variants = definition.canonical.variants;
  if (variants) {
    return variants.flatMap((variant, index) => {
      const mode = index === 0 ? 'create' : 'update';
      const forms = variant.branches.map(({ all }) => all.length ? all.map((name) => `\`${name}\``).join(' + ') : 'no required fields');
      return [`**${mode[0]!.toUpperCase()}${mode.slice(1)} forms**`, '', ...forms.map((form) => `- ${form}`), ''];
    });
  }
  return definition.canonical.branches.map(({ all }) =>
    `- ${all.length ? all.map((name) => `\`${name}\``).join(' + ') : 'No required fields.'}`);
}

function resultBehavior(definition: (typeof operationDefinitions)[number]): string {
  if (definition.safety.mutation) return 'Compact acknowledgement by default. Set `view` to `full` when the schema publishes it.';
  if (definition.result.category === 'collection') return 'Summary collection by default. Set `view` to `full` when the schema publishes it.';
  if (definition.result.category === 'singular') return 'Full singular result by default.';
  return 'Local result. No Linear network request.';
}

function detailedOperationReference(definition: (typeof operationDefinitions)[number]): string[] {
  const advanced = definition.canonical.advancedFields;
  return [
    '<details>',
    `<summary><code>${definition.toolName}</code> · ${definition.kind} · ${definition.purpose}</summary>`,
    '',
    `Activate: \`{ "operation": "help", "variables": { "operation": "${definition.name}" } }\``,
    '',
    '**Valid forms**',
    '',
    ...validForms(definition),
    '',
    '**Common fields**',
    '',
    ...parameterTable(definition, definition.canonical.fields),
    '',
    '**Advanced fields**',
    '',
    ...(advanced.length
      ? [
          `Load this list with \`{ "operation": "help", "variables": { "operation": "${definition.name}:advanced" } }\`.`,
          '',
          ...parameterTable(definition, advanced),
        ]
      : ['None.']),
    '',
    `Example: \`${JSON.stringify(definition.canonical.example)}\``,
    '',
    `Result: ${resultBehavior(definition)}`,
    '',
    `Safety: ${definition.safety.mutation
      ? definition.safety.namedInputPolicy === 'guarded-destructive'
        ? 'Guarded destructive mutation. The operation checks the target and its identity before the write.'
        : 'Named mutation. Read-only mode rejects it before credential lookup or network access.'
      : 'Read or local operation.'}`,
    '',
    '</details>',
  ];
}

function controlToolReference(): string[] {
  return [
    '## Control tool details',
    '',
    '<details>',
    '<summary><code>linear</code> · discovery and activation</summary>',
    '',
    '| Field | Type | Requirement |',
    '| --- | --- | --- |',
    '| `operation` | literal `"help"` | required |',
    '| `variables.domain` | operation domain | optional, exclusive with `variables.operation` |',
    '| `variables.operation` | operation name, `<name>:advanced`, `graphql`, `batch`, or `get_result` | optional, exclusive with `variables.domain` |',
    '',
    'This tool makes no Linear network request. Root and domain help load no tool. Exact operation help activates one direct tool.',
    '',
    '</details>',
    '',
    '<details>',
    '<summary><code>linear_get_result</code> · read a stored result</summary>',
    '',
    '| Field | Type | Requirement |',
    '| --- | --- | --- |',
    '| `handle` | result handle | required |',
    '| `path` | RFC 6901 JSON Pointer | optional |',
    '| `offset` | integer, minimum 0 | optional |',
    '',
    'This tool starts active. Continue with the returned `nextOffset` until `complete` is true.',
    '',
    '</details>',
    '',
    '<details>',
    '<summary><code>linear_graphql</code> · direct GraphQL escape hatch</summary>',
    '',
    '| Field | Type | Requirement |',
    '| --- | --- | --- |',
    '| `query` | GraphQL document string | required |',
    '| `variables` | object | optional |',
    '| `workspace` | stored Workspace name | optional |',
    '| `sink` | `inline` or `artifact` | optional |',
    '| `telemetry` | literal `always` | optional |',
    '',
    'Load this tool with exact `graphql` help. Raw mutations require `LINEAR_MUTATIONS=all` and explicit authorization.',
    '',
    '</details>',
    '',
    '<details>',
    '<summary><code>linear_batch</code> · independent reads and ordered mutations</summary>',
    '',
    '| Field | Type | Requirement |',
    '| --- | --- | --- |',
    '| `operations` | non-empty `BatchEntry[]` | use this read-only form, or use phased fields |',
    '| `reads` | non-empty `BatchEntry[]` | optional phased read list |',
    '| `mutations` | non-empty `BatchEntry[]` | optional phased mutation list |',
    '| `workspace` | stored Workspace name | optional |',
    '| `sink` | `inline` or `artifact` | optional |',
    '| `telemetry` | literal `always` | optional |',
    '',
    'A `BatchEntry` has `operation`, optional `variables`, and optional `key`. Use `operations`, or use `reads` and `mutations`. Do not combine both forms.',
    '',
    '</details>',
  ];
}

function referenceCatalog(): string {
  const rows = operationDefinitions.map((definition) => {
    const required = definition.canonical.fields.filter(({ required }) => required).map(({ name }) => name).join(', ') || 'none';
    const example = `\`${JSON.stringify(definition.canonical.example)}\``;
    return `| \`${definition.name}\` | \`${definition.toolName}\` | ${definition.domain} | ${required} | ${definition.purpose} | ${example} |`;
  });
  const details = DOMAINS.flatMap((domain) => {
    const definitions = operationDefinitions.filter((definition) => definition.domain === domain);
    if (!definitions.length) return [];
    return [
      `### ${domain}`,
      '',
      ...definitions.flatMap((definition) => [...detailedOperationReference(definition), '']),
    ];
  });
  return [
    '## Generated operation catalog',
    '',
    'Use exact loader help to activate an ordinary operation. The table shows one common-tier call for each typed tool.',
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
    'Normal exact help returns purpose, example, and activation. Then call `linear_get_issue`:',
    '',
    '```json',
    '{ "issue": "AEO-258" }',
    '```',
    '',
    '### Advanced tail help',
    '',
    '```json',
    '{ "operation": "help", "variables": { "operation": "list_comments:advanced" } }',
    '```',
    '',
    'Send returned tail fields inside `advanced`:',
    '',
    '```json',
    '{ "issue": "AEO-258", "advanced": { "before": "CURSOR", "last": 20 } }',
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
    '{ "reads": [{ "key": "issue", "operation": "get_issue", "variables": { "issue": "AEO-258" } }], "mutations": [{ "key": "delete", "operation": "delete_issue_relation", "variables": { "relationId": "33333333-3333-4333-8333-333333333333", "issue": "11111111-1111-4111-8111-111111111111", "relatedIssue": "22222222-2222-4222-8222-222222222222", "type": "related" } }] }',
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
    '',
    ...controlToolReference(),
    '',
    '## Complete typed tool details',
    '',
    'These tables come from the same operation definitions that build the runtime schemas.',
    'The activated schema remains authoritative for nested object keys, enum values, and provider validation.',
    '',
    ...details,
  ].join('\n');
}

function packageDocumentInventory(introspectionDocument: string) {
  const documents = runtimePackageDocuments(introspectionDocument).map((entry) => {
    const definition = parse(entry.document).definitions.find(
      (candidate): candidate is OperationDefinitionNode => candidate.kind === Kind.OPERATION_DEFINITION,
    );
    if (!definition) throw new Error(`Package document ${entry.id} has no operation definition.`);
    return {
      ...entry,
      operationType: definition.operation,
      operationName: definition.name?.value ?? null,
      rootFields: definition.selectionSet.selections
        .filter((selection): selection is FieldNode => selection.kind === Kind.FIELD)
        .map(({ name }) => name.value),
      variables: Object.fromEntries((definition.variableDefinitions ?? []).map(({ variable, type }) => [
        variable.name.value, print(type),
      ])),
      sha256: createHash('sha256').update(entry.document).digest('hex'),
    };
  });
  if (new Set(documents.map(({ id }) => id)).size !== documents.length) {
    throw new Error('Package document inventory contains duplicate IDs.');
  }
  return { schemaVersion: 1, exclusions: PACKAGE_DOCUMENT_EXCLUSIONS, documents };
}

export async function renderGeneratedFiles(): Promise<Record<string, string>> {
  const base = {
    readme: await readFile(readmePath, 'utf8'),
    reference: await readFile(referencePath, 'utf8'),
    introspection: await readFile(introspectionPath, 'utf8'),
  };
  return {
    [manifestPath]: `${JSON.stringify(manifest(), null, 2)}\n`,
    [contractsPath]: `${JSON.stringify(contracts(), null, 2)}\n`,
    [catalogPath]: catalogModule(),
    [packageDocumentsPath]: `${JSON.stringify(packageDocumentInventory(base.introspection), null, 2)}\n`,
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

/**
 * The non-Linear tools a bound Linear agent may hold.
 *
 * This sync restricts deliberately: an agent granted `all`, `bash` or `exec` loses them,
 * because a Linear agent has no business running commands. `read` is included because the
 * agent's job is to write brief artifacts and it must be able to open what it produced;
 * without it here, every sync silently revoked a granted `read`, and pi drops unknown tool
 * names without an error, so the loss came with nothing to explain it.
 */
const AGENT_BASE_TOOLS = ['read', 'write'] as const;

function replaceToolsLine(source: string, allowedTools: readonly string[]): string {
  if (!/^tools:\s*(.*)$/m.test(source)) throw new Error('Agent allowlist has no tools frontmatter field.');
  return source.replace(/^tools:.*$/m, `tools: ${[...AGENT_BASE_TOOLS, ...allowedTools].join(', ')}`);
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
