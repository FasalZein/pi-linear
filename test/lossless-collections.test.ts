import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { linearGraphqlTool, routeLinearResult } from '../extensions/api';
import { typedLinearTools } from '../extensions/typed-tools';
import { isolateLinearCredentials } from './helpers/credentials';

isolateLinearCredentials();

const originalArtifactRoot = process.env.PI_ARTIFACT_PROJECT_ROOT;
const originalSpillBytes = process.env.LINEAR_SPILL_BYTES;
const originalApiKey = process.env.LINEAR_API_KEY;
const roots: string[] = [];

async function artifactRoot() {
  const root = await mkdtemp(join(tmpdir(), 'pi-linear-lossless-'));
  roots.push(root);
  process.env.PI_ARTIFACT_PROJECT_ROOT = root;
  return root;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  if (originalArtifactRoot === undefined) delete process.env.PI_ARTIFACT_PROJECT_ROOT;
  else process.env.PI_ARTIFACT_PROJECT_ROOT = originalArtifactRoot;
  if (originalSpillBytes === undefined) delete process.env.LINEAR_SPILL_BYTES;
  else process.env.LINEAR_SPILL_BYTES = originalSpillBytes;
  if (originalApiKey === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = originalApiKey;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function rows(count: number, bodyLength = 80) {
  return Array.from({ length: count }, (_, index) => ({
    id: `issue-${index}`,
    identifier: `AEO-${index}`,
    title: `Issue ${index}`,
    body: String(index).padStart(bodyLength, 'x'),
    custom: { retained: true, index },
  }));
}

async function storedEnvelope(result: Awaited<ReturnType<typeof routeLinearResult>>) {
  if (!('path' in result)) throw new Error('Expected an externalized result.');
  return JSON.parse(await readFile(result.path, 'utf8')) as any;
}

describe('lossless collection routing', () => {
  it('keeps a modest summary collection immediately usable by default', async () => {
    const nodes = rows(50, 80);
    const pageInfo = { hasNextPage: true, hasPreviousPage: false, startCursor: 'server-start', endCursor: 'server-end' };
    const data = { issues: { nodes, pageInfo, totalCount: 913 } };
    const result = await routeLinearResult(data, { label: 'list_issues', category: 'collection' });

    expect(result).toMatchObject({
      data,
      meta: {
        truncations: [],
        stringsClipped: 0,
        routing: { requestedSink: 'auto', actualSink: 'inline', inlineComplete: true },
      },
    });
    expect(result).not.toHaveProperty('handle');
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBe(9_592);
  });

  it('externalizes auto collections at the configured byte threshold', async () => {
    await artifactRoot();
    process.env.LINEAR_SPILL_BYTES = '50000';
    const data = { issues: { nodes: rows(2) } };
    const inline = await routeLinearResult(data, { label: 'list_issues', category: 'collection' });
    process.env.LINEAR_SPILL_BYTES = String(Buffer.byteLength(JSON.stringify(inline), 'utf8'));

    const result = await routeLinearResult(data, { label: 'list_issues', category: 'collection' });
    expect(result).toMatchObject({ meta: { routing: { actualSink: 'artifact', reason: 'spill-threshold' } } });
    const stored = await storedEnvelope(result);
    expect(stored.data).toEqual(data);
    expect(stored.meta.routing).toEqual({
      requestedSink: 'auto', actualSink: 'artifact', reason: 'spill-threshold', inlineComplete: false,
    });
    if (!('bytes' in result)) throw new Error('Expected an externalized result.');
    expect(result.bytes).toBe(Buffer.byteLength(JSON.stringify(stored), 'utf8'));
  });

  it('keeps forced inline collections complete below Pi boundary', async () => {
    const nodes = rows(110, 20);
    const result = await routeLinearResult(
      { issues: { nodes, pageInfo: { hasNextPage: true, endCursor: 'linear-cursor' }, totalCount: 110 } },
      { label: 'list_issues', category: 'collection', sink: 'inline' },
    );

    expect(result).not.toHaveProperty('path');
    if (!('data' in result)) throw new Error('Expected inline data.');
    expect(result.data.issues).toEqual({
      nodes,
      pageInfo: { hasNextPage: true, endCursor: 'linear-cursor' },
      totalCount: 110,
    });
    expect(result.meta).toMatchObject({ truncations: [], stringsClipped: 0 });
    expect(result.meta).not.toHaveProperty('nodeCap');
  });

  it('falls back once at Pi boundary with exact recoverable root metadata', async () => {
    await artifactRoot();
    const nodes = rows(120, 500);
    const result = await routeLinearResult(
      { issues: { nodes, pageInfo: { hasNextPage: false, endCursor: 'final-server-cursor' }, totalCount: 120 } },
      { label: 'list_issues', category: 'collection', sink: 'inline' },
    );

    expect(result).toMatchObject({
      handle: expect.stringMatching(/^linear-result:v1:[0-9a-f-]+$/),
      meta: {
        truncations: [],
        stringsClipped: 0,
        resultBudget: {
          maxBytes: 51200,
          maxLines: 2000,
          truncated: true,
          recoverable: true,
          omissions: [{ path: '', handle: expect.stringMatching(/^linear-result:v1:/), originalBytes: expect.any(Number), inlineBytes: 0 }],
        },
        routing: {
          requestedSink: 'inline',
          actualSink: 'artifact',
          reason: 'tool-output-boundary',
          inlineComplete: false,
          externalized: [{ path: '', handle: expect.stringMatching(/^linear-result:v1:/), bytes: expect.any(Number) }],
        },
      },
    });
    const stored = await storedEnvelope(result);
    expect(stored.data.issues.nodes).toEqual(nodes);
    expect(stored.meta.routing).toEqual({
      requestedSink: 'inline', actualSink: 'artifact', reason: 'tool-output-boundary', inlineComplete: false,
    });
    if (!('handle' in result)) throw new Error('Expected an externalized result.');
    expect(result.bytes).toBe(Buffer.byteLength(JSON.stringify(stored), 'utf8'));
    expect(result.meta.resultBudget?.omissions?.[0]?.handle).toBe(result.handle);
    expect(result.meta.routing?.externalized?.[0]?.handle).toBe(result.handle);
  });

  it('preserves strings above 2,000 characters in inline collection and raw results', async () => {
    const long = 'z'.repeat(2_500);
    const collection = await routeLinearResult(
      { issues: { nodes: [{ id: 'issue-1', body: long }] } },
      { label: 'list_issues', category: 'collection', sink: 'inline' },
    );
    const raw = await routeLinearResult(
      { arbitrary: { nodes: [{ id: 1, value: long }] } },
      { label: 'query', category: 'composite', sink: 'inline' },
    );

    expect(collection).toMatchObject({
      data: { issues: { nodes: [{ id: 'issue-1', body: long }] } },
      meta: { truncations: [], stringsClipped: 0 },
    });
    expect(raw).toMatchObject({
      data: { arbitrary: { nodes: [{ id: 1, value: long }] } },
      meta: { truncations: [], stringsClipped: 0 },
    });
  });

  it('preserves more than 100 fetched raw nodes without a local cap', async () => {
    const nodes = Array.from({ length: 125 }, (_, index) => ({ id: index, value: `row-${index}` }));
    const result = await routeLinearResult(
      { arbitrary: { nodes } },
      { label: 'query', category: 'composite', sink: 'inline', nodeCap: 100 },
    );
    expect(result).toMatchObject({ data: { arbitrary: { nodes } }, meta: { truncations: [], stringsClipped: 0 } });
  });

  it.each(['summary', 'full'] as const)('preserves %s view metadata without changing completeness', async (view) => {
    const data = { issues: { nodes: rows(3), pageInfo: { hasNextPage: false }, totalCount: 3 } };
    const result = await routeLinearResult(data, { label: 'list_issues', category: 'collection', sink: 'inline', view });
    expect(result).toMatchObject({ data, meta: { view, truncations: [], stringsClipped: 0 } });
  });
});

describe('raw and typed collection parity', () => {
  it('returns the same complete result through both public tools', async () => {
    process.env.LINEAR_API_KEY = 'test-key';
    process.env.LINEAR_SPILL_BYTES = '50000';
    const nodes = rows(105, 5);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      json: async () => ({ data: { issues: { nodes, pageInfo: { hasNextPage: true, endCursor: 'server-next' }, totalCount: 301 } } }),
    })));

    const raw = await (linearGraphqlTool() as any).execute(
      'loader-call',
      { query: 'query { issues { nodes { id title } pageInfo { hasNextPage endCursor } totalCount } }' },
      undefined,
      undefined,
      { hasUI: false },
    );
    const typed = typedLinearTools().find((tool) => tool.name === 'linear_list_issues') as any;
    const typedResult = await typed.execute('typed-call', {}, undefined, undefined, { hasUI: false });

    expect(raw.details.data).toEqual(typedResult.details.data);
    expect(raw.details.data.issues.nodes).toEqual(nodes);
    expect(JSON.parse(raw.content[0].text)).toEqual(raw.details);
    expect(JSON.parse(typedResult.content[0].text)).toEqual(typedResult.details);
  });
});
