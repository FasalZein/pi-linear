import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse, print } from 'graphql';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { convertTools } from '../node_modules/@earendil-works/pi-ai/dist/api/google-shared.js';
import { resolveJsonSchemaStrictSampling } from '../node_modules/@earendil-works/pi-ai/dist/api/constrained-sampling.js';
import { resolveRequest } from '../extensions/api';
import { operations } from '../extensions/operations';
import type { CompatibilityObject, CompatibilityValue } from '../extensions/operation-types';
import { typedLinearTools } from '../extensions/typed-tools';
import { LIVE_COMMENT_SCHEMA_2026_08_19 } from './fixtures/comment-schema';
import { isolateLinearCredentials } from './helpers/credentials';
import { prepareOperation } from './helpers/operation-plan';

isolateLinearCredentials();

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = '33333333-3333-4333-8333-333333333333';
const tools = new Map(typedLinearTools().map((tool) => [tool.name, tool]));
const create = tools.get('linear_create_comment')!;
const update = tools.get('linear_update_comment')!;

const TARGETS = [
  ['issue', 'AEO-258'],
  ['project', TARGET_ID],
  ['initiative', TARGET_ID],
  ['projectUpdateId', TARGET_ID],
  ['initiativeUpdateId', TARGET_ID],
  ['postId', TARGET_ID],
  ['documentContentId', TARGET_ID],
  ['parentId', TARGET_ID],
] as const;

function compatibilityField(values: CompatibilityObject, field: string): CompatibilityValue | undefined {
  return values[field];
}

function schemaAccepts(tool: typeof create, args: CompatibilityObject): boolean {
  try {
    validateToolArguments(tool as any, { id: 'call-1', name: tool.name, arguments: args } as any);
    return true;
  } catch {
    return false;
  }
}

function rawAccepts(tool: typeof create, args: CompatibilityObject): boolean {
  try {
    tool.prepareArguments!(args);
    return true;
  } catch {
    return false;
  }
}

async function prepare(name: 'create_comment' | 'update_comment', variables: CompatibilityObject) {
  return prepareOperation(operations[name]!, variables);
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.LINEAR_API_KEY;
});

describe('canonical comment schemas', () => {
  const createArgs = (target: string, value: CompatibilityValue, content: CompatibilityObject) => {
    const variables: CompatibilityObject = {};
    const advanced: CompatibilityObject = {};
    if (target === 'issue') variables.issue = value;
    else advanced[target] = value;
    if ('body' in content) variables.body = content.body;
    if ('bodyData' in content) advanced.bodyData = content.bodyData;
    if (Object.keys(advanced).length) variables.advanced = advanced;
    return variables;
  };

  it.each(TARGETS)('accepts %s as the only create target with body or bodyData', (target, value) => {
    expect(schemaAccepts(create, createArgs(target, value, { body: 'Text' }))).toBe(true);
    expect(rawAccepts(create, createArgs(target, value, { bodyData: { type: 'doc', content: [] } }))).toBe(true);
  });

  it.each([
    ['string', 'serialized'],
    ['array', []],
    ['number', 1],
    ['boolean', true],
    ['null', null],
  ])('rejects %s bodyData roots', (_kind, bodyData) => {
    expect(schemaAccepts(create, { issue: 'AEO-258', advanced: { bodyData } })).toBe(true);
    expect(rawAccepts(create, { issue: 'AEO-258', advanced: { bodyData } })).toBe(false);
    expect(rawAccepts(update, { id: 'comment-id', bodyData })).toBe(false);
  });

  it.each([
    ['missing target', { body: 'Text' }, false],
    ['multiple targets', { issue: 'AEO-258', body: 'Text', advanced: { project: TARGET_ID } }, true],
    ['missing content', { issue: 'AEO-258' }, false],
    ['multiple content values', { issue: 'AEO-258', body: 'Text', advanced: { bodyData: { type: 'doc' } } }, true],
    ['unknown field', { issue: 'AEO-258', body: 'Text', archivedAt: '2026-08-18T00:00:00Z' }, false],
  ])('rejects %s', (_name, args, providerMayAccept) => {
    expect(schemaAccepts(create, args)).toBe(providerMayAccept);
    expect(rawAccepts(create, args)).toBe(false);
  });

  it('requires update id plus one current safe field', () => {
    const fields = {
      body: 'Text',
      bodyData: { type: 'doc' },
      quotedText: 'quote',
    } satisfies CompatibilityObject;
    for (const [field, value] of Object.entries(fields)) {
      expect(rawAccepts(update, { id: 'comment-id', [field]: value }), field).toBe(true);
    }
    expect(rawAccepts(update, { id: 'comment-id', skipEditedAt: true })).toBe(false);
    expect(rawAccepts(update, { id: 'comment-id', body: 'Text', skipEditedAt: true })).toBe(true);
    expect(rawAccepts(update, { id: 'comment-id' })).toBe(false);
    expect(rawAccepts(update, { id: 'comment-id', trashed: true })).toBe(false);
    expect(rawAccepts(update, { id: 'comment-id', issueId: ISSUE_ID })).toBe(false);
  });

  it('publishes an independent dated field fixture and excludes unsafe or unsupported fields', () => {
    expect(Object.keys((create.parameters as any).properties)).toEqual([
      'issue', 'body', 'view', 'advanced',
    ]);
    expect(Object.keys((update.parameters as any).properties)).toEqual([
      'id', 'body', 'bodyData', 'quotedText', 'skipEditedAt', 'view',
    ]);
    for (const field of ['input', 'issueId', 'subscriberIds', 'createAsUser', 'displayIconUrl', 'resolvingCommentId', 'resolvingUserId', 'resolved', 'trashed', 'archivedAt', 'externalUserId']) {
      expect((create.parameters as any).properties).not.toHaveProperty(field);
      expect((update.parameters as any).properties).not.toHaveProperty(field);
    }
  });
});

describe('comment compatibility validation and preparation', () => {
  it('records exact authenticated introspection wrappers and payload fields independently', () => {
    expect(LIVE_COMMENT_SCHEMA_2026_08_19.payload).toEqual({
      lastSyncId: 'Float!', comment: 'Comment!', success: 'Boolean!',
    });
    expect(LIVE_COMMENT_SCHEMA_2026_08_19.mutations.commentResolve).toEqual({
      arguments: { id: 'String!', resolvingCommentId: 'String' }, returns: 'CommentPayload!',
    });
    expect(LIVE_COMMENT_SCHEMA_2026_08_19.mutations.commentUnresolve).toEqual({
      arguments: { id: 'String!' }, returns: 'CommentPayload!',
    });

    for (const [operationName, mutationName] of [
      ['create_comment', 'commentCreate'],
      ['update_comment', 'commentUpdate'],
    ] as const) {
      const document = parse(operations[operationName].document);
      const definition = document.definitions[0] as any;
      const variables = Object.fromEntries(definition.variableDefinitions.map((variable: any) => [
        variable.variable.name.value, print(variable.type),
      ]));
      const field = definition.selectionSet.selections[0];
      const argumentsByName = Object.fromEntries(field.arguments.map((argument: any) => [
        argument.name.value, `$${argument.value.name.value}`,
      ]));
      expect(field.name.value).toBe(mutationName);
      expect(variables).toEqual(LIVE_COMMENT_SCHEMA_2026_08_19.mutations[mutationName].arguments);
      expect(Object.keys(argumentsByName).sort()).toEqual(Object.keys(variables).sort());
      expect(operations[operationName].variants?.[0]).toMatchObject({
        root: mutationName,
        mutationResult: { requiredEntityPaths: ['comment'] },
      });
    }
  });

  it('keeps every live input field in raw compatibility and gates non-canonical fields', () => {
    const createValues = {
      id: TARGET_ID,
      body: 'Text',
      bodyData: { type: 'doc' },
      issueId: 'AEO-258',
      projectUpdateId: TARGET_ID,
      initiativeUpdateId: TARGET_ID,
      postId: TARGET_ID,
      documentContentId: TARGET_ID,
      projectId: TARGET_ID,
      initiativeId: TARGET_ID,
      parentId: TARGET_ID,
      createAsUser: 'Linear Importer',
      displayIconUrl: 'https://example.com/icon.png',
      createdAt: '2026-08-18T00:00:00Z',
      doNotSubscribeToIssue: true,
      createOnSyncedSlackThread: true,
      quotedText: 'quote',
      subscriberIds: [TARGET_ID],
    } satisfies CompatibilityObject;
    const targetFields = new Set([
      'issueId', 'projectId', 'initiativeId', 'projectUpdateId', 'initiativeUpdateId',
      'postId', 'documentContentId', 'parentId',
    ]);
    for (const field of Object.keys(LIVE_COMMENT_SCHEMA_2026_08_19.inputs.CommentCreateInput)) {
      const input: CompatibilityObject = targetFields.has(field)
        ? { [field]: compatibilityField(createValues, field), body: 'Text' }
        : field === 'bodyData'
          ? { issueId: 'AEO-258', bodyData: createValues.bodyData }
          : { issueId: 'AEO-258', body: 'Text', [field]: compatibilityField(createValues, field) };
      if (field === 'displayIconUrl') input.createAsUser = 'Linear Importer';
      expect(() => resolveRequest({ operation: 'create_comment', variables: { input } }), field).not.toThrow();
    }

    const updateValues = {
      body: 'Text',
      bodyData: { type: 'doc' },
      resolvingUserId: TARGET_ID,
      resolvingCommentId: TARGET_ID,
      quotedText: 'quote',
      subscriberIds: [TARGET_ID],
      doNotSubscribeToIssue: true,
    } satisfies CompatibilityObject;
    for (const field of Object.keys(LIVE_COMMENT_SCHEMA_2026_08_19.inputs.CommentUpdateInput)) {
      expect(() => resolveRequest({
        operation: 'update_comment', variables: { id: 'comment-id', input: { [field]: compatibilityField(updateValues, field) } },
      }), field).not.toThrow();
    }

    for (const field of ['createAsUser', 'displayIconUrl', 'subscriberIds']) {
      expect(() => resolveRequest({
        operation: 'create_comment', variables: { issue: 'AEO-258', body: 'Text', [field]: compatibilityField(createValues, field) },
      })).toThrow();
    }
    for (const field of ['resolvingUserId', 'resolvingCommentId', 'subscriberIds', 'doNotSubscribeToIssue', 'resolved']) {
      expect(() => resolveRequest({
        operation: 'update_comment', variables: { id: 'comment-id', [field]: compatibilityField(updateValues, field) ?? true },
      })).toThrow();
    }
    expect(() => resolveRequest({
      operation: 'update_comment', variables: { id: 'comment-id', input: { resolved: true } },
    })).toThrow();
  });

  it.each([
    ['projectId', TARGET_ID],
    ['initiativeId', TARGET_ID],
    ['projectUpdateId', TARGET_ID],
    ['initiativeUpdateId', TARGET_ID],
    ['postId', TARGET_ID],
    ['documentContentId', TARGET_ID],
    ['parentId', TARGET_ID],
  ] as const)('accepts named compatibility target %s', (target, value) => {
    expect(() => resolveRequest({ operation: 'create_comment', variables: { [target]: value, body: 'Text' } })).not.toThrow();
    expect(() => resolveRequest({ operation: 'create_comment', variables: { input: { [target]: value, bodyData: { type: 'doc' } } } })).not.toThrow();
  });

  it('keeps independent compatibility metadata in parity with the dated safe inputs', () => {
    expect((operations.create_comment.acceptedParameters ?? []).map(({ name }) => name)).toEqual([
      'issue', 'body', 'bodyData', 'createOnSyncedSlackThread', 'createdAt',
      'doNotSubscribeToIssue', 'documentContentId', 'id', 'initiativeId', 'initiativeUpdateId',
      'issueId', 'parentId', 'postId', 'projectId', 'projectUpdateId', 'quotedText', 'input', 'view',
    ]);
    expect(operations.update_comment.parameters.map(({ name }) => name)).toEqual([
      'id', 'body', 'bodyData', 'quotedText', 'skipEditedAt', 'input', 'view',
    ]);
  });

  it('keeps issue aliases safe and resolves AEO-258 exactly', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      expect(request.query).toContain('ResolveIssueById');
      expect(request.variables).toEqual({ id: 'AEO-258' });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        json: async () => ({ data: { issue: { id: ISSUE_ID, identifier: 'AEO-258', team: { id: OTHER_ID, key: 'AEO' } } } }),
      };
    });
    vi.stubGlobal('fetch', fetch);

    expect((await prepare('create_comment', { issue: 'AEO-258', body: 'Text' })).variables).toEqual({ input: { issueId: ISSUE_ID, body: 'Text' } });
    expect((await prepare('create_comment', { issueId: 'AEO-258', body: 'Text' })).variables).toEqual({ input: { issueId: ISSUE_ID, body: 'Text' } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('preserves valid UUID issue preparation and provider-safe bodyData conversion', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      expect(request.query).toContain('ResolveIssueById');
      expect(request.variables).toEqual({ id: ISSUE_ID });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        json: async () => ({ data: { issue: { id: ISSUE_ID, identifier: 'AEO-258', team: { id: OTHER_ID, key: 'AEO' } } } }),
      };
    });
    vi.stubGlobal('fetch', fetch);
    const bodyData = { type: 'doc', content: [{ type: 'paragraph' }] };

    expect((await prepare('create_comment', { issue: ISSUE_ID, advanced: { bodyData } })).variables).toEqual({ input: { issueId: ISSUE_ID, bodyData } });
    expect(fetch).toHaveBeenCalledTimes(1);

    for (const useParameters of [false, true]) {
      const converted = convertTools([create, update] as any, useParameters, false)![0]!.functionDeclarations as any[];
      const createParameters = converted[0]!.parametersJsonSchema ?? converted[0]!.parameters;
      const updateParameters = converted[1]!.parametersJsonSchema ?? converted[1]!.parameters;
      expect(createParameters.properties.advanced.type).toBe('object');
      expect(createParameters.properties).not.toHaveProperty('bodyData');
      expect(updateParameters.properties.bodyData.type).toBe('object');
    }
    for (const tool of [create, update]) {
      expect(tool.constrainedSampling).toBe(false);
      expect(resolveJsonSchemaStrictSampling(tool as any, true)).toBeUndefined();
    }
  });

  it.each([
    ['missing target', { body: 'Text' }],
    ['conflicting targets', { issue: 'AEO-258', projectId: TARGET_ID, body: 'Text' }],
    ['conflicting nested target', { issue: 'AEO-258', input: { projectId: TARGET_ID, body: 'Text' } }],
    ['missing content', { projectId: TARGET_ID }],
    ['body and bodyData', { projectId: TARGET_ID, body: 'Text', bodyData: { type: 'doc' } }],
    ['string bodyData', { projectId: TARGET_ID, bodyData: 'serialized' }],
    ['unknown nested field', { input: { projectId: TARGET_ID, body: 'Text', trashed: true } }],
  ])('rejects %s before auth or network', async (_name, variables) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const api = tools.get('linear_create_comment')!;
    await expect(api.execute('call-1', variables as never, undefined, undefined, { hasUI: false } as any)).rejects.toThrow();
    expect(() => resolveRequest({ operation: 'create_comment', variables })).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['identity only', { id: 'comment-id' }],
    ['string bodyData', { id: 'comment-id', bodyData: 'serialized' }],
    ['unknown field', { id: 'comment-id', archivedAt: '2026-08-18T00:00:00Z' }],
    ['unknown nested field', { id: 'comment-id', input: { body: 'Text', trashed: true } }],
  ])('rejects update %s before auth or network', async (_name, variables) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(update.execute('call-1', variables as never, undefined, undefined, { hasUI: false } as any)).rejects.toThrow();
    expect(() => resolveRequest({ operation: 'update_comment', variables })).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('normalizes all direct targets and current safe fields without conversion', async () => {
    const bodyData = { type: 'doc', content: [] };
    for (const [target, value] of TARGETS.slice(3)) {
      expect((await prepare('create_comment', { [target]: value, bodyData, subscriberIds: [OTHER_ID] })).variables)
        .toEqual({ input: { [target]: value, bodyData, subscriberIds: [OTHER_ID] } });
    }
    expect((await prepare('update_comment', {
      id: 'comment-id', bodyData, skipEditedAt: true,
    })).variables).toEqual({
      id: 'comment-id', skipEditedAt: true,
      input: { bodyData },
    });
  });
});
