import { buildSchema, coerceInputValue, parseType, typeFromAST, type GraphQLInputType } from 'graphql';
import { describe, expect, it } from 'vitest';
import { helpResult } from '../extensions/api';
import { recoveryLine } from '../extensions/failure-message';
import { operations } from '../extensions/operations';
import type { JsonObject } from '../extensions/json';
import { typedLinearTools } from '../extensions/typed-tools';
import type { ReadonlySchemaFixture } from '../scripts/readonly-schema';
import { prepareOperation } from './helpers/operation-plan';
// The validator Pi runs on every tool call, imported from the agent runtime itself.
import { validateToolArguments } from '../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/validation.js';

const fixture = (await import('../scripts/fixtures/readonly-schema-contract.json')).default as ReadonlySchemaFixture;
const builtIns = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);
const schema = buildSchema([
  ...Object.keys(fixture.scalars).filter((name) => !builtIns.has(name)).map((name) => `scalar ${name}`),
  ...Object.entries(fixture.enums).map(([name, value]) => `enum ${name} { ${value.values.join(' ')} }`),
  ...Object.entries(fixture.inputs).map(([name, value]) =>
    `input ${name} { ${Object.entries(value.fields).map(([field, type]) => `${field}: ${type}`).join(' ')} }`,
  ),
  'type Query { fixture: Boolean }',
].join('\n'));
const tools = new Map(typedLinearTools().map((tool) => [tool.name, tool]));

function expectLinearInput(value: JsonObject[string] | null, type: string) {
  const errors: string[] = [];
  const graphQLType = typeFromAST(schema, parseType(type)) as GraphQLInputType | undefined;
  expect(graphQLType, type).toBeDefined();
  coerceInputValue(value, graphQLType!, (_path, _invalid, error) => errors.push(error.message));
  expect(errors, `${type}: ${errors.join('; ')}`).toEqual([]);
}

const sortedLists = [
  ['list_projects', 'updatedAt', 'ProjectSortInput'],
  ['list_issues', 'priority', 'IssueSortInput'],
  ['list_initiatives', 'targetDate', 'InitiativeSortInput'],
  ['list_users', 'displayName', 'UserSortInput'],
  ['list_documents', 'title', 'DocumentSortInput'],
] as const;

describe('model-visible deferred operation contracts', () => {
  it.each(sortedLists)('%s maps its public sort clause to Linear GraphQL input', async (name, key, inputType) => {
    const toolName = `linear_${name}`;
    const tool = tools.get(toolName)!;
    const args = { sort: [{ key, order: 'Descending' }] };
    expect(tool.prepareArguments!(args as any)).toEqual(args);
    expect(() => validateToolArguments(tool as any, { id: 'call-1', name: toolName, arguments: args } as any)).not.toThrow();

    const prepared = await prepareOperation(operations[name]!, args);
    expect(prepared.variables.sort).toEqual([{ [key]: { order: 'Descending' } }]);
    expectLinearInput(prepared.variables.sort ?? null, `[${inputType}!]`);
  });

  it('preserves sort clause order and maps omitted order to an empty nested object', async () => {
    const prepared = await prepareOperation(operations.list_projects!, {
      sort: [{ key: 'updatedAt', order: 'Descending' }, { key: 'createdAt' }],
    });
    expect(prepared.variables.sort).toEqual([
      { updatedAt: { order: 'Descending' } },
      { createdAt: {} },
    ]);
    expectLinearInput(prepared.variables.sort ?? null, '[ProjectSortInput!]');
  });

  it('maps the legacy batch sort shorthand to Linear GraphQL input', async () => {
    const prepared = await prepareOperation(operations.list_issues!, {
      sort: [{ priority: 'Ascending' }],
    });
    expect(prepared.variables.sort).toEqual([{ priority: { order: 'Ascending' } }]);
    expectLinearInput(prepared.variables.sort ?? null, '[IssueSortInput!]');
  });

  it.each([
    ['create_project', 'save_project'],
    ['update_project', 'save_project'],
    ['create_milestone', 'save_milestone'],
    ['update_milestone', 'save_milestone'],
    ['create_initiative', 'save_initiative'],
    ['update_initiative', 'save_initiative'],
  ])('exact help for %s activates canonical %s', (alias, canonical) => {
    const result = helpResult({ operation: alias }, (names) => names);
    expect(result).toMatchObject({ name: canonical, loadedTools: [`linear_${canonical}`] });
  });

  /**
   * Regression: `workspace` was published on all 49 schemas but absent from every help
   * card. A caller told to trust the card met an undocumented free-text field, filled it
   * with a directory path, and could not recover. The published schema and the card must
   * name the same parameters.
   */
  it('publishes no parameter the help card does not document', () => {
    for (const [toolName, tool] of tools) {
      const operation = toolName.slice('linear_'.length);
      const card = helpResult({ operation }) as { parameters: { name: string }[] };
      const documented = new Set(card.parameters.map(({ name }) => name));
      const schema = (tool as any).parameters;
      const objects = schema.properties ? [schema] : (schema.anyOf ?? schema.oneOf ?? []);
      const published = new Set<string>(objects.flatMap((object: any) => Object.keys(object.properties ?? {})));
      const undocumented = [...published].filter((name) => !documented.has(name));
      expect(undocumented, `${toolName} publishes undocumented parameters`).toEqual([]);
      expect(published, `${toolName} must not publish workspace`).not.toContain('workspace');
    }
  });

  it('names the fix when a caller supplies a workspace parameter', async () => {
    const tool = tools.get('linear_get_document')! as any;
    const args = { document: 'Decision record', workspace: '/Users/someone/Dev/project' };
    for (const attempt of [
      () => tool.prepareArguments(args),
      () => tool.execute('call-1', args, undefined, undefined, { hasUI: false }),
    ]) {
      const failure = await Promise.resolve().then(attempt).catch((error: Error) => error) as Error;
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toContain('Typed tools have no workspace parameter');
      expect(failure.message).toContain('/linear-auth switch');
      // The recovery has to travel on the message: renderResult reaches only the human.
      expect(recoveryLine(failure)).toContain('Remove the unaccepted parameters');
    }
  });

  it('preserves safe unknown names and gives an exact recovery request', () => {
    expect(() => helpResult({ operation: 'list_projectz' })).toThrow(
      'Unknown Linear operation "list_projectz". Check the catalog, then send `{ "operation": "help", "variables": { "operation": "<canonical_name>" } }`.',
    );
  });

  it('publishes list_projects default pagination guidance without changing the public sort shape', () => {
    const help = helpResult({ operation: 'list_projects' });
    const tool = tools.get('linear_list_projects')! as any;
    expect(help.pagination).toEqual({ defaultPageSize: 20 });
    expect(tool.parameters.properties.first.description).toContain('Omit first to use the default 20');
    expect(tool.parameters.properties.sort.items.properties.key.enum).toContain('updatedAt');
    expect((tools.get('linear_list_issues') as any).parameters.properties.sort.items.properties.key.enum).not.toContain('labelGroup');
  });
});
