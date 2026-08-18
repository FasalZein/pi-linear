const TOOL_PREFIX = 'linear_';

/** Upstream-compatible tool name for one catalog operation. */
export function typedToolName(operationName: string): string {
  return `${TOOL_PREFIX}${operationName}`;
}

export function typedToolOperationName(toolName: string): string | undefined {
  return toolName.startsWith(TOOL_PREFIX) ? toolName.slice(TOOL_PREFIX.length) : undefined;
}
