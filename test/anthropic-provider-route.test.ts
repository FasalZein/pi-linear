import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import {
  captureAnthropic,
  createLinearHarness,
  execute,
  isolateAgentDir,
  NATIVE_ANTHROPIC_MODEL,
  activationContext,
  type ProviderPayload,
  type ProviderPayloadContentBlock,
} from './helpers/provider-harness';

const originalDirectory = process.env.PI_CODING_AGENT_DIR;
let directory: string | undefined;

afterEach(async () => {
  if (originalDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalDirectory;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

function flattenContent(payload: ProviderPayload): ProviderPayloadContentBlock[] {
  const blocks: ProviderPayloadContentBlock[] = [];
  const visit = (block: ProviderPayloadContentBlock): void => {
    blocks.push(block);
    if (Array.isArray(block.content)) block.content.forEach(visit);
  };
  for (const message of payload.messages) {
    if (Array.isArray(message.content)) message.content.forEach(visit);
  }
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
    const batchHelp = await execute(harness.tool('linear'), {
      operation: 'help', variables: { operation: 'batch' },
    });
    expect(batchHelp.details.loadedTools).toEqual(['linear_batch']);

    const payload = await captureAnthropic(
      NATIVE_ANTHROPIC_MODEL,
      activationContext(harness, [...help.details.loadedTools, ...batchHelp.details.loadedTools]),
    );
    const tools = payload.tools;
    expect(harness.activeTools().filter((name) => name === 'linear' || name.startsWith('linear_'))).toEqual([
      'linear', 'linear_get_result', 'linear_graphql', 'linear_batch',
    ]);
    expect(tools.find((tool) => tool.name === 'linear')?.defer_loading).toBeUndefined();
    expect(tools.find((tool) => tool.name === 'linear_get_result')?.defer_loading).toBeUndefined();
    const deferred = tools.find((tool) => tool.name === 'linear_graphql');
    const deferredSchema = deferred?.input_schema;
    expect(deferred?.defer_loading).toBe(true);
    expect(deferredSchema?.type).toBe('object');
    expect(deferredSchema?.properties).toBeTypeOf('object');
    const deferredBatch = tools.find((tool) => tool.name === 'linear_batch');
    expect(deferredBatch?.defer_loading).toBe(true);
    expect(deferredBatch?.input_schema).toBeTypeOf('object');

    /*
     * Regression: linear_batch published a union root, so it had no top-level `properties`.
     * The adapter builds a tool's input schema as
     * `{ type: 'object', properties: schema.properties ?? {}, required: schema.required ?? [] }`,
     * which turned linear_batch into a tool that appeared to accept nothing. The model then
     * guessed field names from the description and every guess was rejected locally against
     * a schema it had never been shown. Assert on the real payload, not on our own object.
     */
    expect(Object.keys(deferredBatch?.input_schema?.properties ?? {}))
      .toEqual(['operations', 'reads', 'mutations', 'workspace', 'sink', 'telemetry']);
    for (const tool of tools) {
      expect(Object.keys(tool.input_schema?.properties ?? {}).length, `${tool.name} must show its parameters`).toBeGreaterThan(0);
    }

    expect(() => harness.tool('linear_batch').prepareArguments({ operations: [{ operation: 'get_issue' }], reads: [{ operation: 'get_issue' }] }))
      .toThrow(/cannot combine "operations" with "reads" or "mutations"/);

    const references = flattenContent(payload).filter((block) => block.type === 'tool_reference');
    expect(references).toEqual([
      { type: 'tool_reference', tool_name: 'linear_graphql' },
      { type: 'tool_reference', tool_name: 'linear_batch' },
    ]);

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
