import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { linearApiTool, resolveRequest } from '../extensions/api';
import { assertBatchAccounting, batchHelp } from '../extensions/batch';
import { operationDefinitions, projectCompatibilityOperation } from '../extensions/operations';
import type { MutationMode } from '../extensions/safety';
import { isolateLinearCredentials } from './helpers/credentials';

isolateLinearCredentials();

const ISSUE_A = '11111111-1111-4111-8111-111111111111';
const ISSUE_B = '22222222-2222-4222-8222-222222222222';
const TEAM_ID = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'lin_api_secret123456789abcdef';
const originalKey = process.env.LINEAR_API_KEY;
const originalArtifactRoot = process.env.PI_ARTIFACT_PROJECT_ROOT;
const originalSpillBytes = process.env.LINEAR_SPILL_BYTES;
const artifactRoots: string[] = [];

async function useArtifactRoot() {
  const root = await mkdtemp(join(tmpdir(), 'pi-linear-batch-'));
  artifactRoots.push(root);
  process.env.PI_ARTIFACT_PROJECT_ROOT = root;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  if (originalKey === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = originalKey;
  if (originalArtifactRoot === undefined) delete process.env.PI_ARTIFACT_PROJECT_ROOT;
  else process.env.PI_ARTIFACT_PROJECT_ROOT = originalArtifactRoot;
  if (originalSpillBytes === undefined) delete process.env.LINEAR_SPILL_BYTES;
  else process.env.LINEAR_SPILL_BYTES = originalSpillBytes;
  await Promise.all(artifactRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function execute(params: Record<string, unknown>, mode: MutationMode = 'allowlist') {
  return (linearApiTool(mode) as any).execute('call-1', params, undefined, undefined, { hasUI: false });
}

function batch(reads: unknown[], extra: Record<string, unknown> = {}) {
  return execute({ operation: 'batch', variables: { reads, ...extra } });
}

function operations(entries: unknown[]) {
  return execute({ operation: 'batch', variables: { operations: entries } });
}

function issueNode(id: string, identifier: string, title = 'Fix login') {
  return { id, identifier, title, team: { id: TEAM_ID, key: 'AEO' } };
}

function graphqlStub(respond: (request: { query: string; variables: Record<string, unknown> }) => {
  ok?: boolean;
  status?: number;
  statusText?: string;
  body?: unknown;
  json?: boolean;
  throw?: Error;
}) {
  const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    requests.push(request);
    const outcome = respond(request);
    if (outcome.throw) throw outcome.throw;
    if (outcome.json === false) {
      return {
        ok: outcome.ok ?? false,
        status: outcome.status ?? 502,
        statusText: outcome.statusText ?? 'Bad Gateway',
        headers: new Headers(),
        json: async () => { throw new Error('not json'); },
      };
    }
    return {
      ok: outcome.ok ?? true,
      status: outcome.status ?? 200,
      statusText: outcome.statusText ?? 'OK',
      headers: new Headers(),
      json: async () => outcome.body ?? { data: {} },
    };
  });
  vi.stubGlobal('fetch', fetch);
  process.env.LINEAR_API_KEY = 'test-key';
  return { fetch, requests };
}

describe('batch help and catalog', () => {
  it('returns a batch parameter card without network access or typed-tool activation', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const result = await execute({ operation: 'help', variables: { operation: 'batch' } });
    expect(fetch).not.toHaveBeenCalled();
    expect(result.details.name).toBe('batch');
    expect(result.details.loadedTools).toBeUndefined();
    expect(result.details.parameters).toEqual(
      expect.arrayContaining([
        { name: 'operations', type: '{ key?, operation, variables }[]', required: false },
        { name: 'reads', type: '{ key?, operation, variables }[]', required: false },
        { name: 'mutations', type: '{ key?, operation, variables }[]', required: false },
      ]),
    );
    expect(result.details.entry).toMatch(/keys are optional caller labels/i);
    expect(result.details.entry).toMatch(/runtime assigns/i);
    expect(result.details.entry).not.toMatch(/GraphQL alias/i);
    expect(result.details.example.variables).toEqual({
      operations: [{ operation: 'get_issue', variables: { issue: 'AEO-258' } }],
    });
    expect(result.details.phasedExample.variables).toMatchObject({
      reads: [{ operation: 'get_issue', variables: { issue: 'AEO-258' } }],
      mutations: [{ operation: 'delete_issue_relation' }],
    });
  });

  it('validates every nested entry in every published batch example against its real operation contract', async () => {
    const reference = await readFile('REFERENCE.md', 'utf8');
    const documented = [...reference.matchAll(/```json\n([^`]*?"operation": "batch"[^`]*?)\n```/g)]
      .map((match) => JSON.parse(match[1]!));
    const help = batchHelp();
    const examples = [help.example, help.phasedExample, ...documented] as Array<{
      variables: { operations?: Array<{ operation: string; variables: Record<string, unknown> }>; reads?: Array<{ operation: string; variables: Record<string, unknown> }>; mutations?: Array<{ operation: string; variables: Record<string, unknown> }> };
    }>;
    expect(examples).toHaveLength(4);
    for (const example of examples) {
      for (const entry of [...(example.variables.operations ?? []), ...(example.variables.reads ?? []), ...(example.variables.mutations ?? [])]) {
        expect(() => resolveRequest({ operation: entry.operation, variables: entry.variables }), entry.operation).not.toThrow();
      }
    }
  });

  it('publishes batch and the loader-only telemetry override', () => {
    const tool = linearApiTool() as any;
    expect(tool.description).toContain('batch: Batch independent reads with read-only operations, or use explicit phases for one ordinary mutation, grouped issue creates, or one guarded relation delete.');
    expect(Object.keys(tool.parameters.properties).sort()).toEqual(['operation', 'query', 'sink', 'telemetry', 'variables', 'workspace']);
  });
});

describe('pure read operation plans', () => {
  it('plans every query deterministically without transport, timers, or random IDs', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const now = vi.spyOn(Date, 'now');
    const random = vi.spyOn(Math, 'random');
    delete process.env.LINEAR_API_KEY;
    const resolved = {
      issue: { id: ISSUE_A, identifier: 'AEO-1', teamId: TEAM_ID, teamKey: 'AEO' },
      team: { id: TEAM_ID, key: 'AEO' },
      assignee: { id: ISSUE_B, name: 'Ada' },
      user: { id: ISSUE_B, name: 'Ada' },
      state: { id: ISSUE_B, teamId: TEAM_ID, name: 'Started' },
      project: { id: ISSUE_A, name: 'Platform' },
      cycle: { id: ISSUE_A, name: 'Cycle 1' },
      document: { id: ISSUE_A, name: 'Planning notes' },
      milestone: { id: ISSUE_A, name: 'Beta' },
      initiative: { id: ISSUE_A, name: 'Platform' },
    };
    const snapshots: unknown[] = [];
    for (const definition of operationDefinitions.filter(({ kind }) => kind === 'query')) {
      const operation = projectCompatibilityOperation(definition);
      expect(operation.plan, operation.name).toBeTypeOf('function');
      const first = await operation.plan!(operation.example.variables);
      const second = await operation.plan!(operation.example.variables);
      const snapshot = (plan: typeof first) => ({
        lookups: plan.lookups.map((lookup) => ({
          key: lookup.key,
          dependsOn: lookup.dependsOn,
          document: lookup.document(resolved),
          variables: lookup.variables(resolved),
        })),
        prepared: plan.finish(resolved),
      });
      expect(snapshot(second), operation.name).toEqual(snapshot(first));
      snapshots.push(snapshot(first));
    }
    expect(snapshots.length).toBeGreaterThan(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(timer).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
  });
});

describe('batch read phase', () => {
  it('carries two compatible read aliases in one GraphQL request', async () => {
    const { requests } = graphqlStub((request) => {
      expect(request.query).toContain('one: issue');
      expect(request.query).toContain('two: issue');
      expect(request.variables).toMatchObject({ one_id: 'AEO-1', two_id: 'AEO-2' });
      return {
        body: {
          data: {
            one: issueNode(ISSUE_A, 'AEO-1'),
            two: issueNode(ISSUE_B, 'AEO-2'),
          },
        },
      };
    });

    const result = await batch([
      { key: 'one', operation: 'get_issue', variables: { issue: 'AEO-1' } },
      { key: 'two', operation: 'get_issue', variables: { issue: 'AEO-2' } },
    ]);

    expect(requests).toHaveLength(1);
    expect(result.details).toMatchObject({
      data: {
        one: { issue: issueNode(ISSUE_A, 'AEO-1') },
        two: { issue: issueNode(ISSUE_B, 'AEO-2') },
      },
      errors: [],
      skipped: [],
      meta: { requests: { read: 1, mutation: 0 } },
    });
  });

  it('accepts the observed three-entry read-only operations form and assigns recoverable keys', async () => {
    const { requests } = graphqlStub(() => ({
      body: { data: {
        get_issue: issueNode(ISSUE_A, 'AEO-1'),
        get_issue_2: issueNode(ISSUE_B, 'AEO-2'),
        get_issue_3: issueNode(ISSUE_A, 'AEO-3'),
      } },
    }));

    const result = await operations([
      { operation: 'get_issue', variables: { issue: 'AEO-1' } },
      { operation: 'get_issue', variables: { issue: 'AEO-2' } },
      { operation: 'get_issue', variables: { issue: 'AEO-3' } },
    ]);

    expect(requests).toHaveLength(1);
    expect(Object.keys(result.details.data)).toEqual(['get_issue', 'get_issue_2', 'get_issue_3']);
  });

  it('accepts the observed three-entry explicit reads retry with omitted keys', async () => {
    graphqlStub(() => ({
      body: { data: {
        get_issue: issueNode(ISSUE_A, 'AEO-1'),
        get_issue_2: issueNode(ISSUE_B, 'AEO-2'),
        get_issue_3: issueNode(ISSUE_A, 'AEO-3'),
      } },
    }));

    const result = await batch([
      { operation: 'get_issue', variables: { issue: 'AEO-1' } },
      { operation: 'get_issue', variables: { issue: 'AEO-2' } },
      { operation: 'get_issue', variables: { issue: 'AEO-3' } },
    ]);

    expect(Object.keys(result.details.data)).toEqual(['get_issue', 'get_issue_2', 'get_issue_3']);
  });

  it('assigns stable keys to repeated operations with omitted keys', async () => {
    const { requests } = graphqlStub(() => ({
      body: {
        data: {
          get_issue: issueNode(ISSUE_A, 'AEO-1'),
          get_issue_2: issueNode(ISSUE_B, 'AEO-2'),
        },
      },
    }));

    const result = await operations([
      { operation: 'get_issue', variables: { issue: 'AEO-1' } },
      { operation: 'get_issue', variables: { issue: 'AEO-2' } },
    ]);

    expect(requests).toHaveLength(1);
    expect(Object.keys(result.details.data)).toEqual(['get_issue', 'get_issue_2']);
  });

  it('keeps a successful alias when a sibling path fails', async () => {
    graphqlStub(() => ({
      body: {
        data: {
          ready: issueNode(ISSUE_A, 'AEO-1'),
          missing: null,
        },
        errors: [{ message: 'Entity not found: Issue', path: ['missing'] }],
      },
    }));

    const result = await batch([
      { key: 'ready', operation: 'get_issue', variables: { issue: 'AEO-1' } },
      { key: 'missing', operation: 'get_issue', variables: { issue: 'AEO-2' } },
    ]);

    expect(result.details.data).toEqual({ ready: { issue: issueNode(ISSUE_A, 'AEO-1') } });
    expect(result.details.errors).toEqual([
      { key: 'missing', path: ['missing'], message: 'Entity not found: Issue' },
    ]);
    expect(result.details.skipped).toEqual([]);
    expect(result.details.meta.requests).toEqual({ read: 1, mutation: 0 });
  });

  it('accounts every failed read and skips a pending mutation', async () => {
    graphqlStub(() => ({
      body: {
        data: { one: null, two: null },
        errors: [
          { message: 'Missing one', path: ['one'] },
          { message: 'Missing two', path: ['two'] },
        ],
      },
    }));

    const result = await execute({
      operation: 'batch',
      variables: {
        reads: [
          { key: 'one', operation: 'get_issue', variables: { issue: 'AEO-1' } },
          { key: 'two', operation: 'get_issue', variables: { issue: 'AEO-2' } },
        ],
        mutations: [{ key: 'edit', operation: 'update_issue', variables: { issue: 'AEO-3', title: 'Later' } }],
      },
    });

    expect(result.details.data).toEqual({});
    expect(result.details.errors).toEqual([
      { key: 'one', path: ['one'], message: 'Missing one' },
      { key: 'two', path: ['two'], message: 'Missing two' },
    ]);
    expect(result.details.skipped).toEqual(['edit']);
    expect(result.details.meta.requests).toEqual({ read: 1, mutation: 0 });
  });

  it('accepts name as a loader-only compatibility label when key is absent', async () => {
    graphqlStub(() => ({ body: { data: { issue: issueNode(ISSUE_A, 'AEO-1') } } }));
    const result = await batch([
      { name: 'issue', operation: 'get_issue', variables: { issue: 'AEO-1' } },
    ]);
    expect(result.details.data).toEqual({ issue: { issue: issueNode(ISSUE_A, 'AEO-1') } });
  });

  it('rejects key and name conflicts with the corrected shape before network access', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(batch([
      { key: 'issue', name: 'other', operation: 'get_issue', variables: { issue: 'AEO-1' } },
    ])).rejects.toThrow(/cannot include both "key" and "name".*omit "name"/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects malformed entries with the corrected shape before network access', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(operations([null])).rejects.toThrow(/send.*"operation".*"variables".*"key"/i);
    await expect(operations([{ operation: 'get_issue', variables: [] }])).rejects.toThrow(/send.*"operation".*"variables".*"key"/i);
    await expect(operations([{ operation: 'get_issue', variables: {}, extra: true }])).rejects.toThrow(/send.*"operation".*"variables".*"key"/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects duplicate and invalid caller labels before network access', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    process.env.LINEAR_API_KEY = 'test-key';

    await expect(batch([])).rejects.toThrow(/non-empty|reads/i);
    await expect(batch([
      { key: 'one', operation: 'get_issue', variables: { issue: 'AEO-1' } },
      { key: 'one', operation: 'get_issue', variables: { issue: 'AEO-2' } },
    ])).rejects.toThrow(/unique|duplicate/i);
    await expect(batch([
      { key: '1bad', operation: 'get_issue', variables: { issue: 'AEO-1' } },
    ])).rejects.toThrow(/alias|key/i);
    await expect(batch([
      { key: 'a-b', operation: 'get_issue', variables: { issue: 'AEO-1' } },
    ])).rejects.toThrow(/valid batch entry key/i);
    await expect(batch([
      { name: 'a-b', operation: 'get_issue', variables: { issue: 'AEO-1' } },
    ])).rejects.toThrow(/valid batch entry key/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('avoids explicit key collisions when it assigns keys', async () => {
    graphqlStub(() => ({
      body: {
        data: {
          get_issue: issueNode(ISSUE_A, 'AEO-1'),
          get_issue_2: issueNode(ISSUE_B, 'AEO-2'),
        },
      },
    }));
    const result = await operations([
      { key: 'get_issue', operation: 'get_issue', variables: { issue: 'AEO-1' } },
      { operation: 'get_issue', variables: { issue: 'AEO-2' } },
    ]);
    expect(Object.keys(result.details.data)).toEqual(['get_issue', 'get_issue_2']);
  });

  it('rejects flat mutations and mixed flat work with the phased shape before network access', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    process.env.LINEAR_API_KEY = 'test-key';
    const corrected = /use.*"reads".*"mutations"/i;
    await expect(operations([
      { operation: 'create_issue', variables: { title: 'X', team: 'AEO' } },
    ])).rejects.toThrow(corrected);
    await expect(operations([
      { operation: 'get_issue', variables: { issue: 'AEO-1' } },
      { operation: 'create_issue', variables: { title: 'X', team: 'AEO' } },
    ])).rejects.toThrow(corrected);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects raw, help, batch, local, and mutation entries before network access', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    process.env.LINEAR_API_KEY = 'test-key';

    await expect(batch([{ key: 'help', operation: 'help', variables: {} }])).rejects.toThrow(/named GraphQL/i);
    await expect(batch([{ key: 'again', operation: 'batch', variables: { reads: [] } }])).rejects.toThrow(/named GraphQL/i);
    await expect(batch([{ key: 'local', operation: 'switch_workspace', variables: { name: 'main' } }])).rejects.toThrow(/local|named GraphQL/i);
    await expect(batch([{ key: 'write', operation: 'create_issue', variables: { title: 'X', team: 'AEO' } }])).rejects.toThrow(/query|mutation/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a second lookup layer before credential or network access', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    delete process.env.LINEAR_API_KEY;

    await expect(batch([
      { key: 'issues', operation: 'list_issues', variables: { team: 'AEO' } },
    ])).rejects.toThrow(/second lookup layer.*one read request/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('redacts credentials from successful batch data', async () => {
    graphqlStub(() => ({
      body: {
        data: {
          one: issueNode(ISSUE_A, 'AEO-1', `see ${TOKEN}`),
        },
      },
    }));

    const result = await batch([
      { key: 'one', operation: 'get_issue', variables: { issue: 'AEO-1' } },
    ]);
    const text = JSON.stringify(result.details);
    expect(text).not.toContain(TOKEN);
    expect(text).toContain('[REDACTED]');
  });

  it('preserves network, HTTP, and non-JSON failures', async () => {
    graphqlStub(() => ({ throw: new Error('socket closed') }));
    await expect(batch([
      { key: 'one', operation: 'get_issue', variables: { issue: 'AEO-1' } },
    ])).rejects.toThrow('Linear network error: socket closed');

    graphqlStub(() => ({ ok: false, status: 502, statusText: 'Bad Gateway', json: false }));
    await expect(batch([
      { key: 'one', operation: 'get_issue', variables: { issue: 'AEO-1' } },
    ])).rejects.toThrow('Linear API request failed: 502 Bad Gateway');
  });

  it('leaves the single-operation path unchanged', async () => {
    const { requests } = graphqlStub((request) => {
      expect(request.query).toContain('query GetIssue');
      expect(request.query).not.toContain('BatchRead');
      expect(request.variables).toEqual({ id: 'AEO-1' });
      return { body: { data: { issue: issueNode(ISSUE_A, 'AEO-1') } } };
    });

    const result = await execute({ operation: 'get_issue', variables: { issue: 'AEO-1' } });
    expect(requests).toHaveLength(1);
    expect(result.details.data.issue).toEqual(issueNode(ISSUE_A, 'AEO-1'));
    expect(result.details).not.toHaveProperty('skipped');
    expect(result.details).not.toHaveProperty('errors');
  });

  it('uses the same exact identity rejection for direct and batch reads', async () => {
    graphqlStub((request) => ({
      body: { data: request.query.includes('BatchRead')
        ? { one: issueNode(ISSUE_A, 'AEO-2') }
        : { issue: issueNode(ISSUE_A, 'AEO-2') } },
    }));
    await expect(execute({ operation: 'get_issue', variables: { issue: 'AEO-1' } }))
      .rejects.toThrow('Linear issue resolver returned mismatched identifier "AEO-2" for "AEO-1".');
    const result = await batch([{ key: 'one', operation: 'get_issue', variables: { issue: 'AEO-1' } }]);
    expect(result.details.errors[0].message)
      .toBe('Linear issue resolver returned mismatched identifier "AEO-2" for "AEO-1".');
  });

  it('keeps a concurrent read-only batch and direct call on their own responses', async () => {
    let releaseBatch!: () => void;
    const batchBlocked = new Promise<void>((resolve) => { releaseBatch = resolve; });
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
      requests.push(request);
      if (request.query.includes('BatchRead')) {
        await batchBlocked;
        return { ok: true, status: 200, statusText: 'OK', headers: new Headers(), json: async () => ({ data: { one: issueNode(ISSUE_A, 'AEO-1', 'batch') } }) };
      }
      releaseBatch();
      return { ok: true, status: 200, statusText: 'OK', headers: new Headers(), json: async () => ({ data: { issue: issueNode(ISSUE_B, 'AEO-2', 'direct') } }) };
    });
    vi.stubGlobal('fetch', fetch);
    process.env.LINEAR_API_KEY = 'test-key';

    const batchCall = batch([{ key: 'one', operation: 'get_issue', variables: { issue: 'AEO-1' } }]);
    const directCall = execute({ operation: 'get_issue', variables: { issue: 'AEO-2' } });
    const [batchResult, directResult] = await Promise.all([batchCall, directCall]);
    expect(requests).toHaveLength(2);
    expect(batchResult.details.data.one.issue.title).toBe('batch');
    expect(directResult.details.data.issue.title).toBe('direct');
  });
});

describe('batch mutation phase', () => {
  const updated = issueNode(ISSUE_A, 'AEO-1', 'New title');

  function mutationEntry(key = 'edit') {
    return { key, operation: 'update_issue', variables: { issue: 'AEO-1', title: 'New title' } };
  }

  it('runs a mutation-only batch as one mutation request', async () => {
    const { requests } = graphqlStub((request) => {
      expect(request.query).toMatch(/mutation/);
      expect(request.query).toContain('edit: issueUpdate');
      return { body: { data: { edit: { success: true, issue: updated } } } };
    });

    const result = await execute({
      operation: 'batch',
      variables: { mutations: [mutationEntry()] },
    });

    expect(requests).toHaveLength(1);
    expect(result.details.data.edit).toEqual({ issueUpdate: { success: true, issue: updated } });
    expect(result.details.errors).toEqual([]);
    expect(result.details.skipped).toEqual([]);
    expect(result.details.meta.requests).toEqual({ read: 0, mutation: 1 });
  });

  it('runs reads then one mutation when both phases succeed', async () => {
    const { requests } = graphqlStub((request) => {
      if (request.query.includes('issueUpdate')) {
        return { body: { data: { edit: { success: true, issue: updated } } } };
      }
      return { body: { data: { one: issueNode(ISSUE_A, 'AEO-1') } } };
    });

    const result = await execute({
      operation: 'batch',
      variables: {
        reads: [{ key: 'one', operation: 'get_issue', variables: { issue: 'AEO-1' } }],
        mutations: [mutationEntry()],
      },
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]!.query).toContain('one: issue');
    expect(requests[1]!.query).toContain('edit: issueUpdate');
    expect(result.details.data).toEqual({
      one: { issue: issueNode(ISSUE_A, 'AEO-1') },
      edit: { issueUpdate: { success: true, issue: updated } },
    });
    expect(result.details.skipped).toEqual([]);
    expect(result.details.meta.requests).toEqual({ read: 1, mutation: 1 });
  });

  it('skips the mutation when a read alias fails', async () => {
    const { requests } = graphqlStub((request) => {
      expect(request.query).not.toMatch(/mutation/);
      return {
        body: {
          data: { ready: issueNode(ISSUE_A, 'AEO-1'), missing: null },
          errors: [{ message: 'Entity not found: Issue', path: ['missing'] }],
        },
      };
    });

    const result = await execute({
      operation: 'batch',
      variables: {
        reads: [
          { key: 'ready', operation: 'get_issue', variables: { issue: 'AEO-1' } },
          { key: 'missing', operation: 'get_issue', variables: { issue: 'AEO-2' } },
        ],
        mutations: [mutationEntry()],
      },
    });

    expect(requests).toHaveLength(1);
    expect(result.details.data).toEqual({ ready: { issue: issueNode(ISSUE_A, 'AEO-1') } });
    expect(result.details.errors).toEqual([
      { key: 'missing', path: ['missing'], message: 'Entity not found: Issue' },
    ]);
    expect(result.details.skipped).toEqual(['edit']);
    expect(result.details.meta.requests).toEqual({ read: 1, mutation: 0 });
  });

  it('rejects mutations in read-only mode before network access', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    process.env.LINEAR_API_KEY = 'test-key';
    await expect(execute({
      operation: 'batch',
      variables: { mutations: [mutationEntry()] },
    }, 'readonly')).rejects.toThrow(/read-only/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects destructive named input before network access', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    process.env.LINEAR_API_KEY = 'test-key';
    await expect(execute({
      operation: 'batch',
      variables: {
        mutations: [{
          key: 'edit',
          operation: 'update_issue',
          variables: { issue: 'AEO-1', input: { title: 'New title', trashed: true } },
        }],
      },
    })).rejects.toThrow(/trashed|destructive/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a mutation whose prepare would call Linear', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    process.env.LINEAR_API_KEY = 'test-key';
    await expect(execute({
      operation: 'batch',
      variables: {
        mutations: [{
          key: 'write',
          operation: 'create_cycle',
          variables: { team: 'AEO', startsAt: '2026-08-17', endsAt: '2026-08-31' },
        }],
      },
    })).rejects.toThrow(/preparation|fold/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects two mutations and create-only transaction sets before network access', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    process.env.LINEAR_API_KEY = 'test-key';
    await expect(execute({
      operation: 'batch',
      variables: {
        mutations: [mutationEntry('one'), mutationEntry('two')],
      },
    })).rejects.toThrow(/one ordinary named mutation/i);
    await expect(execute({
      operation: 'batch',
      variables: {
        mutations: [
          { key: 'a', operation: 'create_issue', variables: { title: 'A', team: 'AEO' } },
          mutationEntry('b'),
        ],
      },
    })).rejects.toThrow(/mixed|one ordinary named mutation/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps successful reads when the mutation alias has a path error', async () => {
    const { requests } = graphqlStub((request) => {
      if (request.query.includes('issueUpdate')) {
        return {
          body: {
            data: { edit: null },
            errors: [{ message: 'Issue not found', path: ['edit'] }],
          },
        };
      }
      return { body: { data: { one: issueNode(ISSUE_A, 'AEO-1') } } };
    });

    const result = await execute({
      operation: 'batch',
      variables: {
        reads: [{ key: 'one', operation: 'get_issue', variables: { issue: 'AEO-1' } }],
        mutations: [mutationEntry()],
      },
    });

    expect(requests).toHaveLength(2);
    expect(result.details.data).toEqual({ one: { issue: issueNode(ISSUE_A, 'AEO-1') } });
    expect(result.details.errors).toEqual([
      { key: 'edit', path: ['edit'], message: 'Issue not found' },
    ]);
    expect(result.details.skipped).toEqual([]);
    expect(result.details.meta.requests).toEqual({ read: 1, mutation: 1 });
  });

  it('preserves mutation transport failures', async () => {
    graphqlStub((request) => {
      if (request.query.includes('issueUpdate')) return { throw: new Error('socket closed') };
      return { body: { data: { one: issueNode(ISSUE_A, 'AEO-1') } } };
    });
    await expect(execute({
      operation: 'batch',
      variables: {
        reads: [{ key: 'one', operation: 'get_issue', variables: { issue: 'AEO-1' } }],
        mutations: [mutationEntry()],
      },
    })).rejects.toThrow('Linear network error: socket closed');
  });
});

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATE_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '55555555-5555-4555-8555-555555555555';
const PROJECT_ID = '66666666-6666-4666-8666-666666666666';
const LABEL_ID = '77777777-7777-4777-8777-777777777777';

function aliases(query: string, field: string): string[] {
  return [...query.matchAll(new RegExp(`(\\w+)\\s*:\\s*${field}\\b`, 'g'))].map((match) => match[1]!);
}

function lookupData(query: string, overrides: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = {};
  const user = { id: USER_ID, name: 'Me', displayName: 'Me', email: 'me@example.com' };
  for (const alias of aliases(query, 'teams')) data[alias] = { nodes: [{ id: TEAM_ID, key: 'AEO' }] };
  for (const alias of aliases(query, 'team')) data[alias] = { id: TEAM_ID, key: 'AEO' };
  for (const alias of aliases(query, 'workflowStates')) {
    data[alias] = { nodes: [{ id: STATE_ID, name: 'Todo', team: { id: TEAM_ID, key: 'AEO' } }] };
  }
  for (const alias of aliases(query, 'workflowState')) {
    data[alias] = { id: STATE_ID, name: 'Todo', team: { id: TEAM_ID } };
  }
  for (const alias of aliases(query, 'viewer')) data[alias] = user;
  for (const alias of aliases(query, 'user')) data[alias] = user;
  for (const alias of aliases(query, 'users')) data[alias] = { nodes: [user] };
  for (const alias of aliases(query, 'projects')) data[alias] = { nodes: [{ id: PROJECT_ID, name: 'Dispatch' }] };
  for (const alias of aliases(query, 'issue')) data[alias] = issueNode(ISSUE_A, 'AEO-1');
  return { ...data, ...overrides };
}

function createIssue(key: string, title: string, extra: Record<string, unknown> = {}) {
  return { key, operation: 'create_issue', variables: { title, team: 'AEO', ...extra } };
}

function batchIssues(request: { variables: Record<string, unknown> }) {
  const input = request.variables.input as { issues?: Array<{ id: string; title: string; teamId?: string; stateId?: string; assigneeId?: string }> };
  return input.issues ?? [];
}

describe('batch transactional create', () => {
  it('maps two creates by generated id when Linear returns issues in reverse order', async () => {
    const { requests } = graphqlStub((request) => {
      if (request.query.includes('issueBatchCreate')) {
        const issues = batchIssues(request);
        expect(issues).toHaveLength(2);
        expect(issues[0]!.id).toMatch(UUID_V4);
        expect(issues[1]!.id).toMatch(UUID_V4);
        expect(issues[0]!.id).not.toBe(issues[1]!.id);
        const byTitle = Object.fromEntries(issues.map((issue) => [issue.title, issue.id]));
        return {
          body: {
            data: {
              issueBatchCreate: {
                success: true,
                issues: [
                  { id: byTitle.B, identifier: 'AEO-2', title: 'B', team: { id: TEAM_ID, key: 'AEO' } },
                  { id: byTitle.A, identifier: 'AEO-1', title: 'A', team: { id: TEAM_ID, key: 'AEO' } },
                ],
              },
            },
          },
        };
      }
      return { body: { data: lookupData(request.query) } };
    });

    const result = await execute({
      operation: 'batch',
      variables: {
        mutations: [
          { operation: 'create_issue', variables: { title: 'A', team: 'AEO' } },
          { operation: 'create_issue', variables: { title: 'B', team: 'AEO' } },
        ],
      },
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]!.query).toMatch(/query/);
    expect(requests[0]!.query).not.toMatch(/mutation/);
    expect(requests[1]!.query).toContain('issueBatchCreate');
    expect(requests[1]!.query).not.toContain('issueCreate');
    expect(result.details.data.create_issue.issueCreate.issue.title).toBe('A');
    expect(result.details.data.create_issue_2.issueCreate.issue.title).toBe('B');
    expect(result.details.data.create_issue.issueCreate.issue.id).toBe(batchIssues(requests[1]!).find((issue) => issue.title === 'A')!.id);
    expect(result.details.data.create_issue_2.issueCreate.issue.id).toBe(batchIssues(requests[1]!).find((issue) => issue.title === 'B')!.id);
    expect(result.details.errors).toEqual([]);
    expect(result.details.skipped).toEqual([]);
    expect(result.details.meta.requests).toEqual({ read: 1, mutation: 1 });
  });

  it('folds team, state, and assignee lookups into one read request', async () => {
    const { requests } = graphqlStub((request) => {
      if (request.query.includes('issueBatchCreate')) {
        const issues = batchIssues(request);
        expect(issues.every((issue) => issue.teamId === TEAM_ID)).toBe(true);
        expect(issues.every((issue) => issue.stateId === STATE_ID)).toBe(true);
        expect(issues.every((issue) => issue.assigneeId === USER_ID)).toBe(true);
        return {
          body: {
            data: {
              issueBatchCreate: {
                success: true,
                issues: issues.map((issue, index) => ({
                  id: issue.id,
                  identifier: `AEO-${index + 1}`,
                  title: issue.title,
                })),
              },
            },
          },
        };
      }
      expect(request.query).toMatch(/teams|team\(/);
      expect(request.query).toMatch(/workflowStates/);
      expect(request.query).toMatch(/viewer/);
      expect(request.query).not.toMatch(/mutation/);
      return { body: { data: lookupData(request.query) } };
    });

    const result = await execute({
      operation: 'batch',
      variables: {
        mutations: [
          createIssue('one', 'A', { state: 'Todo', assignee: 'me' }),
          createIssue('two', 'B', { state: 'Todo', assignee: 'me' }),
        ],
      },
    });

    expect(requests).toHaveLength(2);
    expect(result.details.errors).toEqual([]);
    expect(Object.keys(result.details.data).sort()).toEqual(['one', 'two']);
    expect(result.details.meta.requests).toEqual({ read: 1, mutation: 1 });
  });

  it('shares one read lookup phase plus one mutation request with caller reads', async () => {
    const { requests } = graphqlStub((request) => {
      if (request.query.includes('issueBatchCreate')) {
        const issues = batchIssues(request);
        return {
          body: {
            data: {
              issueBatchCreate: {
                success: true,
                issues: issues.map((issue) => ({ id: issue.id, identifier: 'AEO-9', title: issue.title })),
              },
            },
          },
        };
      }
      expect(request.query).toContain('ready: issue');
      expect(request.query).toMatch(/teams|team\(/);
      expect(request.query).not.toMatch(/mutation/);
      return { body: { data: lookupData(request.query) } };
    });

    const result = await execute({
      operation: 'batch',
      variables: {
        reads: [{ key: 'ready', operation: 'get_issue', variables: { issue: 'AEO-1' } }],
        mutations: [createIssue('one', 'A'), createIssue('two', 'B')],
      },
    });

    expect(requests).toHaveLength(2);
    expect(result.details.data.ready.issue).toEqual(issueNode(ISSUE_A, 'AEO-1'));
    expect(result.details.data.one.issueCreate.issue.title).toBe('A');
    expect(result.details.data.two.issueCreate.issue.title).toBe('B');
    expect(result.details.meta.requests).toEqual({ read: 1, mutation: 1 });
  });

  it('rejects parent-only plus state name before any request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    process.env.LINEAR_API_KEY = 'test-key';
    await expect(execute({
      operation: 'batch',
      variables: {
        mutations: [{
          key: 'child',
          operation: 'create_issue',
          variables: { title: 'Child', parent: 'AEO-1', state: 'Todo' },
        }],
      },
    })).rejects.toThrow(/state name|explicit team|sequential/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('skips every create when a preparation lookup fails', async () => {
    const { requests } = graphqlStub((request) => {
      expect(request.query).not.toMatch(/mutation/);
      const data = lookupData(request.query);
      const teamAlias = aliases(request.query, 'teams')[0] ?? aliases(request.query, 'team')[0];
      return {
        body: {
          data: teamAlias ? { ...data, [teamAlias]: { nodes: [] } } : data,
          errors: teamAlias ? [{ message: `missing team ${TOKEN}`, path: [teamAlias] }] : [],
        },
      };
    });

    const result = await execute({
      operation: 'batch',
      variables: { mutations: [createIssue('one', 'A'), createIssue('two', 'B')] },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.query).not.toMatch(/mutation/);
    expect(result.details.data).toEqual({});
    expect(result.details.errors).toEqual([]);
    expect(JSON.stringify(result.details)).not.toContain(TOKEN);
    expect(result.details.skipped.sort()).toEqual(['one', 'two']);
    expect(result.details.meta.requests).toEqual({ read: 1, mutation: 0 });
  });

  it('returns keyed errors when returned issue ids are missing or duplicated', async () => {
    let round = 0;
    graphqlStub((request) => {
      if (!request.query.includes('issueBatchCreate')) return { body: { data: lookupData(request.query) } };
      const issues = batchIssues(request);
      round += 1;
      const payload = round === 1
        ? { success: true, issues: [{ id: issues[0]!.id, title: 'A' }] }
        : { success: true, issues: [{ id: issues[0]!.id, title: 'A' }, { id: issues[0]!.id, title: 'B' }] };
      return { body: { data: { issueBatchCreate: payload } } };
    });

    const missing = await execute({
      operation: 'batch',
      variables: { mutations: [createIssue('one', 'A'), createIssue('two', 'B')] },
    });
    expect(missing.details.data).toEqual({});
    expect(missing.details.errors.map((error: { key: string }) => error.key).sort()).toEqual(['one', 'two']);
    expect(missing.details.skipped).toEqual([]);
    expect(missing.details.meta.requests).toEqual({ read: 1, mutation: 1 });

    const duplicated = await execute({
      operation: 'batch',
      variables: { mutations: [createIssue('one', 'A'), createIssue('two', 'B')] },
    });
    expect(duplicated.details.data).toEqual({});
    expect(duplicated.details.errors.map((error: { key: string }) => error.key).sort()).toEqual(['one', 'two']);
    expect(duplicated.details.meta.requests).toEqual({ read: 1, mutation: 1 });
  });

  it('returns keyed errors when issueBatchCreate.success is false', async () => {
    graphqlStub((request) => {
      if (!request.query.includes('issueBatchCreate')) return { body: { data: lookupData(request.query) } };
      return { body: { data: { issueBatchCreate: { success: false, issues: [] } } } };
    });

    const result = await execute({
      operation: 'batch',
      variables: { mutations: [createIssue('one', 'A'), createIssue('two', 'B')] },
    });
    expect(result.details.data).toEqual({});
    expect(result.details.errors.map((error: { key: string }) => error.key).sort()).toEqual(['one', 'two']);
    expect(result.details.skipped).toEqual([]);
    expect(result.details.meta.requests).toEqual({ read: 1, mutation: 1 });
  });

  it('maps an indexed transaction error only to its returned issue', async () => {
    graphqlStub((request) => {
      if (!request.query.includes('issueBatchCreate')) return { body: { data: lookupData(request.query) } };
      const issues = batchIssues(request);
      return {
        body: {
          data: {
            issueBatchCreate: {
              success: true,
              issues: [
                { id: issues[1]!.id, identifier: 'AEO-2', title: 'B' },
                { id: issues[0]!.id, identifier: 'AEO-1', title: 'A', description: null },
              ],
            },
          },
          errors: [{ message: 'Description unavailable', path: ['issueBatchCreate', 'issues', 1, 'description'] }],
        },
      };
    });

    const result = await execute({
      operation: 'batch',
      variables: {
        mutations: [
          { operation: 'create_issue', variables: { title: 'A', team: 'AEO' } },
          { operation: 'create_issue', variables: { title: 'B', team: 'AEO' } },
        ],
      },
    });

    expect(result.details.data).toEqual({
      create_issue_2: { issueCreate: { success: true, issue: expect.objectContaining({ identifier: 'AEO-2', title: 'B' }) } },
    });
    expect(result.details.errors).toEqual([{
      key: 'create_issue',
      path: ['issueBatchCreate', 'issues', 1, 'description'],
      message: 'Description unavailable',
      partial: { issueCreate: { success: true, issue: expect.objectContaining({ identifier: 'AEO-1', title: 'A' }) } },
    }]);
    expect(result.details.skipped).toEqual([]);
  });

  it('returns keyed errors for GraphQL path errors on the transaction', async () => {
    graphqlStub((request) => {
      if (!request.query.includes('issueBatchCreate')) return { body: { data: lookupData(request.query) } };
      return {
        body: {
          data: { issueBatchCreate: null },
          errors: [{ message: `denied ${TOKEN}`, path: ['issueBatchCreate'] }],
        },
      };
    });

    const result = await execute({
      operation: 'batch',
      variables: { mutations: [createIssue('one', 'A'), createIssue('two', 'B')] },
    });
    expect(result.details.data).toEqual({});
    expect(result.details.errors).toEqual([
      { key: 'one', path: ['issueBatchCreate'], message: expect.stringMatching(/denied/) },
      { key: 'two', path: ['issueBatchCreate'], message: expect.stringMatching(/denied/) },
    ]);
    expect(JSON.stringify(result.details)).not.toContain(TOKEN);
    expect(result.details.skipped).toEqual([]);
    expect(result.details.meta.requests).toEqual({ read: 1, mutation: 1 });
  });

  it('redacts credentials from transactional create data', async () => {
    graphqlStub((request) => {
      if (!request.query.includes('issueBatchCreate')) return { body: { data: lookupData(request.query) } };
      const issues = batchIssues(request);
      return {
        body: {
          data: {
            issueBatchCreate: {
              success: true,
              issues: issues.map((issue) => ({ id: issue.id, identifier: 'AEO-1', title: `see ${TOKEN}` })),
            },
          },
        },
      };
    });

    const result = await execute({
      operation: 'batch',
      variables: { mutations: [createIssue('one', 'A'), createIssue('two', 'B')] },
    });
    const text = JSON.stringify(result.details);
    expect(text).not.toContain(TOKEN);
    expect(text).toContain('[REDACTED]');
  });

  it('rejects transactional creates in read-only mode before network access', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    process.env.LINEAR_API_KEY = 'test-key';
    await expect(execute({
      operation: 'batch',
      variables: { mutations: [createIssue('one', 'A'), createIssue('two', 'B')] },
    }, 'readonly')).rejects.toThrow(/read-only/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('runs one create_issue as an ordinary mutation after folded lookups', async () => {
    const { requests } = graphqlStub((request) => {
      if (request.query.includes('issueCreate')) {
        expect(request.query).not.toContain('issueBatchCreate');
        return {
          body: {
            data: {
              write: { success: true, issue: { id: ISSUE_A, identifier: 'AEO-1', title: 'Solo' } },
            },
          },
        };
      }
      return { body: { data: lookupData(request.query) } };
    });

    const result = await execute({
      operation: 'batch',
      variables: { mutations: [createIssue('write', 'Solo')] },
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.query).toContain('write: issueCreate');
    expect(result.details.data.write.issueCreate.issue.title).toBe('Solo');
    expect(result.details.meta.requests).toEqual({ read: 1, mutation: 1 });
  });

  it('converts loader project and labels aliases inside a batch create', async () => {
    const { requests } = graphqlStub((request) => {
      if (request.query.includes('issueCreate')) {
        const input = Object.values(request.variables).find((value) =>
          typeof value === 'object' && value !== null && 'projectId' in value,
        ) as Record<string, unknown>;
        expect(input).toMatchObject({ projectId: PROJECT_ID, labelIds: [LABEL_ID] });
        expect(input).not.toHaveProperty('project');
        expect(input).not.toHaveProperty('labels');
        return { body: { data: { write: { success: true, issue: { id: ISSUE_A, identifier: 'AEO-1', title: 'Solo' } } } } };
      }
      return { body: { data: lookupData(request.query) } };
    });
    const result = await execute({
      operation: 'batch',
      variables: { mutations: [createIssue('write', 'Solo', { project: 'Dispatch', labels: [LABEL_ID] })] },
    });
    expect(requests).toHaveLength(2);
    expect(result.details.data.write.issueCreate.issue.title).toBe('Solo');
  });

  it('leaves the single-operation create_issue path on issueCreate', async () => {
    const { requests } = graphqlStub((request) => {
      if (request.query.includes('issueCreate')) {
        expect(request.query).toContain('mutation CreateIssue');
        expect(request.query).not.toContain('issueBatchCreate');
        expect(request.query).not.toContain('Batch');
        return { body: { data: { issueCreate: { success: true, issue: { id: ISSUE_A, identifier: 'AEO-1', title: 'Solo' } } } } };
      }
      return { body: { data: { teams: { nodes: [{ id: TEAM_ID, key: 'AEO' }] } } } };
    });

    const result = await execute({ operation: 'create_issue', variables: { title: 'Solo', team: 'AEO' } });
    expect(requests.some((request) => request.query.includes('issueCreate'))).toBe(true);
    expect(requests.every((request) => !request.query.includes('issueBatchCreate'))).toBe(true);
    expect(result.details.data.issueCreate.issue.title).toBe('Solo');
    expect(result.details).not.toHaveProperty('skipped');
  });
});

describe('exact batch accounting and routing', () => {
  it('preserves all 30 aliases and every selected field across auto, inline, and artifact recovery', async () => {
    await useArtifactRoot();
    const reads = Array.from({ length: 30 }, (_, index) => ({
      key: `item${index + 1}`,
      operation: 'get_issue',
      variables: { issue: `AEO-${index + 1}` },
    }));
    graphqlStub((request) => ({
      body: {
        data: Object.fromEntries(reads.map((entry, index) => [entry.key, {
          id: `${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`,
          identifier: entry.variables.issue,
          title: `Issue ${index + 1}`,
          description: `field-${index + 1}-${'x'.repeat(120)}`,
          team: { id: TEAM_ID, key: 'AEO' },
        }])),
      },
    }));

    const run = async (sink?: 'inline' | 'artifact') => {
      const result = await execute({ operation: 'batch', variables: { reads }, ...(sink ? { sink } : {}) });
      if (!result.details.handle) return result.details;
      const recovered = await execute({
        operation: 'get_result',
        variables: { handle: result.details.handle },
      });
      return recovered.details.data.value;
    };

    process.env.LINEAR_SPILL_BYTES = '100';
    const auto = await run();
    const inline = await run('inline');
    const artifact = await run('artifact');
    for (const envelope of [auto, inline, artifact]) {
      expect(Object.keys(envelope.data)).toEqual(reads.map(({ key }) => key));
      expect(envelope.errors).toEqual([]);
      expect(envelope.skipped).toEqual([]);
      expect(envelope.meta.requests).toEqual({ read: 1, mutation: 0 });
      expect(envelope.meta.aliases).toBe(30);
      for (const [index, entry] of reads.entries()) {
        expect(envelope.data[entry.key].issue).toMatchObject({
          identifier: entry.variables.issue,
          title: `Issue ${index + 1}`,
          description: `field-${index + 1}-${'x'.repeat(120)}`,
          team: { id: TEAM_ID, key: 'AEO' },
        });
      }
    }
    expect(auto.data).toEqual(inline.data);
    expect(artifact.data).toEqual(inline.data);
  });

  it('falls back from inline at Pi output boundary and recovers the complete batch field', async () => {
    await useArtifactRoot();
    const description = 'batch-boundary-'.repeat(5_000);
    graphqlStub(() => ({
      body: {
        data: {
          one: { id: ISSUE_A, identifier: 'AEO-1', title: 'Large', description, team: { id: TEAM_ID, key: 'AEO' } },
        },
      },
    }));
    const result = await execute({
      operation: 'batch',
      variables: { reads: [{ key: 'one', operation: 'get_issue', variables: { issue: 'AEO-1' } }] },
      sink: 'inline',
    });
    expect(result.details).toMatchObject({
      handle: expect.stringMatching(/^linear-result:v1:/),
      meta: { routing: { requestedSink: 'inline', actualSink: 'artifact', reason: 'tool-output-boundary' } },
    });

    let offset = 0;
    let recovered = '';
    do {
      const part = await execute({
        operation: 'get_result',
        variables: { handle: result.details.handle, path: '/data/one/issue/description', offset },
      });
      recovered += part.details.data.value;
      offset = part.details.meta.retrieval.nextOffset;
    } while (offset !== undefined);
    expect(recovered).toBe(description);
  });

  it('consolidates multiple path errors for one key and preserves partial data and a successful sibling', async () => {
    graphqlStub(() => ({
      body: {
        data: {
          partial: { id: ISSUE_A, identifier: 'AEO-1', title: 'Known', description: null, team: { id: TEAM_ID, key: 'AEO' } },
          ready: issueNode(ISSUE_B, 'AEO-2'),
        },
        errors: [
          { message: 'Description unavailable', path: ['partial', 'description'] },
          { message: 'Comments unavailable', path: ['partial', 'comments'] },
        ],
      },
    }));

    const result = await batch([
      { key: 'partial', operation: 'get_issue', variables: { issue: 'AEO-1' } },
      { key: 'ready', operation: 'get_issue', variables: { issue: 'AEO-2' } },
    ]);

    expect(result.details.data).toEqual({ ready: { issue: issueNode(ISSUE_B, 'AEO-2') } });
    expect(result.details.errors).toEqual([{
      key: 'partial',
      path: ['partial', 'description'],
      message: 'Description unavailable',
      causes: [
        { path: ['partial', 'description'], message: 'Description unavailable' },
        { path: ['partial', 'comments'], message: 'Comments unavailable' },
      ],
      partial: {
        issue: { id: ISSUE_A, identifier: 'AEO-1', title: 'Known', description: null, team: { id: TEAM_ID, key: 'AEO' } },
      },
    }]);
    expect(result.details.skipped).toEqual([]);
  });

  it('keeps a mutation skipped after a read failure only in skipped', async () => {
    graphqlStub(() => ({
      body: {
        data: { missing: null, ready: issueNode(ISSUE_B, 'AEO-2') },
        errors: [{ message: 'Not found', path: ['missing'] }],
      },
    }));
    const result = await execute({
      operation: 'batch',
      variables: {
        reads: [
          { key: 'missing', operation: 'get_issue', variables: { issue: 'AEO-1' } },
          { key: 'ready', operation: 'get_issue', variables: { issue: 'AEO-2' } },
        ],
        mutations: [{ key: 'edit', operation: 'update_issue', variables: { issue: 'AEO-1', title: 'New title' } }],
      },
    });
    expect(result.details.errors.map((error: { key: string }) => error.key)).toEqual(['missing']);
    expect(result.details.skipped).toEqual(['edit']);
    expect(result.details.data).not.toHaveProperty('edit');
  });

  it('rejects duplicate buckets, duplicate records, missing keys, and unexpected keys', () => {
    const valid = { data: { one: {} }, errors: [{ key: 'two', path: ['two'], message: 'failed' }], skipped: ['three'] };
    expect(() => assertBatchAccounting(['one', 'two', 'three'], valid.data, valid.errors, valid.skipped)).not.toThrow();
    expect(() => assertBatchAccounting(['one'], { one: {} }, [{ key: 'one', path: ['one'], message: 'failed' }], []))
      .toThrow(/accounting/i);
    expect(() => assertBatchAccounting(['one'], {}, [
      { key: 'one', path: ['one'], message: 'first' },
      { key: 'one', path: ['one'], message: 'second' },
    ], [])).toThrow(/accounting/i);
    expect(() => assertBatchAccounting(['one'], {}, [], [])).toThrow(/accounting/i);
    expect(() => assertBatchAccounting(['one'], { extra: {} }, [], ['one'])).toThrow(/accounting/i);
  });

  it('passes top-level sink through batch execution with a generated key', async () => {
    await useArtifactRoot();
    graphqlStub(() => ({ body: { data: { get_issue: issueNode(ISSUE_A, 'AEO-1') } } }));
    const result = await execute({
      operation: 'batch',
      variables: { operations: [{ operation: 'get_issue', variables: { issue: 'AEO-1' } }] },
      sink: 'artifact',
    });
    expect(result.details).toMatchObject({
      handle: expect.stringMatching(/^linear-result:v1:/),
      meta: { routing: { requestedSink: 'artifact', actualSink: 'artifact', reason: 'requested' } },
    });
    const recovered = await execute({ operation: 'get_result', variables: { handle: result.details.handle } });
    expect(recovered.details.data.value).toMatchObject({
      data: { get_issue: { issue: issueNode(ISSUE_A, 'AEO-1') } },
      errors: [],
      skipped: [],
      meta: { requests: { read: 1, mutation: 0 }, aliases: 1 },
    });
  });
});
