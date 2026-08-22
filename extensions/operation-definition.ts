import { Kind, parse } from 'graphql';
import type {
  GraphQLDocumentVariant,
  LinearOperation,
  OperationDefinition,
  OperationDocumentDefinition,
  RequirementBranch,
} from './operation-types';

function actionAndEntity(name: string): { action: string; entity: string } {
  const [action, ...parts] = name.split('_');
  return { action: action ?? name, entity: parts.join('_') || name };
}

/** Projected from the operation name; a source definition may override it. */
function projectedRenderKind(name: string): string {
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

function pathPresent(value: Record<string, unknown>, path: string): boolean {
  const parts = path.split('.');
  let current: unknown = value;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || Array.isArray(current)
      || !Object.prototype.hasOwnProperty.call(current, part)) return false;
    current = (current as Record<string, unknown>)[part];
  }
  return current !== undefined;
}

export function requirementBranchMatches(
  branch: RequirementBranch,
  variables: Record<string, unknown>,
): boolean {
  if (!branch.all.every((path) => pathPresent(variables, path))) return false;
  if (branch.atLeastOneOf && !branch.atLeastOneOf.some((path) => pathPresent(variables, path))) return false;
  if (branch.exactlyOneOf?.some((group) =>
    group.filter((path) => pathPresent(variables, path)).length !== 1)) return false;
  return !branch.forbidden?.some((path) => pathPresent(variables, path));
}

export function assertRequirementBranches(
  branches: readonly RequirementBranch[],
  variables: Record<string, unknown>,
): void {
  if (branches.some((branch) => requirementBranchMatches(branch, variables))) return;
  const mode = branches.find(({ mode: branchMode, all }) =>
    branchMode === 'update' && all.every((path) => pathPresent(variables, path)))?.mode ?? 'create';
  const candidates = branches.filter((branch) => !branch.mode || branch.mode === mode);
  const forbidden = candidates.flatMap((branch) => branch.forbidden ?? [])
    .filter((path, index, values) => pathPresent(variables, path) && values.indexOf(path) === index)
    .map((path) => path.replace(/^input\./, ''));
  if (forbidden.length) throw new Error(`Params not valid in ${mode} mode: ${forbidden.join(', ')}.`);
  for (const branch of candidates) {
    const failedGroup = branch.exactlyOneOf?.findIndex((group) =>
      group.filter((path) => pathPresent(variables, path)).length !== 1) ?? -1;
    if (failedGroup >= 0 && branch.exactlyOneOfMessages?.[failedGroup]) {
      throw new Error(branch.exactlyOneOfMessages[failedGroup]!);
    }
    if (branch.atLeastOneOf && !branch.atLeastOneOf.some((path) => pathPresent(variables, path))
      && branch.atLeastOneOfMessage) throw new Error(branch.atLeastOneOfMessage);
  }
  const first = candidates[0] ?? branches[0];
  const missing = first?.all.filter((path) => !pathPresent(variables, path)) ?? [];
  if (missing.length) throw new Error(`missing ${missing.join(', ')}`);
  throw new Error('parameters do not match one accepted requirement branch');
}

/** Project the runtime definition from one authored source operation. */
export function defineOperation(operation: LinearOperation): OperationDefinition {
  const branches = operation.compatibilityBranches;
  if (!branches) throw new Error(`Missing compatibility branches for "${operation.name}".`);
  const { action } = actionAndEntity(operation.name);
  const local = Boolean(operation.executeLocal);
  if (local && !operation.localResult?.requiredStringPaths.length) {
    throw new Error(`Local operation ${operation.name} is missing its result expectation.`);
  }
  if (!local && operation.localResult) {
    throw new Error(`Operation ${operation.name} declares a local result expectation without executeLocal.`);
  }
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
  if (kind === 'query' && !operation.plan) {
    throw new Error(`Query operation ${operation.name} is missing its pure operation plan.`);
  }
  const entityKind = operation.renderKind ?? projectedRenderKind(operation.name);
  const renderEmpty = operation.renderEmpty;
  if ((action === 'list' || action === 'search') && !renderEmpty) {
    throw new Error(`Missing render empty state for "${operation.name}".`);
  }
  const renderTargetFields = operation.renderTargetFields;
  const requiresVariables = !branches.some((branch) => requirementBranchMatches(branch, {}));
  const canonical = operation.canonical;
  const canonicalFields = Object.entries(canonical.fields).map(([name, type]) => ({
    name,
    type,
    required: canonical.branches.length > 0
      && canonical.branches.every((branch) => branch.includes(name)),
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
      branches,
      ...(operation.acceptedParameters ? { acceptedFields: operation.acceptedParameters } : {}),
      ...(operation.legacyParameters ? { legacyBranches: operation.legacyParameters } : {}),
      ...(operation.aliasParameters ? { aliasFields: operation.aliasParameters } : {}),
      example: operation.example,
      document: operation.document,
      ...(operation.pagination ? { pagination: operation.pagination } : {}),
      ...(operation.resolverPaths ? { resolverPaths: operation.resolverPaths } : {}),
      ...(requiresVariables ? { requiresVariables: true } : {}),
      ...(operation.validateVariables ? {
        semanticException: operation.semanticException
          ?? (() => { throw new Error(`Unnamed semantic validation exception for "${operation.name}".`); })(),
        semanticValidateVariables: operation.validateVariables,
      } : {}),
      ...(operation.plan ? { plan: operation.plan } : {}),
      ...(operation.executeLocal ? { executeLocal: operation.executeLocal } : {}),
      ...(operation.localResult ? { localResult: operation.localResult } : {}),
    },
    ...(documents ? { graphql: { documents } } : {}),
    preparation: {
      resolverPaths: operation.resolverPaths ?? {},
      ...(operation.plan ? { plan: operation.plan } : {}),
    },
    safety: {
      namedInputPolicy: operation.namedInputPolicy ?? 'non-destructive',
      mutation: kind === 'mutation',
    },
    result: {
      category: operation.resultCategory,
      renderKind: entityKind,
      dataPaths: documents?.map(({ root }) => root)
        ?? [...(operation.localResult?.requiredStringPaths ?? [])],
      ...(operation.localResult ? { local: operation.localResult } : {}),
    },
    render: {
      entityKind,
      callFields: canonicalFields.map(({ name }) => name),
      action,
      ...(renderTargetFields ? { targetFields: renderTargetFields } : {}),
      ...(renderEmpty ? { empty: renderEmpty } : {}),
    },
    canonical: {
      fields: canonicalFields,
      branches: canonical.branches.map((all) => ({ all })),
      ...(canonical.exclusiveBranches ? { exclusiveBranches: true } : {}),
      ...(canonical.variants ? {
        variants: canonical.variants.map((variant) => ({
          fields: variant.fields,
          branches: variant.branches.map((all) => ({ all })),
        })),
      } : {}),
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
    resultCategory: definition.result.category,
    canonical: {
      fields: Object.fromEntries(definition.canonical.fields.map(({ name, type }) => [name, type])),
      branches: definition.canonical.branches.map(({ all }) => all),
      ...(definition.canonical.exclusiveBranches ? { exclusiveBranches: true } : {}),
      ...(definition.canonical.variants ? {
        variants: definition.canonical.variants.map((variant) => ({
          fields: variant.fields,
          branches: variant.branches.map(({ all }) => all),
        })) as unknown as NonNullable<LinearOperation['canonical']['variants']>,
      } : {}),
    },
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
    validateVariables(variables) {
      assertRequirementBranches(compatibility.branches, variables);
      compatibility.semanticValidateVariables?.(variables);
    },
    ...(compatibility.plan ? {
      plan: async (variables) => {
        assertRequirementBranches(compatibility.branches, variables);
        compatibility.semanticValidateVariables?.(variables);
        return compatibility.plan!(variables);
      },
    } : {}),
    ...(compatibility.localResult ? { localResult: compatibility.localResult } : {}),
    ...(compatibility.executeLocal ? {
      executeLocal: async (variables, ctx) => {
        assertRequirementBranches(compatibility.branches, variables);
        compatibility.semanticValidateVariables?.(variables);
        return compatibility.executeLocal!(variables, ctx);
      },
    } : {}),
  };
  projections.set(definition, operation);
  return operation;
}
