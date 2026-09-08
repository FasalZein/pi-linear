import { isDeepStrictEqual } from 'node:util';
import { createServer, type Server } from 'node:http';
import { Kind, parse, type FieldNode, type OperationDefinitionNode } from 'graphql';
import { parseJsonObject, type JsonObject, type JsonValue } from '../../extensions/json';
import { isCompatibilityNumber, isCompatibilityString } from '../../extensions/operation-types';

export const IDS = {
  issue: '11111111-1111-4111-8111-111111111111',
  relatedIssue: '22222222-2222-4222-8222-222222222222',
  team: '33333333-3333-4333-8333-333333333333',
  user: '44444444-4444-4444-8444-444444444444',
  project: '55555555-5555-4555-8555-555555555555',
  relatedProject: '66666666-6666-4666-8666-666666666666',
  initiative: '77777777-7777-4777-8777-777777777777',
  cycle: '88888888-8888-4888-8888-888888888888',
  milestone: '99999999-9999-4999-8999-999999999999',
  document: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  comment: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  view: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  issueLabel: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  projectLabel: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  relation: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
} as const;

export type MutationFixtureCase = {
  operation: string;
  root: string;
  entityPath?: string;
  args: JsonObject;
  expectedVariables: JsonObject;
  serverId: string;
};

function serverId(index: number): string {
  return `f0000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
}

export const MUTATION_CASES: readonly MutationFixtureCase[] = [
  {
    operation: 'create_comment', root: 'commentCreate', entityPath: 'comment', serverId: serverId(0),
    args: { issue: IDS.issue, advanced: { bodyData: { type: 'doc', content: [] }, quotedText: 'Quoted fixture text' } },
    expectedVariables: { input: { issueId: IDS.issue, bodyData: { type: 'doc', content: [] }, quotedText: 'Quoted fixture text' } },
  },
  {
    operation: 'update_comment', root: 'commentUpdate', entityPath: 'comment', serverId: serverId(1),
    args: { id: IDS.comment, body: 'Edited fixture comment', skipEditedAt: true },
    expectedVariables: { id: IDS.comment, input: { body: 'Edited fixture comment' }, skipEditedAt: true },
  },
  {
    operation: 'create_view', root: 'customViewCreate', entityPath: 'customView', serverId: serverId(2),
    args: { name: 'Fixture triage view', team: IDS.team, filterData: { priority: { eq: 1 } } },
    expectedVariables: { input: { name: 'Fixture triage view', filterData: { priority: { eq: 1 } }, teamId: IDS.team } },
  },
  {
    operation: 'update_view', root: 'customViewUpdate', entityPath: 'customView', serverId: serverId(3),
    args: { id: IDS.view, name: 'Fixture view renamed' },
    expectedVariables: { id: IDS.view, input: { name: 'Fixture view renamed' } },
  },
  {
    operation: 'set_view_preferences', root: 'viewPreferencesCreate', entityPath: 'viewPreferences', serverId: serverId(4),
    args: { viewId: IDS.view, preferences: { issueGrouping: 'status', showEmptyGroups: true } },
    expectedVariables: { input: { type: 'user', viewType: 'customView', customViewId: IDS.view, preferences: { issueGrouping: 'status', showEmptyGroups: true } } },
  },
  {
    operation: 'create_cycle', root: 'cycleCreate', entityPath: 'cycle', serverId: serverId(5),
    args: { team: IDS.team, startsAt: '2026-09-08T00:00:00.000Z', endsAt: '2026-09-22T00:00:00.000Z', name: 'Fixture cycle' },
    expectedVariables: { input: { startsAt: '2026-09-08T00:00:00.000Z', endsAt: '2026-09-22T00:00:00.000Z', name: 'Fixture cycle', teamId: IDS.team } },
  },
  {
    operation: 'update_cycle', root: 'cycleUpdate', entityPath: 'cycle', serverId: serverId(6),
    args: { cycle: IDS.cycle, completedAt: '2026-09-22T12:00:00.000Z' },
    expectedVariables: { id: IDS.cycle, input: { completedAt: '2026-09-22T12:00:00.000Z' } },
  },
  {
    operation: 'create_document', root: 'documentCreate', entityPath: 'document', serverId: serverId(7),
    args: { title: 'Fixture planning notes', content: 'A real fixture document.' },
    expectedVariables: { input: { title: 'Fixture planning notes', content: 'A real fixture document.' } },
  },
  {
    operation: 'update_document', root: 'documentUpdate', entityPath: 'document', serverId: serverId(8),
    args: { document: IDS.document, hiddenAt: null },
    expectedVariables: { id: IDS.document, input: { hiddenAt: null } },
  },
  {
    operation: 'create_issue_label', root: 'issueLabelCreate', entityPath: 'issueLabel', serverId: serverId(9),
    args: { name: 'fixture-needs-review', color: '#ff5500' },
    expectedVariables: { input: { name: 'fixture-needs-review', color: '#ff5500' } },
  },
  {
    operation: 'update_issue_label', root: 'issueLabelUpdate', entityPath: 'issueLabel', serverId: serverId(10),
    args: { label: IDS.issueLabel, retiredAt: null },
    expectedVariables: { id: IDS.issueLabel, input: { retiredAt: null } },
  },
  {
    operation: 'create_issue_relation', root: 'issueRelationCreate', entityPath: 'issueRelation', serverId: serverId(11),
    args: { issue: IDS.issue, relatedIssue: IDS.relatedIssue, type: 'blocks' },
    expectedVariables: { input: { issueId: IDS.issue, relatedIssueId: IDS.relatedIssue, type: 'blocks' } },
  },
  {
    operation: 'update_issue_relation', root: 'issueRelationUpdate', entityPath: 'issueRelation', serverId: serverId(12),
    args: { id: IDS.relation, relatedIssue: IDS.relatedIssue },
    expectedVariables: { id: IDS.relation, input: { relatedIssueId: IDS.relatedIssue } },
  },
  {
    operation: 'delete_issue_relation', root: 'issueRelationDelete', serverId: serverId(13),
    args: { relationId: IDS.relation, issue: IDS.issue, relatedIssue: IDS.relatedIssue, type: 'related' },
    expectedVariables: { id: IDS.relation },
  },
  {
    operation: 'create_issue', root: 'issueCreate', entityPath: 'issue', serverId: serverId(14),
    args: { title: 'Fixture issue', team: IDS.team, advanced: { descriptionData: '{"type":"doc","content":[]}', preserveSortOrderOnCreate: true } },
    expectedVariables: { input: { title: 'Fixture issue', teamId: IDS.team, descriptionData: '{"type":"doc","content":[]}', preserveSortOrderOnCreate: true } },
  },
  {
    operation: 'update_issue', root: 'issueUpdate', entityPath: 'issue', serverId: IDS.issue,
    args: { issue: IDS.issue, assignee: null, advanced: { milestone: null, slaBreachesAt: null } },
    expectedVariables: { id: IDS.issue, input: { assigneeId: null, projectMilestoneId: null, slaBreachesAt: null } },
  },
  {
    operation: 'create_project_label', root: 'projectLabelCreate', entityPath: 'projectLabel', serverId: serverId(16),
    args: { name: 'Fixture strategic', description: 'Used by local E2E tests.' },
    expectedVariables: { input: { name: 'Fixture strategic', description: 'Used by local E2E tests.' } },
  },
  {
    operation: 'update_project_label', root: 'projectLabelUpdate', entityPath: 'projectLabel', serverId: serverId(17),
    args: { label: IDS.projectLabel, name: 'Fixture strategy' },
    expectedVariables: { id: IDS.projectLabel, input: { name: 'Fixture strategy' } },
  },
  {
    operation: 'create_project_relation', root: 'projectRelationCreate', entityPath: 'projectRelation', serverId: serverId(18),
    args: { project: IDS.project, relatedProject: IDS.relatedProject, type: 'related', anchorType: 'project', relatedAnchorType: 'project' },
    expectedVariables: { input: { projectId: IDS.project, relatedProjectId: IDS.relatedProject, type: 'related', anchorType: 'project', relatedAnchorType: 'project' } },
  },
  {
    operation: 'update_project_relation', root: 'projectRelationUpdate', entityPath: 'projectRelation', serverId: serverId(19),
    args: { id: IDS.relation, relatedProject: IDS.relatedProject },
    expectedVariables: { id: IDS.relation, input: { relatedProjectId: IDS.relatedProject } },
  },
  {
    operation: 'save_initiative', root: 'initiativeCreate', entityPath: 'initiative', serverId: serverId(20),
    args: { name: 'Fixture initiative', advanced: { targetDateResolution: 'quarter' } },
    expectedVariables: { input: { name: 'Fixture initiative', targetDateResolution: 'quarter' } },
  },
  {
    operation: 'save_initiative', root: 'initiativeUpdate', entityPath: 'initiative', serverId: serverId(21),
    args: { initiative: IDS.initiative, advanced: { targetDateResolution: 'quarter' } },
    expectedVariables: { id: IDS.initiative, input: { targetDateResolution: 'quarter' } },
  },
  {
    operation: 'save_milestone', root: 'projectMilestoneCreate', entityPath: 'projectMilestone', serverId: serverId(22),
    args: { name: 'Fixture milestone', project: IDS.project },
    expectedVariables: { input: { name: 'Fixture milestone', projectId: IDS.project } },
  },
  {
    operation: 'save_milestone', root: 'projectMilestoneUpdate', entityPath: 'projectMilestone', serverId: serverId(23),
    args: { milestone: IDS.milestone, targetDate: null },
    expectedVariables: { id: IDS.milestone, input: { targetDate: null } },
  },
  {
    operation: 'save_project', root: 'projectCreate', entityPath: 'project', serverId: serverId(24),
    args: { name: 'Fixture project', teams: [IDS.team], advanced: { startDateResolution: 'quarter', slackChannelName: 'fixture-updates' } },
    expectedVariables: { input: { name: 'Fixture project', teamIds: [IDS.team], startDateResolution: 'quarter' }, slackChannelName: 'fixture-updates' },
  },
  {
    operation: 'save_project', root: 'projectUpdate', entityPath: 'project', serverId: serverId(25),
    args: { project: IDS.project, advanced: { projectUpdateRemindersPausedUntilAt: null } },
    expectedVariables: { id: IDS.project, input: { projectUpdateRemindersPausedUntilAt: null } },
  },
] as const;

export type RecordedGraphQLRequest = {
  operationName: string;
  kind: 'query' | 'mutation';
  root: string;
  variables: JsonObject;
  query: string;
};

type LookupBehavior = 'normal' | 'document-missing' | 'document-ambiguous' | 'delete-mismatch';

type FixtureState = {
  active?: MutationFixtureCase;
  behavior: LookupBehavior;
  errors: string[];
  requests: RecordedGraphQLRequest[];
};

function operationDefinition(query: string): OperationDefinitionNode {
  const definition = parse(query).definitions.find(
    (candidate): candidate is OperationDefinitionNode => candidate.kind === Kind.OPERATION_DEFINITION,
  );
  if (!definition) throw new Error('Fixture received no GraphQL operation definition.');
  return definition;
}

function rootField(definition: OperationDefinitionNode): FieldNode {
  const field = definition.selectionSet.selections.find((selection): selection is FieldNode => selection.kind === Kind.FIELD);
  if (!field) throw new Error('Fixture received no GraphQL root field.');
  return field;
}

function namedIdentity(root: string, id: JsonValue | undefined): JsonObject {
  const value = isCompatibilityString(id) ? id : '00000000-0000-4000-8000-000000000000';
  if (root === 'document') return { id: value, title: 'Fixture planning notes', slugId: 'fixture-notes' };
  if (root === 'team') return { id: value, key: 'AEO', name: 'Fixture team' };
  if (root === 'user') return { id: value, name: 'Fixture User', displayName: 'Fixture User', email: 'fixture@example.test' };
  return { id: value, name: `Fixture ${root}`, slugId: `fixture-${root}` };
}

function lookupData(request: RecordedGraphQLRequest, behavior: LookupBehavior): JsonObject {
  const { operationName, root, variables } = request;
  if (operationName === 'ResolveIssueById') {
    const id = String(variables.id);
    return { issue: { id, identifier: 'AEO-42', title: 'Fixture issue', team: { id: IDS.team, key: 'AEO' } } };
  }
  if (operationName === 'ResolveTeamById') return { team: namedIdentity('team', variables.id) };
  if (operationName === 'ResolveUserById') return { user: namedIdentity('user', variables.id) };
  if (operationName === 'ResolveDocumentById') return { document: namedIdentity('document', variables.id) };
  if (operationName === 'ResolveDocumentByTitle') {
    if (behavior === 'document-missing') return { documents: { nodes: [] } };
    const title = String(variables.title);
    const node = { id: IDS.document, title };
    return { documents: { nodes: behavior === 'document-ambiguous' ? [node, { ...node, id: IDS.comment }] : [node] } };
  }
  if (operationName === 'ResolveNamedEntityById') return { [root]: namedIdentity(root, variables.id) };
  if (operationName === 'VerifyIssueRelationDelete') {
    return {
      issueRelation: {
        id: IDS.relation,
        type: 'related',
        issue: { id: behavior === 'delete-mismatch' ? IDS.relatedIssue : IDS.issue },
        relatedIssue: { id: IDS.relatedIssue },
      },
    };
  }
  throw new Error(`Fixture has no meaningful lookup response for ${operationName} (${root}).`);
}

function mutationData(fixture: MutationFixtureCase): JsonObject {
  if (!fixture.entityPath) return { [fixture.root]: { success: true } };
  const label = `Server ${fixture.operation} ${fixture.root}`;
  return {
    [fixture.root]: {
      success: true,
      [fixture.entityPath]: {
        id: fixture.serverId,
        name: label,
        title: label,
        identifier: `E2E-${fixture.serverId.slice(-2)}`,
        privateFixtureDetails: 'returned only for full result view',
      },
    },
  };
}

export class NamedMutationFixtureServer {
  private server?: Server;
  private state: FixtureState = { behavior: 'normal', errors: [], requests: [] };
  url = '';

  async start(): Promise<void> {
    this.server = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = parseJsonObject(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if (!body || !isCompatibilityString(body.query)) throw new Error('Fixture received an invalid GraphQL request body.');
        const definition = operationDefinition(body.query);
        const field = rootField(definition);
        const recorded: RecordedGraphQLRequest = {
          operationName: definition.name?.value ?? 'Anonymous',
          kind: definition.operation === 'mutation' ? 'mutation' : 'query',
          root: field.name.value,
          variables: parseJsonObject(body.variables) ?? {},
          query: body.query,
        };
        this.state.requests.push(recorded);
        let data: JsonObject;
        if (recorded.kind === 'mutation') {
          const active = this.state.active;
          if (!active) throw new Error(`Unexpected mutation ${recorded.root} without an active fixture.`);
          if (recorded.root !== active.root) throw new Error(`Expected mutation root ${active.root}, received ${recorded.root}.`);
          if (!isDeepStrictEqual(recorded.variables, active.expectedVariables)) {
            throw new Error(`Expected ${active.root} variables ${JSON.stringify(active.expectedVariables)}, received ${JSON.stringify(recorded.variables)}.`);
          }
          data = mutationData(active);
        } else {
          data = lookupData(recorded, this.state.behavior);
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.state.errors.push(message);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ errors: [{ message }] }));
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.server.address();
    const parsedAddress = parseJsonObject(address);
    if (!parsedAddress || !isCompatibilityNumber(parsedAddress.port)) {
      throw new Error('Fixture server did not bind a TCP port.');
    }
    this.url = `http://127.0.0.1:${parsedAddress.port}/graphql`;
  }

  reset(active?: MutationFixtureCase, behavior: LookupBehavior = 'normal'): void {
    this.state = { active, behavior, errors: [], requests: [] };
  }

  requests(): readonly RecordedGraphQLRequest[] {
    return this.state.requests;
  }

  fixtureErrors(): readonly string[] {
    return this.state.errors;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => this.server!.close((error) => error ? reject(error) : resolve()));
    this.server = undefined;
  }
}
