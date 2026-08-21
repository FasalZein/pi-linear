import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from '@earendil-works/pi-coding-agent';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { activeSecrets } from './active-secrets';
import { redactDeep } from './redact';
import type { JsonObject } from './runtime';

const HANDLE_PREFIX = 'linear-result:v1:';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MISSING = 'Result handle was not found or is no longer available.';
const INVALID_ARTIFACT = 'Stored Linear result is invalid or unavailable.';
const INVALID_DIRECTORY = 'Linear result artifact directory is invalid or contains a symbolic link.';
const EXAMPLE_HANDLE = 'linear-result:v1:550e8400-e29b-41d4-a716-446655440000';

export const GET_RESULT_PURPOSE = 'Retrieve a stored Linear result by handle.';
export const GET_RESULT_HELP = {
  name: 'get_result',
  purpose: GET_RESULT_PURPOSE,
  parameters: [
    { name: 'handle', type: 'ResultHandle', required: true },
    { name: 'path', type: 'JSONPointer', required: false },
    { name: 'offset', type: 'Int', required: false },
  ],
  example: {
    operation: 'get_result',
    variables: {
      handle: EXAMPLE_HANDLE,
      path: '/data/document/content',
      offset: 0,
    },
  },
} as const;

function artifactTrustAnchor(): string {
  return resolve(process.env.PI_ARTIFACT_PROJECT_ROOT ?? join(homedir(), '.pi/artifacts'));
}

export function resultArtifactRoot(): string {
  return join(artifactTrustAnchor(), 'linear/raw');
}

function contained(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

export async function resolveTrustedResultDirectory(create: boolean): Promise<string> {
  const anchor = artifactTrustAnchor();
  if (create) await mkdir(anchor, { recursive: true });
  const anchorReal = await realpath(anchor);
  let lexical = anchor;
  let trusted = anchorReal;
  for (const component of ['linear', 'raw']) {
    lexical = join(lexical, component);
    try {
      const metadata = await lstat(lexical);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(INVALID_DIRECTORY);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error;
      await mkdir(lexical);
      const metadata = await lstat(lexical);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(INVALID_DIRECTORY);
    }
    const resolved = await realpath(lexical);
    if (!contained(trusted, resolved) || relative(trusted, resolved) !== component) throw new Error(INVALID_DIRECTORY);
    trusted = resolved;
  }
  if (!contained(anchorReal, trusted)) throw new Error(INVALID_DIRECTORY);
  return trusted;
}

export async function assertTrustedResultDirectory(expected: string): Promise<void> {
  const current = await resolveTrustedResultDirectory(false);
  if (current !== expected) throw new Error(INVALID_DIRECTORY);
}

export function resultHandle(uuid: string): string {
  return `${HANDLE_PREFIX}${uuid}`;
}

function handleUuid(handle: unknown): string {
  if (typeof handle !== 'string' || !handle.startsWith(HANDLE_PREFIX)) {
    throw new Error('Invalid Linear result handle.');
  }
  const uuid = handle.slice(HANDLE_PREFIX.length);
  if (!UUID_V4.test(uuid)) throw new Error('Invalid Linear result handle.');
  return uuid;
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

function validEnvelope(value: unknown): value is JsonObject {
  const envelope = asObject(value);
  if (!envelope || !Object.prototype.hasOwnProperty.call(envelope, 'data')) return false;
  const allowed = new Set(['data', 'errors', 'skipped', 'meta', 'resolution']);
  if (Object.keys(envelope).some((key) => !allowed.has(key))) return false;
  if (!asObject(envelope.data)) return false;
  const meta = asObject(envelope.meta);
  if (!meta || !Array.isArray(meta.truncations) || typeof meta.stringsClipped !== 'number') return false;
  if ('errors' in envelope && !Array.isArray(envelope.errors)) return false;
  if ('skipped' in envelope && !Array.isArray(envelope.skipped)) return false;
  if ('resolution' in envelope && !asObject(envelope.resolution)) return false;
  return true;
}

async function readArtifact(handle: string): Promise<JsonObject> {
  const uuid = handleUuid(handle);
  let file;
  try {
    const directory = await resolveTrustedResultDirectory(false);
    const path = join(directory, `${uuid}.json`);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(INVALID_ARTIFACT);
    await assertTrustedResultDirectory(directory);
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!(await file.stat()).isFile()) throw new Error(INVALID_ARTIFACT);
    const parsed: unknown = JSON.parse(await file.readFile('utf8'));
    await assertTrustedResultDirectory(directory);
    if (!validEnvelope(parsed)) throw new Error(INVALID_ARTIFACT);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') throw new Error(MISSING);
    if (error instanceof Error && (error.message === INVALID_ARTIFACT || error.message === INVALID_DIRECTORY)) throw error;
    throw new Error(INVALID_ARTIFACT);
  } finally {
    if (file) await file.close().catch(() => {});
  }
}

function pointerTokens(pointer: unknown): string[] {
  if (pointer === undefined || pointer === '') return [];
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) throw new Error('Invalid JSON Pointer.');
  return pointer.slice(1).split('/').map((token) => {
    if (/~(?:[^01]|$)/.test(token)) throw new Error('Invalid JSON Pointer.');
    return token.replace(/~1/g, '/').replace(/~0/g, '~');
  });
}

function selectPointer(root: unknown, pointer: string): unknown {
  let selected = root;
  for (const token of pointerTokens(pointer)) {
    if (Array.isArray(selected)) {
      if (!/^(?:0|[1-9]\d*)$/.test(token)) throw new Error('Invalid JSON Pointer.');
      const index = Number(token);
      if (!Number.isSafeInteger(index) || index >= selected.length) throw new Error('Invalid JSON Pointer.');
      selected = selected[index];
      continue;
    }
    const object = asObject(selected);
    if (!object || !Object.prototype.hasOwnProperty.call(object, token)) throw new Error('Invalid JSON Pointer.');
    selected = object[token];
  }
  return selected;
}

export function childPointer(pointer: string, token: string): string {
  return `${pointer}/${token.replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

type Range = { unit: 'codePoints' | 'items' | 'properties'; start: number; end: number; total: number };

function response(
  handle: string,
  path: string,
  value: unknown,
  complete: boolean,
  options: { range?: Range; nextOffset?: number; externalized?: Array<{ path: string; handle: string; bytes: number }> } = {},
): JsonObject {
  return {
    data: {
      value,
      ...(options.range ? { range: options.range } : {}),
      ...(options.externalized ? { externalized: options.externalized } : {}),
    },
    meta: {
      retrieval: {
        handle,
        path,
        complete,
        ...(options.nextOffset === undefined ? {} : { nextOffset: options.nextOffset }),
      },
    },
  };
}

export function fitsResultBoundary(value: unknown): boolean {
  const serialized = JSON.stringify(value);
  return Buffer.byteLength(serialized, 'utf8') <= DEFAULT_MAX_BYTES
    && serialized.split('\n').length <= DEFAULT_MAX_LINES;
}

function checked(value: JsonObject): JsonObject {
  if (!fitsResultBoundary(value)) throw new Error('Selected Linear result cannot be represented within the tool output boundary.');
  return value;
}

function worstRange(unit: Range['unit']): Range {
  return { unit, start: Number.MAX_SAFE_INTEGER, end: Number.MAX_SAFE_INTEGER, total: Number.MAX_SAFE_INTEGER };
}

export function resultPointerRepresentable(path: string): boolean {
  const continuation = response(EXAMPLE_HANDLE, path, '', false, {
    range: worstRange('codePoints'), nextOffset: Number.MAX_SAFE_INTEGER,
  });
  const child = childPointer(path, String(Number.MAX_SAFE_INTEGER));
  const fallback = response(EXAMPLE_HANDLE, path, [], false, {
    range: worstRange('items'), nextOffset: Number.MAX_SAFE_INTEGER,
    externalized: [{ path: child, handle: EXAMPLE_HANDLE, bytes: Number.MAX_SAFE_INTEGER }],
  });
  return fitsResultBoundary(continuation) && fitsResultBoundary(fallback);
}

export function resultChildPointerRepresentable(parent: string, child: string): boolean {
  return resultPointerRepresentable(child) && fitsResultBoundary(response(EXAMPLE_HANDLE, parent, {}, false, {
    range: worstRange('properties'), nextOffset: Number.MAX_SAFE_INTEGER,
    externalized: [{ path: child, handle: EXAMPLE_HANDLE, bytes: Number.MAX_SAFE_INTEGER }],
  }));
}

function assertOffset(value: unknown): number {
  const offset = value ?? 0;
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
    throw new Error('Invalid result offset. Use a non-negative integer.');
  }
  return offset;
}

function largestEnd(start: number, total: number, candidate: (end: number) => JsonObject): number {
  let low = start;
  let high = total;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fitsResultBoundary(candidate(middle))) low = middle;
    else high = middle - 1;
  }
  return low;
}

function segmentSequence<T>(
  handle: string,
  path: string,
  values: readonly T[],
  offset: number,
  unit: Range['unit'],
  slice: (start: number, end: number) => unknown,
  childToken?: (index: number) => string,
): JsonObject {
  const total = values.length;
  if (offset > total) throw new Error('Invalid result offset. The offset exceeds the selected value.');
  const whole = response(handle, path, slice(offset, total), true,
    offset ? { range: { unit, start: offset, end: total, total } } : {});
  if (fitsResultBoundary(whole)) return whole;

  const candidate = (end: number) => response(handle, path, slice(offset, end), end === total, {
    range: { unit, start: offset, end, total },
    ...(end < total ? { nextOffset: end } : {}),
  });
  const end = largestEnd(offset, total, candidate);
  if (end > offset) return checked(candidate(end));
  if (!childToken) throw new Error('Invalid JSON Pointer.');

  const childPath = childPointer(path, childToken(offset));
  if (!resultChildPointerRepresentable(path, childPath)) throw new Error('Invalid JSON Pointer.');
  const next = offset + 1;
  return checked(response(handle, path, slice(offset, offset), false, {
    range: { unit, start: offset, end: next, total },
    ...(next < total ? { nextOffset: next } : {}),
    externalized: [{ path: childPath, handle, bytes: Buffer.byteLength(JSON.stringify(values[offset]), 'utf8') }],
  }));
}

function segment(handle: string, path: string, selected: unknown, offset: number): JsonObject {
  let result: JsonObject;
  if (typeof selected === 'string') {
    const points = Array.from(selected);
    result = segmentSequence(handle, path, points, offset, 'codePoints',
      (start, end) => points.slice(start, end).join(''));
  } else if (Array.isArray(selected)) {
    result = segmentSequence(handle, path, selected, offset, 'items',
      (start, end) => selected.slice(start, end), (index) => String(index));
  } else {
    const object = asObject(selected);
    if (object) {
      const entries = Object.entries(object);
      result = segmentSequence(handle, path, entries, offset, 'properties',
        (start, end) => Object.fromEntries(entries.slice(start, end)), (index) => entries[index]![0]);
    } else {
      if (offset !== 0) throw new Error('Invalid result offset. Scalars only accept offset 0.');
      result = response(handle, path, selected, true);
    }
  }
  return checked(result);
}

export function validateGetResultVariables(variables: unknown): {
  handle: string;
  path: string;
  offset: number;
} {
  const object = asObject(variables) ?? {};
  const allowed = new Set(['handle', 'path', 'offset']);
  const unknown = Object.keys(object).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`Invalid parameters for "get_result": unknown ${unknown.join(', ')}.`);
  const handle = object.handle;
  handleUuid(handle);
  const path = object.path ?? '';
  pointerTokens(path);
  if (!resultPointerRepresentable(path as string)) throw new Error('Invalid JSON Pointer.');
  return { handle: handle as string, path: path as string, offset: assertOffset(object.offset) };
}

export async function getResult(variables: unknown): Promise<JsonObject> {
  const { handle, path, offset } = validateGetResultVariables(variables);
  const artifact = await readArtifact(handle);
  const selected = redactDeep(selectPointer(artifact, path), activeSecrets());
  return segment(handle, path, selected, offset);
}
