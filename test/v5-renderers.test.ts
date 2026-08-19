import { afterEach, describe, expect, it, vi } from 'vitest';
import { getOperation } from '../extensions/operations';
import { operationRenderers, renderLinearApiCall, renderLinearApiResult } from '../extensions/renderers';
import { executeOperation } from '../extensions/runtime';
import { isolateLinearCredentials } from './helpers/credentials';

isolateLinearCredentials();

const ORIGINAL_API_KEY = process.env.LINEAR_API_KEY;

afterEach(() => {
  if (ORIGINAL_API_KEY === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = ORIGINAL_API_KEY;
  vi.unstubAllGlobals();
});

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
} as any;

const WIDTH = 120;

function lines(component: any): string[] {
  return component.render(WIDTH);
}

function block(component: any): string {
  return lines(component).join('\n');
}

function result(details: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details } as any;
}

const meta = { truncations: [], stringsClipped: 0 };

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

function render(
  operationName: string,
  details: unknown,
  options: { expanded?: boolean; isPartial?: boolean } = {},
  context: Record<string, unknown> = {},
) {
  const renderers = operationRenderers(getOperation(operationName));
  return renderers.renderResult(
    result(details),
    { expanded: options.expanded ?? false, isPartial: options.isPartial ?? false },
    theme,
    context as any,
  );
}

describe('typed tool call row', () => {
  it('leads with the tool name and the arguments that identify the target', () => {
    const renderers = operationRenderers(getOperation('get_issue'));
    const text = block(renderers.renderCall({ issue: 'AEO-258' }, theme, {} as any));
    expect(text).toContain('linear_get_issue');
    expect(text).toContain('issue=AEO-258');
  });

  it('scrubs credentials out of argument values', () => {
    const renderers = operationRenderers(getOperation('get_issue'));
    const text = block(renderers.renderCall({ issue: 'lin_api_secret123' }, theme, {} as any));
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('secret123');
  });
});

describe('result states', () => {
  it('shows a pending state while the call streams', () => {
    const text = block(render('get_issue', undefined, { isPartial: true }));
    expect(text).toContain('Loading issue…');
  });

  it('renders one status line for a single entity', () => {
    const text = block(render('get_issue', { data: { issue: ISSUE }, meta }));
    expect(text).toContain('✓ Loaded AEO-258 Fix login redirect');
    expect(text).toContain('In Progress · High · @sam · bug');
    expect(text).toContain('https://linear.app/aeo/issue/AEO-258');
  });

  it('renders an aligned table for a list result', () => {
    const text = block(render('list_issues', {
      data: { issues: { nodes: [ISSUE, { ...ISSUE, identifier: 'AEO-9', title: 'Second' }], pageInfo: { hasNextPage: false } } },
      meta,
    }));
    expect(text).toContain('2 issues returned');
    expect(text).toContain('ID');
    expect(text).toContain('Status');
    expect(text).toContain('AEO-258');
    expect(text).toContain('AEO-9');
    const rows = lines(render('list_issues', {
      data: { issues: { nodes: [ISSUE, { ...ISSUE, identifier: 'AEO-9', title: 'Second' }] } },
      meta,
    })).filter((line) => line.includes('AEO-'));
    expect(rows[0]!.indexOf('Fix login redirect')).toBe(rows[1]!.indexOf('Second'));
  });

  it('states the fact and the way forward when a list is empty', () => {
    const text = block(render('list_issues', { data: { issues: { nodes: [] } }, meta }));
    expect(text).toContain('No issues exist in the selected workspace.');
    expect(text).toContain('Check another workspace');
  });

  it('names the next page cursor when results were truncated', () => {
    const text = block(render('list_issues', {
      data: { issues: { nodes: [ISSUE], pageInfo: { hasNextPage: true, endCursor: 'cursor-1' } } },
      meta: { truncations: [{ path: 'issues.nodes', kept: 100, endCursor: 'cursor-1' }], stringsClipped: 2 },
    }));
    expect(text).toContain('kept 100 nodes — request the next page with after="cursor-1"');
    expect(text).toContain('2 long fields clipped');
  });

  it('reports a mutation outcome with the affected record', () => {
    const text = block(render('update_issue', {
      data: { issueUpdate: { success: true, issue: ISSUE } },
      meta,
      resolution: { target: { requested: 'AEO-258', resolvedId: 'issue-1', identifier: 'AEO-258' } },
    }));
    expect(text).toContain('✓ Updated AEO-258 Fix login redirect');
  });

  it('renders a failed named mutation through the execution error path', async () => {
    process.env.LINEAR_API_KEY = 'test-key';
    const issueId = '11111111-1111-4111-8111-111111111111';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const { query } = JSON.parse(String(init.body)) as { query: string };
      const data = query.includes('ResolveIssueById')
        ? { issue: { id: issueId, identifier: 'AEO-258', team: { id: 'team-1', key: 'AEO' } } }
        : { issueUpdate: { success: false, issue: null } };
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    let error: unknown;
    try {
      await executeOperation(
        getOperation('update_issue'),
        { variables: { issue: issueId, title: 'Updated title' } },
        'allowlist',
        { hasUI: false } as any,
        undefined,
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const text = block(render(
      'update_issue',
      { error: (error as Error).message },
      {},
      { isError: true },
    ));
    expect(text).toContain('✗');
    expect(text).toContain('issueUpdate.success must be true');
    expect(text).not.toContain('status unknown');
  });

  it('keeps legacy pre-validation envelopes explicitly unconfirmed', () => {
    const text = block(render('update_issue', { data: { issueUpdate: { success: false } }, meta }));
    expect(text).toContain('Updated issue: status unknown');
    expect(text).toContain('Re-read the record to confirm');
  });

  it('renders a spilled result as a digest plus the artifact path', () => {
    const text = block(render('list_issues', {
      path: '/tmp/linear/raw/list_issues.json',
      bytes: 42_000,
      index: ['AEO-258 · Fix login redirect · In Progress'],
      meta,
    }));
    expect(text).toContain('41 KB written to disk');
    expect(text).toContain('/tmp/linear/raw/list_issues.json');
    expect(text).toContain('AEO-258 · Fix login redirect');
    expect(text).toContain('Read the file for the full payload.');
  });

  it('shows the error and the next valid action, never a credential', () => {
    const text = block(render(
      'get_issue',
      { error: 'Linear rejected key lin_api_abc123def' },
      {},
      { isError: true },
    ));
    expect(text).toContain('✗');
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('abc123def');
    expect(text).toContain('call linear_get_issue again');
  });

  it('shows raw JSON when the row is expanded', () => {
    const text = block(render('get_issue', { data: { issue: ISSUE }, meta }, { expanded: true }));
    expect(text).toContain('Full JSON response');
    expect(text).toContain('"identifier":"AEO-258"');
  });

  it('renders a workspace switch without a Linear entity', () => {
    const text = block(render('switch_workspace', { active: 'work' }));
    expect(text).toContain('work');
  });
});

describe('linear_api rendering', () => {
  function apiResult(details: unknown, args: Record<string, unknown>, options: Record<string, boolean> = {}) {
    return renderLinearApiResult(
      result(details),
      { expanded: options.expanded ?? false, isPartial: options.isPartial ?? false },
      theme,
      { args } as any,
    );
  }

  it('labels the call with the operation and its variables', () => {
    const text = block(renderLinearApiCall({ operation: 'get_issue', variables: { issue: 'AEO-258' } }, theme));
    expect(text).toContain('linear_api');
    expect(text).toContain('get_issue');
    expect(text).toContain('issue=AEO-258');
  });

  it('renders operation results with the same language as the typed tools', () => {
    const text = block(apiResult({ data: { issue: ISSUE }, meta }, { operation: 'get_issue' }));
    expect(text).toContain('✓ Loaded AEO-258 Fix login redirect');
  });

  it('renders a parameter card and reports the tool it loaded', () => {
    const text = block(apiResult(
      {
        loadedTools: ['linear_get_issue'],
        name: 'get_issue',
        purpose: 'Get one issue.',
        parameters: [{ name: 'issue', type: 'IssueReference', required: true }],
        example: { operation: 'get_issue', variables: { issue: 'AEO-258' } },
      },
      { operation: 'help', variables: { operation: 'get_issue' } },
    ));
    expect(text).toContain('✓ get_issue');
    expect(text).toContain('issue');
    expect(text).toContain('IssueReference');
    expect(text).toContain('✓ loaded 1 tool');
    expect(text).toContain('linear_get_issue');
  });

  it('renders the domain index', () => {
    const text = block(apiResult({ domains: ['issues', 'comments'] }, { operation: 'help' }));
    expect(text).toContain('2 domains');
    expect(text).toContain('issues  comments');
  });

  it('points a failed call at the parameter card', () => {
    const text = block(renderLinearApiResult(
      result({ error: 'Invalid parameters' }),
      { expanded: false, isPartial: false },
      theme,
      { args: { operation: 'get_issue' }, isError: true } as any,
    ));
    expect(text).toContain('"operation": "get_issue"');
  });
});

describe('data extremes', () => {
  const issue = (index: number) => ({
    identifier: `AEO-${index}`,
    title: `Issue ${index}`,
    state: { name: 'Todo' },
  });

  it('previews a large list and says how much is left', () => {
    const text = block(render('list_issues', {
      data: { issues: { nodes: Array.from({ length: 1000 }, (_, index) => issue(index)) } },
      meta,
    }));
    expect(text).toContain('1000 issues returned');
    expect(text).toContain('980 more issues in the JSON');
  });

  it('keeps columns aligned for long titles, emoji, and a single row', () => {
    const rows = lines(render('list_issues', {
      data: { issues: { nodes: [
        { identifier: 'AEO-1', title: '🚀 '.repeat(30), state: { name: 'Todo' } },
        { identifier: 'AEO-2', title: 'x'.repeat(300), state: { name: 'Todo' } },
      ] } },
      meta,
    })).filter((line) => line.includes('AEO-'));

    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(WIDTH * 4);
    expect(rows[0]!.indexOf('🚀')).toBe(rows[1]!.indexOf('xxx'));
  });

  it('renders a single-row list without a header collapse', () => {
    const text = block(render('list_issues', { data: { issues: { nodes: [issue(1)] } }, meta }));
    expect(text).toContain('1 issue returned');
    expect(text).toContain('AEO-1');
  });
});

describe('escape hatch and local operations', () => {
  it('summarises a raw GraphQL response without borrowing entity language', () => {
    const text = block(renderLinearApiResult(
      result({ data: { viewer: { id: 'user-1', name: 'sam' } }, meta }),
      { expanded: false, isPartial: false },
      theme,
      { args: { query: 'query { viewer { id name } }' } } as any,
    ));
    expect(text).toContain('✓ GraphQL response');
    expect(text).toContain('Keys: viewer');
    expect(text).toContain('viewer: object · 2 keys');
    expect(text).not.toContain('Loaded');
  });

  it('reports a workspace switch as a status line', () => {
    const text = block(render('switch_workspace', { active: 'work' }));
    expect(text).toContain('✓ Switched workspace work');
  });
});

describe('credential safety in rendered rows', () => {
  const token = 'lin_api_secret123456789';

  it('scrubs a credential in a direct linear_api variable', () => {
    const text = block(renderLinearApiCall({ operation: 'get_issue', variables: { token } }, theme));
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('secret123456789');
  });

  it('scrubs a credential nested inside a linear_api variable key or value', () => {
    const text = block(renderLinearApiCall(
      {
        operation: 'get_issue',
        variables: { headers: { Authorization: `Bearer ${token}` }, list: [token], [token]: 'safe' },
      },
      theme,
    ));
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('secret123456789');
  });

  it('scrubs a credential in a raw GraphQL query call row', () => {
    const text = block(renderLinearApiCall({ query: `query { viewer { id } } # ${token}`, variables: { key: token } }, theme));
    expect(text).not.toContain('secret123456789');
  });

  it('scrubs a credential in a typed tool call row', () => {
    const renderers = operationRenderers(getOperation('create_comment'));
    const text = block(renderers.renderCall({ issue: 'AEO-258', body: token }, theme, {} as any));
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('secret123456789');
  });

  it('scrubs a credential in expanded JSON keys and values on both surfaces', () => {
    const details = { data: { issue: { identifier: 'AEO-1', title: token, [token]: 'safe' } }, meta };
    const expandedTyped = block(render('get_issue', details, { expanded: true }));
    expect(expandedTyped).toContain('[REDACTED]');
    expect(expandedTyped).not.toContain('secret123456789');

    const expandedApi = block(renderLinearApiResult(
      result(details),
      { expanded: true, isPartial: false },
      theme,
      { args: { operation: 'get_issue' } } as any,
    ));
    expect(expandedApi).not.toContain('secret123456789');
  });

  it('scrubs a credential in an error row', () => {
    const text = block(render('get_issue', { error: `rejected key ${token}` }, {}, { isError: true }));
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('secret123456789');
  });
});

describe('credential safety in result data', () => {
  const token = 'lin_api_secret123456789';

  it('scrubs a credential carried inside Linear content', () => {
    const listed = block(render('list_issues', {
      data: { issues: { nodes: [{ identifier: 'AEO-1', title: `key ${token}`, state: { name: 'Todo' } }] } },
      meta,
    }));
    expect(listed).not.toContain('secret123456789');

    const single = block(render('get_issue', {
      data: { issue: { identifier: 'AEO-1', title: 'x', description: token } },
      meta,
    }));
    expect(single).not.toContain('secret123456789');

    const spilled = block(render('list_issues', {
      path: '/tmp/x.json', bytes: 2048, index: [`AEO-1 · ${token} · Todo`], meta,
    }));
    expect(spilled).not.toContain('secret123456789');
  });

  it('scrubs a credential in a raw GraphQL summary row', () => {
    const text = block(renderLinearApiResult(
      result({ data: { viewer: { token } }, meta }),
      { expanded: false, isPartial: false },
      theme,
      { args: { query: 'query { viewer { token } }' } } as any,
    ));
    expect(text).not.toContain('secret123456789');
  });
});

describe('discovery feedback', () => {
  it('says that nothing was loaded and lists the candidates', () => {
    const text = block(renderLinearApiResult(
      result({
        query: 'issues',
        note: 'No clause named exactly one operation, so no tool was loaded.',
        candidates: [
          { name: 'list_issues', signature: 'list_issues(query?: String)' },
          { name: 'get_issue', signature: 'get_issue(issue: IssueReference)' },
        ],
      }),
      { expanded: false, isPartial: false },
      theme,
      { args: { operation: 'help', variables: { query: 'issues' } } } as any,
    ));
    expect(text).toContain('No tool loaded for "issues"');
    expect(text).toContain('Name one operation, or pick a candidate below.');
    expect(text).toContain('list_issues(query?: String)');
    expect(text).not.toContain('GraphQL response');
  });
});

describe('clearing a field', () => {
  it('shows an explicit null in the call row', () => {
    const renderers = operationRenderers(getOperation('update_issue'));
    const text = block(renderers.renderCall({ issue: 'AEO-258', dueDate: null }, theme, {} as any));
    expect(text).toContain('dueDate=null');
  });
});
