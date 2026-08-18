import { Kind, parse } from 'graphql';
import type {
  GraphQLDocumentVariant,
  LinearOperation,
  OperationDefinition,
  OperationDocumentDefinition,
} from './operation-types';

const EXPLICIT_RENDER_KINDS: Readonly<Record<string, string>> = {
  search_issues: 'issue',
  set_view_preferences: 'view',
  switch_workspace: 'workspace',
  list_issue_statuses: 'issue_status',
  list_issue_labels: 'label',
  create_issue_label: 'label',
  update_issue_label: 'label',
  list_project_labels: 'label',
  create_project_label: 'label',
  update_project_label: 'label',
};

function actionAndEntity(name: string): { action: string; entity: string } {
  const [action, ...parts] = name.split('_');
  return { action: action ?? name, entity: parts.join('_') || name };
}

function renderKind(name: string): string {
  if (EXPLICIT_RENDER_KINDS[name]) return EXPLICIT_RENDER_KINDS[name]!;
  const { entity } = actionAndEntity(name);
  if (entity.endsWith('ies')) return `${entity.slice(0, -3)}y`;
  return entity.endsWith('s') ? entity.slice(0, -1) : entity;
}

function documentDefinition(
  document: string,
  declared?: GraphQLDocumentVariant,
): OperationDocumentDefinition {
  const operation = parse(document).definitions.find(
    (definition) => definition.kind === Kind.OPERATION_DEFINITION,
  );
  if (!operation || operation.kind !== Kind.OPERATION_DEFINITION) {
    throw new Error('Missing GraphQL operation definition.');
  }
  const root = operation.selectionSet.selections[0];
  if (!root || root.kind !== Kind.FIELD) throw new Error('Missing GraphQL root field.');
  const kind = operation.operation === 'mutation' ? 'mutation' : 'query';
  if (declared?.root && declared.root !== root.name.value) {
    throw new Error(`GraphQL root ${root.name.value} does not match declared root ${declared.root}.`);
  }
  if (kind === 'mutation' && !declared?.mutationResult) {
    throw new Error(`Mutation ${root.name.value} is missing its result expectation.`);
  }
  if (kind === 'query' && declared?.mutationResult) {
    throw new Error(`Query ${root.name.value} cannot declare a mutation result expectation.`);
  }
  return {
    ...(declared?.when ? { when: declared.when } : {}),
    document,
    root: declared?.root ?? root.name.value,
    kind,
    ...(declared?.mutationResult ? { mutationResult: declared.mutationResult } : {}),
  };
}

/** Build the single authority object while the v0.4-shaped input stays local to this module boundary. */
export function defineOperation(operation: LinearOperation): OperationDefinition {
  const { action, entity } = actionAndEntity(operation.name);
  const local = Boolean(operation.executeLocal);
  const documents = local
    ? undefined
    : (operation.variants ?? [{ document: operation.document, root: '' }]).map((variant) =>
        documentDefinition(variant.document, operation.variants ? variant : undefined),
      );
  const kind = local
    ? 'local'
    : documents?.some((variant) => variant.kind === 'mutation')
      ? 'mutation'
      : 'query';
  const entityKind = renderKind(operation.name);
  const compatibilityBranches = [
    operation.parameters,
    ...(operation.legacyParameters ?? []),
    ...Object.values(operation.aliasParameters ?? {}),
  ].map((fields) => ({
    all: fields.filter(({ required }) => required).map(({ name }) => name),
  }));

  return {
    name: operation.name,
    toolName: `linear_${operation.name}`,
    domain: operation.domain,
    purpose: operation.purpose,
    kind,
    compatibility: {
      operationAliases: operation.aliases,
      fields: operation.parameters,
      branches: compatibilityBranches,
      ...(operation.acceptedParameters ? { acceptedFields: operation.acceptedParameters } : {}),
      ...(operation.legacyParameters ? { legacyBranches: operation.legacyParameters } : {}),
      ...(operation.aliasParameters ? { aliasFields: operation.aliasParameters } : {}),
      example: operation.example,
      document: operation.document,
      ...(operation.pagination ? { pagination: operation.pagination } : {}),
      ...(operation.resolverPaths ? { resolverPaths: operation.resolverPaths } : {}),
      ...(operation.requiresVariables ? { requiresVariables: true } : {}),
      ...(operation.validateVariables ? { validateVariables: operation.validateVariables } : {}),
      ...(operation.prepare ? { prepare: operation.prepare } : {}),
      ...(operation.executeLocal ? { executeLocal: operation.executeLocal } : {}),
    },
    ...(documents ? { graphql: { documents } } : {}),
    preparation: {
      resolverPaths: operation.resolverPaths ?? {},
      ...(operation.prepare ? { prepare: operation.prepare } : {}),
    },
    safety: {
      namedInputPolicy: 'non-destructive',
      mutation: kind === 'mutation',
    },
    discovery: {
      action,
      entity,
      terms: operation.name.split('_'),
      exactHelp: true,
    },
    result: {
      renderKind: entityKind,
      dataPaths: documents?.map(({ root }) => root) ?? ['active'],
    },
    render: {
      entityKind,
      callFields: operation.parameters.map(({ name }) => name),
      action,
    },
    canonical: {
      fields: [],
      branches: [],
      strictRawArguments: true,
      example: operation.example.variables,
    },
  };
}

const projections = new WeakMap<OperationDefinition, LinearOperation>();

/** Project the stable v0.4 runtime contract. All public consumers use this adapter during S7. */
export function projectCompatibilityOperation(definition: OperationDefinition): LinearOperation {
  const existing = projections.get(definition);
  if (existing) return existing;
  const compatibility = definition.compatibility;
  const variants = definition.graphql?.documents
    .filter(({ kind }) => kind === 'mutation')
    .map(({ kind: _kind, ...variant }) => variant);
  const operation: LinearOperation = {
    name: definition.name,
    aliases: compatibility.operationAliases,
    domain: definition.domain,
    purpose: definition.purpose,
    parameters: compatibility.fields,
    ...(compatibility.acceptedFields ? { acceptedParameters: compatibility.acceptedFields } : {}),
    ...(compatibility.legacyBranches ? { legacyParameters: compatibility.legacyBranches } : {}),
    ...(compatibility.aliasFields ? { aliasParameters: compatibility.aliasFields } : {}),
    example: compatibility.example,
    document: compatibility.document,
    ...(variants?.length ? { variants } : {}),
    ...(compatibility.pagination ? { pagination: compatibility.pagination } : {}),
    ...(compatibility.resolverPaths ? { resolverPaths: compatibility.resolverPaths } : {}),
    ...(compatibility.requiresVariables ? { requiresVariables: true } : {}),
    ...(compatibility.validateVariables ? { validateVariables: compatibility.validateVariables } : {}),
    ...(compatibility.prepare ? { prepare: compatibility.prepare } : {}),
    ...(compatibility.executeLocal ? { executeLocal: compatibility.executeLocal } : {}),
  };
  projections.set(definition, operation);
  return operation;
}
