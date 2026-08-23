import type { MutationMode } from '../../extensions/safety';
import { typedLinearTools } from '../../extensions/typed-tools';

export function typedTool(operation: string, mode: MutationMode = 'allowlist') {
  const tool = typedLinearTools(mode).find(({ name }) => name === `linear_${operation}`);
  if (!tool) throw new Error(`Missing typed tool for ${operation}.`);
  return tool as any;
}

export function executeTyped(
  operation: string,
  variables: Record<string, unknown> = {},
  options: {
    mode?: MutationMode;
    workspace?: string;
    signal?: AbortSignal;
    ctx?: { hasUI: boolean };
  } = {},
) {
  const args = options.workspace === undefined ? variables : { ...variables, workspace: options.workspace };
  return typedTool(operation, options.mode).execute(
    'call',
    args,
    options.signal,
    undefined,
    options.ctx ?? { hasUI: false },
  );
}
