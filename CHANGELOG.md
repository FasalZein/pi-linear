# Changelog

## 1.0.0

This entry documents the v1.0 contract. Combined verification passed on a clean checkout in a Linux container: type check, lint, generated-product check, package contents, and the complete test suite.

### Bound agent tool policy

- Replaced the 53-name agent allowlist with a short deny-list.
- All Linear tools still register. Only `linear` and `linear_get_result` start active.
- A tool-registry refresh keeps the deferred Linear tools inactive.

### Common and advanced fields

- Added a common tier for ordinary calls.
- Added a closed `advanced` object for rare tail fields.
- Added exact advanced discovery with `{ "operation": "help", "variables": { "operation": "<name>:advanced" } }`.
- Changed normal exact help to return only purpose, example, and activation.
- Kept the activated direct tool schema as the authority for common fields.
- Moved backward paging to advanced tails. Common paging uses `first` and `after`. Advanced paging uses `before` and `last`.
- Kept advanced calls on the same validation, reference-resolution, read-only, and mutation-safety paths.

Every field moved from the v0.9 top level appears here:

| Operation | Fields now inside `advanced` |
| --- | --- |
| `list_comments`, `list_views`, `list_cycles`, `list_documents`, `list_initiatives`, `list_issue_labels`, `list_issue_relations`, `list_issue_statuses`, `list_issues`, `search_issues`, `list_milestones`, `list_project_labels`, `list_project_relations`, `list_projects`, `list_teams`, `list_users` | `before`, `last` |
| `create_comment` | `project`, `initiative`, `projectUpdateId`, `initiativeUpdateId`, `postId`, `documentContentId`, `parentId`, `bodyData`, `quotedText`, `doNotSubscribeToIssue`, `createOnSyncedSlackThread`, `createdAt`, `id` |
| `create_issue` | `descriptionData`, `milestone`, `delegate`, `lastAppliedTemplateId`, `slaType`, `slaBreachesAt`, `slaStartedAt`, `sortOrder`, `subIssueSortOrder`, `prioritySortOrder`, `templateId`, `useDefaultTemplate`, `preserveSortOrderOnCreate`, `referenceCommentId`, `sourceCommentId`, `sourcePullRequestCommentId`, `createAsUser`, `displayIconUrl`, `completedAt`, `createdAt`, `id` |
| `update_issue` | `descriptionData`, `milestone`, `delegate`, `lastAppliedTemplateId`, `slaType`, `slaBreachesAt`, `slaStartedAt`, `sortOrder`, `subIssueSortOrder`, `prioritySortOrder`, `autoClosedByParentClosing`, `snoozedBy`, `snoozedUntilAt` |
| `save_initiative` | `targetDateResolution`, `leadTeam`, `sortOrder`, `prioritySortOrder`, `id`, `customIdentifier`, `frequencyResolution`, `updateReminderFrequency`, `updateReminderFrequencyInWeeks`, `updateRemindersDay`, `updateRemindersHour` |
| `save_project` | `startDateResolution`, `targetDateResolution`, `leadTeam`, `members`, `convertedFromIssue`, `lastAppliedTemplateId`, `sortOrder`, `prioritySortOrder`, `canceledAt`, `completedAt`, `projectUpdateRemindersPausedUntilAt`, `slackIssueComments`, `slackIssueStatuses`, `slackNewIssue`, `slackChannelName`, `templateId`, `useDefaultTemplate`, `id`, `frequencyResolution`, `updateReminderFrequency`, `updateReminderFrequencyInWeeks`, `updateRemindersDay`, `updateRemindersHour` |

### Unified Reference names

Typed tools now use one caller name for each Reference concept. Every v0.9 replacement appears here:

| Operation | v0.9 field → v1.0 field |
| --- | --- |
| `create_comment` | `projectId` → `project`<br>`initiativeId` → `initiative` |
| `update_cycle` | `id` → `cycle` |
| `create_document`, `update_document` | `issueId` → `issue`<br>`teamId` → `team`<br>`projectId` → `project`<br>`initiativeId` → `initiative`<br>`cycleId` → `cycle`<br>`ownerId` → `owner`<br>`subscriberIds` → `subscribers` |
| `update_issue_label`, `update_project_label` | `id` → `label` |
| `update_issue_relation`, `delete_issue_relation` | `issueId` → `issue`<br>`relatedIssueId` → `relatedIssue` |
| `list_issues` | `projectId` → `project` |
| `create_issue` | `projectId` → `project`<br>`projectMilestoneId` → `milestone`<br>`cycleId` → `cycle`<br>`labelIds` → `labels`<br>`subscriberIds` → `subscribers`<br>`delegateId` → `delegate` |
| `update_issue` | `teamId` → `team`<br>`projectId` → `project`<br>`addedLabelIds` → `addLabels`<br>`removedLabelIds` → `removeLabels`<br>`projectMilestoneId` → `milestone`<br>`cycleId` → `cycle`<br>`labelIds` → `labels`<br>`subscriberIds` → `subscribers`<br>`delegateId` → `delegate`<br>`snoozedById` → `snoozedBy` |
| `save_milestone` | `milestoneId` → `milestone`<br>`projectId` → `project` |
| `create_project_relation`, `update_project_relation` | `projectId` → `project`<br>`relatedProjectId` → `relatedProject`<br>`projectMilestoneId` → `milestone`<br>`relatedProjectMilestoneId` → `relatedMilestone` |
| `save_project` | `projectId` → `project`<br>`teamIds` → `teams`<br>`statusId` → `status`<br>`leadId` → `lead`<br>`leadTeamId` → `leadTeam`<br>`memberIds` → `members`<br>`labelIds` → `labels`<br>`convertedFromIssueId` → `convertedFromIssue` |
| `save_initiative` | `initiativeId` → `initiative`<br>`ownerId` → `owner`<br>`leadTeamId` → `leadTeam`<br>`labelIds` → `labels` |

The extension stores no default project or default team. Typed tools no longer publish `workspace`.

Use `/linear-auth switch` or `linear_switch_workspace` to select a Workspace. `linear_graphql` and `linear_batch` keep an explicit cross-account override.

Use `null` only for nullable fields. In these fields, `null` clears the current association or date.

Document `icon` remains outside typed tools because Linear does not publish valid typed values. Compatibility calls can still accept it.

### Mutation acknowledgements and batches

- Added `view` to all 23 named mutation tools.
- Mutations return a validated compact `summary` acknowledgement by default.
- Set `view` to `full` to return the complete mutation entity.
- A batch validates all mutation entries and resolves all References before the first mutation request.
- Ordinary batch mutations run in order. The batch stops at the first failure and skips later entries.
- A transport, HTTP, or cancellation failure marks the sent mutation outcome as unknown.
- Several `create_issue` entries keep the one-request `issueBatchCreate` transaction.
- Ordinary mutations remain non-atomic and keep the same named-root safety rules.

### Dependencies and evidence

- The package has no Notebook dependency.
- `scripts/context-measurement/run.sh` reproduces the context measurement offline.
- Later commits changed only documentation, so the measured extension source is unchanged.
- That measurement runs no model. Completion, model-chosen wrong calls, latency, cache use, and billed provider usage stay unmeasured. This release note makes no token-improvement or behavior claim.
- Exact serialized byte checks remain the deterministic schema measurement.

## 0.9.0

- Added deferred direct `linear_batch`. Exact `batch` help activates it. Direct calls use canonical `key`.
- Added deferred direct `linear_graphql`. Exact `graphql` help activates it.
- Added direct `linear_get_result` as an initially active exceptional tool. Exact `get_result` help returns its direct parameter card without activation.
- Made `linear` discovery-only. It requires `operation: "help"` and accepts only root, domain, or exact help. Removed named, raw GraphQL, batch, and result-retrieval execution routes. Removed shapes fail locally with guidance to `linear_<operation>`, `linear_graphql`, `linear_batch`, or `linear_get_result`.
- Kept the generated 49-operation catalog in the model-facing discovery description and reduced the initial active schema (`linear` plus `linear_get_result`) to 2,068 bytes from the measured 2,122-byte pre-Design-B baseline.
- Added `delete_issue_relation`, the only named delete operation. It requires exact relation, source issue, target issue, and relation-type guards, verifies them with one preflight read, and deletes only after an exact match under normal named mutation authority. Generic batch can fold this guard into its read phase before one ordinary mutation.
- Normalized guarded relation preflight and delete failures to stable operation-specific errors that expose no supplied UUID or active credential.
- Added batch transport: compatible reads share one aliased query, one ordinary mutation runs after the read gate, and independent issue creates use `issueBatchCreate`.
- Added internal telemetry for every documented Linear rate-limit header. By default, results show compact `meta.rateLimit` details only near exhaustion. For explicit diagnostics, set top-level `telemetry: "always"` on the exact direct `linear_batch`, `linear_graphql`, or typed `linear_*` tool. Search reads retry one documented GraphQL `RATELIMITED` 400 response.
- Removed document `icon` from typed tools because Linear does not publish its valid values. Compatibility calls still accept this field.
- Classified `not a valid` GraphQL responses as input errors. The recovery message now requests corrected parameters instead of an unchanged retry.

## 0.8.0

- Added exact issue and named-root routing, named issue-set reads, summary and full result views, and unseen result counts.
- Made singular, collection, batch, and raw GraphQL results lossless. Added path-scoped partial errors, exact batch accounting, opaque result handles, and loader-only `get_result` recovery.

## 0.7.1

- Split operations into domain modules and moved selections into a projection module. Updated the shipped glossary and acceptance evidence.
- Removed unreachable natural-help renderer paths. Renamed tests by guarded behavior. Kept multiline tool arguments inside one TUI row.

## 0.7.0

- Renamed the `linear_api` tool to `linear`. No alias is registered.
- Removed natural help. `help` no longer accepts `query` or `search`; those variables fail with a message that names the catalog and the exact-name form.
- Published a generated `name: purpose` catalog of all 48 operations in the `linear` tool description. Call an operation directly from that catalog. Use `help { "operation": "<name>" }` only for exact parameters; that call also loads the typed tool.
- Corrected the `save_initiative` and `save_milestone` purposes.
- Moved the initial active schema from 669 bytes / 168 Pi-estimated tokens to 3,170 bytes / 793 tokens.

## 0.6.0

- Registered 49 tools: always-on `linear_api` plus 48 lazy typed tools that stay inactive until exact help or a closed natural query names them.
- Kept the always-active loader schema at 673 bytes. The 48 typed schemas are 64,583 bytes and stay out of context until activation: 550 bytes above the 64,033-byte v0.5 baseline, from the approved S3 comment contract.
- Preserved the Pi peer minimum at `>=0.80.7` and verified the packed package against Pi 0.80.7 and Pi 0.84.2 in isolated installs.
- Added first-party provider-route checks for fallback, native Anthropic deferred definitions, native OpenAI additional-tools and tool-search, Google conversion of all 48 runtime schemas, and custom proxies with native flags disabled.
- Added bound package inspection and clean-tree verification. The packed package registers 49 tools, keeps only `linear_api` active, and registers `/linear-auth` and `/linear-settings` without generator sources.
- Made each operation the single editable authority: compatibility branches, named semantic exceptions, render metadata, discovery intents, and local result expectations are authored beside the operation and projected into runtime, generated contracts, and help.
- Added an explicit local result expectation for `switch_workspace`, enforced before redaction and routing.
- Extended exact active-secret redaction to help, loader output, and rendered call rows, including credentials in unknown formats.
- Left the authorized AEO-258 `linear_create_comment` mutation pending. This release candidate does not fabricate a comment ID or pass result.

## 0.5.0

- Resolve capitalized natural help requests, prefer list intent in “list comments,” and let `list_comments` accept an exact issue reference.

- Added 48 upstream-named typed tools (`linear_get_issue`, `linear_list_issues`, …) built from the existing operation catalog.
- Registered every typed tool inactive at session start; only `linear_api` carries always-on schema cost (673 bytes against 64,033 bytes for all typed schemas).
- Added deterministic activation: exact operation help loads that one tool, domain help loads none, and a natural query resolves clause by clause through closed action and entity maps, loading only operations a clause names exactly.
- Added an explicit canonical typed contract for all 48 operations, separate from v0.4 `acceptedParameters`: one public name per concept, no legacy aliases, no raw `input`, and strict shapes for object, array, date, colour, and priority values.
- Made typed schemas reject unknown fields, incomplete branches, and identity-only update or save calls inside Pi's `validateToolArguments`.
- Added credential redaction at the data boundary (`extensions/redact.ts`): result data, spill files, artifact indexes, resolution metadata, local results, and every external error are redacted to `[REDACTED]` before they reach the model, the transcript, or disk. TUI rendering redacts as a second line of defence.
- Completed typed coverage: all 48 tools publish 403 safe top-level parameters, including initiative and project lead teams, initiative priority and labels, document owners, label retirement dates, templates, SLA, reminders, sorting, associations, and Slack fields. Arbitrary raw `input` stays on `linear_api`; identity aliases and `trashed` stay out.
- Gave every typed tool a provider-safe root object. Each `save_*` root enforces exclusive create and update modes through root constraints while retaining explicit root properties.
- Made all three save target dates nullable. Kept document `id` create-only. Made label retirement dates non-null on create and nullable on update.
- Replaced literal-union string enums with Pi's provider-compatible `StringEnum`, including sort order and `linear_api.sink`. Added `@earendil-works/pi-ai` peer and development metadata.
- Added strict pre-conversion validation: typed calls are checked against the published schema before Pi's `Value.Convert`, so a raw `123` for a string field, a `"true"` for a boolean, or an invalid null is rejected with zero network calls, and valid arguments pass through byte-identical.
- Extended redaction to the exact active API key, so a key in an unknown format is removed from results, spill files, indexes, resolution metadata, and errors; known-prefix patterns remain as defence in depth.
- Replaced the open view-preferences record with the finite upstream contract: ten known keys, correct value types, no unknown keys, at least one property.
- Raised the `@earendil-works/pi-coding-agent` peer minimum to `>=0.80.7`, the release that added cache-friendly dynamic tool loading.
- Kept `linear_api` as the loader, the raw GraphQL escape hatch, and the v0.4 compatibility path.
- Routed typed tools through the v0.4 execution path: mutation gating, exact resolvers, spill, and result routing exist once.
- Added TUI renderers for both surfaces: aligned tables, one status line per record, spill digests, truncation cursors, and error recovery lines.
- Added typed-tool, schema-builder, provider-conversion, validation-boundary, activation, upstream-compatibility, strict-coercion, credential-isolation, redaction, and renderer test coverage; 364 tests pass across twelve files.

## 0.4.0

- Added evidence-driven, on-demand discovery while keeping one compact `linear_api` tool.
- Added help bootstrap, domain catalogs, and authoritative operation parameter cards with valid examples.
- Expanded the named catalog to 48 safe, non-destructive canonical operations.
- Added exact, fail-closed resolution for issue, team, state, user, and supported named-entity references.
- Kept v0.3 operation names and request shapes as hidden compatibility aliases.
- Changed default mutation authorization to safe named operations with exact declared roots.
- Required `LINEAR_MUTATIONS=all` for raw GraphQL mutations while preserving all read-only overrides.
- Added catalog parity, help, resolver, compatibility, mutation safety, and blind-task coverage; 89 tests pass across six files at parity commit `1876561`.

## 0.3.0

- Added automatic artifact routing for results larger than 8KB.
- Added `sink: "inline" | "artifact"` to override automatic routing.
- Added artifact digests with paths, byte counts, indexes, and result metadata.
- Kept artifact JSON complete while retaining v0.2 clipping for inline results.
- Added the `LINEAR_SPILL_BYTES` threshold override.

## 0.2.0

- Added bundled named operations and kept raw GraphQL as an escape hatch.
- Added parsed mutation detection, a default mutation allowlist, and a read-only entry point.
- Added per-path node truncation metadata, string clipping, and a 50KB result budget.
- Added stable network errors and one HTTP 429 retry with `Retry-After` support.
- Added operation, safety, result hygiene, retry, and entry-point tests.
- Added a glossary, operation reference, pagination guidance, and architecture decisions.

## 0.1.0

- Replaced upstream entity tools with one Linear GraphQL tool.
- Kept multi-workspace authentication.
