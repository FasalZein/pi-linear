import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeBatch } from '../extensions/batch';
import { mutationAcknowledgement } from '../extensions/mutation-acknowledgement';
import { getOperation, operationDefinitions } from '../extensions/operations';
import type { JsonValue } from '../extensions/json';
import {
  isCompatibilityObject,
  isCompatibilityString,
  type CompatibilityObject,
} from '../extensions/operation-types';
import { operationRenderers } from '../extensions/renderers';
import { executeOperation } from '../extensions/runtime';
import { isolateLinearCredentials } from './helpers/credentials';

isolateLinearCredentials();

const ORIGINAL_API_KEY = process.env.LINEAR_API_KEY;

afterEach(() => {
  if (ORIGINAL_API_KEY === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = ORIGINAL_API_KEY;
  vi.unstubAllGlobals();
});

const MATRIX = JSON.parse(readFileSync(
  new URL('./fixtures/v06-mutation-acknowledgement-matrix.json', import.meta.url),
  'utf8',
)) as { readonly [name: string]: Array<{ required: string[]; target: string }> };

type ByteEntityPath =
  | 'comment'
  | 'customView'
  | 'cycle'
  | 'document'
  | 'initiative'
  | 'issueLabel'
  | 'issueRelation'
  | 'issue'
  | 'projectMilestone'
  | 'projectLabel'
  | 'projectRelation'
  | 'project'
  | 'viewPreferences';

const BYTE_FIXTURES = JSON.parse(readFileSync(
  new URL('./fixtures/mutation-acknowledgement-bytes.json', import.meta.url),
  'utf8',
)) as {
  readonly [name: string]: Array<{ root: string; entityPath: ByteEntityPath | null; bytes: number }>;
};

const theme = {
  fg: (_role: string, text: string) => text,
  bg: (_role: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
} as any;

const definitions = operationDefinitions.filter((definition) => definition.safety.mutation);

function render(operationName: string, root: string, args: CompatibilityObject): string {
  const acknowledgement = operationName === 'delete_issue_relation' ? { deleted: true } : { success: true };
  const details = {
    data: { [root]: acknowledgement },
    meta: { truncations: [], stringsClipped: 0 },
  };
  return operationRenderers(getOperation(operationName)).renderResult(
    { content: [{ type: 'text', text: JSON.stringify(details) }], details } as any,
    { expanded: false, isPartial: false },
    theme,
    { args } as any,
  ).render(200).join('\n');
}

const BYTE_ENTITY_BASE = {
  id: 'server-entity-id',
  identifier: 'AEO-828',
  slug: 'server-slug',
  slugId: 'server-slug-id',
  title: 'Server title',
  name: 'Server name',
  url: 'https://linear.app/server/entity',
  type: 'related',
  modelName: 'Issue',
  createdAt: '2026-09-07T20:00:00.000Z',
  updatedAt: '2026-09-07T21:00:00.000Z',
  resolvedAt: '2026-09-07T21:30:00.000Z',
  content: 'x'.repeat(14 * 1024),
};

function byteReference(id: string, extra: CompatibilityObject = {}): CompatibilityObject {
  return { id, name: `Server ${id}`, url: `https://linear.app/${id}`, ...extra };
}

const BYTE_ENTITY_RELATIONS = {
  comment: {
    issue: byteReference('issue', { identifier: 'AEO-828', title: 'Issue title' }),
    parent: { id: 'parent-comment' },
    user: byteReference('user'),
  },
  customView: { team: byteReference('team', { key: 'AEO' }), owner: byteReference('owner') },
  cycle: { team: byteReference('team', { key: 'AEO' }) },
  document: {
    team: byteReference('team', { key: 'AEO' }),
    project: byteReference('project'),
    issue: byteReference('issue', { identifier: 'AEO-828', title: 'Issue title' }),
    initiative: byteReference('initiative'),
  },
  initiative: { owner: byteReference('owner') },
  issueLabel: { team: byteReference('team', { key: 'AEO' }), parent: byteReference('parent-label') },
  issueRelation: {
    issue: byteReference('issue', { identifier: 'AEO-828', title: 'Issue title' }),
    relatedIssue: byteReference('related-issue', { identifier: 'AEO-829', title: 'Related issue' }),
  },
  issue: {
    team: byteReference('team', { key: 'AEO' }),
    project: byteReference('project'),
    parent: byteReference('parent-issue', { identifier: 'AEO-800', title: 'Parent issue' }),
    cycle: byteReference('cycle'),
  },
  projectMilestone: { project: byteReference('project') },
  projectLabel: { parent: byteReference('parent-label') },
  projectRelation: {
    project: byteReference('project'),
    projectMilestone: byteReference('milestone'),
    relatedProject: byteReference('related-project'),
    relatedProjectMilestone: byteReference('related-milestone'),
  },
  project: {},
  viewPreferences: {},
} satisfies Readonly<Record<ByteEntityPath, CompatibilityObject>>;

const LARGE_DOCUMENT = {
  id: 'server-document-id',
  slugId: 'server-document-slug',
  title: 'Server title',
  content: 'x'.repeat(14 * 1024),
  url: 'https://linear.app/document/server-document-slug',
  createdAt: '2026-09-07T20:00:00.000Z',
  updatedAt: '2026-09-07T21:00:00.000Z',
  project: { id: 'server-project-id', name: 'Server project', url: 'https://linear.app/project/server-project-id' },
};

function response(body: JsonValue): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requestBody(init: RequestInit): { query: string; variables: CompatibilityObject } {
  return JSON.parse(String(init.body));
}

describe('mutation acknowledgement byte contracts', () => {
  it('measures every mutation reply from a 14 KB representative entity', () => {
    const definitions = operationDefinitions.filter(({ safety }) => safety.mutation);
    expect(Object.keys(BYTE_FIXTURES).sort()).toEqual(definitions.map(({ name }) => name).sort());

    for (const definition of definitions) {
      const variants = definition.graphql!.documents.filter(({ kind }) => kind === 'mutation');
      const fixtures = BYTE_FIXTURES[definition.name]!;
      expect(fixtures.map(({ root, entityPath }) => ({ root, entityPath }))).toEqual(
        variants.map((variant) => ({
          root: variant.root,
          entityPath: variant.mutationResult!.requiredEntityPaths[0] ?? null,
        })),
      );
      for (const [index, variant] of variants.entries()) {
        const fixture = fixtures[index]!;
        const entityPath = fixture.entityPath;
        const data = entityPath
          ? {
              [variant.root]: {
                success: true,
                [entityPath]: { ...BYTE_ENTITY_BASE, ...BYTE_ENTITY_RELATIONS[entityPath] },
              },
            }
          : { [variant.root]: { success: true } };
        const acknowledgement = entityPath
          ? mutationAcknowledgement(definition.name, data, variant)
          : {
              [variant.root]: {
                relationId: '11111111-1111-4111-8111-111111111111',
                issueId: '22222222-2222-4222-8222-222222222222',
                relatedIssueId: '33333333-3333-4333-8333-333333333333',
                type: 'related',
                deleted: true,
              },
            };
        const envelope = {
          data: acknowledgement,
          meta: { truncations: [], stringsClipped: 0, view: 'summary' },
          resolution: {
            target: {
              requested: 'caller-reference',
              resolvedId: 'server-entity-id',
              name: 'Server name',
            },
          },
        };
        const json = JSON.stringify(envelope);
        expect(Buffer.byteLength(json, 'utf8')).toBe(fixture.bytes);
        expect(fixture.bytes).toBeLessThanOrEqual(1024);
        expect(json).not.toContain(BYTE_ENTITY_BASE.content);
      }
    }
  });
});

describe('mutation acknowledgement execution', () => {
  it('returns a server-derived acknowledgement under 1 KB by default and never sends view', async () => {
    process.env.LINEAR_API_KEY = 'test-key';
    const requests: Array<{ query: string; variables: CompatibilityObject }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      requests.push(requestBody(init));
      return response({ data: { documentCreate: { success: true, document: LARGE_DOCUMENT } } });
    }));

    const details = await executeOperation(
      getOperation('create_document'),
      { variables: { title: 'Caller title', content: LARGE_DOCUMENT.content } },
      'allowlist',
      { hasUI: false } as any,
      undefined,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]!.variables).toEqual({ input: { title: 'Caller title', content: LARGE_DOCUMENT.content } });
    expect(requests[0]!.variables).not.toHaveProperty('view');
    expect(requests[0]!.variables.input).not.toHaveProperty('view');
    expect(details).toMatchObject({
      data: {
        documentCreate: {
          success: true,
          document: {
            id: 'server-document-id',
            slugId: 'server-document-slug',
            title: 'Server title',
            url: LARGE_DOCUMENT.url,
            updatedAt: LARGE_DOCUMENT.updatedAt,
          },
        },
      },
      meta: { view: 'summary' },
    });
    expect(JSON.stringify(details)).not.toContain(LARGE_DOCUMENT.content);
    expect(Buffer.byteLength(JSON.stringify(details), 'utf8')).toBeLessThan(1024);
  });

  it('preserves the full server entity and resolution metadata when view is full', async () => {
    process.env.LINEAR_API_KEY = 'test-key';
    const requests: Array<{ query: string; variables: CompatibilityObject }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      requests.push(requestBody(init));
      return response({ data: { documentCreate: { success: true, document: LARGE_DOCUMENT } } });
    }));

    const operation = getOperation('create_document');
    const originalPlan = operation.plan!;
    const details = await executeOperation(
      {
        ...operation,
        plan: async (variables) => {
          const plan = await originalPlan(variables);
          return {
            ...plan,
            finish: (resolved) => ({
              ...plan.finish(resolved),
              resolution: { target: { requested: 'Caller title', resolvedId: 'server-document-id', name: 'Server title' } },
            }),
          };
        },
      },
      { variables: { title: 'Caller title', content: LARGE_DOCUMENT.content, view: 'full' } },
      'allowlist',
      { hasUI: false } as any,
      undefined,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]!.variables).not.toHaveProperty('view');
    expect(requests[0]!.variables.input).not.toHaveProperty('view');
    expect(details.data).toEqual({ documentCreate: { success: true, document: LARGE_DOCUMENT } });
    expect(details).toMatchObject({
      meta: { view: 'full' },
      resolution: { target: { requested: 'Caller title', resolvedId: 'server-document-id', name: 'Server title' } },
    });
  });

  it('retains redacted child GraphQL errors and renders a qualified warning with the acknowledgement', async () => {
    const secret = 'lin_api_acknowledgement_secret_123456789';
    process.env.LINEAR_API_KEY = secret;
    vi.stubGlobal('fetch', vi.fn(async () => response({
      data: { documentCreate: { success: true, document: { ...LARGE_DOCUMENT, content: null } } },
      errors: [{
        path: ['documentCreate', 'document', 'content'],
        message: `Content unavailable for ${secret}`,
      }],
    })));

    const operation = getOperation('create_document');
    const originalPlan = operation.plan!;
    const details = await executeOperation(
      {
        ...operation,
        plan: async (variables) => {
          const plan = await originalPlan(variables);
          return {
            ...plan,
            finish: (resolved) => ({
              ...plan.finish(resolved),
              resolution: { target: { requested: 'Caller title', resolvedId: 'server-document-id' } },
            }),
          };
        },
      },
      { variables: { title: 'Caller title', content: LARGE_DOCUMENT.content } },
      'allowlist',
      { hasUI: false } as any,
      undefined,
    );
    expect(details).toMatchObject({
      data: { documentCreate: { success: true, document: { id: 'server-document-id' } } },
      errors: [{ path: ['documentCreate', 'document', 'content'], message: 'Content unavailable for [REDACTED]' }],
      resolution: { target: { requested: 'Caller title', resolvedId: 'server-document-id' } },
    });
    expect(JSON.stringify(details)).not.toContain(secret);

    const rendered = operationRenderers(getOperation('create_document')).renderResult(
      { content: [{ type: 'text', text: JSON.stringify(details) }], details } as any,
      { expanded: false, isPartial: false },
      theme,
      { args: { title: 'Caller title' } } as any,
    ).render(200).join('\n');
    expect(rendered).toContain('with warnings');
    expect(rendered).toContain('Content unavailable for [REDACTED]');
    expect(rendered).toContain('documentCreate.document.content');
    expect(rendered).not.toContain(secret);
    expect(rendered).not.toContain('✓ Created');
  });

  it.each([
    [
      'reported failure',
      { documentCreate: { success: false, document: LARGE_DOCUMENT } },
      'documentCreate.success must be true',
    ],
    [
      'missing required entity',
      { documentCreate: { success: true, document: null } },
      'documentCreate.document must be an object',
    ],
    [
      'missing server identity',
      { documentCreate: { success: true, document: { title: 'No id' } } },
      'documentCreate.document.id must be a non-empty string',
    ],
  ] as const)('emits no acknowledgement for %s', async (_case, data, message) => {
    process.env.LINEAR_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => response({ data })));

    await expect(executeOperation(
      getOperation('create_document'),
      { variables: { title: 'Caller title' } },
      'allowlist',
      { hasUI: false } as any,
      undefined,
    )).rejects.toThrow(message);
  });

  it.each([
    ['summary', {}, false],
    ['full', { view: 'full' }, true],
  ] as const)('applies %s view to a batch mutation entry', async (_label, control, full) => {
    process.env.LINEAR_API_KEY = 'test-key';
    const requests: Array<{ query: string; variables: CompatibilityObject }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const request = requestBody(init);
      requests.push(request);
      return response({ data: { doc: { success: true, document: LARGE_DOCUMENT } } });
    }));

    const result = await executeBatch({
      variables: {
        mutations: [{
          key: 'doc',
          operation: 'create_document',
          variables: { title: 'Caller title', content: LARGE_DOCUMENT.content, ...control },
        }],
      },
    }, 'allowlist', { hasUI: false } as any, undefined);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.variables).not.toHaveProperty('doc_view');
    expect((requests[0]!.variables.doc_input as CompatibilityObject)).not.toHaveProperty('view');
    if (!isCompatibilityObject(result.data)) throw new Error('Batch result data must be an object.');
    expect(JSON.stringify(result.data.doc)).toContain('server-document-id');
    expect(JSON.stringify(result.data.doc).includes(LARGE_DOCUMENT.content)).toBe(full);
  });

  it.each([
    ['summary', {}, false],
    ['full', { view: 'full' }, true],
  ] as const)('keeps a %s batch partial error visible with the matching result shape', async (_label, control, full) => {
    process.env.LINEAR_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => response({
      data: { doc: { success: true, document: LARGE_DOCUMENT } },
      errors: [{ path: ['doc', 'document', 'content'], message: 'Content unavailable' }],
    })));

    const result = await executeBatch({
      variables: {
        mutations: [{
          key: 'doc',
          operation: 'create_document',
          variables: { title: 'Caller title', content: LARGE_DOCUMENT.content, ...control },
        }],
      },
    }, 'allowlist', { hasUI: false } as any, undefined);

    expect(result.data).toEqual({});
    expect(result.errors).toMatchObject([{
      key: 'doc',
      path: ['doc', 'document', 'content'],
      message: 'Content unavailable',
    }]);
    if (!Array.isArray(result.errors) || !isCompatibilityObject(result.errors[0])) {
      throw new Error('Batch result errors must contain an object.');
    }
    const partial = JSON.stringify(result.errors[0].partial);
    expect(partial).toContain('server-document-id');
    expect(partial.includes(LARGE_DOCUMENT.content)).toBe(full);
  });

  it('applies each entry view in a transactional create batch', async () => {
    process.env.LINEAR_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const request = requestBody(init);
      if (!request.query.includes('issueBatchCreate')) {
        const data: CompatibilityObject = {};
        for (const match of request.query.matchAll(/(\w+):\s*team\(/g)) {
          data[match[1]!] = {
            id: '11111111-1111-4111-8111-111111111111',
            key: 'AEO',
            name: 'AEO team',
          };
        }
        return response({ data });
      }
      const input = request.variables.input;
      if (!isCompatibilityObject(input) || !Array.isArray(input.issues)) {
        throw new Error('Transactional input must contain issues.');
      }
      const issues = input.issues.map((value, index) => {
        if (!isCompatibilityObject(value) || !isCompatibilityString(value.id)) {
          throw new Error('Transactional issue must contain an id.');
        }
        return {
          id: value.id,
          identifier: `AEO-${828 + index}`,
          title: `Server issue ${index + 1}`,
          description: LARGE_DOCUMENT.content,
          url: `https://linear.app/issue/AEO-${828 + index}`,
          createdAt: LARGE_DOCUMENT.createdAt,
          updatedAt: LARGE_DOCUMENT.updatedAt,
        };
      });
      return response({ data: { issueBatchCreate: { success: true, issues } } });
    }));

    const result = await executeBatch({
      variables: {
        mutations: [
          {
            key: 'summary',
            operation: 'create_issue',
            variables: {
              title: 'Summary issue',
              teamId: '11111111-1111-4111-8111-111111111111',
              description: LARGE_DOCUMENT.content,
            },
          },
          {
            key: 'full',
            operation: 'create_issue',
            variables: {
              title: 'Full issue',
              teamId: '11111111-1111-4111-8111-111111111111',
              description: LARGE_DOCUMENT.content,
              view: 'full',
            },
          },
        ],
      },
    }, 'allowlist', { hasUI: false } as any, undefined);

    if (!isCompatibilityObject(result.data)) throw new Error('Batch result data must be an object.');
    expect(JSON.stringify(result.data.summary)).not.toContain(LARGE_DOCUMENT.content);
    expect(JSON.stringify(result.data.full)).toContain(LARGE_DOCUMENT.content);
  });
});

describe('v0.6 entity-less mutation acknowledgement matrix', () => {
  it('enumerates every canonical mutation operation and branch independently', () => {
    expect(Object.keys(MATRIX).sort()).toEqual(definitions.map(({ name }) => name).sort());
    for (const definition of definitions) {
      expect(MATRIX[definition.name]!.map(({ required }) => required))
        .toEqual(definition.canonical.branches.map(({ all }) => all));
    }
  });

  for (const definition of definitions) {
    const root = definition.graphql!.documents.find(({ kind }) => kind === 'mutation')!.root;
    for (const [index, branch] of MATRIX[definition.name]!.entries()) {
      it(`${definition.name} branch ${index + 1} acknowledges ${branch.target}`, () => {
        const args = Object.fromEntries(branch.required.map((field) => [field, `value-${field}`]));
        const expected = `target-${definition.name}-${index}-${branch.target}`;
        args[branch.target] = expected;
        const rendered = render(definition.name, root, args);
        expect(rendered).toContain(expected);
        expect(rendered).not.toContain(': status unknown');
      });
    }
  }
});
