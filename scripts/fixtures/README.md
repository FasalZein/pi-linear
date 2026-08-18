# Read-only Linear schema contract

`readonly-schema-scope.json` is the independent capture scope. It lists the Linear GraphQL roots and mutation payload fields that this package supports. The capture path does not import the operation catalog.

`readonly-introspection.graphql` is the exact read-only query sent to `https://api.linear.app/graphql`. The query reads schema metadata only. It does not request workspace data.

`readonly-schema-contract.json` is normalized from that query and scope. Its `provenance` block records:

- capture date and endpoint;
- GraphQL query and mutation type names;
- source query and scope paths with SHA-256 hashes;
- a SHA-256 digest of the normalized contract, excluding provenance.

## Regenerate

1. Review and update `readonly-schema-scope.json` independently when supported schema scope changes.
2. Configure Linear authentication through the normal supported path.
3. Run:

   ```sh
   LINEAR_READONLY=1 npm run capture:readonly-schema
   ```

4. Run `npm test` and `LINEAR_READONLY=1 CI=1 npm run smoke:readonly`.
5. Review the fixture diff. Confirm it contains schema metadata only.

The capture command refuses without `LINEAR_READONLY=1`. It prints only counts, capture date, and the normalized digest.
