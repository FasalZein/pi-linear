import { Kind, parse } from 'graphql';
import { describe, expect, it } from 'vitest';
import { helpResult, resolveRequest } from '../extensions/api';
import { assertActivationAdapterParity } from '../extensions/activation';
import { assertCanonicalAdapterParity } from '../extensions/canonical';
import {
  getOperation,
  operationDefinitions,
  operationDocuments,
  operations,
  projectCompatibilityOperation,
} from '../extensions/operations';

const CANONICAL_NAMES = [
  'list_comments', 'create_comment', 'update_comment', 'list_views', 'get_view', 'create_view',
  'update_view', 'set_view_preferences', 'list_cycles', 'get_cycle', 'create_cycle', 'update_cycle',
  'list_documents', 'get_document', 'create_document', 'update_document', 'list_initiatives',
  'get_initiative', 'list_issue_labels', 'create_issue_label',
  'update_issue_label', 'list_issue_relations', 'create_issue_relation', 'update_issue_relation',
  'list_issue_statuses', 'list_issues', 'get_issue', 'create_issue', 'update_issue', 'search_issues',
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
  it('owns all 48 unique operation identities and required contract sections', () => {
    expect(operationDefinitions.map(({ name }) => name)).toEqual(CANONICAL_NAMES);
    expect(new Set(operationDefinitions.map(({ name }) => name)).size).toBe(48);
    for (const definition of operationDefinitions) {
      expect(definition.toolName).toBe(`linear_${definition.name}`);
      expect(definition.compatibility.example).toEqual({
        operation: definition.name,
        variables: expect.any(Object),
      });
      expect(definition.compatibility.fields).toBeDefined();
      expect(definition.compatibility.branches.length).toBeGreaterThan(0);
      expect(definition.compatibility.prepare ?? definition.compatibility.executeLocal).toBeTypeOf('function');
      expect(definition.discovery.exactHelp).toBe(true);
      expect(definition.result.renderKind).toBeTruthy();
      expect(definition.render.callFields).toEqual(definition.compatibility.fields.map(({ name }) => name));
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

  it('owns every GraphQL document and all 25 mutation expectations', () => {
    const mutations = operationDefinitions.flatMap((definition) =>
      definition.graphql?.documents.filter((variant) => variant.kind === 'mutation') ?? [],
    );
    expect(mutations).toHaveLength(25);
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

  it('projects help, examples, preparation, raw fallback, and adapter parity without behavior changes', () => {
    for (const definition of operationDefinitions) {
      expect(helpResult({ operation: definition.name })).toMatchObject({
        name: definition.name,
        purpose: definition.purpose,
        parameters: definition.compatibility.fields,
        example: definition.compatibility.example,
      });
      expect(() => resolveRequest(definition.compatibility.example)).not.toThrow();
    }
    expect(resolveRequest({ query: 'query { viewer { id } }', variables: {} }).named).toBe(false);
    expect(() => assertCanonicalAdapterParity()).not.toThrow();
    expect(() => assertActivationAdapterParity()).not.toThrow();
  });
});
