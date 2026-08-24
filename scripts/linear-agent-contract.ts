export const LINEAR_AGENT_TOOL_SURFACE_START = '<!-- pi-linear:tool-surface:start -->';
export const LINEAR_AGENT_TOOL_SURFACE_END = '<!-- pi-linear:tool-surface:end -->';
export const LINEAR_AGENT_QUERY_DISCIPLINE_START = '<!-- pi-linear:query-discipline:start -->';
export const LINEAR_AGENT_QUERY_DISCIPLINE_END = '<!-- pi-linear:query-discipline:end -->';

export const LINEAR_AGENT_TOOL_SURFACE = `${LINEAR_AGENT_TOOL_SURFACE_START}
- Use \`linear\` for discovery, raw GraphQL, and batch. Its legacy \`get_result\` route is deprecated.
- Before the first use of an unfamiliar named operation, call loader help: \`{ "operation": "help", "variables": { "operation": "<name>" } }\`. Help is local and makes no Linear network request.
- Help activates the matching typed tool. Then call that typed tool with only its declared direct parameters.
- Never send loader fields (\`operation\`, \`query\`, \`variables\`, \`workspace\`, \`sink\`, or \`telemetry\`) to a typed tool unless its schema declares a same-named business parameter.
- Use wrapper envelopes only with the \`linear\` loader. The deprecated \`get_result\` envelope exists for compatibility only. For independent reads, prefer \`{ "operation": "batch", "variables": { "operations": [{ "operation": "<name>", "variables": { ... } }] } }\`.
- Use explicit \`reads\` and \`mutations\` phases only when mutations exist. Batch entry keys are optional caller labels. Do not invent keys; the runtime assigns stable keys when absent.
- Do not guess parameter names or nested \`input\` shapes. Read loader help, then follow the activated typed schema.
- Use \`linear_get_result\` for lossless recovery from compact or spilled results. Pass \`{ "handle": "..." }\` directly. Preserve the handle exactly. Follow the returned JSON Pointer and \`nextOffset\` until \`complete\` is true.
- Use raw GraphQL only when no named operation exists. Keep raw reads bounded. Do not send raw mutations unless the job explicitly authorizes them.
${LINEAR_AGENT_TOOL_SURFACE_END}`;

export const LINEAR_AGENT_QUERY_DISCIPLINE = `${LINEAR_AGENT_QUERY_DISCIPLINE_START}
- Apply task-sized filters and page sizes.
- Continue through pages only until the requested result is complete.
- Prefer exact issue, project, cycle, team, user, and document references when known.
- Use server-side filters before local filtering.
- Use batch only for independent operations. Keep guarded deletes in the mutation phase with all required identity guards.
${LINEAR_AGENT_QUERY_DISCIPLINE_END}`;
