import { afterEach, describe, expect, it, vi } from 'vitest';
import { typedLinearTools } from '../extensions/typed-tools';
import { isolateLinearCredentials } from './helpers/credentials';
import type { CompatibilityObject } from '../extensions/operation-types';

isolateLinearCredentials();

const TEAM_ID = '11111111-1111-4111-8111-111111111111';
const ISSUE_ID = '44444444-4444-4444-8444-444444444444';
const DOCUMENT_ID = '55555555-5555-4555-8555-555555555555';
const INITIATIVE_ID = '66666666-6666-4666-8666-666666666666';
const FIRST = '22222222-2222-4222-8222-222222222222';
const SECOND = '33333333-3333-4333-8333-333333333333';
const originalApiKey = process.env.LINEAR_API_KEY;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalApiKey === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = originalApiKey;
});

type Recorded = { query: string; variables: CompatibilityObject };

/**
 * One deterministic server that answers every reference lookup by echoing the requested
 * id back, so a resolved list keeps the exact ids the caller sent, in order.
 */
function installServer() {
  const requests: Recorded[] = [];
  process.env.LINEAR_API_KEY = 'test-key';
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as Recorded;
    requests.push(request);
    const id = request.variables.id;
    const data: CompatibilityObject = request.query.includes('ResolveUserById')
      ? { user: { id, name: 'Person', displayName: 'person', email: 'person@example.com' } }
      : request.query.includes('ResolveNamedEntityById')
        ? {
          issueLabel: { id, name: 'label' },
          initiativeLabel: { id, name: 'label' },
          projectLabel: { id, name: 'label' },
          document: { id, title: 'Doc', slugId: 'doc-slug' },
          initiative: { id, name: 'Initiative' },
        }
        : request.query.includes('ResolveTeamById')
          ? { team: { id, key: 'AEO', name: 'Team' } }
          : request.query.includes('ResolveIssue')
            ? { issue: { id: ISSUE_ID, identifier: 'AEO-1', title: 'Issue', team: { id: TEAM_ID, key: 'AEO' } } }
            : request.query.includes('ResolveDocument')
              ? { document: { id: DOCUMENT_ID, title: 'Doc', slugId: 'doc-slug' } }
              : request.query.includes('ResolveInitiative')
                ? { initiative: { id: INITIATIVE_ID, name: 'Initiative' } }
                : request.query.includes('issueCreate')
                  ? { issueCreate: { success: true, issue: { id: ISSUE_ID, identifier: 'AEO-1', title: 'Issue' } } }
                  : request.query.includes('issueUpdate')
                    ? { issueUpdate: { success: true, issue: { id: ISSUE_ID, identifier: 'AEO-1', title: 'Issue' } } }
                    : request.query.includes('documentCreate')
                      ? { documentCreate: { success: true, document: { id: DOCUMENT_ID, title: 'Doc', slugId: 'doc-slug' } } }
                      : request.query.includes('documentUpdate')
                        ? { documentUpdate: { success: true, document: { id: DOCUMENT_ID, title: 'Doc', slugId: 'doc-slug' } } }
                        : request.query.includes('initiativeCreate')
                          ? { initiativeCreate: { success: true, initiative: { id: INITIATIVE_ID, name: 'Initiative' } } }
                          : { initiativeUpdate: { success: true, initiative: { id: INITIATIVE_ID, name: 'Initiative' } } };
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  return requests;
}

function tool(name: string) {
  const found = typedLinearTools().find((candidate) => candidate.name === `linear_${name}`);
  if (!found) throw new Error(`Missing typed tool for ${name}.`);
  return found;
}

function execute(operation: string, variables: CompatibilityObject) {
  return (tool(operation) as any).execute('call-1', variables, undefined, undefined, { hasUI: false });
}

function writtenInput(requests: readonly Recorded[], root: string): CompatibilityObject {
  const write = requests.find(({ query }) => query.includes(root));
  if (!write) throw new Error(`No ${root} write was sent.`);
  return (write.variables.input ?? write.variables) as CompatibilityObject;
}

/**
 * Every list-shaped reference parameter must carry ALL of its entries through resolution to
 * the wire field. A single-value reading of any of these drops the list on the floor.
 */
describe('list-shaped reference parameters keep every entry', () => {
  it.each([
    ['create_issue', { title: 'Issue', team: TEAM_ID }, 'subscribers', 'subscriberIds', 'issueCreate'],
    ['update_issue', { issue: 'AEO-1' }, 'subscribers', 'subscriberIds', 'issueUpdate'],
    ['update_issue', { issue: 'AEO-1' }, 'labels', 'labelIds', 'issueUpdate'],
    ['update_issue', { issue: 'AEO-1' }, 'addLabels', 'addedLabelIds', 'issueUpdate'],
    ['update_issue', { issue: 'AEO-1' }, 'removeLabels', 'removedLabelIds', 'issueUpdate'],
    ['create_document', { title: 'Doc' }, 'subscribers', 'subscriberIds', 'documentCreate'],
    ['update_document', { document: DOCUMENT_ID }, 'subscribers', 'subscriberIds', 'documentUpdate'],
    ['save_initiative', { name: 'Initiative' }, 'labels', 'labelIds', 'initiativeCreate'],
  ])('%s sends both %s entries as %s', async (operation, base, parameter, wireField, root) => {
    const requests = installServer();

    await execute(operation, { ...base, [parameter]: [FIRST, SECOND] });

    expect(writtenInput(requests, root)[wireField]).toEqual([FIRST, SECOND]);
  });

  it.each([
    ['create_issue', { title: 'Issue', team: TEAM_ID }, 'subscribers'],
    ['update_issue', { issue: 'AEO-1' }, 'addLabels'],
    ['create_document', { title: 'Doc' }, 'subscribers'],
    ['save_initiative', { name: 'Initiative' }, 'labels'],
  ])('%s rejects an empty %s list before any write', async (operation, base, parameter) => {
    const requests = installServer();

    await expect(execute(operation, { ...base, [parameter]: [] })).rejects.toThrow();

    expect(requests.filter(({ query }) => query.includes('mutation'))).toHaveLength(0);
  });
});
