import { readFile } from 'node:fs/promises';
import { buildSchema } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import { runtimePackageDocuments } from '../extensions/package-documents';
import { recordingTransport, requestEvidence } from '../scripts/request-recorder';
import {
  sha256,
  validateDocumentsAgainstSchema,
  type PackageGraphQLInventory,
} from '../scripts/readonly-schema';

const introspectionUrl = new URL('../scripts/fixtures/readonly-introspection.graphql', import.meta.url);
const inventoryUrl = new URL('../scripts/fixtures/package-graphql-documents.json', import.meta.url);

function inventory(document: string): PackageGraphQLInventory {
  return {
    schemaVersion: 1,
    exclusions: [],
    documents: [{
      id: 'synthetic', sourceClass: 'test', operationType: 'query', operationName: 'Test',
      rootFields: ['thing'], variables: {}, document, sha256: sha256(document),
    }],
  };
}

describe('package GraphQL document authority', () => {
  it('matches the complete generated neutral inventory exactly', async () => {
    const [query, source] = await Promise.all([readFile(introspectionUrl, 'utf8'), readFile(inventoryUrl, 'utf8')]);
    const generated = JSON.parse(source) as PackageGraphQLInventory;
    const runtime = runtimePackageDocuments(query);
    expect(generated.documents.map(({ id, sourceClass, document }) => ({ id, sourceClass, document }))).toEqual(runtime);
    expect(new Set(generated.documents.map(({ id }) => id)).size).toBe(generated.documents.length);
    expect(generated.documents.map(({ id }) => id)).toEqual(expect.arrayContaining([
      'transaction.issue-batch-create',
      'lookup.state.team-id',
      'lookup.state.team-key',
      'lookup.user.viewer',
      'batch.merged.all-reads',
      'introspection.readonly-schema',
    ]));
    expect(generated.exclusions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'caller.linear_graphql' }),
      expect.objectContaining({ id: 'local.SwitchWorkspaceLocal' }),
    ]));
  });

  it('keeps authenticated validator and capture consumers independent from runtime authorities', async () => {
    for (const path of ['../scripts/validate-readonly-schema.ts', '../scripts/capture-readonly-schema.ts']) {
      const source = await readFile(new URL(path, import.meta.url), 'utf8');
      expect(source).not.toMatch(/extensions\/(?:operations|batch|operation-plan)/);
      expect(source).toContain('package-graphql-documents.json');
    }
  });

  it.each([
    ['unknown field', 'query Test { thing { missing } }'],
    ['bad argument', 'query Test { thing(wrong: 1) { id } }'],
    ['missing selection', 'query Test { thing }'],
    ['wrong input type', 'query Test($input: String!) { thing(input: $input) { id } }'],
  ])('rejects a full document with %s', (_label, document) => {
    const schema = buildSchema(`input Input { value: Int! } type Thing { id: ID! } type Query { thing(input: Input): Thing }`);
    expect(() => validateDocumentsAgainstSchema(schema, inventory(document))).toThrow('documents.synthetic:');
  });
});

describe('transport request recorder', () => {
  it('records the first request and preserves the delegated response', async () => {
    const response = new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    const delegate = vi.fn(async () => response);
    const evidence = requestEvidence();
    await expect(recordingTransport(delegate, evidence)('https://api.linear.app/graphql', {
      method: 'POST', body: JSON.stringify({ query: 'query First { viewer { id } }', variables: { secret: 'not-recorded' } }),
    })).resolves.toBe(response);
    expect(delegate).toHaveBeenCalledTimes(1);
    expect(evidence).toMatchObject({ total: 1, query: 1, mutation: 0 });
    expect(JSON.stringify(evidence)).not.toContain('not-recorded');
  });

  it('records and rejects a mutation before transport', async () => {
    const delegate = vi.fn();
    const evidence = requestEvidence();
    await expect(recordingTransport(delegate, evidence)('https://api.linear.app/graphql', {
      method: 'POST', body: JSON.stringify({ query: 'mutation Stop { deleteThing { success } }' }),
    })).rejects.toThrow('mutation request rejected before network transmission');
    expect(delegate).not.toHaveBeenCalled();
    expect(evidence).toMatchObject({ total: 1, query: 0, mutation: 1 });
  });

  it('preserves top-level network and cancellation failures', async () => {
    for (const error of [new TypeError('network down'), new DOMException('aborted', 'AbortError')]) {
      const delegate = vi.fn(async () => { throw error; });
      await expect(recordingTransport(delegate, requestEvidence())('https://api.linear.app/graphql', {
        method: 'POST', body: JSON.stringify({ query: 'query Failure { viewer { id } }' }),
      })).rejects.toBe(error);
    }
  });
});
