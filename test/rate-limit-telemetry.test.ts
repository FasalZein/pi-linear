import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  linearErrorTelemetry,
  linearGraphQL,
  linearGraphQLWithContext,
  linearRateLimitTelemetry,
  parseLinearRateLimitHeaders,
} from '../extensions/client';
import { linearApiTool, linearBatchTool, linearGraphqlTool } from '../extensions/api';
import { getResult } from '../extensions/result-handles';
import { parseJsonObject, type JsonObject } from '../extensions/json';
import { isCompatibilityString } from '../extensions/operation-types';
import {
  executeOperationInContext,
  executeRawQuery,
  linearCallContext,
  routeLinearEnvelope,
  routeLinearResult,
} from '../extensions/runtime';
import { getOperation } from '../extensions/operations';
import { typedLinearTools } from '../extensions/typed-tools';

const roots: string[] = [];
const originalArtifactRoot = process.env.PI_ARTIFACT_PROJECT_ROOT;
const originalApiKey = process.env.LINEAR_API_KEY;

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalArtifactRoot === undefined) delete process.env.PI_ARTIFACT_PROJECT_ROOT;
  else process.env.PI_ARTIFACT_PROJECT_ROOT = originalArtifactRoot;
  if (originalApiKey === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = originalApiKey;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function executeBatchLegacy(params: JsonObject, ..._unused: unknown[]) {
  const { operation: _operation, variables, ...direct } = params;
  return (linearBatchTool() as any).execute(
    'call-1',
    { ...parseJsonObject(variables), ...direct },
    undefined,
    undefined,
    { hasUI: false },
  );
}

function response(status: number, body: JsonObject, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 429 ? 'Too Many Requests' : status === 400 ? 'Bad Request' : 'OK',
    headers,
  });
}

const completeHeaders = {
  'X-Complexity': '18',
  'X-RateLimit-Requests-Limit': '1500',
  'X-RateLimit-Requests-Remaining': '1499',
  'X-RateLimit-Requests-Reset': '1770000000000',
  'X-RateLimit-Endpoint-Requests-Limit': '30',
  'X-RateLimit-Endpoint-Requests-Remaining': '29',
  'X-RateLimit-Endpoint-Requests-Reset': '1770000001000',
  'X-RateLimit-Endpoint-Name': 'searchIssues',
  'X-RateLimit-Complexity-Limit': '250000',
  'X-RateLimit-Complexity-Remaining': '249982',
  'X-RateLimit-Complexity-Reset': '1770000002000',
  'Retry-After': '2.5',
};

describe('Linear rate-limit header telemetry', () => {
  it('parses every documented header without changing names', () => {
    expect(parseLinearRateLimitHeaders(new Headers(completeHeaders))).toEqual({
      'X-Complexity': 18,
      'X-RateLimit-Requests-Limit': 1500,
      'X-RateLimit-Requests-Remaining': 1499,
      'X-RateLimit-Requests-Reset': 1770000000000,
      'X-RateLimit-Endpoint-Requests-Limit': 30,
      'X-RateLimit-Endpoint-Requests-Remaining': 29,
      'X-RateLimit-Endpoint-Requests-Reset': 1770000001000,
      'X-RateLimit-Endpoint-Name': 'searchIssues',
      'X-RateLimit-Complexity-Limit': 250000,
      'X-RateLimit-Complexity-Remaining': 249982,
      'X-RateLimit-Complexity-Reset': 1770000002000,
      'Retry-After': '2.5',
    });
  });

  it('omits absent and malformed headers', () => {
    expect(parseLinearRateLimitHeaders(new Headers({
      'X-Complexity': 'not-a-number',
      'X-RateLimit-Requests-Remaining': '-1',
      'X-RateLimit-Endpoint-Name': '  ',
      'Retry-After': 'later',
    }))).toEqual({});
  });

  it('keeps normal response telemetry internal and non-enumerable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(200, { data: { viewer: { id: 'user-1' } } }, completeHeaders)));
    const data = await linearGraphQL('key', 'query { viewer { id } }');

    expect(data).toEqual({ viewer: { id: 'user-1' } });
    expect(JSON.stringify(data)).toBe('{"viewer":{"id":"user-1"}}');
    expect(linearRateLimitTelemetry(data)).toEqual([{ attempt: 1, headers: parseLinearRateLimitHeaders(new Headers(completeHeaders)) }]);
  });

  it('preserves redacted telemetry on stable HTTP and GraphQL errors', async () => {
    const key = 'lin_api_secret1234';
    vi.stubGlobal('fetch', vi.fn(async () => response(502, {}, {
      'X-RateLimit-Endpoint-Name': `search-${key}`,
      'X-RateLimit-Requests-Remaining': '1',
    })));
    const http = await linearGraphQL(key, 'query { viewer { id } }').catch((error): Error => error as Error) as Error;
    expect(http.message).toBe('Linear API request failed: 502 OK');
    expect(linearErrorTelemetry(http)[0]?.headers['X-RateLimit-Endpoint-Name']).toBe('search-[REDACTED]');
    expect(Object.keys(http)).not.toContain('linearTelemetry');
    expect(JSON.stringify(linearErrorTelemetry(http))).not.toContain(key);

    vi.stubGlobal('fetch', vi.fn(async () => response(200, {
      errors: [{ message: 'validation failed' }],
    }, { 'X-Complexity': '9' })));
    const graphql = await linearGraphQL('key', 'query { viewer { id } }').catch((error): Error => error as Error) as Error;
    expect(graphql.message).toBe('Linear GraphQL error: validation failed');
    expect(linearErrorTelemetry(graphql)).toEqual([{ attempt: 1, headers: { 'X-Complexity': 9 } }]);
  });

  it('rejects promptly when cancellation happens during the retry delay', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const transport = vi.fn(async () => response(429, {}, { 'Retry-After': '60' }));
    const request = linearGraphQLWithContext({
      credential: { apiKey: 'key', source: 'env' },
      transport,
      telemetry: [],
      signal: controller.signal,
    }, 'query { viewer { id } }');

    await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
    controller.abort();

    await expect(request).rejects.toThrow('Request cancelled.');
    expect(transport).toHaveBeenCalledOnce();
  });

  it('preserves initial and final snapshots across the existing one HTTP 429 retry', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(429, {}, {
        'Retry-After': '0',
        'X-RateLimit-Requests-Remaining': '0',
      }))
      .mockResolvedValueOnce(response(200, { data: { viewer: { id: 'user-1' } } }, {
        'X-RateLimit-Requests-Remaining': '10',
      }));
    vi.stubGlobal('fetch', fetch);

    const data = await linearGraphQL('key', 'query { viewer { id } }');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(linearRateLimitTelemetry(data)).toEqual([
      { attempt: 1, headers: { 'X-RateLimit-Requests-Remaining': 0, 'Retry-After': '0' } },
      { attempt: 2, headers: { 'X-RateLimit-Requests-Remaining': 10 } },
    ]);
  });

  it.each(['searchIssues', 'semanticSearch'])('retries a GraphQL 400 RATELIMITED %s read once using endpoint reset', async (root) => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const reset = Date.now() + 1250;
    const delays: number[] = [];
    vi.stubGlobal('setTimeout', ((callback: () => void, delay: number) => {
      delays.push(delay);
      callback();
      return 0;
    }) as typeof setTimeout);
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(400, { errors: [{ message: 'limited', extensions: { code: 'RATELIMITED' } }] }, {
        'X-RateLimit-Endpoint-Requests-Remaining': '0',
        'X-RateLimit-Endpoint-Requests-Reset': String(reset),
      }))
      .mockResolvedValueOnce(response(200, { data: { [root]: { nodes: [] } } }));
    vi.stubGlobal('fetch', fetch);

    await expect(linearGraphQL('key', `query { ${root}(term: "x") { nodes { id } } }`)).resolves.toEqual({ [root]: { nodes: [] } });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([1250]);
  });

  it('does not retry unrelated GraphQL validation errors or mutation-body RATELIMITED errors', async () => {
    const validationFetch = vi.fn(async () => response(400, { errors: [{ message: 'invalid', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] }));
    vi.stubGlobal('fetch', validationFetch);
    await expect(linearGraphQL('key', 'query { searchIssues(term: "x") { nodes { id } } }')).rejects.toThrow('invalid');
    expect(validationFetch).toHaveBeenCalledOnce();

    const mutationFetch = vi.fn(async () => response(400, { errors: [{ message: 'limited', extensions: { code: 'RATELIMITED' } }] }, { 'Retry-After': '0' }));
    vi.stubGlobal('fetch', mutationFetch);
    await expect(linearGraphQL('key', 'mutation { issueCreate(input: {}) { success } }')).rejects.toThrow('limited');
    expect(mutationFetch).toHaveBeenCalledOnce();
  });

  it.each([
    ['1.25', 1250],
    ['Thu, 01 Jan 2026 00:00:02 GMT', 2000],
  ])('honors Retry-After %s before endpoint reset', async (retryAfter, expectedDelay) => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const delays: number[] = [];
    vi.stubGlobal('setTimeout', ((callback: () => void, delay: number) => {
      delays.push(delay);
      callback();
      return 0;
    }) as typeof setTimeout);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response(429, {}, {
        'Retry-After': retryAfter,
        'X-RateLimit-Endpoint-Requests-Remaining': '0',
        'X-RateLimit-Endpoint-Requests-Reset': String(Date.now() + 9000),
      }))
      .mockResolvedValueOnce(response(200, { data: { viewer: { id: 'user-1' } } })));

    await linearGraphQL('key', 'query { viewer { id } }');
    expect(delays).toEqual([expectedDelay]);
  });
});

describe('model-facing budget warnings', () => {
  const base = { attempt: 1, headers: {} } as const;

  it('keeps concurrent direct and raw transports and telemetry isolated per call', async () => {
    process.env.LINEAR_API_KEY = 'lin_api_context_test';
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const awaitBoth = async () => {
      arrivals += 1;
      if (arrivals === 2) release();
      await barrier;
    };
    const directTransport = vi.fn(async () => {
      await awaitBoth();
      return response(200, { data: { customView: { id: 'view-1', name: 'Direct' } } }, {
        'X-RateLimit-Endpoint-Name': 'direct-only',
      });
    });
    const rawTransport = vi.fn(async () => {
      await awaitBoth();
      return response(200, { data: { viewer: { id: 'raw-user' } } }, {
        'X-RateLimit-Endpoint-Name': 'raw-only',
      });
    });
    const ctx = { hasUI: false } as any;
    const directCall = linearCallContext('allowlist', undefined, ctx, { telemetryMode: 'always' });
    const rawCall = linearCallContext('allowlist', undefined, ctx, { telemetryMode: 'always' });

    const [direct, raw] = await Promise.all([
      executeOperationInContext(getOperation('get_view'), { variables: { id: 'view-1' } }, directCall, directTransport),
      executeRawQuery('query { viewer { id } }', {}, rawCall, rawTransport),
    ]);

    expect((direct as any).data.customView.name).toBe('Direct');
    expect((raw as any).data.viewer.id).toBe('raw-user');
    expect((direct as any).meta.rateLimit.responses).toEqual([
      { attempt: 1, 'X-RateLimit-Endpoint-Name': 'direct-only' },
    ]);
    expect((raw as any).meta.rateLimit.responses).toEqual([
      { attempt: 1, 'X-RateLimit-Endpoint-Name': 'raw-only' },
    ]);
    expect(directTransport).toHaveBeenCalledOnce();
    expect(rawTransport).toHaveBeenCalledOnce();
  });

  it('keeps ordinary direct lookup telemetry free of batch phase labels', async () => {
    process.env.LINEAR_API_KEY = 'lin_api_lookup_telemetry';
    const transport = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = parseJsonObject(JSON.parse(String(init?.body))) ?? {};
      const query = isCompatibilityString(body.query) ? body.query : '';
      if (query.includes('ResolveTeamByKey')) {
        return response(200, { data: { teams: { nodes: [{ id: 'team-1', key: 'AEO' }] } } }, {
          'X-RateLimit-Endpoint-Name': 'lookup',
        });
      }
      return response(200, { data: { team: { id: 'team-1', key: 'AEO', name: 'AEO' } } }, {
        'X-RateLimit-Endpoint-Name': 'final',
      });
    });
    const call = linearCallContext('allowlist', undefined, { hasUI: false } as any, { telemetryMode: 'always' });

    const result = await executeOperationInContext(
      getOperation('get_team'),
      { variables: { team: 'AEO' } },
      call,
      transport,
    );

    expect((result as any).meta.rateLimit.responses).toEqual([
      { attempt: 1, 'X-RateLimit-Endpoint-Name': 'lookup' },
      { attempt: 1, 'X-RateLimit-Endpoint-Name': 'final' },
    ]);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('does not change ordinary result size or shape', async () => {
    const normal = await routeLinearResult({ viewer: { id: 'user-1' } }, {
      label: 'query', category: 'singular', telemetry: [{ ...base, headers: { 'X-RateLimit-Requests-Remaining': 2 } }],
    });
    expect(normal).toEqual({
      data: { viewer: { id: 'user-1' } },
      meta: { truncations: [], stringsClipped: 0, routing: { requestedSink: 'auto', actualSink: 'inline', inlineComplete: true } },
    });
    expect(JSON.stringify(normal)).not.toContain('rateLimit');
  });

  it('includes healthy response telemetry only for the explicit diagnostic override', async () => {
    const explicit = await routeLinearResult({ viewer: { id: 'user-1' } }, {
      label: 'query', category: 'singular', telemetryMode: 'always', telemetry: [{
        phase: 'read', attempt: 1, headers: parseLinearRateLimitHeaders(new Headers(completeHeaders)),
      }],
    });
    expect((explicit as any).meta.rateLimit).toEqual({
      scopes: [],
      retryAttempts: 0,
      responses: [{ phase: 'read', attempt: 1, ...parseLinearRateLimitHeaders(new Headers(completeHeaders)) }],
    });
  });

  it.each([
    ['requests at one', { 'X-RateLimit-Requests-Remaining': 1 }, ['requests']],
    ['endpoint at one', { 'X-RateLimit-Endpoint-Requests-Remaining': 1 }, ['endpoint']],
    ['complexity equal to current cost', { 'X-Complexity': 18, 'X-RateLimit-Complexity-Remaining': 18 }, ['complexity']],
  ])('warns for %s', async (_label, headers, scopes) => {
    const result = await routeLinearResult({ ok: true }, {
      label: 'query', category: 'singular', telemetry: [{ attempt: 1, headers }],
    });
    expect((result as any).meta.rateLimit).toEqual({ scopes, retryAttempts: 0, responses: [{ attempt: 1, ...headers }] });
  });

  it.each([
    ['requests above one', { 'X-RateLimit-Requests-Remaining': 2 }],
    ['endpoint above one', { 'X-RateLimit-Endpoint-Requests-Remaining': 2 }],
    ['complexity above current cost', { 'X-Complexity': 18, 'X-RateLimit-Complexity-Remaining': 19 }],
    ['complexity without current cost', { 'X-RateLimit-Complexity-Remaining': 1 }],
  ])('does not warn for %s', async (_label, headers) => {
    const result = await routeLinearResult({ ok: true }, {
      label: 'query', category: 'singular', telemetry: [{ attempt: 1, headers }],
    });
    expect((result as any).meta).not.toHaveProperty('rateLimit');
  });

  it('keeps near-exhaustion output unchanged with the diagnostic override', async () => {
    const options = {
      label: 'query', category: 'singular' as const,
      telemetry: [{ attempt: 1, headers: { 'X-RateLimit-Requests-Remaining': 1 } }],
    };
    const ordinary = await routeLinearResult({ ok: true }, options);
    const explicit = await routeLinearResult({ ok: true }, { ...options, telemetryMode: 'always' });
    expect((explicit as any).meta.rateLimit).toEqual((ordinary as any).meta.rateLimit);
  });

  it('reports the retry attempt count and preserves both warned response headers', async () => {
    const result = await routeLinearResult({ ok: true }, {
      label: 'query', category: 'singular', telemetry: [
        { attempt: 1, headers: { 'X-RateLimit-Requests-Remaining': 0, 'Retry-After': '0' } },
        { attempt: 2, headers: { 'X-RateLimit-Requests-Remaining': 10 } },
      ],
    });
    expect((result as any).meta.rateLimit).toEqual({
      scopes: ['requests'],
      retryAttempts: 1,
      responses: [
        { attempt: 1, 'X-RateLimit-Requests-Remaining': 0, 'Retry-After': '0' },
        { attempt: 2, 'X-RateLimit-Requests-Remaining': 10 },
      ],
    });
  });

  it('keeps batch read and mutation phase identity compact', async () => {
    const result = await routeLinearEnvelope({
      data: { read: {}, mutation: {} }, errors: [], skipped: [],
      meta: { requests: { read: 1, mutation: 1 }, aliases: 2, truncations: [], stringsClipped: 0 },
    }, {
      label: 'batch', category: 'batch', telemetry: [
        { phase: 'read', attempt: 1, headers: { 'X-RateLimit-Requests-Remaining': 1 } },
        { phase: 'mutation', attempt: 1, headers: { 'X-Complexity': 4 } },
      ],
    });
    expect((result as any).meta.rateLimit.responses).toEqual([
      { phase: 'read', attempt: 1, 'X-RateLimit-Requests-Remaining': 1 },
      { phase: 'mutation', attempt: 1, 'X-Complexity': 4 },
    ]);
  });

  it('wires raw and typed singular and collection result paths', async () => {
    process.env.LINEAR_API_KEY = 'test-key';
    const issue = { id: '11111111-1111-4111-8111-111111111111', identifier: 'AEO-370', title: 'Telemetry' };
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const { query } = JSON.parse(String(init.body)) as { query: string };
      const data = query.includes('searchIssues') ? { searchIssues: { nodes: [issue] } }
        : query.includes('teams(') ? { teams: { nodes: [{ id: 'team-1', name: 'AEO' }] } }
        : query.includes('issue(') ? { issue }
        : { viewer: { id: 'user-1' } };
      return response(200, { data }, { 'X-RateLimit-Requests-Remaining': '1' });
    }));
    const execute = (tool: any, params: JsonObject) =>
      tool.execute('call-1', params, undefined, undefined, { hasUI: false });

    const raw = await execute(linearGraphqlTool(), { query: 'query { viewer { id } }' });
    const tools = typedLinearTools();
    const singular = tools.find(({ name }) => name === 'linear_get_issue');
    const collection = tools.find(({ name }) => name === 'linear_list_teams');
    if (!singular || !collection) throw new Error('Missing typed telemetry test tools.');
    const singularResult = await execute(singular, { issue: issue.id });
    const collectionResult = await execute(collection, {});

    for (const result of [raw, singularResult, collectionResult]) {
      expect(result.details.meta.rateLimit.scopes).toEqual(['requests']);
    }
  });

  it('aggregates actual batch read and mutation response telemetry by phase', async () => {
    process.env.LINEAR_API_KEY = 'test-key';
    const issue = { id: '11111111-1111-4111-8111-111111111111', identifier: 'AEO-370', title: 'Telemetry' };
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const { query } = JSON.parse(String(init.body)) as { query: string };
      if (query.trimStart().startsWith('query')) {
        return response(200, { data: { read: issue } }, { 'X-RateLimit-Requests-Remaining': '1' });
      }
      return response(200, { data: { change: { success: true, issue: { ...issue, title: 'Updated' } } } }, { 'X-Complexity': '5' });
    }));
    const result = await executeBatchLegacy({
      operation: 'batch',
      variables: {
        reads: [{ key: 'read', operation: 'get_issue', variables: { issue: issue.id } }],
        mutations: [{ key: 'change', operation: 'update_issue', variables: { issue: issue.id, title: 'Updated' } }],
      },
    }, undefined, undefined, { hasUI: false });

    expect(result.details.meta.rateLimit.responses).toEqual([
      { phase: 'read', attempt: 1, 'X-RateLimit-Requests-Remaining': 1 },
      { phase: 'mutation', attempt: 1, 'X-Complexity': 5 },
    ]);
  });

  it('preserves successful read telemetry when a batch mutation transport failure is attributed', async () => {
    process.env.LINEAR_API_KEY = 'test-key';
    const issue = { id: '11111111-1111-4111-8111-111111111111', identifier: 'AEO-370', title: 'Telemetry' };
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(200, { data: { read: issue } }, {
        'X-RateLimit-Endpoint-Name': 'batch-read',
      }))
      .mockRejectedValueOnce(new Error('mutation transport failed'));
    vi.stubGlobal('fetch', fetch);

    const result = await executeBatchLegacy({
      operation: 'batch',
      telemetry: 'always',
      variables: {
        reads: [{ key: 'read', operation: 'get_issue', variables: { issue: issue.id } }],
        mutations: [{ key: 'change', operation: 'update_issue', variables: { issue: issue.id, title: 'Updated' } }],
      },
    }, undefined, undefined, { hasUI: false });

    expect(result.details).toMatchObject({
      data: { read: { issue } },
      errors: [{ key: 'change', path: ['change'], message: expect.stringMatching(/outcome is unknown/i) }],
      meta: {
        requests: { read: 1, mutation: 1 },
        rateLimit: { responses: [{ phase: 'read', attempt: 1, 'X-RateLimit-Endpoint-Name': 'batch-read' }] },
      },
    });
  });

  it('preserves read and mutation response telemetry when a mutation GraphQL error is classified', async () => {
    process.env.LINEAR_API_KEY = 'test-key';
    const issue = { id: '11111111-1111-4111-8111-111111111111', identifier: 'AEO-370', title: 'Telemetry' };
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(200, { data: { read: issue } }, {
        'X-RateLimit-Endpoint-Name': 'batch-read',
      }))
      .mockResolvedValueOnce(response(200, { errors: [{ message: 'mutation failed' }] }, {
        'X-RateLimit-Endpoint-Name': 'batch-mutation',
      }));
    vi.stubGlobal('fetch', fetch);

    const result = await executeBatchLegacy({
      operation: 'batch',
      telemetry: 'always',
      variables: {
        reads: [{ key: 'read', operation: 'get_issue', variables: { issue: issue.id } }],
        mutations: [{ key: 'change', operation: 'update_issue', variables: { issue: issue.id, title: 'Updated' } }],
      },
    }, undefined, undefined, { hasUI: false });

    expect(result.details).toMatchObject({
      data: { read: { issue } },
      errors: [{ key: 'change', path: ['change'], message: 'mutation failed' }],
      skipped: [],
      meta: { requests: { read: 1, mutation: 1 } },
    });
    expect(result.details.meta.rateLimit.responses).toEqual([
      { phase: 'read', attempt: 1, 'X-RateLimit-Endpoint-Name': 'batch-read' },
      { phase: 'mutation', attempt: 1, 'X-RateLimit-Endpoint-Name': 'batch-mutation' },
    ]);
  });

  it('rejects loader named execution before applying its telemetry override', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect((linearApiTool() as any).execute('call-1', {
      operation: 'get_issue',
      variables: { issue: '11111111-1111-4111-8111-111111111111' },
      telemetry: 'always',
    }, undefined, undefined, { hasUI: false }))
      .rejects.toThrow('Call linear_get_issue with direct arguments.');

    expect(fetch).not.toHaveBeenCalled();
  });

  it('supports explicit telemetry on raw queries without passing the loader field to GraphQL', async () => {
    process.env.LINEAR_API_KEY = 'lin_api_secret1234';
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => response(200, {
      data: { viewer: { id: 'user-1' } },
    }, {
      'X-RateLimit-Requests-Remaining': '1499',
      'X-RateLimit-Endpoint-Name': 'viewer-lin_api_secret1234',
    }));
    vi.stubGlobal('fetch', fetch);

    const result = await (linearGraphqlTool() as any).execute('call-1', {
      query: 'query Viewer($id: String) { viewer { id } }',
      variables: { id: 'user-1' },
      telemetry: 'always',
    }, undefined, undefined, { hasUI: false });

    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
    expect(body.variables).toEqual({ id: 'user-1' });
    expect(body.query).not.toContain('telemetry');
    expect(result.details.meta.rateLimit).toEqual({
      scopes: [], retryAttempts: 0, responses: [{
        attempt: 1,
        'X-RateLimit-Requests-Remaining': 1499,
        'X-RateLimit-Endpoint-Name': 'viewer-[REDACTED]',
      }],
    });
    expect(JSON.stringify(result)).not.toContain('secret1234');
  });

  it('preserves explicit retry attempts and batch phases', async () => {
    process.env.LINEAR_API_KEY = 'test-key';
    const issue = {
      id: '11111111-1111-4111-8111-111111111111', identifier: 'AEO-427', title: 'Measure telemetry',
    };
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(429, {}, { 'Retry-After': '0', 'X-RateLimit-Requests-Remaining': '10' }))
      .mockResolvedValueOnce(response(200, { data: { read: issue } }, { 'X-RateLimit-Requests-Remaining': '9' }))
      .mockResolvedValueOnce(response(200, { data: { change: { success: true, issue: { ...issue, title: 'Updated' } } } }, { 'X-Complexity': '5' }));
    vi.stubGlobal('fetch', fetch);

    const result = await executeBatchLegacy({
      operation: 'batch', telemetry: 'always', variables: {
        reads: [{ key: 'read', operation: 'get_issue', variables: { issue: '11111111-1111-4111-8111-111111111111' } }],
        mutations: [{ key: 'change', operation: 'update_issue', variables: { issue: '11111111-1111-4111-8111-111111111111', title: 'Updated' } }],
      },
    }, undefined, undefined, { hasUI: false });

    expect(result.details.meta.rateLimit).toEqual({
      scopes: [], retryAttempts: 1, responses: [
        { phase: 'read', attempt: 1, 'X-RateLimit-Requests-Remaining': 10, 'Retry-After': '0' },
        { phase: 'read', attempt: 2, 'X-RateLimit-Requests-Remaining': 9 },
        { phase: 'mutation', attempt: 1, 'X-Complexity': 5 },
      ],
    });
  });

  it('preserves read and mutation identity for an explicit guarded delete', async () => {
    process.env.LINEAR_API_KEY = 'test-key';
    const variables = {
      relationId: '33333333-3333-4333-8333-333333333333',
      issueId: '11111111-1111-4111-8111-111111111111',
      relatedIssueId: '22222222-2222-4222-8222-222222222222',
      type: 'related',
    };
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const { query } = JSON.parse(String(init.body)) as { query: string };
      if (query.trimStart().startsWith('mutation')) {
        return response(200, { data: { issueRelationDelete: { success: true } } }, { 'X-Complexity': '4' });
      }
      const alias = query.match(/(\w+):\s*issueRelation/)?.[1] ?? 'issueRelation';
      return response(200, { data: { [alias]: {
        id: variables.relationId, type: variables.type,
        issue: { id: variables.issueId }, relatedIssue: { id: variables.relatedIssueId },
      } } }, { 'X-RateLimit-Requests-Remaining': '100' });
    });
    vi.stubGlobal('fetch', fetch);

    const result = await executeBatchLegacy({
      operation: 'batch', telemetry: 'always', variables: {
        mutations: [{ operation: 'delete_issue_relation', variables }],
      },
    }, undefined, undefined, { hasUI: false });

    expect(result.details.meta.rateLimit.responses).toEqual([
      { phase: 'read', attempt: 1, 'X-RateLimit-Requests-Remaining': 100 },
      { phase: 'mutation', attempt: 1, 'X-Complexity': 4 },
    ]);
  });

  it('rejects malformed loader telemetry before credentials or network', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    delete process.env.LINEAR_API_KEY;

    await expect((linearGraphqlTool() as any).execute('call-1', {
      query: 'query { viewer { id } }', telemetry: 'sometimes',
    }, undefined, undefined, { hasUI: false })).rejects.toThrow(/Invalid arguments for "linear_graphql"/);
    expect(fetch).not.toHaveBeenCalled();
    expect((linearGraphqlTool() as any).parameters.properties.telemetry).toBeDefined();
    for (const tool of typedLinearTools()) {
      expect((tool.parameters as any).properties?.telemetry).toBeUndefined();
    }
  });

  it('stores and retrieves an explicit healthy envelope through an artifact handle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-linear-rate-limit-'));
    roots.push(root);
    process.env.PI_ARTIFACT_PROJECT_ROOT = root;
    const stored = await routeLinearResult({ document: { id: 'doc-1' } }, {
      label: 'get_document', category: 'singular', sink: 'artifact', telemetryMode: 'always',
      telemetry: [{ attempt: 1, headers: { 'X-RateLimit-Requests-Remaining': 100 } }],
    });
    if (!('handle' in stored)) throw new Error('Expected artifact result.');
    const disk = JSON.parse(await readFile(stored.path, 'utf8'));
    expect(disk.meta.rateLimit.scopes).toEqual([]);
    const retrieved = await getResult({ handle: stored.handle, path: '/meta/rateLimit' });
    expect((retrieved.data as any).value).toMatchObject({ scopes: [], retryAttempts: 0 });
  });
});
