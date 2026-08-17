# Linear API reference

`pi-linear-lite` registers one tool: `linear_api`. Send exactly one of `operation` or `query`. Send operation inputs through `variables`.

## Help protocol

Use this exact bootstrap request:

```json
{ "operation": "help" }
```

It returns the accepted domains and examples for the two narrower help forms.

```json
{ "operation": "help", "variables": { "domain": "issues" } }
```

Domain help returns only the canonical names and compact signatures for that domain.

```json
{ "operation": "help", "variables": { "operation": "update_issue" } }
```

Operation help returns one parameter card and one valid invocation. That response is the authoritative parameter reference. This file does not duplicate 48 full schemas that can change or consume context unnecessarily.

Accepted domains are `issues`, `comments`, `users`, `teams`, `projects`, `cycles`, `milestones`, `initiatives`, `documents`, `views`, `labels`, `relations`, and `workspace`. Invalid requests direct the caller to a valid help request instead of returning the full catalog.

## Canonical operation catalog

The catalog contains these 48 non-destructive operations. Delete and archive operations are not present.

### Issues

- `list_issues`
- `get_issue`
- `create_issue`
- `update_issue`
- `search_issues`

### Comments

- `list_comments`
- `create_comment`
- `update_comment`

### Users

- `list_users`
- `get_user`

### Teams

- `list_teams`
- `get_team`

### Projects

- `list_projects`
- `get_project`
- `save_project`

### Cycles

- `list_cycles`
- `get_cycle`
- `create_cycle`
- `update_cycle`

### Milestones

- `list_milestones`
- `get_milestone`
- `save_milestone`

### Initiatives

- `list_initiatives`
- `get_initiative`
- `save_initiative`

### Documents

- `list_documents`
- `get_document`
- `create_document`
- `update_document`

### Views

- `list_views`
- `get_view`
- `create_view`
- `update_view`
- `set_view_preferences`

### Labels

- `list_issue_labels`
- `create_issue_label`
- `update_issue_label`
- `list_project_labels`
- `create_project_label`
- `update_project_label`

### Relations

- `list_issue_relations`
- `create_issue_relation`
- `update_issue_relation`
- `list_project_relations`
- `create_project_relation`
- `update_project_relation`

### Workspace

- `list_issue_statuses`
- `switch_workspace`

## Canonical first calls

Read an issue:

```json
{ "operation": "get_issue", "variables": { "issue": "AEO-258" } }
```

Comment on an issue:

```json
{ "operation": "create_comment", "variables": { "issue": "AEO-258", "body": "Status update" } }
```

List the current user's in-progress issues:

```json
{ "operation": "list_issues", "variables": { "assignee": "me", "state": "In Progress" } }
```

Create a child issue under `AEO-258` in Backlog. The parent supplies the team for exact state resolution:

```json
{ "operation": "create_issue", "variables": { "title": "Child issue", "parent": "AEO-258", "state": "Backlog" } }
```

Use operation help before changing these shapes. For example, `{ "operation": "help", "variables": { "operation": "create_issue" } }` returns all accepted create fields.

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

List operations and `search_issues` return `pageInfo` and accept supported cursor parameters such as `after`, `before`, `first`, and `last`. Their operation help cards show the exact parameters. Named operations apply fixed default page sizes when a size is omitted.

1. Make the first call without `after`.
2. Read `pageInfo.hasNextPage` and `pageInfo.endCursor`.
3. Repeat the same operation and variables with `after` set to that cursor.
4. Stop when `hasNextPage` is false.

```json
{
  "operation": "search_issues",
  "variables": { "term": "authentication", "after": "CURSOR_FROM_PAGE_INFO" }
}
```

## Result routing

Results larger than 8KB automatically route to `${PI_ARTIFACT_PROJECT_ROOT:-$HOME/.pi/artifacts}/linear/raw/`. The returned digest includes the absolute `path`, full `bytes`, a compact `index`, and `meta`. The artifact contains the complete JSON.

Use `"sink": "artifact"` to force an artifact. Use `"sink": "inline"` to force inline output. Inline raw results cap each `nodes` array at 100 items. Inline strings cap at 2,000 characters. The total inline budget is 50KB. Named operations retain their server page sizes and do not apply the raw node cap. Truncation metadata identifies every omitted value.

Set `LINEAR_SPILL_BYTES` to change the automatic spill threshold.

## Workspaces and authentication

The optional top-level `workspace` argument selects one stored workspace for one request without changing the active workspace:

```json
{ "operation": "get_issue", "variables": { "issue": "AEO-258" }, "workspace": "work" }
```

The named operation `switch_workspace` changes the active stored workspace. `/linear-auth switch <name>` performs the same persistent selection. Credential precedence and commands are documented in [`README.md`](./README.md).

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
