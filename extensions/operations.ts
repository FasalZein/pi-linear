export type LinearOperation = {
  signature: string;
  purpose: string;
  document: string;
};

export const operations = {
  get_issue: {
    signature: 'get_issue(teamKey: String!, number: Float!)',
    purpose: 'Fetch one issue brief with comments, relations, project, state, and labels.',
    document: `query GetIssue($teamKey: String!, $number: Float!) {
  issues(first: 1, filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }) {
    nodes {
      id identifier title description url priority createdAt updatedAt
      team { id key name }
      state { id name type }
      project { id name }
      labels(first: 25) { nodes { id name color } }
      comments(first: 50) { nodes { id body createdAt updatedAt user { id name } } pageInfo { hasNextPage endCursor } }
      relations(first: 50) { nodes { id type relatedIssue { id identifier title } } pageInfo { hasNextPage endCursor } }
    }
  }
}`,
  },
  search_issues: {
    signature: 'search_issues(term: String!, after?: String)',
    purpose: 'Search for issues in pages of ten.',
    document: `query SearchIssues($term: String!, $after: String) {
  searchIssues(term: $term, first: 10, after: $after) {
    nodes { id identifier title description state { id name type } assignee { id name } team { id key name } }
    pageInfo { hasNextPage endCursor }
  }
}`,
  },
  create_issue: {
    signature: 'create_issue(input: IssueCreateInput!)',
    purpose: 'Create one issue.',
    document: `mutation CreateIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { id identifier title state { id name type } } }
}`,
  },
  update_issue_state: {
    signature: 'update_issue_state(issueId: String!, stateId: String!)',
    purpose: 'Move one issue to a workflow state.',
    document: `mutation UpdateIssueState($issueId: String!, $stateId: String!) {
  issueUpdate(id: $issueId, input: { stateId: $stateId }) { success issue { id identifier title state { id name type } } }
}`,
  },
  add_comment: {
    signature: 'add_comment(issueId: String!, body: String!)',
    purpose: 'Add one comment to an issue.',
    document: `mutation AddComment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id body createdAt user { id name } } }
}`,
  },
  create_relation: {
    signature: 'create_relation(issueId: String!, relatedIssueId: String!, type: IssueRelationType!)',
    purpose: 'Create a relation between two issues.',
    document: `mutation CreateRelation($issueId: String!, $relatedIssueId: String!, $type: IssueRelationType!) {
  issueRelationCreate(input: { issueId: $issueId, relatedIssueId: $relatedIssueId, type: $type }) {
    success issueRelation { id type relatedIssue { id identifier title } }
  }
}`,
  },
  list_teams: {
    signature: 'list_teams(after?: String)',
    purpose: 'List teams with their workflow states and labels.',
    document: `query ListTeams($after: String) {
  teams(first: 50, after: $after) {
    nodes { id key name states(first: 50) { nodes { id name type color } } labels(first: 50) { nodes { id name color } } }
    pageInfo { hasNextPage endCursor }
  }
}`,
  },
  list_workflow_states: {
    signature: 'list_workflow_states(after?: String)',
    purpose: 'List workspace workflow states.',
    document: `query ListWorkflowStates($after: String) {
  workflowStates(first: 50, after: $after) {
    nodes { id name type color team { id key name } }
    pageInfo { hasNextPage endCursor }
  }
}`,
  },
  list_issue_labels: {
    signature: 'list_issue_labels(after?: String)',
    purpose: 'List workspace issue labels.',
    document: `query ListIssueLabels($after: String) {
  issueLabels(first: 50, after: $after) {
    nodes { id name color description team { id key name } }
    pageInfo { hasNextPage endCursor }
  }
}`,
  },
  list_projects: {
    signature: 'list_projects(after?: String)',
    purpose: 'List workspace projects.',
    document: `query ListProjects($after: String) {
  projects(first: 50, after: $after) {
    nodes { id name description state progress url teams { nodes { id key name } } }
    pageInfo { hasNextPage endCursor }
  }
}`,
  },
} as const satisfies Record<string, LinearOperation>;

export type OperationName = keyof typeof operations;

export function operationCatalog(): string {
  return Object.values(operations).map(({ signature, purpose }) => `- ${signature}: ${purpose}`).join('\n');
}

export function getOperation(name: string): LinearOperation {
  const operation = (operations as Record<string, LinearOperation>)[name];
  if (!operation) throw new Error(`Unknown Linear operation "${name}". Valid operations:\n${operationCatalog()}`);
  return operation;
}
