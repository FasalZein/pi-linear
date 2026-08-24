import { afterEach, describe, expect, it, vi } from 'vitest';
import { linearApiTool, linearGraphqlTool } from '../extensions/api';
import { createLinearHarness, execute } from './helpers/provider-harness';
import { isolateLinearCredentials } from './helpers/credentials';

isolateLinearCredentials();

const originalApiKey = process.env.LINEAR_API_KEY;
const originalMutations = process.env.LINEAR_MUTATIONS;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalApiKey === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = originalApiKey;
  if (originalMutations === undefined) delete process.env.LINEAR_MUTATIONS;
  else process.env.LINEAR_MUTATIONS = originalMutations;
});

describe('direct raw GraphQL tool', () => {
  it('publishes the strict direct schema and rejects wrapper fields before network access', async () => {
    const tool = linearGraphqlTool() as any;
    expect(tool.name).toBe('linear_graphql');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      required: ['query'],
      additionalProperties: false,
      properties: {
        query: { type: 'string' },
        variables: { type: 'object' },
        workspace: { type: 'string' },
        sink: { enum: ['inline', 'artifact'] },
        telemetry: { enum: ['always'] },
      },
    });
    expect(Object.keys(tool.parameters.properties).sort()).toEqual(['query', 'sink', 'telemetry', 'variables', 'workspace']);

    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    for (const args of [
      {},
      { operation: 'get_issue', query: 'query { viewer { id } }' },
      { query: 'query { viewer { id } }', unknown: true },
      { query: 123 },
      { query: 'query { viewer { id } }', telemetry: 'sometimes' },
    ]) {
      expect(() => tool.prepareArguments(args)).toThrow(/Invalid arguments for "linear_graphql"/);
      await expect(execute(tool, args as any)).rejects.toThrow(/Invalid arguments for "linear_graphql"/);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('activates only linear_graphql for exact graphql help and reports it once', async () => {
    const harness = createLinearHarness();
    harness.startSession();
    expect(harness.activeTools().filter((name) => name === 'linear' || name.startsWith('linear_')))
      .toEqual(['linear', 'linear_get_result']);

    const domain = await execute(harness.tool('linear'), {
      operation: 'help', variables: { domain: 'issues' },
    });
    expect(domain.details.loadedTools).toBeUndefined();
    expect(harness.activeTools().filter((name) => name === 'linear' || name.startsWith('linear_')))
      .toEqual(['linear', 'linear_get_result']);

    const first = await execute(harness.tool('linear'), {
      operation: 'help', variables: { operation: 'graphql' },
    });
    expect(first.details).toMatchObject({
      loadedTools: ['linear_graphql'],
      name: 'graphql',
      example: { query: 'query Viewer { viewer { id name } }', variables: {} },
    });
    expect(first.details.parameters.map(({ name }: { name: string }) => name))
      .toEqual(['query', 'variables', 'workspace', 'sink', 'telemetry']);
    expect(harness.activeTools().filter((name) => name === 'linear' || name.startsWith('linear_')))
      .toEqual(['linear', 'linear_get_result', 'linear_graphql']);

    const again = await execute(harness.tool('linear'), {
      operation: 'help', variables: { operation: 'graphql' },
    });
    expect(again.details.loadedTools).toBeUndefined();
    expect(harness.activeTools().filter((name) => name === 'linear' || name.startsWith('linear_')))
      .toEqual(['linear', 'linear_get_result', 'linear_graphql']);
  });

  it('executes the direct raw read with unchanged routing', async () => {
    process.env.LINEAR_API_KEY = 'test-key';
    const requests: Array<{ query: string; variables: Record<string, unknown>; authorization: string | null }> = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      requests.push({ ...body, authorization: new Headers(init.headers).get('Authorization') });
      return new Response(JSON.stringify({
        data: { me: { id: 'user-1', name: 'Ada' }, failed: null },
        errors: [{ message: 'Issue not found', path: ['failed', 'name'] }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetch);
    const args = {
      query: 'query Viewer($includeName: Boolean!) { me: viewer { ...ViewerFields } failed: issue(id: "missing") { id name } } fragment ViewerFields on User { id name @include(if: $includeName) }',
      variables: { includeName: true },
      sink: 'inline' as const,
      telemetry: 'always' as const,
    };

    const direct = await execute(linearGraphqlTool() as any, args);

    expect(requests).toEqual([
      { query: args.query, variables: args.variables, authorization: 'test-key' },
    ]);
    expect(direct.details).toMatchObject({ data: { me: { id: 'user-1', name: 'Ada' } } });
  });

  it.each([
    ['malformed document', { query: 'query {' }, /Syntax Error/],
    ['unrepresentable alias', { query: `query { ${'a'.repeat(60_000)}: viewer { id } }` }, /alias|represent/i],
    ['raw mutation gate', { query: 'mutation { issueArchive(id: "x") { success } }' }, /Raw Linear mutations are disabled/],
  ])('preserves %s before credentials and network', async (_name, args, message) => {
    delete process.env.LINEAR_API_KEY;
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(execute(linearGraphqlTool() as any, args)).rejects.toThrow(message);
    expect(fetch).not.toHaveBeenCalled();
  });
});
