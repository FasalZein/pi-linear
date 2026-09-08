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
  OperationReferenceField,
  OperationSource,
  ParsedOperationPlanFactory,
  RequirementBranch,
} from './operation-types';
import { isCompatibilityObject } from './operation-types';
import { requireJsonObject, type JsonValue } from './json';
import { flattenAdvancedArguments } from './advanced-arguments';
import { MUTATION_VIEW_PARAMETER, withMutationResultView } from './mutation-acknowledgement';
import {
  canonicalReferenceExample,
  canonicalReferenceFields,
  referenceContract,
  normalizeReferenceArguments,
  operationReferenceRenames,
  resolveCanonicalReferences,
} from './operations/reference-language';

/** The seam where transport-supplied variables become parsed and advanced fields become flat. */
function operationVariables(
  name: string,
  canonical: LinearOperation['canonical'],
  variables: JsonValue | undefined,
): CompatibilityObject {
  const parsed = requireJsonObject(variables, `Linear operation "${name}" variables`);
  return flattenAdvancedArguments(name, canonical, parsed);
}

function actionAndEntity(name: string) {
  const [action, ...parts] = name.split('_');
  return { action: action ?? name, entity: parts.join('_') || name };
}

const DIRECT_REFERENCE_CONCEPTS = new Set(['Issue', 'Team', 'State', 'User']);

function resolverLabel(type: OperationReferenceField['type']): string {
  const concept = type.replace(/^Nullable/, '').replace(/Reference$/, '');
  if (DIRECT_REFERENCE_CONCEPTS.has(concept)) return `resolve${concept}Reference`;
  if (concept === 'DocumentId') return 'resolveDocumentReference';
  return 'resolveNamedEntityReference';
}

function resolverPaths(fields: readonly OperationReferenceField[]) {
  const names = new Set<string>();
  return Object.fromEntries(fields.map((field) => {
    if (names.has(field.name)) throw new Error(`Duplicate reference field ${field.name}.`);
    names.add(field.name);
    return [field.name, resolverLabel(field.type)];
  }));
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

function canonicalOnlyVariables(
  definition: OperationDefinition,
  variables: CompatibilityObject,
): boolean {
  const compatibilityFields = new Set(
    (definition.compatibility.acceptedFields ?? definition.compatibility.fields).map(({ name }) => name),
  );
  return Object.keys(variables).some((name) => !compatibilityFields.has(name));
}

function canonicalBranchesSatisfied(
  definition: OperationDefinition,
  variables: CompatibilityObject,
): boolean {
  const matches = definition.canonical.branches.filter((branch) => requirementBranchMatches(branch, variables));
  return definition.canonical.exclusiveBranches ? matches.length === 1 : matches.length > 0;
}

function assertExclusiveCanonicalBranch(
  definition: OperationDefinition,
  variables: CompatibilityObject,
): never {
  const messages = definition.compatibility.branches[0]?.exactlyOneOfMessages ?? [];
  const width = Math.max(...definition.canonical.branches.map(({ all }) => all.length));
  for (let index = 0; index < width; index += 1) {
    const fields = [...new Set(definition.canonical.branches.map(({ all }) => all[index]).filter(Boolean))];
    if (fields.filter((field) => pathPresent(variables, field!)).length !== 1 && messages[index]) {
      throw new Error(messages[index]!);
    }
  }
  throw new Error('parameters do not match exactly one accepted requirement branch');
}

function assertProjectedBranches(
  definition: OperationDefinition,
  variables: CompatibilityObject,
): void {
  if (canonicalOnlyVariables(definition, variables)) {
    if (canonicalBranchesSatisfied(definition, variables)) return;
    if (definition.canonical.exclusiveBranches) assertExclusiveCanonicalBranch(definition, variables);
  }
  assertRequirementBranches(definition.compatibility.branches, variables);
}

function assignOptional<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

function withViewParameter<T extends { name: string }>(values: readonly T[]): readonly (T | typeof MUTATION_VIEW_PARAMETER)[] {
  return values.some(({ name }) => name === MUTATION_VIEW_PARAMETER.name)
    ? values
    : [...values, MUTATION_VIEW_PARAMETER];
}

function withMutationViewLegacyBranches(
  values: NonNullable<OperationSource['legacyParameters']>,
): NonNullable<OperationSource['legacyParameters']> {
  return values.map((parameters) =>
    parameters.length === 1 && parameters[0]?.name === 'input'
      ? parameters
      : withViewParameter(parameters));
}

function withMutationViewAliasFields(
  values: OperationSource['aliasParameters'],
): OperationSource['aliasParameters'] {
  if (!values) return undefined;
  return Object.fromEntries(
    Object.entries(values).map(([name, parameters]) => [name, withViewParameter(parameters)]),
  );
}

function parseThenPlan(
  name: string,
  canonical: LinearOperation['canonical'],
  plan: ParsedOperationPlanFactory,
): OperationPlanFactory {
  return async (variables) => {
    const parsed = operationVariables(name, canonical, variables);
    const planned = await plan(normalizeReferenceArguments(name, parsed));
    return resolveCanonicalReferences(name, parsed, planned);
  };
}

function assertLocalOperationContract(operation: OperationSource, local: boolean): void {
  if (local && !operation.localResult?.requiredStringPaths.length) {
    throw new Error(`Local operation ${operation.name} is missing its result expectation.`);
  }
  if (!local && operation.localResult) {
    throw new Error(`Operation ${operation.name} declares a local result expectation without executeLocal.`);
  }
}

function operationDocuments(
  operation: OperationSource,
  local: boolean,
): OperationDocumentDefinition[] | undefined {
  if (local) return undefined;
  const variants = operation.variants ?? [{ document: operation.document, root: '' }];
  return variants.map((variant) =>
    documentDefinition(variant.document, operation.variants ? variant : undefined));
}

function operationKind(
  local: boolean,
  documents: readonly OperationDocumentDefinition[] | undefined,
): OperationDefinition['kind'] {
  if (local) return 'local';
  if (documents?.some((variant) => variant.kind === 'mutation')) return 'mutation';
  return 'query';
}

function plannedOperation(
  operation: OperationSource,
  kind: OperationDefinition['kind'],
): ParsedOperationPlanFactory | undefined {
  if (kind === 'query' && !operation.plan) {
    throw new Error(`Query operation ${operation.name} is missing its pure operation plan.`);
  }
  if (kind === 'mutation' && operation.plan) return withMutationResultView(operation.plan);
  return operation.plan;
}

function assertRenderContract(operation: OperationSource, action: string): void {
  if ((action === 'list' || action === 'search') && !operation.renderEmpty) {
    throw new Error(`Missing render empty state for "${operation.name}".`);
  }
}

function canonicalFieldDefinitions(
  canonical: LinearOperation['canonical'],
  mutation: boolean,
) {
  const fields = Object.entries(canonical.fields).map(([name, type]) => ({
    name,
    type,
    required: canonical.branches.length > 0
      && canonical.branches.every((branch) => branch.includes(name)),
  }));
  if (mutation && !fields.some(({ name }) => name === MUTATION_VIEW_PARAMETER.name)) {
    fields.push(MUTATION_VIEW_PARAMETER);
  }
  return fields;
}

function advancedFieldDefinitions(canonical: LinearOperation['canonical']) {
  return Object.entries(canonical.advanced ?? {}).map(([name, type]) => ({
    name,
    type,
    required: false,
  }));
}

function fieldsForMutation<T extends { name: string }>(values: readonly T[], mutation: boolean) {
  return mutation ? withViewParameter(values) : values;
}

function optionalFieldsForMutation<T extends { name: string }>(
  values: readonly T[] | undefined,
  mutation: boolean,
) {
  if (!values) return undefined;
  return fieldsForMutation(values, mutation);
}

function legacyFieldsForMutation(
  values: OperationSource['legacyParameters'],
  mutation: boolean,
): OperationSource['legacyParameters'] {
  if (!values) return undefined;
  return mutation ? withMutationViewLegacyBranches(values) : values;
}

function aliasFieldsForMutation(
  values: OperationSource['aliasParameters'],
  mutation: boolean,
): OperationSource['aliasParameters'] {
  if (!mutation) return values;
  return withMutationViewAliasFields(values);
}

function assignSemanticValidation(
  compatibility: OperationCompatibilityDefinition,
  operation: OperationSource,
): void {
  if (!operation.validateVariables) return;
  if (!operation.semanticException) {
    throw new Error(`Unnamed semantic validation exception for "${operation.name}".`);
  }
  compatibility.semanticException = operation.semanticException;
  compatibility.semanticValidateVariables = operation.validateVariables;
}

function compatibilityDefinition(
  operation: OperationSource,
  branches: readonly RequirementBranch[],
  mutation: boolean,
  referenceFields: readonly OperationReferenceField[],
  generatedResolverPaths: Readonly<Record<string, string>>,
  plan: ParsedOperationPlanFactory | undefined,
): OperationCompatibilityDefinition {
  const compatibility: OperationCompatibilityDefinition = {
    operationAliases: operation.aliases,
    fields: fieldsForMutation(operation.parameters, mutation),
    branches,
    example: operation.example,
    document: operation.document,
  };
  assignOptional(compatibility, 'acceptedFields', optionalFieldsForMutation(operation.acceptedParameters, mutation));
  assignOptional(compatibility, 'legacyBranches', legacyFieldsForMutation(operation.legacyParameters, mutation));
  assignOptional(compatibility, 'aliasFields', aliasFieldsForMutation(operation.aliasParameters, mutation));
  assignOptional(compatibility, 'inventoryDocuments', operation.inventoryDocuments);
  assignOptional(compatibility, 'pagination', operation.pagination);
  if (referenceFields.length) compatibility.resolverPaths = generatedResolverPaths;
  if (!branches.some((branch) => requirementBranchMatches(branch, {}))) {
    compatibility.requiresVariables = true;
  }
  assignSemanticValidation(compatibility, operation);
  assignOptional(compatibility, 'plan', plan);
  assignOptional(compatibility, 'executeLocal', operation.executeLocal);
  assignOptional(compatibility, 'localResult', operation.localResult);
  return compatibility;
}

function canonicalVariantDefinitions(
  canonical: LinearOperation['canonical'],
  mutation: boolean,
) {
  return canonical.variants?.map((variant) => ({
    fields: mutation
      ? withViewParameter(variant.fields.map((name) => ({ name }))).map(({ name }) => name)
      : variant.fields,
    branches: variant.branches.map((all) => ({ all })),
  }));
}

function canonicalDefinition(
  operation: OperationSource,
  canonical: LinearOperation['canonical'],
  canonicalFields: ReturnType<typeof canonicalFieldDefinitions>,
  advancedFields: ReturnType<typeof advancedFieldDefinitions>,
  mutation: boolean,
): OperationDefinition['canonical'] {
  const projection: OperationDefinition['canonical'] = {
    fields: canonicalFields,
    advancedFields,
    branches: canonical.branches.map((all) => ({ all })),
    strictRawArguments: true,
    example: canonicalReferenceExample(
      operation.name,
      operation.canonicalExample ?? operation.example.variables,
    ),
  };
  if (canonical.exclusiveBranches) projection.exclusiveBranches = true;
  const variants = canonicalVariantDefinitions(canonical, mutation);
  if (variants) projection.variants = variants;
  return projection;
}

function baseOperationDefinition(
  operation: OperationSource,
  kind: OperationDefinition['kind'],
  entityKind: string,
  action: string,
  compatibility: OperationCompatibilityDefinition,
  canonical: OperationDefinition['canonical'],
  referenceFields: readonly OperationReferenceField[],
  generatedResolverPaths: Readonly<Record<string, string>>,
  documents: readonly OperationDocumentDefinition[] | undefined,
): OperationDefinition {
  return {
    name: operation.name,
    toolName: `linear_${operation.name}`,
    domain: operation.domain,
    purpose: operation.purpose,
    kind,
    compatibility,
    preparation: { referenceFields, resolverPaths: generatedResolverPaths },
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
      callFields: canonical.fields.map(({ name }) => name),
      action,
    },
    canonical,
  };
}

/** Project the runtime definition from one authored source operation. */
export function defineOperation(operation: OperationSource): OperationDefinition {
  const branches = operation.compatibilityBranches;
  if (!branches) throw new Error(`Missing compatibility branches for "${operation.name}".`);
  const { action } = actionAndEntity(operation.name);
  const local = Boolean(operation.executeLocal);
  assertLocalOperationContract(operation, local);
  const documents = operationDocuments(operation, local);
  const kind = operationKind(local, documents);
  const plan = plannedOperation(operation, kind);
  const entityKind = operation.renderKind ?? projectedRenderKind(operation.name);
  const mutation = kind === 'mutation';
  assertRenderContract(operation, action);
  const renames = operationReferenceRenames(operation.name);
  const renderTargetFields = operation.renderTargetFields?.map((field) => renames[field]?.name ?? field);
  const canonical = referenceContract(operation.name, operation.canonical);
  const canonicalFields = canonicalFieldDefinitions(canonical, mutation);
  const advancedFields = advancedFieldDefinitions(canonical);
  const referenceFields = canonicalReferenceFields(
    operation.name,
    operation.referenceFields,
    operation.canonical,
  );
  const generatedResolverPaths = resolverPaths(referenceFields);
  const compatibility = compatibilityDefinition(
    operation,
    branches,
    mutation,
    referenceFields,
    generatedResolverPaths,
    plan,
  );
  const canonicalProjection = canonicalDefinition(
    operation,
    canonical,
    canonicalFields,
    advancedFields,
    mutation,
  );
  const definition = baseOperationDefinition(
    operation,
    kind,
    entityKind,
    action,
    compatibility,
    canonicalProjection,
    referenceFields,
    generatedResolverPaths,
    documents,
  );
  if (documents) definition.graphql = { documents };
  if (plan) definition.preparation.plan = parseThenPlan(operation.name, canonical, plan);
  assignOptional(definition.result, 'local', operation.localResult);
  assignOptional(definition.render, 'targetFields', renderTargetFields);
  assignOptional(definition.render, 'empty', operation.renderEmpty);
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

function projectedCanonicalContract(definition: OperationDefinition): LinearOperation['canonical'] {
  const canonical: LinearOperation['canonical'] = {
    fields: Object.fromEntries(definition.canonical.fields.map(({ name, type }) => [name, type])),
    advanced: Object.fromEntries(definition.canonical.advancedFields.map(({ name, type }) => [name, type])),
    branches: definition.canonical.branches.map(({ all }) => all),
  };
  if (definition.canonical.exclusiveBranches) canonical.exclusiveBranches = true;
  const variants = projectedCanonicalVariants(definition);
  if (variants) canonical.variants = variants;
  return canonical;
}

function mutationVariantDocuments(definition: OperationDefinition) {
  return definition.graphql?.documents
    .filter(({ kind }) => kind === 'mutation')
    .map(({ kind: _kind, ...variant }) => variant);
}

/** Parse, normalize, and gate one call against the projected canonical contract. */
function acceptedCallVariables(
  definition: OperationDefinition,
  canonical: LinearOperation['canonical'],
  variables: JsonValue | undefined,
) {
  const parsed = operationVariables(definition.name, canonical, variables);
  const normalized = normalizeReferenceArguments(definition.name, parsed);
  definition.compatibility.semanticValidateVariables?.(normalized);
  assertProjectedBranches(definition, parsed);
  return { parsed, normalized };
}

function assignProjectedExecution(
  operation: LinearOperation,
  definition: OperationDefinition,
  canonical: LinearOperation['canonical'],
): void {
  const compatibility = definition.compatibility;
  if (compatibility.plan) {
    operation.plan = async (variables: JsonValue | undefined) => {
      const { parsed, normalized } = acceptedCallVariables(definition, canonical, variables);
      const plan = await compatibility.plan!(normalized);
      return resolveCanonicalReferences(definition.name, parsed, plan);
    };
  }
  assignOptional(operation, 'localResult', compatibility.localResult);
  if (compatibility.executeLocal) {
    operation.executeLocal = async (variables, ctx, mode) => {
      const { normalized } = acceptedCallVariables(definition, canonical, variables);
      return compatibility.executeLocal!(normalized, ctx, mode);
    };
  }
}

/** Project the stable v0.4 runtime contract. All public consumers use this adapter during S7. */
export function projectCompatibilityOperation(definition: OperationDefinition): LinearOperation {
  const existing = projections.get(definition);
  if (existing) return existing;
  const compatibility = definition.compatibility;
  const canonical = projectedCanonicalContract(definition);
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
      acceptedCallVariables(definition, canonical, variables);
    },
  };
  assignOptional(operation, 'acceptedParameters', compatibility.acceptedFields);
  assignOptional(operation, 'legacyParameters', compatibility.legacyBranches);
  assignOptional(operation, 'aliasParameters', compatibility.aliasFields);
  const variants = mutationVariantDocuments(definition);
  if (variants?.length) operation.variants = variants;
  assignOptional(operation, 'inventoryDocuments', compatibility.inventoryDocuments);
  assignOptional(operation, 'pagination', compatibility.pagination);
  assignOptional(operation, 'resolverPaths', compatibility.resolverPaths);
  if (compatibility.requiresVariables) operation.requiresVariables = true;
  assignProjectedExecution(operation, definition, canonical);
  projections.set(definition, operation);
  return operation;
}
