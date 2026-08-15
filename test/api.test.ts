import { describe, expect, it } from 'vitest';
import { NODE_CAP, compactLinearResult } from '../extensions/api';

describe('compactLinearResult', () => {
  it('caps every GraphQL nodes array and reports truncation', () => {
    const nodes = Array.from({ length: NODE_CAP + 2 }, (_, id) => ({ id }));
    const result = compactLinearResult({ issues: { nodes, nested: { nodes } } });

    expect(result.data.issues.nodes).toHaveLength(NODE_CAP);
    expect(result.data.issues.nested.nodes).toHaveLength(NODE_CAP);
    expect(result.meta).toEqual({ nodeCap: NODE_CAP, truncated: true });
  });

  it('states the cap when no data was truncated', () => {
    expect(compactLinearResult({ viewer: { id: 'user-1' } })).toEqual({
      data: { viewer: { id: 'user-1' } },
      meta: { nodeCap: NODE_CAP, truncated: false },
    });
  });
});
