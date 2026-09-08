import { DEFAULT_MAX_BYTES } from '@earendil-works/pi-coding-agent';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { linearGetResultTool, linearGraphqlTool } from '../extensions/api';
import { typedLinearTools } from '../extensions/typed-tools';
import { isolateLinearCredentials } from './helpers/credentials';
import { executeTyped } from './helpers/typed-execution';
import { parseJsonObject, type JsonObject } from '../extensions/json';
import { isCompatibilityString } from '../extensions/operation-types';

type RawRequest = { query: string; sink?: 'inline' | 'artifact' };
type NamedRequest = { operation: string; variables?: JsonObject };
type ToolRequest = RawRequest | NamedRequest;

isolateLinearCredentials();

const originalRoot = process.env.PI_ARTIFACT_PROJECT_ROOT;
const originalKey = process.env.LINEAR_API_KEY;
const originalSpill = process.env.LINEAR_SPILL_BYTES;
const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';
const roots: string[] = [];

async function useArtifactRoot() {
  const root = await mkdtemp(join(tmpdir(), 'pi-linear-aeo412-'));
  roots.push(root);
  process.env.PI_ARTIFACT_PROJECT_ROOT = root;
}

function execute(params: ToolRequest) {
  if ('query' in params) {
    return (linearGraphqlTool() as any).execute('call-1', params, undefined, undefined, { hasUI: false });
  }
  if (params.operation === 'get_result') {
    return (linearGetResultTool() as any).execute('call-1', params.variables, undefined, undefined, { hasUI: false });
  }
  return executeTyped(params.operation, params.variables);
}

function installServer(respond: (query: string, variables: JsonObject) => {
  data?: JsonObject;
  errors?: Array<{ path?: Array<string | number>; message: string }>;
}) {
  process.env.LINEAR_API_KEY = 'lin_api_active_secret_123456789';
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const request = parseJsonObject(JSON.parse(String(init.body))) ?? {};
    if (!isCompatibilityString(request.query)) throw new Error('Test transport received a request without a query.');
    return new Response(JSON.stringify(respond(request.query, parseJsonObject(request.variables) ?? {})), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }));
}

async function recovered(details: any, path = ''): Promise<any> {
  if (!details.handle) return details;
  return (await execute({ operation: 'get_result', variables: { handle: details.handle, path } })).details;
}

async function recoverString(handle: string, path: string): Promise<string> {
  let offset = 0;
  let result = '';
  for (;;) {
    const response = (await execute({ operation: 'get_result', variables: { handle, path, offset } })).details;
    result += response.data.value;
    if (response.meta.retrieval.complete) return result;
    offset = response.meta.retrieval.nextOffset;
  }
}

afterEach(async () => {
  vi.unstubAllGlobals();
  if (originalRoot === undefined) delete process.env.PI_ARTIFACT_PROJECT_ROOT;
  else process.env.PI_ARTIFACT_PROJECT_ROOT = originalRoot;
  if (originalKey === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = originalKey;
  if (originalSpill === undefined) delete process.env.LINEAR_SPILL_BYTES;
  else process.env.LINEAR_SPILL_BYTES = originalSpill;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('lossless singular routing', () => {
  it('returns the maintained 6,500-character get_document result inline', async () => {
    const content = 'd'.repeat(6_500);
    installServer(() => ({ data: { document: { id: DOCUMENT_ID, slugId: 'doc-1', title: 'Notes', content } } }));

    const result = await execute({ operation: 'get_document', variables: { document: DOCUMENT_ID } });

    expect(result.details.data.document.content).toBe(content);
    expect(result.details).not.toHaveProperty('handle');
    expect(result.details.meta).toMatchObject({
      truncations: [],
      stringsClipped: 0,
      routing: { requestedSink: 'auto', actualSink: 'inline', inlineComplete: true },
    });
  });

  it('externalizes an above-boundary singular result once and recovers every character', async () => {
    await useArtifactRoot();
    const content = '😀'.repeat(DEFAULT_MAX_BYTES);
    installServer(() => ({ data: { document: { id: DOCUMENT_ID, slugId: 'doc-1', title: 'Notes', content } } }));

    const result = await execute({ operation: 'get_document', variables: { document: DOCUMENT_ID } });

    expect(result.details).toMatchObject({
      handle: expect.stringMatching(/^linear-result:v1:/),
      meta: {
        routing: { requestedSink: 'auto', actualSink: 'artifact', reason: 'tool-output-boundary', inlineComplete: false },
        resultBudget: {
          maxBytes: DEFAULT_MAX_BYTES,
          truncated: true,
          recoverable: true,
          omissions: [{ path: '', handle: result.details.handle, inlineBytes: 0 }],
        },
      },
    });
    expect(await recoverString(result.details.handle, '/data/document/content')).toBe(content);
  });

  it('treats inline as a complete preference and artifact as strict', async () => {
    await useArtifactRoot();
    const large = 'x'.repeat(DEFAULT_MAX_BYTES);
    installServer(() => ({ data: { document: { id: 'doc-1', title: 'Notes', content: large } } }));

    const fallback = await execute({ query: 'query { document(id: "doc-1") { id title content } }', sink: 'inline' });
    expect(fallback.details.meta.routing).toMatchObject({
      requestedSink: 'inline', actualSink: 'artifact', reason: 'tool-output-boundary', inlineComplete: false,
    });
    expect(await recoverString(fallback.details.handle, '/data/document/content')).toBe(large);

    installServer(() => ({ data: { document: { id: 'doc-2', title: 'Small', content: 'complete' } } }));
    const forced = await execute({ query: 'query { document(id: "doc-2") { id title content } }', sink: 'artifact' });
    expect(forced.details.meta.routing).toMatchObject({
      requestedSink: 'artifact', actualSink: 'artifact', reason: 'requested', inlineComplete: false,
    });
    expect(forced.details.meta).not.toHaveProperty('resultBudget');
    expect((await recovered(forced.details, '/data/document')).data.value).toEqual({
      id: 'doc-2', title: 'Small', content: 'complete',
    });
  });

  it('publishes named child errors with partial entity identity', async () => {
    installServer(() => ({
      data: { document: { id: DOCUMENT_ID, slugId: 'doc-1', title: 'Notes', content: null } },
      errors: [{ path: ['document', 'content'], message: 'Content unavailable' }],
    }));

    const result = await execute({ operation: 'get_document', variables: { document: DOCUMENT_ID } });

    expect(result.details.data.document).toMatchObject({ id: DOCUMENT_ID, title: 'Notes' });
    expect(result.details.errors).toEqual([{ path: ['document', 'content'], message: 'Content unavailable' }]);
  });

  it('classifies exact search as singular without applying the collection spill threshold', async () => {
    await useArtifactRoot();
    process.env.LINEAR_SPILL_BYTES = '100';
    const issue = { id: 'issue-1', identifier: 'AEO-412', title: 'x'.repeat(500) };
    installServer((query) => query.includes('query GetIssue')
      ? { data: { issue } }
      : { data: { searchIssues: { nodes: [issue], pageInfo: { hasNextPage: false } } } });

    const exact = await execute({ operation: 'search_issues', variables: { term: 'AEO-412' } });
    const ordinary = await execute({ operation: 'search_issues', variables: { term: 'routing' } });

    expect(exact.details.data.issue).toEqual(issue);
    expect(exact.details.meta.routing.actualSink).toBe('inline');
    expect(ordinary.details.meta.routing).toMatchObject({ actualSink: 'artifact', reason: 'spill-threshold' });
  });

  it('keeps typed and raw singular reads lossless', async () => {
    const content = 't'.repeat(6_500);
    installServer(() => ({ data: { document: { id: DOCUMENT_ID, slugId: 'doc-1', title: 'Notes', content } } }));
    const typed = typedLinearTools().find((tool: any) => tool.name === 'linear_get_document') as any;

    const typedResult = await typed.execute('call-1', { document: DOCUMENT_ID }, undefined, undefined, { hasUI: false });
    const rawResult = await execute({ query: `query { document(id: "${DOCUMENT_ID}") { id title content } }` });

    expect(typedResult.details.data).toEqual(rawResult.details.data);
    expect(typedResult.details.data.document.content).toBe(content);
  });
});

describe('lossless raw GraphQL routing', () => {
  it.each([
    ['auto', undefined],
    ['inline', 'inline'],
    ['artifact', 'artifact'],
  ] as const)('preserves sibling data and path errors with %s sink', async (_name, sink) => {
    await useArtifactRoot();
    process.env.LINEAR_SPILL_BYTES = '100';
    const secret = 'lin_api_active_secret_123456789';
    installServer(() => ({
      data: { viewer: { id: 'me', name: `Ada ${secret}` }, organization: null },
      errors: [{ path: ['organization'], message: `Unavailable ${secret}` }],
    }));

    const query = 'query { viewer { id name } organization { id } }';
    const call = await execute(sink ? { query, sink } : { query });
    const envelope = call.details.handle ? (await recovered(call.details)).data.value : call.details;

    expect(envelope.data).toEqual({ viewer: { id: 'me', name: 'Ada [REDACTED]' }, organization: null });
    expect(envelope.errors).toEqual([{ path: ['organization'], message: 'Unavailable [REDACTED]' }]);
    // The serialized envelope keeps its published key order for every sink.
    expect(Object.keys(envelope)).toEqual(['data', 'errors', 'meta']);
  });

  it('keeps every raw node when forced inline', async () => {
    const nodes = Array.from({ length: 120 }, (_, index) => ({ id: `issue-${index}`, title: `Issue ${index}` }));
    installServer(() => ({ data: { issues: { nodes, pageInfo: { hasNextPage: false } } } }));

    const result = await execute({ query: 'query { issues { nodes { id title } pageInfo { hasNextPage } } }', sink: 'inline' });

    expect(result.details.data.issues.nodes).toEqual(nodes);
    expect(result.details.meta).toMatchObject({ truncations: [], stringsClipped: 0 });
  });

  it('still throws pathless GraphQL errors', async () => {
    installServer(() => ({ data: { viewer: { id: 'me' } }, errors: [{ message: 'Request failed' }] }));

    await expect(execute({ query: 'query { viewer { id } }' })).rejects.toThrow('Linear GraphQL error: Request failed');
  });
});
