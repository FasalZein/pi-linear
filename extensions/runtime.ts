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
import {
  isCompatibilityObject,
  isCompatibilityString,
  type GraphQLDocumentVariant,
  type LocalResultExpectation,
  type OperationPlan,
  type ResultCategory,
} from './operation-types';
import { parseJson, type JsonObject, type JsonValue } from './json';
import { mutationAcknowledgement } from './mutation-acknowledgement';
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

export type { JsonObject, JsonValue } from './json';
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
  const visit = (value: JsonValue | undefined): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (!isCompatibilityObject(value)) return;
    if (isCompatibilityString(value.identifier) && isCompatibilityString(value.title)) {
      const state = isCompatibilityObject(value.state) ? value.state : undefined;
      const stateName = state === undefined ? undefined : state.name;
      issues.push(`${value.identifier} · ${value.title} · ${isCompatibilityString(stateName) ? stateName : ''}`);
    }
    for (const entry of Object.values(value)) visit(entry);
  };
  visit(data);
  if (issues.length) return [...issues.slice(0, 50), ...(issues.length > 50 ? [`+${issues.length - 50} more`] : [])];

  return Object.entries(data).map(([key, value]) => {
    const nodes = isCompatibilityObject(value) ? value.nodes : undefined;
    return Array.isArray(nodes) ? `${key} · ${nodes.length} nodes` : key;
  });
}

export type CompactedResult<T extends JsonObject> = { data: T; meta: ResultMeta };

export function compactLinearResult<T extends JsonObject>(
  input: T,
  _options: { nodeCap?: number; resultBudget?: number } = {},
): CompactedResult<T> {
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
    responses: snapshots.map(({ phase, attempt, headers }) => {
      const response: Record<string, string | number> = {};
      if (phase) response.phase = phase;
      response.attempt = attempt;
      return { ...response, ...headers };
    }),
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
  if (!isCompatibilityObject(existingMeta)) {
    throw new Error(`Linear ${options.label} result envelope is missing metadata.`);
  }
  const requestedSink = options.sink ?? 'auto';
  // One reported metadata base, so inline, stored, and digest envelopes stay identical.
  const reportedMeta: JsonObject = { ...existingMeta };
  if (warning) reportedMeta.rateLimit = warning;
  const inlineEnvelope = {
    ...envelope,
    meta: {
      ...reportedMeta,
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
      ...reportedMeta,
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
  const digestMeta: JsonObject = { ...reportedMeta };
  if (exceedsBoundary) {
    digestMeta.resultBudget = {
      maxBytes: DEFAULT_MAX_BYTES,
      maxLines: DEFAULT_MAX_LINES,
      truncated: true,
      recoverable: true,
      omissions: [{ path: '', handle, originalBytes: bytes, inlineBytes: 0 }],
    };
  }
  const base: ArtifactResult = {
    handle,
    path,
    bytes,
    index: [],
    meta: {
      ...digestMeta,
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
  const resolution = envelope.resolution;
  if (isCompatibilityObject(resolution)) {
    const candidate = { ...digest, resolution };
    if (fitsResultBoundary(candidate)) digest = candidate;
  }
  for (const entry of artifactIndex(isCompatibilityObject(data) ? data : {})) {
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
  const meta: ResultMeta = { truncations: [], stringsClipped: 0 };
  if (options.view) meta.view = options.view;
  // Serialized envelopes keep the published key order: data, errors, meta, resolution.
  const errors = options.errors?.length ? [...options.errors] : undefined;
  const envelope: RoutedEnvelope<T> = errors
    ? { data: rawData, errors, meta }
    : { data: rawData, meta };
  if (options.resolution) envelope.resolution = options.resolution;
  return routeLinearEnvelope(envelope, options);
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
  variables: JsonObject;
  workspace?: string;
  sink?: 'inline' | 'artifact';
  telemetryMode?: TelemetryMode;
};

export function assertOperationAllowed(
  operation: LinearOperation,
  variables: JsonObject,
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

function objectAtPath(value: JsonValue | undefined, path: string): JsonObject | undefined {
  const found = valueAtPath(value, path);
  return isCompatibilityObject(found) ? found : undefined;
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

function valueAtPath(value: JsonValue | undefined, path: string): JsonValue | undefined {
  let current = value;
  for (const part of path.split('.')) {
    if (!isCompatibilityObject(current)) return undefined;
    current = current[part];
  }
  return current;
}

/**
 * A local operation produces its result inside this process, so nothing else proves the
 * result is real. The declared expectation is checked before redaction and routing, and
 * the parsed value is what the caller routes.
 */
export function parseLocalResult(
  operationName: string,
  cause: unknown,
  expectation: LocalResultExpectation | undefined,
): JsonObject {
  const fail = (path: string, expected: string): never => {
    throw new Error(
      `Linear operation "${operationName}" failed local result expectation: ${path} must be ${expected}.`,
    );
  };
  if (!expectation) {
    throw new Error(`Linear operation "${operationName}" ran locally without a result expectation.`);
  }
  const parsed = parseJson(cause);
  if (!isCompatibilityObject(parsed)) return fail('result', 'an object');
  for (const path of expectation.requiredStringPaths) {
    const value = valueAtPath(parsed, path);
    if (!isCompatibilityString(value) || !value.trim()) fail(path, 'a non-empty string');
  }
  return parsed;
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
      return redactDeep(parseLocalResult(operation.name, localResult, operation.localResult), secrets);
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
        data = await linearGraphQLWithContext(
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
      const acknowledgement = prepared.acknowledgement
        ?? (variant && prepared.resultView !== 'full'
          ? mutationAcknowledgement(operation.name, data, variant)
          : undefined);
      return routeLinearResult(acknowledgement ?? data, {
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
  variables: JsonObject,
  call: LinearCallContext,
  transport: LinearTransport = fetch,
): Promise<JsonObject> {
  assertMutationAllowed(query, call.mode);
  const secrets = [...activeSecrets()];
  return withRedactedErrors(async () => {
    const network = await networkExecutionContext(call, transport);
    secrets.push(network.credential.apiKey);
    return withLinearRateLimitTelemetry(network.telemetry, async () => {
      const data = await linearGraphQLWithContext(network, query, variables);
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
