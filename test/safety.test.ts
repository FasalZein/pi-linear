import { afterEach, describe, expect, it } from 'vitest';
import { assertMutationAllowed, assertNamedInputAllowed, getMutationFields } from '../extensions/safety';

afterEach(() => {
  delete process.env.LINEAR_MUTATIONS;
  delete process.env.LINEAR_READONLY;
});

describe('named input policy', () => {
  it.each([
    [{ trashed: true }, 'variables.trashed'],
    [{ input: { trashed: false } }, 'variables.input.trashed'],
    [{ filters: [{ nested: { trashed: null } }] }, 'variables.filters[0].nested.trashed'],
  ])('rejects destructive semantic fields at any depth', (variables, path) => {
    expect(() => assertNamedInputAllowed(variables)).toThrow(
      `Destructive named input is unavailable at ${path}. Use an authorized raw GraphQL mutation with LINEAR_MUTATIONS=all.`,
    );
  });

  it('inspects only own enumerable string keys', () => {
    const inherited = Object.create({ trashed: true }) as Record<string, unknown>;
    Object.defineProperty(inherited, 'hidden', { value: { trashed: true }, enumerable: false });
    inherited.body = 'ordinary trashed text';

    expect(() => assertNamedInputAllowed(inherited)).not.toThrow();
  });

  it('does not infer destructive intent from ordinary string values or unrelated keys', () => {
    expect(() => assertNamedInputAllowed({
      body: 'The word trashed is ordinary text.',
      trashedAt: '2026-08-18',
      status: ['not trashed'],
    })).not.toThrow();
  });
});

describe('mutation detection and gating', () => {
  it('uses the parsed operation type and root field names', () => {
    expect(getMutationFields('query { viewer { id } }')).toEqual([]);
    expect(getMutationFields('mutation Rename { changed: issueUpdate(id: "x", input: {}) { success } }')).toEqual(['issueUpdate']);
  });

  it('follows root fragment selections', () => {
    expect(getMutationFields('mutation { ...Change } fragment Change on Mutation { commentCreate(input: {}) { success } }')).toEqual(['commentCreate']);
  });

  it('allows only safe roots declared by a named operation', () => {
    expect(() => assertMutationAllowed(
      'mutation { issueCreate(input: {}) { success } }',
      'allowlist',
      ['issueCreate'],
    )).not.toThrow();
  });

  it('rejects named document roots that the catalog entry did not declare', () => {
    expect(() => assertMutationAllowed(
      'mutation { issueCreate(input: {}) { success } commentCreate(input: {}) { success } }',
      'allowlist',
      ['issueCreate'],
    )).toThrow('Named Linear operation contains undeclared mutation roots: commentCreate.');
  });

  it('rejects named roots outside the safe set even when declared', () => {
    expect(() => assertMutationAllowed(
      'mutation { issueDelete(id: "x") { success } }',
      'allowlist',
      ['issueDelete'],
    )).toThrow('Linear mutation rejected: issueDelete is not in the safe named-root set.');
  });

  it('rejects raw mutations by default', () => {
    expect(() => assertMutationAllowed(
      'mutation { issueCreate(input: {}) { success } }',
      'allowlist',
    )).toThrow('Raw Linear mutations are disabled. Set LINEAR_MUTATIONS=all to allow raw mutations.');
  });

  it('allows raw mutations through the environment escape hatch', () => {
    process.env.LINEAR_MUTATIONS = 'all';
    expect(() => assertMutationAllowed(
      'mutation { issueDelete(id: "x") { success } }',
      'allowlist',
    )).not.toThrow();
  });

  it('does not let the escape hatch bypass named declarations', () => {
    process.env.LINEAR_MUTATIONS = 'all';
    expect(() => assertMutationAllowed(
      'mutation { issueUpdate(id: "x", input: {}) { success } }',
      'allowlist',
      [],
    )).toThrow('undeclared mutation roots: issueUpdate');
  });

  it('rejects every mutation in read-only mode even with the escape hatch', () => {
    process.env.LINEAR_MUTATIONS = 'all';
    expect(() => assertMutationAllowed(
      'mutation { issueUpdate(id: "x", input: {}) { success } }',
      'readonly',
      ['issueUpdate'],
    )).toThrow('read-only mode');
  });

  it('LINEAR_READONLY=1 forces read-only mode on every entry', () => {
    process.env.LINEAR_READONLY = '1';
    process.env.LINEAR_MUTATIONS = 'all';
    expect(() => assertMutationAllowed(
      'mutation { issueCreate(input: {}) { success } }',
      'allowlist',
      ['issueCreate'],
    )).toThrow('read-only mode');
    expect(() => assertMutationAllowed('query { viewer { id } }', 'allowlist')).not.toThrow();
  });
});
