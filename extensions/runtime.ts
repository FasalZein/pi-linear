import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { activeSecrets } from './active-secrets';
import {
  assertIssueNodeMatches,
  assertNamedNodeMatches,
  linearGraphQL,
  linearGraphQLErrors,
  resolveApiKey,
  type LinearGraphQLPathError,
} from './client';
import type {
  GraphQLDocumentVariant,
  LocalResultExpectation,
  OperationPreparation,
  ResultCategory,
} from './operation-types';
import type { LinearOperation } from './operations';
import type { ResultView } from './selections';
import { redactDeep, withRedactedErrors } from './redact';
import { resultArtifactRoot, resultHandle } from './result-handles';
import { assertMutationAllowed, assertNamedInputAllowed, getMutationFields, type MutationMode } from './safety';

export const NODE_CAP = 100;
export const STRING_CAP = 2_000;
export const RESULT_BUDGET = 50 * 1024;
export const AUTO_SPILL_BYTES = 8 * 1024;

export type JsonObject = Record<string, unknown>;
export type Truncation = { path: string; kept: number; endCursor?: string };
export type ResultMeta = {
  nodeCap?: number;
  truncations: Truncation[];
  stringsClipped: number;
  resultBudget?: {
    maxBytes: number;
    maxLines?: number;
    truncated: true;
    recoverable?: true;
    omissions?: Array<{ path: ''; handle: string; originalBytes: number; inlineBytes: 0 }>;
  };
  view?: ResultView;
  routing?: {
    requestedSink: 'auto' | 'inline' | 'artifact';
    actualSink: 'inline' | 'artifact';
    reason?: 'requested' | 'spill-threshold' | 'tool-output-boundary';
    inlineComplete: boolean;
    externalized?: Array<{ path: ''; handle: string; bytes: number }>;
  };
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
  const key = Object.keys(object).filter((name) => name !== 'pageInfo' && name !== 'totalCount').at(-1);
  if (!key) return false;
  if (!dropLastBoundary(object[key])) {
    if (key === 'nodes') return false;
    delete object[key];
  }
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

type RoutedEnvelope<T extends JsonObject> = {
  data: T;
  errors?: LinearGraphQLPathError[];
  meta: ResultMeta;
  resolution?: JsonObject;
};

type RouteCategory = Exclude<ResultCategory, 'local'> | 'composite';

function withinToolBoundary(serialized: string): boolean {
  return Buffer.byteLength(serialized, 'utf8') <= DEFAULT_MAX_BYTES
    && serialized.split('\n').length <= DEFAULT_MAX_LINES;
}

export async function routeLinearResult<T extends JsonObject>(
  rawData: T,
  options: {
    label: string;
    category: RouteCategory;
    sink?: 'inline' | 'artifact';
    nodeCap?: number;
    secrets?: readonly string[];
    errors?: readonly LinearGraphQLPathError[];
    view?: ResultView;
    resolution?: JsonObject;
  },
): Promise<RoutedEnvelope<T> | {
  handle: string;
  path: string;
  bytes: number;
  index: string[];
  meta: ResultMeta;
  resolution?: JsonObject;
}> {
  // Redact before anything is measured, serialized, indexed, written, or returned.
  const secrets = options.secrets ?? [];
  const data = redactDeep(rawData, secrets);
  const errors = options.errors?.length
    ? redactDeep(options.errors, secrets) as LinearGraphQLPathError[]
    : undefined;
  const resolution = options.resolution ? redactDeep(options.resolution, secrets) : undefined;
  const requestedSink = options.sink ?? 'auto';
  const baseMeta: ResultMeta = {
    truncations: [],
    stringsClipped: 0,
    ...(options.view ? { view: options.view } : {}),
  };
  const complete: RoutedEnvelope<T> = {
    data,
    ...(errors ? { errors } : {}),
    meta: {
      ...baseMeta,
      routing: { requestedSink, actualSink: 'inline', inlineComplete: true },
    },
    ...(resolution ? { resolution } : {}),
  };
  const serialized = JSON.stringify(complete);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  const exceedsBoundary = !withinToolBoundary(serialized);
  const spillForPolicy = options.category !== 'singular' && bytes > spillThreshold();
  const spill = requestedSink === 'artifact'
    || exceedsBoundary
    || (requestedSink === 'auto' && spillForPolicy);

  if (!spill) {
    if (options.category !== 'collection') return complete;
    const compact = compactLinearResult(data, { nodeCap: options.nodeCap });
    return {
      data: compact.data,
      ...(errors ? { errors } : {}),
      meta: {
        ...compact.meta,
        ...(options.view ? { view: options.view } : {}),
        routing: { requestedSink, actualSink: 'inline', inlineComplete: true },
      },
      ...(resolution ? { resolution } : {}),
    };
  }

  const directory = resultArtifactRoot();
  const uuid = randomUUID();
  const handle = resultHandle(uuid);
  const path = join(directory, `${uuid}.json`);
  await mkdir(directory, { recursive: true });
  await writeFile(path, serialized);
  const reason = requestedSink === 'artifact'
    ? 'requested'
    : exceedsBoundary
      ? 'tool-output-boundary'
      : 'spill-threshold';
  return {
    handle,
    path,
    bytes,
    index: artifactIndex(data),
    meta: {
      ...baseMeta,
      ...(exceedsBoundary ? {
        resultBudget: {
          maxBytes: DEFAULT_MAX_BYTES,
          maxLines: DEFAULT_MAX_LINES,
          truncated: true,
          recoverable: true,
          omissions: [{ path: '', handle, originalBytes: bytes, inlineBytes: 0 }],
        },
      } : {}),
      routing: {
        requestedSink,
        actualSink: 'artifact',
        reason,
        inlineComplete: false,
        externalized: [{ path: '', handle, bytes }],
      },
    },
    ...(resolution ? { resolution } : {}),
  };
}

export async function apiKeyForWorkspace(ctx: ExtensionContext, workspace?: string): Promise<string> {
  const { apiKey } = await resolveApiKey(ctx, { workspace });
  if (!apiKey) throw new Error('Missing Linear API key. Set LINEAR_API_KEY or run /linear-auth.');
  return apiKey;
}

export type OperationRunOptions = {
  variables: Record<string, unknown>;
  workspace?: string;
  sink?: 'inline' | 'artifact';
};

export function assertOperationAllowed(
  operation: LinearOperation,
  variables: Record<string, unknown>,
  mode: MutationMode,
): void {
  if (operation.variants) {
    for (const variant of operation.variants) {
      assertMutationAllowed(variant.document, mode, [variant.root]);
    }
  } else {
    assertMutationAllowed(operation.document, mode, []);
  }
  assertNamedInputAllowed(variables);
  if (operation.variants) {
    for (const variant of operation.variants) {
      mutationExpectation(operation.name, variant);
    }
  }
}

function objectAtPath(value: unknown, path: string): JsonObject | undefined {
  let current: unknown = value;
  for (const part of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as JsonObject)[part];
  }
  return current && typeof current === 'object' && !Array.isArray(current)
    ? current as JsonObject
    : undefined;
}

function mutationExpectation(
  operationName: string,
  variant: GraphQLDocumentVariant,
) {
  const expectation = variant.mutationResult;
  if (!expectation && getMutationFields(variant.document).length) {
    throw new Error(
      `Linear operation "${operationName}" selected mutation variant "${variant.root}" without mutationResult metadata.`,
    );
  }
  return expectation;
}

export function validateMutationResult(
  operationName: string,
  data: JsonObject,
  variant: GraphQLDocumentVariant,
): void {
  const expectation = mutationExpectation(operationName, variant);
  if (!expectation) return;

  const root = objectAtPath(data, variant.root);
  const fail = (path: string, expected: string): never => {
    throw new Error(
      `Linear operation "${operationName}" failed mutation expectation: ${path} must be ${expected}.`,
    );
  };
  const payload = root ?? fail(variant.root, 'an object');
  if (payload[expectation.successPath] !== expectation.successValue) {
    fail(`${variant.root}.${expectation.successPath}`, 'true');
  }
  for (const entityPath of expectation.requiredEntityPaths) {
    if (!objectAtPath(payload, entityPath)) {
      fail(`${variant.root}.${entityPath}`, 'an object');
    }
  }
}

function valueAtPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const part of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as JsonObject)[part];
  }
  return current;
}

/**
 * A local operation produces its result inside this process, so nothing else proves the
 * result is real. The declared expectation is checked before redaction and routing.
 */
export function validateLocalResult(
  operationName: string,
  data: unknown,
  expectation: LocalResultExpectation | undefined,
): asserts data is JsonObject {
  const fail = (path: string, expected: string): never => {
    throw new Error(
      `Linear operation "${operationName}" failed local result expectation: ${path} must be ${expected}.`,
    );
  };
  if (!expectation) {
    throw new Error(`Linear operation "${operationName}" ran locally without a result expectation.`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('result', 'an object');
  for (const path of expectation.requiredStringPaths) {
    const value = valueAtPath(data, path);
    if (typeof value !== 'string' || !value.trim()) fail(path, 'a non-empty string');
  }
}

function applyExactIssueCheck(prepared: OperationPreparation, data: JsonObject): void {
  const check = prepared.exactIssue;
  if (!check) return;
  const issue = objectAtPath(data, check.path);
  assertIssueNodeMatches(check.requested, issue);
  const target = {
    requested: check.requested,
    resolvedId: issue.id,
    identifier: issue.identifier,
  };
  const resolution = prepared.resolution && typeof prepared.resolution === 'object'
    ? prepared.resolution
    : {};
  prepared.resolution = {
    ...resolution,
    target: { ...(typeof resolution.target === 'object' && resolution.target ? resolution.target : {}), ...target },
  };
}

function applyExactNamedCheck(prepared: OperationPreparation, data: JsonObject): void {
  const check = prepared.exactNamed;
  if (!check) return;
  const node = objectAtPath(data, check.path);
  assertNamedNodeMatches(check.kind, check.requested, node);
  const target: Record<string, unknown> = {
    requested: check.requested,
    resolvedId: node.id,
  };
  if (typeof node.name === 'string') target.name = node.name;
  if (typeof node.title === 'string') target.title = node.title;
  const resolution = prepared.resolution && typeof prepared.resolution === 'object'
    ? prepared.resolution
    : {};
  prepared.resolution = {
    ...resolution,
    target: { ...(typeof resolution.target === 'object' && resolution.target ? resolution.target : {}), ...target },
  };
}

/**
 * Single execution path for one named operation. Both `linear` and the typed
 * tools route through here, so mutation gating, reference resolution, spill, and
 * result routing exist exactly once.
 */
export async function executeOperation(
  operation: LinearOperation,
  options: OperationRunOptions,
  mode: MutationMode,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<JsonObject> {
  assertOperationAllowed(operation, options.variables, mode);
  // Seeded with every active credential, so local results, help, and early failures are
  // covered too; the selected key is appended as soon as it is known.
  const secrets: string[] = [...activeSecrets()];
  return withRedactedErrors(async () => {
    if (operation.executeLocal) {
      const localResult = await operation.executeLocal(options.variables, ctx);
      validateLocalResult(operation.name, localResult, operation.localResult);
      return redactDeep(localResult, secrets);
    }

    const apiKey = await apiKeyForWorkspace(ctx, options.workspace);
    secrets.push(apiKey);
    const prepared = operation.prepare
      ? await operation.prepare(apiKey, options.variables, signal)
      : { variables: options.variables };
    const variant = prepared.variant ?? operation.variants?.[0];
    const document = variant?.document ?? operation.document;
    assertMutationAllowed(document, mode, variant ? [variant.root] : []);
    if (variant) mutationExpectation(operation.name, variant);
    const data = await linearGraphQL<JsonObject>(apiKey, document, prepared.variables, signal);
    const errors = linearGraphQLErrors(data);
    if (variant) validateMutationResult(operation.name, data, variant);
    applyExactIssueCheck(prepared, data);
    applyExactNamedCheck(prepared, data);
    const category = prepared.resultCategory ?? operation.resultCategory;
    if (category === 'local') throw new Error(`Network operation "${operation.name}" cannot use local result routing.`);
    return routeLinearResult(data, {
      label: operation.name,
      category,
      sink: options.sink,
      secrets,
      errors,
      view: prepared.resultView,
      resolution: prepared.resolution,
    });
  }, secrets);
}
