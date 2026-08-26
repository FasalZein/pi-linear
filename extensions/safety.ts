import { Kind, parse, type DocumentNode, type SelectionSetNode } from 'graphql';
import { parseJson, type JsonValue } from './json';
import { isCompatibilityObject } from './operation-types';
import { SAFE_NAMED_MUTATION_ROOTS } from './operations';
import { redactText } from './redact';

export { SAFE_NAMED_MUTATION_ROOTS } from './operations';
export type MutationMode = 'allowlist' | 'readonly';

export function assertNamedInputAllowed(value: JsonValue | undefined, path = 'variables'): void {
  const reject = (childPath: string): never => {
    throw new Error(
      `Destructive named input is unavailable at ${childPath}. Use an authorized raw GraphQL mutation with LINEAR_MUTATIONS=all.`,
    );
  };
  const visit = (current: JsonValue | undefined, currentPath: string): void => {
    if (Array.isArray(current)) {
      current.forEach((child, index) => visit(child, `${currentPath}[${redactText(String(index))}]`));
      return;
    }
    if (!isCompatibilityObject(current)) return;

    for (const [key, child] of Object.entries(current)) {
      const childPath = `${currentPath}.${redactText(key)}`;
      if (key === 'trashed') reject(childPath);
      visit(child, childPath);
    }
  };

  // Parse once at the tool seam: only own enumerable JSON reaches the policy walk.
  visit(parseJson(value), path);
}

type MutationAnalysis = { hasMutation: boolean; fields: string[] };

function analyzeMutations(document: DocumentNode): MutationAnalysis {
  const fragments = new Map(
    document.definitions
      .filter((definition) => definition.kind === Kind.FRAGMENT_DEFINITION)
      .map((fragment) => [fragment.name.value, fragment.selectionSet]),
  );
  const visitedFragments = new Set<string>();
  const fields = new Set<string>();
  const visit = (selectionSet: SelectionSetNode) => {
    for (const selection of selectionSet.selections) {
      if (selection.kind === Kind.FIELD) fields.add(selection.name.value);
      else if (selection.kind === Kind.INLINE_FRAGMENT) visit(selection.selectionSet);
      else if (!visitedFragments.has(selection.name.value)) {
        visitedFragments.add(selection.name.value);
        const fragment = fragments.get(selection.name.value);
        if (fragment) visit(fragment);
      }
    }
  };
  let hasMutation = false;
  for (const definition of document.definitions) {
    if (definition.kind === Kind.OPERATION_DEFINITION && definition.operation === 'mutation') {
      hasMutation = true;
      visit(definition.selectionSet);
    }
  }
  return { hasMutation, fields: [...fields] };
}

export function assertMutationAllowed(
  query: string,
  mode: MutationMode,
  namedMutationRoots?: readonly string[],
): void {
  const { hasMutation, fields } = analyzeMutations(parse(query));
  if (!hasMutation) return;

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
  return analyzeMutations(parse(query)).fields;
}
