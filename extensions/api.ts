import { defineTool, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { linearGraphQL, resolveApiKey } from './client';

export const NODE_CAP = 100;

type JsonObject = Record<string, unknown>;

export function compactLinearResult<T extends JsonObject>(data: T): {
  data: T;
  meta: { nodeCap: number; truncated: boolean };
} {
  let truncated = false;

  const visit = (value: unknown, key?: string): unknown => {
    if (Array.isArray(value)) {
      const items = key === 'nodes' ? value.slice(0, NODE_CAP) : value;
      if (items.length < value.length) truncated = true;
      return items.map((item) => visit(item));
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([childKey, child]) => [childKey, visit(child, childKey)]),
      );
    }
    return value;
  };

  return {
    data: visit(data) as T,
    meta: { nodeCap: NODE_CAP, truncated },
  };
}

async function apiKeyForWorkspace(ctx: ExtensionContext, workspace?: string): Promise<string> {
  const { apiKey } = await resolveApiKey(ctx, { workspace });
  if (!apiKey) {
    throw new Error('Missing Linear API key. Set LINEAR_API_KEY or run /linear-auth.');
  }
  return apiKey;
}

export function linearApiTool(referencePath: string) {
  return defineTool({
    name: 'linear_api',
    label: 'Linear API',
    description: `Execute any Linear GraphQL query or mutation with stored credentials and return compact JSON. Read tested snippets at ${referencePath}; each result caps every nodes array at ${NODE_CAP} items and reports truncation.`,
    parameters: Type.Object({
      query: Type.String({ description: 'GraphQL query or mutation.' }),
      variables: Type.Optional(Type.Record(Type.String(), Type.Any())),
      workspace: Type.Optional(Type.String({ description: 'Stored workspace name.' })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error('Request cancelled.');
      const apiKey = await apiKeyForWorkspace(ctx, params.workspace);
      const data = await linearGraphQL<JsonObject>(apiKey, params.query, params.variables ?? {}, signal);
      const result = compactLinearResult(data);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        details: result,
      };
    },
  });
}
