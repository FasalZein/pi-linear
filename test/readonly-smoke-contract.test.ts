import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { introspectionFromSchema, buildSchema } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import { operations } from '../extensions/operations';
import {
  assertFixtureProvenance,
  catalogSchemaUsage,
  compareReadonlySchema,
  parseReadonlySchemaFixture,
  parseReadonlySchemaScope,
  schemaFixtureFromIntrospection,
  sha256,
  type ReadonlySchemaScope,
} from '../scripts/readonly-schema';
import { assertNoCredentialLeak } from '../scripts/smoke-safety';
// The command boundary is JavaScript so it can reject before loading TypeScript or auth code.
// @ts-expect-error No declaration file is needed for this repository-only command module.
import { readonlyRefusal, runReadonlySmokeCommand } from '../scripts/smoke-readonly.mjs';

const queryOperation = {
  name: 'list_things',
  document: `query ListThings($filter: ThingFilter!, $ids: [[ID!]!]!, $mode: ThingMode) {
    things(filter: $filter, ids: $ids, mode: $mode) { nodes { id } }
  }`,
};
const mutationDocument = `mutation CreateThing($input: ThingInput!) {
  thingCreate(input: $input) { success thing { id } }
}`;
function mutationOperation(document = mutationDocument) {
  return {
    name: 'create_thing',
    document,
    variants: [{ document }],
  };
}

const schemaText = `
  scalar DateTime
  enum ThingMode { ACTIVE ARCHIVED }
  input NestedInput { timestamp: DateTime!, tags: [String!]! }
  input ThingFilter { nested: NestedInput, mode: ThingMode }
  input ThingInput { name: String!, nested: NestedInput }
  type Thing { id: ID! }
  type ThingConnection { nodes: [Thing!]! }
  type ThingPayload { success: Boolean!, thing: Thing, extra: String }
  type Query { things(filter: ThingFilter!, ids: [[ID!]!]!, mode: ThingMode): ThingConnection! }
  type Mutation { thingCreate(input: ThingInput!): ThingPayload! }
`;
const scope: ReadonlySchemaScope = {
  schemaVersion: 1,
  endpoint: 'https://api.linear.app/graphql',
  schemaIdentity: { queryType: 'Query', mutationType: 'Mutation' },
  roots: { Query: ['things'], Mutation: ['thingCreate'] },
  mutationPayloadFields: { thingCreate: ['success', 'thing'] },
};

function testContract(text = schemaText) {
  const usage = catalogSchemaUsage([queryOperation, mutationOperation()]);
  const introspection = introspectionFromSchema(buildSchema(text));
  const fixture = schemaFixtureFromIntrospection(introspection, scope, {
    captureDate: '2026-08-19', endpoint: scope.endpoint, schemaIdentity: scope.schemaIdentity,
    sourceQuery: 'query.graphql', sourceQuerySha256: sha256('query'),
    scope: 'scope.json', scopeSha256: sha256('scope'),
  });
  return { usage, introspection, fixture };
}

describe('read-only schema comparator', () => {
  it('covers every current catalog root argument and payload selection with the independent fixture', async () => {
    const fixture = parseReadonlySchemaFixture(
      await readFile(new URL('../scripts/fixtures/readonly-schema-contract.json', import.meta.url), 'utf8'),
    );
    const usage = catalogSchemaUsage(Object.values(operations));
    for (const kind of ['Query', 'Mutation'] as const) {
      for (const [root, catalog] of Object.entries(usage.roots[kind])) {
        for (const [argument, signature] of Object.entries(catalog.arguments)) {
          expect(fixture.roots[kind][root].arguments[argument]).toBe(signature);
        }
      }
    }
    for (const [root, fields] of Object.entries(usage.mutationPayloadFields)) {
      expect(fields).toEqual(fixture.roots.Mutation[root].selectedPayloadFields);
    }
  });

  it('verifies query, scope, and normalized fixture provenance hashes', async () => {
    const [fixtureSource, scopeSource, query, captureSource] = await Promise.all([
      readFile(new URL('../scripts/fixtures/readonly-schema-contract.json', import.meta.url), 'utf8'),
      readFile(new URL('../scripts/fixtures/readonly-schema-scope.json', import.meta.url), 'utf8'),
      readFile(new URL('../scripts/fixtures/readonly-introspection.graphql', import.meta.url), 'utf8'),
      readFile(new URL('../scripts/capture-readonly-schema.ts', import.meta.url), 'utf8'),
    ]);
    expect(() => assertFixtureProvenance(
      parseReadonlySchemaFixture(fixtureSource), parseReadonlySchemaScope(scopeSource), query, scopeSource,
    )).not.toThrow();
    expect(captureSource).not.toContain("../extensions/operations");
  });

  it('accepts recursive wrappers, named kinds, input fields, enums, and payload fields', () => {
    const { usage, introspection, fixture } = testContract();
    expect(() => compareReadonlySchema(introspection, fixture, usage, scope)).not.toThrow();
    expect(fixture.roots.Query.things.arguments.ids).toBe('[[ID!]!]!');
    expect(fixture.inputs.NestedInput.fields.tags).toBe('[String!]!');
    expect(fixture.enums.ThingMode.values).toEqual(['ACTIVE', 'ARCHIVED']);
    expect(fixture.objects.ThingPayload.fields).toEqual({ success: 'Boolean!', thing: 'Thing' });
  });

  it('rejects added and removed selected mutation payload fields', () => {
    const { introspection, fixture } = testContract();
    const added = catalogSchemaUsage([queryOperation, mutationOperation(mutationDocument.replace('success thing', 'success extra thing'))]);
    expect(() => compareReadonlySchema(introspection, fixture, added, scope)).toThrow(
      'catalog.Mutation.thingCreate.payloadFields: expected ["success","thing"], actual ["extra","success","thing"]',
    );
    const removed = catalogSchemaUsage([queryOperation, mutationOperation(mutationDocument.replace(' thing { id }', ''))]);
    expect(() => compareReadonlySchema(introspection, fixture, removed, scope)).toThrow(
      'catalog.Mutation.thingCreate.payloadFields: expected ["success","thing"], actual ["success"]',
    );
  });

  it('rejects added and removed live root arguments before signature checks', () => {
    const { usage, fixture } = testContract();
    const added = introspectionFromSchema(buildSchema(
      schemaText.replace('mode: ThingMode): ThingConnection!', 'mode: ThingMode, added: String): ThingConnection!'),
    ));
    expect(() => compareReadonlySchema(added, fixture, usage, scope)).toThrow(
      'schema.Query.things.arguments: expected ["filter","ids","mode"], actual ["added","filter","ids","mode"]',
    );
    const removed = introspectionFromSchema(buildSchema(
      schemaText.replace(', mode: ThingMode): ThingConnection!', '): ThingConnection!'),
    ));
    expect(() => compareReadonlySchema(removed, fixture, usage, scope)).toThrow(
      'schema.Query.things.arguments: expected ["filter","ids","mode"], actual ["filter","ids"]',
    );
  });

  it('reports credential-free expected and actual signatures on wrapper drift', () => {
    const { usage, fixture } = testContract();
    const drift = introspectionFromSchema(buildSchema(schemaText.replace('ids: [[ID!]!]!', 'ids: [ID!]!')));
    expect(() => compareReadonlySchema(drift, fixture, usage, scope)).toThrow(
      'schema.Query.things.arguments.ids: expected "[[ID!]!]!", actual "[ID!]!"',
    );
  });

  it('fails when an input field or enum value drifts', () => {
    const { usage, fixture } = testContract();
    const inputDrift = introspectionFromSchema(buildSchema(schemaText.replace('timestamp: DateTime!', 'timestamp: DateTime!, added: String')));
    expect(() => compareReadonlySchema(inputDrift, fixture, usage, scope)).toThrow('schema.types.NestedInput.fields');
    const enumDrift = introspectionFromSchema(buildSchema(schemaText.replace('ACTIVE ARCHIVED', 'ACTIVE ARCHIVED PAUSED')));
    expect(() => compareReadonlySchema(enumDrift, fixture, usage, scope)).toThrow('schema.types.ThingMode.values');
  });
});

describe('smoke:readonly command boundary', () => {
  it('refuses before starting the runner when LINEAR_READONLY is absent', () => {
    const spawn = vi.fn();
    const result = runReadonlySmokeCommand({ environment: {}, spawn });
    expect(result.status).toBe(2);
    expect(result.output).toContain('no authentication or network request was attempted');
    expect(readonlyRefusal({})).toContain('no authentication or network request');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('isolates PI data, returns only the compact runner summary, and cleans twice', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'pi-linear-smoke-test-'));
    try {
      const spawn = vi.fn((_command, _args, options) => {
        expect(options.env.PI_CODING_AGENT_DIR).toContain(parent);
        expect(options.env.PI_ARTIFACT_PROJECT_ROOT).toContain(parent);
        expect(options.env.LINEAR_SMOKE_AUTH_AGENT_DIR).toBe('/existing/pi-agent');
        mkdirSync(options.env.PI_ARTIFACT_PROJECT_ROOT, { recursive: true });
        writeFileSync(join(options.env.PI_ARTIFACT_PROJECT_ROOT, 'summary.json'), '{}');
        return { status: 0, stdout: 'READONLY SMOKE PASS: {"status":"pass"}\n', stderr: '' };
      });
      for (let run = 0; run < 2; run++) {
        expect(runReadonlySmokeCommand({
          environment: { LINEAR_READONLY: '1', PI_CODING_AGENT_DIR: '/existing/pi-agent' },
          temporaryParent: parent, spawn,
        })).toEqual({ status: 0, output: 'READONLY SMOKE PASS: {"status":"pass"}' });
        expect(await readdir(parent)).toEqual([]);
      }
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('rejects active secrets and known Linear token forms from model-visible output', () => {
    expect(() => assertNoCredentialLeak({ ok: true }, 'active-secret')).not.toThrow();
    expect(() => assertNoCredentialLeak({ value: 'active-secret' }, 'active-secret')).toThrow('active secret');
    expect(() => assertNoCredentialLeak({ value: 'lin_oauth_known_token_123' }, '')).toThrow('known token');
  });
});
