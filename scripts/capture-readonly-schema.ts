import { readFile, writeFile } from 'node:fs/promises';
import { linearGraphQLWithContext, resolveApiKey } from '../extensions/client';
import { redactText } from '../extensions/redact';
import {
  schemaFixtureFromIntrospection,
  sha256,
  validatePackageDocuments,
  type PackageGraphQLInventory,
  type ReadonlySchemaScope,
} from './readonly-schema';
import type { IntrospectionQuery } from 'graphql';
import { assertReadOnlyEvidence, recordingTransport, requestEvidence } from './request-recorder';

function context() {
  return { hasUI: false, ui: { confirm: async () => false, input: async () => undefined, notify: () => undefined } } as any;
}

try {
  if (process.env.LINEAR_READONLY !== '1') throw new Error('LINEAR_READONLY=1 is required before authentication or network access');
  if (process.env.LINEAR_SMOKE_GRAPHQL_ENDPOINT) throw new Error('schema capture does not allow endpoint overrides');
  const queryUrl = new URL('./fixtures/readonly-introspection.graphql', import.meta.url);
  const scopeUrl = new URL('./fixtures/readonly-schema-scope.json', import.meta.url);
  const outputUrl = new URL('./fixtures/readonly-schema-contract.json', import.meta.url);
  const inventoryUrl = new URL('./fixtures/package-graphql-documents.json', import.meta.url);
  const [sourceQuery, scopeSource, inventorySource] = await Promise.all([
    readFile(queryUrl, 'utf8'),
    readFile(scopeUrl, 'utf8'),
    readFile(inventoryUrl, 'utf8'),
  ]);
  const scope = JSON.parse(scopeSource) as ReadonlySchemaScope;
  const inventory = JSON.parse(inventorySource) as PackageGraphQLInventory;
  const { apiKey, source } = await resolveApiKey(context(), { promptIfMissing: false });
  if (!apiKey || source === 'none') throw new Error('existing Linear authentication is unavailable');
  const requests = requestEvidence();
  const introspection = await linearGraphQLWithContext<IntrospectionQuery>({
    credential: { apiKey, source }, transport: recordingTransport(fetch, requests), telemetry: [],
  }, sourceQuery, {});
  validatePackageDocuments(introspection, inventory);
  assertReadOnlyEvidence(requests);
  const captureDate = process.env.LINEAR_SCHEMA_CAPTURE_DATE || new Date().toISOString().slice(0, 10);
  const fixture = schemaFixtureFromIntrospection(introspection, scope, {
    captureDate,
    endpoint: scope.endpoint,
    schemaIdentity: scope.schemaIdentity,
    sourceQuery: 'scripts/fixtures/readonly-introspection.graphql',
    sourceQuerySha256: sha256(sourceQuery),
    scope: 'scripts/fixtures/readonly-schema-scope.json',
    scopeSha256: sha256(scopeSource),
    requests,
  });
  await writeFile(outputUrl, `${JSON.stringify(fixture, null, 2)}\n`);
  process.stdout.write(`READONLY SCHEMA CAPTURE PASS: ${JSON.stringify({
    captureDate,
    queryRoots: scope.roots.Query.length,
    mutationRoots: scope.roots.Mutation.length,
    digest: fixture.provenance.normalizedSha256,
    requests,
  })}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`READONLY SCHEMA CAPTURE FAIL: ${redactText(message)}\n`);
  process.exitCode = 1;
}
