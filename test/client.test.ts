import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import {
  resolveApiKey,
  readCredentials,
  writeCredentials,
  getCredentialFilePath,
  addWorkspace,
  removeWorkspace,
  switchWorkspace,
  setAuthPreference,
  linearGraphQL,
  linearGraphQLErrors,
  resolveIssueReference,
  resolveTeamReference,
  resolveStateReference,
  resolveUserReference,
  resolveNamedEntityReference,
  resolveDocumentReference,
  type WorkspaceCredentials,
} from '../extensions/client';

function fakeCtx(hasUI = false) {
  return {
    hasUI,
    ui: { confirm: vi.fn(), input: vi.fn(), notify: vi.fn() },
  } as any;
}

const ENV_KEY = 'LINEAR_API_KEY';
const WORKSPACE_KEY = 'lin_api_workspace_key';
const ENV_VAR_KEY = 'lin_api_env_var_key';

function credsWith(overrides: Partial<WorkspaceCredentials> = {}): WorkspaceCredentials {
  return {
    activeWorkspace: 'my-workspace',
    authPreference: 'workspace',
    workspaces: { 'my-workspace': { apiKey: WORKSPACE_KEY } },
    ...overrides,
  };
}

function useTmpDir() {
  const tmpDir = `/tmp/pi-linear-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let originalDir: string | undefined;

  beforeEach(async () => {
    originalDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = tmpDir;
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    if (originalDir !== undefined) process.env.PI_CODING_AGENT_DIR = originalDir;
    else delete process.env.PI_CODING_AGENT_DIR;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
}

describe('readCredentials / writeCredentials', () => {
  useTmpDir();

  it('returns empty credentials when no file exists', async () => {
    const creds = await readCredentials();
    expect(creds).toEqual({ activeWorkspace: null, authPreference: 'workspace', workspaces: {} });
  });

  it('round-trips credentials through write then read', async () => {
    const input = credsWith();
    await writeCredentials(input);
    const output = await readCredentials();
    expect(output).toEqual(input);
  });

  it('persists auth preference', async () => {
    await setAuthPreference('env');
    const creds = await readCredentials();
    expect(creds.authPreference).toBe('env');
  });

  it('sets file permissions to 0o600', async () => {
    await writeCredentials(credsWith());
    const stat = await fs.stat(getCredentialFilePath());
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

describe('workspace management', () => {
  useTmpDir();

  it('addWorkspace sets first workspace as active', async () => {
    const creds = await addWorkspace('first', 'key-1');
    expect(creds.activeWorkspace).toBe('first');
    expect(creds.workspaces['first']).toEqual({ apiKey: 'key-1' });
  });

  it('addWorkspace does not change active when one already exists', async () => {
    await addWorkspace('first', 'key-1');
    const creds = await addWorkspace('second', 'key-2');
    expect(creds.activeWorkspace).toBe('first');
    expect(Object.keys(creds.workspaces)).toEqual(['first', 'second']);
  });

  it('removeWorkspace falls back to next available workspace', async () => {
    await addWorkspace('a', 'key-a');
    await addWorkspace('b', 'key-b');
    const creds = await removeWorkspace('a');
    expect(creds.activeWorkspace).toBe('b');
    expect(creds.workspaces['a']).toBeUndefined();
  });

  it('removeWorkspace sets null when last workspace removed', async () => {
    await addWorkspace('only', 'key-only');
    const creds = await removeWorkspace('only');
    expect(creds.activeWorkspace).toBeNull();
    expect(Object.keys(creds.workspaces)).toHaveLength(0);
  });

  it('switchWorkspace changes the active workspace', async () => {
    await addWorkspace('a', 'key-a');
    await addWorkspace('b', 'key-b');
    const creds = await switchWorkspace('b');
    expect(creds.activeWorkspace).toBe('b');
  });

  it('switchWorkspace sets auth preference back to workspace', async () => {
    await addWorkspace('a', 'key-a');
    await setAuthPreference('env');
    const creds = await switchWorkspace('a');
    expect(creds.authPreference).toBe('workspace');
  });

  it('switchWorkspace throws for unknown workspace', async () => {
    await addWorkspace('a', 'key-a');
    await expect(switchWorkspace('nope')).rejects.toThrow('does not exist');
  });
});

describe('linearGraphQL error surfacing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(response: {
    ok: boolean;
    status: number;
    statusText: string;
    body?: unknown;
  }) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(),
        json: async () => {
          if (response.body === undefined) throw new Error('not json');
          return response.body;
        },
      })),
    );
  }

  it('prefers extensions.userPresentableMessage over the bare message', async () => {
    stubFetch({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: {
        errors: [
          {
            message: 'Argument Validation Error',
            extensions: { userPresentableMessage: 'icon must be a valid icon name' },
          },
        ],
      },
    });

    await expect(linearGraphQL('key', 'query { viewer { id } }', {})).rejects.toThrow(
      'Linear GraphQL error: icon must be a valid icon name',
    );
  });

  it('surfaces validation constraint messages when no presentable message exists', async () => {
    stubFetch({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: {
        errors: [
          {
            message: 'Argument Validation Error',
            extensions: {
              validationErrors: [{ constraints: { isIn: 'state must be a valid project state' } }],
            },
          },
        ],
      },
    });

    await expect(linearGraphQL('key', 'query { viewer { id } }', {})).rejects.toThrow(
      'Linear GraphQL error: state must be a valid project state',
    );
  });

  it('falls back to the HTTP status for non-JSON error responses', async () => {
    stubFetch({ ok: false, status: 502, statusText: 'Bad Gateway' });

    await expect(linearGraphQL('key', 'query { viewer { id } }', {})).rejects.toThrow(
      'Linear API request failed: 502 Bad Gateway',
    );
  });

  it('wraps fetch failures in a stable network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket closed'); }));
    await expect(linearGraphQL('key', 'query { viewer { id } }')).rejects.toThrow(
      'Linear network error: socket closed',
    );
  });

  it('retries one 429 and honors Retry-After', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers: new Headers({ 'Retry-After': '0' }),
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        json: async () => ({ data: { viewer: { id: 'user-1' } } }),
      });
    vi.stubGlobal('fetch', fetch);

    await expect(linearGraphQL('key', 'query { viewer { id } }')).resolves.toEqual({ viewer: { id: 'user-1' } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps a successful root alias when a sibling path fails', async () => {
    stubFetch({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: {
        data: {
          ready: { id: 'issue-1', title: 'Ready' },
          missing: null,
        },
        errors: [{ message: 'Entity not found: Issue', path: ['missing'] }],
      },
    });

    const data = await linearGraphQL('key', 'query { ready: issue { id title } missing: issue { id } }');
    expect(data).toEqual({
      ready: { id: 'issue-1', title: 'Ready' },
      missing: null,
    });
    expect(linearGraphQLErrors(data)).toEqual([{ path: ['missing'], message: 'Entity not found: Issue' }]);
  });

  it('maps multiple path errors without dropping a successful sibling', async () => {
    stubFetch({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: {
        data: {
          ready: { id: 'issue-1' },
          missing: null,
          forbidden: null,
        },
        errors: [
          { message: 'Entity not found: Issue', path: ['missing'] },
          { message: 'You cannot view that issue', path: ['forbidden'] },
        ],
      },
    });

    const data = await linearGraphQL('key', 'query { ready: issue { id } missing: issue { id } forbidden: issue { id } }');
    expect(data).toEqual({
      ready: { id: 'issue-1' },
      missing: null,
      forbidden: null,
    });
    expect(linearGraphQLErrors(data)).toEqual([
      { path: ['missing'], message: 'Entity not found: Issue' },
      { path: ['forbidden'], message: 'You cannot view that issue' },
    ]);
  });

  it('keeps a sibling alias when nested non-null failure nulls its root', async () => {
    stubFetch({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: {
        data: {
          ready: { id: 'issue-1', title: 'Ready' },
          broken: null,
        },
        errors: [{
          message: 'Cannot return null for non-nullable field Issue.assignee',
          path: ['broken', 'assignee', 'name'],
        }],
      },
    });

    const data = await linearGraphQL('key', 'query { ready: issue { id title } broken: issue { assignee { name } } }');
    expect(data).toEqual({
      ready: { id: 'issue-1', title: 'Ready' },
      broken: null,
    });
    expect(linearGraphQLErrors(data)).toEqual([{
      path: ['broken', 'assignee', 'name'],
      message: 'Cannot return null for non-nullable field Issue.assignee',
    }]);
  });

  it('still fails fast when nested non-null failure leaves no usable root', async () => {
    stubFetch({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: {
        data: { issue: null },
        errors: [{
          message: 'Cannot return null for non-nullable field Issue.assignee',
          path: ['issue', 'assignee', 'name'],
        }],
      },
    });

    await expect(linearGraphQL('key', 'query { issue { assignee { name } } }')).rejects.toThrow(
      'Linear GraphQL error: Cannot return null for non-nullable field Issue.assignee',
    );
  });

  it('still fails fast for errors that have no path', async () => {
    stubFetch({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: {
        data: {
          ready: { id: 'issue-1' },
          missing: null,
        },
        errors: [{ message: 'Variable "$id" of required type "String!" was not provided.' }],
      },
    });

    await expect(linearGraphQL('key', 'query { ready: issue { id } missing: issue { id } }')).rejects.toThrow(
      'Linear GraphQL error: Variable "$id" of required type "String!" was not provided.',
    );
  });

  it('redacts secrets in retained path error text', async () => {
    const apiKey = 'lin_api_secretkey12';
    stubFetch({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: {
        data: {
          ready: { id: 'issue-1' },
          missing: null,
        },
        errors: [{ message: `rejected ${apiKey}`, path: ['missing'] }],
      },
    });

    const data = await linearGraphQL(apiKey, 'query { ready: issue { id } missing: issue { id } }');
    expect(linearGraphQLErrors(data)).toEqual([{ path: ['missing'], message: 'rejected [REDACTED]' }]);
    expect(JSON.stringify(linearGraphQLErrors(data))).not.toContain(apiKey);
  });

  it('redacts secrets in thrown GraphQL error text', async () => {
    const apiKey = 'lin_api_secretkey12';
    stubFetch({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: {
        errors: [{ message: `rejected ${apiKey}` }],
      },
    });

    await expect(linearGraphQL(apiKey, 'query { viewer { id } }')).rejects.toThrow(
      'Linear GraphQL error: rejected [REDACTED]',
    );
  });
});

describe('strict reference resolvers', () => {
  const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
  const OTHER_ID = '22222222-2222-4222-8222-222222222222';
  const TEAM_ID = '33333333-3333-4333-8333-333333333333';
  const STATE_ID = '44444444-4444-4444-8444-444444444444';
  const USER_ID = '55555555-5555-4555-8555-555555555555';
  const DOCUMENT_ID = '66666666-6666-4666-8666-666666666666';

  afterEach(() => vi.unstubAllGlobals());

  function graphqlStub(handler: (query: string, variables: Record<string, unknown>) => unknown) {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
      return {
        ok: true, status: 200, statusText: 'OK', headers: new Headers(),
        json: async () => ({ data: handler(request.query, request.variables) }),
      };
    });
    vi.stubGlobal('fetch', fetch);
    return fetch;
  }

  const issue = (id = ISSUE_ID, identifier = 'AEO-258') => ({
    id, identifier, team: { id: TEAM_ID, key: 'AEO' },
  });

  it.each(['AEO-258', 'aeo-258'])('resolves exact identifier %s without search', async (reference) => {
    const fetch = graphqlStub((query, variables) => {
      expect(query).toContain('issues(first: 2');
      expect(query).not.toContain('searchIssues');
      expect(variables).toEqual({ teamKey: 'AEO', number: 258 });
      return { issues: { nodes: [issue()] } };
    });
    await expect(resolveIssueReference('key', reference)).resolves.toEqual({
      id: ISSUE_ID, identifier: 'AEO-258', teamId: TEAM_ID, teamKey: 'AEO',
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('resolves an exact issue UUID', async () => {
    graphqlStub((query, variables) => {
      expect(query).toContain('issue(id: $id)');
      expect(query).not.toContain('searchIssues');
      expect(variables).toEqual({ id: ISSUE_ID });
      return { issue: issue() };
    });
    await expect(resolveIssueReference('key', ISSUE_ID)).resolves.toMatchObject({ id: ISSUE_ID, identifier: 'AEO-258' });
  });

  it('rejects missing, ambiguous, identifier-mismatched, and UUID-mismatched issues', async () => {
    graphqlStub((_query, variables) => {
      if ('teamKey' in variables) {
        if (variables.number === 1) return { issues: { nodes: [] } };
        if (variables.number === 2) return { issues: { nodes: [issue(), issue(OTHER_ID)] } };
        return { issues: { nodes: [issue(ISSUE_ID, 'AEO-999')] } };
      }
      return { issue: issue(OTHER_ID) };
    });
    await expect(resolveIssueReference('key', 'AEO-1')).rejects.toThrow('0 matches');
    await expect(resolveIssueReference('key', 'AEO-2')).rejects.toThrow('2 matches');
    await expect(resolveIssueReference('key', 'AEO-3')).rejects.toThrow('mismatched identifier');
    await expect(resolveIssueReference('key', ISSUE_ID)).rejects.toThrow('mismatched id');
  });

  it('rejects invalid issue input before network access', async () => {
    const fetch = graphqlStub(() => ({}));
    await expect(resolveIssueReference('key', 'some title')).rejects.toThrow('Use TEAM-123 or a UUID');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('resolves team keys and UUIDs exactly', async () => {
    graphqlStub((query) => query.includes('ResolveTeamByKey')
      ? { teams: { nodes: [{ id: TEAM_ID, key: 'AEO' }] } }
      : { team: { id: TEAM_ID, key: 'AEO' } });
    await expect(resolveTeamReference('key', 'aeo')).resolves.toEqual({ id: TEAM_ID, key: 'AEO' });
    await expect(resolveTeamReference('key', TEAM_ID)).resolves.toEqual({ id: TEAM_ID, key: 'AEO' });
  });

  it('rejects mismatched team keys and UUIDs', async () => {
    graphqlStub((query) => query.includes('ResolveTeamByKey')
      ? { teams: { nodes: [{ id: TEAM_ID, key: 'OTHER' }] } }
      : { team: { id: OTHER_ID, key: 'AEO' } });
    await expect(resolveTeamReference('key', 'AEO')).rejects.toThrow('mismatched key');
    await expect(resolveTeamReference('key', TEAM_ID)).rejects.toThrow('mismatched id');
  });

  it('resolves exact state names and UUIDs within the issue team', async () => {
    graphqlStub((query) => query.includes('ResolveStateByName')
      ? { workflowStates: { nodes: [{ id: STATE_ID, name: 'Backlog', team: { id: TEAM_ID } }] } }
      : { workflowState: { id: STATE_ID, name: 'Backlog', team: { id: TEAM_ID } } });
    await expect(resolveStateReference('key', TEAM_ID, 'backlog')).resolves.toEqual({ id: STATE_ID, name: 'Backlog', teamId: TEAM_ID });
    await expect(resolveStateReference('key', TEAM_ID, STATE_ID)).resolves.toEqual({ id: STATE_ID, name: 'Backlog', teamId: TEAM_ID });
  });

  it('rejects wrong-team and ambiguous duplicate state names', async () => {
    graphqlStub((query) => query.includes('ResolveStateByName')
      ? { workflowStates: { nodes: [
          { id: STATE_ID, name: 'Backlog', team: { id: TEAM_ID } },
          { id: OTHER_ID, name: 'BACKLOG', team: { id: TEAM_ID } },
        ] } }
      : { workflowState: { id: STATE_ID, name: 'Backlog', team: { id: OTHER_ID } } });
    await expect(resolveStateReference('key', TEAM_ID, 'Backlog')).rejects.toThrow('2 matches');
    await expect(resolveStateReference('key', TEAM_ID, STATE_ID)).rejects.toThrow('does not belong');
  });

  it('resolves me through viewer and exact supported user identities', async () => {
    graphqlStub((query) => query.includes('ResolveViewer')
      ? { viewer: { id: USER_ID, name: 'Ada', displayName: 'Ada L', email: 'ada@example.com' } }
      : {
          byEmail: { nodes: [{ id: USER_ID, name: 'Ada', displayName: 'Ada L', email: 'ada@example.com' }] },
          byName: { nodes: [] }, byDisplayName: { nodes: [] },
        });
    await expect(resolveUserReference('key', 'me')).resolves.toMatchObject({ id: USER_ID });
    await expect(resolveUserReference('key', 'ada@example.com')).resolves.toMatchObject({ id: USER_ID, name: 'Ada' });
  });

  it('rejects ambiguous exact user identities', async () => {
    graphqlStub(() => ({
      byEmail: { nodes: [] },
      byName: { nodes: [{ id: USER_ID, name: 'Ada' }, { id: OTHER_ID, name: 'Ada' }] },
      byDisplayName: { nodes: [] },
    }));
    await expect(resolveUserReference('key', 'Ada')).rejects.toThrow('2 matches');
  });


  it('resolves supported entity names exactly and uses title for documents', async () => {
    graphqlStub((query) => {
      expect(query).toContain('documents(first: 2, filter: { title: { eq: $name } })');
      expect(query).toContain('name: title');
      return { documents: { nodes: [{ id: OTHER_ID, name: 'Planning notes' }] } };
    });
    await expect(resolveNamedEntityReference('key', 'document', 'Planning notes')).resolves.toEqual({
      id: OTHER_ID,
      name: 'Planning notes',
    });
  });

  it('resolves document titles and UUIDs through exact read queries', async () => {
    graphqlStub((query, variables) => query.includes('ResolveDocumentByTitle')
      ? { documents: { nodes: [{ id: OTHER_ID, title: 'Planning notes' }] } }
      : { document: { id: DOCUMENT_ID, title: 'Planning notes' } });

    await expect(resolveDocumentReference('key', 'Planning notes')).resolves.toEqual({
      id: OTHER_ID,
      title: 'Planning notes',
    });
    await expect(resolveDocumentReference('key', DOCUMENT_ID)).resolves.toEqual({
      id: DOCUMENT_ID,
      title: 'Planning notes',
    });
  });

  it('fails closed for missing, ambiguous, and mismatched document references', async () => {
    graphqlStub((query, variables) => {
      if (query.includes('ResolveDocumentById')) return { document: { id: OTHER_ID, title: 'Wrong' } };
      if (variables.title === 'Missing') return { documents: { nodes: [] } };
      if (variables.title === 'Duplicate') return { documents: { nodes: [
        { id: DOCUMENT_ID, title: 'Duplicate' },
        { id: OTHER_ID, title: 'Duplicate' },
      ] } };
      return { documents: { nodes: [{ id: DOCUMENT_ID, title: 'Fuzzy result' }] } };
    });

    await expect(resolveDocumentReference('key', 'Missing')).rejects.toThrow(
      'Linear document "Missing" resolved to 0 results; expected exactly one.',
    );
    await expect(resolveDocumentReference('key', 'Duplicate')).rejects.toThrow(
      'Linear document "Duplicate" resolved to 2 results; expected exactly one.',
    );
    await expect(resolveDocumentReference('key', 'Exact title')).rejects.toThrow(
      'Linear document resolver returned mismatched title "Fuzzy result" for "Exact title".',
    );
    await expect(resolveDocumentReference('key', DOCUMENT_ID)).rejects.toThrow(
      `Linear document resolver returned mismatched id "${OTHER_ID}" for "${DOCUMENT_ID}".`,
    );
  });

  it('rejects ambiguous supported entity names', async () => {
    graphqlStub(() => ({
      projects: { nodes: [{ id: USER_ID, name: 'Platform' }, { id: OTHER_ID, name: 'Platform' }] },
    }));
    await expect(resolveNamedEntityReference('key', 'project', 'Platform')).rejects.toThrow('2 matches');
  });
});

describe('resolveApiKey precedence', () => {
  useTmpDir();
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (originalEnv !== undefined) process.env[ENV_KEY] = originalEnv;
    else delete process.env[ENV_KEY];
  });

  it('prefers credentials.json over env var by default', async () => {
    await writeCredentials(credsWith());
    process.env[ENV_KEY] = ENV_VAR_KEY;

    const result = await resolveApiKey(fakeCtx(), { promptIfMissing: false });
    expect(result).toEqual({ apiKey: WORKSPACE_KEY, source: 'workspace' });
  });

  it('uses a requested workspace without changing the active workspace', async () => {
    await writeCredentials(
      credsWith({ workspaces: { 'my-workspace': { apiKey: WORKSPACE_KEY }, other: { apiKey: 'other-key' } } }),
    );

    const result = await resolveApiKey(fakeCtx(), { promptIfMissing: false, workspace: 'other' });
    expect(result).toEqual({ apiKey: 'other-key', source: 'workspace' });
    expect((await readCredentials()).activeWorkspace).toBe('my-workspace');
  });

  it.each(['default', 'active'])('uses normal workspace-first precedence for the %s alias', async (workspace) => {
    await writeCredentials(credsWith());
    process.env[ENV_KEY] = ENV_VAR_KEY;

    await expect(resolveApiKey(fakeCtx(), { promptIfMissing: false, workspace })).resolves.toEqual({
      apiKey: WORKSPACE_KEY,
      source: 'workspace',
    });
  });

  it.each(['default', 'active'])('uses normal env-first precedence for the %s alias', async (workspace) => {
    await writeCredentials(credsWith({ authPreference: 'env' }));
    process.env[ENV_KEY] = ENV_VAR_KEY;

    await expect(resolveApiKey(fakeCtx(), { promptIfMissing: false, workspace })).resolves.toEqual({
      apiKey: ENV_VAR_KEY,
      source: 'env',
    });
  });

  it('rejects an unknown requested workspace', async () => {
    await writeCredentials(credsWith());
    await expect(
      resolveApiKey(fakeCtx(), { promptIfMissing: false, workspace: 'missing' }),
    ).rejects.toThrow('does not exist');
  });

  it('uses env var first when auth preference is env', async () => {
    await writeCredentials(credsWith({ authPreference: 'env' }));
    process.env[ENV_KEY] = ENV_VAR_KEY;

    const result = await resolveApiKey(fakeCtx(), { promptIfMissing: false });
    expect(result).toEqual({ apiKey: ENV_VAR_KEY, source: 'env' });
  });

  it('falls back to credentials.json when env is preferred but not set', async () => {
    await writeCredentials(credsWith({ authPreference: 'env' }));

    const result = await resolveApiKey(fakeCtx(), { promptIfMissing: false });
    expect(result).toEqual({ apiKey: WORKSPACE_KEY, source: 'workspace' });
  });

  it('falls back to credentials.json when preferred env var is empty string', async () => {
    await writeCredentials(credsWith({ authPreference: 'env' }));
    process.env[ENV_KEY] = '';

    const result = await resolveApiKey(fakeCtx(), { promptIfMissing: false });
    expect(result).toEqual({ apiKey: WORKSPACE_KEY, source: 'workspace' });
  });

  it('falls back to credentials.json when preferred env var is whitespace', async () => {
    await writeCredentials(credsWith({ authPreference: 'env' }));
    process.env[ENV_KEY] = '   ';

    const result = await resolveApiKey(fakeCtx(), { promptIfMissing: false });
    expect(result).toEqual({ apiKey: WORKSPACE_KEY, source: 'workspace' });
  });

  it('uses env var even when no credentials file exists', async () => {
    process.env[ENV_KEY] = ENV_VAR_KEY;

    const result = await resolveApiKey(fakeCtx(), { promptIfMissing: false });
    expect(result).toEqual({ apiKey: ENV_VAR_KEY, source: 'env' });
  });

  it('returns none when neither env var nor credentials exist', async () => {
    const result = await resolveApiKey(fakeCtx(false), { promptIfMissing: false });
    expect(result).toEqual({ source: 'none' });
  });
});
