import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, type IntrospectionQuery, type OperationDefinitionNode } from 'graphql';
import { registerLinearExtension } from '../extensions/index';
import { linearGraphQL, resolveApiKey } from '../extensions/client';
import { operations, type LinearOperation } from '../extensions/operations';
import { redactText } from '../extensions/redact';
import {
  assertFixtureProvenance,
  catalogSchemaUsage,
  compareReadonlySchema,
  type ReadonlySchemaFixture,
  type ReadonlySchemaScope,
} from './readonly-schema';
import { assertNoCredentialLeak } from './smoke-safety';

type ToolResult = { details?: Record<string, unknown> };
type JsonObject = Record<string, unknown>;
type Tool = { name: string; execute: (...args: any[]) => Promise<ToolResult> };

const ISSUE_REFERENCE = 'AEO-258';
const MISSING_ISSUE_ID = '00000000-0000-4000-8000-000000000000';
const KNOWN_TOKEN = 'lin_api_known_smoke_token_1234567890';
const PAGE_INFO_FIELDS = ['endCursor', 'hasNextPage', 'hasPreviousPage', 'startCursor'];
const ZERO_ARGUMENT_READS = [
  'list_comments', 'list_views', 'list_cycles', 'list_documents', 'list_initiatives',
  'list_issue_labels', 'list_issue_relations', 'list_issue_statuses', 'list_issues',
  'list_milestones', 'list_project_labels', 'list_project_relations', 'list_projects',
  'list_teams', 'list_users',
].sort();
const LIST_GET: Record<string, { get: string; parameter: string; root: string } | undefined> = {
  list_comments: undefined,
  list_views: { get: 'get_view', parameter: 'id', root: 'customView' },
  list_cycles: { get: 'get_cycle', parameter: 'cycle', root: 'cycle' },
  list_documents: { get: 'get_document', parameter: 'document', root: 'document' },
  list_initiatives: { get: 'get_initiative', parameter: 'initiative', root: 'initiative' },
  list_issue_labels: undefined,
  list_issue_relations: undefined,
  list_issue_statuses: undefined,
  list_issues: { get: 'get_issue', parameter: 'issue', root: 'issue' },
  list_milestones: { get: 'get_milestone', parameter: 'milestone', root: 'projectMilestone' },
  list_project_labels: undefined,
  list_project_relations: undefined,
  list_projects: { get: 'get_project', parameter: 'project', root: 'project' },
  list_teams: { get: 'get_team', parameter: 'team', root: 'team' },
  list_users: { get: 'get_user', parameter: 'user', root: 'user' },
};

function fakeContext() {
  return {
    hasUI: false,
    ui: { confirm: async () => false, input: async () => undefined, notify: () => undefined },
  } as any;
}

async function smokeApiKey(): Promise<string> {
  const isolated = process.env.PI_CODING_AGENT_DIR;
  const authenticated = process.env.LINEAR_SMOKE_AUTH_AGENT_DIR;
  try {
    if (authenticated) process.env.PI_CODING_AGENT_DIR = authenticated;
    const { apiKey } = await resolveApiKey(fakeContext(), { promptIfMissing: false });
    if (!apiKey) throw new Error('smoke.auth: existing Linear authentication is unavailable');
    return apiKey;
  } finally {
    if (isolated === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = isolated;
  }
}

function data(details: Record<string, unknown> | undefined): JsonObject {
  const value = details?.data;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('smoke.runtime: inline data object is missing');
  return value as JsonObject;
}

function entityId(details: Record<string, unknown> | undefined, root: string): string {
  const entity = data(details)[root];
  if (!entity || typeof entity !== 'object' || Array.isArray(entity)) throw new Error(`smoke.runtime: ${root} entity is missing`);
  const id = (entity as JsonObject).id;
  if (typeof id !== 'string' || !id) throw new Error(`smoke.runtime: ${root}.id is missing`);
  return id;
}

function rootName(operation: LinearOperation): string {
  const definition = parse(operation.document).definitions.find(
    (entry): entry is OperationDefinitionNode => entry.kind === 'OperationDefinition',
  );
  const field = definition?.selectionSet.selections.find((entry) => entry.kind === 'Field');
  if (!field || field.kind !== 'Field') throw new Error(`smoke.catalog: ${operation.name} root is missing`);
  return field.name.value;
}

function connection(details: Record<string, unknown> | undefined, root: string) {
  const value = data(details)[root];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`smoke.pagination: ${root} connection is missing`);
  const nodes = (value as JsonObject).nodes;
  const pageInfo = (value as JsonObject).pageInfo;
  if (!Array.isArray(nodes) || !pageInfo || typeof pageInfo !== 'object' || Array.isArray(pageInfo)) {
    throw new Error(`smoke.pagination: ${root} nodes or pageInfo is missing; fields ${JSON.stringify(Object.keys(value as JsonObject).sort())}`);
  }
  const page = pageInfo as JsonObject;
  const fields = Object.keys(page).sort();
  if (JSON.stringify(fields) !== JSON.stringify(PAGE_INFO_FIELDS)) {
    throw new Error(`smoke.pagination: ${root}.pageInfo fields expected ${JSON.stringify(PAGE_INFO_FIELDS)}, actual ${JSON.stringify(fields)}`);
  }
  if (typeof page.hasNextPage !== 'boolean' || typeof page.hasPreviousPage !== 'boolean') {
    throw new Error(`smoke.pagination: ${root}.pageInfo booleans are invalid`);
  }
  for (const cursor of ['startCursor', 'endCursor']) {
    if (page[cursor] !== null && typeof page[cursor] !== 'string') throw new Error(`smoke.pagination: ${root}.pageInfo.${cursor} is invalid`);
  }
  return { nodes, pageInfo: page as { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null } };
}

async function executeTool(tool: Tool, params: Record<string, unknown>): Promise<ToolResult> {
  return await tool.execute('readonly-smoke', params, undefined, undefined, fakeContext());
}

function extensionHarness() {
  const tools = new Map<string, Tool>();
  let active: string[] = [];
  let start: () => void = () => undefined;
  const pi = {
    registerCommand: () => undefined,
    registerTool: (tool: Tool) => { tools.set(tool.name, tool); active.push(tool.name); },
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active = [...names]; },
    on: (event: string, handler: () => void) => { if (event === 'session_start') start = handler; },
  } as any;
  registerLinearExtension(pi, 'readonly');
  start();
  return { tool: (name: string) => tools.get(name), active: () => [...active] };
}

function zeroArgumentReads(): LinearOperation[] {
  const reads = Object.values(operations).filter((operation) => operation.name.startsWith('list_') && !operation.requiresVariables);
  const names = reads.map((operation) => operation.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(ZERO_ARGUMENT_READS)) {
    throw new Error(`smoke.catalog: zero-argument reads expected ${JSON.stringify(ZERO_ARGUMENT_READS)}, actual ${JSON.stringify(names)}`);
  }
  return reads.sort((left, right) => left.name.localeCompare(right.name));
}

async function writeSummary(summary: JsonObject, apiKey: string): Promise<void> {
  assertNoCredentialLeak(summary, apiKey);
  const root = process.env.PI_ARTIFACT_PROJECT_ROOT;
  if (!root) throw new Error('smoke.cleanup: isolated artifact root is unavailable');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'readonly-smoke-summary.json'), JSON.stringify(summary, null, 2));
}

async function runAuthenticatedSmoke(apiKey: string): Promise<JsonObject> {
  const [fixtureSource, scopeSource, sourceQuery] = await Promise.all([
    readFile(new URL('./fixtures/readonly-schema-contract.json', import.meta.url), 'utf8'),
    readFile(new URL('./fixtures/readonly-schema-scope.json', import.meta.url), 'utf8'),
    readFile(new URL('./fixtures/readonly-introspection.graphql', import.meta.url), 'utf8'),
  ]);
  const fixture = JSON.parse(fixtureSource) as ReadonlySchemaFixture;
  const scope = JSON.parse(scopeSource) as ReadonlySchemaScope;
  assertFixtureProvenance(fixture, scope, sourceQuery, scopeSource);
  const usage = catalogSchemaUsage(Object.values(operations));
  const introspection = await linearGraphQL<IntrospectionQuery>(apiKey, sourceQuery, {});
  compareReadonlySchema(introspection, fixture, usage, scope);

  const harness = extensionHarness();
  const compatibility = harness.tool('linear_api');
  if (!compatibility) throw new Error('smoke.activation: linear_api is unavailable');
  const activation = await executeTool(compatibility, { operation: 'help', variables: { operation: 'get_issue' } });
  const loaded = activation.details?.loadedTools;
  if (!Array.isArray(loaded) || loaded.length !== 1 || loaded[0] !== 'linear_get_issue' || !harness.active().includes('linear_get_issue')) {
    throw new Error('smoke.activation: linear_get_issue was not loaded through linear_api');
  }
  const typedGetIssue = harness.tool('linear_get_issue');
  if (!typedGetIssue) throw new Error('smoke.activation: activated linear_get_issue is unavailable');

  const compatibilityIssue = await executeTool(compatibility, {
    operation: 'get_issue', variables: { issue: ISSUE_REFERENCE }, sink: 'inline',
  });
  const typedIssue = await executeTool(typedGetIssue, { issue: ISSUE_REFERENCE });
  assertNoCredentialLeak({ compatibilityIssue, typedIssue }, apiKey);
  if (entityId(compatibilityIssue.details, 'issue') !== entityId(typedIssue.details, 'issue')) {
    throw new Error('smoke.runtime: get_issue identity differed across surfaces');
  }

  const listResults = new Map<string, { nodes: unknown[]; root: string }>();
  let followedCursors = 0;
  for (const operation of zeroArgumentReads()) {
    const zeroArgumentResult = await executeTool(compatibility, { operation: operation.name, variables: {}, sink: 'inline' });
    assertNoCredentialLeak(zeroArgumentResult, apiKey);
    const root = rootName(operation);
    if (!(root in data(zeroArgumentResult.details))) throw new Error(`smoke.runtime: ${operation.name} root is missing`);
    const result = await executeTool(compatibility, { operation: operation.name, variables: { first: 1 }, sink: 'inline' });
    assertNoCredentialLeak(result, apiKey);
    const page = connection(result.details, root);
    listResults.set(operation.name, { nodes: page.nodes, root });
    if (page.pageInfo.hasNextPage) {
      if (!page.pageInfo.endCursor) throw new Error(`smoke.pagination: ${operation.name} hasNextPage without endCursor`);
      const next = await executeTool(compatibility, {
        operation: operation.name, variables: { first: 1, after: page.pageInfo.endCursor }, sink: 'inline',
      });
      assertNoCredentialLeak(next, apiKey);
      connection(next.details, root);
      followedCursors++;
    }
  }

  const pairResults: Array<{ list: string; get?: string; status: string }> = [];
  for (const list of ZERO_ARGUMENT_READS) {
    const pair = LIST_GET[list];
    const listed = listResults.get(list)!;
    if (!pair) {
      pairResults.push({ list, status: 'skipped:no valid get input exists' });
      continue;
    }
    const first = listed.nodes[0];
    if (!first || typeof first !== 'object' || Array.isArray(first)) {
      pairResults.push({ list, get: pair.get, status: 'skipped:list empty' });
      continue;
    }
    const id = (first as JsonObject).id;
    if (typeof id !== 'string' || !id) {
      pairResults.push({ list, get: pair.get, status: 'skipped:no valid get input exists' });
      continue;
    }
    const got = await executeTool(compatibility, {
      operation: pair.get, variables: { [pair.parameter]: id }, sink: 'inline',
    });
    assertNoCredentialLeak(got, apiKey);
    if (entityId(got.details, pair.root) !== id) throw new Error(`smoke.identity: ${list} to ${pair.get} identity differed`);
    pairResults.push({ list, get: pair.get, status: 'passed' });
  }

  let missingMessage = '';
  try {
    await executeTool(compatibility, {
      operation: 'get_issue', variables: { issue: MISSING_ISSUE_ID }, sink: 'inline',
    });
  } catch (error) {
    missingMessage = error instanceof Error ? error.message : String(error);
  }
  const expectedMissing = [
    `Linear issue "${MISSING_ISSUE_ID}" was not found.`,
    'Linear GraphQL error: Could not find referenced Issue.',
  ];
  if (!expectedMissing.includes(missingMessage)) {
    throw new Error(`smoke.missing-reference: expected one of ${JSON.stringify(expectedMissing)}, actual ${JSON.stringify(redactText(missingMessage, [apiKey]))}`);
  }

  const originalFetch = globalThis.fetch;
  let mutationRequests = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? init.body : '';
    if (/\bmutation\b/.test(body)) mutationRequests++;
    return originalFetch(input, init);
  }) as typeof fetch;
  let rejectionMessage = '';
  try {
    await executeTool(compatibility, {
      operation: 'create_comment', variables: { issue: ISSUE_REFERENCE, body: 'must not execute' },
    });
  } catch (error) {
    rejectionMessage = error instanceof Error ? error.message : String(error);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const expectedRejection = 'Linear mutations are disabled by read-only mode.';
  if (rejectionMessage !== expectedRejection) {
    throw new Error(`smoke.readonly: expected ${JSON.stringify(expectedRejection)}, actual ${JSON.stringify(redactText(rejectionMessage, [apiKey]))}`);
  }
  if (mutationRequests !== 0) throw new Error(`smoke.readonly: observed ${mutationRequests} mutation requests`);

  assertNoCredentialLeak({ pairResults, knownTokenProbe: redactText(KNOWN_TOKEN, [apiKey]) }, apiKey);
  const summary = {
    status: 'pass',
    schema: {
      queryRoots: scope.roots.Query.length,
      mutationRoots: scope.roots.Mutation.length,
      inputTypes: Object.keys(fixture.inputs).length,
      enums: Object.keys(fixture.enums).length,
      namedObjects: Object.keys(fixture.objects).length,
      digest: fixture.provenance.normalizedSha256,
    },
    runtime: {
      activation: 'passed',
      zeroArgumentReads: ZERO_ARGUMENT_READS.length,
      followedCursors,
      listGet: pairResults,
      getIssueIdentity: 'passed',
      missingReference: 'passed',
      mutationRequests,
      redaction: 'passed',
    },
  };
  await writeSummary(summary, apiKey);
  return summary;
}

function safeFailure(message: string, apiKey: string): string {
  const redacted = redactText(message, [apiKey]);
  return /^(?:schema|catalog|fixture|smoke)\./.test(redacted)
    ? redacted
    : 'smoke.runtime: authenticated read-only probe failed safely';
}

export async function runReadonlySmoke(): Promise<JsonObject> {
  if (process.env.LINEAR_READONLY !== '1') throw new Error('smoke.readonly: LINEAR_READONLY=1 is required before authentication or network access');
  const apiKey = await smokeApiKey();
  const previousApiKey = process.env.LINEAR_API_KEY;
  process.env.LINEAR_API_KEY = apiKey;
  try {
    return await runAuthenticatedSmoke(apiKey);
  } catch (error) {
    throw new Error(safeFailure(error instanceof Error ? error.message : String(error), apiKey));
  } finally {
    if (previousApiKey === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = previousApiKey;
  }
}

try {
  const summary = await runReadonlySmoke();
  process.stdout.write(`READONLY SMOKE PASS: ${JSON.stringify(summary)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`READONLY SMOKE FAIL: ${redactText(message)}\n`);
  process.exitCode = 1;
}
