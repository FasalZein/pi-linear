import { readFileSync } from 'node:fs';
import { Kind, parse } from 'graphql';
import { describe, expect, it } from 'vitest';
import { helpResult, resolveRequest } from '../extensions/api';
import {
  getOperation,
  operationDefinitions,
  operationDocuments,
  operations,
  projectCompatibilityOperation,
} from '../extensions/operations';
import { requirementBranchMatches } from '../extensions/operation-definition';
import type { RequirementBranch } from '../extensions/operation-types';

// Static renderer fixture updated for canonical invocation fields. Tests never generate it during verification.
const RENDERER_FIXTURE = JSON.parse(readFileSync(
  new URL('./fixtures/v06-renderer-metadata.json', import.meta.url),
  'utf8',
)) as Record<string, unknown>;

const CREATE_ISSUE_BRANCH_FIXTURE: readonly RequirementBranch[] = [
  {
    all: ['title'],
    atLeastOneOf: ['team', 'teamKey', 'teamId', 'parent', 'input.teamId', 'input.parentId'],
  },
  {
    all: ['input.title'],
    atLeastOneOf: ['team', 'teamKey', 'teamId', 'parent', 'input.teamId', 'input.parentId'],
  },
];

function definition(name: string) {
  return operationDefinitions.find((value) => value.name === name)!;
}

function assertRendererFixtureParity(): void {
  expect(Object.fromEntries(operationDefinitions.map((value) => [value.name, value.render])))
    .toEqual(RENDERER_FIXTURE);
}

function assertCreateIssueBranchFixtureParity(): void {
  expect(definition('create_issue').compatibility.branches).toEqual(CREATE_ISSUE_BRANCH_FIXTURE);
}

const CANONICAL_NAMES = [
  'list_comments', 'create_comment', 'update_comment', 'list_views', 'get_view', 'create_view',
  'update_view', 'set_view_preferences', 'list_cycles', 'get_cycle', 'create_cycle', 'update_cycle',
  'list_documents', 'get_document', 'create_document', 'update_document', 'list_initiatives',
  'get_initiative', 'list_issue_labels', 'create_issue_label',
  'update_issue_label', 'list_issue_relations', 'create_issue_relation', 'update_issue_relation',
  'delete_issue_relation', 'list_issue_statuses', 'list_issues', 'get_issue', 'create_issue', 'update_issue', 'search_issues',
  'list_milestones', 'get_milestone', 'list_project_labels',
  'create_project_label', 'update_project_label', 'list_project_relations',
  'create_project_relation', 'update_project_relation', 'list_projects', 'get_project',
  'list_teams', 'get_team', 'list_users', 'get_user', 'switch_workspace', 'save_initiative',
  'save_milestone', 'save_project',
] as const;

const COMPATIBILITY_ALIASES = {
  add_comment: 'create_comment',
  create_relation: 'create_issue_relation',
  list_workflow_states: 'list_issue_statuses',
  update_issue_state: 'update_issue',
} as const;

describe('v0.6 operation definition authority', () => {
  it('owns all 49 unique operation identities and required contract sections', () => {
    expect(operationDefinitions.map(({ name }) => name)).toEqual(CANONICAL_NAMES);
    expect(new Set(operationDefinitions.map(({ name }) => name)).size).toBe(49);
    for (const definition of operationDefinitions) {
      expect(definition.toolName).toBe(`linear_${definition.name}`);
      expect(definition.compatibility.example).toEqual({
        operation: definition.name,
        variables: expect.any(Object),
      });
      expect(definition.compatibility.fields).toBeDefined();
      expect(definition.compatibility.branches.length).toBeGreaterThan(0);
      expect(definition.compatibility.prepare ?? definition.compatibility.executeLocal).toBeTypeOf('function');
      expect(definition.result.renderKind).toBeTruthy();
      expect(definition.render.callFields).toEqual(definition.canonical.fields.map(({ name }) => name));
      expect(definition.canonical.strictRawArguments).toBe(true);
    }
  });

  it('owns all compatibility aliases and projects the exact public catalog shape', () => {
    expect(Object.fromEntries(operationDefinitions.flatMap((definition) =>
      definition.compatibility.operationAliases.map((alias) => [alias, definition.name]),
    ))).toEqual(COMPATIBILITY_ALIASES);

    expect(Object.keys(operations)).toEqual(CANONICAL_NAMES);
    for (const definition of operationDefinitions) {
      expect(operations[definition.name]).toEqual(projectCompatibilityOperation(definition));
      for (const alias of definition.compatibility.operationAliases) {
        expect(getOperation(alias)).toBe(operations[definition.name]);
      }
    }
  });

  it('owns every GraphQL document and all 26 mutation expectations', () => {
    const mutations = operationDefinitions.flatMap((definition) =>
      definition.graphql?.documents.filter((variant) => variant.kind === 'mutation') ?? [],
    );
    expect(mutations).toHaveLength(26);
    for (const definition of operationDefinitions) {
      expect(operationDocuments(operations[definition.name])).toEqual(
        definition.graphql?.documents.map(({ document }) => document) ?? [definition.compatibility.document],
      );
      for (const variant of definition.graphql?.documents ?? []) {
        const operation = parse(variant.document).definitions.find(
          (entry) => entry.kind === Kind.OPERATION_DEFINITION,
        );
        expect(operation?.kind).toBe(Kind.OPERATION_DEFINITION);
        expect(variant.mutationResult !== undefined).toBe(variant.kind === 'mutation');
      }
    }
  });

  it('authors exact compatibility requirements and names every semantic-only exception', () => {
    assertCreateIssueBranchFixtureParity();
    expect(definition('create_comment').compatibility.branches[0]).toMatchObject({
      all: [],
      exactlyOneOf: [expect.arrayContaining(['issue', 'input.issueId']), ['body', 'bodyData', 'input.body', 'input.bodyData']],
    });
    expect(definition('update_comment').compatibility.branches[0]).toMatchObject({
      all: ['id'],
      atLeastOneOf: expect.arrayContaining(['body', 'input.bodyData']),
    });
    for (const name of ['save_initiative', 'save_milestone', 'save_project']) {
      const branches = definition(name).compatibility.branches;
      expect(branches.some(({ mode, forbidden }) => mode === 'create' && Boolean(forbidden?.length))).toBe(true);
      expect(branches.some(({ mode, atLeastOneOf, forbidden }) =>
        mode === 'update' && Boolean(atLeastOneOf?.length) && Boolean(forbidden?.length))).toBe(true);
    }
    for (const value of operationDefinitions.filter(({ compatibility }) => compatibility.requiresVariables)) {
      expect(value.compatibility.branches.some((branch) => requirementBranchMatches(branch, {})), value.name).toBe(false);
    }
    expect(Object.fromEntries(operationDefinitions
      .filter(({ compatibility }) => compatibility.semanticValidateVariables)
      .map(({ name, compatibility }) => [name, compatibility.semanticException]))).toEqual({
      create_comment: 'comment-value-types',
      update_comment: 'comment-value-types',
      create_document: 'nested-title-type',
      create_issue_label: 'nested-name-type',
      list_issues: 'state-name-requires-team',
      create_issue: 'non-empty-title-and-team-or-parent',
      create_project_label: 'nested-name-type',
      delete_issue_relation: 'All delete guards must be exact UUIDs and the relation type must be closed.',
      save_initiative: 'save-value-types',
      save_milestone: 'save-value-types',
      save_project: 'save-value-types',
    });
  });

  it('projects branch validation for all, atLeastOneOf, exactlyOneOf, and forbidden', () => {
    expect(() => operations.create_issue.validateVariables?.({ title: 'T', parent: 'AEO-1' })).not.toThrow();
    expect(() => operations.create_issue.validateVariables?.({ title: 'T' })).toThrow();
    expect(() => operations.create_comment.validateVariables?.({ issue: 'AEO-1', body: 'ok' })).not.toThrow();
    expect(() => operations.create_comment.validateVariables?.({ issue: 'AEO-1', projectId: 'p', body: 'ok' })).toThrow(
      'exactly one comment target is required',
    );
    expect(() => operations.update_comment.validateVariables?.({ id: 'c' })).toThrow(
      'at least one comment update field is required',
    );
    expect(() => operations.save_project.validateVariables?.({
      projectId: 'p', id: 'create-only', name: 'update',
    })).toThrow('Params not valid in update mode: id.');
  });

  it('detects deliberate independent compatibility and renderer fixture drift', () => {
    const issue = definition('create_issue');
    const branches = issue.compatibility.branches;
    issue.compatibility.branches = [{ all: [] }];
    expect(assertCreateIssueBranchFixtureParity).toThrow();
    issue.compatibility.branches = branches;

    const render = definition('get_issue').render;
    const renderKind = render.entityKind;
    render.entityKind = 'project';
    expect(assertRendererFixtureParity).toThrow();
    render.entityKind = renderKind;

    assertCreateIssueBranchFixtureParity();
    assertRendererFixtureParity();
  });

  it('matches renderer kind and call fields against an independent fixture', () => {
    assertRendererFixtureParity();
  });

  it('projects complete canonical help while preserving examples, preparation, and raw fallback', () => {
    for (const definition of operationDefinitions) {
      expect(helpResult({ operation: definition.name })).toMatchObject({
        name: definition.name,
        purpose: definition.purpose,
        parameters: definition.canonical.fields,
        requirements: definition.canonical.branches.map(({ all }) => all),
        example: definition.compatibility.example,
      });
      expect(() => resolveRequest(definition.compatibility.example)).not.toThrow();
    }
    expect(resolveRequest({ query: 'query { viewer { id } }', variables: {} }).named).toBe(false);
  });
});
