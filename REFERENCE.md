# Linear API reference

Version 0.9 of `pi-linear-lite` registers 53 tool surfaces: active `linear` and `linear_get_result`, deferred `linear_graphql` and `linear_batch`, plus 49 inactive typed tools. Legacy loader batch, `get_result`, and raw `query` routes remain compatible but are deprecated. The `linear` tool publishes compact discovery. For an ordinary operation, send exact help, then call the activated `linear_<operation>` tool with direct arguments. Send exact `graphql` or `batch` help before calling the matching direct exceptional tool. Only `"telemetry": "always"` is valid.

## Help protocol

Help is optional. This request returns the accepted domains plus exact-operation, GraphQL, batch, and result-retrieval help links:

```json
{ "operation": "help" }
```

```json
{ "operation": "help", "variables": { "domain": "issues" } }
```

Domain help returns only the canonical names for that domain. Exact operation help returns purpose, parameters, accepted branches, and an example.

```json
{ "operation": "help", "variables": { "operation": "update_issue" } }
```

Operation help returns one parameter card and direct arguments for the activated typed tool. For example, call `linear_update_issue` with the returned arguments. This response is the authoritative parameter reference. This file does not duplicate 49 full schemas that can change or consume context unnecessarily.

Every typed schema has a provider-safe object root. Save operations enforce exclusive create and update modes inside that root. All save target dates are nullable. The packaged dated schema contract includes initiative and project lead teams, initiative priority and labels, document owners, and create/update label retirement dates. `trashed` remains excluded from typed tools.

Accepted domains are `issues`, `comments`, `users`, `teams`, `projects`, `cycles`, `milestones`, `initiatives`, `documents`, `views`, `labels`, `relations`, and `workspace`. Invalid requests direct the caller to a valid help request instead of returning the full catalog.

<!-- BEGIN GENERATED LINEAR OPERATIONS -->
## Generated operation catalog

Use exact loader help to activate an ordinary operation. Then call its typed tool with the direct arguments in the table.

| Operation | Typed tool | Domain | Always required | Purpose | Typed arguments |
| --- | --- | --- | --- | --- | --- |
| `list_comments` | `linear_list_comments` | comments | none | List comments, optionally for one exact issue. | `{"issue":"AEO-258"}` |
| `create_comment` | `linear_create_comment` | comments | none | Create a comment on an issue or another supported target. | `{"issue":"AEO-258","body":"Comment text"}` |
| `update_comment` | `linear_update_comment` | comments | id | Update a comment by id. | `{"id":"comment-id","body":"Updated text"}` |
| `list_views` | `linear_list_views` | views | none | List custom views. | `{}` |
| `get_view` | `linear_get_view` | views | id | Get a custom view. | `{"id":"view-id"}` |
| `create_view` | `linear_create_view` | views | name | Create a custom view using filterData, projectFilterData, initiativeFilterData, or feedItemFilterData. | `{"name":"My issues","filterData":{"assignee":"me"}}` |
| `update_view` | `linear_update_view` | views | id | Update a custom view. | `{"id":"view-id","name":"New name"}` |
| `set_view_preferences` | `linear_set_view_preferences` | views | viewId, preferences | Set preferences for a custom view. | `{"viewId":"view-id","preferences":{"showEmptyGroups":true}}` |
| `list_cycles` | `linear_list_cycles` | cycles | none | List cycles. | `{}` |
| `get_cycle` | `linear_get_cycle` | cycles | cycle | Get a cycle by exact name or UUID. | `{"cycle":"Cycle 12"}` |
| `create_cycle` | `linear_create_cycle` | cycles | team, startsAt, endsAt | Create a cycle. | `{"team":"AEO","startsAt":"2026-08-17","endsAt":"2026-08-31"}` |
| `update_cycle` | `linear_update_cycle` | cycles | id | Update a cycle. | `{"id":"cycle-id","name":"Cycle 12"}` |
| `list_documents` | `linear_list_documents` | documents | none | List documents. | `{}` |
| `get_document` | `linear_get_document` | documents | document | Get a document by exact title or UUID. | `{"document":"Planning notes"}` |
| `create_document` | `linear_create_document` | documents | title | Create a document. | `{"title":"Planning notes","content":"Notes"}` |
| `update_document` | `linear_update_document` | documents | documentId | Update a document. | `{"documentId":"document-id","title":"Updated notes"}` |
| `list_initiatives` | `linear_list_initiatives` | initiatives | none | List initiatives. | `{}` |
| `get_initiative` | `linear_get_initiative` | initiatives | initiative | Get an initiative by exact name or UUID. | `{"initiative":"Platform"}` |
| `list_issue_labels` | `linear_list_issue_labels` | labels | none | List issue labels. | `{}` |
| `create_issue_label` | `linear_create_issue_label` | labels | name | Create an issue label. | `{"name":"needs-review","color":"#ff0000"}` |
| `update_issue_label` | `linear_update_issue_label` | labels | id | Update an issue label. | `{"id":"label-id","name":"review"}` |
| `list_issue_relations` | `linear_list_issue_relations` | relations | none | List issue relations. | `{}` |
| `create_issue_relation` | `linear_create_issue_relation` | relations | issue, relatedIssue, type | Create a relation between two issues. | `{"issue":"AEO-258","relatedIssue":"AEO-259","type":"related"}` |
| `update_issue_relation` | `linear_update_issue_relation` | relations | id | Update an issue relation. | `{"id":"relation-id","type":"blocks"}` |
| `delete_issue_relation` | `linear_delete_issue_relation` | relations | relationId, issueId, relatedIssueId, type | Delete one issue relation after exact relation and endpoint verification. | `{"relationId":"33333333-3333-4333-8333-333333333333","issueId":"11111111-1111-4111-8111-111111111111","relatedIssueId":"22222222-2222-4222-8222-222222222222","type":"related"}` |
| `list_issue_statuses` | `linear_list_issue_statuses` | workspace | none | List issue workflow states. | `{}` |
| `list_issues` | `linear_list_issues` | issues | none | List issues with exact convenience filters. | `{"assignee":"me","stateType":"started"}` |
| `get_issue` | `linear_get_issue` | issues | issue | Get one issue by exact identifier or UUID. | `{"issue":"AEO-258"}` |
| `create_issue` | `linear_create_issue` | issues | title | Create an issue. A parent reference supplies the team when team is omitted. | `{"title":"v0.4 trial child","parent":"AEO-258"}` |
| `update_issue` | `linear_update_issue` | issues | issue | Update an issue by exact identifier or UUID. | `{"issue":"AEO-258","state":"Backlog"}` |
| `search_issues` | `linear_search_issues` | issues | term | Search issues by text. | `{"term":"authentication"}` |
| `list_milestones` | `linear_list_milestones` | milestones | none | List project milestones. | `{}` |
| `get_milestone` | `linear_get_milestone` | milestones | milestone | Get a milestone by exact name or UUID. | `{"milestone":"Beta"}` |
| `list_project_labels` | `linear_list_project_labels` | labels | none | List project labels. | `{}` |
| `create_project_label` | `linear_create_project_label` | labels | name | Create a project label. | `{"name":"Strategic"}` |
| `update_project_label` | `linear_update_project_label` | labels | id | Update a project label. | `{"id":"label-id","name":"Strategy"}` |
| `list_project_relations` | `linear_list_project_relations` | relations | none | List project relations. | `{}` |
| `create_project_relation` | `linear_create_project_relation` | relations | projectId, relatedProjectId, type, anchorType, relatedAnchorType | Create a relation between two projects. | `{"projectId":"project-id","relatedProjectId":"other-project-id","type":"related","anchorType":"project","relatedAnchorType":"project"}` |
| `update_project_relation` | `linear_update_project_relation` | relations | id | Update a project relation. | `{"id":"relation-id","type":"related"}` |
| `list_projects` | `linear_list_projects` | projects | none | List projects. | `{}` |
| `get_project` | `linear_get_project` | projects | project | Get a project by exact name or UUID. | `{"project":"Platform"}` |
| `list_teams` | `linear_list_teams` | teams | none | List teams and workflow states. | `{}` |
| `get_team` | `linear_get_team` | teams | team | Get a team by exact key or UUID. | `{"team":"AEO"}` |
| `list_users` | `linear_list_users` | users | none | List users. | `{}` |
| `get_user` | `linear_get_user` | users | user | Get a user by me, UUID, email, name, or display name. | `{"user":"me"}` |
| `switch_workspace` | `linear_switch_workspace` | workspace | name | Switch the active stored workspace without exposing credentials. | `{"name":"work"}` |
| `save_initiative` | `linear_save_initiative` | initiatives | none | Create or update an initiative. | `{"name":"Platform"}` |
| `save_milestone` | `linear_save_milestone` | milestones | none | Create or update a milestone. | `{"name":"Beta","projectId":"project-id"}` |
| `save_project` | `linear_save_project` | projects | none | Create or update a project. | `{"name":"Platform","teamIds":["team-id"]}` |

### Exact help and typed call

```json
{ "operation": "help", "variables": { "operation": "get_issue" } }
```

Then call `linear_get_issue`:

```json
{ "issue": "AEO-258" }
```

### Discovery, direct exceptional tools, and retained compatibility envelopes

```json
{ "operation": "help" }
```

```json
{ "operation": "help", "variables": { "domain": "issues" } }
```

```json
{ "operation": "help", "variables": { "operation": "batch" } }
```

Then call `linear_batch` with direct arguments:

```json
{ "operations": [{ "key": "issue", "operation": "get_issue", "variables": { "issue": "AEO-258" } }] }
```

```json
{ "reads": [{ "key": "issue", "operation": "get_issue", "variables": { "issue": "AEO-258" } }], "mutations": [{ "key": "delete", "operation": "delete_issue_relation", "variables": { "relationId": "33333333-3333-4333-8333-333333333333", "issueId": "11111111-1111-4111-8111-111111111111", "relatedIssueId": "22222222-2222-4222-8222-222222222222", "type": "related" } }] }
```

```json
{ "handle": "linear-result:v1:550e8400-e29b-41d4-a716-446655440000", "path": "", "offset": 0 }
```

Call the direct `linear_get_result` tool with that object. Legacy `linear` batch and `get_result` envelopes remain compatible but are deprecated.
<!-- END GENERATED LINEAR OPERATIONS -->

A batch can combine independent reads with one guarded `delete_issue_relation`. Its read request includes the exact relation preflight. The delete request runs only after every guard matches and the read-error gate passes.

## Exact references and fail-closed behavior

Named operations resolve human references before the final request:

- Issue references accept only an exact `TEAM-123` identifier or UUID.
- Team references accept only an exact team key or UUID.
- State references accept an exact state name or UUID and must belong to the target team.
- User references accept `me`, an exact UUID, or one exact email, name, or display name.
- Projects, initiatives, cycles, documents, milestones, and views accept an exact supported name or UUID.

Resolution requires exactly one match. Missing, ambiguous, fuzzy, malformed, or mismatched results fail before a mutation. Issue and team responses are checked against the requested identifier, key, UUID, and team. Parent and state references are checked against the target issue team.

## Hidden v0.3 compatibility

Canonical names appear in help. These v0.3 names remain accepted but hidden:

| Hidden alias | Canonical operation |
| --- | --- |
| `add_comment` | `create_comment` |
| `create_relation` | `create_issue_relation` |
| `list_workflow_states` | `list_issue_statuses` |
| `update_issue_state` | `update_issue` |

The v0.3 `get_issue` shape `{ "teamKey": "AEO", "number": 258 }` and legacy nested `input` mutation shapes remain internal compatibility inputs for retained batch entries. New ordinary calls must use exact help, then the canonical typed tool and its direct example.

## Pagination

List operations and `search_issues` return `pageInfo` and accept supported cursor parameters such as `after`, `before`, `first`, and `last`. `search_issues` also returns `totalCount`. `list_issues` does not: `IssueConnection` has no total count, so an incomplete page reports that more results exist without a total. Their operation help cards show the exact parameters. Named operations apply their documented defaults when a size is omitted. Result routing never changes the server request size or returned cursor.

1. Make the first call without `after`.
2. Read `totalCount` when present, then `pageInfo.hasNextPage` and `pageInfo.endCursor`.
3. Repeat the same operation and variables with `after` set to that cursor.
4. Stop when `hasNextPage` is false, or when the returned count equals `totalCount`.

Call `linear_search_issues` with direct arguments:

```json
{ "term": "authentication", "after": "CURSOR_FROM_PAGE_INFO" }
```

## Result routing

Named singular reads stay complete inline when their serialized result fits Pi's 50KB or 2,000-line custom-tool boundary. Collections, batches, and raw GraphQL results at or above 8KB automatically route to `${PI_ARTIFACT_PROJECT_ROOT:-$HOME/.pi/artifacts}/linear/raw/`. This routing is cardinality-aware: it preserves every returned entity and every caller key.

The returned digest includes a canonical opaque `handle`, full `bytes`, a compact `index`, `meta`, and a legacy compatibility `path`. The artifact contains the complete redacted JSON. Retrieve it through `linear_get_result({"handle":"linear-result:v1:<UUID>"})`. Do not use arbitrary file-reading or shell tools. The compatibility path exists only for older integrations.

Use `"sink": "artifact"` to force an artifact. Use `"sink": "inline"` to prefer complete inline output. Pi's boundary can override the inline preference and return one recoverable artifact. The runtime performs no lossy compaction: it does not clip strings, cap returned nodes, remove object fields, remove rows, remove batch keys, or fabricate pagination. Linear's `pageInfo`, `totalCount`, server cursors, and requested page size stay unchanged.

`linear_get_result` returns the complete selected value when it fits. For a large string, array, or object, it returns ordered code-point, item, or property segments. Follow `nextOffset` for the same JSON Pointer `path` until `complete` is true. If one child cannot fit, follow its `externalized` path with the same handle.

Raw GraphQL returns usable partial data with all path-scoped errors instead of discarding successful siblings. Every batch caller key appears exactly once across `data`, `errors`, and `skipped`. A failed key has at most one error record. Its first `path` and `message` remain stable. Multiple path errors add `causes`. Usable failed data appears in `partial`. A batch artifact stores and recovers the complete `{ "data": {}, "errors": [], "skipped": [], "meta": {} }` envelope.

Set `LINEAR_SPILL_BYTES` to change the automatic spill threshold for collection, batch, and raw GraphQL routing.

## Rate-limit telemetry

The extension captures Linear's request, endpoint-request, complexity, reset, endpoint-name, response-complexity, and `Retry-After` headers from each response. This capture makes no extra request. It stays internal and does not change ordinary result JSON.

A result adds one compact `meta.rateLimit` object only when another similar call may exhaust a budget. The request or endpoint scope warns when its remaining count is at most one. The complexity scope warns when its remaining budget is at most the current response's `X-Complexity`. The object contains only received header values, triggered scopes, response attempt identity, and the retry count. Batch responses also identify the read or mutation phase. Artifact routing and `get_result` preserve this object.

For an explicit diagnostic measurement, set top-level `"telemetry": "always"` on the exact direct tool that performs the request: `linear_batch` for batch work, `linear_graphql` for raw GraphQL, or the applicable typed `linear_*` tool for named work. This override includes the same redacted object for healthy responses. Healthy output uses `"scopes": []`; it does not claim exhaustion. The deprecated loader routes still accept top-level telemetry for compatibility. Routine calls must omit it.

HTTP 429 responses keep one automatic retry. For `searchIssues` and `semanticSearch` query reads, a documented GraphQL `RATELIMITED` HTTP 400 response also gets one retry. An explicit `Retry-After` value takes priority. Otherwise, an exhausted endpoint budget uses its endpoint reset time. Other GraphQL validation errors and mutation-body `RATELIMITED` responses do not add retries. Thrown HTTP and GraphQL errors keep redacted telemetry in a non-enumerable internal `linearTelemetry` field without changing the error message.

## Workspaces and authentication

The optional `workspace` argument selects one stored workspace for one typed call without changing the active workspace. For example, call `linear_get_issue` with:

```json
{ "issue": "AEO-258", "workspace": "work" }
```

The named operation `switch_workspace` changes the active stored workspace. `/linear-auth switch <name>` performs the same persistent selection. `/linear-settings` sets the default Human readable or Full JSON result view. That preference lives under the Pi agent state directory and is never stored with credentials. Credential precedence and commands are documented in [`README.md`](./README.md).

## Raw GraphQL and mutation safety

Use exact `graphql` help to activate `linear_graphql`. Call `linear_graphql` only when no named operation covers the work. Select only required fields. Add a small `first:` value to every connection. Include `pageInfo { hasNextPage endCursor }` when another page can matter.

```json
{
  "query": "query Viewer { viewer { id name } }",
  "variables": {}
}
```

The default entry point authorizes safe mutations by canonical or compatible named operation. Each named operation declares exact mutation roots, and the runtime checks its parsed GraphQL document against that declaration and the safe named-root set.

Raw GraphQL mutations are disabled by default. Set `LINEAR_MUTATIONS=all` to allow them. The guarded `delete_issue_relation` operation uses normal named mutation authority and does not require that setting. The read-only entry point and `LINEAR_READONLY=1` reject all named and raw mutations, and `LINEAR_MUTATIONS=all` cannot override them. Ask for user authorization before a mutation even when the runtime permits it.
