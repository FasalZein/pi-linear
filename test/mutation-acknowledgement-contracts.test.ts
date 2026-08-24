import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getOperation, operationDefinitions } from '../extensions/operations';
import { operationRenderers } from '../extensions/renderers';

const MATRIX = JSON.parse(readFileSync(
  new URL('./fixtures/v06-mutation-acknowledgement-matrix.json', import.meta.url),
  'utf8',
)) as Record<string, Array<{ required: string[]; target: string }>>;

const theme = {
  fg: (_role: string, text: string) => text,
  bg: (_role: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
} as any;

const definitions = operationDefinitions.filter((definition) => definition.safety.mutation);

function render(operationName: string, root: string, args: Record<string, unknown>): string {
  const acknowledgement = operationName === 'delete_issue_relation' ? { deleted: true } : { success: true };
  const details = {
    data: { [root]: acknowledgement },
    meta: { truncations: [], stringsClipped: 0 },
  };
  return operationRenderers(getOperation(operationName)).renderResult(
    { content: [{ type: 'text', text: JSON.stringify(details) }], details } as any,
    { expanded: false, isPartial: false },
    theme,
    { args } as any,
  ).render(200).join('\n');
}

describe('v0.6 entity-less mutation acknowledgement matrix', () => {
  it('enumerates every canonical mutation operation and branch independently', () => {
    expect(Object.keys(MATRIX).sort()).toEqual(definitions.map(({ name }) => name).sort());
    for (const definition of definitions) {
      expect(MATRIX[definition.name]!.map(({ required }) => required))
        .toEqual(definition.canonical.branches.map(({ all }) => all));
    }
  });

  for (const definition of definitions) {
    const root = definition.graphql!.documents.find(({ kind }) => kind === 'mutation')!.root;
    for (const [index, branch] of MATRIX[definition.name]!.entries()) {
      it(`${definition.name} branch ${index + 1} acknowledges ${branch.target}`, () => {
        const args = Object.fromEntries(branch.required.map((field) => [field, `value-${field}`]));
        const expected = `target-${definition.name}-${index}-${branch.target}`;
        args[branch.target] = expected;
        const rendered = render(definition.name, root, args);
        expect(rendered).toContain(expected);
        expect(rendered).not.toContain(': status unknown');
      });
    }
  }
});
