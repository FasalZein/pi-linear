import { promises as fs } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { credentialStore } from '../extensions/credential-store';
import { getCredentialFilePath } from '../extensions/client';

const originalEnvironment = { ...process.env };
let agentDirectory: string;

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonDocument = { [key: string]: JsonValue };

async function putText(source: string): Promise<string> {
  const file = getCredentialFilePath();
  await mkdir(join(agentDirectory, 'extensions', 'linear'), { recursive: true });
  await writeFile(file, source, { mode: 0o600 });
  return file;
}

function put(value: JsonDocument): Promise<string> {
  return putText(JSON.stringify(value));
}

function document(overrides: JsonDocument = {}): JsonDocument {
  return {
    activeWorkspace: 'first',
    authPreference: 'workspace',
    workspaces: {
      first: { apiKey: 'first-key' },
      second: { apiKey: 'second-key' },
    },
    ...overrides,
  };
}

beforeEach(async () => {
  agentDirectory = await mkdtemp(join(tmpdir(), 'pi-linear-store-'));
  process.env.PI_CODING_AGENT_DIR = agentDirectory;
  delete process.env.LINEAR_API_KEY;
  delete process.env.LINEAR_READONLY;
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.env = { ...originalEnvironment };
  await rm(agentDirectory, { recursive: true, force: true });
});

describe('Credential store public boundary', () => {
  it('exposes exactly resolve, change, and secrets', () => {
    expect(Object.keys(credentialStore)).toEqual(['resolve', 'change', 'secrets']);
  });

  it('resolves the active Workspace and returns a secret-free snapshot', async () => {
    await put(document({ futureSetting: true }));

    await expect(credentialStore.resolve()).resolves.toEqual({
      apiKey: 'first-key',
      source: 'workspace',
      snapshot: {
        activeWorkspace: 'first',
        authPreference: 'workspace',
        workspaces: ['first', 'second'],
      },
    });
  });

  it('requires an exact named Workspace and ignores environment fallback', async () => {
    await put(document());
    process.env.LINEAR_API_KEY = 'env-key';

    await expect(credentialStore.resolve({ workspace: 'second' })).resolves.toMatchObject({
      apiKey: 'second-key',
      source: 'workspace',
    });
    await expect(credentialStore.resolve({ workspace: 'missing' })).rejects.toThrow(
      'Workspace "missing" does not exist.',
    );
    await expect(credentialStore.resolve({ workspace: 'lin_api_missing_secret_123456789' })).rejects.toThrow(
      'Workspace "[REDACTED]" does not exist.',
    );
  });

  it.each(['default', 'active'])('uses Auth preference for the %s alias', async (workspace) => {
    await put(document({ authPreference: 'env' }));
    process.env.LINEAR_API_KEY = ' env-key ';

    await expect(credentialStore.resolve({ workspace })).resolves.toMatchObject({
      apiKey: 'env-key',
      source: 'env',
    });
  });

  it('treats whitespace-only environment values as absent', async () => {
    await put(document({ authPreference: 'env' }));
    process.env.LINEAR_API_KEY = '   ';

    await expect(credentialStore.resolve()).resolves.toMatchObject({
      apiKey: 'first-key',
      source: 'workspace',
    });
  });

  it('returns an empty snapshot without prompting, writing, or locking when the document is missing', async () => {
    await expect(credentialStore.resolve()).resolves.toEqual({
      source: 'none',
      snapshot: { activeWorkspace: null, authPreference: 'workspace', workspaces: [] },
    });
    await expect(access(getCredentialFilePath())).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(`${getCredentialFilePath()}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a malformed Credential document without changing its bytes', async () => {
    const file = await putText('{"workspaces":');
    const before = await readFile(file);

    await expect(credentialStore.resolve()).rejects.toThrow(
      'Invalid Linear credential file. Repair or remove it before changing stored credentials.',
    );

    expect(await readFile(file)).toEqual(before);
    await expect(access(`${file}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('Credential store changes', () => {
  it('adds, replaces, and activates only the first added Workspace', async () => {
    expect(await credentialStore.change({ type: 'add', name: 'first', apiKey: 'old' }, 'allowlist')).toEqual({
      activeWorkspace: 'first', authPreference: 'workspace', workspaces: ['first'],
    });
    await credentialStore.change({ type: 'add', name: 'second', apiKey: 'second' }, 'allowlist');
    const snapshot = await credentialStore.change({ type: 'add', name: 'first', apiKey: 'new' }, 'allowlist');

    expect(snapshot).toEqual({ activeWorkspace: 'first', authPreference: 'workspace', workspaces: ['first', 'second'] });
    await expect(credentialStore.resolve({ workspace: 'first' })).resolves.toMatchObject({ apiKey: 'new' });
  });

  it('removes idempotently and selects the first remaining Workspace when active is removed', async () => {
    await put(document());

    await expect(credentialStore.change({ type: 'remove', name: 'missing' }, 'allowlist')).resolves.toMatchObject({
      activeWorkspace: 'first', workspaces: ['first', 'second'],
    });
    await expect(credentialStore.change({ type: 'remove', name: 'first' }, 'allowlist')).resolves.toMatchObject({
      activeWorkspace: 'second', workspaces: ['second'],
    });
    await expect(credentialStore.change({ type: 'remove', name: 'second' }, 'allowlist')).resolves.toMatchObject({
      activeWorkspace: null, workspaces: [],
    });
  });

  it('switches only to an existing Workspace and leaves Auth preference unchanged', async () => {
    const file = await put(document({ authPreference: 'env' }));
    const before = await readFile(file);

    await expect(credentialStore.change({ type: 'switch', name: 'missing' }, 'allowlist')).rejects.toThrow('does not exist');
    expect(await readFile(file)).toEqual(before);
    await expect(credentialStore.change({ type: 'switch', name: 'second' }, 'allowlist')).resolves.toEqual({
      activeWorkspace: 'second', authPreference: 'env', workspaces: ['first', 'second'],
    });
  });

  it('changes only Auth preference and preserves unknown top-level fields', async () => {
    await put(document({ futureSetting: { enabled: true } }));

    await expect(credentialStore.change({ type: 'prefer', preference: 'env' }, 'allowlist')).resolves.toEqual({
      activeWorkspace: 'first', authPreference: 'env', workspaces: ['first', 'second'],
    });

    expect(JSON.parse(await readFile(getCredentialFilePath(), 'utf8'))).toMatchObject({
      activeWorkspace: 'first',
      authPreference: 'env',
      futureSetting: { enabled: true },
    });
  });

  it('applies the Read-only entry gate before Credential lock or file access', async () => {
    const inaccessibleRoot = join(agentDirectory, 'not-a-directory');
    await writeFile(inaccessibleRoot, 'file');
    process.env.PI_CODING_AGENT_DIR = inaccessibleRoot;

    await expect(credentialStore.change({ type: 'add', name: 'work', apiKey: 'key' }, 'readonly')).rejects.toThrow(
      'Local Linear credential writes are disabled by read-only mode.',
    );
  });

  it('lets LINEAR_READONLY=1 override allowlist mode', async () => {
    const file = await put(document());
    const before = await readFile(file);
    process.env.LINEAR_READONLY = '1';

    await expect(credentialStore.change({ type: 'prefer', preference: 'env' }, 'allowlist')).rejects.toThrow('read-only mode');
    expect(await readFile(file)).toEqual(before);
  });

  it('rejects malformed documents, preserves bytes, and leaves no temporary state', async () => {
    const file = await putText('{"activeWorkspace":"first","workspaces":');
    const before = await readFile(file);

    await expect(credentialStore.change({ type: 'remove', name: 'first' }, 'allowlist')).rejects.toThrow('Invalid Linear credential file');

    expect(await readFile(file)).toEqual(before);
    expect(await readdir(join(agentDirectory, 'extensions', 'linear'))).toEqual(['credentials.json']);
  });

  it('fails safely on an invalid Credential lock without changing the document', async () => {
    const file = await put(document());
    const before = await readFile(file);
    await writeFile(`${file}.lock`, 'invalid lock');

    await expect(credentialStore.change({ type: 'prefer', preference: 'env' }, 'allowlist')).rejects.toThrow(
      'Invalid Linear credential lock. Repair or remove it before changing stored credentials.',
    );

    expect(await readFile(file)).toEqual(before);
  });

  it('publishes a mode-0600 file through a synchronized sibling temporary file and cleans it after success', async () => {
    const open = vi.spyOn(fs, 'open');

    await credentialStore.change({ type: 'add', name: 'work', apiKey: 'key' }, 'allowlist');

    expect(open).toHaveBeenCalledWith(expect.stringMatching(/\/\.credentials-.*\.tmp$/), 'wx', 0o600);
    expect((await stat(getCredentialFilePath())).mode & 0o777).toBe(0o600);
    expect(await readdir(join(agentDirectory, 'extensions', 'linear'))).toEqual(['credentials.json']);
  });
});

describe('Credential store Active secrets', () => {
  it('is synchronous and returns trimmed unique values in deterministic order', async () => {
    process.env.LINEAR_API_KEY = ' shared-key ';
    await put(document({
      workspaces: {
        first: { apiKey: ' shared-key ' },
        second: { apiKey: ' second-key ' },
        third: { apiKey: 'second-key' },
      },
    }));

    const result = credentialStore.secrets();

    expect(result).not.toBeInstanceOf(Promise);
    expect(result).toEqual(['shared-key', 'second-key']);
  });

  it('recovers complete closed apiKey strings from damaged JSON in first-seen order', async () => {
    await putText('{"apiKey":" first-key ","broken":[,"apiKey" : "second-key","apiKey":"first-key"}');

    expect(credentialStore.secrets()).toEqual(['first-key', 'second-key']);
  });

  it('parses recovered escapes with JSON string rules', async () => {
    await putText(String.raw`{"apiKey":" line\nquote:\" slash:\/ unicode:\u0061 backslash:\\ "},broken`);

    expect(credentialStore.secrets()).toEqual(['line\nquote:" slash:/ unicode:a backslash:\\']);
  });

  it.each([
    ['unclosed string', '{"apiKey":"partial-secret'],
    ['incomplete escape', '{"apiKey":"partial-secret' + '\\'],
    ['incomplete unicode escape', '{"apiKey":"partial-secret\\u123'],
    ['single-quoted value', `{"apiKey":'single-secret',broken`],
    ['unquoted value', '{"apiKey":unquoted-secret,broken'],
    ['alternate property name', '{"api_key":"alternate-secret",broken'],
    ['case-changed property name', '{"apikey":"alternate-secret",broken'],
    ['unrelated string', '{"name":"unrelated-secret",broken'],
    ['arbitrary text', 'arbitrary-secret text without a JSON property'],
  ])('ignores %s in damaged JSON', async (_name, source) => {
    await putText(source);

    expect(credentialStore.secrets()).toEqual([]);
  });

  it('keeps valid JSON structured and skips invalid or unrelated siblings', async () => {
    await put({
      workspaces: {
        first: { apiKey: 'first-key' },
        invalidEntry: 'not-an-entry',
        invalidKey: { apiKey: 42 },
        unrelated: { secret: 'unrelated-key' },
      },
      apiKey: 'top-level-key',
      sibling: { apiKey: 'sibling-key' },
    });

    expect(credentialStore.secrets()).toEqual(['first-key']);
  });

  it('puts the environment key first and trims, removes empty values, and deduplicates recovered keys', async () => {
    process.env.LINEAR_API_KEY = ' shared-key ';
    await putText('{"apiKey":" ","apiKey":"second-key","bad":,"apiKey":" shared-key ","apiKey":"third-key"}');

    expect(credentialStore.secrets()).toEqual(['shared-key', 'second-key', 'third-key']);
  });

  it('never throws for damaged, missing, and unreadable documents', async () => {
    process.env.LINEAR_API_KEY = 'env-key';
    const file = await putText('{"workspaces":{"work":{"apiKey":"saved-key"}},broken');
    expect(credentialStore.secrets()).toEqual(['env-key', 'saved-key']);

    await rm(file);
    expect(credentialStore.secrets()).toEqual(['env-key']);

    await mkdir(file);
    expect(credentialStore.secrets()).toEqual(['env-key']);
  });

  it('keeps resolve and change fail-closed on recovered damaged-file values without changing bytes', async () => {
    const secret = 'recovered-unknown-secret-123456789';
    const file = await putText(`{"workspaces":{"first":{"apiKey":"${secret}"}},broken`);
    const before = await readFile(file);
    const expected = 'Invalid Linear credential file. Repair or remove it before changing stored credentials.';

    const resolveError = await credentialStore.resolve().then(() => undefined, (error: Error) => error);
    expect(resolveError).toBeInstanceOf(Error);
    expect(resolveError?.message).toBe(expected);
    expect(resolveError?.message).not.toContain(secret);
    expect(await readFile(file)).toEqual(before);

    const changeError = await credentialStore.change({ type: 'remove', name: 'first' }, 'allowlist')
      .then(() => undefined, (error: Error) => error);
    expect(changeError).toBeInstanceOf(Error);
    expect(changeError?.message).toBe(expected);
    expect(changeError?.message).not.toContain(secret);
    expect(await readFile(file)).toEqual(before);
    expect(await readdir(join(agentDirectory, 'extensions', 'linear'))).toEqual(['credentials.json']);
  });
});
