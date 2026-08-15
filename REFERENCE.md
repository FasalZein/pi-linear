# Linear GraphQL reference

Pass a fenced GraphQL document as `query` and the adjacent JSON object as `variables` to `linear_api`.
Use IDs returned by the read queries in mutations. Ask before every mutation.

## Get an issue by identifier

```graphql
query GetIssueByIdentifier($teamKey: String!, $number: Float!) {
  issues(first: 1, filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }) {
    nodes { id identifier title description state { id name type } team { id key name } }
  }
}
```

```json
{ "teamKey": "AEO", "number": 236 }
```

## Search issues

Keep `first: 10` to control context size.

```graphql
query SearchIssues($term: String!) {
  searchIssues(term: $term, first: 10) {
    nodes { id identifier title state { id name type } assignee { id name } }
    pageInfo { hasNextPage endCursor }
  }
}
```

```json
{ "term": "authentication" }
```

## Create an issue

Get `teamId` from **List teams, states, and labels** first.

```graphql
mutation CreateIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { id identifier title state { id name } }
  }
}
```

```json
{ "input": { "teamId": "TEAM_ID", "title": "Issue title", "description": "Markdown description" } }
```

## Update an issue state

Get `issueId` from **Get an issue by identifier**. Get `stateId` from **List teams, states, and labels**.

```graphql
mutation UpdateIssueState($issueId: String!, $stateId: String!) {
  issueUpdate(id: $issueId, input: { stateId: $stateId }) {
    success
    issue { id identifier title state { id name type } }
  }
}
```

```json
{ "issueId": "ISSUE_ID", "stateId": "STATE_ID" }
```

## Add a comment

Get `issueId` from **Get an issue by identifier**.

```graphql
mutation AddComment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
    comment { id body createdAt user { id name } }
  }
}
```

```json
{ "issueId": "ISSUE_ID", "body": "Comment text" }
```

## List teams, states, and labels

```graphql
query ListLinearReferenceData {
  teams(first: 50) {
    nodes {
      id
      key
      name
      states(first: 50) { nodes { id name type } }
      labels(first: 50) { nodes { id name color } }
    }
  }
}
```

```json
{}
```

## List all workflow states

```graphql
query ListWorkflowStates {
  workflowStates(first: 50) {
    nodes { id name type color team { id key name } }
  }
}
```

```json
{}
```

## List all issue labels

```graphql
query ListIssueLabels {
  issueLabels(first: 50) {
    nodes { id name color description team { id key name } }
  }
}
```

```json
{}
```
