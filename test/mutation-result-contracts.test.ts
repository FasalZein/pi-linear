import { Kind, parse, type SelectionSetNode } from 'graphql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { operationDocuments, operations } from '../extensions/operations';
import { executeOperation, validateMutationResult } from '../extensions/runtime';
import { typedLinearTools } from '../extensions/typed-tools';
import { isolateLinearCredentials } from './helpers/credentials';
import { parseJsonObject, type JsonObject } from '../extensions/json';
import { isCompatibilityString } from '../extensions/operation-types';

isolateLinearCredentials();

const ORIGINAL_API_KEY = process.env.LINEAR_API_KEY;

afterEach(() => {
  if (ORIGINAL_API_KEY === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = ORIGINAL_API_KEY;
  vi.unstubAllGlobals();
});

const EXPECTED_MUTATIONS = {
  create_comment: { commentCreate: 'comment' },
  update_comment: { commentUpdate: 'comment' },
  create_view: { customViewCreate: 'customView' },
  update_view: { customViewUpdate: 'customView' },
  set_view_preferences: { viewPreferencesCreate: 'viewPreferences' },
  create_cycle: { cycleCreate: 'cycle' },
  update_cycle: { cycleUpdate: 'cycle' },
  create_document: { documentCreate: 'document' },
  update_document: { documentUpdate: 'document' },
  save_initiative: { initiativeCreate: 'initiative', initiativeUpdate: 'initiative' },
  create_issue_label: { issueLabelCreate: 'issueLabel' },
  update_issue_label: { issueLabelUpdate: 'issueLabel' },
  create_issue_relation: { issueRelationCreate: 'issueRelation' },
  update_issue_relation: { issueRelationUpdate: 'issueRelation' },
  delete_issue_relation: { issueRelationDelete: null },
  create_issue: { issueCreate: 'issue' },
  update_issue: { issueUpdate: 'issue' },
  save_milestone: { projectMilestoneCreate: 'projectMilestone', projectMilestoneUpdate: 'projectMilestone' },
  create_project_label: { projectLabelCreate: 'projectLabel' },
  update_project_label: { projectLabelUpdate: 'projectLabel' },
  create_project_relation: { projectRelationCreate: 'projectRelation' },
  update_project_relation: { projectRelationUpdate: 'projectRelation' },
  save_project: { projectCreate: 'project', projectUpdate: 'project' },
} as const;

function selectsPath(selectionSet: SelectionSetNode, path: readonly string[]): boolean {
  const [field, ...rest] = path;
  const selection = selectionSet.selections.find(
    (value) => value.kind === Kind.FIELD && value.name.value === field,
  );
  if (!selection || selection.kind !== Kind.FIELD) return false;
  return rest.length === 0 || Boolean(selection.selectionSet && selectsPath(selection.selectionSet, rest));
}

describe('mutation document result contracts', () => {
  it('co-locates one executable expectation with every current named mutation root', () => {
    const actual: Record<string, Record<string, string | null>> = {};

    for (const [name, operation] of Object.entries(operations)) {
      const variants = operation.variants ?? [];
      for (const variant of variants) {
        const definition = parse(variant.document).definitions.find((value) => value.kind === Kind.OPERATION_DEFINITION);
        if (!definition || definition.kind !== Kind.OPERATION_DEFINITION || definition.operation !== 'mutation') continue;

        expect(variant.mutationResult).toBeDefined();
        const rootSelection = definition.selectionSet.selections[0];
        expect(rootSelection?.kind).toBe(Kind.FIELD);
        if (!rootSelection || rootSelection.kind !== Kind.FIELD || !variant.mutationResult) continue;
        expect(variant.root).toBe(rootSelection.name.value);
        expect(variant.mutationResult.successPath).toBe('success');
        expect(variant.mutationResult.successValue).toBe(true);
        const declaredForOperation = EXPECTED_MUTATIONS[
          name as keyof typeof EXPECTED_MUTATIONS
        ] as Record<string, string | null> | undefined;
        const declaredEntityPath = declaredForOperation?.[variant.root];
        const payloadSelections = rootSelection.selectionSet;
        expect(variant.mutationResult.requiredEntityPaths).toEqual(
          declaredEntityPath ? [declaredEntityPath] : [],
        );
        expect(payloadSelections).toBeDefined();
        if (declaredEntityPath === undefined || !payloadSelections) throw new Error('Invalid mutation fixture.');
        expect(selectsPath(payloadSelections, ['success'])).toBe(true);
        if (declaredEntityPath) expect(selectsPath(payloadSelections, declaredEntityPath.split('.'))).toBe(true);
        actual[name] ??= {};
        actual[name]![variant.root] = declaredEntityPath;

        const entity = declaredEntityPath ? { [declaredEntityPath]: { id: 'entity-id' } } : {};
        const valid = { [variant.root]: { success: true, ...entity } };
        expect(() => validateMutationResult(name, valid, variant)).not.toThrow();
        expect(() => validateMutationResult(name, {
          [variant.root]: { success: false, ...entity },
        }, variant)).toThrow(`Linear operation "${name}" failed mutation expectation: ${variant.root}.success must be true.`);
      }
    }

    expect(actual).toEqual(EXPECTED_MUTATIONS);
    expect(Object.values(operations).every((operation) => !('mutationRoots' in operation))).toBe(true);
  });

  it('keeps separate create and update contracts for all save operations', () => {
    for (const name of ['save_initiative', 'save_milestone', 'save_project'] as const) {
      expect(operations[name].variants?.map(({ when, root }) => ({ when, root }))).toEqual([
        { when: 'create', root: Object.keys(EXPECTED_MUTATIONS[name])[0] },
        { when: 'update', root: Object.keys(EXPECTED_MUTATIONS[name])[1] },
      ]);
    }
  });

  it.each([
    ['missing root', {}, 'issueCreate must be an object'],
    ['null root', { issueCreate: null }, 'issueCreate must be an object'],
    ['missing success', { issueCreate: { issue: { id: 'issue-1' } } }, 'issueCreate.success must be true'],
    ['false success', { issueCreate: { success: false, issue: { id: 'issue-1' } } }, 'issueCreate.success must be true'],
    ['missing entity', { issueCreate: { success: true } }, 'issueCreate.issue must be an object'],
    ['null entity', { issueCreate: { success: true, issue: null } }, 'issueCreate.issue must be an object'],
  ])('rejects %s with a stable operation-specific error', (_case, data, expectation) => {
    const variant = operations.create_issue.variants![0]!;
    expect(() => validateMutationResult('create_issue', data, variant)).toThrow(
      `Linear operation "create_issue" failed mutation expectation: ${expectation}.`,
    );
  });

  it('permits success-only or nullable entity payloads only when metadata declares no required entity', () => {
    const variant = {
      document: 'mutation Ack { acknowledge { success } }',
      root: 'acknowledge',
      mutationResult: { successPath: 'success', successValue: true, requiredEntityPaths: [] },
    } as const;
    expect(() => validateMutationResult('acknowledge', { acknowledge: { success: true } }, variant)).not.toThrow();
  });

  it('rejects missing mutation metadata before real resolver preparation but permits a query variant without it', async () => {
    delete process.env.LINEAR_API_KEY;
    const mutationVariant = {
      document: operations.create_issue.variants![0]!.document,
      root: 'issueCreate',
    };
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: { viewer: { id: 'viewer-1' } } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetch);

    await expect(executeOperation(
      { ...operations.create_issue, variants: [mutationVariant] },
      { variables: { title: 'Missing metadata', parent: 'AEO-279' } },
      'allowlist',
      { hasUI: false } as any,
      undefined,
    )).rejects.toThrow(
      'Linear operation "create_issue" selected mutation variant "issueCreate" without mutationResult metadata.',
    );
    expect(fetch).not.toHaveBeenCalled();

    process.env.LINEAR_API_KEY = 'test-key';
    const queryVariant = {
      document: 'query VariantQuery { viewer { id } }',
      root: 'viewer',
    };
    await expect(executeOperation(
      {
        ...operations.get_issue,
        variants: [queryVariant],
        plan: async () => ({
          kind: 'query',
          lookups: [],
          finish: () => ({ variant: queryVariant, variables: {} }),
        }),
      },
      { variables: {} },
      'allowlist',
      { hasUI: false } as any,
      undefined,
    )).resolves.toMatchObject({ data: { viewer: { id: 'viewer-1' } } });
  });

  it('keeps operationDocuments aligned with mutation variants', () => {
    for (const operation of Object.values(operations)) {
      expect(operationDocuments(operation)).toEqual(operation.variants?.map(({ document }) => document) ?? [operation.document]);
    }
  });
});

describe('shared mutation response validation', () => {
  const SAVE_CASES = [
    ['save_initiative', 'create', { name: 'Initiative' }, 'initiativeCreate', 'initiative'],
    ['save_initiative', 'update', { initiativeId: '11111111-1111-4111-8111-111111111111', name: 'Initiative' }, 'initiativeUpdate', 'initiative'],
    ['save_milestone', 'create', { name: 'Milestone', projectId: '22222222-2222-4222-8222-222222222222' }, 'projectMilestoneCreate', 'projectMilestone'],
    ['save_milestone', 'update', { milestoneId: '33333333-3333-4333-8333-333333333333', name: 'Milestone' }, 'projectMilestoneUpdate', 'projectMilestone'],
    ['save_project', 'create', { name: 'Project', teamIds: ['44444444-4444-4444-8444-444444444444'] }, 'projectCreate', 'project'],
    ['save_project', 'update', { projectId: '55555555-5555-4555-8555-555555555555', name: 'Project' }, 'projectUpdate', 'project'],
  ] as const;

  it.each(SAVE_CASES)(
    'executes %s %s through its declared variant and response root',
    async (name, mode, variables, expectedRoot, entityPath) => {
      process.env.LINEAR_API_KEY = 'test-key';
      const expectedVariant = operations[name].variants!.find((variant) => variant.when === mode)!;
      const responseEnvelope = {
        [expectedRoot]: { success: true, [entityPath]: { id: `${name}-${mode}` } },
      };
      const mutationDocuments: string[] = [];
      const mutationRoots: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        const request = parseJsonObject(JSON.parse(String(init.body))) ?? {};
        if (!isCompatibilityString(request.query)) throw new Error('Test transport received a request without a query.');
        const requestVariables = parseJsonObject(request.variables) ?? {};
        const definition = parse(request.query).definitions.find(
          (value) => value.kind === Kind.OPERATION_DEFINITION,
        );
        if (definition?.kind === Kind.OPERATION_DEFINITION && definition.operation === 'mutation') {
          const root = definition.selectionSet.selections[0];
          mutationDocuments.push(request.query);
          if (root?.kind === Kind.FIELD) mutationRoots.push(root.name.value);
          return new Response(JSON.stringify({ data: responseEnvelope }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const root = definition?.kind === Kind.OPERATION_DEFINITION
          ? definition.selectionSet.selections[0]
          : undefined;
        const rootName = root?.kind === Kind.FIELD ? root.name.value : 'unknown';
        return new Response(JSON.stringify({
          data: { [rootName]: { id: requestVariables.id ?? null, name: 'Resolved' } },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }));

      await expect(executeOperation(
        operations[name],
        { variables },
        'allowlist',
        { hasUI: false } as any,
        undefined,
      )).resolves.toMatchObject({ data: responseEnvelope });
      expect(mutationDocuments).toEqual([expectedVariant.document]);
      expect(mutationRoots).toEqual([expectedRoot]);
    },
  );

  const variables = {
    projectId: '11111111-1111-4111-8111-111111111111',
    relatedProjectId: '22222222-2222-4222-8222-222222222222',
    type: 'related',
    anchorType: 'project',
    relatedAnchorType: 'project',
  };

  function installFailure(payload: JsonObject) {
    process.env.LINEAR_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: payload }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));
  }

  it.each([
    ['typed tool with workspace routing', () => {
      const tool = typedLinearTools().find(({ name }) => name === 'linear_create_project_relation')! as any;
      return tool.execute('call-1', { ...variables, workspace: 'default' }, undefined, undefined, { hasUI: false });
    }],
    ['typed tool', () => {
      const tool = typedLinearTools().find(({ name }) => name === 'linear_create_project_relation')! as any;
      return tool.execute('call-1', variables, undefined, undefined, { hasUI: false });
    }],
  ])('rejects unsuccessful named payloads on the %s surface', async (_surface, execute) => {
    installFailure({ projectRelationCreate: { success: false, projectRelation: null } });
    await expect(execute()).rejects.toThrow(
      'Linear operation "create_project_relation" failed mutation expectation: projectRelationCreate.success must be true.',
    );
  });
});
