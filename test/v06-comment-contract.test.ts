import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { convertTools } from '../node_modules/@earendil-works/pi-ai/dist/api/google-shared.js';
import { resolveJsonSchemaStrictSampling } from '../node_modules/@earendil-works/pi-ai/dist/api/constrained-sampling.js';
import { resolveRequest } from '../extensions/api';
import { operations } from '../extensions/operations';
import { typedLinearTools } from '../extensions/typed-tools';
import { isolateLinearCredentials } from './helpers/credentials';

isolateLinearCredentials();

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = '33333333-3333-4333-8333-333333333333';
const tools = new Map(typedLinearTools().map((tool) => [tool.name, tool]));
const create = tools.get('linear_create_comment')!;
const update = tools.get('linear_update_comment')!;

const TARGETS = [
  ['issue', 'AEO-258'],
  ['projectId', TARGET_ID],
  ['initiativeId', TARGET_ID],
  ['projectUpdateId', TARGET_ID],
  ['initiativeUpdateId', TARGET_ID],
  ['postId', TARGET_ID],
  ['documentContentId', TARGET_ID],
  ['parentId', TARGET_ID],
] as const;

function schemaAccepts(tool: typeof create, args: Record<string, unknown>): boolean {
  try {
    validateToolArguments(tool as any, { id: 'call-1', name: tool.name, arguments: args } as any);
    return true;
  } catch {
    return false;
  }
}

function rawAccepts(tool: typeof create, args: Record<string, unknown>): boolean {
  try {
    tool.prepareArguments!(args);
    return true;
  } catch {
    return false;
  }
}

async function prepare(name: 'create_comment' | 'update_comment', variables: Record<string, unknown>) {
  return operations[name]!.prepare!('test-key', variables, undefined);
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.LINEAR_API_KEY;
});

describe('canonical comment schemas', () => {
  it.each(TARGETS)('accepts %s as the only create target with body or bodyData', (target, value) => {
    expect(schemaAccepts(create, { [target]: value, body: 'Text' })).toBe(true);
    expect(rawAccepts(create, { [target]: value, bodyData: { type: 'doc', content: [] } })).toBe(true);
  });

  it.each([
    ['string', 'serialized'],
    ['array', []],
    ['number', 1],
    ['boolean', true],
    ['null', null],
  ])('rejects %s bodyData roots', (_kind, bodyData) => {
    expect(schemaAccepts(create, { issue: 'AEO-258', bodyData })).toBe(false);
    expect(rawAccepts(update, { id: 'comment-id', bodyData })).toBe(false);
  });

  it.each([
    ['missing target', { body: 'Text' }],
    ['multiple targets', { issue: 'AEO-258', projectId: TARGET_ID, body: 'Text' }],
    ['missing content', { issue: 'AEO-258' }],
    ['multiple content values', { issue: 'AEO-258', body: 'Text', bodyData: { type: 'doc' } }],
    ['unknown field', { issue: 'AEO-258', body: 'Text', archivedAt: '2026-08-18T00:00:00Z' }],
  ])('rejects %s', (_name, args) => {
    expect(schemaAccepts(create, args)).toBe(false);
    expect(rawAccepts(create, args)).toBe(false);
  });

  it('requires update id plus one current safe field', () => {
    const fields: Record<string, unknown> = {
      body: 'Text',
      bodyData: { type: 'doc' },
      quotedText: 'quote',
      doNotSubscribeToIssue: true,
      resolvingCommentId: TARGET_ID,
      resolvingUserId: TARGET_ID,
      subscriberIds: [TARGET_ID],
    };
    for (const [field, value] of Object.entries(fields)) {
      expect(rawAccepts(update, { id: 'comment-id', [field]: value }), field).toBe(true);
    }
    expect(rawAccepts(update, { id: 'comment-id' })).toBe(false);
    expect(rawAccepts(update, { id: 'comment-id', trashed: true })).toBe(false);
    expect(rawAccepts(update, { id: 'comment-id', issueId: ISSUE_ID })).toBe(false);
  });

  it('publishes an independent dated field fixture and excludes unsafe or unsupported fields', () => {
    expect(Object.keys((create.parameters as any).properties)).toEqual([
      'issue', 'projectId', 'initiativeId', 'projectUpdateId', 'initiativeUpdateId', 'postId',
      'documentContentId', 'parentId', 'body', 'bodyData', 'quotedText', 'subscriberIds',
      'doNotSubscribeToIssue', 'createOnSyncedSlackThread', 'createAsUser', 'displayIconUrl',
      'createdAt', 'id', 'workspace',
    ]);
    expect(Object.keys((update.parameters as any).properties)).toEqual([
      'id', 'body', 'bodyData', 'quotedText', 'doNotSubscribeToIssue', 'resolvingCommentId',
      'resolvingUserId', 'subscriberIds', 'workspace',
    ]);
    for (const field of ['input', 'issueId', 'trashed', 'archivedAt', 'externalUserId']) {
      expect((create.parameters as any).properties).not.toHaveProperty(field);
      expect((update.parameters as any).properties).not.toHaveProperty(field);
    }
  });
});

describe('comment compatibility validation and preparation', () => {
  it.each(TARGETS.slice(1))('accepts named compatibility target %s', (target, value) => {
    expect(() => resolveRequest({ operation: 'create_comment', variables: { [target]: value, body: 'Text' } })).not.toThrow();
    expect(() => resolveRequest({ operation: 'create_comment', variables: { input: { [target]: value, bodyData: { type: 'doc' } } } })).not.toThrow();
  });

  it('keeps independent compatibility metadata in parity with the dated safe inputs', () => {
    expect((operations.create_comment.acceptedParameters ?? []).map(({ name }) => name)).toEqual([
      'issue', 'body', 'bodyData', 'createAsUser', 'createOnSyncedSlackThread', 'createdAt',
      'displayIconUrl', 'doNotSubscribeToIssue', 'documentContentId', 'id', 'initiativeId',
      'initiativeUpdateId', 'issueId', 'parentId', 'postId', 'projectId', 'projectUpdateId',
      'quotedText', 'subscriberIds', 'input',
    ]);
    expect(operations.update_comment.parameters.map(({ name }) => name)).toEqual([
      'id', 'body', 'bodyData', 'doNotSubscribeToIssue', 'quotedText', 'resolvingCommentId',
      'resolvingUserId', 'subscriberIds', 'input',
    ]);
  });

  it('keeps issue aliases safe and resolves AEO-258 exactly', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      expect(request.query).toContain('ResolveIssueByIdentifier');
      expect(request.variables).toEqual({ teamKey: 'AEO', number: 258 });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        json: async () => ({ data: { issues: { nodes: [{ id: ISSUE_ID, identifier: 'AEO-258', team: { id: OTHER_ID, key: 'AEO' } }] } } }),
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

    expect((await prepare('create_comment', { issue: ISSUE_ID, bodyData })).variables).toEqual({ input: { issueId: ISSUE_ID, bodyData } });
    expect(fetch).toHaveBeenCalledTimes(1);

    for (const useParameters of [false, true]) {
      const converted = convertTools([create, update] as any, useParameters, false)![0]!.functionDeclarations as any[];
      for (const declaration of converted) {
        const parameters = declaration.parametersJsonSchema ?? declaration.parameters;
        expect(parameters.properties.bodyData.type).toBe('object');
      }
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
    for (const [target, value] of TARGETS.slice(1)) {
      expect((await prepare('create_comment', { [target]: value, bodyData, subscriberIds: [OTHER_ID] })).variables)
        .toEqual({ input: { [target]: value, bodyData, subscriberIds: [OTHER_ID] } });
    }
    expect((await prepare('update_comment', {
      id: 'comment-id', bodyData, doNotSubscribeToIssue: true,
      resolvingCommentId: TARGET_ID, resolvingUserId: OTHER_ID, subscriberIds: [TARGET_ID],
    })).variables).toEqual({
      id: 'comment-id',
      input: { bodyData, doNotSubscribeToIssue: true, resolvingCommentId: TARGET_ID, resolvingUserId: OTHER_ID, subscriberIds: [TARGET_ID] },
    });
  });
});
