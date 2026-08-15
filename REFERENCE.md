# Linear API reference

Call `linear_api` with exactly one of `operation` or `query`. Pass operation inputs through `variables`. Use IDs from read operations in mutations.

## Operations catalog

| Operation | Variables | Return shape | Purpose |
| --- | --- | --- | --- |
| `get_issue` | `{ teamKey: String!, number: Float! }` | `issues.nodes[]` with issue fields, comments, relations, project, state, and labels | Build a complete ticket brief. |
| `search_issues` | `{ term: String!, after?: String }` | `searchIssues.nodes[]`, `pageInfo` | Search issues in pages of 10. |
| `create_issue` | `{ input: IssueCreateInput! }` | `issueCreate { success, issue }` | Create an issue. |
| `update_issue_state` | `{ issueId: String!, stateId: String! }` | `issueUpdate { success, issue }` | Move an issue to a workflow state. |
| `add_comment` | `{ issueId: String!, body: String! }` | `commentCreate { success, comment }` | Add a comment. |
| `create_relation` | `{ issueId: String!, relatedIssueId: String!, type: IssueRelationType! }` | `issueRelationCreate { success, issueRelation }` | Relate two issues. |
| `list_teams` | `{ after?: String }` | `teams.nodes[]` with nested states and labels, `pageInfo` | Discover team, state, and label IDs. |
| `list_workflow_states` | `{ after?: String }` | `workflowStates.nodes[]`, `pageInfo` | Discover workflow state IDs. |
| `list_issue_labels` | `{ after?: String }` | `issueLabels.nodes[]`, `pageInfo` | Discover label IDs. |
| `list_projects` | `{ after?: String }` | `projects.nodes[]`, `pageInfo` | Discover project IDs and status. |

Example:

```json
{
  "operation": "get_issue",
  "variables": { "teamKey": "AEO", "number": 236 }
}
```

## Raw GraphQL

Use `query` when no bundled operation covers the task. Select only required fields. Add a small `first:` value to every connection. Select `pageInfo { hasNextPage endCursor }` when more pages can matter.

The default entry allows only the documented safe mutation fields. The read-only entry rejects every mutation. Ask the user before a mutation even when the runtime allows it.

```json
{
  "query": "query Viewer { viewer { id name } }",
  "variables": {}
}
```

## Cursor pagination recipe

1. Call an operation without `after`, or set `after` to `null`.
2. Read `pageInfo.hasNextPage` and `pageInfo.endCursor`.
3. If `hasNextPage` is true, call the same operation again.
4. Keep all other variables unchanged.
5. Set `after` to the previous `endCursor`.
6. Stop when `hasNextPage` is false.

Example next page:

```json
{
  "operation": "search_issues",
  "variables": { "term": "authentication", "after": "CURSOR_FROM_PAGE_INFO" }
}
```

For a raw query, declare `$after: String` and pass it to the connection:

```graphql
query MoreIssues($after: String) {
  issues(first: 10, after: $after) {
    nodes { id identifier title }
    pageInfo { hasNextPage endCursor }
  }
}
```
