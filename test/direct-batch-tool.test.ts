import { afterEach, describe, expect, it, vi } from 'vitest';
import { linearBatchTool } from '../extensions/api';
import { renderLinearBatchCall, renderLinearBatchResult } from '../extensions/renderers';
import { createLinearHarness, execute } from './helpers/provider-harness';
import { isolateLinearCredentials } from './helpers/credentials';

isolateLinearCredentials();

afterEach(() => vi.unstubAllGlobals());

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
} as any;

function block(component: any): string {
  return component.render(120).join('\n');
}

function result(details: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details } as any;
}

describe('direct batch tool', () => {
  it('publishes strict flat and phased branches and rejects legacy or unknown fields before network access', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const tool = linearBatchTool() as any;
    expect(tool.name).toBe('linear_batch');
    expect(tool.parameters.anyOf).toHaveLength(2);

    for (const args of [
      { operations: [{ name: 'one', operation: 'get_issue' }] },
      { operations: [{ operation: 'get_issue', extra: true }] },
      { operations: [{ operation: 'get_issue' }], reads: [{ operation: 'get_issue' }] },
      { reads: [] },
      { operations: [], extra: true },
    ]) {
      expect(() => tool.prepareArguments(args)).toThrow(/Invalid arguments for "linear_batch"/);
      await expect(execute(tool, args as any)).rejects.toThrow(/Invalid arguments for "linear_batch"/);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('activates only linear_batch for exact batch help and reports it once', async () => {
    const harness = createLinearHarness();
    harness.startSession();
    expect(harness.activeTools().filter((name) => name === 'linear' || name.startsWith('linear_')))
      .toEqual(['linear', 'linear_get_result']);

    const first = await execute(harness.tool('linear'), { operation: 'help', variables: { operation: 'batch' } });
    expect(first.details.loadedTools).toEqual(['linear_batch']);
    expect(first.details).toMatchObject({ name: 'batch', entry: { key: 'string?', operation: 'string', variables: 'Record<string, unknown>?' } });
    expect(first.details.flatExample).toEqual({ operations: [{ key: 'issue', operation: 'get_issue', variables: { issue: 'AEO-258' } }] });
    expect(harness.activeTools().filter((name) => name === 'linear' || name.startsWith('linear_')))
      .toEqual(['linear', 'linear_get_result', 'linear_batch']);

    const again = await execute(harness.tool('linear'), { operation: 'help', variables: { operation: 'batch' } });
    expect(again.details.loadedTools).toBeUndefined();
  });

  it('preserves canonical-key reads on the direct batch tool', async () => {
    process.env.LINEAR_API_KEY = 'test-key';
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      requests.push(request);
      return new Response(JSON.stringify({ data: { issue: { id: '11111111-1111-4111-8111-111111111111', identifier: 'AEO-258', title: 'Batch' } } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    const harness = createLinearHarness();
    harness.startSession();
    await execute(harness.tool('linear'), { operation: 'help', variables: { operation: 'batch' } });
    const cases = [
      { operations: [{ key: 'issue', operation: 'get_issue', variables: { issue: 'AEO-258' } }] },
      { reads: [{ key: 'issue', operation: 'get_issue', variables: { issue: 'AEO-258' } }] },
    ];
    for (const args of cases) {
      const direct = await execute(harness.tool('linear_batch'), args);
      expect(direct.details.data.issue.issue.id).toBe('11111111-1111-4111-8111-111111111111');
    }
    expect(requests).toHaveLength(cases.length);
  });

  it('renders call phases and completed, failed, skipped, and request states', () => {
    const call = block(renderLinearBatchCall({
      reads: [{ key: 'ready', operation: 'get_issue' }],
      mutations: [{ key: 'write', operation: 'create_issue' }],
    }, theme));
    expect(call).toContain('linear_batch phased');
    expect(call).toContain('reads: get_issue');
    expect(call).toContain('mutations: create_issue');

    const rendered = block(renderLinearBatchResult(result({
      data: { ready: { issue: {} } },
      errors: [{ key: 'write', message: 'failed' }],
      skipped: ['later'],
      meta: { requests: { read: 1, mutation: 1 } },
    }), { isPartial: false, expanded: false } as any, theme, { args: {} } as any));
    expect(rendered).toContain('Completed: ready');
    expect(rendered).toContain('Failed: write');
    expect(rendered).toContain('Skipped: later');
    expect(rendered).toContain('Requests: 1 read, 1 mutation');
  });

  it('names direct batch and direct result retrieval in recovery guidance', () => {
    const failure = block(renderLinearBatchResult(
      result({ error: 'Linear network error: closed' }),
      { isPartial: false, expanded: false } as any,
      theme,
      { args: { operations: [{ operation: 'get_issue' }] }, isError: true } as any,
    ));
    expect(failure).toContain('linear_batch');
    expect(failure).not.toContain('call linear again');

    const spill = block(renderLinearBatchResult(result({
      handle: 'linear-result:v1:550e8400-e29b-41d4-a716-446655440000',
      path: '/tmp/linear/raw/result.json',
      bytes: 42_000,
      index: [],
      meta: { result: { route: 'artifact' } },
    }), { isPartial: false, expanded: false } as any, theme, { args: {} } as any));
    expect(spill.replace(/\s+/g, ' ')).toContain('linear_get_result({"handle":"linear-result:v1:550e8400-e29b-41d4-a716-446655440000"})');
  });
});
