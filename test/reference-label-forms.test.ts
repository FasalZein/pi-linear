import { afterEach, describe, expect, it, vi } from 'vitest';
import { linearBatchTool } from '../extensions/api';
import type { JsonObject } from '../extensions/json';
import { operations } from '../extensions/operations';
import { typedLinearTools } from '../extensions/typed-tools';
import { isolateLinearCredentials } from './helpers/credentials';
import type { CompatibilityObject } from '../extensions/operation-types';

isolateLinearCredentials();

const TEAM_ID = '11111111-1111-4111-8111-111111111111';
const LABEL_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_LABEL_ID = '33333333-3333-4333-8333-333333333333';
const ISSUE_ID = '44444444-4444-4444-8444-444444444444';
const originalApiKey = process.env.LINEAR_API_KEY;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalApiKey === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = originalApiKey;
});

type Recorded = { query: string; variables: CompatibilityObject };

/** Answer one compiled batch read with the alias keys the batch itself requested. */
function batchReadData(query: string, labelNodes: CompatibilityObject[]): CompatibilityObject {
  const data: CompatibilityObject = {};
  for (const [, alias, root] of query.matchAll(/(\w+): (team|issueLabels)\(/g)) {
    data[alias!] = root === 'team'
      ? { id: TEAM_ID, key: 'AEO' }
      : { nodes: labelNodes };
  }
  return data;
}

function installServer(labelNodes: CompatibilityObject[]) {
  const requests: Recorded[] = [];
  process.env.LINEAR_API_KEY = 'test-key';
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as Recorded;
    requests.push(request);
    const data = request.query.includes('query BatchRead')
      ? batchReadData(request.query, labelNodes)
      : request.query.includes('created: issueCreate')
        ? { created: { success: true, issue: { id: ISSUE_ID, identifier: 'AEO-1', title: 'Labelled issue' } } }
        : request.query.includes('ResolveTeamById')
          ? { team: { id: request.variables.id, key: 'AEO', name: 'Team' } }
          : request.query.includes('ResolveNamedEntityById')
            ? { issueLabel: { id: request.variables.id, name: 'bug' } }
            : request.query.includes('ResolveNamedEntityByName')
              ? { issueLabels: { nodes: labelNodes } }
              : { issueCreate: { success: true, issue: { id: ISSUE_ID, identifier: 'AEO-1', title: 'Labelled issue' } } };
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  return requests;
}

function createIssueTool() {
  return typedLinearTools().find(({ name }) => name === 'linear_create_issue')!;
}

function execute(params: CompatibilityObject) {
  return (createIssueTool() as any).execute('call-1', params, undefined, undefined, { hasUI: false });
}

function mutations(requests: readonly Recorded[]) {
  return requests.filter(({ query }) => query.includes('issueCreate'));
}

describe('create_issue label reference forms', () => {
  it('resolves exact label names before the write', async () => {
    const requests = installServer([{ id: LABEL_ID, name: 'bug' }]);

    const result = await execute({ title: 'Labelled issue', team: TEAM_ID, labels: ['bug'] });

    const written = mutations(requests);
    expect(written).toHaveLength(1);
    expect(written[0]!.variables).toEqual({
      input: { title: 'Labelled issue', teamId: TEAM_ID, labelIds: [LABEL_ID] },
    });
    expect(result.details.resolution.labels).toEqual([{ requested: 'bug', resolvedId: LABEL_ID }]);
    expect(requests.some(({ query }) => query.includes('ResolveNamedEntityByName'))).toBe(true);
  });

  it('verifies exact label UUIDs before the write', async () => {
    const requests = installServer([]);

    await execute({ title: 'Labelled issue', team: TEAM_ID, labels: [LABEL_ID] });

    const written = mutations(requests);
    expect(written).toHaveLength(1);
    expect(written[0]!.variables).toEqual({
      input: { title: 'Labelled issue', teamId: TEAM_ID, labelIds: [LABEL_ID] },
    });
    expect(requests.some(({ query }) => query.includes('ResolveNamedEntityById'))).toBe(true);
  });

  it('sends no write when a label name matches no label', async () => {
    const requests = installServer([]);

    await expect(execute({ title: 'Labelled issue', team: TEAM_ID, labels: ['bug'] }))
      .rejects.toThrow('Linear issueLabel "bug" resolved to 0 matches; expected exactly one.');
    expect(mutations(requests)).toHaveLength(0);
  });

  it('sends no write when a label name matches more than one label', async () => {
    const requests = installServer([{ id: LABEL_ID, name: 'bug' }, { id: OTHER_LABEL_ID, name: 'bug' }]);

    await expect(execute({ title: 'Labelled issue', team: TEAM_ID, labels: ['bug'] }))
      .rejects.toThrow('Linear issueLabel "bug" resolved to 2 matches; expected exactly one.');
    expect(mutations(requests)).toHaveLength(0);
  });

  it('rejects an empty or blank canonical label list before any request', async () => {
    const requests = installServer([{ id: LABEL_ID, name: 'bug' }]);

    for (const labels of [[], [' ']]) {
      await expect(execute({ title: 'Labelled issue', team: TEAM_ID, labels }))
        .rejects.toThrow('labels must be a non-empty list of exact issue-label names or UUIDs');
    }
    expect(requests).toHaveLength(0);
  });

  it('keeps every legacy labelIds path UUID-only', () => {
    const validate = operations.create_issue!.validateVariables!;
    const base = { title: 'Labelled issue', teamId: TEAM_ID };

    expect(() => validate({ ...base, labelIds: ['bug'] }))
      .toThrow('labelIds must be a non-empty list of exact issue-label UUIDs');
    expect(() => validate({ ...base, input: { title: 'T', teamId: TEAM_ID, labelIds: ['bug'] } }))
      .toThrow('labelIds must be a non-empty list of exact issue-label UUIDs');
    expect(() => validate({ ...base, labelIds: [LABEL_ID] })).not.toThrow();
    expect(() => validate({ ...base, labels: ['bug'] })).not.toThrow();
    expect(() => validate({ ...base, labels: ['bug'], input: { title: 'T', teamId: TEAM_ID, labelIds: [LABEL_ID] } }))
      .toThrow('labels, labelIds, and input.labelIds conflict; send exactly one');
  });

  it('accepts label names and rejects legacy label names in batch preflight', async () => {
    const requests = installServer([{ id: LABEL_ID, name: 'bug' }]);
    const batch = (variables: JsonObject) => (linearBatchTool('allowlist') as any)
      .execute('call-1', variables, undefined, undefined, { hasUI: false });

    await expect(batch({
      mutations: [{ key: 'created', operation: 'create_issue', variables: { title: 'Labelled issue', teamId: TEAM_ID, labelIds: ['bug'] } }],
    })).rejects.toThrow('labelIds must be a non-empty list of exact issue-label UUIDs');
    expect(mutations(requests)).toHaveLength(0);

    const accepted = await batch({
      mutations: [{ key: 'created', operation: 'create_issue', variables: { title: 'Labelled issue', team: TEAM_ID, labels: ['bug'] } }],
    });
    expect(accepted.details.data.created.issueCreate.issue.id).toBe(ISSUE_ID);
    const preflight = requests.filter(({ query }) => query.includes('query BatchRead'));
    expect(preflight).toHaveLength(1);
    expect(preflight[0]!.query).toContain('issueLabels(');
    expect(Object.values(preflight[0]!.variables)).toContain('bug');
  });
});
