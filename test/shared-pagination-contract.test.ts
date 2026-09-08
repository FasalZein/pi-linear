import { IsObject, type TObject, type TSchema } from 'typebox';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { helpResult, linearBatchTool } from '../extensions/api';
import type { JsonObject } from '../extensions/json';
import { operationDefinitions, operations } from '../extensions/operations';
import { projection } from '../extensions/selections';
import { typedLinearTools } from '../extensions/typed-tools';
import { isolateLinearCredentials } from './helpers/credentials';
import { prepareOperation } from './helpers/operation-plan';

isolateLinearCredentials();

const LIST_OPERATIONS = [
  'list_comments',
  'list_views',
  'list_cycles',
  'list_documents',
  'list_initiatives',
  'list_issue_labels',
  'list_issue_relations',
  'list_issue_statuses',
  'list_issues',
  'search_issues',
  'list_milestones',
  'list_project_labels',
  'list_project_relations',
  'list_projects',
  'list_teams',
  'list_users',
] as const;

const tools = new Map(typedLinearTools().map((tool) => [tool.name, tool]));
const originalKey = process.env.LINEAR_API_KEY;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalKey === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = originalKey;
});

function variablesFor(name: typeof LIST_OPERATIONS[number], extra: JsonObject = {}): JsonObject {
  return name === 'search_issues' ? { term: 'authentication', ...extra } : extra;
}

function objectProperties(schema: TSchema): TObject['properties'] {
  if (!IsObject(schema)) throw new Error('Expected an object schema.');
  return schema.properties;
}

function schemaProperties(name: typeof LIST_OPERATIONS[number]): TObject['properties'] {
  const tool = tools.get(`linear_${name}`);
  if (!tool) throw new Error(`Missing typed tool for ${name}.`);
  return objectProperties(tool.parameters);
}

function executeBatch(reads: JsonObject[]) {
  return (linearBatchTool() as any).execute(
    'call-1',
    { reads },
    undefined,
    undefined,
    { hasUI: false },
  );
}

describe('AEO-829 shared list pagination contract', () => {
  it('covers the exact 16 collection operations', () => {
    const actual = operationDefinitions
      .filter(({ result }) => result.category === 'collection')
      .map(({ name }) => name)
      .sort();
    expect(actual).toEqual([...LIST_OPERATIONS].sort());
  });

  it.each(LIST_OPERATIONS)('%s publishes one forward page shape, keeps its default in schema, and details backward fields in advanced help', (name) => {
    const operation = operations[name]!;
    const properties = schemaProperties(name);
    for (const field of ['first', 'after', 'includeArchived', 'orderBy']) expect(properties, field).toHaveProperty(field);
    expect(properties).not.toHaveProperty('before');
    expect(properties).not.toHaveProperty('last');
    // The provider-safe advanced object stays compact. Exact advanced help owns its closed field list.
    expect(objectProperties(properties.advanced!)).toEqual({});

    const defaultPageSize = operation.pagination!.defaultPageSize;
    expect(Reflect.get(properties.first!, 'description')).toBe(`Forward page size. Omit first to use the default ${defaultPageSize}.`);
    expect(helpResult({ operation: name })).toEqual({
      purpose: operation.purpose,
      example: operationDefinitions.find((definition) => definition.name === name)!.canonical.example,
    });
    expect(helpResult({ operation: `${name}:advanced` })).toMatchObject({
      name,
      parameters: [
        { name: 'before', type: 'String' },
        { name: 'last', type: 'Int' },
      ],
    });
  });

  it.each(LIST_OPERATIONS)('%s sends its documented default and preserves explicit forward values', async (name) => {
    const defaultPageSize = operations[name]!.pagination!.defaultPageSize;
    expect((await prepareOperation(operations[name]!, variablesFor(name))).variables.first).toBe(defaultPageSize);

    const explicit = await prepareOperation(operations[name]!, variablesFor(name, {
      first: 7,
      after: 'cursor-1',
      includeArchived: true,
      orderBy: 'updatedAt',
    }));
    expect(explicit.variables).toMatchObject({
      first: 7,
      after: 'cursor-1',
      includeArchived: true,
      orderBy: 'updatedAt',
    });
  });

  it.each(LIST_OPERATIONS)('%s rejects top-level backward fields and accepts the closed advanced form', async (name) => {
    const tool = tools.get(`linear_${name}`)!;
    expect(() => tool.prepareArguments!(variablesFor(name, { before: 'cursor-1', last: 7 }) as any))
      .toThrow(/"before", "last" are advanced; send them inside "advanced"/);

    const args = variablesFor(name, { advanced: { before: 'cursor-1', last: 7 } });
    expect(tool.prepareArguments!(args as any)).toBe(args);
    expect((await prepareOperation(operations[name]!, args)).variables).toMatchObject({
      before: 'cursor-1',
      last: 7,
    });
    expect((await prepareOperation(operations[name]!, args)).variables).not.toHaveProperty('first');
  });

  it('keeps the same complete pageInfo selection on every list document', () => {
    for (const name of LIST_OPERATIONS) {
      expect(operations[name]!.document, name).toContain(projection('pageInfo', 'list'));
    }
  });

  it('uses the same closed advanced gate for typed and batch calls', async () => {
    const tool = tools.get('linear_list_projects')!;
    for (const invalid of [
      { advanced: { mystery: true } },
      { first: 5, advanced: { first: 6 } },
    ]) {
      expect(() => tool.prepareArguments!(invalid as any)).toThrow(/Unknown advanced parameter|duplicates common parameter/);
      await expect(executeBatch([{ key: 'projects', operation: 'list_projects', variables: invalid }]))
        .rejects.toThrow(/Unknown advanced parameter|duplicates common parameter/);
    }

    const requests: Array<{ query: string; variables: JsonObject }> = [];
    process.env.LINEAR_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)) as { query: string; variables: JsonObject });
      return new Response(JSON.stringify({
        data: { projects: { nodes: [], pageInfo: { hasNextPage: false, hasPreviousPage: true, startCursor: 'a', endCursor: 'b' } } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const result = await executeBatch([{
      key: 'projects',
      operation: 'list_projects',
      variables: { advanced: { before: 'cursor-1', last: 7 } },
    }]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.variables).toMatchObject({
      projects_before: 'cursor-1',
      projects_last: 7,
    });
    expect(requests[0]!.variables).not.toHaveProperty('projects_first');
    expect(result.details.data.projects.projects.pageInfo).toEqual({
      hasNextPage: false,
      hasPreviousPage: true,
      startCursor: 'a',
      endCursor: 'b',
    });
  });
});
