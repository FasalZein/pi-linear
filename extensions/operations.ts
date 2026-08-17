import {
  resolveIssueReference,
  resolveStateReference,
  type ResolvedIssue,
} from './client';

export const DOMAINS = [
  'issues',
  'comments',
  'users',
  'teams',
  'projects',
  'cycles',
  'milestones',
  'initiatives',
  'documents',
  'views',
  'labels',
  'relations',
  'workspace',
] as const;

export type OperationDomain = typeof DOMAINS[number];
export type OperationParameter = { name: string; type: string; required: boolean };
export type OperationExample = { operation: string; variables: Record<string, unknown> };
export type OperationPreparation = {
  variables: Record<string, unknown>;
  resolution?: Record<string, unknown>;
};
export type LinearOperation = {
  name: string;
  aliases: readonly string[];
  domain: OperationDomain;
  purpose: string;
  parameters: readonly OperationParameter[];
  legacyParameters?: readonly (readonly OperationParameter[])[];
  aliasParameters?: Readonly<Record<string, readonly OperationParameter[]>>;
  example: OperationExample;
  document: string;
  mutationRoots: readonly string[];
  prepare?: (
    apiKey: string,
    variables: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ) => Promise<OperationPreparation>;
};

function issueTarget(requested: string, issue: ResolvedIssue) {
  return { requested, resolvedId: issue.id, identifier: issue.identifier };
}

function issueReference(variables: Record<string, unknown>): string {
  if (typeof variables.issue === 'string') return variables.issue;
  if (typeof variables.issueId === 'string') return variables.issueId;
  return `${String(variables.teamKey)}-${String(variables.number)}`;
}

export function operationSignature(operation: LinearOperation): string {
  const parameters = operation.parameters.map(({ name, type, required }) =>
    required ? `${name}: ${type}!` : `${name}?: ${type}`,
  );
  return `${operation.name}(${parameters.join(', ')})`;
}

export function formatInvocation(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(formatInvocation).join(', ')}]`;
  if (value && typeof value === 'object') {
    return `{ ${Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => `${JSON.stringify(key)}: ${formatInvocation(entry)}`)
      .join(', ')} }`;
  }
  return JSON.stringify(value);
}

export const operations = {
  get_issue: {
    name: 'get_issue', aliases: [], domain: 'issues',
    purpose: 'Fetch one issue brief with comments, relations, project, state, and labels.',
    parameters: [{ name: 'issue', type: 'IssueReference', required: true }],
    legacyParameters: [[{ name: 'teamKey', type: 'String', required: true }, { name: 'number', type: 'Float', required: true }]],
    example: { operation: 'get_issue', variables: { issue: 'AEO-258' } },
    mutationRoots: [],
    async prepare(apiKey, variables, signal) {
      const requested = issueReference(variables);
      const issue = await resolveIssueReference(apiKey, requested, signal);
      return { variables: { issueId: issue.id }, resolution: { target: issueTarget(requested, issue) } };
    },
    document: `query GetIssue($issueId: String!) {
  issue(id: $issueId) {
    id identifier title description url priority createdAt updatedAt
    team { id key name }
    state { id name type }
    project { id name }
    labels(first: 25) { nodes { id name color } }
    comments(first: 50) { nodes { id body createdAt updatedAt user { id name } } pageInfo { hasNextPage endCursor } }
    relations(first: 50) { nodes { id type relatedIssue { id identifier title } } pageInfo { hasNextPage endCursor } }
  }
}`,
  },
  search_issues: {
    name: 'search_issues', aliases: [], domain: 'issues',
    purpose: 'Search for issues in pages of ten.',
    parameters: [{ name: 'term', type: 'String', required: true }, { name: 'after', type: 'String', required: false }],
    example: { operation: 'search_issues', variables: { term: 'authentication' } },
    mutationRoots: [],
    document: `query SearchIssues($term: String!, $after: String) {
  searchIssues(term: $term, first: 10, after: $after) {
    nodes { id identifier title description state { id name type } assignee { id name } team { id key name } }
    pageInfo { hasNextPage endCursor }
  }
}`,
  },
  create_issue: {
    name: 'create_issue', aliases: [], domain: 'issues',
    purpose: 'Create one issue.',
    parameters: [{ name: 'input', type: 'IssueCreateInput', required: true }],
    example: { operation: 'create_issue', variables: { input: { teamId: 'team-id', title: 'Issue title' } } },
    mutationRoots: ['issueCreate'],
    document: `mutation CreateIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { id identifier title state { id name type } } }
}`,
  },
  update_issue_state: {
    name: 'update_issue_state', aliases: [], domain: 'issues',
    purpose: 'Move one issue to a workflow state.',
    parameters: [{ name: 'issue', type: 'IssueReference', required: true }, { name: 'state', type: 'StateReference', required: true }],
    legacyParameters: [[{ name: 'issueId', type: 'String', required: true }, { name: 'stateId', type: 'String', required: true }]],
    example: { operation: 'update_issue_state', variables: { issue: 'AEO-258', state: 'Backlog' } },
    mutationRoots: ['issueUpdate'],
    async prepare(apiKey, variables, signal) {
      const requested = issueReference(variables);
      const requestedState = String(variables.state ?? variables.stateId);
      const issue = await resolveIssueReference(apiKey, requested, signal);
      const state = await resolveStateReference(apiKey, issue.teamId, requestedState, signal);
      return {
        variables: { issueId: issue.id, stateId: state.id },
        resolution: {
          target: issueTarget(requested, issue),
          state: { requested: requestedState, resolvedId: state.id, name: state.name },
        },
      };
    },
    document: `mutation UpdateIssueState($issueId: String!, $stateId: String!) {
  issueUpdate(id: $issueId, input: { stateId: $stateId }) { success issue { id identifier title state { id name type } } }
}`,
  },
  create_comment: {
    name: 'create_comment', aliases: ['add_comment'], domain: 'comments',
    purpose: 'Add one comment to an issue.',
    parameters: [{ name: 'issue', type: 'IssueReference', required: true }, { name: 'body', type: 'String', required: true }],
    legacyParameters: [[{ name: 'issueId', type: 'String', required: true }, { name: 'body', type: 'String', required: true }]],
    aliasParameters: { add_comment: [{ name: 'issueId', type: 'String', required: true }, { name: 'body', type: 'String', required: true }] },
    example: { operation: 'create_comment', variables: { issue: 'AEO-258', body: 'Comment text' } },
    mutationRoots: ['commentCreate'],
    async prepare(apiKey, variables, signal) {
      const requested = issueReference(variables);
      const issue = await resolveIssueReference(apiKey, requested, signal);
      return {
        variables: { issueId: issue.id, body: variables.body },
        resolution: { target: issueTarget(requested, issue) },
      };
    },
    document: `mutation AddComment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id body createdAt user { id name } } }
}`,
  },
  create_issue_relation: {
    name: 'create_issue_relation', aliases: ['create_relation'], domain: 'relations',
    purpose: 'Create a relation between two issues.',
    parameters: [
      { name: 'issue', type: 'IssueReference', required: true },
      { name: 'relatedIssue', type: 'IssueReference', required: true },
      { name: 'type', type: 'IssueRelationType', required: true },
    ],
    legacyParameters: [[
      { name: 'issueId', type: 'String', required: true },
      { name: 'relatedIssueId', type: 'String', required: true },
      { name: 'type', type: 'IssueRelationType', required: true },
    ]],
    aliasParameters: { create_relation: [
      { name: 'issueId', type: 'String', required: true },
      { name: 'relatedIssueId', type: 'String', required: true },
      { name: 'type', type: 'IssueRelationType', required: true },
    ] },
    example: { operation: 'create_issue_relation', variables: { issue: 'AEO-258', relatedIssue: 'AEO-259', type: 'related' } },
    mutationRoots: ['issueRelationCreate'],
    async prepare(apiKey, variables, signal) {
      const requested = issueReference(variables);
      const relatedRequested = String(variables.relatedIssue ?? variables.relatedIssueId);
      const [issue, relatedIssue] = await Promise.all([
        resolveIssueReference(apiKey, requested, signal),
        resolveIssueReference(apiKey, relatedRequested, signal),
      ]);
      return {
        variables: { issueId: issue.id, relatedIssueId: relatedIssue.id, type: variables.type },
        resolution: {
          target: issueTarget(requested, issue),
          relatedTarget: issueTarget(relatedRequested, relatedIssue),
        },
      };
    },
    document: `mutation CreateRelation($issueId: String!, $relatedIssueId: String!, $type: IssueRelationType!) {
  issueRelationCreate(input: { issueId: $issueId, relatedIssueId: $relatedIssueId, type: $type }) {
    success issueRelation { id type relatedIssue { id identifier title } }
  }
}`,
  },
  list_teams: {
    name: 'list_teams', aliases: [], domain: 'teams',
    purpose: 'List teams with their workflow states and labels.',
    parameters: [{ name: 'after', type: 'String', required: false }],
    example: { operation: 'list_teams', variables: {} },
    mutationRoots: [],
    document: `query ListTeams($after: String) {
  teams(first: 50, after: $after) {
    nodes { id key name states(first: 50) { nodes { id name type color } } labels(first: 50) { nodes { id name color } } }
    pageInfo { hasNextPage endCursor }
  }
}`,
  },
  list_issue_statuses: {
    name: 'list_issue_statuses', aliases: ['list_workflow_states'], domain: 'workspace',
    purpose: 'List workspace workflow states.',
    parameters: [{ name: 'after', type: 'String', required: false }],
    example: { operation: 'list_issue_statuses', variables: {} },
    mutationRoots: [],
    document: `query ListWorkflowStates($after: String) {
  workflowStates(first: 50, after: $after) {
    nodes { id name type color team { id key name } }
    pageInfo { hasNextPage endCursor }
  }
}`,
  },
  list_issue_labels: {
    name: 'list_issue_labels', aliases: [], domain: 'labels',
    purpose: 'List workspace issue labels.',
    parameters: [{ name: 'after', type: 'String', required: false }],
    example: { operation: 'list_issue_labels', variables: {} },
    mutationRoots: [],
    document: `query ListIssueLabels($after: String) {
  issueLabels(first: 50, after: $after) {
    nodes { id name color description team { id key name } }
    pageInfo { hasNextPage endCursor }
  }
}`,
  },
  list_projects: {
    name: 'list_projects', aliases: [], domain: 'projects',
    purpose: 'List workspace projects.',
    parameters: [{ name: 'after', type: 'String', required: false }],
    example: { operation: 'list_projects', variables: {} },
    mutationRoots: [],
    document: `query ListProjects($after: String) {
  projects(first: 50, after: $after) {
    nodes { id name description state progress url teams { nodes { id key name } } }
    pageInfo { hasNextPage endCursor }
  }
}`,
  },
} as const satisfies Record<string, LinearOperation>;

export type OperationName = keyof typeof operations;

const aliases = new Map<string, LinearOperation>();
for (const operation of Object.values(operations)) {
  for (const alias of operation.aliases) aliases.set(alias, operation);
}

export function getOperation(name: string): LinearOperation {
  const operation = (operations as Record<string, LinearOperation>)[name] ?? aliases.get(name);
  if (!operation) throw new Error(`Unknown Linear operation "${name}". Send { "operation": "help" }.`);
  return operation;
}

export function parameterShapes(operation: LinearOperation, requestedName: string): readonly (readonly OperationParameter[])[] {
  const aliasShape = operation.aliasParameters?.[requestedName];
  if (aliasShape) return [aliasShape];
  return [operation.parameters, ...(operation.legacyParameters ?? [])];
}

export function operationsForDomain(domain: OperationDomain): LinearOperation[] {
  return Object.values(operations).filter((operation) => operation.domain === domain);
}
