import { afterEach, describe, expect, it, vi } from 'vitest';
import { getOperation, operations } from '../extensions/operations';
import { operationRenderers, SUMMARY_VIEW_NOTICE } from '../extensions/renderers';
import { compactLinearResult, executeOperation } from '../extensions/runtime';
import { isolateLinearCredentials } from './helpers/credentials';
import type { JsonObject } from '../extensions/runtime';

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

const NOTICE = 'Fields narrowed — use view="full" for complete fields.';
const WIDTHS = [120, 80, 40, 30, 26, 20, 12] as const;

const ISSUE = {
  id: 'issue-1',
  identifier: 'AEO-258',
  title: 'Fix login redirect',
  url: 'https://linear.app/aeo/issue/AEO-258',
};

function result<T>(details: T) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details } as any;
}

function render<T>(operationName: string, details: T, width = 120) {
  return operationRenderers(getOperation(operationName)).renderResult(
    result(details),
    { expanded: false, isPartial: false },
    theme,
    {} as any,
  ).render(width);
}

function text<T>(operationName: string, details: T, width = 120) {
  return render(operationName, details, width).join('\n');
}

function capturedRequests() {
  const requests: Array<{ query: string; variables: JsonObject }> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { query: string; variables: JsonObject };
    requests.push(body);
    const { query } = body;
    const data = query.includes('query SearchIssues')
      ? { searchIssues: { nodes: [ISSUE], pageInfo: { hasNextPage: false }, totalCount: 1 } }
      : query.includes('query ListIssues')
        ? { issues: { nodes: [ISSUE], pageInfo: { hasNextPage: false } } }
        : { issue: ISSUE };
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }));
  process.env.LINEAR_API_KEY = 'test-key';
  return requests;
}

async function run(name: string, variables: JsonObject = {}) {
  return executeOperation(
    getOperation(name),
    { variables },
    'allowlist',
    { hasUI: false } as any,
    undefined,
  );
}

describe('root-specific totalCount', () => {
  it('requests totalCount only on search_issues', () => {
    expect(operations.search_issues!.document).toContain('totalCount');
    expect(operations.list_issues!.document).not.toContain('totalCount');
    for (const operation of Object.values(operations)) {
      if (operation.name === 'search_issues') continue;
      expect(operation.document, operation.name).not.toContain('totalCount');
    }
  });

  it('keeps totalCount on both search views and omits it from list_issues views', async () => {
    const requests = capturedRequests();
    await run('search_issues', { term: 'login' });
    await run('search_issues', { term: 'login', view: 'full' });
    await run('list_issues');
    await run('list_issues', { view: 'full' });

    expect(requests[0]!.query).toContain('totalCount');
    expect(requests[1]!.query).toContain('totalCount');
    expect(requests[2]!.query).not.toContain('totalCount');
    expect(requests[3]!.query).not.toContain('totalCount');
  });

  it('does not request totalCount when search_issues routes to an exact issue', async () => {
    const requests = capturedRequests();
    await run('search_issues', { term: 'AEO-258' });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.query).toContain('query GetIssue');
    expect(requests[0]!.query).not.toContain('totalCount');
  });
});

describe('lossless count metadata', () => {
  it('keeps every node with exact totalCount and server pageInfo', () => {
    const nodes = Array.from({ length: 20 }, (_, index) => ({
      id: `issue-${index}`,
      title: 'x'.repeat(200),
    }));
    const pageInfo = {
      hasNextPage: true,
      hasPreviousPage: false,
      startCursor: 'a',
      endCursor: 'z',
    };
    const compacted = compactLinearResult(
      { searchIssues: { nodes, pageInfo, totalCount: 91 } },
      { resultBudget: 2000 },
    );

    expect(compacted.meta).toEqual({ truncations: [], stringsClipped: 0 });
    expect(compacted.data.searchIssues).toEqual({ nodes, pageInfo, totalCount: 91 });
  });

  it('preserves a zero totalCount on an empty connection', () => {
    const compacted = compactLinearResult({
      searchIssues: {
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
        totalCount: 0,
      },
    });
    expect(compacted.data.searchIssues).toEqual({
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
      totalCount: 0,
    });
  });
});

describe('count-capable list rendering', () => {
  it('keeps a zero search honest', () => {
    const output = text('search_issues', {
      data: {
        searchIssues: {
          nodes: [],
          pageInfo: { hasNextPage: false },
          totalCount: 0,
        },
      },
      meta: { truncations: [], stringsClipped: 0, view: 'summary' },
    });
    expect(output).toContain('No issues matched the search.');
    expect(output).toContain('Change or broaden the search term.');
    expect(output).not.toContain('0 of 0');
    expect(output).not.toContain('more available');
    expect(output).not.toContain(NOTICE);
  });

  it('reports a complete page without more-available copy', () => {
    const output = text('search_issues', {
      data: {
        searchIssues: {
          nodes: [ISSUE, { ...ISSUE, identifier: 'AEO-9', title: 'Second' }],
          pageInfo: { hasNextPage: false },
          totalCount: 2,
        },
      },
      meta: { truncations: [], stringsClipped: 0 },
    });
    expect(output).toContain('2 issues returned');
    expect(output).not.toContain('showing 2 of 2');
    expect(output).not.toContain('more available');
    expect(output).not.toContain('total count is unavailable');
  });

  it('reports an incomplete page as showing N of M, more available', () => {
    const nodes = Array.from({ length: 20 }, (_, index) => ({
      ...ISSUE,
      id: `issue-${index}`,
      identifier: `AEO-${index + 1}`,
    }));
    const output = text('search_issues', {
      data: {
        searchIssues: {
          nodes,
          pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
          totalCount: 91,
        },
      },
      meta: { truncations: [], stringsClipped: 0 },
    });
    expect(output).toContain('showing 20 of 91, more available');
    expect(output).not.toContain('20 issues returned');
    expect(output).toContain('after="cursor-1"');
    expect(output).not.toContain('total count is unavailable');
  });

  it('keeps the summary headline and notice with an incomplete count', () => {
    const lines = render('search_issues', {
      data: {
        searchIssues: {
          nodes: [ISSUE],
          pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
          totalCount: 91,
        },
      },
      meta: { truncations: [], stringsClipped: 0, view: 'summary' },
    });
    const headline = lines.findIndex((line) => line.includes('showing 1 of 91, more available · summary view'));
    const notice = lines.findIndex((line) => line.includes(NOTICE));
    const row = lines.findIndex((line) => line.includes('AEO-258'));
    expect(SUMMARY_VIEW_NOTICE).toBe(NOTICE);
    expect(headline).toBeGreaterThan(-1);
    expect(notice).toBeGreaterThan(headline);
    expect(row).toBeGreaterThan(notice);
  });
});

describe('pageInfo-only issue lists', () => {
  it('states that more results exist without inventing a total', () => {
    const output = text('list_issues', {
      data: {
        issues: {
          nodes: [ISSUE],
          pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
        },
      },
      meta: { truncations: [], stringsClipped: 0 },
    });
    expect(output).toContain('1 issue returned');
    expect(output).toContain('more results exist; total count is unavailable');
    expect(output).toContain('after="cursor-1"');
    expect(output).not.toContain('showing 1 of');
    expect(output).not.toContain('more available');
  });

  it('omits the unavailable-count note when the page is complete', () => {
    const output = text('list_issues', {
      data: {
        issues: { nodes: [ISSUE], pageInfo: { hasNextPage: false } },
      },
      meta: { truncations: [], stringsClipped: 0 },
    });
    expect(output).toContain('1 issue returned');
    expect(output).not.toContain('total count is unavailable');
    expect(output).not.toContain('more available');
  });

  it('keeps an empty list_issues result free of count copy', () => {
    const output = text('list_issues', {
      data: { issues: { nodes: [], pageInfo: { hasNextPage: false } } },
      meta: { truncations: [], stringsClipped: 0, view: 'summary' },
    });
    expect(output).toContain('No issues exist in the selected workspace.');
    expect(output).not.toContain('0 of 0');
    expect(output).not.toContain('more available');
    expect(output).not.toContain('total count is unavailable');
  });
});

describe('truncation with count metadata', () => {
  it('keeps local truncation notes beside an incomplete count headline', () => {
    const output = text('search_issues', {
      data: {
        searchIssues: {
          nodes: [ISSUE],
          pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
          totalCount: 91,
        },
      },
      meta: {
        truncations: [{ path: 'searchIssues.nodes', kept: 1, endCursor: 'cursor-1' }],
        stringsClipped: 0,
      },
    });
    expect(output).toContain('showing 1 of 91, more available');
    expect(output).toContain('kept 1 nodes — request the next page with after="cursor-1"');
  });
});

describe('narrow count headlines', () => {
  it('keeps showing N of M readable at every review width', () => {
    const details = {
      data: {
        searchIssues: {
          nodes: [ISSUE],
          pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
          totalCount: 91,
        },
      },
      meta: { truncations: [], stringsClipped: 0, view: 'summary' },
    };

    for (const width of WIDTHS) {
      const lines = render('search_issues', details, width);
      const joined = lines.join('\n');
      const flattened = joined.replace(/\s+/g, ' ');
      expect(flattened, `width ${width}`).toContain('showing');
      expect(flattened, `width ${width}`).toMatch(/\b1\b/);
      expect(flattened, `width ${width}`).toMatch(/\b91\b/);
      expect(flattened, `width ${width}`).toContain('more available');
      if (width >= 40) expect(flattened, `width ${width}`).toContain(NOTICE);
      for (const line of lines) {
        expect(line.length, `${JSON.stringify(line)} @${width}`).toBeLessThanOrEqual(width);
      }
    }
  });
});
