import { afterEach, describe, expect, it, vi } from 'vitest';
import { linearApiTool } from '../extensions/api';
import type { MutationMode } from '../extensions/safety';
import { isolateLinearCredentials } from './helpers/credentials';

isolateLinearCredentials();

const ISSUE_A = '11111111-1111-4111-8111-111111111111';
const ISSUE_B = '22222222-2222-4222-8222-222222222222';
const TEAM_ID = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'lin_api_secret123456789abcdef';
const originalKey = process.env.LINEAR_API_KEY;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalKey === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = originalKey;
});

function execute(params: Record<string, unknown>, mode: MutationMode = 'allowlist') {
  return (linearApiTool(mode) as any).execute('call-1', params, undefined, undefined, { hasUI: false });
}

function batch(reads: unknown[], extra: Record<string, unknown> = {}) {
  return execute({ operation: 'batch', variables: { reads, ...extra } });
}

function issueNode(id: string, identifier: string, title = 'Fix login') {
  return { id, identifier, title, team: { id: TEAM_ID, key: 'AEO' } };
}

function graphqlStub(respond: (request: { query: string; variables: Record<string, unknown> }) => {
  ok?: boolean;
  status?: number;
  statusText?: string;
  body?: unknown;
  json?: boolean;
  throw?: Error;
}) {
  const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    requests.push(request);
    const outcome = respond(request);
    if (outcome.throw) throw outcome.throw;
    if (outcome.json === false) {
      return {
        ok: outcome.ok ?? false,
        status: outcome.status ?? 502,
        statusText: outcome.statusText ?? 'Bad Gateway',
        headers: new Headers(),
        json: async () => { throw new Error('not json'); },
      };
    }
    return {
      ok: outcome.ok ?? true,
      status: outcome.status ?? 200,
      statusText: outcome.statusText ?? 'OK',
      headers: new Headers(),
      json: async () => outcome.body ?? { data: {} },
    };
  });
  vi.stubGlobal('fetch', fetch);
  process.env.LINEAR_API_KEY = 'test-key';
  return { fetch, requests };
}

describe('batch help and catalog', () => {
  it('returns a batch parameter card without network access or typed-tool activation', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const result = await execute({ operation: 'help', variables: { operation: 'batch' } });
    expect(fetch).not.toHaveBeenCalled();
    expect(result.details.name).toBe('batch');
    expect(result.details.loadedTools).toBeUndefined();
    expect(result.details.parameters).toEqual(
      expect.arrayContaining([
        { name: 'reads', type: 'BatchEntry[]', required: false },
        { name: 'mutations', type: 'BatchEntry[]', required: false },
      ]),
    );
    expect(result.details.example).toMatchObject({ operation: 'batch' });
  });

  it('publishes batch in the linear tool description without changing the TypeBox parameters', () => {
    const tool = linearApiTool() as any;
    expect(tool.description).toContain('batch: Carry several independent named reads in one GraphQL request.');
    expect(Object.keys(tool.parameters.properties).sort()).toEqual(['operation', 'query', 'sink', 'variables', 'workspace']);
  });
});

describe('batch read phase', () => {
  it('carries two compatible read aliases in one GraphQL request', async () => {
    const { requests } = graphqlStub((request) => {
      expect(request.query).toContain('one: issue');
      expect(request.query).toContain('two: issue');
      expect(request.variables).toMatchObject({ one_id: 'AEO-1', two_id: 'AEO-2' });
      return {
        body: {
          data: {
            one: issueNode(ISSUE_A, 'AEO-1'),
            two: issueNode(ISSUE_B, 'AEO-2'),
          },
        },
      };
    });

    const result = await batch([
      { key: 'one', operation: 'get_issue', variables: { issue: 'AEO-1' } },
      { key: 'two', operation: 'get_issue', variables: { issue: 'AEO-2' } },
    ]);

    expect(requests).toHaveLength(1);
    expect(result.details).toMatchObject({
      data: {
        one: { issue: issueNode(ISSUE_A, 'AEO-1') },
        two: { issue: issueNode(ISSUE_B, 'AEO-2') },
      },
      errors: [],
      skipped: [],
      meta: { requests: { read: 1, mutation: 0 } },
    });
  });

  it('repeats the same operation name under unique keys', async () => {
    const { requests } = graphqlStub((request) => ({
      body: {
        data: {
          first: issueNode(ISSUE_A, 'AEO-1'),
          second: issueNode(ISSUE_B, 'AEO-2'),
        },
      },
    }));

    const result = await batch([
      { key: 'first', operation: 'get_issue', variables: { issue: 'AEO-1' } },
      { key: 'second', operation: 'get_issue', variables: { issue: 'AEO-2' } },
    ]);

    expect(requests).toHaveLength(1);
    expect(Object.keys(result.details.data)).toEqual(['first', 'second']);
  });

  it('keeps a successful alias when a sibling path fails', async () => {
    graphqlStub(() => ({
      body: {
        data: {
          ready: issueNode(ISSUE_A, 'AEO-1'),
          missing: null,
        },
        errors: [{ message: 'Entity not found: Issue', path: ['missing'] }],
      },
    }));

    const result = await batch([
      { key: 'ready', operation: 'get_issue', variables: { issue: 'AEO-1' } },
      { key: 'missing', operation: 'get_issue', variables: { issue: 'AEO-2' } },
    ]);

    expect(result.details.data).toEqual({ ready: { issue: issueNode(ISSUE_A, 'AEO-1') } });
    expect(result.details.errors).toEqual([
      { key: 'missing', path: ['missing'], message: 'Entity not found: Issue' },
    ]);
    expect(result.details.skipped).toEqual([]);
    expect(result.details.meta.requests).toEqual({ read: 1, mutation: 0 });
  });

  it('rejects duplicate, invalid, and empty keys before network access', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    process.env.LINEAR_API_KEY = 'test-key';

    await expect(batch([])).rejects.toThrow(/non-empty|reads/i);
    await expect(batch([
      { key: 'one', operation: 'get_issue', variables: { issue: 'AEO-1' } },
      { key: 'one', operation: 'get_issue', variables: { issue: 'AEO-2' } },
    ])).rejects.toThrow(/unique|duplicate/i);
    await expect(batch([
      { key: '1bad', operation: 'get_issue', variables: { issue: 'AEO-1' } },
    ])).rejects.toThrow(/alias|key/i);
    await expect(batch([
      { key: 'a-b', operation: 'get_issue', variables: { issue: 'AEO-1' } },
    ])).rejects.toThrow(/alias|key/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects raw, help, batch, local, and mutation entries before network access', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    process.env.LINEAR_API_KEY = 'test-key';

    await expect(batch([{ key: 'help', operation: 'help', variables: {} }])).rejects.toThrow(/named GraphQL/i);
    await expect(batch([{ key: 'again', operation: 'batch', variables: { reads: [] } }])).rejects.toThrow(/named GraphQL/i);
    await expect(batch([{ key: 'local', operation: 'switch_workspace', variables: { name: 'main' } }])).rejects.toThrow(/local|named GraphQL/i);
    await expect(batch([{ key: 'write', operation: 'create_issue', variables: { title: 'X', team: 'AEO' } }])).rejects.toThrow(/query|mutation/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a read whose prepare would call Linear', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    process.env.LINEAR_API_KEY = 'test-key';

    await expect(batch([
      { key: 'issues', operation: 'list_issues', variables: { team: 'AEO' } },
    ])).rejects.toThrow(/preparation|fold/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('redacts credentials from successful batch data', async () => {
    graphqlStub(() => ({
      body: {
        data: {
          one: issueNode(ISSUE_A, 'AEO-1', `see ${TOKEN}`),
        },
      },
    }));

    const result = await batch([
      { key: 'one', operation: 'get_issue', variables: { issue: 'AEO-1' } },
    ]);
    const text = JSON.stringify(result.details);
    expect(text).not.toContain(TOKEN);
    expect(text).toContain('[REDACTED]');
  });

  it('preserves network, HTTP, and non-JSON failures', async () => {
    graphqlStub(() => ({ throw: new Error('socket closed') }));
    await expect(batch([
      { key: 'one', operation: 'get_issue', variables: { issue: 'AEO-1' } },
    ])).rejects.toThrow('Linear network error: socket closed');

    graphqlStub(() => ({ ok: false, status: 502, statusText: 'Bad Gateway', json: false }));
    await expect(batch([
      { key: 'one', operation: 'get_issue', variables: { issue: 'AEO-1' } },
    ])).rejects.toThrow('Linear API request failed: 502 Bad Gateway');
  });

  it('leaves the single-operation path unchanged', async () => {
    const { requests } = graphqlStub((request) => {
      expect(request.query).toContain('query GetIssue');
      expect(request.query).not.toContain('BatchRead');
      expect(request.variables).toEqual({ id: 'AEO-1' });
      return { body: { data: { issue: issueNode(ISSUE_A, 'AEO-1') } } };
    });

    const result = await execute({ operation: 'get_issue', variables: { issue: 'AEO-1' } });
    expect(requests).toHaveLength(1);
    expect(result.details.data.issue).toEqual(issueNode(ISSUE_A, 'AEO-1'));
    expect(result.details).not.toHaveProperty('skipped');
    expect(result.details).not.toHaveProperty('errors');
  });
});

describe('batch mutation phase', () => {
  const updated = issueNode(ISSUE_A, 'AEO-1', 'New title');

  function mutationEntry(key = 'edit') {
    return { key, operation: 'update_issue', variables: { issue: 'AEO-1', title: 'New title' } };
  }

  it('runs a mutation-only batch as one mutation request', async () => {
    const { requests } = graphqlStub((request) => {
      expect(request.query).toMatch(/mutation/);
      expect(request.query).toContain('edit: issueUpdate');
      return { body: { data: { edit: { success: true, issue: updated } } } };
    });

    const result = await execute({
      operation: 'batch',
      variables: { mutations: [mutationEntry()] },
    });

    expect(requests).toHaveLength(1);
    expect(result.details.data.edit).toEqual({ issueUpdate: { success: true, issue: updated } });
    expect(result.details.errors).toEqual([]);
    expect(result.details.skipped).toEqual([]);
    expect(result.details.meta.requests).toEqual({ read: 0, mutation: 1 });
  });

  it('runs reads then one mutation when both phases succeed', async () => {
    const { requests } = graphqlStub((request) => {
      if (request.query.includes('issueUpdate')) {
        return { body: { data: { edit: { success: true, issue: updated } } } };
      }
      return { body: { data: { one: issueNode(ISSUE_A, 'AEO-1') } } };
    });

    const result = await execute({
      operation: 'batch',
      variables: {
        reads: [{ key: 'one', operation: 'get_issue', variables: { issue: 'AEO-1' } }],
        mutations: [mutationEntry()],
      },
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]!.query).toContain('one: issue');
    expect(requests[1]!.query).toContain('edit: issueUpdate');
    expect(result.details.data).toEqual({
      one: { issue: issueNode(ISSUE_A, 'AEO-1') },
      edit: { issueUpdate: { success: true, issue: updated } },
    });
    expect(result.details.skipped).toEqual([]);
    expect(result.details.meta.requests).toEqual({ read: 1, mutation: 1 });
  });

  it('skips the mutation when a read alias fails', async () => {
    const { requests } = graphqlStub((request) => {
      expect(request.query).not.toMatch(/mutation/);
      return {
        body: {
          data: { ready: issueNode(ISSUE_A, 'AEO-1'), missing: null },
          errors: [{ message: 'Entity not found: Issue', path: ['missing'] }],
        },
      };
    });

    const result = await execute({
      operation: 'batch',
      variables: {
        reads: [
          { key: 'ready', operation: 'get_issue', variables: { issue: 'AEO-1' } },
          { key: 'missing', operation: 'get_issue', variables: { issue: 'AEO-2' } },
        ],
        mutations: [mutationEntry()],
      },
    });

    expect(requests).toHaveLength(1);
    expect(result.details.data).toEqual({ ready: { issue: issueNode(ISSUE_A, 'AEO-1') } });
    expect(result.details.errors).toEqual([
      { key: 'missing', path: ['missing'], message: 'Entity not found: Issue' },
    ]);
    expect(result.details.skipped).toEqual(['edit']);
    expect(result.details.meta.requests).toEqual({ read: 1, mutation: 0 });
  });

  it('rejects mutations in read-only mode before network access', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    process.env.LINEAR_API_KEY = 'test-key';
    await expect(execute({
      operation: 'batch',
      variables: { mutations: [mutationEntry()] },
    }, 'readonly')).rejects.toThrow(/read-only/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects destructive named input before network access', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    process.env.LINEAR_API_KEY = 'test-key';
    await expect(execute({
      operation: 'batch',
      variables: {
        mutations: [{
          key: 'edit',
          operation: 'update_issue',
          variables: { issue: 'AEO-1', input: { title: 'New title', trashed: true } },
        }],
      },
    })).rejects.toThrow(/trashed|destructive/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a mutation whose prepare would call Linear', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    process.env.LINEAR_API_KEY = 'test-key';
    await expect(execute({
      operation: 'batch',
      variables: {
        mutations: [{ key: 'write', operation: 'create_issue', variables: { title: 'X', team: 'AEO' } }],
      },
    })).rejects.toThrow(/preparation|fold/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects two mutations and create-only transaction sets before network access', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    process.env.LINEAR_API_KEY = 'test-key';
    await expect(execute({
      operation: 'batch',
      variables: {
        mutations: [mutationEntry('one'), mutationEntry('two')],
      },
    })).rejects.toThrow(/one ordinary named mutation/i);
    await expect(execute({
      operation: 'batch',
      variables: {
        mutations: [
          { key: 'a', operation: 'create_issue', variables: { title: 'A', team: 'AEO' } },
          { key: 'b', operation: 'create_issue', variables: { title: 'B', team: 'AEO' } },
        ],
      },
    })).rejects.toThrow(/Transactional create support is not yet implemented/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps successful reads when the mutation alias has a path error', async () => {
    const { requests } = graphqlStub((request) => {
      if (request.query.includes('issueUpdate')) {
        return {
          body: {
            data: { edit: null },
            errors: [{ message: 'Issue not found', path: ['edit'] }],
          },
        };
      }
      return { body: { data: { one: issueNode(ISSUE_A, 'AEO-1') } } };
    });

    const result = await execute({
      operation: 'batch',
      variables: {
        reads: [{ key: 'one', operation: 'get_issue', variables: { issue: 'AEO-1' } }],
        mutations: [mutationEntry()],
      },
    });

    expect(requests).toHaveLength(2);
    expect(result.details.data).toEqual({ one: { issue: issueNode(ISSUE_A, 'AEO-1') } });
    expect(result.details.errors).toEqual([
      { key: 'edit', path: ['edit'], message: 'Issue not found' },
    ]);
    expect(result.details.skipped).toEqual([]);
    expect(result.details.meta.requests).toEqual({ read: 1, mutation: 1 });
  });

  it('preserves mutation transport failures', async () => {
    graphqlStub((request) => {
      if (request.query.includes('issueUpdate')) return { throw: new Error('socket closed') };
      return { body: { data: { one: issueNode(ISSUE_A, 'AEO-1') } } };
    });
    await expect(execute({
      operation: 'batch',
      variables: {
        reads: [{ key: 'one', operation: 'get_issue', variables: { issue: 'AEO-1' } }],
        mutations: [mutationEntry()],
      },
    })).rejects.toThrow('Linear network error: socket closed');
  });
});
