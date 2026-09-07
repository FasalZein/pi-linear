import { formatInvocation, parameterVariants, type LinearOperation } from './operations';
import type { CompatibilityObject } from './operation-types';

function validParameterSummary(
  operation: LinearOperation,
  display: 'canonical-fields' | 'parameter-card',
): string {
  if (display === 'canonical-fields') {
    return `canonical fields ${Object.keys(operation.canonical.fields).join(', ')}`;
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
  const variants = parameterVariants(operation, requestedName);
  const valid = new Set(variants.flatMap((variant) => variant.map(({ name }) => name)));
  const accepted = variants.some((variant) => {
    const variantKeys = new Set(variant.map(({ name }) => name));
    return variant.every(({ name, required }) => !required || name in variables)
      && Object.keys(variables).every((name) => variantKeys.has(name));
  });
  const validParameters = validParameterSummary(operation, display);
  if (accepted) {
    try {
      operation.validateVariables?.(variables);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Invalid parameters for "${operation.name}": ${message}. Valid parameters: ${validParameters}. Example: ${formatInvocation(operation.example)}.`,
      );
    }
  }

  const missing = operation.parameters
    .filter(({ name, required }) => required && !(name in variables))
    .map(({ name }) => name);
  const unknown = Object.keys(variables).filter((name) => !valid.has(name));
  const problems = [
    ...(operation.requiresVariables && !Object.keys(variables).length ? ['at least one parameter is required'] : []),
    ...(missing.length ? [`missing ${missing.join(', ')}`] : []),
    ...(unknown.length ? [`unknown ${unknown.join(', ')}`] : []),
  ].join('; ') || 'parameters do not match one accepted shape';
  throw new Error(
    `Invalid parameters for "${operation.name}": ${problems}. Valid parameters: ${validParameters}. Example: ${formatInvocation(operation.example)}.`,
  );
}
