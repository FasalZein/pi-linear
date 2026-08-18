import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linearApiTool } from '../extensions/api';
import { typedLinearTools } from '../extensions/typed-tools';
import { REDACTED, redactDeep, redactError, redactText } from '../extensions/redact';

const TOKEN = 'lin_api_secret123456789abcdef';
const OAUTH = 'lin_oauth_secret987654321zyxwv';

const tools = new Map(typedLinearTools().map((tool) => [tool.name, tool]));
const originalEnvironment = { ...process.env };
let artifactRoot: string;

beforeEach(async () => {
  artifactRoot = await mkdtemp(join(tmpdir(), 'pi-linear-redaction-'));
  process.env.PI_ARTIFACT_PROJECT_ROOT = artifactRoot;
  // Point the credential store at an empty directory: no test may read, use, or
  // observe a real stored API key.
  process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), 'pi-linear-creds-'));
  process.env.LINEAR_API_KEY = 'test-key';
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...originalEnvironment };
});

function execute(tool: any, params: Record<string, unknown>) {
  return tool.execute('call-1', params, undefined, undefined, { hasUI: false });
}

/** Mock transport returning whatever `respond` produces for the issue query. */
function installServer(respond: (request: { query: string; variables: any }) => unknown) {
  const requests: Array<{ query: string; variables: any }> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    requests.push(request);
    const outcome = respond(request);
    if (outcome instanceof Error) throw outcome;
    return { ok: true, status: 200, statusText: 'OK', headers: new Headers(), json: async () => outcome };
  }));
  return requests;
}

function issueResponse(request: { query: string }, title: string) {
  if (request.query.includes('ResolveIssueByIdentifier')) {
    return { data: { issues: { nodes: [{ id: '11111111-1111-4111-8111-111111111111', identifier: 'AEO-258', team: { id: 'team-1', key: 'AEO' } }] } } };
  }
  return { data: { issue: { id: 'issue-1', identifier: 'AEO-258', title, description: `see ${TOKEN}` } } };
}

async function spilledFile(): Promise<string> {
  const directory = join(artifactRoot, 'linear/raw');
  const [file] = await readdir(directory);
  return readFile(join(directory, file!), 'utf8');
}

describe('redaction unit contract', () => {
  it('redacts Linear API keys, OAuth tokens, and Authorization values', () => {
    expect(redactText(`key ${TOKEN}`)).toBe(`key ${REDACTED}`);
    expect(redactText(`key ${OAUTH}`)).toBe(`key ${REDACTED}`);
    expect(redactText('Authorization: abcdef0123456789')).toContain(REDACTED);
    expect(redactText('Bearer abcdef0123456789')).toBe(REDACTED);
    expect(redactText('nothing secret here')).toBe('nothing secret here');
  });

  it('redacts every string in a nested structure', () => {
    const redacted = redactDeep({
      a: TOKEN,
      b: [{ c: `x ${TOKEN}` }],
      d: { e: { f: TOKEN } },
      keep: 42,
      flag: true,
    });
    expect(JSON.stringify(redacted)).not.toContain('secret123456789');
    expect(redacted.keep).toBe(42);
    expect(redacted.flag).toBe(true);
    expect(redacted.d.e.f).toBe(REDACTED);
  });

  it('redacts known-token and exact-secret object keys without losing collisions', () => {
    const exact = 'workspace-secret-with-an-unknown-format';
    const source = {
      [TOKEN]: 'first',
      [OAUTH]: 'second',
      [exact]: 'third',
      nested: { [TOKEN]: { [OAUTH]: 'nested' } },
      list: [{ [exact]: 'array-first' }, 'unchanged', 42, true, null],
      keep: 'safe',
    };

    const redacted = redactDeep(source, [exact]);
    const redactedEntries = redacted as Record<string, unknown>;

    expect(Object.keys(redacted).slice(0, 3)).toEqual([REDACTED, `${REDACTED}#2`, `${REDACTED}#3`]);
    expect(redactedEntries[REDACTED]).toBe('first');
    expect(redactedEntries[`${REDACTED}#2`]).toBe('second');
    expect(redactedEntries[`${REDACTED}#3`]).toBe('third');
    expect(redacted.nested).toEqual({ [REDACTED]: { [REDACTED]: 'nested' } });
    expect(redacted.list).toEqual([{ [REDACTED]: 'array-first' }, 'unchanged', 42, true, null]);
    expect(redacted.keep).toBe('safe');
    expect(Object.keys(source).slice(0, 3)).toEqual([TOKEN, OAUTH, exact]);
  });

  it('keeps Error type and stack while deep-redacting its keys and values without mutation', () => {
    class LinearFailure extends Error {}
    const source = new LinearFailure(`rejected ${TOKEN}`) as LinearFailure & Record<string, unknown>;
    source[TOKEN] = { [OAUTH]: TOKEN };
    const originalStack = source.stack;

    const redacted = redactDeep(source);

    expect(redacted).toBeInstanceOf(LinearFailure);
    expect(redacted).not.toBe(source);
    expect(redacted.message).toBe(`rejected ${REDACTED}`);
    expect(redacted.stack).not.toContain('secret123456789');
    expect(redacted[REDACTED]).toEqual({ [REDACTED]: REDACTED });
    expect(source.message).toBe(`rejected ${TOKEN}`);
    expect(source.stack).toBe(originalStack);
    expect(source[TOKEN]).toEqual({ [OAUTH]: TOKEN });
  });

  it('keeps the error type and stack while redacting the message and custom keys', () => {
    class LinearFailure extends Error {}
    const source = new LinearFailure(`rejected ${TOKEN}`) as LinearFailure & Record<string, unknown>;
    source[TOKEN] = OAUTH;

    const error = redactError(source) as LinearFailure & Record<string, unknown>;

    expect(error).toBeInstanceOf(LinearFailure);
    expect(error).not.toBe(source);
    expect(error.message).toBe(`rejected ${REDACTED}`);
    expect(error.stack).not.toContain('secret123456789');
    expect(typeof error.stack).toBe('string');
    expect(error[REDACTED]).toBe(REDACTED);
    expect(source.message).toBe(`rejected ${TOKEN}`);
    expect(source[TOKEN]).toBe(OAUTH);
  });
});

describe('redaction at the execution boundary', () => {
  it('redacts model content and details of an inline result', async () => {
    installServer((request) => {
      if (request.query.includes('ResolveIssueByIdentifier')) return issueResponse(request, `key ${TOKEN}`);
      return {
        data: {
          issue: {
            id: 'issue-1',
            identifier: 'AEO-258',
            title: `key ${TOKEN}`,
            [TOKEN]: 'first-key-value',
            [OAUTH]: 'second-key-value',
            nested: { [TOKEN]: 'nested-key-value' },
          },
        },
      };
    });
    const result = await execute(tools.get('linear_get_issue')!, { issue: 'AEO-258' });

    const text = result.content.map((entry: any) => entry.text).join('');
    expect(text).not.toContain('secret123456789');
    expect(text).not.toContain('secret987654321');
    expect(text).toContain(REDACTED);
    expect(JSON.stringify(result.details)).not.toContain('secret123456789');
    expect(JSON.stringify(result.details)).not.toContain('secret987654321');
    expect(result.details.data.issue[REDACTED]).toBe('first-key-value');
    expect(result.details.data.issue[`${REDACTED}#2`]).toBe('second-key-value');
    expect(result.details.data.issue.nested).toEqual({ [REDACTED]: 'nested-key-value' });
  });

  it('redacts resolution metadata carrying resolved values', async () => {
    installServer((request) => request.query.includes('ResolveIssueByIdentifier')
      ? { data: { issues: { nodes: [{ id: `issue-${TOKEN}`, identifier: 'AEO-258', team: { id: 'team-1', key: 'AEO' } }] } } }
      : { data: { issue: { id: 'issue-1', identifier: 'AEO-258', title: 'ok' } } });

    const result = await execute(linearApiTool() as any, {
      operation: 'get_issue',
      variables: { issue: 'AEO-258' },
    });
    const serialized = JSON.stringify(result.details.resolution);
    expect(serialized).not.toContain('secret123456789');
    expect(serialized).toContain(REDACTED);
  });

  it('redacts a forced artifact spill, its bytes and its index', async () => {
    installServer(() => ({
      data: {
        [TOKEN]: { nodes: [{ [OAUTH]: 'nested-key-value' }] },
        [OAUTH]: { nodes: [] },
        safe: { nodes: [] },
      },
    }));
    const result = await execute(linearApiTool() as any, {
      query: 'query { viewer { id } }',
      sink: 'artifact',
    });

    expect(result.details.path).toBeTruthy();
    expect(result.details.index).toEqual([
      `${REDACTED} · 1 nodes`,
      `${REDACTED}#2 · 0 nodes`,
      'safe · 0 nodes',
    ]);
    expect(JSON.stringify(result.details.index)).not.toContain('secret123456789');
    expect(JSON.stringify(result.details.index)).not.toContain('secret987654321');
    const contents = await spilledFile();
    expect(contents).not.toContain('secret123456789');
    expect(contents).not.toContain('secret987654321');
    expect(contents).toContain(`"${REDACTED}"`);
    expect(contents).toContain(`"${REDACTED}#2"`);
    expect(contents).toContain('nested-key-value');
    expect(Buffer.byteLength(contents, 'utf8')).toBe(result.details.bytes);
  });

  it('redacts an automatic spill triggered by size', async () => {
    process.env.LINEAR_SPILL_BYTES = '10';
    installServer((request) => issueResponse(request, `key ${TOKEN}`));
    const result = await execute(tools.get('linear_get_issue')!, { issue: 'AEO-258' });

    expect(result.details.path).toBeTruthy();
    const contents = await spilledFile();
    expect(contents).not.toContain('secret123456789');
    expect(contents).toContain(REDACTED);
    expect(JSON.stringify(result.details)).not.toContain('secret123456789');
  });

  it('redacts a GraphQL error before it reaches the model', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      json: async () => ({ errors: [{ message: `rejected ${TOKEN}` }] }),
    })));

    await expect(execute(tools.get('linear_get_issue')!, { issue: 'AEO-258' }))
      .rejects.toThrow(new RegExp(REDACTED.replace(/[[\]]/g, '\\$&')));
    await expect(execute(tools.get('linear_get_issue')!, { issue: 'AEO-258' }))
      .rejects.not.toThrow(/secret123456789/);
  });

  it('redacts an HTTP failure status text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 401,
      statusText: `Unauthorized ${TOKEN}`,
      headers: new Headers(),
      json: async () => ({}),
    })));

    await expect(execute(tools.get('linear_get_issue')!, { issue: 'AEO-258' }))
      .rejects.not.toThrow(/secret123456789/);
  });

  it('redacts a network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error(`connect failed for ${TOKEN}`);
    }));

    const failure = await execute(tools.get('linear_get_issue')!, { issue: 'AEO-258' }).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain('secret123456789');
    expect((failure as Error).message).toContain(REDACTED);
  });

  it('redacts a resolver failure raised during preparation', async () => {
    installServer(() => ({ data: { issues: { nodes: [] } } }));
    const failure = await execute(tools.get('linear_get_issue')!, { issue: `AEO-9 ${TOKEN}` })
      .catch((error: Error) => error);
    expect((failure as Error).message).not.toContain('secret123456789');
  });

  it('redacts a local operation result', async () => {
    const result = await execute(tools.get('linear_switch_workspace')!, { name: `work ${TOKEN}` })
      .catch((error: Error) => error);

    const serialized = result instanceof Error ? result.message : JSON.stringify(result.details);
    expect(serialized).not.toContain('secret123456789');
  });

  it('redacts the raw GraphQL escape hatch as well', async () => {
    installServer(() => ({ data: { viewer: { id: 'user-1', note: `key ${TOKEN}` } } }));
    const result = await execute(linearApiTool() as any, { query: 'query { viewer { id note } }' });

    expect(JSON.stringify(result.details)).not.toContain('secret123456789');
    expect(JSON.stringify(result.details)).toContain(REDACTED);
  });
});

// ---------------------------------------------------------------------------
// Exact-secret redaction: the active API key is removed even when its format is
// unknown to the pattern list. The tests use a synthetic key; the real key is
// never read, logged, or snapshotted.
// ---------------------------------------------------------------------------

const UNKNOWN_FORMAT_KEY = 'zzq-Workspace-Key-4417-not-a-known-prefix';

describe('exact active-secret redaction', () => {
  beforeEach(() => {
    process.env.LINEAR_API_KEY = UNKNOWN_FORMAT_KEY;
  });

  it('removes the active key from inline result content and details', async () => {
    installServer((request) => issueResponse(request, `leaked ${UNKNOWN_FORMAT_KEY}`));
    const result = await execute(tools.get('linear_get_issue')!, { issue: 'AEO-258' });

    const text = result.content.map((entry: any) => entry.text).join('');
    expect(text).not.toContain(UNKNOWN_FORMAT_KEY);
    expect(text).toContain(REDACTED);
    expect(JSON.stringify(result.details)).not.toContain(UNKNOWN_FORMAT_KEY);
  });

  it('removes the active key from nested spill keys, values, bytes, and the index', async () => {
    installServer(() => ({
      data: { [UNKNOWN_FORMAT_KEY]: { nodes: [{ [UNKNOWN_FORMAT_KEY]: UNKNOWN_FORMAT_KEY }] } },
    }));
    const result = await execute(linearApiTool() as any, {
      query: 'query { viewer { id } }',
      sink: 'artifact',
    });

    expect(result.details.index).toEqual([`${REDACTED} · 1 nodes`]);
    expect(JSON.stringify(result.details.index)).not.toContain(UNKNOWN_FORMAT_KEY);
    const contents = await spilledFile();
    expect(contents).not.toContain(UNKNOWN_FORMAT_KEY);
    expect(contents).toContain(`"${REDACTED}"`);
    expect(Buffer.byteLength(contents, 'utf8')).toBe(result.details.bytes);
  });

  it('removes the active key from an automatic spill', async () => {
    process.env.LINEAR_SPILL_BYTES = '10';
    installServer((request) => issueResponse(request, `leaked ${UNKNOWN_FORMAT_KEY}`));
    await execute(tools.get('linear_get_issue')!, { issue: 'AEO-258' });
    const contents = await spilledFile();
    expect(contents).not.toContain(UNKNOWN_FORMAT_KEY);
  });

  it('removes the active key from resolution metadata', async () => {
    installServer((request) => request.query.includes('ResolveIssueByIdentifier')
      ? { data: { issues: { nodes: [{ id: `id-${UNKNOWN_FORMAT_KEY}`, identifier: 'AEO-258', team: { id: 'team-1', key: 'AEO' } }] } } }
      : { data: { issue: { id: 'issue-1', identifier: 'AEO-258', title: 'ok' } } });

    const result = await execute(linearApiTool() as any, {
      operation: 'get_issue',
      variables: { issue: 'AEO-258' },
    });
    expect(JSON.stringify(result.details.resolution)).not.toContain(UNKNOWN_FORMAT_KEY);
  });

  it('removes the active key from GraphQL, network, and resolver errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      json: async () => ({ errors: [{ message: `auth failed for ${UNKNOWN_FORMAT_KEY}` }] }),
    })));
    const graphqlFailure = await execute(tools.get('linear_get_issue')!, { issue: 'AEO-258' }).catch((error: Error) => error);
    expect((graphqlFailure as Error).message).not.toContain(UNKNOWN_FORMAT_KEY);
    expect((graphqlFailure as Error).message).toContain(REDACTED);

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error(`socket closed while sending ${UNKNOWN_FORMAT_KEY}`);
    }));
    const networkFailure = await execute(tools.get('linear_get_issue')!, { issue: 'AEO-258' }).catch((error: Error) => error);
    expect((networkFailure as Error).message).not.toContain(UNKNOWN_FORMAT_KEY);

    installServer(() => ({ data: { issues: { nodes: [{ id: 'a' }, { id: 'b' }] } } }));
    const resolverFailure = await execute(tools.get('linear_get_issue')!, { issue: 'AEO-9' }).catch((error: Error) => error);
    expect((resolverFailure as Error).message).not.toContain(UNKNOWN_FORMAT_KEY);
  });

  it('removes the active key from the raw GraphQL surface', async () => {
    installServer(() => ({ data: { viewer: { id: 'user-1', note: `key ${UNKNOWN_FORMAT_KEY}` } } }));
    const result = await execute(linearApiTool() as any, { query: 'query { viewer { id note } }' });
    expect(JSON.stringify(result.details)).not.toContain(UNKNOWN_FORMAT_KEY);
    expect(JSON.stringify(result.details)).toContain(REDACTED);
  });

  it('still redacts a known-prefix token that is not the active key', () => {
    expect(redactText(`active ${UNKNOWN_FORMAT_KEY} other ${TOKEN}`, [UNKNOWN_FORMAT_KEY]))
      .toBe(`active ${REDACTED} other ${REDACTED}`);
    expect(redactText('short', ['tiny'])).toBe('short');
  });
});
