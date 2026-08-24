import { readFile } from 'node:fs/promises';
import type { IntrospectionQuery } from 'graphql';
import { linearGraphQLWithContext, resolveApiKey } from '../extensions/client';
import { redactText } from '../extensions/redact';
import { assertReadOnlyEvidence, recordingTransport, requestEvidence } from './request-recorder';
import { validatePackageDocuments, type PackageGraphQLInventory } from './readonly-schema';

function context() {
  return { hasUI: false, ui: { confirm: async () => false, input: async () => undefined, notify: () => undefined } } as any;
}

try {
  if (process.env.LINEAR_READONLY !== '1') throw new Error('LINEAR_READONLY=1 is required before authentication or network access');
  const [sourceQuery, inventorySource] = await Promise.all([
    readFile(new URL('./fixtures/readonly-introspection.graphql', import.meta.url), 'utf8'),
    readFile(new URL('./fixtures/package-graphql-documents.json', import.meta.url), 'utf8'),
  ]);
  const inventory = JSON.parse(inventorySource) as PackageGraphQLInventory;
  const { apiKey, source } = await resolveApiKey(context(), { promptIfMissing: false });
  if (!apiKey || source === 'none') throw new Error('existing Linear authentication is unavailable');
  const requests = requestEvidence();
  const introspection = await linearGraphQLWithContext<IntrospectionQuery>({
    credential: { apiKey, source }, transport: recordingTransport(fetch, requests), telemetry: [],
  }, sourceQuery, {});
  validatePackageDocuments(introspection, inventory);
  assertReadOnlyEvidence(requests);
  process.stdout.write(`READONLY SCHEMA VALIDATION PASS: ${JSON.stringify({ documents: inventory.documents.length, requests })}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`READONLY SCHEMA VALIDATION FAIL: ${redactText(message)}\n`);
  process.exitCode = 1;
}
