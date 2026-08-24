import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { splitDeferredTools } from '../node_modules/@earendil-works/pi-ai/dist/utils/deferred-tools.js';
import {
  captureAnthropic,
  execute,
  captureOpenAI,
  createLinearHarness,
  hasNativeOnlyMarker,
  isolateAgentDir,
  loadIssueThroughWrapper,
  NATIVE_ANTHROPIC_MODEL,
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

describe('fallback provider route', () => {
  it('activates additively, reports only new tools, and keeps cumulative definitions without native serialization', async () => {
    directory = await isolateAgentDir();
    const harness = createLinearHarness();
    harness.startSession();
    const before = harness.activeTools();
    expect(before.filter((name) => name === 'linear' || name.startsWith('linear_'))).toEqual(['linear', 'linear_get_result']);
    const help = await execute(harness.tool('linear'), {
      operation: 'help',
      variables: { operation: 'get_issue' },
    });
    expect(help.details.loadedTools).toEqual(['linear_get_issue']);
    const graphqlHelp = await execute(harness.tool('linear'), {
      operation: 'help', variables: { operation: 'graphql' },
    });
    expect(graphqlHelp.details.loadedTools).toEqual(['linear_graphql']);
    const after = harness.activeTools();
    expect(after).toEqual([...before, 'linear_get_issue', 'linear_graphql']);
    expect(harness.tool('linear_get_issue')).toBeTruthy();
    expect(harness.tool('linear_get_issue').promptSnippet).toBeUndefined();
    expect(harness.tool('linear_get_issue').promptGuidelines).toBeUndefined();

    const again = await execute(harness.tool('linear'), {
      operation: 'help',
      variables: { operation: 'get_issue' },
    });
    expect(again.details.loadedTools ?? []).toEqual([]);
    expect(harness.activeTools()).toEqual(after);

    const wrapped = await loadIssueThroughWrapper(createLinearHarness());
    expect(wrapped.addedToolNames).toEqual(['linear_get_issue']);

    const context = activationContext(harness, ['linear_get_issue', 'linear_graphql']);
    const placement = splitDeferredTools(context, false);
    expect(placement.deferred.size).toBe(0);
    expect(placement.immediate.map(({ name }) => name)).toEqual(['linear', 'linear_get_result', 'linear_graphql', 'linear_get_issue']);

    const fallbackAnthropic = { ...NATIVE_ANTHROPIC_MODEL, compat: { ...NATIVE_ANTHROPIC_MODEL.compat, supportsToolReferences: false } };
    const fallbackOpenAI = {
      ...NATIVE_OPENAI_MODEL,
      compat: { ...NATIVE_OPENAI_MODEL.compat, supportsToolSearch: false, supportsAdditionalTools: false },
    };
    const anthropicPayload = await captureAnthropic(fallbackAnthropic, context);
    const openaiPayload = await captureOpenAI(fallbackOpenAI, context);
    expect(hasNativeOnlyMarker(anthropicPayload)).toBe(false);
    expect(hasNativeOnlyMarker(openaiPayload)).toBe(false);
    expect(anthropicPayload.tools.map((tool: { name: string }) => tool.name)).toEqual(['linear', 'linear_get_result', 'linear_graphql', 'linear_get_issue']);
    expect(openaiPayload.tools.map((tool: { name: string }) => tool.name)).toEqual(['linear', 'linear_get_result', 'linear_graphql', 'linear_get_issue']);
    const anthropicGuidance = anthropicPayload.tools.find((tool: { name: string }) => tool.name === 'linear')
      ?.input_schema.properties.operation.description;
    const openaiGuidance = openaiPayload.tools.find((tool: { name: string }) => tool.name === 'linear')
      ?.parameters.properties.operation.description;
    for (const guidance of [anthropicGuidance, openaiGuidance]) {
      expect(guidance).toContain('Legacy get_result is deprecated');
      expect(guidance).toContain('call linear_get_result with direct arguments');
      expect(guidance).not.toContain('loader-only batch and get_result');
    }
  });
});
