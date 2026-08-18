import { readFile, writeFile } from 'node:fs/promises';
import { linearGraphQL, resolveApiKey } from '../extensions/client';
import { redactText } from '../extensions/redact';
import {
  schemaFixtureFromIntrospection,
  sha256,
  type ReadonlySchemaScope,
} from './readonly-schema';
import type { IntrospectionQuery } from 'graphql';

function context() {
  return { hasUI: false, ui: { confirm: async () => false, input: async () => undefined, notify: () => undefined } } as any;
}

try {
  if (process.env.LINEAR_READONLY !== '1') throw new Error('LINEAR_READONLY=1 is required before authentication or network access');
  if (process.env.LINEAR_SMOKE_GRAPHQL_ENDPOINT) throw new Error('schema capture does not allow endpoint overrides');
  const queryUrl = new URL('./fixtures/readonly-introspection.graphql', import.meta.url);
  const scopeUrl = new URL('./fixtures/readonly-schema-scope.json', import.meta.url);
  const outputUrl = new URL('./fixtures/readonly-schema-contract.json', import.meta.url);
  const [sourceQuery, scopeSource] = await Promise.all([
    readFile(queryUrl, 'utf8'),
    readFile(scopeUrl, 'utf8'),
  ]);
  const scope = JSON.parse(scopeSource) as ReadonlySchemaScope;
  const { apiKey } = await resolveApiKey(context(), { promptIfMissing: false });
  if (!apiKey) throw new Error('existing Linear authentication is unavailable');
  const introspection = await linearGraphQL<IntrospectionQuery>(apiKey, sourceQuery, {});
  const captureDate = process.env.LINEAR_SCHEMA_CAPTURE_DATE || new Date().toISOString().slice(0, 10);
  const fixture = schemaFixtureFromIntrospection(introspection, scope, {
    captureDate,
    endpoint: scope.endpoint,
    schemaIdentity: scope.schemaIdentity,
    sourceQuery: 'scripts/fixtures/readonly-introspection.graphql',
    sourceQuerySha256: sha256(sourceQuery),
    scope: 'scripts/fixtures/readonly-schema-scope.json',
    scopeSha256: sha256(scopeSource),
  });
  await writeFile(outputUrl, `${JSON.stringify(fixture, null, 2)}\n`);
  process.stdout.write(`READONLY SCHEMA CAPTURE PASS: ${JSON.stringify({
    captureDate,
    queryRoots: scope.roots.Query.length,
    mutationRoots: scope.roots.Mutation.length,
    digest: fixture.provenance.normalizedSha256,
  })}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`READONLY SCHEMA CAPTURE FAIL: ${redactText(message)}\n`);
  process.exitCode = 1;
}
