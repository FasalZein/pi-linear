import { defineTool, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Type } from 'typebox';
import { linearGraphQL, resolveApiKey } from './client';
import { getOperation } from './operations';
import { assertMutationAllowed, type MutationMode } from './safety';

export const NODE_CAP = 100;
export const STRING_CAP = 2_000;
export const RESULT_BUDGET = 50 * 1024;
export const AUTO_SPILL_BYTES = 8 * 1024;

type JsonObject = Record<string, unknown>;
type Truncation = { path: string; kept: number; endCursor?: string };
type ResultMeta = {
  nodeCap?: number;
  truncations: Truncation[];
  stringsClipped: number;
  resultBudget?: { maxBytes: number; truncated: true };
};

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function dropLastBoundary(value: unknown): boolean {
  if (Array.isArray(value)) {
    if (!value.length) return false;
    value.pop();
    return true;
  }
  if (!value || typeof value !== 'object') return false;
  const object = value as JsonObject;
  const key = Object.keys(object).at(-1);
  if (!key) return false;
  if (!dropLastBoundary(object[key])) delete object[key];
  return true;
}

function spillThreshold(): number {
  const configured = Number(process.env.LINEAR_SPILL_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : AUTO_SPILL_BYTES;
}

function artifactIndex(data: JsonObject): string[] {
  const issues: string[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    const object = value as JsonObject;
    if (typeof object.identifier === 'string' && typeof object.title === 'string') {
      const state = object.state as JsonObject | undefined;
      issues.push(`${object.identifier} · ${object.title} · ${typeof state?.name === 'string' ? state.name : ''}`);
    }
    Object.values(object).forEach(visit);
  };
  visit(data);
  if (issues.length) return [...issues.slice(0, 50), ...(issues.length > 50 ? [`+${issues.length - 50} more`] : [])];

  return Object.entries(data).map(([key, value]) => {
    const nodes = value && typeof value === 'object' ? (value as JsonObject).nodes : undefined;
    return Array.isArray(nodes) ? `${key} · ${nodes.length} nodes` : key;
  });
}

export function compactLinearResult<T extends JsonObject>(
  input: T,
  options: { nodeCap?: number; resultBudget?: number } = { nodeCap: NODE_CAP },
): { data: T; meta: ResultMeta } {
  const truncations: Truncation[] = [];
  let stringsClipped = 0;

  const visit = (value: unknown, path: string, key?: string, endCursor?: string): unknown => {
    if (typeof value === 'string' && value.length > STRING_CAP) {
      stringsClipped++;
      return `${value.slice(0, STRING_CAP)}…[truncated ${STRING_CAP}/${value.length} chars — refetch with a narrower query]`;
    }
    if (Array.isArray(value)) {
      const cap = key === 'nodes' ? options.nodeCap : undefined;
      const items = cap === undefined ? value : value.slice(0, cap);
      if (items.length < value.length) {
        truncations.push({ path, kept: items.length, ...(endCursor ? { endCursor } : {}) });
      }
      return items.map((item, index) => visit(item, `${path}[${index}]`));
    }
    if (value && typeof value === 'object') {
      const object = value as JsonObject;
      const cursor = typeof (object.pageInfo as JsonObject | undefined)?.endCursor === 'string'
        ? (object.pageInfo as JsonObject).endCursor as string
        : undefined;
      return Object.fromEntries(Object.entries(object).map(([childKey, child]) => [
        childKey,
        visit(child, path ? `${path}.${childKey}` : childKey, childKey, cursor),
      ]));
    }
    return value;
  };

  const data = visit(input, '') as T;
  const meta: ResultMeta = {
    ...(options.nodeCap === undefined ? {} : { nodeCap: options.nodeCap }),
    truncations,
    stringsClipped,
  };
  const result = { data, meta };
  const budget = options.resultBudget ?? RESULT_BUDGET;
  if (byteLength(result) > budget) {
    meta.resultBudget = { maxBytes: budget, truncated: true };
    while (byteLength(result) > budget && dropLastBoundary(data));
  }
  return result;
}

export async function routeLinearResult<T extends JsonObject>(
  data: T,
  options: { label: string; sink?: 'inline' | 'artifact'; nodeCap?: number },
): Promise<{ data: T; meta: ResultMeta } | { path: string; bytes: number; index: string[]; meta: ResultMeta }> {
  const full = { data, meta: { truncations: [], stringsClipped: 0 } as ResultMeta };
  const serialized = JSON.stringify(full);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  const spill = options.sink === 'artifact' || (options.sink !== 'inline' && bytes > spillThreshold());
  if (!spill) return compactLinearResult(data, { nodeCap: options.nodeCap });

  const directory = resolve(process.env.PI_ARTIFACT_PROJECT_ROOT ?? join(homedir(), '.pi/artifacts'), 'linear/raw');
  const path = join(directory, `${options.label}-${new Date().toISOString()}.json`);
  await mkdir(directory, { recursive: true });
  await writeFile(path, serialized);
  return { path, bytes, index: artifactIndex(data), meta: full.meta };
}

async function apiKeyForWorkspace(ctx: ExtensionContext, workspace?: string): Promise<string> {
  const { apiKey } = await resolveApiKey(ctx, { workspace });
  if (!apiKey) throw new Error('Missing Linear API key. Set LINEAR_API_KEY or run /linear-auth.');
  return apiKey;
}

export function resolveRequest(params: { operation?: string; query?: string }): {
  query: string;
  named: boolean;
} {
  if (Boolean(params.operation) === Boolean(params.query)) {
    throw new Error('Provide exactly one of operation or query.');
  }
  return params.operation
    ? { query: getOperation(params.operation).document, named: true }
    : { query: params.query!, named: false };
}

export function linearApiTool(referencePath: string, mode: MutationMode = 'allowlist') {
  return defineTool({
    name: 'linear_api',
    label: 'Linear API',
    description: `Run a bundled Linear operation or raw GraphQL. Catalog errors list operations. Reference: ${referencePath}`,
    parameters: Type.Object({
      operation: Type.Optional(Type.String({ description: 'Bundled operation name.' })),
      query: Type.Optional(Type.String({ description: 'Raw GraphQL escape hatch.' })),
      variables: Type.Optional(Type.Record(Type.String(), Type.Any())),
      workspace: Type.Optional(Type.String({ description: 'Stored workspace name.' })),
      sink: Type.Optional(Type.Union([
        Type.Literal('inline'),
        Type.Literal('artifact'),
      ], { description: 'Choose inline output or an artifact file.' })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error('Request cancelled.');
      const request = resolveRequest(params);
      assertMutationAllowed(request.query, mode);
      const apiKey = await apiKeyForWorkspace(ctx, params.workspace);
      const data = await linearGraphQL<JsonObject>(apiKey, request.query, params.variables ?? {}, signal);
      const result = await routeLinearResult(data, {
        label: params.operation ?? 'query',
        sink: params.sink,
        nodeCap: request.named ? undefined : NODE_CAP,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  });
}
