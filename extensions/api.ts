import { defineTool, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { linearGraphQL, resolveApiKey } from './client';
import { getOperation } from './operations';
import { assertMutationAllowed, type MutationMode } from './safety';

export const NODE_CAP = 100;
export const STRING_CAP = 2_000;
export const RESULT_BUDGET = 50 * 1024;

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
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error('Request cancelled.');
      const request = resolveRequest(params);
      assertMutationAllowed(request.query, mode);
      const apiKey = await apiKeyForWorkspace(ctx, params.workspace);
      const data = await linearGraphQL<JsonObject>(apiKey, request.query, params.variables ?? {}, signal);
      const result = compactLinearResult(data, { nodeCap: request.named ? undefined : NODE_CAP });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  });
}
