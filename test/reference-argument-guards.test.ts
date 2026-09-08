import { afterEach, describe, expect, it, vi } from 'vitest';
import { linearBatchTool } from '../extensions/api';
import { typedLinearTools } from '../extensions/typed-tools';
import { isolateLinearCredentials } from './helpers/credentials';
import type { CompatibilityObject } from '../extensions/operation-types';

isolateLinearCredentials();

const TEAM_ID = '11111111-1111-4111-8111-111111111111';
const LABEL_ID = '22222222-2222-4222-8222-222222222222';
const ISSUE_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const originalApiKey = process.env.LINEAR_API_KEY;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalApiKey === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = originalApiKey;
});

/** Refuse every network call: these guards must reject before any request is sent. */
function noNetwork() {
  const fetch = vi.fn(async () => {
    throw new Error('No request may be sent for a rejected reference argument.');
  });
  process.env.LINEAR_API_KEY = 'test-key';
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function resolvingServer() {
  const requests: Array<{ query: string; variables: CompatibilityObject }> = [];
  process.env.LINEAR_API_KEY = 'test-key';
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as { query: string; variables: CompatibilityObject };
    requests.push(request);
    const id = request.variables.id;
    const data: CompatibilityObject = request.query.includes('ResolveNamedEntityById')
      ? { issueLabel: { id, name: 'bug' }, projectLabel: { id, name: 'bug' } }
      : request.query.includes('ResolveUserByIdentity')
        ? { byName: { nodes: [{ id: USER_ID, name: 'person', displayName: 'person', email: 'person@example.com' }] } }
        : request.query.includes('ResolveUserById')
          ? { user: { id: USER_ID, name: 'person', displayName: 'person', email: 'person@example.com' } }
          : request.query.includes('ResolveNamedEntityByName')
            ? { issueLabels: { nodes: [{ id: LABEL_ID, name: 'bug' }] } }
        : request.query.includes('ResolveIssue')
          ? { issue: { id: ISSUE_ID, identifier: 'AEO-1', title: 'Issue', team: { id: TEAM_ID, key: 'AEO' } } }
          : { issueUpdate: { success: true, issue: { id: ISSUE_ID, identifier: 'AEO-1', title: 'Issue' } } };
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  return requests;
}

/**
 * The batch surface carries entry variables straight to the operation guards: unlike a typed
 * tool call there is no per-parameter JSON schema in front of them, so these are the guards a
 * batch caller actually meets.
 */
function batched(operation: string, variables: CompatibilityObject) {
  return (linearBatchTool('allowlist') as any).execute(
    'call-1',
    { mutations: [{ key: 'entry', operation, variables }] },
    undefined,
    undefined,
    { hasUI: false },
  );
}

function typed(operation: string, variables: CompatibilityObject) {
  const tool = typedLinearTools().find((candidate) => candidate.name === `linear_${operation}`);
  if (!tool) throw new Error(`Missing typed tool for ${operation}.`);
  return (tool as any).execute('call-1', variables, undefined, undefined, { hasUI: false });
}

describe('reference list arguments are screened before any request', () => {
  it.each([
    ['an empty list', [], /one or more non-empty strings/],
    ['a blank entry', [''], /one or more non-empty strings/],
    ['a blank entry beside a real one', ['bug', '   '], /one or more non-empty strings/],
  ])('rejects %s for a list reference', async (_case, labels, message) => {
    const fetch = noNetwork();

    await expect(batched('update_issue', { issue: 'AEO-1', labels })).rejects.toThrow(message);

    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a blank single reference before any request', async () => {
    const fetch = noNetwork();

    await expect(batched('update_issue', { issue: 'AEO-1', project: '   ' }))
      .rejects.toThrow(/must be a non-empty string/);

    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an empty legacy labelIds list before any request', async () => {
    const fetch = noNetwork();

    await expect(batched('create_issue', { title: 'Issue', teamId: TEAM_ID, labelIds: [] }))
      .rejects.toThrow(/labelIds must be a non-empty list/);

    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('unknown advanced parameters are never given an invented replacement', () => {
  it('reports an unknown advanced parameter instead of suggesting a name the operation does not accept', async () => {
    const fetch = noNetwork();

    // "bogus" is not an accepted parameter, so stripping the Id suffix must not become advice.
    await expect(typed('update_issue', { issue: 'AEO-1', advanced: { bogusId: 'x' } }))
      .rejects.toThrow(/Unknown advanced parameter "bogusId"/);

    expect(fetch).not.toHaveBeenCalled();
  });

  // "id" falls back to the operation's own noun only when that noun is a parameter the
  // operation accepts. list_comments accepts no "comment" parameter, so there is nothing to send.
  it('reports an unknown advanced "id" when the operation noun is not an accepted parameter', async () => {
    const fetch = noNetwork();

    await expect(typed('list_comments', { advanced: { id: 'x' } }))
      .rejects.toThrow(/Unknown advanced parameter "id"/);

    expect(fetch).not.toHaveBeenCalled();
  });

  it('suggests the canonical spelling when the legacy name really does map to one', async () => {
    const fetch = noNetwork();

    await expect(typed('update_issue', { issue: 'AEO-1', advanced: { teamId: TEAM_ID } }))
      .rejects.toThrow(/send "team"/);

    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('single reference resolution is reported for the requested value', () => {
  it('reports the requested spelling and the resolved id for a list reference', async () => {
    resolvingServer();

    const result = await typed('update_issue', { issue: 'AEO-1', labels: ['bug'] });

    expect(result.details.resolution.labels).toEqual([{ requested: 'bug', resolvedId: LABEL_ID }]);
  });

  // A single-valued reference reports one pair, taken from the first requested value.
  it('reports the requested spelling and the resolved id for a single reference', async () => {
    resolvingServer();

    const result = await typed('update_issue', { issue: 'AEO-1', assignee: 'person' });

    expect(result.details.resolution.assignee).toEqual({ requested: 'person', resolvedId: USER_ID });
  });
});
