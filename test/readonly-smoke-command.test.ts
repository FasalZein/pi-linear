import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGTERM');
});

type ServerMode = 'pass' | 'fail' | 'late-missing' | 'late-gate';

async function startServer(root: string, mode: ServerMode) {
  const ready = join(root, `${mode}-ready.json`);
  const log = join(root, `${mode}-requests.jsonl`);
  const child = spawn(process.execPath, [
    join(process.cwd(), 'test/helpers/readonly-smoke-server.mjs'), ready, log, mode,
  ], { stdio: 'ignore' });
  children.push(child);
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await access(ready);
      const { port } = JSON.parse(await readFile(ready, 'utf8'));
      return { endpoint: `http://127.0.0.1:${port}/graphql`, log, child };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error('fake GraphQL server did not start');
}

function command(root: string, endpoint: string, extraEnvironment: Record<string, string> = {}) {
  const result = spawnSync('npm', ['run', 'smoke:readonly'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
    env: {
      ...process.env,
      CI: '1',
      LINEAR_READONLY: '1',
      LINEAR_API_KEY: 'lin_api_fake_active_secret_123456789',
      LINEAR_SMOKE_GRAPHQL_ENDPOINT: endpoint,
      LINEAR_SMOKE_TMP_PARENT: root,
      PI_CODING_AGENT_DIR: join(root, 'source-agent'),
      ...extraEnvironment,
    },
  });
  return { status: result.status, output: `${result.stdout || ''}\n${result.stderr || ''}` };
}

function summary(output: string) {
  const line = output.split(/\r?\n/).find((entry) => entry.startsWith('READONLY SMOKE PASS: '));
  if (!line) throw new Error(`pass summary missing: ${output}`);
  return JSON.parse(line.slice('READONLY SMOKE PASS: '.length));
}

describe('deterministic fake-server smoke command', () => {
  it('runs the real command twice through activation, both surfaces, pagination, and semantic safety', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-linear-fake-smoke-'));
    try {
      const server = await startServer(root, 'pass');
      for (let run = 0; run < 2; run++) {
        const result = command(root, server.endpoint);
        expect(result.status).toBe(0);
        expect(result.output).not.toContain('fake_active_secret');
        expect(result.output).not.toContain('server_secret');
        const report = summary(result.output);
        expect(report.runtime).toMatchObject({
          activation: 'passed', zeroArgumentReads: 15, followedCursors: 1,
          getIssueIdentity: 'passed', missingReference: 'passed', mutationRequests: 0, redaction: 'passed',
        });
        expect(report.runtime.listGet).toHaveLength(15);
        expect(report.runtime.listGet.filter((entry: any) => entry.status === 'passed')).toHaveLength(8);
        expect(report.runtime.listGet.filter((entry: any) => entry.status === 'skipped:list empty')).toHaveLength(1);
        expect(report.runtime.listGet.filter((entry: any) => entry.status === 'skipped:no valid get input exists')).toHaveLength(6);
        expect((await readdir(root)).filter((name) => name.startsWith('pi-linear-readonly-'))).toEqual([]);
      }

      const requests = (await readFile(server.log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      expect(new Set(requests.map((request) => request.kind))).toEqual(new Set(['introspection', 'query']));
      expect(requests.some((request) => request.kind === 'mutation')).toBe(false);
      expect(requests.filter((request) => request.operationName === 'GetIssue')).toHaveLength(8);
      expect(requests.filter((request) => request.operationName === 'ResolveIssueByIdentifier')).toHaveLength(0);
      expect(requests.filter((request) => request.operationName === 'ListIssues' && request.variables.after === 'next-1')).toHaveLength(2);
      for (const operation of [
        'ListComments', 'ListViews', 'ListCycles', 'ListDocuments', 'ListInitiatives',
        'ListIssueLabels', 'ListIssueRelations', 'ListIssueStatuses', 'ListIssues', 'ListMilestones',
        'ListProjectLabels', 'ListProjectRelations', 'ListProjects', 'ListTeams', 'ListUsers',
      ]) expect(requests.some((request) => request.operationName === operation)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('keeps server failures compact, redacted, generic, and cleaned', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-linear-fake-failure-'));
    try {
      const server = await startServer(root, 'fail');
      const result = command(root, server.endpoint);
      expect(result.status).toBe(1);
      expect(result.output).toContain('READONLY SMOKE FAIL: smoke.runtime: authenticated read-only probe failed safely');
      expect(result.output).not.toContain('server_secret');
      expect(result.output).not.toContain('private-record');
      expect(result.output.split(/\r?\n/).filter((line) => line.startsWith('READONLY SMOKE '))).toEqual([
        'READONLY SMOKE FAIL: smoke.runtime: authenticated read-only probe failed safely',
      ]);
      expect((await readdir(root)).filter((name) => name.startsWith('pi-linear-readonly-'))).toEqual([]);
      const requests = (await readFile(server.log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      expect(requests.map((request) => request.kind)).toEqual(['introspection', 'query']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it.each([
    ['late-missing', {}, 'READONLY SMOKE FAIL: smoke.missing-reference: semantic not-found signal mismatch'],
    ['late-gate', {
      LINEAR_SMOKE_TEST_READONLY_ERROR: `lin_api_gate_secret_123456789 ${'{"workspace":{"issues":["private-gate-record"]}} '.repeat(400)}`,
    }, 'READONLY SMOKE FAIL: smoke.readonly: mutation gate rejection signal mismatch'],
  ] as const)('keeps the %s semantic failure fixed and body-free after earlier reads pass', async (mode, extraEnvironment, expectedLine) => {
    const root = await mkdtemp(join(tmpdir(), `pi-linear-fake-${mode}-`));
    try {
      const server = await startServer(root, mode);
      const result = command(root, server.endpoint, extraEnvironment);
      expect(result.status).toBe(1);
      const lines = result.output.split(/\r?\n/).filter((line) => line.startsWith('READONLY SMOKE '));
      expect(lines).toEqual([expectedLine]);
      expect(lines[0]).toHaveLength(expectedLine.length);
      expect(result.output).not.toContain('server_secret');
      expect(result.output).not.toContain('gate_secret');
      expect(result.output).not.toContain('private-record');
      expect(result.output).not.toContain('private-gate-record');
      expect((await readdir(root)).filter((name) => name.startsWith('pi-linear-readonly-'))).toEqual([]);

      const requests = (await readFile(server.log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      expect(requests.some((request) => request.kind === 'mutation')).toBe(false);
      expect(requests.some((request) => request.operationName === 'ListUsers')).toBe(true);
      expect(requests.some((request) => request.operationName === 'GetIssue')).toBe(true);
      expect(requests.some((request) => request.root === 'issue'
        && request.variables.id === '00000000-0000-4000-8000-000000000000')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
