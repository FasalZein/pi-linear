# Linear API reference

Version 0.7 of `pi-linear-lite` registers 49 tool surfaces: one active loader, `linear`, plus 48 inactive typed tools. The loader-only `batch` and `get_result` operations add no typed tools. The `linear` tool description publishes the operation catalog. Choose an operation from that catalog and call it directly. Send exactly one of `operation` or `query` to the loader. Send operation inputs through `variables`. Use operation help only when exact parameter names are needed. That call activates the matching typed tool.

## Help protocol

Help is optional. This request returns the accepted domains and examples for the two narrower help forms:

```json
{ "operation": "help" }
```

```json
{ "operation": "help", "variables": { "domain": "issues" } }
```

Domain help returns only the canonical names and compact signatures for that domain.

```json
{ "operation": "help", "variables": { "operation": "update_issue" } }
```

Operation help returns one parameter card and one valid invocation. That response is the authoritative parameter reference. This file does not duplicate 48 full schemas that can change or consume context unnecessarily.

Every typed schema has a provider-safe object root. Save operations enforce exclusive create and update modes inside that root. All save target dates are nullable. The packaged dated schema contract includes initiative and project lead teams, initiative priority and labels, document owners, and create/update label retirement dates. `trashed` remains excluded from typed tools.

Accepted domains are `issues`, `comments`, `users`, `teams`, `projects`, `cycles`, `milestones`, `initiatives`, `documents`, `views`, `labels`, `relations`, and `workspace`. Invalid requests direct the caller to a valid help request instead of returning the full catalog.

<!-- BEGIN GENERATED LINEAR OPERATIONS -->
## Generated operation catalog

| Operation | Typed tool | Domain | Always required | Purpose | First call |
| --- | --- | --- | --- | --- | --- |
| `list_comments` | `linear_list_comments` | comments | none | List comments, optionally for one exact issue. | `{"operation":"list_comments","variables":{"issue":"AEO-258"}}` |
| `create_comment` | `linear_create_comment` | comments | none | Create a comment on an issue or another supported target. | `{"operation":"create_comment","variables":{"issue":"AEO-258","body":"Comment text"}}` |
| `update_comment` | `linear_update_comment` | comments | id | Update a comment by id. | `{"operation":"update_comment","variables":{"id":"comment-id","body":"Updated text"}}` |
| `list_views` | `linear_list_views` | views | none | List custom views. | `{"operation":"list_views","variables":{}}` |
| `get_view` | `linear_get_view` | views | id | Get a custom view. | `{"operation":"get_view","variables":{"id":"view-id"}}` |
| `create_view` | `linear_create_view` | views | name | Create a custom view using filterData, projectFilterData, initiativeFilterData, or feedItemFilterData. | `{"operation":"create_view","variables":{"name":"My issues","filterData":{}}}` |
| `update_view` | `linear_update_view` | views | id | Update a custom view. | `{"operation":"update_view","variables":{"id":"view-id","name":"New name"}}` |
| `set_view_preferences` | `linear_set_view_preferences` | views | viewId, preferences | Set preferences for a custom view. | `{"operation":"set_view_preferences","variables":{"viewId":"view-id","preferences":{}}}` |
| `list_cycles` | `linear_list_cycles` | cycles | none | List cycles. | `{"operation":"list_cycles","variables":{}}` |
| `get_cycle` | `linear_get_cycle` | cycles | cycle | Get a cycle by exact name or UUID. | `{"operation":"get_cycle","variables":{"cycle":"Cycle 12"}}` |
| `create_cycle` | `linear_create_cycle` | cycles | team, startsAt, endsAt | Create a cycle. | `{"operation":"create_cycle","variables":{"team":"AEO","startsAt":"2026-08-17","endsAt":"2026-08-31"}}` |
| `update_cycle` | `linear_update_cycle` | cycles | id | Update a cycle. | `{"operation":"update_cycle","variables":{"id":"cycle-id","name":"Cycle 12"}}` |
| `list_documents` | `linear_list_documents` | documents | none | List documents. | `{"operation":"list_documents","variables":{}}` |
| `get_document` | `linear_get_document` | documents | document | Get a document by exact title or UUID. | `{"operation":"get_document","variables":{"document":"Planning notes"}}` |
| `create_document` | `linear_create_document` | documents | title | Create a document. | `{"operation":"create_document","variables":{"title":"Planning notes","content":"Notes"}}` |
| `update_document` | `linear_update_document` | documents | documentId | Update a document. | `{"operation":"update_document","variables":{"documentId":"document-id","title":"Updated notes"}}` |
| `list_initiatives` | `linear_list_initiatives` | initiatives | none | List initiatives. | `{"operation":"list_initiatives","variables":{}}` |
| `get_initiative` | `linear_get_initiative` | initiatives | initiative | Get an initiative by exact name or UUID. | `{"operation":"get_initiative","variables":{"initiative":"Platform"}}` |
| `list_issue_labels` | `linear_list_issue_labels` | labels | none | List issue labels. | `{"operation":"list_issue_labels","variables":{}}` |
| `create_issue_label` | `linear_create_issue_label` | labels | name | Create an issue label. | `{"operation":"create_issue_label","variables":{"name":"needs-review","color":"#ff0000"}}` |
| `update_issue_label` | `linear_update_issue_label` | labels | id | Update an issue label. | `{"operation":"update_issue_label","variables":{"id":"label-id","name":"review"}}` |
| `list_issue_relations` | `linear_list_issue_relations` | relations | none | List issue relations. | `{"operation":"list_issue_relations","variables":{}}` |
| `create_issue_relation` | `linear_create_issue_relation` | relations | issue, relatedIssue, type | Create a relation between two issues. | `{"operation":"create_issue_relation","variables":{"issue":"AEO-258","relatedIssue":"AEO-259","type":"related"}}` |
| `update_issue_relation` | `linear_update_issue_relation` | relations | id | Update an issue relation. | `{"operation":"update_issue_relation","variables":{"id":"relation-id","type":"blocks"}}` |
| `list_issue_statuses` | `linear_list_issue_statuses` | workspace | none | List issue workflow states. | `{"operation":"list_issue_statuses","variables":{}}` |
| `list_issues` | `linear_list_issues` | issues | none | List issues with exact convenience filters. | `{"operation":"list_issues","variables":{"assignee":"me","stateType":"started"}}` |
| `get_issue` | `linear_get_issue` | issues | issue | Get one issue by exact identifier or UUID. | `{"operation":"get_issue","variables":{"issue":"AEO-258"}}` |
| `create_issue` | `linear_create_issue` | issues | title | Create an issue. A parent reference supplies the team when team is omitted. | `{"operation":"create_issue","variables":{"title":"v0.4 trial child","parent":"AEO-258"}}` |
| `update_issue` | `linear_update_issue` | issues | issue | Update an issue by exact identifier or UUID. | `{"operation":"update_issue","variables":{"issue":"AEO-258","state":"Backlog"}}` |
| `search_issues` | `linear_search_issues` | issues | term | Search issues by text. | `{"operation":"search_issues","variables":{"term":"authentication"}}` |
| `list_milestones` | `linear_list_milestones` | milestones | none | List project milestones. | `{"operation":"list_milestones","variables":{}}` |
| `get_milestone` | `linear_get_milestone` | milestones | milestone | Get a milestone by exact name or UUID. | `{"operation":"get_milestone","variables":{"milestone":"Beta"}}` |
| `list_project_labels` | `linear_list_project_labels` | labels | none | List project labels. | `{"operation":"list_project_labels","variables":{}}` |
| `create_project_label` | `linear_create_project_label` | labels | name | Create a project label. | `{"operation":"create_project_label","variables":{"name":"Strategic"}}` |
| `update_project_label` | `linear_update_project_label` | labels | id | Update a project label. | `{"operation":"update_project_label","variables":{"id":"label-id","name":"Strategy"}}` |
| `list_project_relations` | `linear_list_project_relations` | relations | none | List project relations. | `{"operation":"list_project_relations","variables":{}}` |
| `create_project_relation` | `linear_create_project_relation` | relations | projectId, relatedProjectId, type, anchorType, relatedAnchorType | Create a relation between two projects. | `{"operation":"create_project_relation","variables":{"projectId":"project-id","relatedProjectId":"other-project-id","type":"related","anchorType":"project","relatedAnchorType":"project"}}` |
| `update_project_relation` | `linear_update_project_relation` | relations | id | Update a project relation. | `{"operation":"update_project_relation","variables":{"id":"relation-id","type":"related"}}` |
| `list_projects` | `linear_list_projects` | projects | none | List projects. | `{"operation":"list_projects","variables":{}}` |
| `get_project` | `linear_get_project` | projects | project | Get a project by exact name or UUID. | `{"operation":"get_project","variables":{"project":"Platform"}}` |
| `list_teams` | `linear_list_teams` | teams | none | List teams and workflow states. | `{"operation":"list_teams","variables":{}}` |
| `get_team` | `linear_get_team` | teams | team | Get a team by exact key or UUID. | `{"operation":"get_team","variables":{"team":"AEO"}}` |
| `list_users` | `linear_list_users` | users | none | List users. | `{"operation":"list_users","variables":{}}` |
| `get_user` | `linear_get_user` | users | user | Get a user by me, UUID, email, name, or display name. | `{"operation":"get_user","variables":{"user":"me"}}` |
| `switch_workspace` | `linear_switch_workspace` | workspace | name | Switch the active stored workspace without exposing credentials. | `{"operation":"switch_workspace","variables":{"name":"work"}}` |
| `save_initiative` | `linear_save_initiative` | initiatives | none | Create or update an initiative. | `{"operation":"save_initiative","variables":{"name":"Platform"}}` |
| `save_milestone` | `linear_save_milestone` | milestones | none | Create or update a milestone. | `{"operation":"save_milestone","variables":{"name":"Beta","projectId":"project-id"}}` |
| `save_project` | `linear_save_project` | projects | none | Create or update a project. | `{"operation":"save_project","variables":{"name":"Platform","teamIds":["team-id"]}}` |

### Loader envelopes

```json
{ "operation": "help" }
```

```json
{ "operation": "help", "variables": { "domain": "issues" } }
```

```json
{ "operation": "help", "variables": { "operation": "get_issue" } }
```

```json
{ "operation": "batch", "variables": { "reads": [{ "key": "one", "operation": "get_issue", "variables": { "issue": "AEO-258" } }] } }
```

```json
{ "operation": "get_result", "variables": { "handle": "linear-result:v1:550e8400-e29b-41d4-a716-446655440000", "path": "", "offset": 0 } }
```
<!-- END GENERATED LINEAR OPERATIONS -->

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

The v0.3 `get_issue` shape `{ "teamKey": "AEO", "number": 258 }` remains accepted. Legacy nested `input` mutation shapes also remain accepted where v0.3 exposed them. New calls should use canonical names and the current operation help example.

## Pagination

List operations and `search_issues` return `pageInfo` and accept supported cursor parameters such as `after`, `before`, `first`, and `last`. `search_issues` also returns `totalCount`. `list_issues` does not: `IssueConnection` has no total count, so an incomplete page reports that more results exist without a total. Their operation help cards show the exact parameters. Named operations apply their documented defaults when a size is omitted. Result routing never changes the server request size or returned cursor.

1. Make the first call without `after`.
2. Read `totalCount` when present, then `pageInfo.hasNextPage` and `pageInfo.endCursor`.
3. Repeat the same operation and variables with `after` set to that cursor.
4. Stop when `hasNextPage` is false, or when the returned count equals `totalCount`.

```json
{
  "operation": "search_issues",
  "variables": { "term": "authentication", "after": "CURSOR_FROM_PAGE_INFO" }
}
```

## Result routing

Named singular reads stay complete inline when their serialized result fits Pi's 50KB or 2,000-line custom-tool boundary. Collections, batches, and raw GraphQL results at or above 8KB automatically route to `${PI_ARTIFACT_PROJECT_ROOT:-$HOME/.pi/artifacts}/linear/raw/`. This routing is cardinality-aware: it preserves every returned entity and every caller key.

The returned digest includes a canonical opaque `handle`, full `bytes`, a compact `index`, `meta`, and a legacy compatibility `path`. The artifact contains the complete redacted JSON. Retrieve it through loader-only `{ "operation": "get_result", "variables": { "handle": "linear-result:v1:<UUID>" } }`. Do not use arbitrary file-reading or shell tools. The compatibility path exists only for older integrations.

Use `"sink": "artifact"` to force an artifact. Use `"sink": "inline"` to prefer complete inline output. Pi's boundary can override the inline preference and return one recoverable artifact. The runtime performs no lossy compaction: it does not clip strings, cap returned nodes, remove object fields, remove rows, remove batch keys, or fabricate pagination. Linear's `pageInfo`, `totalCount`, server cursors, and requested page size stay unchanged.

`get_result` returns the complete selected value when it fits. For a large string, array, or object, it returns ordered code-point, item, or property segments. Follow `nextOffset` for the same JSON Pointer `path` until `complete` is true. If one child cannot fit, follow its `externalized` path with the same handle.

Raw GraphQL returns usable partial data with all path-scoped errors instead of discarding successful siblings. Every batch caller key appears exactly once across `data`, `errors`, and `skipped`. A failed key has at most one error record. Its first `path` and `message` remain stable. Multiple path errors add `causes`. Usable failed data appears in `partial`. A batch artifact stores and recovers the complete `{ "data": {}, "errors": [], "skipped": [], "meta": {} }` envelope.

Set `LINEAR_SPILL_BYTES` to change the automatic spill threshold for collection, batch, and raw GraphQL routing.

## Rate-limit telemetry

The extension captures Linear's request, endpoint-request, complexity, reset, endpoint-name, response-complexity, and `Retry-After` headers from each response. This capture makes no extra request. It stays internal and does not change ordinary result JSON.

A result adds one compact `meta.rateLimit` object only when another similar call may exhaust a budget. The request or endpoint scope warns when its remaining count is at most one. The complexity scope warns when its remaining budget is at most the current response's `X-Complexity`. The object contains only received header values, triggered scopes, response attempt identity, and the retry count. Batch responses also identify the read or mutation phase. Artifact routing and `get_result` preserve this object.

HTTP 429 responses keep one automatic retry. For `searchIssues` and `semanticSearch` query reads, a documented GraphQL `RATELIMITED` HTTP 400 response also gets one retry. An explicit `Retry-After` value takes priority. Otherwise, an exhausted endpoint budget uses its endpoint reset time. Other GraphQL validation errors and mutation-body `RATELIMITED` responses do not add retries. Thrown HTTP and GraphQL errors keep redacted telemetry in a non-enumerable internal `linearTelemetry` field without changing the error message.

## Workspaces and authentication

The optional top-level `workspace` argument selects one stored workspace for one request without changing the active workspace:

```json
{ "operation": "get_issue", "variables": { "issue": "AEO-258" }, "workspace": "work" }
```

The named operation `switch_workspace` changes the active stored workspace. `/linear-auth switch <name>` performs the same persistent selection. `/linear-settings` sets the default Human readable or Full JSON result view. That preference lives under the Pi agent state directory and is never stored with credentials. Credential precedence and commands are documented in [`README.md`](./README.md).

## Raw GraphQL and mutation safety

Use `query` only when no named operation covers the work. Select only required fields. Add a small `first:` value to every connection. Include `pageInfo { hasNextPage endCursor }` when another page can matter.

```json
{
  "query": "query Viewer { viewer { id name } }",
  "variables": {}
}
```

The default entry point authorizes safe mutations by canonical or compatible named operation. Each named operation declares exact mutation roots, and the runtime checks its parsed GraphQL document against that declaration and the safe named-root set.

Raw GraphQL mutations are disabled by default. Set `LINEAR_MUTATIONS=all` to allow them. The read-only entry point and `LINEAR_READONLY=1` reject all named and raw mutations, and `LINEAR_MUTATIONS=all` cannot override them. Ask for user authorization before a mutation even when the runtime permits it.
