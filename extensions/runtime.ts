import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { activeSecrets } from './active-secrets';
import {
  linearGraphQLWithContext,
  linearGraphQLErrors,
  resolveApiKey,
  withLinearRateLimitTelemetry,
  type LinearGraphQLPathError,
  type LinearNetworkContext,
  type LinearRateLimitSnapshot,
  type LinearTransport,
} from './client';
import type {
  GraphQLDocumentVariant,
  LocalResultExpectation,
  OperationPlan,
  OperationPreparation,
  ResultCategory,
} from './operation-types';
import type { LinearOperation } from './operations';
import { resolveOperationPlan, verifyOperationResult } from './operation-plan';
import type { ResultView } from './selections';
import { redactDeep, withRedactedErrors } from './redact';
import {
  assertTrustedResultDirectory,
  fitsResultBoundary,
  resolveTrustedResultDirectory,
  resultArtifactRoot,
  resultHandle,
} from './result-handles';
import { assertMutationAllowed, assertNamedInputAllowed, getMutationFields, type MutationMode } from './safety';

export const NODE_CAP = 100;
export const STRING_CAP = 2_000;
export const RESULT_BUDGET = 50 * 1024;

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
  rateLimit?: {
    scopes: Array<'requests' | 'endpoint' | 'complexity'>;
    retryAttempts: number;
    responses: Array<Record<string, string | number>>;
  };
};

function spillThreshold(): number | undefined {
  const configured = Number(process.env.LINEAR_SPILL_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : undefined;
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
  _options: { nodeCap?: number; resultBudget?: number } = {},
): { data: T; meta: ResultMeta } {
  return { data: input, meta: { truncations: [], stringsClipped: 0 } };
}

type RoutedEnvelope<T extends JsonObject> = {
  data: T;
  errors?: LinearGraphQLPathError[];
  meta: ResultMeta;
  resolution?: JsonObject;
};

type ArtifactResult = {
  handle: string;
  path: string;
  bytes: number;
  index: string[];
  meta: ResultMeta & JsonObject;
  resolution?: JsonObject;
};

type RouteCategory = Exclude<ResultCategory, 'local'> | 'composite' | 'batch';

type RateLimitScope = 'requests' | 'endpoint' | 'complexity';
export type TelemetryMode = 'always';

function rateLimitDetails(
  snapshots: readonly LinearRateLimitSnapshot[],
  mode?: TelemetryMode,
): ResultMeta['rateLimit'] | undefined {
  const scopes = new Set<RateLimitScope>();
  for (const { headers } of snapshots) {
    const requests = headers['X-RateLimit-Requests-Remaining'];
    if (requests !== undefined && requests <= 1) scopes.add('requests');
    const endpoint = headers['X-RateLimit-Endpoint-Requests-Remaining'];
    if (endpoint !== undefined && endpoint <= 1) scopes.add('endpoint');
    const complexity = headers['X-Complexity'];
    const complexityRemaining = headers['X-RateLimit-Complexity-Remaining'];
    if (complexity !== undefined && complexityRemaining !== undefined && complexityRemaining <= complexity) {
      scopes.add('complexity');
    }
  }
  if (!scopes.size && mode !== 'always') return undefined;
  return {
    scopes: [...scopes],
    retryAttempts: snapshots.filter(({ attempt }) => attempt > 1).length,
    responses: snapshots.map(({ phase, attempt, headers }) => ({
      ...(phase ? { phase } : {}),
      attempt,
      ...headers,
    })),
  };
}

function withinToolBoundary(serialized: string): boolean {
  return Buffer.byteLength(serialized, 'utf8') <= DEFAULT_MAX_BYTES
    && serialized.split('\n').length <= DEFAULT_MAX_LINES;
}

async function writeResultArtifact(directory: string, uuid: string, serialized: string): Promise<string> {
  await assertTrustedResultDirectory(directory);
  const path = join(directory, `${uuid}.json`);
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    if (!(await file.stat()).isFile()) throw new Error('Linear result artifact file is not regular.');
    await file.writeFile(serialized, 'utf8');
    await assertTrustedResultDirectory(directory);
  } finally {
    await file.close();
  }
  return path;
}

export async function routeLinearEnvelope<T extends JsonObject>(
  rawEnvelope: T,
  options: {
    label: string;
    category: RouteCategory;
    sink?: 'inline' | 'artifact';
    secrets?: readonly string[];
    telemetry?: readonly LinearRateLimitSnapshot[];
    telemetryMode?: TelemetryMode;
  },
): Promise<T | ArtifactResult> {
  // Redact before anything is measured, serialized, indexed, written, or returned.
  const envelope = redactDeep(rawEnvelope, options.secrets ?? []) as T;
  const telemetry = redactDeep(options.telemetry ?? [], options.secrets ?? []) as LinearRateLimitSnapshot[];
  const warning = rateLimitDetails(telemetry, options.telemetryMode);
  const existingMeta = envelope.meta;
  if (!existingMeta || typeof existingMeta !== 'object' || Array.isArray(existingMeta)) {
    throw new Error(`Linear ${options.label} result envelope is missing metadata.`);
  }
  const requestedSink = options.sink ?? 'auto';
  const inlineEnvelope = {
    ...envelope,
    meta: {
      ...(existingMeta as JsonObject),
      ...(warning ? { rateLimit: warning } : {}),
      routing: { requestedSink, actualSink: 'inline', inlineComplete: true },
    },
  } as T;
  const inlineSerialized = JSON.stringify(inlineEnvelope);
  const inlineBytes = Buffer.byteLength(inlineSerialized, 'utf8');
  const exceedsBoundary = !withinToolBoundary(inlineSerialized);
  const configuredSpillThreshold = spillThreshold();
  const spillForPolicy = configuredSpillThreshold !== undefined
    && options.category !== 'singular'
    && inlineBytes >= configuredSpillThreshold;
  const spill = requestedSink === 'artifact'
    || exceedsBoundary
    || (requestedSink === 'auto' && spillForPolicy);

  if (!spill) return inlineEnvelope;

  const reason = requestedSink === 'artifact'
    ? 'requested'
    : exceedsBoundary
      ? 'tool-output-boundary'
      : 'spill-threshold';
  const storedEnvelope = {
    ...envelope,
    meta: {
      ...(existingMeta as JsonObject),
      ...(warning ? { rateLimit: warning } : {}),
      routing: { requestedSink, actualSink: 'artifact', reason, inlineComplete: false },
    },
  } as T;
  const serialized = JSON.stringify(storedEnvelope);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  const directory = await resolveTrustedResultDirectory(true);
  const uuid = randomUUID();
  const handle = resultHandle(uuid);
  await writeResultArtifact(directory, uuid, serialized);
  const path = join(resultArtifactRoot(), `${uuid}.json`);
  const data = envelope.data;
  const base: ArtifactResult = {
    handle,
    path,
    bytes,
    index: [],
    meta: {
      ...(existingMeta as JsonObject),
      ...(warning ? { rateLimit: warning } : {}),
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
    } as ResultMeta & JsonObject,
  };
  if (!fitsResultBoundary(base)) throw new Error('Linear artifact digest exceeds the tool output boundary.');

  let digest = base;
  if (envelope.resolution && typeof envelope.resolution === 'object' && !Array.isArray(envelope.resolution)) {
    const candidate = { ...digest, resolution: envelope.resolution as JsonObject };
    if (fitsResultBoundary(candidate)) digest = candidate;
  }
  for (const entry of artifactIndex(data && typeof data === 'object' && !Array.isArray(data) ? data as JsonObject : {})) {
    const candidate = { ...digest, index: [...digest.index, entry] };
    if (!fitsResultBoundary(candidate)) break;
    digest = candidate;
  }
  if (!fitsResultBoundary(digest)) throw new Error('Linear artifact digest exceeds the tool output boundary.');
  return digest;
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
    telemetry?: readonly LinearRateLimitSnapshot[];
    telemetryMode?: TelemetryMode;
  },
): Promise<RoutedEnvelope<T> | ArtifactResult> {
  return routeLinearEnvelope({
    data: rawData,
    ...(options.errors?.length ? { errors: options.errors } : {}),
    meta: {
      truncations: [],
      stringsClipped: 0,
      ...(options.view ? { view: options.view } : {}),
    },
    ...(options.resolution ? { resolution: options.resolution } : {}),
  } as RoutedEnvelope<T>, options);
}

export type LinearCallContext = {
  mode: MutationMode;
  signal?: AbortSignal;
  pi: ExtensionContext;
  workspace?: string;
  sink?: 'inline' | 'artifact';
  telemetryMode?: TelemetryMode;
};

export function linearCallContext(
  mode: MutationMode,
  signal: AbortSignal | undefined,
  pi: ExtensionContext,
  options: { workspace?: string; sink?: 'inline' | 'artifact'; telemetryMode?: TelemetryMode } = {},
): LinearCallContext {
  return { mode, signal, pi, ...options };
}

export async function networkExecutionContext(
  call: LinearCallContext,
  transport: LinearTransport = fetch,
  telemetry: LinearRateLimitSnapshot[] = [],
): Promise<LinearNetworkContext> {
  const credential = await resolveApiKey(call.pi, { workspace: call.workspace, mode: call.mode });
  if (!credential.apiKey || credential.source === 'none') {
    throw new Error('Missing Linear API key. Set LINEAR_API_KEY or run /linear-auth.');
  }
  return {
    credential: { apiKey: credential.apiKey, source: credential.source },
    transport,
    telemetry,
    signal: call.signal,
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
  telemetryMode?: TelemetryMode;
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

/**
 * Single execution path for one named operation. Both `linear` and the typed
 * tools route through here, so mutation gating, reference resolution, spill, and
 * result routing exist exactly once.
 */
async function executeOperationWithContext(
  operation: LinearOperation,
  options: OperationRunOptions,
  call: LinearCallContext,
  transport: LinearTransport,
): Promise<JsonObject> {
  assertOperationAllowed(operation, options.variables, call.mode);
  const secrets: string[] = [];
  return withRedactedErrors(async () => {
    if (operation.executeLocal) {
      secrets.push(...activeSecrets());
      const localResult = await operation.executeLocal(options.variables, call.pi, call.mode);
      validateLocalResult(operation.name, localResult, operation.localResult);
      return redactDeep(localResult, secrets);
    }

    let plan: OperationPlan | undefined;
    try {
      plan = operation.plan ? await operation.plan(options.variables) : undefined;
    } catch (error) {
      secrets.push(...activeSecrets());
      throw error;
    }
    secrets.push(...activeSecrets());
    const network = await networkExecutionContext(call, transport);
    const apiKey = network.credential.apiKey;
    secrets.push(apiKey);
    return withLinearRateLimitTelemetry(network.telemetry, async () => {
      const prepared = plan
        ? await resolveOperationPlan(network, plan)
        : { variables: options.variables };
      const variant = prepared.variant ?? operation.variants?.[0];
      const document = variant?.document ?? operation.document;
      assertMutationAllowed(document, call.mode, variant ? [variant.root] : []);
      if (variant) mutationExpectation(operation.name, variant);
      let data: JsonObject;
      let errors: readonly LinearGraphQLPathError[];
      try {
        data = await linearGraphQLWithContext<JsonObject>(
          network,
          document,
          prepared.variables,
          prepared.telemetryPhase ? { phase: prepared.telemetryPhase } : undefined,
        );
        errors = linearGraphQLErrors(data);
        if (prepared.requireNoGraphQLErrors && errors.length) {
          throw new Error(`Linear operation "${operation.name}" returned a GraphQL error.`);
        }
        if (variant) validateMutationResult(operation.name, data, variant);
        verifyOperationResult(prepared, data);
      } catch (error) {
        if (prepared.failureMessage) throw new Error(prepared.failureMessage);
        throw error;
      }
      const category = prepared.resultCategory ?? operation.resultCategory;
      if (category === 'local') throw new Error(`Network operation "${operation.name}" cannot use local result routing.`);
      return routeLinearResult(prepared.acknowledgement ?? data, {
        label: operation.name,
        category,
        sink: call.sink,
        secrets,
        errors,
        view: prepared.resultView,
        resolution: prepared.resolution,
        telemetry: network.telemetry,
        telemetryMode: call.telemetryMode,
      });
    });
  }, secrets);
}

export async function executeOperationInContext(
  operation: LinearOperation,
  options: Pick<OperationRunOptions, 'variables'>,
  call: LinearCallContext,
  transport: LinearTransport = fetch,
): Promise<JsonObject> {
  return executeOperationWithContext(operation, options, call, transport);
}

export async function executeOperation(
  operation: LinearOperation,
  options: OperationRunOptions,
  mode: MutationMode,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  transport: LinearTransport = fetch,
): Promise<JsonObject> {
  return executeOperationWithContext(
    operation,
    options,
    linearCallContext(mode, signal, ctx, options),
    transport,
  );
}

export async function executeRawQuery(
  query: string,
  variables: Record<string, unknown>,
  call: LinearCallContext,
  transport: LinearTransport = fetch,
): Promise<JsonObject> {
  assertMutationAllowed(query, call.mode);
  const secrets = [...activeSecrets()];
  return withRedactedErrors(async () => {
    const network = await networkExecutionContext(call, transport);
    secrets.push(network.credential.apiKey);
    return withLinearRateLimitTelemetry(network.telemetry, async () => {
      const data = await linearGraphQLWithContext<JsonObject>(network, query, variables);
      return routeLinearResult(data, {
        label: 'query',
        category: 'composite',
        sink: call.sink,
        nodeCap: NODE_CAP,
        secrets,
        errors: linearGraphQLErrors(data),
        telemetry: network.telemetry,
        telemetryMode: call.telemetryMode,
      });
    });
  }, secrets);
}
