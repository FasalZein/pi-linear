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

**Raw query**:
A GraphQL document supplied directly for work outside the operation catalog.
_Avoid_: Operation

**Issue reference**:
An exact Linear issue identifier or UUID. Resolution must reject missing, ambiguous, or mismatched issues.
_Avoid_: Search term, fuzzy issue name

**Allowlist**:
The set of mutation actions that a mode permits.

**Read-only entry**:
An extension mode that permits reads and rejects all mutations.

**Workspace**:
A named Linear account and credential selection.

**Truncation metadata**:
Result information that identifies omitted data and supports a narrower request or next-page request.
