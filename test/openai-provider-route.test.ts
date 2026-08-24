import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import {
  captureOpenAI,
  createLinearHarness,
  execute,
  isolateAgentDir,
  NATIVE_OPENAI_MODEL,
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

describe('native OpenAI route', () => {
  it('loads only newly activated definitions through first-party additional-tools or tool-search', async () => {
    directory = await isolateAgentDir();
    const harness = createLinearHarness();
    harness.startSession();
    const help = await execute(harness.tool('linear'), {
      operation: 'help', variables: { operation: 'graphql' },
    });
    expect(help.details.loadedTools).toEqual(['linear_graphql']);
    const context = activationContext(harness, help.details.loadedTools);

    const firstParty = await captureOpenAI(NATIVE_OPENAI_MODEL, context);
    expect(harness.activeTools().filter((name) => name === 'linear' || name.startsWith('linear_'))).toEqual([
      'linear', 'linear_get_result', 'linear_graphql',
    ]);
    expect(firstParty.tools.map((tool: { name: string }) => tool.name)).toEqual(['linear', 'linear_get_result']);
    const additional = firstParty.input.filter((item: { type: string }) => item.type === 'additional_tools');
    expect(additional).toHaveLength(1);
    expect(additional[0].tools.map((tool: { name: string; defer_loading?: boolean }) => tool.name)).toEqual(['linear_graphql']);

    const searchModel = {
      ...NATIVE_OPENAI_MODEL,
      compat: { ...NATIVE_OPENAI_MODEL.compat, supportsAdditionalTools: false, supportsToolSearch: true },
    };
    const search = await captureOpenAI(searchModel, context);
    const call = search.input.find((item: { type: string }) => item.type === 'tool_search_call');
    const output = search.input.find((item: { type: string }) => item.type === 'tool_search_output');
    expect(call.status).toBe('completed');
    expect(call.execution).toBe('client');
    expect(output.status).toBe('completed');
    expect(output.tools.map((tool: { name: string; defer_loading?: boolean }) => ({
      name: tool.name,
      defer_loading: tool.defer_loading,
    }))).toEqual([{ name: 'linear_graphql', defer_loading: true }]);

    expect(() => harness.tool('linear_create_comment').prepareArguments({})).toThrow(
      /Invalid arguments for "linear_create_comment"/,
    );
  });
});
