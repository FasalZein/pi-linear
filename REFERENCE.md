# Linear API reference

Version 1.0.0 of `pi-linear-lite` registers 53 tool surfaces. `linear` and `linear_get_result` start active. `linear_graphql`, `linear_batch`, and 49 typed tools load on demand.

The `linear` tool accepts discovery help only. Callable tool names use underscores.

## Help protocol

Every `linear` call requires `operation: "help"`. Root help returns the accepted domains and exact help forms:

```json
{ "operation": "help" }
```

Domain help returns only the canonical names for that domain:

```json
{ "operation": "help", "variables": { "domain": "issues" } }
```

Normal exact help returns only the operation purpose, canonical example, and additive activation result:

```json
{ "operation": "help", "variables": { "operation": "update_issue" } }
```

The activated `linear_<operation>` schema is the authority for common fields. It has a closed object root and rejects legacy caller names.

A tool description names the advanced route when an operation has rare tail fields. Request the exact tail with:

```json
{ "operation": "help", "variables": { "operation": "update_issue:advanced" } }
```

Advanced help returns the tail names and types. Save operations also return each field's create or update modes.

Send tail fields inside `advanced`. The runtime rejects unknown tail fields, common-field duplicates, and tail fields at the top level.

Exact `graphql` and `batch` help return their direct cards and activate their tools. Exact `get_result` help returns its card without activation.

Save operations enforce separate create and update modes. `view` controls result detail and never satisfies an update change requirement.

Accepted domains are `issues`, `comments`, `users`, `teams`, `projects`, `cycles`, `milestones`, `initiatives`, `documents`, `views`, `labels`, `relations`, and `workspace`.

<!-- BEGIN GENERATED LINEAR OPERATIONS -->
## Generated operation catalog

Use exact loader help to activate an ordinary operation. The table shows one common-tier call for each typed tool.

| Operation | Typed tool | Domain | Always required | Purpose | Typed arguments |
| --- | --- | --- | --- | --- | --- |
| `list_comments` | `linear_list_comments` | comments | none | List comments, optionally for one exact issue. | `{"issue":"AEO-258"}` |
| `create_comment` | `linear_create_comment` | comments | none | Create a comment on an issue or another supported target. | `{"issue":"AEO-258","body":"Comment text"}` |
| `update_comment` | `linear_update_comment` | comments | id | Update a comment by id. | `{"id":"comment-id","body":"Updated text"}` |
| `list_views` | `linear_list_views` | views | none | List custom views. | `{}` |
| `get_view` | `linear_get_view` | views | id | Get a custom view. | `{"id":"view-id"}` |
| `create_view` | `linear_create_view` | views | name | Create a custom view using filterData, projectFilterData, initiativeFilterData, or feedItemFilterData. | `{"name":"My issues","filterData":{"assignee":{"isMe":{"eq":true}}}}` |
| `update_view` | `linear_update_view` | views | id | Update a custom view. | `{"id":"view-id","name":"New name"}` |
| `set_view_preferences` | `linear_set_view_preferences` | views | viewId, preferences | Set preferences for a custom view. | `{"viewId":"view-id","preferences":{"showEmptyGroups":true}}` |
| `list_cycles` | `linear_list_cycles` | cycles | none | List cycles. | `{}` |
| `get_cycle` | `linear_get_cycle` | cycles | cycle | Get a cycle by exact name or UUID. | `{"cycle":"Cycle 12"}` |
| `create_cycle` | `linear_create_cycle` | cycles | team, startsAt, endsAt | Create a cycle. | `{"team":"AEO","startsAt":"2026-08-17","endsAt":"2026-08-31"}` |
| `update_cycle` | `linear_update_cycle` | cycles | cycle | Update a cycle. | `{"cycle":"cycle-id","name":"Cycle 12"}` |
| `list_documents` | `linear_list_documents` | documents | none | List documents. | `{}` |
| `get_document` | `linear_get_document` | documents | document | Get a document by exact title, slug, or UUID. | `{"document":"Planning notes"}` |
| `create_document` | `linear_create_document` | documents | title | Create a document. | `{"title":"Planning notes","content":"Notes"}` |
| `update_document` | `linear_update_document` | documents | document | Update a document. | `{"document":"document-id","title":"Updated notes"}` |
| `list_initiatives` | `linear_list_initiatives` | initiatives | none | List initiatives. | `{}` |
| `get_initiative` | `linear_get_initiative` | initiatives | initiative | Get an initiative by exact name or UUID. | `{"initiative":"Platform"}` |
| `list_issue_labels` | `linear_list_issue_labels` | labels | none | List issue labels. | `{}` |
| `create_issue_label` | `linear_create_issue_label` | labels | name | Create an issue label. | `{"name":"needs-review","color":"#ff0000"}` |
| `update_issue_label` | `linear_update_issue_label` | labels | label | Update an issue label. | `{"label":"label-id","name":"review"}` |
| `list_issue_relations` | `linear_list_issue_relations` | relations | none | List issue relations. | `{}` |
| `create_issue_relation` | `linear_create_issue_relation` | relations | issue, relatedIssue, type | Create a relation between two issues. | `{"issue":"AEO-258","relatedIssue":"AEO-259","type":"related"}` |
| `update_issue_relation` | `linear_update_issue_relation` | relations | id | Update an issue relation. | `{"id":"relation-id","type":"blocks"}` |
| `delete_issue_relation` | `linear_delete_issue_relation` | relations | relationId, issue, relatedIssue, type | Delete one issue relation after exact relation and endpoint verification. | `{"relationId":"33333333-3333-4333-8333-333333333333","issue":"11111111-1111-4111-8111-111111111111","relatedIssue":"22222222-2222-4222-8222-222222222222","type":"related"}` |
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
| `update_project_label` | `linear_update_project_label` | labels | label | Update a project label. | `{"label":"label-id","name":"Strategy"}` |
| `list_project_relations` | `linear_list_project_relations` | relations | none | List project relations. | `{}` |
| `create_project_relation` | `linear_create_project_relation` | relations | project, relatedProject, type, anchorType, relatedAnchorType | Create a relation between two projects. | `{"project":"project-id","relatedProject":"other-project-id","type":"related","anchorType":"project","relatedAnchorType":"project"}` |
| `update_project_relation` | `linear_update_project_relation` | relations | id | Update a project relation. | `{"id":"relation-id","type":"related"}` |
| `list_projects` | `linear_list_projects` | projects | none | List projects. | `{}` |
| `get_project` | `linear_get_project` | projects | project | Get a project by exact name, slug, or UUID. | `{"project":"Platform"}` |
| `list_teams` | `linear_list_teams` | teams | none | List teams and workflow states. | `{}` |
| `get_team` | `linear_get_team` | teams | team | Get a team by exact key or UUID. | `{"team":"AEO"}` |
| `list_users` | `linear_list_users` | users | none | List users. | `{}` |
| `get_user` | `linear_get_user` | users | user | Get a user by me, UUID, email, name, or display name. | `{"user":"me"}` |
| `switch_workspace` | `linear_switch_workspace` | workspace | name | Switch the active stored workspace without exposing credentials. | `{"name":"work"}` |
| `save_initiative` | `linear_save_initiative` | initiatives | none | Create or update an initiative. | `{"name":"Platform"}` |
| `save_milestone` | `linear_save_milestone` | milestones | none | Create or update a milestone. | `{"name":"Beta","project":"project-id"}` |
| `save_project` | `linear_save_project` | projects | none | Create or update a project. | `{"name":"Platform","teams":["AEO"]}` |

### Exact help and typed call

```json
{ "operation": "help", "variables": { "operation": "get_issue" } }
```

Normal exact help returns purpose, example, and activation. Then call `linear_get_issue`:

```json
{ "issue": "AEO-258" }
```

### Advanced tail help

```json
{ "operation": "help", "variables": { "operation": "list_comments:advanced" } }
```

Send returned tail fields inside `advanced`:

```json
{ "issue": "AEO-258", "advanced": { "before": "CURSOR", "last": 20 } }
```

### Discovery and direct exceptional tools

```json
{ "operation": "help" }
```

```json
{ "operation": "help", "variables": { "domain": "issues" } }
```

```json
{ "operation": "help", "variables": { "operation": "graphql" } }
```

Then call `linear_graphql` with direct arguments:

```json
{ "query": "query { viewer { id } }", "variables": {} }
```

```json
{ "operation": "help", "variables": { "operation": "batch" } }
```

Then call `linear_batch` with direct arguments:

```json
{ "operations": [{ "key": "issue", "operation": "get_issue", "variables": { "issue": "AEO-258" } }] }
```

```json
{ "reads": [{ "key": "issue", "operation": "get_issue", "variables": { "issue": "AEO-258" } }], "mutations": [{ "key": "delete", "operation": "delete_issue_relation", "variables": { "relationId": "33333333-3333-4333-8333-333333333333", "issue": "11111111-1111-4111-8111-111111111111", "relatedIssue": "22222222-2222-4222-8222-222222222222", "type": "related" } }] }
```

```json
{ "operation": "help", "variables": { "operation": "get_result" } }
```

This returns the direct parameter card without activation. Call the already-active `linear_get_result` tool:

```json
{ "handle": "linear-result:v1:550e8400-e29b-41d4-a716-446655440000", "path": "", "offset": 0 }
```

## Control tool details

<details>
<summary><code>linear</code> · discovery and activation</summary>

| Field | Type | Requirement |
| --- | --- | --- |
| `operation` | literal `"help"` | required |
| `variables.domain` | operation domain | optional, exclusive with `variables.operation` |
| `variables.operation` | operation name, `<name>:advanced`, `graphql`, `batch`, or `get_result` | optional, exclusive with `variables.domain` |

This tool makes no Linear network request. Root and domain help load no tool. Exact operation help activates one direct tool.

</details>

<details>
<summary><code>linear_get_result</code> · read a stored result</summary>

| Field | Type | Requirement |
| --- | --- | --- |
| `handle` | result handle | required |
| `path` | RFC 6901 JSON Pointer | optional |
| `offset` | integer, minimum 0 | optional |

This tool starts active. Continue with the returned `nextOffset` until `complete` is true.

</details>

<details>
<summary><code>linear_graphql</code> · direct GraphQL escape hatch</summary>

| Field | Type | Requirement |
| --- | --- | --- |
| `query` | GraphQL document string | required |
| `variables` | object | optional |
| `workspace` | stored Workspace name | optional |
| `sink` | `inline` or `artifact` | optional |
| `telemetry` | literal `always` | optional |

Load this tool with exact `graphql` help. Raw mutations require `LINEAR_MUTATIONS=all` and explicit authorization.

</details>

<details>
<summary><code>linear_batch</code> · independent reads and ordered mutations</summary>

| Field | Type | Requirement |
| --- | --- | --- |
| `operations` | non-empty `BatchEntry[]` | use this read-only form, or use phased fields |
| `reads` | non-empty `BatchEntry[]` | optional phased read list |
| `mutations` | non-empty `BatchEntry[]` | optional phased mutation list |
| `workspace` | stored Workspace name | optional |
| `sink` | `inline` or `artifact` | optional |
| `telemetry` | literal `always` | optional |

A `BatchEntry` has `operation`, optional `variables`, and optional `key`. Use `operations`, or use `reads` and `mutations`. Do not combine both forms.

</details>

## Complete typed tool details

These tables come from the same operation definitions that build the runtime schemas.
The activated schema remains authoritative for nested object keys, enum values, and provider validation.

### issues

<details>
<summary><code>linear_list_issues</code> · query · List issues with exact convenience filters.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "list_issues" } }`

**Valid forms**

- No required fields.

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `issues` | `[IssueReference!]` | optional | all calls |
| `query` | `String` | optional | all calls |
| `team` | `TeamReference` | optional | all calls |
| `state` | `StateReference` | optional | all calls |
| `stateType` | `WorkflowStateType` | optional | all calls |
| `assignee` | `UserReference` | optional | all calls |
| `project` | `ProjectReference` | optional | all calls |
| `sort` | `[IssueSort!]` | optional | all calls |
| `first` | `Int` | optional | all calls |
| `after` | `String` | optional | all calls |
| `includeArchived` | `Boolean` | optional | all calls |
| `orderBy` | `PaginationOrderBy` | optional | all calls |
| `filter` | `Filter` | optional | all calls |
| `view` | `ResultView` | optional | all calls |

**Advanced fields**

Load this list with `{ "operation": "help", "variables": { "operation": "list_issues:advanced" } }`.

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `before` | `String` | optional | all calls |
| `last` | `Int` | optional | all calls |

Example: `{"assignee":"me","stateType":"started"}`

Result: Summary collection by default. Set `view` to `full` when the schema publishes it.

Safety: Read or local operation.

</details>

<details>
<summary><code>linear_get_issue</code> · query · Get one issue by exact identifier or UUID.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "get_issue" } }`

**Valid forms**

- `issue`

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `issue` | `IssueReference` | required | all calls |
| `view` | `ResultView` | optional | all calls |

**Advanced fields**

None.

Example: `{"issue":"AEO-258"}`

Result: Full singular result by default.

Safety: Read or local operation.

</details>

<details>
<summary><code>linear_create_issue</code> · mutation · Create an issue. A parent reference supplies the team when team is omitted.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "create_issue" } }`

**Valid forms**

- `title` + `team`
- `title` + `parent`

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `title` | `String` | required | all calls |
| `team` | `TeamReference` | required in some forms | all calls |
| `parent` | `IssueReference` | required in some forms | all calls |
| `state` | `StateReference` | optional | all calls |
| `assignee` | `UserReference` | optional | all calls |
| `dueDate` | `Date` | optional | all calls |
| `description` | `String` | optional | all calls |
| `priority` | `Priority` | optional | all calls |
| `estimate` | `Int` | optional | all calls |
| `project` | `ProjectReference` | optional | all calls |
| `cycle` | `CycleReference` | optional | all calls |
| `labels` | `[LabelReference!]` | optional | all calls |
| `subscribers` | `[UserReference!]` | optional | all calls |
| `view` | `ResultView` | optional | all calls |

**Advanced fields**

Load this list with `{ "operation": "help", "variables": { "operation": "create_issue:advanced" } }`.

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `descriptionData` | `JsonString` | optional | all calls |
| `milestone` | `MilestoneReference` | optional | all calls |
| `delegate` | `UserReference` | optional | all calls |
| `lastAppliedTemplateId` | `UUID` | optional | all calls |
| `slaType` | `SlaDayCountType` | optional | all calls |
| `slaBreachesAt` | `NullableDateTime` | optional | all calls |
| `slaStartedAt` | `NullableDateTime` | optional | all calls |
| `sortOrder` | `Float` | optional | all calls |
| `subIssueSortOrder` | `Float` | optional | all calls |
| `prioritySortOrder` | `Float` | optional | all calls |
| `templateId` | `UUID` | optional | all calls |
| `useDefaultTemplate` | `Boolean` | optional | all calls |
| `preserveSortOrderOnCreate` | `Boolean` | optional | all calls |
| `referenceCommentId` | `UUID` | optional | all calls |
| `sourceCommentId` | `UUID` | optional | all calls |
| `sourcePullRequestCommentId` | `UUID` | optional | all calls |
| `createAsUser` | `String` | optional | all calls |
| `displayIconUrl` | `Url` | optional | all calls |
| `completedAt` | `NullableDateTime` | optional | all calls |
| `createdAt` | `DateTime` | optional | all calls |
| `id` | `UUID` | optional | all calls |

Example: `{"title":"v0.4 trial child","parent":"AEO-258"}`

Result: Compact acknowledgement by default. Set `view` to `full` when the schema publishes it.

Safety: Named mutation. Read-only mode rejects it before credential lookup or network access.

</details>

<details>
<summary><code>linear_update_issue</code> · mutation · Update an issue by exact identifier or UUID.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "update_issue" } }`

**Valid forms**

- `issue` + `title`
- `issue` + `state`
- `issue` + `assignee`
- `issue` + `parent`
- `issue` + `team`
- `issue` + `dueDate`
- `issue` + `addLabels`
- `issue` + `removeLabels`
- `issue` + `description`
- `issue` + `descriptionData`
- `issue` + `priority`
- `issue` + `estimate`
- `issue` + `project`
- `issue` + `milestone`
- `issue` + `cycle`
- `issue` + `labels`
- `issue` + `subscribers`
- `issue` + `delegate`
- `issue` + `lastAppliedTemplateId`
- `issue` + `slaType`
- `issue` + `slaBreachesAt`
- `issue` + `slaStartedAt`
- `issue` + `sortOrder`
- `issue` + `subIssueSortOrder`
- `issue` + `prioritySortOrder`
- `issue` + `autoClosedByParentClosing`
- `issue` + `snoozedBy`
- `issue` + `snoozedUntilAt`

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `issue` | `IssueReference` | required | all calls |
| `title` | `String` | required in some forms | all calls |
| `state` | `StateReference` | required in some forms | all calls |
| `assignee` | `NullableUserReference` | required in some forms | all calls |
| `parent` | `NullableIssueReference` | required in some forms | all calls |
| `team` | `TeamReference` | required in some forms | all calls |
| `dueDate` | `NullableDate` | required in some forms | all calls |
| `addLabels` | `[LabelReference!]` | required in some forms | all calls |
| `removeLabels` | `[LabelReference!]` | required in some forms | all calls |
| `description` | `String` | required in some forms | all calls |
| `priority` | `Priority` | required in some forms | all calls |
| `estimate` | `Int` | required in some forms | all calls |
| `project` | `NullableProjectReference` | required in some forms | all calls |
| `cycle` | `NullableCycleReference` | required in some forms | all calls |
| `labels` | `[LabelReference!]` | required in some forms | all calls |
| `subscribers` | `[UserReference!]` | required in some forms | all calls |
| `view` | `ResultView` | optional | all calls |

**Advanced fields**

Load this list with `{ "operation": "help", "variables": { "operation": "update_issue:advanced" } }`.

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `descriptionData` | `JsonString` | required in some forms | all calls |
| `milestone` | `NullableMilestoneReference` | required in some forms | all calls |
| `delegate` | `UserReference` | required in some forms | all calls |
| `lastAppliedTemplateId` | `UUID` | required in some forms | all calls |
| `slaType` | `SlaDayCountType` | required in some forms | all calls |
| `slaBreachesAt` | `NullableDateTime` | required in some forms | all calls |
| `slaStartedAt` | `NullableDateTime` | required in some forms | all calls |
| `sortOrder` | `Float` | required in some forms | all calls |
| `subIssueSortOrder` | `Float` | required in some forms | all calls |
| `prioritySortOrder` | `Float` | required in some forms | all calls |
| `autoClosedByParentClosing` | `Boolean` | required in some forms | all calls |
| `snoozedBy` | `UserReference` | required in some forms | all calls |
| `snoozedUntilAt` | `NullableDateTime` | required in some forms | all calls |

Example: `{"issue":"AEO-258","state":"Backlog"}`

Result: Compact acknowledgement by default. Set `view` to `full` when the schema publishes it.

Safety: Named mutation. Read-only mode rejects it before credential lookup or network access.

</details>

<details>
<summary><code>linear_search_issues</code> · query · Search issues by text.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "search_issues" } }`

**Valid forms**

- `term`

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `term` | `String` | required | all calls |
| `includeComments` | `Boolean` | optional | all calls |
| `team` | `TeamReference` | optional | all calls |
| `first` | `Int` | optional | all calls |
| `after` | `String` | optional | all calls |
| `includeArchived` | `Boolean` | optional | all calls |
| `orderBy` | `PaginationOrderBy` | optional | all calls |
| `filter` | `Filter` | optional | all calls |
| `view` | `ResultView` | optional | all calls |

**Advanced fields**

Load this list with `{ "operation": "help", "variables": { "operation": "search_issues:advanced" } }`.

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `before` | `String` | optional | all calls |
| `last` | `Int` | optional | all calls |

Example: `{"term":"authentication"}`

Result: Summary collection by default. Set `view` to `full` when the schema publishes it.

Safety: Read or local operation.

</details>

### comments

<details>
<summary><code>linear_list_comments</code> · query · List comments, optionally for one exact issue.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "list_comments" } }`

**Valid forms**

- No required fields.

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `issue` | `IssueReference` | optional | all calls |
| `first` | `Int` | optional | all calls |
| `after` | `String` | optional | all calls |
| `includeArchived` | `Boolean` | optional | all calls |
| `orderBy` | `PaginationOrderBy` | optional | all calls |
| `filter` | `Filter` | optional | all calls |

**Advanced fields**

Load this list with `{ "operation": "help", "variables": { "operation": "list_comments:advanced" } }`.

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `before` | `String` | optional | all calls |
| `last` | `Int` | optional | all calls |

Example: `{"issue":"AEO-258"}`

Result: Summary collection by default. Set `view` to `full` when the schema publishes it.

Safety: Read or local operation.

</details>

<details>
<summary><code>linear_create_comment</code> · mutation · Create a comment on an issue or another supported target.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "create_comment" } }`

**Valid forms**

- `issue` + `body`
- `issue` + `bodyData`
- `project` + `body`
- `project` + `bodyData`
- `initiative` + `body`
- `initiative` + `bodyData`
- `projectUpdateId` + `body`
- `projectUpdateId` + `bodyData`
- `initiativeUpdateId` + `body`
- `initiativeUpdateId` + `bodyData`
- `postId` + `body`
- `postId` + `bodyData`
- `documentContentId` + `body`
- `documentContentId` + `bodyData`
- `parentId` + `body`
- `parentId` + `bodyData`

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `issue` | `IssueReference` | required in some forms | all calls |
| `body` | `String` | required in some forms | all calls |
| `view` | `ResultView` | optional | all calls |

**Advanced fields**

Load this list with `{ "operation": "help", "variables": { "operation": "create_comment:advanced" } }`.

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `project` | `ProjectReference` | required in some forms | all calls |
| `initiative` | `InitiativeReference` | required in some forms | all calls |
| `projectUpdateId` | `UUID` | required in some forms | all calls |
| `initiativeUpdateId` | `UUID` | required in some forms | all calls |
| `postId` | `UUID` | required in some forms | all calls |
| `documentContentId` | `UUID` | required in some forms | all calls |
| `parentId` | `UUID` | required in some forms | all calls |
| `bodyData` | `JsonObject` | required in some forms | all calls |
| `quotedText` | `String` | optional | all calls |
| `doNotSubscribeToIssue` | `Boolean` | optional | all calls |
| `createOnSyncedSlackThread` | `Boolean` | optional | all calls |
| `createdAt` | `DateTime` | optional | all calls |
| `id` | `UUID` | optional | all calls |

Example: `{"issue":"AEO-258","body":"Comment text"}`

Result: Compact acknowledgement by default. Set `view` to `full` when the schema publishes it.

Safety: Named mutation. Read-only mode rejects it before credential lookup or network access.

</details>

<details>
<summary><code>linear_update_comment</code> · mutation · Update a comment by id.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "update_comment" } }`

**Valid forms**

- `id` + `body`
- `id` + `bodyData`
- `id` + `quotedText`

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `id` | `String` | required | all calls |
| `body` | `String` | required in some forms | all calls |
| `bodyData` | `JsonObject` | required in some forms | all calls |
| `quotedText` | `String` | required in some forms | all calls |
| `skipEditedAt` | `Boolean` | optional | all calls |
| `view` | `ResultView` | optional | all calls |

**Advanced fields**

None.

Example: `{"id":"comment-id","body":"Updated text"}`

Result: Compact acknowledgement by default. Set `view` to `full` when the schema publishes it.

Safety: Named mutation. Read-only mode rejects it before credential lookup or network access.

</details>

### users

<details>
<summary><code>linear_list_users</code> · query · List users.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "list_users" } }`

**Valid forms**

- No required fields.

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `includeDisabled` | `Boolean` | optional | all calls |
| `sort` | `[UserSort!]` | optional | all calls |
| `first` | `Int` | optional | all calls |
| `after` | `String` | optional | all calls |
| `includeArchived` | `Boolean` | optional | all calls |
| `orderBy` | `PaginationOrderBy` | optional | all calls |
| `filter` | `Filter` | optional | all calls |

**Advanced fields**

Load this list with `{ "operation": "help", "variables": { "operation": "list_users:advanced" } }`.

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `before` | `String` | optional | all calls |
| `last` | `Int` | optional | all calls |

Example: `{}`

Result: Summary collection by default. Set `view` to `full` when the schema publishes it.

Safety: Read or local operation.

</details>

<details>
<summary><code>linear_get_user</code> · query · Get a user by me, UUID, email, name, or display name.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "get_user" } }`

**Valid forms**

- `user`

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `user` | `UserReference` | required | all calls |

**Advanced fields**

None.

Example: `{"user":"me"}`

Result: Full singular result by default.

Safety: Read or local operation.

</details>

### teams

<details>
<summary><code>linear_list_teams</code> · query · List teams and workflow states.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "list_teams" } }`

**Valid forms**

- No required fields.

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `first` | `Int` | optional | all calls |
| `after` | `String` | optional | all calls |
| `includeArchived` | `Boolean` | optional | all calls |
| `orderBy` | `PaginationOrderBy` | optional | all calls |
| `filter` | `Filter` | optional | all calls |

**Advanced fields**

Load this list with `{ "operation": "help", "variables": { "operation": "list_teams:advanced" } }`.

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `before` | `String` | optional | all calls |
| `last` | `Int` | optional | all calls |

Example: `{}`

Result: Summary collection by default. Set `view` to `full` when the schema publishes it.

Safety: Read or local operation.

</details>

<details>
<summary><code>linear_get_team</code> · query · Get a team by exact key or UUID.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "get_team" } }`

**Valid forms**

- `team`

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `team` | `TeamReference` | required | all calls |

**Advanced fields**

None.

Example: `{"team":"AEO"}`

Result: Full singular result by default.

Safety: Read or local operation.

</details>

### projects

<details>
<summary><code>linear_list_projects</code> · query · List projects.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "list_projects" } }`

**Valid forms**

- No required fields.

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `sort` | `[ProjectSort!]` | optional | all calls |
| `first` | `Int` | optional | all calls |
| `after` | `String` | optional | all calls |
| `includeArchived` | `Boolean` | optional | all calls |
| `orderBy` | `PaginationOrderBy` | optional | all calls |
| `filter` | `Filter` | optional | all calls |
| `view` | `ResultView` | optional | all calls |

**Advanced fields**

Load this list with `{ "operation": "help", "variables": { "operation": "list_projects:advanced" } }`.

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `before` | `String` | optional | all calls |
| `last` | `Int` | optional | all calls |

Example: `{}`

Result: Summary collection by default. Set `view` to `full` when the schema publishes it.

Safety: Read or local operation.

</details>

<details>
<summary><code>linear_get_project</code> · query · Get a project by exact name, slug, or UUID.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "get_project" } }`

**Valid forms**

- `project`

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `project` | `ProjectReference` | required | all calls |
| `view` | `ResultView` | optional | all calls |

**Advanced fields**

None.

Example: `{"project":"Platform"}`

Result: Full singular result by default.

Safety: Read or local operation.

</details>

<details>
<summary><code>linear_save_project</code> · mutation · Create or update a project.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "save_project" } }`

**Valid forms**

**Create forms**

- `name` + `teams`

**Update forms**

- `project` + `name`
- `project` + `teams`
- `project` + `description`
- `project` + `content`
- `project` + `icon`
- `project` + `color`
- `project` + `priority`
- `project` + `startDate`
- `project` + `startDateResolution`
- `project` + `targetDate`
- `project` + `targetDateResolution`
- `project` + `status`
- `project` + `lead`
- `project` + `leadTeam`
- `project` + `members`
- `project` + `labels`
- `project` + `convertedFromIssue`
- `project` + `lastAppliedTemplateId`
- `project` + `sortOrder`
- `project` + `prioritySortOrder`
- `project` + `canceledAt`
- `project` + `completedAt`
- `project` + `projectUpdateRemindersPausedUntilAt`
- `project` + `slackIssueComments`
- `project` + `slackIssueStatuses`
- `project` + `slackNewIssue`
- `project` + `frequencyResolution`
- `project` + `updateReminderFrequency`
- `project` + `updateReminderFrequencyInWeeks`
- `project` + `updateRemindersDay`
- `project` + `updateRemindersHour`


**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `project` | `ProjectReference` | required in some forms | update only |
| `name` | `String` | required in some forms | create and update |
| `teams` | `[TeamReference!]` | required in some forms | create and update |
| `description` | `String` | required in some forms | create and update |
| `content` | `String` | required in some forms | create and update |
| `icon` | `String` | required in some forms | create and update |
| `color` | `Color` | required in some forms | create and update |
| `priority` | `Priority` | required in some forms | create and update |
| `startDate` | `Date` | required in some forms | create and update |
| `targetDate` | `NullableDate` | required in some forms | create and update |
| `status` | `ProjectStatusReference` | required in some forms | create and update |
| `lead` | `UserReference` | required in some forms | create and update |
| `labels` | `[LabelReference!]` | required in some forms | create and update |
| `view` | `ResultView` | optional | create and update |

**Advanced fields**

Load this list with `{ "operation": "help", "variables": { "operation": "save_project:advanced" } }`.

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `startDateResolution` | `DateResolutionType` | required in some forms | create and update |
| `targetDateResolution` | `DateResolutionType` | required in some forms | create and update |
| `leadTeam` | `TeamReference` | required in some forms | create and update |
| `members` | `[UserReference!]` | required in some forms | create and update |
| `convertedFromIssue` | `IssueReference` | required in some forms | create and update |
| `lastAppliedTemplateId` | `UUID` | required in some forms | create and update |
| `sortOrder` | `Float` | required in some forms | create and update |
| `prioritySortOrder` | `Float` | required in some forms | create and update |
| `canceledAt` | `NullableDateTime` | required in some forms | update only |
| `completedAt` | `NullableDateTime` | required in some forms | update only |
| `projectUpdateRemindersPausedUntilAt` | `NullableDateTime` | required in some forms | update only |
| `slackIssueComments` | `Boolean` | required in some forms | update only |
| `slackIssueStatuses` | `Boolean` | required in some forms | update only |
| `slackNewIssue` | `Boolean` | required in some forms | update only |
| `slackChannelName` | `String` | optional | create only |
| `templateId` | `UUID` | optional | create only |
| `useDefaultTemplate` | `Boolean` | optional | create only |
| `id` | `UUID` | optional | create only |
| `frequencyResolution` | `FrequencyResolutionType` | required in some forms | update only |
| `updateReminderFrequency` | `Float` | required in some forms | update only |
| `updateReminderFrequencyInWeeks` | `Float` | required in some forms | update only |
| `updateRemindersDay` | `Day` | required in some forms | update only |
| `updateRemindersHour` | `Float` | required in some forms | update only |

Example: `{"name":"Platform","teams":["AEO"]}`

Result: Compact acknowledgement by default. Set `view` to `full` when the schema publishes it.

Safety: Named mutation. Read-only mode rejects it before credential lookup or network access.

</details>

### cycles

<details>
<summary><code>linear_list_cycles</code> · query · List cycles.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "list_cycles" } }`

**Valid forms**

- No required fields.

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `team` | `TeamReference` | optional | all calls |
| `first` | `Int` | optional | all calls |
| `after` | `String` | optional | all calls |
| `includeArchived` | `Boolean` | optional | all calls |
| `orderBy` | `PaginationOrderBy` | optional | all calls |
| `filter` | `Filter` | optional | all calls |

**Advanced fields**

Load this list with `{ "operation": "help", "variables": { "operation": "list_cycles:advanced" } }`.

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `before` | `String` | optional | all calls |
| `last` | `Int` | optional | all calls |

Example: `{}`

Result: Summary collection by default. Set `view` to `full` when the schema publishes it.

Safety: Read or local operation.

</details>

<details>
<summary><code>linear_get_cycle</code> · query · Get a cycle by exact name or UUID.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "get_cycle" } }`

**Valid forms**

- `cycle`

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `cycle` | `CycleReference` | required | all calls |

**Advanced fields**

None.

Example: `{"cycle":"Cycle 12"}`

Result: Full singular result by default.

Safety: Read or local operation.

</details>

<details>
<summary><code>linear_create_cycle</code> · mutation · Create a cycle.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "create_cycle" } }`

**Valid forms**

- `team` + `startsAt` + `endsAt`

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `team` | `TeamReference` | required | all calls |
| `startsAt` | `DateTime` | required | all calls |
| `endsAt` | `DateTime` | required | all calls |
| `name` | `String` | optional | all calls |
| `description` | `String` | optional | all calls |
| `view` | `ResultView` | optional | all calls |

**Advanced fields**

None.

Example: `{"team":"AEO","startsAt":"2026-08-17","endsAt":"2026-08-31"}`

Result: Compact acknowledgement by default. Set `view` to `full` when the schema publishes it.

Safety: Named mutation. Read-only mode rejects it before credential lookup or network access.

</details>

<details>
<summary><code>linear_update_cycle</code> · mutation · Update a cycle.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "update_cycle" } }`

**Valid forms**

- `cycle` + `name`
- `cycle` + `description`
- `cycle` + `startsAt`
- `cycle` + `endsAt`
- `cycle` + `completedAt`

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `cycle` | `CycleReference` | required | all calls |
| `name` | `String` | required in some forms | all calls |
| `description` | `String` | required in some forms | all calls |
| `startsAt` | `DateTime` | required in some forms | all calls |
| `endsAt` | `DateTime` | required in some forms | all calls |
| `completedAt` | `DateTime` | required in some forms | all calls |
| `view` | `ResultView` | optional | all calls |

**Advanced fields**

None.

Example: `{"cycle":"cycle-id","name":"Cycle 12"}`

Result: Compact acknowledgement by default. Set `view` to `full` when the schema publishes it.

Safety: Named mutation. Read-only mode rejects it before credential lookup or network access.

</details>

### milestones

<details>
<summary><code>linear_list_milestones</code> · query · List project milestones.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "list_milestones" } }`

**Valid forms**

- No required fields.

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `first` | `Int` | optional | all calls |
| `after` | `String` | optional | all calls |
| `includeArchived` | `Boolean` | optional | all calls |
| `orderBy` | `PaginationOrderBy` | optional | all calls |
| `filter` | `Filter` | optional | all calls |

**Advanced fields**

Load this list with `{ "operation": "help", "variables": { "operation": "list_milestones:advanced" } }`.

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `before` | `String` | optional | all calls |
| `last` | `Int` | optional | all calls |

Example: `{}`

Result: Summary collection by default. Set `view` to `full` when the schema publishes it.

Safety: Read or local operation.

</details>

<details>
<summary><code>linear_get_milestone</code> · query · Get a milestone by exact name or UUID.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "get_milestone" } }`

**Valid forms**

- `milestone`

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `milestone` | `MilestoneReference` | required | all calls |

**Advanced fields**

None.

Example: `{"milestone":"Beta"}`

Result: Full singular result by default.

Safety: Read or local operation.

</details>

<details>
<summary><code>linear_save_milestone</code> · mutation · Create or update a milestone.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "save_milestone" } }`

**Valid forms**

**Create forms**

- `name` + `project`

**Update forms**

- `milestone` + `name`
- `milestone` + `project`
- `milestone` + `description`
- `milestone` + `descriptionData`
- `milestone` + `targetDate`
- `milestone` + `sortOrder`


**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `milestone` | `MilestoneReference` | required in some forms | update only |
| `name` | `String` | required in some forms | create and update |
| `project` | `ProjectReference` | required in some forms | create and update |
| `description` | `String` | required in some forms | create and update |
| `descriptionData` | `JsonString` | required in some forms | create and update |
| `targetDate` | `NullableDate` | required in some forms | create and update |
| `sortOrder` | `Float` | required in some forms | create and update |
| `id` | `UUID` | optional | create only |
| `view` | `ResultView` | optional | create and update |

**Advanced fields**

None.

Example: `{"name":"Beta","project":"project-id"}`

Result: Compact acknowledgement by default. Set `view` to `full` when the schema publishes it.

Safety: Named mutation. Read-only mode rejects it before credential lookup or network access.

</details>

### initiatives

<details>
<summary><code>linear_list_initiatives</code> · query · List initiatives.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "list_initiatives" } }`

**Valid forms**

- No required fields.

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `sort` | `[InitiativeSort!]` | optional | all calls |
| `first` | `Int` | optional | all calls |
| `after` | `String` | optional | all calls |
| `includeArchived` | `Boolean` | optional | all calls |
| `orderBy` | `PaginationOrderBy` | optional | all calls |
| `filter` | `Filter` | optional | all calls |

**Advanced fields**

Load this list with `{ "operation": "help", "variables": { "operation": "list_initiatives:advanced" } }`.

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `before` | `String` | optional | all calls |
| `last` | `Int` | optional | all calls |

Example: `{}`

Result: Summary collection by default. Set `view` to `full` when the schema publishes it.

Safety: Read or local operation.

</details>

<details>
<summary><code>linear_get_initiative</code> · query · Get an initiative by exact name or UUID.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "get_initiative" } }`

**Valid forms**

- `initiative`

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `initiative` | `InitiativeReference` | required | all calls |

**Advanced fields**

None.

Example: `{"initiative":"Platform"}`

Result: Full singular result by default.

Safety: Read or local operation.

</details>

<details>
<summary><code>linear_save_initiative</code> · mutation · Create or update an initiative.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "save_initiative" } }`

**Valid forms**

**Create forms**

- `name`

**Update forms**

- `initiative` + `name`
- `initiative` + `description`
- `initiative` + `content`
- `initiative` + `icon`
- `initiative` + `color`
- `initiative` + `status`
- `initiative` + `targetDate`
- `initiative` + `targetDateResolution`
- `initiative` + `owner`
- `initiative` + `leadTeam`
- `initiative` + `sortOrder`
- `initiative` + `prioritySortOrder`
- `initiative` + `priority`
- `initiative` + `labels`
- `initiative` + `customIdentifier`
- `initiative` + `frequencyResolution`
- `initiative` + `updateReminderFrequency`
- `initiative` + `updateReminderFrequencyInWeeks`
- `initiative` + `updateRemindersDay`
- `initiative` + `updateRemindersHour`


**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `initiative` | `InitiativeReference` | required in some forms | update only |
| `name` | `String` | required in some forms | create and update |
| `description` | `String` | required in some forms | create and update |
| `content` | `String` | required in some forms | create and update |
| `icon` | `String` | required in some forms | create and update |
| `color` | `Color` | required in some forms | create and update |
| `status` | `InitiativeStatus` | required in some forms | create and update |
| `targetDate` | `NullableDate` | required in some forms | create and update |
| `owner` | `UserReference` | required in some forms | create and update |
| `priority` | `Priority` | required in some forms | create and update |
| `labels` | `[LabelReference!]` | required in some forms | create and update |
| `view` | `ResultView` | optional | create and update |

**Advanced fields**

Load this list with `{ "operation": "help", "variables": { "operation": "save_initiative:advanced" } }`.

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `targetDateResolution` | `DateResolutionType` | required in some forms | create and update |
| `leadTeam` | `TeamReference` | required in some forms | create and update |
| `sortOrder` | `Float` | required in some forms | create and update |
| `prioritySortOrder` | `Float` | required in some forms | create and update |
| `id` | `UUID` | optional | create only |
| `customIdentifier` | `String` | required in some forms | update only |
| `frequencyResolution` | `FrequencyResolutionType` | required in some forms | update only |
| `updateReminderFrequency` | `Float` | required in some forms | update only |
| `updateReminderFrequencyInWeeks` | `Float` | required in some forms | update only |
| `updateRemindersDay` | `Day` | required in some forms | update only |
| `updateRemindersHour` | `Float` | required in some forms | update only |

Example: `{"name":"Platform"}`

Result: Compact acknowledgement by default. Set `view` to `full` when the schema publishes it.

Safety: Named mutation. Read-only mode rejects it before credential lookup or network access.

</details>

### documents

<details>
<summary><code>linear_list_documents</code> · query · List documents.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "list_documents" } }`

**Valid forms**

- No required fields.

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `sort` | `[DocumentSort!]` | optional | all calls |
| `first` | `Int` | optional | all calls |
| `after` | `String` | optional | all calls |
| `includeArchived` | `Boolean` | optional | all calls |
| `orderBy` | `PaginationOrderBy` | optional | all calls |
| `filter` | `Filter` | optional | all calls |
| `view` | `ResultView` | optional | all calls |

**Advanced fields**

Load this list with `{ "operation": "help", "variables": { "operation": "list_documents:advanced" } }`.

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `before` | `String` | optional | all calls |
| `last` | `Int` | optional | all calls |

Example: `{}`

Result: Summary collection by default. Set `view` to `full` when the schema publishes it.

Safety: Read or local operation.

</details>

<details>
<summary><code>linear_get_document</code> · query · Get a document by exact title, slug, or UUID.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "get_document" } }`

**Valid forms**

- `document`

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `document` | `DocumentReference` | required | all calls |
| `view` | `ResultView` | optional | all calls |

**Advanced fields**

None.

Example: `{"document":"Planning notes"}`

Result: Full singular result by default.

Safety: Read or local operation.

</details>

<details>
<summary><code>linear_create_document</code> · mutation · Create a document.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "create_document" } }`

**Valid forms**

- `title`

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `title` | `String` | required | all calls |
| `content` | `String` | optional | all calls |
| `color` | `Color` | optional | all calls |
| `issue` | `IssueReference` | optional | all calls |
| `team` | `TeamReference` | optional | all calls |
| `project` | `ProjectReference` | optional | all calls |
| `initiative` | `InitiativeReference` | optional | all calls |
| `cycle` | `CycleReference` | optional | all calls |
| `releaseId` | `UUID` | optional | all calls |
| `resourceFolderId` | `UUID` | optional | all calls |
| `lastAppliedTemplateId` | `UUID` | optional | all calls |
| `owner` | `UserReference` | optional | all calls |
| `subscribers` | `[UserReference!]` | optional | all calls |
| `sortOrder` | `Float` | optional | all calls |
| `id` | `UUID` | optional | all calls |
| `view` | `ResultView` | optional | all calls |

**Advanced fields**

None.

Example: `{"title":"Planning notes","content":"Notes"}`

Result: Compact acknowledgement by default. Set `view` to `full` when the schema publishes it.

Safety: Named mutation. Read-only mode rejects it before credential lookup or network access.

</details>

<details>
<summary><code>linear_update_document</code> · mutation · Update a document.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "update_document" } }`

**Valid forms**

- `document` + `title`
- `document` + `content`
- `document` + `color`
- `document` + `issue`
- `document` + `team`
- `document` + `project`
- `document` + `initiative`
- `document` + `cycle`
- `document` + `releaseId`
- `document` + `resourceFolderId`
- `document` + `lastAppliedTemplateId`
- `document` + `owner`
- `document` + `subscribers`
- `document` + `sortOrder`
- `document` + `hiddenAt`

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `document` | `DocumentReference` | required | all calls |
| `title` | `String` | required in some forms | all calls |
| `content` | `String` | required in some forms | all calls |
| `color` | `Color` | required in some forms | all calls |
| `issue` | `IssueReference` | required in some forms | all calls |
| `team` | `TeamReference` | required in some forms | all calls |
| `project` | `ProjectReference` | required in some forms | all calls |
| `initiative` | `InitiativeReference` | required in some forms | all calls |
| `cycle` | `CycleReference` | required in some forms | all calls |
| `releaseId` | `UUID` | required in some forms | all calls |
| `resourceFolderId` | `UUID` | required in some forms | all calls |
| `lastAppliedTemplateId` | `UUID` | required in some forms | all calls |
| `owner` | `UserReference` | required in some forms | all calls |
| `subscribers` | `[UserReference!]` | required in some forms | all calls |
| `sortOrder` | `Float` | required in some forms | all calls |
| `hiddenAt` | `NullableDateTime` | required in some forms | all calls |
| `view` | `ResultView` | optional | all calls |

**Advanced fields**

None.

Example: `{"document":"document-id","title":"Updated notes"}`

Result: Compact acknowledgement by default. Set `view` to `full` when the schema publishes it.

Safety: Named mutation. Read-only mode rejects it before credential lookup or network access.

</details>

### views

<details>
<summary><code>linear_list_views</code> · query · List custom views.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "list_views" } }`

**Valid forms**

- No required fields.

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `first` | `Int` | optional | all calls |
| `after` | `String` | optional | all calls |
| `includeArchived` | `Boolean` | optional | all calls |
| `orderBy` | `PaginationOrderBy` | optional | all calls |
| `filter` | `Filter` | optional | all calls |

**Advanced fields**

Load this list with `{ "operation": "help", "variables": { "operation": "list_views:advanced" } }`.

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `before` | `String` | optional | all calls |
| `last` | `Int` | optional | all calls |

Example: `{}`

Result: Summary collection by default. Set `view` to `full` when the schema publishes it.

Safety: Read or local operation.

</details>

<details>
<summary><code>linear_get_view</code> · query · Get a custom view.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "get_view" } }`

**Valid forms**

- `id`

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `id` | `String` | required | all calls |

**Advanced fields**

None.

Example: `{"id":"view-id"}`

Result: Full singular result by default.

Safety: Read or local operation.

</details>

<details>
<summary><code>linear_create_view</code> · mutation · Create a custom view using filterData, projectFilterData, initiativeFilterData, or feedItemFilterData.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "create_view" } }`

**Valid forms**

- `name`

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `name` | `String` | required | all calls |
| `team` | `TeamReference` | optional | all calls |
| `description` | `String` | optional | all calls |
| `icon` | `String` | optional | all calls |
| `color` | `Color` | optional | all calls |
| `shared` | `Boolean` | optional | all calls |
| `filterData` | `FilterData` | optional | all calls |
| `projectFilterData` | `FilterData` | optional | all calls |
| `initiativeFilterData` | `FilterData` | optional | all calls |
| `feedItemFilterData` | `FilterData` | optional | all calls |
| `view` | `ResultView` | optional | all calls |

**Advanced fields**

None.

Example: `{"name":"My issues","filterData":{"assignee":{"isMe":{"eq":true}}}}`

Result: Compact acknowledgement by default. Set `view` to `full` when the schema publishes it.

Safety: Named mutation. Read-only mode rejects it before credential lookup or network access.

</details>

<details>
<summary><code>linear_update_view</code> · mutation · Update a custom view.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "update_view" } }`

**Valid forms**

- `id` + `name`
- `id` + `description`
- `id` + `icon`
- `id` + `color`
- `id` + `shared`
- `id` + `filterData`
- `id` + `projectFilterData`
- `id` + `initiativeFilterData`
- `id` + `feedItemFilterData`

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `id` | `String` | required | all calls |
| `name` | `String` | required in some forms | all calls |
| `description` | `String` | required in some forms | all calls |
| `icon` | `String` | required in some forms | all calls |
| `color` | `Color` | required in some forms | all calls |
| `shared` | `Boolean` | required in some forms | all calls |
| `filterData` | `FilterData` | required in some forms | all calls |
| `projectFilterData` | `FilterData` | required in some forms | all calls |
| `initiativeFilterData` | `FilterData` | required in some forms | all calls |
| `feedItemFilterData` | `FilterData` | required in some forms | all calls |
| `view` | `ResultView` | optional | all calls |

**Advanced fields**

None.

Example: `{"id":"view-id","name":"New name"}`

Result: Compact acknowledgement by default. Set `view` to `full` when the schema publishes it.

Safety: Named mutation. Read-only mode rejects it before credential lookup or network access.

</details>

<details>
<summary><code>linear_set_view_preferences</code> · mutation · Set preferences for a custom view.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "set_view_preferences" } }`

**Valid forms**

- `viewId` + `preferences`

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `viewId` | `String` | required | all calls |
| `preferences` | `Preferences` | required | all calls |
| `view` | `ResultView` | optional | all calls |

**Advanced fields**

None.

Example: `{"viewId":"view-id","preferences":{"showEmptyGroups":true}}`

Result: Compact acknowledgement by default. Set `view` to `full` when the schema publishes it.

Safety: Named mutation. Read-only mode rejects it before credential lookup or network access.

</details>

### labels

<details>
<summary><code>linear_list_issue_labels</code> · query · List issue labels.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "list_issue_labels" } }`

**Valid forms**

- No required fields.

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `team` | `TeamReference` | optional | all calls |
| `first` | `Int` | optional | all calls |
| `after` | `String` | optional | all calls |
| `includeArchived` | `Boolean` | optional | all calls |
| `orderBy` | `PaginationOrderBy` | optional | all calls |
| `filter` | `Filter` | optional | all calls |

**Advanced fields**

Load this list with `{ "operation": "help", "variables": { "operation": "list_issue_labels:advanced" } }`.

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `before` | `String` | optional | all calls |
| `last` | `Int` | optional | all calls |

Example: `{}`

Result: Summary collection by default. Set `view` to `full` when the schema publishes it.

Safety: Read or local operation.

</details>

<details>
<summary><code>linear_create_issue_label</code> · mutation · Create an issue label.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "create_issue_label" } }`

**Valid forms**

- `name`

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `name` | `String` | required | all calls |
| `team` | `TeamReference` | optional | all calls |
| `description` | `String` | optional | all calls |
| `color` | `Color` | optional | all calls |
| `isGroup` | `Boolean` | optional | all calls |
| `parentId` | `UUID` | optional | all calls |
| `retiredAt` | `DateTime` | optional | all calls |
| `replaceTeamLabels` | `Boolean` | optional | all calls |
| `id` | `UUID` | optional | all calls |
| `view` | `ResultView` | optional | all calls |

**Advanced fields**

None.

Example: `{"name":"needs-review","color":"#ff0000"}`

Result: Compact acknowledgement by default. Set `view` to `full` when the schema publishes it.

Safety: Named mutation. Read-only mode rejects it before credential lookup or network access.

</details>

<details>
<summary><code>linear_update_issue_label</code> · mutation · Update an issue label.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "update_issue_label" } }`

**Valid forms**

- `label` + `name`
- `label` + `description`
- `label` + `color`
- `label` + `isGroup`
- `label` + `parentId`
- `label` + `retiredAt`
- `label` + `replaceTeamLabels`

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `label` | `LabelReference` | required | all calls |
| `name` | `String` | required in some forms | all calls |
| `description` | `String` | required in some forms | all calls |
| `color` | `Color` | required in some forms | all calls |
| `isGroup` | `Boolean` | required in some forms | all calls |
| `parentId` | `UUID` | required in some forms | all calls |
| `retiredAt` | `NullableDateTime` | required in some forms | all calls |
| `replaceTeamLabels` | `Boolean` | required in some forms | all calls |
| `view` | `ResultView` | optional | all calls |

**Advanced fields**

None.

Example: `{"label":"label-id","name":"review"}`

Result: Compact acknowledgement by default. Set `view` to `full` when the schema publishes it.

Safety: Named mutation. Read-only mode rejects it before credential lookup or network access.

</details>

<details>
<summary><code>linear_list_project_labels</code> · query · List project labels.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "list_project_labels" } }`

**Valid forms**

- No required fields.

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `first` | `Int` | optional | all calls |
| `after` | `String` | optional | all calls |
| `includeArchived` | `Boolean` | optional | all calls |
| `orderBy` | `PaginationOrderBy` | optional | all calls |
| `filter` | `Filter` | optional | all calls |

**Advanced fields**

Load this list with `{ "operation": "help", "variables": { "operation": "list_project_labels:advanced" } }`.

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `before` | `String` | optional | all calls |
| `last` | `Int` | optional | all calls |

Example: `{}`

Result: Summary collection by default. Set `view` to `full` when the schema publishes it.

Safety: Read or local operation.

</details>

<details>
<summary><code>linear_create_project_label</code> · mutation · Create a project label.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "create_project_label" } }`

**Valid forms**

- `name`

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `name` | `String` | required | all calls |
| `description` | `String` | optional | all calls |
| `color` | `Color` | optional | all calls |
| `isGroup` | `Boolean` | optional | all calls |
| `parentId` | `UUID` | optional | all calls |
| `retiredAt` | `DateTime` | optional | all calls |
| `view` | `ResultView` | optional | all calls |

**Advanced fields**

None.

Example: `{"name":"Strategic"}`

Result: Compact acknowledgement by default. Set `view` to `full` when the schema publishes it.

Safety: Named mutation. Read-only mode rejects it before credential lookup or network access.

</details>

<details>
<summary><code>linear_update_project_label</code> · mutation · Update a project label.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "update_project_label" } }`

**Valid forms**

- `label` + `name`
- `label` + `description`
- `label` + `color`
- `label` + `isGroup`
- `label` + `parentId`
- `label` + `retiredAt`

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `label` | `LabelReference` | required | all calls |
| `name` | `String` | required in some forms | all calls |
| `description` | `String` | required in some forms | all calls |
| `color` | `Color` | required in some forms | all calls |
| `isGroup` | `Boolean` | required in some forms | all calls |
| `parentId` | `UUID` | required in some forms | all calls |
| `retiredAt` | `NullableDateTime` | required in some forms | all calls |
| `view` | `ResultView` | optional | all calls |

**Advanced fields**

None.

Example: `{"label":"label-id","name":"Strategy"}`

Result: Compact acknowledgement by default. Set `view` to `full` when the schema publishes it.

Safety: Named mutation. Read-only mode rejects it before credential lookup or network access.

</details>

### relations

<details>
<summary><code>linear_list_issue_relations</code> · query · List issue relations.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "list_issue_relations" } }`

**Valid forms**

- No required fields.

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `first` | `Int` | optional | all calls |
| `after` | `String` | optional | all calls |
| `includeArchived` | `Boolean` | optional | all calls |
| `orderBy` | `PaginationOrderBy` | optional | all calls |

**Advanced fields**

Load this list with `{ "operation": "help", "variables": { "operation": "list_issue_relations:advanced" } }`.

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `before` | `String` | optional | all calls |
| `last` | `Int` | optional | all calls |

Example: `{}`

Result: Summary collection by default. Set `view` to `full` when the schema publishes it.

Safety: Read or local operation.

</details>

<details>
<summary><code>linear_create_issue_relation</code> · mutation · Create a relation between two issues.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "create_issue_relation" } }`

**Valid forms**

- `issue` + `relatedIssue` + `type`

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `issue` | `IssueReference` | required | all calls |
| `relatedIssue` | `IssueReference` | required | all calls |
| `type` | `IssueRelationType` | required | all calls |
| `view` | `ResultView` | optional | all calls |

**Advanced fields**

None.

Example: `{"issue":"AEO-258","relatedIssue":"AEO-259","type":"related"}`

Result: Compact acknowledgement by default. Set `view` to `full` when the schema publishes it.

Safety: Named mutation. Read-only mode rejects it before credential lookup or network access.

</details>

<details>
<summary><code>linear_update_issue_relation</code> · mutation · Update an issue relation.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "update_issue_relation" } }`

**Valid forms**

- `id` + `type`
- `id` + `issue`
- `id` + `relatedIssue`

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `id` | `String` | required | all calls |
| `type` | `IssueRelationType` | required in some forms | all calls |
| `issue` | `IssueReference` | required in some forms | all calls |
| `relatedIssue` | `IssueReference` | required in some forms | all calls |
| `view` | `ResultView` | optional | all calls |

**Advanced fields**

None.

Example: `{"id":"relation-id","type":"blocks"}`

Result: Compact acknowledgement by default. Set `view` to `full` when the schema publishes it.

Safety: Named mutation. Read-only mode rejects it before credential lookup or network access.

</details>

<details>
<summary><code>linear_delete_issue_relation</code> · mutation · Delete one issue relation after exact relation and endpoint verification.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "delete_issue_relation" } }`

**Valid forms**

- `relationId` + `issue` + `relatedIssue` + `type`

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `relationId` | `UUID` | required | all calls |
| `issue` | `IssueReference` | required | all calls |
| `relatedIssue` | `IssueReference` | required | all calls |
| `type` | `IssueRelationType` | required | all calls |
| `view` | `ResultView` | optional | all calls |

**Advanced fields**

None.

Example: `{"relationId":"33333333-3333-4333-8333-333333333333","issue":"11111111-1111-4111-8111-111111111111","relatedIssue":"22222222-2222-4222-8222-222222222222","type":"related"}`

Result: Compact acknowledgement by default. Set `view` to `full` when the schema publishes it.

Safety: Guarded destructive mutation. The operation checks the target and its identity before the write.

</details>

<details>
<summary><code>linear_list_project_relations</code> · query · List project relations.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "list_project_relations" } }`

**Valid forms**

- No required fields.

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `first` | `Int` | optional | all calls |
| `after` | `String` | optional | all calls |
| `includeArchived` | `Boolean` | optional | all calls |
| `orderBy` | `PaginationOrderBy` | optional | all calls |

**Advanced fields**

Load this list with `{ "operation": "help", "variables": { "operation": "list_project_relations:advanced" } }`.

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `before` | `String` | optional | all calls |
| `last` | `Int` | optional | all calls |

Example: `{}`

Result: Summary collection by default. Set `view` to `full` when the schema publishes it.

Safety: Read or local operation.

</details>

<details>
<summary><code>linear_create_project_relation</code> · mutation · Create a relation between two projects.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "create_project_relation" } }`

**Valid forms**

- `project` + `relatedProject` + `type` + `anchorType` + `relatedAnchorType`

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `project` | `ProjectReference` | required | all calls |
| `relatedProject` | `ProjectReference` | required | all calls |
| `type` | `String` | required | all calls |
| `anchorType` | `String` | required | all calls |
| `relatedAnchorType` | `String` | required | all calls |
| `milestone` | `MilestoneReference` | optional | all calls |
| `relatedMilestone` | `MilestoneReference` | optional | all calls |
| `view` | `ResultView` | optional | all calls |

**Advanced fields**

None.

Example: `{"project":"project-id","relatedProject":"other-project-id","type":"related","anchorType":"project","relatedAnchorType":"project"}`

Result: Compact acknowledgement by default. Set `view` to `full` when the schema publishes it.

Safety: Named mutation. Read-only mode rejects it before credential lookup or network access.

</details>

<details>
<summary><code>linear_update_project_relation</code> · mutation · Update a project relation.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "update_project_relation" } }`

**Valid forms**

- `id` + `type`
- `id` + `anchorType`
- `id` + `relatedAnchorType`
- `id` + `project`
- `id` + `relatedProject`
- `id` + `milestone`
- `id` + `relatedMilestone`

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `id` | `String` | required | all calls |
| `type` | `String` | required in some forms | all calls |
| `anchorType` | `String` | required in some forms | all calls |
| `relatedAnchorType` | `String` | required in some forms | all calls |
| `project` | `ProjectReference` | required in some forms | all calls |
| `relatedProject` | `ProjectReference` | required in some forms | all calls |
| `milestone` | `MilestoneReference` | required in some forms | all calls |
| `relatedMilestone` | `MilestoneReference` | required in some forms | all calls |
| `view` | `ResultView` | optional | all calls |

**Advanced fields**

None.

Example: `{"id":"relation-id","type":"related"}`

Result: Compact acknowledgement by default. Set `view` to `full` when the schema publishes it.

Safety: Named mutation. Read-only mode rejects it before credential lookup or network access.

</details>

### workspace

<details>
<summary><code>linear_list_issue_statuses</code> · query · List issue workflow states.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "list_issue_statuses" } }`

**Valid forms**

- No required fields.

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `first` | `Int` | optional | all calls |
| `after` | `String` | optional | all calls |
| `includeArchived` | `Boolean` | optional | all calls |
| `orderBy` | `PaginationOrderBy` | optional | all calls |
| `filter` | `Filter` | optional | all calls |

**Advanced fields**

Load this list with `{ "operation": "help", "variables": { "operation": "list_issue_statuses:advanced" } }`.

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `before` | `String` | optional | all calls |
| `last` | `Int` | optional | all calls |

Example: `{}`

Result: Summary collection by default. Set `view` to `full` when the schema publishes it.

Safety: Read or local operation.

</details>

<details>
<summary><code>linear_switch_workspace</code> · local · Switch the active stored workspace without exposing credentials.</summary>

Activate: `{ "operation": "help", "variables": { "operation": "switch_workspace" } }`

**Valid forms**

- `name`

**Common fields**

| Field | Type | Requirement | Mode |
| --- | --- | --- | --- |
| `name` | `String` | required | all calls |

**Advanced fields**

None.

Example: `{"name":"work"}`

Result: Local result. No Linear network request.

Safety: Read or local operation.

</details>
<!-- END GENERATED LINEAR OPERATIONS -->

A batch can combine independent reads with several ordinary mutations. It validates all entries, resolves all References, and applies all safety gates before the first mutation.

Ordinary mutations run in order with one request per entry. The batch stops at the first failure and skips all later mutations without sending them.

A transport, HTTP, or cancellation failure can leave the sent mutation outcome unknown. Check Linear before you retry that mutation.

Several `create_issue` entries can use one `issueBatchCreate` transaction. The batch rejects a mix of this transaction and ordinary mutations.

Guarded `delete_issue_relation` entries place every exact guard in the shared read phase. No guarded delete runs unless all guards match.

## Exact references and fail-closed behavior

Named operations use one Reference name for each object concept. They resolve human References before the final request:

- Issue References accept only an exact `TEAM-123` identifier or UUID.
- Team References accept only an exact team key or UUID.
- State References accept an exact state name or UUID and must belong to the target team.
- User References accept `me`, an exact UUID, or one exact email, name, or display name.
- Project and document References accept an exact supported name, slug, or UUID.
- Initiative, cycle, milestone, label, and view References accept an exact supported name or UUID.

Resolution requires exactly one match. Missing, ambiguous, fuzzy, malformed, or mismatched results fail before a mutation.

The extension stores no default project or default team. Every call supplies its required context. A `create_issue` parent can supply its team.

Typed tools publish no `workspace` field. Workspace selection is independent from project and team References.

Use `null` only for fields whose schema type is nullable. In these fields, `null` clears the existing association or date.

The [v1.0 changelog](./CHANGELOG.md#100) lists every v0.9 field rename and every field moved into `advanced`.

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

List operations and `search_issues` return `pageInfo`. The common tier publishes forward paging with `first` and `after`.

Backward paging stays available in the advanced tail with `before` and `last`. Request exact `<operation>:advanced` help before using it.

`search_issues` also returns `totalCount`. `list_issues` does not because `IssueConnection` has no total count.

Named operations apply their documented page-size defaults when a size is omitted. Result routing never changes the server request size or returned cursor.

1. Make the first call without `after`.
2. Read `totalCount` when present, then `pageInfo.hasNextPage` and `pageInfo.endCursor`.
3. Repeat the same operation and variables with `after` set to that cursor.
4. Stop when `hasNextPage` is false, or when the returned count equals `totalCount`.

Call `linear_search_issues` with direct arguments:

```json
{ "term": "authentication", "after": "CURSOR_FROM_PAGE_INFO" }
```

## Result routing

Singular reads default to `full`. Collection reads default to `summary`.

Mutations default to a compact `summary` acknowledgement from the validated server result. Set `view` to `full` for the complete mutation entity.

Complete routed results stay inline when they fit Pi's 50KB or 2,000-line custom-tool boundary. Larger results route to `${PI_ARTIFACT_PROJECT_ROOT:-$HOME/.pi/artifacts}/linear/raw/`.

The returned digest includes a canonical opaque `handle`, full `bytes`, a compact `index`, `meta`, and a legacy compatibility `path`. The artifact contains the complete redacted JSON. Retrieve it through `linear_get_result({"handle":"linear-result:v1:<UUID>"})`. Do not use arbitrary file-reading or shell tools. The compatibility path exists only for older integrations.

Use `"sink": "artifact"` to force an artifact. Use `"sink": "inline"` to prefer complete inline output. Pi's boundary can override the inline preference and return one recoverable artifact. The runtime performs no lossy compaction: it does not clip strings, cap returned nodes, remove object fields, remove rows, remove batch keys, or fabricate pagination. Linear's `pageInfo`, `totalCount`, server cursors, and requested page size stay unchanged.

`linear_get_result` returns the complete selected value when it fits. For a large string, array, or object, it returns ordered code-point, item, or property segments. Follow `nextOffset` for the same JSON Pointer `path` until `complete` is true. If one child cannot fit, follow its `externalized` path with the same handle.

Raw GraphQL returns usable partial data with all path-scoped errors instead of discarding successful siblings. Every batch caller key appears exactly once across `data`, `errors`, and `skipped`. A failed key has at most one error record. Its first `path` and `message` remain stable. Multiple path errors add `causes`. Usable failed data appears in `partial`. A batch artifact stores and recovers the complete `{ "data": {}, "errors": [], "skipped": [], "meta": {} }` envelope.

Set `LINEAR_SPILL_BYTES` only to apply an explicit lower automatic spill threshold to collection, batch, and raw GraphQL routing.

## Rate-limit telemetry

The extension captures Linear's request, endpoint-request, complexity, reset, endpoint-name, response-complexity, and `Retry-After` headers from each response. This capture makes no extra request. It stays internal and does not change ordinary result JSON.

A result adds one compact `meta.rateLimit` object only when another similar call may exhaust a budget. The request or endpoint scope warns when its remaining count is at most one. The complexity scope warns when its remaining budget is at most the current response's `X-Complexity`. The object contains only received header values, triggered scopes, response attempt identity, and the retry count. Batch responses also identify the read or mutation phase. Artifact routing and `get_result` preserve this object.

For an explicit diagnostic measurement, set top-level `"telemetry": "always"` on the direct tool that performs the request.

Use `linear_batch` for batch work. Use `linear_graphql` for raw GraphQL. Use the applicable typed `linear_*` tool for named work.

This override includes the same redacted object for healthy responses. Healthy output uses `"scopes": []`. It does not claim exhaustion. Routine calls must omit it.

HTTP 429 responses keep one automatic retry. For `searchIssues` and `semanticSearch` query reads, a documented GraphQL `RATELIMITED` HTTP 400 response also gets one retry. An explicit `Retry-After` value takes priority. Otherwise, an exhausted endpoint budget uses its endpoint reset time. Other GraphQL validation errors and mutation-body `RATELIMITED` responses do not add retries. Thrown HTTP and GraphQL errors keep redacted telemetry in a non-enumerable internal `linearTelemetry` field without changing the error message.

## Workspaces and authentication

A Workspace is a named Linear account and credential selection. It is not a Linear organization name, Pi working directory, project, or team.

Typed tools do not accept `workspace`. Use `linear_switch_workspace` or `/linear-auth switch <name>` to change the active stored Workspace.

`linear_graphql` and `linear_batch` accept an explicit `workspace` override for cross-account work. The override does not change the active Workspace.

The extension stores no default project or default team. `/linear-settings` controls Human readable or Full JSON display only.

The display preference lives under the Pi agent state directory. It is never stored with credentials.

## Raw GraphQL and mutation safety

Use exact `graphql` help to activate `linear_graphql`. Call `linear_graphql` only when no named operation covers the work. Select only required fields. Add a small `first:` value to every connection. Include `pageInfo { hasNextPage endCursor }` when another page can matter.

```json
{
  "query": "query Viewer { viewer { id name } }",
  "variables": {}
}
```

The default entry point authorizes safe mutations by canonical or compatible named operation. Each named operation declares exact mutation roots, and the runtime checks its parsed GraphQL document against that declaration and the safe named-root set.

Common and advanced fields use the same mutation checks. The `advanced` wrapper does not widen mutation authority.

Raw GraphQL mutations are disabled by default. Set `LINEAR_MUTATIONS=all` to allow them. The guarded `delete_issue_relation` operation uses normal named mutation authority and does not require that setting. The read-only entry point and `LINEAR_READONLY=1` reject all named and raw mutations, and `LINEAR_MUTATIONS=all` cannot override them. Ask for user authorization before a mutation even when the runtime permits it.
