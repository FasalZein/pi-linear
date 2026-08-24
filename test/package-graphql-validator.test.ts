import { readFile } from 'node:fs/promises';
import { buildSchema, parse } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import { runtimePackageDocuments } from '../extensions/package-documents';
import { operations } from '../extensions/operations';
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
      'operation.search_issues.summary',
      'operation.search_issues.full',
      'operation.search_issues.exact-summary',
      'operation.search_issues.exact-full',
      'operation.save_project.create',
      'operation.save_project.update',
      'transaction.issue-batch-create',
      'lookup.issue',
      'lookup.team.id',
      'lookup.team.key',
      'lookup.state.id',
      'lookup.state.name',
      'lookup.state.team-id',
      'lookup.state.team-key',
      'lookup.user.viewer',
      'lookup.user.id',
      'lookup.user.identity',
      'lookup.document.id',
      'lookup.document.title',
      'lookup.issue-relation',
      'batch.merged.all-reads',
      'introspection.readonly-schema',
    ]));
    expect(generated.exclusions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'caller.linear_graphql' }),
      expect.objectContaining({ id: 'local.SwitchWorkspaceLocal' }),
      expect.objectContaining({ id: 'local.linear_get_result' }),
    ]));
    for (const descriptor of generated.documents) {
      expect(() => parse(descriptor.document), descriptor.id).not.toThrow();
      expect(descriptor.sha256, descriptor.id).toBe(sha256(descriptor.document));
    }
    const transaction = generated.documents.find(({ id }) => id === 'transaction.issue-batch-create')!;
    expect(transaction.document).toContain('IssueBatchCreateInput!');
    expect(transaction.document).toContain('issueBatchCreate(input: $input)');
    expect(transaction.document).toContain('success');
    expect(transaction.document).toContain('issues {');
    expect(transaction.document).toContain('labels(first: 50)');
  });

  it('keeps identifier-shaped search runtime documents in the inventory', async () => {
    const source = JSON.parse(await readFile(inventoryUrl, 'utf8')) as PackageGraphQLInventory;
    for (const view of ['summary', 'full'] as const) {
      const plan = await operations.search_issues!.plan!({ term: 'AEO-1', view });
      expect(plan.finish({}).variant?.document).toBe(
        source.documents.find(({ id }) => id === `operation.search_issues.exact-${view}`)?.document,
      );
    }
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
  it('records the first request and preserves only compact request proof', async () => {
    const response = new Response(JSON.stringify({ data: { privateRecord: 'not-recorded-response' } }), { status: 200 });
    const delegate = vi.fn(async () => response);
    const evidence = requestEvidence();
    await expect(recordingTransport(delegate, evidence)('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { Authorization: 'Bearer not-recorded-credential', 'X-Private': 'not-recorded-header' },
      body: JSON.stringify({ query: 'query First { viewer { id } }', variables: { secret: 'not-recorded-variable' } }),
    })).resolves.toBe(response);
    expect(delegate).toHaveBeenCalledTimes(1);
    expect(evidence).toMatchObject({ total: 1, query: 1, mutation: 0 });
    const durableProof = JSON.stringify(evidence);
    for (const secret of ['not-recorded-variable', 'not-recorded-credential', 'not-recorded-header', 'not-recorded-response']) {
      expect(durableProof).not.toContain(secret);
    }
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

  it('rejects subscriptions before transport and does not count them as queries', async () => {
    const delegate = vi.fn();
    const evidence = requestEvidence();
    await expect(recordingTransport(delegate, evidence)('https://api.linear.app/graphql', {
      method: 'POST', body: JSON.stringify({ query: 'subscription Stop { thingChanged { id } }' }),
    })).rejects.toThrow('subscription request rejected before network transmission');
    expect(delegate).not.toHaveBeenCalled();
    expect(evidence).toMatchObject({ total: 1, query: 0, mutation: 0 });
    expect(evidence.documents[0]?.operationType).toBe('subscription');
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
