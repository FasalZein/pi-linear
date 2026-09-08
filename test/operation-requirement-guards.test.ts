import { afterEach, describe, expect, it, vi } from 'vitest';
import { typedLinearTools } from '../extensions/typed-tools';
import { operationDefinitions } from '../extensions/operations';
import { isolateLinearCredentials } from './helpers/credentials';
import type { CompatibilityObject } from '../extensions/operation-types';

isolateLinearCredentials();

const originalApiKey = process.env.LINEAR_API_KEY;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalApiKey === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = originalApiKey;
});

function noNetwork() {
  const fetch = vi.fn(async () => {
    throw new Error('No request may be sent for parameters that fail validation.');
  });
  process.env.LINEAR_API_KEY = 'test-key';
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function typed(operation: string, variables: CompatibilityObject) {
  const tool = typedLinearTools().find((candidate) => candidate.name === `linear_${operation}`);
  if (!tool) throw new Error(`Missing typed tool for ${operation}.`);
  return (tool as any).execute('call-1', variables, undefined, undefined, { hasUI: false });
}

describe('operation requirement branches are enforced', () => {
  // A non-exclusive requirement needs at least one satisfied branch. Accepting zero would let a
  // request with no usable parameters reach Linear.
  it('rejects a call that satisfies no requirement branch', async () => {
    const fetch = noNetwork();

    await expect(typed('get_view', {})).rejects.toThrow(/missing id/);

    expect(fetch).not.toHaveBeenCalled();
  });

  // With exclusive branches the diagnostic must name the group that actually failed. Here the
  // comment target is given exactly once and the body is missing, so the body group is at fault.
  it('names the requirement group that failed, not one that was satisfied', async () => {
    const fetch = noNetwork();

    await expect(typed('create_comment', { issue: 'AEO-1' }))
      .rejects.toThrow(/exactly one of body or bodyData is required/);

    expect(fetch).not.toHaveBeenCalled();
  });

  it('names the target group when the comment target itself is ambiguous', async () => {
    const fetch = noNetwork();

    await expect(typed('create_comment', { issue: 'AEO-1', body: 'hi', advanced: { project: 'Apollo' } }))
      .rejects.toThrow(/exactly one comment target is required/);

    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('exclusive requirement diagnostics stay inside the declared columns', () => {
  // The per-column diagnostic walks the widest requirement branch. A message list longer than
  // that width could never be reached, so the catalog must not declare one.
  it('never declares more exactly-one-of messages than the widest requirement branch', () => {
    const offenders: string[] = [];
    for (const definition of operationDefinitions) {
      if (!definition.canonical.exclusiveBranches) continue;
      const messages = definition.compatibility.branches[0]?.exactlyOneOfMessages ?? [];
      const width = Math.max(...definition.canonical.branches.map(({ all }) => all.length));
      if (messages.length > width) offenders.push(`${definition.name}: ${messages.length} messages for width ${width}`);
    }
    expect(offenders).toEqual([]);
  });
});
