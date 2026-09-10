import { buildSchema, parse, validate } from 'graphql';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FIXTURE_KEY,
  ISSUE_ID,
  createHostSession,
  executeActiveTool,
  issue,
  resetHostFixtures,
  schemaPropertyNames,
  startGraphQLServer,
} from './helpers/pi-host-session';

const ISSUE_RELATIONS_QUERY = `query ReadIssueRelations(
  $issue: String!
  $pageSize: Int!
  $outboundAfter: String
  $inboundAfter: String
) {
  issue(id: $issue) {
    id
    identifier
    outbound: relations(first: $pageSize, after: $outboundAfter) {
      nodes {
        id
        type
        issue { id identifier }
        relatedIssue { id identifier }
      }
      pageInfo { hasNextPage endCursor }
    }
    inbound: inverseRelations(first: $pageSize, after: $inboundAfter) {
      nodes {
        id
        type
        issue { id identifier }
        relatedIssue { id identifier }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;
const ISSUE_RELATIONS_SCHEMA = buildSchema(`
  type Query { issue(id: String!): Issue! }
  type Issue {
    id: ID!
    identifier: String!
    relations(first: Int!, after: String): IssueRelationConnection!
    inverseRelations(first: Int!, after: String): IssueRelationConnection!
  }
  type IssueRelationConnection { nodes: [IssueRelation!]!, pageInfo: PageInfo! }
  type IssueRelation { id: ID!, type: IssueRelationType!, issue: Issue!, relatedIssue: Issue! }
  enum IssueRelationType { blocks duplicate related similar }
  type PageInfo { hasNextPage: Boolean!, endCursor: String }
`);

afterEach(resetHostFixtures);

describe('installed Pi host comment and relation reads', () => {
  it('reads paged issue comments and both relation directions without a workspace relation scan', async () => {
    expect(validate(ISSUE_RELATIONS_SCHEMA, parse(ISSUE_RELATIONS_QUERY))).toEqual([]);
    const { endpoint, requests } = await startGraphQLServer((request) => {
      if (request.query.includes('query ReadIssueRelations')) {
        return {
          body: {
            data: {
              issue: {
                id: ISSUE_ID,
                identifier: 'AEO-1',
                outbound: {
                  nodes: [{
                    id: 'outbound-1', type: 'blocks',
                    issue: { id: ISSUE_ID, identifier: 'AEO-1' },
                    relatedIssue: { id: 'issue-2', identifier: 'AEO-2' },
                  }],
                  pageInfo: { hasNextPage: false, endCursor: 'outbound-end' },
                },
                inbound: {
                  nodes: [{
                    id: 'inbound-1', type: 'related',
                    issue: { id: 'issue-3', identifier: 'AEO-3' },
                    relatedIssue: { id: ISSUE_ID, identifier: 'AEO-1' },
                  }],
                  pageInfo: { hasNextPage: false, endCursor: 'inbound-end' },
                },
              },
            },
          },
        };
      }
      if (request.query.includes('query ListComments')) {
        const secondPage = request.variables.after === 'comment-next';
        return {
          body: {
            data: {
              comments: {
                nodes: [{
                  id: secondPage ? 'comment-2' : 'comment-1',
                  body: secondPage ? 'Later decision' : 'Initial context',
                  createdAt: secondPage ? '2026-09-02T00:00:00.000Z' : '2026-09-01T00:00:00.000Z',
                  issue: { id: ISSUE_ID, identifier: 'AEO-1', title: 'Brief source' },
                  user: { id: 'user-1', name: 'Ada', email: 'ada@example.com' },
                }],
                pageInfo: {
                  hasNextPage: !secondPage,
                  hasPreviousPage: secondPage,
                  startCursor: secondPage ? 'comment-next' : 'comment-start',
                  endCursor: secondPage ? 'comment-end' : 'comment-next',
                },
              },
            },
          },
        };
      }
      return { body: { data: { issue: issue('AEO-1', 'Brief source') } } };
    });
    process.env.LINEAR_API_KEY = FIXTURE_KEY;
    process.env.LINEAR_READONLY = '1';
    process.env.LINEAR_SMOKE_GRAPHQL_ENDPOINT = endpoint;
    const { session } = await createHostSession({ fullLinearAllowlist: true });
    const schemas = new Map(session.getAllTools().map(({ name, parameters }) => [name, parameters]));

    const getIssueProperties = schemaPropertyNames(schemas.get('linear_get_issue'));
    expect(getIssueProperties).toEqual(['issue', 'view']);
    const commentProperties = schemaPropertyNames(schemas.get('linear_list_comments'));
    expect(commentProperties).toEqual(expect.arrayContaining(['issue', 'first', 'after']));
    const relationProperties = schemaPropertyNames(schemas.get('linear_list_issue_relations'));
    expect(relationProperties).not.toContain('issue');
    expect(relationProperties).not.toContain('filter');

    await executeActiveTool(session, 'linear', {
      operation: 'help', variables: { operation: 'get_issue' },
    });
    await executeActiveTool(session, 'linear_get_issue', { issue: 'AEO-1' });
    await executeActiveTool(session, 'linear', {
      operation: 'help', variables: { operation: 'list_comments' },
    });
    const firstComments = await executeActiveTool(session, 'linear_list_comments', {
      issue: 'AEO-1', first: 1,
    });
    const secondComments = await executeActiveTool(session, 'linear_list_comments', {
      issue: 'AEO-1', first: 1, after: 'comment-next',
    });
    await executeActiveTool(session, 'linear', {
      operation: 'help', variables: { operation: 'graphql' },
    });
    const relations = await executeActiveTool(session, 'linear_graphql', {
      query: ISSUE_RELATIONS_QUERY,
      variables: {
        issue: 'AEO-1', pageSize: 20, outboundAfter: null, inboundAfter: null,
      },
    });

    expect(firstComments.details).toMatchObject({
      data: { comments: { nodes: [{ body: 'Initial context' }], pageInfo: { hasNextPage: true, endCursor: 'comment-next' } } },
    });
    expect(secondComments.details).toMatchObject({
      data: { comments: { nodes: [{ body: 'Later decision' }], pageInfo: { hasNextPage: false, endCursor: 'comment-end' } } },
    });
    expect(relations.details).toMatchObject({
      data: { issue: {
        identifier: 'AEO-1',
        outbound: { nodes: [{ relatedIssue: { identifier: 'AEO-2' } }] },
        inbound: { nodes: [{ issue: { identifier: 'AEO-3' } }] },
      } },
    });
    const getIssueRequest = requests.find((request) => request.query.includes('query GetIssue'));
    expect(getIssueRequest?.query).not.toMatch(/comments|relations|inverseRelations/);
    const relationRequest = requests.find((request) => request.query.includes('query ReadIssueRelations'));
    expect(relationRequest).toEqual({
      query: ISSUE_RELATIONS_QUERY,
      variables: { issue: 'AEO-1', pageSize: 20, outboundAfter: null, inboundAfter: null },
    });
    expect(requests.some((request) => request.query.includes('query ListIssueRelations'))).toBe(false);
  }, 30_000);
});
