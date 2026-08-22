import { afterEach, describe, expect, it, vi } from 'vitest';
import { linearApiTool } from '../extensions/api';
import { linearErrorTelemetry } from '../extensions/client';
import { operations } from '../extensions/operations';
import { SAFE_NAMED_MUTATION_ROOTS } from '../extensions/safety';
import { typedLinearTools } from '../extensions/typed-tools';
import { isolateLinearCredentials } from './helpers/credentials';

isolateLinearCredentials();

const ISSUE = '11111111-1111-4111-8111-111111111111';
const RELATED = '22222222-2222-4222-8222-222222222222';
const RELATION = '33333333-3333-4333-8333-333333333333';
const SECRET = 'lin_api_secret123456789abcdef';
const variables = { relationId: RELATION, issueId: ISSUE, relatedIssueId: RELATED, type: 'related' };
const originalKey = process.env.LINEAR_API_KEY;
const originalMutations = process.env.LINEAR_MUTATIONS;
const originalReadonly = process.env.LINEAR_READONLY;

function execute(input: Record<string, unknown>, mode: 'allowlist' | 'readonly' = 'allowlist') {
  return (linearApiTool(mode) as any).execute('call', input, undefined, undefined, { hasUI: false });
}

function response(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function successStub(relation: Record<string, unknown> | null = {
  id: RELATION,
  type: 'related',
  issue: { id: ISSUE },
  relatedIssue: { id: RELATED },
}) {
  const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    requests.push(request);
    if (request.query.includes('VerifyIssueRelationDelete')) {
      return response({ data: { issueRelation: relation } });
    }
    return response({ data: { issueRelationDelete: { success: true } } });
  });
  vi.stubGlobal('fetch', fetch);
  process.env.LINEAR_API_KEY = SECRET;
  return { fetch, requests };
}

afterEach(() => {
  vi.unstubAllGlobals();
  SAFE_NAMED_MUTATION_ROOTS.add('issueRelationDelete');
  if (originalKey === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = originalKey;
  if (originalMutations === undefined) delete process.env.LINEAR_MUTATIONS;
  else process.env.LINEAR_MUTATIONS = originalMutations;
  if (originalReadonly === undefined) delete process.env.LINEAR_READONLY;
  else process.env.LINEAR_READONLY = originalReadonly;
});

describe('delete_issue_relation strict guarded delete', () => {
  it('publishes only the four exact required guards and rejects malformed or unknown fields with zero network calls', async () => {
    const operation = operations.delete_issue_relation;
    expect(operation.parameters).toEqual([
      { name: 'relationId', type: 'UUID', required: true },
      { name: 'issueId', type: 'UUID', required: true },
      { name: 'relatedIssueId', type: 'UUID', required: true },
      { name: 'type', type: 'IssueRelationType', required: true },
    ]);
    const tool = typedLinearTools().find((candidate: any) => candidate.name === 'linear_delete_issue_relation') as any;
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    for (const invalid of [
      { ...variables, relationId: 'AEO-1' },
      { ...variables, issueId: 'AEO-1' },
      { ...variables, relatedIssueId: 'AEO-2' },
      { ...variables, type: 'inverse' },
      { ...variables, input: {} },
      { ...variables, issue: ISSUE },
      { relationId: RELATION, issueId: ISSUE, relatedIssueId: RELATED },
    ]) expect(() => tool.prepareArguments(invalid)).toThrow();
    await expect(execute({ operation: 'delete_issue_relation', variables: { ...variables, relationId: 'bad' } }))
      .rejects.toThrow('Invalid relationId: expected a UUID.');
    await expect(execute({ operation: 'delete_issue_relation', variables: { ...variables, input: {} } }))
      .rejects.toThrow('Invalid parameters for "delete_issue_relation": unknown input.');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('makes one exact read then one delete and returns the compact acknowledgement without requiring all', async () => {
    delete process.env.LINEAR_MUTATIONS;
    const { requests } = successStub();
    const result = await execute({ operation: 'delete_issue_relation', variables });
    expect(requests).toHaveLength(2);
    expect(requests[0]!.query).toContain('query VerifyIssueRelationDelete');
    expect(requests[0]!.variables).toEqual({ id: RELATION });
    expect(requests[1]!.query).toContain('mutation DeleteIssueRelation');
    expect(requests[1]!.variables).toEqual({ id: RELATION });
    expect(result.details.data).toEqual({
      issueRelationDelete: { ...variables, deleted: true },
    });
  });

  it.each([
    ['absent', null],
    ['wrong source', { id: RELATION, type: 'related', issue: { id: RELATED }, relatedIssue: { id: RELATED } }],
    ['wrong target', { id: RELATION, type: 'related', issue: { id: ISSUE }, relatedIssue: { id: ISSUE } }],
    ['reversed endpoints', { id: RELATION, type: 'related', issue: { id: RELATED }, relatedIssue: { id: ISSUE } }],
    ['wrong type', { id: RELATION, type: 'blocks', issue: { id: ISSUE }, relatedIssue: { id: RELATED } }],
    ['wrong returned id', { id: ISSUE, type: 'related', issue: { id: ISSUE }, relatedIssue: { id: RELATED } }],
  ])('fails closed for %s without deleting', async (_case, relation) => {
    const { requests } = successStub(relation as any);
    await expect(execute({ operation: 'delete_issue_relation', variables }))
      .rejects.toThrow('Linear issue relation did not match the exact delete guard.');
    expect(requests).toHaveLength(1);
  });

  const leaked = `${RELATION} ${ISSUE} ${RELATED} ${SECRET}`;

  it.each([
    ['transport', async () => { throw new Error(`offline ${leaked}`); }],
    ['GraphQL', async () => response({
      data: { issueRelation: { id: RELATION, type: 'related', issue: { id: ISSUE }, relatedIssue: { id: RELATED } } },
      errors: [{ path: ['issueRelation'], message: `failed ${leaked}` }],
    })],
    ['HTTP', async () => new Response(JSON.stringify({ message: leaked }), {
      status: 502,
      statusText: leaked,
      headers: { 'Content-Type': 'application/json' },
    })],
  ])('does not delete after a preflight %s failure and exposes no guard or credential', async (_case, fetcher) => {
    process.env.LINEAR_API_KEY = SECRET;
    const fetch = vi.fn(fetcher);
    vi.stubGlobal('fetch', fetch);
    const error = await execute({ operation: 'delete_issue_relation', variables }).catch((value: Error) => value);
    expect(error.message).toBe('Linear issue relation delete preflight failed.');
    for (const secret of [RELATION, ISSUE, RELATED, SECRET]) expect(error.message).not.toContain(secret);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('retains safe phase telemetry on normalized failures', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const { query } = JSON.parse(String(init.body));
      if (query.includes('VerifyIssueRelationDelete')) {
        return response({ data: { issueRelation: { id: RELATION, type: 'related', issue: { id: ISSUE }, relatedIssue: { id: RELATED } } } }, {
          'X-RateLimit-Requests-Remaining': '9',
        });
      }
      return response({ errors: [{ message: leaked }] }, { 'X-RateLimit-Complexity-Remaining': '8' });
    });
    vi.stubGlobal('fetch', fetch);
    process.env.LINEAR_API_KEY = SECRET;
    const error = await execute({ operation: 'delete_issue_relation', variables }).catch((value: Error) => value);
    expect(error.message).toBe('Linear issue relation delete failed.');
    expect(linearErrorTelemetry(error)).toEqual([
      { phase: 'read', attempt: 1, headers: { 'X-RateLimit-Requests-Remaining': 9 } },
      { phase: 'mutation', attempt: 1, headers: { 'X-RateLimit-Complexity-Remaining': 8 } },
    ]);
    const text = JSON.stringify(linearErrorTelemetry(error));
    for (const secret of [RELATION, ISSUE, RELATED, SECRET]) expect(text).not.toContain(secret);
  });

  it.each([
    ['success false', { data: { issueRelationDelete: { success: false } } }],
    ['GraphQL error', { data: { issueRelationDelete: null }, errors: [{ path: ['issueRelationDelete'], message: leaked }] }],
    ['HTTP error', null],
    ['transport error', undefined],
  ])('normalizes upstream delete %s without exposing a guard or credential', async (_case, deleteBody) => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const { query } = JSON.parse(String(init.body));
      if (query.includes('VerifyIssueRelationDelete')) {
        return response({ data: { issueRelation: { id: RELATION, type: 'related', issue: { id: ISSUE }, relatedIssue: { id: RELATED } } } });
      }
      if (deleteBody === undefined) throw new Error(leaked);
      if (deleteBody === null) return new Response(JSON.stringify({ message: leaked }), { status: 502, statusText: leaked });
      return response(deleteBody);
    });
    vi.stubGlobal('fetch', fetch);
    process.env.LINEAR_API_KEY = SECRET;
    const error = await execute({ operation: 'delete_issue_relation', variables }).catch((value: Error) => value);
    expect(error.message).toBe('Linear issue relation delete failed.');
    for (const secret of [RELATION, ISSUE, RELATED, SECRET]) expect(error.message).not.toContain(secret);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('obeys read-only mode and the named root allowlist before network access', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(execute({ operation: 'delete_issue_relation', variables }, 'readonly'))
      .rejects.toThrow('Linear mutations are disabled by read-only mode.');
    SAFE_NAMED_MUTATION_ROOTS.delete('issueRelationDelete');
    await expect(execute({ operation: 'delete_issue_relation', variables }))
      .rejects.toThrow('issueRelationDelete is not in the safe named-root set.');
    expect(fetch).not.toHaveBeenCalled();
  });

  function batchDelete(reads: unknown[] = []) {
    return execute({
      operation: 'batch',
      variables: {
        reads,
        mutations: [{ key: 'remove', operation: 'delete_issue_relation', variables }],
      },
    });
  }

  it('folds a guarded preflight beside reads, then returns the keyed acknowledgement', async () => {
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      requests.push(request);
      if (request.query.includes('BatchRead')) return response({ data: {
        read: { id: ISSUE, identifier: 'AEO-1', title: 'Read' },
        _lookup_remove_issueRelation: { id: RELATION, type: 'related', issue: { id: ISSUE }, relatedIssue: { id: RELATED } },
      } });
      return response({ data: { remove: { success: true } } });
    });
    vi.stubGlobal('fetch', fetch);
    process.env.LINEAR_API_KEY = SECRET;
    const result = await batchDelete([{ key: 'read', operation: 'get_issue', variables: { issue: ISSUE } }]);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.query).toContain('read: issue');
    expect(requests[0]!.query).toContain('_lookup_remove_issueRelation: issueRelation');
    expect(requests[0]!.query).not.toContain('issueRelationDelete');
    expect(requests[1]!.query).toContain('remove: issueRelationDelete');
    expect(result.details).toMatchObject({
      data: {
        read: { issue: { id: ISSUE } },
        remove: { issueRelationDelete: { ...variables, deleted: true } },
      },
      errors: [],
      skipped: [],
      meta: { requests: { read: 1, mutation: 1 } },
    });
    expect([...Object.keys(result.details.data), ...result.details.skipped]).toEqual(['read', 'remove']);
  });

  it('assigns a mutation key that avoids a reserved guarded-read name', async () => {
    const reserved = '_lookup_delete_issue_relation_issueRelation';
    const requests: Array<{ query: string }> = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      requests.push(request);
      if (request.query.includes('BatchRead')) return response({ data: {
        [reserved]: { id: ISSUE, identifier: 'AEO-1', title: 'Read' },
        _lookup_delete_issue_relation_2_issueRelation: { id: RELATION, type: 'related', issue: { id: ISSUE }, relatedIssue: { id: RELATED } },
      } }, { 'X-RateLimit-Requests-Remaining': '1' });
      return response({ data: { delete_issue_relation_2: { success: true } } }, { 'X-RateLimit-Complexity-Remaining': '1' });
    });
    vi.stubGlobal('fetch', fetch);
    process.env.LINEAR_API_KEY = SECRET;
    const result = await execute({
      operation: 'batch',
      variables: {
        reads: [{ key: reserved, operation: 'get_issue', variables: { issue: ISSUE } }],
        mutations: [{ operation: 'delete_issue_relation', variables }],
      },
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]!.query).toContain('_lookup_delete_issue_relation_2_issueRelation: issueRelation');
    expect(requests[1]!.query).toContain('delete_issue_relation_2: issueRelationDelete');
    expect(Object.keys(result.details.data)).toEqual([reserved, 'delete_issue_relation_2']);
    expect(result.details.meta.rateLimit.responses).toEqual([
      { phase: 'read', attempt: 1, 'X-RateLimit-Requests-Remaining': 1 },
      { phase: 'mutation', attempt: 1, 'X-RateLimit-Complexity-Remaining': 1 },
    ]);
  });

  it.each([
    ['absent', null],
    ['wrong relation', { id: ISSUE, type: 'related', issue: { id: ISSUE }, relatedIssue: { id: RELATED } }],
    ['wrong source', { id: RELATION, type: 'related', issue: { id: RELATED }, relatedIssue: { id: RELATED } }],
    ['wrong target', { id: RELATION, type: 'related', issue: { id: ISSUE }, relatedIssue: { id: ISSUE } }],
    ['reversed endpoints', { id: RELATION, type: 'related', issue: { id: RELATED }, relatedIssue: { id: ISSUE } }],
    ['wrong type', { id: RELATION, type: 'blocks', issue: { id: ISSUE }, relatedIssue: { id: RELATED } }],
  ])('skips the guarded batch delete after %s and never compiles or sends the mutation', async (_case, relation) => {
    const requests: Array<{ query: string }> = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      requests.push(request);
      return response({ data: { _lookup_remove_issueRelation: relation } });
    });
    vi.stubGlobal('fetch', fetch);
    process.env.LINEAR_API_KEY = SECRET;
    const result = await batchDelete();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.query).not.toContain('issueRelationDelete');
    expect(result.details).toMatchObject({
      data: {}, errors: [], skipped: ['remove'], meta: { requests: { read: 1, mutation: 0 } },
    });
  });

  it('accounts a preflight GraphQL failure as skipped and exposes none of the echoed values', async () => {
    const requests: Array<{ query: string }> = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      requests.push(request);
      return response({
        data: { _lookup_remove_issueRelation: null },
        errors: [{ path: ['_lookup_remove_issueRelation'], message: leaked }],
      });
    });
    vi.stubGlobal('fetch', fetch);
    process.env.LINEAR_API_KEY = SECRET;
    const result = await batchDelete();
    expect(requests).toHaveLength(1);
    expect(result.details).toMatchObject({ data: {}, errors: [], skipped: ['remove'] });
    const text = JSON.stringify(result.details);
    for (const secret of [RELATION, ISSUE, RELATED, SECRET]) expect(text).not.toContain(secret);
  });

  it('blocks the guarded mutation after an unexpected-alias read error', async () => {
    const upstreamError = { path: ['unexpected'], message: leaked };
    const requests: Array<{ query: string }> = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      requests.push(request);
      return response({
        data: {
          _lookup_remove_issueRelation: { id: RELATION, type: 'related', issue: { id: ISSUE }, relatedIssue: { id: RELATED } },
        },
        errors: [upstreamError],
      });
    });
    vi.stubGlobal('fetch', fetch);
    process.env.LINEAR_API_KEY = SECRET;
    const result = await batchDelete();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.query).not.toContain('issueRelationDelete');
    expect(result.details).toMatchObject({ data: {}, errors: [], skipped: ['remove'] });
    const text = JSON.stringify(result.details);
    for (const secret of [RELATION, ISSUE, RELATED, SECRET]) expect(text).not.toContain(secret);
  });

  it('blocks the guarded mutation after a pathless read error', async () => {
    const requests: Array<{ query: string }> = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      requests.push(request);
      return response({
        data: {
          _lookup_remove_issueRelation: { id: RELATION, type: 'related', issue: { id: ISSUE }, relatedIssue: { id: RELATED } },
        },
        errors: [{ message: leaked }],
      });
    });
    vi.stubGlobal('fetch', fetch);
    process.env.LINEAR_API_KEY = SECRET;
    const error = await batchDelete().catch((value: Error) => value);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.query).not.toContain('issueRelationDelete');
    expect(error.message).toBe('Linear issue relation delete preflight failed.');
    for (const secret of [RELATION, ISSUE, RELATED, SECRET]) expect(error.message).not.toContain(secret);
  });

  it('uses the existing read-error gate and keeps the guarded mutation unsent', async () => {
    const requests: Array<{ query: string }> = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      requests.push(request);
      return response({
        data: {
          broken: null,
          _lookup_remove_issueRelation: { id: RELATION, type: 'related', issue: { id: ISSUE }, relatedIssue: { id: RELATED } },
        },
        errors: [{ path: ['broken'], message: 'Read failed safely.' }],
      });
    });
    vi.stubGlobal('fetch', fetch);
    process.env.LINEAR_API_KEY = SECRET;
    const result = await batchDelete([{ key: 'broken', operation: 'get_issue', variables: { issue: ISSUE } }]);
    expect(requests).toHaveLength(1);
    expect(result.details).toMatchObject({
      data: {},
      errors: [{ key: 'broken', path: ['broken'], message: 'Read failed safely.' }],
      skipped: ['remove'],
      meta: { requests: { read: 1, mutation: 0 } },
    });
  });

  it.each([
    ['unexpected alias', { path: ['unexpected'], message: leaked }],
    ['pathless', { message: leaked }],
  ])('rejects a false batch acknowledgement after an %s delete error', async (_case, upstreamError) => {
    const requests: Array<{ query: string }> = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      requests.push(request);
      if (request.query.includes('BatchRead')) return response({ data: {
        _lookup_remove_issueRelation: { id: RELATION, type: 'related', issue: { id: ISSUE }, relatedIssue: { id: RELATED } },
      } });
      return response({ data: { remove: { success: true } }, errors: [upstreamError] });
    });
    vi.stubGlobal('fetch', fetch);
    process.env.LINEAR_API_KEY = SECRET;
    const result = await batchDelete();
    expect(requests).toHaveLength(2);
    expect(result.details).toMatchObject({
      data: {},
      errors: [{ key: 'remove', path: ['remove'], message: 'Linear issue relation delete failed.' }],
      skipped: [],
    });
    expect(result.details.data.remove).toBeUndefined();
    const text = JSON.stringify(result.details);
    for (const secret of [RELATION, ISSUE, RELATED, SECRET]) expect(text).not.toContain(secret);
  });

  it('keeps batch delete failures keyed and strips echoed guards and credentials', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const { query } = JSON.parse(String(init.body));
      if (query.includes('BatchRead')) return response({ data: {
        _lookup_remove_issueRelation: { id: RELATION, type: 'related', issue: { id: ISSUE }, relatedIssue: { id: RELATED } },
      } });
      return response({ data: { remove: null }, errors: [{ path: ['remove'], message: leaked }] });
    });
    vi.stubGlobal('fetch', fetch);
    process.env.LINEAR_API_KEY = SECRET;
    const result = await batchDelete();
    expect(result.details).toMatchObject({
      data: {},
      errors: [{ key: 'remove', path: ['remove'], message: 'Linear issue relation delete failed.' }],
      skipped: [],
      meta: { requests: { read: 1, mutation: 1 } },
    });
    const text = JSON.stringify(result.details);
    for (const secret of [RELATION, ISSUE, RELATED, SECRET]) expect(text).not.toContain(secret);
  });

  it('preserves read and mutation phase telemetry for a guarded batch delete', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const { query } = JSON.parse(String(init.body));
      if (query.includes('BatchRead')) return response({ data: {
        _lookup_remove_issueRelation: { id: RELATION, type: 'related', issue: { id: ISSUE }, relatedIssue: { id: RELATED } },
      } }, { 'X-RateLimit-Requests-Remaining': '1' });
      return response({ data: { remove: { success: true } } }, { 'X-RateLimit-Complexity-Remaining': '1' });
    });
    vi.stubGlobal('fetch', fetch);
    process.env.LINEAR_API_KEY = SECRET;
    const result = await batchDelete();
    expect(result.details.meta.rateLimit.responses).toEqual([
      { phase: 'read', attempt: 1, 'X-RateLimit-Requests-Remaining': 1 },
      { phase: 'mutation', attempt: 1, 'X-RateLimit-Complexity-Remaining': 1 },
    ]);
  });

  it('aggregates near-exhaustion telemetry with read and mutation phase identity', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const { query } = JSON.parse(String(init.body));
      return query.includes('VerifyIssueRelationDelete')
        ? response({ data: { issueRelation: { id: RELATION, type: 'related', issue: { id: ISSUE }, relatedIssue: { id: RELATED } } } }, { 'X-RateLimit-Requests-Remaining': '1' })
        : response({ data: { issueRelationDelete: { success: true } } }, { 'X-RateLimit-Complexity-Remaining': '1' });
    });
    vi.stubGlobal('fetch', fetch);
    process.env.LINEAR_API_KEY = SECRET;
    const result = await execute({ operation: 'delete_issue_relation', variables });
    expect(result.details.data.issueRelationDelete.deleted).toBe(true);
    expect(result.details.meta.rateLimit.responses).toEqual([
      { phase: 'read', attempt: 1, 'X-RateLimit-Requests-Remaining': 1 },
      { phase: 'mutation', attempt: 1, 'X-RateLimit-Complexity-Remaining': 1 },
    ]);
  });
});
