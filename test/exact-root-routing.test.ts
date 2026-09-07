import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeTyped } from './helpers/typed-execution';
import { isolateLinearCredentials } from './helpers/credentials';
import type { CompatibilityObject } from '../extensions/operation-types';

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

function execute(params: { operation: string; variables?: CompatibilityObject }) {
  return executeTyped(params.operation, params.variables);
}

function graphqlStub(
  responder: (query: string, variables: CompatibilityObject) => CompatibilityObject,
) {
  const requests: Array<{ query: string; variables: CompatibilityObject }> = [];
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as { query: string; variables: CompatibilityObject };
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

describe('exact project, cycle, and document reads', () => {
  it('resolves a project slug exactly before the GetProject request', async () => {
    const { requests } = graphqlStub((query, variables) => {
      if (query.includes('ResolveNamedEntityByReference')) {
        expect(query).toContain('projects(first: 3');
        expect(query).toContain('slugId: { eq: $reference }');
        expect(variables).toEqual({ reference: 'pi-linear' });
        return { matches: { nodes: [{ id: PROJECT_ID, name: 'Pi Linear', slugId: 'pi-linear' }] } };
      }
      expect(query).toContain('query GetProject');
      expect(query).toContain('project(id: $id)');
      expect(variables).toEqual({ id: PROJECT_ID });
      return {
        project: {
          id: PROJECT_ID,
          name: 'Pi Linear',
          slugId: 'pi-linear',
          teams: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'team-cursor' } },
          members: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      };
    });

    const result = await execute({ operation: 'get_project', variables: { project: 'pi-linear' } });

    expect(requests).toHaveLength(2);
    expect(result.details.resolution.target).toEqual({
      requested: 'pi-linear',
      resolvedId: PROJECT_ID,
      name: 'Pi Linear',
    });
    expect(result.details.data.project.teams.pageInfo).toEqual({
      hasNextPage: true,
      endCursor: 'team-cursor',
    });
    expect(result.details.data.project.members.pageInfo).toEqual({
      hasNextPage: false,
      endCursor: null,
    });
  });

  it('resolves a hyphenated cycle exact name before reading its UUID', async () => {
    const { requests } = graphqlStub((query, variables) => {
      if (query.includes('ResolveNamedEntityByName')) {
        expect(query).toContain('cycles(first:');
        expect(variables).toEqual({ name: 'Cycle-12' });
        return { cycles: { nodes: [{ id: CYCLE_ID, name: 'Cycle-12' }] } };
      }
      expect(query).toContain('query GetCycle');
      expect(query).toContain('cycle(id: $id)');
      expect(query).not.toContain('slugId');
      expect(variables).toEqual({ id: CYCLE_ID });
      return { cycle: { id: CYCLE_ID, name: 'Cycle-12' } };
    });

    const result = await execute({ operation: 'get_cycle', variables: { cycle: 'Cycle-12' } });
    expect(requests).toHaveLength(2);
    expect(result.details.resolution.target).toEqual({
      requested: 'Cycle-12',
      resolvedId: CYCLE_ID,
      name: 'Cycle-12',
    });
  });

  it('resolves a document slug exactly before the GetDocument request', async () => {
    const { requests } = graphqlStub((query, variables) => {
      if (query.includes('ResolveNamedEntityByReference')) {
        expect(query).toContain('documents(first: 3');
        expect(query).toContain('slugId: { eq: $reference }');
        expect(variables).toEqual({ reference: 'planning-notes' });
        return { matches: { nodes: [{ id: DOCUMENT_ID, name: 'Planning notes', slugId: 'planning-notes' }] } };
      }
      expect(query).toContain('query GetDocument');
      expect(query).toContain('document(id: $id)');
      expect(variables).toEqual({ id: DOCUMENT_ID });
      return { document: { id: DOCUMENT_ID, title: 'Planning notes', slugId: 'planning-notes' } };
    });

    await execute({ operation: 'get_document', variables: { document: 'planning-notes' } });
    expect(requests).toHaveLength(2);
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
      if (query.includes('ResolveNamedEntityByReference')) {
        expect(query).not.toMatch(/project\(id: \$id\)/);
        expect(query).not.toMatch(/document\(id: \$id\)/);
        if (query.includes('projects(')) {
          expect(variables).toEqual({ reference: 'Platform' });
          return { matches: { nodes: [{ id: PROJECT_ID, name: 'Platform', slugId: 'platform' }] } };
        }
        expect(variables).toEqual({ reference: 'Planning notes' });
        return { matches: { nodes: [{ id: DOCUMENT_ID, name: 'Planning notes', slugId: 'planning-notes' }] } };
      }
      if (query.includes('ResolveNamedEntityByName')) {
        expect(query).not.toMatch(/cycle\(id: \$id\)/);
        expect(query).toContain('cycles(');
        expect(variables).toEqual({ name: 'Cycle 12' });
        return { cycles: { nodes: [{ id: CYCLE_ID, name: 'Cycle 12' }] } };
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
      'query ResolveNamedEntityByReference',
      'query GetProject',
      'query ResolveNamedEntityByName',
      'query GetCycle',
      'query ResolveNamedEntityByReference',
      'query GetDocument',
    ]);
  });

  it.each([
    ['project', 'get_project', 'project', 'pi-linear', PROJECT_ID],
    ['document', 'get_document', 'document', 'planning-notes', DOCUMENT_ID],
  ] as const)('rejects a %s slug lookup without identity proof', async (_kind, operation, field, reference, id) => {
    const { requests } = graphqlStub((query) => {
      expect(query).toContain('ResolveNamedEntityByReference');
      return { matches: { nodes: [{ id, name: 'Name', title: 'Title' }] } };
    });
    await expect(execute({ operation, variables: { [field]: reference } }))
      .rejects.toThrow('resolved to 0 matches; expected exactly one');
    expect(requests).toHaveLength(1);
  });

  it.each([
    ['project', 'get_project', 'project', 'pi-linear', PROJECT_ID],
    ['document', 'get_document', 'document', 'planning-notes', DOCUMENT_ID],
  ] as const)('rejects a mismatched %s slug without a singular request', async (_kind, operation, field, reference, id) => {
    const { requests } = graphqlStub((query) => {
      expect(query).toContain('ResolveNamedEntityByReference');
      return { matches: { nodes: [{ id, name: 'Other', title: 'Other', slugId: 'other-slug' }] } };
    });
    await expect(execute({ operation, variables: { [field]: reference } }))
      .rejects.toThrow('resolved to 0 matches; expected exactly one');
    expect(requests).toHaveLength(1);
  });

  it('rejects a mismatched project UUID', async () => {
    graphqlStub(() => ({ project: { id: OTHER_ID, name: 'Pi Linear', slugId: 'pi-linear' } }));
    await expect(execute({ operation: 'get_project', variables: { project: PROJECT_ID } }))
      .rejects.toThrow('mismatched id');
  });

  it('rejects a mismatched cycle UUID without slug proof', async () => {
    const { requests } = graphqlStub((query) => {
      expect(query).toContain('query GetCycle');
      expect(query).not.toContain('slugId');
      return { cycle: { id: OTHER_ID, name: 'Cycle 12' } };
    });
    await expect(execute({ operation: 'get_cycle', variables: { cycle: CYCLE_ID } }))
      .rejects.toThrow('mismatched id');
    expect(requests).toHaveLength(1);
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
      variables: { document: 'planning-notes', title: 'Updated notes' },
    });

    expect(requests[0]!.query).toContain('ResolveDocumentByTitle');
    expect(requests[0]!.variables).toEqual({ title: 'planning-notes' });
    expect(requests[1]!.variables).toEqual({ id: DOCUMENT_ID, input: { title: 'Updated notes' } });
  });

  it('resolves a save_project slug-shaped id as a name, not project(id:)', async () => {
    const { requests } = graphqlStub((query) => {
      expect(query).not.toMatch(/project\(id: \$id\)/);
      if (query.includes('ResolveNamedEntityByReference')) {
        return { matches: { nodes: [{ id: PROJECT_ID, name: 'pi-linear', slugId: 'pi-linear' }] } };
      }
      expect(query).toContain('mutation UpdateProject');
      return { projectUpdate: { success: true, project: { id: PROJECT_ID, name: 'pi-linear' } } };
    });

    await execute({
      operation: 'save_project',
      variables: { project: 'pi-linear', name: 'Pi Linear' },
    });

    expect(requests[0]!.query).toContain('ResolveNamedEntityByReference');
    expect(requests[0]!.variables).toEqual({ reference: 'pi-linear' });
    expect(requests[1]!.variables).toEqual({ id: PROJECT_ID, input: { name: 'Pi Linear' } });
  });
});
