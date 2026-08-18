import { operationDefinitions, type LinearOperation } from './operations';
import { TYPED_EXCLUSIONS, type CanonicalOperation, type CanonicalVariant } from './definition-canonical';

export { TYPED_EXCLUSIONS, type CanonicalOperation, type CanonicalVariant };

function projectedCanonical(name: string): CanonicalOperation {
  const definition = operationDefinitions.find((entry) => entry.name === name);
  if (!definition) throw new Error(`No canonical typed contract for operation "${name}".`);
  const canonical = definition.canonical;
  return {
    fields: Object.fromEntries(canonical.fields.map(({ name: field, type }) => [field, type])),
    branches: canonical.branches.map(({ all }) => all),
    ...(canonical.exclusiveBranches ? { exclusiveBranches: true } : {}),
    ...(canonical.variants ? {
      variants: canonical.variants.map((variant) => ({
        fields: variant.fields,
        branches: variant.branches.map(({ all }) => all),
      })) as unknown as [CanonicalVariant, CanonicalVariant],
    } : {}),
  };
}

/** Generated compatibility projection. OperationDefinition.canonical is the authority. */
export const CANONICAL_OPERATIONS: Record<string, CanonicalOperation> = Object.fromEntries(
  operationDefinitions.map(({ name }) => [name, projectedCanonical(name)]),
);

export function canonicalOperation(operation: LinearOperation): CanonicalOperation {
  return projectedCanonical(operation.name);
}

export function canonicalFieldNames(operation: LinearOperation): string[] {
  return operationDefinitions.find(({ name }) => name === operation.name)?.canonical.fields.map(({ name }) => name) ?? [];
}

export function missingCanonicalOperations(): string[] {
  return operationDefinitions.length === Object.keys(CANONICAL_OPERATIONS).length ? [] : ['definition-count-mismatch'];
}
