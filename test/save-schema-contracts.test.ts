import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { convertTools } from '../node_modules/@earendil-works/pi-ai/dist/api/google-shared.js';
import { makeStrictJsonSchema, resolveJsonSchemaStrictSampling } from '../node_modules/@earendil-works/pi-ai/dist/api/constrained-sampling.js';
import { linearGraphqlTool } from '../extensions/api';
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
    update: { initiativeId: 'Platform', description: 'New scope' },
    updateOnly: { initiativeId: 'Platform', frequencyResolution: 'weekly' },
    createOnly: { initiativeId: 'Platform', id: UUID },
    invalidCreate: { name: 'Platform', frequencyResolution: 'weekly' },
    missingCreate: {},
  },
  {
    tool: 'linear_save_milestone',
    create: { name: 'Beta', projectId: 'Roadmap' },
    update: { milestoneId: 'Beta', targetDate: '2026-09-01' },
    updateOnly: undefined,
    createOnly: { milestoneId: 'Beta', id: UUID },
    invalidCreate: undefined,
    missingCreate: { name: 'Beta' },
  },
  {
    tool: 'linear_save_project',
    create: { name: 'Roadmap', teamIds: [UUID] },
    update: { projectId: 'Roadmap', description: 'New scope' },
    updateOnly: { projectId: 'Roadmap', completedAt: null },
    createOnly: { projectId: 'Roadmap', templateId: UUID },
    invalidCreate: { name: 'Roadmap', teamIds: [UUID], completedAt: null },
    missingCreate: { name: 'Roadmap' },
  },
] as const;

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.LINEAR_API_KEY;
});

describe('closed create and update save schemas', () => {
  it.each(SAVE_CASES)('$tool accepts each valid mode and optional workspace', (entry) => {
    expect(accepts(entry.tool, entry.create)).toBe(true);
    expect(accepts(entry.tool, { ...entry.create, workspace: 'work' })).toBe(true);
    expect(accepts(entry.tool, entry.update)).toBe(true);
    expect(accepts(entry.tool, { ...entry.update, workspace: 'work' })).toBe(true);
    if (entry.updateOnly) expect(accepts(entry.tool, entry.updateOnly)).toBe(true);
  });

  it.each(SAVE_CASES)('$tool rejects incomplete and cross-mode calls', (entry) => {
    const identity = Object.fromEntries(Object.entries(entry.update).slice(0, 1));
    expect(accepts(entry.tool, identity)).toBe(false);
    expect(strictAccepts(entry.tool, identity)).toBe(false);
    expect(accepts(entry.tool, entry.createOnly)).toBe(false);
    expect(strictAccepts(entry.tool, entry.createOnly)).toBe(false);
    expect(accepts(entry.tool, entry.missingCreate)).toBe(false);
    expect(strictAccepts(entry.tool, entry.missingCreate)).toBe(false);
    if (entry.invalidCreate) {
      expect(accepts(entry.tool, entry.invalidCreate)).toBe(false);
      expect(strictAccepts(entry.tool, entry.invalidCreate)).toBe(false);
    }
  });

  it.each(SAVE_CASES)('$tool rejects before making a network request', async (entry) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    process.env.LINEAR_API_KEY = 'test-key';
    const identity = Object.fromEntries(Object.entries(entry.update).slice(0, 1));
    const rejected = [identity, entry.createOnly, entry.missingCreate, entry.invalidCreate]
      .filter((args): args is CompatibilityObject => Boolean(args));

    for (const args of rejected) {
      await expect(execute(entry.tool, args)).rejects.toThrow(/^Invalid (parameters|arguments)/);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('accepts a nullable initiative target date in both modes', () => {
    expect(accepts('linear_save_initiative', { name: 'Platform', targetDate: null })).toBe(true);
    expect(accepts('linear_save_initiative', { initiativeId: 'Platform', targetDate: null })).toBe(true);
    expect(accepts('linear_save_initiative', { initiativeId: 'Platform', targetDate: '2026-09-01' })).toBe(true);
    expect(accepts('linear_save_initiative', { initiativeId: 'Platform', targetDate: 'September' })).toBe(false);
  });

  it('keeps save arguments byte-identical through prepareArguments', () => {
    const tool = tools.get('linear_save_initiative')!;
    const args = { initiativeId: 'Platform', targetDate: null, workspace: 'work' };
    const before = JSON.stringify(args);
    expect(tool.prepareArguments!(args)).toBe(args);
    expect(JSON.stringify(args)).toBe(before);
  });

  it('publishes the dated live field union on one closed root object', () => {
    const expected = {
      linear_save_initiative: ['initiativeId', 'name', 'description', 'content', 'icon', 'color', 'status', 'targetDate', 'targetDateResolution', 'ownerId', 'leadTeamId', 'sortOrder', 'prioritySortOrder', 'priority', 'labelIds', 'id', 'customIdentifier', 'frequencyResolution', 'updateReminderFrequency', 'updateReminderFrequencyInWeeks', 'updateRemindersDay', 'updateRemindersHour', 'workspace'],
      linear_save_milestone: ['milestoneId', 'name', 'projectId', 'description', 'descriptionData', 'targetDate', 'sortOrder', 'id', 'workspace'],
      linear_save_project: ['projectId', 'name', 'teamIds', 'description', 'content', 'icon', 'color', 'priority', 'startDate', 'startDateResolution', 'targetDate', 'targetDateResolution', 'statusId', 'leadId', 'leadTeamId', 'memberIds', 'labelIds', 'convertedFromIssueId', 'lastAppliedTemplateId', 'sortOrder', 'prioritySortOrder', 'canceledAt', 'completedAt', 'projectUpdateRemindersPausedUntilAt', 'slackIssueComments', 'slackIssueStatuses', 'slackNewIssue', 'slackChannelName', 'templateId', 'useDefaultTemplate', 'id', 'frequencyResolution', 'updateReminderFrequency', 'updateReminderFrequencyInWeeks', 'updateRemindersDay', 'updateRemindersHour', 'workspace'],
    };

    for (const [toolName, fields] of Object.entries(expected)) {
      const root = schema(toolName);
      expect(root.type).toBe('object');
      expect(Object.keys(root.properties)).toEqual(fields);
      expect(root.additionalProperties).toBe(false);
      expect(root.oneOf).toHaveLength(2);
    }
  });

  it('publishes exact create and update mode constraints', () => {
    const expected = {
      linear_save_initiative: { create: ['name'], identity: 'initiativeId', createForbidden: ['initiativeId', 'customIdentifier', 'frequencyResolution', 'updateReminderFrequency', 'updateReminderFrequencyInWeeks', 'updateRemindersDay', 'updateRemindersHour'], updateForbidden: ['id'] },
      linear_save_milestone: { create: ['name', 'projectId'], identity: 'milestoneId', createForbidden: ['milestoneId'], updateForbidden: ['id'] },
      linear_save_project: { create: ['name', 'teamIds'], identity: 'projectId', createForbidden: ['projectId', 'canceledAt', 'completedAt', 'projectUpdateRemindersPausedUntilAt', 'slackIssueComments', 'slackIssueStatuses', 'slackNewIssue', 'frequencyResolution', 'updateReminderFrequency', 'updateReminderFrequencyInWeeks', 'updateRemindersDay', 'updateRemindersHour'], updateForbidden: ['slackChannelName', 'templateId', 'useDefaultTemplate', 'id'] },
    } as const;
    for (const [toolName, rule] of Object.entries(expected)) {
      const [create, update] = schema(toolName).oneOf;
      expect(create.required).toEqual(rule.create);
      expect(create.not.anyOf.map((item: any) => item.required[0])).toEqual(rule.createForbidden);
      expect(update.required).toEqual([rule.identity]);
      expect(update.not.anyOf.map((item: any) => item.required[0])).toEqual(rule.updateForbidden);
      expect(update.anyOf.length).toBeGreaterThan(0);
      for (const branch of update.anyOf) {
        expect(branch.required[0]).toBe(rule.identity);
        expect(branch.required).toHaveLength(2);
      }
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
      linear_create_document: ['title', 'content', 'icon', 'color', 'issueId', 'teamId', 'projectId', 'initiativeId', 'cycleId', 'releaseId', 'resourceFolderId', 'lastAppliedTemplateId', 'ownerId', 'subscriberIds', 'sortOrder', 'id', 'workspace'],
      linear_update_document: ['document', 'title', 'content', 'icon', 'color', 'issueId', 'teamId', 'projectId', 'initiativeId', 'cycleId', 'releaseId', 'resourceFolderId', 'lastAppliedTemplateId', 'ownerId', 'subscriberIds', 'sortOrder', 'hiddenAt', 'workspace'],
      linear_create_issue_label: ['name', 'team', 'description', 'color', 'isGroup', 'parentId', 'retiredAt', 'replaceTeamLabels', 'id', 'workspace'],
      linear_update_issue_label: ['id', 'name', 'description', 'color', 'isGroup', 'parentId', 'retiredAt', 'replaceTeamLabels', 'workspace'],
      linear_create_project_label: ['name', 'description', 'color', 'isGroup', 'parentId', 'retiredAt', 'workspace'],
      linear_update_project_label: ['id', 'name', 'description', 'color', 'isGroup', 'parentId', 'retiredAt', 'workspace'],
    };
    for (const [tool, fields] of Object.entries(expected)) {
      expect(Object.keys(schema(tool).properties)).toEqual(fields);
    }
  });

  it('uses non-null create and nullable update retiredAt contracts for both label types', () => {
    for (const type of ['issue', 'project']) {
      expect(accepts(`linear_create_${type}_label`, { name: 'old', retiredAt: '2026-08-18T12:00:00Z' })).toBe(true);
      expect(strictAccepts(`linear_create_${type}_label`, { name: 'old', retiredAt: null })).toBe(false);
      expect(accepts(`linear_update_${type}_label`, { id: 'label-1', retiredAt: null })).toBe(true);
    }
  });

  it('accepts dated live fields and rejects unsupported extras', () => {
    for (const field of ['leadTeamId', 'prioritySortOrder', 'priority', 'labelIds']) {
      const value = field === 'priority' ? 2 : field === 'prioritySortOrder' ? 1.5 : field === 'labelIds' ? [UUID] : UUID;
      expect(accepts('linear_save_initiative', { name: 'Initiative', [field]: value })).toBe(true);
      expect(accepts('linear_save_initiative', { initiativeId: 'Initiative', [field]: value })).toBe(true);
    }
    expect(accepts('linear_save_initiative', { initiativeId: 'Initiative', customIdentifier: 'PLAT' })).toBe(true);
    expect(accepts('linear_save_initiative', { name: 'Initiative', customIdentifier: 'PLAT' })).toBe(false);
    expect(accepts('linear_save_project', { name: 'Project', teamIds: [UUID], leadTeamId: UUID })).toBe(true);
    expect(accepts('linear_save_project', { projectId: 'Project', leadTeamId: UUID })).toBe(true);
    expect(accepts('linear_create_document', { title: 'Plan', ownerId: UUID })).toBe(true);
    expect(accepts('linear_update_document', { document: 'Plan', ownerId: UUID })).toBe(true);
    expect(accepts('linear_save_initiative', { name: 'Initiative', health: 'onTrack' })).toBe(false);
    expect(accepts('linear_save_project', { name: 'Project', teamIds: [UUID], resources: [] })).toBe(false);
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
    expect(accepts('linear_save_initiative', { initiativeId: 'I', targetDate: null })).toBe(true);
    expect(accepts('linear_save_milestone', { name: 'M', projectId: 'P', targetDate: null })).toBe(true);
    expect(accepts('linear_save_milestone', { milestoneId: 'M', targetDate: null })).toBe(true);
    expect(accepts('linear_save_project', { name: 'P', teamIds: [UUID], targetDate: null })).toBe(true);
    expect(accepts('linear_save_project', { projectId: 'P', targetDate: null })).toBe(true);
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
    expect((await prepare('update_document', { documentId: UUID, ownerId: UUID })).variables).toEqual({ id: UUID, input: { ownerId: UUID } });
    expect((await prepare('create_project_label', { name: 'L', retiredAt: '2026-08-18T12:00:00Z' })).variables).toEqual({ input: { name: 'L', retiredAt: '2026-08-18T12:00:00Z' } });
    expect((await prepare('update_project_label', { id: UUID, retiredAt: null })).variables).toEqual({ id: UUID, input: { retiredAt: null } });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('adds every dated live field to named operation metadata', () => {
    const expected = {
      save_initiative: ['leadTeamId', 'prioritySortOrder', 'priority', 'labelIds', 'customIdentifier'],
      save_project: ['leadTeamId'],
      create_document: ['ownerId'],
      update_document: ['ownerId'],
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
