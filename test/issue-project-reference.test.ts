import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeTyped } from './helpers/typed-execution';
import { isolateLinearCredentials } from './helpers/credentials';
import type { CompatibilityObject } from '../extensions/operation-types';

isolateLinearCredentials();

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ISSUE_ID = '22222222-2222-4222-8222-222222222222';
const TEAM_ID = '33333333-3333-4333-8333-333333333333';
const originalKey = process.env.LINEAR_API_KEY;

function issueNode() {
  return { id: ISSUE_ID, identifier: 'AEO-258', title: 'Fix references', team: { id: TEAM_ID, key: 'AEO' }, project: { id: PROJECT_ID, name: 'pi-linear' } };
}

function stubGraphql(responder: (query: string, variables: CompatibilityObject) => CompatibilityObject) {
  const requests: Array<{ query: string; variables: CompatibilityObject }> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as { query: string; variables: CompatibilityObject };
    requests.push(request);
    return { ok: true, status: 200, statusText: 'OK', headers: new Headers(), json: async () => ({ data: responder(request.query, request.variables) }) };
  }));
  process.env.LINEAR_API_KEY = 'test-key';
  return requests;
}

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalKey === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = originalKey;
});

describe('AEO-824 issue project references', () => {
  it('routes the exact project name pi-linear through name and slug resolution', async () => {
    const requests = stubGraphql((query, variables) => {
      if (query.includes('ResolveNamedEntityByReference')) {
        expect(variables).toEqual({ reference: 'pi-linear' });
        return { matches: { nodes: [{ id: PROJECT_ID, name: 'pi-linear', slugId: 'different-slug' }] } };
      }
      return { project: { id: PROJECT_ID, name: 'pi-linear', slugId: 'different-slug' } };
    });
    const result = await executeTyped('get_project', { project: 'pi-linear' });
    expect(requests).toHaveLength(2);
    expect(result.details.resolution.target).toMatchObject({ requested: 'pi-linear', resolvedId: PROJECT_ID, name: 'pi-linear' });
  });

  it('filters list_issues by an exact project name', async () => {
    const requests = stubGraphql((query) => query.includes('ResolveNamedEntityByReference')
      ? { matches: { nodes: [{ id: PROJECT_ID, name: 'pi-linear', slugId: 'pi-linear' }] } }
      : { issues: { nodes: [], pageInfo: { hasNextPage: false, hasPreviousPage: false } } });
    await executeTyped('list_issues', { project: 'pi-linear' });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.variables).toMatchObject({ filter: { project: { id: { eq: PROJECT_ID } } } });
  });

  it('creates an issue attached to a project resolved by exact name', async () => {
    const requests = stubGraphql((query) => {
      if (query.includes('ResolveNamedEntityByReference')) return { matches: { nodes: [{ id: PROJECT_ID, name: 'pi-linear', slugId: 'pi-linear' }] } };
      if (query.includes('ResolveTeamByKey')) return { teams: { nodes: [{ id: TEAM_ID, key: 'AEO', name: 'Agent Experience' }] } };
      return { issueCreate: { success: true, issue: issueNode() } };
    });
    const result = await executeTyped('create_issue', { title: 'Fix references', team: 'AEO', project: 'pi-linear' });
    expect(requests.at(-1)?.variables).toEqual({ input: { title: 'Fix references', teamId: TEAM_ID, projectId: PROJECT_ID } });
    expect(result.details.resolution.project).toMatchObject({ requested: 'pi-linear', resolvedId: PROJECT_ID });
  });

  it('preserves a null project clear on update_issue without a lookup', async () => {
    const requests = stubGraphql((query, variables) => {
      expect(query).toContain('mutation UpdateIssue');
      expect(variables).toEqual({ id: 'AEO-258', input: { projectId: null } });
      return { issueUpdate: { success: true, issue: { ...issueNode(), project: null } } };
    });
    await executeTyped('update_issue', { issue: 'AEO-258', project: null });
    expect(requests).toHaveLength(1);
  });

  it('fails closed when a project name does not resolve and sends no mutation', async () => {
    const requests = stubGraphql((query) => query.includes('ResolveNamedEntityByReference')
      ? { matches: { nodes: [] } }
      : (() => { throw new Error('mutation must not run'); })());
    await expect(executeTyped('update_issue', { issue: 'AEO-258', project: 'missing' }))
      .rejects.toThrow('expected exactly one');
    expect(requests).toHaveLength(1);
  });
});
