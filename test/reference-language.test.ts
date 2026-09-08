import { afterEach, describe, expect, it, vi } from 'vitest';
import { typedLinearTools } from '../extensions/typed-tools';
import { canonicalOperation } from '../extensions/canonical';
import { operations } from '../extensions/operations';
import { executeTyped } from './helpers/typed-execution';
import { isolateLinearCredentials } from './helpers/credentials';
import type { CompatibilityObject } from '../extensions/operation-types';

isolateLinearCredentials();

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';
const originalKey = process.env.LINEAR_API_KEY;

const CONTRACTED_REFERENCE_FIELDS = {
  create_comment: { projectId: 'project', initiativeId: 'initiative' },
  update_cycle: { id: 'cycle' },
  create_document: { issueId: 'issue', teamId: 'team', projectId: 'project', initiativeId: 'initiative', cycleId: 'cycle', ownerId: 'owner', subscriberIds: 'subscribers' },
  update_document: { issueId: 'issue', teamId: 'team', projectId: 'project', initiativeId: 'initiative', cycleId: 'cycle', ownerId: 'owner', subscriberIds: 'subscribers' },
  update_issue_label: { id: 'label' },
  update_issue_relation: { issueId: 'issue', relatedIssueId: 'relatedIssue' },
  delete_issue_relation: { issueId: 'issue', relatedIssueId: 'relatedIssue' },
  list_issues: { projectId: 'project' },
  create_issue: { projectId: 'project', projectMilestoneId: 'milestone', cycleId: 'cycle', labelIds: 'labels', subscriberIds: 'subscribers', delegateId: 'delegate' },
  update_issue: { teamId: 'team', projectId: 'project', addedLabelIds: 'addLabels', removedLabelIds: 'removeLabels', projectMilestoneId: 'milestone', cycleId: 'cycle', labelIds: 'labels', subscriberIds: 'subscribers', delegateId: 'delegate', snoozedById: 'snoozedBy' },
  save_milestone: { milestoneId: 'milestone', projectId: 'project' },
  update_project_label: { id: 'label' },
  create_project_relation: { projectId: 'project', relatedProjectId: 'relatedProject', projectMilestoneId: 'milestone', relatedProjectMilestoneId: 'relatedMilestone' },
  update_project_relation: { projectId: 'project', relatedProjectId: 'relatedProject', projectMilestoneId: 'milestone', relatedProjectMilestoneId: 'relatedMilestone' },
  save_project: { projectId: 'project', teamIds: 'teams', convertedFromIssueId: 'convertedFromIssue', labelIds: 'labels', leadId: 'lead', leadTeamId: 'leadTeam', memberIds: 'members', statusId: 'status' },
  save_initiative: { initiativeId: 'initiative', labelIds: 'labels', leadTeamId: 'leadTeam', ownerId: 'owner' },
} as const;

function canonicalFields(operation: string): string[] {
  const contract = canonicalOperation(operations[operation]!);
  return [...Object.keys(contract.fields), ...Object.keys(contract.advanced ?? {})];
}

function stubGraphql(responder: (query: string, variables: CompatibilityObject) => CompatibilityObject) {
  const requests: Array<{ query: string; variables: CompatibilityObject }> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as { query: string; variables: CompatibilityObject };
    requests.push(request);
    return { ok: true, status: 200, statusText: 'OK', headers: new Headers(), json: async () => ({ data: responder(request.query, request.variables) }) };
  }));
  process.env.LINEAR_API_KEY = 'test-key';
  return requests;
}

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalKey === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = originalKey;
});

describe('AEO-825 contracted reference language', () => {
  it('keeps each new reference word in the common or advanced contract and removes its old spelling', () => {
    for (const [operation, renames] of Object.entries(CONTRACTED_REFERENCE_FIELDS)) {
      const fields = canonicalFields(operation);
      for (const [oldName, newName] of Object.entries(renames)) {
        expect(fields, `${operation}.${newName}`).toContain(newName);
        expect(fields, `${operation}.${oldName}`).not.toContain(oldName);
      }
    }
  });

  it('rejects every removed spelling and names its accepted replacement', () => {
    const tools = new Map(typedLinearTools().map((tool) => [tool.name, tool]));
    for (const [operation, renames] of Object.entries(CONTRACTED_REFERENCE_FIELDS)) {
      const tool = tools.get(`linear_${operation}`)!;
      for (const [oldName, newName] of Object.entries(renames)) {
        expect(() => tool.prepareArguments!({ [oldName]: 'legacy' }), `${operation}.${oldName}`)
          .toThrow(`"${oldName}"; send "${newName}"`);
      }
    }
  });

  it('rejects duplicate old and new identities before transport and names the accepted word', async () => {
    const requests = stubGraphql(() => { throw new Error('transport must not run'); });
    await expect(executeTyped('save_milestone', {
      name: 'Beta', project: 'Roadmap', projectId: UUID_A,
    })).rejects.toThrow('Duplicate project identity: "projectId" conflicts with "project"; send only "project"');
    expect(requests).toHaveLength(0);
  });

  it.each([
    ['list_issues', 'teamId', 'team'],
    ['list_issues', 'teamKey', 'team'],
    ['list_issues', 'stateName', 'state'],
    ['list_issues', 'assigneeId', 'assignee'],
    ['get_cycle', 'id', 'cycle'],
    ['get_project', 'projectId', 'project'],
    ['get_document', 'documentId', 'document'],
    ['get_user', 'userId', 'user'],
    ['get_team', 'teamId', 'team'],
    ['get_milestone', 'milestoneId', 'milestone'],
    ['get_initiative', 'initiativeId', 'initiative'],
    ['create_issue', 'stateId', 'state'],
    ['create_issue', 'parentId', 'parent'],
    ['create_issue_relation', 'issueId', 'issue'],
  ])('rejects %s.%s and names %s', async (operation, oldName, replacement) => {
    const tool = typedLinearTools().find(({ name }) => name === `linear_${operation}`) as any;
    expect(() => tool.prepareArguments({ [oldName]: UUID_A })).toThrow(`send "${replacement}"`);
  });

  it('resolves team, user, label, and status references before creating a project', async () => {
    const requests = stubGraphql((query) => {
      if (query.includes('ResolveTeamByKey')) return { teams: { nodes: [{ id: UUID_A, key: 'AEO' }] } };
      if (query.includes('ResolveViewer')) return { viewer: { id: UUID_B, name: 'Ada', displayName: 'Ada', email: 'ada@example.com' } };
      if (query.includes('ResolveUserByIdentity')) return { byEmail: { nodes: [{ id: UUID_C, name: 'Sam', displayName: 'Sam', email: 'sam@example.com' }] }, byName: { nodes: [] }, byDisplayName: { nodes: [] } };
      if (query.includes('projectLabels')) return { projectLabels: { nodes: [{ id: '44444444-4444-4444-8444-444444444444', name: 'Roadmap' }] } };
      if (query.includes('projectStatuses')) return { projectStatuses: { nodes: [{ id: '55555555-5555-4555-8555-555555555555', name: 'Started' }] } };
      return { projectCreate: { success: true, project: { id: '66666666-6666-4666-8666-666666666666', name: 'Lean references' } } };
    });
    await executeTyped('save_project', {
      name: 'Lean references',
      teams: ['AEO'],
      lead: 'me',
      advanced: { members: ['sam@example.com'] },
      labels: ['Roadmap'],
      status: 'Started',
    });
    expect(requests.at(-1)?.variables).toEqual({ input: {
      name: 'Lean references',
      teamIds: [UUID_A],
      leadId: UUID_B,
      memberIds: [UUID_C],
      labelIds: ['44444444-4444-4444-8444-444444444444'],
      statusId: '55555555-5555-4555-8555-555555555555',
    } });
  });

  it('rejects duplicate references in a list before transport', async () => {
    const requests = stubGraphql(() => { throw new Error('transport must not run'); });
    await expect(executeTyped('save_project', { name: 'Lean references', teams: ['AEO', 'aeo'] }))
      .rejects.toThrow('Duplicate Linear reference');
    expect(requests).toHaveLength(0);
  });

  it('resolves exact project names before a project relation mutation', async () => {
    const requests = stubGraphql((query, variables) => {
      if (query.includes('ResolveNamedEntityByReference')) {
        return variables.reference === 'Roadmap'
          ? { matches: { nodes: [{ id: UUID_A, name: 'Roadmap', slugId: 'roadmap' }] } }
          : { matches: { nodes: [{ id: UUID_B, name: 'Other', slugId: 'other' }] } };
      }
      return { projectRelationCreate: { success: true, projectRelation: { id: UUID_C } } };
    });
    await executeTyped('create_project_relation', {
      project: 'Roadmap', relatedProject: 'Other', type: 'related', anchorType: 'project', relatedAnchorType: 'project',
    });
    expect(requests.filter(({ query }) => query.includes('mutation'))).toHaveLength(1);
    expect(requests.at(-1)?.variables).toEqual({ input: { projectId: UUID_A, relatedProjectId: UUID_B, type: 'related', anchorType: 'project', relatedAnchorType: 'project' } });
  });
});
