import { Kind, parse } from 'graphql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { linearApiTool } from '../extensions/api';
import { operationDocuments, operations } from '../extensions/operations';
import { validateMutationResult } from '../extensions/runtime';
import { typedLinearTools } from '../extensions/typed-tools';
import { isolateLinearCredentials } from './helpers/credentials';

isolateLinearCredentials();

afterEach(() => vi.unstubAllGlobals());

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
  create_issue: { issueCreate: 'issue' },
  update_issue: { issueUpdate: 'issue' },
  save_milestone: { projectMilestoneCreate: 'projectMilestone', projectMilestoneUpdate: 'projectMilestone' },
  create_project_label: { projectLabelCreate: 'projectLabel' },
  update_project_label: { projectLabelUpdate: 'projectLabel' },
  create_project_relation: { projectRelationCreate: 'projectRelation' },
  update_project_relation: { projectRelationUpdate: 'projectRelation' },
  save_project: { projectCreate: 'project', projectUpdate: 'project' },
} as const;

describe('mutation document result contracts', () => {
  it('co-locates one executable expectation with every current named mutation root', () => {
    const actual: Record<string, Record<string, string>> = {};

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
        expect(variant.mutationResult.requiredEntityPaths).toHaveLength(1);

        const entityPath = variant.mutationResult.requiredEntityPaths[0]!;
        actual[name] ??= {};
        actual[name]![variant.root] = entityPath;

        const valid = { [variant.root]: { success: true, [entityPath]: { id: 'entity-id' } } };
        expect(() => validateMutationResult(name, valid, variant)).not.toThrow();
        expect(() => validateMutationResult(name, {
          [variant.root]: { success: false, [entityPath]: { id: 'entity-id' } },
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

  it('keeps operationDocuments aligned with mutation variants', () => {
    for (const operation of Object.values(operations)) {
      expect(operationDocuments(operation)).toEqual(operation.variants?.map(({ document }) => document) ?? [operation.document]);
    }
  });
});

describe('shared mutation response validation', () => {
  const variables = {
    projectId: '11111111-1111-4111-8111-111111111111',
    relatedProjectId: '22222222-2222-4222-8222-222222222222',
    type: 'related',
    anchorType: 'project',
    relatedAnchorType: 'project',
  };

  function installFailure(payload: Record<string, unknown>) {
    process.env.LINEAR_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: payload }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));
  }

  it.each([
    ['linear_api', () => (linearApiTool() as any).execute(
      'call-1', { operation: 'create_project_relation', variables }, undefined, undefined, { hasUI: false },
    )],
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
