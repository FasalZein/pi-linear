# Changelog

## 0.7.0

- Added internal Linear rate-limit telemetry for every documented response header. Results show compact `meta.rateLimit` details only when one similar request may exhaust the request, endpoint, or complexity budget. Search reads retry one documented GraphQL `RATELIMITED` 400 response, while HTTP 429 keeps its existing one-retry boundary.
- Renamed the `linear_api` tool to `linear`. No alias is registered.
- Removed natural help. `help` no longer accepts `query` or `search`; those variables fail with a message that names the catalog and the exact-name form.
- Published a generated `name: purpose` catalog of all 48 operations in the `linear` tool description. Call an operation directly from that catalog. Use `help { "operation": "<name>" }` only for exact parameters; that call also loads the typed tool.
- Corrected the `save_initiative` and `save_milestone` purposes.
- Moved the initial active schema from 669 bytes / 168 Pi-estimated tokens to 3,170 bytes / 793 tokens.
- Added lossless, cardinality-aware result routing. Named singular reads stay complete inline within Pi's 50KB or 2,000-line boundary. Collections, batches, and raw GraphQL keep the 8KB artifact threshold without removing data.
- Added opaque result handles and loader-only `get_result` recovery. Large selected values use ordered continuation offsets. No typed `linear_get_result` tool exists.
- Made `sink:inline` fall back to one recoverable artifact at Pi's boundary. Kept artifact paths as legacy compatibility output only.
- Preserved usable raw GraphQL partial data with path-scoped errors. Added exact batch accounting across `data`, `errors`, and `skipped`, including grouped causes and partial failed data.
- Restricted generated Linear agent allowlists to exactly `write` plus the 49 registered Linear names. Removed `all`, `read`, `bash`, `exec`, stale names, and arbitrary filesystem access.
- Changed bare allowlist check and sync to target only `~/.pi/agent/agents/linear.md`. Explicit custom paths remain supported.
- See [`docs/adr/0003-result-routing.md`](./docs/adr/0003-result-routing.md), [`docs/adr/0006-publish-the-operation-catalog.md`](./docs/adr/0006-publish-the-operation-catalog.md), and [`docs/v06-discovery-evidence.md`](./docs/v06-discovery-evidence.md).

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
