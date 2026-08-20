import { afterEach, describe, expect, it, vi } from 'vitest';
import { linearApiTool } from '../extensions/api';
import { isolateLinearCredentials } from './helpers/credentials';

isolateLinearCredentials();

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const CYCLE_ID = '33333333-3333-4333-8333-333333333333';
const DOCUMENT_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_ID = '55555555-5555-4555-8555-555555555555';
const TEAM_ID = '66666666-6666-4666-8666-666666666666';
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

describe('identifier-shaped search_issues uses the exact issue root', () => {
  it.each(['AEO-258', 'aeo-258'])('reads %s with one issue(id:) request', async (term) => {
    const { requests } = graphqlStub((query, variables) => {
      expect(query).toContain('issue(id: $id)');
      expect(query).not.toContain('searchIssues');
      expect(variables).toEqual({ id: term });
      return { issue: issueNode() };
    });

    const result = await execute({ operation: 'search_issues', variables: { term } });

    expect(requests).toHaveLength(1);
    expect(result.details.data.issue.identifier).toBe('AEO-258');
    expect(result.details.resolution.target).toEqual({
      requested: term,
      resolvedId: ISSUE_ID,
      identifier: 'AEO-258',
    });
  });

  it('keeps ordinary text search on searchIssues', async () => {
    const { requests } = graphqlStub((query, variables) => {
      expect(query).toContain('searchIssues');
      expect(query).not.toContain('issue(id: $id)');
      expect(variables.term).toBe('authentication');
      return { searchIssues: { nodes: [issueNode()], pageInfo: { hasNextPage: false } } };
    });

    await execute({ operation: 'search_issues', variables: { term: 'authentication' } });
    expect(requests).toHaveLength(1);
  });
});

describe('project, cycle, and document slug reads use singular roots', () => {
  it('reads a project slug with one GetProject request', async () => {
    const { requests } = graphqlStub((query, variables) => {
      expect(query).toContain('query GetProject');
      expect(query).toContain('project(id: $id)');
      expect(query).not.toContain('projects(first:');
      expect(variables).toEqual({ id: 'pi-linear' });
      return { project: { id: PROJECT_ID, name: 'Pi Linear', slugId: 'pi-linear' } };
    });

    const result = await execute({ operation: 'get_project', variables: { project: 'pi-linear' } });

    expect(requests).toHaveLength(1);
    expect(result.details.resolution.target).toEqual({
      requested: 'pi-linear',
      resolvedId: PROJECT_ID,
      name: 'Pi Linear',
    });
  });

  it('reads a cycle slug with one GetCycle request', async () => {
    const { requests } = graphqlStub((query, variables) => {
      expect(query).toContain('query GetCycle');
      expect(query).toContain('cycle(id: $id)');
      expect(query).not.toContain('cycles(first:');
      expect(variables).toEqual({ id: 'eng-12' });
      return { cycle: { id: CYCLE_ID, name: 'Cycle 12' } };
    });

    await execute({ operation: 'get_cycle', variables: { cycle: 'eng-12' } });
    expect(requests).toHaveLength(1);
  });

  it('reads a document slug with one GetDocument request', async () => {
    const { requests } = graphqlStub((query, variables) => {
      expect(query).toContain('query GetDocument');
      expect(query).toContain('document(id: $id)');
      expect(query).not.toContain('documents(first:');
      expect(variables).toEqual({ id: 'planning-notes' });
      return { document: { id: DOCUMENT_ID, title: 'Planning notes', slugId: 'planning-notes' } };
    });

    await execute({ operation: 'get_document', variables: { document: 'planning-notes' } });
    expect(requests).toHaveLength(1);
  });

  it('reads project, cycle, and document UUIDs with one singular request', async () => {
    const { requests } = graphqlStub((query, variables) => {
      expect(query).not.toContain('ResolveNamedEntity');
      if (query.includes('GetProject')) {
        expect(variables).toEqual({ id: PROJECT_ID });
        return { project: { id: PROJECT_ID, name: 'Pi Linear', slugId: 'pi-linear' } };
      }
      if (query.includes('GetCycle')) {
        expect(variables).toEqual({ id: CYCLE_ID });
        return { cycle: { id: CYCLE_ID, name: 'Cycle 12' } };
      }
      expect(query).toContain('GetDocument');
      expect(variables).toEqual({ id: DOCUMENT_ID });
      return { document: { id: DOCUMENT_ID, title: 'Planning notes', slugId: 'planning-notes' } };
    });

    await execute({ operation: 'get_project', variables: { project: PROJECT_ID } });
    await execute({ operation: 'get_cycle', variables: { cycle: CYCLE_ID } });
    await execute({ operation: 'get_document', variables: { document: DOCUMENT_ID } });
    expect(requests).toHaveLength(3);
  });

  it('keeps ordinary exact names on list filters', async () => {
    const { requests } = graphqlStub((query, variables) => {
      if (query.includes('ResolveNamedEntityByName')) {
        expect(query).not.toMatch(/project\(id: \$id\)/);
        expect(query).not.toMatch(/cycle\(id: \$id\)/);
        expect(query).not.toMatch(/document\(id: \$id\)/);
        if (query.includes('projects(')) {
          expect(variables).toEqual({ name: 'Platform' });
          return { projects: { nodes: [{ id: PROJECT_ID, name: 'Platform' }] } };
        }
        if (query.includes('cycles(')) {
          expect(variables).toEqual({ name: 'Cycle 12' });
          return { cycles: { nodes: [{ id: CYCLE_ID, name: 'Cycle 12' }] } };
        }
        expect(variables).toEqual({ name: 'Planning notes' });
        return { documents: { nodes: [{ id: DOCUMENT_ID, name: 'Planning notes' }] } };
      }
      if (query.includes('GetProject')) {
        expect(variables).toEqual({ id: PROJECT_ID });
        return { project: { id: PROJECT_ID, name: 'Platform', slugId: 'platform' } };
      }
      if (query.includes('GetCycle')) {
        expect(variables).toEqual({ id: CYCLE_ID });
        return { cycle: { id: CYCLE_ID, name: 'Cycle 12' } };
      }
      expect(query).toContain('GetDocument');
      expect(variables).toEqual({ id: DOCUMENT_ID });
      return { document: { id: DOCUMENT_ID, title: 'Planning notes', slugId: 'planning-notes' } };
    });

    await execute({ operation: 'get_project', variables: { project: 'Platform' } });
    await execute({ operation: 'get_cycle', variables: { cycle: 'Cycle 12' } });
    await execute({ operation: 'get_document', variables: { document: 'Planning notes' } });
    expect(requests.map(({ query }) => query.split('(')[0]!.trim())).toEqual([
      'query ResolveNamedEntityByName',
      'query GetProject',
      'query ResolveNamedEntityByName',
      'query GetCycle',
      'query ResolveNamedEntityByName',
      'query GetDocument',
    ]);
  });

  it('rejects a mismatched project slug without a second request', async () => {
    const { requests } = graphqlStub(() => ({
      project: { id: PROJECT_ID, name: 'Other', slugId: 'other-project' },
    }));
    await expect(execute({ operation: 'get_project', variables: { project: 'pi-linear' } }))
      .rejects.toThrow('mismatched slug');
    expect(requests).toHaveLength(1);
  });

  it('rejects a mismatched project UUID', async () => {
    graphqlStub(() => ({ project: { id: OTHER_ID, name: 'Pi Linear', slugId: 'pi-linear' } }));
    await expect(execute({ operation: 'get_project', variables: { project: PROJECT_ID } }))
      .rejects.toThrow('mismatched id');
  });
});

describe('mutations do not infer slug identifiers', () => {
  it('resolves an update_document slug-shaped id as a title, not document(id:)', async () => {
    const { requests } = graphqlStub((query) => {
      expect(query).not.toMatch(/document\(id: \$id\)/);
      if (query.includes('ResolveDocumentByTitle')) {
        return { documents: { nodes: [{ id: DOCUMENT_ID, title: 'planning-notes' }] } };
      }
      expect(query).toContain('mutation UpdateDocument');
      return { documentUpdate: { success: true, document: { id: DOCUMENT_ID, title: 'Updated notes' } } };
    });

    await execute({
      operation: 'update_document',
      variables: { documentId: 'planning-notes', title: 'Updated notes' },
    });

    expect(requests[0]!.query).toContain('ResolveDocumentByTitle');
    expect(requests[0]!.variables).toEqual({ title: 'planning-notes' });
    expect(requests[1]!.variables).toEqual({ id: DOCUMENT_ID, input: { title: 'Updated notes' } });
  });

  it('resolves a save_project slug-shaped id as a name, not project(id:)', async () => {
    const { requests } = graphqlStub((query) => {
      expect(query).not.toMatch(/project\(id: \$id\)/);
      if (query.includes('ResolveNamedEntityByName')) {
        return { projects: { nodes: [{ id: PROJECT_ID, name: 'pi-linear' }] } };
      }
      expect(query).toContain('mutation UpdateProject');
      return { projectUpdate: { success: true, project: { id: PROJECT_ID, name: 'pi-linear' } } };
    });

    await execute({
      operation: 'save_project',
      variables: { projectId: 'pi-linear', name: 'Pi Linear' },
    });

    expect(requests[0]!.query).toContain('ResolveNamedEntityByName');
    expect(requests[0]!.variables).toEqual({ name: 'pi-linear' });
    expect(requests[1]!.variables).toEqual({ id: PROJECT_ID, input: { name: 'Pi Linear' } });
  });
});
