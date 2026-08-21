import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from '@earendil-works/pi-coding-agent';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { linearApiTool, routeLinearResult } from '../extensions/api';
import { typedToolNames } from '../extensions/typed-tools';
import { isolateLinearCredentials } from './helpers/credentials';

isolateLinearCredentials();

const originalArtifactRoot = process.env.PI_ARTIFACT_PROJECT_ROOT;
const roots: string[] = [];

async function artifactRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pi-linear-results-'));
  roots.push(root);
  process.env.PI_ARTIFACT_PROJECT_ROOT = root;
  return root;
}

function execute(params: Record<string, unknown>) {
  return (linearApiTool() as any).execute('call-1', params, undefined, undefined, { hasUI: false });
}

async function artifact(data: Record<string, unknown>) {
  const result = await routeLinearResult(data, { label: 'caller-controlled/operation', sink: 'artifact' });
  if (!('handle' in result)) throw new Error('Expected artifact result.');
  return result;
}

function expectWithinBoundary(details: unknown): void {
  const serialized = JSON.stringify(details);
  expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
  expect(serialized.split('\n')).toHaveLength(1);
  expect(serialized.split('\n').length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
}

async function writeEnvelope(root: string, uuid: string, content: string): Promise<string> {
  const directory = join(root, 'linear/raw');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${uuid}.json`);
  await writeFile(path, content);
  return path;
}

async function get(handle: string, path = '', offset?: number) {
  const variables: Record<string, unknown> = { handle, ...(path ? { path } : {}) };
  if (offset !== undefined) variables.offset = offset;
  return execute({ operation: 'get_result', variables });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  if (originalArtifactRoot === undefined) delete process.env.PI_ARTIFACT_PROJECT_ROOT;
  else process.env.PI_ARTIFACT_PROJECT_ROOT = originalArtifactRoot;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('result handles', () => {
  it('writes UUID-derived artifact names and retrieves the exact root or field without network access', async () => {
    const root = await artifactRoot();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const stored = await artifact({ document: { id: 'doc-1', title: 'Result' } });

    expect(stored.handle).toMatch(/^linear-result:v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const uuid = stored.handle.slice('linear-result:v1:'.length);
    expect(stored.path).toBe(join(root, 'linear/raw', `${uuid}.json`));
    expect(stored.path).not.toContain('caller-controlled');
    expect(stored).toMatchObject({
      bytes: expect.any(Number),
      index: expect.any(Array),
      meta: {
        routing: {
          requestedSink: 'artifact',
          actualSink: 'artifact',
          reason: 'requested',
          inlineComplete: false,
          externalized: [{ path: '', handle: stored.handle, bytes: expect.any(Number) }],
        },
      },
    });

    const rootResult = await get(stored.handle);
    expect(rootResult.details.data.value).toEqual(JSON.parse(await readFile(stored.path, 'utf8')));
    expect(rootResult.details.meta.retrieval).toEqual({
      handle: stored.handle, path: '', complete: true,
    });

    const fieldResult = await get(stored.handle, '/data/document/title');
    expect(fieldResult.details).toEqual({
      data: { value: 'Result' },
      meta: { retrieval: { handle: stored.handle, path: '/data/document/title', complete: true } },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses exact RFC 6901 pointer escaping', async () => {
    await artifactRoot();
    const stored = await artifact({ 'a/b': { '~key': 'found' } });
    await expect(get(stored.handle, '/data/a~1b/~0key')).resolves.toMatchObject({
      details: { data: { value: 'found' } },
    });
    await expect(get(stored.handle, '/data/a~01b')).rejects.toThrow('Invalid JSON Pointer');
    await expect(get(stored.handle, 'data')).rejects.toThrow('Invalid JSON Pointer');
  });

  it('segments strings by Unicode code points and supports continuation offsets', async () => {
    await artifactRoot();
    const value = '😀é'.repeat(DEFAULT_MAX_BYTES);
    const stored = await artifact({ value });
    const first = await get(stored.handle, '/data/value');
    expectWithinBoundary(first.details);
    expect(first.details.data.range).toMatchObject({ unit: 'codePoints', start: 0, total: Array.from(value).length });
    expect(first.details.data.value).toBe(Array.from(value).slice(0, first.details.data.range.end).join(''));
    expect(first.details.meta.retrieval.complete).toBe(false);

    const second = await get(stored.handle, '/data/value', first.details.meta.retrieval.nextOffset);
    expectWithinBoundary(second.details);
    expect(second.details.data.range.start).toBe(first.details.data.range.end);
    expect(Array.from(first.details.data.value + second.details.data.value)).toEqual(
      Array.from(value).slice(0, second.details.data.range.end),
    );
  });

  it('segments arrays by whole items and objects by insertion-ordered whole properties', async () => {
    await artifactRoot();
    const rows = Array.from({ length: 120 }, (_, id) => ({ id, value: `${id}:` + 'x'.repeat(900) }));
    const record = Object.fromEntries(rows.map((row) => [`key-${row.id}`, row.value]));
    const stored = await artifact({ rows, record });

    const arrayFirst = await get(stored.handle, '/data/rows');
    expectWithinBoundary(arrayFirst.details);
    expect(arrayFirst.details.data.range).toMatchObject({ unit: 'items', start: 0, total: rows.length });
    expect(arrayFirst.details.data.value).toEqual(rows.slice(0, arrayFirst.details.data.range.end));
    const arrayNext = await get(stored.handle, '/data/rows', arrayFirst.details.meta.retrieval.nextOffset);
    expect(arrayNext.details.data.value).toEqual(rows.slice(arrayFirst.details.data.range.end, arrayNext.details.data.range.end));

    const objectFirst = await get(stored.handle, '/data/record');
    expectWithinBoundary(objectFirst.details);
    expect(objectFirst.details.data.range).toMatchObject({ unit: 'properties', start: 0, total: rows.length });
    expect(Object.entries(objectFirst.details.data.value)).toEqual(Object.entries(record).slice(0, objectFirst.details.data.range.end));
    const objectNext = await get(stored.handle, '/data/record', objectFirst.details.meta.retrieval.nextOffset);
    expect(Object.entries(objectNext.details.data.value)).toEqual(
      Object.entries(record).slice(objectFirst.details.data.range.end, objectNext.details.data.range.end),
    );
  });

  it('externalizes an oversized array item at its exact child pointer', async () => {
    await artifactRoot();
    const huge = { body: 'x'.repeat(DEFAULT_MAX_BYTES * 2) };
    const stored = await artifact({ rows: [huge, { body: 'next' }] });
    const first = await get(stored.handle, '/data/rows');

    expectWithinBoundary(first.details);
    expect(first.details.data).toEqual({
      value: [],
      range: { unit: 'items', start: 0, end: 1, total: 2 },
      externalized: [{ path: '/data/rows/0', handle: stored.handle, bytes: expect.any(Number) }],
    });
    expect(first.details.meta.retrieval).toMatchObject({ complete: false, nextOffset: 1 });
    const child = await get(stored.handle, '/data/rows/0');
    expect(child.details.data.externalized).toEqual([
      { path: '/data/rows/0/body', handle: stored.handle, bytes: expect.any(Number) },
    ]);
    const body = await get(stored.handle, '/data/rows/0/body');
    expect(body.details.data.value).toMatch(/^x+$/);
    expectWithinBoundary(body.details);
  });

  it('rejects invalid offsets and retrieval-only routing fields', async () => {
    await artifactRoot();
    const stored = await artifact({ value: ['a', 'b'] });
    for (const offset of [-1, 1.5, 3]) {
      await expect(get(stored.handle, '/data/value', offset)).rejects.toThrow('Invalid result offset');
    }
    await expect(execute({ operation: 'get_result', variables: { handle: stored.handle, filename: stored.path } }))
      .rejects.toThrow('unknown filename');
    await expect(execute({ operation: 'get_result', variables: { handle: stored.handle }, sink: 'artifact' }))
      .rejects.toThrow('does not accept sink');
    await expect(execute({ operation: 'get_result', variables: { handle: stored.handle }, workspace: 'default' }))
      .rejects.toThrow('does not accept workspace');
  });

  it('rejects traversal, path, URI, malformed, alternate, and missing handles safely', async () => {
    await artifactRoot();
    const invalid = [
      '../secret', '/tmp/secret', 'file:///tmp/secret', 'https://example.com/result',
      'linear-result:v1:../secret', 'linear-result:v2:550e8400-e29b-41d4-a716-446655440000',
      'linear-result:v1:550e8400-e29b-11d4-a716-446655440000',
      'linear-result:v1:550e8400-e29b-41d4-a716-446655440000.json',
    ];
    for (const handle of invalid) await expect(get(handle)).rejects.toThrow('Invalid Linear result handle');
    await expect(get('linear-result:v1:550e8400-e29b-41d4-a716-446655440000')).rejects.toThrow(
      'Result handle was not found or is no longer available.',
    );
  });

  it('rejects symlinks, malformed JSON, and non-envelope artifacts without exposing content', async () => {
    const root = await artifactRoot();
    const outside = join(root, 'outside-secret.json');
    await writeFile(outside, 'DO_NOT_EXPOSE');
    const symlinkUuid = '11111111-1111-4111-8111-111111111111';
    const link = await writeEnvelope(root, symlinkUuid, '{}');
    await rm(link);
    await symlink(outside, link);

    const malformedUuid = '22222222-2222-4222-8222-222222222222';
    await writeEnvelope(root, malformedUuid, '{bad');
    const unknownUuid = '33333333-3333-4333-8333-333333333333';
    await writeEnvelope(root, unknownUuid, JSON.stringify({ data: { value: 'DO_NOT_EXPOSE' } }));

    for (const uuid of [symlinkUuid, malformedUuid, unknownUuid]) {
      const error = await get(`linear-result:v1:${uuid}`).catch((caught: Error) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('Stored Linear result is invalid or unavailable.');
      expect((error as Error).message).not.toContain('DO_NOT_EXPOSE');
      expect((error as Error).message).not.toContain(root);
    }
  });

  it('redacts artifact writes and retrieval again without creating another artifact', async () => {
    const root = await artifactRoot();
    const token = 'lin_api_secret123456789';
    const stored = await artifact({ value: token });
    expect(await readFile(stored.path, 'utf8')).not.toContain(token);

    const uuid = '44444444-4444-4444-8444-444444444444';
    await writeEnvelope(root, uuid, JSON.stringify({
      data: { value: token }, meta: { truncations: [], stringsClipped: 0 },
    }));
    const before = await readdir(join(root, 'linear/raw'));
    const retrieved = await get(`linear-result:v1:${uuid}`, '/data/value');
    const after = await readdir(join(root, 'linear/raw'));

    expect(retrieved.details.data.value).toBe('[REDACTED]');
    expect(JSON.stringify(retrieved.details)).not.toContain(token);
    expect(after).toEqual(before);
  });

  it('publishes loader help without adding a typed result tool', async () => {
    const root = await execute({ operation: 'help' });
    expect(root.details.resultHelp).toEqual({ operation: 'help', variables: { operation: 'get_result' } });
    const card = await execute({ operation: 'help', variables: { operation: 'get_result' } });
    expect(card.details).toMatchObject({
      name: 'get_result',
      parameters: [
        { name: 'handle', type: 'ResultHandle', required: true },
        { name: 'path', type: 'JSONPointer', required: false },
        { name: 'offset', type: 'Int', required: false },
      ],
      example: {
        operation: 'get_result',
        variables: {
          handle: 'linear-result:v1:550e8400-e29b-41d4-a716-446655440000',
          path: '/data/document/content',
          offset: 0,
        },
      },
    });
    expect(card.details).not.toHaveProperty('loadedTools');
    expect((linearApiTool() as any).description).toContain('get_result: Retrieve a stored Linear result by handle.');
    expect(typedToolNames()).not.toContain('linear_get_result');
  });
});
