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
The compact list of canonical operations available through the extension.
_Avoid_: Tool list

**Parameter card**:
The parameter names, types, and example for one operation.
_Avoid_: Tool schema

**Help request**:
An on-demand request for one domain catalog or one operation parameter card.
_Avoid_: Always-on catalog

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
