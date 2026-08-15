import { afterEach, describe, expect, it } from 'vitest';
import { assertMutationAllowed, getMutationFields } from '../extensions/safety';

afterEach(() => delete process.env.LINEAR_MUTATIONS);

describe('mutation detection and gating', () => {
  it('uses the parsed operation type and root field names', () => {
    expect(getMutationFields('query { viewer { id } }')).toEqual([]);
    expect(getMutationFields('mutation Rename { changed: issueUpdate(id: "x", input: {}) { success } }')).toEqual(['issueUpdate']);
  });

  it('follows root fragment selections', () => {
    expect(getMutationFields('mutation { ...Change } fragment Change on Mutation { commentCreate(input: {}) { success } }')).toEqual(['commentCreate']);
  });

  it('accepts allowlisted mutations', () => {
    expect(() => assertMutationAllowed('mutation { issueCreate(input: {}) { success } }', 'allowlist')).not.toThrow();
  });

  it('rejects other mutations and names the escape hatch', () => {
    expect(() => assertMutationAllowed('mutation { issueDelete(id: "x") { success } }', 'allowlist')).toThrow(
      'issueDelete is not allowlisted. Set LINEAR_MUTATIONS=all',
    );
  });

  it('allows all mutations through the environment escape hatch', () => {
    process.env.LINEAR_MUTATIONS = 'all';
    expect(() => assertMutationAllowed('mutation { issueDelete(id: "x") { success } }', 'allowlist')).not.toThrow();
  });

  it('rejects every mutation in read-only mode even with the escape hatch', () => {
    process.env.LINEAR_MUTATIONS = 'all';
    expect(() => assertMutationAllowed('mutation { issueUpdate(id: "x", input: {}) { success } }', 'readonly')).toThrow(
      'read-only entry point',
    );
  });
});
