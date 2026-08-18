import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getIntrospectionQuery, type IntrospectionQuery } from 'graphql';
import { linearApiTool } from '../extensions/api';
import { linearGraphQL, resolveApiKey } from '../extensions/client';
import { operations } from '../extensions/operations';
import { redactText } from '../extensions/redact';
import { typedLinearTools } from '../extensions/typed-tools';
import {
  catalogSchemaUsage,
  compareReadonlySchema,
  type ReadonlySchemaFixture,
} from './readonly-schema';
import { assertNoCredentialLeak } from './smoke-safety';

type ToolResult = { details?: Record<string, unknown> };
type JsonObject = Record<string, unknown>;

const ISSUE_REFERENCE = 'AEO-258';
const MISSING_ISSUE_ID = '00000000-0000-4000-8000-000000000000';
const KNOWN_TOKEN = 'lin_api_known_smoke_token_1234567890';

function fakeContext() {
  return {
    hasUI: false,
    ui: {
      confirm: async () => false,
      input: async () => undefined,
      notify: () => undefined,
    },
  } as any;
}

async function smokeApiKey(): Promise<string> {
  const isolated = process.env.PI_CODING_AGENT_DIR;
  const authenticated = process.env.LINEAR_SMOKE_AUTH_AGENT_DIR;
  try {
    if (authenticated) process.env.PI_CODING_AGENT_DIR = authenticated;
    const { apiKey } = await resolveApiKey(fakeContext(), { promptIfMissing: false });
    if (!apiKey) throw new Error('existing Linear authentication is unavailable');
    return apiKey;
  } finally {
    if (isolated === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = isolated;
  }
}

function data(details: Record<string, unknown> | undefined): JsonObject {
  const value = details?.data;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('runtime result did not include an inline data object');
  }
  return value as JsonObject;
}

function entityId(details: Record<string, unknown> | undefined, root: string): string {
  const entity = data(details)[root];
  if (!entity || typeof entity !== 'object' || Array.isArray(entity)) {
    throw new Error(`${root} result did not include an entity`);
  }
  const id = (entity as JsonObject).id;
  if (typeof id !== 'string' || !id) throw new Error(`${root}.id was missing`);
  return id;
}

function connection(details: Record<string, unknown> | undefined, root: string) {
  const value = data(details)[root];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${root} result did not include a connection`);
  }
  const nodes = (value as JsonObject).nodes;
  const pageInfo = (value as JsonObject).pageInfo;
  if (!Array.isArray(nodes) || !pageInfo || typeof pageInfo !== 'object') {
    throw new Error(`${root} result did not include nodes and pageInfo`);
  }
  return { nodes, pageInfo: pageInfo as JsonObject };
}

async function executeTool(tool: any, params: Record<string, unknown>): Promise<ToolResult> {
  return await tool.execute('readonly-smoke', params, undefined, undefined, fakeContext()) as ToolResult;
}

async function writeSummary(summary: JsonObject, apiKey: string): Promise<void> {
  assertNoCredentialLeak(summary, apiKey);
  const root = process.env.PI_ARTIFACT_PROJECT_ROOT;
  if (!root) throw new Error('isolated artifact root is unavailable');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'readonly-smoke-summary.json'), JSON.stringify(summary, null, 2));
}

async function runAuthenticatedSmoke(apiKey: string): Promise<JsonObject> {
  const fixture = JSON.parse(
    await readFile(new URL('./fixtures/readonly-schema-contract.json', import.meta.url), 'utf8'),
  ) as ReadonlySchemaFixture;
  const usage = catalogSchemaUsage(Object.values(operations));
  const introspection = await linearGraphQL<IntrospectionQuery>(apiKey, getIntrospectionQuery(), {});
  compareReadonlySchema(introspection, fixture, usage);

  const compatibility = linearApiTool('readonly');
  const typedTools = typedLinearTools('readonly');
  const typedGetIssue = typedTools.find((tool) => tool.name === 'linear_get_issue');
  const typedListIssues = typedTools.find((tool) => tool.name === 'linear_list_issues');
  if (!typedGetIssue || !typedListIssues) throw new Error('representative typed runtime tools are unavailable');

  const compatibilityIssue = await executeTool(compatibility, {
    operation: 'get_issue',
    variables: { issue: ISSUE_REFERENCE },
    sink: 'inline',
  });
  const typedIssue = await executeTool(typedGetIssue, { issue: ISSUE_REFERENCE });
  const compatibilityId = entityId(compatibilityIssue.details, 'issue');
  const typedId = entityId(typedIssue.details, 'issue');
  if (compatibilityId !== typedId) throw new Error('get_issue identity differed across runtime surfaces');

  const listed = await executeTool(compatibility, {
    operation: 'list_issues',
    variables: { first: 2 },
    sink: 'inline',
  });
  const compatibilityIssues = connection(listed.details, 'issues');
  const typedListed = await executeTool(typedListIssues, { first: 2 });
  const issues = connection(typedListed.details, 'issues');
  let listGet = 'skipped:no-issues';
  const first = issues.nodes[0];
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    const identifier = (first as JsonObject).identifier;
    const listId = (first as JsonObject).id;
    if (typeof identifier !== 'string' || typeof listId !== 'string') {
      throw new Error('list_issues returned an entity without identity fields');
    }
    const got = await executeTool(typedGetIssue, { issue: identifier });
    if (entityId(got.details, 'issue') !== listId) throw new Error('list_issues to get_issue identity differed');
    listGet = 'passed';
  }

  let missingReference = false;
  try {
    await executeTool(compatibility, {
      operation: 'get_issue',
      variables: { issue: MISSING_ISSUE_ID },
      sink: 'inline',
    });
  } catch {
    missingReference = true;
  }
  if (!missingReference) throw new Error('exact missing issue reference did not fail closed');

  const originalFetch = globalThis.fetch;
  let mutationRequests = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? init.body : '';
    if (/\bmutation\b/.test(body)) mutationRequests++;
    return originalFetch(input, init);
  }) as typeof fetch;
  try {
    await executeTool(compatibility, {
      operation: 'create_comment',
      variables: { issue: ISSUE_REFERENCE, body: 'must not execute' },
    });
    throw new Error('read-only mutation gate accepted a mutation');
  } catch (error) {
    if (error instanceof Error && error.message === 'read-only mutation gate accepted a mutation') throw error;
  } finally {
    globalThis.fetch = originalFetch;
  }
  if (mutationRequests !== 0) throw new Error(`read-only mutation gate observed ${mutationRequests} mutation requests`);

  const visible = {
    compatibilityIssue,
    typedIssue,
    listed,
    typedListed,
    compatibilityPageInfo: compatibilityIssues.pageInfo,
    knownTokenProbe: redactText(KNOWN_TOKEN, [apiKey]),
  };
  assertNoCredentialLeak(visible, apiKey);

  const summary = {
    status: 'pass',
    schema: {
      queryRoots: Object.keys(usage.roots.Query).length,
      mutationRoots: Object.keys(usage.roots.Mutation).length,
      inputTypes: Object.keys(fixture.inputs).length,
      enums: Object.keys(fixture.enums).length,
      namedObjects: Object.keys(fixture.objects).length,
    },
    runtime: {
      getIssueIdentity: 'passed',
      pagination: 'passed',
      listGet,
      missingReference: 'passed',
      mutationRequests,
      redaction: 'passed',
    },
  };
  await writeSummary(summary, apiKey);
  return summary;
}

export async function runReadonlySmoke(): Promise<JsonObject> {
  if (process.env.LINEAR_READONLY !== '1') {
    throw new Error('LINEAR_READONLY=1 is required before authentication or network access');
  }
  const apiKey = await smokeApiKey();
  const previousApiKey = process.env.LINEAR_API_KEY;
  process.env.LINEAR_API_KEY = apiKey;
  try {
    return await runAuthenticatedSmoke(apiKey);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(redactText(message, [apiKey]));
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
