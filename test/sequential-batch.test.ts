import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse, type FieldNode, type OperationDefinitionNode } from 'graphql';
import { linearBatchTool } from '../extensions/api';
import { SAFE_NAMED_MUTATION_ROOTS } from '../extensions/safety';
import { isolateLinearCredentials } from './helpers/credentials';
import type { CompatibilityObject } from '../extensions/operation-types';

isolateLinearCredentials();

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const originalKey = process.env.LINEAR_API_KEY;
const originalReadonly = process.env.LINEAR_READONLY;
const originalMutationRoots = new Set(SAFE_NAMED_MUTATION_ROOTS);
const servers: Server[] = [];

function mutation(key: string, title: string) {
  return { key, operation: 'update_issue', variables: { issue: 'AEO-1', title } };
}

function responseHeaders(...entries: Array<readonly [string, string]>): Record<string, string> {
  return Object.fromEntries(entries);
}

function rootField(query: string): FieldNode {
  const operation = parse(query).definitions.find(
    (definition): definition is OperationDefinitionNode => definition.kind === 'OperationDefinition',
  );
  const field = operation?.selectionSet.selections.find(
    (selection): selection is FieldNode => selection.kind === 'Field',
  );
  if (!field) throw new Error('Test server received no GraphQL root field.');
  return field;
}

async function localGraphQLServer(
  respond: (request: { query: string; variables: CompatibilityObject }, index: number) => {
    status?: number;
    body?: unknown;
    headers?: Record<string, string>;
    beforeReply?: () => void;
  },
) {
  const requests: Array<{ query: string; variables: CompatibilityObject }> = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const parsed = JSON.parse(body) as { query: string; variables: CompatibilityObject };
      requests.push(parsed);
      const outcome = respond(parsed, requests.length - 1);
      outcome.beforeReply?.();
      response.writeHead(outcome.status ?? 200, {
        'content-type': 'application/json',
        ...outcome.headers,
      });
      response.end(JSON.stringify(outcome.body ?? { data: {} }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || Object.prototype.toString.call(address) !== '[object Object]') {
    throw new Error('Test server did not bind to a port.');
  }
  const endpoint = `http://127.0.0.1:${(address as { port: number }).port}/graphql`;
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn((_url: string | URL | Request, init?: RequestInit) => realFetch(endpoint, init)));
  process.env.LINEAR_API_KEY = 'test-key';
  return { requests };
}

function execute(mutations: CompatibilityObject[], signal?: AbortSignal, telemetry?: 'always') {
  const tool = linearBatchTool() as any;
  return tool.execute('call-1', { mutations, telemetry }, signal, undefined, { hasUI: false });
}

function issueResult(request: { query: string; variables: CompatibilityObject }) {
  const field = rootField(request.query);
  const key = field.alias?.value ?? field.name.value;
  const input = Object.values(request.variables).find(
    (value) => value !== null && Object.prototype.toString.call(value) === '[object Object]',
  ) as CompatibilityObject | undefined;
  return {
    key,
    body: {
      data: {
        [key]: {
          success: true,
          issue: { id: ISSUE_ID, identifier: 'AEO-1', title: input?.title, description: 'Server detail' },
        },
      },
    },
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  if (originalKey === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = originalKey;
  if (originalReadonly === undefined) delete process.env.LINEAR_READONLY;
  else process.env.LINEAR_READONLY = originalReadonly;
  SAFE_NAMED_MUTATION_ROOTS.clear();
  for (const root of originalMutationRoots) SAFE_NAMED_MUTATION_ROOTS.add(root);
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe('sequential batch mutations', () => {
  it('runs one ordinary mutation through the direct batch tool', async () => {
    const { requests } = await localGraphQLServer((request) => ({ body: issueResult(request).body }));

    const result = await execute([mutation('one', 'First')]);

    expect(requests).toHaveLength(1);
    expect(result.details).toMatchObject({
      data: { one: { issueUpdate: { success: true, issue: { id: ISSUE_ID, title: 'First' } } } },
      errors: [],
      skipped: [],
      meta: { requests: { read: 0, mutation: 1 } },
    });
  });

  it('runs three independent ordinary mutations in order through separate HTTP requests', async () => {
    const { requests } = await localGraphQLServer((request) => ({ body: issueResult(request).body }));

    const result = await execute([
      mutation('one', 'First'),
      mutation('two', 'Second'),
      mutation('three', 'Third'),
    ]);

    expect(requests).toHaveLength(3);
    expect(requests.map(({ query }) => rootField(query).alias?.value)).toEqual(['one', 'two', 'three']);
    expect(Object.keys(result.details.data)).toEqual(['one', 'two', 'three']);
    expect(result.details.errors).toEqual([]);
    expect(result.details.skipped).toEqual([]);
    expect(result.details.meta.requests).toEqual({ read: 0, mutation: 3 });
  });

  it('uses the shared summary and full mutation result views for sequential entries', async () => {
    const { requests } = await localGraphQLServer((request) => ({ body: issueResult(request).body }));

    const result = await execute([
      mutation('summary', 'Summary'),
      { ...mutation('full', 'Full'), variables: { issue: 'AEO-1', title: 'Full', view: 'full' } },
    ]);

    expect(requests).toHaveLength(2);
    expect(result.details.data.summary.issueUpdate.issue).not.toHaveProperty('description');
    expect(result.details.data.full.issueUpdate.issue.description).toBe('Server detail');
    expect(Object.keys(requests[1]!.variables).some((key) => key.endsWith('_view'))).toBe(false);
    expect(Object.values(requests[1]!.variables)).not.toContain('full');
  });

  it('stops after the second GraphQL failure and accounts for every key once', async () => {
    const { requests } = await localGraphQLServer((request, index) => {
      const { key, body } = issueResult(request);
      return index === 1
        ? { body: { data: { [key]: null }, errors: [{ message: 'Mutation rejected', path: [key] }] } }
        : { body };
    });

    const result = await execute([
      mutation('one', 'First'),
      mutation('two', 'Second'),
      mutation('three', 'Third'),
    ]);

    expect(requests).toHaveLength(2);
    expect(result.details.data).toEqual({
      one: { issueUpdate: { success: true, issue: { id: ISSUE_ID, identifier: 'AEO-1', title: 'First' } } },
    });
    expect(result.details.errors).toEqual([{ key: 'two', path: ['two'], message: 'Mutation rejected' }]);
    expect(result.details.skipped).toEqual(['three']);
    expect(result.details.meta.requests).toEqual({ read: 0, mutation: 2 });
  });

  it('preserves earlier success and marks a sent HTTP failure outcome unknown without retrying', async () => {
    const { requests } = await localGraphQLServer((request, index) => index === 1
      ? {
          status: 503,
          headers: responseHeaders(['x-ratelimit-requests-remaining', '7']),
          body: { message: 'Unavailable' },
        }
      : { headers: responseHeaders(['x-complexity', '5']), body: issueResult(request).body });

    const result = await execute([
      mutation('one', 'First'),
      mutation('two', 'Second'),
      mutation('three', 'Third'),
    ], undefined, 'always');

    expect(requests).toHaveLength(2);
    expect(result.details.data.one.issueUpdate.issue.title).toBe('First');
    expect(result.details.errors).toEqual([{
      key: 'two',
      path: ['two'],
      message: expect.stringMatching(/outcome is unknown.*Do not retry.*blindly/i),
    }]);
    expect(result.details.skipped).toEqual(['three']);
    expect(result.details.meta.requests).toEqual({ read: 0, mutation: 2 });
    expect(result.details.meta.rateLimit.responses).toEqual([
      { phase: 'mutation', attempt: 1, 'X-Complexity': 5 },
      { phase: 'mutation', attempt: 1, 'X-RateLimit-Requests-Remaining': 7 },
    ]);
  });

  it('does not retry a rate-limited mutation with an uncertain write outcome', async () => {
    const { requests } = await localGraphQLServer((request, index) => index === 1
      ? { status: 429, headers: { 'retry-after': '0' }, body: { errors: [{ message: 'Rate limited' }] } }
      : { body: issueResult(request).body });

    const result = await execute([
      mutation('one', 'First'),
      mutation('two', 'Second'),
      mutation('three', 'Third'),
    ]);

    expect(requests).toHaveLength(2);
    expect(result.details.data.one.issueUpdate.issue.title).toBe('First');
    expect(result.details.errors).toEqual([{
      key: 'two',
      path: ['two'],
      message: expect.stringMatching(/outcome is unknown.*Do not retry.*blindly/i),
    }]);
    expect(result.details.skipped).toEqual(['three']);
  });

  it('marks an aborted sent request as outcome unknown and sends no later mutation', async () => {
    const controller = new AbortController();
    const { requests } = await localGraphQLServer((request, index) => index === 1
      ? { beforeReply: () => controller.abort(), body: issueResult(request).body }
      : { body: issueResult(request).body });

    const result = await execute([
      mutation('one', 'First'),
      mutation('two', 'Second'),
      mutation('three', 'Third'),
    ], controller.signal);

    expect(requests).toHaveLength(2);
    expect(result.details.data.one.issueUpdate.issue.title).toBe('First');
    expect(result.details.errors).toEqual([{
      key: 'two',
      path: ['two'],
      message: expect.stringMatching(/cancelled.*outcome is unknown.*may have reached Linear/i),
    }]);
    expect(result.details.skipped).toEqual(['three']);
  });

  it('resolves every reference before writes and sends zero mutations when a later lookup fails', async () => {
    const { requests } = await localGraphQLServer((request) => {
      expect(request.query).not.toContain('mutation');
      const aliases = [...request.query.matchAll(/(\w+)\s*:\s*teams\b/g)].map((match) => match[1]!);
      return { body: { data: Object.fromEntries(aliases.map((alias) => [alias, { nodes: [] }])) } };
    });

    const result = await execute([
      mutation('one', 'First'),
      { key: 'two', operation: 'create_cycle', variables: { team: 'Missing', startsAt: '2026-09-01', endsAt: '2026-09-08' } },
      mutation('three', 'Third'),
    ]);

    expect(requests).toHaveLength(1);
    expect(requests.every(({ query }) => !query.includes('mutation'))).toBe(true);
    expect(result.details.data).toEqual({});
    expect(result.details.errors).toEqual([{
      key: 'two',
      path: expect.any(Array),
      message: expect.stringMatching(/team.*Missing.*0 matches/i),
    }]);
    expect(result.details.skipped).toEqual(['one', 'three']);
    expect(result.details.meta.requests).toEqual({ read: 1, mutation: 0 });
  });

  it('validates and authorizes every later entry before any network access', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    process.env.LINEAR_API_KEY = 'test-key';

    await expect(execute([
      mutation('one', 'First'),
      { key: 'two', operation: 'update_issue', variables: { issue: 'AEO-2' } },
    ])).rejects.toThrow(/at least one|update field|change/i);
    expect(fetch).not.toHaveBeenCalled();

    SAFE_NAMED_MUTATION_ROOTS.delete('commentCreate');
    await expect(execute([
      mutation('one', 'First'),
      { key: 'two', operation: 'create_comment', variables: { issue: 'AEO-2', body: 'No write' } },
    ])).rejects.toThrow(/commentCreate.*safe named-root/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects cross-entry dependency fields at the direct tool boundary', async () => {
    const tool = linearBatchTool() as any;
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    for (const field of ['dependsOn', 'resultRef']) {
      const entry = { ...mutation('one', 'First'), [field]: 'earlier' };
      expect(() => tool.prepareArguments({ mutations: [entry] }))
        .toThrow(/Invalid arguments for "linear_batch"/);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
