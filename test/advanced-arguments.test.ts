import { describe, expect, it } from 'vitest';
import type { TSchema } from 'typebox';
import { helpResult } from '../extensions/api';
import { operationDefinitions, operations } from '../extensions/operations';
import { validateOperationVariables } from '../extensions/operation-validation';
import type { CompatibilityObject } from '../extensions/operation-types';
import { typedLinearTools } from '../extensions/typed-tools';

const UUID = '11111111-1111-4111-8111-111111111111';
const tools = new Map(typedLinearTools().map((tool) => [tool.name, tool]));

function properties(name: string): Record<string, TSchema> {
  return (tools.get(name)!.parameters as { properties: Record<string, TSchema> }).properties;
}

describe('advanced typed arguments', () => {
  it('publishes only the approved common issue and save fields plus one advanced object', () => {
    expect(Object.keys(properties('linear_create_issue'))).toEqual([
      'title', 'team', 'parent', 'state', 'assignee', 'dueDate', 'description', 'priority', 'estimate',
      'project', 'cycle', 'labels', 'subscribers', 'view', 'advanced',
    ]);
    expect(Object.keys(properties('linear_update_issue'))).toEqual([
      'issue', 'title', 'state', 'assignee', 'parent', 'team', 'dueDate', 'addLabels', 'removeLabels',
      'description', 'priority', 'estimate', 'project', 'cycle', 'labels', 'subscribers', 'view', 'advanced',
    ]);
    expect(Object.keys(properties('linear_save_project'))).toEqual([
      'project', 'name', 'teams', 'description', 'content', 'icon', 'color', 'priority', 'startDate',
      'targetDate', 'status', 'lead', 'labels', 'view', 'advanced',
    ]);
    expect(Object.keys(properties('linear_save_initiative'))).toEqual([
      'initiative', 'name', 'description', 'content', 'icon', 'color', 'status', 'targetDate', 'owner',
      'priority', 'labels', 'view', 'advanced',
    ]);

    const advanced = properties('linear_create_issue').advanced as { type: string; properties?: unknown };
    expect(advanced.type).toBe('object');
    expect(advanced.properties ?? {}).toEqual({});
  });

  it('accepts a valid rare field without changing the provider-facing object and flattens it for Linear', async () => {
    const args = { title: 'Advanced issue', team: UUID, advanced: { displayIconUrl: 'https://example.com/icon.png' } };
    expect(tools.get('linear_create_issue')!.prepareArguments!(args)).toBe(args);

    expect(() => validateOperationVariables(
      operations.create_issue!,
      'create_issue',
      args,
      'parameter-card',
    )).not.toThrow();
    const plan = await operations.create_issue!.plan!(args);
    expect(plan.kind).toBe('mutation');
    if (plan.kind !== 'mutation') throw new Error('Expected a mutation plan.');
    const prepared = plan.finish({ team: { id: UUID, key: 'AEO' } });
    expect(prepared.variables.input).toMatchObject({
      title: 'Advanced issue',
      teamId: UUID,
      displayIconUrl: 'https://example.com/icon.png',
    });
    expect(prepared.variables).not.toHaveProperty('advanced');
  });

  it('rejects unknown, wrongly typed, duplicate, raw, and destructive advanced fields before execution', () => {
    const prepare = (args: CompatibilityObject) => tools.get('linear_create_issue')!.prepareArguments!(args);
    expect(() => prepare({ title: 'x', team: UUID, advanced: { mystery: true } }))
      .toThrow(/Unknown advanced parameter "mystery".*advanced help/);
    expect(() => prepare({ title: 'x', team: UUID, advanced: { sortOrder: 'first' } }))
      .toThrow(/Invalid advanced parameters.*sortOrder/);
    expect(() => prepare({ title: 'x', team: UUID, advanced: { title: 'again' } }))
      .toThrow(/advanced duplicates common parameter "title"/);
    expect(() => prepare({ title: 'x', team: UUID, advanced: { input: { title: 'raw' } } }))
      .toThrow(/Raw input is unavailable in advanced/);
    expect(() => prepare({ title: 'x', team: UUID, advanced: { trashed: true } }))
      .toThrow(/Destructive named input is unavailable at variables\.advanced\.trashed/);
    expect(() => prepare({ title: 'x', team: UUID, sortOrder: 1 }))
      .toThrow(/"sortOrder" is advanced; send it inside "advanced"/);
  });

  it('discovers each exact closed tail only on an explicit advanced help request', () => {
    const advancedDefinitions = operationDefinitions.filter(({ canonical }) => canonical.advancedFields.length > 0);
    expect(advancedDefinitions.map(({ name }) => name)).toEqual([
      'create_issue', 'update_issue', 'save_initiative', 'save_project',
    ]);

    for (const definition of advancedDefinitions) {
      const common = helpResult({ operation: definition.name });
      expect(common, definition.name).toEqual({
        purpose: definition.purpose,
        example: definition.canonical.example,
      });
      const description = tools.get(definition.toolName)!.description;
      expect(description, definition.name).toBe(
        `${definition.purpose} For advanced fields, request linear help with variables.operation "${definition.name}:advanced".`,
      );

      const detail = helpResult({ operation: `${definition.name}:advanced` }) as {
        name: string;
        parameters: Array<{ name: string; type: string }>;
      };
      expect(detail.name, definition.name).toBe(definition.name);
      expect(detail.parameters.map(({ name, type }) => ({ name, type })), definition.name)
        .toEqual(definition.canonical.advancedFields.map(({ name, type }) => ({ name, type })));
      for (const field of definition.canonical.fields) {
        expect(detail.parameters, `${definition.name}.${field.name}`).not.toContainEqual(
          expect.objectContaining({ name: field.name }),
        );
      }
    }
  });
});
