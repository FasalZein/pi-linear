import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'graphql';
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
import { operations } from '../extensions/operations';

const originalArtifactRoot = process.env.PI_ARTIFACT_PROJECT_ROOT;
const originalSpillBytes = process.env.LINEAR_SPILL_BYTES;
const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  if (originalArtifactRoot === undefined) delete process.env.PI_ARTIFACT_PROJECT_ROOT;
  else process.env.PI_ARTIFACT_PROJECT_ROOT = originalArtifactRoot;
  if (originalSpillBytes === undefined) delete process.env.LINEAR_SPILL_BYTES;
  else process.env.LINEAR_SPILL_BYTES = originalSpillBytes;
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function artifactRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'pi-linear-'));
  temporaryRoots.push(path);
  process.env.PI_ARTIFACT_PROJECT_ROOT = path;
  return path;
}

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
    const tool = linearApiTool('/tmp/reference', 'readonly') as any;

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
