import { describe, expect, it } from 'vitest';
import { getOperation } from '../extensions/operations';
import {
  operationRenderers,
  renderLinearApiCall,
  renderLinearApiResult,
  renderLinearGetResultResult,
  renderLinearGraphqlResult,
} from '../extensions/renderers';

const theme = {
  fg: (_role: string, text: string) => text,
  bg: (_role: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
} as any;

function result<T>(details: T) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details } as any;
}

function text(component: any, width = 120): string {
  return component.render(width).join('\n');
}

function renderPartial(operationName: string): string {
  return text(operationRenderers(getOperation(operationName)).renderResult(
    result(undefined),
    { expanded: false, isPartial: true },
    theme,
    {},
  ));
}

describe('renderer branch contracts', () => {
  it('uses operation-specific progress verbs and plural list nouns', () => {
    const expected = [
      ['create_issue', 'Creating issue…'],
      ['update_issue', 'Updating issue…'],
      ['save_project', 'Saving project…'],
      ['delete_issue_relation', 'Deleting relation…'],
      ['switch_workspace', 'Switching workspace…'],
      ['search_issues', 'Searching issues…'],
      ['get_issue', 'Loading issue…'],
      ['list_issues', 'Loading issues…'],
    ] as const;

    for (const [operation, message] of expected) {
      expect(renderPartial(operation)).toContain(message);
    }
  });

  it('renders domain operation help from signatures and falls back to operation names', () => {
    const operations = [
      { name: 'get_issue', signature: 'get_issue(issue: IssueReference)' },
      { name: 'list_issues' },
      ...Array.from({ length: 19 }, (_, index) => ({ name: `operation_${index + 3}` })),
    ];
    const rendered = text(renderLinearApiResult(
      result({ domain: 'issues', operations }),
      { expanded: false, isPartial: false },
      theme,
      { args: { operation: 'help', variables: { domain: 'issues' } } } as any,
    ));

    expect(rendered).toContain('21 operations in issues');
    expect(rendered).toContain('get_issue(issue: IssueReference)');
    expect(rendered).toContain('list_issues');
    expect(rendered).toContain('operation_20');
    expect(rendered).not.toContain('operation_21');
  });

  it('summarizes every raw GraphQL field kind and an empty response', () => {
    const rendered = text(renderLinearGraphqlResult(
      result({
        data: {
          issues: { nodes: [], pageInfo: { hasNextPage: false } },
          labels: ['bug', 'security'],
          viewer: {},
          title: 'abc',
          enabled: true,
        },
        meta: { truncations: [], stringsClipped: 0 },
      }),
      { expanded: false, isPartial: false },
      theme,
      { args: { query: 'query { issues labels viewer title enabled }' } } as any,
    ));

    expect(rendered).toContain('issues: connection · 0 nodes');
    expect(rendered).not.toContain('next page after=');
    expect(rendered).toContain('labels: array · 2 items');
    expect(rendered).toContain('viewer: object · 0 keys');
    expect(rendered).toContain('title: string · 3 chars');
    expect(rendered).toContain('enabled: boolean');

    const empty = text(renderLinearGraphqlResult(
      result({ data: {}, meta: { truncations: [], stringsClipped: 0 } }),
      { expanded: false, isPartial: false },
      theme,
      { args: { query: 'query { viewer { id } }' } } as any,
    ));
    expect(empty).toContain('Keys: (none)');
  });

  it('keeps legacy spill recovery explicit and limits the visible index', () => {
    const rendered = text(operationRenderers(getOperation('list_issues')).renderResult(
      result({
        path: '/tmp/linear/result.json',
        bytes: 0,
        index: Array.from({ length: 10 }, (_, index) => `entry ${index + 1}`),
        meta: { truncations: [], stringsClipped: 0 },
      }),
      { expanded: false, isPartial: false },
      theme,
      {},
    ));

    expect(rendered).toContain('✓ 1 KB written to disk');
    expect(rendered).toContain('This legacy artifact has no result handle.');
    expect(rendered).toContain('entry 8');
    expect(rendered).not.toContain('entry 9');
    expect(rendered).toContain('… 2 more entries in the file');
  });

  it('renders unknown retrieval bounds without inventing offsets', () => {
    const rendered = text(renderLinearGetResultResult(
      result({
        data: { value: 'segment', range: { unit: 'characters' } },
        meta: { retrieval: { complete: true } },
      }),
      { expanded: false, isPartial: false },
      theme,
      {},
    ));

    expect(rendered).toContain('Stored result complete');
    expect(rendered).toContain('Range: ?–? of ? characters');
    expect(rendered).not.toContain('Next offset:');
  });

  it('distinguishes catalog, domain, and exact-operation call rows', () => {
    expect(text(renderLinearApiCall({}, theme))).toContain('linear catalog');
    expect(text(renderLinearApiCall({ variables: { domain: 'issues' } }, theme))).toContain('help: issues');
    expect(text(renderLinearApiCall({ variables: { operation: 'get_issue', domain: 'issues' } }, theme)))
      .toContain('help: get_issue');
  });
});
