import { parse } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import { NODE_CAP, RESULT_BUDGET, STRING_CAP, compactLinearResult, linearApiTool, resolveRequest } from '../extensions/api';
import { operations } from '../extensions/operations';

describe('named operations', () => {
  it('loads valid bundled operation documents', () => {
    for (const [name, operation] of Object.entries(operations)) {
      expect(resolveRequest({ operation: name })).toEqual({ query: operation.document, named: true });
      expect(() => parse(operation.document)).not.toThrow();
    }
  });

  it('lists signatures for every valid operation when the name is unknown', () => {
    expect(() => resolveRequest({ operation: 'missing' })).toThrow(
      'Unknown Linear operation "missing". Valid operations:\n- get_issue(teamKey: String!, number: Float!)',
    );
    for (const operation of Object.values(operations)) {
      expect(() => resolveRequest({ operation: 'missing' })).toThrow(operation.signature);
    }
  });

  it('requires exactly one request form', () => {
    expect(() => resolveRequest({})).toThrow('Provide exactly one');
    expect(() => resolveRequest({ operation: 'get_issue', query: 'query { viewer { id } }' })).toThrow('Provide exactly one');
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

describe('read-only tool', () => {
  it('rejects a mutation before credential lookup or network access', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const tool = linearApiTool('/tmp/reference', 'readonly') as any;

    await expect(tool.execute(
      'call-1',
      { query: 'mutation { issueCreate(input: { teamId: "x", title: "x" }) { success } }' },
      undefined,
      undefined,
      { hasUI: false },
    )).rejects.toThrow('read-only mode');
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
