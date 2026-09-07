import { afterEach, describe, expect, it, vi } from 'vitest';
import { linearBatchTool, resolveRequest } from '../extensions/api';
import { linearErrorTelemetry } from '../extensions/client';
import { failureLine, recoveryLine } from '../extensions/failure-message';
import { getOperation, operations } from '../extensions/operations';
import { operationRenderers } from '../extensions/renderers';
import { SAFE_NAMED_MUTATION_ROOTS } from '../extensions/safety';
import { typedLinearTools } from '../extensions/typed-tools';
import { isolateLinearCredentials } from './helpers/credentials';
import { executeTyped } from './helpers/typed-execution';
import type { CompatibilityObject } from '../extensions/operation-types';

isolateLinearCredentials();

const ISSUE = '11111111-1111-4111-8111-111111111111';
const RELATED = '22222222-2222-4222-8222-222222222222';
const RELATION = '33333333-3333-4333-8333-333333333333';
const SECRET = 'lin_api_secret123456789abcdef';
const variables = { relationId: RELATION, issueId: ISSUE, relatedIssueId: RELATED, type: 'related' };
const originalKey = process.env.LINEAR_API_KEY;
const originalMutations = process.env.LINEAR_MUTATIONS;
const originalReadonly = process.env.LINEAR_READONLY;
const theme = {
  fg: (_role: string, text: string) => text,
  bg: (_role: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
} as any;

function execute(input: { operation: string; variables?: CompatibilityObject }, mode: 'allowlist' | 'readonly' = 'allowlist') {
  if (input.operation === 'batch') {
    return (linearBatchTool(mode) as any).execute('call', input.variables, undefined, undefined, { hasUI: false });
  }
  return executeTyped(input.operation, input.variables, { mode });
}

function executeWithSignal(input: { operation: string; variables?: CompatibilityObject }, signal: AbortSignal) {
  if (input.operation === 'batch') {
    return (linearBatchTool('allowlist') as any).execute('call', input.variables, signal, undefined, { hasUI: false });
  }
  return executeTyped(input.operation, input.variables, { signal });
}

function response(body: CompatibilityObject, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function successStub(relation: CompatibilityObject | null = {
  id: RELATION,
  type: 'related',
  issue: { id: ISSUE },
  relatedIssue: { id: RELATED },
}) {
  const requests: Array<{ query: string; variables: CompatibilityObject }> = [];
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
  it('publishes four exact required guards plus the result view and rejects malformed or unknown fields with zero network calls', async () => {
    const operation = operations.delete_issue_relation;
    expect(operation.parameters).toEqual([
      { name: 'relationId', type: 'UUID', required: true },
      { name: 'issueId', type: 'UUID', required: true },
      { name: 'relatedIssueId', type: 'UUID', required: true },
      { name: 'type', type: 'IssueRelationType', required: true },
      { name: 'view', type: 'ResultView', required: false },
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
    expect(() => resolveRequest({ operation: 'delete_issue_relation', variables: { ...variables, relationId: 'bad' } }))
      .toThrow('Invalid relationId: expected a UUID.');
    expect(() => resolveRequest({ operation: 'delete_issue_relation', variables: { ...variables, input: {} } }))
      .toThrow('Invalid parameters for "delete_issue_relation": unknown input.');
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

    const rendered = operationRenderers(getOperation('delete_issue_relation')).renderResult(
      result,
      { expanded: false, isPartial: false },
      theme,
      { args: variables } as any,
    ).render(200).join('\n');
    expect(rendered).toContain('✓ Deleted relation');
    expect(rendered).not.toContain('status unknown');
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
    expect(failureLine(error)).toBe('Linear issue relation delete preflight failed.');
    expect(recoveryLine(error)).not.toBe('');
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
    expect(failureLine(error)).toBe('Linear issue relation delete failed.');
    expect(recoveryLine(error)).not.toBe('');
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
    expect(failureLine(error)).toBe('Linear issue relation delete failed.');
    expect(recoveryLine(error)).not.toBe('');
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

  function batchDelete(reads: CompatibilityObject[] = []) {
    const payload: CompatibilityObject = {
      mutations: [{ key: 'remove', operation: 'delete_issue_relation', variables }],
    };
    if (reads.length) payload.reads = reads;
    return execute({ operation: 'batch', variables: payload });
  }

  it('folds a guarded preflight beside reads, then returns the keyed acknowledgement', async () => {
    const requests: Array<{ query: string; variables: CompatibilityObject }> = [];
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

  it.each([
    ['two', ['_lookup_delete_issue_relation_issueRelation', '_lookup_delete_issue_relation_2_issueRelation']],
    ['three', ['_lookup_delete_issue_relation_issueRelation', '_lookup_delete_issue_relation_2_issueRelation', '_lookup_delete_issue_relation_3_issueRelation']],
  ])('monotonically allocates past %s consecutive guarded-read aliases', async (_count, reserved) => {
    const reservedCount = reserved.length;
    const effectiveMutationKey = `delete_issue_relation_${reservedCount + 1}`;
    const effectiveLookupKey = `_lookup_${effectiveMutationKey}_issueRelation`;
    const requests: Array<{ query: string }> = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      requests.push(request);
      if (request.query.includes('BatchRead')) return response({ data: {
        ...Object.fromEntries(reserved.map((key, index) => [key, { id: index ? RELATED : ISSUE, identifier: `AEO-${index + 1}`, title: 'Read' }])),
        [effectiveLookupKey]: { id: RELATION, type: 'related', issue: { id: ISSUE }, relatedIssue: { id: RELATED } },
      } });
      return response({ data: { [effectiveMutationKey]: { success: true } } });
    });
    vi.stubGlobal('fetch', fetch);
    process.env.LINEAR_API_KEY = SECRET;
    const result = await execute({
      operation: 'batch',
      variables: {
        reads: reserved.map((key, index) => ({ key, operation: 'get_issue', variables: { issue: index ? RELATED : ISSUE } })),
        mutations: [{ operation: 'delete_issue_relation', variables }],
      },
    });
    const accounted = [
      ...Object.keys(result.details.data),
      ...result.details.errors.map((error: { key: string }) => error.key),
      ...result.details.skipped,
    ];
    expect(requests).toHaveLength(2);
    expect(requests[0]!.query).toContain(`${effectiveLookupKey}: issueRelation`);
    expect(requests[1]!.query).toContain(`${effectiveMutationKey}: issueRelationDelete`);
    expect(Object.keys(result.details.data)).toEqual([...reserved, effectiveMutationKey]);
    expect(new Set(accounted).size).toBe(reservedCount + 1);
    expect(accounted).toEqual([...reserved, effectiveMutationKey]);
    expect(result.details.errors).toEqual([]);
    expect(result.details.skipped).toEqual([]);
    expect(result.details.meta.requests).toEqual({ read: 1, mutation: 1 });
  });

  it.each([
    ['absent', null],
    ['wrong relation', { id: ISSUE, type: 'related', issue: { id: ISSUE }, relatedIssue: { id: RELATED } }],
    ['wrong source', { id: RELATION, type: 'related', issue: { id: RELATED }, relatedIssue: { id: RELATED } }],
    ['wrong target', { id: RELATION, type: 'related', issue: { id: ISSUE }, relatedIssue: { id: ISSUE } }],
    ['reversed endpoints', { id: RELATION, type: 'related', issue: { id: RELATED }, relatedIssue: { id: ISSUE } }],
    ['wrong type', { id: RELATION, type: 'blocks', issue: { id: ISSUE }, relatedIssue: { id: RELATED } }],
  ])('classifies the guarded batch delete after %s and never compiles or sends the mutation', async (_case, relation) => {
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
      data: {},
      errors: [{ key: 'remove', message: 'Linear issue relation did not match the exact delete guard.' }],
      skipped: [],
      meta: { requests: { read: 1, mutation: 0 } },
    });
  });

  it('accounts a preflight GraphQL failure as one stable error and exposes none of the echoed values', async () => {
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
    expect(result.details).toMatchObject({
      data: {},
      errors: [{ key: 'remove', message: 'Linear issue relation delete preflight failed.' }],
      skipped: [],
    });
    const text = JSON.stringify(result.details);
    for (const secret of [RELATION, ISSUE, RELATED, SECRET]) expect(text).not.toContain(secret);
  });

  it('attributes an unexpected-path preflight error to the guarded mutation', async () => {
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
    expect(result.details).toMatchObject({
      data: {},
      errors: [{ key: 'remove', path: ['remove'], message: 'Linear issue relation delete preflight failed.' }],
      skipped: [],
      meta: { requests: { read: 1, mutation: 0 } },
    });
    const text = JSON.stringify(result.details);
    for (const secret of [RELATION, ISSUE, RELATED, SECRET]) expect(text).not.toContain(secret);
  });

  it('attributes a pathless preflight error to the guarded mutation', async () => {
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
    const result = await batchDelete();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.query).not.toContain('issueRelationDelete');
    expect(result.details).toMatchObject({
      data: {},
      errors: [{ key: 'remove', path: ['remove'], message: 'Linear issue relation delete preflight failed.' }],
      skipped: [],
      meta: { requests: { read: 1, mutation: 0 } },
    });
    const text = JSON.stringify(result.details);
    for (const secret of [RELATION, ISSUE, RELATED, SECRET]) expect(text).not.toContain(secret);
  });

  it.each(['network', 'http', 'non-json', 'cancel'] as const)(
    'preserves top-level %s failure behavior for guarded preflight',
    async (failureKind) => {
      const controller = new AbortController();
      const requests: Array<{ query: string }> = [];
      const fetch = vi.fn(async (_url: string, init: RequestInit) => {
        const request = JSON.parse(String(init.body));
        requests.push(request);
        if (failureKind === 'network') throw new Error('guard socket closed');
        if (failureKind === 'http') return new Response('{}', { status: 503, statusText: 'Unavailable' });
        if (failureKind === 'non-json') return new Response('not json', { status: 200 });
        controller.abort();
        throw new Error('guard cancelled');
      });
      vi.stubGlobal('fetch', fetch);
      process.env.LINEAR_API_KEY = SECRET;
      const input = {
        operation: 'batch',
        variables: { mutations: [{ key: 'remove', operation: 'delete_issue_relation', variables }] },
      };
      const promise = failureKind === 'cancel'
        ? executeWithSignal(input, controller.signal)
        : execute(input);
      await expect(promise).rejects.toThrow(/Linear|guard|cancelled|data/i);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.query).not.toContain('issueRelationDelete');
    },
  );

  it('preserves a successful caller read when an unowned preflight error belongs to the guard', async () => {
    const requests: Array<{ query: string }> = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      requests.push(request);
      return response({
        data: {
          keep: { id: ISSUE, identifier: 'AEO-258', team: { id: 'team-id', key: 'AEO' } },
          _lookup_remove_issueRelation: { id: RELATION, type: 'related', issue: { id: ISSUE }, relatedIssue: { id: RELATED } },
        },
        errors: [{ message: leaked }],
      });
    });
    vi.stubGlobal('fetch', fetch);
    process.env.LINEAR_API_KEY = SECRET;
    const result = await batchDelete([{ key: 'keep', operation: 'get_issue', variables: { issue: 'AEO-258' } }]);
    expect(requests).toHaveLength(1);
    expect(result.details).toMatchObject({
      data: { keep: { issue: { id: ISSUE, identifier: 'AEO-258' } } },
      errors: [{ key: 'remove', path: ['remove'], message: 'Linear issue relation delete preflight failed.' }],
      skipped: [],
      meta: { requests: { read: 1, mutation: 0 } },
    });
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
