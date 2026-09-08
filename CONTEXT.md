# Linear extension domain

This context defines the caller-facing language for compact, safe access to Linear.

## Language

**Operation**:
A canonical caller-facing Linear task. Its name does not need to match a GraphQL field name.
_Avoid_: Tool name, GraphQL operation

**Operation alias**:
A supported legacy name that maps to one canonical operation. Aliases do not appear in the primary catalog.
_Avoid_: Duplicate operation

**Operation catalog**:
The compact canonical operation-name index available at session start. Exact operation help supplies the purpose and example.
_Avoid_: Tool list

**Parameter card**:
The parameter names and types for one exceptional tool or one advanced tail.
_Avoid_: Tool schema

**Common tier**:
The fields for ordinary calls. The direct tool schema publishes these fields when the tool becomes active.
_Avoid_: Default fields, basic mode

**Tail field**:
A rare field that a caller sends inside `advanced`. Exact `<operation>:advanced` help publishes the closed tail for one operation.
_Avoid_: Hidden field, arbitrary option

**Loader**:
The always-available `linear` discovery tool. It returns root, domain, or exact help and activates deferred direct tools.
_Avoid_: Router, dispatcher, execution tool

**Direct tool**:
A callable underscore identifier that executes one named or exceptional operation, such as `linear_get_issue` or `linear_graphql`.
_Avoid_: Space-form tool name, unprefixed operation name

**Activation**:
The step that makes one typed tool available to the caller. It removes no other tool.
_Avoid_: Registration, discovery

**Help request**:
A request for all domains, one domain's operation names, one operation's purpose and example, or one operation's advanced tail.
_Avoid_: Catalog search, natural-language query

**Batch request**:
One operation request that groups independent entries for one workspace. Read-only requests can use one `operations` list. Requests with mutations use explicit read and mutation phases.
_Avoid_: Tool-call merge, workflow

**Batch entry**:
One independent operation in a batch request. Its effective key identifies its result. A caller label is optional because the runtime assigns a stable key when absent.
_Avoid_: Step, dependent operation, GraphQL alias

**Read phase**:
The batch entries that read data. The extension completes this phase before the mutation phase.
_Avoid_: Preflight, lookup stage

**Mutation phase**:
The batch entries that change data. The extension skips this phase if the read phase has a failure.
_Avoid_: Write queue, transaction

**Batch result**:
The result that separates completed data, failures, skipped entries, and request metadata.
_Avoid_: Combined response, outcome map

**Raw query**:
A GraphQL document supplied directly for work outside the operation catalog.
_Avoid_: Operation

**Result handle**:
An opaque identifier issued for one complete redacted stored result. Use it only through `linear_get_result`.
_Avoid_: Artifact path, filename

**Result retrieval**:
A direct `linear_get_result` request that selects a stored value by handle, JSON Pointer path, and optional continuation offset.
_Avoid_: File read, legacy loader envelope

**Result view**:
The disclosed level of detail for a result. A result view is `summary` or `full`.
_Avoid_: Compaction, truncation

**Result routing**:
The cardinality-aware choice between complete inline output and a complete stored result. It never removes returned data.
_Avoid_: Compaction, truncation

**Exact-root routing**:
The use of a singular resource identity for exact access. Search remains the path for discovery.
_Avoid_: Exact-name search, resolver lookup

**Compatibility path**:
The legacy artifact path retained for older integrations. New callers use the result handle.
_Avoid_: Retrieval interface

**Partial path error**:
A GraphQL error tied to one response path while usable sibling data remains available.
_Avoid_: Total failure

**Reference**:
An exact caller value that identifies one Linear object. Supported forms depend on the object type. Resolution fails on no match or several matches.
_Avoid_: Stored default, fuzzy search term

**Issue reference**:
An exact Linear issue identifier or UUID. Resolution must reject missing, ambiguous, or mismatched issues.
_Avoid_: Search term, fuzzy issue name

**Allowlist**:
The exact agent tool set. The restricted Linear agent receives `write` plus the generated Linear tools only.
_Avoid_: Mutation roots, broad capability

**Read-only entry**:
An extension mode that permits reads and rejects all mutations.

**Credential store**:
The module that resolves, changes, and lists secrets from Linear credentials.

**Credential document**:
The private on-disk document that stores Workspace credentials, Workspace selection, and Auth preference.

**Credential lock**:
The private cross-process lock that serializes Credential document changes and recovers after an owner process ends.

**Auth preference**:
The saved order for default credential resolution. It selects Workspace-first or environment-first resolution.

**Auth source**:
The source selected for one resolved credential. It is `workspace`, `env`, or `none`.

**Active secrets**:
The unique environment and saved Workspace credential values used for synchronous redaction.

**Workspace**:
A named Linear account and credential selection. It is not a Linear organization name, Pi working directory, project, or team.

**Continuation offset**:
The next code-point, item, or property position for ordered `linear_get_result` recovery.
_Avoid_: Page cursor, byte offset
