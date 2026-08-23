import { afterEach, describe, expect, it, vi } from 'vitest';

const { credentialWork } = vi.hoisted(() => ({
  credentialWork: vi.fn(() => {
    throw new Error('credential work must not run');
  }),
}));

vi.mock('../extensions/active-secrets', () => ({ activeSecrets: credentialWork }));

import { linearApiTool } from '../extensions/api';

function execute(params: Record<string, unknown>) {
  return (linearApiTool() as any).execute('call-1', params, undefined, undefined, { hasUI: false });
}

afterEach(() => {
  credentialWork.mockClear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('discovery-only loader execution', () => {
  it('rejects a named operation with typed-tool guidance before credentials, timers, or network', async () => {
    const fetch = vi.fn();
    const timer = vi.spyOn(globalThis, 'setTimeout');
    vi.stubGlobal('fetch', fetch);

    await expect(execute({
      operation: 'get_issue',
      variables: { issue: 'AEO-258' },
      workspace: 'work',
      sink: 'artifact',
      telemetry: 'always',
    })).rejects.toThrow(
      'Named operation "get_issue" cannot run through linear. Send { "operation": "help", "variables": { "operation": "get_issue" } } to load linear_get_issue, then call linear_get_issue with the operation variables directly.',
    );

    expect(credentialWork).not.toHaveBeenCalled();
    expect(timer).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('guides compatibility aliases to the canonical typed tool', async () => {
    await expect(execute({ operation: 'add_comment', variables: { issueId: 'issue-id', body: 'text' } }))
      .rejects.toThrow('load linear_create_comment, then call linear_create_comment');
    expect(credentialWork).not.toHaveBeenCalled();
  });

  it('keeps unknown operation guidance generic without credential work', async () => {
    const operation = 'lin_api_secret123456789';
    const error = await execute({ operation }).catch((failure: Error) => failure);
    expect(error.message).toBe('Unknown Linear operation. Send { "operation": "help" }.');
    expect(error.message).not.toContain(operation);
    expect(credentialWork).not.toHaveBeenCalled();
  });
});
