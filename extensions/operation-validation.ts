import { formatInvocation, parameterVariants, type LinearOperation } from './operations';
import type { CompatibilityObject } from './operation-types';
import { canonicalOperation } from './canonical';
import { flattenAdvancedArguments } from './advanced-arguments';
import { normalizeReferenceArguments } from './operations/reference-language';

function validParameterSummary(
  operation: LinearOperation,
  display: 'canonical-fields' | 'parameter-card',
): string {
  if (display === 'canonical-fields') {
    const canonical = canonicalOperation(operation);
    return `canonical fields ${[...Object.keys(canonical.fields), ...(Object.keys(canonical.advanced ?? {}).length ? ['advanced'] : [])].join(', ')}`;
  }
  return operation.parameters.map(({ name, type, required }) =>
    `${name}: ${type}${required ? ' (required)' : ' (optional)'}`,
  ).join(', ');
}

/** Validate compatibility variables with the diagnostic format already owned by each caller. */
export function validateOperationVariables(
  operation: LinearOperation,
  requestedName: string,
  variables: CompatibilityObject,
  display: 'canonical-fields' | 'parameter-card',
): void {
  const flattened = flattenAdvancedArguments(operation.name, canonicalOperation(operation), variables);
  const effectiveVariables = normalizeReferenceArguments(operation.name, flattened);
  const variants = parameterVariants(operation, requestedName);
  const valid = new Set(variants.flatMap((variant) => variant.map(({ name }) => name)));
  const accepted = variants.some((variant) => {
    const variantKeys = new Set(variant.map(({ name }) => name));
    return variant.every(({ name, required }) => !required || name in effectiveVariables)
      && Object.keys(effectiveVariables).every((name) => variantKeys.has(name));
  });
  const validParameters = validParameterSummary(operation, display);
  if (accepted) {
    try {
      operation.validateVariables?.(effectiveVariables);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Invalid parameters for "${operation.name}": ${message}. Valid parameters: ${validParameters}. Example: ${formatInvocation(operation.example)}.`,
      );
    }
  }

  const missing = operation.parameters
    .filter(({ name, required }) => required && !(name in effectiveVariables))
    .map(({ name }) => name);
  const unknown = Object.keys(effectiveVariables).filter((name) => !valid.has(name));
  const problems = [
    ...(operation.requiresVariables && !Object.keys(effectiveVariables).length ? ['at least one parameter is required'] : []),
    ...(missing.length ? [`missing ${missing.join(', ')}`] : []),
    ...(unknown.length ? [`unknown ${unknown.join(', ')}`] : []),
  ].join('; ') || 'parameters do not match one accepted shape';
  throw new Error(
    `Invalid parameters for "${operation.name}": ${problems}. Valid parameters: ${validParameters}. Example: ${formatInvocation(operation.example)}.`,
  );
}
