export const LINEAR_AGENT_TOOL_SURFACE = `## Tool surface

<!-- pi-linear:tool-surface:start -->
- Use \`linear\` only as the loader, raw GraphQL escape hatch, batch wrapper, and local result reader.
- Before the first use of an unfamiliar named operation, call loader help: \`{ "operation": "help", "variables": { "operation": "<name>" } }\`. Help is local and makes no Linear network request.
- Help activates the matching typed tool. Then call that typed tool with only its declared direct parameters.
- Never send loader fields (\`operation\`, \`query\`, \`variables\`, \`workspace\`, or \`sink\`) to a typed tool unless its schema declares a same-named business parameter.
- Use wrapper envelopes only with the \`linear\` loader. A batch entry is exactly \`{ key, operation, variables }\`. Each key must be a valid unique GraphQL alias.
- Do not guess parameter names or nested \`input\` shapes. Read loader help, then follow the activated typed schema.
- Use \`get_result\` through the loader for lossless recovery from compact or spilled results. Preserve its result handle exactly. Follow the returned JSON Pointer and \`nextOffset\` until \`complete\` is true.
- Use raw GraphQL only when no named operation exists. Keep raw reads bounded. Do not send raw mutations unless the job explicitly authorizes them.
<!-- pi-linear:tool-surface:end -->`;

export const LINEAR_AGENT_QUERY_DISCIPLINE = `## Query discipline

<!-- pi-linear:query-discipline:start -->
- Apply task-sized filters and page sizes.
- Continue through pages only until the requested result is complete.
- Prefer exact issue, project, cycle, team, user, and document references when known.
- Use server-side filters before local filtering.
- Use batch only for independent operations. Keep guarded deletes in the mutation phase with all required identity guards.
<!-- pi-linear:query-discipline:end -->`;
