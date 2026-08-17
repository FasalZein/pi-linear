import { defineTool, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Type } from 'typebox';
import { linearGraphQL, resolveApiKey } from './client';
import {
  DOMAINS,
  formatInvocation,
  getOperation,
  operationSignature,
  operationsForDomain,
  parameterShapes,
  operationDocuments,
  operations,
  type LinearOperation,
  type OperationDomain,
} from './operations';
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

const REQUEST_SHAPES = 'Invalid request. Send exactly one of: { "operation": "get_issue", "variables": { "issue": "AEO-258" } }, { "operation": "help" }, or { "query": "query { viewer { id } }", "variables": {} }.';
const HELP_SHAPES = 'Send exactly one of: { "operation": "help" }, { "operation": "help", "variables": { "domain": "issues" } }, or { "operation": "help", "variables": { "operation": "get_issue" } }. For natural search, send exactly one of: { "operation": "help", "variables": { "query": "issue lookup by identifier" } } or { "operation": "help", "variables": { "search": "comment issue create comment" } }.';

function parameterList(operation: LinearOperation): string {
  return operation.parameters.map(({ name, type, required }) =>
    `${name}: ${type}${required ? ' (required)' : ' (optional)'}`,
  ).join(', ');
}

function validateVariables(
  operation: LinearOperation,
  requestedName: string,
  variables: Record<string, unknown>,
): void {
  const shapes = parameterShapes(operation, requestedName);
  const valid = new Set(shapes.flatMap((shape) => shape.map(({ name }) => name)));
  const validShape = !operation.requiresVariables || Object.keys(variables).length > 0
    ? shapes.find((shape) => {
      const shapeKeys = new Set(shape.map(({ name }) => name));
      return shape.every(({ name, required }) => !required || name in variables)
        && Object.keys(variables).every((name) => shapeKeys.has(name));
    })
    : undefined;
  if (validShape) {
    try {
      operation.validateVariables?.(variables);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Invalid parameters for "${operation.name}": ${message}. Valid parameters: ${parameterList(operation)}. Example: ${formatInvocation(operation.example)}.`,
      );
    }
  }

  const missing = operation.parameters.filter(({ name, required }) => required && !(name in variables)).map(({ name }) => name);
  const unknown = Object.keys(variables).filter((name) => !valid.has(name));
  const problems = [
    ...(operation.requiresVariables && !Object.keys(variables).length ? ['at least one parameter is required'] : []),
    ...(missing.length ? [`missing ${missing.join(', ')}`] : []),
    ...(unknown.length ? [`unknown ${unknown.join(', ')}`] : []),
  ].join('; ') || 'parameters do not match one accepted shape';
  throw new Error(
    `Invalid parameters for "${operation.name}": ${problems}. Valid parameters: ${parameterList(operation)}. Example: ${formatInvocation(operation.example)}.`,
  );
}

export function resolveRequest(params: {
  operation?: string;
  query?: string;
  variables?: Record<string, unknown>;
}): { query: string; named: false } | { query: string; named: true; operation: LinearOperation } {
  if (Boolean(params.operation) === Boolean(params.query)) throw new Error(REQUEST_SHAPES);
  if (!params.operation) return { query: params.query!, named: false };

  const operation = getOperation(params.operation);
  validateVariables(operation, params.operation, params.variables ?? {});
  return { query: operation.document, named: true, operation };
}

const HELP_WORD_ALIASES: Record<string, string> = {
  assigned: 'assignee',
  assignment: 'assignee',
  comments: 'comment',
  cycles: 'cycle',
  documents: 'document',
  initiatives: 'initiative',
  issues: 'issue',
  labels: 'label',
  lookup: 'get',
  milestones: 'milestone',
  progress: 'started',
  projects: 'project',
  relations: 'relation',
  statuses: 'status',
  teams: 'team',
  users: 'user',
  views: 'view',
};

function helpWords(value: string): Set<string> {
  const words = value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? [];
  return new Set(words.map((word) => HELP_WORD_ALIASES[word] ?? word));
}

function naturalHelp(search: string): JsonObject {
  const queryWords = helpWords(search);
  const score = (operation: LinearOperation): number => {
    const fields: Array<[Set<string>, number]> = [
      [helpWords(operation.name), 16],
      [helpWords(operation.domain), 6],
      [helpWords(operation.purpose), 4],
      [helpWords(operation.parameters.map(({ name, type }) => `${name} ${type}`).join(' ')), 2],
    ];
    return fields.reduce((total, [words, weight]) =>
      total + [...queryWords].filter((word) => words.has(word)).length * weight, 0);
  };
  const ranked = Object.values(operations)
    .map((operation) => ({ operation, score: score(operation) }))
    .sort((left, right) => right.score - left.score || (left.operation.name < right.operation.name ? -1 : 1));
  const best = ranked[0]!.operation;
  return {
    query: search,
    match: {
      name: best.name,
      domain: best.domain,
      purpose: best.purpose,
      signature: operationSignature(best),
      parameters: best.parameters,
      invocation: best.example,
    },
    alternatives: ranked.slice(1, 3).filter(({ score }) => score > 0).map(({ operation }) => ({
      name: operation.name,
      signature: operationSignature(operation),
    })),
  };
}

function helpResult(variables: Record<string, unknown> = {}): JsonObject {
  const keys = Object.keys(variables);
  if (!keys.length) {
    return {
      domains: DOMAINS,
      domainHelp: { operation: 'help', variables: { domain: 'issues' } },
      operationHelp: { operation: 'help', variables: { operation: 'get_issue' } },
    };
  }

  const domain = variables.domain;
  const operationName = variables.operation;
  const naturalKeys = keys.filter((key) => key === 'query' || key === 'search');
  const schemaKeys = keys.filter((key) => key === 'includeSchema' || key === 'include_schema');
  const naturalQuery = variables.query ?? variables.search;
  const naturalMode = naturalKeys.length === 1
    && schemaKeys.length <= 1
    && keys.length === naturalKeys.length + schemaKeys.length
    && (schemaKeys.length === 0 || typeof variables[schemaKeys[0]!] === 'boolean');
  if (naturalMode && typeof naturalQuery === 'string' && naturalQuery.trim()) {
    return naturalHelp(naturalQuery.trim());
  }
  if (keys.length !== 1) throw new Error(`Invalid help request. ${HELP_SHAPES}`);
  if (typeof domain === 'string' && DOMAINS.includes(domain as OperationDomain)) {
    return {
      domain,
      operations: operationsForDomain(domain as OperationDomain).map((operation) => ({
        name: operation.name,
        signature: operationSignature(operation),
      })),
    };
  }
  if (typeof operationName === 'string') {
    const operation = getOperation(operationName);
    return {
      name: operation.name,
      domain: operation.domain,
      purpose: operation.purpose,
      parameters: operation.parameters,
      example: operation.example,
    };
  }
  throw new Error(`Invalid help request. ${HELP_SHAPES}`);
}

function toolResult(details: JsonObject) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
}

export function linearApiTool(mode: MutationMode = 'allowlist') {
  return defineTool({
    name: 'linear_api',
    label: 'Linear API',
    description: 'Run a named Linear operation or raw GraphQL. Discover operations with { "operation": "help" }.',
    parameters: Type.Object({
      operation: Type.Optional(Type.String({ description: 'Bundled operation name.' })),
      query: Type.Optional(Type.String({ description: 'Raw GraphQL escape hatch.' })),
      variables: Type.Optional(Type.Record(Type.String(), Type.Any())),
      workspace: Type.Optional(Type.String({ description: 'Stored workspace name, or default/active for normal credential selection.' })),
      sink: Type.Optional(Type.Union([
        Type.Literal('inline'),
        Type.Literal('artifact'),
      ], { description: 'Choose inline output or an artifact file.' })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error('Request cancelled.');
      if (params.operation === 'help' && !params.query) return toolResult(helpResult(params.variables));

      const request = resolveRequest(params);
      if (request.named) {
        for (const document of operationDocuments(request.operation)) {
          assertMutationAllowed(document, mode, request.operation.mutationRoots);
        }
        if (request.operation.executeLocal) {
          return toolResult(await request.operation.executeLocal(params.variables ?? {}, ctx));
        }
      } else {
        assertMutationAllowed(request.query, mode);
      }
      const apiKey = await apiKeyForWorkspace(ctx, params.workspace);
      const prepared: { variables: Record<string, unknown>; resolution?: Record<string, unknown>; document?: string } = request.named && request.operation.prepare
        ? await request.operation.prepare(apiKey, params.variables ?? {}, signal)
        : { variables: params.variables ?? {} };
      const document = prepared.document ?? request.query;
      if (request.named) assertMutationAllowed(document, mode, request.operation.mutationRoots);
      const data = await linearGraphQL<JsonObject>(apiKey, document, prepared.variables, signal);
      const result = await routeLinearResult(data, {
        label: params.operation ?? 'query',
        sink: params.sink,
        nodeCap: request.named ? undefined : NODE_CAP,
      });
      return toolResult(prepared.resolution ? { ...result, resolution: prepared.resolution } : result);
    },
  });
}
