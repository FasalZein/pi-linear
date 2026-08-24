import { afterEach, describe, expect, it, vi } from 'vitest';

const { credentialWork, artifactRead } = vi.hoisted(() => ({
  credentialWork: vi.fn(() => {
    throw new Error('credential work must not run');
  }),
  artifactRead: vi.fn(() => {
    throw new Error('artifact read must not run');
  }),
}));

vi.mock('../extensions/active-secrets', () => ({ activeSecrets: credentialWork }));
vi.mock('../extensions/result-handles', async (importOriginal) => ({
  ...await importOriginal<typeof import('../extensions/result-handles')>(),
  getResult: artifactRead,
}));

import { linearApiTool } from '../extensions/api';

function execute(params: Record<string, unknown>) {
  return (linearApiTool() as any).execute('call-1', params, undefined, undefined, { hasUI: false });
}

afterEach(() => {
  credentialWork.mockClear();
  artifactRead.mockClear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('discovery-only loader execution', () => {
  it.each([
    [
      'raw GraphQL',
      { query: 'query { viewer { id } }', variables: {}, workspace: 'work', sink: 'artifact', telemetry: 'always' },
      'Raw GraphQL cannot run through linear. Call linear_graphql with direct arguments.',
    ],
    [
      'batch',
      { operation: 'batch', variables: { operations: [{ operation: 'get_issue' }] }, workspace: 'work' },
      'Batch execution cannot run through linear. Call linear_batch with direct arguments.',
    ],
    [
      'result retrieval',
      { operation: 'get_result', variables: { handle: 'linear-result:v1:550e8400-e29b-41d4-a716-446655440000' } },
      'Result retrieval cannot run through linear. Call linear_get_result with direct arguments.',
    ],
    [
      'named operation',
      { operation: 'get_issue', variables: { issue: 'AEO-258' }, workspace: 'work' },
      'Named operations cannot run through linear. Call linear_get_issue with direct arguments.',
    ],
  ])('rejects the removed %s route before credentials, artifacts, timers, or network', async (_name, params, message) => {
    const fetch = vi.fn();
    const timer = vi.spyOn(globalThis, 'setTimeout');
    vi.stubGlobal('fetch', fetch);
    const tool = linearApiTool() as any;

    expect(() => tool.prepareArguments(params)).toThrow(message);
    await expect(execute(params)).rejects.toThrow(message);

    expect(credentialWork).not.toHaveBeenCalled();
    expect(artifactRead).not.toHaveBeenCalled();
    expect(timer).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('guides compatibility aliases to the canonical typed tool', async () => {
    await expect(execute({ operation: 'add_comment', variables: { issueId: 'issue-id', body: 'text' } }))
      .rejects.toThrow('Call linear_create_comment with direct arguments.');
    expect(credentialWork).not.toHaveBeenCalled();
  });

  it('keeps unknown operation guidance generic without echoing caller text', async () => {
    const operation = 'lin_api_secret123456789';
    const error = await execute({ operation }).catch((failure: Error) => failure);
    expect(error.message).toBe('The linear tool accepts discovery help only. Send { "operation": "help" }.');
    expect(error.message).not.toContain(operation);
    expect(credentialWork).not.toHaveBeenCalled();
  });

  it.each([
    { operation: 'help', extra: true },
    { operation: 'help', variables: { domain: 'issues', extra: true } },
    { operation: 'help', variables: { operation: 'get_issue', extra: true } },
    { operation: 'help', variables: {} },
    { operation: 'help', variables: { domain: 'missing' } },
  ])('rejects unknown or invalid help fields locally: %j', async (params) => {
    const tool = linearApiTool() as any;
    expect(() => tool.prepareArguments(params)).toThrow(/Invalid arguments for "linear"/);
    await expect(execute(params)).rejects.toThrow(/Invalid arguments for "linear"/);
    expect(credentialWork).not.toHaveBeenCalled();
    expect(artifactRead).not.toHaveBeenCalled();
  });

  it('publishes only the exact discovery schema', () => {
    const tool = linearApiTool() as any;
    expect(Object.keys(tool.parameters.properties)).toEqual(['operation', 'variables']);
    expect(tool.parameters.required).toEqual(['operation']);
    expect(tool.parameters.properties.operation.const).toBe('help');
    expect(tool.label).toBe('Linear');
  });
});
