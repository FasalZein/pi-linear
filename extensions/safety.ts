import { Kind, parse, type DocumentNode, type SelectionSetNode } from 'graphql';
import { SAFE_NAMED_MUTATION_ROOTS } from './operations';
import { redactText } from './redact';

export { SAFE_NAMED_MUTATION_ROOTS } from './operations';
export type MutationMode = 'allowlist' | 'readonly';

export function assertNamedInputAllowed(value: unknown, path = 'variables'): void {
  const seen = new WeakSet<object>();
  const visit = (current: unknown, currentPath: string): void => {
    if (!current || typeof current !== 'object' || seen.has(current)) return;
    seen.add(current);

    for (const key of Object.keys(current)) {
      const childPath = Array.isArray(current)
        ? `${currentPath}[${redactText(key)}]`
        : `${currentPath}.${redactText(key)}`;
      if (key === 'trashed') {
        throw new Error(
          `Destructive named input is unavailable at ${childPath}. Use an authorized raw GraphQL mutation with LINEAR_MUTATIONS=all.`,
        );
      }
      visit((current as Record<string, unknown>)[key], childPath);
    }
  };

  visit(value, path);
}

function mutationFields(document: DocumentNode): string[] {
  const fragments = new Map(
    document.definitions
      .filter((definition) => definition.kind === Kind.FRAGMENT_DEFINITION)
      .map((fragment) => [fragment.name.value, fragment.selectionSet]),
  );
  const fields = new Set<string>();
  const visit = (selectionSet: SelectionSetNode) => {
    for (const selection of selectionSet.selections) {
      if (selection.kind === Kind.FIELD) fields.add(selection.name.value);
      else if (selection.kind === Kind.INLINE_FRAGMENT) visit(selection.selectionSet);
      else {
        const fragment = fragments.get(selection.name.value);
        if (fragment) visit(fragment);
      }
    }
  };
  for (const definition of document.definitions) {
    if (definition.kind === Kind.OPERATION_DEFINITION && definition.operation === 'mutation') {
      visit(definition.selectionSet);
    }
  }
  return [...fields];
}

export function assertMutationAllowed(
  query: string,
  mode: MutationMode,
  namedMutationRoots?: readonly string[],
): void {
  const fields = mutationFields(parse(query));
  if (!fields.length) return;

  const effectiveMode = process.env.LINEAR_READONLY === '1' ? 'readonly' : mode;
  if (effectiveMode === 'readonly') throw new Error('Linear mutations are disabled by read-only mode.');

  if (namedMutationRoots === undefined) {
    if (process.env.LINEAR_MUTATIONS === 'all') return;
    throw new Error('Raw Linear mutations are disabled. Set LINEAR_MUTATIONS=all to allow raw mutations.');
  }

  const undeclared = fields.filter((field) => !namedMutationRoots.includes(field));
  if (undeclared.length) {
    throw new Error(`Named Linear operation contains undeclared mutation roots: ${undeclared.join(', ')}.`);
  }

  const unsafe = fields.filter((field) => !SAFE_NAMED_MUTATION_ROOTS.has(field));
  if (unsafe.length) {
    throw new Error(`Linear mutation rejected: ${unsafe.join(', ')} is not in the safe named-root set.`);
  }
}

export function getMutationFields(query: string): string[] {
  return mutationFields(parse(query));
}
