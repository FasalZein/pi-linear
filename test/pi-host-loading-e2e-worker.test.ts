import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fauxAssistantMessage,
  fauxToolCall,
  type Context,
} from '@earendil-works/pi-ai';
import {
  NATIVE_ANTHROPIC_MODEL,
  NATIVE_OPENAI_MODEL,
  captureAnthropic,
  captureOpenAI,
} from './helpers/provider-harness';
import {
  FIXTURE_KEY,
  TEAM_ID,
  createHostSession,
  executeActiveTool,
  issue,
  resetHostFixtures,
  snapshotContext,
  startGraphQLServer,
  toolNames,
  toolResultDetails,
} from './helpers/pi-host-session';

afterEach(resetHostFixtures);

describe('installed Pi host deferred Linear control tools', () => {
  it('runs loader, typed call, raw GraphQL, result recovery, and read batch in one real Pi turn', async () => {
    const { endpoint, requests } = await startGraphQLServer((request) => {
      if (request.query.includes('query HostRaw')) {
        return { body: { data: { viewer: { id: 'viewer-1', name: 'Fixture Viewer' } } } };
      }
      if (request.query.includes('first: issue') && request.query.includes('second: issue')) {
        return {
          body: {
            data: {
              first: issue('AEO-1', 'First issue'),
              second: issue('AEO-2', 'Second issue'),
            },
          },
        };
      }
      return { body: { data: { issue: issue('AEO-1', 'Host issue') } } };
    });
    process.env.LINEAR_API_KEY = FIXTURE_KEY;
    process.env.LINEAR_READONLY = '1';
    process.env.LINEAR_SMOKE_GRAPHQL_ENDPOINT = endpoint;

    const contexts: Context[] = [];
    let resultHandle = '';
    const responses = [
      (context: Context) => {
        contexts.push(snapshotContext(context));
        return fauxAssistantMessage(fauxToolCall('linear', {
          operation: 'help', variables: { operation: 'get_issue' },
        }, { id: 'load-get-issue' }), { stopReason: 'toolUse' });
      },
      (context: Context) => {
        contexts.push(snapshotContext(context));
        return fauxAssistantMessage(fauxToolCall('linear_get_issue', {
          issue: 'AEO-1', view: 'summary',
        }, { id: 'get-issue' }), { stopReason: 'toolUse' });
      },
      (context: Context) => {
        contexts.push(snapshotContext(context));
        return fauxAssistantMessage(fauxToolCall('linear', {
          operation: 'help', variables: { operation: 'graphql' },
        }, { id: 'load-graphql' }), { stopReason: 'toolUse' });
      },
      (context: Context) => {
        contexts.push(snapshotContext(context));
        return fauxAssistantMessage(fauxToolCall('linear_graphql', {
          query: 'query HostRaw { viewer { id name } }', sink: 'artifact',
        }, { id: 'raw-graphql' }), { stopReason: 'toolUse' });
      },
      (context: Context) => {
        contexts.push(snapshotContext(context));
        const details = toolResultDetails(context, 'linear_graphql');
        resultHandle = String(details.handle);
        return fauxAssistantMessage(fauxToolCall('linear_get_result', {
          handle: resultHandle, path: '/data/viewer/name',
        }, { id: 'get-result' }), { stopReason: 'toolUse' });
      },
      (context: Context) => {
        contexts.push(snapshotContext(context));
        return fauxAssistantMessage(fauxToolCall('linear', {
          operation: 'help', variables: { operation: 'batch' },
        }, { id: 'load-batch' }), { stopReason: 'toolUse' });
      },
      (context: Context) => {
        contexts.push(snapshotContext(context));
        return fauxAssistantMessage(fauxToolCall('linear_batch', {
          operations: [
            { key: 'first', operation: 'get_issue', variables: { issue: 'AEO-1' } },
            { key: 'second', operation: 'get_issue', variables: { issue: 'AEO-2' } },
          ],
        }, { id: 'read-batch' }), { stopReason: 'toolUse' });
      },
      (context: Context) => {
        contexts.push(snapshotContext(context));
        return fauxAssistantMessage('All four Linear control tools completed.');
      },
    ];
    const { session, faux } = await createHostSession({ responses });

    expect(session.getActiveToolNames()).toEqual(['linear', 'linear_get_result']);
    await session.prompt('Exercise the Linear control path.');

    expect(faux.state.callCount).toBe(8);
    expect(faux.getPendingResponseCount()).toBe(0);
    expect(toolNames(contexts[0]!)).toEqual(['linear', 'linear_get_result']);
    expect(toolNames(contexts[0]!)).not.toContain('linear_get_issue');
    expect(contexts.flatMap(toolNames).some((name) => /notebook/i.test(name))).toBe(false);
    expect(toolNames(contexts[1]!)).toEqual(['linear', 'linear_get_result', 'linear_get_issue']);
    expect(toolNames(contexts[3]!)).toContain('linear_graphql');
    expect(toolNames(contexts[6]!)).toContain('linear_batch');
    expect(session.getActiveToolNames()).toEqual([
      'linear', 'linear_get_result', 'linear_get_issue', 'linear_graphql', 'linear_batch',
    ]);

    const loaderResult = contexts[1]!.messages.find(
      (message) => message.role === 'toolResult' && message.toolName === 'linear',
    );
    expect(loaderResult).toMatchObject({ addedToolNames: ['linear_get_issue'] });
    expect(toolResultDetails(contexts[5]!, 'linear_get_result')).toMatchObject({
      data: { value: 'Fixture Viewer' },
      meta: { retrieval: { complete: true, handle: resultHandle, path: '/data/viewer/name' } },
    });
    expect(toolResultDetails(contexts[7]!, 'linear_batch')).toMatchObject({
      data: {
        first: { issue: { identifier: 'AEO-1' } },
        second: { issue: { identifier: 'AEO-2' } },
      },
      errors: [],
      skipped: [],
      meta: { requests: { read: 1, mutation: 0 } },
    });
    expect(resultHandle).toMatch(/^linear-result:v1:/);
    expect(requests).toHaveLength(3);
    expect(requests.filter((request) => request.query.includes('mutation'))).toHaveLength(0);
    expect(JSON.stringify(session.messages)).not.toContain(FIXTURE_KEY);

    const deferredContext = contexts[1]!;
    const anthropic = await captureAnthropic(NATIVE_ANTHROPIC_MODEL, deferredContext);
    expect(anthropic.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'linear_get_issue', defer_loading: true }),
    ]));
    expect(anthropic.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: expect.arrayContaining([
        expect.objectContaining({
          type: 'tool_result',
          content: expect.arrayContaining([
            expect.objectContaining({ type: 'tool_reference', tool_name: 'linear_get_issue' }),
          ]),
        }),
      ]) }),
    ]));

    const openai = await captureOpenAI(NATIVE_OPENAI_MODEL, deferredContext);
    expect(openai.tools).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'linear_get_issue' }),
    ]));
    const additionalTools = openai.input.filter((item) => item.type === 'additional_tools');
    expect(additionalTools).toHaveLength(1);
    expect(additionalTools[0]?.tools?.map((tool) => tool.name)).toEqual(['linear_get_issue']);

    const fallback = await captureAnthropic({
      ...NATIVE_ANTHROPIC_MODEL,
      compat: { ...NATIVE_ANTHROPIC_MODEL.compat, supportsToolReferences: false },
    }, deferredContext);
    expect(fallback.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'linear_get_issue' }),
    ]));
    expect(JSON.stringify(fallback)).not.toContain('tool_reference');
    expect(JSON.stringify(fallback)).not.toContain('defer_loading');
  }, 30_000);

  it('preserves unrelated tools on startup and resume and separates normal help from advanced cards', async () => {
    for (const reason of ['startup', 'resume'] as const) {
      const { session } = await createHostSession({ reason, sentinel: true });
      expect(session.getActiveToolNames()).toEqual(['linear', 'linear_get_result', 'host_sentinel']);
      const normal = await executeActiveTool(session, 'linear', {
        operation: 'help', variables: { operation: 'create_issue' },
      });
      expect(normal.addedToolNames).toEqual(['linear_create_issue']);
      expect(normal.details).toMatchObject({
        loadedTools: ['linear_create_issue'],
        purpose: expect.stringContaining('Create an issue'),
        example: { title: expect.any(String), parent: expect.any(String) },
      });
      expect(normal.details).not.toHaveProperty('parameters');
      expect(normal.details).not.toHaveProperty('advanced');

      const advanced = await executeActiveTool(session, 'linear', {
        operation: 'help', variables: { operation: 'create_issue:advanced' },
      });
      expect(advanced.addedToolNames).toBeUndefined();
      expect(advanced.details).toMatchObject({
        name: 'create_issue',
        parameters: expect.arrayContaining([
          { name: 'descriptionData', type: 'JsonString' },
          { name: 'id', type: 'UUID' },
        ]),
      });
      expect(advanced.details).not.toHaveProperty('purpose');
      expect(session.getActiveToolNames()).toEqual([
        'linear', 'linear_get_result', 'host_sentinel', 'linear_create_issue',
      ]);
    }
  }, 30_000);

  it('recovers a complete large result through continuation offsets in the installed host wrapper', async () => {
    const largeValue = '😀é'.repeat(50_000);
    const { endpoint, requests } = await startGraphQLServer(() => ({
      body: { data: { document: { id: 'doc-1', content: largeValue } } },
    }));
    process.env.LINEAR_API_KEY = FIXTURE_KEY;
    process.env.LINEAR_READONLY = '1';
    process.env.LINEAR_SMOKE_GRAPHQL_ENDPOINT = endpoint;
    const { session } = await createHostSession();
    await executeActiveTool(session, 'linear', {
      operation: 'help', variables: { operation: 'graphql' },
    });
    const stored = await executeActiveTool(session, 'linear_graphql', {
      query: 'query LargeDocument { document(id: "doc-1") { id content } }',
      sink: 'artifact',
    });
    const handle = String(stored.details?.handle);
    expect(handle).toMatch(/^linear-result:v1:/);

    let offset = 0;
    let recovered = '';
    let parts = 0;
    while (true) {
      const part = await executeActiveTool(session, 'linear_get_result', {
        handle, path: '/data/document/content', offset,
      });
      const data = part.details?.data as { value: string; range: { end: number } };
      const retrieval = part.details?.meta as { retrieval: { complete: boolean; nextOffset?: number } };
      recovered += data.value;
      parts += 1;
      if (retrieval.retrieval.complete) break;
      if (retrieval.retrieval.nextOffset === undefined) throw new Error('Continuation omitted nextOffset.');
      offset = retrieval.retrieval.nextOffset;
    }

    expect(parts).toBeGreaterThan(1);
    expect(recovered).toBe(largeValue);
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(stored.details)).not.toContain(FIXTURE_KEY);
  }, 30_000);

  it('preflights every batch entry and blocks raw mutations before any network request', async () => {
    delete process.env.LINEAR_READONLY;
    delete process.env.LINEAR_MUTATIONS;
    process.env.LINEAR_API_KEY = FIXTURE_KEY;
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { session } = await createHostSession();
    await executeActiveTool(session, 'linear', {
      operation: 'help', variables: { operation: 'batch' },
    });

    await expect(executeActiveTool(session, 'linear_batch', {
      mutations: [
        { key: 'valid', operation: 'update_issue', variables: { issue: 'AEO-1', title: 'First' } },
        { key: 'invalid', operation: 'update_issue', variables: { issue: 'AEO-2' } },
      ],
    })).rejects.toThrow(/update field|change|at least one/i);
    expect(fetch).not.toHaveBeenCalled();

    await executeActiveTool(session, 'linear', {
      operation: 'help', variables: { operation: 'graphql' },
    });
    await expect(executeActiveTool(session, 'linear_graphql', {
      query: 'mutation Forbidden { issueArchive(id: "AEO-1") { success } }',
    })).rejects.toThrow(/LINEAR_MUTATIONS=all|raw GraphQL mutation/i);
    expect(fetch).not.toHaveBeenCalled();
  }, 30_000);

  it('stops sequential writes after an uncertain failure, accounts for every key, and does not retry', async () => {
    delete process.env.LINEAR_READONLY;
    process.env.LINEAR_API_KEY = FIXTURE_KEY;
    const { endpoint, requests } = await startGraphQLServer((request, index) => {
      const key = request.query.match(/\{\s*(\w+)\s*:\s*issueUpdate/s)?.[1] ?? `write_${index}`;
      if (index === 1) return { status: 503, body: { message: 'Synthetic unavailable response' } };
      return {
        body: {
          data: {
            [key]: { success: true, issue: issue('AEO-1', 'First') },
          },
        },
      };
    });
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn((_url: string | URL | Request, init?: RequestInit) => realFetch(endpoint, init)));
    const { session } = await createHostSession();
    await executeActiveTool(session, 'linear', {
      operation: 'help', variables: { operation: 'batch' },
    });

    const result = await executeActiveTool(session, 'linear_batch', {
      mutations: [
        { key: 'one', operation: 'update_issue', variables: { issue: 'AEO-1', title: 'First' } },
        { key: 'two', operation: 'update_issue', variables: { issue: 'AEO-2', title: 'Second' } },
        { key: 'three', operation: 'update_issue', variables: { issue: 'AEO-3', title: 'Third' } },
      ],
    });

    expect(requests).toHaveLength(2);
    expect(result.details).toMatchObject({
      data: { one: { issueUpdate: { success: true, issue: { title: 'First' } } } },
      errors: [{ key: 'two', path: ['two'], message: expect.stringMatching(/outcome is unknown.*Do not retry.*blindly/i) }],
      skipped: ['three'],
      meta: { requests: { read: 0, mutation: 2 } },
    });
    expect(JSON.stringify(result.details)).not.toContain(FIXTURE_KEY);
  }, 30_000);

  it('retains one transactional issueBatchCreate request for multiple independent creates', async () => {
    delete process.env.LINEAR_READONLY;
    process.env.LINEAR_API_KEY = FIXTURE_KEY;
    const { endpoint, requests } = await startGraphQLServer((request) => {
      if (!request.query.includes('issueBatchCreate')) {
        const aliases = [...request.query.matchAll(/(\w+)\s*:\s*team\(/g)].map((match) => match[1]!);
        return {
          body: {
            data: Object.fromEntries(aliases.map((alias) => [alias, {
              id: TEAM_ID, key: 'AEO', name: 'Agent Experience',
            }])),
          },
        };
      }
      const input = request.variables.input as { issues: Array<{ id: string; title: string }> };
      return {
        body: {
          data: {
            issueBatchCreate: {
              success: true,
              issues: [...input.issues].reverse().map((entry, index) => ({
                id: entry.id,
                identifier: `AEO-${index + 1}`,
                title: entry.title,
                team: { id: TEAM_ID, key: 'AEO' },
              })),
            },
          },
        },
      };
    });
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn((_url: string | URL | Request, init?: RequestInit) => realFetch(endpoint, init)));
    const { session } = await createHostSession();
    await executeActiveTool(session, 'linear', {
      operation: 'help', variables: { operation: 'batch' },
    });

    const result = await executeActiveTool(session, 'linear_batch', {
      mutations: [
        { key: 'alpha', operation: 'create_issue', variables: { title: 'Alpha', team: TEAM_ID } },
        { key: 'beta', operation: 'create_issue', variables: { title: 'Beta', team: TEAM_ID } },
      ],
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]!.query).not.toContain('mutation');
    expect(requests[1]!.query).toContain('issueBatchCreate');
    expect(requests[1]!.query).not.toContain('issueCreate(');
    expect(result.details).toMatchObject({
      data: {
        alpha: { issueCreate: { success: true, issue: { title: 'Alpha' } } },
        beta: { issueCreate: { success: true, issue: { title: 'Beta' } } },
      },
      errors: [],
      skipped: [],
      meta: { requests: { read: 1, mutation: 1 } },
    });
  }, 30_000);
});
