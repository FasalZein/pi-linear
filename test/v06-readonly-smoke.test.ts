import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { introspectionFromSchema, buildSchema } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import { operations } from '../extensions/operations';
import {
  catalogSchemaUsage,
  compareReadonlySchema,
  schemaFixtureFromIntrospection,
  type ReadonlySchemaFixture,
} from '../scripts/readonly-schema';
import { assertNoCredentialLeak } from '../scripts/smoke-safety';
// The command boundary is JavaScript so it can reject before loading TypeScript or auth code.
// @ts-expect-error No declaration file is needed for this repository-only command module.
import { readonlyRefusal, runReadonlySmokeCommand } from '../scripts/smoke-readonly.mjs';

const queryOperation = {
  name: 'list_things', aliases: [], domain: 'issues', purpose: 'test', parameters: [],
  example: { operation: 'list_things', variables: {} },
  document: `query ListThings($filter: ThingFilter!, $ids: [[ID!]!]!, $mode: ThingMode) {
    things(filter: $filter, ids: $ids, mode: $mode) { nodes { id } }
  }`,
} as any;
const mutationOperation = {
  name: 'create_thing', aliases: [], domain: 'issues', purpose: 'test', parameters: [],
  example: { operation: 'create_thing', variables: {} },
  document: `mutation CreateThing($input: ThingInput!) {
    thingCreate(input: $input) { success thing { id } }
  }`,
  variants: [{
    root: 'thingCreate',
    document: `mutation CreateThing($input: ThingInput!) {
      thingCreate(input: $input) { success thing { id } }
    }`,
    mutationResult: { successPath: 'success', successValue: true, requiredEntityPaths: ['thing'] },
  }],
} as any;

const schemaText = `
  scalar DateTime
  enum ThingMode { ACTIVE ARCHIVED }
  input NestedInput { timestamp: DateTime!, tags: [String!]! }
  input ThingFilter { nested: NestedInput, mode: ThingMode }
  input ThingInput { name: String!, nested: NestedInput }
  type Thing { id: ID! }
  type ThingConnection { nodes: [Thing!]! }
  type ThingPayload { success: Boolean!, thing: Thing }
  type Query { things(filter: ThingFilter!, ids: [[ID!]!]!, mode: ThingMode): ThingConnection! }
  type Mutation { thingCreate(input: ThingInput!): ThingPayload! }
`;

function testContract(text = schemaText) {
  const usage = catalogSchemaUsage([queryOperation, mutationOperation]);
  const introspection = introspectionFromSchema(buildSchema(text));
  const fixture = schemaFixtureFromIntrospection(introspection, usage, '2026-08-18');
  return { usage, introspection, fixture };
}

describe('read-only schema comparator', () => {
  it('covers every current catalog root argument with the independent fixture', async () => {
    const fixture = (await import('../scripts/fixtures/readonly-schema-contract.json')).default as ReadonlySchemaFixture;
    const usage = catalogSchemaUsage(Object.values(operations));
    for (const kind of ['Query', 'Mutation'] as const) {
      expect(Object.fromEntries(Object.entries(usage.roots[kind]).map(([name, root]) => [name, root.arguments])))
        .toEqual(Object.fromEntries(Object.entries(fixture.roots[kind]).map(([name, root]) => [name, root.arguments])));
    }
    expect(usage.namedTypes.every((name) =>
      name in fixture.inputs || name in fixture.enums || name in fixture.objects || name in fixture.scalars,
    )).toBe(true);
  });

  it('accepts recursive wrappers, named kinds, input fields, enums, and payload fields', () => {
    const { usage, introspection, fixture } = testContract();
    expect(() => compareReadonlySchema(introspection, fixture, usage)).not.toThrow();
    expect(fixture.roots.Query.things.arguments.ids).toBe('[[ID!]!]!');
    expect(fixture.inputs.NestedInput.fields.tags).toBe('[String!]!');
    expect(fixture.enums.ThingMode.values).toEqual(['ACTIVE', 'ARCHIVED']);
    expect(fixture.objects.ThingPayload.fields).toEqual({ success: 'Boolean!', thing: 'Thing' });
  });

  it('reports credential-free expected and actual signatures on wrapper drift', () => {
    const { usage, fixture } = testContract();
    const drift = introspectionFromSchema(buildSchema(schemaText.replace('ids: [[ID!]!]!', 'ids: [ID!]!')));
    expect(() => compareReadonlySchema(drift, fixture, usage)).toThrow(
      'schema.Query.things.arguments.ids: expected "[[ID!]!]!", actual "[ID!]!"',
    );
  });

  it('fails when an input field or enum value drifts', () => {
    const { usage, fixture } = testContract();
    const inputDrift = introspectionFromSchema(buildSchema(
      schemaText.replace('timestamp: DateTime!', 'timestamp: DateTime!, extra: String'),
    ));
    expect(() => compareReadonlySchema(inputDrift, fixture, usage)).toThrow('schema.types.NestedInput.fields');

    const enumDrift = introspectionFromSchema(buildSchema(
      schemaText.replace('ACTIVE ARCHIVED', 'ACTIVE ARCHIVED PAUSED'),
    ));
    expect(() => compareReadonlySchema(enumDrift, fixture, usage)).toThrow('schema.types.ThingMode.values');
  });
});

describe('smoke:readonly command boundary', () => {
  it('refuses before starting the runner when LINEAR_READONLY is absent', () => {
    const spawn = vi.fn();
    const result = runReadonlySmokeCommand({ environment: {}, spawn });
    expect(result).toEqual({
      status: 2,
      output: 'READONLY SMOKE FAIL: smoke:readonly requires LINEAR_READONLY=1; no authentication or network request was attempted.',
    });
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
          temporaryParent: parent,
          spawn,
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
