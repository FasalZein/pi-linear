import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import {
  captureOpenAI,
  createLinearHarness,
  execute,
  isolateAgentDir,
  NATIVE_OPENAI_MODEL,
  activationContext,
  parseProviderPayload,
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
    const batchHelp = await execute(harness.tool('linear'), {
      operation: 'help', variables: { operation: 'batch' },
    });
    expect(batchHelp.details.loadedTools).toEqual(['linear_batch']);
    const context = activationContext(harness, [...help.details.loadedTools, ...batchHelp.details.loadedTools]);

    const firstParty = await captureOpenAI(NATIVE_OPENAI_MODEL, context);
    expect(harness.activeTools().filter((name) => name === 'linear' || name.startsWith('linear_'))).toEqual([
      'linear', 'linear_get_result', 'linear_graphql', 'linear_batch',
    ]);
    expect(firstParty.tools.map((tool) => tool.name)).toEqual(['linear', 'linear_get_result']);
    const additional = firstParty.input.filter((item) => item.type === 'additional_tools');
    expect(additional).toHaveLength(1);
    if (!additional[0]?.tools) throw new Error('The additional-tools route emitted no tool definitions.');
    expect(additional[0].tools.map((tool) => tool.name)).toEqual(['linear_graphql', 'linear_batch']);

    const searchModel = {
      ...NATIVE_OPENAI_MODEL,
      compat: { ...NATIVE_OPENAI_MODEL.compat, supportsAdditionalTools: false, supportsToolSearch: true },
    };
    const search = await captureOpenAI(searchModel, context);
    const call = search.input.find((item) => item.type === 'tool_search_call');
    const output = search.input.find((item) => item.type === 'tool_search_output');
    if (!call || !output?.tools) throw new Error('The tool-search route emitted no tool_search_call and tool_search_output pair.');
    expect(call.status).toBe('completed');
    expect(call.execution).toBe('client');
    expect(output.status).toBe('completed');
    expect(output.tools.map((tool) => ({
      name: tool.name,
      defer_loading: tool.defer_loading,
    }))).toEqual([
      { name: 'linear_graphql', defer_loading: true },
      { name: 'linear_batch', defer_loading: true },
    ]);

    expect(() => harness.tool('linear_create_comment').prepareArguments({})).toThrow(
      /Invalid arguments for "linear_create_comment"/,
    );
  });

  it('rejects missing payload arrays and malformed tool-search definitions at the harness seam', () => {
    expect(() => parseProviderPayload({ tools: [] }, 'OpenAI')).toThrow(
      'OpenAI provider payload.input must be an array.',
    );
    expect(() => parseProviderPayload({
      tools: [],
      input: [{ type: 'tool_search_output', status: 'completed' }],
    }, 'OpenAI')).toThrow('OpenAI provider payload.input[0].tools must be an array.');
  });
});
