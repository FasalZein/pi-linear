import { afterEach, describe, expect, it, vi } from 'vitest';
import { linearApiTool } from '../extensions/api';
import { operations } from '../extensions/operations';
import { isolateLinearCredentials } from './helpers/credentials';
import { prepareOperation } from './helpers/operation-plan';

isolateLinearCredentials();

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const TEAM_ID = '33333333-3333-4333-8333-333333333333';
const FOREIGN_TEAM_ID = '77777777-7777-4777-8777-777777777777';
const STATE_ID = '44444444-4444-4444-8444-444444444444';
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

function issueNode(id = ISSUE_ID, identifier = 'AEO-258') {
  return { id, identifier, title: 'Fix login', team: { id: TEAM_ID, key: 'AEO' } };
}

describe('direct issue identifier routing', () => {
  it.each(['AEO-258', 'aeo-258'])('reads %s with one GetIssue request', async (reference) => {
    const { requests } = graphqlStub((query, variables) => {
      expect(query).toContain('query GetIssue');
      expect(query).toContain('issue(id: $id)');
      expect(query).not.toContain('searchIssues');
      expect(query).not.toContain('issues(first:');
      expect(variables).toEqual({ id: reference });
      return { issue: issueNode() };
    });

    const result = await execute({ operation: 'get_issue', variables: { issue: reference } });

    expect(requests).toHaveLength(1);
    expect(result.details.resolution.target).toEqual({
      requested: reference,
      resolvedId: ISSUE_ID,
      identifier: 'AEO-258',
    });
  });

  it('reads an issue UUID with one GetIssue request', async () => {
    const { requests } = graphqlStub((query, variables) => {
      expect(query).toContain('query GetIssue');
      expect(variables).toEqual({ id: ISSUE_ID });
      return { issue: issueNode() };
    });

    await execute({ operation: 'get_issue', variables: { issue: ISSUE_ID } });
    expect(requests).toHaveLength(1);
  });

  it('updates an identifier target with one issueUpdate request', async () => {
    const { requests } = graphqlStub((query, variables) => {
      expect(query).toContain('mutation UpdateIssue');
      expect(query).toContain('issueUpdate(id: $id, input: $input)');
      expect(query).not.toContain('searchIssues');
      expect(variables).toEqual({ id: 'AEO-258', input: { title: 'New title' } });
      return { issueUpdate: { success: true, issue: issueNode() } };
    });

    const result = await execute({
      operation: 'update_issue',
      variables: { issue: 'AEO-258', title: 'New title' },
    });

    expect(requests).toHaveLength(1);
    expect(result.details.resolution.target).toEqual({
      requested: 'AEO-258',
      resolvedId: ISSUE_ID,
      identifier: 'AEO-258',
    });
  });

  it('rejects a mismatched identifier on get_issue without a second request', async () => {
    const { requests } = graphqlStub(() => ({ issue: issueNode(ISSUE_ID, 'AEO-999') }));
    await expect(execute({ operation: 'get_issue', variables: { issue: 'AEO-258' } }))
      .rejects.toThrow('mismatched identifier');
    expect(requests).toHaveLength(1);
  });

  it('rejects a mismatched UUID on get_issue', async () => {
    graphqlStub(() => ({ issue: issueNode(OTHER_ID) }));
    await expect(execute({ operation: 'get_issue', variables: { issue: ISSUE_ID } }))
      .rejects.toThrow('mismatched id');
  });

  it('rejects a mismatched identifier on update_issue', async () => {
    const { requests } = graphqlStub(() => ({
      issueUpdate: { success: true, issue: issueNode(ISSUE_ID, 'AEO-999') },
    }));
    await expect(execute({
      operation: 'update_issue',
      variables: { issue: 'AEO-258', title: 'New title' },
    })).rejects.toThrow('mismatched identifier');
    expect(requests).toHaveLength(1);
  });

  it('rejects a foreign-team state UUID before any direct mutation request', async () => {
    const { requests } = graphqlStub((query) => {
      if (query.includes('ResolveIssueById')) return { issue: issueNode() };
      if (query.includes('ResolveStateById')) {
        return { workflowState: { id: STATE_ID, name: 'Foreign', team: { id: FOREIGN_TEAM_ID } } };
      }
      throw new Error('Mutation request must not run.');
    });

    await expect(execute({
      operation: 'update_issue',
      variables: { issue: 'AEO-258', stateId: STATE_ID },
    })).rejects.toThrow(`does not belong to team "${TEAM_ID}"`);
    expect(requests).toHaveLength(2);
    expect(requests.every(({ query }) => !query.includes('mutation'))).toBe(true);
  });

  it('preserves a valid explicit-team move with a state from the destination team', async () => {
    const { requests } = graphqlStub((query, variables) => {
      if (query.includes('ResolveTeamById')) {
        expect(variables).toEqual({ id: FOREIGN_TEAM_ID });
        return { team: { id: FOREIGN_TEAM_ID, key: 'OTHER' } };
      }
      if (query.includes('ResolveStateById')) {
        return { workflowState: { id: STATE_ID, name: 'Moved', team: { id: FOREIGN_TEAM_ID } } };
      }
      expect(query).toContain('mutation UpdateIssue');
      return { issueUpdate: { success: true, issue: issueNode() } };
    });

    await execute({
      operation: 'update_issue',
      variables: { issue: 'AEO-258', teamId: FOREIGN_TEAM_ID, stateId: STATE_ID },
    });
    expect(requests).toHaveLength(3);
    expect(requests.some(({ query }) => query.includes('ResolveIssueById'))).toBe(false);
    expect(requests.filter(({ query }) => query.includes('mutation'))).toHaveLength(1);
  });

  it('still resolves state names with the issue team before update_issue', async () => {
    const { requests } = graphqlStub((query, variables) => {
      if (query.includes('ResolveIssueById')) {
        expect(variables).toEqual({ id: 'AEO-258' });
        return { issue: issueNode() };
      }
      if (query.includes('ResolveStateByName')) {
        expect(variables).toEqual({ teamId: TEAM_ID, name: 'Backlog' });
        return { workflowStates: { nodes: [{ id: STATE_ID, name: 'Backlog', team: { id: TEAM_ID } }] } };
      }
      expect(query).toContain('mutation UpdateIssue');
      expect(variables).toEqual({ id: 'AEO-258', input: { stateId: STATE_ID } });
      return { issueUpdate: { success: true, issue: issueNode() } };
    });

    await execute({ operation: 'update_issue', variables: { issue: 'AEO-258', state: 'Backlog' } });
    expect(requests.map(({ query }) => query.split('(')[0]!.trim())).toEqual([
      'query ResolveIssueById',
      'query ResolveStateByName',
      'mutation UpdateIssue',
    ]);
  });
});

describe('shared operation-plan routing', () => {
  it('still converts comment issue identifiers to UUIDs before the list filter', async () => {
    const { requests } = graphqlStub((query, variables) => {
      if (query.includes('ResolveIssueById')) {
        expect(variables).toEqual({ id: 'AEO-258' });
        return { issue: issueNode() };
      }
      expect(query).toContain('query ListComments');
      return { comments: { nodes: [], pageInfo: { hasNextPage: false } } };
    });
    const prepared = await prepareOperation(operations.list_comments!, { issue: 'AEO-258' });
    expect(requests).toHaveLength(1);
    expect(prepared.variables.filter).toEqual({ issue: { id: { eq: ISSUE_ID } } });
  });
});
