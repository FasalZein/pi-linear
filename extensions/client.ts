import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LINEAR_GRAPHQL_ENDPOINT = 'https://api.linear.app/graphql';

export type AuthPreference = 'workspace' | 'env';

export type WorkspaceCredentials = {
  activeWorkspace: string | null;
  authPreference: AuthPreference;
  workspaces: Record<string, { apiKey: string }>;
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

export async function readCredentials(): Promise<WorkspaceCredentials> {
  try {
    const parsed = JSON.parse(await fs.readFile(getCredentialFilePath(), 'utf8')) as Record<
      string,
      unknown
    >;
    if (!parsed.workspaces || typeof parsed.workspaces !== 'object') return emptyCredentials();

    const workspaces: WorkspaceCredentials['workspaces'] = {};
    for (const [name, entry] of Object.entries(parsed.workspaces)) {
      const apiKey = asString((entry as { apiKey?: unknown } | null)?.apiKey);
      if (apiKey) workspaces[name] = { apiKey };
    }

    return {
      activeWorkspace: typeof parsed.activeWorkspace === 'string' ? parsed.activeWorkspace : null,
      authPreference: parsed.authPreference === 'env' ? 'env' : 'workspace',
      workspaces,
    };
  } catch {
    return emptyCredentials();
  }
}

export async function writeCredentials(creds: WorkspaceCredentials): Promise<void> {
  const filePath = getCredentialFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(creds, null, 2), { mode: 0o600 });
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

export async function addWorkspace(name: string, apiKey: string): Promise<WorkspaceCredentials> {
  const creds = await readCredentials();
  creds.workspaces[name] = { apiKey };
  creds.activeWorkspace ??= name;
  await writeCredentials(creds);
  return creds;
}

export async function removeWorkspace(name: string): Promise<WorkspaceCredentials> {
  const creds = await readCredentials();
  delete creds.workspaces[name];
  if (creds.activeWorkspace === name) creds.activeWorkspace = Object.keys(creds.workspaces)[0] ?? null;
  await writeCredentials(creds);
  return creds;
}

export async function switchWorkspace(name: string): Promise<WorkspaceCredentials> {
  const creds = await readCredentials();
  if (!creds.workspaces[name]) throw new Error(`Workspace "${name}" does not exist.`);
  creds.activeWorkspace = name;
  creds.authPreference = 'workspace';
  await writeCredentials(creds);
  return creds;
}

export async function setAuthPreference(preference: AuthPreference): Promise<WorkspaceCredentials> {
  const creds = await readCredentials();
  creds.authPreference = preference;
  await writeCredentials(creds);
  return creds;
}

export function listWorkspaceNames(creds: WorkspaceCredentials): string[] {
  return Object.keys(creds.workspaces);
}

export function getActiveWorkspaceName(creds: WorkspaceCredentials): string | null {
  return creds.activeWorkspace;
}

export async function resolveApiKey(
  ctx: ExtensionContext,
  options?: { promptIfMissing?: boolean; workspace?: string },
): Promise<{ apiKey?: string; source: 'env' | 'workspace' | 'none' }> {
  const creds = await readCredentials();
  const requestedWorkspace = asString(options?.workspace);
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
        await addWorkspace(name, key);
        ctx.ui.notify(`Workspace "${name}" saved and set as active`, 'info');
        return { apiKey: key, source: 'workspace' };
      }
    }
  }

  return { source: 'none' };
}

type LinearGraphQLError = {
  message?: string;
  extensions?: Record<string, unknown>;
};

function errorText(error: LinearGraphQLError): string {
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

export async function linearGraphQL<TData>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<TData> {
  const response = await fetch(LINEAR_GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: apiKey },
    body: JSON.stringify({ query, variables }),
    signal,
  });

  let body: { data?: TData; errors?: LinearGraphQLError[] } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // Use the HTTP status below for non-JSON responses.
  }

  const detail = [...new Set((body.errors ?? []).map(errorText))].join('; ');
  if (!response.ok) {
    throw new Error(`Linear API request failed: ${detail || `${response.status} ${response.statusText}`}`);
  }
  if (body.errors?.length) throw new Error(`Linear GraphQL error: ${detail}`);
  if (!body.data) throw new Error('Linear GraphQL response did not include data.');
  return body.data;
}
