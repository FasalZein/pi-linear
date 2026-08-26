import { Kind, parse } from 'graphql';
import type {
  CompatibilityObject,
  CompatibilityValue,
  GraphQLDocumentVariant,
  LinearOperation,
  OperationCompatibilityDefinition,
  OperationDefinition,
  OperationDocumentDefinition,
  OperationPlanFactory,
  OperationSource,
  ParsedOperationPlanFactory,
  RequirementBranch,
} from './operation-types';
import { isCompatibilityObject } from './operation-types';
import { requireJsonObject, type JsonValue } from './json';

/** The seam where transport-supplied variables become parsed compatibility JSON. */
function operationVariables(name: string, variables: JsonValue | undefined): CompatibilityObject {
  return requireJsonObject(variables, `Linear operation "${name}" variables`);
}

function actionAndEntity(name: string) {
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
  const rootName = declared?.root ?? root.name.value;
  if (declared?.when && declared.mutationResult) {
    return {
      when: declared.when,
      document,
      root: rootName,
      kind,
      mutationResult: declared.mutationResult,
    };
  }
  if (declared?.when) {
    return { when: declared.when, document, root: rootName, kind };
  }
  if (declared?.mutationResult) {
    return { document, root: rootName, kind, mutationResult: declared.mutationResult };
  }
  return { document, root: rootName, kind };
}

function pathPresent(value: CompatibilityObject, path: string): boolean {
  const parts = path.split('.');
  let current: CompatibilityValue = value;
  for (const part of parts) {
    if (!isCompatibilityObject(current) || !Object.prototype.hasOwnProperty.call(current, part)) {
      return false;
    }
    const next: CompatibilityValue | undefined = current[part];
    if (next === undefined) return false;
    current = next;
  }
  return true;
}

export function requirementBranchMatches(
  branch: RequirementBranch,
  variables: CompatibilityObject,
): boolean {
  if (!branch.all.every((path) => pathPresent(variables, path))) return false;
  if (branch.atLeastOneOf && !branch.atLeastOneOf.some((path) => pathPresent(variables, path))) return false;
  if (branch.exactlyOneOf?.some((group) =>
    group.filter((path) => pathPresent(variables, path)).length !== 1)) return false;
  return !branch.forbidden?.some((path) => pathPresent(variables, path));
}

export function assertRequirementBranches(
  branches: readonly RequirementBranch[],
  variables: CompatibilityObject,
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

function assertProjectedBranches(
  definition: OperationDefinition,
  variables: CompatibilityObject,
): void {
  const compatibilityFields = new Set(
    (definition.compatibility.acceptedFields ?? definition.compatibility.fields).map(({ name }) => name),
  );
  const hasCanonicalOnlyField = Object.keys(variables).some((name) => !compatibilityFields.has(name));
  if (hasCanonicalOnlyField
    && definition.canonical.branches.some((branch) => requirementBranchMatches(branch, variables))) return;
  assertRequirementBranches(definition.compatibility.branches, variables);
}

function assignOptional<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) target[key] = value;
}


function parseThenPlan(name: string, plan: ParsedOperationPlanFactory): OperationPlanFactory {
  return async (variables) => plan(operationVariables(name, variables));
}

/** Project the runtime definition from one authored source operation. */
export function defineOperation(operation: OperationSource): OperationDefinition {
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
  const compatibility: OperationCompatibilityDefinition = {
    operationAliases: operation.aliases,
    fields: operation.parameters,
    branches,
    example: operation.example,
    document: operation.document,
  };
  assignOptional(compatibility, 'acceptedFields', operation.acceptedParameters);
  assignOptional(compatibility, 'legacyBranches', operation.legacyParameters);
  assignOptional(compatibility, 'aliasFields', operation.aliasParameters);
  assignOptional(compatibility, 'inventoryDocuments', operation.inventoryDocuments);
  assignOptional(compatibility, 'pagination', operation.pagination);
  assignOptional(compatibility, 'resolverPaths', operation.resolverPaths);
  if (requiresVariables) compatibility.requiresVariables = true;
  if (operation.validateVariables) {
    compatibility.semanticException = operation.semanticException
      ?? (() => { throw new Error(`Unnamed semantic validation exception for "${operation.name}".`); })();
    compatibility.semanticValidateVariables = operation.validateVariables;
  }
  assignOptional(compatibility, 'plan', operation.plan);
  assignOptional(compatibility, 'executeLocal', operation.executeLocal);
  assignOptional(compatibility, 'localResult', operation.localResult);

  const canonicalBranches = canonical.branches.map((all) => ({ all }));
  const canonicalExample = operation.canonicalExample ?? operation.example.variables;
  const canonicalVariants = canonical.variants?.map((variant) => ({
    fields: variant.fields,
    branches: variant.branches.map((all) => ({ all })),
  }));
  const canonicalProjection: OperationDefinition['canonical'] = canonical.exclusiveBranches
    ? canonicalVariants
      ? {
          fields: canonicalFields,
          branches: canonicalBranches,
          exclusiveBranches: true,
          variants: canonicalVariants,
          strictRawArguments: true,
          example: canonicalExample,
        }
      : {
          fields: canonicalFields,
          branches: canonicalBranches,
          exclusiveBranches: true,
          strictRawArguments: true,
          example: canonicalExample,
        }
    : canonicalVariants
      ? {
          fields: canonicalFields,
          branches: canonicalBranches,
          variants: canonicalVariants,
          strictRawArguments: true,
          example: canonicalExample,
        }
      : {
          fields: canonicalFields,
          branches: canonicalBranches,
          strictRawArguments: true,
          example: canonicalExample,
        };

  const definition: OperationDefinition = {
    name: operation.name,
    toolName: `linear_${operation.name}`,
    domain: operation.domain,
    purpose: operation.purpose,
    kind,
    compatibility,
    preparation: {
      resolverPaths: operation.resolverPaths ?? {},
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
    },
    render: {
      entityKind,
      callFields: canonicalFields.map(({ name }) => name),
      action,
    },
    canonical: canonicalProjection,
  };
  if (documents) definition.graphql = { documents };
  if (operation.plan) definition.preparation.plan = parseThenPlan(operation.name, operation.plan);
  assignOptional(definition.result, 'local', operation.localResult);
  assignOptional(definition.render, 'targetFields', renderTargetFields);
  assignOptional(definition.render, 'empty', renderEmpty);
  return definition;
}

function canonicalVariants(definition: OperationDefinition) {
  const variants = definition.canonical.variants;
  if (!variants) return undefined;
  return variants.map((variant) => ({
    fields: variant.fields,
    branches: variant.branches.map(({ all }) => all),
  }));
}

function projectedCanonicalVariants(definition: OperationDefinition): LinearOperation['canonical']['variants'] {
  const variants = canonicalVariants(definition);
  if (!variants) return undefined;
  const first = variants[0];
  const second = variants[1];
  if (variants.length !== 2 || first === undefined || second === undefined) {
    throw new Error(`Canonical variants for "${definition.name}" must be a pair.`);
  }
  return [first, second];
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
  const canonical: LinearOperation['canonical'] = {
    fields: Object.fromEntries(definition.canonical.fields.map(({ name, type }) => [name, type])),
    branches: definition.canonical.branches.map(({ all }) => all),
  };
  if (definition.canonical.exclusiveBranches) canonical.exclusiveBranches = true;
  const projectedVariants = projectedCanonicalVariants(definition);
  if (projectedVariants) canonical.variants = projectedVariants;
  const operation: LinearOperation = {
    name: definition.name,
    resultCategory: definition.result.category,
    canonical,
    aliases: compatibility.operationAliases,
    domain: definition.domain,
    purpose: definition.purpose,
    parameters: compatibility.fields,
    example: compatibility.example,
    document: compatibility.document,
    validateVariables(variables: JsonValue | undefined) {
      const parsed = operationVariables(definition.name, variables);
      assertProjectedBranches(definition, parsed);
      compatibility.semanticValidateVariables?.(parsed);
    },
  };
  assignOptional(operation, 'acceptedParameters', compatibility.acceptedFields);
  assignOptional(operation, 'legacyParameters', compatibility.legacyBranches);
  assignOptional(operation, 'aliasParameters', compatibility.aliasFields);
  if (variants?.length) operation.variants = variants;
  assignOptional(operation, 'inventoryDocuments', compatibility.inventoryDocuments);
  assignOptional(operation, 'pagination', compatibility.pagination);
  assignOptional(operation, 'resolverPaths', compatibility.resolverPaths);
  if (compatibility.requiresVariables) operation.requiresVariables = true;
  if (compatibility.plan) {
    operation.plan = async (variables: JsonValue | undefined) => {
      const parsed = operationVariables(definition.name, variables);
      assertProjectedBranches(definition, parsed);
      compatibility.semanticValidateVariables?.(parsed);
      return compatibility.plan!(parsed);
    };
  }
  assignOptional(operation, 'localResult', compatibility.localResult);
  if (compatibility.executeLocal) {
    operation.executeLocal = async (variables, ctx, mode) => {
      const parsed = operationVariables(definition.name, variables);
      assertProjectedBranches(definition, parsed);
      compatibility.semanticValidateVariables?.(parsed);
      return compatibility.executeLocal!(parsed, ctx, mode);
    };
  }
  projections.set(definition, operation);
  return operation;
}
