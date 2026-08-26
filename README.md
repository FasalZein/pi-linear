# pi-linear

Linear tools for [Pi](https://pi.dev). The extension talks to the Linear GraphQL API. It gives Pi 49 named operations, a batch tool, a raw GraphQL tool, and a result reader.

A Linear client with one tool per operation puts every parameter schema in the model prompt at session start. This package loads tools later instead. Pi registers 53 tools from the package. Only `linear` and `linear_get_result` are in the prompt at session start.

The `linear` tool answers help requests. When the model asks for one operation by name, Pi adds that one tool to the prompt. This deferred loading keeps the prompt small in sessions that use few operations.

## What you get

- 49 typed operation tools for issues, comments, projects, cycles, milestones, initiatives, documents, views, labels, relations, teams, users, and workspace selection.
- One discovery tool, `linear`, that returns domains, operation names, and parameter cards.
- `linear_batch` for independent operations in one request, with separate read and mutation phases.
- `linear_graphql` for work that no named operation covers.
- Complete results, saved to a file on disk when a result is too large for one tool answer.
- `linear_get_result` to read a saved result without file or shell tools.
- Mutation rules that reject raw mutations, archive operations, and every delete except the guarded `delete_issue_relation`.
- API key redaction in tool results, saved result files, resolution metadata, and error messages.
- Multiple workspaces, with a per-request `workspace` argument.

## Requirements

- Pi 0.80.7 or newer. That release added the dynamic tool loading this package depends on. Verified against Pi 0.84.2.
- Node.js with `npm`, because Pi runs `npm install` for the package.
- A Linear API key from Linear, under Settings, API, Personal API keys.

## Install

```bash
pi install git:github.com/FasalZein/pi-linear
```

This adds the package to `~/.pi/agent/settings.json` and loads `extensions/index.ts`. Use `pi install -l git:github.com/FasalZein/pi-linear` to write the entry to project configuration instead.

To try the package for one run only, use the temporary form:

```bash
pi -e git:github.com/FasalZein/pi-linear
```

Check the installed packages with `pi list`.

## Authenticate

The extension reads the `LINEAR_API_KEY` environment variable:

```bash
export LINEAR_API_KEY=lin_api_...
```

For stored workspaces, use the `/linear-auth` command inside Pi:

| Command | Action |
| --- | --- |
| `/linear-auth add <name>` | Add a workspace and its API key. |
| `/linear-auth remove <name>` | Remove a stored workspace. |
| `/linear-auth switch <name>` | Set the active workspace. |
| `/linear-auth prefer workspace` | Prefer the stored key over the environment variable. |
| `/linear-auth prefer env` | Prefer `LINEAR_API_KEY` over the stored key. |
| `/linear-auth status` | Show the auth source and the stored workspaces. |

Stored keys live in `~/.pi/agent/extensions/linear/credentials.json`. The default order is stored workspace first, then `LINEAR_API_KEY`.

## First call

Every `linear` call needs `operation: "help"`. The first call is a read of the catalog. It contacts nothing and needs no credential.

Call `linear` with:

```json
{ "operation": "help" }
```

The response lists the domains and the help forms:

```json
{
  "domains": ["issues", "comments", "users", "teams", "projects", "cycles", "milestones", "initiatives", "documents", "views", "labels", "relations", "workspace"],
  "domainHelp": { "operation": "help", "variables": { "domain": "issues" } },
  "operationHelp": { "operation": "help", "variables": { "operation": "get_issue" } },
  "graphqlHelp": { "operation": "help", "variables": { "operation": "graphql" } },
  "batchHelp": { "operation": "help", "variables": { "operation": "batch" } },
  "resultHelp": { "operation": "help", "variables": { "operation": "get_result" } }
}
```

Ask for one operation by name. This request returns the parameter card and loads the matching tool.

Call `linear` with:

```json
{ "operation": "help", "variables": { "operation": "get_issue" } }
```

```json
{
  "loadedTools": ["linear_get_issue"],
  "name": "get_issue",
  "domain": "issues",
  "purpose": "Get one issue by exact identifier or UUID.",
  "parameters": [
    { "name": "issue", "type": "IssueReference", "required": true },
    { "name": "view", "type": "ResultView", "required": false }
  ],
  "requirements": [["issue"]],
  "example": { "issue": "AEO-258" }
}
```

`loadedTools` names the tool that Pi added. Call `linear_get_issue` with:

```json
{ "issue": "AEO-258" }
```

The `linear` tool never runs an operation. Work runs through the underscore tools, such as `linear_get_issue`, `linear_batch`, `linear_graphql`, and `linear_get_result`.

## Discover operations

Domain help returns the operation names for one domain and loads no tool.

Call `linear` with:

```json
{ "operation": "help", "variables": { "domain": "issues" } }
```

```json
{
  "domain": "issues",
  "operations": [
    { "name": "list_issues" },
    { "name": "get_issue" },
    { "name": "create_issue" },
    { "name": "update_issue" },
    { "name": "search_issues" }
  ]
}
```

Each operation has its own tool. Send the matching help request first, then call the tool.

Call `linear_list_issues` with:

```json
{ "assignee": "me", "stateType": "started" }
```

Call `linear_search_issues` with:

```json
{ "term": "authentication" }
```

Call `linear_create_issue` with:

```json
{ "title": "Cache the workspace lookup", "team": "AEO" }
```

References must be exact. An issue is `TEAM-123` or a UUID. A team is its key or a UUID. A user is `me`, an email, a name, a display name, or a UUID. Projects, cycles, documents, milestones, initiatives, and views take an exact name or a UUID. A reference that matches nothing, or matches more than one record, fails before any change.

[`REFERENCE.md`](./REFERENCE.md) holds the full operation table, pagination rules, and rate-limit behavior.

## Read-only use

Set `LINEAR_READONLY=1` to reject every mutation before credential lookup and before network access:

```bash
LINEAR_READONLY=1 pi
```

For a Pi agent definition, put the same variable in the `env` frontmatter of the agent file. `LINEAR_MUTATIONS=all` cannot override read-only mode. Use this method with the installed package.

The repository has a second entry file, `extensions/readonly.ts`, with the same rule built in. It works only from a clone of the repository, because the installed package loads `extensions/index.ts` alone:

```bash
git clone https://github.com/FasalZein/pi-linear
cd pi-linear && npm install
pi -e ./extensions/readonly.ts
```

CAUTION: Do not load `extensions/index.ts` and `extensions/readonly.ts` in one session. Both register the same tool names.

## Batch requests

Send exact `batch` help, then call `linear_batch`. Independent reads use one `operations` list.

Call `linear_batch` with:

```json
{
  "operations": [
    { "key": "issue", "operation": "get_issue", "variables": { "issue": "AEO-258" } },
    { "key": "teams", "operation": "list_teams", "variables": {} }
  ]
}
```

A batch with a mutation uses explicit phases. The read phase runs first. If a read fails, the mutation phase does not run.

Call `linear_batch` with:

```json
{
  "reads": [{ "key": "issue", "operation": "get_issue", "variables": { "issue": "AEO-258" } }],
  "mutations": [{ "key": "update", "operation": "update_issue", "variables": { "issue": "AEO-258", "state": "Backlog" } }]
}
```

The mutation phase accepts one ordinary named mutation. It also accepts two or more `create_issue` entries, which the extension sends as one Linear `issueBatchCreate` request. Linear applies that request as one server-side transaction. No other batch is a transaction, so a completed mutation stays completed when a later entry fails.

The result reports every caller key exactly once, under `data`, `errors`, or `skipped`.

## Raw GraphQL

Send exact `graphql` help, then call `linear_graphql` with:

```json
{ "query": "query Viewer { viewer { id name } }", "variables": {} }
```

Use this tool only when no named operation covers the work. Select the fields you need. Add a small `first:` value to every connection, and include `pageInfo { hasNextPage endCursor }` when another page can matter. Raw mutations are rejected unless `LINEAR_MUTATIONS=all` is set.

## Large results

A complete result stays in the tool answer when it fits the Pi limit of 50KB or 2,000 lines. A larger result goes to a file under `${PI_ARTIFACT_PROJECT_ROOT:-$HOME/.pi/artifacts}/linear/raw/`. The tool then answers with a handle, a byte count, a short index, and metadata. Nothing is clipped, capped, or summarized. Entities, fields, batch keys, and Linear pagination values stay as the server returned them.

Call `linear_get_result` with the handle:

```json
{ "handle": "linear-result:v1:550e8400-e29b-41d4-a716-446655440000", "path": "", "offset": 0 }
```

A large string, array, or object comes back in ordered segments. Continue with the same `path` and the returned `nextOffset` until `complete` is true.

Every operation tool also accepts `sink`. Use `"sink": "artifact"` to force a saved file. Use `"sink": "inline"` to prefer a direct answer.

## Configuration

| Name | Type | Effect |
| --- | --- | --- |
| `LINEAR_API_KEY` | environment variable | Linear API key used when no stored workspace key applies. |
| `LINEAR_READONLY` | environment variable | Set to `1` to reject every mutation. Cannot be overridden. |
| `LINEAR_MUTATIONS` | environment variable | Set to `all` to allow raw GraphQL mutations. |
| `LINEAR_SPILL_BYTES` | environment variable | Positive number that lowers the size at which a result goes to a file. |
| `PI_ARTIFACT_PROJECT_ROOT` | environment variable | Root folder for saved results. Defaults to `~/.pi/artifacts`. |
| `PI_CODING_AGENT_DIR` | environment variable | Pi agent directory that holds the credential file. Defaults to `~/.pi/agent`. |
| `workspace` | tool argument | Stored workspace for one request. The active workspace does not change. |
| `/linear-settings` | command | Sets the default result view, Human readable or Full JSON. |

The result view preference is saved under the Pi agent state directory, in `state/extensions/linear/settings.json`. It is never written next to credentials.

## Safety rules

- Mutations run only through named operations. Each named operation declares the exact mutation roots it can send, and the runtime checks the parsed document against that declaration.
- Raw GraphQL mutations need `LINEAR_MUTATIONS=all`.
- `LINEAR_READONLY=1` and the read-only entry file reject every mutation, named or raw.
- `delete_issue_relation` is the only delete operation. It checks the relation and both endpoints before it sends the delete.
- There are no archive or unarchive operations.
- A reference that matches nothing, or matches more than one record, fails before the mutation request.
- The API key is replaced with `[REDACTED]` in tool results, saved result files, indexes, resolution metadata, and error messages.
- The extension shows no confirmation dialog. A permitted mutation runs when the model calls the tool. For a session that must not write, use `LINEAR_READONLY=1`.

## Development

```bash
npm install
npm test
npm run lint
npm run typecheck
npm run generate:check
npm run verify:package
npm run verify:clean
npm run test:providers
npm run test:pi:min
npm run test:pi:current
```

These commands are offline. They need no Linear credential.

The read-only smoke test is different. It sends live read requests to the Linear API, so it needs a valid API key:

```bash
LINEAR_READONLY=1 LINEAR_API_KEY=lin_api_... npm run smoke:readonly
```

The script stops with an error when `LINEAR_READONLY=1` is missing. It sends no mutation.

`npm run generate` rebuilds the generated tool manifest and the generated sections of this file and of `REFERENCE.md`. `npm run generate:check` fails when a generated section is stale. `npm run check:linear-agent-allowlists` and `npm run sync:linear-agent-allowlists` keep a restricted Linear agent file limited to `write` plus the generated Linear tool names.

## Troubleshooting

**Missing API key.** The tool reports `Missing Linear API key. Set LINEAR_API_KEY or run /linear-auth.` Set the environment variable, or add a workspace with `/linear-auth add`. Then use `/linear-auth status` to see the active source.

**Unknown workspace.** The tool reports `Workspace "<name>" does not exist.` Run `/linear-auth status` for the stored names.

**Read-only rejection.** The tool reports `Linear mutations are disabled by read-only mode.` Make sure that `LINEAR_READONLY` is unset. Make sure that the session does not load the read-only entry file.

**Raw mutation rejection.** The tool reports `Raw Linear mutations are disabled. Set LINEAR_MUTATIONS=all to allow raw mutations.` Prefer a named operation. Use the environment variable only when no named operation covers the work.

**Unknown operation.** The tool reports `Unknown Linear operation "<name>".` Send `{ "operation": "help", "variables": { "domain": "issues" } }` to `linear` for the current names in that domain.

**Bad issue reference.** The tool reports `Invalid Linear issue reference "<value>". Use TEAM-123 or a UUID.` A missing record reports `Linear issue "<reference>" was not found.` Find the exact identifier with `linear_search_issues` or `linear_list_issues` first.

**Network or API error.** Messages start with `Linear network error:` or `Linear API request failed:`. One HTTP 429 response is retried once, after the `Retry-After` delay, the endpoint reset time, or three seconds. Repeat the call after the reset time when the retry also fails.

<!-- BEGIN GENERATED LINEAR OPERATIONS -->
## Generated tool inventory

The package registers 53 tools. `linear` and `linear_get_result` start active. `linear_graphql`, `linear_batch`, and typed tools load on demand.

`linear`, `linear_get_result`, `linear_graphql`, `linear_batch`, `linear_list_comments`, `linear_create_comment`, `linear_update_comment`, `linear_list_views`, `linear_get_view`, `linear_create_view`, `linear_update_view`, `linear_set_view_preferences`, `linear_list_cycles`, `linear_get_cycle`, `linear_create_cycle`, `linear_update_cycle`, `linear_list_documents`, `linear_get_document`, `linear_create_document`, `linear_update_document`, `linear_list_initiatives`, `linear_get_initiative`, `linear_list_issue_labels`, `linear_create_issue_label`, `linear_update_issue_label`, `linear_list_issue_relations`, `linear_create_issue_relation`, `linear_update_issue_relation`, `linear_delete_issue_relation`, `linear_list_issue_statuses`, `linear_list_issues`, `linear_get_issue`, `linear_create_issue`, `linear_update_issue`, `linear_search_issues`, `linear_list_milestones`, `linear_get_milestone`, `linear_list_project_labels`, `linear_create_project_label`, `linear_update_project_label`, `linear_list_project_relations`, `linear_create_project_relation`, `linear_update_project_relation`, `linear_list_projects`, `linear_get_project`, `linear_list_teams`, `linear_get_team`, `linear_list_users`, `linear_get_user`, `linear_switch_workspace`, `linear_save_initiative`, `linear_save_milestone`, `linear_save_project`
<!-- END GENERATED LINEAR OPERATIONS -->
