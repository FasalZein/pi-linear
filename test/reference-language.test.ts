import { afterEach, describe, expect, it, vi } from 'vitest';
import { typedLinearTools } from '../extensions/typed-tools';
import { executeTyped } from './helpers/typed-execution';
import { isolateLinearCredentials } from './helpers/credentials';
import type { CompatibilityObject } from '../extensions/operation-types';

isolateLinearCredentials();

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';
const originalKey = process.env.LINEAR_API_KEY;

const EXPANDED_REFERENCE_FIELDS = {
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

function schemaFields(operation: string): string[] {
  const tool = typedLinearTools().find(({ name }) => name === `linear_${operation}`) as any;
  return Object.keys(tool.parameters.properties);
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

describe('AEO-823 expanded reference language', () => {
  it('publishes each new reference word beside its old spelling', () => {
    for (const [operation, renames] of Object.entries(EXPANDED_REFERENCE_FIELDS)) {
      const fields = schemaFields(operation);
      for (const [oldName, newName] of Object.entries(renames)) {
        expect(fields, `${operation}.${newName}`).toContain(newName);
        expect(fields, `${operation}.${oldName}`).toContain(oldName);
      }
    }
  });

  it('rejects duplicate old and new identities before transport and names the accepted word', async () => {
    const requests = stubGraphql(() => { throw new Error('transport must not run'); });
    await expect(executeTyped('save_milestone', {
      name: 'Beta', project: 'Roadmap', projectId: UUID_A,
    })).rejects.toThrow('project');
    expect(requests).toHaveLength(0);
  });

  it('resolves exact project names before a project relation mutation', async () => {
    const requests = stubGraphql((query, variables) => {
      if (query.includes('ResolveNamedEntityByReference')) {
        return variables.reference === 'Roadmap'
          ? { byName: { nodes: [{ id: UUID_A, name: 'Roadmap', slugId: 'roadmap' }] }, bySlug: null }
          : { byName: { nodes: [{ id: UUID_B, name: 'Other', slugId: 'other' }] }, bySlug: null };
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
