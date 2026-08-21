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
The compact list of canonical operations and their purposes. Every session receives it.
_Avoid_: Tool list

**Parameter card**:
The parameter names, types, and example for one operation.
_Avoid_: Tool schema

**Loader**:
The always-available tool that carries the operation catalog and runs any operation.
_Avoid_: Router, dispatcher

**Typed tool**:
A tool that exposes one canonical operation with the parameters of that operation.
_Avoid_: Operation wrapper

**Activation**:
The step that makes one typed tool available to the caller. It removes no other tool.
_Avoid_: Registration, discovery

**Help request**:
A request for the domain names, for one domain's operation signatures, or for one operation parameter card.
_Avoid_: Catalog search, natural-language query

**Batch request**:
One operation request that groups independent entries for one workspace. It has a read phase and a mutation phase.
_Avoid_: Tool-call merge, workflow

**Batch entry**:
One independent operation in a batch request. A unique key identifies its result.
_Avoid_: Step, dependent operation

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
An opaque identifier issued for one complete redacted stored result. Use it only through `get_result`.
_Avoid_: Artifact path, filename

**Result retrieval**:
A loader-only `get_result` request that selects a stored value by handle, JSON Pointer path, and optional continuation offset.
_Avoid_: File read, typed retrieval tool

**Result routing**:
The cardinality-aware choice between complete inline output and a complete stored result. It never removes returned data.
_Avoid_: Compaction, truncation

**Compatibility path**:
The legacy artifact path retained for older integrations. New callers use the result handle.
_Avoid_: Retrieval interface

**Partial path error**:
A GraphQL error tied to one response path while usable sibling data remains available.
_Avoid_: Total failure

**Issue reference**:
An exact Linear issue identifier or UUID. Resolution must reject missing, ambiguous, or mismatched issues.
_Avoid_: Search term, fuzzy issue name

**Allowlist**:
The exact agent tool set. The restricted Linear agent receives `write` plus the generated Linear tools only.
_Avoid_: Mutation roots, broad capability

**Read-only entry**:
An extension mode that permits reads and rejects all mutations.

**Workspace**:
A named Linear account and credential selection.

**Continuation offset**:
The next code-point, item, or property position for ordered `get_result` recovery.
_Avoid_: Page cursor, byte offset
