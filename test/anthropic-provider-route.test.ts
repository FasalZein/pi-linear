import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import {
  captureAnthropic,
  createLinearHarness,
  execute,
  isolateAgentDir,
  NATIVE_ANTHROPIC_MODEL,
  activationContext,
} from './helpers/provider-harness';

const originalDirectory = process.env.PI_CODING_AGENT_DIR;
let directory: string | undefined;

afterEach(async () => {
  if (originalDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalDirectory;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

function flattenContent(payload: any): unknown[] {
  const blocks: unknown[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    blocks.push(value);
    visit((value as { content?: unknown }).content);
  };
  visit(payload.messages);
  return blocks;
}

describe('native Anthropic route', () => {
  it('defers newly activated definitions and keeps required-branch validation local', async () => {
    directory = await isolateAgentDir();
    const harness = createLinearHarness();
    harness.startSession();
    const help = await execute(harness.tool('linear'), {
      operation: 'help', variables: { operation: 'graphql' },
    });
    expect(help.details.loadedTools).toEqual(['linear_graphql']);

    const payload = await captureAnthropic(NATIVE_ANTHROPIC_MODEL, activationContext(harness, help.details.loadedTools));
    const tools = payload.tools as Array<{ name: string; defer_loading?: boolean; input_schema?: any }>;
    expect(harness.activeTools().filter((name) => name === 'linear' || name.startsWith('linear_'))).toEqual([
      'linear', 'linear_get_result', 'linear_graphql',
    ]);
    expect(tools.find((tool) => tool.name === 'linear')?.defer_loading).toBeUndefined();
    expect(tools.find((tool) => tool.name === 'linear_get_result')?.defer_loading).toBeUndefined();
    const deferred = tools.find((tool) => tool.name === 'linear_graphql');
    expect(deferred?.defer_loading).toBe(true);
    expect(deferred?.input_schema?.type).toBe('object');
    expect(deferred?.input_schema?.properties).toBeTypeOf('object');

    const references = flattenContent(payload).filter((block: any) => block?.type === 'tool_reference');
    expect(references).toEqual([{ type: 'tool_reference', tool_name: 'linear_graphql' }]);

    const comment = harness.tool('linear_create_comment');
    expect(comment.parameters).toBeTruthy();
    expect(() => comment.prepareArguments({})).toThrow(/Invalid arguments for "linear_create_comment"/);
    expect(() => comment.prepareArguments({
      issue: 'AEO-258',
      projectId: '11111111-1111-4111-8111-111111111111',
      body: 'two targets',
    })).toThrow(/Invalid arguments for "linear_create_comment"/);
  });
});
