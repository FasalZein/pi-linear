# pi-linear

Linear tools for [Pi](https://pi.dev). The package provides typed Linear operations, deferred tool loading, safe mutation rules, batching, and lossless large results.

Pi registers 53 tools from this package. Only `linear` and `linear_get_result` start active. The other schemas enter context only after exact help loads them.

## Quick start

### 1. Install the package

```bash
pi install git:github.com/FasalZein/pi-linear
```

### 2. Add a Linear API key

Use an environment variable:

```bash
export LINEAR_API_KEY=lin_api_...
```

Or store a named Workspace inside Pi:

```text
/linear-auth add work
```

### 3. Load one operation

Call `linear`:

```json
{ "operation": "help", "variables": { "operation": "get_issue" } }
```

Pi activates `linear_get_issue`. Call `linear_get_issue` with:

```json
{ "issue": "AEO-258" }
```

The `linear` tool never runs an operation. It only provides discovery and activation.

## Requirements

- Pi 0.80.7 or newer.
- Node.js and `npm`.
- A Linear personal API key.
- No Notebook mode or model-specific setup.

Pi 0.80.7 added the deferred loading interface that this package uses. Development checks use Pi 0.84.2.

## Installation

Install for the current user:

```bash
pi install git:github.com/FasalZein/pi-linear
```

Install in the current project configuration:

```bash
pi install -l git:github.com/FasalZein/pi-linear
```

Run the package once without installing it:

```bash
pi -e git:github.com/FasalZein/pi-linear
```

Manage the package:

```bash
pi list
pi update --extension git:github.com/FasalZein/pi-linear
pi remove git:github.com/FasalZein/pi-linear
```

Pi adds the package to `~/.pi/agent/settings.json` by default. The `-l` flag writes to `.pi/settings.json`.

## Authentication and Workspaces

The extension can use `LINEAR_API_KEY` or a stored Workspace credential.

A Workspace is a named Linear account and credential selection. It is not a Linear project, team, or Pi working directory.

| Command | Result |
| --- | --- |
| `/linear-auth add <name>` | Store a Workspace and API key. |
| `/linear-auth remove <name>` | Remove a stored Workspace. |
| `/linear-auth switch <name>` | Select the active stored Workspace. |
| `/linear-auth prefer workspace` | Prefer stored credentials. |
| `/linear-auth prefer env` | Prefer `LINEAR_API_KEY`. |
| `/linear-auth status` | Show the credential source and stored names. |

Stored credentials live in `~/.pi/agent/extensions/linear/credentials.json`. The default order is stored Workspace first, then `LINEAR_API_KEY`.

Typed operation tools always use the active Workspace. They do not accept a `workspace` field.

`linear_graphql` and `linear_batch` accept a `workspace` override. The override applies to one request and does not change the active Workspace.

The extension does not store a default project or team. Supply the required project or team in each operation.

## Deferred tool loading

The model starts with two Linear schemas:

- `linear` provides discovery and activates tools.
- `linear_get_result` reads saved results.

The other 51 tools stay registered but inactive. Exact help activates one matching tool for the rest of the session.

List a domain without loading tools:

```json
{ "operation": "help", "variables": { "domain": "issues" } }
```

Load a normal operation:

```json
{ "operation": "help", "variables": { "operation": "create_issue" } }
```

Normal help returns the purpose, one example, and the activation result. The activated tool schema defines the common fields.

Load rare fields only when required:

```json
{ "operation": "help", "variables": { "operation": "create_issue:advanced" } }
```

Send those fields inside `advanced`:

```json
{
  "title": "Investigate cache misses",
  "team": "AEO",
  "advanced": { "slaType": "all" }
}
```

The `advanced` object is closed. The runtime rejects unknown fields, duplicate common fields, raw `input`, and destructive fields.

The committed measurement uses local `o200k_base` tokenization. Five issue tools decreased from 3,988 to 2,278 tokens. All tool schemas decreased from 15,516 to 12,100 tokens. These values are not provider billing data.

See [the measurement method](./docs/v10-context-measurement-evidence.md) for the fixed task set and limits.

## Common workflows

### Read an issue

```json
{ "operation": "help", "variables": { "operation": "get_issue" } }
```

```json
{ "issue": "AEO-258" }
```

### List issues for a project

```json
{ "operation": "help", "variables": { "operation": "list_issues" } }
```

```json
{ "project": "pi-linear", "first": 20 }
```

### Create an issue with exact references

```json
{
  "title": "Add cache diagnostics",
  "team": "AEO",
  "project": "pi-linear",
  "labels": ["bug"],
  "assignee": "me"
}
```

References accept exact supported forms. Projects and documents accept exact names, slugs, or UUIDs. Issues accept identifiers or UUIDs. Teams accept keys or UUIDs.

Missing or ambiguous references fail before a mutation request.

### Update and clear fields

```json
{ "issue": "AEO-258", "state": "Done", "assignee": null, "dueDate": null }
```

Use `null` only when the activated schema publishes a nullable type.

### Request a full mutation result

Mutations return a compact acknowledgement by default:

```json
{ "issue": "AEO-258", "priority": 1 }
```

Request the complete returned entity when required:

```json
{ "issue": "AEO-258", "priority": 1, "view": "full" }
```

The `view` field controls only the result. It never enters the GraphQL mutation input.

## Tools

The package has 49 typed operation tools and four control tools. The generated inventory groups every registered tool.

The [complete reference](./REFERENCE.md) lists every field, type, valid form, mode, result, and example.

<!-- BEGIN GENERATED LINEAR OPERATIONS -->
## Generated tool inventory

The package registers 53 tools. `linear` and `linear_get_result` start active. The other tools load on demand.

| Group | Tools |
| --- | --- |
| Control | `linear`, `linear_get_result`, `linear_graphql`, `linear_batch` |
| issues | `linear_list_issues`, `linear_get_issue`, `linear_create_issue`, `linear_update_issue`, `linear_search_issues` |
| comments | `linear_list_comments`, `linear_create_comment`, `linear_update_comment` |
| users | `linear_list_users`, `linear_get_user` |
| teams | `linear_list_teams`, `linear_get_team` |
| projects | `linear_list_projects`, `linear_get_project`, `linear_save_project` |
| cycles | `linear_list_cycles`, `linear_get_cycle`, `linear_create_cycle`, `linear_update_cycle` |
| milestones | `linear_list_milestones`, `linear_get_milestone`, `linear_save_milestone` |
| initiatives | `linear_list_initiatives`, `linear_get_initiative`, `linear_save_initiative` |
| documents | `linear_list_documents`, `linear_get_document`, `linear_create_document`, `linear_update_document` |
| views | `linear_list_views`, `linear_get_view`, `linear_create_view`, `linear_update_view`, `linear_set_view_preferences` |
| labels | `linear_list_issue_labels`, `linear_create_issue_label`, `linear_update_issue_label`, `linear_list_project_labels`, `linear_create_project_label`, `linear_update_project_label` |
| relations | `linear_list_issue_relations`, `linear_create_issue_relation`, `linear_update_issue_relation`, `linear_delete_issue_relation`, `linear_list_project_relations`, `linear_create_project_relation`, `linear_update_project_relation` |
| workspace | `linear_list_issue_statuses`, `linear_switch_workspace` |

See [`REFERENCE.md`](./REFERENCE.md) for every common field, advanced field, valid form, mode, result, and example.
<!-- END GENERATED LINEAR OPERATIONS -->

## Batch requests

Load the batch tool:

```json
{ "operation": "help", "variables": { "operation": "batch" } }
```

### Independent reads

```json
{
  "operations": [
    { "key": "issue", "operation": "get_issue", "variables": { "issue": "AEO-258" } },
    { "key": "teams", "operation": "list_teams", "variables": {} }
  ]
}
```

The read entries compile into one GraphQL request.

### Reads followed by mutations

```json
{
  "reads": [
    { "key": "issue", "operation": "get_issue", "variables": { "issue": "AEO-258" } }
  ],
  "mutations": [
    { "key": "update", "operation": "update_issue", "variables": { "issue": "AEO-258", "state": "Done" } },
    { "key": "comment", "operation": "create_comment", "variables": { "issue": "AEO-258", "body": "Completed." } }
  ]
}
```

The extension checks every entry before the first mutation. It validates fields, resolves references, and applies mutation rules.

Ordinary mutations run in order. The first failure stops later writes. Earlier successful writes remain successful.

The result reports every key once under `data`, `errors`, or `skipped`.

CAUTION: A network failure can leave the current mutation outcome unknown. Read the target before you retry the mutation.

Two or more `create_issue` entries can use one `issueBatchCreate` transaction. The batch rejects a mix of transactional issue creation and ordinary mutations.

## Raw GraphQL

Load `linear_graphql`:

```json
{ "operation": "help", "variables": { "operation": "graphql" } }
```

Run a bounded query:

```json
{
  "query": "query Viewer { viewer { id name } }",
  "variables": {}
}
```

Use raw GraphQL only when no named operation covers the work. Select only required fields. Set an explicit `first:` value on connections.

Raw mutations are disabled by default. Set `LINEAR_MUTATIONS=all` only for an authorized mutation that has no named operation.

## Large results and result handles

Results stay inline when they fit Pi's 50KB or 2,000-line tool limit. Larger results are saved under:

```text
${PI_ARTIFACT_PROJECT_ROOT:-$HOME/.pi/artifacts}/linear/raw/
```

The tool returns an opaque handle such as:

```text
linear-result:v1:550e8400-e29b-41d4-a716-446655440000
```

Read the saved value with `linear_get_result`:

```json
{
  "handle": "linear-result:v1:550e8400-e29b-41d4-a716-446655440000",
  "path": "",
  "offset": 0
}
```

If the value needs more than one segment, keep the same `path` and use the returned `nextOffset`. Stop when `complete` is true.

Use `sink: "artifact"` to force a saved result. Use `sink: "inline"` to prefer inline output. Pi's hard result limit still applies.

Result files contain complete redacted JSON. The router does not remove rows, fields, batch keys, or server cursors.

## Read-only mode and mutation safety

Start Pi in read-only mode:

```bash
LINEAR_READONLY=1 pi
```

This setting rejects all named and raw mutations before credential lookup and network access. `LINEAR_MUTATIONS=all` cannot override it.

A repository clone also has a fixed read-only entry:

```bash
git clone https://github.com/FasalZein/pi-linear
cd pi-linear
npm install
pi -e ./extensions/readonly.ts
```

CAUTION: Do not load `extensions/index.ts` and `extensions/readonly.ts` in one session. Both files register the same tool names.

Safety rules:

- Named operations declare the exact mutation roots that they can send.
- Common and advanced fields use the same mutation rules.
- `delete_issue_relation` is the only delete operation.
- The delete operation checks the relation, both endpoints, and the relation type before the write.
- Archive and unarchive operations do not exist.
- API keys are redacted in results, saved files, indexes, resolution data, and error messages.
- Permitted mutations run without a confirmation dialog.

If a session must not write, use `LINEAR_READONLY=1`.

## Configuration

| Name | Kind | Result |
| --- | --- | --- |
| `LINEAR_API_KEY` | Environment variable | Supplies the API key when no preferred stored Workspace applies. |
| `LINEAR_READONLY=1` | Environment variable | Rejects every mutation. |
| `LINEAR_MUTATIONS=all` | Environment variable | Allows raw GraphQL mutations. |
| `LINEAR_SPILL_BYTES` | Environment variable | Sets a lower automatic result-file threshold. |
| `PI_ARTIFACT_PROJECT_ROOT` | Environment variable | Sets the saved-result root. |
| `PI_CODING_AGENT_DIR` | Environment variable | Sets the Pi agent directory and credential location. |
| `workspace` | `linear_graphql` or `linear_batch` field | Selects a stored Workspace for one request. |
| `telemetry: "always"` | Direct tool field | Includes available rate-limit data for that request. |
| `/linear-settings` | Pi command | Selects Human readable or Full JSON display. |

The display setting is stored in `state/extensions/linear/settings.json`. It is separate from credentials.

## Rate limits and retries

The extension reads Linear's request, endpoint, complexity, reset, and `Retry-After` headers. It makes no extra request for telemetry.

Results include `meta.rateLimit` only near an observed limit. Use `telemetry: "always"` on a direct tool for diagnostics.

HTTP 429 responses get one retry. An explicit `Retry-After` value has priority.

Search reads can also retry one GraphQL `RATELIMITED` response. Mutations do not retry an uncertain GraphQL rate-limit failure.

## Development

Install development dependencies:

```bash
npm install
```

Run the complete local checks:

```bash
npm test
npm run typecheck
npm run lint
npm run generate:check
npm run test:schema-bytes
npm run test:providers
npm run verify:package
npm run verify:clean
```

The normal checks are offline and need no Linear credential.

Run the live read-only smoke check:

```bash
LINEAR_READONLY=1 LINEAR_API_KEY=lin_api_... npm run smoke:readonly
```

The smoke command sends reads to Linear. It sends no mutation.

Regenerate code and documentation:

```bash
npm run generate
```

This command updates generated contracts, manifests, the README tool inventory, and the complete reference.

## Troubleshooting

### Missing API key

Run `/linear-auth status`. Then set `LINEAR_API_KEY`, or add a stored Workspace.

### Unknown operation

Ask for domain help:

```json
{ "operation": "help", "variables": { "domain": "issues" } }
```

Then use exact operation help.

### Unknown or ambiguous reference

Use a Linear identifier, UUID, exact key, exact name, or exact slug that the Reference type accepts. Search or list the target first when you do not know the exact value.

### Advanced field rejection

Request `<operation>:advanced` help. Put the returned field inside `advanced`.

### Read-only rejection

Remove `LINEAR_READONLY` only when the session is allowed to write. Make sure that the fixed read-only entry is not loaded.

### Raw mutation rejection

Prefer a named operation. Set `LINEAR_MUTATIONS=all` only for an authorized raw mutation.

### Network or API failure

The extension reports `Linear network error:` or `Linear API request failed:`. If a mutation result is uncertain, read the target before another write.

## License

MIT
