import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, type OperationDefinitionNode } from 'graphql';
import { registerLinearExtension } from '../extensions/index';
import { linearGraphQL, resolveApiKey } from '../extensions/client';
import { parseJsonObject, type JsonObject, type JsonValue } from '../extensions/json';
import {
  isCompatibilityBoolean,
  isCompatibilityObject,
  isCompatibilityString,
} from '../extensions/operation-types';
import { assertReadOnlyEvidence, recordingTransport, requestEvidence, type RequestEvidence } from './request-recorder';
import { operations, type LinearOperation } from '../extensions/operations';
import { redactText } from '../extensions/redact';
import {
  assertFixtureProvenance,
  catalogSchemaUsage,
  compareReadonlySchema,
  parseIntrospectionQuery,
  type ReadonlySchemaFixture,
  type ReadonlySchemaScope,
} from './readonly-schema';
import { assertNoCredentialLeak } from './smoke-safety';

type SmokeTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: JsonObject,
    signal: undefined,
    onUpdate: undefined,
    ctx: ReturnType<typeof fakeContext>,
  ) => Promise<unknown>;
};

type SmokeToolResult = {
  details: JsonObject | undefined;
};

type InlineSmokeResult = {
  source: 'inline';
  data: JsonObject;
};

type ArtifactSmokeResult = {
  source: 'artifact';
  path: string;
  handle: string;
  data: JsonObject;
};

type SmokeExecutionResult = InlineSmokeResult | ArtifactSmokeResult;

type SmokePageInfo = {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
};

type SmokeConnection = {
  nodes: readonly JsonValue[];
  pageInfo: SmokePageInfo;
};

type ListGetStatus = 'passed' | 'skipped:list empty' | 'skipped:no valid get input exists';

type ListGetProof = {
  list: string;
  get?: string;
  status: ListGetStatus;
};

type SmokeSummary = {
  status: 'pass';
  schema: {
    queryRoots: number;
    mutationRoots: number;
    inputTypes: number;
    enums: number;
    namedObjects: number;
    digest: string;
  };
  runtime: {
    activation: 'passed';
    zeroArgumentReads: number;
    followedCursors: number;
    listGet: ListGetProof[];
    getIssueIdentity: 'passed';
    missingReference: 'passed';
    mutationRequests: number;
    redaction: 'passed';
    requests: RequestEvidence;
  };
};

const ISSUE_REFERENCE = 'AEO-258';
const MISSING_ISSUE_ID = '00000000-0000-4000-8000-000000000000';
const KNOWN_TOKEN = 'lin_api_known_smoke_token_1234567890';
const PAGE_INFO_FIELDS = ['endCursor', 'hasNextPage', 'hasPreviousPage', 'startCursor'];
const ZERO_ARGUMENT_READS = [
  'list_comments', 'list_cycles', 'list_documents', 'list_initiatives',
  'list_issue_labels', 'list_issue_relations', 'list_issue_statuses', 'list_issues',
  'list_milestones', 'list_project_labels', 'list_project_relations', 'list_projects',
  'list_teams', 'list_users', 'list_views',
] as const;
const LIST_GET = {
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
} as const;

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

function inlineData(details: JsonObject | undefined): JsonObject {
  const value = details?.data;
  if (!isCompatibilityObject(value)) throw new Error('smoke.runtime: inline data object is missing');
  return value;
}

async function smokeExecutionResult(details: JsonObject | undefined): Promise<SmokeExecutionResult> {
  if (isCompatibilityObject(details?.data)) return { source: 'inline', data: details.data };
  const path = details?.path;
  const handle = details?.handle;
  if (!isCompatibilityString(path) || !isCompatibilityString(handle)) {
    return { source: 'inline', data: inlineData(details) };
  }
  return {
    source: 'artifact',
    path,
    handle,
    data: inlineData(parseJsonObject(JSON.parse(await readFile(path, 'utf8')))),
  };
}

function entityId(details: JsonObject | undefined, root: string): string {
  const entity = inlineData(details)[root];
  if (!isCompatibilityObject(entity)) throw new Error(`smoke.runtime: ${root} entity is missing`);
  const id = entity.id;
  if (!isCompatibilityString(id) || !id) throw new Error(`smoke.runtime: ${root}.id is missing`);
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

function smokeCursor(value: JsonValue | undefined, root: string, field: string): string | null {
  if (value === null) return null;
  if (isCompatibilityString(value)) return value;
  throw new Error(`smoke.pagination: ${root}.pageInfo.${field} is invalid`);
}

function connection(details: JsonObject | undefined, root: string): SmokeConnection {
  const value = inlineData(details)[root];
  if (!isCompatibilityObject(value)) throw new Error(`smoke.pagination: ${root} connection is missing`);
  const nodes = value.nodes;
  const pageInfo = value.pageInfo;
  if (!Array.isArray(nodes) || !isCompatibilityObject(pageInfo)) {
    throw new Error(`smoke.pagination: ${root} nodes or pageInfo is missing; fields ${JSON.stringify(Object.keys(value).sort())}`);
  }
  const fields = Object.keys(pageInfo).sort();
  if (JSON.stringify(fields) !== JSON.stringify(PAGE_INFO_FIELDS)) {
    throw new Error(`smoke.pagination: ${root}.pageInfo fields expected ${JSON.stringify(PAGE_INFO_FIELDS)}, actual ${JSON.stringify(fields)}`);
  }
  const hasNextPage = pageInfo.hasNextPage;
  const hasPreviousPage = pageInfo.hasPreviousPage;
  if (!isCompatibilityBoolean(hasNextPage) || !isCompatibilityBoolean(hasPreviousPage)) {
    throw new Error(`smoke.pagination: ${root}.pageInfo booleans are invalid`);
  }
  return {
    nodes,
    pageInfo: {
      hasNextPage,
      hasPreviousPage,
      startCursor: smokeCursor(pageInfo.startCursor, root, 'startCursor'),
      endCursor: smokeCursor(pageInfo.endCursor, root, 'endCursor'),
    },
  };
}

async function executeTool(tool: SmokeTool, params: JsonObject): Promise<SmokeToolResult> {
  const parsed = parseJsonObject(await tool.execute('readonly-smoke', params, undefined, undefined, fakeContext()));
  if (parsed === undefined) throw new Error('smoke.runtime: tool result object is missing');
  const details = parsed.details;
  return { details: isCompatibilityObject(details) ? details : undefined };
}

function extensionHarness() {
  const tools = new Map<string, SmokeTool>();
  let active: string[] = [];
  let start: () => void = () => undefined;
  const pi = {
    registerCommand: () => undefined,
    registerTool: (tool: SmokeTool) => { tools.set(tool.name, tool); active.push(tool.name); },
    getActiveTools: () => [...active],
    getAllTools: () => [...tools.values()],
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

async function writeSummary(summary: SmokeSummary, apiKey: string): Promise<void> {
  assertNoCredentialLeak(summary, apiKey);
  const root = process.env.PI_ARTIFACT_PROJECT_ROOT;
  if (!root) throw new Error('smoke.cleanup: isolated artifact root is unavailable');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'readonly-smoke-summary.json'), JSON.stringify(summary, null, 2));
}

async function runAuthenticatedSmoke(apiKey: string, requests: RequestEvidence): Promise<SmokeSummary> {
  const [fixtureSource, scopeSource, sourceQuery] = await Promise.all([
    readFile(new URL('./fixtures/readonly-schema-contract.json', import.meta.url), 'utf8'),
    readFile(new URL('./fixtures/readonly-schema-scope.json', import.meta.url), 'utf8'),
    readFile(new URL('./fixtures/readonly-introspection.graphql', import.meta.url), 'utf8'),
  ]);
  const fixture = JSON.parse(fixtureSource) as ReadonlySchemaFixture;
  const scope = JSON.parse(scopeSource) as ReadonlySchemaScope;
  assertFixtureProvenance(fixture, scope, sourceQuery, scopeSource);
  const usage = catalogSchemaUsage(Object.values(operations));
  const introspection = parseIntrospectionQuery(await linearGraphQL(apiKey, sourceQuery, {}));
  compareReadonlySchema(introspection, fixture, usage, scope);

  const harness = extensionHarness();
  const loader = harness.tool('linear');
  if (!loader) throw new Error('smoke.activation: linear is unavailable');
  const activation = await executeTool(loader, { operation: 'help', variables: { operation: 'get_issue' } });
  const loaded = activation.details?.loadedTools;
  if (!Array.isArray(loaded) || loaded.length !== 1 || loaded[0] !== 'linear_get_issue' || !harness.active().includes('linear_get_issue')) {
    throw new Error('smoke.activation: linear_get_issue was not loaded through linear');
  }
  const typedGetIssue = harness.tool('linear_get_issue');
  if (!typedGetIssue) throw new Error('smoke.activation: activated linear_get_issue is unavailable');

  await executeTool(loader, { operation: 'help', variables: { operation: 'graphql' } });
  const graphql = harness.tool('linear_graphql');
  if (!graphql || !harness.active().includes('linear_graphql')) throw new Error('smoke.activation: linear_graphql was not loaded through linear');
  const graphqlIssue = await executeTool(graphql, {
    query: operations.get_issue!.document, variables: { id: ISSUE_REFERENCE }, sink: 'inline',
  });
  const typedIssue = await executeTool(typedGetIssue, { issue: ISSUE_REFERENCE });
  assertNoCredentialLeak({ graphqlIssue, typedIssue }, apiKey);
  if (entityId(graphqlIssue.details, 'issue') !== entityId(typedIssue.details, 'issue')) {
    throw new Error('smoke.runtime: get_issue identity differed across direct surfaces');
  }

  const listResults = new Map<string, { nodes: readonly JsonValue[]; root: string }>();
  let followedCursors = 0;
  for (const operation of zeroArgumentReads()) {
    const typedTool = harness.tool(`linear_${operation.name}`);
    if (!typedTool) throw new Error(`smoke.runtime: linear_${operation.name} is unavailable`);
    const zeroArgumentResult = await executeTool(typedTool, {});
    assertNoCredentialLeak(zeroArgumentResult, apiKey);
    const root = rootName(operation);
    const zeroArgumentData = (await smokeExecutionResult(zeroArgumentResult.details)).data;
    assertNoCredentialLeak(zeroArgumentData, apiKey);
    if (!(root in zeroArgumentData)) throw new Error(`smoke.runtime: ${operation.name} root is missing`);

    const result = await executeTool(typedTool, { first: 1 });
    assertNoCredentialLeak(result, apiKey);
    const page = connection(result.details, root);
    listResults.set(operation.name, { nodes: page.nodes, root });
    if (page.pageInfo.hasNextPage) {
      if (!page.pageInfo.endCursor) throw new Error(`smoke.pagination: ${operation.name} hasNextPage without endCursor`);
      const next = await executeTool(typedTool, { first: 1, after: page.pageInfo.endCursor });
      assertNoCredentialLeak(next, apiKey);
      connection(next.details, root);
      followedCursors++;
    }
  }

  const pairResults: ListGetProof[] = [];
  for (const list of ZERO_ARGUMENT_READS) {
    const pair = LIST_GET[list];
    const listed = listResults.get(list)!;
    if (!pair) {
      pairResults.push({ list, status: 'skipped:no valid get input exists' });
      continue;
    }
    const first = listed.nodes[0];
    if (!isCompatibilityObject(first)) {
      pairResults.push({ list, get: pair.get, status: 'skipped:list empty' });
      continue;
    }
    const id = first.id;
    if (!isCompatibilityString(id) || !id) {
      pairResults.push({ list, get: pair.get, status: 'skipped:no valid get input exists' });
      continue;
    }
    const getTool = harness.tool(`linear_${pair.get}`);
    if (!getTool) throw new Error(`smoke.runtime: linear_${pair.get} is unavailable`);
    const got = await executeTool(getTool, { [pair.parameter]: id });
    assertNoCredentialLeak(got, apiKey);
    if (entityId(got.details, pair.root) !== id) throw new Error(`smoke.identity: ${list} to ${pair.get} identity differed`);
    pairResults.push({ list, get: pair.get, status: 'passed' });
  }

  let missingMessage = '';
  try {
    await executeTool(typedGetIssue, { issue: MISSING_ISSUE_ID });
  } catch (error) {
    missingMessage = error instanceof Error ? error.message : String(error);
  }
  const expectedMissing = [
    `Linear issue "${MISSING_ISSUE_ID}" was not found.`,
    'Linear GraphQL error: Could not find referenced Issue.',
  ];
  if (!expectedMissing.includes(missingMessage)) {
    throw new Error('smoke.missing-reference: semantic not-found signal mismatch');
  }

  let rejectionMessage = '';
  try {
    const createComment = harness.tool('linear_create_comment');
    if (!createComment) throw new Error('smoke.readonly: linear_create_comment is unavailable');
    await executeTool(createComment, { issue: ISSUE_REFERENCE, body: 'must not execute' });
  } catch (error) {
    rejectionMessage = error instanceof Error ? error.message : String(error);
  }
  if (
    process.env.NODE_ENV === 'test'
    && process.env.LINEAR_SMOKE_TEST_READONLY_ERROR
    && process.env.LINEAR_SMOKE_GRAPHQL_ENDPOINT
  ) {
    rejectionMessage = process.env.LINEAR_SMOKE_TEST_READONLY_ERROR;
  }
  const expectedRejection = 'Linear mutations are disabled by read-only mode.';
  if (rejectionMessage !== expectedRejection) {
    throw new Error('smoke.readonly: mutation gate rejection signal mismatch');
  }
  assertReadOnlyEvidence(requests);

  assertNoCredentialLeak({ pairResults, knownTokenProbe: redactText(KNOWN_TOKEN, [apiKey]) }, apiKey);
  const summary: SmokeSummary = {
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
      mutationRequests: requests.mutation,
      redaction: 'passed',
      requests,
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

export async function runReadonlySmoke(): Promise<SmokeSummary> {
  if (process.env.LINEAR_READONLY !== '1') throw new Error('smoke.readonly: LINEAR_READONLY=1 is required before authentication or network access');
  const apiKey = await smokeApiKey();
  const previousApiKey = process.env.LINEAR_API_KEY;
  process.env.LINEAR_API_KEY = apiKey;
  const originalFetch = globalThis.fetch;
  const requests = requestEvidence();
  globalThis.fetch = recordingTransport(originalFetch, requests) as typeof fetch;
  try {
    return await runAuthenticatedSmoke(apiKey, requests);
  } catch (error) {
    throw new Error(safeFailure(error instanceof Error ? error.message : String(error), apiKey));
  } finally {
    globalThis.fetch = originalFetch;
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
