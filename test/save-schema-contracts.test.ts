import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { convertTools } from '../node_modules/@earendil-works/pi-ai/dist/api/google-shared.js';
import { makeStrictJsonSchema, resolveJsonSchemaStrictSampling } from '../node_modules/@earendil-works/pi-ai/dist/api/constrained-sampling.js';
import { linearGraphqlTool } from '../extensions/api';
import { canonicalOperation } from '../extensions/canonical';
import { operations } from '../extensions/operations';
import type { CompatibilityObject } from '../extensions/operation-types';
import { typedLinearTools } from '../extensions/typed-tools';
import { isolateLinearCredentials } from './helpers/credentials';
import { prepareOperation } from './helpers/operation-plan';

isolateLinearCredentials();

const UUID = '11111111-1111-4111-8111-111111111111';
const tools = new Map(typedLinearTools().map((tool) => [tool.name, tool]));

function accepts(toolName: string, args: CompatibilityObject): boolean {
  const tool = tools.get(toolName)!;
  try {
    validateToolArguments(tool as any, { id: 'call-1', name: toolName, arguments: args } as any);
    return true;
  } catch {
    return false;
  }
}

/** The pre-call gate itself, so a test can assert on the message it produces. */
function strictGate(toolName: string, args: CompatibilityObject): unknown {
  return tools.get(toolName)!.prepareArguments!(args);
}

function strictAccepts(toolName: string, args: CompatibilityObject): boolean {
  try {
    tools.get(toolName)!.prepareArguments!(args);
    return true;
  } catch {
    return false;
  }
}

function execute(toolName: string, args: CompatibilityObject) {
  return tools.get(toolName)!.execute('call-1', args as never, undefined, undefined, { hasUI: false } as any);
}

function schema(toolName: string): any {
  return tools.get(toolName)!.parameters as any;
}

const SAVE_CASES = [
  {
    tool: 'linear_save_initiative',
    create: { name: 'Platform' },
    update: { initiative: 'Platform', description: 'New scope' },
    updateOnly: { initiative: 'Platform', advanced: { frequencyResolution: 'weekly' } },
    createOnly: { initiative: 'Platform', advanced: { id: UUID } },
    invalidCreate: { name: 'Platform', advanced: { frequencyResolution: 'weekly' } },
    missingCreate: {},
  },
  {
    tool: 'linear_save_milestone',
    create: { name: 'Beta', project: 'Roadmap' },
    update: { milestone: 'Beta', targetDate: '2026-09-01' },
    updateOnly: undefined,
    createOnly: { milestone: 'Beta', id: UUID },
    invalidCreate: undefined,
    missingCreate: { name: 'Beta' },
  },
  {
    tool: 'linear_save_project',
    create: { name: 'Roadmap', teams: [UUID] },
    update: { project: 'Roadmap', description: 'New scope' },
    updateOnly: { project: 'Roadmap', advanced: { completedAt: null } },
    createOnly: { project: 'Roadmap', advanced: { templateId: UUID } },
    invalidCreate: { name: 'Roadmap', teams: [UUID], advanced: { completedAt: null } },
    missingCreate: { name: 'Roadmap' },
  },
] as const;

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.LINEAR_API_KEY;
});

describe('closed create and update save schemas', () => {
  it.each(SAVE_CASES)('$tool accepts each valid mode and rejects a workspace parameter', (entry) => {
    expect(accepts(entry.tool, entry.create)).toBe(true);
    expect(accepts(entry.tool, entry.update)).toBe(true);
    if (entry.updateOnly) expect(accepts(entry.tool, entry.updateOnly)).toBe(true);
    // Typed tools always use the active workspace; the property is not published.
    expect(accepts(entry.tool, { ...entry.create, workspace: 'work' })).toBe(false);
    expect(accepts(entry.tool, { ...entry.update, workspace: 'work' })).toBe(false);
  });

  it.each(SAVE_CASES)('$tool rejects incomplete and cross-mode calls', (entry) => {
    const identity = Object.fromEntries(Object.entries(entry.update).slice(0, 1));
    const invalid = [identity, entry.createOnly, entry.missingCreate, entry.invalidCreate]
      .filter((args): args is CompatibilityObject => Boolean(args));

    // Every invalid call is refused before execution by the gate that owns the mode rule.
    for (const args of invalid) expect(strictAccepts(entry.tool, args)).toBe(false);

    // The published schema still carries what each mode requires, so it catches the
    // incomplete calls on its own. It no longer enumerates forbidden fields, so a
    // cross-mode call reaches the gate instead, which names the field and the mode.
    expect(accepts(entry.tool, identity)).toBe(false);
    expect(accepts(entry.tool, entry.missingCreate)).toBe(false);
    expect(() => strictGate(entry.tool, entry.createOnly)).toThrow(/does not accept:/);
  });

  it.each(SAVE_CASES)('$tool rejects before making a network request', async (entry) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    process.env.LINEAR_API_KEY = 'test-key';
    const identity = Object.fromEntries(Object.entries(entry.update).slice(0, 1));
    const rejected = [identity, entry.createOnly, entry.missingCreate, entry.invalidCreate]
      .filter((args): args is CompatibilityObject => Boolean(args));

    for (const args of rejected) {
      // The message shape differs by which gate caught it; what matters is that the call
      // is refused, names the tool, and never reaches the network.
      await expect(execute(entry.tool, args)).rejects.toThrow(entry.tool);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('accepts a nullable initiative target date in both modes', () => {
    expect(accepts('linear_save_initiative', { name: 'Platform', targetDate: null })).toBe(true);
    expect(accepts('linear_save_initiative', { initiative: 'Platform', targetDate: null })).toBe(true);
    expect(accepts('linear_save_initiative', { initiative: 'Platform', targetDate: '2026-09-01' })).toBe(true);
    expect(accepts('linear_save_initiative', { initiative: 'Platform', targetDate: 'September' })).toBe(false);
  });

  it('keeps save arguments byte-identical through prepareArguments', () => {
    const tool = tools.get('linear_save_initiative')!;
    const args = { initiative: 'Platform', targetDate: null };
    const before = JSON.stringify(args);
    expect(tool.prepareArguments!(args)).toBe(args);
    expect(JSON.stringify(args)).toBe(before);
  });

  it('publishes the dated live field union on one closed root object', () => {
    const expected = {
      linear_save_initiative: ['initiative', 'name', 'description', 'content', 'icon', 'color', 'status', 'targetDate', 'owner', 'priority', 'labels', 'view', 'advanced'],
      linear_save_milestone: ['milestone', 'name', 'project', 'description', 'descriptionData', 'targetDate', 'sortOrder', 'id', 'view'],
      linear_save_project: ['project', 'name', 'teams', 'description', 'content', 'icon', 'color', 'priority', 'startDate', 'targetDate', 'status', 'lead', 'labels', 'view', 'advanced'],
    };

    for (const [toolName, fields] of Object.entries(expected)) {
      const root = schema(toolName);
      expect(root.type).toBe('object');
      expect(Object.keys(root.properties)).toEqual(fields);
      expect(root.additionalProperties).toBe(false);
      // Two clauses: what create requires, and what update requires. The forbidden-field
      // enumerations moved to the pre-call gate.
      expect(root.anyOf).toHaveLength(2);
      expect(root.oneOf).toBeUndefined();
    }
  });

  it('enforces exact create and update mode constraints', () => {
    const expected = {
      linear_save_initiative: { create: ['name'], identity: 'initiative', createForbidden: ['initiative', 'customIdentifier', 'frequencyResolution', 'updateReminderFrequency', 'updateReminderFrequencyInWeeks', 'updateRemindersDay', 'updateRemindersHour'], updateForbidden: ['id'] },
      linear_save_milestone: { create: ['name', 'project'], identity: 'milestone', createForbidden: ['milestone'], updateForbidden: ['id'] },
      linear_save_project: { create: ['name', 'teams'], identity: 'project', createForbidden: ['project', 'canceledAt', 'completedAt', 'projectUpdateRemindersPausedUntilAt', 'slackIssueComments', 'slackIssueStatuses', 'slackNewIssue', 'frequencyResolution', 'updateReminderFrequency', 'updateReminderFrequencyInWeeks', 'updateRemindersDay', 'updateRemindersHour'], updateForbidden: ['slackChannelName', 'templateId', 'useDefaultTemplate', 'id'] },
    } as const;
    for (const [toolName, rule] of Object.entries(expected)) {
      const contract = canonicalOperation(operations[toolName.slice('linear_'.length)]!);
      const [create, update] = contract.variants!;
      const published = [...Object.keys(contract.fields), ...Object.keys(contract.advanced ?? {})];

      // The partition itself, read from the contract the gate enforces.
      expect(create.branches[0]).toEqual(rule.create);
      expect(update.branches[0]![0]).toBe(rule.identity);
      expect(published.filter((field) => !create.fields.includes(field))).toEqual(rule.createForbidden);
      expect(published.filter((field) => !update.fields.includes(field))).toEqual(rule.updateForbidden);
      expect(update.branches.every((branch) => branch.length === 2 && branch[0] === rule.identity)).toBe(true);

      // And the gate refuses each forbidden field, naming it. The identity is excluded:
      // supplying it is what selects update mode, so it is a mode switch, not a violation.
      const withField = (base: CompatibilityObject, field: string, value: string): CompatibilityObject =>
        field in (contract.advanced ?? {}) ? { ...base, advanced: { [field]: value } } : { ...base, [field]: value };
      for (const field of rule.createForbidden.filter((name) => name !== rule.identity)) {
        const base = Object.fromEntries(rule.create.map((name) => [name, 'x']));
        expect(() => strictGate(toolName, withField(base, field, 'x')), `${toolName} create must refuse ${field}`).toThrow(field);
      }
      for (const field of rule.updateForbidden) {
        expect(() => strictGate(toolName, withField({ [rule.identity]: 'x' }, field, 'x')), `${toolName} update must refuse ${field}`).toThrow(field);
      }

      // The published schema carries the required half only.
      const [createClause, updateClause] = schema(toolName).anyOf;
      expect(createClause.required).toEqual(rule.create);
      expect(updateClause).toEqual({ required: [rule.identity], minProperties: 2 });
    }
  });
});

describe('mode-specific field ownership', () => {
  it('keeps DocumentCreateInput.id out of update_document', () => {
    expect(accepts('linear_create_document', { title: 'Plan', id: UUID })).toBe(true);
    expect(accepts('linear_update_document', { document: 'Plan', id: UUID })).toBe(false);
  });

  it('publishes exact dated document and label fields without unsupported extras', () => {
    const expected = {
      linear_create_document: ['title', 'content', 'color', 'issue', 'team', 'project', 'initiative', 'cycle', 'releaseId', 'resourceFolderId', 'lastAppliedTemplateId', 'owner', 'subscribers', 'sortOrder', 'id', 'view'],
      linear_update_document: ['document', 'title', 'content', 'color', 'issue', 'team', 'project', 'initiative', 'cycle', 'releaseId', 'resourceFolderId', 'lastAppliedTemplateId', 'owner', 'subscribers', 'sortOrder', 'hiddenAt', 'view'],
      linear_create_issue_label: ['name', 'team', 'description', 'color', 'isGroup', 'parentId', 'retiredAt', 'replaceTeamLabels', 'id', 'view'],
      linear_update_issue_label: ['label', 'name', 'description', 'color', 'isGroup', 'parentId', 'retiredAt', 'replaceTeamLabels', 'view'],
      linear_create_project_label: ['name', 'description', 'color', 'isGroup', 'parentId', 'retiredAt', 'view'],
      linear_update_project_label: ['label', 'name', 'description', 'color', 'isGroup', 'parentId', 'retiredAt', 'view'],
    };
    for (const [tool, fields] of Object.entries(expected)) {
      expect(Object.keys(schema(tool).properties)).toEqual(fields);
    }
  });

  it('uses non-null create and nullable update retiredAt contracts for both label types', () => {
    for (const type of ['issue', 'project']) {
      expect(accepts(`linear_create_${type}_label`, { name: 'old', retiredAt: '2026-08-18T12:00:00Z' })).toBe(true);
      expect(strictAccepts(`linear_create_${type}_label`, { name: 'old', retiredAt: null })).toBe(false);
      expect(accepts(`linear_update_${type}_label`, { label: 'label-1', retiredAt: null })).toBe(true);
    }
  });

  it('accepts dated live fields and rejects unsupported extras', () => {
    for (const field of ['leadTeam', 'prioritySortOrder', 'priority', 'labels']) {
      const value = field === 'priority' ? 2 : field === 'prioritySortOrder' ? 1.5 : field === 'labels' ? [UUID] : UUID;
      const fieldArgs = ['priority', 'labels'].includes(field) ? { [field]: value } : { advanced: { [field]: value } };
      expect(accepts('linear_save_initiative', { name: 'Initiative', ...fieldArgs })).toBe(true);
      expect(accepts('linear_save_initiative', { initiative: 'Initiative', ...fieldArgs })).toBe(true);
    }
    expect(accepts('linear_save_initiative', { initiative: 'Initiative', advanced: { customIdentifier: 'PLAT' } })).toBe(true);
    // Create mode forbids customIdentifier; the gate owns that rule now, not the schema.
    expect(strictAccepts('linear_save_initiative', { name: 'Initiative', advanced: { customIdentifier: 'PLAT' } })).toBe(false);
    expect(accepts('linear_save_project', { name: 'Project', teams: [UUID], advanced: { leadTeam: UUID } })).toBe(true);
    expect(accepts('linear_save_project', { project: 'Project', advanced: { leadTeam: UUID } })).toBe(true);
    expect(accepts('linear_create_document', { title: 'Plan', owner: UUID })).toBe(true);
    expect(accepts('linear_update_document', { document: 'Plan', owner: UUID })).toBe(true);
    expect(accepts('linear_create_document', { title: 'Plan', icon: 'Target' })).toBe(false);
    expect(accepts('linear_update_document', { document: 'Plan', icon: 'Target' })).toBe(false);
    expect(accepts('linear_save_initiative', { name: 'Initiative', health: 'onTrack' })).toBe(false);
    expect(accepts('linear_save_project', { name: 'Project', teams: [UUID], resources: [] })).toBe(false);
    expect(accepts('linear_update_document', { document: 'Plan', trashed: true })).toBe(false);
  });

  it('rejects dated-fixture negatives before any network request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    process.env.LINEAR_API_KEY = 'test-key';
    const rejected: Array<[string, CompatibilityObject]> = [
      ['linear_save_initiative', { name: 'I', customIdentifier: 'PLAT' }],
      ['linear_save_initiative', { name: 'I', health: 'onTrack' }],
      ['linear_save_project', { name: 'P', teamIds: [UUID], resources: [] }],
      ['linear_update_document', { document: 'D', trashed: true }],
      ['linear_create_issue_label', { name: 'L', retiredAt: null }],
      ['linear_create_project_label', { name: 'L', retiredAt: null }],
    ];
    for (const [tool, args] of rejected) {
      await expect(execute(tool, args)).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('accepts null targetDate on every save create and update path', () => {
    expect(accepts('linear_save_initiative', { name: 'I', targetDate: null })).toBe(true);
    expect(accepts('linear_save_initiative', { initiative: 'I', targetDate: null })).toBe(true);
    expect(accepts('linear_save_milestone', { name: 'M', project: 'P', targetDate: null })).toBe(true);
    expect(accepts('linear_save_milestone', { milestone: 'M', targetDate: null })).toBe(true);
    expect(accepts('linear_save_project', { name: 'P', teams: [UUID], targetDate: null })).toBe(true);
    expect(accepts('linear_save_project', { project: 'P', targetDate: null })).toBe(true);
  });

  it('preserves live fields and explicit nulls through runtime preparation', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const { variables } = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ data: { document: { id: variables.id, title: 'D' } } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetch);
    const prepare = (operation: string, variables: CompatibilityObject) =>
      prepareOperation(operations[operation]!, variables);

    expect((await prepare('save_initiative', { name: 'I', leadTeamId: UUID, prioritySortOrder: 1.5, priority: 2, labelIds: [UUID], targetDate: null })).variables).toEqual({ input: { name: 'I', leadTeamId: UUID, prioritySortOrder: 1.5, priority: 2, labelIds: [UUID], targetDate: null } });
    expect((await prepare('save_project', { name: 'P', teamIds: [UUID], leadTeamId: UUID, targetDate: null })).variables).toEqual({ input: { name: 'P', teamIds: [UUID], leadTeamId: UUID, targetDate: null } });
    expect((await prepare('create_document', { title: 'D', ownerId: UUID })).variables).toEqual({ input: { title: 'D', ownerId: UUID } });
    expect((await prepare('create_document', { input: { title: 'D', icon: 'Target' } })).variables).toEqual({ input: { title: 'D', icon: 'Target' } });
    expect((await prepare('update_document', { documentId: UUID, ownerId: UUID })).variables).toEqual({ id: UUID, input: { ownerId: UUID } });
    expect((await prepare('update_document', { documentId: UUID, input: { icon: 'Target' } })).variables).toEqual({ id: UUID, input: { icon: 'Target' } });
    expect((await prepare('create_project_label', { name: 'L', retiredAt: '2026-08-18T12:00:00Z' })).variables).toEqual({ input: { name: 'L', retiredAt: '2026-08-18T12:00:00Z' } });
    expect((await prepare('update_project_label', { id: UUID, retiredAt: null })).variables).toEqual({ id: UUID, input: { retiredAt: null } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('adds every dated live field to named operation metadata', () => {
    const expected = {
      save_initiative: ['leadTeamId', 'prioritySortOrder', 'priority', 'labelIds', 'customIdentifier'],
      save_project: ['leadTeamId'],
      create_document: ['ownerId', 'icon'],
      update_document: ['ownerId', 'icon'],
      create_project_label: ['retiredAt'],
      update_project_label: ['retiredAt'],
    };
    for (const [operation, fields] of Object.entries(expected)) {
      const accepted = (operations[operation]!.acceptedParameters ?? []).map(({ name }) => name);
      for (const field of fields) expect(accepted).toContain(field);
    }
  });
});

describe('provider-facing schemas', () => {
  it('keeps all 49 typed tools rooted at an object with explicit properties', () => {
    for (const tool of tools.values()) {
      const root = tool.parameters as any;
      expect(root.type, tool.name).toBe('object');
      expect(root.properties, tool.name).toBeTypeOf('object');
    }
  });

  it('converts every tool to both Google schema formats with an object root', () => {
    for (const useParameters of [false, true]) {
      const converted = convertTools([...tools.values()] as any, useParameters, false)!;
      const declarations = converted[0]!.functionDeclarations as any[];
      expect(declarations).toHaveLength(49);
      for (const declaration of declarations) {
        const parameters = declaration.parametersJsonSchema ?? declaration.parameters;
        expect(parameters.type, declaration.name).toBe('object');
        expect(parameters.properties, declaration.name).toBeTypeOf('object');
      }
    }
  });

  it('converts a closed object schema to Pi strict JSON schema and safely skips save constraints', () => {
    const getIssue = tools.get('linear_get_issue')!;
    expect(makeStrictJsonSchema(getIssue.parameters as any).type).toBe('object');
    for (const name of ['linear_save_initiative', 'linear_save_milestone', 'linear_save_project']) {
      const tool = tools.get(name)!;
      expect(tool.constrainedSampling).toBe(false);
      expect(resolveJsonSchemaStrictSampling(tool as any, true)).toBeUndefined();
      expect((tool.parameters as any).type).toBe('object');
    }
  });
});

describe('portable string enums', () => {
  it('uses JSON Schema enum arrays for typed enums and sort order', () => {
    const list = tools.get('linear_list_issues')!.parameters as any;
    expect(list.properties.orderBy.enum).toEqual(['createdAt', 'updatedAt']);
    expect(list.properties.sort.items.properties.key.enum).toContain('priority');
    expect(list.properties.sort.items.properties.order.enum).toEqual(['Ascending', 'Descending']);
    expect(JSON.stringify(list)).not.toContain('"const"');

    const graphql = linearGraphqlTool() as any;
    expect(graphql.parameters.properties.sink.enum).toEqual(['inline', 'artifact']);
    expect(JSON.stringify(graphql.parameters.properties.sink)).not.toContain('"const"');
  });
});
