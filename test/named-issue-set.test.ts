import { afterEach, describe, expect, it, vi } from 'vitest';
import { linearApiTool } from '../extensions/api';
import { operations } from '../extensions/operations';
import { projection } from '../extensions/selections';
import { isolateLinearCredentials } from './helpers/credentials';
import { prepareOperation } from './helpers/operation-plan';

isolateLinearCredentials();

const ISSUE_A = '11111111-1111-4111-8111-111111111111';
const ISSUE_B = '22222222-2222-4222-8222-222222222222';
const TEAM_ID = '33333333-3333-4333-8333-333333333333';
const originalKey = process.env.LINEAR_API_KEY;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalKey === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = originalKey;
});

function execute(params: Record<string, unknown>) {
  return (linearApiTool() as any).execute('call-1', params, undefined, undefined, { hasUI: false });
}

function graphqlStub(
  responder: (query: string, variables: Record<string, unknown>) => Record<string, unknown>,
) {
  const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    requests.push(request);
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      json: async () => ({ data: responder(request.query, request.variables) }),
    };
  });
  vi.stubGlobal('fetch', fetch);
  process.env.LINEAR_API_KEY = 'test-key';
  return { fetch, requests };
}

function issueNode(id: string, identifier: string) {
  return { id, identifier, title: identifier, team: { id: TEAM_ID, key: 'AEO' } };
}

async function prepare(variables: Record<string, unknown>) {
  return prepareOperation(operations.list_issues!, variables);
}

describe('list_issues named issue set', () => {
  it('reads several identifiers with one issues filter request', async () => {
    const { requests } = graphqlStub((query, variables) => {
      expect(query).toContain('query ListIssues');
      expect(query).toContain('issues(');
      expect(query).toContain(projection('issue', 'list'));
      expect(query).not.toContain('searchIssues');
      expect(query).not.toContain('issue(id: $id)');
      expect(query).not.toContain('ResolveIssue');
      expect(variables.filter).toEqual({ id: { in: ['AEO-258', 'AEO-362'] } });
      expect(variables.id).toBeUndefined();
      return {
        issues: {
          nodes: [issueNode(ISSUE_A, 'AEO-258'), issueNode(ISSUE_B, 'AEO-362')],
          pageInfo: { hasNextPage: false },
        },
      };
    });

    const result = await execute({
      operation: 'list_issues',
      variables: { issues: ['AEO-258', 'AEO-362'] },
    });

    expect(requests).toHaveLength(1);
    expect(result.details.meta.view).toBe('summary');
    expect(result.details.data.issues.nodes.map((node: { identifier: string }) => node.identifier))
      .toEqual(['AEO-258', 'AEO-362']);
  });

  it('sends lowercase identifiers through id.in without a preflight lookup', async () => {
    const { requests } = graphqlStub((query, variables) => {
      expect(query).not.toContain('ResolveIssue');
      expect(variables.filter).toEqual({ id: { in: ['aeo-258', 'AEO-362'] } });
      return {
        issues: {
          nodes: [issueNode(ISSUE_A, 'AEO-258'), issueNode(ISSUE_B, 'AEO-362')],
          pageInfo: { hasNextPage: false },
        },
      };
    });

    await execute({
      operation: 'list_issues',
      variables: { issues: ['aeo-258', 'AEO-362'] },
    });
    expect(requests).toHaveLength(1);
  });

  it('accepts mixed identifiers and UUIDs in one id.in filter', async () => {
    const prepared = await prepare({ issues: ['AEO-258', ISSUE_B] });
    expect(prepared.variables).toEqual({
      first: 20,
      filter: { id: { in: ['AEO-258', ISSUE_B] } },
    });
  });

  it('ANDs the identifier set with other convenience filters', async () => {
    const { requests } = graphqlStub((query, variables) => {
      if (query.includes('ResolveTeamByKey')) {
        expect(variables).toEqual({ key: 'AEO' });
        return { teams: { nodes: [{ id: TEAM_ID, key: 'AEO' }] } };
      }
      expect(query).toContain('query ListIssues');
      expect(variables.filter).toEqual({
        id: { in: ['AEO-258', 'AEO-362'] },
        team: { id: { eq: TEAM_ID } },
      });
      return { issues: { nodes: [issueNode(ISSUE_A, 'AEO-258')], pageInfo: { hasNextPage: false } } };
    });

    await execute({
      operation: 'list_issues',
      variables: { issues: ['AEO-258', 'AEO-362'], team: 'AEO' },
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]!.query).toContain('ResolveTeamByKey');
    expect(requests[1]!.query).toContain('query ListIssues');
  });

  it('ANDs the identifier set with a caller filter', async () => {
    const prepared = await prepare({
      issues: ['AEO-258', 'AEO-362'],
      filter: { priority: { eq: 1 } },
    });
    expect(prepared.variables.filter).toEqual({
      and: [
        { priority: { eq: 1 } },
        { id: { in: ['AEO-258', 'AEO-362'] } },
      ],
    });
  });

  it('widens to the full issue projection when view is full', async () => {
    const { requests } = graphqlStub((query, variables) => {
      expect(query).toContain(projection('issue', 'detail'));
      expect(query).toContain('description');
      expect(variables.filter).toEqual({ id: { in: ['AEO-258'] } });
      expect(variables.view).toBeUndefined();
      return { issues: { nodes: [issueNode(ISSUE_A, 'AEO-258')], pageInfo: { hasNextPage: false } } };
    });

    const result = await execute({
      operation: 'list_issues',
      variables: { issues: ['AEO-258'], view: 'full' },
    });
    expect(requests).toHaveLength(1);
    expect(result.details.meta.view).toBe('full');
  });

  it('rejects empty, invalid, and duplicate-conflicting identifiers before any network call', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    process.env.LINEAR_API_KEY = 'test-key';
    const tool = linearApiTool() as any;

    await expect(tool.execute(
      'call',
      { operation: 'list_issues', variables: { issues: [] } },
      undefined,
      undefined,
      { hasUI: false },
    )).rejects.toThrow('issues must contain at least one issue identifier or UUID');

    await expect(tool.execute(
      'call',
      { operation: 'list_issues', variables: { issues: 'AEO-258' } },
      undefined,
      undefined,
      { hasUI: false },
    )).rejects.toThrow('issues must be an array of issue identifiers or UUIDs');

    await expect(tool.execute(
      'call',
      { operation: 'list_issues', variables: { issues: ['login-bug'] } },
      undefined,
      undefined,
      { hasUI: false },
    )).rejects.toThrow('Invalid Linear issue reference "login-bug". Use TEAM-123 or a UUID.');

    await expect(tool.execute(
      'call',
      { operation: 'list_issues', variables: { issues: ['AEO-258', 'aeo-258'] } },
      undefined,
      undefined,
      { hasUI: false },
    )).rejects.toThrow('Duplicate Linear issue reference "aeo-258"');

    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps identifier-shaped search_issues on the singular issue root', async () => {
    const { requests } = graphqlStub((query, variables) => {
      expect(query).toContain('issue(id: $id)');
      expect(query).not.toContain('searchIssues');
      expect(query).not.toContain('id: { in:');
      expect(variables).toEqual({ id: 'AEO-258' });
      return { issue: issueNode(ISSUE_A, 'AEO-258') };
    });

    await execute({ operation: 'search_issues', variables: { term: 'AEO-258' } });
    expect(requests).toHaveLength(1);
  });

  it('leaves ordinary list_issues filters on the issues root without id.in', async () => {
    const prepared = await prepare({ stateType: 'started' });
    expect(prepared.variables).toEqual({
      first: 20,
      filter: { state: { type: { eq: 'started' } } },
    });
  });
});
