import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveRequest } from '../extensions/api';

const UUID = '11111111-1111-4111-8111-111111111111';

type Field = { name: string; type: string; required: boolean };
type RequestFixture = {
  operationName: string;
  requestedName: string;
  shapes: Field[][];
};
type AcceptanceFixture = {
  parent: string;
  requests: RequestFixture[];
  accepted: string;
  caseCount: number;
};

// Static compatibility output after the dispatch-usability aliases and conflict guards. This test does not use parameterShapes or branch projectors.
const FIXTURE = JSON.parse(readFileSync(
  new URL('./fixtures/v06-compatibility-acceptance.json', import.meta.url),
  'utf8',
)) as AcceptanceFixture;

const INPUT_VALUES: Record<string, unknown> = {
  create_comment: { issueId: UUID, body: 'x' },
  update_comment: { body: 'x' },
  create_issue: { title: 'x', teamId: UUID },
  create_document: { title: 'x' },
  create_issue_label: { name: 'x' },
  create_project_label: { name: 'x' },
};

function fieldValue(operationName: string, name: string, type: string): unknown {
  if (name === 'input') return INPUT_VALUES[operationName] ?? {};
  if (name === 'bodyData' || /filter|preferences/i.test(name)) return {};
  if (type.startsWith('[')) return [UUID];
  if (/Float|Int|Priority/.test(type)) return 1;
  if (/Boolean/.test(type)) return true;
  if (/Date/.test(type)) return '2026-01-01';
  if (name === 'number') return 1;
  if (['name', 'title', 'body', 'term'].includes(name)) return 'x';
  return UUID;
}

function representativeCases(operationName: string, shapes: Field[][]): Record<string, unknown>[] {
  const seen = new Set<string>();
  const cases: Record<string, unknown>[] = [];
  for (const shape of shapes) {
    const all = Object.fromEntries(shape.map((field) => [
      field.name,
      fieldValue(operationName, field.name, field.type),
    ]));
    const required = Object.fromEntries(shape.filter(({ required }) => required).map((field) => [
      field.name,
      fieldValue(operationName, field.name, field.type),
    ]));
    const candidates = [
      {},
      required,
      all,
      ...shape.map((field) => ({
        [field.name]: fieldValue(operationName, field.name, field.type),
      })),
      ...shape.map((field) => ({
        ...required,
        [field.name]: fieldValue(operationName, field.name, field.type),
      })),
      ...shape.filter(({ required }) => required).map((field) =>
        Object.fromEntries(Object.entries(all).filter(([name]) => name !== field.name))),
    ];
    for (const variables of candidates) {
      const key = JSON.stringify(variables);
      if (seen.has(key)) continue;
      seen.add(key);
      cases.push(variables);
    }
  }
  return cases;
}

function accepts(operation: string, variables: Record<string, unknown>): boolean {
  try {
    resolveRequest({ operation, variables });
    return true;
  } catch {
    return false;
  }
}

describe('loader compatibility differential', () => {
  it('matches all 52 requested shapes across 1,007 representative field-presence cases', () => {
    expect(FIXTURE.parent).toBe('c8c4ac3+dispatch-usability');
    expect(FIXTURE.requests).toHaveLength(52);
    expect(new Set(FIXTURE.requests.map(({ operationName }) => operationName)).size).toBe(48);

    let actual = '';
    for (const request of FIXTURE.requests) {
      expect(request.shapes.length, request.requestedName).toBeGreaterThan(0);
      for (const variables of representativeCases(request.operationName, request.shapes)) {
        actual += accepts(request.requestedName, variables) ? '1' : '0';
      }
    }
    expect(actual).toHaveLength(FIXTURE.caseCount);
    expect(actual).toBe(FIXTURE.accepted);
  });

  it('rejects skipEditedAt as standalone comment content and keeps real updates', () => {
    expect(() => resolveRequest({
      operation: 'update_comment', variables: { id: 'comment-id', skipEditedAt: true },
    })).toThrow('at least one comment update field is required');

    for (const update of [
      { body: 'text' },
      { bodyData: {} },
      { quotedText: 'quote' },
      { body: 'text', skipEditedAt: true },
      { input: { doNotSubscribeToIssue: true } },
      { input: { resolvingUserId: UUID } },
      { input: { subscriberIds: [UUID] } },
    ]) {
      expect(() => resolveRequest({
        operation: 'update_comment', variables: { id: 'comment-id', ...update },
      }), JSON.stringify(update)).not.toThrow();
    }
  });

  it('isolates canonical and alias required shapes for update_issue', () => {
    expect(() => resolveRequest({
      operation: 'update_issue', variables: { issueId: UUID, stateId: UUID },
    })).toThrow('missing issue');
    expect(() => resolveRequest({
      operation: 'update_issue_state', variables: { issueId: UUID, stateId: UUID },
    })).not.toThrow();
  });
});
