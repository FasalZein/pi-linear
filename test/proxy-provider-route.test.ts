import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import {
  captureAnthropic,
  captureOpenAI,
  createLinearHarness,
  execute,
  hasNativeOnlyMarker,
  isolateAgentDir,
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

describe('custom proxies with native flags disabled', () => {
  it('uses fallback payloads and never emits native-only items', async () => {
    directory = await isolateAgentDir();
    const harness = createLinearHarness();
    harness.startSession();
    const help = await execute(harness.tool('linear'), {
      operation: 'help', variables: { operation: 'graphql' },
    });
    const context = activationContext(harness, help.details.loadedTools);

    const anthropicProxy = {
      ...NATIVE_ANTHROPIC_MODEL,
      provider: 'custom-anthropic-proxy',
      baseUrl: 'https://proxy.example/anthropic',
      compat: { ...NATIVE_ANTHROPIC_MODEL.compat, supportsToolReferences: false },
    };
    const openaiProxy = {
      ...NATIVE_OPENAI_MODEL,
      provider: 'custom-openai-proxy',
      baseUrl: 'https://proxy.example/openai',
      compat: { ...NATIVE_OPENAI_MODEL.compat, supportsToolSearch: false, supportsAdditionalTools: false },
    };

    const anthropicPayload = await captureAnthropic(anthropicProxy, context);
    const openaiPayload = await captureOpenAI(openaiProxy, context);
    expect(hasNativeOnlyMarker(anthropicPayload)).toBe(false);
    expect(hasNativeOnlyMarker(openaiPayload)).toBe(false);
    expect(anthropicPayload.tools.every((tool: { defer_loading?: boolean }) => !tool.defer_loading)).toBe(true);
    expect(openaiPayload.tools.map((tool: { name: string }) => tool.name)).toEqual(['linear', 'linear_get_result', 'linear_graphql']);
  });
});
