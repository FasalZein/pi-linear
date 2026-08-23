/**
 * One authority per operation.
 *
 * Every per-operation decision — compatibility branches, named semantic exceptions,
 * render kind, target fields, empty states, local result
 * expectations — is authored beside the operation in `extensions/operations/`.
 * Runtime compatibility, generated contracts, help, and tests project from there.
 *
 * A second authority is always a hand-maintained catalog: a module that enumerates operations by name.
 * These checks fail when any authored module outside the source directory enumerates two or more
 * operation names. The generated discovery projection is checked separately for deterministic parity.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import contracts from '../extensions/generated/operation-contracts.json';
import { getOperationDefinition, operationDefinitions, operations } from '../extensions/operations';

const SOURCE_DIR = join('extensions', 'operations');
const GENERATED_DISCOVERY = join('extensions', 'generated', 'operation-catalog.ts');
const names = operationDefinitions.map(({ name }) => name);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

function isOperationSource(path: string): boolean {
  return path === SOURCE_DIR || path.startsWith(`${SOURCE_DIR}/`);
}

describe('no second operation-keyed authority', () => {
  it('removed the authored compatibility catalog module', () => {
    expect(existsSync(join('extensions', 'definition-compatibility.ts'))).toBe(false);
  });

  it('keeps every operation-name enumeration inside the source directory', () => {
    const offenders = sourceFiles('extensions')
      .filter((path) => !isOperationSource(path) && path !== GENERATED_DISCOVERY)
      .map((path) => {
        const text = readFileSync(path, 'utf8');
        return { path, hits: names.filter((name) => new RegExp(`\\b${name}\\b`).test(text)) };
      })
      .filter(({ hits }) => hits.length > 1);
    expect(offenders).toEqual([]);
  });

  it('authors every per-operation override in the source directory', () => {
    const source = sourceFiles(SOURCE_DIR)
      .filter((path) => !path.endsWith(`${join('operations', 'index.ts')}`) && !path.endsWith(`${join('operations', 'shared.ts')}`))
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');
    for (const keyword of [
      'compatibilityBranches:',
      'semanticException:',
      'renderKind:',
      'renderTargetFields:',
      'renderEmpty:',
      'localResult:',
    ]) {
      expect(source, keyword).toContain(keyword);
    }
    const authored = source.match(/^\t{1,2}compatibilityBranches: \[/gm) ?? [];
    expect(authored).toHaveLength(names.length);
  });
});

describe('definitions project from the source', () => {
  it('gives all 49 operations authored compatibility branches', () => {
    expect(names).toHaveLength(49);
    for (const definition of operationDefinitions) {
      expect(definition.compatibility.branches.length, definition.name).toBeGreaterThan(0);
    }
  });

  it('names a semantic exception wherever semantic validation exists', () => {
    for (const definition of operationDefinitions) {
      const compatibility = definition.compatibility;
      if (!compatibility.semanticValidateVariables) continue;
      expect(compatibility.semanticException, definition.name).toBeTruthy();
    }
  });

  it('keeps runtime operations, definitions, and generated contracts identical', () => {
    const generated = new Map((contracts as any[]).map((entry) => [entry.name, entry]));
    for (const name of names) {
      const definition = getOperationDefinition(name);
      expect(operations[name], name).toBeDefined();
      expect(JSON.parse(JSON.stringify(generated.get(name)!.compatibility.branches)), name)
        .toEqual(JSON.parse(JSON.stringify(definition.compatibility.branches)));
      expect(generated.get(name)!.render.entityKind, name).toBe(definition.render.entityKind);
    }
  });
});
