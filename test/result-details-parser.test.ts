import { describe, expect, it } from 'vitest';
import { getOperation } from '../extensions/operations';
import type { JsonValue } from '../extensions/json';
import {
  operationRenderers,
  renderLinearApiResult,
  renderLinearBatchResult,
  renderLinearGetResultResult,
  renderLinearGraphqlResult,
} from '../extensions/renderers';
import { parseResultDetails } from '../extensions/renderers/details';

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
} as never;

function block(component: { render: (width: number) => string[] }): string {
  return component.render(120).join('\n');
}

function result(details: JsonValue | undefined) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(details) ?? '' }], details };
}

const ISSUE = { id: 'issue-1', identifier: 'AEO-258', title: 'Fix login redirect' };

describe('named Result details', () => {
  it('parses a list, a missing exact root, and a workspace switch', () => {
    expect(parseResultDetails({
      data: { issues: { nodes: [ISSUE], totalCount: 4, pageInfo: { hasNextPage: true, endCursor: 'cursor-1' } } },
      meta: { view: 'summary' },
    }, { kind: 'named', expectedRoots: ['issues'] })).toMatchObject({
      kind: 'list',
      totalCount: 4,
      view: 'summary',
      entities: [ISSUE],
    });

    expect(parseResultDetails(
      { data: { issue: null }, resolution: { target: { requested: 'AEO-1', identifier: 'AEO-1' } } },
      { kind: 'named', expectedRoots: ['issue'] },
    )).toEqual({
      kind: 'not-found',
      notes: [],
      target: 'AEO-1',
    });

    expect(parseResultDetails({ active: 'work' }, { kind: 'named', expectedRoots: [] })).toEqual({
      kind: 'workspace',
      active: 'work',
    });
  });

  it('treats a mismatched Batch envelope as an entity when the first data root is an object', () => {
    const parsed = parseResultDetails({
      data: { ready: { issue: ISSUE } },
      errors: [{ key: 'write', message: 'failed' }],
      skipped: ['later'],
      meta: { requests: { read: 1, mutation: 1 } },
    }, { kind: 'named', expectedRoots: ['issue'] });
    expect(parsed.kind).toBe('entity');
    if (parsed.kind !== 'entity') return;
    expect(parsed.entity).toEqual({ issue: ISSUE });
  });

  it('summarises malformed named details instead of inventing an entity', () => {
    expect(parseResultDetails('not-json-object', { kind: 'named', expectedRoots: ['issue'] })).toEqual({
      kind: 'unknown',
      summary: '"not-json-object"',
    });
    expect(parseResultDetails(undefined, { kind: 'named', expectedRoots: ['issue'] })).toEqual({
      kind: 'unknown',
      summary: '{}',
    });
  });
});

describe('Batch Result details', () => {
  it('parses completed, failed, skipped, and request counts', () => {
    expect(parseResultDetails({
      data: { ready: { issue: {} } },
      errors: [{ key: 'write', message: 'failed' }, { key: 'write', message: 'again' }],
      skipped: ['later', 2],
      meta: { requests: { read: 1, mutation: 1 } },
    }, { kind: 'batch' })).toEqual({
      kind: 'batch',
      completed: ['ready'],
      failed: ['write'],
      skipped: ['later'],
      readRequests: 1,
      mutationRequests: 1,
    });
  });

  it('keeps a Batch spill ahead of Batch accounting', () => {
    const parsed = parseResultDetails({
      path: '/tmp/linear/raw/result.json',
      bytes: 42_000,
      handle: 'linear-result:v1:550e8400-e29b-41d4-a716-446655440000',
      index: [],
      data: { ready: { issue: {} } },
    }, { kind: 'batch' });
    expect(parsed.kind).toBe('spill');
  });

  it('treats mismatched or malformed Batch details as an empty Batch', () => {
    expect(parseResultDetails({ name: 'get_issue', parameters: [] }, { kind: 'batch' })).toEqual({
      kind: 'batch',
      completed: [],
      failed: [],
      skipped: [],
      readRequests: 0,
      mutationRequests: 0,
    });
    expect(parseResultDetails('nope', { kind: 'batch' })).toEqual({
      kind: 'batch',
      completed: [],
      failed: [],
      skipped: [],
      readRequests: 0,
      mutationRequests: 0,
    });
  });
});

describe('Result retrieval details', () => {
  it('parses a complete segment and a continuation', () => {
    expect(parseResultDetails({
      data: { value: [{ id: 'issue-3' }], range: { start: 2, end: 3, total: 5, unit: 'items' } },
      meta: { retrieval: { complete: false, nextOffset: 3 } },
    }, { kind: 'retrieval' })).toEqual({
      kind: 'retrieval',
      complete: false,
      range: { start: 2, end: 3, total: 5, unit: 'items' },
      nextOffset: 3,
      value: [{ id: 'issue-3' }],
    });
  });

  it('does not treat a retrieval envelope as a spill even when a path is present', () => {
    expect(parseResultDetails({
      path: '/tmp/ignored.json',
      data: { value: 'chunk' },
      meta: { retrieval: { complete: true } },
    }, { kind: 'retrieval' })).toEqual({
      kind: 'retrieval',
      complete: true,
      nextOffset: undefined,
      range: undefined,
      value: 'chunk',
    });
  });

  it('treats mismatched named details as an incomplete retrieval', () => {
    expect(parseResultDetails({ data: { issue: ISSUE } }, { kind: 'retrieval' })).toEqual({
      kind: 'retrieval',
      complete: false,
      nextOffset: undefined,
      range: undefined,
      value: undefined,
    });
  });
});

describe('Raw query details', () => {
  it('parses GraphQL field kinds without borrowing named-operation language', () => {
    expect(parseResultDetails({
      data: {
        issues: { nodes: [ISSUE], pageInfo: { hasNextPage: true, endCursor: 'c1' } },
        labels: ['bug'],
        viewer: { id: 'user-1', name: 'sam' },
        count: 2,
      },
    }, { kind: 'raw' })).toEqual({
      kind: 'raw',
      keys: ['issues', 'labels', 'viewer', 'count'],
      notes: [],
      fields: [
        { kind: 'connection', key: 'issues', nodeCount: 1, nextCursor: 'c1' },
        { kind: 'array', key: 'labels', itemCount: 1 },
        { kind: 'object', key: 'viewer', keys: ['id', 'name'] },
        { kind: 'scalar', key: 'count', valueKind: 'number' },
      ],
    });
  });

  it('treats malformed Raw query details as an empty GraphQL response', () => {
    expect(parseResultDetails({ domains: ['issues'] }, { kind: 'raw' })).toEqual({
      kind: 'raw',
      keys: [],
      fields: [],
      notes: [],
    });
  });
});

describe('help details', () => {
  it('parses domain, operation list, and parameter-card help', () => {
    expect(parseResultDetails({ domains: ['issues', 'comments'], loadedTools: ['linear_get_issue'] }, { kind: 'help' })).toEqual({
      kind: 'help-domains',
      domains: ['issues', 'comments'],
      loaded: ['linear_get_issue'],
    });
    expect(parseResultDetails({
      domain: 'issues',
      operations: [{ name: 'get_issue', signature: 'get_issue(issue)' }],
    }, { kind: 'help' })).toEqual({
      kind: 'help-operations',
      domain: 'issues',
      operations: [{ name: 'get_issue', signature: 'get_issue(issue)' }],
      loaded: [],
    });
    expect(parseResultDetails({
      name: 'get_issue',
      purpose: 'Get one issue.',
      parameters: [{ name: 'issue', type: 'IssueReference', required: true }],
    }, { kind: 'help' })).toEqual({
      kind: 'help-operation',
      name: 'get_issue',
      purpose: 'Get one issue.',
      parameters: [{ name: 'issue', type: 'IssueReference', required: true }],
      loaded: [],
    });
  });

  it('rejects mismatched Batch and named envelopes as unknown help', () => {
    expect(parseResultDetails({
      data: { ready: { issue: {} } },
      errors: [],
      skipped: [],
    }, { kind: 'help' }).kind).toBe('unknown');
    expect(parseResultDetails({ data: { issue: ISSUE } }, { kind: 'help' }).kind).toBe('unknown');
  });
});

describe('renderers consume parsed variants', () => {
  it('renders malformed Batch details as an empty Batch', () => {
    const text = block(renderLinearBatchResult(
      result('nope') as never,
      { expanded: false, isPartial: false },
      theme,
      {},
    ));
    expect(text).toContain('Batch complete');
    expect(text).toContain('Completed: (none)');
    expect(text).toContain('Failed: (none)');
    expect(text).toContain('Skipped: (none)');
    expect(text).toContain('Requests: 0 read, 0 mutation');
  });

  it('renders mismatched retrieval details as an incomplete stored segment', () => {
    const text = block(renderLinearGetResultResult(
      result({ data: { value: ISSUE } }) as never,
      { expanded: false, isPartial: false },
      theme,
      {},
    ));
    expect(text).toContain('Stored result segment');
    expect(text).not.toContain('Stored result complete');
    expect(text).toContain('"identifier":"AEO-258"');
  });

  it('renders mismatched help details as JSON instead of a parameter card', () => {
    const text = block(renderLinearApiResult(
      result({ data: { issue: ISSUE } }) as never,
      { expanded: false, isPartial: false },
      theme,
      { args: { operation: 'help' } },
    ));
    expect(text).toContain('Full JSON response');
    expect(text).not.toContain('✓ get_issue');
  });

  it('renders malformed Raw query details as an empty GraphQL response', () => {
    const text = block(renderLinearGraphqlResult(
      result({ domains: ['issues'] }) as never,
      { expanded: false, isPartial: false },
      theme,
      { args: { query: 'query { viewer { id } }' } },
    ));
    expect(text).toContain('GraphQL response');
    expect(text).toContain('Keys: (none)');
  });

  it('renders malformed named-operation details as a JSON summary', () => {
    const text = block(operationRenderers(getOperation('get_issue')).renderResult(
      result('nope') as never,
      { expanded: false, isPartial: false },
      theme,
      {},
    ));
    expect(text).toContain('"nope"');
    expect(text).not.toContain('Loaded');
  });
});
