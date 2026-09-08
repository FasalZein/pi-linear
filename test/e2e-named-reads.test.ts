import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, type DocumentNode, type FieldNode, type OperationDefinitionNode } from 'graphql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerLinearExtension } from '../extensions/index';
import manifest from '../extensions/generated/linear-tools.manifest.json';
import { operationDefinitions } from '../extensions/operations';
import type { JsonObject } from '../extensions/json';
import { validateToolArguments } from '../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/validation.js';

const FAKE_TOKEN = 'lin_api_fixture_named_reads_never_real';
const UUID = '11111111-1111-4111-8111-111111111111';
const ENTITY_ID = '22222222-2222-4222-8222-222222222222';
const ISSUE_ID = '33333333-3333-4333-8333-333333333333';
const TEAM_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '55555555-5555-4555-8555-555555555555';

type Tool = {
  name: string;
  parameters: unknown;
  prepareArguments?: (args: JsonObject) => JsonObject;
  execute: (
    id: string,
    params: JsonObject,
    signal: AbortSignal | undefined,
    update: undefined,
    context: { hasUI: boolean },
  ) => Promise<{ details: JsonObject }>;
};

type CapturedRequest = {
  query: string;
  variables: JsonObject;
  operationName: string;
  operationType: 'query' | 'mutation' | 'subscription';
  rootFields: string[];
  authorization: string | undefined;
};

type NamedReadCase = {
  name: string;
  tool: string;
  args: JsonObject;
  finalOperation: string;
  finalVariables: JsonObject;
  root: string;
};

const expectedReadNames = [
  'list_comments',
  'list_views',
  'get_view',
  'list_cycles',
  'get_cycle',
  'list_documents',
  'get_document',
  'list_initiatives',
  'get_initiative',
  'list_issue_labels',
  'list_issue_relations',
  'list_issue_statuses',
  'list_issues',
  'get_issue',
  'search_issues',
  'list_milestones',
  'get_milestone',
  'list_project_labels',
  'list_project_relations',
  'list_projects',
  'get_project',
  'list_teams',
  'get_team',
  'list_users',
  'get_user',
] as const;

const readCases: readonly NamedReadCase[] = [
  {
    name: 'list_comments', tool: 'linear_list_comments', args: { issue: 'AEO-258' },
    finalOperation: 'ListComments', finalVariables: { first: 20, filter: { issue: { id: { eq: ISSUE_ID } } } }, root: 'comments',
  },
  { name: 'list_views', tool: 'linear_list_views', args: {}, finalOperation: 'ListViews', finalVariables: { first: 50 }, root: 'customViews' },
  { name: 'get_view', tool: 'linear_get_view', args: { id: 'view-id' }, finalOperation: 'GetView', finalVariables: { id: 'view-id' }, root: 'customView' },
  { name: 'list_cycles', tool: 'linear_list_cycles', args: {}, finalOperation: 'ListCycles', finalVariables: { first: 50 }, root: 'cycles' },
  { name: 'get_cycle', tool: 'linear_get_cycle', args: { cycle: 'Cycle 12' }, finalOperation: 'GetCycle', finalVariables: { id: ENTITY_ID }, root: 'cycle' },
  { name: 'list_documents', tool: 'linear_list_documents', args: {}, finalOperation: 'ListDocuments', finalVariables: { first: 20 }, root: 'documents' },
  { name: 'get_document', tool: 'linear_get_document', args: { document: 'Planning notes' }, finalOperation: 'GetDocument', finalVariables: { id: ENTITY_ID }, root: 'document' },
  { name: 'list_initiatives', tool: 'linear_list_initiatives', args: {}, finalOperation: 'ListInitiatives', finalVariables: { first: 20 }, root: 'initiatives' },
  { name: 'get_initiative', tool: 'linear_get_initiative', args: { initiative: 'Platform' }, finalOperation: 'GetInitiative', finalVariables: { id: ENTITY_ID }, root: 'initiative' },
  { name: 'list_issue_labels', tool: 'linear_list_issue_labels', args: {}, finalOperation: 'ListIssueLabels', finalVariables: { first: 50 }, root: 'issueLabels' },
  { name: 'list_issue_relations', tool: 'linear_list_issue_relations', args: {}, finalOperation: 'ListIssueRelations', finalVariables: { first: 20 }, root: 'issueRelations' },
  { name: 'list_issue_statuses', tool: 'linear_list_issue_statuses', args: {}, finalOperation: 'ListIssueStatuses', finalVariables: { first: 50 }, root: 'workflowStates' },
  {
    name: 'list_issues', tool: 'linear_list_issues', args: { assignee: 'me', stateType: 'started' },
    finalOperation: 'ListIssues',
    finalVariables: { first: 20, filter: { state: { type: { eq: 'started' } }, assignee: { id: { eq: USER_ID } } } },
    root: 'issues',
  },
  { name: 'get_issue', tool: 'linear_get_issue', args: { issue: 'AEO-258' }, finalOperation: 'GetIssue', finalVariables: { id: 'AEO-258' }, root: 'issue' },
  { name: 'search_issues', tool: 'linear_search_issues', args: { term: 'authentication' }, finalOperation: 'SearchIssues', finalVariables: { first: 20, term: 'authentication' }, root: 'searchIssues' },
  { name: 'list_milestones', tool: 'linear_list_milestones', args: {}, finalOperation: 'ListMilestones', finalVariables: { first: 20 }, root: 'projectMilestones' },
  { name: 'get_milestone', tool: 'linear_get_milestone', args: { milestone: 'Beta' }, finalOperation: 'GetMilestone', finalVariables: { id: ENTITY_ID }, root: 'projectMilestone' },
  { name: 'list_project_labels', tool: 'linear_list_project_labels', args: {}, finalOperation: 'ListProjectLabels', finalVariables: { first: 50 }, root: 'projectLabels' },
  { name: 'list_project_relations', tool: 'linear_list_project_relations', args: {}, finalOperation: 'ListProjectRelations', finalVariables: { first: 20 }, root: 'projectRelations' },
  { name: 'list_projects', tool: 'linear_list_projects', args: {}, finalOperation: 'ListProjects', finalVariables: { first: 20 }, root: 'projects' },
  { name: 'get_project', tool: 'linear_get_project', args: { project: 'Platform' }, finalOperation: 'GetProject', finalVariables: { id: ENTITY_ID }, root: 'project' },
  { name: 'list_teams', tool: 'linear_list_teams', args: {}, finalOperation: 'ListTeams', finalVariables: { first: 50 }, root: 'teams' },
  { name: 'get_team', tool: 'linear_get_team', args: { team: 'AEO' }, finalOperation: 'GetTeam', finalVariables: { id: TEAM_ID }, root: 'team' },
  { name: 'list_users', tool: 'linear_list_users', args: {}, finalOperation: 'ListUsers', finalVariables: { first: 50 }, root: 'users' },
  { name: 'get_user', tool: 'linear_get_user', args: { user: 'me' }, finalOperation: 'GetUser', finalVariables: { id: USER_ID }, root: 'user' },
];

const listCases = readCases.filter(({ name }) => name.startsWith('list_') || name === 'search_issues');
const defaultPageSizes = new Map(listCases
  .map(({ name, finalVariables }) => [name, Number(finalVariables.first)]));

const originalEnvironment = { ...process.env };
let agentDirectory = '';
let endpoint = '';
let failRequests = false;
let requests: CapturedRequest[] = [];
let closeServer: (() => Promise<void>) | undefined;
let harness: ReturnType<typeof extensionApiHarness>;

function operation(document: DocumentNode): OperationDefinitionNode {
  const definition = document.definitions.find((entry): entry is OperationDefinitionNode => entry.kind === 'OperationDefinition');
  if (!definition) throw new Error('Fixture received no GraphQL operation.');
  return definition;
}

function capturedRequest(query: string, variables: JsonObject, authorization: string | undefined): CapturedRequest {
  const definition = operation(parse(query));
  return {
    query,
    variables,
    operationName: definition.name?.value ?? '',
    operationType: definition.operation,
    rootFields: definition.selectionSet.selections
      .filter((selection): selection is FieldNode => selection.kind === 'Field')
      .map((field) => field.alias?.value ?? field.name.value),
    authorization,
  };
}

function entityName(root: string): string {
  switch (root) {
    case 'cycle': return 'Cycle 12';
    case 'document': return 'Planning notes';
    case 'initiative': return 'Platform';
    case 'projectMilestone': return 'Beta';
    case 'project': return 'Platform';
    case 'team': return 'AEO';
    case 'user': return 'Ada Lovelace';
    default: return `${root} fixture`;
  }
}

function entityFor(root: string, variables: JsonObject): JsonObject {
  const requestedId = String(variables.id ?? ENTITY_ID);
  const id = requestedId === 'AEO-258' ? ISSUE_ID : requestedId;
  return {
    id,
    identifier: requestedId === UUID ? 'AEO-258' : requestedId === 'AEO-258' ? 'AEO-258' : undefined,
    key: root === 'team' ? 'AEO' : undefined,
    name: entityName(root),
    title: root === 'document' ? 'Planning notes' : `${root} fixture`,
    email: root === 'user' ? 'ada@example.com' : undefined,
  };
}

function fixtureData(request: CapturedRequest): JsonObject {
  const { operationName, variables } = request;
  if (operationName === 'ResolveIssueById') {
    return { issue: { id: ISSUE_ID, identifier: String(variables.id), team: { id: TEAM_ID, key: 'AEO' } } };
  }
  if (operationName === 'ResolveViewer') {
    return { viewer: { id: USER_ID, name: 'Ada Lovelace', displayName: 'Ada', email: 'ada@example.com' } };
  }
  if (operationName === 'ResolveUserById') {
    return { user: { id: variables.id, name: 'Ada Lovelace', displayName: 'Ada', email: 'ada@example.com' } };
  }
  if (operationName === 'ResolveUserByIdentity') {
    const user = { id: USER_ID, name: variables.reference, displayName: 'Ada', email: 'ada@example.com' };
    return { byEmail: { nodes: [] }, byName: { nodes: [user] }, byDisplayName: { nodes: [] } };
  }
  if (operationName === 'ResolveTeamByKey') {
    return { teams: { nodes: [{ id: TEAM_ID, key: String(variables.key) }] } };
  }
  if (operationName === 'ResolveTeamById') {
    return { team: { id: variables.id, key: 'AEO' } };
  }
  if (operationName === 'ResolveNamedEntityByName') {
    const root = request.rootFields[0]!;
    return { [root]: { nodes: [{ id: ENTITY_ID, name: variables.name }] } };
  }
  if (operationName === 'ResolveNamedEntityById') {
    const root = request.rootFields[0]!;
    return { [root]: { id: variables.id, name: `${root} fixture` } };
  }

  const root = request.rootFields[0]!;
  if (operationName.startsWith('List') || operationName === 'SearchIssues') {
    return {
      [root]: {
        nodes: [entityFor(root.replace(/s$/, ''), variables)],
        pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: 'start', endCursor: 'end' },
        totalCount: 1,
      },
    };
  }
  return { [root]: entityFor(root, variables) };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function startFixtureServer(): Promise<{ endpoint: string; close: () => Promise<void> }> {
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    try {
      if (request.method !== 'POST' || request.url !== '/graphql') {
        response.writeHead(404).end();
        return;
      }
      const body = JSON.parse(await readBody(request)) as { query: string; variables?: JsonObject };
      const captured = capturedRequest(body.query, body.variables ?? {}, request.headers.authorization);
      requests.push(captured);
      if (failRequests) {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ errors: [{ message: `fixture rejected ${captured.operationName}` }] }));
        return;
      }
      response.writeHead(200, {
        'content-type': 'application/json',
        'x-ratelimit-requests-limit': '1000',
        'x-ratelimit-requests-remaining': '999',
      });
      response.end(JSON.stringify({ data: fixtureData(captured) }));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ errors: [{ message: error instanceof Error ? error.message : String(error) }] }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number } | null)?.port;
  if (!port) throw new Error('Fixture server has no TCP address.');
  return {
    endpoint: `http://127.0.0.1:${port}/graphql`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function extensionApiHarness() {
  const tools = new Map<string, Tool>();
  const sessionStartHandlers: Array<() => void> = [];
  let active: string[] = [];
  const pi = {
    registerCommand: () => undefined,
    registerTool: (tool: Tool) => {
      tools.set(tool.name, tool);
      active.push(tool.name);
    },
    getAllTools: () => [...tools.values()].map(({ name, parameters }) => ({ name, parameters })),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active = [...names]; },
    on: (event: string, handler: () => void) => {
      if (event === 'session_start') sessionStartHandlers.push(handler);
    },
  };
  registerLinearExtension(pi as never, 'allowlist');
  for (const handler of sessionStartHandlers) handler();
  return {
    tool(name: string): Tool {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool ${name} was not registered.`);
      return tool;
    },
    activeTools: () => [...active],
  };
}

function prepareAndValidate(tool: Tool, raw: JsonObject): JsonObject {
  const prepared = tool.prepareArguments ? tool.prepareArguments(raw) : raw;
  return validateToolArguments(
    tool as never,
    { id: 'fixture-call', name: tool.name, arguments: prepared } as never,
  ) as JsonObject;
}

async function invoke(tool: Tool, raw: JsonObject): Promise<{ details: JsonObject }> {
  return tool.execute('fixture-call', prepareAndValidate(tool, raw), undefined, undefined, { hasUI: false });
}

async function activate(operationName: string, expectedToolName: string): Promise<void> {
  const loader = harness.tool('linear');
  await invoke(loader, { operation: 'help', variables: { operation: operationName } });
  expect(harness.activeTools()).toContain(expectedToolName);
}

function finalRequest(since: number, operationName: string): CapturedRequest {
  const matches = requests.slice(since).filter((request) => request.operationName === operationName);
  expect(matches, `final request for ${operationName}`).toHaveLength(1);
  return matches[0]!;
}

function expectedDocuments(name: string): string[] {
  const definition = operationDefinitions.find((candidate) => candidate.name === name)!;
  return definition.graphql?.documents.map(({ document }) => document) ?? [];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

beforeAll(async () => {
  const server = await startFixtureServer();
  endpoint = server.endpoint;
  closeServer = server.close;
});

beforeEach(async () => {
  agentDirectory = await mkdtemp(join(tmpdir(), 'pi-linear-e2e-named-reads-'));
  process.env.PI_CODING_AGENT_DIR = agentDirectory;
  process.env.LINEAR_API_KEY = FAKE_TOKEN;
  process.env.LINEAR_READONLY = '1';
  process.env.LINEAR_SMOKE_GRAPHQL_ENDPOINT = endpoint;
  requests = [];
  failRequests = false;
  harness = extensionApiHarness();
});

afterEach(async () => {
  process.env = { ...originalEnvironment };
  await rm(agentDirectory, { recursive: true, force: true });
});

afterAll(async () => {
  await closeServer?.();
});

describe('named read tools through extension activation and the real HTTP client', () => {
  it('derives and covers the complete non-mutating named operation inventory', () => {
    const actual = operationDefinitions
      .filter((definition) => definition.kind === 'query' && definition.safety.mutation === false)
      .map(({ name }) => name);
    expect(actual).toEqual(expectedReadNames);
    expect(readCases.map(({ name }) => name)).toEqual(actual);
    expect(new Set(readCases.map(({ tool }) => tool)).size).toBe(25);
    expect(manifest.lazyTools
      .filter(({ operation }) => actual.includes(operation as typeof actual[number]))
      .map(({ name }) => name)).toEqual(readCases.map(({ tool }) => tool));
    expect(operationDefinitions.filter((definition) => definition.safety.mutation === true)).toHaveLength(23);
    expect(operationDefinitions.filter((definition) => definition.kind === 'local').map(({ name }) => name)).toEqual(['switch_workspace']);
    expect(manifest.lazyTools.find(({ operation }) => operation === 'switch_workspace')?.name).toBe('linear_switch_workspace');
  });

  it('activates and executes every exact read tool against the loopback GraphQL server', async () => {
    for (const testCase of readCases) {
      await activate(testCase.name, testCase.tool);
      const start = requests.length;
      const result = await invoke(harness.tool(testCase.tool), testCase.args);
      const final = finalRequest(start, testCase.finalOperation);

      expect(final.operationType, testCase.name).toBe('query');
      expect(final.authorization, testCase.name).toBe(FAKE_TOKEN);
      expect(final.variables, testCase.name).toEqual(testCase.finalVariables);
      expect(expectedDocuments(testCase.name), testCase.name).toContain(final.query);
      expect(final.query, testCase.name).not.toMatch(/\bmutation\b/);
      expect(result.details.data, testCase.name).toHaveProperty(testCase.root);
    }

    expect(requests.every(({ operationType }) => operationType === 'query')).toBe(true);
    expect(requests.some(({ query }) => /\bmutation\b/.test(query))).toBe(false);
    expect(await pathExists(join(agentDirectory, 'extensions', 'linear', 'credentials.json'))).toBe(false);
  });

  it('preserves defaults and supports advanced backward pagination for every paginated read', async () => {
    expect(listCases).toHaveLength(16);
    for (const testCase of listCases) {
      await activate(testCase.name, testCase.tool);
      const args: JsonObject = testCase.name === 'search_issues'
        ? { term: 'authentication', before: 'backward-cursor', last: 3, orderBy: 'updatedAt' }
        : { before: 'backward-cursor', last: 3, orderBy: 'updatedAt' };
      const start = requests.length;
      await invoke(harness.tool(testCase.tool), args);
      const final = finalRequest(start, testCase.finalOperation);
      expect(final.variables.before, testCase.name).toBe('backward-cursor');
      expect(final.variables.last, testCase.name).toBe(3);
      expect(final.variables.orderBy, testCase.name).toBe('updatedAt');
      expect(final.variables, testCase.name).not.toHaveProperty('first');
      expect(defaultPageSizes.get(testCase.name), testCase.name).toBe(testCase.finalVariables.first);
    }
  });

  it('resolves exact names, identity aliases, issue references, and UUIDs without changing the requested identity', async () => {
    const variants: Array<{ name: string; tool: string; args: JsonObject; operation: string; expectedId: string; root: string }> = [
      { name: 'get_issue', tool: 'linear_get_issue', args: { issue: UUID }, operation: 'GetIssue', expectedId: UUID, root: 'issue' },
      { name: 'get_cycle', tool: 'linear_get_cycle', args: { cycle: UUID }, operation: 'GetCycle', expectedId: UUID, root: 'cycle' },
      { name: 'get_document', tool: 'linear_get_document', args: { document: UUID }, operation: 'GetDocument', expectedId: UUID, root: 'document' },
      { name: 'get_initiative', tool: 'linear_get_initiative', args: { initiative: UUID }, operation: 'GetInitiative', expectedId: UUID, root: 'initiative' },
      { name: 'get_milestone', tool: 'linear_get_milestone', args: { milestone: UUID }, operation: 'GetMilestone', expectedId: UUID, root: 'projectMilestone' },
      { name: 'get_project', tool: 'linear_get_project', args: { project: UUID }, operation: 'GetProject', expectedId: UUID, root: 'project' },
      { name: 'get_team', tool: 'linear_get_team', args: { team: UUID }, operation: 'GetTeam', expectedId: UUID, root: 'team' },
      { name: 'get_user', tool: 'linear_get_user', args: { user: UUID }, operation: 'GetUser', expectedId: UUID, root: 'user' },
      { name: 'get_user', tool: 'linear_get_user', args: { user: 'Ada Lovelace' }, operation: 'GetUser', expectedId: USER_ID, root: 'user' },
    ];

    for (const variant of variants) {
      await activate(variant.name, variant.tool);
      const start = requests.length;
      const result = await invoke(harness.tool(variant.tool), variant.args);
      expect(finalRequest(start, variant.operation).variables).toEqual({ id: variant.expectedId });
      expect((result.details.data as JsonObject)[variant.root]).toMatchObject({ id: variant.expectedId });
    }
  });

  it('surfaces a transport failure for every read tool and sends no mutation document', async () => {
    failRequests = true;
    for (const testCase of readCases) {
      await activate(testCase.name, testCase.tool);
      const start = requests.length;
      await expect(invoke(harness.tool(testCase.tool), testCase.args), testCase.name).rejects.toThrow(/503|Service Unavailable|Linear API request failed/i);
      expect(requests.length, testCase.name).toBe(start + 1);
      expect(requests[start]!.operationType, testCase.name).toBe('query');
      expect(requests[start]!.query, testCase.name).not.toMatch(/\bmutation\b/);
    }
    expect(await pathExists(join(agentDirectory, 'extensions', 'linear', 'credentials.json'))).toBe(false);
  });

  it('rejects unexpected input on every read tool before any HTTP request', async () => {
    for (const testCase of readCases) {
      await activate(testCase.name, testCase.tool);
      const before = requests.length;
      expect(
        () => prepareAndValidate(harness.tool(testCase.tool), { ...testCase.args, unexpectedFixtureField: true }),
        testCase.name,
      ).toThrow(/unexpectedFixtureField|unexpected|unknown|additional/i);
      expect(requests, testCase.name).toHaveLength(before);
    }
  });
});

describe('local workspace switch through extension activation', () => {
  async function writeIsolatedCredentials(): Promise<string> {
    const path = join(agentDirectory, 'extensions', 'linear', 'credentials.json');
    await mkdir(join(agentDirectory, 'extensions', 'linear'), { recursive: true });
    await writeFile(path, JSON.stringify({
      activeWorkspace: 'main',
      authPreference: 'workspace',
      workspaces: { main: { apiKey: 'fixture-main' }, work: { apiKey: 'fixture-work' } },
    }));
    return path;
  }

  it('activates the exact local tool and switches only the isolated credential file', async () => {
    const credentialPath = await writeIsolatedCredentials();
    delete process.env.LINEAR_READONLY;
    await activate('switch_workspace', 'linear_switch_workspace');
    const beforeRequests = requests.length;
    const result = await invoke(harness.tool('linear_switch_workspace'), { name: 'work' });

    expect(result.details).toEqual({ active: 'work' });
    expect(requests).toHaveLength(beforeRequests);
    const stored = JSON.parse(await readFile(credentialPath, 'utf8')) as JsonObject;
    expect(stored.activeWorkspace).toBe('work');
    expect(stored.workspaces).toEqual({ main: { apiKey: 'fixture-main' }, work: { apiKey: 'fixture-work' } });
  });

  it('rejects an unknown workspace and unexpected input without changing isolated state', async () => {
    const credentialPath = await writeIsolatedCredentials();
    delete process.env.LINEAR_READONLY;
    await activate('switch_workspace', 'linear_switch_workspace');
    const tool = harness.tool('linear_switch_workspace');
    const before = await readFile(credentialPath);

    await expect(invoke(tool, { name: 'missing' })).rejects.toThrow('Workspace "missing" does not exist.');
    expect(() => prepareAndValidate(tool, { name: 'work', unexpectedFixtureField: true }))
      .toThrow(/unexpectedFixtureField|unexpected|unknown|additional/i);
    expect(await readFile(credentialPath)).toEqual(before);
    expect(requests).toHaveLength(0);
  });
});
