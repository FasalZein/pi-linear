import { operationDefinitions, type LinearOperation } from './operations';
import { TYPED_EXCLUSIONS, type CanonicalOperation, type CanonicalVariant } from './canonical-schema';

export { TYPED_EXCLUSIONS, type CanonicalOperation, type CanonicalVariant };

function projectedVariantPair(
  variants: readonly { fields: readonly string[]; branches: readonly { all: readonly string[] }[] }[],
): [CanonicalVariant, CanonicalVariant] {
  const projected = variants.map((variant) => ({
    fields: variant.fields,
    branches: variant.branches.map(({ all }) => all),
  }));
  const first = projected[0];
  const second = projected[1];
  if (projected.length !== 2 || first === undefined || second === undefined) {
    throw new Error('Canonical variants must be a pair.');
  }
  return [first, second];
}

function projectedCanonical(name: string): CanonicalOperation {
  const definition = operationDefinitions.find((entry) => entry.name === name);
  if (!definition) throw new Error(`No canonical typed contract for operation "${name}".`);
  const canonical = definition.canonical;
  const projected: CanonicalOperation = {
    fields: Object.fromEntries(canonical.fields.map(({ name: field, type }) => [field, type])),
    branches: canonical.branches.map(({ all }) => all),
  };
  if (canonical.exclusiveBranches) projected.exclusiveBranches = true;
  if (canonical.variants) projected.variants = projectedVariantPair(canonical.variants);
  return projected;
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
