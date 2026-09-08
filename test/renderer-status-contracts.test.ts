import { describe, expect, it } from 'vitest';
import type { JsonObject, JsonValue } from '../extensions/json';
import { getOperation } from '../extensions/operations';
import { operationRenderers } from '../extensions/renderers';

function result<T>(details: T) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details } as any;
}

const theme = {
  fg: (_role: string, text: string) => text,
  bg: (_role: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
} as any;

function render(operation: string, details: JsonValue, args: JsonObject = {}) {
  return operationRenderers(getOperation(operation))
    .renderResult(result(details), { expanded: false, isPartial: false }, theme, { args } as any)
    .render(200)
    .join('\n');
}

/** A mutation that returned no entity, so the acknowledgement summary is what a caller sees. */
const acknowledgement = (errors: JsonValue[]): JsonValue => ({
  data: { issueUpdate: { success: true } },
  errors,
  meta: { view: 'acknowledgement', truncations: [], stringsClipped: 0 },
});

describe('acknowledged mutation status reflects the warnings it lists', () => {
  // One warning is already a warning. A threshold above one would show a clean success line
  // while printing the warning underneath it.
  it('marks the status as warning when exactly one warning is reported', () => {
    const rendered = render('update_issue', acknowledgement([
      { path: ['issueUpdate', 'description'], message: 'Description was clipped' },
    ]));

    expect(rendered).toContain('with warnings');
    expect(rendered).toContain('Description was clipped');
    expect(rendered).not.toContain('✓ Updated');
  });

  it('marks the status as success when no warning is reported', () => {
    const rendered = render('update_issue', acknowledgement([]));

    expect(rendered).not.toContain('with warnings');
    expect(rendered).toContain('✓ Updated');
  });
});

describe('render target fields are chosen from the operation contract', () => {
  // "id" is the identity a caller recognises. Dropping it from the target fields leaves the
  // acknowledgement naming only the entity kind, with nothing to say which one was changed.
  it.each([
    ['update_comment', { id: 'ID-1' }, 'Updated comment ID-1'],
    ['get_view', { id: 'ID-1' }, 'Loaded view ID-1'],
  ])('names the %s target by its id', (operation, args, expected) => {
    const rendered = render(operation, {
      data: { [operation === 'get_view' ? 'customView' : 'commentUpdate']: { success: true } },
      errors: [],
      meta: { view: 'acknowledgement', truncations: [], stringsClipped: 0 },
    }, args);

    expect(rendered).toContain(expected);
  });

  // A relation names neither an "id" nor its own entity kind, so its target is selected purely
  // by the reference type of the field. The acknowledgement must still name the project.
  it('names a relation target selected by its reference type', () => {
    const rendered = render('create_project_relation', {
      data: { projectRelationCreate: { success: true } },
      errors: [],
      meta: { view: 'acknowledgement', truncations: [], stringsClipped: 0 },
    }, { project: 'Apollo', relatedProject: 'Zeus' });

    expect(rendered).toContain('Created relation Apollo');
  });
});
