import { Kind, parse, type FragmentDefinitionNode, type SelectionSetNode } from 'graphql';
import { parseJsonObject, type JsonObject, type JsonValue } from './json';
import {
  isCompatibilityNumber,
  isCompatibilityObject,
  isCompatibilityString,
} from './operation-types';
import { redactDeep, redactText } from './redact';

const LINEAR_GRAPHQL_ENDPOINT = 'https://api.linear.app/graphql';

function linearGraphQLEndpoint(): string {
  const override = process.env.LINEAR_READONLY === '1' ? process.env.LINEAR_SMOKE_GRAPHQL_ENDPOINT : undefined;
  if (!override) return LINEAR_GRAPHQL_ENDPOINT;
  const endpoint = new URL(override);
  if (!['127.0.0.1', '::1', 'localhost'].includes(endpoint.hostname)) {
    throw new Error('Read-only smoke endpoint overrides must use loopback.');
  }
  return endpoint.href;
}

const ISSUE_IDENTIFIER_PATTERN = /^([A-Z][A-Z0-9]*)-(\d+)$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ResolvedIssue = { id: string; identifier: string; teamId: string; teamKey: string };
export type ResolvedTeam = { id: string; key: string };
export type ResolvedState = { id: string; name: string; teamId: string };
export type ResolvedUser = { id: string; name?: string; displayName?: string; email?: string };
export type ResolvedNamedEntity = { id: string; name: string };

function asString(value: JsonValue | undefined): string | undefined {
  if (!isCompatibilityString(value)) return undefined;
  const text = value.trim();
  return text || undefined;
}

export {
  addWorkspace,
  getActiveWorkspaceName,
  getCredentialFilePath,
  listWorkspaceNames,
  readCredentials,
  removeWorkspace,
  resolveApiKey,
  setAuthPreference,
  switchWorkspace,
  writeCredentials,
  type AuthPreference,
  type WorkspaceCredentials,
} from './credential-internal/adapters';

type GraphQLErrorBody = {
  message?: string;
  path?: ReadonlyArray<string | number>;
  extensions?: JsonObject;
};

/** The Linear GraphQL response body, parsed once from the HTTP payload. */
type LinearResponseBody = { data?: JsonObject; errors: GraphQLErrorBody[] };

function parseErrorBody(entry: JsonObject): GraphQLErrorBody {
  const body: GraphQLErrorBody = {};
  const message = entry.message;
  if (isCompatibilityString(message)) body.message = message;
  const path = entry.path;
  if (Array.isArray(path) && path.every((part) => isCompatibilityString(part) || isCompatibilityNumber(part))) {
    body.path = path;
  }
  const extensions = entry.extensions;
  if (isCompatibilityObject(extensions)) body.extensions = extensions;
  return body;
}

/** Parse the HTTP payload once, at the network seam, into the response this module owns. */
function parseResponseBody(cause: unknown): LinearResponseBody {
  const parsed = parseJsonObject(cause);
  const entries = Array.isArray(parsed?.errors) ? parsed.errors : [];
  const errors = entries.flatMap((entry) => (isCompatibilityObject(entry) ? [parseErrorBody(entry)] : []));
  const data = isCompatibilityObject(parsed?.data) ? parsed.data : undefined;
  return data === undefined ? { errors } : { data, errors };
}

export type LinearGraphQLPathError = {
  path: ReadonlyArray<string | number>;
  message: string;
};

const LINEAR_GRAPHQL_ERRORS = Symbol('linearGraphQLErrors');
const LINEAR_GRAPHQL_RESPONSE_FAILURE = Symbol('linearGraphQLResponseFailure');
const LINEAR_GRAPHQL_RESPONSE_DATA = Symbol('linearGraphQLResponseData');
const LINEAR_RATE_LIMIT_TELEMETRY = Symbol('linearRateLimitTelemetry');

export type LinearRateLimitHeaders = Partial<{
  'X-Complexity': number;
  'X-RateLimit-Requests-Limit': number;
  'X-RateLimit-Requests-Remaining': number;
  'X-RateLimit-Requests-Reset': number;
  'X-RateLimit-Endpoint-Requests-Limit': number;
  'X-RateLimit-Endpoint-Requests-Remaining': number;
  'X-RateLimit-Endpoint-Requests-Reset': number;
  'X-RateLimit-Endpoint-Name': string;
  'X-RateLimit-Complexity-Limit': number;
  'X-RateLimit-Complexity-Remaining': number;
  'X-RateLimit-Complexity-Reset': number;
  'Retry-After': string;
}>;

export type LinearRateLimitSnapshot = {
  phase?: 'read' | 'mutation';
  attempt: number;
  headers: LinearRateLimitHeaders;
};

export async function withLinearRateLimitTelemetry<T>(
  snapshots: LinearRateLimitSnapshot[],
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof Error) attachTelemetry(error, snapshots, 'linearTelemetry');
    throw error;
  }
}

export function linearRateLimitTelemetry(value: JsonObject | undefined): readonly LinearRateLimitSnapshot[] {
  if (value === null || value === undefined) return [];
  return (value as { [LINEAR_RATE_LIMIT_TELEMETRY]?: readonly LinearRateLimitSnapshot[] })[LINEAR_RATE_LIMIT_TELEMETRY] ?? [];
}

export function linearErrorTelemetry(cause: unknown): readonly LinearRateLimitSnapshot[] {
  if (!(cause instanceof Error)) return [];
  return (cause as Error & { linearTelemetry?: readonly LinearRateLimitSnapshot[] }).linearTelemetry ?? [];
}

export function linearGraphQLErrors(data: JsonObject | undefined): readonly LinearGraphQLPathError[] {
  if (data === null || data === undefined) return [];
  return (data as { [LINEAR_GRAPHQL_ERRORS]?: readonly LinearGraphQLPathError[] })[LINEAR_GRAPHQL_ERRORS] ?? [];
}

export type LinearGraphQLResponseFailure = {
  error: Error;
  data: JsonObject;
  errors: readonly LinearGraphQLPathError[];
};

export function linearGraphQLResponseFailure(cause: unknown): LinearGraphQLResponseFailure | undefined {
  if (!(cause instanceof Error)) return undefined;
  const structured = cause as Error & {
    [LINEAR_GRAPHQL_RESPONSE_FAILURE]?: readonly LinearGraphQLPathError[];
    [LINEAR_GRAPHQL_RESPONSE_DATA]?: JsonObject;
  };
  if (!structured[LINEAR_GRAPHQL_RESPONSE_FAILURE]) return undefined;
  return {
    error: cause,
    data: structured[LINEAR_GRAPHQL_RESPONSE_DATA] ?? {},
    errors: structured[LINEAR_GRAPHQL_RESPONSE_FAILURE],
  };
}

function errorPath(error: GraphQLErrorBody): ReadonlyArray<string | number> | undefined {
  const path = error.path;
  return path === undefined || path.length === 0 ? undefined : path;
}

function responseGraphQLErrors(errors: GraphQLErrorBody[], apiKey: string): LinearGraphQLPathError[] {
  return errors.map((error) => ({
    path: errorPath(error) ?? [],
    message: redactText(errorText(error), [apiKey]),
  }));
}

function scopedPathErrors(errors: GraphQLErrorBody[], apiKey: string): LinearGraphQLPathError[] | undefined {
  const scoped = responseGraphQLErrors(errors, apiKey);
  return scoped.every((error) => error.path.length > 0) ? scoped : undefined;
}

function hasUsableRoot(data: JsonObject, errors: readonly LinearGraphQLPathError[]): boolean {
  const failed = new Set(errors.map((error) => error.path[0]));
  return Object.entries(data).some(([key, value]) => value != null || !failed.has(key));
}

function errorText(error: GraphQLErrorBody): string {
  const extensions = error.extensions ?? {};
  const presentable = asString(extensions.userPresentableMessage);
  if (presentable) return presentable;

  for (const source of [extensions, extensions.exception]) {
    if (!isCompatibilityObject(source)) continue;
    for (const key of ['fieldErrors', 'validationErrors']) {
      const entries = source[key];
      if (!Array.isArray(entries)) continue;
      const messages = entries.flatMap((entry) => {
        if (!isCompatibilityObject(entry)) return asString(entry) ?? [];
        const constraints = entry.constraints;
        return isCompatibilityObject(constraints)
          ? Object.values(constraints).flatMap((value) => asString(value) ?? [])
          : asString(entry.message) ?? [];
      });
      if (messages.length) return [...new Set(messages)].join('; ');
    }
  }

  return asString(error.message) ?? asString(extensions.type) ?? asString(extensions.code) ?? 'Unknown Linear GraphQL error';
}

const NUMERIC_RATE_LIMIT_HEADERS = [
  'X-Complexity',
  'X-RateLimit-Requests-Limit',
  'X-RateLimit-Requests-Remaining',
  'X-RateLimit-Requests-Reset',
  'X-RateLimit-Endpoint-Requests-Limit',
  'X-RateLimit-Endpoint-Requests-Remaining',
  'X-RateLimit-Endpoint-Requests-Reset',
  'X-RateLimit-Complexity-Limit',
  'X-RateLimit-Complexity-Remaining',
  'X-RateLimit-Complexity-Reset',
] as const;

export function parseLinearRateLimitHeaders(headers: Headers): LinearRateLimitHeaders {
  const parsed: LinearRateLimitHeaders = {};
  for (const name of NUMERIC_RATE_LIMIT_HEADERS) {
    const raw = headers.get(name);
    if (raw === null || !raw.trim()) continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) parsed[name] = value;
  }
  const endpoint = headers.get('X-RateLimit-Endpoint-Name')?.trim();
  if (endpoint) parsed['X-RateLimit-Endpoint-Name'] = endpoint;
  const retryAfter = headers.get('Retry-After')?.trim();
  if (retryAfter && retryAfterDelay(retryAfter) !== undefined) parsed['Retry-After'] = retryAfter;
  return parsed;
}

function retryAfterDelay(value: string): number | undefined {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function retryDelay(snapshot: LinearRateLimitSnapshot): number {
  const retryAfter = snapshot.headers['Retry-After'];
  if (retryAfter) return retryAfterDelay(retryAfter) ?? 3_000;
  const endpointRemaining = snapshot.headers['X-RateLimit-Endpoint-Requests-Remaining'];
  const endpointReset = snapshot.headers['X-RateLimit-Endpoint-Requests-Reset'];
  if (endpointRemaining !== undefined && endpointRemaining <= 0 && endpointReset !== undefined) {
    return Math.max(0, endpointReset - Date.now());
  }
  return 3_000;
}

function searchRead(query: string): boolean {
  try {
    const document = parse(query);
    const fragments = new Map(document.definitions
      .filter((definition): definition is FragmentDefinitionNode => definition.kind === Kind.FRAGMENT_DEFINITION)
      .map((fragment) => [fragment.name.value, fragment]));
    const roots = new Set<string>();
    const collect = (selectionSet: SelectionSetNode, seen: Set<string>): void => {
      for (const selection of selectionSet.selections) {
        if (selection.kind === Kind.FIELD) roots.add(selection.name.value);
        else if (selection.kind === Kind.INLINE_FRAGMENT) collect(selection.selectionSet, seen);
        else if (!seen.has(selection.name.value)) {
          const fragment = fragments.get(selection.name.value);
          if (fragment) collect(fragment.selectionSet, new Set([...seen, selection.name.value]));
        }
      }
    };
    for (const definition of document.definitions) {
      if (definition.kind !== Kind.OPERATION_DEFINITION || definition.operation !== 'query') continue;
      collect(definition.selectionSet, new Set());
    }
    return roots.has('searchIssues') || roots.has('semanticSearch');
  } catch {
    return false;
  }
}

function rateLimited(errors: readonly GraphQLErrorBody[]): boolean {
  return errors.some(({ extensions }) =>
    extensions?.code === 'RATELIMITED' || extensions?.type === 'RATELIMITED');
}

function attachTelemetry(target: Error | JsonObject, snapshots: readonly LinearRateLimitSnapshot[], key: symbol | string): void {
  Object.defineProperty(target, key, { value: snapshots.map((snapshot) => redactDeep(snapshot)), configurable: true });
}

export type LinearGraphQLOptions = {
  preserveUnusableRoot?: boolean;
  throwResponseErrors?: boolean;
  phase?: 'read' | 'mutation';
};

export type LinearTransport = typeof fetch;

export type LinearNetworkContext = {
  credential: { apiKey: string; source: 'env' | 'workspace' };
  transport: LinearTransport;
  telemetry: LinearRateLimitSnapshot[];
  signal?: AbortSignal;
};

export type LinearGraphQLFn = (
  apiKey: string,
  query: string,
  variables?: JsonObject,
  signal?: AbortSignal,
  options?: LinearGraphQLOptions,
) => Promise<JsonObject>;

function abortableDelay(delay: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('Request cancelled.'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, delay);
    function done(): void {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      reject(new Error('Request cancelled.'));
    }
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

export async function linearGraphQLWithContext(
  context: LinearNetworkContext,
  query: string,
  variables: JsonObject = {},
  options?: LinearGraphQLOptions,
): Promise<JsonObject> {
  const { apiKey } = context.credential;
  const snapshots: LinearRateLimitSnapshot[] = [];
  const isSearchRead = searchRead(query);
  let response!: Response;
  let body: LinearResponseBody = { errors: [] };

  for (let attempt = 0; ; attempt++) {
    try {
      response = await context.transport(linearGraphQLEndpoint(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: apiKey },
        body: JSON.stringify({ query, variables }),
        signal: context.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failure = new Error(`Linear network error: ${redactText(message, [apiKey])}`);
      attachTelemetry(failure, snapshots, 'linearTelemetry');
      throw failure;
    }

    const headers = redactDeep(parseLinearRateLimitHeaders(response.headers ?? new Headers()), [apiKey]);
    const snapshot: LinearRateLimitSnapshot = options?.phase
      ? { phase: options.phase, attempt: attempt + 1, headers }
      : { attempt: attempt + 1, headers };
    snapshots.push(snapshot);
    context.telemetry.push(snapshot);
    body = { errors: [] };
    try {
      body = parseResponseBody(await response.json());
    } catch {
      // Use the HTTP status below for non-JSON responses.
    }

    const retryHttp = response.status === 429;
    const retryGraphQL = response.status === 400 && isSearchRead && rateLimited(body.errors);
    if (attempt === 0 && (retryHttp || retryGraphQL)) {
      try {
        await abortableDelay(retryDelay(snapshot), context.signal);
      } catch (error) {
        if (error instanceof Error) attachTelemetry(error, snapshots, 'linearTelemetry');
        throw error;
      }
      continue;
    }
    break;
  }

  const detail = redactText([...new Set(body.errors.map(errorText))].join('; '), [apiKey]);
  if (!response.ok) {
    const status = redactText(`${response.status} ${response.statusText}`, [apiKey]);
    const failure = new Error(`Linear API request failed: ${detail || status}`);
    attachTelemetry(failure, snapshots, 'linearTelemetry');
    throw failure;
  }
  if (body.errors.length) {
    const data = body.data;
    const normalized = responseGraphQLErrors(body.errors, apiKey);
    if (options?.throwResponseErrors) {
      const failure = new Error(`Linear GraphQL error: ${detail}`);
      Object.defineProperty(failure, LINEAR_GRAPHQL_RESPONSE_FAILURE, { value: normalized });
      if (data) {
        Object.defineProperty(failure, LINEAR_GRAPHQL_RESPONSE_DATA, { value: data });
      }
      attachTelemetry(failure, snapshots, 'linearTelemetry');
      throw failure;
    }
    if (data) {
      const scoped = scopedPathErrors(body.errors, apiKey);
      if ((scoped && hasUsableRoot(data, scoped)) || options?.preserveUnusableRoot) {
        Object.defineProperty(data, LINEAR_GRAPHQL_ERRORS, {
          value: scoped ?? responseGraphQLErrors(body.errors, apiKey),
        });
        attachTelemetry(data, snapshots, LINEAR_RATE_LIMIT_TELEMETRY);
        return data;
      }
    }
    const failure = new Error(`Linear GraphQL error: ${detail}`);
    attachTelemetry(failure, snapshots, 'linearTelemetry');
    throw failure;
  }
  if (!body.data) {
    const failure = new Error('Linear GraphQL response did not include data.');
    attachTelemetry(failure, snapshots, 'linearTelemetry');
    throw failure;
  }
  attachTelemetry(body.data, snapshots, LINEAR_RATE_LIMIT_TELEMETRY);
  return body.data;
}

export async function linearGraphQL(
  apiKey: string,
  query: string,
  variables: JsonObject = {},
  signal?: AbortSignal,
  options?: LinearGraphQLOptions,
): Promise<JsonObject> {
  return linearGraphQLWithContext({
    credential: { apiKey, source: 'env' },
    transport: fetch,
    telemetry: [],
    signal,
  }, query, variables, options);
}

function requireReference(value: string, kind: string): string {
  const reference = value.trim();
  if (!reference) throw new Error(`Linear ${kind} reference is required.`);
  return reference;
}

export function isIssueIdentifier(value: string): boolean {
  return ISSUE_IDENTIFIER_PATTERN.test(value);
}

export function requireIssueReference(value: string): string {
  const reference = requireReference(value, 'issue');
  if (ISSUE_IDENTIFIER_PATTERN.test(reference) || UUID_PATTERN.test(reference)) return reference;
  throw new Error(`Invalid Linear issue reference "${reference}". Use TEAM-123 or a UUID.`);
}

export function parseIssueReferenceSet(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) {
    throw new Error('issues must be an array of issue identifiers or UUIDs.');
  }
  if (!value.length) {
    throw new Error('issues must contain at least one issue identifier or UUID.');
  }
  const seen = new Set<string>();
  const references: string[] = [];
  for (const item of value) {
    if (!isCompatibilityString(item)) {
      throw new Error('issues must be an array of issue identifiers or UUIDs.');
    }
    const reference = requireIssueReference(item);
    const key = reference.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`Duplicate Linear issue reference "${item}".`);
    }
    seen.add(key);
    references.push(reference);
  }
  return references;
}

export type MatchedIssueNode = JsonObject & { id: string; identifier: string };

export function assertIssueNodeMatches(
  requested: string,
  issue: JsonObject | null | undefined,
): asserts issue is MatchedIssueNode {
  const reference = requireIssueReference(requested);
  if (!issue || !isCompatibilityString(issue.id) || !isCompatibilityString(issue.identifier)) {
    throw new Error(`Linear issue "${reference}" was not found.`);
  }
  const identifier = reference.match(ISSUE_IDENTIFIER_PATTERN);
  if (identifier) {
    const teamKey = identifier[1]!;
    const number = Number(identifier[2]!);
    const parsedResult = issue.identifier.match(ISSUE_IDENTIFIER_PATTERN);
    if (!parsedResult || parsedResult[1]!.toLowerCase() !== teamKey.toLowerCase() || Number(parsedResult[2]!) !== number) {
      throw new Error(`Linear issue resolver returned mismatched identifier "${issue.identifier}" for "${reference}".`);
    }
    return;
  }
  if (issue.id !== reference) {
    throw new Error(`Linear issue resolver returned mismatched id "${issue.id}" for "${reference}".`);
  }
}

export type NamedEntityKind = 'project' | 'cycle' | 'document';

export type MatchedNamedNode = JsonObject & { id: string };

export function assertNamedNodeMatches(
  kind: NamedEntityKind,
  requested: string,
  node: JsonObject | null | undefined,
): asserts node is MatchedNamedNode {
  const reference = requested.trim();
  if (!node || !isCompatibilityString(node.id)) {
    throw new Error(`Linear ${kind} "${reference}" was not found.`);
  }
  if (UUID_PATTERN.test(reference)) {
    if (node.id !== reference) {
      throw new Error(`Linear ${kind} resolver returned mismatched id "${node.id}" for "${reference}".`);
    }
    return;
  }
  if (!isCompatibilityString(node.slugId)) {
    throw new Error(`Linear ${kind} resolver did not include slug identity proof for "${reference}".`);
  }
  if (node.slugId.toLowerCase() !== reference.toLowerCase()) {
    throw new Error(`Linear ${kind} resolver returned mismatched slug "${node.slugId}" for "${reference}".`);
  }
}
