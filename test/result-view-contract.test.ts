import { afterEach, describe, expect, it, vi } from 'vitest';
import { linearApiTool } from '../extensions/api';
import { getOperation, operations } from '../extensions/operations';
import { operationRenderers, SUMMARY_VIEW_NOTICE } from '../extensions/renderers';
import { compactLinearResult, executeOperation, RESULT_BUDGET } from '../extensions/runtime';
import { projection } from '../extensions/selections';
import { buildTypedToolMetadata } from '../extensions/typed-tool-metadata';
import { isolateLinearCredentials } from './helpers/credentials';

isolateLinearCredentials();

const ORIGINAL_API_KEY = process.env.LINEAR_API_KEY;

afterEach(() => {
  if (ORIGINAL_API_KEY === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = ORIGINAL_API_KEY;
  vi.unstubAllGlobals();
});

const VIEWABLE_LISTS = ['list_issues', 'search_issues', 'list_projects', 'list_documents'] as const;
const VIEWABLE_GETS = ['get_issue', 'get_project', 'get_document'] as const;
const NOTICE = 'Fields narrowed — use view="full" for complete fields.';

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
} as any;

const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';

const ISSUE = {
  id: 'issue-1',
  identifier: 'AEO-258',
  title: 'Fix login redirect',
  description: 'The redirect drops the return path.',
  url: 'https://linear.app/aeo/issue/AEO-258',
  priorityLabel: 'High',
  state: { name: 'In Progress' },
  assignee: { name: 'sam' },
  labels: { nodes: [{ name: 'bug' }] },
};

function result(details: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details } as any;
}

function render(operationName: string, details: unknown) {
  return operationRenderers(getOperation(operationName)).renderResult(
    result(details),
    { expanded: false, isPartial: false },
    theme,
    {} as any,
  ).render(120);
}

function enumValues(schema: { enum?: string[]; anyOf?: Array<{ const?: string }> } | undefined): string[] | undefined {
  if (!schema) return undefined;
  if (schema.enum) return schema.enum;
  if (schema.anyOf) {
    const values = schema.anyOf.map((entry) => entry.const).filter((value): value is string => typeof value === 'string');
    return values.length ? values : undefined;
  }
  return undefined;
}

function capturedRequests() {
  const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    requests.push(body);
    const { query } = body;
    const data = query.includes('query ListIssues')
      ? { issues: { nodes: [ISSUE, { ...ISSUE, identifier: 'AEO-9', title: 'Second' }], pageInfo: { hasNextPage: false } } }
      : query.includes('query SearchIssues')
        ? { searchIssues: { nodes: [ISSUE], pageInfo: { hasNextPage: false } } }
        : query.includes('query ListProjects')
          ? { projects: { nodes: [{ id: 'p1', name: 'Platform' }], pageInfo: { hasNextPage: false } } }
          : query.includes('query ListDocuments')
            ? { documents: { nodes: [{ id: 'd1', title: 'Notes' }], pageInfo: { hasNextPage: false } } }
            : query.includes('query GetProject')
              ? { project: { id: 'p1', name: 'Platform' } }
              : query.includes('query GetDocument')
                ? { document: { id: DOCUMENT_ID, title: 'Notes' } }
                : { issue: ISSUE };
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }));
  process.env.LINEAR_API_KEY = 'test-key';
  return requests;
}

async function run(name: string, variables: Record<string, unknown> = {}) {
  return executeOperation(
    getOperation(name),
    { variables },
    'allowlist',
    { hasUI: false } as any,
    undefined,
  );
}

describe('public summary and full views', () => {
  it('publishes view on issue, project, and document reads only', () => {
    for (const name of [...VIEWABLE_LISTS, ...VIEWABLE_GETS]) {
      expect(operations[name]!.canonical.fields.view, name).toBe('ResultView');
      expect(operations[name]!.parameters.some((parameter) => parameter.name === 'view'), name).toBe(true);
      const schema = buildTypedToolMetadata(operations[name]!).parameters as { properties?: { view?: { enum?: string[] } } };
      expect(enumValues(schema.properties?.view), name).toEqual(['summary', 'full']);
    }
    expect(operations.create_issue!.canonical.fields.view).toBeUndefined();
    expect(operations.list_comments!.canonical.fields.view).toBeUndefined();
    expect(operations.update_issue!.canonical.fields.view).toBeUndefined();
  });

  it('defaults lists to summary and singular reads to full', async () => {
    const requests = capturedRequests();
    const list = await run('list_issues');
    const search = await run('search_issues', { term: 'login' });
    const get = await run('get_issue', { issue: 'AEO-258' });
    const project = await run('list_projects');
    const document = await run('get_document', { document: DOCUMENT_ID });

    expect(list.meta).toMatchObject({ view: 'summary' });
    expect(search.meta).toMatchObject({ view: 'summary' });
    expect(get.meta).toMatchObject({ view: 'full' });
    expect(project.meta).toMatchObject({ view: 'summary' });
    expect(document.meta).toMatchObject({ view: 'full' });
    expect(requests[0]!.query).toContain(projection('issue', 'list'));
    expect(requests[0]!.query).not.toContain('description');
    expect(requests[0]!.variables.view).toBeUndefined();
    expect(requests[1]!.query).toContain(projection('issue', 'list'));
    expect(requests[2]!.query).toContain(projection('issue', 'detail'));
    expect(requests[2]!.query).toContain('description');
    expect(requests[3]!.query).toContain(projection('project', 'list'));
    expect(requests[3]!.query).not.toContain('content');
    expect(requests[4]!.query).toContain(projection('document', 'detail'));
    expect(requests[4]!.query).toContain('content');
  });

  it('selects the other projection when view is explicit', async () => {
    const requests = capturedRequests();
    const fullList = await run('list_issues', { view: 'full' });
    const summaryGet = await run('get_issue', { issue: 'AEO-258', view: 'summary' });
    expect(fullList.meta).toMatchObject({ view: 'full' });
    expect(summaryGet.meta).toMatchObject({ view: 'summary' });
    expect(requests[0]!.query).toContain(projection('issue', 'detail'));
    expect(requests[0]!.query).toContain('description');
    expect(requests[0]!.variables.view).toBeUndefined();
    expect(requests[1]!.query).toContain(projection('issue', 'list'));
    expect(requests[1]!.query).not.toContain('description');
  });

  it('paginates issue labels explicitly in both views', () => {
    expect(projection('issue', 'list')).toContain('labels(first: 50)');
    expect(projection('issue', 'detail')).toContain('labels(first: 50)');
    expect(projection('issue', 'list')).not.toContain('labels { nodes');
    expect(projection('issue', 'detail')).not.toContain('labels { nodes');
    expect(operations.create_issue!.document).toContain('labels(first: 50)');
    expect(operations.list_issues!.document).toContain('labels(first: 50)');
    expect(operations.get_issue!.document).toContain('labels(first: 50)');
  });

  it('rejects an unknown view before any network call', async () => {
    const requests = capturedRequests();
    await expect(run('list_issues', { view: 'compact' })).rejects.toThrow('view must be "summary" or "full"');
    await expect(run('get_issue', { issue: 'AEO-258', view: 'compact' })).rejects.toThrow(
      'view must be "summary" or "full"',
    );
    expect(requests).toEqual([]);
  });

  it('keeps linear and typed tools on the same default documents', async () => {
    const requests = capturedRequests();
    await run('list_issues');
    const named = requests.splice(0);
    await (linearApiTool() as any).execute(
      'call-1',
      { operation: 'list_issues', variables: {} },
      undefined,
      undefined,
      { hasUI: false },
    );
    expect(named.map(({ query, variables }) => ({ query, variables }))).toEqual(
      requests.map(({ query, variables }) => ({ query, variables })),
    );
  });
});

describe('summary disclosure', () => {
  it('prints the owner-approved notice before summary list rows', () => {
    expect(SUMMARY_VIEW_NOTICE).toBe(NOTICE);
    const lines = render('list_issues', {
      data: { issues: { nodes: [ISSUE, { ...ISSUE, identifier: 'AEO-9', title: 'Second' }] } },
      meta: { truncations: [], stringsClipped: 0, view: 'summary' },
    });
    const text = lines.join('\n');
    const headline = lines.findIndex((line) => line.includes('2 issues returned · summary view'));
    const notice = lines.findIndex((line) => line.includes(NOTICE));
    const row = lines.findIndex((line) => line.includes('AEO-258'));
    expect(text).toContain('✓ 2 issues returned · summary view');
    expect(headline).toBeGreaterThan(-1);
    expect(notice).toBeGreaterThan(headline);
    expect(row).toBeGreaterThan(notice);
  });

  it('omits the notice on full lists and full singular reads', () => {
    const fullList = render('list_issues', {
      data: { issues: { nodes: [ISSUE] } },
      meta: { truncations: [], stringsClipped: 0, view: 'full' },
    }).join('\n');
    const fullGet = render('get_issue', {
      data: { issue: ISSUE },
      meta: { truncations: [], stringsClipped: 0, view: 'full' },
    }).join('\n');
    expect(fullList).toContain('1 issue returned');
    expect(fullList).not.toContain('summary view');
    expect(fullList).not.toContain(NOTICE);
    expect(fullGet).toContain('Loaded AEO-258');
    expect(fullGet).not.toContain(NOTICE);
  });

  it('states the narrowing on a singular summary read', () => {
    const lines = render('get_issue', {
      data: { issue: ISSUE },
      meta: { truncations: [], stringsClipped: 0, view: 'summary' },
    });
    const headline = lines.findIndex((line) => line.includes('Loaded AEO-258'));
    const notice = lines.findIndex((line) => line.includes(NOTICE));
    expect(headline).toBeGreaterThan(-1);
    expect(notice).toBeGreaterThan(headline);
  });

  it('does not treat view as a list filter', () => {
    const text = operationRenderers(getOperation('list_issues')).renderResult(
      result({ data: { issues: { nodes: [] } }, meta: { truncations: [], stringsClipped: 0, view: 'summary' } }),
      { expanded: false, isPartial: false },
      theme,
      { args: { view: 'summary' } } as any,
    ).render(120).join('\n');
    expect(text).toContain('No issues exist in the selected workspace.');
    expect(text).not.toContain(NOTICE);
  });
});

describe('result budget against summary and full shapes', () => {
  function summaryNode(index: number) {
    return {
      id: `issue-${index}`,
      identifier: `AEO-${index}`,
      number: index,
      title: `Issue ${index}`,
      priority: 3,
      url: `https://linear.app/aeo/issue/AEO-${index}`,
      dueDate: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      priorityLabel: 'Medium',
      state: { id: 'state-1', name: 'In Progress', type: 'started' },
      team: { id: 'team-1', key: 'AEO', name: 'Aeon' },
      assignee: { id: 'user-1', name: 'sam' },
      labels: { nodes: [{ id: 'label-1', name: 'bug' }] },
      project: { id: 'project-1', name: 'Platform' },
    };
  }

  function fullNode(index: number) {
    return {
      ...summaryNode(index),
      description: 'd'.repeat(2_000),
      branchName: `fasal/aeo-${index}-fix`,
      estimate: 2,
      completedAt: null,
      startedAt: '2026-08-01T00:00:00.000Z',
      archivedAt: null,
      trashed: false,
      assignee: { id: 'user-1', name: 'sam', email: 'sam@example.com' },
      labels: {
        nodes: Array.from({ length: 50 }, (_, label) => ({ id: `label-${index}-${label}`, name: `label-${label}` })),
      },
      parent: { id: 'parent-1', identifier: 'AEO-1', title: 'Parent' },
      cycle: { id: 'cycle-1', name: 'Cycle 12', number: 12 },
      creator: { id: 'user-2', name: 'ada', email: 'ada@example.com' },
    };
  }

  it('keeps twenty summary issue nodes under the result budget', () => {
    const compacted = compactLinearResult({
      issues: {
        nodes: Array.from({ length: 20 }, (_, index) => summaryNode(index + 1)),
        pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: 'a', endCursor: 't' },
      },
    });
    expect(compacted.meta.resultBudget).toBeUndefined();
    expect(compacted.data.issues.nodes).toHaveLength(20);
    expect(Buffer.byteLength(JSON.stringify(compacted))).toBeLessThan(RESULT_BUDGET);
  });

  it('drops whole full issue nodes once descriptions and labels blow the budget', () => {
    const compacted = compactLinearResult({
      issues: {
        nodes: Array.from({ length: 20 }, (_, index) => fullNode(index + 1)),
        pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: 'a', endCursor: 't' },
      },
    });
    expect(compacted.meta.resultBudget).toEqual({ maxBytes: RESULT_BUDGET, truncated: true });
    expect(compacted.data.issues.nodes.length).toBeLessThan(20);
    expect(compacted.data.issues.nodes.length).toBeGreaterThan(0);
  });
});
