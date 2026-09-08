import { afterEach, describe, expect, it, vi } from 'vitest';
import { linearBatchTool, resolveRequest } from '../extensions/api';
import contracts from '../extensions/generated/operation-contracts.json';
import type { JsonObject } from '../extensions/json';
import { operationDefinitions, operations } from '../extensions/operations';
import { contractProjection } from '../scripts/generate';
import { isolateLinearCredentials } from './helpers/credentials';
import { prepareOperation } from './helpers/operation-plan';

isolateLinearCredentials();

const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';
const ISSUE_ID = '22222222-2222-4222-8222-222222222222';
const TEAM_ID = '33333333-3333-4333-8333-333333333333';
const DOCUMENT_OPERATIONS = ['list_documents', 'get_document', 'create_document', 'update_document'] as const;
const RELATED_FIELDS = ['cycleId', 'initiativeId', 'projectId', 'releaseId', 'resourceFolderId'] as const;
const originalApiKey = process.env.LINEAR_API_KEY;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalApiKey === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = originalApiKey;
});

function resolver() {
  return vi.fn(async (_apiKey: string, query: string, variables: any) => {
    if (query.includes('ResolveDocumentById')) {
      return { document: { id: variables.id, title: 'Planning notes' } };
    }
    if (query.includes('ResolveNamedEntityByName')) {
      return { documents: { nodes: [{ id: DOCUMENT_ID, name: variables.name }] } };
    }
    if (query.includes('ResolveIssueById')) {
      return {
        issue: {
          id: ISSUE_ID,
          identifier: 'AEO-1',
          team: { id: TEAM_ID, key: 'AEO' },
        },
      };
    }
    if (query.includes('ResolveTeamByKey')) {
      return { teams: { nodes: [{ id: TEAM_ID, key: variables.key }] } };
    }
    throw new Error(`Unexpected query: ${query}`);
  });
}

describe('document operation hardening', () => {
  it('keeps every public document operation equal to its checked-in generated contract', () => {
    const generated = new Map(contracts.map((contract) => [contract.name, contract]));

    for (const name of DOCUMENT_OPERATIONS) {
      const definition = operationDefinitions.find((operation) => operation.name === name)!;
      expect(contractProjection(definition), name).toEqual(generated.get(name));
    }
  });

  it('trims exact document references and resolves title references before a get', async () => {
    const graphql = resolver();

    const exact = await prepareOperation(
      operations.get_document!,
      { document: `  ${DOCUMENT_ID}  ` },
      graphql,
    );
    expect(exact.variables).toEqual({ id: DOCUMENT_ID });
    expect(operations.get_document!.document).toContain('query GetDocument');
    expect(operations.get_document!.document).toContain('document(id: $id)');
    expect(operations.get_document!.document).toContain('title');
    expect(exact.exactNamed).toEqual({
      requested: DOCUMENT_ID,
      path: 'document',
      kind: 'document',
    });
    expect(exact.resolution).toEqual({ target: { requested: DOCUMENT_ID } });
    expect(graphql).not.toHaveBeenCalled();

    const named = await prepareOperation(
      operations.get_document!,
      { document: 'Planning notes' },
      graphql,
    );
    expect(named.variables).toEqual({ id: DOCUMENT_ID });
    expect(graphql.mock.calls[0]?.[1]).toContain('ResolveNamedEntityByName');
  });

  it('resolves a create issue and removes a conflicting team association', async () => {
    const graphql = resolver();
    const prepared = await prepareOperation(
      operations.create_document!,
      { title: 'Planning notes', issueId: 'AEO-1', teamId: TEAM_ID },
      graphql,
    );

    expect(prepared.variables).toEqual({ input: { title: 'Planning notes', issueId: ISSUE_ID } });
    expect(prepared.resolution).toEqual({
      issue: {
        requested: 'AEO-1',
        resolvedId: ISSUE_ID,
        identifier: 'AEO-1',
      },
    });
    expect(graphql).toHaveBeenCalledTimes(1);
    expect(graphql.mock.calls[0]?.[1]).toContain('ResolveIssueById');
  });

  it('resolves a create team when no related record owns the association', async () => {
    const graphql = resolver();
    const prepared = await prepareOperation(
      operations.create_document!,
      { title: 'Planning notes', teamKey: 'ENG' },
      graphql,
    );

    expect(prepared.variables).toEqual({ input: { title: 'Planning notes', teamId: TEAM_ID } });
    expect(prepared.resolution).toEqual({
      team: { requested: 'ENG', resolvedId: TEAM_ID, key: 'ENG' },
    });
    expect(graphql).toHaveBeenCalledTimes(1);
    expect(graphql.mock.calls[0]?.[1]).toContain('ResolveTeamByKey');
  });

  it('rejects missing and blank create titles through both public preparation paths', async () => {
    expect(() => resolveRequest({
      operation: 'create_document',
      variables: { input: { content: 'No title' } },
    })).toThrow('parameters do not match one accepted requirement branch');
    expect(() => resolveRequest({
      operation: 'create_document',
      variables: { input: { title: 42 } },
    })).toThrow('canonical fields or nested input require title');
    expect(() => resolveRequest({
      operation: 'create_document',
      variables: { input: { title: 'Nested title' } },
    })).not.toThrow();

    await expect(prepareOperation(
      operations.create_document!,
      { title: '   ' },
      resolver(),
    )).rejects.toThrow('Document title is required for documentCreate (title).');
  });

  it('rejects an update with no changed fields after exact target resolution', async () => {
    await expect(prepareOperation(
      operations.update_document!,
      { documentId: DOCUMENT_ID },
      resolver(),
    )).rejects.toThrow('No update fields were provided.');
  });

  it('removes a conflicting create team for every related-record field', async () => {
    for (const field of RELATED_FIELDS) {
      const prepared = await prepareOperation(
        operations.create_document!,
        { title: 'Planning notes', [field]: ISSUE_ID, teamId: TEAM_ID },
        resolver(),
      );
      expect(prepared.variables, field).toEqual({
        input: { title: 'Planning notes', [field]: ISSUE_ID },
      });
    }
  });

  it('resolves update issue and team associations on their separate valid paths', async () => {
    const issueGraphql = resolver();
    const related = await prepareOperation(
      operations.update_document!,
      { document: DOCUMENT_ID, issueId: 'AEO-1', teamId: TEAM_ID },
      issueGraphql,
    );
    expect(related.variables).toEqual({ id: DOCUMENT_ID, input: { issueId: ISSUE_ID } });
    expect(related.resolution).toMatchObject({
      target: { requested: DOCUMENT_ID, resolvedId: DOCUMENT_ID, title: 'Planning notes' },
      issue: { requested: 'AEO-1', resolvedId: ISSUE_ID, identifier: 'AEO-1' },
    });
    expect(issueGraphql.mock.calls.map((call) => call[1])).not.toEqual(
      expect.arrayContaining([expect.stringContaining('ResolveTeam')]),
    );

    const teamGraphql = resolver();
    const assigned = await prepareOperation(
      operations.update_document!,
      { document: DOCUMENT_ID, teamKey: 'ENG', title: 'Updated notes' },
      teamGraphql,
    );
    expect(assigned.variables).toEqual({
      id: DOCUMENT_ID,
      input: { title: 'Updated notes', teamId: TEAM_ID },
    });
    expect(assigned.resolution).toMatchObject({
      team: { requested: 'ENG', resolvedId: TEAM_ID, key: 'ENG' },
    });
  });

  it('removes a conflicting update team for every related-record field', async () => {
    for (const field of RELATED_FIELDS) {
      const prepared = await prepareOperation(
        operations.update_document!,
        { document: DOCUMENT_ID, title: 'Updated notes', [field]: ISSUE_ID, teamId: TEAM_ID },
        resolver(),
      );
      expect(prepared.variables, field).toEqual({
        id: DOCUMENT_ID,
        input: { title: 'Updated notes', [field]: ISSUE_ID },
      });
    }
  });

  it('keeps query and mutation document plans valid through the public batch tool', async () => {
    process.env.LINEAR_API_KEY = 'test-key';
    const requests: Array<{ query: string; variables: JsonObject }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      requests.push(request);
      const data = request.query.includes('ResolveNamedEntityByName')
        ? { documents: { nodes: [{ id: DOCUMENT_ID, name: 'Planning notes' }] } }
        : request.query.includes('documentCreate')
          ? { created: { success: true, document: { id: DOCUMENT_ID, title: 'Planning notes' } } }
          : { found: { id: DOCUMENT_ID, title: 'Planning notes' } };
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    const execute = (variables: JsonObject) => (linearBatchTool('allowlist') as any)
      .execute('call-1', variables, undefined, undefined, { hasUI: false });

    const read = await execute({
      reads: [{ key: 'found', operation: 'get_document', variables: { document: DOCUMENT_ID } }],
    });
    expect(read.details.data.found.document.id).toBe(DOCUMENT_ID);

    await expect(execute({
      reads: [{ key: 'found', operation: 'get_document', variables: { document: 'Planning notes' } }],
    })).rejects.toThrow('requires a second lookup layer');

    const mutation = await execute({
      mutations: [{ key: 'created', operation: 'create_document', variables: { title: 'Planning notes' } }],
    });
    expect(mutation.details.data.created.documentCreate.document.id).toBe(DOCUMENT_ID);
    expect(requests).toHaveLength(2);
  });
});
