import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveRequest } from '../extensions/api';
import type { CompatibilityObject, CompatibilityValue } from '../extensions/operation-types';

const UUID = '11111111-1111-4111-8111-111111111111';

type Field = { name: string; type: string; required: boolean };
type RequestFixture = {
  operationName: string;
  requestedName: string;
  cards: Field[][];
};
type AcceptanceFixture = {
  parent: string;
  requests: Array<{
    operationName: string;
    requestedName: string;
  } & { [key: string]: Field[][] | string }>;
  accepted: string;
  caseCount: number;
};

// Static compatibility output after the dispatch-usability aliases and conflict guards. This test does not use parameterCards or branch projectors.
const RAW_FIXTURE = JSON.parse(readFileSync(
  new URL('./fixtures/v06-compatibility-acceptance.json', import.meta.url),
  'utf8',
)) as AcceptanceFixture;
const FIXTURE = {
  parent: RAW_FIXTURE.parent,
  accepted: RAW_FIXTURE.accepted,
  caseCount: RAW_FIXTURE.caseCount,
  requests: RAW_FIXTURE.requests.map((request) => ({
    operationName: request.operationName,
    requestedName: request.requestedName,
    cards: Array.isArray(request['shapes']) ? request['shapes'] : [],
  })),
} satisfies { parent: string; accepted: string; caseCount: number; requests: RequestFixture[] };

const INPUT_VALUES = {
  create_comment: { issueId: UUID, body: 'x' },
  update_comment: { body: 'x' },
  create_issue: { title: 'x', teamId: UUID },
  create_document: { title: 'x' },
  create_issue_label: { name: 'x' },
  create_project_label: { name: 'x' },
};

function inputValue(operationName: string): CompatibilityObject {
  if (operationName === 'create_comment') return INPUT_VALUES.create_comment;
  if (operationName === 'update_comment') return INPUT_VALUES.update_comment;
  if (operationName === 'create_issue') return INPUT_VALUES.create_issue;
  if (operationName === 'create_document') return INPUT_VALUES.create_document;
  if (operationName === 'create_issue_label') return INPUT_VALUES.create_issue_label;
  if (operationName === 'create_project_label') return INPUT_VALUES.create_project_label;
  return {};
}

function fieldValue(operationName: string, name: string, type: string): CompatibilityValue {
  if (name === 'input') return inputValue(operationName);
  if (name === 'bodyData' || /filter|preferences/i.test(name)) return {};
  if (type.startsWith('[')) return [UUID];
  if (/Float|Int|Priority/.test(type)) return 1;
  if (/Boolean/.test(type)) return true;
  if (/Date/.test(type)) return '2026-01-01';
  if (name === 'number') return 1;
  if (['name', 'title', 'body', 'term'].includes(name)) return 'x';
  return UUID;
}

function representativeCases(operationName: string, cards: Field[][]): CompatibilityObject[] {
  const seen = new Set<string>();
  const cases: CompatibilityObject[] = [];
  for (const card of cards) {
    const all = Object.fromEntries(card.map((field) => [
      field.name,
      fieldValue(operationName, field.name, field.type),
    ]));
    const required = Object.fromEntries(card.filter(({ required }) => required).map((field) => [
      field.name,
      fieldValue(operationName, field.name, field.type),
    ]));
    const candidates = [
      {},
      required,
      all,
      ...card.map((field) => ({
        [field.name]: fieldValue(operationName, field.name, field.type),
      })),
      ...card.map((field) => ({
        ...required,
        [field.name]: fieldValue(operationName, field.name, field.type),
      })),
      ...card.filter(({ required }) => required).map((field) =>
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

function accepts(operation: string, variables: CompatibilityObject): boolean {
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
      expect(request.cards.length, request.requestedName).toBeGreaterThan(0);
      for (const variables of representativeCases(request.operationName, request.cards)) {
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
