import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactText } from './redact';

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
export type ResolvedDocument = { id: string; title: string };

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

function retryDelay(response: Response): number {
  const value = response.headers.get('Retry-After');
  if (!value) return 3_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  return Math.max(0, Date.parse(value) - Date.now());
}

export async function linearGraphQL<TData>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<TData> {
  let response: Response;
  for (let attempt = 0; ; attempt++) {
    try {
      response = await fetch(linearGraphQLEndpoint(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: apiKey },
        body: JSON.stringify({ query, variables }),
        signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Linear network error: ${redactText(message, [apiKey])}`);
    }
    if (response.status !== 429 || attempt === 1) break;
    await new Promise((resolve) => setTimeout(resolve, retryDelay(response)));
  }

  let body: { data?: TData; errors?: LinearGraphQLError[] } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // Use the HTTP status below for non-JSON responses.
  }

  const detail = redactText([...new Set((body.errors ?? []).map(errorText))].join('; '), [apiKey]);
  if (!response.ok) {
    const status = redactText(`${response.status} ${response.statusText}`, [apiKey]);
    throw new Error(`Linear API request failed: ${detail || status}`);
  }
  if (body.errors?.length) throw new Error(`Linear GraphQL error: ${detail}`);
  if (!body.data) throw new Error('Linear GraphQL response did not include data.');
  return body.data;
}

function requireReference(value: string, kind: string): string {
  const reference = value.trim();
  if (!reference) throw new Error(`Linear ${kind} reference is required.`);
  return reference;
}

function requireSingle<T>(nodes: T[], description: string): T {
  if (nodes.length !== 1) {
    throw new Error(`Linear ${description} resolved to ${nodes.length} matches; expected exactly one.`);
  }
  return nodes[0]!;
}

export async function resolveIssueReference(
  apiKey: string,
  value: string,
  signal?: AbortSignal,
): Promise<ResolvedIssue> {
  const reference = requireReference(value, 'issue');
  const identifier = reference.match(ISSUE_IDENTIFIER_PATTERN);
  if (identifier) {
    const teamKey = identifier[1]!;
    const number = Number(identifier[2]!);
    const data = await linearGraphQL<{ issues: { nodes: Array<{
      id: string; identifier: string; team: { id: string; key: string } | null;
    }> } }>(apiKey, `query ResolveIssueByIdentifier($teamKey: String!, $number: Float!) {
  issues(first: 2, filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }) {
    nodes { id identifier team { id key } }
  }
}`, { teamKey: teamKey.toUpperCase(), number }, signal);
    const issue = requireSingle(data.issues.nodes, `issue "${reference}"`);
    const parsedResult = issue.identifier.match(ISSUE_IDENTIFIER_PATTERN);
    if (!parsedResult || parsedResult[1]!.toLowerCase() !== teamKey.toLowerCase() || Number(parsedResult[2]!) !== number) {
      throw new Error(`Linear issue resolver returned mismatched identifier "${issue.identifier}" for "${reference}".`);
    }
    if (!issue.team || issue.team.key.toLowerCase() !== teamKey.toLowerCase()) {
      throw new Error(`Linear issue resolver returned a mismatched team for "${reference}".`);
    }
    return { id: issue.id, identifier: issue.identifier, teamId: issue.team.id, teamKey: issue.team.key };
  }

  if (!UUID_PATTERN.test(reference)) {
    throw new Error(`Invalid Linear issue reference "${reference}". Use TEAM-123 or a UUID.`);
  }
  const data = await linearGraphQL<{ issue: {
    id: string; identifier: string; team: { id: string; key: string } | null;
  } | null }>(apiKey, `query ResolveIssueById($id: String!) {
  issue(id: $id) { id identifier team { id key } }
}`, { id: reference }, signal);
  if (!data.issue) throw new Error(`Linear issue "${reference}" was not found.`);
  if (data.issue.id !== reference) {
    throw new Error(`Linear issue resolver returned mismatched id "${data.issue.id}" for "${reference}".`);
  }
  if (!data.issue.team) throw new Error(`Linear issue "${reference}" has no team.`);
  return {
    id: data.issue.id,
    identifier: data.issue.identifier,
    teamId: data.issue.team.id,
    teamKey: data.issue.team.key,
  };
}

export async function resolveTeamReference(
  apiKey: string,
  value: string,
  signal?: AbortSignal,
): Promise<ResolvedTeam> {
  const reference = requireReference(value, 'team');
  if (UUID_PATTERN.test(reference)) {
    const data = await linearGraphQL<{ team: { id: string; key: string } | null }>(apiKey, `query ResolveTeamById($id: String!) {
  team(id: $id) { id key }
}`, { id: reference }, signal);
    if (!data.team) throw new Error(`Linear team "${reference}" was not found.`);
    if (data.team.id !== reference) throw new Error(`Linear team resolver returned mismatched id for "${reference}".`);
    return data.team;
  }
  if (!/^[A-Z][A-Z0-9]*$/i.test(reference)) {
    throw new Error(`Invalid Linear team reference "${reference}". Use a team key or UUID.`);
  }
  const data = await linearGraphQL<{ teams: { nodes: ResolvedTeam[] } }>(apiKey, `query ResolveTeamByKey($key: String!) {
  teams(first: 2, filter: { key: { eq: $key } }) { nodes { id key } }
}`, { key: reference.toUpperCase() }, signal);
  const team = requireSingle(data.teams.nodes, `team "${reference}"`);
  if (team.key.toLowerCase() !== reference.toLowerCase()) {
    throw new Error(`Linear team resolver returned mismatched key "${team.key}" for "${reference}".`);
  }
  return team;
}

export async function resolveStateIdReference(
  apiKey: string,
  value: string,
  signal?: AbortSignal,
): Promise<ResolvedState> {
  const reference = requireReference(value, 'state');
  if (!UUID_PATTERN.test(reference)) {
    throw new Error(
      `Invalid Linear state reference "${reference}". Use a state UUID, or provide team with an exact state name.`,
    );
  }
  const data = await linearGraphQL<{
    workflowState: {
      id: string;
      name: string;
      team: { id: string } | null;
    } | null;
  }>(apiKey, `query ResolveStateById($id: String!) {
  workflowState(id: $id) { id name team { id } }
}`, { id: reference }, signal);
  if (!data.workflowState) throw new Error(`Linear state "${reference}" was not found.`);
  if (data.workflowState.id !== reference) {
    throw new Error(`Linear state resolver returned mismatched id for "${reference}".`);
  }
  if (!data.workflowState.team?.id) throw new Error(`Linear state "${reference}" has no team.`);
  return {
    id: data.workflowState.id,
    name: data.workflowState.name,
    teamId: data.workflowState.team.id,
  };
}

export async function resolveStateReference(
  apiKey: string,
  teamId: string,
  value: string,
  signal?: AbortSignal,
): Promise<ResolvedState> {
  const reference = requireReference(value, 'state');
  if (UUID_PATTERN.test(reference)) {
    const data = await linearGraphQL<{ workflowState: {
      id: string; name: string; team: { id: string } | null;
    } | null }>(apiKey, `query ResolveStateById($id: String!) {
  workflowState(id: $id) { id name team { id } }
}`, { id: reference }, signal);
    if (!data.workflowState) throw new Error(`Linear state "${reference}" was not found.`);
    if (data.workflowState.id !== reference) throw new Error(`Linear state resolver returned mismatched id for "${reference}".`);
    if (data.workflowState.team?.id !== teamId) throw new Error(`Linear state "${reference}" does not belong to team "${teamId}".`);
    return { id: data.workflowState.id, name: data.workflowState.name, teamId };
  }
  const data = await linearGraphQL<{ workflowStates: { nodes: Array<{
    id: string; name: string; team: { id: string } | null;
  }> } }>(apiKey, `query ResolveStateByName($teamId: ID!, $name: String!) {
  workflowStates(first: 2, filter: { team: { id: { eq: $teamId } }, name: { eqIgnoreCase: $name } }) {
    nodes { id name team { id } }
  }
}`, { teamId, name: reference }, signal);
  const matches = data.workflowStates.nodes.filter((state) =>
    state.team?.id === teamId && state.name.toLowerCase() === reference.toLowerCase(),
  );
  const state = requireSingle(matches, `state "${reference}" in team "${teamId}"`);
  return { id: state.id, name: state.name, teamId };
}

export async function resolveDocumentReference(
  apiKey: string,
  value: string,
  signal?: AbortSignal,
): Promise<ResolvedDocument> {
  const reference = requireReference(value, 'document');
  if (UUID_PATTERN.test(reference)) {
    const data = await linearGraphQL<{ document: ResolvedDocument | null }>(apiKey, `query ResolveDocumentById($id: String!) {
  document(id: $id) { id title }
}`, { id: reference }, signal);
    if (!data.document) throw new Error(`Linear document "${reference}" was not found.`);
    if (data.document.id !== reference) {
      throw new Error(`Linear document resolver returned mismatched id "${data.document.id}" for "${reference}".`);
    }
    return data.document;
  }

  const data = await linearGraphQL<{ documents: { nodes: ResolvedDocument[] } }>(apiKey, `query ResolveDocumentByTitle($title: String!) {
  documents(first: 2, filter: { title: { eq: $title } }) { nodes { id title } }
}`, { title: reference }, signal);
  const nodes = data.documents?.nodes ?? [];
  if (nodes.length !== 1) {
    throw new Error(`Linear document "${reference}" resolved to ${nodes.length} results; expected exactly one.`);
  }
  if (nodes[0]!.title !== reference) {
    throw new Error(`Linear document resolver returned mismatched title "${nodes[0]!.title}" for "${reference}".`);
  }
  return nodes[0]!;
}

export async function resolveNamedEntityReference(
	apiKey: string,
	kind:
		| "project"
		| "initiative"
		| "cycle"
		| "document"
		| "projectMilestone"
		| "customView",
	value: string,
	signal?: AbortSignal,
): Promise<ResolvedNamedEntity> {
	const reference = requireReference(value, kind);
	const singular = kind;
	const plural =
		kind === "projectMilestone"
			? "projectMilestones"
			: kind === "customView"
				? "customViews"
				: `${kind}s`;
	const nameField = kind === "document" ? "title" : "name";
	const nameSelection = kind === "document" ? "name: title" : "name";
	if (UUID_PATTERN.test(reference)) {
		const data = await linearGraphQL<
			Record<string, ResolvedNamedEntity | null>
		>(
			apiKey,
			`query ResolveNamedEntityById($id: String!) {
  ${singular}(id: $id) { id ${nameSelection} }
}`,
			{ id: reference },
			signal,
		);
		const entity = data[singular];
		if (!entity)
			throw new Error(`Linear ${kind} "${reference}" was not found.`);
		if (entity.id !== reference)
			throw new Error(
				`Linear ${kind} resolver returned mismatched id for "${reference}".`,
			);
		return entity;
	}
	const data = await linearGraphQL<
		Record<string, { nodes: ResolvedNamedEntity[] }>
	>(
		apiKey,
		`query ResolveNamedEntityByName($name: String!) {
  ${plural}(first: 2, filter: { ${nameField}: { eq: $name } }) { nodes { id ${nameSelection} } }
}`,
		{ name: reference },
		signal,
	);
	const matches = (data[plural]?.nodes ?? []).filter(
		(entity) => entity.name === reference,
	);
	return requireSingle(matches, `${kind} "${reference}"`);
}

export async function resolveUserReference(
  apiKey: string,
  value: string,
  signal?: AbortSignal,
): Promise<ResolvedUser> {
  const reference = requireReference(value, 'user');
  const selection = 'id name displayName email';
  if (reference.toLowerCase() === 'me') {
    const data = await linearGraphQL<{ viewer: ResolvedUser | null }>(apiKey, `query ResolveViewer { viewer { ${selection} } }`, {}, signal);
    if (!data.viewer?.id) throw new Error('Linear viewer could not be resolved.');
    return data.viewer;
  }
  if (UUID_PATTERN.test(reference)) {
    const data = await linearGraphQL<{ user: ResolvedUser | null }>(apiKey, `query ResolveUserById($id: String!) {
  user(id: $id) { ${selection} }
}`, { id: reference }, signal);
    if (!data.user) throw new Error(`Linear user "${reference}" was not found.`);
    if (data.user.id !== reference) throw new Error(`Linear user resolver returned mismatched id for "${reference}".`);
    return data.user;
  }
  const data = await linearGraphQL<{
    byEmail: { nodes: ResolvedUser[] };
    byName: { nodes: ResolvedUser[] };
    byDisplayName: { nodes: ResolvedUser[] };
  }>(apiKey, `query ResolveUserByIdentity($reference: String!) {
  byEmail: users(first: 2, filter: { email: { eq: $reference } }) { nodes { ${selection} } }
  byName: users(first: 2, filter: { name: { eq: $reference } }) { nodes { ${selection} } }
  byDisplayName: users(first: 2, filter: { displayName: { eq: $reference } }) { nodes { ${selection} } }
}`, { reference }, signal);
  const exact = [...data.byEmail.nodes, ...data.byName.nodes, ...data.byDisplayName.nodes].filter((user) =>
    user.email === reference || user.name === reference || user.displayName === reference,
  );
  const users = [...new Map(exact.map((user) => [user.id, user])).values()];
  return requireSingle(users, `user "${reference}"`);
}
