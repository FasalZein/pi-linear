import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kind, parse, type SelectionSetNode } from 'graphql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_SPILL_BYTES,
  NODE_CAP,
  RESULT_BUDGET,
  STRING_CAP,
  compactLinearResult,
  linearApiTool,
  routeLinearResult,
  resolveRequest,
} from '../extensions/api';
import { DOMAINS, getOperation, operationDocuments, operations } from '../extensions/operations';
import { isolateLinearCredentials } from './helpers/credentials';

isolateLinearCredentials();

const originalArtifactRoot = process.env.PI_ARTIFACT_PROJECT_ROOT;
const originalSpillBytes = process.env.LINEAR_SPILL_BYTES;
const originalApiKey = process.env.LINEAR_API_KEY;
const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  if (originalArtifactRoot === undefined) delete process.env.PI_ARTIFACT_PROJECT_ROOT;
  else process.env.PI_ARTIFACT_PROJECT_ROOT = originalArtifactRoot;
  if (originalSpillBytes === undefined) delete process.env.LINEAR_SPILL_BYTES;
  else process.env.LINEAR_SPILL_BYTES = originalSpillBytes;
  if (originalApiKey === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = originalApiKey;
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function artifactRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'pi-linear-'));
  temporaryRoots.push(path);
  process.env.PI_ARTIFACT_PROJECT_ROOT = path;
  return path;
}

describe('named operations', () => {
  function parsedRootOperation(documentText: string) {
    const document = parse(documentText);
    const fragments = new Map(
      document.definitions
        .filter((definition) => definition.kind === Kind.FRAGMENT_DEFINITION)
        .map((fragment) => [fragment.name.value, fragment.selectionSet]),
    );
    const definitions = document.definitions.filter((definition) => definition.kind === Kind.OPERATION_DEFINITION);
    expect(definitions).toHaveLength(1);
    const definition = definitions[0];
    if (!definition || definition.kind !== Kind.OPERATION_DEFINITION) throw new Error('Expected one operation definition.');

    const roots = new Set<string>();
    const visit = (selectionSet: SelectionSetNode) => {
      for (const selection of selectionSet.selections) {
        if (selection.kind === Kind.FIELD) roots.add(selection.name.value);
        else if (selection.kind === Kind.INLINE_FRAGMENT) visit(selection.selectionSet);
        else {
          const fragment = fragments.get(selection.name.value);
          if (fragment) visit(fragment);
        }
      }
    };
    visit(definition.selectionSet);
    return { type: definition.operation, roots: [...roots].sort() };
  }

  it('loads valid documents and exactly matches mutation-root declarations', () => {
    for (const [name, operation] of Object.entries(operations)) {
      expect(resolveRequest({ operation: name, variables: operation.example.variables })).toMatchObject({
        query: operation.document,
        named: true,
        operation,
      });
      expect(operation.name).toBe(name);
      expect(operation.example.operation).toBe(name);

      const parsed = operationDocuments(operation).map(parsedRootOperation);
      const mutationRoots = [...new Set(parsed.filter(({ type }) => type === 'mutation').flatMap(({ roots }) => roots))].sort();
      expect(operation.variants?.map(({ root }) => root).sort() ?? []).toEqual(mutationRoots);
      for (const document of parsed.filter(({ type }) => type === 'query')) expect(document.roots.length).toBeGreaterThan(0);
    }
  });

  it('accepts old names and variable shapes as hidden aliases', () => {
    const aliases = [
      ['add_comment', { issueId: '11111111-1111-4111-8111-111111111111', body: 'Comment text' }, 'create_comment'],
      ['create_relation', { issueId: '11111111-1111-4111-8111-111111111111', relatedIssueId: '22222222-2222-4222-8222-222222222222', type: 'related' }, 'create_issue_relation'],
      ['list_workflow_states', {}, 'list_issue_statuses'],
    ] as const;

    for (const [alias, variables, canonical] of aliases) {
      expect(getOperation(alias).name).toBe(canonical);
      expect(resolveRequest({ operation: alias, variables })).toMatchObject({
        named: true,
        operation: { name: canonical },
      });
    }
  });

  it('teaches the exact valid request shapes for invalid request selection', () => {
    const message = 'Invalid request. Send exactly one of: { "operation": "get_issue", "variables": { "issue": "AEO-258" } }, { "operation": "help" }, or { "query": "query { viewer { id } }", "variables": {} }.';
    expect(() => resolveRequest({})).toThrow(message);
    expect(() => resolveRequest({ operation: 'get_issue', query: 'query { viewer { id } }' })).toThrow(message);
  });

  it('teaches help for unknown operations and the example for invalid parameters', () => {
    expect(() => resolveRequest({ operation: 'missing' })).toThrow(
      'Unknown Linear operation "missing". Send { "operation": "help" }.',
    );
    expect(() => resolveRequest({ operation: 'get_issue', variables: { teamKey: 'AEO', extra: true } })).toThrow(
      'Invalid parameters for "get_issue": missing issue; unknown extra. Valid parameters: issue: IssueReference (required), view: ResultView (optional). Example: { "operation": "get_issue", "variables": { "issue": "AEO-258" } }.',
    );
  });

  it.each([
    ['canonical', 'update_document', { documentId: 'document-id', trashed: true }],
    ['compatibility alias', 'add_comment', { input: { issueId: 'issue-id', body: 'text', trashed: true } }],
  ])('rejects destructive input on the %s named surface before credentials or fetch', async (_surface, operation, variables) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const tool = linearApiTool() as any;

    await expect(tool.execute(
      'call-1',
      { operation, variables },
      undefined,
      undefined,
      { hasUI: false },
    )).rejects.toThrow(/Destructive named input is unavailable at variables(?:\.input)?\.trashed/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['policy', { issue: 'AEO-258', lin_api_secret123456789: { trashed: true } }],
    ['validation', { issue: 'AEO-258', lin_api_secret123456789: true }],
  ])('redacts credential-shaped keys from pre-auth named %s errors', async (_kind, variables) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    const failure = await (linearApiTool() as any).execute(
      'call-1',
      { operation: 'get_issue', variables },
      undefined,
      undefined,
      { hasUI: false },
    ).catch((error: Error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('[REDACTED]');
    expect((failure as Error).message).not.toContain('secret123456789');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves explicitly authorized raw GraphQL mutations, including raw trashed variables', async () => {
    process.env.LINEAR_API_KEY = 'test-key';
    process.env.LINEAR_MUTATIONS = 'all';
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      data: { documentUpdate: { success: true } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    try {
      await expect((linearApiTool() as any).execute(
        'call-1',
        {
          query: 'mutation Raw($id: String!, $input: DocumentUpdateInput!) { documentUpdate(id: $id, input: $input) { success } }',
          variables: { id: 'document-id', input: { trashed: true } },
        },
        undefined,
        undefined,
        { hasUI: false },
      )).resolves.toMatchObject({ details: { data: { documentUpdate: { success: true } } } });
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      delete process.env.LINEAR_MUTATIONS;
    }
  });

  it('does not let LINEAR_MUTATIONS=all bypass named destructive input rejection', async () => {
    process.env.LINEAR_MUTATIONS = 'all';
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      await expect((linearApiTool() as any).execute(
        'call-1',
        { operation: 'update_document', variables: { documentId: 'document-id', trashed: true } },
        undefined,
        undefined,
        { hasUI: false },
      )).rejects.toThrow('Destructive named input is unavailable at variables.trashed');
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      delete process.env.LINEAR_MUTATIONS;
    }
  });

  it('preserves read-only mutation rejection precedence for destructive named input', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect((linearApiTool('readonly') as any).execute(
      'call-1',
      { operation: 'update_document', variables: { documentId: 'document-id', trashed: true } },
      undefined,
      undefined,
      { hasUI: false },
    )).rejects.toThrow('read-only mode');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('runtime discovery', () => {
  function execute(tool: any, params: Record<string, unknown>) {
    return tool.execute('call-1', params, undefined, undefined, { hasUI: false });
  }

  it('keeps the description compact and bootstraps exact help', () => {
    const tool = linearApiTool() as any;
    expect(tool.description).toContain('{ "operation": "help", "variables": { "operation": "<name>" } }');
    expect(tool.description).not.toContain('REFERENCE.md');
    expect(tool.description).not.toContain('/REFERENCE');
    expect(tool.description).not.toContain('get_issue(');
  });

  it('returns zero-argument, domain, and operation help without network calls', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const tool = linearApiTool() as any;

    const root = await execute(tool, { operation: 'help' });
    expect(root.details).toEqual({
      domains: DOMAINS,
      domainHelp: { operation: 'help', variables: { domain: 'issues' } },
      operationHelp: { operation: 'help', variables: { operation: 'get_issue' } },
    });

    const domain = await execute(tool, { operation: 'help', variables: { domain: 'issues' } });
    expect(domain.details.operations.map(({ name }: any) => name)).toEqual([
      'list_issues', 'get_issue', 'create_issue', 'update_issue', 'search_issues',
    ]);

    const comments = await execute(tool, { operation: 'help', variables: { domain: 'comments' } });
    expect(comments.details.operations.map(({ name }: any) => name)).toEqual([
      'list_comments', 'create_comment', 'update_comment',
    ]);
    const relations = await execute(tool, { operation: 'help', variables: { domain: 'relations' } });
    expect(relations.details.operations.map(({ name }: any) => name)).toEqual([
      'list_issue_relations', 'create_issue_relation', 'update_issue_relation',
      'list_project_relations', 'create_project_relation', 'update_project_relation',
    ]);
    const workspace = await execute(tool, { operation: 'help', variables: { domain: 'workspace' } });
    expect(workspace.details.operations.map(({ name }: any) => name)).toEqual([
      'list_issue_statuses', 'switch_workspace',
    ]);
    expect(JSON.stringify([comments.details, relations.details, workspace.details])).not.toMatch(
      /add_comment|create_relation|list_workflow_states/,
    );

    const aliasCards = await Promise.all([
      execute(tool, { operation: 'help', variables: { operation: 'add_comment' } }),
      execute(tool, { operation: 'help', variables: { operation: 'create_relation' } }),
      execute(tool, { operation: 'help', variables: { operation: 'list_workflow_states' } }),
    ]);
    expect(aliasCards.map(({ details }: any) => details.name)).toEqual([
      'create_comment',
      'create_issue_relation',
      'list_issue_statuses',
    ]);
    expect(aliasCards[0].details).toMatchObject({
      example: { operation: 'create_comment', variables: { issue: 'AEO-258', body: 'Comment text' } },
    });
    for (const card of aliasCards) expect(card.details).not.toHaveProperty('aliases');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects ambiguous and invalid help with exact alternatives before network access', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const tool = linearApiTool() as any;
    const alternatives = 'Send exactly one of: { "operation": "help" }, { "operation": "help", "variables": { "domain": "issues" } }, or { "operation": "help", "variables": { "operation": "get_issue" } }.';
    const naturalSearch = 'Natural search was removed. The operation catalog is in the `linear` tool description. Send `{ "operation": "help", "variables": { "operation": "get_issue" } }` for exact parameters, or call the operation directly.';

    await expect(execute(tool, { operation: 'help', variables: { domain: 'issues', operation: 'get_issue' } }))
      .rejects.toThrow(alternatives);
    await expect(execute(tool, { operation: 'help', variables: { query: 'issue lookup by identifier' } }))
      .rejects.toThrow(naturalSearch);
    await expect(execute(tool, { operation: 'help', variables: { search: 'comment issue create comment' } }))
      .rejects.toThrow(naturalSearch);
    await expect(execute(tool, { operation: 'help', variables: { query: 'issues', search: 'comments' } }))
      .rejects.toThrow(naturalSearch);
    await expect(execute(tool, { operation: 'help', variables: { domain: 'issues', query: 'comments' } }))
      .rejects.toThrow(naturalSearch);
    await expect(execute(tool, { operation: 'help', variables: { domain: 'issues', includeSchema: true } }))
      .rejects.toThrow(alternatives);
    await expect(execute(tool, { operation: 'help', variables: { query: 'issues', includeSchema: 'yes' } }))
      .rejects.toThrow(naturalSearch);
    await expect(execute(tool, { operation: 'help', variables: { query: 42 } }))
      .rejects.toThrow(naturalSearch);
    await expect(execute(tool, { operation: 'help', variables: { domain: 'unknown' } }))
      .rejects.toThrow(alternatives);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects unknown operations and wrong parameters before network access', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const tool = linearApiTool() as any;

    await expect(execute(tool, { operation: 'missing' })).rejects.toThrow(
      'Unknown Linear operation "missing". Send { "operation": "help" }.',
    );
    await expect(execute(tool, { operation: 'get_issue', variables: { teamKey: 'AEO' } })).rejects.toThrow(
      'Valid parameters: issue: IssueReference (required), view: ResultView (optional). Example: { "operation": "get_issue", "variables": { "issue": "AEO-258" } }.',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('redacts credential forms from help failures', async () => {
    const token = 'lin_api_secret123456789';
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const failure = await execute(linearApiTool() as any, {
      operation: 'help',
      variables: { operation: token },
    }).catch((error: Error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('[REDACTED]');
    expect((failure as Error).message).not.toContain(token);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('redacts credential forms from malformed raw GraphQL failures', async () => {
    const token = 'lin_api_secret123456789';
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const failure = await execute(linearApiTool() as any, { query: token })
      .catch((error: Error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('[REDACTED]');
    expect((failure as Error).message).not.toContain(token);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('reference preparation pipeline', () => {
  const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
  const RELATED_ID = '22222222-2222-4222-8222-222222222222';
  const TEAM_ID = '33333333-3333-4333-8333-333333333333';
  const STATE_ID = '44444444-4444-4444-8444-444444444444';

  function execute(tool: any, params: Record<string, unknown>) {
    return tool.execute('call-1', params, undefined, undefined, { hasUI: false });
  }

  function installGraphqlServer() {
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
      requests.push(request);
      const { query, variables } = request;
      const resolvedIssue = (value: unknown) => {
        const raw = String(value);
        if (raw === RELATED_ID || /^AEO-259$/i.test(raw)) {
          return { id: RELATED_ID, identifier: 'AEO-259', team: { id: TEAM_ID, key: 'AEO' } };
        }
        return { id: ISSUE_ID, identifier: /^AEO-\d+$/i.test(raw) ? raw.toUpperCase() : 'AEO-258', team: { id: TEAM_ID, key: 'AEO' } };
      };
      let data: Record<string, unknown>;
      if (query.includes('ResolveIssueById')) {
        data = { issue: resolvedIssue(variables.id) };
      } else if (query.includes('ResolveStateByName')) {
        data = { workflowStates: { nodes: [{ id: STATE_ID, name: 'Backlog', team: { id: TEAM_ID } }] } };
      } else if (query.includes('ResolveStateById')) {
        data = { workflowState: { id: STATE_ID, name: 'Backlog', team: { id: TEAM_ID } } };
      } else if (query.includes('mutation CreateComment')) {
        data = { commentCreate: { success: true, comment: { id: 'comment-1', body: (variables.input as any).body } } };
      } else if (query.includes('mutation CreateIssueRelation')) {
        data = { issueRelationCreate: { success: true, issueRelation: { id: 'relation-1', type: (variables.input as any).type } } };
      } else if (query.includes('mutation UpdateIssue')) {
        data = { issueUpdate: { success: true, issue: resolvedIssue(variables.id) } };
      } else {
        data = { issue: resolvedIssue(variables.id) };
      }
      return { ok: true, status: 200, statusText: 'OK', headers: new Headers(), json: async () => ({ data }) };
    });
    vi.stubGlobal('fetch', fetch);
    process.env.LINEAR_API_KEY = 'test-key';
    return requests;
  }

  it('normalizes canonical and legacy variable shapes to final GraphQL variables', async () => {
    const requests = installGraphqlServer();
    const tool = linearApiTool() as any;
    const calls = [
      { operation: 'get_issue', variables: { issue: 'AEO-258' } },
      { operation: 'get_issue', variables: { teamKey: 'AEO', number: 258 } },
      { operation: 'create_comment', variables: { issue: 'AEO-258', body: 'canonical' } },
      { operation: 'add_comment', variables: { issueId: ISSUE_ID, body: 'legacy' } },
      { operation: 'create_issue_relation', variables: { issue: 'AEO-258', relatedIssue: 'AEO-259', type: 'related' } },
      { operation: 'create_relation', variables: { issueId: ISSUE_ID, relatedIssueId: RELATED_ID, type: 'blocks' } },
      { operation: 'update_issue_state', variables: { issue: 'AEO-258', state: 'Backlog' } },
      { operation: 'update_issue_state', variables: { issueId: ISSUE_ID, stateId: STATE_ID } },
    ];
    const results = [];
    for (const call of calls) results.push(await execute(tool, call));

    const final = requests.filter(({ query }) => !query.includes('Resolve'));
    expect(final.map(({ variables }) => variables)).toEqual([
      { id: 'AEO-258' },
      { id: 'AEO-258' },
      { input: { body: 'canonical', issueId: ISSUE_ID } },
      { input: { issueId: ISSUE_ID, body: 'legacy' } },
      { input: { issueId: ISSUE_ID, relatedIssueId: RELATED_ID, type: 'related' } },
      { input: { issueId: ISSUE_ID, relatedIssueId: RELATED_ID, type: 'blocks' } },
      { id: 'AEO-258', input: { stateId: STATE_ID } },
      { id: ISSUE_ID, input: { stateId: STATE_ID } },
    ]);
    expect(results[2].details.resolution.target).toEqual({
      requested: 'AEO-258', resolvedId: ISSUE_ID, identifier: 'AEO-258',
    });
    expect(results[4].details.resolution.relatedTarget).toMatchObject({
      requested: 'AEO-259', resolvedId: RELATED_ID, identifier: 'AEO-259',
    });
  });

  it.each([
    ['create_comment', { issue: 'AEO-404', body: 'no' }],
    ['create_issue_relation', { issue: 'AEO-404', relatedIssue: 'AEO-405', type: 'related' }],
    ['update_issue_state', { issue: 'AEO-404', state: 'Backlog' }],
  ])('prevents %s mutation when issue resolution fails', async (operation, variables) => {
    process.env.LINEAR_API_KEY = 'test-key';
    const queries: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as { query: string };
      queries.push(request.query);
      return {
        ok: true, status: 200, statusText: 'OK', headers: new Headers(),
        json: async () => ({ data: { issue: null } }),
      };
    }));
    await expect(execute(linearApiTool() as any, { operation, variables })).rejects.toThrow('was not found');
    expect(queries.some((query) => query.trimStart().startsWith('mutation'))).toBe(false);
  });
});

describe('compactLinearResult', () => {
  it('reports each capped nodes path with its nearest cursor', () => {
    const nodes = Array.from({ length: NODE_CAP + 2 }, (_, id) => ({ id }));
    const result = compactLinearResult({
      issues: { nodes, pageInfo: { endCursor: 'issue-cursor' }, nested: { nodes } },
    });

    expect(result.data.issues.nodes).toHaveLength(NODE_CAP);
    expect(result.data.issues.nested.nodes).toHaveLength(NODE_CAP);
    expect(result.meta.truncations).toEqual([
      { path: 'issues.nodes', kept: NODE_CAP, endCursor: 'issue-cursor' },
      { path: 'issues.nested.nodes', kept: NODE_CAP },
    ]);
  });

  it('clips long strings with a refetch marker', () => {
    const result = compactLinearResult({ body: 'x'.repeat(STRING_CAP + 17) });
    expect(result.data.body).toBe(
      `${'x'.repeat(STRING_CAP)}…[truncated ${STRING_CAP}/${STRING_CAP + 17} chars — refetch with a narrower query]`,
    );
    expect(result.meta.stringsClipped).toBe(1);
  });

  it('drops complete values to keep the serialized result in budget', () => {
    const result = compactLinearResult(
      { rows: Array.from({ length: 20 }, (_, id) => ({ id, value: 'x'.repeat(100) })) },
      { resultBudget: 500 },
    );
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(500);
    expect(result.meta.resultBudget).toEqual({ maxBytes: 500, truncated: true });
    expect(result.data.rows.length).toBeLessThan(20);
  });

  it('uses the 50KB default result budget', () => {
    expect(RESULT_BUDGET).toBe(50 * 1024);
  });
});

describe('result routing', () => {
  it('auto-spills results above the default threshold', async () => {
    expect(AUTO_SPILL_BYTES).toBe(8 * 1024);
    await artifactRoot();
    const result = await routeLinearResult({ body: 'x'.repeat(AUTO_SPILL_BYTES) }, { label: 'get_issue' });

    expect(result).toMatchObject({ bytes: expect.any(Number), path: expect.stringContaining('/linear/raw/get_issue-') });
    expect(result).not.toHaveProperty('data');
  });

  it('honors forced artifact and inline sinks', async () => {
    await artifactRoot();
    const forcedArtifact = await routeLinearResult({ ok: true }, { label: 'query', sink: 'artifact' });
    const forcedInline = await routeLinearResult(
      { body: 'x'.repeat(AUTO_SPILL_BYTES + 1) },
      { label: 'query', sink: 'inline' },
    );

    expect(forcedArtifact).toHaveProperty('path');
    expect(forcedInline).toHaveProperty('data');
    expect(forcedInline).not.toHaveProperty('path');
  });

  it('indexes issue-like nodes and caps the index at 50 lines', async () => {
    await artifactRoot();
    const nodes = Array.from({ length: 52 }, (_, index) => ({
      identifier: `AEO-${index + 1}`,
      title: `Issue ${index + 1}`,
      state: { name: 'Open' },
    }));
    const result = await routeLinearResult({ issues: { nodes } }, { label: 'query', sink: 'artifact' });

    expect('index' in result).toBe(true);
    if (!('index' in result)) throw new Error('Expected artifact result.');
    expect(result.index).toHaveLength(51);
    expect(result.index[0]).toBe('AEO-1 · Issue 1 · Open');
    expect(result.index[50]).toBe('+2 more');
  });

  it('indexes top-level keys and connection node counts for non-issue results', async () => {
    await artifactRoot();
    const result = await routeLinearResult(
      { teams: { nodes: [{ id: '1' }, { id: '2' }] }, viewer: { id: 'me' } },
      { label: 'list_teams', sink: 'artifact' },
    );

    expect('index' in result).toBe(true);
    if (!('index' in result)) throw new Error('Expected artifact result.');
    expect(result.index).toEqual(['teams · 2 nodes', 'viewer']);
  });

  it('writes complete strings to the artifact without inline clipping', async () => {
    await artifactRoot();
    const body = 'x'.repeat(STRING_CAP + 792);
    const result = await routeLinearResult({ comments: { nodes: [{ body }] } }, { label: 'get_issue', sink: 'artifact' });
    expect('path' in result).toBe(true);
    if (!('path' in result)) throw new Error('Expected artifact result.');
    const file = JSON.parse(await readFile(result.path, 'utf8'));

    expect(file.data.comments.nodes[0].body).toBe(body);
    expect(result.meta).toEqual({ truncations: [], stringsClipped: 0 });
    expect(Buffer.byteLength(JSON.stringify(file))).toBe(result.bytes);
  });

  it('uses LINEAR_SPILL_BYTES as the auto-spill threshold', async () => {
    await artifactRoot();
    process.env.LINEAR_SPILL_BYTES = '100';
    const result = await routeLinearResult({ body: 'x'.repeat(100) }, { label: 'query' });

    expect(result).toHaveProperty('path');
  });
});

describe('read-only tool', () => {
  it('rejects a mutation before credential lookup or network access', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const tool = linearApiTool('readonly') as any;

    await expect(tool.execute(
      'call-1',
      { query: 'mutation { issueCreate(input: { teamId: "x", title: "x" }) { success } }' },
      undefined,
      undefined,
      { hasUI: false },
    )).rejects.toThrow('read-only mode');
    expect(fetch).not.toHaveBeenCalled();
  });
});
