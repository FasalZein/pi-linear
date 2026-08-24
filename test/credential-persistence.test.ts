import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
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

describe('inter-process credential transactions', () => {
  it('persists every concurrent successful workspace addition', async () => {
    const worker = join(process.cwd(), 'node_modules/vite-node/vite-node.mjs');
    const helper = join(process.cwd(), 'test/helpers/credential-worker.ts');
    const startFile = join(agentDirectory, 'start');
    const names = Array.from({ length: 20 }, (_, index) => `workspace-${index}`);
    const children = names.map((name, index) => {
      const readyFile = join(agentDirectory, `ready-${index}`);
      const child = spawn(process.execPath, [worker, helper, agentDirectory, name, readyFile, startFile], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      return {
        readyFile,
        exited: new Promise<void>((resolve, reject) => child.once('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Credential worker exited ${code}: ${stderr}`));
        })),
      };
    });

    while (true) {
      const ready = await Promise.all(children.map(({ readyFile }) => access(readyFile).then(() => true, () => false)));
      if (ready.every(Boolean)) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await writeFile(startFile, 'start');
    await Promise.all(children.map(({ exited }) => exited));

    expect(Object.keys((await readCredentials()).workspaces).sort()).toEqual(names.sort());
  }, 30_000);
});

describe('credential lock safety', () => {
  it('recovers a lock only after its recorded process is gone', async () => {
    const file = await put(credentials());
    const lock = `${file}.lock`;
    const child = spawn(process.execPath, ['-e', '']);
    const deadPid = child.pid!;
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: deadPid, token: 'dead-owner' }), { mode: 0o600 });

    await addWorkspace('third', 'lin_api_third_secret_123456789');

    expect((await readCredentials()).workspaces.third).toEqual({ apiKey: 'lin_api_third_secret_123456789' });
    await expect(access(lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers after the recovery claimant also dies', async () => {
    const file = await put(credentials());
    const lock = `${file}.lock`;
    const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    const deadOwnerPid = owner.pid!;
    owner.kill('SIGKILL');
    await new Promise<void>((resolve) => owner.once('exit', () => resolve()));
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: deadOwnerPid, token: 'dead-owner' }), { mode: 0o600 });

    const recovery = join(lock, 'recovery.json');
    const ready = join(agentDirectory, 'recovery-ready');
    const claimant = spawn(process.execPath, [
      '-e',
      "const fs=require('node:fs');fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,token:'dead-recovery'}),{mode:0o600});fs.writeFileSync(process.argv[2],'ready');setInterval(()=>{},1000)",
      recovery,
      ready,
    ]);
    while (await access(ready).then(() => false, () => true)) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    claimant.kill('SIGKILL');
    await new Promise<void>((resolve) => claimant.once('exit', () => resolve()));

    await addWorkspace('third', 'lin_api_third_secret_123456789');

    expect((await readCredentials()).workspaces.third).toEqual({ apiKey: 'lin_api_third_secret_123456789' });
    await expect(access(lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a symbolic-link lock without writing through it', async () => {
    const file = await put(credentials());
    const before = await readFile(file);
    const outside = join(agentDirectory, 'outside');
    await mkdir(outside);
    await symlink(outside, `${file}.lock`, 'dir');

    await expect(addWorkspace('third', 'lin_api_third_secret_123456789')).rejects.toThrow();

    expect(await readFile(file)).toEqual(before);
    expect(await readdir(outside)).toEqual([]);
  });
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

describe('/linear-auth workspace display redaction', () => {
  it('redacts token-shaped and exact-secret names without changing selected workspaces', async () => {
    const tokenName = 'lin_api_workspace_name_secret_123456789';
    const unknownName = 'unknown-workspace-secret-123456789';
    const addedUnknownName = 'another-unknown-workspace-secret-123456789';
    await put(credentials({
      activeWorkspace: tokenName,
      workspaces: {
        [tokenName]: { apiKey: 'safe-key-token' },
        [unknownName]: { apiKey: unknownName },
      },
    }));
    const harness = commandHarness('allowlist');

    await harness.run('status');
    harness.ui.select.mockImplementationOnce(async (_title, labels: string[]) => labels[1]);
    await harness.run('switch');
    expect((await readCredentials()).activeWorkspace).toBe(unknownName);

    harness.ui.select.mockImplementationOnce(async (_title, labels: string[]) => labels[0]);
    await harness.run('remove');
    expect((await readCredentials()).workspaces[tokenName]).toBeUndefined();

    harness.ui.input.mockResolvedValueOnce('safe-key-added');
    harness.ui.confirm.mockResolvedValueOnce(false);
    await harness.run(`add ${tokenName}`);
    expect((await readCredentials()).workspaces[tokenName]).toEqual({ apiKey: 'safe-key-added' });

    harness.ui.input.mockResolvedValueOnce(addedUnknownName);
    harness.ui.confirm.mockResolvedValueOnce(false);
    await harness.run(`add ${addedUnknownName}`);
    expect((await readCredentials()).workspaces[addedUnknownName]).toEqual({ apiKey: addedUnknownName });

    const displayed = [
      ...harness.ui.notify.mock.calls.map(([message]) => message),
      ...harness.ui.select.mock.calls.flatMap(([, labels]) => labels),
      ...harness.ui.confirm.mock.calls.flatMap(([title, message]) => [title, message]),
    ].join('\n');
    expect(displayed).toContain('[REDACTED]');
    for (const secret of [tokenName, unknownName, addedUnknownName]) expect(displayed).not.toContain(secret);
  });
});

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
