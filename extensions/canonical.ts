import { operationDefinitions, operations, type LinearOperation } from './operations';
import {
  DEFINITION_CANONICAL_OPERATIONS,
  TYPED_EXCLUSIONS,
  type CanonicalOperation,
  type CanonicalVariant,
} from './definition-canonical';

export { TYPED_EXCLUSIONS, type CanonicalOperation, type CanonicalVariant };

/** Temporary S7 adapter shadow. S8 removes this copy and projects schemas directly. */
export const CANONICAL_OPERATIONS: Record<string, CanonicalOperation> =
  structuredClone(DEFINITION_CANONICAL_OPERATIONS) as Record<string, CanonicalOperation>;

export function canonicalOperation(operation: LinearOperation): CanonicalOperation {
  const contract = CANONICAL_OPERATIONS[operation.name];
  if (!contract) throw new Error(`No canonical typed contract for operation "${operation.name}".`);
  return contract;
}

/** Public parameter names, in declaration order. */
export function canonicalFieldNames(operation: LinearOperation): string[] {
  return Object.keys(canonicalOperation(operation).fields);
}

/** Every catalog operation must have exactly one canonical contract. */
export function missingCanonicalOperations(): string[] {
  const declared = new Set(Object.keys(CANONICAL_OPERATIONS));
  const catalog = Object.keys(operations);
  return [
    ...catalog.filter((name) => !declared.has(name)),
    ...[...declared].filter((name) => !catalog.includes(name)),
  ];
}

function stable(value: unknown): string {
  return JSON.stringify(value);
}

/** S7 shadow assertion. Canonical data remains an adapter consumer until S8. */
export function assertCanonicalAdapterParity(): void {
  const missing = missingCanonicalOperations();
  if (missing.length) {
    throw new Error(`Canonical adapter does not match operation definitions: ${missing.join(', ')}.`);
  }
  for (const definition of operationDefinitions) {
    const shadow = canonicalOperation(operations[definition.name]!);
    const authoritative = definition.canonical;
    const comparable = {
      fields: Object.fromEntries(authoritative.fields.map(({ name, type }) => [name, type])),
      branches: authoritative.branches.map(({ all }) => all),
      ...(authoritative.exclusiveBranches ? { exclusiveBranches: true as const } : {}),
      ...(authoritative.variants ? {
        variants: authoritative.variants.map((variant) => ({
          fields: variant.fields,
          branches: variant.branches.map(({ all }) => all),
        })),
      } : {}),
    };
    if (stable(shadow) !== stable(comparable)) {
      throw new Error(`Canonical adapter drift for operation "${definition.name}".`);
    }
  }
}
