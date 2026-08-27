import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { JsonObject } from '../../extensions/json';
import type { MutationMode } from '../../extensions/safety';
import { typedLinearTools } from '../../extensions/typed-tools';

/** A direct Linear tool exactly as production publishes it. */
type TypedLinearTool = ReturnType<typeof typedLinearTools>[number];
/** Parsed operation variables, exactly as a model-supplied tool call carries them. */
type OperationVariables = JsonObject;

/** The harness runs tools headless: only `hasUI` is read on this path. */
const HEADLESS_CONTEXT = { hasUI: false } as ExtensionContext;

export function typedTool(operation: string, mode: MutationMode = 'allowlist'): TypedLinearTool {
  const tool = typedLinearTools(mode).find(({ name }) => name === `linear_${operation}`);
  if (!tool) throw new Error(`Missing typed tool for ${operation}.`);
  return tool;
}

export function executeTyped(
  operation: string,
  variables: OperationVariables = {},
  options: {
    mode?: MutationMode;
    signal?: AbortSignal;
    ctx?: ExtensionContext;
  } = {},
) {
  // No `workspace` option: typed tools publish no such parameter and always use the
  // active workspace. Explicit selection goes through linear_graphql or linear_batch.
  return typedTool(operation, options.mode).execute(
    'call',
    variables,
    options.signal,
    undefined,
    options.ctx ?? HEADLESS_CONTEXT,
  );
}
