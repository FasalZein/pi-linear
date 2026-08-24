import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Kind, parse, type FragmentDefinitionNode, type SelectionSetNode } from 'graphql';
import { assertLocalWriteAllowed } from './local-write-policy';
import { redactDeep, redactError, redactText } from './redact';
import type { MutationMode } from './safety';

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
const LINEAR_URL_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type ResolvedIssue = { id: string; identifier: string; teamId: string; teamKey: string };
export type ResolvedTeam = { id: string; key: string };
export type ResolvedState = { id: string; name: string; teamId: string };
export type ResolvedUser = { id: string; name?: string; displayName?: string; email?: string };
export type ResolvedNamedEntity = { id: string; name: string };

export type AuthPreference = 'workspace' | 'env';

export type WorkspaceCredentials = {
  activeWorkspace: string | null;
  authPreference: AuthPreference;
  workspaces: Record<string, { apiKey: string }>;
  [key: string]: unknown;
};

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text || undefined;
}

function emptyCredentials(): WorkspaceCredentials {
  return { activeWorkspace: null, authPreference: 'workspace', workspaces: {} };
}

export function getCredentialFilePath(): string {
  const piDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
  return path.join(piDir, 'extensions', 'linear', 'credentials.json');
}

function invalidCredentialFile(): never {
  throw new Error('Invalid Linear credential file. Repair or remove it before changing stored credentials.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCredentials(parsed: unknown): WorkspaceCredentials {
  if (!isRecord(parsed) || !isRecord(parsed.workspaces)) invalidCredentialFile();
  if (parsed.activeWorkspace !== undefined && parsed.activeWorkspace !== null && typeof parsed.activeWorkspace !== 'string') {
    invalidCredentialFile();
  }
  if (parsed.authPreference !== undefined && parsed.authPreference !== 'workspace' && parsed.authPreference !== 'env') {
    invalidCredentialFile();
  }

  const workspaces: WorkspaceCredentials['workspaces'] = {};
  for (const [name, entry] of Object.entries(parsed.workspaces)) {
    if (!isRecord(entry)) invalidCredentialFile();
    const apiKey = asString(entry.apiKey);
    if (!apiKey) invalidCredentialFile();
    workspaces[name] = { apiKey };
  }

  return {
    ...parsed,
    activeWorkspace: typeof parsed.activeWorkspace === 'string' ? parsed.activeWorkspace : null,
    authPreference: parsed.authPreference === 'env' ? 'env' : 'workspace',
    workspaces,
  };
}

export async function readCredentials(): Promise<WorkspaceCredentials> {
  let source: string;
  try {
    source = await fs.readFile(getCredentialFilePath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyCredentials();
    throw redactError(error);
  }

  try {
    return normalizeCredentials(JSON.parse(source));
  } catch (error) {
    if (error instanceof SyntaxError) invalidCredentialFile();
    throw error;
  }
}

type CredentialLockOwner = { pid: number; token: string };

function invalidCredentialLock(): never {
  throw new Error('Invalid Linear credential lock. Repair or remove it before changing stored credentials.');
}

async function readCredentialLockRecord(lockPath: string, fileName: string): Promise<CredentialLockOwner> {
  const lockStat = await fs.lstat(lockPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!lockStat) throw Object.assign(new Error('Credential lock changed.'), { code: 'ENOENT' });
  if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) invalidCredentialLock();
  const changed = async (): Promise<never> => {
    const current = await fs.lstat(lockPath).catch(() => undefined);
    if (!current || current.dev !== lockStat.dev || current.ino !== lockStat.ino) {
      throw Object.assign(new Error('Credential lock changed.'), { code: 'ENOENT' });
    }
    invalidCredentialLock();
  };
  const recordPath = path.join(lockPath, fileName);
  const recordStat = await fs.lstat(recordPath).catch(() => undefined);
  if (!recordStat) return changed();
  if (!recordStat.isFile() || recordStat.isSymbolicLink()) invalidCredentialLock();
  let record: unknown;
  try {
    record = JSON.parse(await fs.readFile(recordPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return changed();
    invalidCredentialLock();
  }
  const current = await fs.lstat(lockPath).catch(() => undefined);
  if (!current || current.dev !== lockStat.dev || current.ino !== lockStat.ino) {
    throw Object.assign(new Error('Credential lock changed.'), { code: 'ENOENT' });
  }
  if (!isRecord(record) || !Number.isSafeInteger(record.pid) || Number(record.pid) <= 0 || typeof record.token !== 'string') {
    invalidCredentialLock();
  }
  return { pid: Number(record.pid), token: record.token };
}

function readCredentialLockOwner(lockPath: string): Promise<CredentialLockOwner> {
  return readCredentialLockRecord(lockPath, 'owner.json');
}

function readCredentialRecoveryClaim(lockPath: string): Promise<CredentialLockOwner> {
  return readCredentialLockRecord(lockPath, 'recovery.json');
}

function ownerProcessIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw error;
  }
}

async function moveAndRemoveCredentialLock(lockPath: string, expected: CredentialLockOwner): Promise<void> {
  const movedPath = `${lockPath}.remove-${process.pid}-${randomUUID()}`;
  await fs.rename(lockPath, movedPath);
  const moved = await readCredentialLockOwner(movedPath);
  if (moved.pid !== expected.pid || moved.token !== expected.token) invalidCredentialLock();
  await fs.rm(movedPath, { recursive: true });
}

function sameCredentialLockOwner(left: CredentialLockOwner, right: CredentialLockOwner): boolean {
  return left.pid === right.pid && left.token === right.token;
}

async function restoreCredentialRecoveryClaim(movedPath: string, recoveryPath: string): Promise<void> {
  try {
    await fs.link(movedPath, recoveryPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST' && code !== 'ENOENT') throw error;
  }
  await fs.rm(movedPath, { force: true });
}

async function removeCredentialRecoveryClaim(lockPath: string, expected: CredentialLockOwner): Promise<void> {
  const recoveryPath = path.join(lockPath, 'recovery.json');
  const movedName = `recovery.remove-${process.pid}-${randomUUID()}.json`;
  const movedPath = path.join(lockPath, movedName);
  try {
    await fs.rename(recoveryPath, movedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const moved = await readCredentialLockRecord(lockPath, movedName).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!moved || sameCredentialLockOwner(moved, expected)) {
    await fs.rm(movedPath, { force: true });
    return;
  }
  await restoreCredentialRecoveryClaim(movedPath, recoveryPath);
}

async function recoverCredentialLock(lockPath: string, expected: CredentialLockOwner): Promise<void> {
  const recoveryPath = path.join(lockPath, 'recovery.json');
  const recovery = { pid: process.pid, token: randomUUID() };
  try {
    await fs.writeFile(recoveryPath, JSON.stringify(recovery), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let existing: CredentialLockOwner;
    try {
      existing = await readCredentialRecoveryClaim(lockPath);
    } catch (readError) {
      if ((readError as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw readError;
    }
    if (!ownerProcessIsGone(existing.pid)) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return;
    }
    let current: CredentialLockOwner;
    try {
      current = await readCredentialLockOwner(lockPath);
    } catch (readError) {
      if ((readError as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw readError;
    }
    if (!sameCredentialLockOwner(current, expected) || !ownerProcessIsGone(current.pid)) return;

    const abandonedName = `recovery.abandoned-${process.pid}-${randomUUID()}.json`;
    const abandonedPath = path.join(lockPath, abandonedName);
    try {
      await fs.rename(recoveryPath, abandonedPath);
    } catch (moveError) {
      if ((moveError as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw moveError;
    }
    const abandoned = await readCredentialLockRecord(lockPath, abandonedName).catch((readError) => {
      if ((readError as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw readError;
    });
    if (!abandoned) return;
    if (!sameCredentialLockOwner(abandoned, existing)) {
      await restoreCredentialRecoveryClaim(abandonedPath, recoveryPath);
      return;
    }
    try {
      await fs.writeFile(recoveryPath, JSON.stringify(recovery), { flag: 'wx', mode: 0o600 });
    } catch (claimError) {
      await fs.rm(abandonedPath, { force: true });
      if ((claimError as NodeJS.ErrnoException).code === 'EEXIST' || (claimError as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw claimError;
    }
    await fs.rm(abandonedPath, { force: true });
  }

  let current: CredentialLockOwner;
  let claim: CredentialLockOwner;
  try {
    [current, claim] = await Promise.all([readCredentialLockOwner(lockPath), readCredentialRecoveryClaim(lockPath)]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!sameCredentialLockOwner(current, expected) || !ownerProcessIsGone(current.pid) || !sameCredentialLockOwner(claim, recovery)) {
    await removeCredentialRecoveryClaim(lockPath, recovery);
    return;
  }
  await moveAndRemoveCredentialLock(lockPath, expected);
}

async function withCredentialLock<T>(work: () => Promise<T>): Promise<T> {
  const filePath = getCredentialFilePath();
  const directory = path.dirname(filePath);
  const lockPath = `${filePath}.lock`;
  const owner = { pid: process.pid, token: randomUUID() };
  await fs.mkdir(directory, { recursive: true });

  while (true) {
    const candidate = `${lockPath}-${owner.pid}-${randomUUID()}`;
    try {
      await fs.mkdir(candidate, { mode: 0o700 });
      await fs.writeFile(path.join(candidate, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
      await fs.rename(candidate, lockPath);
      break;
    } catch (error) {
      await fs.rm(candidate, { recursive: true, force: true }).catch(() => undefined);
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw redactError(error);
      let existing: CredentialLockOwner;
      try {
        existing = await readCredentialLockOwner(lockPath);
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw redactError(readError);
      }
      if (ownerProcessIsGone(existing.pid)) {
        await recoverCredentialLock(lockPath, existing);
        continue;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  try {
    return await work();
  } finally {
    const current = await readCredentialLockOwner(lockPath);
    if (current.pid !== owner.pid || current.token !== owner.token) invalidCredentialLock();
    await moveAndRemoveCredentialLock(lockPath, owner);
  }
}

async function writeCredentialsUnlocked(creds: WorkspaceCredentials): Promise<void> {
  const filePath = getCredentialFilePath();
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(directory, `.credentials-${process.pid}-${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(creds, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw redactError(error);
  }
}

export async function writeCredentials(
  creds: WorkspaceCredentials,
  mode: MutationMode = 'allowlist',
): Promise<void> {
  assertLocalWriteAllowed(mode);
  await withCredentialLock(() => writeCredentialsUnlocked(normalizeCredentials(structuredClone(creds))));
}

async function mutateCredentials(
  mode: MutationMode,
  mutate: (creds: WorkspaceCredentials) => void,
): Promise<WorkspaceCredentials> {
  assertLocalWriteAllowed(mode);
  return withCredentialLock(async () => {
    const creds = structuredClone(await readCredentials());
    mutate(creds);
    const validated = normalizeCredentials(creds);
    await writeCredentialsUnlocked(validated);
    return validated;
  });
}

export async function addWorkspace(
  name: string,
  apiKey: string,
  mode: MutationMode = 'allowlist',
): Promise<WorkspaceCredentials> {
  return mutateCredentials(mode, (creds) => {
    creds.workspaces[name] = { apiKey };
    creds.activeWorkspace ??= name;
  });
}

export async function removeWorkspace(
  name: string,
  mode: MutationMode = 'allowlist',
): Promise<WorkspaceCredentials> {
  return mutateCredentials(mode, (creds) => {
    delete creds.workspaces[name];
    if (creds.activeWorkspace === name) creds.activeWorkspace = Object.keys(creds.workspaces)[0] ?? null;
  });
}

export async function switchWorkspace(
  name: string,
  mode: MutationMode = 'allowlist',
): Promise<WorkspaceCredentials> {
  return mutateCredentials(mode, (creds) => {
    if (!creds.workspaces[name]) throw new Error(`Workspace "${redactText(name)}" does not exist.`);
    creds.activeWorkspace = name;
  });
}

export async function setAuthPreference(
  preference: AuthPreference,
  mode: MutationMode = 'allowlist',
): Promise<WorkspaceCredentials> {
  return mutateCredentials(mode, (creds) => {
    creds.authPreference = preference;
  });
}

export function listWorkspaceNames(creds: WorkspaceCredentials): string[] {
  return Object.keys(creds.workspaces);
}

export function getActiveWorkspaceName(creds: WorkspaceCredentials): string | null {
  return creds.activeWorkspace;
}

export async function resolveApiKey(
  ctx: ExtensionContext,
  options?: { promptIfMissing?: boolean; workspace?: string; mode?: MutationMode },
): Promise<{ apiKey?: string; source: 'env' | 'workspace' | 'none' }> {
  const creds = await readCredentials();
  const workspaceAlias = options?.workspace === 'default' || options?.workspace === 'active';
  const requestedWorkspace = workspaceAlias ? undefined : asString(options?.workspace);
  if (requestedWorkspace) {
    const apiKey = creds.workspaces[requestedWorkspace]?.apiKey;
    if (!apiKey) throw new Error(`Workspace "${requestedWorkspace}" does not exist.`);
    return { apiKey, source: 'workspace' };
  }

  const workspaceKey = creds.activeWorkspace
    ? creds.workspaces[creds.activeWorkspace]?.apiKey
    : undefined;
  const envApiKey = asString(process.env.LINEAR_API_KEY);
  const preferred =
    creds.authPreference === 'env'
      ? [envApiKey, workspaceKey]
      : [workspaceKey, envApiKey];
  const apiKey = preferred.find(Boolean);
  if (apiKey) return { apiKey, source: apiKey === envApiKey ? 'env' : 'workspace' };

  if ((options?.promptIfMissing ?? true) && ctx.hasUI) {
    const shouldAdd = await ctx.ui.confirm(
      'Linear API key required',
      'No configured workspace or LINEAR_API_KEY found. Add one now?',
    );
    if (shouldAdd) {
      const name = asString(await ctx.ui.input('Workspace name', 'my-workspace'));
      const key = name ? asString(await ctx.ui.input('Linear API key', 'lin_api_...')) : undefined;
      if (name && key) {
        await addWorkspace(name, key, options?.mode ?? 'allowlist');
        ctx.ui.notify(`Workspace "${name}" saved and set as active`, 'info');
        return { apiKey: key, source: 'workspace' };
      }
    }
  }

  return { source: 'none' };
}

type GraphQLErrorBody = {
  message?: string;
  path?: ReadonlyArray<string | number>;
  extensions?: Record<string, unknown>;
};

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

export function linearRateLimitTelemetry(value: unknown): readonly LinearRateLimitSnapshot[] {
  if (!value || typeof value !== 'object') return [];
  return (value as { [LINEAR_RATE_LIMIT_TELEMETRY]?: readonly LinearRateLimitSnapshot[] })[LINEAR_RATE_LIMIT_TELEMETRY] ?? [];
}

export function linearErrorTelemetry(error: unknown): readonly LinearRateLimitSnapshot[] {
  if (!(error instanceof Error)) return [];
  return (error as Error & { linearTelemetry?: readonly LinearRateLimitSnapshot[] }).linearTelemetry ?? [];
}

export function linearGraphQLErrors(data: unknown): readonly LinearGraphQLPathError[] {
  if (!data || typeof data !== 'object') return [];
  return (data as { [LINEAR_GRAPHQL_ERRORS]?: readonly LinearGraphQLPathError[] })[LINEAR_GRAPHQL_ERRORS] ?? [];
}

export function linearGraphQLResponseFailure(error: unknown): {
  error: Error;
  data: Record<string, unknown>;
  errors: readonly LinearGraphQLPathError[];
} | undefined {
  if (!(error instanceof Error)) return undefined;
  const structured = error as Error & {
    [LINEAR_GRAPHQL_RESPONSE_FAILURE]?: readonly LinearGraphQLPathError[];
    [LINEAR_GRAPHQL_RESPONSE_DATA]?: Record<string, unknown>;
  };
  if (!structured[LINEAR_GRAPHQL_RESPONSE_FAILURE]) return undefined;
  return {
    error,
    data: structured[LINEAR_GRAPHQL_RESPONSE_DATA] ?? {},
    errors: structured[LINEAR_GRAPHQL_RESPONSE_FAILURE],
  };
}

function errorPath(error: GraphQLErrorBody): ReadonlyArray<string | number> | undefined {
  const path = error.path;
  if (!Array.isArray(path) || path.length === 0) return undefined;
  if (!path.every((entry) => typeof entry === 'string' || typeof entry === 'number')) return undefined;
  return path;
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

function hasUsableRoot(data: object, errors: readonly LinearGraphQLPathError[]): boolean {
  const failed = new Set(errors.map((error) => error.path[0]));
  return Object.entries(data).some(([key, value]) => value != null || !failed.has(key));
}

function errorText(error: GraphQLErrorBody): string {
  const extensions = error.extensions ?? {};
  const presentable = asString(extensions.userPresentableMessage);
  if (presentable) return presentable;

  for (const source of [extensions, extensions.exception]) {
    if (!source || typeof source !== 'object') continue;
    for (const key of ['fieldErrors', 'validationErrors']) {
      const entries = (source as Record<string, unknown>)[key];
      if (!Array.isArray(entries)) continue;
      const messages = entries.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return asString(entry) ?? [];
        const record = entry as Record<string, unknown>;
        const constraints = record.constraints;
        return constraints && typeof constraints === 'object'
          ? Object.values(constraints).flatMap((value) => asString(value) ?? [])
          : asString(record.message) ?? [];
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

function attachTelemetry(target: object, snapshots: readonly LinearRateLimitSnapshot[], key: symbol | string): void {
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

export type LinearGraphQLFn = <TData>(
  apiKey: string,
  query: string,
  variables?: Record<string, unknown>,
  signal?: AbortSignal,
  options?: LinearGraphQLOptions,
) => Promise<TData>;

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

export async function linearGraphQLWithContext<TData>(
  context: LinearNetworkContext,
  query: string,
  variables: Record<string, unknown> = {},
  options?: LinearGraphQLOptions,
): Promise<TData> {
  const { apiKey } = context.credential;
  const snapshots: LinearRateLimitSnapshot[] = [];
  const isSearchRead = searchRead(query);
  let response!: Response;
  let body: { data?: TData; errors?: GraphQLErrorBody[] } = {};

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

    const snapshot: LinearRateLimitSnapshot = {
      ...(options?.phase ? { phase: options.phase } : {}),
      attempt: attempt + 1,
      headers: redactDeep(parseLinearRateLimitHeaders(response.headers ?? new Headers()), [apiKey]),
    };
    snapshots.push(snapshot);
    context.telemetry.push(snapshot);
    body = {};
    try {
      body = (await response.json()) as typeof body;
    } catch {
      // Use the HTTP status below for non-JSON responses.
    }

    const retryHttp = response.status === 429;
    const retryGraphQL = response.status === 400 && isSearchRead && rateLimited(body.errors ?? []);
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

  const detail = redactText([...new Set((body.errors ?? []).map(errorText))].join('; '), [apiKey]);
  if (!response.ok) {
    const status = redactText(`${response.status} ${response.statusText}`, [apiKey]);
    const failure = new Error(`Linear API request failed: ${detail || status}`);
    attachTelemetry(failure, snapshots, 'linearTelemetry');
    throw failure;
  }
  if (body.errors?.length) {
    const data = body.data;
    const normalized = responseGraphQLErrors(body.errors, apiKey);
    if (options?.throwResponseErrors) {
      const failure = new Error(`Linear GraphQL error: ${detail}`);
      Object.defineProperty(failure, LINEAR_GRAPHQL_RESPONSE_FAILURE, { value: normalized });
      if (data && typeof data === 'object') {
        Object.defineProperty(failure, LINEAR_GRAPHQL_RESPONSE_DATA, { value: data });
      }
      attachTelemetry(failure, snapshots, 'linearTelemetry');
      throw failure;
    }
    if (data && typeof data === 'object') {
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
  if (typeof body.data === 'object' && body.data !== null) {
    attachTelemetry(body.data, snapshots, LINEAR_RATE_LIMIT_TELEMETRY);
  }
  return body.data;
}

export async function linearGraphQL<TData>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown> = {},
  signal?: AbortSignal,
  options?: LinearGraphQLOptions,
): Promise<TData> {
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

export function isLinearUrlSlug(value: string): boolean {
  return LINEAR_URL_SLUG_PATTERN.test(value) && !UUID_PATTERN.test(value);
}

export function requireIssueReference(value: string): string {
  const reference = requireReference(value, 'issue');
  if (ISSUE_IDENTIFIER_PATTERN.test(reference) || UUID_PATTERN.test(reference)) return reference;
  throw new Error(`Invalid Linear issue reference "${reference}". Use TEAM-123 or a UUID.`);
}

export function parseIssueReferenceSet(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('issues must be an array of issue identifiers or UUIDs.');
  }
  if (!value.length) {
    throw new Error('issues must contain at least one issue identifier or UUID.');
  }
  const seen = new Set<string>();
  const references: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
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

export function assertIssueNodeMatches(
  requested: string,
  issue: { id?: unknown; identifier?: unknown; team?: { id?: unknown; key?: unknown } | null } | null | undefined,
): asserts issue is { id: string; identifier: string; team?: { id?: unknown; key?: unknown } | null } {
  const reference = requireIssueReference(requested);
  if (!issue || typeof issue.id !== 'string' || typeof issue.identifier !== 'string') {
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

export function assertNamedNodeMatches(
  kind: NamedEntityKind,
  requested: string,
  node: { id?: unknown; slugId?: unknown; name?: unknown; title?: unknown } | null | undefined,
): asserts node is { id: string; slugId?: string; name?: string; title?: string } {
  const reference = requested.trim();
  if (!node || typeof node.id !== 'string') {
    throw new Error(`Linear ${kind} "${reference}" was not found.`);
  }
  if (UUID_PATTERN.test(reference)) {
    if (node.id !== reference) {
      throw new Error(`Linear ${kind} resolver returned mismatched id "${node.id}" for "${reference}".`);
    }
    return;
  }
  if (typeof node.slugId !== 'string') {
    throw new Error(`Linear ${kind} resolver did not include slug identity proof for "${reference}".`);
  }
  if (node.slugId.toLowerCase() !== reference.toLowerCase()) {
    throw new Error(`Linear ${kind} resolver returned mismatched slug "${node.slugId}" for "${reference}".`);
  }
}
