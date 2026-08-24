import { promises as fs } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addWorkspace,
  getCredentialFilePath,
  readCredentials,
  removeWorkspace,
  resolveApiKey,
  setAuthPreference,
  switchWorkspace,
  writeCredentials,
  type WorkspaceCredentials,
} from '../extensions/client';
import { registerLinearExtension } from '../extensions/index';

const originalEnvironment = { ...process.env };
let agentDirectory: string;

function credentials(overrides: Partial<WorkspaceCredentials> = {}): WorkspaceCredentials {
  return {
    activeWorkspace: 'first',
    authPreference: 'env',
    workspaces: {
      first: { apiKey: 'lin_api_first_secret_123456789' },
      second: { apiKey: 'lin_api_second_secret_123456789' },
    },
    futureSetting: { enabled: true },
    ...overrides,
  };
}

async function put(source: string | object): Promise<string> {
  const file = getCredentialFilePath();
  await mkdir(join(agentDirectory, 'extensions', 'linear'), { recursive: true });
  await writeFile(file, typeof source === 'string' ? source : JSON.stringify(source), { mode: 0o600 });
  return file;
}

beforeEach(async () => {
  agentDirectory = await mkdtemp(join(tmpdir(), 'pi-linear-credentials-'));
  process.env.PI_CODING_AGENT_DIR = agentDirectory;
  delete process.env.LINEAR_READONLY;
  delete process.env.LINEAR_API_KEY;
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.env = { ...originalEnvironment };
  await rm(agentDirectory, { recursive: true, force: true });
});

describe('fail-closed credential mutation', () => {
  it.each([
    ['add', () => addWorkspace('third', 'lin_api_third_secret_123456789')],
    ['remove', () => removeWorkspace('first')],
    ['switch', () => switchWorkspace('second')],
    ['preference', () => setAuthPreference('workspace')],
  ])('rejects %s after truncated JSON and leaves the file unchanged', async (_name, mutate) => {
    const file = await put('{"activeWorkspace":"first","workspaces":');
    const before = await readFile(file);

    await expect(mutate()).rejects.toThrow();

    expect(await readFile(file)).toEqual(before);
  });

  it('does not expose credential text from corrupt JSON errors', async () => {
    const secret = 'lin_api_corrupt_secret_123456789';
    await put(`{"workspaces":{"first":{"apiKey":"${secret}"}},broken`);

    const error = await addWorkspace('second', 'lin_api_second_secret_123456789').catch((failure: Error) => failure);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Invalid Linear credential file. Repair or remove it before changing stored credentials.');
    expect((error as Error).message).not.toContain(secret);
  });

  it('rejects invalid managed shapes without replacing the file', async () => {
    const file = await put({ activeWorkspace: 'first', authPreference: 'workspace', workspaces: { first: { apiKey: 42 } } });
    const before = await readFile(file);

    await expect(addWorkspace('second', 'lin_api_second_secret_123456789')).rejects.toThrow('Invalid Linear credential file');

    expect(await readFile(file)).toEqual(before);
  });

  it('surfaces read errors without replacing the file', async () => {
    const file = await put(credentials());
    await chmod(file, 0o000);
    try {
      await expect(addWorkspace('third', 'lin_api_third_secret_123456789')).rejects.toThrow();
    } finally {
      await chmod(file, 0o600);
    }
    expect(JSON.parse(await readFile(file, 'utf8')).futureSetting).toEqual({ enabled: true });
  });

  it('preserves unknown top-level fields through every mutation', async () => {
    await put(credentials());

    await addWorkspace('third', 'lin_api_third_secret_123456789');
    await switchWorkspace('second');
    await setAuthPreference('workspace');
    await removeWorkspace('first');

    const stored = JSON.parse(await readFile(getCredentialFilePath(), 'utf8'));
    expect(stored.futureSetting).toEqual({ enabled: true });
    expect(stored.activeWorkspace).toBe('second');
    expect(stored.authPreference).toBe('workspace');
    expect(Object.keys(stored.workspaces)).toEqual(['second', 'third']);
  });

  it('keeps authentication preference unchanged when switching workspace', async () => {
    await put(credentials({ authPreference: 'env' }));

    const updated = await switchWorkspace('second');

    expect(updated.activeWorkspace).toBe('second');
    expect(updated.authPreference).toBe('env');
  });

  it('writes a private final file and leaves no temporary file', async () => {
    await writeCredentials(credentials());

    expect((await stat(getCredentialFilePath())).mode & 0o777).toBe(0o600);
    expect(await readdir(join(agentDirectory, 'extensions', 'linear'))).toEqual(['credentials.json']);
  });

  it('keeps the original file and removes the temporary file after rename failure', async () => {
    const file = await put(credentials());
    const before = await readFile(file);
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('forced rename failure'));

    await expect(addWorkspace('third', 'lin_api_third_secret_123456789')).rejects.toThrow('forced rename failure');

    expect(await readFile(file)).toEqual(before);
    expect(await readdir(join(agentDirectory, 'extensions', 'linear'))).toEqual(['credentials.json']);
  });
});

describe('effective read-only local-write policy', () => {
  it.each([
    ['write', () => writeCredentials(credentials(), 'readonly')],
    ['add', () => addWorkspace('third', 'lin_api_third_secret_123456789', 'readonly')],
    ['remove', () => removeWorkspace('first', 'readonly')],
    ['switch', () => switchWorkspace('second', 'readonly')],
    ['preference', () => setAuthPreference('workspace', 'readonly')],
  ])('blocks %s at the shared credential boundary', async (_name, mutate) => {
    const file = await put(credentials());
    const before = await readFile(file);

    await expect(mutate()).rejects.toThrow('Local Linear credential writes are disabled by read-only mode.');

    expect(await readFile(file)).toEqual(before);
  });

  it('lets LINEAR_READONLY=1 override allowlist mode', async () => {
    const file = await put(credentials());
    const before = await readFile(file);
    process.env.LINEAR_READONLY = '1';

    await expect(switchWorkspace('second', 'allowlist')).rejects.toThrow('read-only mode');

    expect(await readFile(file)).toEqual(before);
  });

  it('blocks prompt-driven credential creation', async () => {
    const ctx = {
      hasUI: true,
      ui: {
        confirm: vi.fn().mockResolvedValue(true),
        input: vi.fn().mockResolvedValueOnce('work').mockResolvedValueOnce('lin_api_prompt_secret_123456789'),
        notify: vi.fn(),
      },
    } as any;

    await expect(resolveApiKey(ctx, { mode: 'readonly' })).rejects.toThrow('read-only mode');
    await expect(readFile(getCredentialFilePath(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

function commandHarness(mode: 'allowlist' | 'readonly') {
  let command: any;
  const ui = {
    input: vi.fn().mockResolvedValue('lin_api_command_secret_123456789'),
    select: vi.fn(),
    confirm: vi.fn(),
    notify: vi.fn(),
  };
  const pi = {
    registerCommand: (name: string, definition: any) => { if (name === 'linear-auth') command = definition; },
    registerTool: vi.fn(),
    getAllTools: () => [],
    getActiveTools: () => [],
    setActiveTools: vi.fn(),
    on: vi.fn(),
  } as any;
  registerLinearExtension(pi, mode);
  return { run: (args: string) => command.handler(args, { hasUI: true, ui }), ui };
}

describe('/linear-auth read-only command boundary', () => {
  it.each(['add third', 'remove first', 'switch second', 'prefer workspace'])('rejects %s before changing credentials', async (args) => {
    const file = await put(credentials());
    const before = await readFile(file);
    const harness = commandHarness('readonly');

    await expect(harness.run(args)).rejects.toThrow('read-only mode');

    expect(await readFile(file)).toEqual(before);
  });

  it('lets LINEAR_READONLY=1 override the normal command entry mode', async () => {
    const file = await put(credentials());
    const before = await readFile(file);
    process.env.LINEAR_READONLY = '1';
    const harness = commandHarness('allowlist');

    await expect(harness.run('prefer workspace')).rejects.toThrow('read-only mode');

    expect(await readFile(file)).toEqual(before);
  });

  it('keeps status available in read-only mode', async () => {
    await put(credentials());
    const harness = commandHarness('readonly');

    await expect(harness.run('status')).resolves.toBeUndefined();

    expect(harness.ui.notify).toHaveBeenCalledWith(expect.stringContaining('Auth preference: env'), 'info');
  });
});
