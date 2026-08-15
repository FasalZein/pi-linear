# Changelog

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
